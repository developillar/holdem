/**
 * ROYALE — ui/feed/minicards.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The miniature playing cards. These appear on every post, in every replay,
 * in every share sheet — so they get the same attention a real product gives
 * its most-repeated element: warm ivory stock rather than paper white, a
 * hairline that is brighter along the top edge, an inset highlight, a
 * two-layer contact shadow, and a large watermark pip that keeps the suit
 * legible at 30px.
 *
 *   MiniCard(card, { size: 34 })
 *   MiniHand([ah, kh], { size: 36, fan: true })
 *   MiniBoard(board, { size: 32, highlight: winningFive })
 *   HandSnapshot(replay, seat)          ← the centrepiece of a post card
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { CardId, HandReplay } from '../../core/types.ts';
import { cardRank, cardSuit, RANKS } from '../../core/types.ts';
import { cash } from './util.ts';
import { suitPip } from './glyphs.ts';

export interface MiniCardOpts {
  /** card width in px; height follows the 1:1.4 poker ratio */
  size?: number;
  /** render the back instead of the face */
  down?: boolean;
  /** gold ring — used for the five cards that make the winning hand */
  win?: boolean;
  /** desaturate — used for board cards not yet dealt in a replay */
  ghost?: boolean;
  class?: ClassValue;
  /** entrance delay for the deal animation, in ms */
  delay?: number;
}

const RANK_TEXT = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function rankLabel(card: CardId): string {
  return RANK_TEXT[cardRank(card) - 2];
}

/** One card. Pass `null` with `down` for an unknown holding. */
export function MiniCard(card: CardId | null, opts: MiniCardOpts = {}): HTMLElement {
  const size = opts.size ?? 32;
  const down = opts.down || card === null;
  const style: Record<string, string> = { '--mc-w': `${size}px` };
  if (opts.delay) style['--mc-delay'] = `${opts.delay}ms`;

  if (down) {
    return h(
      'span',
      {
        class: cx('mc', 'mc--down', opts.ghost && 'is-ghost', opts.class),
        style,
        'aria-label': 'Hidden card',
      },
      h('span', { class: 'mc__back', 'aria-hidden': 'true' }, h('span', { class: 'mc__lattice' })),
    );
  }

  const c = card as CardId;
  const suit = cardSuit(c);
  const label = `${RANKS[cardRank(c) - 2]}${['clubs', 'diamonds', 'hearts', 'spades'][suit]}`;

  return h(
    'span',
    {
      class: cx('mc', `mc--s${suit}`, opts.win && 'is-win', opts.ghost && 'is-ghost', opts.class),
      style,
      role: 'img',
      'aria-label': label,
    },
    h(
      'span',
      { class: 'mc__face', 'aria-hidden': 'true' },
      h(
        'span',
        { class: 'mc__corner' },
        h('span', { class: cx('mc__rank', rankLabel(c).length > 1 && 'is-wide') }, rankLabel(c)),
        h('span', { class: 'mc__cpip' }, suitPip(suit, Math.round(size * 0.27))),
      ),
      // A watermark, not a second pip. At 0.62 it matched the corner pip's
      // optical weight on a 90px card and read as a duplicated element.
      h('span', { class: 'mc__ghostpip' }, suitPip(suit, Math.round(size * 0.42))),
      h('span', { class: 'mc__gloss' }),
    ),
  );
}

export interface MiniHandOpts extends Omit<MiniCardOpts, 'delay'> {
  /** splay the cards like a held hand */
  fan?: boolean;
  /** cards that belong to the winning five */
  highlight?: readonly CardId[];
  /** how many are face-down (from the right) */
  hidden?: number;
  label?: string;
}

/** A player's hole cards. Two for hold'em, four for Omaha. */
export function MiniHand(cards: readonly CardId[], opts: MiniHandOpts = {}): HTMLElement {
  const size = opts.size ?? 34;
  const hi = opts.highlight ?? [];
  const kids = cards.map((c, i) =>
    MiniCard(c, {
      size,
      win: hi.includes(c),
      class: opts.fan ? `mc--fan-${Math.min(3, i)}` : null,
      delay: i * 45,
    }),
  );
  return h(
    'span',
    { class: cx('mcrow', 'mcrow--hole', opts.fan && 'is-fan', cards.length > 2 && 'is-quad', opts.class) },
    ...kids,
  );
}

export interface MiniBoardOpts extends MiniCardOpts {
  highlight?: readonly CardId[];
  /** total slots to render; missing ones render as ghost placeholders */
  slots?: number;
}

/** The community cards, grouped flop / turn / river with optical gaps. */
export function MiniBoard(cards: readonly CardId[], opts: MiniBoardOpts = {}): HTMLElement {
  const size = opts.size ?? 30;
  const slots = opts.slots ?? Math.max(cards.length, 5);
  const hi = opts.highlight ?? [];
  const kids: HTMLElement[] = [];
  for (let i = 0; i < slots; i++) {
    const c = cards[i];
    if (c === undefined) {
      kids.push(
        h('span', {
          class: cx('mc', 'mc--slot', i === 3 && 'is-gap', i === 4 && 'is-gap'),
          style: { '--mc-w': `${size}px` },
          'aria-hidden': 'true',
        }),
      );
    } else {
      kids.push(
        MiniCard(c, {
          size,
          win: hi.includes(c),
          delay: i * 40,
          class: cx(i === 3 && 'is-gap', i === 4 && 'is-gap'),
        }),
      );
    }
  }
  return h('span', { class: cx('mcrow', 'mcrow--board', opts.class) }, ...kids);
}

// ───────────────────────────── snapshot ─────────────────────────────

export interface SnapshotOpts {
  /** whose hole cards to feature; defaults to the first revealed seat */
  seat?: number;
  /** compact variant used inside the share sheet */
  dense?: boolean;
  class?: ClassValue;
}

function seatOf(replay: HandReplay, seat: number | undefined): HandReplay['seats'][number] | null {
  if (seat !== undefined) {
    const exact = replay.seats.find((s) => s.seat === seat);
    if (exact && exact.holeCards && exact.holeCards.length) return exact;
  }
  const winner = replay.results.slice().sort((a, b) => b.won - a.won)[0];
  if (winner) {
    const row = replay.seats.find((s) => s.seat === winner.seat);
    if (row && row.holeCards && row.holeCards.length) return row;
  }
  return replay.seats.find((s) => s.holeCards && s.holeCards.length) ?? null;
}

/**
 * The hero element of a post: hole cards, the board, the pot and the hand
 * label, laid out so the eye lands on the cards first and the money second.
 */
export function HandSnapshot(replay: HandReplay, opts: SnapshotOpts = {}): HTMLElement {
  const row = seatOf(replay, opts.seat);
  const hole = row?.holeCards ?? [];
  const result = row ? replay.results.find((r) => r.seat === row.seat) ?? null : null;
  const winning = result?.rank?.best ?? [];
  const dense = !!opts.dense;

  const omaha = replay.variant === 'plo4';
  // The hole cards stay the larger pair — they are the hero — but the gap is
  // kept small so the two rows share a top edge to within a couple of px once
  // the grid below puts them on the same row.
  const holeSize = dense ? 26 : omaha ? 28 : 34;
  const boardSize = dense ? 25 : omaha ? 26 : 32;

  const wentToShowdown = replay.results.filter((r) => r.rank).length >= 2;
  const winner = replay.results.slice().sort((a, b) => b.won - a.won)[0] ?? null;
  const handLabel = result?.rank?.label ?? (wentToShowdown ? null : 'Won without showdown');
  // The gold "winning five" ring would lie on a bad-beat post, where the
  // featured player is the one who lost. Cool ring, red label, no confusion.
  const lost = !!result && result.won <= 0 && wentToShowdown;

  return h(
    'div',
    { class: cx('hsnap', dense && 'is-dense', lost && 'is-lost', opts.class) },
    h('span', { class: 'hsnap__grain', 'aria-hidden': 'true' }),
    // One grid, not two stacked columns. HOLE and BOARD are peer labels, so
    // they occupy the same grid row and share a baseline; the two card rows
    // occupy the second row and share a top edge. Stacking them as separate
    // flex columns made both alignments drift with the card-size difference —
    // the one visible layout break on the card.
    h(
      'div',
      { class: 'hsnap__cards' },
      h('span', { class: 'hsnap__cap hsnap__cap--hole caps' }, hole.length > 2 ? 'Hand' : 'Hole'),
      h('span', { class: 'hsnap__div', 'aria-hidden': 'true' }),
      h('span', { class: 'hsnap__cap hsnap__cap--board caps' }, 'Board'),
      hole.length
        ? MiniHand(hole, {
            size: holeSize,
            fan: !omaha,
            highlight: winning,
            class: 'hsnap__row hsnap__row--hole',
          })
        : h(
            'span',
            { class: 'mcrow mcrow--hole hsnap__row hsnap__row--hole' },
            MiniCard(null, { size: holeSize, down: true }),
            MiniCard(null, { size: holeSize, down: true }),
          ),
      MiniBoard(replay.board, {
        size: boardSize,
        highlight: winning,
        class: 'hsnap__row hsnap__row--board',
      }),
    ),
    h(
      'div',
      { class: 'hsnap__meta' },
      h(
        'div',
        { class: 'hsnap__pot' },
        h('span', { class: 'hsnap__cap caps' }, 'Pot'),
        h('span', { class: 'hsnap__potv tnum' }, cash(replay.potTotal)),
      ),
      handLabel
        ? h(
            'div',
            { class: cx('hsnap__hand', winner && winner.seat === row?.seat && 'is-won') },
            h('span', { class: 'hsnap__handt' }, handLabel),
            lost && winner?.rank
              ? h('span', { class: 'hsnap__beat' }, `beaten by ${winner.rank.label}`)
              : null,
          )
        : null,
    ),
  );
}

/** Compact inline card row for comments and toasts ("A♠ K♠"). */
export function InlineCards(cards: readonly CardId[], size = 18): HTMLElement {
  return h(
    'span',
    { class: 'mcrow mcrow--inline' },
    ...cards.map((c) => MiniCard(c, { size })),
  );
}
