/**
 * Table-screen primitives.
 *
 * `src/ui/dom.ts` and `src/ui/components/*` are owned by another module and
 * were not present when this screen was built, so the table ships with its
 * own hardened micro-layer: element construction, a single shared rAF loop,
 * critically-damped springs, count-up numerics and a pointer-press helper
 * that fires haptics + SFX on every touch. Everything here is deliberately
 * allocation-free on the hot path — the frame loop runs while nine
 * nameplates track the 3D camera.
 */

import { bus } from '../../core/bus.ts';
import type { HapticPattern } from '../../core/bus.ts';

// ─────────────────────────── element building ───────────────────────────

export type Child = string | number | Node | null | undefined | false | Child[];
export type Attrs = Record<string, unknown>;

function appendChild(el: Element, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) {
    for (let i = 0; i < c.length; i++) appendChild(el, c[i]);
    return;
  }
  if (typeof c === 'string' || typeof c === 'number') {
    el.appendChild(document.createTextNode(String(c)));
    return;
  }
  el.appendChild(c);
}

function applyProps(el: HTMLElement, props: Attrs): void {
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (v === null || v === undefined || v === false) continue;
    if (key === 'class' || key === 'className') {
      el.className = String(v);
    } else if (key === 'text') {
      el.textContent = String(v);
    } else if (key === 'html') {
      el.innerHTML = String(v);
    } else if (key === 'style' && typeof v === 'object') {
      Object.assign(el.style, v as Partial<CSSStyleDeclaration>);
    } else if (key === 'dataset' && typeof v === 'object') {
      Object.assign(el.dataset, v as Record<string, string>);
    } else if (key.startsWith('on') && typeof v === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), v as EventListener);
    } else if (v === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(v));
    }
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Attrs | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  for (let i = 0; i < children.length; i++) appendChild(el, children[i]);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG element factory — every icon in this screen is drawn, never an emoji. */
export function s(tag: string, attrs?: Record<string, string | number> | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  for (let i = 0; i < children.length; i++) appendChild(el, children[i]);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Toggle a class and return the element, for terse chaining. */
export function cls(el: HTMLElement, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/** Writes only when the value actually changed — avoids layout churn. */
export function setText(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

// ─────────────────────────── math ───────────────────────────

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Deterministic 32-bit string hash — drives procedural avatar colours. */
export function hash32(str: string): number {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h1 ^= str.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return h1 >>> 0;
}

// ─────────────────────────── frame loop ───────────────────────────

type FrameFn = (dtMs: number, nowMs: number) => void;
const frameSubs = new Set<FrameFn>();
let rafId = 0;
let lastFrame = 0;

function tick(now: number): void {
  const dt = lastFrame === 0 ? 16.7 : Math.min(64, now - lastFrame);
  lastFrame = now;
  for (const fn of frameSubs) {
    try {
      fn(dt, now);
    } catch (err) {
      console.error('[table] frame handler failed', err);
    }
  }
  rafId = frameSubs.size ? requestAnimationFrame(tick) : 0;
  if (!rafId) lastFrame = 0;
}

/** One rAF for the entire table HUD. Returns an unsubscribe. */
export function onFrame(fn: FrameFn): () => void {
  frameSubs.add(fn);
  if (!rafId) {
    lastFrame = 0;
    rafId = requestAnimationFrame(tick);
  }
  return () => {
    frameSubs.delete(fn);
  };
}

// ─────────────────────────── springs ───────────────────────────

/**
 * Critically-ish damped spring. Physical motion is the difference between
 * "animated" and "alive" — every transform in this screen that is not a
 * one-shot CSS transition runs through one of these.
 */
export class Spring {
  value: number;
  target: number;
  velocity = 0;
  stiffness: number;
  damping: number;

  constructor(value = 0, stiffness = 190, damping = 24) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  set(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }

  step(dtMs: number): number {
    const dt = Math.min(0.032, dtMs / 1000);
    const a = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
    this.velocity += a * dt;
    this.value += this.velocity * dt;
    if (Math.abs(this.target - this.value) < 0.0004 && Math.abs(this.velocity) < 0.004) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }

  get settled(): boolean {
    return this.value === this.target && this.velocity === 0;
  }
}

// ─────────────────────────── count-up numerics ───────────────────────────

export interface CountUp {
  readonly el: HTMLElement;
  /** Animate to a new value. */
  to(value: number, ms?: number): void;
  /** Jump with no animation. */
  set(value: number): void;
  value(): number;
  dispose(): void;
}

/**
 * Ticks a number toward a target with an ease-out curve. Money that lands
 * instantly reads as a spreadsheet; money that counts up reads as a win.
 */
export function countUp(el: HTMLElement, format: (v: number) => string, initial = 0): CountUp {
  let current = initial;
  let from = initial;
  let target = initial;
  let t = 1;
  let dur = 1;
  let off: (() => void) | null = null;
  el.textContent = format(initial);

  const stop = (): void => {
    if (off) {
      off();
      off = null;
    }
  };

  const run = (dt: number): void => {
    t = Math.min(1, t + dt / dur);
    current = lerp(from, target, easeOut(t));
    el.textContent = format(current);
    if (t >= 1) {
      current = target;
      el.textContent = format(target);
      stop();
    }
  };

  return {
    el,
    to(value: number, ms = 620): void {
      if (Math.abs(value - target) < 1e-9 && t >= 1) return;
      from = current;
      target = value;
      dur = Math.max(1, ms);
      t = 0;
      if (!off) off = onFrame(run);
    },
    set(value: number): void {
      stop();
      current = value;
      from = value;
      target = value;
      t = 1;
      el.textContent = format(value);
    },
    value(): number {
      return target;
    },
    dispose: stop,
  };
}

// ─────────────────────────── audio + haptics ───────────────────────────

type SfxLib = Record<string, (...args: number[]) => void>;
let sfxLib: SfxLib | null = null;

// The audio subsystem is loaded lazily and defensively: the HUD must remain
// fully usable on a device where the Web Audio graph failed to build.
void import('../../audio/sfx.ts')
  .then((m) => {
    sfxLib = m.sfx as unknown as SfxLib;
  })
  .catch(() => {
    sfxLib = null;
  });

export function cue(name: string, ...args: number[]): void {
  const fn = sfxLib?.[name];
  if (!fn) return;
  try {
    fn(...args);
  } catch {
    /* a dead audio context must never break an action */
  }
}

export function haptic(pattern: HapticPattern): void {
  bus.emit('ui:haptic', { pattern });
}

/** The standard tactile response for a UI press: one haptic, one cue. */
export function feedback(pattern: HapticPattern, sfxName: string, ...args: number[]): void {
  haptic(pattern);
  cue(sfxName, ...args);
}

// ─────────────────────────── pointer press ───────────────────────────

export interface PressOpts {
  onPress?: (e: PointerEvent) => void;
  onDown?: (e: PointerEvent) => void;
  onUp?: (e: PointerEvent, completed: boolean) => void;
  onLongPress?: (e: PointerEvent) => void;
  onMove?: (e: PointerEvent) => void;
  longMs?: number;
  /** cancel the press once the finger travels this far, in px */
  slop?: number;
  haptic?: HapticPattern | null;
  sfx?: string | null;
  /** when true the press does not fire onPress after a long press */
  exclusiveLong?: boolean;
}

/**
 * A press that behaves like a native control: instant visual feedback on
 * pointerdown, cancels when the finger slides off, supports long-press, and
 * never fires a ghost click.
 */
export function press(el: HTMLElement, opts: PressOpts): () => void {
  let id = -1;
  let sx = 0;
  let sy = 0;
  let longTimer = 0;
  let didLong = false;
  const slop = opts.slop ?? 14;

  const clearLong = (): void => {
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = 0;
    }
  };

  const end = (e: PointerEvent, completed: boolean): void => {
    if (id === -1) return;
    id = -1;
    clearLong();
    el.classList.remove('is-pressed');
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released by the platform */
    }
    opts.onUp?.(e, completed);
    if (completed && !(didLong && opts.exclusiveLong)) opts.onPress?.(e);
  };

  const onDown = (e: PointerEvent): void => {
    if (id !== -1 || el.hasAttribute('disabled') || el.classList.contains('is-disabled')) return;
    id = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    didLong = false;
    el.classList.add('is-pressed');
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    if (opts.haptic) haptic(opts.haptic);
    if (opts.sfx) cue(opts.sfx);
    opts.onDown?.(e);
    if (opts.onLongPress) {
      longTimer = window.setTimeout(() => {
        longTimer = 0;
        didLong = true;
        opts.onLongPress?.(e);
      }, opts.longMs ?? 340);
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    opts.onMove?.(e);
    if (didLong) return;
    if (Math.abs(e.clientX - sx) > slop || Math.abs(e.clientY - sy) > slop) {
      clearLong();
      el.classList.remove('is-pressed');
      id = -1;
      opts.onUp?.(e, false);
    }
  };

  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    end(e, true);
  };

  const onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    end(e, false);
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('contextmenu', preventDefault);

  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('contextmenu', preventDefault);
    clearLong();
  };
}

function preventDefault(e: Event): void {
  e.preventDefault();
}

// ─────────────────────────── persisted settings ───────────────────────────

const STORE_PREFIX = 'royale.table.';

export function readSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* private mode — settings simply do not persist */
  }
}

// ─────────────────────────── misc ───────────────────────────

/** Runs a one-shot CSS animation by re-adding a class on the next frame. */
export function replay(el: HTMLElement, className: string): void {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

export function delay(ms: number, fn: () => void): () => void {
  const id = window.setTimeout(fn, ms);
  return () => clearTimeout(id);
}
