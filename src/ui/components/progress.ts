/**
 * ROYALE — components/progress.ts
 * ────────────────────────────────────────────────────────────────────────────
 *   ProgressBar({ value: 340, max: 1000, tone: 'gold', label: 'Tier 7' })
 *   RingProgress({ value: 1, size: 46, tone: 'gold' })  // the action timer
 *
 * The bar fills with a real metal gradient plus a travelling gloss, and has a
 * leading-edge glow so the head of the fill reads as lit. The ring is a
 * dash-offset arc with round caps; drive it every frame from your own rAF for
 * the action clock — `set()` is allocation-free.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { clamp } from './util.ts';

export type ProgressTone = 'gold' | 'good' | 'bad' | 'info' | 'epic';

export interface ProgressBarOpts {
  value?: number;
  max?: number;
  tone?: ProgressTone;
  /** 4 | 6 | 10 px track */
  thickness?: number;
  label?: string;
  /** right-aligned caption, e.g. "340 / 1000" */
  caption?: string;
  /** animated barber-pole while indeterminate */
  indeterminate?: boolean;
  /** segment ticks at these fractions (0–1) */
  ticks?: number[];
  class?: ClassValue;
  ariaLabel?: string;
}

export interface ProgressBarEl extends HTMLDivElement {
  set(value: number, max?: number): void;
  setCaption(text: string): void;
}

export function ProgressBar(opts: ProgressBarOpts = {}): ProgressBarEl {
  let max = opts.max ?? 1;
  let value = opts.value ?? 0;

  const fill = h('span', { class: 'r-prg__fill' }, h('span', { class: 'r-prg__gloss' }));
  const capEl = opts.caption !== undefined ? h('span', { class: 'r-prg__cap tnum' }, opts.caption) : null;
  const head = h('div', { class: 'r-prg__head' },
    opts.label ? h('span', { class: 'r-prg__label caps' }, opts.label) : null,
    capEl,
  );

  const track = h(
    'div',
    {
      class: 'r-prg__track',
      role: 'progressbar',
      'aria-label': opts.ariaLabel ?? opts.label ?? 'progress',
      'aria-valuemin': '0',
      'aria-valuemax': String(max),
      'aria-valuenow': String(value),
    },
    fill,
    ...(opts.ticks ?? []).map((t) =>
      h('span', { class: 'r-prg__tick', style: { left: `${clamp(t, 0, 1) * 100}%` } }),
    ),
  );

  const el = h(
    'div',
    {
      class: cx('r-prg', `r-prg--${opts.tone ?? 'gold'}`, opts.indeterminate && 'is-indeterminate', opts.class),
      style: opts.thickness ? { '--prg-h': `${opts.thickness}px` } : undefined,
    },
    opts.label || capEl ? head : null,
    track,
  ) as ProgressBarEl;

  const paint = () => {
    const pct = max > 0 ? clamp(value / max, 0, 1) : 0;
    fill.style.transform = `scaleX(${pct.toFixed(4)})`;
    fill.classList.toggle('is-empty', pct <= 0.001);
    track.setAttribute('aria-valuenow', String(Math.round(value)));
    track.setAttribute('aria-valuemax', String(Math.round(max)));
  };

  el.set = (v, m) => {
    if (m !== undefined) max = m;
    value = v;
    paint();
  };
  el.setCaption = (text) => {
    if (capEl) capEl.textContent = text;
  };
  paint();
  return el;
}

export interface RingProgressOpts {
  /** 0–1 */
  value?: number;
  size?: number;
  /** stroke width, default size/9 */
  stroke?: number;
  tone?: ProgressTone;
  /** node rendered in the middle (a count, an icon) */
  center?: Node;
  class?: ClassValue;
  ariaLabel?: string;
}

export interface RingProgressEl extends HTMLDivElement {
  /** value 0–1; `tone` optionally re-tints (timer going red) */
  set(value: number, tone?: ProgressTone): void;
  setCenter(node: Node | string): void;
}

export function RingProgress(opts: RingProgressOpts = {}): RingProgressEl {
  const size = opts.size ?? 48;
  const sw = opts.stroke ?? Math.max(3, size / 9);
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;

  const arc = h('circle', {
    attrs: {
      cx: size / 2, cy: size / 2, r,
      fill: 'none', stroke: 'currentColor', 'stroke-width': sw,
      'stroke-linecap': 'round',
      'stroke-dasharray': circ.toFixed(2),
      'stroke-dashoffset': '0',
    },
  });
  const centerEl = h('div', { class: 'r-ring__center' }, opts.center ?? null);

  const el = h(
    'div',
    {
      class: cx('r-ring', `r-ring--${opts.tone ?? 'gold'}`, opts.class),
      style: { '--ring': `${size}px` },
      role: 'progressbar',
      'aria-label': opts.ariaLabel ?? 'progress',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    },
    h(
      'svg',
      { class: 'r-ring__svg', attrs: { width: size, height: size, viewBox: `0 0 ${size} ${size}` } },
      h('circle', {
        class: 'r-ring__bg',
        attrs: { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': sw },
      }),
      h('g', { class: 'r-ring__arcw', attrs: { transform: `rotate(-90 ${size / 2} ${size / 2})` } }, arc),
    ),
    centerEl,
  ) as RingProgressEl;

  el.set = (value, tone) => {
    const v = clamp(value, 0, 1);
    arc.setAttribute('stroke-dashoffset', (circ * (1 - v)).toFixed(2));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    if (tone) {
      el.className = cx('r-ring', `r-ring--${tone}`, opts.class);
    }
  };
  el.setCenter = (node) => {
    centerEl.textContent = '';
    centerEl.append(node);
  };
  el.set(opts.value ?? 0);
  return el;
}
