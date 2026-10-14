// Shared breakables (coins, crates, safes, chests, presents, boss chests, comets) as seen by this client.
import * as THREE from 'three';
import { BALANCE } from '../../../shared/config';
import { fmt } from '../../../shared/formulas';
import type { BreakableState } from '../../../shared/types';
import { cloneModel } from './assets';
import { disposeLabel, makeLabel } from './labels';

const PRESENT_COLORS = ['#ff6fae', '#6fb8ff', '#7ee081', '#b77bff', '#ffb347'];
const TINT: Record<string, Record<string, string>> = {
  boss_chest: { tint_chest: '#6a2fd8' },
  comet: { tint_comet: '#7c5cff' },
};
export const BURST_COLOR: Record<string, string> = {
  coins_small: '#ffd23f', coins_large: '#ffc21a', crate: '#c8894a', present: '#ff6fae', safe: '#8b93a7', chest: '#ffb02e', boss_chest: '#b77bff', comet: '#9b7cff',
};

export interface BkView {
  data: BreakableState;
  obj: THREE.Group;
  model: THREE.Object3D;
  hit: THREE.Mesh;
  bar: THREE.Group;
  fg: THREE.Mesh;
  label: THREE.Sprite | null;
  radius: number;
  height: number;
  baseScale: number;
  shake: number;
  spawn: number;
  pendingDmg: number;
  numTimer: number;
  pos: THREE.Vector3;
}

const heightCache = new Map<string, number>();
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const barGeo = new THREE.PlaneGeometry(1, 1);
const barBgMat = new THREE.MeshBasicMaterial({ color: '#2a2040', transparent: true, opacity: 0.8, depthWrite: false });

function hash(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export class Breakables {
  readonly views = new Map<string, BkView>();
  readonly group = new THREE.Group();
  private hitList: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  clear() {
    for (const id of [...this.views.keys()]) this.remove(id);
  }

  add(b: BreakableState) {
    if (this.views.has(b.id)) return;
    const def = BALANCE.breakables[b.type] ?? BALANCE.breakables.crate;
    const h = hash(b.id);
    const tint = b.type === 'present' ? { tint_box: PRESENT_COLORS[h % PRESENT_COLORS.length], tint_ribbon: '#fff06a' } : TINT[b.type];
    const model = cloneModel(def.model, tint);
    const obj = new THREE.Group();
    obj.add(model);
    model.rotation.y = (h % 628) / 100;
    obj.position.set(b.x, 0, b.z);
    let height = heightCache.get(def.model);
    if (height === undefined) {
      height = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y || 1;
      heightCache.set(def.model, height);
    }
    height *= def.scale;
    const radius = def.radius;
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.15, radius * 1.15, height + 0.6, 10), hitMat);
    hit.position.y = (height + 0.6) / 2;
    hit.userData.bk = b.id;
    obj.add(hit);
    const bar = new THREE.Group();
    const w = Math.min(5, Math.max(1.5, radius * 1.7));
    const bg = new THREE.Mesh(barGeo, barBgMat);
    bg.scale.set(w + 0.12, 0.3, 1);
    const fg = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({ color: '#5ee26a', depthWrite: false }));
    fg.scale.set(w, 0.2, 1);
    fg.position.z = 0.01;
    fg.userData.w = w;
    bar.add(bg, fg);
    bar.position.y = height + 0.8;
    bar.visible = false;
    bar.renderOrder = 5;
    obj.add(bar);
    let label: THREE.Sprite | null = null;
    if (b.ev) {
      label = makeLabel([{ text: b.ev === 'boss' ? '👑 Boss Chest' : '☄️ Comet', size: 34, color: b.ev === 'boss' ? '#f3d1ff' : '#d6ccff' }, { text: `❤ ${fmt(b.hp)}`, size: 26 }], { bg: 'rgba(40,20,70,0.6)', height: 0.8 });
      label.position.y = height + 2.2;
      obj.add(label);
      bar.visible = true;
    }
    this.group.add(obj);
    const view: BkView = {
      data: { ...b }, obj, model, hit, bar, fg, label, radius, height, baseScale: def.scale, shake: 0, spawn: 0, pendingDmg: 0, numTimer: 0, pos: obj.position,
    };
    this.views.set(b.id, view);
    this.hitList.push(hit);
    this.applyHp(view);
    return view;
  }

  /** Returns the damage delta (>0 when hit). */
  setHp(id: string, hp: number): number {
    const v = this.views.get(id);
    if (!v) return 0;
    const delta = v.data.hp - hp;
    v.data.hp = hp;
    if (delta > 0) {
      v.shake = 1;
      v.pendingDmg += delta;
    }
    this.applyHp(v);
    return delta;
  }

  private applyHp(v: BkView) {
    const frac = Math.max(0, Math.min(1, v.data.hp / v.data.maxHp));
    const w = v.fg.userData.w as number;
    v.fg.scale.x = Math.max(0.001, w * frac);
    v.fg.position.x = -(w - w * frac) / 2;
    (v.fg.material as THREE.MeshBasicMaterial).color.setHSL(0.33 * frac, 0.8, 0.55);
    if (frac < 1) v.bar.visible = true;
    if (v.label && v.data.ev) {
      const now = Date.now();
      if (!v.label.userData.t || now - v.label.userData.t > 250) {
        v.obj.remove(v.label);
        disposeLabel(v.label);
        v.label = makeLabel([{ text: v.data.ev === 'boss' ? '👑 Boss Chest' : '☄️ Comet', size: 34, color: v.data.ev === 'boss' ? '#f3d1ff' : '#d6ccff' }, { text: `❤ ${fmt(v.data.hp)}`, size: 26 }], { bg: 'rgba(40,20,70,0.6)', height: 0.8 });
        v.label.position.y = v.height + 2.2;
        v.label.userData.t = now;
        v.obj.add(v.label);
      }
    }
  }

  remove(id: string): BkView | null {
    const v = this.views.get(id);
    if (!v) return null;
    this.views.delete(id);
    this.group.remove(v.obj);
    v.hit.geometry.dispose();
    (v.fg.material as THREE.Material).dispose();
    disposeLabel(v.label);
    this.hitList = this.hitList.filter((h) => h !== v.hit);
    return v;
  }

  info(id: string) {
    const v = this.views.get(id);
    return v && v.obj.visible ? { pos: v.pos, radius: v.radius } : null;
  }

  pick(ray: THREE.Raycaster): string | null {
    const hits = ray.intersectObjects(this.hitList.filter((h) => h.parent!.visible), false);
    return hits.length ? (hits[0].object.userData.bk as string) : null;
  }

  update(dt: number, camera: THREE.Camera, loaded: Set<number>, onNumber: (v: BkView, dmg: number) => void) {
    for (const v of this.views.values()) {
      v.obj.visible = loaded.has(v.data.zone);
      if (!v.obj.visible) continue;
      if (v.spawn < 1) v.spawn = Math.min(1, v.spawn + dt * 4);
      const pop = v.spawn < 1 ? easeOutBack(v.spawn) : 1;
      v.shake = Math.max(0, v.shake - dt * 6);
      const s = v.baseScale * pop * (1 + Math.sin(v.shake * 20) * 0.08 * v.shake);
      v.model.scale.setScalar(s);
      if (v.data.ev === 'comet') v.model.rotation.y += dt * 0.5;
      if (v.bar.visible) v.bar.quaternion.copy(camera.quaternion);
      v.numTimer -= dt;
      if (v.pendingDmg > 0 && v.numTimer <= 0) {
        onNumber(v, v.pendingDmg);
        v.pendingDmg = 0;
        v.numTimer = 0.3;
      }
    }
  }
}

function easeOutBack(x: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
