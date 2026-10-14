// Keyboard, mouse and touch input. Drag = rotate camera, click/tap = select target, wheel/pinch = zoom.
export class Input {
  readonly keys = new Set<string>();
  readonly joy = { x: 0, y: 0 };
  look = { yaw: 0, pitch: 0, zoom: 0 };
  jumpQueued = false;
  onTap: ((x: number, y: number) => void) | null = null;
  onKey: ((code: string) => void) | null = null;
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; drag: boolean; button: number }>();
  private pinch = 0;
  private cleanup: (() => void)[] = [];

  constructor(private el: HTMLElement, private sens: () => number) {
    const on = <K extends keyof WindowEventMap>(t: EventTarget, ev: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn, opts);
      this.cleanup.push(() => t.removeEventListener(ev, fn, opts));
    };
    const typing = () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    };
    on(window, 'keydown', (e: KeyboardEvent) => {
      if (typing()) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) {
        if (e.code === 'Space') this.jumpQueued = true;
        this.onKey?.(e.code);
      }
      this.keys.add(e.code);
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
    on(el, 'contextmenu', (e: Event) => e.preventDefault());
    on(el, 'pointerdown', (e: PointerEvent) => {
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, drag: false, button: e.button });
      if (this.pointers.size === 2) this.pinch = this.pinchDist();
    });
    on(el, 'pointermove', (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size >= 2) {
        const d = this.pinchDist();
        this.look.zoom -= (d - this.pinch) * 0.05;
        this.pinch = d;
        for (const q of this.pointers.values()) q.drag = true;
        return;
      }
      if (!p.drag && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 7) p.drag = true;
      if (p.drag) {
        const s = this.sens() * (e.pointerType === 'touch' ? 1.4 : 1);
        this.look.yaw -= dx * 0.0055 * s;
        this.look.pitch += dy * 0.004 * s;
      }
    });
    const up = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (p && !p.drag && p.button === 0 && this.pointers.size === 0) this.onTap?.(e.clientX, e.clientY);
    };
    on(el, 'pointerup', up);
    on(el, 'pointercancel', (e: PointerEvent) => this.pointers.delete(e.pointerId));
    on(el, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.look.zoom += Math.sign(e.deltaY) * 1.6;
    }, { passive: false });
  }

  private pinchDist() {
    const ps = [...this.pointers.values()];
    return ps.length < 2 ? 0 : Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }

  /** Movement intent in [-1,1]: x = right, y = forward. */
  move(): { x: number; y: number } {
    let x = this.joy.x;
    let y = this.joy.y;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  consumeLook() {
    const l = this.look;
    this.look = { yaw: 0, pitch: 0, zoom: 0 };
    return l;
  }

  dispose() {
    for (const c of this.cleanup) c();
  }
}
