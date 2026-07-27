/**
 * ROYALE — components/button.ts
 * ────────────────────────────────────────────────────────────────────────────
 *   Button({ label: 'Sit down', variant: 'primary', onTap })
 *   Button({ label: 'Fold', variant: 'destructive', size: 'lg', full: true })
 *   Button({ icon: icon('plus'), variant: 'ghost', ariaLabel: 'Add chips' })
 *
 * Variants
 *   primary      milled 24k gold with a specular sheen that sweeps on tap
 *   secondary    frosted glass with a hairline and inner highlight
 *   ghost        text-only, still 44px tall
 *   destructive  low-saturation crimson glass
 *
 * Sizes: 'sm' 40px · 'md' 48px · 'lg' 56px (all ≥ the 44px hit floor via
 * `-webkit-tap-highlight` free padding on `sm`).
 *
 * Async `onTap` handlers automatically drive the loading spinner and are
 * re-entrancy guarded, so a double tap can never fire a purchase twice.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue, Child } from '../dom.ts';
import { haptic, pressFeedback } from './util.ts';
import type { HapticPattern } from '../../core/bus.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonOpts {
  label?: string;
  /** small line under the label — price, "20 gems", "min 40bb" */
  sub?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: Node;
  iconRight?: Node;
  full?: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** haptic fired on tap; pass null to silence */
  haptic?: HapticPattern | null;
  ariaLabel?: string;
  class?: ClassValue;
  /**
   * Return a promise and the button drives its own loading state and blocks
   * re-entry until it settles. Any other return value is ignored, so
   * `onTap: () => openSheet(…)` is fine.
   */
  onTap?: (ev: MouseEvent) => unknown;
  /** extra nodes appended inside the label column */
  children?: Child;
}

export interface ButtonEl extends HTMLButtonElement {
  setLoading(on: boolean): void;
  setDisabled(on: boolean): void;
  setLabel(text: string): void;
  setSub(text: string): void;
}

export function Button(opts: ButtonOpts): ButtonEl {
  const variant = opts.variant ?? 'secondary';
  const size = opts.size ?? 'md';

  const labelEl = h('span', { class: 'r-btn__label' }, opts.label ?? null);
  const subEl = opts.sub ? h('span', { class: 'r-btn__sub tnum' }, opts.sub) : null;

  const el = h(
    'button',
    {
      class: cx('r-btn', `r-btn--${variant}`, `r-btn--${size}`, opts.full && 'is-full', opts.class),
      type: 'button',
      disabled: !!opts.disabled,
      'aria-label': opts.ariaLabel ?? null,
      'aria-busy': opts.loading ? 'true' : null,
    },
    h('span', { class: 'r-btn__sheen', 'aria-hidden': 'true' }),
    h('span', { class: 'r-btn__glow', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'r-btn__inner' },
      opts.icon ? h('span', { class: 'r-btn__ic' }, opts.icon) : null,
      h('span', { class: 'r-btn__col' }, labelEl, subEl, opts.children ?? null),
      opts.iconRight ? h('span', { class: 'r-btn__ic r-btn__ic--r' }, opts.iconRight) : null,
    ),
    h(
      'span',
      { class: 'r-btn__spin', 'aria-hidden': 'true' },
      h('svg', { attrs: { viewBox: '0 0 24 24', width: 20, height: 20 } },
        h('circle', { attrs: { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, opacity: 0.22 } }),
        h('path', { attrs: { d: 'M21 12a9 9 0 00-9-9', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round' } }),
      ),
    ),
  ) as ButtonEl;

  pressFeedback(el);
  if (opts.loading) el.classList.add('is-loading');

  let busy = false;
  el.addEventListener('click', (ev) => {
    if (el.disabled || busy) return;
    if (opts.haptic !== null) haptic(opts.haptic ?? (variant === 'primary' ? 'select' : 'tick'));
    el.classList.remove('is-flare');
    void el.offsetWidth;
    el.classList.add('is-flare');
    const out = opts.onTap?.(ev);
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      busy = true;
      el.setLoading(true);
      void (out as Promise<unknown>).finally(() => {
        busy = false;
        el.setLoading(false);
      });
    }
  });
  el.addEventListener('animationend', (ev) => {
    if ((ev as AnimationEvent).animationName.indexOf('btnFlare') === 0) el.classList.remove('is-flare');
  });

  el.setLoading = (on) => {
    el.classList.toggle('is-loading', on);
    if (on) el.setAttribute('aria-busy', 'true');
    else el.removeAttribute('aria-busy');
  };
  el.setDisabled = (on) => {
    el.disabled = on;
  };
  el.setLabel = (text) => {
    labelEl.textContent = text;
  };
  el.setSub = (text) => {
    if (subEl) subEl.textContent = text;
  };
  return el;
}

/** Circular icon-only button — used for the top bar `+`, close affordances. */
export interface IconButtonOpts {
  icon: Node;
  ariaLabel: string;
  variant?: ButtonVariant;
  size?: number;
  class?: ClassValue;
  haptic?: HapticPattern | null;
  onTap?: (ev: MouseEvent) => unknown;
}

export function IconButton(opts: IconButtonOpts): HTMLButtonElement {
  const el = h(
    'button',
    {
      class: cx('r-iconbtn', `r-iconbtn--${opts.variant ?? 'secondary'}`, opts.class),
      type: 'button',
      'aria-label': opts.ariaLabel,
      style: opts.size ? { '--ib-size': `${opts.size}px` } : undefined,
    },
    h('span', { class: 'r-iconbtn__sheen', 'aria-hidden': 'true' }),
    h('span', { class: 'r-iconbtn__ic' }, opts.icon),
  );
  pressFeedback(el);
  el.addEventListener('click', (ev) => {
    if (opts.haptic !== null) haptic(opts.haptic ?? 'tick');
    opts.onTap?.(ev);
  });
  return el;
}
