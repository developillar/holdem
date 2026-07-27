/**
 * ROYALE — fx/coinburst.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Currency in flight: chips off the pot into your stack, gems out of a price
 * tag into the wallet pill, pass rewards into the tier track.
 *
 * Each token follows its own cubic Bézier:
 *
 *      P0 = source
 *      P1 = source + a random outward kick      ← the scatter
 *      P2 = target + a fixed approach vector    ← every token converges
 *      P3 = target
 *
 * The scatter makes the group feel like a handful thrown, and the shared
 * approach vector makes them converge into a stream at the end instead of
 * arriving from twelve random directions. Progress along the curve is eased so
 * tokens leave slowly and *snap* into the counter — the acceleration is what
 * makes the arrival feel earned. Arrival pops the target, so the number and
 * the motion land on the same frame.
 */
import {
  engine,
  ease,
  clamp,
  token,
  reduceMotion,
  rand,
  rangeOf,
  pointOf,
  type FxPoint,
  type Particle,
} from './engine.ts';
import { bus } from '../core/bus.ts';

export type CoinKind = 'chip' | 'coin' | 'gem';

export interface CoinBurstOpts {
  from: FxPoint | Element | string;
  to: FxPoint | Element | string;
  count?: number;
  kind?: CoinKind;
  /** flight time per token, ms */
  travelMs?: number;
  /** delay added per token, ms */
  staggerMs?: number;
  /** outward kick radius at launch, px */
  scatter?: number;
  /** token size, px */
  size?: number;
  color?: string | string[];
  /** pulse the destination element on each arrival (default true) */
  pop?: boolean;
  /** fire `ui:haptic` ticks as tokens land (default true) */
  haptics?: boolean;
  onArrive?: (index: number, total: number) => void;
  onComplete?: () => void;
}

const KIND_COLOR: Record<CoinKind, [string, string]> = {
  chip: ['--c-gold-300', '#edc96b'],
  coin: ['--c-gold-200', '#f6e0a0'],
  gem: ['--c-rar-rare', '#47a9ff'],
};

/**
 * Springy scale/notch pulse on any element. Safe to call on elements this
 * module does not own — it adds one namespaced class and removes it again.
 */
export function pulse(target: Element | string | null | undefined, kind: 'pop' | 'gain' | 'loss' = 'pop'): void {
  const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : (target as HTMLElement | null);
  if (!el || !el.isConnected) return;
  const cls = `fx-${kind}`;
  el.classList.remove(cls);
  // Restart the keyframes without a forced reflow: cancelling our own running
  // animations is scoped to this element and reads no layout.
  for (const anim of el.getAnimations?.() ?? []) {
    const name = (anim as { animationName?: string }).animationName;
    if (typeof name === 'string' && name.startsWith('fx')) anim.cancel();
  }
  el.classList.add(cls);
  engine.after(560, () => el.classList.remove(cls));
}

/** Direction tokens approach the destination from — up and slightly leading. */
const APPROACH_X = 42;
const APPROACH_Y = -62;

function bezier(out: FxPoint, u: number, d: number[]): void {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const e = u * u * u;
  out.x = a * d[0] + b * d[2] + c * d[4] + e * d[6];
  out.y = a * d[1] + b * d[3] + c * d[5] + e * d[7];
}

const scratch: FxPoint = { x: 0, y: 0 };

export function coinBurst(opts: CoinBurstOpts): number {
  const src = pointOf(opts.from);
  const dstEl =
    typeof opts.to === 'string'
      ? document.querySelector<HTMLElement>(opts.to)
      : opts.to instanceof Element
        ? (opts.to as HTMLElement)
        : null;
  const dst = pointOf(opts.to);
  const kind = opts.kind ?? 'chip';
  const total = Math.max(1, opts.count ?? 12);
  const travel = (opts.travelMs ?? 620) / 1000;
  const stagger = (opts.staggerMs ?? 42) / 1000;
  const scatter = opts.scatter ?? 74;
  const size = opts.size ?? (kind === 'chip' ? 19 : 17);
  const [tokenName, fallback] = KIND_COLOR[kind];
  const color = opts.color ?? token(tokenName, fallback);
  const doPop = opts.pop !== false;
  const doHaptic = opts.haptics !== false;

  if (reduceMotion()) {
    // Still deliver the payoff, just without the flight.
    if (doPop && dstEl) pulse(dstEl, 'gain');
    opts.onArrive?.(total - 1, total);
    opts.onComplete?.();
    return 0;
  }

  let landed = 0;
  let hapticsFired = 0;
  let made = 0;

  // `made` is final by the time any token lands — the first arrival is at
  // least one travel-time after the spawn loop returns.
  const finish = (): void => {
    landed++;
    if (landed >= made) opts.onComplete?.();
  };

  const update = (p: Particle, _dt: number, _t: number): boolean => {
    const d = p.data;
    const delay = d[8];
    const dur = d[9];
    const a = p.age - delay;
    if (a < 0) {
      p.x = d[0];
      p.y = d[1];
      p.scale = 0;
      return true;
    }
    const u = clamp(a / dur, 0, 1);
    // Slow out of the pot, hard into the counter.
    const k = ease.inCubic(u) * 0.58 + u * 0.42;
    bezier(scratch, k, d);
    p.x = scratch.x;
    p.y = scratch.y;
    // Pop to full size on launch, shrink slightly as it is "absorbed".
    const grow = u < 0.14 ? ease.outBack(u / 0.14) : 1;
    p.scale = grow * (1 - 0.34 * ease.inCubic(u)) * d[10];
    p.ry += d[11] * _dt;
    return true;
  };

  for (let i = 0; i < total; i++) {
    const p = engine.spawn(kind, src.x, src.y, 'coins');
    if (!p) break;
    made++;

    const ang = rand() * Math.PI * 2;
    const kick = scatter * (0.35 + rand() * 0.9);
    const d = p.data;
    d[0] = src.x;
    d[1] = src.y;
    d[2] = src.x + Math.cos(ang) * kick;
    d[3] = src.y + Math.sin(ang) * kick * 0.8 - 40;
    d[4] = dst.x + APPROACH_X * (rand() * 2 - 1);
    d[5] = dst.y + APPROACH_Y - rand() * 26;
    d[6] = dst.x + rangeOf(-4, 4);
    d[7] = dst.y + rangeOf(-4, 4);
    d[8] = stagger * i;
    d[9] = travel * rangeOf(0.9, 1.12);
    d[10] = rangeOf(0.86, 1.14);
    d[11] = rangeOf(-1, 1) * 560;

    engine.sizeOf(p, size, size);
    p.tumble = true;
    p.ry = rand() * 360;
    p.rot = 0;
    p.life = d[8] + d[9];
    p.fadeIn = 0.06;
    p.fadeOut = 0.001;
    p.cull = false;
    p.weight = 6;
    p.update = update;
    p.el.style.setProperty('--fx-c', Array.isArray(color) ? color[i % color.length] : color);

    const index = i;
    p.done = (): void => {
      opts.onArrive?.(index, total);
      if (doPop && dstEl) pulse(dstEl, 'gain');
      if (doHaptic && hapticsFired < 4 && index % 3 === 0) {
        hapticsFired++;
        bus.emit('ui:haptic', { pattern: 'tick' });
      }
      // A tight sparkle exactly where it landed sells the absorption.
      engine.emit(
        {
          count: 4,
          origin: { x: d[6], y: d[7] },
          sprite: 'spark',
          speed: 130,
          speedVar: 0.7,
          drag: 8,
          life: 0.34,
          size: 5,
          sizeVar: 0.4,
          scaleTo: 0,
          color,
          blend: 'plus',
          weight: 0.4,
          cull: false,
        },
        'coins',
      );
      finish();
    };
  }

  if (made === 0) opts.onComplete?.();
  return made;
}

/**
 * Convenience wired to the top-bar wallet pills. The DOM contract is
 * `[data-fx-target="chips" | "gems"]`, with the current `.wal--chips` /
 * `.wal--gems` class names as a fallback and the top-right corner as a last
 * resort so the effect never fires into nowhere.
 */
export function coinsToWallet(
  from: FxPoint | Element | string,
  currency: 'chips' | 'gems',
  count = 14,
  onComplete?: () => void,
): number {
  const sel =
    currency === 'chips'
      ? '[data-fx-target="chips"], .wal--chips, .topbar__wallet .wal:first-child'
      : '[data-fx-target="gems"], .wal--gems, .topbar__wallet .wal:last-child';
  const el = document.querySelector<HTMLElement>(sel);
  const { w } = engine.viewport();
  const to: FxPoint | Element = el ?? { x: w - (currency === 'chips' ? 118 : 58), y: 42 };
  return coinBurst({
    from,
    to,
    count,
    kind: currency === 'chips' ? 'chip' : 'gem',
    travelMs: 660,
    staggerMs: 38,
    onComplete,
  });
}

/**
 * The reverse: currency leaving the wallet toward a purchase. Shorter, tighter
 * and with no arrival pop, because spending should feel light, not celebratory.
 */
export function coinsFromWallet(to: FxPoint | Element | string, currency: 'chips' | 'gems', count = 9): number {
  const sel = currency === 'chips' ? '[data-fx-target="chips"], .wal--chips' : '[data-fx-target="gems"], .wal--gems';
  const el = document.querySelector<HTMLElement>(sel);
  const { w } = engine.viewport();
  return coinBurst({
    from: el ?? { x: w - 88, y: 42 },
    to,
    count,
    kind: currency === 'chips' ? 'chip' : 'gem',
    travelMs: 460,
    staggerMs: 26,
    scatter: 40,
    size: 12,
    pop: false,
    haptics: false,
  });
}

/**
 * A chip shower that falls into a target — used when a pot is pushed to the
 * hero. Reads as volume rather than as a stream of individual tokens.
 */
export function chipShower(target: FxPoint | Element | string, count = 22): number {
  if (reduceMotion()) return 0;
  const dst = pointOf(target);
  const { w } = engine.viewport();
  return coinBurst({
    from: { x: clamp(dst.x, 40, w - 40), y: Math.max(24, dst.y - 210) },
    to: dst,
    count,
    kind: 'chip',
    travelMs: 540,
    staggerMs: 26,
    scatter: 120,
    haptics: false,
  });
}
