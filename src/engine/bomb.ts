/**
 * ROYALE — bomb pots.
 *
 * Every N hands the table skips the preflop street entirely: everyone antes,
 * the flop lands immediately, and the betting starts from there. The double
 * board variant deals two runouts, splits the pot between them, and lets a
 * player scoop both halves — which is where the screaming comes from.
 *
 * This module owns the schedule, the countdown the UI renders, the ante maths
 * and the multi-board pot resolution. It deliberately knows nothing about how
 * cards are dealt; the table driver asks it what kind of hand to run.
 */

import { Rng } from '../core/rng.ts';
import type { BombPotConfig, Pot } from '../core/types.ts';

// ─────────────────────────── Settings ───────────────────────────

export interface BombPotSettings {
  enabled: boolean;
  /** each player's forced ante, in big blinds */
  anteBb: number;
  /** how many boards a bomb pot runs */
  boards: 1 | 2;
  /** a bomb pot fires on every Nth hand */
  triggerEveryHands: number;
  /** the countdown becomes visible this many hands out */
  announceWithin: number;
  /** alternate between single and double board so it never gets stale */
  mixBoards: boolean;
  /** probability of a double board when mixing */
  doubleChance: number;
}

export const DEFAULT_BOMB_SETTINGS: BombPotSettings = {
  enabled: true,
  anteBb: 1,
  boards: 1,
  triggerEveryHands: 10,
  announceWithin: 3,
  mixBoards: true,
  doubleChance: 0.4,
};

export interface BombPlan {
  /** true when the hand about to be dealt is a bomb pot */
  active: boolean;
  boards: 1 | 2;
  anteBb: number;
  /** chips each seated player must ante */
  anteChips: number;
  /** the pot before any betting, given the number of players anteing */
  seedPot: number;
}

export const NO_BOMB: BombPlan = { active: false, boards: 1, anteBb: 0, anteChips: 0, seedPot: 0 };

export interface BombCountdown {
  handsUntilNext: number;
  /** true when the *next* hand is the bomb */
  imminent: boolean;
  /** true while the current hand is itself a bomb pot */
  active: boolean;
  boards: 1 | 2;
  /** short all-caps string for the table banner */
  label: string;
  /** longer line for the lobby card */
  detail: string;
  /** 0..1 — how close we are, for a progress ring */
  progress: number;
}

function quant(v: number, unit: number): number {
  if (unit <= 0) return v;
  return Math.round(Math.round(v / unit) * unit * 1e6) / 1e6;
}

/** Chips each player antes for a bomb pot. */
export function bombAnteChips(anteBb: number, bb: number, chipUnit = 0.01): number {
  return Math.max(chipUnit, quant(anteBb * bb, chipUnit));
}

// ─────────────────────────── Scheduler ───────────────────────────

/**
 * Counts hands and decides when the next bomb fires. One instance per table;
 * the table driver calls `beginHand()` before dealing and `endHand()` after.
 */
export class BombPotScheduler {
  private s: BombPotSettings;
  private rng: Rng;
  private countdown: number;
  private current: BombPlan = NO_BOMB;
  private forced = false;

  constructor(settings: Partial<BombPotSettings> = {}, seed = 0xb0_b0) {
    this.s = { ...DEFAULT_BOMB_SETTINGS, ...settings };
    this.rng = new Rng(seed >>> 0);
    this.countdown = Math.max(1, this.s.triggerEveryHands);
  }

  get settings(): Readonly<BombPotSettings> {
    return this.s;
  }

  update(patch: Partial<BombPotSettings>): void {
    const wasEvery = this.s.triggerEveryHands;
    this.s = { ...this.s, ...patch };
    if (this.s.triggerEveryHands !== wasEvery) {
      this.countdown = Math.min(this.countdown, Math.max(1, this.s.triggerEveryHands));
    }
  }

  /** Force the next hand to be a bomb pot (the "run it now" button). */
  forceNext(): void {
    this.forced = true;
    this.countdown = 1;
  }

  /** Push the bomb back a full cycle. */
  skipNext(): void {
    this.forced = false;
    this.countdown = Math.max(1, this.s.triggerEveryHands);
  }

  reset(): void {
    this.forced = false;
    this.current = NO_BOMB;
    this.countdown = Math.max(1, this.s.triggerEveryHands);
  }

  /**
   * Decide what the hand about to be dealt looks like.
   * `bb` is the current big blind; `players` the number of seats posting.
   */
  beginHand(bb: number, players: number, chipUnit = 0.01): BombPlan {
    if (!this.s.enabled || players < 2) {
      this.current = NO_BOMB;
      return NO_BOMB;
    }
    if (this.countdown > 1 && !this.forced) {
      // Not this hand — burn one off the counter so the banner reads correctly
      // *during* the hand rather than a hand behind it.
      this.countdown--;
      this.current = NO_BOMB;
      return NO_BOMB;
    }
    const boards: 1 | 2 = this.s.mixBoards ? (this.rng.next() < this.s.doubleChance ? 2 : 1) : this.s.boards;
    const anteChips = bombAnteChips(this.s.anteBb, bb, chipUnit);
    this.current = {
      active: true,
      boards,
      anteBb: this.s.anteBb,
      anteChips,
      seedPot: quant(anteChips * players, chipUnit),
    };
    return this.current;
  }

  /** Close out the hand. Call exactly once after each completed hand. */
  endHand(): void {
    if (this.current.active) {
      this.forced = false;
      this.countdown = Math.max(1, this.s.triggerEveryHands);
    }
    this.current = NO_BOMB;
  }

  /** The plan for the hand currently in progress. */
  plan(): BombPlan {
    return this.current;
  }

  /** Snapshot for `TableState.bombPot` — null when bomb pots are off. */
  config(): BombPotConfig | null {
    if (!this.s.enabled) return null;
    return {
      anteBb: this.s.anteBb,
      boards: this.current.active ? this.current.boards : this.s.boards,
      triggerEveryHands: this.s.triggerEveryHands,
      handsUntilNext: this.current.active ? 0 : this.countdown,
    };
  }

  /** Everything the countdown chip needs, pre-formatted. */
  status(): BombCountdown {
    const active = this.current.active;
    const left = active ? 0 : this.countdown;
    const boards: 1 | 2 = active ? this.current.boards : this.s.boards;
    const every = Math.max(1, this.s.triggerEveryHands);
    let label: string;
    if (active) label = boards === 2 ? 'DOUBLE BOARD BOMB' : 'BOMB POT';
    else if (left <= 1) label = 'BOMB POT NEXT HAND';
    else label = `BOMB IN ${left}`;
    const detail = active
      ? boards === 2
        ? 'Two boards. Ante in, no preflop, scoop or split.'
        : 'Everyone antes. No preflop betting — straight to the flop.'
      : left <= 1
        ? `Everyone antes ${this.s.anteBb}bb. Flop deals immediately.`
        : `Bomb pot every ${every} hands.`;
    return {
      handsUntilNext: left,
      imminent: !active && left <= 1,
      active,
      boards,
      label,
      detail,
      progress: active ? 1 : 1 - (left - 1) / every,
    };
  }

  /** Hands until the next bomb, for `LobbyTable.bombPotIn`. */
  handsUntilNext(): number | null {
    if (!this.s.enabled) return null;
    return this.current.active ? 0 : this.countdown;
  }
}

// ─────────────────────────── Multi-board resolution ───────────────────────────

export interface BombAward {
  seat: number;
  amount: number;
  potIndex: number;
  boardIndex: number;
}

export interface BombBoardResult {
  boardIndex: number;
  potIndex: number;
  winners: number[];
  amount: number;
}

export interface BombResolution {
  awards: BombAward[];
  /** total won per seat across every board and side pot */
  totals: Map<number, number>;
  /** seats that won every board of the main pot — the scoop */
  scoopers: number[];
  perBoard: BombBoardResult[];
}

export interface MultiBoardInput {
  pots: readonly Pot[];
  boards: 1 | 2;
  /** rank value for a seat on a board; return -1 when the seat cannot win it */
  rankOf: (seat: number, boardIndex: number) => number;
  /** seats in clockwise order starting left of the button — decides odd chips */
  oddChipOrder: readonly number[];
  chipUnit?: number;
}

/**
 * Splits every pot across the boards and awards each share to that board's
 * best hand. Odd chips travel clockwise from the button, exactly like a live
 * dealer would push them.
 */
export function resolveMultiBoard(input: MultiBoardInput): BombResolution {
  const unit = input.chipUnit ?? 0.01;
  const boards = input.boards;
  const awards: BombAward[] = [];
  const perBoard: BombBoardResult[] = [];
  const totals = new Map<number, number>();
  const order = input.oddChipOrder;

  const push = (seat: number, amount: number, potIndex: number, boardIndex: number): void => {
    if (amount <= 0) return;
    awards.push({ seat, amount, potIndex, boardIndex });
    totals.set(seat, quant((totals.get(seat) ?? 0) + amount, unit));
  };

  const mainWinnersByBoard: number[][] = [];

  for (const pot of input.pots) {
    // All splitting happens in whole chip units. Doing it in floats loses a
    // cent on boards that divide evenly, which is exactly the bug players
    // screenshot and post.
    const potUnits = Math.round(pot.amount / unit);
    const shares: number[] = [];
    const baseUnits = Math.floor(potUnits / boards);
    let extra = potUnits - baseUnits * boards;
    for (let b = 0; b < boards; b++) {
      const u = baseUnits + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      shares.push(u);
    }

    for (let b = 0; b < boards; b++) {
      let best = -1;
      let winners: number[] = [];
      for (const seat of pot.eligible) {
        const v = input.rankOf(seat, b);
        if (v < 0) continue;
        if (v > best) {
          best = v;
          winners = [seat];
        } else if (v === best) {
          winners.push(seat);
        }
      }
      if (winners.length === 0) winners = pot.eligible.slice();
      if (pot.index === 0) mainWinnersByBoard.push(winners.slice());

      const shareUnits = shares[b];
      const amount = quant(shareUnits * unit, unit);
      perBoard.push({ boardIndex: b, potIndex: pot.index, winners: winners.slice(), amount });
      if (winners.length === 1) {
        push(winners[0], amount, pot.index, b);
        continue;
      }
      // Even split, then the odd chips walk clockwise from the button.
      const perUnits = Math.floor(shareUnits / winners.length);
      let oddUnits = shareUnits - perUnits * winners.length;
      const ordered = order.filter((s) => winners.includes(s));
      const ring = ordered.length ? ordered : winners;
      for (const seat of winners) push(seat, quant(perUnits * unit, unit), pot.index, b);
      for (let i = 0; oddUnits > 0 && ring.length > 0; i++, oddUnits--) {
        push(ring[i % ring.length], unit, pot.index, b);
      }
    }
  }

  // A scoop is taking the main pot outright on every board — a chop on one of
  // them is a split, and the celebration should know the difference.
  let scoopers: number[] = [];
  if (mainWinnersByBoard.length >= 1) {
    const sole = mainWinnersByBoard.every((w) => w.length === 1);
    if (sole) {
      scoopers = mainWinnersByBoard[0].filter((s) => mainWinnersByBoard.every((w) => w.includes(s)));
    }
  }

  return { awards, totals, scoopers, perBoard };
}

/**
 * The deal script for a bomb pot: which cards land on which board, in the
 * order the renderer should animate them. Both boards advance together so a
 * single betting round covers the street.
 */
export interface BombDealStep {
  street: 'flop' | 'turn' | 'river';
  boardIndex: number;
  count: number;
}

export function bombDealScript(boards: 1 | 2): BombDealStep[] {
  const steps: BombDealStep[] = [];
  for (let b = 0; b < boards; b++) steps.push({ street: 'flop', boardIndex: b, count: 3 });
  for (let b = 0; b < boards; b++) steps.push({ street: 'turn', boardIndex: b, count: 1 });
  for (let b = 0; b < boards; b++) steps.push({ street: 'river', boardIndex: b, count: 1 });
  return steps;
}

/** Cards a bomb pot burns through, so the table can size its deck check. */
export function bombCardsNeeded(boards: 1 | 2, players: number, holeCards: number): number {
  return players * holeCards + boards * 5;
}
