/**
 * ROYALE — components/toggle.ts
 * ────────────────────────────────────────────────────────────────────────────
 * iOS-weight switch. Included in the library so every settings row in the app
 * uses the same knob, the same travel and the same gold "on" state — a
 * hand-rolled checkbox anywhere would break cohesion instantly.
 *
 *   ListRow({ title: 'Haptics', trailing: Toggle({ on: true, onChange: setHaptics }) })
 *   const t = Toggle({ on: false, ariaLabel: 'Four-colour deck' });
 *   t.setOn(true, true);   // second arg = silent
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { haptic } from './util.ts';

export interface ToggleOpts {
  on?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  /** 'gold' (default) or 'good' */
  tone?: 'gold' | 'good';
  class?: ClassValue;
  onChange?: (on: boolean) => void;
}

export interface ToggleEl extends HTMLButtonElement {
  setOn(on: boolean, silent?: boolean): void;
  isOn(): boolean;
}

export function Toggle(opts: ToggleOpts = {}): ToggleEl {
  let on = !!opts.on;
  const el = h(
    'button',
    {
      class: cx('r-tog', `r-tog--${opts.tone ?? 'gold'}`, opts.class),
      type: 'button',
      role: 'switch',
      'aria-checked': on ? 'true' : 'false',
      'aria-label': opts.ariaLabel ?? null,
      disabled: !!opts.disabled,
    },
    h('span', { class: 'r-tog__track', 'aria-hidden': 'true' }),
    h('span', { class: 'r-tog__knob', 'aria-hidden': 'true' }),
  ) as ToggleEl;

  const paint = () => {
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  };

  el.addEventListener('click', () => {
    on = !on;
    paint();
    haptic(on ? 'select' : 'tick');
    opts.onChange?.(on);
  });
  el.addEventListener('pointerdown', () => el.classList.add('is-press'));
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) {
    el.addEventListener(t, () => el.classList.remove('is-press'));
  }

  el.setOn = (next, silent = true) => {
    if (next === on) return;
    on = next;
    paint();
    if (!silent) opts.onChange?.(on);
  };
  el.isOn = () => on;
  paint();
  return el;
}
