/**
 * ROYALE — components/surface.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The elevated glass panel every screen is built from. Getting the material
 * right here is what makes the whole app read as one object: a two-stop
 * vertical gradient, a hairline that is brighter along the top edge than the
 * bottom (light comes from above), an inset top highlight, and a two-layer
 * cool shadow. Nothing here is a plain 1px grey border.
 *
 *   Surface({ pad: 'md' }, h('h2', null, 'Tonight'))
 *   Surface({ tone: 'gold', shine: true }, …)   // slow specular sweep
 *   Surface({ tone: 'sunken', pad: 'sm' }, …)   // recessed well
 *   Surface({ as: 'button', onTap, interactive: true }, …)
 *
 * `elevation` 0–3 maps onto the token shadow ramp.
 */
import { h, cx } from '../dom.ts';
import type { Child, ClassValue } from '../dom.ts';
import { pressFeedback } from './util.ts';

export type SurfaceTone = 'default' | 'raised' | 'sunken' | 'gold' | 'plain';
export type SurfacePad = 'none' | 'xs' | 'sm' | 'md' | 'lg';

export interface SurfaceOpts {
  tone?: SurfaceTone;
  pad?: SurfacePad;
  /** 0 flat · 1 resting · 2 lifted · 3 floating */
  elevation?: 0 | 1 | 2 | 3;
  radius?: 'sm' | 'md' | 'lg' | 'xl';
  /** adds a slow moving specular highlight across the surface */
  shine?: boolean;
  /** press feedback + pointer cursor */
  interactive?: boolean;
  as?: 'div' | 'section' | 'article' | 'button' | 'li';
  class?: ClassValue;
  ariaLabel?: string;
  onTap?: (ev: MouseEvent) => unknown;
}

export function Surface(opts: SurfaceOpts = {}, ...children: Child[]): HTMLElement {
  const tag = opts.as ?? (opts.onTap ? 'button' : 'div');
  const el = h(
    tag,
    {
      class: cx(
        'r-surf',
        `r-surf--${opts.tone ?? 'default'}`,
        `r-surf--pad-${opts.pad ?? 'md'}`,
        `r-surf--e${opts.elevation ?? 1}`,
        opts.radius && `r-surf--r-${opts.radius}`,
        (opts.interactive || opts.onTap) && 'is-interactive',
        opts.class,
      ),
      type: tag === 'button' ? 'button' : null,
      'aria-label': opts.ariaLabel ?? null,
    },
    h('span', { class: 'r-surf__edge', 'aria-hidden': 'true' }),
    opts.shine ? h('span', { class: 'r-surf__shine', 'aria-hidden': 'true' }) : null,
    h('span', { class: 'r-surf__body' }, ...children),
  );
  if (opts.interactive || opts.onTap) pressFeedback(el);
  const tap = opts.onTap;
  if (tap) el.addEventListener('click', (ev) => tap(ev as MouseEvent));
  return el;
}

/**
 * Section header used above a Surface or a list. Small caps eyebrow on the
 * left, optional action on the right — the rhythm that keeps screens legible.
 */
export interface SectionHeaderOpts {
  title: string;
  /** uppercase micro line above the title */
  eyebrow?: string;
  action?: Node;
  class?: ClassValue;
}

export function SectionHeader(opts: SectionHeaderOpts): HTMLElement {
  return h(
    'div',
    { class: cx('r-sechead', opts.class) },
    h(
      'div',
      { class: 'r-sechead__text' },
      opts.eyebrow ? h('div', { class: 'r-sechead__eyebrow caps' }, opts.eyebrow) : null,
      h('h2', { class: 'r-sechead__title' }, opts.title),
    ),
    opts.action ? h('div', { class: 'r-sechead__action' }, opts.action) : null,
  );
}
