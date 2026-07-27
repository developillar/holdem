/**
 * ROYALE — components/util.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Shared plumbing for the component library. Importing any component pulls
 * this in, and this pulls in `styles/components.css`, so a screen never has
 * to remember to link a stylesheet.
 *
 * EXPORTS
 *   uid(prefix)                     unique DOM id
 *   clamp / lerp / invLerp / round  numeric helpers
 *   reduceMotion()                  live prefers-reduced-motion check
 *   haptic(pattern)                 fire-and-forget `ui:haptic`
 *   spring(from, onUpdate, opts)    rAF spring; retarget with `.set()`
 *   pressFeedback(el)               adds/removes `.is-press` on touch
 *   swipeToDismiss(el, opts)        horizontal swipe gesture
 *   trapFocus(el)                   focus trap + restore, returns release
 *   fmtInt / fmtSigned              tabular-safe number formatting
 */
import '../styles/components.css';
import { bus } from '../../core/bus.ts';
import type { HapticPattern } from '../../core/bus.ts';

let idSeq = 0;
export function uid(prefix = 'r'): string {
  idSeq += 1;
  return `${prefix}-${idSeq.toString(36)}`;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number =>
  b === a ? 0 : (v - a) / (b - a);
export const roundTo = (v: number, step: number): number =>
  step > 0 ? Math.round(v / step) * step : v;

const mqReduce =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** True when the user asked the OS to cut animation. Re-read every call. */
export function reduceMotion(): boolean {
  return mqReduce ? mqReduce.matches : false;
}

export function haptic(pattern: HapticPattern): void {
  bus.emit('ui:haptic', { pattern });
}

// ─────────────────────────────── spring ───────────────────────────────

export interface SpringOpts {
  /** Higher = snappier. Default 210. */
  stiffness?: number;
  /** Higher = less overshoot. Default 24. */
  damping?: number;
  mass?: number;
  /** Settle threshold in value units. Default 0.01. */
  precision?: number;
  /** Called once when the spring comes to rest. */
  onRest?: () => void;
}

export interface Spring {
  /** Animate toward a new target. */
  set(target: number): void;
  /** Teleport (no animation) — use for first paint. */
  jump(value: number): void;
  value(): number;
  target(): number;
  stop(): void;
}

/**
 * Semi-implicit Euler spring on rAF. Fixed 1/120s substeps so behaviour is
 * identical on 60Hz and 120Hz panels, and interruptible mid-flight: calling
 * `set()` again retargets while keeping the current velocity, which is what
 * makes retapping a tab feel alive instead of stuttery.
 */
export function spring(initial: number, onUpdate: (v: number) => void, opts: SpringOpts = {}): Spring {
  const k = opts.stiffness ?? 210;
  const c = opts.damping ?? 24;
  const m = opts.mass ?? 1;
  const eps = opts.precision ?? 0.01;
  let value = initial;
  let target = initial;
  let vel = 0;
  let raf = 0;
  let last = 0;

  const step = (now: number) => {
    raf = 0;
    const dt = Math.min(0.064, (now - last) / 1000) || 1 / 60;
    last = now;
    let remaining = dt;
    while (remaining > 0) {
      const sub = Math.min(remaining, 1 / 120);
      remaining -= sub;
      const accel = (-k * (value - target) - c * vel) / m;
      vel += accel * sub;
      value += vel * sub;
    }
    if (Math.abs(value - target) < eps && Math.abs(vel) < eps * 8) {
      value = target;
      vel = 0;
      onUpdate(value);
      opts.onRest?.();
      return;
    }
    onUpdate(value);
    raf = requestAnimationFrame(step);
  };

  const start = () => {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(step);
  };

  return {
    set(next) {
      if (target === next) return;
      target = next;
      if (reduceMotion()) {
        value = next;
        vel = 0;
        onUpdate(value);
        opts.onRest?.();
        return;
      }
      start();
    },
    jump(next) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      value = target = next;
      vel = 0;
      onUpdate(value);
    },
    value: () => value,
    target: () => target,
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      vel = 0;
    },
  };
}

// ─────────────────────────────── gestures ───────────────────────────────

/**
 * Toggles `.is-press` while a finger/mouse is held on `el`, cancelling if the
 * pointer wanders more than 12px (so it never fights a scroll). Activation
 * itself stays on `click`, which keeps keyboard and assistive tech working.
 */
export function pressFeedback(el: HTMLElement): () => void {
  let id = -1;
  let sx = 0;
  let sy = 0;
  const end = () => {
    id = -1;
    el.classList.remove('is-press');
  };
  const down = (ev: PointerEvent) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
    id = ev.pointerId;
    sx = ev.clientX;
    sy = ev.clientY;
    el.classList.add('is-press');
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (Math.abs(ev.clientX - sx) > 12 || Math.abs(ev.clientY - sy) > 12) end();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    el.removeEventListener('pointerleave', end);
  };
}

export interface SwipeOpts {
  /** px of travel that commits the dismiss. Default 96. */
  threshold?: number;
  /** px/ms that commits regardless of travel. Default 0.45. */
  velocity?: number;
  onMove?(dx: number): void;
  onDismiss(dir: 1 | -1): void;
  onCancel?(): void;
}

/** Horizontal swipe-to-dismiss that follows the finger 1:1. */
export function swipeToDismiss(el: HTMLElement, opts: SwipeOpts): () => void {
  const threshold = opts.threshold ?? 96;
  const vLimit = opts.velocity ?? 0.45;
  let id = -1;
  let x0 = 0;
  let y0 = 0;
  let t0 = 0;
  let dx = 0;
  let axis: 'x' | 'y' | null = null;

  const down = (ev: PointerEvent) => {
    if (id !== -1 || ev.pointerType === 'mouse' && ev.button !== 0) return;
    id = ev.pointerId;
    x0 = ev.clientX;
    y0 = ev.clientY;
    t0 = performance.now();
    dx = 0;
    axis = null;
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    const ddx = ev.clientX - x0;
    const ddy = ev.clientY - y0;
    if (!axis) {
      if (Math.abs(ddx) < 6 && Math.abs(ddy) < 6) return;
      axis = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
      if (axis === 'x') el.setPointerCapture(ev.pointerId);
    }
    if (axis !== 'x') return;
    dx = ddx;
    opts.onMove?.(dx);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    id = -1;
    if (axis !== 'x') return;
    const v = dx / Math.max(1, performance.now() - t0);
    if (Math.abs(dx) > threshold || Math.abs(v) > vLimit) opts.onDismiss(dx < 0 ? -1 : 1);
    else opts.onCancel?.();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
}

// ─────────────────────────────── focus ───────────────────────────────

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[role="slider"]';

/** Confines Tab to `el` and restores focus to the previous element on release. */
export function trapFocus(el: HTMLElement): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Tab') return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => n.offsetParent !== null || n === document.activeElement,
    );
    if (!items.length) {
      ev.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (ev.shiftKey && (active === first || !el.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => {
    const target = el.querySelector<HTMLElement>('[autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    if (!el.contains(document.activeElement)) target.focus({ preventScroll: true });
  });
  return () => {
    document.removeEventListener('keydown', onKey, true);
    if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
  };
}

// ─────────────────────────────── numbers ───────────────────────────────

const groupFmt = new Intl.NumberFormat('en-US');

/** 1234567 → "1,234,567". Always pair with the `.tnum` class. */
export function fmtInt(n: number): string {
  return groupFmt.format(Math.round(n));
}

/** +12 / −4, using a real minus sign so digits stay optically centred. */
export function fmtSigned(n: number): string {
  const r = Math.round(n);
  return r < 0 ? `−${groupFmt.format(-r)}` : `+${groupFmt.format(r)}`;
}
