/**
 * ROYALE — fx/text.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Floating type: rising values, streak counters and the big headline cards
 * ("ROYAL FLUSH", "BAD BEAT", "ALL IN").
 *
 * Text is the one thing that must never be rasterised into the WebGL layer, so
 * all of it lives here as real DOM with real font hinting. The animations are
 * CSS keyframes driven by per-node custom properties — declarative, composited,
 * and free of any per-frame JavaScript. The only measurement in the file is a
 * single `offsetLeft` sweep when a headline mounts, used to stretch ONE gold
 * gradient across letters that each animate independently (a shared
 * `background-clip: text` on the parent would break the moment a child got a
 * transform, so every letter carries its own slice of the same gradient).
 */
import { engine, reduceMotion, token, pointOf, clamp, type FxPoint } from './engine.ts';
import { money } from '../core/stakes.ts';
import { shineOnce } from './shine.ts';

export type TextTone = 'good' | 'bad' | 'gold' | 'neutral' | 'epic';

export interface FloatTextOpts {
  at?: FxPoint | Element | string;
  tone?: TextTone;
  size?: 'sm' | 'md' | 'lg';
  ms?: number;
  /** upward drift distance, px */
  drift?: number;
  delayMs?: number;
  /** small leading glyph drawn inline as SVG */
  glyph?: 'chip' | 'gem' | 'xp' | 'up' | 'down' | null;
}

const TONE_VAR: Record<TextTone, [string, string]> = {
  good: ['--c-good', '#34d399'],
  bad: ['--c-bad', '#f6534f'],
  gold: ['--c-gold-300', '#edc96b'],
  neutral: ['--c-slate-100', '#dfe4ee'],
  epic: ['--c-epic', '#a78bfa'],
};

// ─────────────────────────── inline glyphs ───────────────────────────
// Drawn, never emoji. Kept tiny — these sit at 11–13px next to a number.

function svg(paths: string, viewBox = '0 0 16 16'): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = paths;
  return el;
}

function glyphFor(kind: NonNullable<FloatTextOpts['glyph']>): SVGSVGElement {
  switch (kind) {
    case 'chip':
      return svg(
        '<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
          '<circle cx="8" cy="8" r="2.7" fill="currentColor"/>' +
          '<path d="M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
      );
    case 'gem':
      return svg(
        '<path d="M4.4 2h7.2l3 4.1L8 14.4 1.4 6.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
          '<path d="M1.4 6.1h13.2M5.6 6.1 8 14.4l2.4-8.3M4.4 2 5.6 6.1M11.6 2l-1.2 4.1" stroke="currentColor" stroke-width="1.1"/>',
      );
    case 'xp':
      return svg(
        '<path d="M9.2 1.3 2.6 9.1h4.1l-.9 5.6 6.6-7.8H8.3z" fill="currentColor"/>',
      );
    case 'up':
      return svg('<path d="M8 3.2 13 9.4H9.9v3.6H6.1V9.4H3z" fill="currentColor"/>');
    case 'down':
      return svg('<path d="M8 12.8 3 6.6h3.1V3h3.8v3.6H13z" fill="currentColor"/>');
  }
}

// ─────────────────────────── floating value ───────────────────────────

/**
 * Damage-number-style riser: a spring pop, a slow drift, then a fade. The pop
 * and the drift are one keyframe track so the two never fight for the
 * transform, and the whole node is removed on `animationend`.
 */
export function floatText(text: string, opts: FloatTextOpts = {}): HTMLElement | null {
  const host = engine.layer('text');
  const at = pointOf(opts.at, { x: engine.viewport().w / 2, y: engine.viewport().h * 0.42 });
  const tone = opts.tone ?? 'gold';
  const [varName, fallback] = TONE_VAR[tone];
  const ms = opts.ms ?? 1350;

  const el = document.createElement('div');
  el.className = `fx-float fx-float--${opts.size ?? 'md'} fx-float--${tone}`;
  el.style.setProperty('--fx-c', token(varName, fallback));
  el.style.setProperty('--fx-drift', `${-(opts.drift ?? 62)}px`);
  el.style.setProperty('--fx-ms', `${ms}ms`);
  el.style.setProperty('--fx-delay', `${opts.delayMs ?? 0}ms`);
  // Keep risers fully on screen — a "+$142.50" clipped by the safe area is
  // worse than one nudged 20px inward.
  const vp = engine.viewport();
  el.style.left = `${clamp(at.x, 60, Math.max(60, vp.w - 60))}px`;
  el.style.top = `${clamp(at.y, 78, Math.max(78, vp.h - 70))}px`;

  if (opts.glyph) {
    const g = glyphFor(opts.glyph);
    g.classList.add('fx-float__g');
    el.appendChild(g);
  }
  const label = document.createElement('span');
  label.className = 'fx-float__t tnum';
  label.textContent = text;
  el.appendChild(label);

  host.appendChild(el);
  if (reduceMotion()) {
    el.classList.add('is-static');
    engine.after(900, () => el.remove());
    return el;
  }
  el.addEventListener('animationend', () => el.remove(), { once: true });
  // Safety net in case the element is hidden before its animation can end.
  engine.after(ms + (opts.delayMs ?? 0) + 400, () => el.remove());
  return el;
}

/** `floatText` with the app's money formatting and an automatic sign + tone. */
export function floatValue(amount: number, opts: FloatTextOpts = {}): void {
  const positive = amount >= 0;
  floatText(`${positive ? '+' : '−'}${money(Math.abs(amount))}`, {
    ...opts,
    tone: opts.tone ?? (positive ? 'good' : 'bad'),
    size: opts.size ?? 'lg',
  });
}

/** "+240" style riser, gold, with the bolt glyph. */
export function floatXp(amount: number, opts: FloatTextOpts = {}): void {
  floatText(`+${Math.round(amount)}`, {
    ...opts,
    tone: opts.tone ?? 'gold',
    glyph: opts.glyph ?? 'xp',
    size: opts.size ?? 'sm',
  });
}

// ─────────────────────────── streak counter ───────────────────────────

export interface StreakOpts {
  at?: FxPoint | Element | string;
  label?: string;
  tone?: TextTone;
  ms?: number;
}

/**
 * The big combo number. Scale is driven off the streak length so a 12-streak
 * genuinely feels bigger than a 3-streak without a second code path, and the
 * heat ring behind it saturates on the same curve.
 */
/** Like headlines, a streak displaces the previous one rather than stacking. */
let liveStreak: (() => void) | null = null;

export function streakCounter(n: number, opts: StreakOpts = {}): void {
  liveStreak?.();
  const host = engine.layer('text');
  const at = pointOf(opts.at, { x: engine.viewport().w / 2, y: engine.viewport().h * 0.34 });
  const heat = clamp((n - 2) / 10, 0, 1);
  const tone = opts.tone ?? (heat > 0.55 ? 'gold' : 'good');
  const [varName, fallback] = TONE_VAR[tone];
  const ms = opts.ms ?? 1250;

  const el = document.createElement('div');
  el.className = 'fx-streak';
  el.style.setProperty('--fx-c', token(varName, fallback));
  el.style.setProperty('--fx-heat', heat.toFixed(2));
  el.style.setProperty('--fx-ms', `${ms}ms`);
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;

  const ring = document.createElement('i');
  ring.className = 'fx-streak__ring';
  const num = document.createElement('div');
  num.className = 'fx-streak__n tnum';
  num.textContent = `${n}`;
  const mult = document.createElement('span');
  mult.className = 'fx-streak__x';
  mult.textContent = '×';
  const lab = document.createElement('div');
  lab.className = 'fx-streak__l caps';
  lab.textContent = opts.label ?? 'STREAK';

  num.insertBefore(mult, num.firstChild);
  el.append(ring, num, lab);
  host.appendChild(el);

  const drop = (): void => {
    if (liveStreak === drop) liveStreak = null;
    el.remove();
  };
  liveStreak = drop;

  if (reduceMotion()) {
    el.classList.add('is-static');
    engine.after(800, drop);
    return;
  }
  engine.after(ms + 260, drop);
}

// ─────────────────────────── headline ───────────────────────────

export interface HeadlineOpts {
  /** small caps line rendered ABOVE the headline */
  kicker?: string;
  /** small caps line rendered BELOW the headline */
  sub?: string;
  tone?: 'gold' | 'bad' | 'epic' | 'good';
  /** ms the headline holds before leaving */
  holdMs?: number;
  at?: FxPoint;
  /** stagger between letters, ms */
  stepMs?: number;
  /** run the specular sweep across it (default true for gold) */
  sweep?: boolean;
}

/**
 * "ROYAL FLUSH". Letters fly up out of the floor of the card one at a time,
 * each rotating out of a −72° X tilt, and the gold gradient is stretched
 * across the whole word so the sheen is continuous rather than repeating per
 * character. That continuity is the difference between "styled text" and
 * something that looks stamped out of metal.
 */
/** Only one headline is ever on screen — a second one displaces the first. */
let liveHeadline: { el: HTMLElement; cancels: Array<() => void> } | null = null;

function dismissHeadline(fast: boolean): void {
  const cur = liveHeadline;
  if (!cur) return;
  liveHeadline = null;
  for (const c of cur.cancels) c();
  cur.el.classList.remove('is-in');
  cur.el.classList.add('is-out');
  engine.after(fast ? 200 : 420, () => cur.el.remove());
}

export function headline(text: string, opts: HeadlineOpts = {}): HTMLElement {
  dismissHeadline(true);
  const host = engine.layer('text');
  const tone = opts.tone ?? 'gold';
  const step = opts.stepMs ?? 34;
  const chars = Array.from(text);
  const hold = opts.holdMs ?? 1500;
  const inMs = 520 + chars.length * step;

  const el = document.createElement('div');
  el.className = `fx-headline fx-headline--${tone}`;
  if (opts.at) {
    el.style.left = `${opts.at.x}px`;
    el.style.top = `${opts.at.y}px`;
    el.classList.add('is-anchored');
  }

  const glow = document.createElement('i');
  glow.className = 'fx-headline__glow';

  const row = document.createElement('div');
  row.className = 'fx-headline__row';
  const spans: HTMLElement[] = [];
  let visibleIndex = 0;
  for (const ch of chars) {
    const s = document.createElement('span');
    if (ch === ' ') {
      s.className = 'fx-hl-sp';
      s.innerHTML = '&nbsp;';
    } else {
      s.className = 'fx-hl-ch';
      s.textContent = ch;
      // Feeds the ::before emboss copy — a solid dark glyph behind the
      // gradient fill, which gets us depth without an animated filter.
      s.dataset.c = ch;
      s.style.setProperty('--i', String(visibleIndex++));
      s.style.setProperty('--step', `${step}ms`);
      spans.push(s);
    }
    row.appendChild(s);
  }

  el.appendChild(glow);
  if (opts.kicker) {
    const kick = document.createElement('div');
    kick.className = 'fx-headline__kicker caps';
    kick.textContent = opts.kicker;
    kick.style.setProperty('--i', '0');
    kick.style.setProperty('--step', `${step}ms`);
    el.appendChild(kick);
  }
  el.appendChild(row);
  if (opts.sub) {
    const sub = document.createElement('div');
    sub.className = 'fx-headline__sub caps';
    sub.textContent = opts.sub;
    sub.style.setProperty('--i', String(visibleIndex));
    sub.style.setProperty('--step', `${step}ms`);
    el.appendChild(sub);
  }
  host.appendChild(el);

  // One measurement pass, before any class that animates: stretch a single
  // gradient across the row by giving every letter the row's width as its
  // background-size and its own left offset as the background position.
  const rowWidth = row.offsetWidth || 1;
  for (const s of spans) {
    s.style.setProperty('--gw', `${rowWidth}px`);
    s.style.setProperty('--gx', `${-s.offsetLeft}px`);
  }

  const cancels: Array<() => void> = [];
  liveHeadline = { el, cancels };

  if (reduceMotion()) {
    el.classList.add('is-static');
    cancels.push(
      engine.after(Math.min(1400, hold + 400), () => {
        liveHeadline = null;
        el.remove();
      }),
    );
    return el;
  }

  el.classList.add('is-in');
  if (tone === 'gold' && opts.sweep !== false) {
    cancels.push(engine.after(inMs * 0.7, () => shineOnce(row, { width: 0.3, angle: 14, strength: 0.9 })));
  }
  cancels.push(engine.after(inMs + hold, () => dismissHeadline(false)));
  return el;
}

/**
 * Two-line variant used for showdown callouts: a small kicker above a big
 * headline, e.g. "YOU WIN" / "$142.50".
 */
export function callout(kicker: string, value: string, opts: HeadlineOpts = {}): void {
  headline(value, { ...opts, kicker });
}

/** Remove every headline/float currently on screen — used on route changes. */
export function clearText(): void {
  if (liveHeadline) {
    for (const c of liveHeadline.cancels) c();
    liveHeadline = null;
  }
  liveStreak?.();
  liveStreak = null;
  const layer = engine.layer('text');
  while (layer.firstChild) layer.removeChild(layer.firstChild);
}
