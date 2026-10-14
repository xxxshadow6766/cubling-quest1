// Loads the Blender-built assets.glb and provides tinted clones, merged pet meshes and thumbnails.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EGG_FAMILIES, SPECIES_BY_ID, ZONES } from '../../../shared/config';
import type { PetInstance } from '../../../shared/types';

const nodes = new Map<string, THREE.Object3D>();
let loading: Promise<void> | null = null;

export function loadAssets(): Promise<void> {
  if (!loading) {
    loading = new GLTFLoader().loadAsync('/models/assets.glb').then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      for (const child of gltf.scene.children) nodes.set(child.name, child);
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

export const hasModel = (name: string) => nodes.has(name);

// ---------------------------------------------------------------- materials
const matCache = new Map<string, THREE.Material>();
function tintMaterial(mat: THREE.Material, tint: string | Record<string, string>): THREE.Material {
  const name = mat.name || '';
  if (!name.startsWith('tint_')) return mat;
  const color = typeof tint === 'string' ? tint : tint[name] ?? tint['*'];
  if (!color) return mat;
  const key = `${name}|${color}`;
  let m = matCache.get(key);
  if (!m) {
    const c = (mat as THREE.MeshStandardMaterial).clone();
    c.color.set(color);
    if (c.emissive && c.emissive.r + c.emissive.g + c.emissive.b > 0.001) c.emissive.set(color);
    m = c;
    matCache.set(key, m);
  }
  return m;
}

/** Deep clone of a model (geometry shared), with tint_* materials recoloured. */
export function cloneModel(name: string, tint?: string | Record<string, string>, shadows = true): THREE.Object3D {
  const src = nodes.get(name);
  if (!src) {
    const fallback = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: typeof tint === 'string' ? tint : '#ff66cc' }));
    fallback.position.y = 0.5;
    const g = new THREE.Group();
    g.add(fallback);
    return g;
  }
  const obj = src.clone(true);
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      if (tint) m.material = Array.isArray(m.material) ? m.material.map((x) => tintMaterial(x, tint)) : tintMaterial(m.material, tint);
      m.castShadow = shadows;
      m.receiveShadow = false;
    }
  });
  return obj;
}

export interface MeshPart { geometry: THREE.BufferGeometry; material: THREE.Material }
const partCache = new Map<string, MeshPart[]>();
/** All meshes of a model with their transforms baked into the geometry (for instancing/merging). */
export function meshParts(name: string): MeshPart[] {
  let parts = partCache.get(name);
  if (parts) return parts;
  parts = [];
  const src = nodes.get(name);
  if (src) {
    const rootInv = new THREE.Matrix4().copy(src.matrixWorld).invert();
    const m4 = new THREE.Matrix4();
    src.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m4.multiplyMatrices(rootInv, m.matrixWorld);
        const g = m.geometry.clone().applyMatrix4(m4);
        parts!.push({ geometry: g, material: m.material as THREE.Material });
      }
    });
  }
  partCache.set(name, parts);
  return parts;
}

/** Tinted instanced meshes (one per sub-mesh) for scenery. */
export function instancedModel(name: string, tint: string, count: number): THREE.InstancedMesh[] {
  return meshParts(name).map((p) => {
    const im = new THREE.InstancedMesh(p.geometry, tintMaterial(p.material, tint), count);
    im.castShadow = true;
    im.receiveShadow = false;
    return im;
  });
}

// ---------------------------------------------------------------- pets
const ROLE: Record<string, number> = { tint_body: 0, tint_secondary: 1, tint_ear: 2, tint_tail: 3, tint_accent: 4, tint_wing: 5, tint_visor: 4 };
const geoCache = new Map<string, THREE.BufferGeometry>();
const GOLD = new THREE.Color('#ffc928');
const tmpC = new THREE.Color();

export function petGeometry(speciesId: string, variant: string): THREE.BufferGeometry {
  const key = `${speciesId}|${variant}`;
  const cached = geoCache.get(key);
  if (cached) return cached;
  const sp = SPECIES_BY_ID[speciesId];
  const want = new Set(sp?.p ?? []);
  const parts = ['pet_body'];
  if (!want.has('visor')) parts.push('pet_eyes', 'pet_shine');
  if (!want.has('snout')) parts.push('pet_mouth');
  for (const x of sp?.p ?? []) parts.push(`pet_${x}`);
  const geoms: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    for (const mp of meshParts(part)) {
      let g = mp.geometry.clone();
      for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal') g.deleteAttribute(a);
      if (g.index) g = g.toNonIndexed();
      const role = ROLE[mp.material.name];
      const base = role !== undefined ? new THREE.Color(sp?.c[role] ?? '#ffffff') : (mp.material as THREE.MeshStandardMaterial).color.clone();
      const pos = g.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        tmpC.copy(base);
        if (role !== undefined && variant === 'golden') {
          const l = base.r * 0.3 + base.g * 0.55 + base.b * 0.15;
          tmpC.copy(GOLD).multiplyScalar(0.55 + Math.min(0.6, l * 0.7));
        } else if (role !== undefined && variant === 'rainbow') {
          const h = ((pos.getY(i) * 0.45 + pos.getX(i) * 0.25 + pos.getZ(i) * 0.15) % 1 + 1) % 1;
          tmpC.setHSL(h, 0.9, 0.55 + (role === 1 ? 0.12 : 0));
        }
        col[i * 3] = tmpC.r;
        col[i * 3 + 1] = tmpC.g;
        col[i * 3 + 2] = tmpC.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geoms.push(g);
    }
  }
  let merged = geoms.length ? mergeGeometries(geoms) : new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  if (!merged) merged = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const sc = sp?.sc ?? [1, 1, 1];
  merged.scale(sc[0], sc[1], sc[2]);
  merged.computeBoundingSphere();
  geoCache.set(key, merged);
  return merged;
}

export const petMaterials = {
  normal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.02 }),
  golden: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.8, emissive: new THREE.Color('#4a3200'), emissiveIntensity: 0.6 }),
  rainbow: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.15, emissive: new THREE.Color('#ff00ff'), emissiveIntensity: 0.18 }),
  shiny: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.1, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.15 }),
};

export function petMaterial(p: Pick<PetInstance, 'v' | 'sh'>): THREE.Material {
  if (p.v === 'golden') return petMaterials.golden;
  if (p.v === 'rainbow') return petMaterials.rainbow;
  if (p.sh) return petMaterials.shiny;
  return petMaterials.normal;
}

export function createPetMesh(p: Pick<PetInstance, 's' | 'v' | 'sh' | 'hg'>, hugeScale = 2.6): THREE.Mesh {
  const mesh = new THREE.Mesh(petGeometry(p.s, p.v), petMaterial(p));
  mesh.castShadow = true;
  if (p.hg) mesh.scale.setScalar(hugeScale);
  return mesh;
}

/** Animate shared variant materials (rainbow hue cycle, shiny pulse). */
export function animateMaterials(t: number) {
  petMaterials.rainbow.emissive.setHSL((t * 0.15) % 1, 1, 0.5);
  petMaterials.shiny.emissiveIntensity = 0.12 + Math.sin(t * 4) * 0.08;
  petMaterials.golden.emissiveIntensity = 0.5 + Math.sin(t * 2) * 0.15;
}

// ---------------------------------------------------------------- thumbnails (offscreen renderer)
let thumbR: THREE.WebGLRenderer | null = null;
let thumbScene: THREE.Scene;
let thumbCam: THREE.PerspectiveCamera;
const thumbCache = new Map<string, string>();
const thumbQueue: { key: string; build: () => THREE.Object3D }[] = [];
const queued = new Set<string>();
const thumbListeners = new Set<() => void>();
let pumping = false;
export let thumbVersion = 0;

function initThumbs(): boolean {
  if (thumbR) return true;
  try {
    const canvas = document.createElement('canvas');
    thumbR = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  } catch {
    return false;
  }
  thumbR.setSize(160, 160, false);
  thumbR.setPixelRatio(1);
  thumbR.outputColorSpace = THREE.SRGBColorSpace;
  thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.HemisphereLight('#ffffff', '#8a7aa8', 2.2));
  const d = new THREE.DirectionalLight('#ffffff', 2.2);
  d.position.set(2, 4, 5);
  thumbScene.add(d);
  thumbCam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  return true;
}

export function onThumbs(cb: () => void) {
  thumbListeners.add(cb);
  return () => thumbListeners.delete(cb);
}

function pump() {
  if (pumping) return;
  pumping = true;
  const run = () => {
    const t0 = performance.now();
    let n = 0;
    while (thumbQueue.length && performance.now() - t0 < 12) {
      const job = thumbQueue.shift()!;
      queued.delete(job.key);
      if (!initThumbs()) break;
      const obj = job.build();
      thumbScene.add(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const dist = (sphere.radius / Math.sin((thumbCam.fov * Math.PI) / 360)) * 0.8;
      thumbCam.position.set(sphere.center.x + dist * 0.35, sphere.center.y + dist * 0.25, sphere.center.z + dist * 0.9);
      thumbCam.lookAt(sphere.center);
      thumbR!.render(thumbScene, thumbCam);
      thumbCache.set(job.key, thumbR!.domElement.toDataURL('image/png'));
      thumbScene.remove(obj);
      n++;
    }
    if (n) {
      thumbVersion++;
      thumbListeners.forEach((l) => l());
    }
    if (thumbQueue.length) setTimeout(run, 16);
    else pumping = false;
  };
  setTimeout(run, 0);
}

function requestThumb(key: string, build: () => THREE.Object3D): string | null {
  const c = thumbCache.get(key);
  if (c) return c;
  if (!nodes.size) return null;
  if (!queued.has(key)) {
    queued.add(key);
    thumbQueue.push({ key, build });
    pump();
  }
  return null;
}

export function petThumb(p: Pick<PetInstance, 's' | 'v' | 'sh'>): string | null {
  const key = `pet|${p.s}|${p.v}|${p.sh ? 1 : 0}`;
  return requestThumb(key, () => {
    const m = new THREE.Mesh(petGeometry(p.s, p.v), petMaterial(p));
    m.rotation.y = -0.45;
    return m;
  });
}

export function eggThumb(zone: number): string | null {
  const z = ZONES[zone];
  const fam = z.egg.family;
  const key = `egg|${fam.id}|${z.egg.tier}`;
  return requestThumb(key, () => eggModel(zone));
}

export function eggModel(zone: number): THREE.Object3D {
  const z = ZONES[zone];
  const fam = z.egg.family;
  const obj = cloneModel('egg', { tint_egg: fam.shell, tint_spot: tierSpot(fam.spot, z.egg.tier) });
  return obj;
}

function tierSpot(spot: string, tier: number) {
  const tiers = [spot, spot, '#ffd23f', '#ff4f9a', '#7c5cff'];
  return tier <= 1 ? spot : tiers[tier];
}

export function familyEggThumb(familyId: string): string | null {
  const idx = EGG_FAMILIES.findIndex((f) => f.id === familyId);
  return eggThumb(Math.max(1, idx * 5 + 1));
}
