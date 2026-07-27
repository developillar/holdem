/**
 * ROYALE — components/pill.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Chips / pills / tags. One component, three densities, tinted either by a
 * semantic tone or by a `Rarity` from core/types. Every pill carries an inner
 * top highlight and a tinted hairline so it reads as a physical token rather
 * than a coloured rectangle.
 *
 *   Pill({ text: '$0.50/$1', tone: 'neutral' })
 *   Pill({ text: 'LEGENDARY', rarity: 'legendary', size: 'xs', caps: true })
 *   Pill({ text: '+2.4bb', tone: 'good', icon: icon('trend-up', { size: 13 }) })
 *   Pill({ text: 'Bomb pot', tone: 'gold', glow: true })
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { Rarity } from '../../core/types.ts';

export type PillTone = 'neutral' | 'gold' | 'good' | 'bad' | 'info' | 'epic' | 'dim';
export type PillSize = 'xs' | 'sm' | 'md';

export interface PillOpts {
  text: string;
  tone?: PillTone;
  /** overrides `tone` with the rarity ramp */
  rarity?: Rarity | null;
  size?: PillSize;
  icon?: Node;
  caps?: boolean;
  /** tabular numerals — use for any pill containing money */
  numeric?: boolean;
  /** soft outer bloom in the tint colour */
  glow?: boolean;
  /** hollow outline instead of a filled token */
  outline?: boolean;
  class?: ClassValue;
  title?: string;
}

export interface PillEl extends HTMLSpanElement {
  setText(text: string): void;
}

export function Pill(opts: PillOpts): PillEl {
  const textEl = h('span', { class: 'r-pill__t' }, opts.text);
  const el = h(
    'span',
    {
      class: cx(
        'r-pill',
        `r-pill--${opts.size ?? 'sm'}`,
        opts.rarity ? `r-pill--rar-${opts.rarity}` : `r-pill--${opts.tone ?? 'neutral'}`,
        opts.caps && 'caps',
        opts.numeric && 'tnum',
        opts.glow && 'is-glow',
        opts.outline && 'is-outline',
        opts.class,
      ),
      title: opts.title ?? null,
    },
    opts.icon ? h('span', { class: 'r-pill__ic' }, opts.icon) : null,
    textEl,
  ) as PillEl;
  el.setText = (text) => {
    textEl.textContent = text;
  };
  return el;
}

/** Uppercase rarity tag — store cards, drop reveals, pass rewards. */
export function RarityTag(rarity: Rarity, opts: { size?: PillSize; class?: ClassValue } = {}): PillEl {
  return Pill({
    text: rarity,
    rarity,
    caps: true,
    size: opts.size ?? 'xs',
    class: cx('r-pill--rartag', opts.class),
  });
}
