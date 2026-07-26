/**
 * ROYALE — Sit & Go tournaments.
 *
 * Single-table 6-max and 9-max SNGs: a blind ladder with escalating antes,
 * a real prize pool, elimination handling, and — the part that actually
 * changes how the hand plays — a Malmuth–Harville ICM model that tells the
 * bots how much a stack is worth in money rather than chips. On the bubble a
 * marginal call stops being marginal, and the opponents know it.
 */

import { Rng } from '../core/rng.ts';
import type { GameVariant, TournamentState } from '../core/types.ts';

// ─────────────────────────── Configuration ───────────────────────────

export type SngSpeed = 'regular' | 'turbo' | 'hyper';

export interface SngConfig {
  id: string;
  name: string;
  seats: 6 | 9;
  /** entry, excluding the fee */
  buyIn: number;
  fee: number;
  startingStack: number;
  speed: SngSpeed;
  variant: GameVariant;
}

export const SPEED_MS: Record<SngSpeed, number> = {
  regular: 300_000,
  turbo: 180_000,
  hyper: 90_000,
};

export const SPEED_LABEL: Record<SngSpeed, string> = {
  regular: 'Regular',
  turbo: 'Turbo',
  hyper: 'Hyper',
};

/** The lobby's Sit & Go menu. */
export const SNG_TEMPLATES: SngConfig[] = [
  { id: 'sng-6-turbo-1', name: 'Six Shooter', seats: 6, buyIn: 1, fee: 0.1, startingStack: 1500, speed: 'turbo', variant: 'nlhe' },
  { id: 'sng-6-reg-5', name: 'Cardroom Six', seats: 6, buyIn: 5, fee: 0.4, startingStack: 2500, speed: 'regular', variant: 'nlhe' },
  { id: 'sng-6-hyper-10', name: 'Flash Six', seats: 6, buyIn: 10, fee: 0.6, startingStack: 1000, speed: 'hyper', variant: 'nlhe' },
  { id: 'sng-9-turbo-2', name: 'Full Ring Turbo', seats: 9, buyIn: 2, fee: 0.2, startingStack: 1500, speed: 'turbo', variant: 'nlhe' },
  { id: 'sng-9-reg-10', name: 'The Long Game', seats: 9, buyIn: 10, fee: 0.8, startingStack: 3000, speed: 'regular', variant: 'nlhe' },
  { id: 'sng-9-reg-50', name: 'High Roller Nine', seats: 9, buyIn: 50, fee: 3, startingStack: 5000, speed: 'regular', variant: 'nlhe' },
  { id: 'sng-6-plo-5', name: 'Omaha Six', seats: 6, buyIn: 5, fee: 0.4, startingStack: 2500, speed: 'turbo', variant: 'plo4' },
];

export function sngTemplate(id: string): SngConfig | null {
  return SNG_TEMPLATES.find((t) => t.id === id) ?? null;
}

// ─────────────────────────── Blind ladder ───────────────────────────

export interface BlindLevel {
  level: number;
  sb: number;
  bb: number;
  /** big-blind ante — one player posts it for the table */
  ante: number;
}

const LADDER: ReadonlyArray<readonly [number, number, number]> = [
  [10, 20, 0],
  [15, 30, 0],
  [20, 40, 5],
  [25, 50, 5],
  [30, 60, 10],
  [40, 80, 10],
  [50, 100, 15],
  [60, 120, 20],
  [80, 160, 25],
  [100, 200, 30],
  [125, 250, 35],
  [150, 300, 40],
  [200, 400, 50],
  [250, 500, 60],
  [300, 600, 75],
  [400, 800, 100],
  [500, 1000, 125],
  [600, 1200, 150],
  [800, 1600, 200],
  [1000, 2000, 250],
];

function roundBlind(v: number): number {
  if (v < 100) return Math.round(v / 5) * 5;
  if (v < 1000) return Math.round(v / 25) * 25;
  if (v < 10000) return Math.round(v / 100) * 100;
  return Math.round(v / 1000) * 1000;
}

/** Blind level `n` (1-indexed). Extends geometrically past the fixed ladder. */
export function blindLevel(n: number): BlindLevel {
  const level = Math.max(1, Math.floor(n));
  if (level <= LADDER.length) {
    const l = LADDER[level - 1];
    return { level, sb: l[0], bb: l[1], ante: l[2] };
  }
  const last = LADDER[LADDER.length - 1];
  const growth = Math.pow(1.35, level - LADDER.length);
  const bb = roundBlind(last[1] * growth);
  return { level, sb: roundBlind(bb / 2), bb, ante: roundBlind(last[2] * growth) };
}

export function levelDurationMs(speed: SngSpeed): number {
  return SPEED_MS[speed];
}

/** A readable preview of the next few levels, for the tournament info sheet. */
export function ladderPreview(from: number, count = 6): BlindLevel[] {
  const out: BlindLevel[] = [];
  for (let i = 0; i < count; i++) out.push(blindLevel(from + i));
  return out;
}

// ─────────────────────────── Payouts ───────────────────────────

const PAYOUT_SHAPE: Record<number, number[]> = {
  6: [0.65, 0.35],
  9: [0.5, 0.3, 0.2],
};

/** Prize money by finishing place. Rounded to cents, remainder to first. */
export function payoutsFor(seats: number, prizePool: number): number[] {
  const shape = PAYOUT_SHAPE[seats] ?? (seats <= 6 ? PAYOUT_SHAPE[6] : PAYOUT_SHAPE[9]);
  const out = shape.map((s) => Math.round(prizePool * s * 100) / 100);
  const sum = out.reduce((a, b) => a + b, 0);
  out[0] = Math.round((out[0] + (prizePool - sum)) * 100) / 100;
  return out;
}

// ─────────────────────────── ICM ───────────────────────────

const icmIdx = new Int32Array(16);
const icmStack = new Float64Array(16);
const icmOut = new Float64Array(16);

/**
 * Malmuth–Harville finishing-position equity. Exact for the payout depth we
 * use (2 or 3 places over ≤9 players is a few hundred branches) and written
 * against fixed scratch buffers so it can run inside a bot decision.
 */
export function icmEquity(stacks: readonly number[], payouts: readonly number[]): number[] {
  const n = stacks.length;
  if (n === 0) return [];
  for (let i = 0; i < n; i++) {
    icmIdx[i] = i;
    icmStack[i] = Math.max(0, stacks[i]);
    icmOut[i] = 0;
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += icmStack[i];
  if (total <= 0) {
    const share = (payouts.reduce((a, b) => a + b, 0)) / n;
    return new Array(n).fill(share);
  }
  const depth = Math.min(payouts.length, n);

  // `live` is a prefix of icmIdx; finishing a player swaps them out of it.
  const recurse = (liveCount: number, liveTotal: number, place: number, prob: number): void => {
    if (place >= depth || prob < 1e-12) return;
    for (let k = 0; k < liveCount; k++) {
      const i = icmIdx[k];
      const s = icmStack[i];
      if (s <= 0) continue;
      const p = (prob * s) / liveTotal;
      icmOut[i] += p * payouts[place];
      if (place + 1 < depth && liveCount > 1) {
        const last = liveCount - 1;
        const tmp = icmIdx[last];
        icmIdx[last] = i;
        icmIdx[k] = tmp;
        recurse(last, liveTotal - s, place + 1, p);
        icmIdx[k] = i;
        icmIdx[last] = tmp;
      }
    }
  };
  recurse(n, total, 0, 1);

  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = icmOut[i];
  return out;
}

// ─────────────────────────── Entrants ───────────────────────────

export interface SngEntrantInit {
  seat: number;
  id: string;
  name: string;
  isHuman: boolean;
}

export interface SngEntrant {
  seat: number;
  id: string;
  name: string;
  isHuman: boolean;
  stack: number;
  /** null while still playing */
  place: number | null;
  prize: number;
  bustedHandId: number | null;
}

export interface SngElimination {
  seat: number;
  id: string;
  name: string;
  isHuman: boolean;
  place: number;
  prize: number;
  handId: number;
  /** true when the bust decided the money — the bubble */
  wasBubble: boolean;
}

export interface SngStanding {
  seat: number;
  name: string;
  stack: number;
  bb: number;
  rank: number;
  isHuman: boolean;
  out: boolean;
  place: number | null;
  /** current $ equity from ICM */
  equity: number;
}

// ─────────────────────────── Tournament ───────────────────────────

export class SitAndGo {
  readonly config: SngConfig;
  readonly entrants: SngEntrant[];
  readonly prizePool: number;
  readonly payouts: number[];

  private levelIndex = 1;
  private msLeft: number;
  private rng: Rng;
  private finishedFlag = false;
  private handsPlayed = 0;
  /** cached ICM pressure per seat, invalidated whenever a stack changes */
  private pressureCache = new Map<number, number>();
  private pressureDirty = true;

  constructor(config: SngConfig, seats: SngEntrantInit[], seed = 0x5e6a) {
    this.config = config;
    this.rng = new Rng(seed >>> 0);
    this.entrants = seats.map((s) => ({
      seat: s.seat,
      id: s.id,
      name: s.name,
      isHuman: s.isHuman,
      stack: config.startingStack,
      place: null,
      prize: 0,
      bustedHandId: null,
    }));
    this.prizePool = Math.round(config.buyIn * this.entrants.length * 100) / 100;
    this.payouts = payoutsFor(config.seats, this.prizePool);
    this.msLeft = levelDurationMs(config.speed);
  }

  // ── clock & levels

  get level(): BlindLevel {
    return blindLevel(this.levelIndex);
  }

  get msUntilLevelUp(): number {
    return this.msLeft;
  }

  get finished(): boolean {
    return this.finishedFlag || this.playersLeft <= 1;
  }

  get playersLeft(): number {
    return this.entrants.filter((e) => e.place === null).length;
  }

  get entryCount(): number {
    return this.entrants.length;
  }

  /** Advance the tournament clock. Returns the new level when it ticks over. */
  tick(dtMs: number): BlindLevel | null {
    if (this.finished || dtMs <= 0) return null;
    this.msLeft -= dtMs;
    if (this.msLeft > 0) return null;
    const dur = levelDurationMs(this.config.speed);
    let leveled: BlindLevel | null = null;
    while (this.msLeft <= 0) {
      this.levelIndex++;
      this.msLeft += dur;
      leveled = this.level;
    }
    this.pressureDirty = true;
    return leveled;
  }

  /** Jump straight to a level — used by the "speed up" debug control. */
  setLevel(n: number): BlindLevel {
    this.levelIndex = Math.max(1, Math.floor(n));
    this.msLeft = levelDurationMs(this.config.speed);
    this.pressureDirty = true;
    return this.level;
  }

  noteHandComplete(): void {
    this.handsPlayed++;
  }

  get hands(): number {
    return this.handsPlayed;
  }

  // ── stacks & elimination

  seatOf(seat: number): SngEntrant | null {
    return this.entrants.find((e) => e.seat === seat) ?? null;
  }

  setStack(seat: number, stack: number): void {
    const e = this.seatOf(seat);
    if (!e || e.place !== null) return;
    const next = Math.max(0, Math.round(stack));
    if (next !== e.stack) this.pressureDirty = true;
    e.stack = next;
  }

  /**
   * Push the table's stacks in and take back whoever busted. Eliminations come
   * back ordered worst-place-first so the UI can stagger the bust animations.
   */
  syncStacks(stacks: ReadonlyMap<number, number>, handId: number): SngElimination[] {
    for (const [seat, stack] of stacks) this.setStack(seat, stack);
    const busted = this.entrants.filter((e) => e.place === null && e.stack <= 0);
    if (busted.length === 0) return [];
    // Simultaneous busts: the bigger starting stack finishes higher.
    busted.sort((a, b) => (stacks.get(b.seat) ?? 0) - (stacks.get(a.seat) ?? 0));
    const out: SngElimination[] = [];
    for (const e of busted) out.push(this.eliminate(e.seat, handId));
    return out;
  }

  eliminate(seat: number, handId: number): SngElimination {
    const e = this.seatOf(seat);
    if (!e || e.place !== null) {
      return {
        seat,
        id: e?.id ?? `seat-${seat}`,
        name: e?.name ?? '',
        isHuman: e?.isHuman ?? false,
        place: e?.place ?? this.entrants.length,
        prize: e?.prize ?? 0,
        handId,
        wasBubble: false,
      };
    }
    const place = this.playersLeft;
    e.place = place;
    e.stack = 0;
    e.bustedHandId = handId;
    e.prize = place <= this.payouts.length ? this.payouts[place - 1] : 0;
    this.pressureDirty = true;
    if (this.playersLeft <= 1) this.finishWinner(handId);
    return {
      seat,
      id: e.id,
      name: e.name,
      isHuman: e.isHuman,
      place,
      prize: e.prize,
      handId,
      wasBubble: place === this.payouts.length + 1,
    };
  }

  private finishWinner(handId: number): void {
    const alive = this.entrants.filter((e) => e.place === null);
    if (alive.length !== 1) return;
    const w = alive[0];
    w.place = 1;
    w.prize = this.payouts[0] ?? 0;
    w.bustedHandId = handId;
    this.finishedFlag = true;
  }

  /** True when the very next bust cashes nobody — the money bubble. */
  get onBubble(): boolean {
    return this.playersLeft === this.payouts.length + 1;
  }

  get inTheMoney(): boolean {
    return this.playersLeft <= this.payouts.length;
  }

  isHeadsUp(): boolean {
    return this.playersLeft === 2;
  }

  // ── seating

  /** Seats still playing, in clockwise order. */
  activeSeats(): number[] {
    return this.entrants
      .filter((e) => e.place === null)
      .map((e) => e.seat)
      .sort((a, b) => a - b);
  }

  /**
   * Move the button clockwise onto the next seat that is still alive. Single
   * table SNGs do not break tables, so "rebalancing" is exactly this: the
   * button skips dead seats and the blinds compress toward the survivors.
   */
  advanceButton(currentButton: number, seatCount: number): number {
    const alive = new Set(this.activeSeats());
    if (alive.size === 0) return currentButton;
    for (let i = 1; i <= seatCount; i++) {
      const s = (currentButton + i) % seatCount;
      if (alive.has(s)) return s;
    }
    return currentButton;
  }

  /** Seat order for a hand, starting left of the button. */
  orbitOrder(button: number, seatCount: number): number[] {
    const alive = this.activeSeats();
    const out: number[] = [];
    for (let i = 1; i <= seatCount; i++) {
      const s = (button + i) % seatCount;
      if (alive.includes(s)) out.push(s);
    }
    return out;
  }

  // ── money

  prizeFor(place: number): number {
    return place >= 1 && place <= this.payouts.length ? this.payouts[place - 1] : 0;
  }

  /** Live $ equity per seat, keyed by seat number. */
  equities(): Map<number, number> {
    const alive = this.entrants.filter((e) => e.place === null);
    const eq = icmEquity(alive.map((e) => e.stack), this.payouts);
    const m = new Map<number, number>();
    alive.forEach((e, i) => m.set(e.seat, Math.round(eq[i] * 100) / 100));
    for (const e of this.entrants) if (e.place !== null) m.set(e.seat, e.prize);
    return m;
  }

  /**
   * Risk premium for a seat: how much more a lost chip costs than a won chip
   * is worth, in prize-money terms. 1.0 means chips are chips; on a 4-handed
   * bubble a short stack can easily see 1.6+, and the bots tighten accordingly.
   */
  icmPressure(seat: number): number {
    if (this.finished) return 1;
    if (!this.pressureDirty) {
      const hit = this.pressureCache.get(seat);
      if (hit !== undefined) return hit;
    } else {
      this.pressureCache.clear();
      this.pressureDirty = false;
    }

    const alive = this.entrants.filter((e) => e.place === null);
    const me = alive.findIndex((e) => e.seat === seat);
    if (me < 0 || alive.length < 2) {
      this.pressureCache.set(seat, 1);
      return 1;
    }
    if (alive.length > this.payouts.length + 3) {
      this.pressureCache.set(seat, 1);
      return 1;
    }

    const stacks = alive.map((e) => e.stack);
    const base = icmEquity(stacks, this.payouts);
    // Flip against the opponent whose stack is closest to ours — the most
    // representative confrontation at the table.
    let foe = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < alive.length; i++) {
      if (i === me) continue;
      const d = Math.abs(stacks[i] - stacks[me]);
      if (d < bestDelta) {
        bestDelta = d;
        foe = i;
      }
    }
    if (foe < 0) {
      this.pressureCache.set(seat, 1);
      return 1;
    }
    const d = Math.max(1, Math.min(stacks[me], stacks[foe]));

    const win = stacks.slice();
    win[me] += d;
    win[foe] -= d;
    const lose = stacks.slice();
    lose[me] -= d;
    lose[foe] += d;

    const eqWin = icmEquity(win, this.payouts)[me];
    const eqLose = icmEquity(lose, this.payouts)[me];
    const gain = eqWin - base[me];
    const risk = base[me] - eqLose;
    const pressure = gain <= 1e-9 ? 2.2 : Math.max(1, Math.min(2.4, risk / gain));
    this.pressureCache.set(seat, pressure);
    return pressure;
  }

  // ── views

  standings(): SngStanding[] {
    const eq = this.equities();
    const bb = this.level.bb;
    const rows: SngStanding[] = this.entrants.map((e) => ({
      seat: e.seat,
      name: e.name,
      stack: e.stack,
      bb: bb > 0 ? Math.round((e.stack / bb) * 10) / 10 : 0,
      rank: 0,
      isHuman: e.isHuman,
      out: e.place !== null,
      place: e.place,
      equity: eq.get(e.seat) ?? 0,
    }));
    rows.sort((a, b) => {
      if (a.out !== b.out) return a.out ? 1 : -1;
      if (a.out && b.out) return (a.place ?? 99) - (b.place ?? 99);
      return b.stack - a.stack;
    });
    rows.forEach((r, i) => (r.rank = i + 1));
    return rows;
  }

  /** Final results, best place first. Only meaningful once `finished`. */
  results(): SngEntrant[] {
    return this.entrants
      .filter((e) => e.place !== null)
      .slice()
      .sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  }

  averageStack(): number {
    const alive = this.entrants.filter((e) => e.place === null);
    if (!alive.length) return 0;
    return Math.round(alive.reduce((a, e) => a + e.stack, 0) / alive.length);
  }

  chipLeader(): SngEntrant | null {
    const alive = this.entrants.filter((e) => e.place === null);
    if (!alive.length) return null;
    return alive.reduce((a, b) => (b.stack > a.stack ? b : a));
  }

  /** The place the human finished in, or null while they are still alive. */
  humanPlace(): number | null {
    const h = this.entrants.find((e) => e.isHuman);
    return h ? h.place : null;
  }

  /** Snapshot for `TableState.tournament`. */
  state(): TournamentState {
    const l = this.level;
    return {
      level: l.level,
      sb: l.sb,
      bb: l.bb,
      ante: l.ante,
      msUntilLevelUp: Math.max(0, Math.round(this.msLeft)),
      levelDurationMs: levelDurationMs(this.config.speed),
      playersLeft: this.playersLeft,
      entrants: this.entrants.length,
      prizePool: this.prizePool,
      payouts: this.payouts.slice(),
      finishedPlace: this.humanPlace(),
    };
  }

  /** A one-line status the table banner can render. */
  headline(): string {
    if (this.finished) {
      const p = this.humanPlace();
      if (p === 1) return 'Champion';
      if (p) return `Finished ${ordinal(p)}`;
      return 'Tournament complete';
    }
    if (this.isHeadsUp()) return 'Heads up for the title';
    if (this.onBubble) return `Bubble — ${this.playersLeft} left, ${this.payouts.length} paid`;
    if (this.inTheMoney) return `In the money — ${this.playersLeft} left`;
    return `${this.playersLeft} of ${this.entrants.length} left`;
  }

  /** Deterministic, seeded jitter used for bot join delays and flavour. */
  jitter(): number {
    return this.rng.next();
  }
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** Total cost to enter, for the lobby card. */
export function totalBuyIn(c: SngConfig): number {
  return Math.round((c.buyIn + c.fee) * 100) / 100;
}

/** Starting stack expressed in big blinds at level 1 — the "depth" badge. */
export function startingDepthBb(c: SngConfig): number {
  return Math.round(c.startingStack / blindLevel(1).bb);
}
