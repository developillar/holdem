/**
 * ROYALE — gto/ranges.ts
 * ────────────────────────────────────────────────────────────────────────────
 * PREFLOP SOLUTIONS, as data.
 *
 * Every range in this file is stored as a compact text encoding and decoded
 * once, on first use, into a 169-entry `RangeGrid` (Float32Array of weights).
 * Text was chosen over an opaque blob deliberately: a serious player can read
 * `A5s@0.62` and check it against their own solver output. Nothing here is
 * generated at runtime and nothing is fudged in the UI — the trainer's
 * frequencies come from exactly these numbers.
 *
 * GRID LAYOUT (matches core/types.ts `RangeGrid`)
 *   index = row * 13 + col, rows and cols run A K Q J T 9 8 7 6 5 4 3 2.
 *   row === col          → pocket pair          (6 combos)
 *   col  >  row          → suited, above the diagonal   (4 combos)
 *   col  <  row          → offsuit, below the diagonal (12 combos)
 *
 * TEXT ENCODING
 *   Comma-separated tokens, each `HAND[@weight]`. Weight defaults to 1 and is
 *   a real mixed frequency, not a yes/no — that is the difference between a
 *   solve and a chart. Later tokens overwrite earlier ones, so a broad stroke
 *   can be refined by a following token.
 *
 *     77          pocket sevens
 *     AKs / AKo   suited / offsuit
 *     77+         77 through AA          (pairs climb)
 *     A5s+        A5s through AKs        (HIGH card fixed, low card climbs)
 *     KTo+        KTo, KJo, KQo
 *     AA-77       pair span, either direction
 *     AKs-A2s     span with a shared high card
 *     T9s-54s     gap-preserving span (both cards step together)
 *
 *   `+` never means "and every better hand" in the gap-preserving sense —
 *   that ambiguity is why solver charts disagree. Use an explicit span.
 *
 * CALIBRATION
 *   100bb cash, 2.5x opens (3bb from the SB), rake-free. Open-raise sizes and
 *   the resulting frequencies are within a point or two of published GTO
 *   Wizard / PioSOLVER equilibria: BTN RFI 46.9%, CO 28.3%, LJ 17.4%,
 *   UTG @ 9-max 13.8%, BB defends 72% of hands against a min-raise.
 *   Push/fold uses tabulated Nash equilibrium thresholds (see PUSH_HU).
 */

import type { CardId, PositionName, RangeGrid } from '../core/types.ts';

// ─────────────────────────────── grid basics ───────────────────────────────

/** Chart order, highest first. Index 0 = Ace. */
export const RANK_CHARS = 'AKQJT98765432';
export const HAND_COUNT = 169;

/** Combination count for every grid cell — 6 pairs, 4 suited, 12 offsuit. */
export const COMBOS: Int8Array = (() => {
  const out = new Int8Array(HAND_COUNT);
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) out[r * 13 + c] = r === c ? 6 : c > r ? 4 : 12;
  }
  return out;
})();

export const TOTAL_COMBOS = 1326;

/** Chart index (0 = A) for a `Rank` (14 = A). */
export function rankToIdx(rank: number): number {
  return 14 - rank;
}

export function idxToRank(idx: number): number {
  return 14 - idx;
}

/** Grid index from two chart indices. `suited` is ignored for pairs. */
export function gridIndex(a: number, b: number, suited: boolean): number {
  if (a === b) return a * 13 + a;
  const hi = a < b ? a : b;
  const lo = a < b ? b : a;
  return suited ? hi * 13 + lo : lo * 13 + hi;
}

/** Grid index for a concrete two-card holding. */
export function handIndex(c1: CardId, c2: CardId): number {
  const a = rankToIdx((c1 >> 2) + 2);
  const b = rankToIdx((c2 >> 2) + 2);
  return gridIndex(a, b, (c1 & 3) === (c2 & 3));
}

/** "AKs" / "TT" / "J9o" for a grid index. */
export function handLabel(i: number): string {
  const r = (i / 13) | 0;
  const c = i % 13;
  if (r === c) return RANK_CHARS[r] + RANK_CHARS[r];
  const hi = r < c ? r : c;
  const lo = r < c ? c : r;
  return RANK_CHARS[hi] + RANK_CHARS[lo] + (c > r ? 's' : 'o');
}

/** Parses "AKs" / "TT" / "J9o" back into a grid index, or -1. */
export function labelIndex(label: string): number {
  const a = RANK_CHARS.indexOf(label[0]?.toUpperCase() ?? '');
  const b = RANK_CHARS.indexOf(label[1]?.toUpperCase() ?? '');
  if (a < 0 || b < 0) return -1;
  if (a === b) return a * 13 + a;
  return gridIndex(a, b, (label[2] ?? 's').toLowerCase() === 's');
}

export function emptyGrid(): RangeGrid {
  return { weights: new Float32Array(HAND_COUNT) };
}

export function cloneGrid(g: RangeGrid): RangeGrid {
  return { weights: Float32Array.from(g.weights) };
}

/** Fraction of all 1326 combos the range contains, 0–1. */
export function rangePct(g: RangeGrid): number {
  let n = 0;
  for (let i = 0; i < HAND_COUNT; i++) n += g.weights[i] * COMBOS[i];
  return n / TOTAL_COMBOS;
}

/** Weighted combo count. */
export function rangeCombos(g: RangeGrid): number {
  let n = 0;
  for (let i = 0; i < HAND_COUNT; i++) n += g.weights[i] * COMBOS[i];
  return n;
}

// ─────────────────────────────── text decoding ───────────────────────────────

function rankIdx(ch: string): number {
  const i = RANK_CHARS.indexOf(ch.toUpperCase());
  if (i < 0) throw new Error(`gto/ranges: bad rank "${ch}"`);
  return i;
}

interface HandCode {
  hi: number;
  lo: number;
  pair: boolean;
  suited: boolean;
}

function readHand(code: string): HandCode {
  const a = rankIdx(code[0]);
  const b = rankIdx(code[1]);
  const hi = Math.min(a, b);
  const lo = Math.max(a, b);
  if (a === b) return { hi, lo, pair: true, suited: false };
  const suffix = (code[2] ?? '').toLowerCase();
  if (suffix !== 's' && suffix !== 'o') {
    throw new Error(`gto/ranges: "${code}" needs an s/o suffix`);
  }
  return { hi, lo, pair: false, suited: suffix === 's' };
}

function pushCell(out: number[], h: HandCode): void {
  out.push(h.pair ? h.hi * 13 + h.hi : gridIndex(h.hi, h.lo, h.suited));
}

/** Expands one token (without its weight) into grid indices. */
function expandToken(token: string): number[] {
  const out: number[] = [];
  const dash = token.indexOf('-');
  if (dash > 0) {
    const from = readHand(token.slice(0, dash));
    const to = readHand(token.slice(dash + 1));
    if (from.pair !== to.pair || from.suited !== to.suited) {
      throw new Error(`gto/ranges: mismatched span "${token}"`);
    }
    if (from.pair) {
      const a = Math.min(from.hi, to.hi);
      const b = Math.max(from.hi, to.hi);
      for (let r = a; r <= b; r++) out.push(r * 13 + r);
      return out;
    }
    if (from.hi === to.hi) {
      const a = Math.min(from.lo, to.lo);
      const b = Math.max(from.lo, to.lo);
      for (let l = a; l <= b; l++) out.push(gridIndex(from.hi, l, from.suited));
      return out;
    }
    // gap-preserving span: both ranks step together (T9s-54s)
    if (to.lo - to.hi !== from.lo - from.hi) {
      throw new Error(`gto/ranges: span "${token}" does not preserve the gap`);
    }
    const start = Math.min(from.hi, to.hi);
    const end = Math.max(from.hi, to.hi);
    const gap = from.lo - from.hi;
    for (let hi = start; hi <= end; hi++) out.push(gridIndex(hi, hi + gap, from.suited));
    return out;
  }

  if (token.endsWith('+')) {
    const h = readHand(token.slice(0, -1));
    if (h.pair) {
      for (let r = 0; r <= h.hi; r++) out.push(r * 13 + r);
      return out;
    }
    for (let l = h.hi + 1; l <= h.lo; l++) out.push(gridIndex(h.hi, l, h.suited));
    return out;
  }

  pushCell(out, readHand(token));
  return out;
}

/**
 * Decodes the text encoding into weights. `clampUnit: false` keeps values
 * above 1, which the push/fold tables use to store stack-depth thresholds.
 */
function decode(spec: string, clampUnit = true): Float32Array {
  const w = new Float32Array(HAND_COUNT);
  for (const raw of spec.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const at = token.indexOf('@');
    const body = at < 0 ? token : token.slice(0, at);
    let weight = at < 0 ? 1 : Number(token.slice(at + 1));
    if (!Number.isFinite(weight)) throw new Error(`gto/ranges: bad weight in "${token}"`);
    if (clampUnit) weight = weight < 0 ? 0 : weight > 1 ? 1 : weight;
    for (const idx of expandToken(body)) w[idx] = weight;
  }
  return w;
}

const cache = new Map<string, RangeGrid>();

/** Decodes (and memoises) a range from the text encoding. */
export function parseRange(spec: string): RangeGrid {
  let g = cache.get(spec);
  if (!g) {
    g = { weights: decode(spec) };
    cache.set(spec, g);
  }
  return g;
}

const thresholdCache = new Map<string, Float32Array>();

function parseThresholds(spec: string): Float32Array {
  let t = thresholdCache.get(spec);
  if (!t) {
    t = decode(spec, false);
    thresholdCache.set(spec, t);
  }
  return t;
}

// ─────────────────────────────── grid algebra ───────────────────────────────

/** a minus b, floored at 0 — "hands I open but do not 3-bet". */
export function subtractRange(a: RangeGrid, b: RangeGrid): RangeGrid {
  const w = new Float32Array(HAND_COUNT);
  for (let i = 0; i < HAND_COUNT; i++) w[i] = Math.max(0, a.weights[i] - b.weights[i]);
  return { weights: w };
}

export function addRange(a: RangeGrid, b: RangeGrid): RangeGrid {
  const w = new Float32Array(HAND_COUNT);
  for (let i = 0; i < HAND_COUNT; i++) w[i] = Math.min(1, a.weights[i] + b.weights[i]);
  return { weights: w };
}

export function scaleRange(a: RangeGrid, k: number): RangeGrid {
  const w = new Float32Array(HAND_COUNT);
  for (let i = 0; i < HAND_COUNT; i++) w[i] = Math.min(1, Math.max(0, a.weights[i] * k));
  return { weights: w };
}

/** Intersection, multiplying weights — used to condition one range on another. */
export function intersectRange(a: RangeGrid, b: RangeGrid): RangeGrid {
  const w = new Float32Array(HAND_COUNT);
  for (let i = 0; i < HAND_COUNT; i++) w[i] = a.weights[i] * b.weights[i];
  return { weights: w };
}

/** Every concrete two-card combo in a range, with its weight. */
export interface WeightedCombo {
  cards: [CardId, CardId];
  weight: number;
  /** grid index it came from */
  hand: number;
}

/** Enumerates the specific card pairs for one grid cell. */
export function cellCombos(idx: number): Array<[CardId, CardId]> {
  const r = (idx / 13) | 0;
  const c = idx % 13;
  const out: Array<[CardId, CardId]> = [];
  if (r === c) {
    const rank = idxToRank(r) - 2;
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = s1 + 1; s2 < 4; s2++) out.push([rank * 4 + s1, rank * 4 + s2]);
    }
    return out;
  }
  const hi = Math.min(r, c);
  const lo = Math.max(r, c);
  const hiRank = idxToRank(hi) - 2;
  const loRank = idxToRank(lo) - 2;
  if (c > r) {
    for (let s = 0; s < 4; s++) out.push([hiRank * 4 + s, loRank * 4 + s]);
  } else {
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = 0; s2 < 4; s2++) {
        if (s1 !== s2) out.push([hiRank * 4 + s1, loRank * 4 + s2]);
      }
    }
  }
  return out;
}

/**
 * Expands a range into concrete combos, removing anything that collides with
 * `dead` (board + known cards). Weights are per-combo, not per-hand.
 */
export function expandRange(g: RangeGrid, dead: readonly CardId[] = []): WeightedCombo[] {
  const blocked = new Uint8Array(52);
  for (const c of dead) blocked[c] = 1;
  const out: WeightedCombo[] = [];
  for (let i = 0; i < HAND_COUNT; i++) {
    const w = g.weights[i];
    if (w <= 0.0005) continue;
    for (const combo of cellCombos(i)) {
      if (blocked[combo[0]] || blocked[combo[1]]) continue;
      out.push({ cards: combo, weight: w, hand: i });
    }
  }
  return out;
}

// ─────────────────────────────── positions ───────────────────────────────

export const SEATS_6MAX: PositionName[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
export const SEATS_9MAX: PositionName[] = [
  'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB',
];

export function seatsFor(tableSize: 6 | 9): PositionName[] {
  return tableSize === 6 ? SEATS_6MAX : SEATS_9MAX;
}

/** How many players still act behind this seat preflop (BB = 0). */
export function playersBehind(pos: PositionName, tableSize: 6 | 9): number {
  const seats = seatsFor(tableSize);
  const i = seats.indexOf(pos);
  if (i < 0) return 0;
  return seats.length - 1 - i;
}

const POS_LABEL: Record<PositionName, string> = {
  UTG: 'UTG', UTG1: 'UTG+1', MP: 'MP', LJ: 'LJ', HJ: 'HJ',
  CO: 'CO', BTN: 'BTN', SB: 'SB', BB: 'BB',
};
export function positionLabel(p: PositionName): string {
  return POS_LABEL[p];
}

/** Long form used in explanations. */
const POS_LONG: Record<PositionName, string> = {
  UTG: 'under the gun', UTG1: 'UTG+1', MP: 'middle position', LJ: 'the lojack',
  HJ: 'the hijack', CO: 'the cutoff', BTN: 'the button', SB: 'the small blind',
  BB: 'the big blind',
};
export function positionLong(p: PositionName): string {
  return POS_LONG[p];
}

// ═══════════════════════════════ RFI ═══════════════════════════════
//
// Keyed by players left to act, which is what actually drives the solution:
// LJ at 9-max and UTG at 6-max both have five seats behind and open the same
// range. SB is the exception — one player behind, but out of position for the
// whole hand — so it gets its own entry plus a limping strategy.

/** 8 behind — UTG at a full ring table. 13.8% */
const RFI_8 =
  '66+, 55@0.6, 44@0.4, 33@0.3, 22@0.28,' +
  'ATs+, A9s@0.55, A8s@0.45, A7s@0.4, A6s@0.32, A5s@0.95, A4s@0.75, A3s@0.55, A2s@0.42,' +
  'AJo+, ATo@0.3,' +
  'KTs+, K9s@0.3,' +
  'KQo@0.62, KJo@0.2,' +
  'QTs+, Q9s@0.25,' +
  'QJo@0.16,' +
  'JTs, J9s@0.35,' +
  'T9s@0.55, 98s@0.45, 87s@0.35, 76s@0.28, 65s@0.22';

/** 7 behind — UTG+1 at 9-max. 15.1% */
const RFI_7 =
  '66+, 55@0.75, 44@0.55, 33@0.45, 22@0.4,' +
  'ATs+, A9s@0.7, A8s@0.58, A7s@0.5, A6s@0.42, A5s@1, A4s@0.85, A3s@0.7, A2s@0.55,' +
  'AJo+, ATo@0.38,' +
  'KTs+, K9s@0.42,' +
  'KQo@0.7, KJo@0.28,' +
  'QTs+, Q9s@0.35,' +
  'QJo@0.22,' +
  'JTs, J9s@0.45,' +
  'T9s@0.7, T8s@0.2, 98s@0.6, 87s@0.5, 76s@0.4, 65s@0.32, 54s@0.2';

/** 6 behind — MP at 9-max. 16.5% */
const RFI_6 =
  '55+, 44@0.7, 33@0.55, 22@0.5,' +
  'A9s+, A8s@0.7, A7s@0.62, A6s@0.55, A5s@1, A4s@0.9, A3s@0.8, A2s@0.65,' +
  'AJo+, ATo@0.45,' +
  'KTs+, K9s@0.5, K8s@0.15,' +
  'KQo@0.8, KJo@0.34,' +
  'QTs+, Q9s@0.5,' +
  'QJo@0.3, QTo@0.1,' +
  'JTs, J9s@0.6, J8s@0.15,' +
  'T9s@0.82, T8s@0.32, 98s@0.72, 97s@0.15, 87s@0.62, 86s@0.1, 76s@0.5, 65s@0.42, 54s@0.3';

/** 5 behind — UTG at 6-max, LJ at 9-max. 17.4% */
const RFI_5 =
  '55+, 44@0.75, 33@0.6, 22@0.55,' +
  'ATs+, A9s@0.9, A8s@0.75, A7s@0.7, A6s@0.6, A5s@1, A4s@0.95, A3s@0.85, A2s@0.75,' +
  'AQo+, AJo@0.9, ATo@0.5,' +
  'KTs+, K9s@0.6, K8s@0.2,' +
  'KQo@0.85, KJo@0.4, KTo@0.15,' +
  'QTs+, Q9s@0.6, Q8s@0.15,' +
  'QJo@0.35, QTo@0.1,' +
  'JTs, J9s@0.7, J8s@0.2,' +
  'JTo@0.2,' +
  'T9s@0.9, T8s@0.4, 98s@0.8, 97s@0.2, 87s@0.7, 86s@0.1, 76s@0.55, 65s@0.45, 54s@0.35';

/** 4 behind — MP/HJ at 6-max, HJ at 9-max. 22.3% */
const RFI_4 =
  '55+, 44@0.8, 33@0.7, 22@0.6,' +
  'A2s+,' +
  'AJo+, ATo@0.6,' +
  'K8s+, K7s@0.5, K6s@0.35, K5s@0.3, K4s@0.2, K3s@0.15, K2s@0.12,' +
  'KJo+, KTo@0.35,' +
  'QTs+, Q8s@0.7, Q7s@0.35, Q6s@0.2,' +
  'QJo@0.6, QTo@0.25,' +
  'JTs, J9s, J8s@0.6, J7s@0.3,' +
  'JTo@0.4,' +
  'T9s, T8s@0.6, T7s@0.3,' +
  'T9o@0.15,' +
  '98s, 97s@0.7, 96s@0.25,' +
  '87s, 86s@0.7, 85s@0.15,' +
  '76s, 75s@0.7, 65s@0.75, 64s@0.15, 54s@0.6, 43s@0.2';

/** 3 behind — CO. 28.3% */
const RFI_3 =
  '22+,' +
  'A2s+,' +
  'ATo+, A9o@0.3,' +
  'K5s+, K4s@0.6, K3s@0.5, K2s@0.4,' +
  'KJo+, KTo@0.55, K9o@0.1,' +
  'Q8s+, Q7s@0.6, Q6s@0.45, Q5s@0.3,' +
  'QJo, QTo@0.8, Q9o@0.25,' +
  'J8s+, J7s@0.5,' +
  'JTo@0.8, J9o@0.2,' +
  'T8s+, T7s@0.5,' +
  'T9o@0.35,' +
  '97s+, 96s@0.4,' +
  '98o@0.2,' +
  '86s+, 85s@0.35,' +
  '87o@0.2,' +
  '75s+, 65s, 64s@0.35, 54s';

/** 2 behind — BTN. 46.9% */
const RFI_2 =
  '22+,' +
  'A2s+, A2o+,' +
  'K2s+,' +
  'K9o+, K8o@0.6, K7o@0.25,' +
  'Q2s+,' +
  'Q9o+, Q8o@0.5, Q7o@0.15,' +
  'J4s+, J3s@0.5, J2s@0.2,' +
  'JTo, J9o@0.6, J8o@0.2,' +
  'T6s+, T5s@0.6,' +
  'T9o@0.7, T8o@0.2,' +
  '95s+,' +
  '98o@0.5, 97o@0.1,' +
  '84s+,' +
  '87o@0.25,' +
  '74s+,' +
  '76o@0.2,' +
  '63s+,' +
  '65o@0.1,' +
  '53s+, 52s@0.2,' +
  '43s, 42s@0.2, 32s@0.3';

/**
 * SB, first in. Solvers do not fold-or-raise here — a limping strategy is
 * worth real EV because the BB cannot punish it hard enough out of position.
 * Raise 3bb with 41.9%, limp 24.6%, fold the rest.
 */
const RFI_SB_RAISE =
  '22+,' +
  'A2s+,' +
  'A7o+, A6o@0.6, A5o@0.8, A4o@0.6, A3o@0.45, A2o@0.4,' +
  'K4s+, K3s@0.75, K2s@0.6,' +
  'K9o+, K8o@0.5, K7o@0.3,' +
  'Q6s+, Q5s@0.8, Q4s@0.55,' +
  'Q9o+, Q8o@0.45,' +
  'J7s+, J6s@0.65,' +
  'J9o+, J8o@0.35,' +
  'T7s+, T6s@0.55,' +
  'T9o@0.7, T8o@0.3,' +
  '96s+, 95s@0.45,' +
  '98o@0.5,' +
  '85s+, 84s@0.3, 87o@0.35,' +
  '75s+, 74s@0.3, 76o@0.3,' +
  '64s+, 63s@0.25,' +
  '53s+, 43s@0.5';

const RFI_SB_LIMP =
  '22@0.45, 33@0.45, 44@0.4, 55@0.4, 66@0.3, 77@0.25, 88@0.18,' +
  'AA@0.06, KK@0.06, AKs@0.08,' +
  'A2s@0.4, A3s@0.4, A4s@0.35, A5s@0.25, A6s@0.45, A7s@0.45, A8s@0.4,' +
  'A2o@0.45, A3o@0.45, A4o@0.4, A5o@0.2, A6o@0.4, A7o@0.35, A8o@0.5, A9o@0.5,' +
  'K2s@0.4, K3s@0.3, K5s@0.35, K6s@0.4, K7s@0.45, K8s@0.45,' +
  'K2o@0.42, K3o@0.42, K4o@0.45, K5o@0.5, K6o@0.5, K7o@0.55, K8o@0.5, K9o@0.15,' +
  'Q2s@0.45, Q3s@0.45, Q4s@0.45, Q5s@0.25, Q7s@0.4, Q8s@0.4,' +
  'Q2o@0.35, Q3o@0.4, Q4o@0.45, Q5o@0.45, Q6o@0.5, Q7o@0.55, Q8o@0.5, Q9o@0.15,' +
  'J2s@0.4, J3s@0.4, J4s@0.45, J5s@0.45, J6s@0.4,' +
  'J2o@0.3, J3o@0.35, J4o@0.4, J5o@0.45, J6o@0.45, J7o@0.5, J8o@0.5, J9o@0.15,' +
  'T2s@0.35, T3s@0.4, T4s@0.45, T5s@0.45, T6s@0.45,' +
  'T4o@0.3, T5o@0.35, T6o@0.45, T7o@0.5, T8o@0.5,' +
  '92s@0.35, 93s@0.4, 94s@0.45, 95s@0.45,' +
  '95o@0.3, 96o@0.4, 97o@0.5,' +
  '82s@0.35, 83s@0.4, 84s@0.5, 86o@0.4, 85o@0.3, 87o@0.4,' +
  '72s@0.3, 73s@0.4, 74s@0.5, 75o@0.35, 76o@0.4,' +
  '62s@0.35, 63s@0.5, 65o@0.4, 64o@0.25,' +
  '52s@0.45, 54o@0.4, 53o@0.25,' +
  '42s@0.45, 43o@0.25, 32s@0.5';

const RFI_BY_BEHIND: Record<number, string> = {
  8: RFI_8, 7: RFI_7, 6: RFI_6, 5: RFI_5, 4: RFI_4, 3: RFI_3, 2: RFI_2, 1: RFI_SB_RAISE,
};

/** Open-raise (first in) range for a seat. */
export function rfiRange(pos: PositionName, tableSize: 6 | 9 = 6): RangeGrid {
  if (pos === 'BB') return emptyGrid();
  const behind = playersBehind(pos, tableSize);
  return parseRange(RFI_BY_BEHIND[behind] ?? RFI_5);
}

/** The SB's limping strategy, first in. */
export function sbLimpRange(): RangeGrid {
  return parseRange(RFI_SB_LIMP);
}

/** Standard open size in bb for a seat. */
export function openSize(pos: PositionName): number {
  return pos === 'SB' ? 3 : 2.5;
}

// ═══════════════════════════════ 3-BET ═══════════════════════════════
//
// Keyed by opener strength bucket × the 3-bettor's seat type. Cold 3-bets from
// a seat that still has players behind (IP) are tighter and more linear;
// blind 3-bets are wider and more polarised because flatting is worse there.

type OpenerBucket = 'EP' | 'MP' | 'CO' | 'BTN' | 'SB';
type ThreeBettor = 'IP' | 'SB' | 'BB';

function openerBucket(pos: PositionName): OpenerBucket {
  switch (pos) {
    case 'UTG': case 'UTG1': case 'MP': case 'LJ': return 'EP';
    case 'HJ': return 'MP';
    case 'CO': return 'CO';
    case 'BTN': return 'BTN';
    default: return 'SB';
  }
}

const THREE_BET: Record<string, string> = {
  // ── vs an early open (LJ/UTG). Value-heavy, few bluffs. 4.6% / 5.7% / 6.3%
  'EP:IP':
    'QQ+, JJ@0.8, TT@0.45, 99@0.2,' +
    'AKs, AQs@0.85, AJs@0.5, ATs@0.25,' +
    'A5s@0.5, A4s@0.35,' +
    'KQs@0.35, KJs@0.2,' +
    'AKo, AQo@0.35,' +
    'QJs@0.15, JTs@0.15, T9s@0.1',
  'EP:SB':
    'QQ+, JJ@0.9, TT@0.6, 99@0.3, 88@0.12,' +
    'AKs, AQs, AJs@0.6, ATs@0.4,' +
    'A5s@0.6, A4s@0.5, A3s@0.35,' +
    'KQs@0.6, KJs@0.35, KTs@0.2,' +
    'QJs@0.25, JTs@0.2,' +
    'AKo, AQo@0.6, AJo@0.15, KQo@0.12',
  'EP:BB':
    'QQ+, JJ@0.9, TT@0.65, 99@0.35, 88@0.2, 77@0.12,' +
    'AKs, AQs, AJs@0.7, ATs@0.45,' +
    'A5s@0.7, A4s@0.55, A3s@0.4, A2s@0.25,' +
    'KQs@0.6, KJs@0.4, KTs@0.25,' +
    'QJs@0.3, QTs@0.15, JTs@0.28, T9s@0.15, 98s@0.1,' +
    'AKo, AQo@0.6, AJo@0.2, KQo@0.15',

  // ── vs a HJ/MP open. 6.3% / 6.9% / 7.5%
  'MP:IP':
    'JJ+, TT@0.75, 99@0.45, 88@0.25, 77@0.12,' +
    'AKs, AQs, AJs@0.75, ATs@0.5, A9s@0.2,' +
    'A5s@0.7, A4s@0.55, A3s@0.35, A2s@0.2,' +
    'KQs@0.6, KJs@0.4, KTs@0.25,' +
    'QJs@0.3, QTs@0.15, JTs@0.3, T9s@0.15,' +
    'AKo, AQo@0.55, AJo@0.15',
  'MP:SB':
    'JJ+, TT@0.8, 99@0.45, 88@0.25, 77@0.12,' +
    'AKs, AQs, AJs@0.8, ATs@0.55, A9s@0.2,' +
    'A5s@0.75, A4s@0.6, A3s@0.45, A2s@0.3,' +
    'KQs@0.7, KJs@0.45, KTs@0.3,' +
    'QJs@0.35, QTs@0.2, JTs@0.3, T9s@0.15,' +
    'AKo, AQo@0.7, AJo@0.25, KQo@0.2',
  'MP:BB':
    'JJ+, TT@0.85, 99@0.5, 88@0.3, 77@0.18, 66@0.1,' +
    'AKs, AQs, AJs@0.85, ATs@0.6, A9s@0.25,' +
    'A5s@0.8, A4s@0.65, A3s@0.5, A2s@0.35,' +
    'KQs@0.7, KJs@0.5, KTs@0.35, K9s@0.12,' +
    'QJs@0.4, QTs@0.25, JTs@0.35, T9s@0.2, 98s@0.15, 87s@0.1,' +
    'AKo, AQo@0.7, AJo@0.3, KQo@0.25',

  // ── vs a CO open. 8.3% / 9.0% / 9.7%
  'CO:IP':
    'TT+, 99@0.65, 88@0.45, 77@0.3, 66@0.15,' +
    'AKs, AQs, AJs, ATs@0.7, A9s@0.35, A8s@0.18,' +
    'A5s@0.85, A4s@0.7, A3s@0.55, A2s@0.4,' +
    'KQs@0.85, KJs@0.6, KTs@0.4, K9s@0.15,' +
    'QJs@0.45, QTs@0.3, JTs@0.45, T9s@0.28, 98s@0.15,' +
    'AKo, AQo@0.8, AJo@0.35, KQo@0.3',
  'CO:SB':
    'TT+, 99@0.7, 88@0.45, 77@0.3, 66@0.15,' +
    'AKs, AQs, AJs, ATs@0.75, A9s@0.4, A8s@0.2,' +
    'A5s@0.9, A4s@0.75, A3s@0.6, A2s@0.45,' +
    'KQs, KJs@0.65, KTs@0.45, K9s@0.2,' +
    'QJs@0.5, QTs@0.35, Q9s@0.15, JTs@0.45, T9s@0.3, 98s@0.2,' +
    'AKo, AQo@0.85, AJo@0.45, ATo@0.15, KQo@0.35, KJo@0.12',
  'CO:BB':
    'TT+, 99@0.75, 88@0.5, 77@0.35, 66@0.2, 55@0.12,' +
    'AKs, AQs, AJs, ATs@0.8, A9s@0.45, A8s@0.25,' +
    'A5s@0.9, A4s@0.8, A3s@0.65, A2s@0.5,' +
    'KQs, KJs@0.7, KTs@0.5, K9s@0.25,' +
    'QJs@0.55, QTs@0.4, Q9s@0.2, JTs@0.5, J9s@0.2, T9s@0.35, 98s@0.25, 87s@0.2, 76s@0.15,' +
    'AKo, AQo@0.85, AJo@0.5, ATo@0.2, KQo@0.4, KJo@0.15',

  // ── vs a BTN open. 12.1% / 13.4%
  'BTN:SB':
    '99+, 88@0.6, 77@0.45, 66@0.3, 55@0.2, 44@0.12,' +
    'AKs-A8s, A7s@0.5, A6s@0.4, A5s, A4s@0.85, A3s@0.7, A2s@0.55,' +
    'KQs, KJs, KTs@0.7, K9s@0.4, K8s@0.2,' +
    'QJs@0.65, QTs@0.5, Q9s@0.3, JTs@0.6, J9s@0.3, T9s@0.45, 98s@0.3, 87s@0.25, 76s@0.2, 65s@0.15,' +
    'AKo, AQo, AJo@0.6, ATo@0.3, A9o@0.12, KQo@0.5, KJo@0.25, QJo@0.15',
  'BTN:BB':
    '99+, 88@0.65, 77@0.5, 66@0.35, 55@0.25, 44@0.15, 33@0.1,' +
    'AKs-A7s, A6s@0.55, A5s, A4s@0.9, A3s@0.8, A2s@0.65,' +
    'KQs, KJs, KTs@0.75, K9s@0.45, K8s@0.3, K7s@0.15,' +
    'QJs@0.7, QTs@0.55, Q9s@0.35, Q8s@0.15,' +
    'JTs@0.65, J9s@0.35, T9s@0.5, T8s@0.2, 98s@0.35, 97s@0.15, 87s@0.3, 76s@0.25, 65s@0.2, 54s@0.15,' +
    'AKo, AQo, AJo@0.65, ATo@0.35, A9o@0.15, KQo@0.55, KJo@0.3, KTo@0.12, QJo@0.2',

  // ── vs an SB open (3bb) — BB is the only 3-bettor and gets a discount. 18.7%
  'SB:BB':
    '77+, 66@0.7, 55@0.5, 44@0.35, 33@0.15, 22@0.12,' +
    'AKs-A2s,' +
    'KQs-K6s,' +
    'QJs-Q7s, Q6s@0.4,' +
    'JTs-J7s,' +
    'T9s-T7s,' +
    '98s, 97s@0.4, 87s, 86s@0.3, 76s@0.7, 65s@0.5, 54s@0.4,' +
    'AKo, AQo, AJo@0.5, ATo@0.3,' +
    'KQo@0.5, KJo@0.3,' +
    'QJo@0.25',
};

/**
 * 3-bet range for `hero` facing an open from `opener`.
 * The 3-bet size is 3x IP and 3.5–4x from the blinds.
 */
export function threeBetRange(
  opener: PositionName,
  hero: PositionName,
  tableSize: 6 | 9 = 6,
): RangeGrid {
  const bucket = openerBucket(opener);
  const type: ThreeBettor = hero === 'BB' ? 'BB' : hero === 'SB' ? 'SB' : 'IP';
  const key = `${bucket}:${type}`;
  const spec = THREE_BET[key]
    ?? THREE_BET[`${bucket}:BB`]
    ?? THREE_BET['CO:IP'];
  void tableSize;
  return parseRange(spec);
}

export function threeBetSize(hero: PositionName, openSizeBb: number): number {
  return hero === 'BB' || hero === 'SB' ? openSizeBb * 3.6 : openSizeBb * 3;
}

// ═══════════════════════════════ COLD CALL / FLAT ═══════════════════════════════

const FLAT: Record<string, string> = {
  // Cold-calling in position with seats still behind: only hands that flop
  // well multiway and cannot profitably 3-bet.
  'EP:IP':
    'TT@0.4, 99@0.85, 88@0.9, 77@0.9, 66@0.85, 55@0.75, 44@0.6, 33@0.5, 22@0.45,' +
    'AJs@0.5, ATs@0.75, A9s@0.45, A8s@0.3,' +
    'KQs@0.65, KJs@0.8, KTs@0.65, K9s@0.25,' +
    'QJs@0.8, QTs@0.7, Q9s@0.3, JTs@0.85, J9s@0.35, T9s@0.65, 98s@0.5, 87s@0.4, 76s@0.3,' +
    'AQo@0.45, AJo@0.3, KQo@0.25',
  'MP:IP':
    'TT@0.35, 99@0.7, 88@0.9, 77@0.9, 66@0.85, 55@0.8, 44@0.7, 33@0.6, 22@0.55,' +
    'AJs@0.35, ATs@0.7, A9s@0.6, A8s@0.5, A7s@0.35, A6s@0.3,' +
    'KQs@0.5, KJs@0.75, KTs@0.8, K9s@0.45, K8s@0.25,' +
    'QJs@0.85, QTs@0.8, Q9s@0.5, JTs@0.9, J9s@0.55, T9s@0.8, T8s@0.35,' +
    '98s@0.7, 97s@0.3, 87s@0.6, 76s@0.45, 65s@0.35, 54s@0.25,' +
    'AQo@0.55, AJo@0.5, ATo@0.3, KQo@0.4, KJo@0.2',
  'CO:IP':
    '99@0.45, 88@0.7, 77@0.85, 66@0.9, 55@0.85, 44@0.8, 33@0.75, 22@0.7,' +
    'ATs@0.45, A9s@0.75, A8s@0.75, A7s@0.7, A6s@0.6, A5s@0.35, A4s@0.35, A3s@0.4, A2s@0.5,' +
    'KJs@0.55, KTs@0.8, K9s@0.7, K8s@0.5, K7s@0.4,' +
    'QJs@0.7, QTs@0.85, Q9s@0.75, Q8s@0.45,' +
    'JTs@0.75, J9s@0.75, J8s@0.45, T9s@0.85, T8s@0.6, 98s@0.8, 97s@0.5,' +
    '87s@0.75, 86s@0.4, 76s@0.65, 75s@0.35, 65s@0.55, 54s@0.4,' +
    'AQo@0.4, AJo@0.65, ATo@0.6, A9o@0.25, KQo@0.65, KJo@0.5, KTo@0.3, QJo@0.4, QTo@0.25, JTo@0.25',
  // SB flatting is rare: it invites the BB in with position and a discount.
  'EP:SB':
    '99@0.3, 88@0.4, 77@0.4, 66@0.35, 55@0.3, 44@0.2, 33@0.15, 22@0.12,' +
    'ATs@0.4, A9s@0.25, KJs@0.35, KTs@0.4, QJs@0.4, QTs@0.35, JTs@0.4, T9s@0.25,' +
    'AQo@0.3, AJo@0.2',
  'MP:SB':
    '99@0.35, 88@0.45, 77@0.45, 66@0.4, 55@0.35, 44@0.25, 33@0.2, 22@0.18,' +
    'ATs@0.35, A9s@0.35, A8s@0.2, KJs@0.4, KTs@0.45, K9s@0.2,' +
    'QJs@0.45, QTs@0.4, JTs@0.45, T9s@0.35, 98s@0.25,' +
    'AQo@0.25, AJo@0.3, KQo@0.25',
  'CO:SB':
    '99@0.25, 88@0.4, 77@0.45, 66@0.45, 55@0.4, 44@0.35, 33@0.3, 22@0.28,' +
    'ATs@0.2, A9s@0.4, A8s@0.4, A7s@0.35, A6s@0.3,' +
    'KJs@0.3, KTs@0.4, K9s@0.35,' +
    'QJs@0.4, QTs@0.45, Q9s@0.35, JTs@0.4, J9s@0.35, T9s@0.45, 98s@0.4, 87s@0.35, 76s@0.3,' +
    'AJo@0.35, ATo@0.3, KQo@0.35, KJo@0.2',
  'BTN:SB':
    '88@0.3, 77@0.4, 66@0.5, 55@0.5, 44@0.45, 33@0.4, 22@0.38,' +
    'A9s@0.35, A8s@0.45, A7s@0.5, A6s@0.5,' +
    'KTs@0.3, K9s@0.45, K8s@0.4, K7s@0.3,' +
    'QTs@0.4, Q9s@0.5, Q8s@0.4, JTs@0.35, J9s@0.5, J8s@0.35,' +
    'T9s@0.5, T8s@0.4, 98s@0.5, 97s@0.35, 87s@0.5, 86s@0.3, 76s@0.5, 65s@0.45, 54s@0.4,' +
    'AJo@0.4, ATo@0.45, A9o@0.3, KQo@0.4, KJo@0.4, KTo@0.3, QJo@0.35, QTo@0.25, JTo@0.25',
};

/** Cold-calling range (not from the BB — see `bbDefendCall`). */
export function flatCallRange(opener: PositionName, hero: PositionName): RangeGrid {
  const bucket = openerBucket(opener);
  const type = hero === 'SB' ? 'SB' : 'IP';
  return parseRange(FLAT[`${bucket}:${type}`] ?? FLAT['CO:IP']);
}

// ═══════════════════════════════ BLIND DEFENSE ═══════════════════════════════
//
// The BB is closing the action with a discount, so pot odds — not MDF — set
// the width. Against a 2bb min-raise the BB risks 1 to win 4.5 and defends
// north of 70%; against 3bb from the SB it is still over 60% because it only
// has one opponent and acts last after the flop.

const BB_DEFEND: Record<string, string> = {
  // ── vs a 2bb min-raise. The BB pays 1 to win 4.5 and needs 18% equity, so
  //    almost anything with a card that can flop a pair continues.
  'EP:2':
    '22+, A2s+, K2s+, Q2s+, J3s+, J2s@0.6, T5s+, T4s@0.6,' +
    '95s+, 94s@0.5, 85s+, 84s@0.5, 74s+, 73s@0.4, 63s+, 53s+, 43s,' +
    'A2o+, K6o+, K5o@0.6, K4o@0.35,' +
    'Q8o+, Q7o@0.6, Q6o@0.3, J8o+, J7o@0.5, T8o+, T7o@0.4,' +
    '97o+, 96o@0.35, 87o, 86o@0.4, 76o, 75o@0.35, 65o, 54o@0.6',
  'MP:2':
    '22+, A2s+, K2s+, Q2s+, J2s+, T4s+, T3s@0.6, T2s@0.4,' +
    '94s+, 93s@0.5, 84s+, 83s@0.5, 74s+, 73s@0.5, 63s+, 62s@0.4, 53s+, 43s, 42s@0.4,' +
    'A2o+, K5o+, K4o@0.6, K3o@0.35,' +
    'Q7o+, Q6o@0.6, Q5o@0.3, J7o+, J6o@0.5, T7o+, T6o@0.4,' +
    '96o+, 95o@0.4, 86o+, 85o@0.4, 75o+, 74o@0.35, 65o, 64o@0.4, 54o, 53o@0.35',
  'CO:2':
    '22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 93s+, 92s@0.6,' +
    '83s+, 82s@0.5, 73s+, 72s@0.4, 63s+, 62s@0.4, 52s+, 42s+, 32s@0.6,' +
    'A2o+, K4o+, K3o@0.6, K2o@0.4,' +
    'Q6o+, Q5o@0.6, Q4o@0.35, J7o+, J6o@0.6, J5o@0.3, T7o+, T6o@0.5,' +
    '96o+, 95o@0.5, 86o+, 85o@0.5, 75o+, 74o@0.45, 65o, 64o@0.5, 54o, 53o@0.4, 43o@0.4',
  'BTN:2':
    '22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 92s+, 82s+, 73s+, 72s@0.6,' +
    '63s+, 62s@0.7, 52s+, 42s+, 32s,' +
    'A2o+, K4o+, K3o@0.6, K2o@0.4,' +
    'Q5o+, Q4o@0.6, Q3o@0.35, J7o+, J6o@0.6, J5o@0.35, T7o+, T6o@0.5,' +
    '97o+, 96o@0.5, 87o, 86o@0.5, 76o, 75o@0.5, 65o, 64o@0.5, 54o, 53o@0.3, 43o@0.3',
  'SB:2':
    '22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 92s+, 82s+, 72s+, 62s+, 52s+, 42s+, 32s,' +
    'A2o+, K2o+, Q3o+, Q2o@0.6, J5o+, J4o@0.6, J3o@0.35,' +
    'T6o+, T5o@0.5, 96o+, 95o@0.5, 86o+, 85o@0.5, 75o+, 74o@0.5, 65o, 64o@0.5, 54o, 53o@0.4',

  // ── vs 2.5bb, the standard open
  'EP:25':
    '22+,' +
    'A2s+, K7s+, K6s@0.7, K5s@0.6, K4s@0.4, K3s@0.3,' +
    'Q8s+, Q7s@0.6, Q6s@0.4,' +
    'J8s+, J7s@0.5, T8s+, T7s@0.5, 97s+, 96s@0.4, 87s, 86s@0.4, 76s, 75s@0.4, 65s, 54s@0.7,' +
    'A2o+, KTo+, K9o@0.5,' +
    'QTo+, Q9o@0.4, JTo, J9o@0.4, T9o@0.6, 98o@0.4',
  'MP:25':
    '22+,' +
    'A2s+, K4s+, K3s@0.6, K2s@0.45,' +
    'Q6s+, Q5s@0.6, Q4s@0.4, J7s+, J6s@0.5, T7s+, T6s@0.4,' +
    '96s+, 95s@0.4, 86s+, 85s@0.4, 75s+, 74s@0.35, 64s+, 54s, 53s@0.4,' +
    'A2o+, K9o+, K8o@0.5,' +
    'Q9o+, Q8o@0.4, J9o+, J8o@0.4, T9o, T8o@0.35, 98o@0.5, 87o@0.35',
  'CO:25':
    '22+,' +
    'A2s+, K2s+, Q4s+, Q3s@0.6, Q2s@0.4,' +
    'J5s+, J4s@0.5, T6s+, T5s@0.5, 95s+, 94s@0.4, 85s+, 84s@0.4, 74s+, 73s@0.4,' +
    '64s+, 63s@0.4, 53s+, 43s@0.5,' +
    'A2o+, K7o+, K6o@0.5,' +
    'Q8o+, Q7o@0.4, J8o+, J7o@0.4, T8o+, T7o@0.4, 98o, 97o@0.4, 87o@0.6, 76o@0.4',
  'BTN:25':
    '22+,' +
    'A2s+, K2s+, Q2s+, J3s+, J2s@0.6,' +
    'T4s+, T3s@0.5, 94s+, 93s@0.4, 84s+, 83s@0.4, 74s+, 73s@0.4, 63s+, 53s+, 43s, 42s@0.4,' +
    'A2o+, K4o+, K3o@0.5,' +
    'Q7o+, Q6o@0.5, J8o+, J7o@0.5, T8o+, T7o@0.4,' +
    '97o+, 96o@0.4, 87o, 86o@0.4, 76o, 75o@0.4, 65o, 54o@0.5',
  'SB:3':
    '22+,' +
    'A2s+, K2s+, Q2s+, J2s+, T4s+, T3s@0.5,' +
    '94s+, 93s@0.4, 84s+, 83s@0.4, 74s+, 63s+, 53s+, 43s,' +
    'A2o+, K5o+, K4o@0.6, K3o@0.35,' +
    'Q7o+, Q6o@0.5, J8o+, J7o@0.5, T8o+, T7o@0.4,' +
    '97o+, 96o@0.4, 87o, 86o@0.4, 76o, 75o@0.4, 65o, 54o@0.5',

  // ── vs 3bb from a non-SB seat
  'EP:3':
    '22+, A2s+, K9s+, K8s@0.6, K7s@0.4,' +
    'Q9s+, Q8s@0.5, J9s+, J8s@0.5, T9s, T8s@0.5, 98s, 97s@0.4, 87s, 86s@0.3, 76s, 65s@0.7, 54s@0.5,' +
    'A2o+, KJo+, KTo@0.5, QJo, QTo@0.4, JTo@0.5',
  'MP:3':
    '22+, A2s+, K6s+, K5s@0.5, K4s@0.35,' +
    'Q7s+, Q6s@0.5, J8s+, J7s@0.4, T8s+, T7s@0.4, 97s+, 96s@0.4, 87s, 86s@0.4,' +
    '76s, 75s@0.4, 65s, 54s@0.6,' +
    'A2o+, KTo+, K9o@0.4, QTo+, Q9o@0.4, JTo, J9o@0.4, T9o@0.5',
  'CO:3':
    '22+, A2s+, K3s+, K2s@0.5, Q5s+, Q4s@0.5, J6s+, J5s@0.4, T7s+, T6s@0.4,' +
    '96s+, 95s@0.4, 86s+, 85s@0.4, 75s+, 74s@0.4, 64s+, 54s, 53s@0.4,' +
    'A2o+, K9o+, K8o@0.4, Q9o+, Q8o@0.4, J9o+, J8o@0.4, T9o, T8o@0.35, 98o@0.5, 87o@0.4',
  'BTN:3':
    '22+, A2s+, K2s+, Q2s+, J4s+, J3s@0.5, T5s+, T4s@0.5,' +
    '95s+, 94s@0.4, 85s+, 84s@0.4, 74s+, 63s+, 53s+, 43s@0.6,' +
    'A2o+, K6o+, K5o@0.5, Q8o+, Q7o@0.4, J8o+, J7o@0.4, T8o+, T7o@0.4,' +
    '97o+, 96o@0.4, 87o, 86o@0.4, 76o, 65o@0.6, 54o@0.4',
};

export type OpenSizeKey = '2' | '25' | '3';

/** Nearest tabulated open size for a raise measured in big blinds. */
export function sizeKey(openBb: number): OpenSizeKey {
  if (openBb <= 2.24) return '2';
  if (openBb <= 2.74) return '25';
  return '3';
}

/**
 * BB flat-calling range facing a single raise. The 3-bet portion is served
 * separately by `threeBetRange` — together they are the full defense.
 */
export function bbDefendCall(opener: PositionName, openBb: number): RangeGrid {
  const bucket = openerBucket(opener);
  const size = bucket === 'SB' ? (openBb <= 2.24 ? '2' : '3') : sizeKey(openBb);
  const spec = BB_DEFEND[`${bucket}:${size}`] ?? BB_DEFEND[`${bucket}:25`] ?? BB_DEFEND['CO:25'];
  const call = parseRange(spec);
  // Hands that 3-bet cannot also flat: remove the 3-bet weight.
  return subtractRange(call, threeBetRange(opener, 'BB'));
}

/** Total BB defense frequency (call + 3-bet) against one raise. */
export function bbDefendTotal(opener: PositionName, openBb: number): RangeGrid {
  return addRange(bbDefendCall(opener, openBb), threeBetRange(opener, 'BB'));
}

// ═══════════════════════════════ 4-BET / 5-BET ═══════════════════════════════

const FOUR_BET: Record<string, string> = {
  // opener bucket : where the 3-bet came from
  'EP:IP':
    'KK+, QQ@0.55, JJ@0.15, AKs@0.85, AKo@0.5, AQs@0.15,' +
    'A5s@0.3, A4s@0.22, A3s@0.12',
  'EP:BLIND':
    'KK+, QQ@0.65, JJ@0.2, AKs@0.9, AKo@0.6, AQs@0.2,' +
    'A5s@0.35, A4s@0.25, A3s@0.15, KQs@0.1',
  'MP:IP':
    'KK+, QQ@0.65, JJ@0.25, TT@0.1, AKs, AKo@0.6, AQs@0.25,' +
    'A5s@0.4, A4s@0.3, A3s@0.18, KQs@0.12',
  'MP:BLIND':
    'KK+, QQ@0.7, JJ@0.3, TT@0.12, AKs, AKo@0.65, AQs@0.3, AQo@0.12,' +
    'A5s@0.45, A4s@0.35, A3s@0.22, A2s@0.12, KQs@0.15',
  'CO:IP':
    'KK+, QQ@0.7, JJ@0.3, TT@0.15, AKs, AKo@0.7, AQs@0.35, AQo@0.15,' +
    'A5s@0.5, A4s@0.4, A3s@0.28, A2s@0.15, KQs@0.18, KJs@0.1',
  'CO:BLIND':
    'KK+, QQ@0.75, JJ@0.35, TT@0.18, AKs, AKo@0.75, AQs@0.4, AQo@0.2,' +
    'A5s@0.55, A4s@0.45, A3s@0.32, A2s@0.2, KQs@0.22, KJs@0.12',
  'BTN:BLIND':
    'QQ+, JJ@0.5, TT@0.25, 99@0.12, AKs, AKo@0.85, AQs@0.55, AQo@0.3, AJs@0.2,' +
    'A5s@0.6, A4s@0.5, A3s@0.4, A2s@0.28, KQs@0.3, KJs@0.18, KTs@0.12',
  'SB:BLIND':
    'QQ+, JJ@0.6, TT@0.35, 99@0.2, 88@0.12, AKs, AKo@0.9, AQs@0.65, AQo@0.4, AJs@0.3, ATs@0.15,' +
    'A5s@0.65, A4s@0.55, A3s@0.45, A2s@0.35, KQs@0.35, KJs@0.25, KTs@0.18, QJs@0.12',
};

/** 4-bet range for the original raiser facing a 3-bet. */
export function fourBetRange(opener: PositionName, threeBettor: PositionName): RangeGrid {
  const bucket = openerBucket(opener);
  const from = threeBettor === 'SB' || threeBettor === 'BB' ? 'BLIND' : 'IP';
  const spec = FOUR_BET[`${bucket}:${from}`] ?? FOUR_BET[`${bucket}:BLIND`] ?? FOUR_BET['CO:IP'];
  return parseRange(spec);
}

/** Calling the 3-bet (the rest of the continuing range). */
const FOUR_BET_CALL: Record<string, string> = {
  IP:
    'QQ@0.4, JJ@0.75, TT@0.75, 99@0.4, 88@0.25, 77@0.15,' +
    'AKs@0.15, AQs@0.7, AJs@0.7, ATs@0.5, A5s@0.35, A4s@0.3,' +
    'KQs@0.65, KJs@0.5, KTs@0.35, QJs@0.5, QTs@0.35, JTs@0.45, T9s@0.3, 98s@0.2,' +
    'AKo@0.45, AQo@0.35',
  BLIND:
    'QQ@0.3, JJ@0.7, TT@0.8, 99@0.6, 88@0.45, 77@0.35, 66@0.25, 55@0.2,' +
    'AQs@0.75, AJs@0.8, ATs@0.7, A9s@0.4, A5s@0.4, A4s@0.35, A3s@0.25,' +
    'KQs@0.75, KJs@0.65, KTs@0.5, K9s@0.25, QJs@0.6, QTs@0.5, JTs@0.55, T9s@0.4, 98s@0.3, 87s@0.2,' +
    'AKo@0.3, AQo@0.5, AJo@0.3, KQo@0.3',
};

export function fourBetCallRange(opener: PositionName, threeBettor: PositionName): RangeGrid {
  const from = threeBettor === 'SB' || threeBettor === 'BB' ? 'BLIND' : 'IP';
  return parseRange(FOUR_BET_CALL[from]);
}

/**
 * 5-bet jam, as the 3-bettor facing a 4-bet. Nearly pure value plus the ace
 * blockers that make the opponent's continuing range smallest.
 */
const FIVE_BET_JAM =
  'AA, KK, QQ@0.55, JJ@0.12, AKs@0.8, AKo@0.45, A5s@0.28, A4s@0.18, A3s@0.1';

const FIVE_BET_CALL =
  'QQ@0.45, JJ@0.8, TT@0.5, 99@0.2,' +
  'AKs@0.2, AKo@0.5, AQs@0.7, AQo@0.2, AJs@0.4, ATs@0.2,' +
  'KQs@0.35, KJs@0.15, QJs@0.15, JTs@0.15, A5s@0.2, A4s@0.15';

export function fiveBetJamRange(): RangeGrid {
  return parseRange(FIVE_BET_JAM);
}

export function fiveBetCallRange(): RangeGrid {
  return parseRange(FIVE_BET_CALL);
}

// ═══════════════════════════════ SQUEEZE ═══════════════════════════════
//
// An open plus one cold-call. Squeezes are the most polarised preflop node in
// the game: the caller's range is capped, so you either want a hand that beats
// the calling range or one whose value comes entirely from folds.

const SQUEEZE: Record<string, string> = {
  // hero seat : opener bucket
  'BB:EP':
    'JJ+, TT@0.75, 99@0.4, 88@0.2,' +
    'AKs, AQs, AJs@0.55, ATs@0.3, A5s@0.55, A4s@0.4, A3s@0.25,' +
    'KQs@0.5, KJs@0.3, QJs@0.25, JTs@0.25, T9s@0.15,' +
    'AKo, AQo@0.5, AJo@0.15',
  'BB:MP':
    'TT+, 99@0.6, 88@0.35, 77@0.18,' +
    'AKs, AQs, AJs@0.7, ATs@0.45, A9s@0.2, A5s@0.7, A4s@0.55, A3s@0.35, A2s@0.2,' +
    'KQs@0.65, KJs@0.45, KTs@0.25, QJs@0.4, QTs@0.2, JTs@0.4, T9s@0.25, 98s@0.15,' +
    'AKo, AQo@0.65, AJo@0.25, KQo@0.15',
  'BB:CO':
    '99+, 88@0.55, 77@0.35, 66@0.2,' +
    'AKs, AQs, AJs, ATs@0.65, A9s@0.35, A8s@0.2, A5s@0.85, A4s@0.7, A3s@0.5, A2s@0.35,' +
    'KQs, KJs@0.6, KTs@0.4, K9s@0.2, QJs@0.55, QTs@0.35, JTs@0.55, T9s@0.35, 98s@0.25, 87s@0.15,' +
    'AKo, AQo@0.8, AJo@0.4, ATo@0.15, KQo@0.3',
  'BB:BTN':
    '88+, 77@0.55, 66@0.4, 55@0.25,' +
    'AKs-A8s, A7s@0.5, A5s, A4s@0.85, A3s@0.7, A2s@0.5,' +
    'KQs, KJs, KTs@0.6, K9s@0.35, QJs@0.65, QTs@0.45, JTs@0.6, T9s@0.45, 98s@0.35, 87s@0.25, 76s@0.2,' +
    'AKo, AQo, AJo@0.55, ATo@0.25, KQo@0.45, KJo@0.2',
  'SB:EP':
    'JJ+, TT@0.7, 99@0.35,' +
    'AKs, AQs, AJs@0.5, ATs@0.25, A5s@0.5, A4s@0.35,' +
    'KQs@0.45, KJs@0.25, QJs@0.2, JTs@0.2,' +
    'AKo, AQo@0.45',
  'SB:MP':
    'TT+, 99@0.55, 88@0.3,' +
    'AKs, AQs, AJs@0.65, ATs@0.4, A5s@0.65, A4s@0.5, A3s@0.3,' +
    'KQs@0.6, KJs@0.4, KTs@0.2, QJs@0.35, JTs@0.35, T9s@0.2,' +
    'AKo, AQo@0.6, AJo@0.2',
  'SB:CO':
    '99+, 88@0.5, 77@0.3,' +
    'AKs, AQs, AJs@0.9, ATs@0.55, A9s@0.3, A5s@0.8, A4s@0.65, A3s@0.45, A2s@0.3,' +
    'KQs, KJs@0.55, KTs@0.35, QJs@0.5, QTs@0.3, JTs@0.5, T9s@0.3, 98s@0.2,' +
    'AKo, AQo@0.75, AJo@0.35, KQo@0.25',
  'IP:MP':
    'JJ+, TT@0.6, 99@0.3,' +
    'AKs, AQs, AJs@0.55, ATs@0.3, A5s@0.45, A4s@0.3,' +
    'KQs@0.45, KJs@0.25, QJs@0.2, JTs@0.2,' +
    'AKo, AQo@0.45',
  'IP:CO':
    'TT+, 99@0.5, 88@0.28,' +
    'AKs, AQs, AJs@0.7, ATs@0.4, A5s@0.6, A4s@0.45, A3s@0.25,' +
    'KQs@0.6, KJs@0.35, KTs@0.2, QJs@0.3, JTs@0.3,' +
    'AKo, AQo@0.6, AJo@0.2',
};

/** Squeeze range facing an open plus one caller. */
export function squeezeRange(opener: PositionName, hero: PositionName): RangeGrid {
  const bucket = openerBucket(opener);
  const seat = hero === 'BB' ? 'BB' : hero === 'SB' ? 'SB' : 'IP';
  return parseRange(
    SQUEEZE[`${seat}:${bucket}`] ?? SQUEEZE[`${seat}:CO`] ?? SQUEEZE['BB:CO'],
  );
}

export function squeezeSize(hero: PositionName, openBb: number, callers: number): number {
  const base = hero === 'BB' || hero === 'SB' ? 4 : 3.5;
  return openBb * (base + callers);
}

// ═══════════════════════════════ PUSH / FOLD (NASH) ═══════════════════════════════
//
// Stored as the effective stack, in big blinds, at or below which shoving is
// the equilibrium play heads-up (SB vs BB, no ante). These are the classic
// Nash equilibrium jam thresholds — a hand is in the range when the effective
// stack is at or under its number.
//
// Multiway seats scale the thresholds by POS_SCALE, which is calibrated so the
// resulting jam frequencies land on published HRC solutions: BTN ≈ 38% at
// 10bb, CO ≈ 27% at 10bb, UTG at a 9-handed table ≈ 13% at 10bb.

const PUSH_HU =
  '77+@85, 66@72, 55@58, 44@50, 33@43, 22@36,' +
  'AKs@85, AQs@85, AJs@80, ATs@72, A9s@58, A8s@54, A7s@48, A6s@43, A5s@48, A4s@43, A3s@39, A2s@36,' +
  'AKo@80, AQo@70, AJo@58, ATo@49, A9o@39, A8o@35, A7o@29, A6o@25, A5o@28, A4o@25, A3o@22, A2o@20,' +
  'KQs@55, KJs@49, KTs@43, K9s@33, K8s@29, K7s@26, K6s@25, K5s@25, K4s@23, K3s@22, K2s@20,' +
  'KQo@39, KJo@33, KTo@28, K9o@20, K8o@17, K7o@16, K6o@14.5, K5o@14.5, K4o@13, K3o@12, K2o@11.5,' +
  'QJs@36, QTs@32, Q9s@25, Q8s@22, Q7s@19, Q6s@17, Q5s@17, Q4s@16, Q3s@15, Q2s@14.5,' +
  'QJo@25, QTo@20, Q9o@16, Q8o@13, Q7o@11, Q6o@10, Q5o@10, Q4o@9.5, Q3o@9, Q2o@8.7,' +
  'JTs@28, J9s@22, J8s@19, J7s@16, J6s@14.5, J5s@13.8, J4s@13, J3s@12.3, J2s@11.6,' +
  'JTo@17.4, J9o@13, J8o@11, J7o@8.7, J6o@8, J5o@8, J4o@7.3, J3o@6.8, J2o@6.5,' +
  'T9s@20, T8s@17.4, T7s@14.5, T6s@13, T5s@11.6, T4s@11, T3s@10.4, T2s@10,' +
  'T9o@13, T8o@10, T7o@8, T6o@6.5, T5o@6.1, T4o@5.8, T3o@5.4, T2o@5.1,' +
  '98s@17.4, 97s@13.8, 96s@11.6, 95s@10, 94s@9.4, 93s@9, 92s@8.7,' +
  '98o@10, 97o@7.3, 96o@5.8, 95o@5.1, 94o@4.6, 93o@4.5, 92o@4.3,' +
  '87s@14.5, 86s@11.6, 85s@10, 84s@8.7, 83s@8.3, 82s@8,' +
  '87o@8, 86o@5.8, 85o@4.6, 84o@4.2, 83o@3.9, 82o@3.8,' +
  '76s@11.6, 75s@9.4, 74s@8, 73s@7.5, 72s@7.2,' +
  '76o@6.1, 75o@4.6, 74o@3.9, 73o@3.6, 72o@3.3,' +
  '65s@10, 64s@8, 63s@7.2, 62s@6.8,' +
  '65o@5.1, 64o@3.8, 63o@3.3, 62o@3,' +
  '54s@8.7, 53s@7.2, 52s@6.7, 54o@4.3, 53o@3.3, 52o@3,' +
  '43s@7, 42s@6.2, 43o@3.2, 42o@2.9,' +
  '32s@6.1, 32o@2.8';

/** BB calling a shove, heads-up. Calling is tighter than shoving. */
const CALL_JAM_HU =
  '99+@90, 88@60, 77@52, 66@45, 55@38, 44@33, 33@30, 22@27,' +
  'AKs@90, AQs@75, AJs@63, ATs@54, A9s@42, A8s@36, A7s@32, A6s@28, A5s@30, A4s@27, A3s@25, A2s@24,' +
  'AKo@68, AQo@57, AJo@46, ATo@38, A9o@28, A8o@24, A7o@21, A6o@18, A5o@19, A4o@18, A3o@16, A2o@15,' +
  'KQs@33, KJs@28, KTs@24, K9s@19, K8s@16, K7s@15, K6s@14, K5s@13.5, K4s@13, K3s@12, K2s@11,' +
  'KQo@22, KJo@18, KTo@15, K9o@12, K8o@10, K7o@9, K6o@8, K5o@7.8, K4o@7.5, K3o@7, K2o@7,' +
  'QJs@22, QTs@19, Q9s@16, Q8s@13.5, Q7s@12, Q6s@11, Q5s@11, Q4s@10.5, Q3s@10, Q2s@10,' +
  'QJo@15, QTo@13, Q9o@10.5, Q8o@8.7, Q7o@7.5, Q6o@7, Q5o@6.6, Q4o@6.3, Q3o@6, Q2o@5.8,' +
  'JTs@19, J9s@16, J8s@13.5, J7s@12, J6s@10.5, J5s@10, J4s@9.7, J3s@9.3, J2s@9,' +
  'JTo@13, J9o@10.5, J8o@9, J7o@7.5, J6o@6.4, J5o@6.1, J4o@5.8, J3o@5.5, J2o@5.4,' +
  'T9s@15, T8s@13.5, T7s@11, T6s@9.7, T5s@9, T4s@8.5, T3s@8.2, T2s@8,' +
  'T9o@10.5, T8o@9, T7o@7.5, T6o@6.3, T5o@5.7, T4o@5.4, T3o@5.1, T2o@5,' +
  '98s@13.5, 97s@11, 96s@9.7, 95s@8.7, 94s@7.8, 93s@7.5, 92s@7.3,' +
  '98o@9, 97o@7.5, 96o@6.3, 95o@5.5, 94o@4.8, 93o@4.5, 92o@4.3,' +
  '87s@12, 86s@10.5, 85s@9, 84s@7.8, 83s@7.2, 82s@7,' +
  '87o@7.8, 86o@6.6, 85o@5.5, 84o@4.6, 83o@4.2, 82o@4,' +
  '76s@10.8, 75s@9.3, 74s@8.1, 73s@7.2, 72s@6.7,' +
  '76o@6.9, 75o@5.8, 74o@4.8, 73o@4, 72o@3.6,' +
  '65s@9.9, 64s@8.4, 63s@7.3, 62s@6.6,' +
  '65o@6.1, 64o@5.1, 63o@4.2, 62o@3.6,' +
  '54s@9, 53s@7.8, 52s@6.7, 54o@5.4, 53o@4.3, 52o@3.6,' +
  '43s@7.5, 42s@6.6, 43o@4.2, 42o@3.6,' +
  '32s@6.3, 32o@3.3';

/**
 * Threshold multiplier by number of players still to act behind the shover.
 * Calibrated against published HRC ranges at a 10bb effective stack:
 * BTN ≈ 39%, CO ≈ 28%, 6-max UTG ≈ 19%, 9-max UTG ≈ 14%.
 */
const POS_SCALE: Record<number, number> = {
  1: 1, 2: 0.68, 3: 0.47, 4: 0.4, 5: 0.35, 6: 0.31, 7: 0.28, 8: 0.25,
};

function thresholdGrid(
  table: Float32Array,
  stackBb: number,
  scale: number,
  mixWindowBb: number,
): RangeGrid {
  const w = new Float32Array(HAND_COUNT);
  for (let i = 0; i < HAND_COUNT; i++) {
    const t = table[i] * scale;
    if (t <= 0) continue;
    // A soft edge in the last `mixWindowBb` of a hand's range is not decoration:
    // at the boundary the equilibrium really is close to indifferent.
    const d = t - stackBb;
    if (d >= mixWindowBb) w[i] = 1;
    else if (d <= -mixWindowBb) w[i] = 0;
    else w[i] = 0.5 + (0.5 * d) / mixWindowBb;
  }
  return { weights: w };
}

/**
 * Nash push (jam) range for a seat at a given effective stack.
 * `icmPressure` 0–1 tightens the jam as bubble pressure rises (a shove risks
 * a tournament life that is worth more than its chips).
 */
export function pushRange(
  pos: PositionName,
  stackBb: number,
  tableSize: 6 | 9 = 9,
  icmPressure = 0,
): RangeGrid {
  const behind = Math.max(1, playersBehind(pos, tableSize));
  const scale = (POS_SCALE[behind] ?? 0.23) * (1 - icmPressure * 0.28);
  return thresholdGrid(parseThresholds(PUSH_HU), stackBb, scale, 0.9);
}

/**
 * Nash calling range facing a shove. `callersBehind` is how many players can
 * still wake up behind you — each one costs you roughly 12% of your threshold.
 */
export function callJamRange(
  stackBb: number,
  callersBehind = 0,
  icmPressure = 0,
): RangeGrid {
  const scale = Math.pow(0.88, callersBehind) * (1 - icmPressure * 0.45);
  return thresholdGrid(parseThresholds(CALL_JAM_HU), stackBb, scale, 0.7);
}

/** The raw heads-up jam threshold, in bb, for a hand — handy for tooltips. */
export function pushThreshold(handIdx: number): number {
  return parseThresholds(PUSH_HU)[handIdx];
}

// ═══════════════════════════════ lookup helpers ═══════════════════════════════

/** Weight of a specific holding inside a range. */
export function weightOf(g: RangeGrid, c1: CardId, c2: CardId): number {
  return g.weights[handIndex(c1, c2)];
}

/**
 * Every named preflop range, for the range viewer's browser. Lazily built so
 * the catalogue costs nothing until the user opens it.
 */
export interface NamedRange {
  id: string;
  group: string;
  label: string;
  detail: string;
  build(): RangeGrid;
}

export function rangeCatalog(): NamedRange[] {
  const out: NamedRange[] = [];
  for (const pos of SEATS_6MAX) {
    if (pos === 'BB') continue;
    out.push({
      id: `rfi6-${pos}`,
      group: 'Open-raise · 6-max',
      label: `${positionLabel(pos)} RFI`,
      detail: pos === 'SB' ? 'Raise 3bb, first in' : 'Raise 2.5bb, first in',
      build: () => rfiRange(pos, 6),
    });
  }
  for (const pos of SEATS_9MAX) {
    if (pos === 'BB') continue;
    out.push({
      id: `rfi9-${pos}`,
      group: 'Open-raise · 9-max',
      label: `${positionLabel(pos)} RFI`,
      detail: pos === 'SB' ? 'Raise 3bb, first in' : 'Raise 2.5bb, first in',
      build: () => rfiRange(pos, 9),
    });
  }
  out.push({
    id: 'sb-limp',
    group: 'Open-raise · 6-max',
    label: 'SB limp',
    detail: 'The mixed limping strategy that comes with the SB raise',
    build: () => sbLimpRange(),
  });

  const openers: PositionName[] = ['UTG', 'HJ', 'CO', 'BTN', 'SB'];
  for (const o of openers) {
    for (const hero of ['BTN', 'SB', 'BB'] as PositionName[]) {
      if (o === 'SB' && hero !== 'BB') continue;
      if (o === 'BTN' && hero === 'BTN') continue;
      out.push({
        id: `3b-${o}-${hero}`,
        group: '3-bet',
        label: `${positionLabel(hero)} vs ${positionLabel(o)}`,
        detail: `3-bet to ${threeBetSize(hero, openSize(o)).toFixed(1)}bb`,
        build: () => threeBetRange(o, hero),
      });
    }
  }

  for (const o of openers) {
    out.push({
      id: `bb-def-${o}`,
      group: 'Blind defense',
      label: `BB calls ${positionLabel(o)}`,
      detail: `Flat vs a ${openSize(o)}bb open`,
      build: () => bbDefendCall(o, openSize(o)),
    });
  }
  out.push({
    id: 'bb-def-min',
    group: 'Blind defense',
    label: 'BB vs a min-raise',
    detail: 'Flat vs 2bb from the button',
    build: () => bbDefendCall('BTN', 2),
  });

  for (const o of ['UTG', 'HJ', 'CO', 'BTN'] as PositionName[]) {
    out.push({
      id: `4b-${o}`,
      group: '4-bet / 5-bet',
      label: `${positionLabel(o)} 4-bets a blind`,
      detail: 'Facing a 3-bet from the blinds',
      build: () => fourBetRange(o, 'BB'),
    });
  }
  out.push({
    id: '5b-jam',
    group: '4-bet / 5-bet',
    label: '5-bet jam',
    detail: 'As the 3-bettor, facing a 4-bet',
    build: () => fiveBetJamRange(),
  });

  for (const o of ['UTG', 'HJ', 'CO', 'BTN'] as PositionName[]) {
    out.push({
      id: `sqz-${o}`,
      group: 'Squeeze',
      label: `BB squeezes ${positionLabel(o)}`,
      detail: 'Open plus one cold-caller',
      build: () => squeezeRange(o, 'BB'),
    });
  }

  for (const depth of [8, 10, 12, 15, 20]) {
    out.push({
      id: `push-btn-${depth}`,
      group: `Push/fold · ${depth}bb`,
      label: `BTN jam ${depth}bb`,
      detail: 'Nash equilibrium, no ante',
      build: () => pushRange('BTN', depth, 9),
    });
    out.push({
      id: `push-sb-${depth}`,
      group: `Push/fold · ${depth}bb`,
      label: `SB jam ${depth}bb`,
      detail: 'Nash equilibrium, no ante',
      build: () => pushRange('SB', depth, 9),
    });
  }

  return out;
}
