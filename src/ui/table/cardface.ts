/**
 * Miniature DOM card faces.
 *
 * The 3D stage owns the real cards; these are the small typographic stand-ins
 * used by the winner banner, the hand-history log and the replay scrubber,
 * where crisp text beats a projected quad. Four-colour deck, because red/black
 * is genuinely illegible at 22px on a phone.
 */

import { h, s } from './dom.ts';
import { cardRank, cardSuit, RANKS } from '../../core/types.ts';
import type { CardId } from '../../core/types.ts';

const SUIT_CLASS = ['c', 'd', 'h', 's'] as const;

function pip(suit: number, size: number): SVGElement {
  const v = (d: string): SVGElement =>
    s(
      'svg',
      { viewBox: '0 0 24 24', width: String(size), height: String(size), 'aria-hidden': 'true' },
      s('path', { d, fill: 'currentColor' }),
    );
  switch (suit) {
    case 0: // clubs
      return v(
        'M12 2.6a4.3 4.3 0 0 0-3.1 7.3 4.4 4.4 0 1 0-2.2 8.2c1.6 0 3-.9 3.8-2.2.1 2.1-.7 4.1-2.1 5.5h7.2c-1.4-1.4-2.2-3.4-2.1-5.5a4.4 4.4 0 1 0 1.6-6 4.3 4.3 0 0 0-3.1-7.3z',
      );
    case 1: // diamonds
      return v('M12 1.8L21.4 12 12 22.2 2.6 12z');
    case 2: // hearts
      return v(
        'M12 21.6S2.4 15.3 2.4 9.1C2.4 5.7 5 3.2 8.1 3.2c2 0 3.3 1 3.9 2.1.6-1.1 1.9-2.1 3.9-2.1 3.1 0 5.7 2.5 5.7 5.9 0 6.2-9.6 12.5-9.6 12.5z',
      );
    default: // spades
      return v(
        'M12 2.2C9.3 5.4 2.8 8.9 2.8 13.6a4.6 4.6 0 0 0 7.7 3.4c-.1 2-.9 3.7-2.2 4.8h7.4c-1.3-1.1-2.1-2.8-2.2-4.8a4.6 4.6 0 0 0 7.7-3.4c0-4.7-6.5-8.2-9.2-11.4z',
      );
  }
}

export type CardSize = 'xs' | 'sm' | 'md';

/** A single face-up card. `dim` greys it out (board card not used in the hand). */
export function cardFace(card: CardId, size: CardSize = 'sm', dim = false): HTMLElement {
  const suit = cardSuit(card);
  const rank = RANKS[cardRank(card) - 2];
  const pipSize = size === 'xs' ? 9 : size === 'sm' ? 12 : 17;
  return h(
    'div',
    { class: `mcard mcard--${size} mcard--${SUIT_CLASS[suit]}${dim ? ' is-dim' : ''}` },
    h('span', { class: 'mcard__r tnum' }, rank),
    h('span', { class: 'mcard__p' }, pip(suit, pipSize)),
  );
}

/** A face-down card — used for mucked holdings in the history log. */
export function cardBack(size: CardSize = 'sm'): HTMLElement {
  return h('div', { class: `mcard mcard--${size} mcard--back` }, h('i', { class: 'mcard__weave' }));
}

/** A row of cards, optionally marking which ids are part of the winning five. */
export function cardRow(cards: readonly CardId[], size: CardSize = 'sm', highlight?: readonly CardId[]): HTMLElement {
  const set = highlight ? new Set(highlight) : null;
  return h(
    'div',
    { class: 'mcard-row' },
    cards.map((c) => cardFace(c, size, set ? !set.has(c) : false)),
  );
}

export function cardText(cards: readonly CardId[]): string {
  return cards.map((c) => `${RANKS[cardRank(c) - 2]}${['♣', '♦', '♥', '♠'][cardSuit(c)]}`).join(' ');
}
