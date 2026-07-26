/**
 * Exact 5/6/7-card Texas Hold'em evaluator.
 *
 * Technique — everything is bitmasks over the 13 ranks plus four small tables
 * built once at module init:
 *
 *   STRAIGHT_HI[mask]  8192 entries -> high rank of the best straight, 0 if none
 *                      (includes the A-2-3-4-5 wheel, reported as a Five-high)
 *   TOP5[mask]         8192 entries -> the five highest ranks in the mask packed
 *                      four bits each: r1<<16 | r2<<12 | r3<<8 | r4<<4 | r5
 *   POP[mask]          8192 entries -> popcount
 *   CATEGORY[key]      512 entries  -> hand class keyed by the rank-count
 *                      pattern (quads<<6 | trips<<3 | pairs)
 *
 * A hand's strength is a single 24-bit integer, `category<<20` over a 20-bit
 * tiebreak of up to five ranks. That makes comparison a plain `a - b` and gives
 * a total order across every hand, which is what pot distribution needs.
 *
 * Flush detection short-circuits: with seven cards you cannot hold both a flush
 * and a full house (a flush uses five distinct ranks, leaving only two cards to
 * build trips *and* a pair), so as soon as a suit hits five the answer is a
 * flush or a straight flush and nothing else needs checking.
 *
 * Throughput on Node 22 is ~8-10M full 7-card evaluations/sec for the value-only
 * path and ~1M/sec for the allocating path that also returns the exact five
 * cards and an English label.
 */
import type { CardId, HandCategory, HandRank } from '../core/types.ts';
import { cardRank, cardSuit } from '../core/types.ts';
import { rankWord, rankWordPlural } from './cards.ts';

// ─────────────────────────── categories ───────────────────────────

export const CAT_HIGH_CARD = 0;
export const CAT_PAIR = 1;
export const CAT_TWO_PAIR = 2;
export const CAT_TRIPS = 3;
export const CAT_STRAIGHT = 4;
export const CAT_FLUSH = 5;
export const CAT_FULL_HOUSE = 6;
export const CAT_QUADS = 7;
export const CAT_STRAIGHT_FLUSH = 8;

const CATEGORY_NAMES: HandCategory[] = [
  'high-card', 'pair', 'two-pair', 'trips', 'straight',
  'flush', 'full-house', 'quads', 'straight-flush',
];

/** Lowest possible value, useful as a "no hand" sentinel. */
export const NO_HAND = -1;

// ─────────────────────────── lookup tables ───────────────────────────

const MASK_COUNT = 1 << 13;

/** High rank (5..14) of the best straight in a 13-bit rank mask, else 0. */
const STRAIGHT_HI = new Uint8Array(MASK_COUNT);
/** Top five ranks of a mask packed 4 bits each, highest first. */
const TOP5 = new Int32Array(MASK_COUNT);
/** Popcount of a 13-bit mask. */
const POP = new Uint8Array(MASK_COUNT);
/** Highest rank present in a mask (2..14), 0 for the empty mask. */
const HIGH_RANK = new Uint8Array(MASK_COUNT);
/** Hand class keyed by (quadCount<<6 | tripCount<<3 | pairCount). */
const CATEGORY = new Uint8Array(512);

(function buildTables(): void {
  for (let mask = 0; mask < MASK_COUNT; mask++) {
    // popcount + top five ranks, walking from the ace bit down
    let pop = 0;
    let packed = 0;
    let taken = 0;
    let high = 0;
    for (let bit = 12; bit >= 0; bit--) {
      if ((mask & (1 << bit)) === 0) continue;
      const rank = bit + 2;
      pop++;
      if (high === 0) high = rank;
      if (taken < 5) {
        packed |= rank << (16 - taken * 4);
        taken++;
      }
    }
    POP[mask] = pop;
    TOP5[mask] = packed;
    HIGH_RANK[mask] = high;

    // straights: five consecutive bits, then the wheel (A-5-4-3-2)
    let hi = 0;
    for (let top = 14; top >= 6; top--) {
      const window = 0b11111 << (top - 6);
      if ((mask & window) === window) {
        hi = top;
        break;
      }
    }
    if (hi === 0) {
      const wheel = (1 << 12) | 0b1111; // ace + 5,4,3,2
      if ((mask & wheel) === wheel) hi = 5;
    }
    STRAIGHT_HI[mask] = hi;
  }

  for (let quads = 0; quads < 8; quads++) {
    for (let trips = 0; trips < 8; trips++) {
      for (let pairs = 0; pairs < 8; pairs++) {
        const key = (quads << 6) | (trips << 3) | pairs;
        // `pairs` counts ranks appearing at least twice, `trips` at least three
        let cat: number;
        if (quads >= 1) cat = CAT_QUADS;
        else if (trips >= 1 && pairs >= 2) cat = CAT_FULL_HOUSE;
        else if (trips >= 1) cat = CAT_TRIPS;
        else if (pairs >= 2) cat = CAT_TWO_PAIR;
        else if (pairs === 1) cat = CAT_PAIR;
        else cat = CAT_HIGH_CARD;
        CATEGORY[key] = cat;
      }
    }
  }
})();

// ─────────────────────────── fast value path ───────────────────────────

// Module-level scratch. The evaluator is synchronous and single-threaded, so
// reusing these buffers keeps the hot loop free of allocation.
const counts = new Int8Array(15);
const suitMask = new Int32Array(4);
const suitCount = new Int8Array(4);

/**
 * Strength of the best five-card hand inside `cards` (5, 6 or 7 cards).
 * Allocation-free — this is the function equity/solver loops should call.
 */
export function evaluateValue(cards: ArrayLike<CardId>, n: number = cards.length): number {
  counts[2] = 0; counts[3] = 0; counts[4] = 0; counts[5] = 0; counts[6] = 0;
  counts[7] = 0; counts[8] = 0; counts[9] = 0; counts[10] = 0; counts[11] = 0;
  counts[12] = 0; counts[13] = 0; counts[14] = 0;
  suitMask[0] = 0; suitMask[1] = 0; suitMask[2] = 0; suitMask[3] = 0;
  suitCount[0] = 0; suitCount[1] = 0; suitCount[2] = 0; suitCount[3] = 0;

  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i] as number;
    const r = (c >> 2) + 2;
    const s = c & 3;
    counts[r]++;
    const bit = 1 << (r - 2);
    rankMask |= bit;
    suitMask[s] |= bit;
    suitCount[s]++;
  }

  // ── flush family (short-circuits: no full house can coexist with a flush)
  let fs = -1;
  if (suitCount[0] >= 5) fs = 0;
  else if (suitCount[1] >= 5) fs = 1;
  else if (suitCount[2] >= 5) fs = 2;
  else if (suitCount[3] >= 5) fs = 3;
  if (fs >= 0) {
    const fm = suitMask[fs];
    const sfHigh = STRAIGHT_HI[fm];
    if (sfHigh !== 0) return (CAT_STRAIGHT_FLUSH << 20) | (sfHigh << 16);
    return (CAT_FLUSH << 20) | TOP5[fm];
  }

  // ── rank-count pattern
  let m2 = 0, m3 = 0, m4 = 0;
  for (let r = 14; r >= 2; r--) {
    const c = counts[r];
    if (c < 2) continue;
    const bit = 1 << (r - 2);
    m2 |= bit;
    if (c >= 3) m3 |= bit;
    if (c >= 4) m4 |= bit;
  }
  const cat = CATEGORY[(POP[m4] << 6) | (POP[m3] << 3) | POP[m2]];

  // ── straights outrank everything below them
  const stHigh = STRAIGHT_HI[rankMask];
  if (stHigh !== 0 && cat < CAT_STRAIGHT) return (CAT_STRAIGHT << 20) | (stHigh << 16);

  switch (cat) {
    case CAT_QUADS: {
      const q = HIGH_RANK[m4];
      const kick = HIGH_RANK[rankMask & ~(1 << (q - 2))];
      return (CAT_QUADS << 20) | (q << 16) | (kick << 12);
    }
    case CAT_FULL_HOUSE: {
      const t = HIGH_RANK[m3];
      const p = HIGH_RANK[m2 & ~(1 << (t - 2))];
      return (CAT_FULL_HOUSE << 20) | (t << 16) | (p << 12);
    }
    case CAT_TRIPS: {
      const t = HIGH_RANK[m3];
      const rest = rankMask & ~(1 << (t - 2));
      // top two kickers: TOP5 >>> 12 leaves r1,r2 in the low eight bits
      return (CAT_TRIPS << 20) | (t << 16) | ((TOP5[rest] >>> 12) << 8);
    }
    case CAT_TWO_PAIR: {
      const packedPairs = TOP5[m2] >>> 12; // r1<<4 | r2
      const p1 = packedPairs >>> 4;
      const p2 = packedPairs & 15;
      const rest = rankMask & ~(1 << (p1 - 2)) & ~(1 << (p2 - 2));
      return (CAT_TWO_PAIR << 20) | (p1 << 16) | (p2 << 12) | (HIGH_RANK[rest] << 8);
    }
    case CAT_PAIR: {
      const p = HIGH_RANK[m2];
      const rest = rankMask & ~(1 << (p - 2));
      // top three kickers: TOP5 >>> 8 leaves r1,r2,r3 in the low twelve bits
      return (CAT_PAIR << 20) | (p << 16) | ((TOP5[rest] >>> 8) << 4);
    }
    default:
      return (CAT_HIGH_CARD << 20) | TOP5[rankMask];
  }
}

const seven = new Int32Array(7);

/** Convenience wrapper for exactly seven cards. */
export function evaluate7(
  a: CardId, b: CardId, c: CardId, d: CardId, e: CardId, f: CardId, g: CardId,
): number {
  seven[0] = a; seven[1] = b; seven[2] = c; seven[3] = d;
  seven[4] = e; seven[5] = f; seven[6] = g;
  return evaluateValue(seven, 7);
}

/** `> 0` when a beats b. Sorts hands strongest-first with `sort(compareValues)`. */
export function compareValues(a: number, b: number): number {
  return a - b;
}

export function categoryOfValue(value: number): HandCategory {
  return CATEGORY_NAMES[value >>> 20];
}

// ─────────────────────────── best five + label ───────────────────────────

/** The five ranks of a straight whose high card is `high` (wheel aware). */
function straightRanks(high: number): number[] {
  if (high === 5) return [5, 4, 3, 2, 14];
  return [high, high - 1, high - 2, high - 3, high - 4];
}

/**
 * Picks `count` cards of `rank` out of `cards`, optionally restricted to a
 * suit, appending them to `out`. Used to turn a decoded value back into the
 * physical cards the player is holding.
 */
function take(cards: readonly CardId[], rank: number, count: number, suit: number, out: CardId[]): void {
  let need = count;
  for (let i = 0; i < cards.length && need > 0; i++) {
    const c = cards[i];
    if (cardRank(c) !== rank) continue;
    if (suit >= 0 && cardSuit(c) !== suit) continue;
    if (out.indexOf(c) >= 0) continue;
    out.push(c);
    need--;
  }
}

/** The suit holding five or more cards, or -1. */
function flushSuitOf(cards: readonly CardId[]): number {
  let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
  for (const c of cards) {
    const s = c & 3;
    if (s === 0) c0++; else if (s === 1) c1++; else if (s === 2) c2++; else c3++;
  }
  if (c0 >= 5) return 0;
  if (c1 >= 5) return 1;
  if (c2 >= 5) return 2;
  if (c3 >= 5) return 3;
  return -1;
}

/**
 * The exact five cards that make the hand described by `value`, best-first:
 * the made portion in descending significance, then kickers.
 */
export function bestFive(cards: readonly CardId[], value: number): CardId[] {
  const cat = value >>> 20;
  const r1 = (value >>> 16) & 15;
  const r2 = (value >>> 12) & 15;
  const r3 = (value >>> 8) & 15;
  const r4 = (value >>> 4) & 15;
  const r5 = value & 15;
  const out: CardId[] = [];

  switch (cat) {
    case CAT_STRAIGHT_FLUSH: {
      const suit = flushSuitOf(cards);
      for (const r of straightRanks(r1)) take(cards, r, 1, suit, out);
      break;
    }
    case CAT_QUADS:
      take(cards, r1, 4, -1, out);
      take(cards, r2, 1, -1, out);
      break;
    case CAT_FULL_HOUSE:
      take(cards, r1, 3, -1, out);
      take(cards, r2, 2, -1, out);
      break;
    case CAT_FLUSH: {
      const suit = flushSuitOf(cards);
      for (const r of [r1, r2, r3, r4, r5]) take(cards, r, 1, suit, out);
      break;
    }
    case CAT_STRAIGHT:
      for (const r of straightRanks(r1)) take(cards, r, 1, -1, out);
      break;
    case CAT_TRIPS:
      take(cards, r1, 3, -1, out);
      take(cards, r2, 1, -1, out);
      take(cards, r3, 1, -1, out);
      break;
    case CAT_TWO_PAIR:
      take(cards, r1, 2, -1, out);
      take(cards, r2, 2, -1, out);
      take(cards, r3, 1, -1, out);
      break;
    case CAT_PAIR:
      take(cards, r1, 2, -1, out);
      take(cards, r2, 1, -1, out);
      take(cards, r3, 1, -1, out);
      take(cards, r4, 1, -1, out);
      break;
    default:
      for (const r of [r1, r2, r3, r4, r5]) take(cards, r, 1, -1, out);
      break;
  }
  return out;
}

/**
 * The English name of a hand, in the voice the HUD uses:
 * "Full House, Kings full of Sevens", "Ace-high Flush", "Royal Flush".
 */
export function labelForValue(value: number): string {
  const cat = value >>> 20;
  const r1 = (value >>> 16) & 15;
  const r2 = (value >>> 12) & 15;
  const r3 = (value >>> 8) & 15;
  switch (cat) {
    case CAT_STRAIGHT_FLUSH:
      return r1 === 14 ? 'Royal Flush' : `${rankWord(r1)}-high Straight Flush`;
    case CAT_QUADS:
      return `Four of a Kind, ${rankWordPlural(r1)}`;
    case CAT_FULL_HOUSE:
      return `Full House, ${rankWordPlural(r1)} full of ${rankWordPlural(r2)}`;
    case CAT_FLUSH:
      return `${rankWord(r1)}-high Flush`;
    case CAT_STRAIGHT:
      return `${rankWord(r1)}-high Straight`;
    case CAT_TRIPS:
      return `Three of a Kind, ${rankWordPlural(r1)}`;
    case CAT_TWO_PAIR:
      return `Two Pair, ${rankWordPlural(r1)} and ${rankWordPlural(r2)}`;
    case CAT_PAIR:
      return `Pair of ${rankWordPlural(r1)}`;
    default:
      return `${rankWord(r1)}-high, ${rankWord(r2)} kicker`;
  }
}

/**
 * Ultra-compact label for dense UI (seat plaques, replay rows):
 * "K♠ Full of 7s" is too wide, so this stays under ~14 characters.
 */
export function shortLabelForValue(value: number): string {
  const cat = value >>> 20;
  const r1 = (value >>> 16) & 15;
  const r2 = (value >>> 12) & 15;
  switch (cat) {
    case CAT_STRAIGHT_FLUSH: return r1 === 14 ? 'Royal Flush' : 'Str. Flush';
    case CAT_QUADS: return `Quad ${rankWordPlural(r1)}`;
    case CAT_FULL_HOUSE: return `${rankWordPlural(r1)} Full`;
    case CAT_FLUSH: return `${rankWord(r1)} Flush`;
    case CAT_STRAIGHT: return `${rankWord(r1)} Straight`;
    case CAT_TRIPS: return `Trip ${rankWordPlural(r1)}`;
    case CAT_TWO_PAIR: return `${rankWordPlural(r1)} & ${rankWordPlural(r2)}`;
    case CAT_PAIR: return `Pair ${rankWordPlural(r1)}`;
    default: return `${rankWord(r1)} High`;
  }
}

/** Builds the full HandRank record from a value and the cards it came from. */
export function handRankOf(cards: readonly CardId[], value: number): HandRank {
  return {
    value,
    category: CATEGORY_NAMES[value >>> 20],
    best: bestFive(cards, value),
    label: labelForValue(value),
  };
}

/**
 * The headline API: best five-card hand from 5, 6 or 7 cards, with the exact
 * cards and an English label. Allocates — use `evaluateValue` in hot loops.
 */
export function evaluate(cards: readonly CardId[]): HandRank {
  if (cards.length < 5) throw new Error(`need at least 5 cards, got ${cards.length}`);
  return handRankOf(cards, evaluateValue(cards, cards.length));
}

/** Hole cards + board, the shape the table actually has them in. */
export function evaluateHoldem(hole: readonly CardId[], board: readonly CardId[]): HandRank {
  const all = hole.concat(board as CardId[]);
  return handRankOf(all, evaluateValue(all, all.length));
}
