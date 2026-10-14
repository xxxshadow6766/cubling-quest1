import * as THREE from 'three';

export interface LabelLine { text: string; color?: string; size?: number; bold?: boolean }

/** Canvas-text billboard sprite. `height` = world height of one 32px line. */
export function makeLabel(lines: LabelLine[] | string, opts: { bg?: string; height?: number; border?: string; pad?: number; depthTest?: boolean } = {}): THREE.Sprite {
  const ls: LabelLine[] = typeof lines === 'string' ? [{ text: lines }] : lines;
  const font = (l: LabelLine) => `${l.bold === false ? 600 : 800} ${l.size ?? 32}px ui-rounded, "Nunito", "Segoe UI", system-ui, sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const pad = opts.pad ?? 14;
  let w = 0;
  let h = 0;
  for (const l of ls) {
    ctx.font = font(l);
    w = Math.max(w, ctx.measureText(l.text).width);
    h += (l.size ?? 32) * 1.2;
  }
  c.width = Math.ceil(w + pad * 2 + 8);
  c.height = Math.ceil(h + pad * 1.4);
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    const r = 18;
    ctx.beginPath();
    ctx.roundRect(2, 2, c.width - 4, c.height - 4, r);
    ctx.fill();
    if (opts.border) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = opts.border;
      ctx.stroke();
    }
  }
  let y = pad * 0.7;
  for (const l of ls) {
    const size = l.size ?? 32;
    ctx.font = font(l);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(4, size / 5);
    ctx.strokeStyle = 'rgba(30,20,50,0.85)';
    ctx.strokeText(l.text, c.width / 2, y);
    ctx.fillStyle = l.color ?? '#ffffff';
    ctx.fillText(l.text, c.width / 2, y);
    y += size * 1.2;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: opts.depthTest ?? true });
  const s = new THREE.Sprite(mat);
  const unit = (opts.height ?? 0.6) / 32;
  s.scale.set(c.width * unit, c.height * unit, 1);
  s.userData.disposeLabel = () => {
    tex.dispose();
    mat.dispose();
  };
  s.renderOrder = 10;
  return s;
}

export function disposeLabel(s: THREE.Object3D | null | undefined) {
  (s?.userData?.disposeLabel as (() => void) | undefined)?.();
}
