/**
 * ROYALE — components/countup.ts
 * ────────────────────────────────────────────────────────────────────────────
 * A number that rolls to its new value instead of snapping. Tabular numerals
 * are enforced so nothing ever reflows mid-count, and the element pops in
 * scale + tints green/red for the direction of the change.
 *
 *   const bal = CountUp({ value: 25_000, format: fmtInt });
 *   bal.set(31_400);          // rolls up, flashes gold
 *   bal.set(0, { silent: true }); // jumps, no animation
 *
 * Uses one shared rAF per instance, cancels cleanly, and honours
 * prefers-reduced-motion (jumps straight to the value).
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { fmtInt, reduceMotion } from './util.ts';

export interface CountUpOpts {
  value?: number;
  /** default `fmtInt` (grouped integer) */
  format?: (n: number) => string;
  /** roll duration, default 620ms */
  ms?: number;
  /** scale pop on change, default true */
  pop?: boolean;
  /** tint the element for the direction of change, default true */
  tint?: boolean;
  class?: ClassValue;
  ariaLabel?: string;
}

export interface CountUpEl extends HTMLSpanElement {
  set(value: number, opts?: { silent?: boolean; ms?: number }): void;
  current(): number;
}

const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t));

export function CountUp(opts: CountUpOpts = {}): CountUpEl {
  const format = opts.format ?? fmtInt;
  const dur = opts.ms ?? 620;
  let value = opts.value ?? 0;
  let raf = 0;

  const el = h('span', {
    class: cx('r-cup', 'tnum', opts.class),
    'aria-label': opts.ariaLabel ?? null,
    text: format(value),
  }) as CountUpEl;

  const pop = (dir: number) => {
    if (opts.pop === false || reduceMotion()) return;
    el.classList.remove('is-pop', 'is-up', 'is-down');
    void el.offsetWidth;
    el.classList.add('is-pop');
    if (opts.tint !== false) el.classList.add(dir >= 0 ? 'is-up' : 'is-down');
  };

  el.addEventListener('animationend', () => el.classList.remove('is-pop', 'is-up', 'is-down'));

  el.set = (next, o = {}) => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const from = value;
    const delta = next - from;
    value = next;
    if (o.silent || delta === 0 || reduceMotion()) {
      el.textContent = format(next);
      if (!o.silent && delta !== 0) pop(delta);
      return;
    }
    pop(delta);
    const ms = o.ms ?? Math.min(1100, dur + Math.min(420, Math.abs(delta) * 0.02));
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      el.textContent = format(from + delta * easeOutExpo(t));
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        raf = 0;
        el.textContent = format(next);
      }
    };
    raf = requestAnimationFrame(tick);
  };

  el.current = () => value;
  return el;
}
