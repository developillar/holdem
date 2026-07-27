/**
 * ROYALE — gto/plo.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Pot-Limit Omaha preflop hand strength.
 *
 * There is no 169-cell shorthand in PLO — 16,432 distinct starting hands do
 * not fit on a grid — so preflop ranges are expressed as a *score* with a
 * percentile attached. The score is the standard structural model every PLO
 * book teaches, made numeric:
 *
 *   pairs        high pairs are worth a great deal, low pairs very little,
 *                and a second pair adds less than the first
 *   suitedness   double-suited is the single biggest multiplier; a bare ace
 *                suit is worth more than a low suit because it makes nuts
 *   connectivity gaps between the four ranks, scored per adjacent pair, with
 *                high rundowns beating low ones
 *   danglers     a card that works with nothing costs you a quarter of the hand
 *
 * The percentile is calibrated at first use by scoring 24,000 random hands, so
 * "top 18%" means exactly that and position thresholds are honest.
 */

import type { CardId } from '../core/types.ts';
import { Rng } from '../core/rng.ts';

export interface PloHandParts {
  pairScore: number;
  suitScore: number;
  connectScore: number;
  danglerPenalty: number;
}

export interface PloHandInfo {
  score: number;
  /** 0–1, share of random PLO hands this beats */
  percentile: number;
  doubleSuited: boolean;
  singleSuited: boolean;
  rainbow: boolean;
  pairs: number[];
  /** worst rank that connects with nothing, or 0 */
  dangler: number;
  label: string;
  parts: PloHandParts;
}

const PAIR_VALUE: Record<number, number> = {
  14: 46, 13: 34, 12: 27, 11: 23, 10: 20, 9: 17, 8: 15, 7: 13, 6: 12, 5: 11, 4: 10, 3: 9, 2: 8,
};

/**
 * Gap between two ranks, scored for straight equity. The falloff past a gap of
 * two is steep on purpose: four cards spread over eight ranks are not a
 * connected hand no matter how the pairs line up.
 */
function gapValue(hi: number, lo: number): number {
  const gap = hi - lo;
  if (gap === 1) return 9;
  if (gap === 2) return 5.5;
  if (gap === 3) return 2.5;
  if (gap === 4) return 1;
  return 0;
}

/** High cards make more nut straights than low ones. */
function heightBonus(rank: number): number {
  return (rank - 2) / 12;
}

export function ploScore(cards: readonly CardId[]): PloHandInfo {
  const ranks = cards.map((c) => (c >> 2) + 2).sort((a, b) => b - a);
  const suits = cards.map((c) => c & 3);
  const suitCount = [0, 0, 0, 0];
  for (const s of suits) suitCount[s]++;

  // ── pairs
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const pairs: number[] = [];
  let trips = 0;
  let quads = 0;
  for (const [r, n] of counts) {
    if (n === 2) pairs.push(r);
    else if (n === 3) trips = r;
    else if (n === 4) quads = r;
  }
  pairs.sort((a, b) => b - a);
  let pairScore = 0;
  if (quads) pairScore = PAIR_VALUE[quads] * 0.4;
  else if (trips) pairScore = PAIR_VALUE[trips] * 0.6;
  else {
    if (pairs[0]) pairScore += PAIR_VALUE[pairs[0]];
    if (pairs[1]) pairScore += PAIR_VALUE[pairs[1]] * 0.5;
  }

  // ── suits: a suited ace is worth far more than a suited deuce
  let suitScore = 0;
  let suitedGroups = 0;
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] < 2) continue;
    suitedGroups++;
    const high = Math.max(...cards.filter((c) => (c & 3) === s).map((c) => (c >> 2) + 2));
    const base = suitCount[s] === 2 ? 8 : suitCount[s] === 3 ? 4 : 1.5;
    suitScore += base * (0.5 + 0.8 * heightBonus(high));
  }
  const doubleSuited = suitedGroups >= 2;
  if (doubleSuited) suitScore += 5;

  // ── connectivity, scored across every adjacent pair of the sorted ranks
  let connectScore = 0;
  for (let i = 0; i < 3; i++) {
    const g = gapValue(ranks[i], ranks[i + 1]);
    connectScore += g * (0.65 + 0.7 * heightBonus(ranks[i]));
  }
  // A true rundown (three consecutive gaps of 1 or 2) plays far above the sum.
  const gaps = [ranks[0] - ranks[1], ranks[1] - ranks[2], ranks[2] - ranks[3]];
  if (gaps.every((g) => g >= 1 && g <= 2)) connectScore += 10;
  // Wheel wrap: an ace also connects downward.
  if (ranks[0] === 14 && ranks[3] <= 5) connectScore += 4;
  // Span: four cards smeared across ten ranks make far fewer straights than
  // the pairwise gaps suggest.
  const span = ranks[0] - ranks[3];
  connectScore *= Math.max(0.35, Math.min(1.15, 1.15 - (span - 3) / 14));

  // ── danglers: a rank that neither pairs nor sits within 4 of another
  let dangler = 0;
  let danglerPenalty = 0;
  for (let i = 0; i < 4; i++) {
    const r = ranks[i];
    if ((counts.get(r) ?? 0) > 1) continue;
    let connects = false;
    for (let j = 0; j < 4; j++) {
      if (i === j) continue;
      if (Math.abs(r - ranks[j]) <= 4) connects = true;
    }
    const suited = suitCount[suits[cards.findIndex((c) => (c >> 2) + 2 === r)]] >= 2;
    if (!connects && !suited && r < 12) {
      const first = dangler === 0;
      dangler = first ? r : Math.min(dangler, r);
      danglerPenalty += (7 - heightBonus(r) * 3) * (first ? 1 : 0.5);
    }
  }

  const score = Math.max(0, pairScore + suitScore + connectScore - danglerPenalty);

  const bits: string[] = [];
  if (quads) bits.push(`quad ${rankWord(quads)}s`);
  else if (trips) bits.push(`trip ${rankWord(trips)}s`);
  else if (pairs.length === 2) bits.push('two pair');
  else if (pairs.length === 1) bits.push(`pair of ${rankWord(pairs[0])}s`);
  if (gaps.every((g) => g >= 1 && g <= 2)) bits.push('rundown');
  else if (connectScore > 16) bits.push('connected');
  bits.push(doubleSuited ? 'double-suited' : suitedGroups === 1 ? 'single-suited' : 'rainbow');
  if (dangler) bits.push(`${rankWord(dangler)} dangler`);

  return {
    score,
    percentile: percentileOf(score),
    doubleSuited,
    singleSuited: suitedGroups === 1,
    rainbow: suitedGroups === 0,
    pairs,
    dangler,
    label: bits.join(', '),
    parts: { pairScore, suitScore, connectScore, danglerPenalty },
  };
}

const RANK_WORD = ['', '', 'deuce', 'trey', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];
function rankWord(r: number): string {
  return RANK_WORD[r] ?? String(r);
}

// ─────────────────────── percentile calibration ───────────────────────

let ladder: Float64Array | null = null;
let calibrating = false;

function buildLadder(): Float64Array {
  const rng = new Rng(0x5150);
  const n = 24000;
  const out = new Float64Array(n);
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  const hand: CardId[] = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) {
      const j = k + rng.int(52 - k);
      const t = deck[k];
      deck[k] = deck[j];
      deck[j] = t;
      hand[k] = deck[k];
    }
    out[i] = rawScore(hand);
  }
  out.sort();
  return out;
}

/** Score without the percentile lookup, so calibration cannot recurse. */
function rawScore(cards: readonly CardId[]): number {
  calibrating = true;
  const s = ploScore(cards).score;
  calibrating = false;
  return s;
}

/** Share of random PLO hands a score beats, 0–1. */
export function percentileOf(score: number): number {
  if (calibrating) return 0;
  if (!ladder) ladder = buildLadder();
  const arr = ladder;
  if (!arr.length) return 0;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < score) lo = mid + 1;
    else hi = mid;
  }
  return lo / arr.length;
}

// ─────────────────────── preflop strategy ───────────────────────

/**
 * Open-raise thresholds by seats left to act, as a percentile of all hands.
 * PLO opens wider than Hold'em because equities run closer and position is
 * worth more, but the top of the range is much narrower in real terms.
 */
const PLO_RFI_PCT: Record<number, number> = {
  8: 0.16, 7: 0.18, 6: 0.21, 5: 0.24, 4: 0.30, 3: 0.38, 2: 0.52, 1: 0.46,
};

/** Continue thresholds facing a pot-sized 3-bet: call, and 4-bet. */
const PLO_VS_3BET_CALL = 0.28;
const PLO_VS_3BET_4BET = 0.055;

export interface PloStrategy {
  freq: Record<string, number>;
  /** the percentile boundary that produced it, for the explanation */
  threshold: number;
  info: PloHandInfo;
}

/** Mixes across a band around the threshold — the boundary is never a cliff. */
function mixAt(percentileFromTop: number, threshold: number, band = 0.05): number {
  const d = threshold - percentileFromTop;
  if (d >= band) return 1;
  if (d <= -band) return 0;
  return 0.5 + (0.5 * d) / band;
}

export function ploRfi(cards: readonly CardId[], playersBehind: number): PloStrategy {
  const info = ploScore(cards);
  const fromTop = 1 - info.percentile;
  const threshold = PLO_RFI_PCT[Math.max(1, Math.min(8, playersBehind))] ?? 0.25;
  const raise = mixAt(fromTop, threshold);
  return { freq: { raise, fold: 1 - raise }, threshold, info };
}

export function ploFacingOpen(
  cards: readonly CardId[],
  inPosition: boolean,
  isBlind: boolean,
): PloStrategy {
  const info = ploScore(cards);
  const fromTop = 1 - info.percentile;
  const threeBetLine = inPosition ? 0.09 : 0.075;
  const callLine = isBlind ? 0.42 : inPosition ? 0.34 : 0.2;
  const threeBet = mixAt(fromTop, threeBetLine, 0.035);
  const call = Math.max(0, mixAt(fromTop, callLine, 0.07) - threeBet);
  return {
    freq: { '3bet': threeBet, call, fold: Math.max(0, 1 - threeBet - call) },
    threshold: callLine,
    info,
  };
}

export function ploFacing3Bet(cards: readonly CardId[]): PloStrategy {
  const info = ploScore(cards);
  const fromTop = 1 - info.percentile;
  const fourBet = mixAt(fromTop, PLO_VS_3BET_4BET, 0.025);
  const call = Math.max(0, mixAt(fromTop, PLO_VS_3BET_CALL, 0.06) - fourBet);
  return {
    freq: { '4bet': fourBet, call, fold: Math.max(0, 1 - fourBet - call) },
    threshold: PLO_VS_3BET_CALL,
    info,
  };
}

/** Pot-limit raise size: 3× the last bet plus everything already in. */
export function potRaiseTo(potBb: number, toCallBb: number): number {
  return toCallBb * 3 + potBb - toCallBb;
}
