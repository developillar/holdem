/**
 * The betting round state machine.
 *
 * Owns everything about *who acts next* and *what they are allowed to do*:
 * blinds and antes, action order (including the heads-up reversal), legal
 * action computation with slider bounds and preset sizings, min-raise rules,
 * the all-in-under-raise no-reopen rule, and string-bet prevention.
 *
 * Amount convention — every amount in a legal action or an applied action is a
 * TOTAL street commitment ("raise to 30"), never a delta; folds and checks
 * carry 0. That is the number the UI slider shows and the number a hand history
 * prints, and it removes a whole class of off-by-a-call bugs. `deltaFor()`
 * converts to chips-off-stack when the renderer needs to fly the right number
 * of chips to the middle.
 */
import type { Action, ActionKind, GameVariant, Street } from '../core/types.ts';
import type { LegalAction } from '../core/bus.ts';
import { roundChips, floorChips, chipsEqual, DEFAULT_CHIP_STEP } from './pots.ts';
import { potLimitRaiseTo } from './plo.ts';

export type SeatPhase = 'out' | 'active' | 'folded' | 'allin';

export interface BettingSeat {
  seat: number;
  stack: number;
  /** chips committed on the current street */
  committed: number;
  /** chips committed across the whole hand, antes and blinds included */
  totalCommitted: number;
  phase: SeatPhase;
  /** has acted at the current bet level */
  hasActed: boolean;
  /** raise rights — revoked by an all-in that is less than a full raise */
  canRaise: boolean;
  lastAction: Action | null;
  /** true once the seat voluntarily put chips in this hand (VPIP) */
  voluntary: boolean;
}

export interface BettingConfig {
  variant: GameVariant;
  sb: number;
  bb: number;
  /** per-player ante, 0 for none */
  ante: number;
  /** smallest chip the table moves */
  step: number;
  /** total seats at the table — defines the clockwise ring */
  seatCount: number;
}

export interface SeatSeed {
  seat: number;
  stack: number;
  /** false for empty seats, sit-outs and busted players */
  inHand: boolean;
}

/** Thrown for any illegal client action. The message is user-presentable. */
export class IllegalActionError extends Error {
  readonly seat: number;
  constructor(message: string, seat: number) {
    super(message);
    this.name = 'IllegalActionError';
    this.seat = seat;
  }
}

export class Betting {
  readonly config: BettingConfig;
  readonly seats: BettingSeat[] = [];
  readonly buttonSeat: number;

  street: Street = 'preflop';
  currentBet = 0;
  /** size of the last full raise — the increment a min-raise must match */
  lastFullRaiseSize = 0;
  minRaiseTo = 0;
  actingSeat = -1;
  sbSeat = -1;
  bbSeat = -1;
  /** monotonic action index within the hand */
  seq = 0;
  /** every action taken this hand, in order — the replay tape */
  readonly log: Action[] = [];
  /** bumped whenever the turn passes; consumed by apply() to kill string bets */
  private turnToken = 0;
  private tokenUsed = -1;

  constructor(config: BettingConfig, seeds: readonly SeatSeed[], buttonSeat: number) {
    this.config = config;
    this.buttonSeat = buttonSeat;
    for (let i = 0; i < config.seatCount; i++) {
      this.seats.push({
        seat: i, stack: 0, committed: 0, totalCommitted: 0,
        phase: 'out', hasActed: false, canRaise: false, lastAction: null, voluntary: false,
      });
    }
    for (const s of seeds) {
      const seat = this.seats[s.seat];
      if (!seat) throw new Error(`seat ${s.seat} is outside the table`);
      seat.stack = roundChips(s.stack, config.step);
      seat.phase = s.inHand && seat.stack > 0 ? 'active' : 'out';
      seat.canRaise = seat.phase === 'active';
    }
    this.lastFullRaiseSize = config.bb;
    this.minRaiseTo = config.bb;
  }

  // ─────────────────────────── ring helpers ───────────────────────────

  /** Seats still in the hand (not folded, not empty) — includes all-ins. */
  liveSeats(): BettingSeat[] {
    return this.seats.filter((s) => s.phase === 'active' || s.phase === 'allin');
  }

  /** Seats that can still put chips in. */
  actableSeats(): BettingSeat[] {
    return this.seats.filter((s) => s.phase === 'active' && s.stack > this.config.step / 2);
  }

  /** Clockwise walk: the next seat after `from` matching `test`, or -1. */
  private nextSeat(from: number, test: (s: BettingSeat) => boolean): number {
    const n = this.config.seatCount;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (test(this.seats[i])) return i;
    }
    return -1;
  }

  private inHand(s: BettingSeat): boolean {
    return s.phase === 'active' || s.phase === 'allin';
  }

  // ─────────────────────────── forced bets ───────────────────────────

  /**
   * Posts antes (if any) and the blinds, and opens the preflop round.
   *
   * Heads-up the button posts the small blind and acts first before the flop,
   * then acts last on every later street — the single most-often-missed rule in
   * hobby poker code.
   */
  postForcedBets(): Action[] {
    const { ante, sb, bb, step } = this.config;
    const posted: Action[] = [];
    const players = this.seats.filter((s) => s.phase === 'active');
    if (players.length < 2) throw new Error('need at least two players to start a hand');
    if (!this.inHand(this.seats[this.buttonSeat])) {
      throw new Error('the button must sit on a seat that is in the hand');
    }

    if (ante > 0) {
      // Antes are dead money: they never count as a street commitment, so they
      // can never be "called", but they do count toward side-pot layers.
      for (const s of orderFrom(players, this.buttonSeat, this.config.seatCount)) {
        const amount = Math.min(roundChips(ante, step), s.stack);
        if (amount <= 0) continue;
        s.stack = roundChips(s.stack - amount, step);
        s.totalCommitted = roundChips(s.totalCommitted + amount, step);
        if (s.stack <= step / 2) s.phase = 'allin';
        posted.push(this.record(s, 'ante', amount));
      }
    }

    const heads = players.length === 2;
    this.sbSeat = heads ? this.buttonSeat : this.nextSeat(this.buttonSeat, (s) => s.phase === 'active' || s.phase === 'allin');
    this.bbSeat = this.nextSeat(this.sbSeat, (s) => s.phase === 'active' || s.phase === 'allin');

    this.postBlind(this.sbSeat, sb, posted);
    this.postBlind(this.bbSeat, bb, posted);

    this.street = 'preflop';
    this.currentBet = roundChips(bb, step);
    this.lastFullRaiseSize = roundChips(bb, step);
    this.minRaiseTo = roundChips(this.currentBet + this.lastFullRaiseSize, step);
    // First to act preflop is always the seat after the big blind. Heads-up
    // that resolves to the button, which is exactly right.
    this.openRound(this.bbSeat);
    return posted;
  }

  /**
   * Bomb pots have no preflop betting: everyone antes and the flop comes out.
   * Posts the ante for every player and leaves the street ready for the flop.
   */
  postBombAnte(anteChips: number): Action[] {
    const { step } = this.config;
    const posted: Action[] = [];
    const players = this.seats.filter((s) => s.phase === 'active');
    for (const s of orderFrom(players, this.buttonSeat, this.config.seatCount)) {
      const amount = Math.min(roundChips(anteChips, step), s.stack);
      if (amount <= 0) continue;
      s.stack = roundChips(s.stack - amount, step);
      s.totalCommitted = roundChips(s.totalCommitted + amount, step);
      if (s.stack <= step / 2) s.phase = 'allin';
      posted.push(this.record(s, 'ante', amount));
    }
    this.sbSeat = this.nextSeat(this.buttonSeat, (s) => this.inHand(s));
    this.bbSeat = this.nextSeat(this.sbSeat, (s) => this.inHand(s));
    this.street = 'preflop';
    this.currentBet = 0;
    return posted;
  }

  private postBlind(seat: number, amount: number, posted: Action[]): void {
    const s = this.seats[seat];
    if (!s) return;
    const { step } = this.config;
    const put = Math.min(roundChips(amount, step), s.stack);
    s.stack = roundChips(s.stack - put, step);
    s.committed = roundChips(s.committed + put, step);
    s.totalCommitted = roundChips(s.totalCommitted + put, step);
    if (s.stack <= step / 2) s.phase = 'allin';
    posted.push(this.record(s, 'post', put));
  }

  // ─────────────────────────── street lifecycle ───────────────────────────

  /** Resets street state and hands the action to the first live seat left of the button. */
  beginStreet(street: Street): void {
    const { step, bb } = this.config;
    this.street = street;
    for (const s of this.seats) {
      s.committed = 0;
      s.hasActed = false;
      s.canRaise = s.phase === 'active';
    }
    this.currentBet = 0;
    this.lastFullRaiseSize = roundChips(bb, step);
    this.minRaiseTo = roundChips(bb, step);
    this.openRound(this.buttonSeat);
  }

  /** Picks the first seat that owes an action, starting after `from`. */
  private openRound(from: number): void {
    this.actingSeat = -1;
    if (this.isRoundComplete()) return;
    const next = this.nextSeat(from, (s) => this.needsAction(s));
    this.actingSeat = next;
    this.turnToken++;
  }

  private needsAction(s: BettingSeat): boolean {
    if (s.phase !== 'active' || s.stack <= this.config.step / 2) return false;
    return !s.hasActed || s.committed < this.currentBet - this.config.step / 2;
  }

  /**
   * True when no further action is owed on this street. Also true the moment
   * only one player can still put chips in and they have matched the bet —
   * you cannot bet at a table where nobody can call.
   */
  isRoundComplete(): boolean {
    if (this.liveSeats().length <= 1) return true;
    const actable = this.actableSeats();
    if (actable.length === 0) return true;
    if (actable.length === 1) {
      const s = actable[0];
      return s.committed >= this.currentBet - this.config.step / 2;
    }
    return actable.every((s) => !this.needsAction(s));
  }

  /** True when every remaining player is all-in — skip straight to the board. */
  noMoreBetting(): boolean {
    const live = this.liveSeats();
    if (live.length <= 1) return true;
    const actable = this.actableSeats();
    if (actable.length === 0) return true;
    return actable.length === 1 && actable[0].committed >= this.currentBet - this.config.step / 2;
  }

  /** Chips already gathered from previous streets and antes (dead money). */
  potBefore(): number {
    let t = 0;
    for (const s of this.seats) t += s.totalCommitted - s.committed;
    return roundChips(t, 1e-6);
  }

  /** Chips wagered on the current street. */
  streetCommitted(): number {
    let t = 0;
    for (const s of this.seats) t += s.committed;
    return roundChips(t, 1e-6);
  }

  /** Everything in the middle right now. */
  pot(): number {
    let t = 0;
    for (const s of this.seats) t += s.totalCommitted;
    return roundChips(t, 1e-6);
  }

  // ─────────────────────────── legal actions ───────────────────────────

  /**
   * What `seat` may legally do right now, with slider bounds and the preset
   * chips the bet pad renders. Returns an empty list when it is not their turn.
   */
  legalActions(seat: number): LegalAction[] {
    const s = this.seats[seat];
    const { step, bb, variant } = this.config;
    if (!s || s.phase !== 'active' || s.stack <= step / 2) return [];

    const out: LegalAction[] = [];
    const shoveTo = roundChips(s.committed + s.stack, step);
    const owed = roundChips(this.currentBet - s.committed, step);

    if (owed > step / 2) {
      out.push({ kind: 'fold', min: 0, max: 0 });
      const callTo = Math.min(this.currentBet, shoveTo);
      out.push({ kind: 'call', min: callTo, max: callTo });
    } else {
      out.push({ kind: 'check', min: 0, max: 0 });
    }

    // Aggression: only with raise rights and chips beyond the call.
    if (s.canRaise && shoveTo > this.currentBet + step / 2) {
      const opening = this.currentBet <= step / 2;
      const capTo = variant === 'plo4'
        ? potLimitRaiseTo({
            potBefore: this.potBefore(),
            streetCommitted: this.streetCommitted(),
            currentBet: this.currentBet,
            myCommitted: s.committed,
            myStack: s.stack,
            step,
          })
        : shoveTo;
      // The true minimum. If the cap (stack, or the pot in pot-limit) cannot
      // reach it, no raise is legal — only the all-in below.
      const minTo = opening ? roundChips(bb, step) : this.minRaiseTo;

      if (capTo >= minTo - step / 2 && capTo > this.currentBet + step / 2) {
        const kind: ActionKind = opening ? 'bet' : 'raise';
        out.push({
          kind,
          min: roundChips(minTo, step),
          max: roundChips(capTo, step),
          presets: this.presets(s, minTo, capTo, opening),
        });
      }
      // An all-in that is short of a full raise is still legal — it just does
      // not reopen the betting. In pot-limit it is only legal up to the cap.
      if (shoveTo <= capTo + step / 2) {
        out.push({ kind: 'allin', min: shoveTo, max: shoveTo });
      }
    }
    return out;
  }

  /**
   * Preset sizings for the bet pad. Preflop no-limit thinks in multiples of the
   * current bet (plus a big blind per limper, the way regulars actually open);
   * every other spot thinks in fractions of the pot after calling.
   */
  private presets(
    s: BettingSeat,
    minTo: number,
    capTo: number,
    opening: boolean,
  ): Array<{ label: string; amount: number }> {
    const { step, bb, variant } = this.config;
    const toCall = Math.max(0, roundChips(this.currentBet - s.committed, step));
    const potAfterCall = roundChips(this.potBefore() + this.streetCommitted() + toCall, step);
    const raw: Array<{ label: string; amount: number }> = [];

    const preflopMultiples = this.street === 'preflop' && !opening && variant === 'nlhe';
    if (preflopMultiples) {
      let limpers = 0;
      for (const o of this.seats) {
        if (o.seat === s.seat || !this.inHand(o)) continue;
        if (o.seat !== this.bbSeat && chipsEqual(o.committed, this.currentBet, step)) limpers++;
      }
      const extra = roundChips(limpers * bb, step);
      raw.push({ label: '2.5x', amount: roundChips(this.currentBet * 2.5 + extra, step) });
      raw.push({ label: '3x', amount: roundChips(this.currentBet * 3 + extra, step) });
    } else {
      for (const [label, pct] of [['33%', 0.33], ['50%', 0.5], ['75%', 0.75]] as const) {
        raw.push({ label, amount: roundChips(this.currentBet + potAfterCall * pct, step) });
      }
    }
    raw.push({ label: 'Pot', amount: roundChips(this.currentBet + potAfterCall, step) });
    const shoveTo = roundChips(s.committed + s.stack, step);
    // In pot-limit a stack deeper than the pot simply cannot be shoved, so the
    // all-in chip is only offered when it is a legal wager.
    if (shoveTo <= capTo + step / 2) raw.push({ label: 'All-in', amount: shoveTo });

    const seen = new Set<number>();
    const out: Array<{ label: string; amount: number }> = [];
    for (const p of raw) {
      // Round down so a preset can never exceed the pot-limit cap, then clamp
      // into the legal band — a clamped chip is relabelled so the pad never
      // promises a sizing it is not actually going to make.
      let amount = floorChips(p.amount, step);
      let label = p.label;
      if (amount < minTo) { amount = minTo; label = 'Min'; }
      if (amount > capTo) { amount = capTo; label = variant === 'plo4' ? 'Max' : 'All-in'; }
      amount = roundChips(amount, step);
      if (chipsEqual(amount, shoveTo, step)) label = 'All-in';
      if (seen.has(amount)) continue;
      seen.add(amount);
      out.push({ label, amount });
    }
    return out;
  }

  /** Chips that leave the stack if `seat` performs `kind` at `amount`. */
  deltaFor(seat: number, kind: ActionKind, amount: number): number {
    const s = this.seats[seat];
    const { step } = this.config;
    if (!s) return 0;
    if (kind === 'fold' || kind === 'check') return 0;
    return Math.max(0, Math.min(s.stack, roundChips(amount - s.committed, step)));
  }

  // ─────────────────────────── applying an action ───────────────────────────

  /**
   * Validates and applies one action.
   *
   * String-bet prevention: an action must be a single complete declaration by
   * the seat whose turn it is. Acting out of turn, or acting twice on the same
   * turn (the "put chips in, then reach for more" move), throws.
   */
  apply(seat: number, kind: ActionKind, amount = 0, tookMs?: number): Action {
    const s = this.seats[seat];
    const { step } = this.config;
    if (!s) throw new IllegalActionError('no such seat', seat);
    if (seat !== this.actingSeat) {
      throw new IllegalActionError('acting out of turn', seat);
    }
    if (this.tokenUsed === this.turnToken) {
      throw new IllegalActionError('action already declared for this turn — no string bets', seat);
    }
    if (s.phase !== 'active') throw new IllegalActionError('seat cannot act', seat);

    const legal = this.legalActions(seat);
    const owed = roundChips(this.currentBet - s.committed, step);
    const shoveTo = roundChips(s.committed + s.stack, step);
    let normalized: ActionKind = kind;
    let total = roundChips(amount, step);

    switch (kind) {
      case 'fold': {
        total = 0;
        break;
      }
      case 'check': {
        if (owed > step / 2) throw new IllegalActionError(`cannot check facing ${owed}`, seat);
        total = s.committed;
        break;
      }
      case 'call': {
        if (owed <= step / 2) throw new IllegalActionError('nothing to call', seat);
        total = Math.min(this.currentBet, shoveTo);
        break;
      }
      case 'allin': {
        total = shoveTo;
        const cap = this.capFor(s);
        if (total > cap + step / 2) {
          throw new IllegalActionError('pot-limit: cannot wager more than the pot', seat);
        }
        if (total <= this.currentBet + step / 2) {
          // Shoving for less than the current bet is just an all-in call.
          normalized = 'call';
          total = Math.min(this.currentBet, shoveTo);
        }
        break;
      }
      case 'bet':
      case 'raise': {
        normalized = this.currentBet <= step / 2 ? 'bet' : 'raise';
        const entry = legal.find((l) => l.kind === 'bet' || l.kind === 'raise');
        if (!entry) {
          const shove = legal.find((l) => l.kind === 'allin');
          if (shove && chipsEqual(total, shove.max, step)) { normalized = 'allin'; total = shove.max; break; }
          throw new IllegalActionError('raising is not available here', seat);
        }
        if (total > shoveTo + step / 2) throw new IllegalActionError('not enough chips', seat);
        if (total > entry.max + step / 2) {
          throw new IllegalActionError(`maximum is ${entry.max}`, seat);
        }
        if (total < entry.min - step / 2) {
          // Short of a min-raise is only ever legal as an all-in.
          if (chipsEqual(total, shoveTo, step)) {
            normalized = 'allin';
          } else {
            throw new IllegalActionError(`minimum raise is to ${entry.min}`, seat);
          }
        }
        break;
      }
      default:
        throw new IllegalActionError(`cannot ${kind} here`, seat);
    }

    this.tokenUsed = this.turnToken;
    const applied = this.commit(s, normalized, total, tookMs);
    this.advance();
    return applied;
  }

  /** The maximum total this seat may wager — the stack, or the pot in PLO. */
  private capFor(s: BettingSeat): number {
    const { step, variant } = this.config;
    const shoveTo = roundChips(s.committed + s.stack, step);
    if (variant !== 'plo4') return shoveTo;
    return potLimitRaiseTo({
      potBefore: this.potBefore(),
      streetCommitted: this.streetCommitted(),
      currentBet: this.currentBet,
      myCommitted: s.committed,
      myStack: s.stack,
      step,
    });
  }

  private commit(s: BettingSeat, kind: ActionKind, total: number, tookMs?: number): Action {
    const { step } = this.config;

    if (kind === 'fold') {
      s.phase = 'folded';
      s.hasActed = true;
      return this.record(s, 'fold', 0, tookMs);
    }
    if (kind === 'check') {
      s.hasActed = true;
      return this.record(s, 'check', 0, tookMs);
    }

    const put = Math.max(0, Math.min(s.stack, roundChips(total - s.committed, step)));
    const isRaise = total > this.currentBet + step / 2;
    s.stack = roundChips(s.stack - put, step);
    s.committed = roundChips(s.committed + put, step);
    s.totalCommitted = roundChips(s.totalCommitted + put, step);
    s.voluntary = true;
    s.hasActed = true;
    const wentAllIn = s.stack <= step / 2;
    if (wentAllIn) s.phase = 'allin';

    if (isRaise) {
      const raiseSize = roundChips(s.committed - this.currentBet, step);
      const full = raiseSize >= this.lastFullRaiseSize - step / 2;
      this.currentBet = s.committed;
      if (full) {
        // A full raise reopens the betting for everyone still holding cards.
        this.lastFullRaiseSize = raiseSize;
        for (const o of this.seats) {
          if (o.seat === s.seat || o.phase !== 'active') continue;
          o.hasActed = false;
          o.canRaise = true;
        }
      } else {
        // All-in under a full raise: players who already acted may only call or
        // fold; players still to act keep full raise rights.
        for (const o of this.seats) {
          if (o.seat === s.seat || o.phase !== 'active') continue;
          if (o.hasActed) o.canRaise = false;
        }
      }
      this.minRaiseTo = roundChips(this.currentBet + this.lastFullRaiseSize, step);
    }

    // An aggressive action that empties the stack is reported as 'allin' so the
    // renderer can fire the shove FX; all-in *calls* stay calls.
    const recordKind: ActionKind = wentAllIn && (isRaise || kind === 'allin') ? 'allin' : kind;
    return this.record(s, recordKind, s.committed, tookMs);
  }

  private record(s: BettingSeat, kind: ActionKind, amount: number, tookMs?: number): Action {
    const action: Action = {
      kind,
      amount: roundChips(amount, this.config.step),
      seat: s.seat,
      seq: this.seq++,
      street: this.street,
      ...(tookMs === undefined ? {} : { tookMs }),
    };
    s.lastAction = action;
    this.log.push(action);
    return action;
  }

  /** Passes the turn to the next seat that owes an action. */
  private advance(): void {
    const from = this.actingSeat >= 0 ? this.actingSeat : this.buttonSeat;
    this.actingSeat = -1;
    if (this.isRoundComplete()) return;
    this.actingSeat = this.nextSeat(from, (s) => this.needsAction(s));
    this.turnToken++;
  }

  /** Default action for a timed-out seat: check if free, otherwise fold. */
  timeoutAction(seat: number): { kind: ActionKind; amount: number } {
    const s = this.seats[seat];
    const owed = s ? roundChips(this.currentBet - s.committed, this.config.step) : 0;
    return owed > this.config.step / 2 ? { kind: 'fold', amount: 0 } : { kind: 'check', amount: 0 };
  }
}

/** Players ordered clockwise starting from the first seat after `from`. */
export function orderFrom<T extends { seat: number }>(
  list: readonly T[],
  from: number,
  seatCount: number,
): T[] {
  return list
    .slice()
    .sort((a, b) => {
      const da = (a.seat - from + seatCount * 2) % seatCount || seatCount;
      const db = (b.seat - from + seatCount * 2) % seatCount || seatCount;
      return da - db;
    });
}

/** Human-readable action line for hand histories and the action log. */
export function describeAction(a: Action, bb: number): string {
  const bbs = (n: number) => `${(n / bb).toFixed(n % bb === 0 ? 0 : 1)}bb`;
  switch (a.kind) {
    case 'fold': return 'folds';
    case 'check': return 'checks';
    case 'call': return `calls ${bbs(a.amount)}`;
    case 'bet': return `bets ${bbs(a.amount)}`;
    case 'raise': return `raises to ${bbs(a.amount)}`;
    case 'allin': return `all-in ${bbs(a.amount)}`;
    case 'post': return `posts ${bbs(a.amount)}`;
    case 'ante': return `antes ${bbs(a.amount)}`;
    default: return a.kind;
  }
}

export { DEFAULT_CHIP_STEP };
