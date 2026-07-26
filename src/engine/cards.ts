/**
 * Deck construction, shuffling and dealing.
 *
 * Cards are the integer encoding from `core/types.ts`: `(rank - 2) * 4 + suit`,
 * so a card is always a plain number and every hot path in the evaluator can
 * stay allocation-free. Nothing here formats for the UI beyond the canonical
 * two-character notation ("As", "Td") and the English words the hand labels
 * are built from.
 */
import type { CardId, Rank, Suit } from '../core/types.ts';
import { RANKS, SUITS, cardRank, cardSuit, cardName, parseCard } from '../core/types.ts';
import type { Rng } from '../core/rng.ts';

export const DECK_SIZE = 52;

/** Singular English rank words, indexed by `rank - 2`. */
export const RANK_WORDS = [
  'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace',
] as const;

/** Plural rank words for labels like "Kings full of Sevens". */
export const RANK_WORDS_PLURAL = [
  'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
] as const;

export const SUIT_WORDS = ['Clubs', 'Diamonds', 'Hearts', 'Spades'] as const;
export const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'] as const;

/** "Ace", "Ten", … for a rank 2..14. */
export function rankWord(rank: number): string {
  return RANK_WORDS[rank - 2] ?? String(rank);
}
/** "Aces", "Tens", … for a rank 2..14. */
export function rankWordPlural(rank: number): string {
  return RANK_WORDS_PLURAL[rank - 2] ?? String(rank);
}
/** "A", "T", "7" — the single-character rank used in compact chips. */
export function rankChar(rank: number): string {
  return RANKS[rank - 2] ?? '?';
}
export function suitGlyph(suit: number): string {
  return SUIT_GLYPHS[suit] ?? '?';
}
/** Suit colour bucket for two-colour and four-colour deck skins. */
export function suitIsRed(suit: number): boolean {
  return suit === 1 || suit === 2;
}

// ─────────────────────────── conversion ───────────────────────────

/** "Ah" for the ace of hearts. Mirrors `core/types.cardName`. */
export function cardToString(c: CardId): string {
  return cardName(c);
}

/** Parses "Ah" / "ah" / "AH" into a CardId. Throws on garbage. */
export function cardFromString(s: string): CardId {
  return parseCard(s.trim());
}

/**
 * Parses a run of cards from any of the shapes humans and fixtures write:
 * "AhKs", "Ah Ks", "Ah,Ks", "ah-ks". Whitespace and separators are optional.
 */
export function parseCards(s: string): CardId[] {
  const compact = s.replace(/[^A-Za-z0-9]/g, '');
  if (compact.length % 2 !== 0) throw new Error(`bad card list: ${s}`);
  const out: CardId[] = [];
  for (let i = 0; i < compact.length; i += 2) out.push(parseCard(compact.slice(i, i + 2)));
  return out;
}

/** "Ah Ks Qd" — the canonical space-separated form used in hand histories. */
export function cardsToString(cards: readonly CardId[]): string {
  let s = '';
  for (let i = 0; i < cards.length; i++) s += (i ? ' ' : '') + cardName(cards[i]);
  return s;
}

/** Descending by rank, then by suit — a stable display order for hole cards. */
export function sortCardsDesc(cards: CardId[]): CardId[] {
  return cards.sort((a, b) => b - a);
}

/** True when the two lists share no card. Cheap guard for scripted deals. */
export function disjoint(a: readonly CardId[], b: readonly CardId[]): boolean {
  for (const c of a) if (b.includes(c)) return false;
  return true;
}

// ─────────────────────────── the deck ───────────────────────────

/** A fresh, ordered 52-card deck: 2c 2d 2h 2s 3c … As. */
export function makeDeck(): CardId[] {
  const d: CardId[] = new Array(DECK_SIZE);
  for (let i = 0; i < DECK_SIZE; i++) d[i] = i;
  return d;
}

/** A fresh deck shuffled with the supplied generator (Fisher-Yates). */
export function shuffledDeck(rng: Rng): CardId[] {
  return rng.shuffle(makeDeck());
}

/**
 * A dealing shoe. Cards come off the top; burns are tracked separately so a
 * hand history can reproduce the exact physical deal, and `remove()` lets a
 * scripted fixture pin specific cards without disturbing the rest of the deck.
 */
export class Deck {
  private cards: CardId[];
  private pos = 0;
  readonly burned: CardId[] = [];

  constructor(cards: CardId[]) {
    this.cards = cards;
  }

  /** A shuffled 52-card shoe. */
  static shuffled(rng: Rng): Deck {
    return new Deck(shuffledDeck(rng));
  }

  /** A shoe that deals exactly these cards, in this order. For fixtures. */
  static stacked(cards: readonly CardId[] | string): Deck {
    return new Deck(typeof cards === 'string' ? parseCards(cards) : cards.slice());
  }

  get remaining(): number {
    return this.cards.length - this.pos;
  }

  /** Cards already dealt or burned, in deal order. */
  get dealt(): CardId[] {
    return this.cards.slice(0, this.pos);
  }

  draw(): CardId {
    if (this.pos >= this.cards.length) throw new Error('deck exhausted');
    return this.cards[this.pos++];
  }

  drawMany(n: number): CardId[] {
    const out: CardId[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.draw();
    return out;
  }

  /** Burns the top card face-down, exactly as a live dealer does. */
  burn(): CardId {
    const c = this.draw();
    this.burned.push(c);
    return c;
  }

  /** Burn one, then deal `n` — the flop / turn / river ritual. */
  burnAndDeal(n: number): CardId[] {
    this.burn();
    return this.drawMany(n);
  }

  /**
   * Pulls specific cards out of the undealt remainder and returns them, so a
   * scripted hand can force a board while everything else stays random.
   * Throws if a card has already been dealt.
   */
  remove(cards: readonly CardId[]): CardId[] {
    for (const c of cards) {
      const at = this.cards.indexOf(c, this.pos);
      if (at < 0) throw new Error(`card ${cardName(c)} is not available in the deck`);
      this.cards[at] = this.cards[this.pos];
      this.cards[this.pos] = c;
      this.pos++;
    }
    return cards.slice();
  }

  /** True when every listed card is still undealt. */
  has(cards: readonly CardId[]): boolean {
    for (const c of cards) if (this.cards.indexOf(c, this.pos) < 0) return false;
    return true;
  }
}

/**
 * Deals hole cards the way a live dealer does: one card at a time, clockwise,
 * starting with the first seat left of the button. The order matters — the
 * renderer replays it card-by-card for the deal animation.
 *
 * Returns a map of seat -> cards plus the flat deal order for the animation.
 */
export function dealHoleCards(
  deck: Deck,
  seatsInOrder: readonly number[],
  perSeat: number,
): { hole: Map<number, CardId[]>; order: Array<{ seat: number; card: CardId; index: number }> } {
  const hole = new Map<number, CardId[]>();
  for (const s of seatsInOrder) hole.set(s, []);
  const order: Array<{ seat: number; card: CardId; index: number }> = [];
  let index = 0;
  for (let round = 0; round < perSeat; round++) {
    for (const s of seatsInOrder) {
      const card = deck.draw();
      hole.get(s)!.push(card);
      order.push({ seat: s, card, index: index++ });
    }
  }
  return { hole, order };
}

/** Number of hole cards each variant deals. */
export function holeCardCount(variant: 'nlhe' | 'plo4'): number {
  return variant === 'plo4' ? 4 : 2;
}

export { cardRank, cardSuit, cardName };
export type { CardId, Rank, Suit };
