import * as THREE from 'three';
import { cloneModel } from './assets';
import { disposeLabel, makeLabel } from './labels';

const HAIR = ['#5a3825', '#2b2238', '#e8b04a', '#c8502a', '#7a4bd8', '#3a8fd8', '#f0e6d0', '#ff7ab8'];
const PANTS = ['#394a7a', '#3a3a4a', '#5a3a7a', '#2f6a5a', '#7a3a3a', '#4a5a8a'];

interface Snap { t: number; x: number; y: number; z: number; ry: number }

export class Avatar {
  readonly root = new THREE.Group();
  private model: THREE.Object3D;
  private parts: Record<string, THREE.Object3D | undefined> = {};
  private label: THREE.Sprite | null = null;
  private phase = 0;
  readonly pos = new THREE.Vector3();
  ry = 0;
  vy = 0;
  grounded = true;
  speed = 0;
  private buf: Snap[] = [];
  private lastPos = new THREE.Vector3();
  private labelKey = '';

  constructor(readonly id: string, color: string, private isLocal: boolean) {
    let h = 0;
    for (const c of id) h = (h * 33 + c.charCodeAt(0)) >>> 0;
    this.model = cloneModel('char', { tint_shirt: color, tint_pants: PANTS[h % PANTS.length], tint_hair: HAIR[(h >>> 3) % HAIR.length] });
    for (const n of ['char_head', 'char_arm_l', 'char_arm_r', 'char_leg_l', 'char_leg_r', 'char_torso']) this.parts[n] = this.model.getObjectByName(n);
    this.root.add(this.model);
  }

  setLabel(name: string, rank: number, rebirths: number, connected: boolean, show: boolean) {
    const key = `${name}|${rank}|${rebirths}|${connected}|${show}`;
    if (key === this.labelKey) return;
    this.labelKey = key;
    if (this.label) {
      this.root.remove(this.label);
      disposeLabel(this.label);
      this.label = null;
    }
    if (!show) return;
    const lines = [{ text: name, color: connected ? '#ffffff' : '#bbbbbb', size: 30 }];
    lines.push({ text: `${rebirths ? `🔄${rebirths} ` : ''}⭐${rank}${connected ? '' : ' · reconnecting…'}`, color: '#ffe48a', size: 22 });
    this.label = makeLabel(lines, { bg: 'rgba(30,20,50,0.45)', height: 0.42 });
    this.label.position.y = 3.25;
    this.root.add(this.label);
  }

  pushSnapshot(x: number, y: number, z: number, ry: number) {
    const t = performance.now();
    this.buf.push({ t, x, y, z, ry });
    if (this.buf.length > 20) this.buf.shift();
    if (this.buf.length === 1) {
      this.pos.set(x, y, z);
      this.ry = ry;
    }
  }

  /** Remote players: render ~120 ms in the past and interpolate between snapshots. */
  interpolate() {
    const rt = performance.now() - 120;
    const b = this.buf;
    if (!b.length) return;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > rt) i--;
    const s1 = b[i];
    const s0 = b[Math.max(0, i - 1)];
    if (s1 === s0 || s1.t <= s0.t || rt >= s1.t) {
      const last = b[b.length - 1];
      this.pos.lerp(new THREE.Vector3(last.x, last.y, last.z), 0.25);
      this.ry = lerpAngle(this.ry, last.ry, 0.25);
      return;
    }
    const k = Math.min(1, Math.max(0, (rt - s0.t) / (s1.t - s0.t)));
    this.pos.set(s0.x + (s1.x - s0.x) * k, s0.y + (s1.y - s0.y) * k, s0.z + (s1.z - s0.z) * k);
    if (this.pos.distanceTo(new THREE.Vector3(s1.x, s1.y, s1.z)) > 25) this.pos.set(s1.x, s1.y, s1.z);
    this.ry = lerpAngle(s0.ry, s1.ry, k);
  }

  snapTo(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.lastPos.copy(this.pos);
    this.buf = [];
  }

  animate(dt: number) {
    const moved = Math.hypot(this.pos.x - this.lastPos.x, this.pos.z - this.lastPos.z);
    const sp = dt > 0 ? moved / dt : 0;
    this.speed += (Math.min(sp, 20) - this.speed) * Math.min(1, dt * 10);
    this.lastPos.copy(this.pos);
    const amt = Math.min(1, this.speed / 8);
    this.phase += dt * (4 + this.speed * 0.9);
    const sw = Math.sin(this.phase) * 0.9 * amt;
    const air = this.pos.y > 0.05;
    if (this.parts.char_leg_l) this.parts.char_leg_l.rotation.x = air ? -0.5 : sw;
    if (this.parts.char_leg_r) this.parts.char_leg_r.rotation.x = air ? 0.3 : -sw;
    if (this.parts.char_arm_l) {
      this.parts.char_arm_l.rotation.x = air ? -2.4 : -sw * 0.9;
      this.parts.char_arm_l.rotation.z = air ? -0.3 : 0;
    }
    if (this.parts.char_arm_r) {
      this.parts.char_arm_r.rotation.x = air ? -2.4 : sw * 0.9;
      this.parts.char_arm_r.rotation.z = air ? 0.3 : 0;
    }
    this.model.position.y = Math.abs(Math.sin(this.phase)) * 0.12 * amt;
    if (this.parts.char_head) this.parts.char_head.rotation.z = Math.sin(this.phase * 0.5) * 0.05 * amt;
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.ry;
  }

  dispose() {
    disposeLabel(this.label);
  }

  get local() {
    return this.isLocal;
  }
}

export function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
