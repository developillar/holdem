/**
 * ROYALE — fx/screen.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Full-screen presentation effects: flash, vignette pulse, shake, shockwave
 * and the "dramatic dim" that isolates one element for an all-in.
 *
 * Two rules shape everything here:
 *  • Only `opacity` and `transform` animate. The vignette's radial gradient and
 *    the dim's enormous spread shadow are painted once and then only faded —
 *    both stay on a single composited layer.
 *  • The shake never writes `transform` on `#ui-root` directly, because that
 *    element belongs to the shell and may already carry one. It writes three
 *    custom properties and toggles `[data-fx-shake]`; `fx.css` owns the actual
 *    transform. Nothing of the shell's is clobbered, and when the attribute
 *    comes off the element is byte-for-byte as it was.
 */
import { engine, ease, clamp, token, reduceMotion, rand, pointOf, type FxPoint } from './engine.ts';

// ─────────────────────────── persistent screen elements ───────────────────────────

const singles = new Map<string, HTMLElement>();

function single(key: string, className: string, layer: 'dim' | 'screen' = 'screen'): HTMLElement {
  let el = singles.get(key);
  if (el && el.isConnected) return el;
  el = document.createElement('div');
  el.className = className;
  el.setAttribute('aria-hidden', 'true');
  engine.layer(layer).appendChild(el);
  singles.set(key, el);
  return el;
}

function play(el: HTMLElement, frames: Keyframe[], ms: number, easing: string, onDone?: () => void): void {
  const anim = el.animate(frames, { duration: ms, easing, fill: 'none' });
  anim.onfinish = (): void => {
    el.style.opacity = '0';
    onDone?.();
  };
  anim.oncancel = (): void => {
    el.style.opacity = '0';
  };
}

// ─────────────────────────── flash ───────────────────────────

export interface FlashOpts {
  color?: string;
  ms?: number;
  /** peak opacity, 0..1 */
  peak?: number;
  /** 'plus' burns in brighter — right for gold and white, wrong for red */
  blend?: 'normal' | 'plus';
}

/**
 * A colour wash with a hard attack and an exponential falloff — 8% of the
 * duration up, the rest down. That asymmetry is what makes it read as an
 * impact rather than a fade.
 */
export function flash(opts: FlashOpts | string = {}, msArg?: number): void {
  const o: FlashOpts = typeof opts === 'string' ? { color: opts, ms: msArg } : opts;
  const ms = Math.max(60, o.ms ?? 260);
  const peak = o.peak ?? (reduceMotion() ? 0.16 : 0.52);
  const el = single('flash', 'fx-flash');
  el.style.background = o.color ?? token('--c-gold-200', '#f6e0a0');
  el.style.mixBlendMode = o.blend === 'plus' ? 'plus-lighter' : 'normal';
  play(
    el,
    [
      { opacity: 0, offset: 0 },
      { opacity: peak, offset: 0.08 },
      { opacity: peak * 0.42, offset: 0.3 },
      { opacity: 0, offset: 1 },
    ],
    ms,
    'cubic-bezier(0.16, 1, 0.3, 1)',
  );
}

// ─────────────────────────── vignette ───────────────────────────

export interface VignetteOpts {
  color?: string;
  ms?: number;
  /** 0..1 */
  strength?: number;
}

/**
 * An impact vignette: the edges of the screen bruise inward and release.
 * Used for damage-shaped events — losing a big pot, a bad-beat, a mistake in
 * the trainer — where a flash would be too celebratory.
 */
export function vignettePulse(opts: VignetteOpts = {}): void {
  const ms = Math.max(120, opts.ms ?? 620);
  const strength = clamp(opts.strength ?? 0.8, 0, 1) * (reduceMotion() ? 0.4 : 1);
  const el = single('vignette', 'fx-vignette');
  el.style.setProperty('--fx-vig-c', opts.color ?? token('--c-bad', '#f6534f'));
  play(
    el,
    [
      { opacity: 0, transform: 'scale(1.06)', offset: 0 },
      { opacity: strength, transform: 'scale(1)', offset: 0.18 },
      { opacity: 0, transform: 'scale(1.02)', offset: 1 },
    ],
    ms,
    'cubic-bezier(0.16, 1, 0.3, 1)',
  );
}

/** A held vignette — for sustained states like "you are all-in and waiting". */
export function vignetteHold(on: boolean, opts: VignetteOpts = {}): void {
  const el = single('vignette-hold', 'fx-vignette fx-vignette--hold');
  el.style.setProperty('--fx-vig-c', opts.color ?? token('--c-gold-400', '#d9a93a'));
  el.style.opacity = on ? String(clamp(opts.strength ?? 0.55, 0, 1) * (reduceMotion() ? 0.4 : 1)) : '0';
}

// ─────────────────────────── shake ───────────────────────────

let shakeStop: (() => void) | null = null;
let shakeAmp = 0;

/**
 * Damped multi-frequency shake on `#ui-root`. Two detuned oscillators per axis
 * stop it sounding like a sine wave, and the decay is quadratic so the tail is
 * short — long shakes read as broken, not dramatic.
 *
 * Fully suppressed under `prefers-reduced-motion`.
 */
export function shake(amount = 9, ms = 340): void {
  if (reduceMotion()) return;
  const ui = document.getElementById('ui-root');
  if (!ui) return;

  // Re-triggering mid-shake takes the louder of the two rather than stacking.
  shakeAmp = Math.max(shakeAmp, amount);
  if (shakeStop) return;

  const dur = Math.max(0.08, ms / 1000);
  const p1 = rand() * 6.28;
  const p2 = rand() * 6.28;
  const p3 = rand() * 6.28;
  let t = 0;

  ui.setAttribute('data-fx-shake', '');
  const clean = (): void => {
    ui.removeAttribute('data-fx-shake');
    ui.style.removeProperty('--fx-shake-x');
    ui.style.removeProperty('--fx-shake-y');
    ui.style.removeProperty('--fx-shake-r');
    shakeStop = null;
    shakeAmp = 0;
  };

  shakeStop = engine.track((dt) => {
    t += dt;
    const k = 1 - t / dur;
    if (k <= 0) {
      clean();
      return false;
    }
    const damp = k * k;
    const a = shakeAmp * damp;
    const x = (Math.sin(t * 47 + p1) * 0.66 + Math.sin(t * 113 + p2) * 0.34) * a;
    const y = (Math.sin(t * 61 + p2) * 0.6 + Math.sin(t * 89 + p3) * 0.4) * a * 0.8;
    const r = Math.sin(t * 39 + p3) * a * 0.055;
    ui.style.setProperty('--fx-shake-x', `${x.toFixed(2)}px`);
    ui.style.setProperty('--fx-shake-y', `${y.toFixed(2)}px`);
    ui.style.setProperty('--fx-shake-r', `${r.toFixed(3)}deg`);
    return true;
  });
}

/** Stop any running shake immediately and restore `#ui-root`. */
export function stopShake(): void {
  shakeStop?.();
  const ui = document.getElementById('ui-root');
  if (ui) {
    ui.removeAttribute('data-fx-shake');
    ui.style.removeProperty('--fx-shake-x');
    ui.style.removeProperty('--fx-shake-y');
    ui.style.removeProperty('--fx-shake-r');
  }
  shakeStop = null;
  shakeAmp = 0;
}

// ─────────────────────────── shockwave ───────────────────────────

export interface ShockwaveOpts {
  color?: string;
  /** final diameter, px */
  size?: number;
  ms?: number;
  /** ring thickness, px */
  thickness?: number;
  rings?: number;
}

/**
 * An expanding hairline ring. Reads as force without the fill cost of a flash,
 * so it can fire on every all-in without ever washing the table out.
 */
export function shockwave(at: FxPoint | Element | string, opts: ShockwaveOpts = {}): void {
  if (reduceMotion()) return;
  const o = pointOf(at);
  const size = opts.size ?? 520;
  const ms = opts.ms ?? 720;
  const color = opts.color ?? token('--c-gold-300', '#edc96b');
  const rings = Math.max(1, Math.min(3, opts.rings ?? 2));
  for (let i = 0; i < rings; i++) {
    const el = document.createElement('i');
    el.className = 'fx-wave';
    el.setAttribute('aria-hidden', 'true');
    el.style.setProperty('--fx-c', color);
    el.style.setProperty('--fx-wave-th', `${opts.thickness ?? 2}px`);
    el.style.left = `${o.x}px`;
    el.style.top = `${o.y}px`;
    el.style.width = el.style.height = `${size}px`;
    engine.layer('particles').appendChild(el);
    const anim = el.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0.04)', opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(0.22)', opacity: 0.95, offset: 0.14 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 },
      ],
      { duration: ms + i * 130, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', delay: i * 90, fill: 'none' },
    );
    const drop = (): void => el.remove();
    anim.onfinish = drop;
    anim.oncancel = drop;
  }
}

// ─────────────────────────── dramatic dim ───────────────────────────

export interface DimOpts {
  /** auto-release after this long; omit to hold until released */
  ms?: number;
  /** darkness, 0..1 */
  opacity?: number;
  /** extra padding around the focused element, px */
  pad?: number;
  /** corner radius of the cutout, px — defaults to the target's own radius */
  radius?: number;
  /** ring colour around the cutout */
  ring?: string;
  /** dim in/out duration, ms */
  fadeMs?: number;
}

let dimRelease: (() => void) | null = null;

/**
 * Darkens everything except `focus`. Implemented as a single element sized to
 * the focus rect with a `100vmax` spread shadow — one layer, one opacity
 * animation, a genuinely soft cutout, and no clip-path recalculation.
 * Pass `null` to dim the whole screen with no hole.
 *
 * Returns a release function; calling `dramaticDim` again replaces the
 * previous dim rather than stacking.
 */
export function dramaticDim(focus?: Element | string | null, opts: DimOpts = {}): () => void {
  dimRelease?.();

  const layer = engine.layer('dim');
  const hole = document.createElement('div');
  hole.className = 'fx-dim';
  hole.setAttribute('aria-hidden', 'true');
  hole.style.setProperty('--fx-dim-o', String(clamp(opts.opacity ?? 0.74, 0, 1)));
  hole.style.setProperty('--fx-dim-ring', opts.ring ?? token('--line-gold', 'rgba(237,201,107,0.34)'));

  const el = typeof focus === 'string' ? document.querySelector(focus) : focus;
  if (el) {
    const r = el.getBoundingClientRect();
    const pad = opts.pad ?? 10;
    const radius =
      opts.radius ?? (Math.min(48, parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) + Math.min(pad, 12));
    hole.style.left = `${r.left - pad}px`;
    hole.style.top = `${r.top - pad}px`;
    hole.style.width = `${r.width + pad * 2}px`;
    hole.style.height = `${r.height + pad * 2}px`;
    hole.style.borderRadius = `${radius}px`;
  } else {
    // No focus: collapse the hole to a point off-screen so only the wash shows.
    hole.style.left = '50%';
    hole.style.top = '-40px';
    hole.style.width = hole.style.height = '0px';
    hole.classList.add('is-full');
  }

  layer.appendChild(hole);
  const fade = opts.fadeMs ?? 260;
  const inAnim = hole.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: reduceMotion() ? 1 : fade,
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    fill: 'forwards',
  });

  let released = false;
  let cancelAuto: (() => void) | null = null;
  const release = (): void => {
    if (released) return;
    released = true;
    cancelAuto?.();
    if (dimRelease === release) dimRelease = null;
    inAnim.cancel();
    const out = hole.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: reduceMotion() ? 1 : fade,
      easing: 'linear',
      fill: 'forwards',
    });
    const drop = (): void => hole.remove();
    out.onfinish = drop;
    out.oncancel = drop;
  };

  dimRelease = release;
  if (opts.ms) cancelAuto = engine.after(opts.ms, release);
  return release;
}

/** Release whatever dim is currently up. Safe to call when there is none. */
export function releaseDim(): void {
  dimRelease?.();
}

// ─────────────────────────── composites ───────────────────────────

export interface ImpactOpts {
  color?: string;
  /** 0..1 — scales flash, shake and wave together */
  power?: number;
  at?: FxPoint | Element | string;
}

/** Flash + shake + shockwave on one beat. The all-in / bomb-pot signature. */
export function impact(opts: ImpactOpts = {}): void {
  const power = clamp(opts.power ?? 0.7, 0, 1);
  const color = opts.color ?? token('--c-gold-300', '#edc96b');
  flash({ color, ms: 200 + power * 180, peak: 0.16 + power * 0.4, blend: 'plus' });
  shake(4 + power * 11, 240 + power * 220);
  shockwave(opts.at ?? { x: engine.viewport().w / 2, y: engine.viewport().h * 0.44 }, {
    color,
    size: 380 + power * 420,
    rings: power > 0.6 ? 3 : 2,
  });
}

/**
 * Slow, wide bloom used when a hand is won without a showdown — a soft light
 * swell rather than a hit. Deliberately has no shake.
 */
export function glowSwell(at: FxPoint | Element | string, color?: string, ms = 900): void {
  if (reduceMotion()) return;
  const o = pointOf(at);
  const el = document.createElement('i');
  el.className = 'fx-swell';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--fx-c', color ?? token('--c-gold-300', '#edc96b'));
  el.style.left = `${o.x}px`;
  el.style.top = `${o.y}px`;
  engine.layer('particles').appendChild(el);
  const anim = el.animate(
    [
      { transform: 'translate(-50%,-50%) scale(0.3)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.85, offset: 0.32 },
      { transform: 'translate(-50%,-50%) scale(1.5)', opacity: 0 },
    ],
    { duration: ms, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'none' },
  );
  const drop = (): void => el.remove();
  anim.onfinish = drop;
  anim.oncancel = drop;
}

/** Exposed for the loading/route layer: a quick wipe of light across the screen. */
export function sweepLight(ms = 520, color?: string): void {
  if (reduceMotion()) return;
  const el = single('sweep', 'fx-sweep');
  el.style.setProperty('--fx-c', color ?? token('--c-gold-200', '#f6e0a0'));
  const anim = el.animate(
    [
      { transform: 'translate3d(-120%,0,0)', opacity: 0 },
      { transform: 'translate3d(-20%,0,0)', opacity: 0.7, offset: 0.35 },
      { transform: 'translate3d(120%,0,0)', opacity: 0 },
    ],
    { duration: ms, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'none' },
  );
  anim.onfinish = (): void => {
    el.style.opacity = '0';
  };
}

export { ease as screenEase };
