/**
 * Pot-Limit Omaha: hand evaluation and the pot-limit bet sizing rule.
 *
 * Omaha's defining rule is that a player uses EXACTLY two hole cards and
 * EXACTLY three board cards — never one, never three. That is why four hearts
 * on the board plus the ace of hearts in your hand is not a flush, and it is
 * the single most common thing naive implementations get wrong. There is no
 * shortcut: enumerate C(4,2) x C(5,3) = 60 five-card hands and take the best.
 *
 * Sixty evaluations of a five-card hand is nothing (the whole showdown for a
 * nine-handed table is ~540 evaluations, well under 100µs), so this stays exact
 * rather than clever.
 */
import type { CardId, HandRank } from '../core/types.ts';
import { evaluateValue, handRankOf } from './evaluator.ts';
import { roundChips, floorChips, DEFAULT_CHIP_STEP } from './pots.ts';

// ─────────────────────────── combination tables ───────────────────────────

/** All k-subsets of [0..n), precomputed for the sizes Omaha actually uses. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const idx: number[] = new Array(k);
  const walk = (start: number, depth: number): void => {
    if (depth === k) { out.push(idx.slice()); return; }
    for (let i = start; i < n; i++) {
      idx[depth] = i;
      walk(i + 1, depth + 1);
    }
  };
  walk(0, 0);
  return out;
}

const HOLE_PAIRS: Record<number, number[][]> = {
  2: combinations(2, 2),
  4: combinations(4, 2),
  5: combinations(5, 2),
  6: combinations(6, 2),
};
const BOARD_TRIPLES: Record<number, number[][]> = {
  3: combinations(3, 3),
  4: combinations(4, 3),
  5: combinations(5, 3),
};

/** How many five-card hands a given hole/board size implies. Omaha: 60. */
export function omahaComboCount(holeLen: number, boardLen: number): number {
  const h = HOLE_PAIRS[holeLen];
  const b = BOARD_TRIPLES[boardLen];
  if (!h || !b) throw new Error(`unsupported omaha shape: ${holeLen} hole / ${boardLen} board`);
  return h.length * b.length;
}

// Scratch buffer for the five-card candidate. Single-threaded, reused.
const five = new Int32Array(5);

/**
 * Strength of the best legal Omaha hand — value only, allocation-free.
 * `hole` must be 2/4/5/6 cards, `board` 3/4/5.
 */
export function ploValue(hole: readonly CardId[], board: readonly CardId[]): number {
  const pairs = HOLE_PAIRS[hole.length];
  const triples = BOARD_TRIPLES[board.length];
  if (!pairs || !triples) {
    throw new Error(`unsupported omaha shape: ${hole.length} hole / ${board.length} board`);
  }
  let best = -1;
  for (let p = 0; p < pairs.length; p++) {
    const pr = pairs[p];
    five[0] = hole[pr[0]];
    five[1] = hole[pr[1]];
    for (let t = 0; t < triples.length; t++) {
      const tr = triples[t];
      five[2] = board[tr[0]];
      five[3] = board[tr[1]];
      five[4] = board[tr[2]];
      const v = evaluateValue(five, 5);
      if (v > best) best = v;
    }
  }
  return best;
}

/**
 * The best legal Omaha hand with its exact five cards and English label.
 * `best` contains the two hole cards first, then the three board cards.
 */
export function evaluatePlo(hole: readonly CardId[], board: readonly CardId[]): HandRank {
  const pairs = HOLE_PAIRS[hole.length];
  const triples = BOARD_TRIPLES[board.length];
  if (!pairs || !triples) {
    throw new Error(`unsupported omaha shape: ${hole.length} hole / ${board.length} board`);
  }
  let best = -1;
  let bestCards: CardId[] = [];
  for (let p = 0; p < pairs.length; p++) {
    const pr = pairs[p];
    for (let t = 0; t < triples.length; t++) {
      const tr = triples[t];
      five[0] = hole[pr[0]];
      five[1] = hole[pr[1]];
      five[2] = board[tr[0]];
      five[3] = board[tr[1]];
      five[4] = board[tr[2]];
      const v = evaluateValue(five, 5);
      if (v > best) {
        best = v;
        bestCards = [five[0], five[1], five[2], five[3], five[4]];
      }
    }
  }
  return handRankOf(bestCards, best);
}

/** Which of the player's hole cards ended up playing — the UI highlights them. */
export function playingHoleCards(rank: HandRank, hole: readonly CardId[]): CardId[] {
  return rank.best.filter((c) => hole.includes(c));
}

// ─────────────────────────── pot-limit sizing ───────────────────────────

export interface PotLimitContext {
  /** chips already gathered into pots from previous streets (and dead money) */
  potBefore: number;
  /** sum of every seat's commitment on the CURRENT street */
  streetCommitted: number;
  /** highest street commitment by any seat */
  currentBet: number;
  /** the acting seat's street commitment so far */
  myCommitted: number;
  /** the acting seat's remaining stack */
  myStack: number;
  step?: number;
}

/**
 * The pot-limit maximum, expressed as a total "raise to" amount.
 *
 * The rule: you may raise by the size of the pot *after* your call. So
 *
 *   maxRaiseTo = currentBet + (potBefore + streetCommitted + amountToCall)
 *
 * Worked example, $1/$2 PLO: the pot is empty, blinds total $3 on the table,
 * UTG must call $2. Max raise to = 2 + (0 + 3 + 2) = $7 — the familiar
 * "pot is seven" preflop open. It is always capped by the player's stack.
 */
export function potLimitRaiseTo(ctx: PotLimitContext): number {
  const step = ctx.step ?? DEFAULT_CHIP_STEP;
  const toCall = Math.max(0, roundChips(ctx.currentBet - ctx.myCommitted, step));
  const potAfterCall = roundChips(ctx.potBefore + ctx.streetCommitted + toCall, step);
  const raw = roundChips(ctx.currentBet + potAfterCall, step);
  const allIn = roundChips(ctx.myCommitted + ctx.myStack, step);
  return Math.min(floorChips(raw, step), allIn);
}

/**
 * The largest *bet* (not raise-to) a pot-limit player may make when there is
 * no wager outstanding: exactly the size of the pot.
 */
export function potLimitOpenBet(potBefore: number, streetCommitted: number, myStack: number, step = DEFAULT_CHIP_STEP): number {
  return Math.min(floorChips(roundChips(potBefore + streetCommitted, step), step), roundChips(myStack, step));
}

/** Convenience: the pot-sized raise expressed as chips added to the pot. */
export function potLimitRaiseDelta(ctx: PotLimitContext): number {
  const step = ctx.step ?? DEFAULT_CHIP_STEP;
  return roundChips(potLimitRaiseTo(ctx) - ctx.myCommitted, step);
}
