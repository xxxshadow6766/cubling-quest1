// Builds and streams the world: only the player's area and its neighbours exist in the scene.
import * as THREE from 'three';
import { BALANCE, THEMES, TOWN, ZONES, type Theme } from '../../../shared/config';
import { fmt } from '../../../shared/formulas';
import { HALF_W, ZL, bossPos, eggStandPos, gateZ, zoneCenterZ, TOWN_MAX_Z } from '../../../shared/world';
import { cloneModel, eggModel, instancedModel } from './assets';
import { disposeLabel, makeLabel } from './labels';

export interface Interactable { kind: 'egg' | 'gate' | 'station'; id: string; label: string; x: number; z: number; r: number; zone?: number }
export interface Collider { x: number; z: number; r: number }

interface ZoneView {
  n: number;
  group: THREE.Group;
  owned: (THREE.BufferGeometry | THREE.Material | THREE.InstancedMesh)[];
  labels: THREE.Sprite[];
  interact: Interactable[];
  colliders: Collider[];
  gate?: { bars: THREE.Object3D; sign: THREE.Sprite; n: number; locked: boolean };
  egg?: THREE.Object3D;
  spinners: THREE.Object3D[];
  /** gate structures that fade out when they block the camera */
  occluders: { z: number; mats: THREE.Material[]; faded: boolean; sprites?: THREE.Sprite[] }[];
}

/** Gives an object its own material copies so it can fade independently. */
function ownMaterials(obj: THREE.Object3D, owned: (THREE.BufferGeometry | THREE.Material | THREE.InstancedMesh)[]): THREE.Material[] {
  const mats: THREE.Material[] = [];
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const cloned = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => {
      const c = x.clone();
      mats.push(c);
      owned.push(c);
      return c;
    });
    m.material = Array.isArray(m.material) ? cloned : cloned[0];
  });
  return mats;
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATION_RADIUS: Record<string, number> = { machine: 2.4, present: 1.4, lectern: 1.1, portal: 2.9, booth: 2.4, board: 1.9, pad: 0 };
const STATION_LABEL_Y: Record<string, number> = { machine: 6.4, present: 3.6, lectern: 3.6, portal: 6.0, booth: 5.0, board: 5.0, pad: 2.4 };

export class World {
  readonly group = new THREE.Group();
  private zones = new Map<number, ZoneView>();
  private maxZone = 1;
  private skyColor = new THREE.Color();
  private fogColor = new THREE.Color();
  private targetSky = new THREE.Color();
  private targetFog = new THREE.Color();
  private ambient: THREE.Points;
  private ambientVel: Float32Array;
  private ambientTheme = '';
  interactables: Interactable[] = [];
  colliders: Collider[] = [];
  private portalInner: THREE.Object3D | null = null;

  constructor(private scene: THREE.Scene, private reduced: boolean) {
    scene.add(this.group);
    this.skyColor.set(THEMES[0].sky);
    this.fogColor.set(THEMES[0].fog);
    scene.background = this.skyColor.clone();
    scene.fog = new THREE.Fog(this.fogColor.clone(), 45, 150);
    const n = reduced ? 60 : 220;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.ambientVel = new Float32Array(n * 3);
    const tex = dotTexture();
    this.ambient = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.35, map: tex, transparent: true, depthWrite: false, color: '#ffffff', opacity: 0.85 }));
    this.ambient.frustumCulled = false;
    scene.add(this.ambient);
  }

  setReduced(r: boolean) {
    this.reduced = r;
    this.ambient.visible = !r;
  }

  setMaxZone(maxZone: number) {
    if (maxZone === this.maxZone) return;
    this.maxZone = maxZone;
    for (const z of this.zones.values()) this.refreshGate(z);
    this.rebuildLists();
  }

  /** Called every frame. */
  update(playerZone: number, px: number, pz: number, dt: number, t: number) {
    const want = new Set<number>();
    for (const n of [playerZone - 1, playerZone, playerZone + 1]) if (n >= 0 && n <= BALANCE.zoneCount) want.add(n);
    let changed = false;
    for (const [n, zv] of this.zones) {
      if (!want.has(n)) {
        this.disposeZone(zv);
        this.zones.delete(n);
        changed = true;
      }
    }
    for (const n of want) {
      if (!this.zones.has(n)) {
        this.zones.set(n, n === 0 ? this.buildTown() : this.buildZone(n));
        changed = true;
      }
    }
    if (changed) this.rebuildLists();

    // sky / fog blending toward the current theme
    const theme = playerZone === 0 ? TOWN_THEME : ZONES[playerZone].theme;
    this.targetSky.set(theme.sky);
    this.targetFog.set(theme.fog);
    const k = 1 - Math.exp(-dt * 2);
    this.skyColor.lerp(this.targetSky, k);
    this.fogColor.lerp(this.targetFog, k);
    (this.scene.background as THREE.Color).copy(this.skyColor);
    (this.scene.fog as THREE.Fog).color.copy(this.fogColor);

    for (const zv of this.zones.values()) {
      if (zv.egg) {
        zv.egg.rotation.y = t * 0.8;
        zv.egg.position.y = 1.05 + Math.sin(t * 2) * 0.12;
      }
      for (const s of zv.spinners) s.rotation.y += dt * 0.6;
    }
    if (this.portalInner) {
      const m = (this.portalInner as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (m?.emissive) m.emissiveIntensity = 1.2 + Math.sin(t * 3) * 0.5;
      this.portalInner.scale.setScalar(1 + Math.sin(t * 2) * 0.03);
    }
    this.updateAmbient(theme, px, pz, dt, t);
  }

  /** Fade gates that sit between the camera and the player so they never block the view. */
  updateOcclusion(camZ: number, playerZ: number) {
    for (const zv of this.zones.values()) {
      for (const o of zv.occluders) {
        const block = (camZ - o.z) * (playerZ - o.z) < 0 || Math.abs(camZ - o.z) < 2.5;
        // floating signs above gates would fill the screen when the camera is right next to them
        const signHidden = block || Math.abs(camZ - o.z) < 12;
        if (zv.gate && Math.abs(gateZ(zv.gate.n) - o.z) < 0.1) zv.gate.sign.visible = !signHidden;
        for (const s of o.sprites ?? []) s.visible = !signHidden;
        if (block === o.faded) continue;
        o.faded = block;
        for (const m of o.mats) {
          m.transparent = block;
          m.opacity = block ? 0.18 : 1;
          m.depthWrite = !block;
          m.needsUpdate = true;
        }
      }
    }
  }

  private rebuildLists() {
    this.interactables = [];
    this.colliders = [];
    for (const zv of this.zones.values()) {
      for (const it of zv.interact) {
        if (it.kind === 'gate' && it.zone !== this.maxZone + 1) continue;
        this.interactables.push(it);
      }
      this.colliders.push(...zv.colliders);
    }
  }

  private refreshGate(zv: ZoneView) {
    if (!zv.gate) return;
    const locked = zv.gate.n > this.maxZone;
    if (locked === zv.gate.locked) return;
    zv.gate.locked = locked;
    zv.gate.bars.visible = locked;
    zv.group.remove(zv.gate.sign);
    disposeLabel(zv.gate.sign);
    zv.gate.sign = this.gateSign(zv.gate.n, locked);
    zv.gate.sign.position.set(0, 12.2, gateZ(zv.gate.n));
    zv.group.add(zv.gate.sign);
  }

  private gateSign(n: number, locked: boolean) {
    const z = ZONES[n];
    return locked
      ? makeLabel([{ text: `🔒 Area ${n}: ${z.name}`, size: 34 }, { text: `🪙 ${fmt(z.gateCost)}`, color: '#ffe066', size: 40 }], { bg: 'rgba(40,30,70,0.72)', height: 0.9, border: '#ffd34d' })
      : makeLabel([{ text: `Area ${n}`, size: 26, color: '#ffe9a8' }, { text: z.name, size: 36 }], { bg: 'rgba(40,30,70,0.55)', height: 0.85 });
  }

  // ---------------------------------------------------------------- builders
  private base(n: number, theme: Theme): ZoneView {
    const zv: ZoneView = { n, group: new THREE.Group(), owned: [], labels: [], interact: [], colliders: [], spinners: [], occluders: [] };
    const c = zoneCenterZ(n);
    const rnd = mulberry32(n * 7919 + 13);
    // ground with soft colour variation
    const g = new THREE.PlaneGeometry(HALF_W * 2, ZL, 16, 18).rotateX(-Math.PI / 2);
    const col = new Float32Array(g.attributes.position.count * 3);
    const a = new THREE.Color(theme.ground);
    const b = new THREE.Color(theme.ground2);
    const tmp = new THREE.Color();
    for (let i = 0; i < g.attributes.position.count; i++) {
      const x = g.attributes.position.getX(i);
      const z = g.attributes.position.getZ(i);
      const v = 0.5 + 0.5 * Math.sin(x * 0.35 + rnd() * 0.6) * Math.cos(z * 0.3 + n);
      tmp.copy(a).lerp(b, v);
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const gm = new THREE.MeshLambertMaterial({ vertexColors: true });
    const ground = new THREE.Mesh(g, gm);
    ground.position.z = c;
    ground.receiveShadow = true;
    zv.group.add(ground);
    // outer ground (outside the walls)
    const og = new THREE.PlaneGeometry(260, ZL).rotateX(-Math.PI / 2);
    const om = new THREE.MeshLambertMaterial({ color: new THREE.Color(theme.ground2).multiplyScalar(0.82) });
    const outer = new THREE.Mesh(og, om);
    outer.position.set(0, -0.06, c);
    zv.group.add(outer);
    // side walls
    const wg = new THREE.BoxGeometry(1.6, 2.4, ZL);
    const wm = new THREE.MeshLambertMaterial({ color: theme.wall });
    const tg = new THREE.BoxGeometry(2.0, 0.4, ZL);
    const tm = new THREE.MeshLambertMaterial({ color: new THREE.Color(theme.wall).lerp(new THREE.Color('#ffffff'), 0.35) });
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(wg, wm);
      w.position.set(s * (HALF_W + 0.8), 1.2, c);
      w.castShadow = !this.reduced;
      w.receiveShadow = true;
      const top = new THREE.Mesh(tg, tm);
      top.position.set(s * (HALF_W + 0.8), 2.5, c);
      zv.group.add(w, top);
    }
    zv.owned.push(g, gm, og, om, wg, wm, tg, tm);
    return zv;
  }

  private buildZone(n: number): ZoneView {
    const zdef = ZONES[n];
    const theme = zdef.theme;
    const zv = this.base(n, theme);
    const c = zoneCenterZ(n);
    const rnd = mulberry32(n * 104729 + 7);
    // path
    const pg = new THREE.PlaneGeometry(7, ZL).rotateX(-Math.PI / 2);
    const pm = new THREE.MeshLambertMaterial({ color: theme.path });
    const path = new THREE.Mesh(pg, pm);
    path.position.set(0, 0.03, c);
    path.receiveShadow = true;
    zv.group.add(path);
    zv.owned.push(pg, pm);

    // gate into this zone
    if (n >= 2) {
      const gz = gateZ(n);
      const arch = cloneModel('gate_arch', { tint_gate: theme.gate });
      arch.position.set(0, 0, gz);
      zv.group.add(arch);
      const bars = cloneModel('gate_bars');
      bars.position.set(0, 0, gz);
      const locked = n > this.maxZone;
      bars.visible = locked;
      zv.group.add(bars);
      const fg = new THREE.BoxGeometry(HALF_W - 7, 4.2, 1.4);
      const fm = new THREE.MeshLambertMaterial({ color: theme.wall });
      for (const s of [-1, 1]) {
        const f = new THREE.Mesh(fg, fm);
        f.position.set(s * (7 + (HALF_W - 7) / 2), 2.1, gz);
        f.castShadow = !this.reduced;
        zv.group.add(f);
      }
      zv.owned.push(fg, fm);
      zv.occluders.push({ z: gz, mats: [...ownMaterials(arch, zv.owned), ...ownMaterials(bars, zv.owned), fm], faded: false });
      const sign = this.gateSign(n, locked);
      sign.position.set(0, 12.2, gz);
      zv.group.add(sign);
      zv.gate = { bars, sign, n, locked };
      zv.interact.push({ kind: 'gate', id: `gate${n}`, label: `Unlock ${zdef.name}`, x: 0, z: gz + 2.5, r: 9, zone: n });
      zv.colliders.push({ x: -6, z: gz, r: 1.6 }, { x: 6, z: gz, r: 1.6 });
    }

    // egg stand
    const ep = eggStandPos(n);
    const stand = cloneModel('egg_stand', { tint_trim: theme.accent });
    stand.position.set(ep.x, 0, ep.z);
    stand.rotation.y = Math.PI / 2;
    zv.group.add(stand);
    const egg = eggModel(n);
    egg.scale.setScalar(1.7);
    egg.position.set(ep.x, 1.05, ep.z);
    zv.group.add(egg);
    zv.egg = egg;
    const eggSign = makeLabel([{ text: `🥚 ${zdef.egg.name}`, size: 32 }, { text: `🪙 ${fmt(zdef.eggCost)}`, color: '#ffe066', size: 34 }], { bg: 'rgba(40,30,70,0.6)', height: 0.75 });
    eggSign.position.set(ep.x, 5.6, ep.z);
    zv.group.add(eggSign);
    zv.labels.push(eggSign);
    zv.interact.push({ kind: 'egg', id: `egg${n}`, label: `Open ${zdef.egg.name}`, x: ep.x, z: ep.z, r: 6.5, zone: n });
    zv.colliders.push({ x: ep.x, z: ep.z, r: 2.1 });

    // boss pedestal
    if (zdef.boss) {
      const bp = bossPos(n);
      const rg = new THREE.RingGeometry(4.2, 5.2, 40).rotateX(-Math.PI / 2);
      const rm = new THREE.MeshBasicMaterial({ color: '#b77bff', transparent: true, opacity: 0.55 });
      const ring = new THREE.Mesh(rg, rm);
      ring.position.set(bp.x, 0.05, bp.z);
      zv.group.add(ring);
      zv.spinners.push(ring);
      zv.owned.push(rg, rm);
      const bl = makeLabel([{ text: '👑 Boss Chest Arena', size: 30, color: '#f3d1ff' }], { height: 0.7 });
      bl.position.set(bp.x, 0.9, bp.z + 5.6);
      zv.group.add(bl);
      zv.labels.push(bl);
    }

    // scenery (instanced)
    for (const sd of theme.scenery) {
      const count = this.reduced ? Math.ceil(sd.n * 0.5) : sd.n;
      const ims = instancedModel(sd.m, sd.t, count);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      for (let i = 0; i < count; i++) {
        const outside = rnd() < 0.3;
        const side = rnd() < 0.5 ? -1 : 1;
        const x = outside ? side * (HALF_W + 3 + rnd() * 18) : side * (HALF_W - 4.5 + rnd() * 3.2);
        const z = c - ZL / 2 + 3 + rnd() * (ZL - 6);
        const s = sd.s[0] + rnd() * (sd.s[1] - sd.s[0]);
        const y = sd.f ? sd.f + rnd() * 4 : 0;
        e.set(0, rnd() * Math.PI * 2, 0);
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
        for (const im of ims) im.setMatrixAt(i, m);
      }
      for (const im of ims) {
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = !this.reduced;
        zv.group.add(im);
        zv.owned.push(im);
      }
    }
    this.group.add(zv.group);
    return zv;
  }

  private buildTown(): ZoneView {
    const zv = this.base(0, TOWN_THEME);
    const c = zoneCenterZ(0);
    // plaza tiles
    const pg = new THREE.CircleGeometry(16, 48).rotateX(-Math.PI / 2);
    const pm = new THREE.MeshLambertMaterial({ color: '#f3e7cf' });
    const plaza = new THREE.Mesh(pg, pm);
    plaza.position.set(0, 0.02, 76);
    plaza.receiveShadow = true;
    const path = new THREE.Mesh(new THREE.PlaneGeometry(7, 40).rotateX(-Math.PI / 2), pm);
    path.position.set(0, 0.03, 52);
    path.receiveShadow = true;
    zv.group.add(plaza, path);
    zv.owned.push(pg, pm, path.geometry);
    // back wall
    const bw = new THREE.BoxGeometry(HALF_W * 2 + 3.2, 3, 1.6);
    const bm = new THREE.MeshLambertMaterial({ color: TOWN_THEME.wall });
    const back = new THREE.Mesh(bw, bm);
    back.position.set(0, 1.5, TOWN_MAX_Z + 0.8);
    zv.group.add(back);
    zv.owned.push(bw, bm);
    // entrance arch to area 1
    const arch = cloneModel('gate_arch', { tint_gate: '#ffffff' });
    arch.position.set(0, 0, c - ZL / 2);
    zv.group.add(arch);
    const fg = new THREE.BoxGeometry(HALF_W - 7, 3, 1.2);
    const fm = new THREE.MeshLambertMaterial({ color: '#c9b88f' });
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(fg, fm);
      f.position.set(s * (7 + (HALF_W - 7) / 2), 1.5, c - ZL / 2);
      zv.group.add(f);
    }
    zv.owned.push(fg, fm);
    const sign = makeLabel([{ text: 'Area 1', size: 26, color: '#ffe9a8' }, { text: 'Sunny Meadow →', size: 36 }], { bg: 'rgba(40,30,70,0.55)', height: 0.85 });
    zv.occluders.push({ z: c - ZL / 2, mats: [...ownMaterials(arch, zv.owned), fm], faded: false, sprites: [sign] });
    sign.position.set(0, 12.2, c - ZL / 2);
    zv.group.add(sign);
    zv.labels.push(sign);
    zv.colliders.push({ x: -6, z: c - ZL / 2, r: 1.6 }, { x: 6, z: c - ZL / 2, r: 1.6 });
    const title = makeLabel([{ text: '🐾 Cubling Town', size: 44, color: '#fff3b0' }], { height: 1.2 });
    title.position.set(0, 9, 76);
    zv.group.add(title);
    zv.labels.push(title);

    for (const st of TOWN.stations) {
      const tint: Record<string, string> =
        st.model === 'present' ? { tint_box: st.tint, tint_ribbon: '#fff06a' } : st.model === 'machine' ? { tint_machine: st.tint, tint_light: '#fff6b0' } : { '*': st.tint };
      const obj = cloneModel(st.model, tint);
      obj.position.set(st.x, 0, st.z);
      obj.rotation.y = st.ry;
      if (st.scale) obj.scale.setScalar(st.scale);
      zv.group.add(obj);
      if (st.model === 'portal') {
        const inner = cloneModel('portal_inner');
        inner.position.set(st.x, 0, st.z);
        inner.rotation.y = st.ry;
        zv.group.add(inner);
        inner.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) this.portalInner = o;
        });
      }
      const lbl = makeLabel([{ text: `${st.icon} ${st.name}`, size: 34 }], { bg: 'rgba(40,30,70,0.6)', height: 0.75 });
      lbl.position.set(st.x, STATION_LABEL_Y[st.model] ?? 5, st.z);
      zv.group.add(lbl);
      zv.labels.push(lbl);
      zv.interact.push({ kind: 'station', id: st.id, label: `${st.icon} ${st.name}`, x: st.x, z: st.z, r: 7 });
      const r = STATION_RADIUS[st.model] ?? 1.5;
      if (r) zv.colliders.push({ x: st.x, z: st.z, r: r * (st.scale ?? 1) * 0.9 });
    }
    for (const d of TOWN.decor) {
      const obj = cloneModel(d.model, d.tint ? { '*': d.tint } : undefined);
      obj.position.set(d.x, 0, d.z);
      if (d.scale) obj.scale.setScalar(d.scale);
      zv.group.add(obj);
      if (d.model === 'fountain') zv.colliders.push({ x: d.x, z: d.z, r: 3.9 * (d.scale ?? 1) });
      if (d.model.startsWith('tree')) zv.colliders.push({ x: d.x, z: d.z, r: 0.6 });
    }
    this.group.add(zv.group);
    return zv;
  }

  private disposeZone(zv: ZoneView) {
    this.group.remove(zv.group);
    for (const o of zv.owned) (o as any).dispose?.();
    for (const l of zv.labels) disposeLabel(l);
    if (zv.gate) disposeLabel(zv.gate.sign);
    if (zv.n === 0) this.portalInner = null;
  }

  // ---------------------------------------------------------------- ambient particles
  private updateAmbient(theme: Theme, px: number, pz: number, dt: number, t: number) {
    if (this.reduced) return;
    const style = AMBIENT[theme.ambient] ?? AMBIENT.sparkle;
    const pos = this.ambient.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const n = pos.count;
    const mat = this.ambient.material as THREE.PointsMaterial;
    if (this.ambientTheme !== theme.ambient) {
      this.ambientTheme = theme.ambient;
      mat.color.set(style.color);
      mat.size = style.size;
      for (let i = 0; i < n; i++) {
        arr[i * 3] = px + (Math.random() - 0.5) * 60;
        arr[i * 3 + 1] = Math.random() * 14;
        arr[i * 3 + 2] = pz + (Math.random() - 0.5) * 60;
        this.ambientVel[i * 3] = (Math.random() - 0.5) * style.drift;
        this.ambientVel[i * 3 + 1] = style.vy * (0.6 + Math.random() * 0.8);
        this.ambientVel[i * 3 + 2] = (Math.random() - 0.5) * style.drift;
      }
    }
    mat.opacity = style.twinkle ? 0.55 + Math.sin(t * 3) * 0.3 : 0.85;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      arr[j] += (this.ambientVel[j] + Math.sin(t + i) * style.wobble) * dt;
      arr[j + 1] += this.ambientVel[j + 1] * dt;
      arr[j + 2] += (this.ambientVel[j + 2] + Math.cos(t * 0.7 + i) * style.wobble) * dt;
      if (arr[j + 1] < 0) arr[j + 1] = 14;
      if (arr[j + 1] > 14) arr[j + 1] = 0;
      if (arr[j] - px > 30) arr[j] -= 60;
      if (arr[j] - px < -30) arr[j] += 60;
      if (arr[j + 2] - pz > 30) arr[j + 2] -= 60;
      if (arr[j + 2] - pz < -30) arr[j + 2] += 60;
    }
    pos.needsUpdate = true;
  }

  dispose() {
    for (const zv of this.zones.values()) this.disposeZone(zv);
    this.zones.clear();
    this.scene.remove(this.group, this.ambient);
    this.ambient.geometry.dispose();
    (this.ambient.material as THREE.Material).dispose();
  }
}

const TOWN_THEME: Theme = {
  id: 'town', name: 'Cubling Town', zoneNames: ['Town'], sky: '#9fdcff', fog: '#d6f0ff', ground: '#9be38a', ground2: '#8ad77a', path: '#f3e7cf',
  wall: '#c9b88f', gate: '#ffffff', accent: '#ffd34d', ambient: 'pollen', scenery: [], mix: {},
};

const AMBIENT: Record<string, { color: string; size: number; vy: number; drift: number; wobble: number; twinkle?: boolean }> = {
  pollen: { color: '#fff6a8', size: 0.22, vy: 0.15, drift: 0.6, wobble: 0.4 },
  sparkle: { color: '#ffffff', size: 0.25, vy: 0.05, drift: 0.2, wobble: 0.2, twinkle: true },
  dust: { color: '#f3d9a8', size: 0.2, vy: 0.05, drift: 1.6, wobble: 0.3 },
  snow: { color: '#ffffff', size: 0.32, vy: -1.4, drift: 0.6, wobble: 0.6 },
  embers: { color: '#ff8a3a', size: 0.28, vy: 1.6, drift: 0.5, wobble: 0.5 },
  fireflies: { color: '#e8ff7a', size: 0.3, vy: 0.05, drift: 0.8, wobble: 1.0, twinkle: true },
  bubbles: { color: '#d8f4ff', size: 0.34, vy: 1.4, drift: 0.2, wobble: 0.5 },
  wisps: { color: '#c6a6ff', size: 0.34, vy: 0.3, drift: 0.6, wobble: 0.8, twinkle: true },
  spores: { color: '#ffd6f6', size: 0.24, vy: 0.4, drift: 0.4, wobble: 0.6 },
  leaves: { color: '#ff9a3a', size: 0.32, vy: -0.9, drift: 1.2, wobble: 0.9 },
  petals: { color: '#ffb8d8', size: 0.3, vy: -0.8, drift: 1.0, wobble: 0.9 },
  confetti: { color: '#ff7ad8', size: 0.28, vy: -0.9, drift: 0.8, wobble: 0.7 },
  data: { color: '#3fe8ff', size: 0.24, vy: 1.2, drift: 0.1, wobble: 0.1, twinkle: true },
  stars: { color: '#ffffff', size: 0.26, vy: 0.0, drift: 0.05, wobble: 0.05, twinkle: true },
};

let dotTex: THREE.Texture | null = null;
function dotTexture() {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  dotTex = new THREE.CanvasTexture(c);
  return dotTex;
}
