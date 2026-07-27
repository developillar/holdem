/**
 * ROYALE — components/slider.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The bet slider. Chunky, thumb-with-shadow, follows the finger exactly, and
 * magnetises onto sizing snaps (⅓ pot, ½ pot, pot, all-in) without ever
 * fighting you. Grab anywhere on the track to jump; the whole control is 48px
 * tall so a thumb never misses it.
 *
 *   const s = Slider({
 *     min: 2, max: 180, step: 0.5, value: 12,
 *     snaps: [12, 18, 27, 180],
 *     format: (v) => money(v),
 *     onInput: (v) => preview(v),
 *     onChange: (v) => commit(v),
 *   });
 *   s.setRange(2, 240); s.setValue(27);
 *
 * Accessibility: `role="slider"` with live `aria-valuetext`, and the full
 * keyboard map — ←/→ step, ↑/↓ step, PageUp/Down ×10, Home/End, plus digits
 * 1–9 to jump to that tenth of the range.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { clamp, haptic, roundTo, uid } from './util.ts';

export interface SliderOpts {
  min: number;
  max: number;
  value?: number;
  step?: number;
  /** absolute values the thumb magnetises onto (within 2.5% of the range) */
  snaps?: number[];
  /** label shown in the bubble and used for aria-valuetext */
  format?: (v: number) => string;
  tone?: 'gold' | 'good' | 'bad';
  ariaLabel?: string;
  disabled?: boolean;
  class?: ClassValue;
  /** every frame of the drag */
  onInput?: (v: number) => void;
  /** on release / keyboard commit */
  onChange?: (v: number) => void;
}

export interface SliderEl extends HTMLDivElement {
  setValue(v: number, silent?: boolean): void;
  setRange(min: number, max: number, value?: number): void;
  setSnaps(snaps: number[]): void;
  setDisabled(on: boolean): void;
  value(): number;
}

export function Slider(opts: SliderOpts): SliderEl {
  let min = opts.min;
  let max = Math.max(opts.max, opts.min);
  let step = opts.step ?? 0;
  let snaps = opts.snaps ? opts.snaps.slice() : [];
  let value = clamp(opts.value ?? min, min, max);
  const format = opts.format ?? ((v: number) => String(Math.round(v)));
  const labelId = uid('sldl');

  const fill = h('span', { class: 'r-sld__fill' });
  const glow = h('span', { class: 'r-sld__glow', 'aria-hidden': 'true' });
  const ticks = h('span', { class: 'r-sld__ticks', 'aria-hidden': 'true' });
  const track = h('span', { class: 'r-sld__track' }, fill, glow, ticks);
  const thumb = h('span', { class: 'r-sld__thumb', 'aria-hidden': 'true' },
    h('span', { class: 'r-sld__knurl' }),
  );
  const bubble = h('span', { class: 'r-sld__bubble tnum', 'aria-hidden': 'true' });

  const el = h(
    'div',
    {
      class: cx('r-sld', `r-sld--${opts.tone ?? 'gold'}`, opts.disabled && 'is-disabled', opts.class),
      role: 'slider',
      tabIndex: opts.disabled ? -1 : 0,
      id: labelId,
      'aria-label': opts.ariaLabel ?? 'Bet size',
      'aria-valuemin': String(min),
      'aria-valuemax': String(max),
      'aria-valuenow': String(value),
      'aria-valuetext': format(value),
      'aria-disabled': opts.disabled ? 'true' : null,
    },
    track,
    thumb,
    bubble,
  ) as SliderEl;

  const frac = () => (max > min ? (value - min) / (max - min) : 0);

  const paintTicks = () => {
    ticks.textContent = '';
    if (max <= min) return;
    for (const sv of snaps) {
      if (sv <= min || sv >= max) continue;
      ticks.appendChild(
        h('i', { style: { left: `${(((sv - min) / (max - min)) * 100).toFixed(3)}%` } }),
      );
    }
  };

  /**
   * All geometry is one CSS custom property: `--f` (0–1). The stylesheet
   * derives the fill width, thumb centre and bubble position from it with
   * `calc(var(--sld-thumb)/2 + (100% - var(--sld-thumb)) * var(--f))`, so a
   * drag frame writes exactly one property and allocates nothing.
   */
  const paint = () => {
    const f = frac();
    el.style.setProperty('--f', f.toFixed(5));
    bubble.textContent = format(value);
    el.setAttribute('aria-valuenow', String(value));
    el.setAttribute('aria-valuetext', format(value));
  };

  const quantise = (raw: number): number => {
    let v = clamp(raw, min, max);
    if (step > 0) v = clamp(roundTo(v - min, step) + min, min, max);
    const tol = (max - min) * 0.025;
    let best = -1;
    let bestD = Infinity;
    for (const sv of snaps) {
      const d = Math.abs(sv - v);
      if (d < bestD) {
        bestD = d;
        best = sv;
      }
    }
    if (best >= 0 && bestD <= tol) v = clamp(best, min, max);
    return Math.abs(v) < 1e-9 ? 0 : v;
  };

  let lastHapticStep = -1;
  const apply = (raw: number, live: boolean) => {
    const next = quantise(raw);
    if (next === value) return;
    value = next;
    paint();
    const bucket = Math.round(frac() * 24);
    if (live && bucket !== lastHapticStep) {
      lastHapticStep = bucket;
      haptic('tick');
    }
    opts.onInput?.(value);
  };

  const valueFromX = (clientX: number): number => {
    const r = track.getBoundingClientRect();
    const thumbW = parseFloat(getComputedStyle(el).getPropertyValue('--sld-thumb')) || 30;
    const usable = Math.max(1, r.width - thumbW);
    const x = clamp(clientX - r.left - thumbW / 2, 0, usable);
    return min + (x / usable) * (max - min);
  };

  let dragging = -1;
  el.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    if (opts.disabled || dragging !== -1) return;
    dragging = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add('is-drag');
    lastHapticStep = -1;
    apply(valueFromX(e.clientX), true);
    haptic('select');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (ev) => {
    const e = ev as PointerEvent;
    if (e.pointerId !== dragging) return;
    apply(valueFromX(e.clientX), true);
  });
  const release = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerId !== dragging) return;
    dragging = -1;
    el.classList.remove('is-drag');
    opts.onChange?.(value);
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);

  el.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (opts.disabled) return;
    const unit = step > 0 ? step : (max - min) / 100;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': next = value + unit; break;
      case 'ArrowLeft': case 'ArrowDown': next = value - unit; break;
      case 'PageUp': next = value + unit * 10; break;
      case 'PageDown': next = value - unit * 10; break;
      case 'Home': next = min; break;
      case 'End': next = max; break;
      default:
        if (e.key >= '1' && e.key <= '9') next = min + ((max - min) * (e.key.charCodeAt(0) - 48)) / 10;
        else if (e.key === '0') next = max;
    }
    if (next === null) return;
    e.preventDefault();
    apply(next, false);
    opts.onChange?.(value);
  });
  el.addEventListener('focus', () => el.classList.add('is-focus'));
  el.addEventListener('blur', () => el.classList.remove('is-focus'));

  el.setValue = (v, silent = true) => {
    const next = quantise(v);
    if (next === value) return;
    value = next;
    paint();
    if (!silent) {
      opts.onInput?.(value);
      opts.onChange?.(value);
    }
  };
  el.setRange = (lo, hi, v) => {
    min = lo;
    max = Math.max(hi, lo);
    el.setAttribute('aria-valuemin', String(min));
    el.setAttribute('aria-valuemax', String(max));
    value = quantise(v ?? value);
    paintTicks();
    paint();
  };
  el.setSnaps = (next) => {
    snaps = next.slice();
    paintTicks();
  };
  el.setDisabled = (on) => {
    el.classList.toggle('is-disabled', on);
    el.tabIndex = on ? -1 : 0;
    if (on) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  };
  el.value = () => value;

  paintTicks();
  paint();
  return el;
}
