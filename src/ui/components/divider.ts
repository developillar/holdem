/**
 * ROYALE — components/divider.ts
 * ────────────────────────────────────────────────────────────────────────────
 * A hairline that fades out at both ends instead of butting into the edges —
 * the small thing that stops a screen looking like a form. Optional centred
 * label for "or", "yesterday", "sit-out".
 *
 *   Divider()
 *   Divider({ label: 'Earlier today' })
 *   Divider({ vertical: true, length: 18 })
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';

export interface DividerOpts {
  label?: string;
  /** vertical rule for inline groups */
  vertical?: boolean;
  /** px length for the vertical variant */
  length?: number;
  /** vertical margin in px, default 12 */
  space?: number;
  /** gold-tinted variant for premium sections */
  gold?: boolean;
  class?: ClassValue;
}

export function Divider(opts: DividerOpts = {}): HTMLElement {
  if (opts.vertical) {
    return h('span', {
      class: cx('r-divi', 'r-divi--v', opts.gold && 'is-gold', opts.class),
      style: { height: `${opts.length ?? 16}px` },
      role: 'separator',
      'aria-orientation': 'vertical',
    });
  }
  return h(
    'div',
    {
      class: cx('r-divi', opts.label && 'has-label', opts.gold && 'is-gold', opts.class),
      style: opts.space !== undefined ? { '--divi-space': `${opts.space}px` } : undefined,
      role: 'separator',
    },
    opts.label ? h('span', { class: 'r-divi__label caps' }, opts.label) : null,
  );
}
