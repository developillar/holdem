/**
 * ROYALE — components/tooltip.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Touch-first tooltip: long-press (or focus, or hover on a mouse) reveals a
 * small glass popover with an arrow, flipped and clamped to stay inside the
 * viewport. Auto-hides, dismisses on scroll or any other touch, and mirrors
 * its text into `aria-description` so screen readers get it without the
 * gesture.
 *
 *   attachTooltip(el, 'All-in adjusted win rate');
 *   const off = attachTooltip(el, text, { placement: 'bottom', ms: 3200 });
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { clamp } from './util.ts';

export interface TooltipOpts {
  placement?: 'top' | 'bottom';
  /** auto-hide delay, default 2800ms */
  ms?: number;
  /** long-press duration on touch, default 380ms */
  holdMs?: number;
  class?: ClassValue;
}

let host: HTMLElement | null = null;
let active: HTMLElement | null = null;
let hideTimer = 0;

function ensureHost(): HTMLElement {
  if (host && document.body.contains(host)) return host;
  host = h('div', { class: 'r-tip-host', 'aria-hidden': 'true' });
  document.body.appendChild(host);
  return host;
}

export function hideTooltip(): void {
  if (!active) return;
  const el = active;
  active = null;
  clearTimeout(hideTimer);
  el.classList.remove('is-in');
  setTimeout(() => el.remove(), 200);
}

/** Shows a tooltip anchored to `anchor`. Returns a hide function. */
export function showTooltip(anchor: Element, text: string, opts: TooltipOpts = {}): () => void {
  hideTooltip();
  const parent = ensureHost();
  const tip = h(
    'div',
    { class: cx('r-tip', opts.class), role: 'tooltip' },
    h('span', { class: 'r-tip__t' }, text),
    h('span', { class: 'r-tip__arrow', 'aria-hidden': 'true' }),
  );
  parent.appendChild(tip);
  active = tip;

  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const margin = 10;
  let place = opts.placement ?? 'top';
  if (place === 'top' && a.top - t.height - margin < 8) place = 'bottom';
  else if (place === 'bottom' && a.bottom + t.height + margin > window.innerHeight - 8) place = 'top';

  const x = clamp(a.left + a.width / 2, 12 + t.width / 2, window.innerWidth - 12 - t.width / 2);
  const y = place === 'top' ? a.top - margin : a.bottom + margin;
  tip.classList.add(`is-${place}`);
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
  tip.style.setProperty('--tip-ax', `${Math.round(a.left + a.width / 2 - (x - t.width / 2))}px`);
  requestAnimationFrame(() => tip.classList.add('is-in'));

  hideTimer = window.setTimeout(hideTooltip, opts.ms ?? 2800);
  return hideTooltip;
}

/** Wires long-press / hover / focus on `el`. Returns a detach function. */
export function attachTooltip(el: HTMLElement, text: string, opts: TooltipOpts = {}): () => void {
  el.setAttribute('aria-description', text);
  let hold = 0;

  const open = () => showTooltip(el, text, opts);
  const down = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse') return;
    hold = window.setTimeout(open, opts.holdMs ?? 380);
  };
  const cancel = () => {
    clearTimeout(hold);
  };
  const enter = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse') open();
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointermove', cancel, { passive: true });
  el.addEventListener('pointerenter', enter);
  el.addEventListener('pointerleave', hideTooltip);
  el.addEventListener('focus', open);
  el.addEventListener('blur', hideTooltip);
  window.addEventListener('scroll', hideTooltip, true);

  return () => {
    cancel();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', cancel);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('pointermove', cancel);
    el.removeEventListener('pointerenter', enter);
    el.removeEventListener('pointerleave', hideTooltip);
    el.removeEventListener('focus', open);
    el.removeEventListener('blur', hideTooltip);
    window.removeEventListener('scroll', hideTooltip, true);
  };
}

/** Small circular "?" that opens a tooltip — for stat abbreviations. */
export function InfoDot(text: string, opts: TooltipOpts = {}): HTMLElement {
  const el = h('button', { class: 'r-tip-dot', type: 'button', 'aria-label': text }, '?');
  attachTooltip(el, text, opts);
  el.addEventListener('click', (ev) => {
    ev.preventDefault();
    showTooltip(el, text, opts);
  });
  return el;
}
