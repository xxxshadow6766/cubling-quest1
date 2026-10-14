// Pooled, capped visual effects: particle bursts, flying coins/gems, floating damage numbers.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { meshParts } from './assets';

function mergedModel(name: string): THREE.BufferGeometry {
  const gs = meshParts(name).map((p) => {
    let g = p.geometry.clone();
    for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal') g.deleteAttribute(a);
    if (g.index) g = g.toNonIndexed();
    return g;
  });
  return (gs.length && mergeGeometries(gs)) || new THREE.BoxGeometry(0.4, 0.4, 0.1);
}

interface Flyer {
  active: boolean;
  t: number;
  dur: number;
  delay: number;
  from: THREE.Vector3;
  mid: THREE.Vector3;
  target: () => THREE.Vector3 | null;
  spin: number;
  onArrive?: () => void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

class FlyerPool {
  mesh: THREE.InstancedMesh;
  items: Flyer[];
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, private scale: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.items = Array.from({ length: n }, () => ({ active: false, t: 0, dur: 1, delay: 0, from: new THREE.Vector3(), mid: new THREE.Vector3(), target: () => null, spin: 0 }));
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, HIDDEN);
  }
  spawn(from: THREE.Vector3, target: () => THREE.Vector3 | null, delay: number, onArrive?: () => void) {
    const f = this.items.find((x) => !x.active);
    if (!f) return;
    f.active = true;
    f.t = 0;
    f.delay = delay;
    f.dur = 0.75 + Math.random() * 0.35;
    f.from.copy(from);
    const a = Math.random() * Math.PI * 2;
    const r = 1 + Math.random() * 2.2;
    f.mid.set(from.x + Math.cos(a) * r, from.y + 1.5 + Math.random() * 2, from.z + Math.sin(a) * r);
    f.target = target;
    f.spin = Math.random() * 10;
    f.onArrive = onArrive;
  }
  update(dt: number) {
    let any = false;
    this.items.forEach((f, i) => {
      if (!f.active) return;
      any = true;
      if (f.delay > 0) {
        f.delay -= dt;
        this.mesh.setMatrixAt(i, HIDDEN);
        return;
      }
      f.t += dt / f.dur;
      const tgt = f.target();
      if (f.t >= 1 || !tgt) {
        f.active = false;
        this.mesh.setMatrixAt(i, HIDDEN);
        if (tgt) f.onArrive?.();
        return;
      }
      const t = f.t;
      if (t < 0.4) {
        const k = t / 0.4;
        const ease = 1 - (1 - k) * (1 - k);
        _v.lerpVectors(f.from, f.mid, ease);
        _v.y += Math.sin(k * Math.PI) * 0.8;
      } else {
        const k = (t - 0.4) / 0.6;
        const ease = k * k;
        _v.lerpVectors(f.mid, _s.copy(tgt).setY(tgt.y + 1.4), ease);
      }
      _e.set(0, f.spin + t * 14, 0);
      _q.setFromEuler(_e);
      const sc = this.scale * (t > 0.85 ? 1 - (t - 0.85) / 0.15 * 0.6 : 1);
      _m.compose(_v, _q, _s.set(sc, sc, sc));
      this.mesh.setMatrixAt(i, _m);
    });
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

interface Particle { life: number; max: number; size: number }

export class Effects {
  private parts: THREE.InstancedMesh;
  private pData: Particle[];
  private pPos: Float32Array;
  private pVel: Float32Array;
  private pNext = 0;
  readonly coins: FlyerPool;
  readonly gems: FlyerPool;
  private numbers: { el: HTMLDivElement; pos: THREE.Vector3; life: number; active: boolean }[] = [];
  private numLayer: HTMLDivElement;
  private reduced: boolean;

  constructor(private scene: THREE.Scene, overlay: HTMLElement, reduced: boolean) {
    this.reduced = reduced;
    const N = reduced ? 120 : 420;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1, emissive: '#222222' });
    this.parts = new THREE.InstancedMesh(geo, mat, N);
    this.parts.frustumCulled = false;
    this.pData = Array.from({ length: N }, () => ({ life: 0, max: 1, size: 0.2 }));
    this.pPos = new Float32Array(N * 3);
    this.pVel = new Float32Array(N * 3);
    const white = new THREE.Color('#ffffff');
    for (let i = 0; i < N; i++) {
      this.parts.setMatrixAt(i, HIDDEN);
      this.parts.setColorAt(i, white);
    }
    scene.add(this.parts);

    const coinMat = new THREE.MeshStandardMaterial({ color: '#ffcc33', metalness: 0.85, roughness: 0.25, emissive: '#7a5200', emissiveIntensity: 0.5 });
    this.coins = new FlyerPool(mergedModel('coin'), coinMat, reduced ? 40 : 140, 0.9);
    const gemMat = new THREE.MeshStandardMaterial({ color: '#43e0ff', metalness: 0.1, roughness: 0.05, emissive: '#1fa8d8', emissiveIntensity: 0.6 });
    this.gems = new FlyerPool(mergedModel('gem'), gemMat, reduced ? 12 : 40, 0.9);
    scene.add(this.coins.mesh, this.gems.mesh);

    this.numLayer = document.createElement('div');
    this.numLayer.className = 'dmg-layer';
    overlay.appendChild(this.numLayer);
    const nNum = reduced ? 10 : 28;
    for (let i = 0; i < nNum; i++) {
      const el = document.createElement('div');
      el.className = 'dmg-num';
      el.style.display = 'none';
      this.numLayer.appendChild(el);
      this.numbers.push({ el, pos: new THREE.Vector3(), life: 0, active: false });
    }
  }

  setReduced(r: boolean) {
    this.reduced = r;
  }

  burst(pos: THREE.Vector3, color: THREE.ColorRepresentation, count: number, speed = 6, size = 0.22, up = 4) {
    const n = this.reduced ? Math.ceil(count / 3) : count;
    const col = new THREE.Color(color);
    const tmp = new THREE.Color();
    const N = this.pData.length;
    for (let k = 0; k < n; k++) {
      const i = this.pNext;
      this.pNext = (this.pNext + 1) % N;
      const p = this.pData[i];
      p.life = p.max = 0.5 + Math.random() * 0.6;
      p.size = size * (0.6 + Math.random() * 0.8);
      this.pPos.set([pos.x, pos.y, pos.z], i * 3);
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.pVel.set([Math.cos(a) * s, up * (0.5 + Math.random()), Math.sin(a) * s], i * 3);
      tmp.copy(col).offsetHSL((Math.random() - 0.5) * 0.06, 0, (Math.random() - 0.5) * 0.15);
      this.parts.setColorAt(i, tmp);
    }
    if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;
  }

  number(pos: THREE.Vector3, text: string, color = '#ffffff', big = false) {
    const n = this.numbers.find((x) => !x.active) ?? this.numbers.reduce((a, b) => (a.life < b.life ? a : b));
    n.active = true;
    n.life = 1;
    n.pos.copy(pos);
    n.pos.x += (Math.random() - 0.5) * 0.8;
    n.el.textContent = text;
    n.el.style.color = color;
    n.el.style.fontSize = big ? '30px' : '22px';
    n.el.style.display = 'block';
  }

  update(dt: number, camera: THREE.Camera, w: number, h: number) {
    const N = this.pData.length;
    let any = false;
    for (let i = 0; i < N; i++) {
      const p = this.pData[i];
      if (p.life <= 0) continue;
      any = true;
      p.life -= dt;
      if (p.life <= 0) {
        this.parts.setMatrixAt(i, HIDDEN);
        continue;
      }
      const j = i * 3;
      this.pVel[j + 1] -= 14 * dt;
      this.pPos[j] += this.pVel[j] * dt;
      this.pPos[j + 1] = Math.max(0.05, this.pPos[j + 1] + this.pVel[j + 1] * dt);
      this.pPos[j + 2] += this.pVel[j + 2] * dt;
      const s = p.size * Math.min(1, p.life / p.max * 2);
      _e.set(p.life * 6, p.life * 4, 0);
      _q.setFromEuler(_e);
      _m.compose(_v.set(this.pPos[j], this.pPos[j + 1], this.pPos[j + 2]), _q, _s.set(s, s, s));
      this.parts.setMatrixAt(i, _m);
    }
    if (any) this.parts.instanceMatrix.needsUpdate = true;
    this.coins.update(dt);
    this.gems.update(dt);
    for (const n of this.numbers) {
      if (!n.active) continue;
      n.life -= dt * 1.1;
      if (n.life <= 0) {
        n.active = false;
        n.el.style.display = 'none';
        continue;
      }
      n.pos.y += dt * 1.6;
      _v.copy(n.pos).project(camera);
      if (_v.z > 1) {
        n.el.style.display = 'none';
        continue;
      }
      n.el.style.display = 'block';
      const x = (_v.x * 0.5 + 0.5) * w;
      const y = (-_v.y * 0.5 + 0.5) * h;
      const sc = 0.8 + Math.min(1, (1 - n.life) * 6) * 0.4;
      n.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${sc.toFixed(2)})`;
      n.el.style.opacity = String(Math.min(1, n.life * 2));
    }
  }

  dispose() {
    this.scene.remove(this.parts, this.coins.mesh, this.gems.mesh);
    this.parts.dispose();
    this.numLayer.remove();
  }
}
