/**
 * Bottom sheet + modal primitives for the table screen.
 *
 * The shared `Sheet` component was not available when this screen was built,
 * so the table carries its own: a spring-in panel with a blurred scrim, a
 * drag-to-dismiss grabber with real velocity handling, safe-area padding and
 * a focus-safe close. Used by the menu, the hand history, the replay viewer
 * and the buy-in flow so all four feel like one control.
 */

import { bus } from '../../core/bus.ts';
import { clamp, cls, cue, h, haptic, setText } from './dom.ts';
import { icon } from './icons.ts';

export interface Sheet {
  el: HTMLElement;
  body: HTMLElement;
  header: HTMLElement;
  open(): void;
  close(): void;
  setTitle(title: string): void;
  readonly isOpen: boolean;
  onClosed?: () => void;
  dispose(): void;
}

export interface SheetOptions {
  title?: string;
  /** extra class on the root, e.g. 'sheet--tall' */
  className?: string;
  /** show the X button and allow drag-to-dismiss (default true) */
  dismissible?: boolean;
  /** id reported on the `ui:modal` bus event */
  id?: string;
}

export function createSheet(opts: SheetOptions = {}): Sheet {
  const dismissible = opts.dismissible !== false;
  const titleEl = h('h2', { class: 'sheet__title' }, opts.title ?? '');
  const closeBtn = h('button', { class: 'sheet__x', type: 'button', 'aria-label': 'Close' }, icon('close', 18));
  const grabber = h('i', { class: 'sheet__grab', 'aria-hidden': 'true' });
  const header = h('div', { class: 'sheet__head' }, grabber, titleEl, dismissible ? closeBtn : null);
  const body = h('div', { class: 'sheet__body scroll' });
  const panel = h('div', { class: 'sheet__panel' }, h('i', { class: 'sheet__edge' }), header, body);
  const scrim = h('div', { class: 'sheet__scrim' });
  const el = h('div', { class: `sheet${opts.className ? ` ${opts.className}` : ''}`, role: 'dialog', 'aria-modal': 'true' }, scrim, panel);

  let isOpen = false;
  let dragging = false;
  let startY = 0;
  let dy = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;

  const api: Sheet = {
    el,
    body,
    header,
    get isOpen(): boolean {
      return isOpen;
    },
    open(): void {
      if (isOpen) return;
      isOpen = true;
      panel.style.transform = '';
      cls(el, 'is-open', true);
      cue('sheetOpen');
      haptic('select');
      bus.emit('ui:modal', { id: opts.id ?? 'table-sheet' });
      body.scrollTop = 0;
    },
    close(): void {
      if (!isOpen) return;
      isOpen = false;
      cls(el, 'is-open', false);
      panel.style.transform = '';
      cue('sheetClose');
      bus.emit('ui:modal', { id: null });
      api.onClosed?.();
    },
    setTitle(title: string): void {
      setText(titleEl, title);
    },
    dispose(): void {
      el.remove();
    },
  };

  scrim.addEventListener('pointerdown', () => {
    if (dismissible) api.close();
  });
  closeBtn.addEventListener('click', () => api.close());

  if (dismissible) {
    header.addEventListener('pointerdown', (e: PointerEvent) => {
      dragging = true;
      startY = e.clientY;
      lastY = e.clientY;
      lastT = performance.now();
      dy = 0;
      velocity = 0;
      cls(panel, 'is-dragging', true);
      try {
        header.setPointerCapture(e.pointerId);
      } catch {
        /* best effort */
      }
    });
    header.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      const now = performance.now();
      if (now > lastT) {
        velocity = (e.clientY - lastY) / (now - lastT);
        lastY = e.clientY;
        lastT = now;
      }
      panel.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0)`;
    });
    const end = (): void => {
      if (!dragging) return;
      dragging = false;
      cls(panel, 'is-dragging', false);
      const h0 = panel.getBoundingClientRect().height || 400;
      if (dy > h0 * 0.32 || velocity > 0.65) {
        panel.style.transform = '';
        api.close();
      } else {
        panel.style.transform = '';
      }
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  }

  return api;
}

// ═══════════════════════ small controls ═══════════════════════

export interface ToggleRow {
  el: HTMLElement;
  set(on: boolean): void;
  get(): boolean;
}

/** A settings row with a physical-feeling switch. */
export function toggleRow(
  label: string,
  sub: string | null,
  initial: boolean,
  onChange: (on: boolean) => void,
  leading?: SVGElement,
): ToggleRow {
  let on = initial;
  const knob = h('i', { class: 'sw__knob' });
  const sw = h('span', { class: 'sw' }, knob);
  const el = h(
    'button',
    { class: 'row row--toggle', type: 'button', role: 'switch', 'aria-checked': String(initial) },
    leading ? h('i', { class: 'row__ic' }, leading) : null,
    h('span', { class: 'row__text' }, h('span', { class: 'row__label' }, label), sub ? h('span', { class: 'row__sub' }, sub) : null),
    sw,
  );
  const paint = (): void => {
    cls(el, 'is-on', on);
    el.setAttribute('aria-checked', String(on));
  };
  paint();
  el.addEventListener('click', () => {
    on = !on;
    paint();
    haptic('select');
    cue('tapToggle', on ? 1 : 0);
    onChange(on);
  });
  return {
    el,
    set(v: boolean): void {
      on = v;
      paint();
    },
    get: () => on,
  };
}

export interface ActionRowOptions {
  label: string;
  sub?: string;
  tone?: 'default' | 'danger' | 'gold';
  leading?: SVGElement;
  trailing?: HTMLElement | null;
  onPress: () => void;
}

export function actionRow(o: ActionRowOptions): HTMLElement {
  const el = h(
    'button',
    { class: `row row--action row--${o.tone ?? 'default'}`, type: 'button' },
    o.leading ? h('i', { class: 'row__ic' }, o.leading) : null,
    h('span', { class: 'row__text' }, h('span', { class: 'row__label' }, o.label), o.sub ? h('span', { class: 'row__sub' }, o.sub) : null),
    o.trailing ?? h('i', { class: 'row__chev' }, icon('chevron-right', 16)),
  );
  el.addEventListener('click', () => {
    haptic('select');
    cue('tapPrimary');
    o.onPress();
  });
  return el;
}

export interface SegmentedOptions<T extends string> {
  items: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(value: T): void;
}

/** Sliding-indicator segmented control. */
export function segmented<T extends string>(o: SegmentedOptions<T>): Segmented<T> {
  const indicator = h('i', { class: 'seg__ind' });
  const el = h('div', { class: 'seg', role: 'tablist' }, indicator);
  let value = o.value;
  const buttons: HTMLElement[] = [];

  const paint = (): void => {
    const i = Math.max(0, o.items.findIndex((it) => it.id === value));
    const pct = 100 / o.items.length;
    indicator.style.transform = `translate3d(${(i * 100).toFixed(2)}%, 0, 0)`;
    indicator.style.width = `${pct}%`;
    buttons.forEach((b, k) => {
      cls(b, 'is-on', k === i);
      b.setAttribute('aria-selected', String(k === i));
    });
  };

  for (const item of o.items) {
    const b = h('button', { class: 'seg__b', type: 'button', role: 'tab' }, item.label);
    b.addEventListener('click', () => {
      if (value === item.id) return;
      value = item.id;
      paint();
      haptic('select');
      cue('tabSwitch', 1);
      o.onChange(item.id);
    });
    buttons.push(b);
    el.appendChild(b);
  }
  paint();

  return {
    el,
    set(v: T): void {
      value = v;
      paint();
    },
  };
}

/** Considered empty state — never a bare "nothing here". */
export function emptyState(title: string, body: string, glyph?: SVGElement): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty__mark' }, glyph ?? icon('history', 26)),
    h('div', { class: 'empty__t' }, title),
    h('div', { class: 'empty__b' }, body),
  );
}

export { clamp };
