/**
 * ROYALE — components/listrow.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The workhorse row: 56px minimum, leading slot, two lines of text, a
 * right-aligned value with its own caption, and an optional chevron. Wrap a
 * run of them in `List()` to get the inset hairline separators (which stop
 * short of the leading edge, the way iOS does it).
 *
 *   List(
 *     ListRow({ leading: Avatar({ name }), title: name, subtitle: '12 hands',
 *               value: '+$41.20', valueTone: 'good', chevron: true, onTap }),
 *     ListRow({ title: 'Haptics', trailing: Toggle }),
 *   )
 */
import { h, cx } from '../dom.ts';
import type { Child, ClassValue } from '../dom.ts';
import { icon } from './icons.ts';
import { haptic, pressFeedback } from './util.ts';

export interface ListRowOpts {
  leading?: Node;
  title: string;
  subtitle?: string;
  value?: string;
  valueSub?: string;
  valueTone?: 'default' | 'good' | 'bad' | 'gold' | 'dim';
  trailing?: Node;
  chevron?: boolean;
  disabled?: boolean;
  /** de-emphasise everything but the title */
  dense?: boolean;
  class?: ClassValue;
  ariaLabel?: string;
  onTap?: (ev: MouseEvent) => unknown;
}

export function ListRow(opts: ListRowOpts): HTMLElement {
  const interactive = !!opts.onTap;
  const el = h(
    interactive ? 'button' : 'div',
    {
      class: cx('r-row', opts.dense && 'is-dense', interactive && 'is-interactive', opts.disabled && 'is-disabled', opts.class),
      type: interactive ? 'button' : null,
      disabled: interactive && opts.disabled ? true : null,
      'aria-label': opts.ariaLabel ?? null,
    },
    opts.leading ? h('span', { class: 'r-row__lead' }, opts.leading) : null,
    h(
      'span',
      { class: 'r-row__main' },
      h('span', { class: 'r-row__title' }, opts.title),
      opts.subtitle ? h('span', { class: 'r-row__sub' }, opts.subtitle) : null,
    ),
    opts.value !== undefined || opts.valueSub !== undefined
      ? h(
          'span',
          { class: cx('r-row__val', `is-${opts.valueTone ?? 'default'}`) },
          opts.value !== undefined ? h('span', { class: 'r-row__valn tnum' }, opts.value) : null,
          opts.valueSub !== undefined ? h('span', { class: 'r-row__vals' }, opts.valueSub) : null,
        )
      : null,
    opts.trailing ? h('span', { class: 'r-row__trail' }, opts.trailing) : null,
    opts.chevron ? h('span', { class: 'r-row__chev' }, icon('chevron-right', { size: 17, stroke: 2 })) : null,
  );
  if (interactive) {
    pressFeedback(el);
    el.addEventListener('click', (ev) => {
      if (opts.disabled) return;
      haptic('tick');
      opts.onTap?.(ev as MouseEvent);
    });
  }
  return el;
}

export interface ListOpts {
  /** wraps the run in a Surface-like card */
  card?: boolean;
  /** small caps header above the list */
  header?: string;
  /** muted caption below the list */
  footer?: string;
  class?: ClassValue;
}

export function List(opts: ListOpts | Child, ...rest: Child[]): HTMLElement {
  const isOpts =
    opts !== null && typeof opts === 'object' && !(opts instanceof Node) && !Array.isArray(opts);
  const o = (isOpts ? opts : {}) as ListOpts;
  const kids = isOpts ? rest : [opts as Child, ...rest];
  return h(
    'div',
    { class: cx('r-listwrap', o.class) },
    o.header ? h('div', { class: 'r-list__header caps' }, o.header) : null,
    h('div', { class: cx('r-list', o.card !== false && 'is-card') }, ...kids),
    o.footer ? h('p', { class: 'r-list__footer' }, o.footer) : null,
  );
}
