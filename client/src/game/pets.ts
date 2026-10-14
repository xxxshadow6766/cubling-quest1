// Pet followers: neat formation behind the owner, then hop over to attack assigned breakables.
import * as THREE from 'three';
import { BALANCE } from '../../../shared/config';
import type { PetInstance } from '../../../shared/types';
import { createPetMesh } from './assets';
import { lerpAngle } from './avatars';
import type { Effects } from './effects';

type PetLook = Pick<PetInstance, 'id' | 's' | 'v' | 'sh' | 'hg'>;

interface PetActor {
  look: PetLook;
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  yaw: number;
  phase: number;
  scale: number;
  sparkleT: number;
}

export interface BkInfo { pos: THREE.Vector3; radius: number }

const _d = new THREE.Vector3();
const _want = new THREE.Vector3();

export class PetSwarm {
  private actors = new Map<string, PetActor>();
  private order: string[] = [];

  constructor(private scene: THREE.Scene, private effects: Effects) {}

  sync(pets: PetLook[], owner: THREE.Vector3) {
    const keep = new Set(pets.map((p) => p.id));
    for (const [id, a] of this.actors) {
      if (!keep.has(id) || a.look.v !== pets.find((p) => p.id === id)?.v) {
        this.scene.remove(a.mesh);
        this.actors.delete(id);
      }
    }
    for (const p of pets) {
      if (this.actors.has(p.id)) continue;
      const mesh = createPetMesh(p, BALANCE.hugeScale);
      const pos = owner.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2));
      mesh.position.copy(pos);
      this.scene.add(mesh);
      this.actors.set(p.id, { look: p, mesh, pos, yaw: 0, phase: Math.random() * 10, scale: p.hg ? BALANCE.hugeScale : 1, sparkleT: Math.random() });
      this.effects.burst(pos.clone().setY(0.6), '#ffffff', 8, 3, 0.15, 3);
    }
    // huge pets first so they lead the formation
    this.order = [...pets].sort((a, b) => Number(!!b.hg) - Number(!!a.hg)).map((p) => p.id);
  }

  snap(owner: THREE.Vector3) {
    for (const a of this.actors.values()) a.pos.copy(owner);
  }

  update(dt: number, t: number, owner: THREE.Vector3, ownerRy: number, targets: Record<string, string> | undefined, getBk: (id: string) => BkInfo | null, reduced: boolean) {
    const attackers = new Map<string, string[]>();
    if (targets) {
      for (const id of this.order) {
        const bk = targets[id];
        if (bk) attackers.set(bk, [...(attackers.get(bk) ?? []), id]);
      }
    }
    const sin = Math.sin(ownerRy);
    const cos = Math.cos(ownerRy);
    let slot = 0;
    let rowX = 0;
    for (const id of this.order) {
      const a = this.actors.get(id);
      if (!a) continue;
      const bkId = targets?.[id];
      const bk = bkId ? getBk(bkId) : null;
      let attacking = false;
      if (bk) {
        const list = attackers.get(bkId!)!;
        const i = list.indexOf(id);
        const ang = (i / list.length) * Math.PI * 2 + hashAngle(bkId!);
        const r = bk.radius + 0.7 + a.scale * 0.45;
        _want.set(bk.pos.x + Math.cos(ang) * r, 0, bk.pos.z + Math.sin(ang) * r);
        attacking = true;
      } else {
        // arc formation around the owner's back so pets stay visible from the camera
        const PER_ROW = 5;
        const row = Math.floor(slot / PER_ROW);
        const col = slot % PER_ROW;
        const inRow = Math.min(PER_ROW, this.order.length - row * PER_ROW);
        const ang = inRow === 1 ? 0.75 : -1.25 + (2.5 * col) / (inRow - 1);
        const R = 2.6 + row * 1.9 + (a.scale > 1 ? 1.6 : 0) + rowX;
        const lx = Math.sin(ang) * R;
        const lz = -Math.cos(ang) * R;
        _want.set(owner.x + lx * cos + lz * sin, 0, owner.z - lx * sin + lz * cos);
        slot++;
      }
      _d.subVectors(_want, a.pos);
      _d.y = 0;
      const dist = _d.length();
      if (dist > 70) {
        a.pos.copy(_want);
      } else if (dist > 0.05) {
        const sp = Math.max(13, dist * 3.2);
        a.pos.addScaledVector(_d.normalize(), Math.min(dist, sp * dt));
      }
      const moving = dist > 0.4;
      let yawTarget = a.yaw;
      if (attacking && bk) yawTarget = Math.atan2(bk.pos.x - a.pos.x, bk.pos.z - a.pos.z);
      else if (moving) yawTarget = Math.atan2(_d.x, _d.z);
      else yawTarget = ownerRy;
      a.yaw = lerpAngle(a.yaw, yawTarget, Math.min(1, dt * 10));
      a.phase += dt * (attacking ? 11 : moving ? 10 : 2.4);
      const hop = attacking ? Math.abs(Math.sin(a.phase)) * 0.75 : moving ? Math.abs(Math.sin(a.phase)) * 0.35 : Math.sin(a.phase) * 0.06 + 0.06;
      a.mesh.position.set(a.pos.x, hop * Math.sqrt(a.scale), a.pos.z);
      a.mesh.rotation.set(attacking ? Math.sin(a.phase) * 0.25 : moving ? 0.12 : 0, a.yaw, 0);
      const squash = attacking ? 1 + Math.cos(a.phase * 2) * 0.06 : 1;
      a.mesh.scale.set(a.scale * (2 - squash), a.scale * squash, a.scale * (2 - squash));
      if ((a.look.sh || a.look.hg || a.look.v === 'rainbow') && !reduced) {
        a.sparkleT -= dt;
        if (a.sparkleT <= 0) {
          a.sparkleT = a.look.hg ? 0.25 : 0.5;
          const c = a.look.v === 'rainbow' ? new THREE.Color().setHSL((t * 0.3) % 1, 1, 0.6) : a.look.hg ? '#ffe066' : '#ffffff';
          this.effects.burst(a.mesh.position.clone().add(new THREE.Vector3(0, a.scale * 0.8, 0)), c, 2, 1.5, 0.1, 2);
        }
      }
    }
  }

  dispose() {
    for (const a of this.actors.values()) this.scene.remove(a.mesh);
    this.actors.clear();
  }
}

function hashAngle(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 628) / 100;
}
