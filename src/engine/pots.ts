/**
 * Chip arithmetic, side-pot construction and pot distribution.
 *
 * Money in this app is decimal (a $0.05/$0.10 table moves cents), so every
 * mutation runs through `roundChips` against the table's chip step. That keeps
 * 0.1 + 0.2 from ever showing up as 0.30000000000000004 in a stack pill, and it
 * gives odd-chip distribution a well-defined smallest unit.
 *
 * Side pots are built from per-seat *total* commitments, which is the only
 * input that is always correct — it survives folds, all-ins on earlier streets
 * and short blinds without any special casing.
 */
import type { Pot } from '../core/types.ts';

/** Smallest chip a table moves. Cents by default; SNGs override with 1. */
export const DEFAULT_CHIP_STEP = 0.01;

/** Rounds to the nearest chip step, killing binary-float dust. */
export function roundChips(x: number, step: number = DEFAULT_CHIP_STEP): number {
  const inv = 1 / step;
  return Math.round(x * inv) / inv;
}

/** Rounds down to a whole chip step — used for anything that must stay legal. */
export function floorChips(x: number, step: number = DEFAULT_CHIP_STEP): number {
  const inv = 1 / step;
  return Math.floor(roundChips(x * inv, 1e-6)) / inv;
}

/** Rounds up to a whole chip step. */
export function ceilChips(x: number, step: number = DEFAULT_CHIP_STEP): number {
  const inv = 1 / step;
  return Math.ceil(roundChips(x * inv, 1e-6)) / inv;
}

/** Float-safe comparison at chip granularity. */
export function chipsEqual(a: number, b: number, step: number = DEFAULT_CHIP_STEP): boolean {
  return Math.abs(a - b) < step / 2;
}

// ─────────────────────────── side pots ───────────────────────────

export interface Commitment {
  seat: number;
  /** total chips this seat put in across the whole hand */
  total: number;
  /** folded seats still contribute dead money but can never win a pot */
  folded: boolean;
}

/**
 * Builds the main pot and every side pot from total commitments.
 *
 * Walks the distinct commitment levels bottom-up. Each level contributes a
 * layer of `(level - previous) x contributors`, and the seats eligible for that
 * layer are the un-folded seats who reached it. Layers that share an eligible
 * set are merged so the UI shows "Main / Side 1 / Side 2" and nothing sillier.
 */
export function buildPots(commitments: readonly Commitment[], step: number = DEFAULT_CHIP_STEP): Pot[] {
  const live = commitments
    .filter((c) => c.total > 0)
    .map((c) => ({ seat: c.seat, total: roundChips(c.total, step), folded: c.folded }));
  if (live.length === 0) return [];

  const levels = Array.from(new Set(live.map((c) => c.total))).sort((a, b) => a - b);

  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    const band = roundChips(level - prev, step);
    if (band <= 0) { prev = level; continue; }
    let amount = 0;
    const eligible: number[] = [];
    for (const c of live) {
      if (c.total >= level - step / 2) {
        amount = roundChips(amount + band, step);
        if (!c.folded) eligible.push(c.seat);
      }
    }
    eligible.sort((a, b) => a - b);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      if (last && sameSeats(last.eligible, eligible)) {
        last.amount = roundChips(last.amount + amount, step);
      } else {
        pots.push({ amount, eligible: eligible.slice(), index: pots.length });
      }
    }
    prev = level;
  }

  // Dead money from a level nobody can win (everyone there folded) belongs to
  // the nearest pot below it that still has claimants.
  for (let i = pots.length - 1; i > 0; i--) {
    if (pots[i].eligible.length === 0) {
      pots[i - 1].amount = roundChips(pots[i - 1].amount + pots[i].amount, step);
      pots.splice(i, 1);
    }
  }
  for (let i = 0; i < pots.length; i++) pots[i].index = i;
  return pots;
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Total across every pot. */
export function potTotal(pots: readonly Pot[]): number {
  let t = 0;
  for (const p of pots) t += p.amount;
  return roundChips(t, 1e-6);
}

/**
 * When the last aggressor's bet goes uncalled, the excess never belonged in the
 * pot — it comes straight back. Returns the refund (0 if the bet was matched).
 */
export function uncalledPortion(
  commitments: readonly Commitment[],
  step: number = DEFAULT_CHIP_STEP,
): { seat: number; amount: number } | null {
  let top = -Infinity, second = -Infinity, topSeat = -1, topCount = 0;
  for (const c of commitments) {
    if (c.total > top + step / 2) {
      second = top; top = c.total; topSeat = c.seat; topCount = 1;
    } else if (chipsEqual(c.total, top, step)) {
      topCount++;
    } else if (c.total > second + step / 2) {
      second = c.total;
    }
  }
  if (topCount !== 1 || topSeat < 0 || second === -Infinity) return null;
  const amount = roundChips(top - second, step);
  return amount > 0 ? { seat: topSeat, amount } : null;
}

// ─────────────────────────── distribution ───────────────────────────

export interface Award {
  seat: number;
  amount: number;
  potIndex: number;
  /** how many seats shared this pot */
  split: number;
  /** extra indivisible chips this seat received */
  oddChips: number;
}

export interface DistributeInput {
  pots: readonly Pot[];
  /** seat -> hand strength; a seat missing from the map cannot win */
  strength: ReadonlyMap<number, number>;
  buttonSeat: number;
  /** every seat index at the table, ascending — defines "left of the button" */
  seatCount: number;
  step?: number;
}

/**
 * Awards every pot to its winners.
 *
 * Odd chips — the remainder when a pot does not divide evenly — go to the
 * winner closest to the left of the button, one chip at a time, which is the
 * rule every live room and every major site uses.
 */
export function distribute(input: DistributeInput): Award[] {
  const step = input.step ?? DEFAULT_CHIP_STEP;
  const awards: Award[] = [];

  for (const pot of input.pots) {
    const contenders = pot.eligible.filter((s) => input.strength.has(s));
    if (contenders.length === 0) continue;

    let best = -Infinity;
    for (const s of contenders) {
      const v = input.strength.get(s)!;
      if (v > best) best = v;
    }
    const winners = contenders.filter((s) => input.strength.get(s) === best);
    const share = roundChips(pot.amount, step);
    if (share <= 0) continue;

    const ordered = orderFromButton(winners, input.buttonSeat, input.seatCount);
    const each = floorChips(share / ordered.length, step);
    let remainder = roundChips(share - each * ordered.length, step);

    for (const seat of ordered) {
      let amount = each;
      let odd = 0;
      if (remainder > step / 2) {
        amount = roundChips(amount + step, step);
        odd = step;
        remainder = roundChips(remainder - step, step);
      }
      if (amount <= 0) continue;
      awards.push({ seat, amount, potIndex: pot.index, split: ordered.length, oddChips: odd });
    }
  }
  return awards;
}

/**
 * Seats ordered starting with the first one clockwise from the button —
 * i.e. the small blind seat first. This is the odd-chip priority order.
 */
export function orderFromButton(seats: readonly number[], buttonSeat: number, seatCount: number): number[] {
  return seats
    .slice()
    .sort((a, b) => {
      const da = (a - buttonSeat + seatCount * 2) % seatCount || seatCount;
      const db = (b - buttonSeat + seatCount * 2) % seatCount || seatCount;
      return da - db;
    });
}

/**
 * Splits every pot across N boards for run-it-twice / double-board hands.
 * Each board gets a floor share; the indivisible remainder rides with the
 * first board, so the sum of the splits is exactly the original pot.
 */
export function splitPotsAcrossBoards(
  pots: readonly Pot[],
  boards: number,
  step: number = DEFAULT_CHIP_STEP,
): Pot[][] {
  if (boards <= 1) return [pots.map((p) => ({ ...p, eligible: p.eligible.slice() }))];
  const out: Pot[][] = [];
  for (let b = 0; b < boards; b++) out.push([]);
  for (const pot of pots) {
    const each = floorChips(pot.amount / boards, step);
    let remainder = roundChips(pot.amount - each * boards, step);
    for (let b = 0; b < boards; b++) {
      let amount = each;
      if (remainder > step / 2) {
        amount = roundChips(amount + step, step);
        remainder = roundChips(remainder - step, step);
      }
      out[b].push({ amount, eligible: pot.eligible.slice(), index: pot.index });
    }
  }
  return out;
}

/** Takes rake off the top, main pot first. Returns the amount actually taken. */
export function takeRake(
  pots: Pot[],
  pct: number,
  cap: number,
  step: number = DEFAULT_CHIP_STEP,
): number {
  const total = potTotal(pots);
  let want = Math.min(floorChips(total * pct, step), roundChips(cap, step));
  let taken = 0;
  for (const pot of pots) {
    if (want <= 0) break;
    const bite = Math.min(pot.amount, want);
    pot.amount = roundChips(pot.amount - bite, step);
    want = roundChips(want - bite, step);
    taken = roundChips(taken + bite, step);
  }
  return taken;
}

/** Collapses awards to one total per seat, for the "you won $X" line. */
export function totalsBySeat(awards: readonly Award[], step: number = DEFAULT_CHIP_STEP): Map<number, number> {
  const m = new Map<number, number>();
  for (const a of awards) m.set(a.seat, roundChips((m.get(a.seat) ?? 0) + a.amount, step));
  return m;
}
