/**
 * ROYALE — server-side poker rules.
 *
 * Self-contained on purpose. The server is the authority: it must be able to
 * evaluate, build pots and award money without depending on anything in
 * `src/engine/*` (which is a client bundle and evolves on its own schedule).
 * Everything here is integer-friendly, allocation-light and deterministic
 * given a seeded `Rng`.
 *
 *  · `rank7` — 7-card evaluator, table-driven, no allocation in the hot path.
 *  · `evaluatePlo` — exactly-two-from-hand Omaha, all 60 combinations.
 *  · `buildPots` / `distribute` — side pots and odd-chip resolution.
 *  · `legalActions` — the legal action set the client is allowed to send.
 */

import { Rng } from '../src/core/rng.ts';
import type { CardId, GameVariant, HandCategory, HandRank, Pot } from '../src/core/types.ts';
import { RANKS, SUITS } from '../src/core/types.ts';
import type { LegalAction } from '../src/core/bus.ts';

// ═══════════════════════════════════════════════════════════════════
// Chip arithmetic — money is decimal, so quantize relentlessly.
// ═══════════════════════════════════════════════════════════════════

export function q(x: number, step = 0.01): number {
  return Math.round(x / step) * step === 0 ? 0 : Math.round((Math.round(x / step) * step + Number.EPSILON) * 1e6) / 1e6;
}
export function qFloor(x: number, step = 0.01): number {
  return Math.round((Math.floor(x / step + 1e-9) * step + Number.EPSILON) * 1e6) / 1e6;
}

// ═══════════════════════════════════════════════════════════════════
// Hand evaluation
// ═══════════════════════════════════════════════════════════════════

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

/** STRAIGHT_HIGH[13-bit rank mask] = index of the straight's top card, else -1. */
const STRAIGHT_HIGH = (() => {
  const t = new Int8Array(1 << 13).fill(-1);
  const wheel = (1 << 12) | 1 | (1 << 1) | (1 << 2) | (1 << 3);
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

const rankCount = new Int8Array(13);
const suitCount = new Int8Array(4);
const suitMask = new Int32Array(4);

function pack(cat: number, a: number, b: number, c: number, d: number, e: number): number {
  return (cat << 20) | (a << 16) | (b << 12) | (c << 8) | (d << 4) | e;
}

/** Top `n` set bits of a 13-bit mask, high to low. */
function topBits(mask: number, n: number, out: number[]): number {
  let found = 0;
  for (let r = 12; r >= 0 && found < n; r--) {
    if (mask & (1 << r)) out[found++] = r;
  }
  for (let i = found; i < n; i++) out[i] = 0;
  return found;
}

const scratch: number[] = [0, 0, 0, 0, 0];

/**
 * Rank any 5..7 card holding into a single comparable integer.
 * Higher is strictly better; equal values are exact ties.
 */
export function rank7(cards: ArrayLike<number>, n: number = cards.length): number {
  rankCount.fill(0);
  suitCount.fill(0);
  suitMask.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = c >> 2;
    const s = c & 3;
    rankCount[r]++;
    suitCount[s]++;
    suitMask[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  // flush / straight flush
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] >= 5) {
      const fm = suitMask[s];
      const sf = STRAIGHT_HIGH[fm];
      if (sf >= 0) return pack(8, sf, 0, 0, 0, 0);
      topBits(fm, 5, scratch);
      return pack(5, scratch[0], scratch[1], scratch[2], scratch[3], scratch[4]);
    }
  }

  // count-based categories
  let quad = -1;
  let trip = -1;
  let trip2 = -1;
  let pair = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const c = rankCount[r];
    if (c === 4) {
      if (quad < 0) quad = r;
    } else if (c === 3) {
      if (trip < 0) trip = r;
      else if (trip2 < 0) trip2 = r;
    } else if (c === 2) {
      if (pair < 0) pair = r;
      else if (pair2 < 0) pair2 = r;
    }
  }

  if (quad >= 0) {
    const kick = highestExcept(rankMask, quad, -1);
    return pack(7, quad, kick, 0, 0, 0);
  }
  if (trip >= 0 && (pair >= 0 || trip2 >= 0)) {
    const low = trip2 >= 0 && trip2 > (pair >= 0 ? pair : -1) ? trip2 : pair;
    return pack(6, trip, low, 0, 0, 0);
  }

  const straight = STRAIGHT_HIGH[rankMask];
  if (straight >= 0) return pack(4, straight, 0, 0, 0, 0);

  if (trip >= 0) {
    const k1 = highestExcept(rankMask, trip, -1);
    const k2 = highestExcept(rankMask, trip, k1);
    return pack(3, trip, k1, k2, 0, 0);
  }
  if (pair >= 0 && pair2 >= 0) {
    const kick = highestExcept(rankMask, pair, pair2);
    return pack(2, pair, pair2, kick, 0, 0);
  }
  if (pair >= 0) {
    const k1 = highestExcept(rankMask, pair, -1);
    const k2 = highestExcept(rankMask, pair, k1);
    const k3 = highestExcept3(rankMask, pair, k1, k2);
    return pack(1, pair, k1, k2, k3, 0);
  }
  topBits(rankMask, 5, scratch);
  return pack(0, scratch[0], scratch[1], scratch[2], scratch[3], scratch[4]);
}

function highestExcept(mask: number, a: number, b: number): number {
  for (let r = 12; r >= 0; r--) {
    if (r === a || r === b) continue;
    if (mask & (1 << r)) return r;
  }
  return 0;
}
function highestExcept3(mask: number, a: number, b: number, c: number): number {
  for (let r = 12; r >= 0; r--) {
    if (r === a || r === b || r === c) continue;
    if (mask & (1 << r)) return r;
  }
  return 0;
}

const ploBuf = new Int32Array(5);

/** Omaha: exactly two from hand, exactly three from board. */
export function rankPlo(hole: ArrayLike<number>, board: ArrayLike<number>): number {
  const h = hole.length;
  const b = board.length;
  if (b < 3) return rank7(hole, Math.min(h, 5));
  let best = -1;
  for (let i = 0; i < h - 1; i++) {
    for (let j = i + 1; j < h; j++) {
      ploBuf[0] = hole[i];
      ploBuf[1] = hole[j];
      for (let x = 0; x < b - 2; x++) {
        for (let y = x + 1; y < b - 1; y++) {
          for (let z = y + 1; z < b; z++) {
            ploBuf[2] = board[x];
            ploBuf[3] = board[y];
            ploBuf[4] = board[z];
            const v = rank7(ploBuf, 5);
            if (v > best) best = v;
          }
        }
      }
    }
  }
  return best;
}

export function rankFor(variant: GameVariant, hole: readonly CardId[], board: readonly CardId[]): number {
  if (variant === 'plo4') return rankPlo(hole, board);
  const all: number[] = [];
  for (const c of hole) all.push(c);
  for (const c of board) all.push(c);
  return rank7(all, all.length);
}

/** Reconstruct the exact five cards behind a value, for the HUD. */
function bestFive(cards: readonly CardId[], value: number): CardId[] {
  const n = cards.length;
  if (n <= 5) return cards.slice();
  const idx = [0, 1, 2, 3, 4];
  const buf = new Int32Array(5);
  let best: CardId[] = cards.slice(0, 5);
  const walk = (start: number, depth: number): void => {
    if (depth === 5) {
      for (let i = 0; i < 5; i++) buf[i] = cards[idx[i]];
      if (rank7(buf, 5) === value) best = [cards[idx[0]], cards[idx[1]], cards[idx[2]], cards[idx[3]], cards[idx[4]]];
      return;
    }
    for (let i = start; i < n; i++) {
      idx[depth] = i;
      walk(i + 1, depth + 1);
    }
  };
  walk(0, 0);
  return best.slice().sort((a, b) => b - a);
}

export function labelForValue(value: number): string {
  const cat = value >>> 20;
  const a = (value >> 16) & 15;
  const b = (value >> 12) & 15;
  switch (cat) {
    case 8:
      return a === 12 ? 'Royal Flush' : `${RANK_ONE[a]}-High Straight Flush`;
    case 7:
      return `Four ${RANK_MANY[a]}`;
    case 6:
      return `${RANK_MANY[a]} full of ${RANK_MANY[b]}`;
    case 5:
      return `${RANK_ONE[a]}-High Flush`;
    case 4:
      return `${RANK_ONE[a]}-High Straight`;
    case 3:
      return `Three ${RANK_MANY[a]}`;
    case 2:
      return `${RANK_MANY[a]} & ${RANK_MANY[b]}`;
    case 1:
      return `Pair of ${RANK_MANY[a]}`;
    default:
      return `${RANK_ONE[a]} High`;
  }
}

export function handRankOf(
  variant: GameVariant,
  hole: readonly CardId[],
  board: readonly CardId[],
): HandRank {
  const value = rankFor(variant, hole, board);
  const pool = variant === 'plo4' ? ploPool(hole, board, value) : [...hole, ...board];
  return {
    value,
    category: CATEGORY_NAMES[value >>> 20] ?? 'high-card',
    best: bestFive(pool, value),
    label: labelForValue(value),
  };
}

/** The exact 2+3 that produced the winning Omaha value. */
function ploPool(hole: readonly CardId[], board: readonly CardId[], value: number): CardId[] {
  for (let i = 0; i < hole.length - 1; i++) {
    for (let j = i + 1; j < hole.length; j++) {
      for (let x = 0; x < board.length - 2; x++) {
        for (let y = x + 1; y < board.length - 1; y++) {
          for (let z = y + 1; z < board.length; z++) {
            const five = [hole[i], hole[j], board[x], board[y], board[z]];
            if (rank7(five, 5) === value) return five;
          }
        }
      }
    }
  }
  return [...hole.slice(0, 2), ...board.slice(0, 3)];
}

export function cardLabel(c: CardId): string {
  return RANKS[c >> 2] + SUITS[c & 3];
}

// ═══════════════════════════════════════════════════════════════════
// Deck
// ═══════════════════════════════════════════════════════════════════

export class Deck {
  private cards: number[] = [];
  private pos = 0;
  private rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
    this.reset();
  }

  reset(): void {
    this.cards.length = 0;
    for (let c = 0; c < 52; c++) this.cards.push(c);
    // Two independent passes: the second shuffle uses a fresh stride so a
    // predicted first pass buys an attacker nothing.
    this.rng.shuffle(this.cards);
    this.rng.shuffle(this.cards);
    this.pos = 0;
  }

  draw(): CardId {
    if (this.pos >= this.cards.length) this.reset();
    return this.cards[this.pos++];
  }

  get remaining(): number {
    return this.cards.length - this.pos;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Pots
// ═══════════════════════════════════════════════════════════════════

export interface Commitment {
  seat: number;
  total: number;
  folded: boolean;
}

/**
 * Build main + side pots from each seat's total commitment. Folded money is
 * dead: it joins the pot but never makes its owner eligible.
 */
export function buildPots(commitments: readonly Commitment[], step = 0.01): Pot[] {
  const live = commitments.filter((c) => c.total > step / 2);
  if (live.length === 0) return [];
  const levels = Array.from(new Set(live.map((c) => q(c.total, step)))).sort((a, b) => a - b);

  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    const band = q(level - prev, step);
    if (band <= step / 2) {
      prev = level;
      continue;
    }
    let amount = 0;
    const eligible: number[] = [];
    for (const c of live) {
      const contributed = Math.min(c.total, level) - Math.min(c.total, prev);
      if (contributed > step / 2) {
        amount = q(amount + contributed, step);
        if (!c.folded) eligible.push(c.seat);
      }
    }
    if (amount > step / 2 && eligible.length > 0) {
      pots.push({ amount, eligible: eligible.sort((a, b) => a - b), index: pots.length });
    } else if (amount > step / 2 && pots.length > 0) {
      // dead money with no live claimant folds into the previous pot
      pots[pots.length - 1].amount = q(pots[pots.length - 1].amount + amount, step);
    }
    prev = level;
  }
  return pots;
}

export function potTotal(pots: readonly Pot[]): number {
  let t = 0;
  for (const p of pots) t += p.amount;
  return q(t);
}

export interface Award {
  seat: number;
  amount: number;
  potIndex: number;
}

/**
 * Award every pot to its best eligible hand. Odd chips go to the first
 * winner left of the button, exactly as in a live room.
 */
export function distribute(
  pots: readonly Pot[],
  values: ReadonlyMap<number, number>,
  buttonSeat: number,
  seatCount: number,
  step = 0.01,
): Award[] {
  const awards: Award[] = [];
  for (const pot of pots) {
    let best = -1;
    let winners: number[] = [];
    for (const seat of pot.eligible) {
      const v = values.get(seat);
      if (v === undefined) continue;
      if (v > best) {
        best = v;
        winners = [seat];
      } else if (v === best) {
        winners.push(seat);
      }
    }
    if (winners.length === 0) {
      // everybody folded into this pot; give it to whoever is left
      const fallback = pot.eligible[0];
      if (fallback !== undefined) awards.push({ seat: fallback, amount: pot.amount, potIndex: pot.index });
      continue;
    }
    const ordered = orderFromButton(winners, buttonSeat, seatCount);
    const share = qFloor(pot.amount / ordered.length, step);
    let handed = 0;
    for (const seat of ordered) {
      awards.push({ seat, amount: share, potIndex: pot.index });
      handed = q(handed + share, step);
    }
    let odd = q(pot.amount - handed, step);
    let i = 0;
    while (odd > step / 2 && ordered.length > 0) {
      const seat = ordered[i % ordered.length];
      const found = awards.find((a) => a.seat === seat && a.potIndex === pot.index);
      if (found) found.amount = q(found.amount + step, step);
      odd = q(odd - step, step);
      i++;
    }
  }
  return awards;
}

/** Clockwise from the seat immediately left of the button. */
export function orderFromButton(seats: readonly number[], buttonSeat: number, seatCount: number): number[] {
  return seats.slice().sort((a, b) => {
    const da = (a - buttonSeat - 1 + seatCount * 2) % seatCount;
    const db = (b - buttonSeat - 1 + seatCount * 2) % seatCount;
    return da - db;
  });
}

// ═══════════════════════════════════════════════════════════════════
// Legal actions — the contract the client is validated against
// ═══════════════════════════════════════════════════════════════════

export interface LegalContext {
  variant: GameVariant;
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  bb: number;
  step: number;
  /** total chips already in the middle across all seats, this hand */
  potTotal: number;
  currentBet: number;
  lastRaiseSize: number;
  seatCommitted: number;
  seatStack: number;
  /** false once the seat has used up its raise right in a capped spot */
  canRaise: boolean;
}

/**
 * The single source of legality. The server computes it for the acting seat,
 * ships it to that client, and re-derives it when the action comes back —
 * an action is only ever accepted if it is in this set.
 */
export function legalActions(ctx: LegalContext): LegalAction[] {
  const out: LegalAction[] = [];
  const step = ctx.step;
  const toCall = q(Math.max(0, Math.min(ctx.currentBet - ctx.seatCommitted, ctx.seatStack)), step);
  const cap = q(ctx.seatCommitted + ctx.seatStack, step);

  const potAfterCall = q(ctx.potTotal + toCall, step);
  const maxRaiseTo =
    ctx.variant === 'plo4'
      ? Math.min(cap, q(ctx.seatCommitted + toCall + potAfterCall, step))
      : cap;

  if (toCall > step / 2) {
    out.push({ kind: 'fold', min: 0, max: 0 });
    out.push({ kind: 'call', min: q(ctx.seatCommitted + toCall, step), max: q(ctx.seatCommitted + toCall, step) });
  } else {
    out.push({ kind: 'check', min: ctx.seatCommitted, max: ctx.seatCommitted });
  }

  if (ctx.canRaise && ctx.seatStack > toCall + step / 2) {
    const rawMin = ctx.currentBet > step / 2 ? ctx.currentBet + Math.max(ctx.lastRaiseSize, ctx.bb) : ctx.bb;
    const minTo = Math.min(q(rawMin, step), maxRaiseTo);
    const kind = ctx.currentBet > step / 2 ? 'raise' : 'bet';
    const presets: Array<{ label: string; amount: number }> = [];
    const add = (label: string, amount: number): void => {
      const a = Math.min(Math.max(q(amount, step), minTo), maxRaiseTo);
      if (!presets.some((p) => Math.abs(p.amount - a) < step / 2)) presets.push({ label, amount: a });
    };
    if (ctx.street === 'preflop' && ctx.currentBet > step / 2) {
      add('2.5x', q(ctx.currentBet * 2.5, step));
      add('3x', q(ctx.currentBet * 3, step));
      add('4x', q(ctx.currentBet * 4, step));
    } else {
      add('⅓', q(ctx.seatCommitted + toCall + potAfterCall * 0.33, step));
      add('½', q(ctx.seatCommitted + toCall + potAfterCall * 0.5, step));
      add('¾', q(ctx.seatCommitted + toCall + potAfterCall * 0.75, step));
      add('Pot', q(ctx.seatCommitted + toCall + potAfterCall, step));
    }
    add('All in', maxRaiseTo);
    if (maxRaiseTo > ctx.seatCommitted + toCall + step / 2) {
      out.push({ kind, min: minTo, max: maxRaiseTo, presets });
    }
    if (ctx.variant !== 'plo4' || cap <= maxRaiseTo + step / 2) {
      out.push({ kind: 'allin', min: cap, max: cap });
    }
  }
  return out;
}

/**
 * Validate an inbound action against the legal set and return the exact
 * total-commitment the server will apply. `null` means "illegal — reject".
 */
export function resolveAction(
  legal: readonly LegalAction[],
  kind: string,
  amount: number,
  step = 0.01,
): { kind: LegalAction['kind']; to: number } | null {
  const entry = legal.find((l) => l.kind === kind);
  if (!entry) return null;
  if (kind === 'bet' || kind === 'raise') {
    if (!Number.isFinite(amount)) return null;
    const to = q(amount, step);
    if (to < entry.min - step / 2) return null;
    if (to > entry.max + step / 2) return null;
    return { kind: entry.kind, to: Math.min(Math.max(to, entry.min), entry.max) };
  }
  return { kind: entry.kind, to: entry.max };
}

/** Seeded generator with an unpredictable seed, for real deals. */
export function dealerRng(): Rng {
  const buf = new Uint32Array(1);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(buf);
  else buf[0] = (Math.random() * 0xffffffff) >>> 0;
  return new Rng(buf[0] ^ (Date.now() & 0xffffffff));
}
