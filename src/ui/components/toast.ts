/**
 * ROYALE — components/toast.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Stacking toasts under the top bar. Newest enters at the top and pushes the
 * others down (a real grid-row collapse, not a jump), each auto-dismisses,
 * and any of them can be flicked away sideways.
 *
 * Fire one from anywhere in the app — no import of this module required:
 *   bus.emit('ui:toast', { text: 'Seat reserved', tone: 'good' });
 * or, with the convenience wrapper:
 *   toast('Not enough gems', 'bad');
 *
 * The shell calls `mountToastHost(el)` once; it returns a disposer.
 */
import { h, cx } from '../dom.ts';
import { bus } from '../../core/bus.ts';
import type { AppEvents } from '../../core/bus.ts';
import { icon } from './icons.ts';
import { haptic, swipeToDismiss } from './util.ts';

export type ToastTone = AppEvents['ui:toast']['tone'];

const TONE_ICON: Record<ToastTone, string> = {
  info: 'info',
  good: 'check',
  bad: 'warning',
  epic: 'sparkle',
};

const MAX_VISIBLE = 4;
const live: HTMLElement[] = [];

/** Convenience emitter — identical to `bus.emit('ui:toast', …)`. */
export function toast(text: string, tone: ToastTone = 'info', ms?: number): void {
  bus.emit('ui:toast', { text, tone, ms });
}

function build(host: HTMLElement, text: string, tone: ToastTone, ms: number): void {
  const card = h(
    'div',
    { class: cx('r-toast', `r-toast--${tone}`), role: 'status', 'aria-live': tone === 'bad' ? 'assertive' : 'polite' },
    h('span', { class: 'r-toast__ic' }, icon(TONE_ICON[tone] as 'info', { size: 17, stroke: 2.1 })),
    h('span', { class: 'r-toast__t' }, text),
    h('span', { class: 'r-toast__bar', 'aria-hidden': 'true', style: { '--toast-ms': `${ms}ms` } }),
  );
  const slot = h('div', { class: 'r-toast-slot' }, h('div', { class: 'r-toast-slot__in' }, card));

  let closed = false;
  let timer = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    const i = live.indexOf(slot);
    if (i >= 0) live.splice(i, 1);
    slot.classList.remove('is-in');
    slot.classList.add('is-out');
    setTimeout(() => slot.remove(), 320);
  };

  swipeToDismiss(card, {
    onMove: (dx) => {
      card.style.transform = `translate3d(${dx}px,0,0)`;
      card.style.opacity = String(Math.max(0.15, 1 - Math.abs(dx) / 220));
    },
    onDismiss: (dir) => {
      card.style.transition = 'transform var(--d-fast) var(--ease-out), opacity var(--d-fast) linear';
      card.style.transform = `translate3d(${dir * 420}px,0,0)`;
      card.style.opacity = '0';
      close();
    },
    onCancel: () => {
      card.style.transition = 'transform var(--d-base) var(--ease-spring), opacity var(--d-fast) linear';
      card.style.transform = '';
      card.style.opacity = '';
      setTimeout(() => (card.style.transition = ''), 260);
    },
  });
  card.addEventListener('click', close);

  host.prepend(slot);
  live.unshift(slot);
  while (live.length > MAX_VISIBLE) {
    const oldest = live.pop();
    oldest?.dispatchEvent(new CustomEvent('r-toast-evict'));
    oldest?.classList.add('is-out');
    setTimeout(() => oldest?.remove(), 320);
  }
  requestAnimationFrame(() => slot.classList.add('is-in'));
  timer = window.setTimeout(close, ms);
}

/** Subscribes the host element to `ui:toast`. Returns an unsubscribe. */
export function mountToastHost(host: HTMLElement): () => void {
  return bus.on('ui:toast', ({ text, tone, ms }) => {
    if (!text) return;
    build(host, text, tone, Math.max(1200, ms ?? (tone === 'epic' ? 3400 : 2600)));
    haptic(tone === 'bad' ? 'error' : tone === 'epic' ? 'win' : 'tick');
  });
}
