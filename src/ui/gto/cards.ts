/**
 * ROYALE — ui/gto/cards.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Mini card faces for the trainer. These are not the 3D deck — they are DOM,
 * so the rank stays razor sharp at 13px on a retina phone.
 *
 * The face is built from four layers, which is what stops it reading as a
 * rectangle with a letter on it: a warm paper gradient with a lifted top edge,
 * a hairline inset border, a corner index over a bottom-right pip, and a
 * specular sweep across the top-left corner. Suits use the four-colour deck
 * from tokens.css because red/black is illegible at this size.
 *
 *   Card(cardId)                    → 34×48 face
 *   Card(cardId, { size: 'lg' })    → 46×64, for your own hand
 *   CardRow([c1, c2])               → overlapping pair
 *   BoardRow(board)                 → flop/turn/river with the burn gap
 *   CardBack()                      → face-down
 */

import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { CardId } from '../../core/types.ts';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_KEY = ['c', 'd', 'h', 's'] as const;

export type CardSize = 'xs' | 'sm' | 'md' | 'lg';

/** Suit pip, drawn on a 24×24 grid so every suit has the same optical mass. */
export function suitGlyph(suit: number, size = 14): SVGSVGElement {
  const svg = h('svg', {
    class: 'tg-suit',
    attrs: { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
  });
  const fill = 'currentColor';
  if (suit === 3) {
    svg.appendChild(h('path', {
      attrs: {
        fill,
        d: 'M12 2.6c3.35 3.7 7.35 6 7.35 9.85a3.95 3.95 0 01-6.6 2.95c.2 2.15.85 3.7 1.85 4.6H9.4c1-.9 1.65-2.45 1.85-4.6a3.95 3.95 0 01-6.6-2.95C4.65 8.6 8.65 6.3 12 2.6z',
      },
    }));
  } else if (suit === 2) {
    svg.appendChild(h('path', {
      attrs: {
        fill,
        d: 'M12 21.1S3.1 15.3 3.1 9.35A4.85 4.85 0 0112 6.6a4.85 4.85 0 018.9 2.75c0 5.95-8.9 11.75-8.9 11.75z',
      },
    }));
  } else if (suit === 1) {
    svg.appendChild(h('path', { attrs: { fill, d: 'M12 2.2l7.1 9.8-7.1 9.8-7.1-9.8L12 2.2z' } }));
  } else {
    const g = h('g', { attrs: { fill } });
    g.appendChild(h('circle', { attrs: { cx: 12, cy: 7.3, r: 3.55 } }));
    g.appendChild(h('circle', { attrs: { cx: 7.5, cy: 13.6, r: 3.55 } }));
    g.appendChild(h('circle', { attrs: { cx: 16.5, cy: 13.6, r: 3.55 } }));
    g.appendChild(h('path', { attrs: { d: 'M12 12.4c.35 3.6 1.2 6.4 2.6 7.9H9.4c1.4-1.5 2.25-4.3 2.6-7.9z' } }));
    svg.appendChild(g);
  }
  return svg;
}

export interface CardOpts {
  size?: CardSize;
  class?: ClassValue;
  /** dims the card — used for board cards that are not yet dealt */
  ghost?: boolean;
  /** entry animation delay index */
  index?: number;
}

export function cardText(card: CardId): string {
  return RANKS[card >> 2] + SUIT_KEY[card & 3];
}

export function Card(card: CardId, opts: CardOpts = {}): HTMLElement {
  const rank = RANKS[card >> 2];
  const suit = card & 3;
  const el = h(
    'div',
    {
      class: cx('tg-card', `tg-card--${opts.size ?? 'md'}`, `tg-card--${SUIT_KEY[suit]}`, opts.ghost && 'is-ghost', opts.class),
      style: opts.index !== undefined ? { '--i': String(opts.index) } : undefined,
      role: 'img',
      'aria-label': `${rank} of ${['clubs', 'diamonds', 'hearts', 'spades'][suit]}`,
    },
    h('span', { class: 'tg-card__face', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'tg-card__idx', 'aria-hidden': 'true' },
      h('span', { class: cx('tg-card__rank', rank === '10' && 'is-ten') }, rank),
      suitGlyph(suit, 12),
    ),
    h('span', { class: 'tg-card__pip', 'aria-hidden': 'true' }, suitGlyph(suit, 20)),
    h('span', { class: 'tg-card__gloss', 'aria-hidden': 'true' }),
  );
  return el;
}

export function CardBack(opts: CardOpts = {}): HTMLElement {
  return h(
    'div',
    { class: cx('tg-card', 'tg-card--back', `tg-card--${opts.size ?? 'md'}`, opts.class), 'aria-hidden': 'true' },
    h('span', { class: 'tg-card__weave' }),
    h('span', { class: 'tg-card__crest' }, suitGlyph(3, 18)),
  );
}

/** Your hole cards, fanned with a slight rotation. */
export function CardRow(cards: readonly CardId[], opts: CardOpts = {}): HTMLElement {
  const row = h('div', { class: cx('tg-hand', `tg-hand--${opts.size ?? 'lg'}`, opts.class) });
  const n = cards.length;
  cards.forEach((c, i) => {
    const spread = n <= 2 ? 3.5 : 2.2;
    const mid = (n - 1) / 2;
    const el = Card(c, { size: opts.size ?? 'lg', index: i });
    el.style.setProperty('--rot', `${(i - mid) * spread}deg`);
    el.style.setProperty('--lift', `${Math.abs(i - mid) * 1.5}px`);
    row.appendChild(el);
  });
  return row;
}

/** The board, with the gap between flop, turn and river that dealers leave. */
export function BoardRow(board: readonly CardId[], opts: { size?: CardSize; slots?: number } = {}): HTMLElement {
  const size = opts.size ?? 'sm';
  const slots = opts.slots ?? board.length;
  const row = h('div', { class: 'tg-board' });
  for (let i = 0; i < Math.max(slots, board.length); i++) {
    const wrap = h('div', {
      class: cx('tg-board__slot', i === 3 && 'is-turn', i === 4 && 'is-river'),
      style: { '--i': String(i) },
    });
    if (i < board.length) wrap.appendChild(Card(board[i], { size, index: i }));
    else wrap.appendChild(h('span', { class: 'tg-board__empty', 'aria-hidden': 'true' }));
    row.appendChild(wrap);
  }
  return row;
}

/** "A♠ K♦" as plain text with coloured suits — for inline prose. */
export function cardsInline(cards: readonly CardId[]): HTMLElement {
  const el = h('span', { class: 'tg-inline' });
  for (const c of cards) {
    el.appendChild(
      h(
        'span',
        { class: cx('tg-inline__c', `tg-inline__c--${SUIT_KEY[c & 3]}`) },
        RANKS[c >> 2],
        suitGlyph(c & 3, 11),
      ),
    );
  }
  return el;
}
