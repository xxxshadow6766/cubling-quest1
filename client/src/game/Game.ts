// The 3D game client: renders the shared world, predicts local movement and visualises server events.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BALANCE, BOOSTS_BY_ID, ENCHANTS_BY_ID, ZONES } from '../../../shared/config';
import { derivedStats, fmt } from '../../../shared/formulas';
import type { BreakableState, PublicPlayer, RewardEvent } from '../../../shared/types';
import { MAX_Z, X_LIMIT, eggStandPos, minZFor, zoneAtZ } from '../../../shared/world';
import { setMusicTheme, sfx } from '../audio';
import { act, bus, emitMove } from '../net';
import { openPanel, store, toast, type PanelId } from '../store';
import { doHatch } from '../ui/actions';
import { animateMaterials } from './assets';
import { Avatar, lerpAngle } from './avatars';
import { BURST_COLOR, Breakables } from './breakables';
import { Effects } from './effects';
import { Input } from './input';
import { PetSwarm } from './pets';
import { World } from './world';

export let currentGame: Game | null = null;

const STATION_PANEL: Record<string, PanelId> = {
  upgrades: 'upgrades', golden: 'golden', rainbow: 'rainbow', enchant: 'enchant', daily: 'daily', index: 'index',
  rebirth: 'rebirth', trade: 'players', quests: 'quests', teleport: 'teleport',
};

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
  readonly input: Input;
  private world: World;
  private effects: Effects;
  private breakables: Breakables;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private avatars = new Map<string, Avatar>();
  private swarms = new Map<string, PetSwarm>();
  private targets: Record<string, Record<string, string>> = {};
  private me: Avatar | null = null;
  private meId = '';
  private vel = new THREE.Vector3();
  private camYaw = 0;
  private camPitch = 0.62;
  private camDist = 17;
  private camTarget = new THREE.Vector3();
  private lastSend = 0;
  private sentPos = new THREE.Vector3(1e9, 0, 0);
  private interactTimer = 0;
  private zone = -1;
  private loaded = new Set<number>();
  private unsub: (() => void)[] = [];
  private clock = new THREE.Clock();
  private width = 1;
  private height = 1;
  private speed = BALANCE.baseWalkSpeed;
  private statsTimer = 0;
  private hatching = false;
  private movedOnce = false;
  private moveDist = 0;
  private nextHatch = 0;
  private fpsAcc = { t: 0, n: 0, checked: false };
  private ro: ResizeObserver;
  private disposed = false;
  private raycaster = new THREE.Raycaster();

  constructor(private container: HTMLElement, overlay: HTMLElement) {
    const settings = store.get().settings;
    const reduced = settings.reducedEffects || settings.quality === 'low';
    this.renderer = new THREE.WebGLRenderer({ antialias: !reduced, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !reduced;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.applyPixelRatio();
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'game-canvas';

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    this.hemi = new THREE.HemisphereLight('#ffffff', '#7a8a6a', 1.5);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff3dc', 2.4);
    this.sun.position.set(18, 30, 12);
    this.sun.castShadow = !reduced;
    this.sun.shadow.mapSize.set(settings.quality === 'high' ? 2048 : 1024, settings.quality === 'high' ? 2048 : 1024);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -32;
    sc.right = sc.top = 32;
    sc.near = 1;
    sc.far = 90;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);

    this.world = new World(this.scene, reduced);
    this.effects = new Effects(this.scene, overlay, reduced);
    this.breakables = new Breakables(this.scene);
    this.input = new Input(this.renderer.domElement, () => store.get().settings.camSens);
    this.input.onTap = (x, y) => this.tap(x, y);
    this.input.onKey = (code) => this.key(code);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    this.unsub.push(
      bus.on('init', (d) => this.init(d)),
      bus.on('s', (snap) => this.onSnapshot(snap)),
      bus.on('pj', (p) => this.upsertPlayer(p)),
      bus.on('pl', (d) => this.removePlayer(d.id)),
      bus.on('pt', (d) => (this.targets[d.id] = d.t)),
      bus.on('bka', (list) => list.forEach((b: BreakableState) => this.breakables.add(b))),
      bus.on('hp', (list) => this.onHp(list)),
      bus.on('bkr', (d) => this.onBreak(d)),
      bus.on('bkrs', (ids) => ids.forEach((id: string) => this.breakables.remove(id))),
      bus.on('reward', (r) => this.onReward(r)),
      bus.on('tp', (p) => this.teleported(p.x, p.z)),
      bus.on('corr', (p) => this.me?.pos.set(p.x, p.y, p.z)),
      bus.on('rankup', () => this.celebrate('#ffe066', 'rankup')),
      bus.on('hatched', (pets: any[]) => this.onHatched(pets)),
      store.subscribe(() => this.onStore()),
    );
    currentGame = this;
    if (import.meta.env.DEV) (window as any).__cq = { game: this, store, act };
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private applyPixelRatio() {
    const s = store.get().settings;
    const max = s.reducedEffects || s.quality === 'low' ? 1 : s.quality === 'high' ? 2 : 1.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, max));
  }

  private lastSettings = store.get().settings;
  private lastMaxZone = 0;
  private onStore() {
    const s = store.get();
    if (s.settings !== this.lastSettings) {
      const reduced = s.settings.reducedEffects || s.settings.quality === 'low';
      this.lastSettings = s.settings;
      this.applyPixelRatio();
      this.renderer.shadowMap.enabled = !reduced;
      this.sun.castShadow = !reduced;
      this.world.setReduced(reduced);
      this.effects.setReduced(reduced);
      for (const p of Object.values(s.players)) this.avatars.get(p.id)?.setLabel(p.name, p.rank, p.rebirths, p.connected, s.settings.showNames || p.id === this.meId);
      this.resize();
    }
    if (s.save && s.save.zone !== this.lastMaxZone) {
      this.lastMaxZone = s.save.zone;
      this.world.setMaxZone(s.save.zone);
    }
  }

  // ---------------------------------------------------------------- network state
  init(d: any) {
    this.meId = d.you.id;
    for (const id of [...this.avatars.keys()]) this.removePlayer(id);
    this.breakables.clear();
    this.targets = d.targets ?? {};
    for (const p of d.players as PublicPlayer[]) this.upsertPlayer(p);
    for (const b of d.breakables as BreakableState[]) this.breakables.add(b);
    const mine = (d.players as PublicPlayer[]).find((p) => p.id === this.meId);
    if (mine) this.teleported(mine.x, mine.z);
    this.world.setMaxZone(d.save.zone);
    this.lastMaxZone = d.save.zone;
  }

  private upsertPlayer(p: PublicPlayer) {
    let av = this.avatars.get(p.id);
    const isMe = p.id === this.meId;
    if (!av) {
      av = new Avatar(p.id, p.color, isMe);
      av.snapTo(p.x, p.y, p.z);
      av.ry = p.ry;
      this.avatars.set(p.id, av);
      this.scene.add(av.root);
      if (isMe) this.me = av;
    }
    av.root.visible = isMe || p.connected;
    av.setLabel(p.name, p.rank, p.rebirths, p.connected, store.get().settings.showNames || isMe);
    let sw = this.swarms.get(p.id);
    if (!sw) {
      sw = new PetSwarm(this.scene, this.effects);
      this.swarms.set(p.id, sw);
    }
    sw.sync(p.connected || isMe ? p.pets : [], av.pos);
  }

  private removePlayer(id: string) {
    const av = this.avatars.get(id);
    if (av) {
      this.scene.remove(av.root);
      av.dispose();
      this.avatars.delete(id);
    }
    this.swarms.get(id)?.dispose();
    this.swarms.delete(id);
    delete this.targets[id];
  }

  private onSnapshot(snap: [string, number, number, number, number][]) {
    for (const [id, x, y, z, ry] of snap) {
      if (id === this.meId) continue;
      this.avatars.get(id)?.pushSnapshot(x, y, z, ry);
    }
  }

  private onHp(list: [string, number][]) {
    const mine = this.targets[this.meId] ?? {};
    const myTargets = new Set(Object.values(mine));
    for (const [id, hp] of list) {
      const delta = this.breakables.setHp(id, hp);
      if (delta <= 0) continue;
      const v = this.breakables.views.get(id);
      if (!v || !v.obj.visible) continue;
      if (Math.random() < 0.35) this.effects.burst(v.pos.clone().setY(v.height * 0.6), BURST_COLOR[v.data.type] ?? '#ffffff', 2, 3, 0.14, 3);
      if (myTargets.has(id)) sfx('hit');
    }
  }

  private onBreak(d: { id: string; x: number; z: number; type: string; by: string[] }) {
    const v = this.breakables.remove(d.id);
    if (!v || !this.loaded.has(v.data.zone)) return;
    const big = d.type === 'boss_chest' || d.type === 'comet';
    const pos = new THREE.Vector3(d.x, v.height * 0.5, d.z);
    this.effects.burst(pos, BURST_COLOR[d.type] ?? '#ffffff', big ? 90 : d.type === 'chest' || d.type === 'safe' ? 36 : 18, big ? 12 : 7, big ? 0.4 : 0.25, big ? 10 : 6);
    if (d.type.startsWith('coins')) this.effects.burst(pos, '#fff2a0', 8, 4, 0.12, 7);
    const meNear = this.me && this.me.pos.distanceTo(pos) < 45;
    if (meNear) sfx(big ? 'bigbreak' : 'break');
    for (const pid of d.by) {
      if (pid === this.meId) continue;
      const av = this.avatars.get(pid);
      if (!av) continue;
      for (let i = 0; i < (big ? 6 : 2); i++) this.effects.coins.spawn(pos, () => av.pos, i * 0.05);
    }
  }

  private onReward(r: RewardEvent) {
    if (!this.me) return;
    const from = new THREE.Vector3(r.x, 1, r.z);
    const me = this.me;
    const n = Math.max(2, Math.min(10, Math.round(2 + Math.log10(1 + r.coins) * 1.2)));
    for (let i = 0; i < n; i++) this.effects.coins.spawn(from, () => me.pos, i * 0.045, () => sfx('coin'));
    for (let i = 0; i < Math.min(r.gems, 6); i++) this.effects.gems.spawn(from, () => me.pos, 0.1 + i * 0.07, () => sfx('gem'));
    if (r.coins > 0) this.effects.number(me.pos.clone().setY(me.pos.y + 3.6), `+${fmt(r.coins)} 🪙`, '#ffe066');
    if (r.gems > 0) this.effects.number(me.pos.clone().setY(me.pos.y + 4.2), `+${fmt(r.gems)} 💎`, '#7fe7ff');
    for (const it of r.items) toast(`🧪 Found a ${BOOSTS_BY_ID[it]?.name ?? it}!`, 'success');
    for (const b of r.books) toast(`📜 Found an enchant book: ${ENCHANTS_BY_ID[b]?.name ?? b}!`, 'success');
    if (r.pets.length) this.celebrate('#ffd23f', 'legendary');
  }

  private onHatched(pets: any[]) {
    if (!this.me) return;
    this.effects.burst(this.me.pos.clone().setY(1.5), '#ffffff', 20, 5, 0.18, 6);
    void pets;
  }

  private celebrate(color: string, sound: string) {
    if (!this.me) return;
    sfx(sound);
    for (let i = 0; i < 3; i++) this.effects.burst(this.me.pos.clone().setY(1 + i), color, 30, 7, 0.25, 8);
  }

  private teleported(x: number, z: number) {
    if (!this.me) return;
    this.me.snapTo(x, 0, z);
    this.vel.set(0, 0, 0);
    this.swarms.get(this.meId)?.snap(this.me.pos);
    this.camTarget.set(x, 2.2, z);
    this.camera.position.set(x + Math.sin(this.camYaw) * this.camDist, 10, z + Math.cos(this.camYaw) * this.camDist);
    this.sentPos.set(1e9, 0, 0);
  }

  // ---------------------------------------------------------------- input
  private tap(x: number, y: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const id = this.breakables.pick(this.raycaster);
    if (id) {
      const v = this.breakables.views.get(id)!;
      act('target', { bk: id }).then((r) => {
        if (r.ok) {
          sfx(r.toggledOff ? 'pop' : 'click');
          this.effects.burst(v.pos.clone().setY(0.3), r.toggledOff ? '#aaaaaa' : '#7cf0ff', 10, 4, 0.14, 2);
          bus.emit('targeted', id);
        } else sfx('error');
      });
    }
  }

  private key(code: string) {
    const s = store.get();
    if (code === 'Escape') {
      if (s.panel) store.set({ panel: null });
      return;
    }
    if (s.panel || s.hatch) return;
    if (code === 'KeyE') this.interact();
    else if (code === 'KeyF') toggleAutoFarm();
    else if (code === 'KeyP' || code === 'KeyI') openPanel('pets');
    else if (code === 'KeyQ') openPanel('quests');
    else if (code === 'KeyT') openPanel('teleport');
    else if (code === 'Enter') store.set({ chatOpen: true });
  }

  interact() {
    const it = store.get().interact;
    if (!it) return;
    sfx('click');
    if (it.kind === 'egg') openPanel('egg', { zone: it.zone });
    else if (it.kind === 'gate') openPanel('gate', { zone: it.zone });
    else openPanel(STATION_PANEL[it.id] ?? null, { station: it.id });
  }

  jump() {
    this.input.jumpQueued = true;
  }

  private updateInteract() {
    const s = store.get();
    if (!this.me || !s.save) return;
    let best: (typeof this.world.interactables)[number] | null = null;
    let bd = Infinity;
    for (const it of this.world.interactables) {
      if (it.kind === 'egg' && (it.zone ?? 0) > s.save.zone) continue;
      const d = Math.hypot(it.x - this.me.pos.x, it.z - this.me.pos.z);
      if (d < it.r && d < bd) {
        bd = d;
        best = it;
      }
    }
    const cur = s.interact;
    if ((best?.id ?? null) !== (cur?.id ?? null)) {
      store.set({ interact: best ? { kind: best.kind, id: best.id, label: best.label, zone: best.zone } : null });
    }
  }

  // ---------------------------------------------------------------- frame
  private resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 68 : 55;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    if (this.disposed) return;
    const dt = Math.min(0.1, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const s = store.get();
    const me = this.me;

    if (me && s.save) {
      this.statsTimer -= dt;
      if (this.statsTimer <= 0) {
        this.statsTimer = 0.5;
        let aura = 0;
        for (const p of Object.values(s.players)) if (p.connected) aura += p.pets.filter((x) => x.hg).length;
        this.speed = derivedStats(s.save, Date.now(), aura).speed;
      }
      this.moveLocal(dt, s.save.zone, !!(s.panel && s.isTouch));
      const z = zoneAtZ(me.pos.z);
      if (z !== this.zone) {
        this.zone = z;
        store.set({ zone: z });
        setMusicTheme(z === 0 ? 0 : ZONES[z].themeIndex);
      }
      this.loaded.clear();
      for (const n of [z - 1, z, z + 1]) if (n >= 0) this.loaded.add(n);
      this.world.update(z, me.pos.x, me.pos.z, dt, t);
      this.interactTimer -= dt;
      if (this.interactTimer <= 0) {
        this.interactTimer = 0.15;
        this.updateInteract();
      }
      this.autoHatchTick();
      // sun follows the player so shadows stay crisp nearby
      this.sun.position.set(me.pos.x + 18, 34, me.pos.z + 14);
      this.sun.target.position.set(me.pos.x, 0, me.pos.z);
    }

    for (const av of this.avatars.values()) {
      if (av !== me) av.interpolate();
      av.animate(dt);
    }
    const getBk = (id: string) => this.breakables.info(id);
    const reduced = s.settings.reducedEffects;
    for (const [pid, sw] of this.swarms) {
      const av = this.avatars.get(pid);
      if (!av) continue;
      sw.update(dt, t, av.pos, av.ry, this.targets[pid], getBk, reduced);
    }
    this.breakables.update(dt, this.camera, this.loaded, (v, dmg) => {
      this.effects.number(v.pos.clone().setY(v.height + 1.4), fmt(dmg), v.data.ev ? '#f3d1ff' : '#ffffff', !!v.data.ev);
    });
    animateMaterials(t);
    this.updateCamera(dt);
    if (me) this.world.updateOcclusion(this.camera.position.z, me.pos.z);
    this.effects.update(dt, this.camera, this.width, this.height);
    this.renderer.render(this.scene, this.camera);
    this.autoQuality(dt);
  }

  private moveLocal(dt: number, maxZone: number, frozen: boolean) {
    const me = this.me!;
    const mv = frozen ? { x: 0, y: 0 } : this.input.move();
    const fwdX = -Math.sin(this.camYaw);
    const fwdZ = -Math.cos(this.camYaw);
    const rightX = Math.cos(this.camYaw);
    const rightZ = -Math.sin(this.camYaw);
    const dx = fwdX * mv.y + rightX * mv.x;
    const dz = fwdZ * mv.y + rightZ * mv.x;
    const k = 1 - Math.exp(-dt * 14);
    this.vel.x += (dx * this.speed - this.vel.x) * k;
    this.vel.z += (dz * this.speed - this.vel.z) * k;
    me.pos.x += this.vel.x * dt;
    me.pos.z += this.vel.z * dt;
    if (Math.hypot(dx, dz) > 0.1) me.ry = lerpAngle(me.ry, Math.atan2(dx, dz), Math.min(1, dt * 12));
    if (this.input.jumpQueued) {
      this.input.jumpQueued = false;
      if (me.grounded) {
        me.vy = 10.5;
        me.grounded = false;
        sfx('jump');
      }
    }
    me.vy -= 30 * dt;
    me.pos.y += me.vy * dt;
    if (me.pos.y <= 0) {
      me.pos.y = 0;
      me.vy = 0;
      me.grounded = true;
    }
    const minZ = minZFor(maxZone);
    me.pos.x = Math.max(-X_LIMIT, Math.min(X_LIMIT, me.pos.x));
    me.pos.z = Math.max(minZ, Math.min(MAX_Z, me.pos.z));
    for (const c of this.world.colliders) {
      const ddx = me.pos.x - c.x;
      const ddz = me.pos.z - c.z;
      const d = Math.hypot(ddx, ddz);
      const min = c.r + 0.55;
      if (d < min && d > 1e-4) {
        me.pos.x = c.x + (ddx / d) * min;
        me.pos.z = c.z + (ddz / d) * min;
      }
    }
    if (!this.movedOnce && Math.hypot(this.vel.x, this.vel.z) > 1) {
      this.moveDist += Math.hypot(this.vel.x, this.vel.z) * dt;
      if (this.moveDist > 4) {
        this.movedOnce = true;
        bus.emit('moved');
      }
    }
    const now = performance.now();
    const moved = this.sentPos.distanceTo(me.pos) > 0.03;
    if ((moved && now - this.lastSend > 100) || now - this.lastSend > 1000) {
      this.lastSend = now;
      this.sentPos.copy(me.pos);
      emitMove(+me.pos.x.toFixed(2), +me.pos.y.toFixed(2), +me.pos.z.toFixed(2), +me.ry.toFixed(2));
    }
  }

  private updateCamera(dt: number) {
    const l = this.input.consumeLook();
    this.camYaw += l.yaw;
    this.camPitch = Math.max(0.12, Math.min(1.3, this.camPitch + l.pitch));
    this.camDist = Math.max(7, Math.min(36, this.camDist + l.zoom));
    if (!this.me) return;
    const target = this.me.pos.clone().add(new THREE.Vector3(0, 2.2, 0));
    this.camTarget.lerp(target, 1 - Math.exp(-dt * 10));
    const cp = Math.cos(this.camPitch);
    const desired = new THREE.Vector3(
      this.camTarget.x + Math.sin(this.camYaw) * cp * this.camDist,
      this.camTarget.y + Math.sin(this.camPitch) * this.camDist,
      this.camTarget.z + Math.cos(this.camYaw) * cp * this.camDist,
    );
    this.camera.position.lerp(desired, 1 - Math.exp(-dt * 14));
    this.camera.lookAt(this.camTarget);
  }

  private autoHatchTick() {
    const s = store.get();
    const zone = s.autoHatch;
    if (!zone || this.hatching || !this.me || !s.save) return;
    if (performance.now() < this.nextHatch || s.hatch) return;
    const ep = eggStandPos(zone);
    if (Math.hypot(ep.x - this.me.pos.x, ep.z - this.me.pos.z) > BALANCE.interactRange + 2) {
      store.set({ autoHatch: null });
      toast('Auto Hatch stopped — you walked away from the egg.', 'info');
      return;
    }
    const st = derivedStats(s.save, Date.now());
    const count = Math.max(...st.hatchCounts);
    if (s.save.coins < ZONES[zone].eggCost * count) {
      store.set({ autoHatch: null });
      toast('Auto Hatch stopped — not enough coins.', 'info');
      return;
    }
    this.hatching = true;
    doHatch(zone, count, true).then((r) => {
      this.hatching = false;
      this.nextHatch = performance.now() + st.hatchCooldown * 1000 + 120;
      if (!r.ok) store.set({ autoHatch: null });
    });
  }

  private autoQuality(dt: number) {
    const s = store.get().settings;
    if (s.quality !== 'auto' || this.fpsAcc.checked) return;
    this.fpsAcc.t += dt;
    this.fpsAcc.n++;
    if (this.fpsAcc.t > 4) {
      const fps = this.fpsAcc.n / this.fpsAcc.t;
      this.fpsAcc.checked = true;
      if (fps < 40) {
        this.renderer.setPixelRatio(1);
        this.renderer.shadowMap.enabled = false;
        this.sun.castShadow = false;
        this.resize();
        console.info(`[quality] low FPS (${fps.toFixed(0)}), reducing render quality`);
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    for (const u of this.unsub) u();
    this.ro.disconnect();
    this.input.dispose();
    for (const id of [...this.avatars.keys()]) this.removePlayer(id);
    this.breakables.clear();
    this.world.dispose();
    this.effects.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    if (currentGame === this) currentGame = null;
  }
}

export function toggleAutoFarm() {
  const on = !store.get().autoFarm;
  act('autoFarm', { on }).then((r) => {
    if (r.ok) {
      store.set({ autoFarm: on });
      sfx(on ? 'unlock' : 'pop');
      toast(on ? '🤖 Auto Farm ON — your pets attack nearby objects automatically.' : 'Auto Farm OFF', 'info');
    }
  });
}
