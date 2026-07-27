/**
 * ROYALE — components/tabs.ts
 * ────────────────────────────────────────────────────────────────────────────
 * In-page tabs with a gold underline that springs (and stretches) between
 * items. Scrolls horizontally when the set overflows and keeps the active tab
 * in view. Use `Segmented` for 2–3 exclusive options; use `Tabs` for a
 * content-switching header of 3+.
 *
 *   const t = Tabs({
 *     items: [{ id: 'all', label: 'All' }, { id: 'wins', label: 'Big wins', count: 4 }],
 *     value: 'all',
 *     onChange: (id) => render(id),
 *   });
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { haptic, spring, uid } from './util.ts';

export interface TabItem {
  id: string;
  label: string;
  /** small trailing count chip */
  count?: number;
  icon?: Node;
}

export interface TabsOpts {
  items: TabItem[];
  value?: string;
  /** 'line' underline (default) · 'pill' filled */
  variant?: 'line' | 'pill';
  class?: ClassValue;
  ariaLabel?: string;
  onChange?: (id: string, index: number) => void;
}

export interface TabsEl extends HTMLDivElement {
  setValue(id: string, silent?: boolean): void;
  setCount(id: string, count: number): void;
  value(): string;
}

export function Tabs(opts: TabsOpts): TabsEl {
  const name = uid('tabs');
  let current = opts.value ?? opts.items[0]?.id ?? '';
  const buttons: HTMLButtonElement[] = [];
  const counts = new Map<string, HTMLElement>();

  const ind = h('span', { class: 'r-tabs__ind', 'aria-hidden': 'true' });
  const rail = h('div', { class: 'r-tabs__rail scroll', role: 'tablist', 'aria-label': opts.ariaLabel ?? null });

  const el = h(
    'div',
    { class: cx('r-tabs', `r-tabs--${opts.variant ?? 'line'}`, opts.class) },
    rail,
  ) as TabsEl;

  const posX = spring(0, (v) => ind.style.setProperty('--tx', `${v}px`), { stiffness: 320, damping: 30 });
  const posW = spring(0, (v) => ind.style.setProperty('--tw', `${v}px`), { stiffness: 280, damping: 28 });

  const layout = (animate: boolean) => {
    const i = opts.items.findIndex((it) => it.id === current);
    const b = buttons[i];
    if (!b) return;
    const x = b.offsetLeft;
    const w = b.offsetWidth;
    if (animate) {
      posX.set(x);
      posW.set(w);
    } else {
      posX.jump(x);
      posW.jump(w);
    }
  };

  const select = (id: string, silent: boolean, viaUser: boolean) => {
    const i = opts.items.findIndex((it) => it.id === id);
    if (i < 0) return;
    current = id;
    buttons.forEach((b, bi) => {
      const on = bi === i;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    layout(viaUser);
    buttons[i].scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: viaUser ? 'smooth' : 'auto' });
    if (viaUser) haptic('tick');
    if (!silent) opts.onChange?.(id, i);
  };

  opts.items.forEach((item, i) => {
    const countEl = h('span', { class: 'r-tabs__count tnum' }, item.count ? String(item.count) : '');
    if (!item.count) countEl.classList.add('is-empty');
    counts.set(item.id, countEl);
    const b = h(
      'button',
      { class: 'r-tabs__b', type: 'button', role: 'tab', id: `${name}-${i}`, 'aria-selected': 'false', tabIndex: -1 },
      item.icon ? h('span', { class: 'r-tabs__ic' }, item.icon) : null,
      h('span', { class: 'r-tabs__l' }, item.label),
      countEl,
    );
    b.addEventListener('click', () => select(item.id, false, true));
    buttons.push(b);
    rail.appendChild(b);
  });
  rail.appendChild(ind);

  el.addEventListener('keydown', (ev) => {
    const k = (ev as KeyboardEvent).key;
    const i = opts.items.findIndex((it) => it.id === current);
    let next = -1;
    if (k === 'ArrowRight') next = (i + 1) % opts.items.length;
    else if (k === 'ArrowLeft') next = (i - 1 + opts.items.length) % opts.items.length;
    else if (k === 'Home') next = 0;
    else if (k === 'End') next = opts.items.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    select(opts.items[next].id, false, true);
    buttons[next].focus();
  });

  el.setValue = (id, silent = true) => select(id, silent, false);
  el.setCount = (id, count) => {
    const c = counts.get(id);
    if (!c) return;
    c.textContent = count ? String(count) : '';
    c.classList.toggle('is-empty', !count);
    requestAnimationFrame(() => layout(true));
  };
  el.value = () => current;

  // First layout must wait until the rail has real widths.
  requestAnimationFrame(() => layout(false));
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => layout(false));
    ro.observe(rail);
  }
  select(current, true, false);
  return el;
}
