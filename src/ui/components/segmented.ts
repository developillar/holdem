/**
 * ROYALE — components/segmented.ts
 * ────────────────────────────────────────────────────────────────────────────
 * iOS-style segmented control with a pill that springs between segments and
 * squashes slightly in the direction of travel. Full keyboard support
 * (arrows / Home / End) and `role="tablist"` semantics.
 *
 *   const seg = Segmented({
 *     items: [{ id: 'nlhe', label: "Hold'em" }, { id: 'plo4', label: 'PLO' }],
 *     value: 'nlhe',
 *     onChange: (id) => setVariant(id),
 *   });
 *   seg.setValue('plo4');
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { haptic, spring, uid } from './util.ts';

export interface SegmentItem {
  id: string;
  label: string;
  icon?: Node;
  disabled?: boolean;
}

export interface SegmentedOpts {
  items: SegmentItem[];
  value?: string;
  size?: 'sm' | 'md';
  full?: boolean;
  class?: ClassValue;
  ariaLabel?: string;
  onChange?: (id: string, index: number) => void;
}

export interface SegmentedEl extends HTMLDivElement {
  setValue(id: string, silent?: boolean): void;
  value(): string;
}

export function Segmented(opts: SegmentedOpts): SegmentedEl {
  const name = uid('seg');
  let current = opts.value ?? opts.items[0]?.id ?? '';

  const pill = h('span', { class: 'r-seg__pill', 'aria-hidden': 'true' });
  const buttons: HTMLButtonElement[] = [];

  const el = h(
    'div',
    {
      class: cx('r-seg', `r-seg--${opts.size ?? 'md'}`, opts.full && 'is-full', opts.class),
      role: 'tablist',
      'aria-label': opts.ariaLabel ?? null,
      style: { '--seg-n': String(opts.items.length) },
    },
    h('span', { class: 'r-seg__well', 'aria-hidden': 'true' }),
    pill,
  ) as SegmentedEl;

  const move = spring(0, (v) => {
    pill.style.transform = `translate3d(${v * 100}%,0,0)`;
  }, { stiffness: 300, damping: 26 });

  const squash = spring(0, (v) => {
    pill.style.setProperty('--squash', String(1 + Math.min(0.18, Math.abs(v))));
  }, { stiffness: 220, damping: 20 });

  const select = (id: string, silent: boolean, viaUser: boolean) => {
    const idx = opts.items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const prev = opts.items.findIndex((i) => i.id === current);
    current = id;
    buttons.forEach((b, i) => {
      const on = i === idx;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    move.set(idx);
    if (viaUser && prev !== idx) {
      squash.jump(Math.sign(idx - prev) * 0.9);
      squash.set(0);
      haptic('select');
    }
    if (!silent) opts.onChange?.(id, idx);
  };

  opts.items.forEach((item, i) => {
    const b = h(
      'button',
      {
        class: 'r-seg__b',
        type: 'button',
        role: 'tab',
        id: `${name}-${i}`,
        disabled: !!item.disabled,
        'aria-selected': 'false',
        tabIndex: -1,
      },
      item.icon ? h('span', { class: 'r-seg__ic' }, item.icon) : null,
      h('span', { class: 'r-seg__l' }, item.label),
    );
    b.addEventListener('click', () => select(item.id, false, true));
    buttons.push(b);
    el.appendChild(b);
  });

  el.addEventListener('keydown', (ev) => {
    const k = (ev as KeyboardEvent).key;
    const idx = opts.items.findIndex((i) => i.id === current);
    let next = -1;
    if (k === 'ArrowRight' || k === 'ArrowDown') next = (idx + 1) % opts.items.length;
    else if (k === 'ArrowLeft' || k === 'ArrowUp') next = (idx - 1 + opts.items.length) % opts.items.length;
    else if (k === 'Home') next = 0;
    else if (k === 'End') next = opts.items.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    select(opts.items[next].id, false, true);
    buttons[next].focus();
  });

  el.setValue = (id, silent = true) => select(id, silent, false);
  el.value = () => current;

  const startIdx = Math.max(0, opts.items.findIndex((i) => i.id === current));
  move.jump(startIdx);
  select(current, true, false);
  return el;
}
