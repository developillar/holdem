/**
 * ROYALE — components/badge.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The little count/dot that rides on a tab icon, an avatar or a list row.
 * It springs in, springs out, and clamps at 99+. The ring colour is a CSS
 * variable (`--badge-ring`) so it can punch a hole in whatever it sits on.
 *
 *   const b = Badge({ count: 3 });     // "3"
 *   b.set(0);                          // springs away
 *   Badge({ dot: true, tone: 'gold' }) // 8px unread dot
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';

export type BadgeTone = 'bad' | 'gold' | 'good' | 'info';

export interface BadgeOpts {
  count?: number;
  dot?: boolean;
  tone?: BadgeTone;
  class?: ClassValue;
  ariaLabel?: string;
}

export interface BadgeEl extends HTMLSpanElement {
  /** 0 / false hides it, anything else shows it with a pop */
  set(value: number | boolean): void;
}

export function Badge(opts: BadgeOpts = {}): BadgeEl {
  const label = h('span', { class: 'r-badge__n tnum' });
  const el = h(
    'span',
    {
      class: cx('r-badge', `r-badge--${opts.tone ?? 'bad'}`, opts.dot && 'r-badge--dot', opts.class),
      role: 'status',
      'aria-label': opts.ariaLabel ?? null,
      'aria-live': 'polite',
    },
    opts.dot ? null : label,
  ) as BadgeEl;

  let shown = false;
  el.set = (value) => {
    const n = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    const visible = n > 0;
    if (!opts.dot) label.textContent = n > 99 ? '99+' : String(n);
    if (visible === shown) return;
    shown = visible;
    el.classList.toggle('is-on', visible);
    if (visible) {
      el.classList.remove('is-pop');
      void el.offsetWidth;
      el.classList.add('is-pop');
    }
  };
  el.set(opts.dot ? true : (opts.count ?? 0));
  return el;
}
