/**
 * ROYALE — opponent intelligence.
 *
 * These are not random-number opponents. The stack is:
 *
 *   1. A rollout-grade 7-card evaluator (integer ranks, zero allocation) so we
 *      can afford thousands of Monte-Carlo trials inside a single decision.
 *   2. A 169-entry preflop model with a real hand ordering, turned into
 *      weighted ranges by position, personality and stack depth.
 *   3. Equity estimation by Monte-Carlo rollout against the opponent's
 *      *modelled range*, memoised so repeated spots are free.
 *   4. Postflop decisions driven by pot odds, SPR, board texture, draw outs
 *      and blockers — with personality-skewed frequencies for value, bluff,
 *      c-bet sizing, slow-play, check-raise and float.
 *   5. A human timing model: snap folds, quick continuation bets, and the
 *      occasional four-second tank when the pot is big and the spot is close.
 *
 * Nothing in here touches the DOM, the renderer or the bus — it is a pure
 * function of (bot, context) → decision.
 */

import { Rng } from '../core/rng.ts';
import type { ActionKind, CardId, GameVariant, HandCategory, HandRank, PositionName, Street } from '../core/types.ts';
import { RANKS } from '../core/types.ts';
import type { BotProfile, Personality } from './profiles.ts';

// ═══════════════════════════════════════════════════════════════════
// 1 — Hand evaluation
// ═══════════════════════════════════════════════════════════════════

const CAT_HIGH = 0;
const CAT_PAIR = 1;
const CAT_TWO_PAIR = 2;
const CAT_TRIPS = 3;
const CAT_STRAIGHT = 4;
const CAT_FLUSH = 5;
const CAT_FULL = 6;
const CAT_QUADS = 7;
const CAT_SF = 8;

const CATEGORY_NAMES: HandCategory[] = [
  'high-card',
  'pair',
  'two-pair',
  'trips',
  'straight',
  'flush',
  'full-house',
  'quads',
  'straight-flush',
];

const RANK_ONE = ['Deuce', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_MANY = ['Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

/** STRAIGHT_HIGH[13-bit rank mask] = top rank index of the best straight, else -1. */
const STRAIGHT_HIGH = (() => {
  const t = new Int8Array(1 << 13).fill(-1);
  const wheel = (1 << 12) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);
  for (let m = 0; m < 1 << 13; m++) {
    let high = -1;
    for (let hi = 12; hi >= 4; hi--) {
      const need = (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3)) | (1 << (hi - 4));
      if ((m & need) === need) {
        high = hi;
        break;
      }
    }
    if (high < 0 && (m & wheel) === wheel) high = 3;
    t[m] = high;
  }
  return t;
})();

const POP = (() => {
  const t = new Uint8Array(1 << 13);
  for (let m = 1; m < 1 << 13; m++) t[m] = t[m >> 1] + (m & 1);
  return t;
})();

// Reusable scratch — the evaluator is hot and must never allocate.
const evSuit = new Int32Array(4);
const evCount = new Int32Array(13);

function packTop(mask: number, count: number, skipA = -1, skipB = -1): number {
  let v = 0;
  let n = 0;
  for (let r = 12; r >= 0 && n < count; r--) {
    if (r === skipA || r === skipB) continue;
    if (mask & (1 << r)) {
      v = (v << 4) | r;
      n++;
    }
  }
  while (n < count) {
    v = v << 4;
    n++;
  }
  return v;
}

/**
 * Rank any 5..7 card holding as a single comparable integer.
 * Layout: category<<20 | k1<<16 | k2<<12 | k3<<8 | k4<<4 | k5.
 */
export function rank7(cards: ArrayLike<number>, n: number = cards.length): number {
  evSuit[0] = evSuit[1] = evSuit[2] = evSuit[3] = 0;
  for (let i = 0; i < 13; i++) evCount[i] = 0;
  let all = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = c >> 2;
    evSuit[c & 3] |= 1 << r;
    evCount[r]++;
    all |= 1 << r;
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) {
    if (POP[evSuit[s]] >= 5) {
      flushSuit = s;
      break;
    }
  }
  if (flushSuit >= 0) {
    const sf = STRAIGHT_HIGH[evSuit[flushSuit]];
    if (sf >= 0) return (CAT_SF << 20) | (sf << 16);
  }

  let quad = -1;
  let trip = -1;
  let trip2 = -1;
  let pair1 = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const c = evCount[r];
    if (c === 4) {
      if (quad < 0) quad = r;
    } else if (c === 3) {
      if (trip < 0) trip = r;
      else if (trip2 < 0) trip2 = r;
    } else if (c === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
    }
  }

  if (quad >= 0) return (CAT_QUADS << 20) | (quad << 16) | (packTop(all, 1, quad) << 12);
  if (trip >= 0 && (pair1 >= 0 || trip2 >= 0)) {
    const kicker = trip2 > pair1 ? trip2 : pair1;
    return (CAT_FULL << 20) | (trip << 16) | (kicker << 12);
  }
  if (flushSuit >= 0) return (CAT_FLUSH << 20) | (packTop(evSuit[flushSuit], 5) << 0);
  const st = STRAIGHT_HIGH[all];
  if (st >= 0) return (CAT_STRAIGHT << 20) | (st << 16);
  if (trip >= 0) return (CAT_TRIPS << 20) | (trip << 16) | (packTop(all, 2, trip) << 4);
  if (pair2 >= 0) {
    return (CAT_TWO_PAIR << 20) | (pair1 << 16) | (pair2 << 12) | (packTop(all, 1, pair1, pair2) << 8);
  }
  if (pair1 >= 0) return (CAT_PAIR << 20) | (pair1 << 16) | (packTop(all, 3, pair1) << 4);
  return (CAT_HIGH << 20) | packTop(all, 5);
}

const ploScratch = new Int32Array(5);
const PLO_HOLE_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
];
const PLO_BOARD_TRIPLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2], [0, 1, 3], [0, 1, 4], [0, 2, 3], [0, 2, 4],
  [0, 3, 4], [1, 2, 3], [1, 2, 4], [1, 3, 4], [2, 3, 4],
];

/** Omaha: exactly two hole cards and three board cards. Needs a 5-card board. */
export function rankPlo(hole: ArrayLike<number>, board: ArrayLike<number>): number {
  if (board.length < 3) return rank7(hole, Math.min(hole.length, 4));
  let best = -1;
  for (let h = 0; h < PLO_HOLE_PAIRS.length; h++) {
    const hp = PLO_HOLE_PAIRS[h];
    if (hp[1] >= hole.length) continue;
    ploScratch[0] = hole[hp[0]];
    ploScratch[1] = hole[hp[1]];
    if (board.length >= 5) {
      for (let b = 0; b < PLO_BOARD_TRIPLES.length; b++) {
        const bt = PLO_BOARD_TRIPLES[b];
        ploScratch[2] = board[bt[0]];
        ploScratch[3] = board[bt[1]];
        ploScratch[4] = board[bt[2]];
        const v = rank7(ploScratch, 5);
        if (v > best) best = v;
      }
    } else {
      // 3 or 4 board cards: evaluate the partial holding directly.
      const tmp: number[] = [ploScratch[0], ploScratch[1]];
      for (let i = 0; i < board.length; i++) tmp.push(board[i]);
      const v = rank7(tmp, tmp.length);
      if (v > best) best = v;
    }
  }
  return best;
}

export function rankFor(variant: GameVariant, hole: ArrayLike<number>, board: ArrayLike<number>): number {
  if (variant === 'plo4') return rankPlo(hole, board);
  const n = hole.length + board.length;
  const buf = comboBuf(n);
  let k = 0;
  for (let i = 0; i < hole.length; i++) buf[k++] = hole[i];
  for (let i = 0; i < board.length; i++) buf[k++] = board[i];
  return rank7(buf, k);
}

let comboScratch = new Int32Array(9);
function comboBuf(n: number): Int32Array {
  if (comboScratch.length < n) comboScratch = new Int32Array(n);
  return comboScratch;
}

function rankLabel(value: number): string {
  const cat = value >>> 20;
  const k1 = (value >> 16) & 0xf;
  const k2 = (value >> 12) & 0xf;
  switch (cat) {
    case CAT_SF:
      return k1 === 12 ? 'Royal Flush' : `${RANK_ONE[k1]}-high Straight Flush`;
    case CAT_QUADS:
      return `Four ${RANK_MANY[k1]}`;
    case CAT_FULL:
      return `${RANK_MANY[k1]} full of ${RANK_MANY[k2]}`;
    case CAT_FLUSH:
      return `${RANK_ONE[(value >> 16) & 0xf]}-high Flush`;
    case CAT_STRAIGHT:
      return `${RANK_ONE[k1]}-high Straight`;
    case CAT_TRIPS:
      return `Three ${RANK_MANY[k1]}`;
    case CAT_TWO_PAIR:
      return `${RANK_MANY[k1]} & ${RANK_MANY[k2]}`;
    case CAT_PAIR:
      return `Pair of ${RANK_MANY[k1]}`;
    default:
      return `${RANK_ONE[k1]} High`;
  }
}

/**
 * Full `HandRank` including the exact five cards — used at showdown, where the
 * extra work buys us the winning-cards highlight. Never call this in a rollout.
 */
export function handRankOf(cards: readonly CardId[]): HandRank {
  const n = cards.length;
  if (n < 5) {
    const v = rank7(cards, n);
    return { value: v, category: CATEGORY_NAMES[v >>> 20], best: cards.slice(), label: rankLabel(v) };
  }
  const idx = [0, 1, 2, 3, 4];
  const pick = new Int32Array(5);
  let bestVal = -1;
  let bestSet: CardId[] = [];
  const walk = (start: number, depth: number): void => {
    if (depth === 5) {
      for (let i = 0; i < 5; i++) pick[i] = cards[idx[i]];
      const v = rank7(pick, 5);
      if (v > bestVal) {
        bestVal = v;
        bestSet = [pick[0], pick[1], pick[2], pick[3], pick[4]];
      }
      return;
    }
    for (let i = start; i < n; i++) {
      idx[depth] = i;
      walk(i + 1, depth + 1);
    }
  };
  walk(0, 0);
  bestSet.sort((a, b) => b - a);
  return {
    value: bestVal,
    category: CATEGORY_NAMES[bestVal >>> 20],
    best: bestSet,
    label: rankLabel(bestVal),
  };
}

/** Showdown ranking for either variant. */
export function showdownRank(variant: GameVariant, hole: readonly CardId[], board: readonly CardId[]): HandRank {
  if (variant !== 'plo4' || board.length < 5) return handRankOf([...hole, ...board]);
  let best: HandRank | null = null;
  for (const hp of PLO_HOLE_PAIRS) {
    if (hp[1] >= hole.length) continue;
    for (const bt of PLO_BOARD_TRIPLES) {
      const five = [hole[hp[0]], hole[hp[1]], board[bt[0]], board[bt[1]], board[bt[2]]];
      const r = handRankOf(five);
      if (!best || r.value > best.value) best = r;
    }
  }
  return best ?? handRankOf([...hole, ...board]);
}

// ═══════════════════════════════════════════════════════════════════
// 2 — Preflop model (169 grid)
// ═══════════════════════════════════════════════════════════════════

/** Grid index for two cards: row*13+col, A..2 descending, suited above the diagonal. */
export function gridIndexOf(a: CardId, b: CardId): number {
  const ra = a >> 2;
  const rb = b >> 2;
  const hi = ra >= rb ? ra : rb;
  const lo = ra >= rb ? rb : ra;
  const dhi = 12 - hi;
  const dlo = 12 - lo;
  if (hi === lo) return dhi * 13 + dhi;
  return (a & 3) === (b & 3) ? dhi * 13 + dlo : dlo * 13 + dhi;
}

export const HAND_LABELS: string[] = new Array(169);
/** Cumulative combo fraction *including* this hand — "top X%" means pct <= X. */
export const PREFLOP_PCT = new Float32Array(169);
const PREFLOP_LOW = new Float32Array(169);
const COMBO_FRACTION = new Float32Array(169);

/**
 * Hand ordering. A tuned Chen-style score: fast, deterministic, and — after the
 * modern corrections for suited connectors, suited aces and set-mining pairs —
 * within a couple of places of a solver's preflop ordering everywhere that
 * matters.
 */
function preflopScore(hi: number, lo: number, suited: boolean): number {
  const pair = hi === lo;
  const hv = hi === 14 ? 10 : hi === 13 ? 8 : hi === 12 ? 7 : hi === 11 ? 6 : hi / 2;
  let s = pair ? Math.max(5, hv * 2) : hv;
  if (suited) s += 2;
  if (!pair) {
    const gap = hi - lo - 1;
    s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && hi < 12) s += 1;
    if (suited && gap === 0 && lo >= 4) s += 0.75;
    if (suited && hi === 14) s += 0.55;
    if (suited && gap <= 2 && lo >= 5) s += 0.3;
    // Offsuit broadways play far better than Chen's raw score implies.
    if (!suited && hi >= 13 && lo >= 11) s += 0.6;
  } else if (lo <= 8) {
    s += 0.6; // implied set value
  }
  return s;
}

(() => {
  const order: number[] = [];
  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 13; col++) {
      const i = row * 13 + col;
      const dhi = Math.min(row, col);
      const dlo = Math.max(row, col);
      const hi = 14 - dhi;
      const lo = 14 - dlo;
      const pair = row === col;
      const suited = row < col;
      HAND_LABELS[i] = pair
        ? `${RANKS[hi - 2]}${RANKS[lo - 2]}`
        : `${RANKS[hi - 2]}${RANKS[lo - 2]}${suited ? 's' : 'o'}`;
      COMBO_FRACTION[i] = (pair ? 6 : suited ? 4 : 12) / 1326;
      order.push(i);
    }
  }
  const score = new Float32Array(169);
  for (let i = 0; i < 169; i++) {
    const row = Math.floor(i / 13);
    const col = i % 13;
    const hi = 14 - Math.min(row, col);
    const lo = 14 - Math.max(row, col);
    score[i] = preflopScore(hi, lo, row < col);
  }
  order.sort((a, b) => score[b] - score[a] || a - b);
  let cum = 0;
  for (const i of order) {
    PREFLOP_LOW[i] = cum;
    cum += COMBO_FRACTION[i];
    PREFLOP_PCT[i] = cum;
  }
})();

/** Percentile of a specific two-card holding: 0 = AA, 1 = 72o. */
export function handPercentile(hole: readonly CardId[]): number {
  if (hole.length < 2) return 1;
  return PREFLOP_PCT[gridIndexOf(hole[0], hole[1])];
}

export interface Range {
  key: string;
  weights: Float32Array;
  /** probability a uniformly random two-card holding lands in this range */
  mass: number;
}

const rangeCache = new Map<string, Range>();

function finishRange(key: string, w: Float32Array): Range {
  let mass = 0;
  for (let i = 0; i < 169; i++) mass += w[i] * COMBO_FRACTION[i];
  const r: Range = { key, weights: w, mass: Math.max(0.004, mass) };
  rangeCache.set(key, r);
  return r;
}

/** Top-N% range with a partially-weighted boundary hand — no hard cliff. */
export function rangeTop(pct: number): Range {
  const p = Math.max(0.005, Math.min(1, pct));
  const key = `t${p.toFixed(3)}`;
  const hit = rangeCache.get(key);
  if (hit) return hit;
  const w = new Float32Array(169);
  for (let i = 0; i < 169; i++) {
    if (PREFLOP_PCT[i] <= p) w[i] = 1;
    else if (PREFLOP_LOW[i] < p) w[i] = (p - PREFLOP_LOW[i]) / COMBO_FRACTION[i];
  }
  return finishRange(key, w);
}

/** Polarised range: a value core plus a band of bluff candidates. */
export function rangePolar(valuePct: number, bluffFrom: number, bluffTo: number, bluffWeight: number): Range {
  const key = `p${valuePct.toFixed(3)}_${bluffFrom.toFixed(3)}_${bluffTo.toFixed(3)}_${bluffWeight.toFixed(2)}`;
  const hit = rangeCache.get(key);
  if (hit) return hit;
  const w = new Float32Array(169);
  for (let i = 0; i < 169; i++) {
    if (PREFLOP_PCT[i] <= valuePct) w[i] = 1;
    else if (PREFLOP_LOW[i] >= bluffFrom && PREFLOP_PCT[i] <= bluffTo) w[i] = bluffWeight;
  }
  return finishRange(key, w);
}

// ═══════════════════════════════════════════════════════════════════
// 3 — Equity by Monte-Carlo rollout
// ═══════════════════════════════════════════════════════════════════

const eqDeck = new Int32Array(52);
/** eqPos[card] = index of that card inside eqDeck — lets us take a named card in O(1). */
const eqPos = new Int32Array(52);
const eqSeen = new Uint8Array(52);
const eqBoard = new Int32Array(5);
const eqHero = new Int32Array(9);
const eqOpp = new Int32Array(4);
const eqOppHands = new Int32Array(9 * 4);
const eqCombo = new Int32Array(9);
/** Weighted enumeration of every two-card combo the opponent range still allows. */
const comboA = new Int32Array(1326);
const comboB = new Int32Array(1326);
const comboCum = new Float64Array(1326);

interface EqCacheEntry {
  eq: number;
}
const eqCache = new Map<string, EqCacheEntry>();

function cardsKey(cards: readonly number[]): string {
  if (cards.length === 0) return '-';
  const s = cards.slice().sort((a, b) => a - b);
  let out = '';
  for (let i = 0; i < s.length; i++) out += (i ? '.' : '') + s[i];
  return out;
}

/**
 * Hero equity against `opponents` hands drawn from `range`, with the remaining
 * board run out at random. Cached by (hole, board, opponents, range).
 */
export function equityVsRange(
  variant: GameVariant,
  hole: readonly CardId[],
  board: readonly CardId[],
  opponents: number,
  range: Range,
  iters: number,
  rng: Rng,
): number {
  if (opponents <= 0) return 1;
  const key = `${variant}|${cardsKey(hole as number[])}|${cardsKey(board as number[])}|${opponents}|${range.key}`;
  const cached = eqCache.get(key);
  if (cached) return cached.eq;

  eqSeen.fill(0);
  for (const c of hole) eqSeen[c] = 1;
  for (const c of board) eqSeen[c] = 1;
  let dn = 0;
  for (let c = 0; c < 52; c++) if (!eqSeen[c]) eqDeck[dn++] = c;
  for (let i = 0; i < dn; i++) eqPos[eqDeck[i]] = i;

  const perOpp = variant === 'plo4' ? 4 : 2;
  const needBoard = 5 - board.length;
  if (dn < needBoard + opponents * perOpp) return 0.5;

  const holeN = hole.length;
  for (let i = 0; i < holeN; i++) eqHero[i] = hole[i];
  for (let i = 0; i < board.length; i++) eqBoard[i] = board[i];

  // Enumerate the opponent's live combos once, weighted by the range. Sampling
  // from this exactly reproduces the range including card-removal effects —
  // rejection sampling silently breaks down on very tight ranges.
  const useRange = variant !== 'plo4';
  let nCombos = 0;
  let totalWeight = 0;
  if (useRange) {
    for (let i = 0; i < dn; i++) {
      for (let j = i + 1; j < dn; j++) {
        const w = range.weights[gridIndexOf(eqDeck[i], eqDeck[j])];
        if (w <= 0) continue;
        comboA[nCombos] = eqDeck[i];
        comboB[nCombos] = eqDeck[j];
        totalWeight += w;
        comboCum[nCombos] = totalWeight;
        nCombos++;
      }
    }
  }

  let used = 0;
  const isUsed = (c: number): boolean => eqPos[c] < used;
  const take = (c: number): void => {
    const i = eqPos[c];
    const j = used;
    const ci = eqDeck[i];
    const cj = eqDeck[j];
    eqDeck[i] = cj;
    eqDeck[j] = ci;
    eqPos[cj] = i;
    eqPos[ci] = j;
    used++;
  };
  const drawOne = (): number => {
    const j = used + rng.int(dn - used);
    const c = eqDeck[j];
    take(c);
    return c;
  };
  const sampleCombo = (): number => {
    const target = rng.next() * totalWeight;
    let lo = 0;
    let hi = nCombos - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comboCum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  let score = 0;
  const rangeUsable = useRange && nCombos > 0 && totalWeight > 0;
  // Omaha ranges are expressed as a strength cutoff rather than a combo list.
  const ploCutoff = useRange ? 1 : Math.max(0.12, Math.min(1, range.mass * 1.8));
  for (let it = 0; it < iters; it++) {
    used = 0;

    // Opponents first — they are the constrained draw.
    let oppCount = 0;
    for (let o = 0; o < opponents; o++) {
      if (rangeUsable) {
        let placed = false;
        for (let attempt = 0; attempt < 48; attempt++) {
          const k = sampleCombo();
          if (!isUsed(comboA[k]) && !isUsed(comboB[k])) {
            take(comboA[k]);
            take(comboB[k]);
            eqOppHands[oppCount * 4] = comboA[k];
            eqOppHands[oppCount * 4 + 1] = comboB[k];
            placed = true;
            break;
          }
        }
        if (!placed) {
          eqOppHands[oppCount * 4] = drawOne();
          eqOppHands[oppCount * 4 + 1] = drawOne();
        }
      } else if (ploCutoff < 0.999) {
        // Omaha has no 169-hand grid, so filter four-card hands by strength
        // percentile instead. Without this every opponent holds junk.
        let placed = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          const mark = used;
          for (let i = 0; i < 4; i++) eqOpp[i] = drawOne();
          if (plo4Percentile(eqOpp) <= ploCutoff) {
            for (let i = 0; i < 4; i++) eqOppHands[oppCount * 4 + i] = eqOpp[i];
            placed = true;
            break;
          }
          used = mark;
        }
        if (!placed) for (let i = 0; i < 4; i++) eqOppHands[oppCount * 4 + i] = drawOne();
      } else {
        for (let i = 0; i < perOpp; i++) eqOppHands[oppCount * 4 + i] = drawOne();
      }
      oppCount++;
    }

    for (let i = 0; i < needBoard; i++) eqBoard[board.length + i] = drawOne();

    let heroVal: number;
    if (variant === 'plo4') {
      heroVal = rankPlo(eqHero, eqBoard);
    } else {
      let k = 0;
      for (let i = 0; i < holeN; i++) eqCombo[k++] = eqHero[i];
      for (let i = 0; i < 5; i++) eqCombo[k++] = eqBoard[i];
      heroVal = rank7(eqCombo, k);
    }

    let bestOpp = -1;
    let ties = 0;
    for (let o = 0; o < oppCount; o++) {
      let v: number;
      if (variant === 'plo4') {
        for (let i = 0; i < 4; i++) eqOpp[i] = eqOppHands[o * 4 + i];
        v = rankPlo(eqOpp, eqBoard);
      } else {
        eqCombo[0] = eqOppHands[o * 4];
        eqCombo[1] = eqOppHands[o * 4 + 1];
        for (let i = 0; i < 5; i++) eqCombo[2 + i] = eqBoard[i];
        v = rank7(eqCombo, 7);
      }
      if (v > bestOpp) {
        bestOpp = v;
        ties = 1;
      } else if (v === bestOpp) {
        ties++;
      }
    }

    if (heroVal > bestOpp) score += 1;
    else if (heroVal === bestOpp) score += 1 / (ties + 1);
  }

  const eq = score / iters;
  if (eqCache.size > 4000) eqCache.clear();
  eqCache.set(key, { eq });
  return eq;
}

/** Drops the memoised equity table — call between sessions to bound memory. */
export function clearBotCaches(): void {
  eqCache.clear();
}

// ═══════════════════════════════════════════════════════════════════
// 4 — Board texture & hand reading
// ═══════════════════════════════════════════════════════════════════

export interface BoardTexture {
  paired: boolean;
  trips: boolean;
  monotone: boolean;
  twoTone: boolean;
  rainbow: boolean;
  /** 0..1 — how straight-heavy the board is */
  connected: number;
  /** rank index (0..12) of the highest board card */
  topRank: number;
  /** 0..1 — the single number the bots size and bluff off */
  wetness: number;
  flushPossible: boolean;
  straightPossible: boolean;
  /** how many broadway cards are out there */
  broadways: number;
}

const DRY_TEXTURE: BoardTexture = {
  paired: false, trips: false, monotone: false, twoTone: false, rainbow: true,
  connected: 0, topRank: 0, wetness: 0, flushPossible: false, straightPossible: false, broadways: 0,
};

export function analyzeBoard(board: readonly CardId[]): BoardTexture {
  if (board.length === 0) return DRY_TEXTURE;
  const suits = [0, 0, 0, 0];
  const counts = new Array(13).fill(0) as number[];
  let mask = 0;
  let topRank = 0;
  let broadways = 0;
  for (const c of board) {
    const r = c >> 2;
    suits[c & 3]++;
    counts[r]++;
    mask |= 1 << r;
    if (r > topRank) topRank = r;
    if (r >= 8) broadways++;
  }
  const maxSuit = Math.max(suits[0], suits[1], suits[2], suits[3]);
  const paired = counts.some((c) => c >= 2);
  const trips = counts.some((c) => c >= 3);

  // Straightiness measured over the ten real straight windows: a window
  // holding three board ranks is a genuine danger, two is a warning. This
  // reads T98 as soaked and K72 as bone dry, which is the whole point.
  let windows3 = 0;
  let windows2 = 0;
  for (let lo = 0; lo <= 9; lo++) {
    const window = lo === 9
      ? (1 << 12) | 0b1111 // A2345
      : (1 << lo) | (1 << (lo + 1)) | (1 << (lo + 2)) | (1 << (lo + 3)) | (1 << (lo + 4));
    const n = POP[mask & window];
    if (n >= 3) windows3++;
    else if (n === 2) windows2++;
  }
  const straightPossible = board.length >= 3 && STRAIGHT_HIGH[mask] >= 0;
  const connected = Math.min(1, windows3 * 0.28 + windows2 * 0.05);

  const flushPossible = maxSuit >= 3;
  const wetness = Math.min(
    1,
    (maxSuit >= 3 ? 0.42 : maxSuit === 2 ? 0.16 : 0) +
      connected * 0.45 +
      (straightPossible ? 0.2 : 0) +
      (broadways >= 2 ? 0.1 : 0) -
      (paired && !trips ? 0.05 : 0),
  );

  return {
    paired,
    trips,
    monotone: maxSuit >= 3 && board.length <= 3 ? maxSuit === board.length : maxSuit >= 4,
    twoTone: maxSuit === 2,
    rainbow: maxSuit <= 1,
    connected,
    topRank,
    wetness: Math.max(0, wetness),
    flushPossible,
    straightPossible,
    broadways,
  };
}

export interface HandRead {
  value: number;
  category: HandCategory;
  categoryIndex: number;
  /** hero's hand is exactly the board — no equity of its own */
  playingBoard: boolean;
  topPairOrBetter: boolean;
  overPair: boolean;
  flushDraw: boolean;
  nutFlushDraw: boolean;
  /** distinct ranks that complete a straight */
  straightOuts: number;
  oesd: boolean;
  gutshot: boolean;
  overcards: number;
  /** estimated clean outs for an unmade hand */
  outs: number;
  /** 0..1 — how much of the opponent's nutted range we hold */
  blockers: number;
}

export function analyzeHand(
  variant: GameVariant,
  hole: readonly CardId[],
  board: readonly CardId[],
): HandRead {
  const value = rankFor(variant, hole, board);
  const categoryIndex = Math.max(0, value >>> 20);
  const tex = analyzeBoard(board);

  let heroMask = 0;
  const heroSuits = [0, 0, 0, 0];
  let heroTop = 0;
  for (const c of hole) {
    heroMask |= 1 << (c >> 2);
    heroSuits[c & 3]++;
    if ((c >> 2) > heroTop) heroTop = c >> 2;
  }
  let boardMask = 0;
  const boardSuits = [0, 0, 0, 0];
  for (const c of board) {
    boardMask |= 1 << (c >> 2);
    boardSuits[c & 3]++;
  }
  const comboMask = heroMask | boardMask;

  const playingBoard = board.length >= 5 && rank7(board, board.length) === value;

  // Flush draw (needs a live turn/river)
  let flushDraw = false;
  let nutFlushDraw = false;
  if (board.length >= 3 && board.length < 5) {
    for (let s = 0; s < 4; s++) {
      const total = heroSuits[s] + boardSuits[s];
      if (total === 4 && heroSuits[s] >= 1) {
        flushDraw = true;
        // Nut draw iff hero holds a higher card of that suit than any card of
        // that suit still unaccounted for.
        let heroBest = -1;
        for (const c of hole) if ((c & 3) === s && c >> 2 > heroBest) heroBest = c >> 2;
        let missingBest = -1;
        for (let r = 12; r >= 0; r--) {
          const card = r * 4 + s;
          if (!hole.includes(card) && !board.includes(card)) {
            missingBest = r;
            break;
          }
        }
        if (heroBest > missingBest) nutFlushDraw = true;
      }
    }
  }

  // Straight outs — ranks that complete a straight that hero actually plays.
  let straightOuts = 0;
  if (board.length >= 3 && board.length < 5 && STRAIGHT_HIGH[comboMask] < 0) {
    for (let r = 0; r < 13; r++) {
      if (comboMask & (1 << r)) continue;
      const m = comboMask | (1 << r);
      const high = STRAIGHT_HIGH[m];
      if (high < 0) continue;
      const window = high === 3 && !(m & (1 << 4))
        ? (1 << 12) | 0b1111
        : (1 << high) | (1 << (high - 1)) | (1 << (high - 2)) | (1 << (high - 3)) | (1 << (high - 4));
      if (heroMask & window & ~boardMask) straightOuts++;
      else if (heroMask & window) straightOuts += 0.5;
    }
  }
  const oesd = straightOuts >= 2;
  const gutshot = straightOuts >= 1 && straightOuts < 2;

  let overcards = 0;
  for (const c of hole) if (board.length > 0 && c >> 2 > tex.topRank) overcards++;

  const pairIndex = categoryIndex;
  const topPairOrBetter =
    pairIndex >= CAT_TWO_PAIR ||
    (pairIndex === CAT_PAIR && (heroMask & (1 << tex.topRank)) !== 0) ||
    (pairIndex === CAT_PAIR && heroTop > tex.topRank && (heroMask & boardMask) === 0);
  const overPair =
    pairIndex === CAT_PAIR && hole.length >= 2 && (hole[0] >> 2) === (hole[1] >> 2) && (hole[0] >> 2) > tex.topRank;

  let outs = 0;
  if (pairIndex < CAT_TRIPS) {
    if (flushDraw) outs += 9;
    outs += Math.round(straightOuts * 4);
    if (flushDraw && straightOuts > 0) outs -= 2;
    if (pairIndex <= CAT_PAIR && overcards > 0 && !topPairOrBetter) outs += overcards * 2.5;
  }
  outs = Math.max(0, Math.round(outs));

  // Blockers — do we hold the cards their nutted range needs?
  let blockers = 0;
  if (tex.flushPossible) {
    for (let s = 0; s < 4; s++) {
      if (boardSuits[s] >= 3) {
        for (const c of hole) if ((c & 3) === s && c >> 2 >= 10) blockers += c >> 2 === 12 ? 0.5 : 0.25;
      }
    }
  }
  if (tex.straightPossible || tex.connected > 0.4) {
    const high = STRAIGHT_HIGH[boardMask | heroMask];
    if (high >= 0 && heroMask & (1 << high)) blockers += 0.2;
  }
  if (tex.topRank >= 0 && heroMask & (1 << tex.topRank)) blockers += 0.15;
  blockers = Math.min(1, blockers);

  return {
    value,
    category: CATEGORY_NAMES[categoryIndex],
    categoryIndex,
    playingBoard,
    topPairOrBetter,
    overPair,
    flushDraw,
    nutFlushDraw,
    straightOuts,
    oesd,
    gutshot,
    overcards,
    outs,
    blockers,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 5 — Personality
// ═══════════════════════════════════════════════════════════════════

export interface PersonalityTraits {
  /** multiplier applied to every preflop range width */
  rangeMul: number;
  /** how often a close spot resolves aggressively */
  aggression: number;
  /** base bluff frequency */
  bluff: number;
  /** when a hand is in range, how often it comes in raised rather than limped */
  openRaise: number;
  /** flop continuation-bet frequency on a neutral board */
  cbet: number;
  /** c-bet size as a fraction of the pot */
  cbetSize: number;
  /** 3-bet frequency multiplier */
  threeBet: number;
  /** willingness to call down light, 0..1 */
  callDown: number;
  /** how often monsters get slow-played */
  slowplay: number;
  /** check-raise frequency */
  checkRaise: number;
  /** float frequency in position */
  float: number;
  /** overbet propensity on polarised rivers */
  overbet: number;
  /** decision speed multiplier — >1 is faster than average */
  speed: number;
  /** random deviation from the plan */
  noise: number;
  /** how hard results move the tilt meter */
  tiltGain: number;
}

export const PERSONALITY_TRAITS: Record<Personality, PersonalityTraits> = {
  nit: {
    rangeMul: 0.62, aggression: 0.5, bluff: 0.05, openRaise: 0.93, cbet: 0.55, cbetSize: 0.5, threeBet: 0.45,
    callDown: 0.22, slowplay: 0.34, checkRaise: 0.05, float: 0.05, overbet: 0.02,
    speed: 1.15, noise: 0.12, tiltGain: 0.5,
  },
  tag: {
    rangeMul: 0.98, aggression: 0.72, bluff: 0.14, openRaise: 0.95, cbet: 0.68, cbetSize: 0.55, threeBet: 1.0,
    callDown: 0.38, slowplay: 0.18, checkRaise: 0.12, float: 0.16, overbet: 0.07,
    speed: 1.0, noise: 0.1, tiltGain: 0.7,
  },
  lag: {
    rangeMul: 1.3, aggression: 0.84, bluff: 0.27, openRaise: 0.92, cbet: 0.76, cbetSize: 0.58, threeBet: 1.6,
    callDown: 0.45, slowplay: 0.12, checkRaise: 0.2, float: 0.34, overbet: 0.16,
    speed: 0.85, noise: 0.16, tiltGain: 1.0,
  },
  station: {
    rangeMul: 1.55, aggression: 0.3, bluff: 0.04, openRaise: 0.14, cbet: 0.45, cbetSize: 0.45, threeBet: 0.35,
    callDown: 0.85, slowplay: 0.3, checkRaise: 0.04, float: 0.1, overbet: 0.02,
    speed: 1.3, noise: 0.22, tiltGain: 0.4,
  },
  maniac: {
    rangeMul: 2.1, aggression: 0.95, bluff: 0.42, openRaise: 0.97, cbet: 0.86, cbetSize: 0.72, threeBet: 2.4,
    callDown: 0.5, slowplay: 0.06, checkRaise: 0.22, float: 0.4, overbet: 0.3,
    speed: 0.6, noise: 0.3, tiltGain: 1.5,
  },
  pro: {
    rangeMul: 1.0, aggression: 0.78, bluff: 0.2, openRaise: 0.95, cbet: 0.64, cbetSize: 0.48, threeBet: 1.2,
    callDown: 0.42, slowplay: 0.22, checkRaise: 0.18, float: 0.26, overbet: 0.12,
    speed: 0.95, noise: 0.05, tiltGain: 0.5,
  },
};

/** Fraction of hands opened when the pot is unopened, by seat. */
const OPEN_BASE: Record<PositionName, number> = {
  UTG: 0.155, UTG1: 0.17, MP: 0.185, LJ: 0.205, HJ: 0.245, CO: 0.3, BTN: 0.46, SB: 0.42, BB: 0.55,
};
/** Positional multiplier for shove/defend widths. */
const POS_MUL: Record<PositionName, number> = {
  UTG: 0.6, UTG1: 0.68, MP: 0.76, LJ: 0.86, HJ: 0.98, CO: 1.14, BTN: 1.45, SB: 1.15, BB: 1.0,
};

// ═══════════════════════════════════════════════════════════════════
// 6 — Bot state
// ═══════════════════════════════════════════════════════════════════

export interface BotHandMemory {
  handId: number;
  preflopAggressor: boolean;
  cbetFlop: boolean;
  floatedFlop: boolean;
  barrels: number;
  /** committed to a multi-street bluff story at the flop */
  bluffPlan: boolean;
  slowPlaying: boolean;
  lastEquity: number;
  checkedThisStreet: Partial<Record<Street, boolean>>;
  showedAggression: boolean;
}

export interface BotState {
  profile: BotProfile;
  traits: PersonalityTraits;
  seat: number;
  rng: Rng;
  /** 0..1 — rises after coolers, widens ranges and speeds up decisions */
  tilt: number;
  /** hands played at this table, gates the "settling in" behaviour */
  handsPlayed: number;
  /** how aggressive this bot has looked recently, 0..1 */
  image: number;
  mem: BotHandMemory;
}

function freshMemory(handId: number): BotHandMemory {
  return {
    handId,
    preflopAggressor: false,
    cbetFlop: false,
    floatedFlop: false,
    barrels: 0,
    bluffPlan: false,
    slowPlaying: false,
    lastEquity: 0.5,
    checkedThisStreet: {},
    showedAggression: false,
  };
}

export function createBot(profile: BotProfile, seat: number, seed: number): BotState {
  return {
    profile,
    traits: PERSONALITY_TRAITS[profile.personality],
    seat,
    rng: new Rng((seed ^ (seat * 0x9e3779b1)) >>> 0),
    tilt: 0,
    handsPlayed: 0,
    image: 0.4,
    mem: freshMemory(-1),
  };
}

export function botBeginHand(bot: BotState, handId: number): void {
  bot.mem = freshMemory(handId);
  bot.handsPlayed++;
  bot.tilt *= 0.94; // tilt decays as the session goes on
}

export interface BotResultInfo {
  /** chips won (positive) or lost (negative) this hand */
  net: number;
  bigBlind: number;
  /** lost at showdown having been ahead — the classic tilt trigger */
  badBeat: boolean;
  wonAtShowdown: boolean;
}

export function botObserveResult(bot: BotState, info: BotResultInfo): void {
  const bbNet = info.net / Math.max(info.bigBlind, 1e-6);
  const t = bot.traits;
  if (info.badBeat) bot.tilt = Math.min(1, bot.tilt + 0.3 * t.tiltGain);
  else if (bbNet < -30) bot.tilt = Math.min(1, bot.tilt + 0.18 * t.tiltGain);
  else if (bbNet > 25) bot.tilt = Math.max(0, bot.tilt - 0.12);
  if (info.wonAtShowdown) bot.image = Math.min(1, bot.image + 0.08);
  bot.image = bot.image * 0.9 + (bot.mem.showedAggression ? 0.1 : 0.02);
}

// ═══════════════════════════════════════════════════════════════════
// 7 — Decision context & output
// ═══════════════════════════════════════════════════════════════════

export interface BotContext {
  variant: GameVariant;
  street: Street;
  handId: number;
  holeCards: readonly CardId[];
  /** the primary board; for double-board bomb pots see `boards` */
  board: readonly CardId[];
  boards?: readonly (readonly CardId[])[];
  /** total pot including every chip committed this hand */
  pot: number;
  /** chips required to continue (already capped at the bot's stack by the table) */
  toCall: number;
  stack: number;
  /** committed on the current street */
  committed: number;
  bb: number;
  ante: number;
  /** smallest legal total-commitment for a raise */
  minRaiseTo: number;
  /** largest legal total-commitment (all-in, or the pot-limit cap for PLO) */
  maxRaiseTo: number;
  canCheck: boolean;
  canRaise: boolean;
  position: PositionName;
  /** players who have not folded, including the bot */
  seatsInHand: number;
  /** opponents who still have chips behind */
  activeOpponents: number;
  /** how many players act after the bot on this street */
  playersToActAfter: number;
  preflopRaises: number;
  raisesThisStreet: number;
  /** aggressive actions opponents have taken after the flop */
  opponentPostflopBets: number;
  /** smallest stack that matters in this pot */
  effectiveStack: number;
  /** ≥1 — SNG bubble risk premium; 1 in cash games */
  icmPressure: number;
  isBombPot: boolean;
  /** chip granularity: 0.01 for cash, 1 for tournaments */
  chipUnit: number;
}

export interface BotDecision {
  kind: ActionKind;
  /** total street commitment after the action (raise-to semantics) */
  amount: number;
  /** how long the bot should appear to think, in ms */
  thinkMs: number;
  /** short strategy note — powers the replay/debug overlay */
  note: string;
  /** 0..1 — drives the subtle "certainty" tell in the seat HUD */
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════════
// 8 — Timing model
// ═══════════════════════════════════════════════════════════════════

interface TimingInput {
  kind: ActionKind;
  /** 0..1 — how close the decision was */
  difficulty: number;
  potBb: number;
  street: Street;
  facingBet: boolean;
}

function thinkTime(bot: BotState, t: TimingInput): number {
  const p = bot.traits;
  const r = bot.rng;
  let base: number;
  if (t.kind === 'fold' && !t.facingBet) base = 260;
  else if (t.kind === 'fold') base = t.difficulty < 0.2 ? 340 : 900;
  else if (t.kind === 'check') base = 520;
  else if (t.kind === 'call') base = 780;
  else base = 940;

  // Harder spots take longer, big pots take longer, later streets take longer.
  base *= 1 + t.difficulty * 1.9;
  base *= 1 + Math.min(1.1, t.potBb / 90);
  base *= t.street === 'river' ? 1.25 : t.street === 'turn' ? 1.1 : 1;
  base /= Math.max(0.4, p.speed * (1 + bot.tilt * 0.35));

  // The occasional genuine tank — rare, but it lands hard when it happens.
  const tankChance = 0.02 + t.difficulty * 0.11 + Math.min(0.08, t.potBb / 900);
  if (r.next() < tankChance) base += 2200 + r.next() * 5200;
  // …and the occasional instant, dismissive snap.
  else if (r.next() < 0.14 && t.difficulty < 0.35) base *= 0.42;

  const jitter = 1 + r.normal(0, 0.22);
  return Math.max(180, Math.min(11000, Math.round(base * Math.max(0.35, jitter))));
}

// ═══════════════════════════════════════════════════════════════════
// 9 — Helpers
// ═══════════════════════════════════════════════════════════════════

function quant(v: number, unit: number): number {
  if (unit <= 0) return v;
  const q = Math.round(v / unit) * unit;
  return Math.round(q * 1e6) / 1e6;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function iterFor(street: Street): number {
  switch (street) {
    case 'preflop':
      return 520;
    case 'flop':
      return 420;
    case 'turn':
      return 340;
    default:
      return 280;
  }
}

/** How wide the bot believes the opposition is, given the betting so far. */
export function estimateOpponentRange(ctx: BotContext): Range {
  let pct: number;
  if (ctx.preflopRaises >= 4) pct = 0.028;
  else if (ctx.preflopRaises === 3) pct = 0.05;
  else if (ctx.preflopRaises === 2) pct = 0.09;
  else if (ctx.preflopRaises === 1) pct = 0.22;
  else pct = 0.62;
  if (ctx.isBombPot) pct = 1;
  // Every postflop bet narrows them; multiway widens the "someone has it" tail.
  pct *= Math.pow(0.78, Math.min(4, ctx.opponentPostflopBets));
  if (ctx.seatsInHand > 2) pct = Math.min(1, pct * (1 + 0.08 * (ctx.seatsInHand - 2)));
  pct = clamp(pct, 0.02, 1);
  // A 3-bet+ range is polarised, not linear: premiums plus a band of suited
  // bluffs. Modelling it as "top X%" makes the bot fold far too much.
  if (ctx.preflopRaises >= 2 && !ctx.isBombPot) {
    return rangePolar(pct * 0.62, pct * 1.6, pct * 3.4, 0.5);
  }
  return rangeTop(pct);
}

const ploRanks = new Int32Array(4);
const ploSuitCount = new Int32Array(4);
const ploRankCount = new Int32Array(13);

/**
 * Raw Omaha starting-hand score. Rewards double-suitedness, high pairs and
 * rundowns; punishes trips, dangling low cards and three-of-a-suit.
 */
function plo4RawScore(hole: ArrayLike<number>): number {
  if (hole.length < 4) return 0;
  for (let i = 0; i < 4; i++) ploRanks[i] = hole[i] >> 2;
  ploRanks.sort();
  ploSuitCount[0] = ploSuitCount[1] = ploSuitCount[2] = ploSuitCount[3] = 0;
  for (let i = 0; i < 13; i++) ploRankCount[i] = 0;
  for (let i = 0; i < 4; i++) {
    ploSuitCount[hole[i] & 3]++;
    ploRankCount[hole[i] >> 2]++;
  }

  let score = 0;
  for (let r = 0; r < 13; r++) {
    const n = ploRankCount[r];
    if (n === 2) score += r >= 10 ? 6 : r >= 7 ? 3.2 : 1.4;
    else if (n >= 3) score -= 2.5;
  }
  let suitedPairs = 0;
  let trisuit = false;
  for (let s = 0; s < 4; s++) {
    if (ploSuitCount[s] === 2) suitedPairs++;
    if (ploSuitCount[s] >= 3) trisuit = true;
  }
  if (suitedPairs === 2) score += 4.5;
  else if (suitedPairs === 1) score += 2.4;
  if (trisuit) score -= 1.6;
  for (let i = 0; i < 4; i++) {
    if (hole[i] >> 2 === 12 && ploSuitCount[hole[i] & 3] >= 2) score += 2.2;
  }
  // ploRanks is ascending after sort(); measure the spread between neighbours.
  let gaps = 0;
  for (let i = 3; i > 0; i--) gaps += Math.min(4, ploRanks[i] - ploRanks[i - 1]);
  score += clamp(9 - gaps, 0, 7) * 0.85;
  for (let i = 0; i < 4; i++) if (ploRanks[i] >= 9) score += 0.9;
  return score;
}

/**
 * Empirical percentile table for Omaha hands. Built once from a fixed seed so
 * the mapping is deterministic — a hand-tuned formula alone produces a wildly
 * skewed distribution, and every range built on it comes out wrong.
 */
const PLO_QUANTILES = (() => {
  const rng = new Rng(0x0104a);
  const N = 4096;
  const scores = new Float64Array(N);
  const deck = new Int32Array(52);
  for (let i = 0; i < 52; i++) deck[i] = i;
  const hole = new Int32Array(4);
  for (let n = 0; n < N; n++) {
    for (let i = 0; i < 4; i++) {
      const j = i + rng.int(52 - i);
      const t = deck[j];
      deck[j] = deck[i];
      deck[i] = t;
      hole[i] = deck[i];
    }
    scores[n] = plo4RawScore(hole);
  }
  scores.sort();
  return scores;
})();

/** PLO preflop strength on the same 0..1 scale as Hold'em: 0 = premium. */
export function plo4Percentile(hole: ArrayLike<number>): number {
  if (hole.length < 4) return 0.6;
  const s = plo4RawScore(hole);
  let lo = 0;
  let hi = PLO_QUANTILES.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (PLO_QUANTILES[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return clamp((PLO_QUANTILES.length - lo) / PLO_QUANTILES.length, 0.004, 1);
}

function percentileOf(ctx: BotContext): number {
  return ctx.variant === 'plo4' ? plo4Percentile(ctx.holeCards) : handPercentile(ctx.holeCards);
}

// ═══════════════════════════════════════════════════════════════════
// 10 — Preflop
// ═══════════════════════════════════════════════════════════════════

function raiseTo(ctx: BotContext, target: number): number {
  return clamp(quant(target, ctx.chipUnit), ctx.minRaiseTo, ctx.maxRaiseTo);
}

function shouldJam(ctx: BotContext, target: number): boolean {
  // Anything that commits two thirds of the stack should just be a shove —
  // real players do this and it stops the bots leaving silly bets behind.
  return target >= ctx.committed + (ctx.stack + ctx.committed) * 0.68;
}

function decidePreflop(bot: BotState, ctx: BotContext): BotDecision {
  const t = bot.traits;
  const r = bot.rng;
  const pct = percentileOf(ctx);
  const stackBb = ctx.effectiveStack / ctx.bb;
  const wide = t.rangeMul * (1 + bot.tilt * 0.45) * (1 / Math.max(0.85, ctx.icmPressure));
  const pos = ctx.position;
  const facing = ctx.toCall > 0.0001;
  const potOdds = facing ? ctx.toCall / (ctx.pot + ctx.toCall) : 0;

  // ── Short-stack push/fold. Below ~13bb the game collapses into a shove game
  //    and playing it any other way looks broken.
  if (stackBb <= 13 && ctx.canRaise) {
    const jamWidth = facing
      ? clamp(0.055 + (13 - stackBb) * 0.012, 0.03, 0.2) * POS_MUL[pos] * wide
      : clamp(0.5 - stackBb * 0.028, 0.11, 0.5) * POS_MUL[pos] * wide;
    if (pct <= jamWidth) {
      const amt = ctx.maxRaiseTo;
      return {
        kind: 'allin',
        amount: amt,
        thinkMs: thinkTime(bot, { kind: 'raise', difficulty: 0.35, potBb: ctx.pot / ctx.bb, street: 'preflop', facingBet: facing }),
        note: `${stackBb.toFixed(0)}bb jam from ${pos}`,
        confidence: 0.7,
      };
    }
    if (!facing && ctx.canCheck) {
      return {
        kind: 'check',
        amount: ctx.committed,
        thinkMs: thinkTime(bot, { kind: 'check', difficulty: 0.1, potBb: ctx.pot / ctx.bb, street: 'preflop', facingBet: false }),
        note: 'short stack, checking option',
        confidence: 0.6,
      };
    }
    if (facing && pct <= jamWidth * 2.1 && potOdds < 0.22 && r.next() < 0.35) {
      return callDecision(bot, ctx, 0.4, 'short-stack price');
    }
    return foldDecision(bot, ctx, 0.15, 'short stack, no hand');
  }

  // ── Unopened pot
  if (ctx.preflopRaises === 0) {
    const open = clamp(OPEN_BASE[pos] * wide, 0.03, 0.92);
    const limpers = Math.max(0, Math.round((ctx.pot - ctx.bb * 1.5 - ctx.ante * ctx.seatsInHand) / ctx.bb));
    if (pct <= open && ctx.canRaise) {
      // Passive profiles come in for a limp far more often than they raise —
      // this is what actually separates a calling station's PFR from a TAG's.
      // The very top of anyone's range always comes in raised; below that the
      // profile decides whether it prefers a raise or a limp.
      const raiseIt = r.next() < t.openRaise || pct <= Math.min(open * 0.28, 0.06);
      if (raiseIt) {
        const sizeBb = (pos === 'SB' ? 3.0 : pos === 'BTN' ? 2.3 : 2.6) + limpers * 1.05 + (t.aggression - 0.7) * 0.7;
        const target = raiseTo(ctx, ctx.bb * Math.max(2, sizeBb));
        const jam = shouldJam(ctx, target);
        return {
          kind: jam ? 'allin' : 'raise',
          amount: jam ? ctx.maxRaiseTo : target,
          thinkMs: thinkTime(bot, { kind: 'raise', difficulty: (pct / Math.max(open, 1e-6)) * 0.5, potBb: ctx.pot / ctx.bb, street: 'preflop', facingBet: facing }),
          note: `open ${pos}`,
          confidence: clamp(1 - pct / Math.max(open, 1e-6), 0.2, 0.95),
        };
      }
      if (!ctx.canCheck) return callDecision(bot, ctx, 0.2, 'limp in');
    }
    if (ctx.canCheck) {
      return {
        kind: 'check',
        amount: ctx.committed,
        thinkMs: thinkTime(bot, { kind: 'check', difficulty: 0.05, potBb: ctx.pot / ctx.bb, street: 'preflop', facingBet: false }),
        note: 'check option',
        confidence: 0.5,
      };
    }
    // Limping: only the loose profiles do it, and only with hands that flop well.
    const limpWidth = open * (t.callDown > 0.6 ? 2.4 : 1.25);
    if (pct <= limpWidth && ctx.toCall <= ctx.bb * 1.2 && r.next() < (t.callDown > 0.6 ? 0.75 : 0.16)) {
      return callDecision(bot, ctx, 0.25, 'speculative call');
    }
    return foldDecision(bot, ctx, foldDifficulty(pct, open), 'out of range');
  }

  // ── Facing a raise
  const level = ctx.preflopRaises; // 1 = open, 2 = 3-bet, 3 = 4-bet, …
  const valuePct = clamp(
    (level === 1 ? 0.048 : level === 2 ? 0.024 : 0.013) * t.threeBet * wide,
    0.006,
    0.3,
  );
  const bluffFloor = level === 1 ? 0.11 : 0.06;
  const bluffCeil = level === 1 ? 0.3 : 0.16;
  const callPct = clamp(
    (level === 1 ? 0.12 : level === 2 ? 0.05 : 0.02) *
      wide *
      POS_MUL[pos] *
      (0.6 + t.callDown * 1.5) *
      (ctx.playersToActAfter === 0 ? 1.18 : 0.88),
    0.006,
    0.72,
  );

  const canReraise = ctx.canRaise && ctx.maxRaiseTo > ctx.minRaiseTo * 0.999;
  if (canReraise) {
    const isValue = pct <= valuePct;
    const isBluff =
      pct > bluffFloor &&
      pct <= bluffCeil &&
      r.next() < t.bluff * (ctx.playersToActAfter === 0 ? 1.5 : 0.8) * (1 + bot.tilt * 0.6);
    if (isValue || isBluff) {
      const mult = level === 1 ? (ctx.playersToActAfter === 0 ? 3.1 : 4.0) : 2.25;
      const target = raiseTo(ctx, (ctx.toCall + ctx.committed) * mult);
      const jam = shouldJam(ctx, target) || (level >= 3 && isValue);
      return {
        kind: jam ? 'allin' : 'raise',
        amount: jam ? ctx.maxRaiseTo : target,
        thinkMs: thinkTime(bot, { kind: 'raise', difficulty: isBluff ? 0.55 : 0.3, potBb: ctx.pot / ctx.bb, street: 'preflop', facingBet: true }),
        note: isValue ? `${level + 1}-bet value` : `${level + 1}-bet bluff`,
        confidence: isValue ? 0.85 : 0.35,
      };
    }
  }

  if (pct <= callPct) {
    return callDecision(bot, ctx, clamp(pct / callPct, 0.1, 0.9), 'defend');
  }
  // Set-mining / suited-connector calls when the stacks justify it.
  const deep = ctx.effectiveStack / Math.max(ctx.toCall, 1e-6) >= 14;
  if (deep && pct <= callPct * 1.7 && ctx.variant !== 'plo4' && r.next() < 0.3) {
    const gi = gridIndexOf(ctx.holeCards[0], ctx.holeCards[1]);
    const row = Math.floor(gi / 13);
    const col = gi % 13;
    const pair = row === col;
    const suitedRun = row < col && Math.abs(row - col) <= 2;
    if (pair || suitedRun) return callDecision(bot, ctx, 0.45, pair ? 'set mine' : 'implied odds');
  }
  return foldDecision(bot, ctx, foldDifficulty(pct, callPct), 'fold to raise');
}

function callDecision(bot: BotState, ctx: BotContext, difficulty: number, note: string): BotDecision {
  return {
    kind: 'call',
    amount: quant(ctx.committed + ctx.toCall, ctx.chipUnit),
    thinkMs: thinkTime(bot, { kind: 'call', difficulty, potBb: ctx.pot / ctx.bb, street: ctx.street, facingBet: true }),
    note,
    confidence: clamp(1 - difficulty, 0.15, 0.9),
  };
}

function foldDecision(bot: BotState, ctx: BotContext, difficulty: number, note: string): BotDecision {
  return {
    kind: 'fold',
    amount: 0,
    thinkMs: thinkTime(bot, { kind: 'fold', difficulty, potBb: ctx.pot / ctx.bb, street: ctx.street, facingBet: ctx.toCall > 0 }),
    note,
    confidence: clamp(1 - difficulty, 0.2, 0.95),
  };
}

/**
 * How agonising a fold is: 1 when the hand sits right on the threshold, ~0
 * when it is nowhere close. Folds that take four seconds should be the ones
 * that were nearly calls — everything else is a snap.
 */
function foldDifficulty(pct: number, threshold: number): number {
  const ratio = pct / Math.max(threshold, 1e-6);
  return clamp(1.05 - (ratio - 1) * 2, 0.05, 0.9);
}

function checkDecision(bot: BotState, ctx: BotContext, difficulty: number, note: string): BotDecision {
  bot.mem.checkedThisStreet[ctx.street] = true;
  return {
    kind: 'check',
    amount: ctx.committed,
    thinkMs: thinkTime(bot, { kind: 'check', difficulty, potBb: ctx.pot / ctx.bb, street: ctx.street, facingBet: false }),
    note,
    confidence: clamp(1 - difficulty, 0.2, 0.9),
  };
}

// ═══════════════════════════════════════════════════════════════════
// 11 — Postflop
// ═══════════════════════════════════════════════════════════════════

function betSizing(bot: BotState, ctx: BotContext, tex: BoardTexture, eq: number, bluff: boolean): number {
  const t = bot.traits;
  const r = bot.rng;
  let frac = t.cbetSize;
  if (tex.wetness > 0.55) frac += 0.16;
  if (tex.wetness < 0.25 && !bluff) frac -= 0.1;
  if (!bluff && eq > 0.82) frac += 0.16;
  if (bluff && ctx.street === 'river') frac += 0.12;
  if (ctx.seatsInHand > 2) frac += 0.08;
  if (ctx.street === 'river' && !bluff && eq > 0.9 && r.next() < t.overbet) frac += 0.55;
  if (bluff && r.next() < t.overbet * 0.6) frac += 0.35;
  frac *= 1 + r.normal(0, 0.09);
  frac = clamp(frac, 0.22, 2.0);
  const target = ctx.committed + ctx.pot * frac;
  return raiseTo(ctx, target);
}

function decidePostflop(bot: BotState, ctx: BotContext): BotDecision {
  const t = bot.traits;
  const r = bot.rng;
  const board = ctx.board;
  const tex = analyzeBoard(board);
  const read = analyzeHand(ctx.variant, ctx.holeCards, board);
  const oppRange = estimateOpponentRange(ctx);
  const opponents = Math.max(1, ctx.seatsInHand - 1);
  const eqRaw = equityVsRange(ctx.variant, ctx.holeCards, board, opponents, oppRange, iterFor(ctx.street), r);
  // Noise: nobody's read is perfect, and the sloppier profiles are sloppier.
  const eq = clamp(eqRaw + r.normal(0, t.noise * 0.06), 0, 1);
  bot.mem.lastEquity = eq;

  const potBb = ctx.pot / ctx.bb;
  const facing = ctx.toCall > 0.0001;
  const callCost = Math.min(ctx.toCall, ctx.stack);
  const potOdds = facing ? callCost / (ctx.pot + callCost) : 0;
  const spr = ctx.effectiveStack / Math.max(ctx.pot, ctx.bb);
  const inPosition = ctx.playersToActAfter === 0;
  const multiway = ctx.seatsInHand > 2;

  // Value thresholds scale with the field and with ICM pressure.
  const icm = clamp(ctx.icmPressure, 1, 2.2);
  const valueEq = clamp(0.56 + 0.055 * (opponents - 1) + (icm - 1) * 0.06, 0.5, 0.86);
  const raiseEq = clamp(0.66 + 0.05 * (opponents - 1) - tex.wetness * 0.04 + (icm - 1) * 0.08, 0.56, 0.92);

  if (facing) {
    // ── Facing a bet
    const strongDraw = read.outs >= 8 && ctx.street !== 'river';
    const impliedBonus = clamp(read.outs * 0.006 * clamp(spr, 0, 6), 0, 0.1);
    const stationBonus = t.callDown * 0.1;
    // Tight profiles over-fold; that leak is the point of playing them.
    const foldBias = (1 - t.callDown) * 0.055;
    const nutted = eq >= raiseEq;

    // Value raise (and the check-raise, when we already checked this street).
    const wasCheck = bot.mem.checkedThisStreet[ctx.street] === true;
    let aggFreq = t.aggression;
    if (wasCheck) aggFreq *= 0.6 + t.checkRaise * 2.2;
    if (ctx.canRaise && nutted && r.next() < clamp(aggFreq, 0.15, 0.97)) {
      if (read.categoryIndex >= CAT_TRIPS && spr > 3 && tex.wetness < 0.35 && r.next() < t.slowplay) {
        return callDecision(bot, ctx, 0.3, 'slow-play the nuts');
      }
      const target = betSizing(bot, ctx, tex, eq, false);
      const raiseAmt = Math.max(target, ctx.minRaiseTo);
      const jam = shouldJam(ctx, raiseAmt);
      bot.mem.showedAggression = true;
      return {
        kind: jam ? 'allin' : 'raise',
        amount: jam ? ctx.maxRaiseTo : raiseTo(ctx, raiseAmt),
        thinkMs: thinkTime(bot, { kind: 'raise', difficulty: 0.4, potBb, street: ctx.street, facingBet: true }),
        note: wasCheck ? 'check-raise for value' : 'raise for value',
        confidence: clamp(eq, 0.4, 0.98),
      };
    }

    // Semi-bluff raise with a real draw and fold equity.
    if (
      ctx.canRaise &&
      strongDraw &&
      !multiway &&
      spr > 1.2 &&
      r.next() < clamp(t.bluff * 1.9 + (wasCheck ? t.checkRaise : 0), 0.03, 0.6)
    ) {
      const target = betSizing(bot, ctx, tex, eq, true);
      const jam = shouldJam(ctx, target);
      bot.mem.showedAggression = true;
      bot.mem.bluffPlan = true;
      return {
        kind: jam ? 'allin' : 'raise',
        amount: jam ? ctx.maxRaiseTo : raiseTo(ctx, Math.max(target, ctx.minRaiseTo)),
        thinkMs: thinkTime(bot, { kind: 'raise', difficulty: 0.62, potBb, street: ctx.street, facingBet: true }),
        note: read.nutFlushDraw ? 'semi-bluff, nut draw' : 'semi-bluff raise',
        confidence: 0.45,
      };
    }

    // Call: pot odds plus implied odds plus how sticky this profile is.
    const need = potOdds * (1 + (icm - 1) * 0.35);
    // Later streets deserve more respect: ranges are stronger and there is
    // less to draw to, so the bar to continue rises with the street.
    const streetTax = ctx.street === 'river' ? 0.045 : ctx.street === 'turn' ? 0.025 : 0;
    const margin = (multiway ? 0.085 : 0.05) + streetTax + foldBias - impliedBonus - stationBonus;
    if (eq >= need + margin) {
      const difficulty = clamp(1 - (eq - need) * 5, 0.08, 0.95);
      if (ctx.canRaise && eq > valueEq && spr < 1.6 && r.next() < t.aggression * 0.55) {
        bot.mem.showedAggression = true;
        return {
          kind: 'allin',
          amount: ctx.maxRaiseTo,
          thinkMs: thinkTime(bot, { kind: 'raise', difficulty: 0.5, potBb, street: ctx.street, facingBet: true }),
          note: 'low SPR, get it in',
          confidence: clamp(eq, 0.4, 0.95),
        };
      }
      // Floating: take one off in position with backdoor equity, planning to
      // steal the turn if it checks through.
      if (ctx.street === 'flop' && inPosition && eq < valueEq && read.outs <= 6) bot.mem.floatedFlop = true;
      return callDecision(bot, ctx, difficulty, eq >= valueEq ? 'call for value' : 'call, price is right');
    }

    // Bluff-catch with blockers — the pros do it, the nits do not.
    if (
      read.blockers > 0.35 &&
      eq >= need * 0.82 &&
      ctx.street === 'river' &&
      r.next() < t.callDown * 0.55 + t.bluff * 0.4
    ) {
      return callDecision(bot, ctx, 0.85, 'bluff-catch with blockers');
    }
    return foldDecision(bot, ctx, clamp(1 - (need - eq) * 4, 0.05, 0.9), 'no price');
  }

  // ── Nobody has bet
  const cbetSpot = bot.mem.preflopAggressor && ctx.street === 'flop';
  const delayedSpot = bot.mem.preflopAggressor && ctx.street === 'turn' && !bot.mem.cbetFlop;
  const floatSpot = bot.mem.floatedFlop && ctx.street === 'turn';

  if (eq >= valueEq) {
    // Slow-play: only on dry boards, only deep, only sometimes.
    const monster = read.categoryIndex >= CAT_TRIPS || eq > 0.9;
    if (monster && tex.wetness < 0.35 && spr > 2.5 && !bot.mem.slowPlaying && r.next() < t.slowplay) {
      bot.mem.slowPlaying = true;
      return checkDecision(bot, ctx, 0.3, 'trap');
    }
    const target = betSizing(bot, ctx, tex, eq, false);
    const jam = shouldJam(ctx, target);
    bot.mem.showedAggression = true;
    if (ctx.street === 'flop' && bot.mem.preflopAggressor) bot.mem.cbetFlop = true;
    bot.mem.barrels++;
    return {
      kind: jam ? 'allin' : 'bet',
      amount: jam ? ctx.maxRaiseTo : target,
      thinkMs: thinkTime(bot, { kind: 'bet', difficulty: 0.24, potBb, street: ctx.street, facingBet: false }),
      note: 'value bet',
      confidence: clamp(eq, 0.45, 0.98),
    };
  }

  // Continuation / probe / float bets — the frequency work that makes bots
  // feel like people rather than a strength threshold.
  let bluffFreq = t.bluff;
  if (cbetSpot) bluffFreq = t.cbet * (1 - tex.wetness * 0.45) * (multiway ? 0.5 : 1);
  else if (delayedSpot) bluffFreq = t.cbet * 0.45;
  else if (floatSpot) bluffFreq = t.float * 1.6;
  else if (inPosition) bluffFreq = t.bluff * 1.25;
  if (bot.mem.bluffPlan) bluffFreq += 0.35; // follow through on the story
  if (read.outs >= 8) bluffFreq += 0.25; // semi-bluffs are free money
  if (read.blockers > 0.4) bluffFreq += 0.12;
  if (multiway) bluffFreq *= 0.45;
  if (ctx.street === 'river' && read.outs > 0) bluffFreq *= 0.8;
  bluffFreq *= 1 + bot.tilt * 0.5;
  bluffFreq /= icm;

  if (ctx.canRaise && ctx.stack > 0 && r.next() < clamp(bluffFreq, 0, 0.92)) {
    const target = betSizing(bot, ctx, tex, eq, true);
    const jam = shouldJam(ctx, target) && ctx.street === 'river' && r.next() < t.overbet;
    bot.mem.showedAggression = true;
    if (ctx.street === 'flop' && bot.mem.preflopAggressor) bot.mem.cbetFlop = true;
    if (ctx.street === 'flop') bot.mem.bluffPlan = r.next() < 0.45 + t.aggression * 0.3;
    bot.mem.barrels++;
    return {
      kind: jam ? 'allin' : 'bet',
      amount: jam ? ctx.maxRaiseTo : target,
      thinkMs: thinkTime(bot, { kind: 'bet', difficulty: 0.3, potBb, street: ctx.street, facingBet: false }),
      note: read.outs >= 8 ? 'semi-bluff barrel' : cbetSpot ? 'c-bet' : 'bluff',
      confidence: 0.32,
    };
  }

  return checkDecision(bot, ctx, 0.15, eq > 0.4 ? 'pot control' : 'give up');
}

// ═══════════════════════════════════════════════════════════════════
// 12 — Entry point
// ═══════════════════════════════════════════════════════════════════

/**
 * The one call the table driver makes. Pure with respect to the table: the
 * only mutation is inside the bot's own memory and RNG.
 */
export function decideBotAction(bot: BotState, ctx: BotContext): BotDecision {
  if (bot.mem.handId !== ctx.handId) botBeginHand(bot, ctx.handId);

  let d: BotDecision;
  if (ctx.street === 'preflop' && !ctx.isBombPot) d = decidePreflop(bot, ctx);
  else d = decidePostflop(bot, ctx);

  // Legality clamp — the table is authoritative, but a bot must never emit an
  // action the table would have to reject.
  if (d.kind === 'check' && ctx.toCall > 0.0001) d = foldDecision(bot, ctx, 0.2, 'cannot check');
  if ((d.kind === 'bet' || d.kind === 'raise') && !ctx.canRaise) {
    d = ctx.toCall > 0.0001 ? callDecision(bot, ctx, 0.3, 'raise unavailable') : checkDecision(bot, ctx, 0.2, 'raise unavailable');
  }
  if (d.kind === 'bet' || d.kind === 'raise') {
    d.amount = clamp(quant(d.amount, ctx.chipUnit), ctx.minRaiseTo, ctx.maxRaiseTo);
    if (d.amount >= ctx.committed + ctx.stack - 1e-9) d.kind = 'allin';
  }
  if (d.kind === 'allin') d.amount = ctx.maxRaiseTo;
  if (d.kind === 'call') {
    d.amount = quant(Math.min(ctx.committed + ctx.toCall, ctx.committed + ctx.stack), ctx.chipUnit);
    if (ctx.toCall >= ctx.stack - 1e-9) d.kind = 'allin';
  }
  if (d.kind === 'fold' && ctx.toCall <= 0.0001) d = checkDecision(bot, ctx, 0.1, 'free card');

  if (d.kind === 'raise' || d.kind === 'bet' || d.kind === 'allin') {
    bot.mem.showedAggression = true;
    if (ctx.street === 'preflop') bot.mem.preflopAggressor = true;
  }
  return d;
}

// ═══════════════════════════════════════════════════════════════════
// 13 — Table chatter
// ═══════════════════════════════════════════════════════════════════

export type ChatterTrigger = 'won-big' | 'lost-big' | 'bluff-shown' | 'bad-beat' | 'idle' | 'bomb';

const CHATTER: Record<Personality, Record<ChatterTrigger, readonly string[]>> = {
  nit: {
    'won-big': ['finally', 'took a while'],
    'lost-big': ['wow', 'unreal'],
    'bluff-shown': ['nice hand', 'sigh'],
    'bad-beat': ['every time', 'of course'],
    idle: ['nothing playable', 'card dead'],
    bomb: ['here we go'],
  },
  tag: {
    'won-big': ['gg', 'ty'],
    'lost-big': ['nh', 'well played'],
    'bluff-shown': ['nice', 'got me'],
    'bad-beat': ['brutal', 'wow ok'],
    idle: ['good table', 'nice structure'],
    bomb: ['bomb time', 'buckle up'],
  },
  lag: {
    'won-big': ['ship it', 'lets go'],
    'lost-big': ['fine, fine', 'rematch'],
    'bluff-shown': ['had to', 'you knew'],
    'bad-beat': ['lol', 'course you had it'],
    idle: ['someone open', 'so slow'],
    bomb: ['finally some action', 'bombs away'],
  },
  station: {
    'won-big': ['i knew it', 'called it'],
    'lost-big': ['had to look', 'worth it'],
    'bluff-shown': ['nice bluff', 'wow'],
    'bad-beat': ['ugh', 'seriously'],
    idle: ['deal already', 'lets play'],
    bomb: ['love these', 'yes'],
  },
  maniac: {
    'won-big': ['EASY', 'ship the pot'],
    'lost-big': ['again again', 'double me'],
    'bluff-shown': ['hahaha', 'obviously air'],
    'bad-beat': ['RIGGED', 'sure sure'],
    idle: ['speed it up', 'raise blind'],
    bomb: ['BOMB', 'all in dark'],
  },
  pro: {
    'won-big': ['gg', 'thanks'],
    'lost-big': ['nice hand', 'good spot'],
    'bluff-shown': ['well played', 'good sizing'],
    'bad-beat': ['standard', 'variance'],
    idle: ['gl all', 'nice run'],
    bomb: ['no fold equity here', 'flop it or drop it'],
  },
};

/** Occasional, in-character table talk. Returns null most of the time. */
export function botChatter(bot: BotState, trigger: ChatterTrigger): string | null {
  const t = bot.traits;
  const chance =
    trigger === 'idle' ? 0.02 * (1 + t.noise) : trigger === 'bomb' ? 0.14 : 0.18 + t.noise * 0.5 + bot.tilt * 0.3;
  if (bot.rng.next() > chance) return null;
  const lines = CHATTER[bot.profile.personality][trigger];
  return lines[bot.rng.int(lines.length)];
}

/** A compact strategy read the UI can show on the seat when revealing bots. */
export function describeBot(bot: BotState): string {
  const s = bot.profile.stats;
  return `${s.vpip.toFixed(0)}/${s.pfr.toFixed(0)} · AF ${s.af.toFixed(1)}`;
}
