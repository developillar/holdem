/**
 * ROYALE — one authoritative table.
 *
 * The room is the only thing in the system that knows the deck. Clients send
 * intents; the room decides what actually happened. Every inbound action is
 * re-validated against a freshly-derived legal action set — the set that was
 * shipped to the client is never trusted on the way back.
 *
 * Security invariant (the important one):
 *   `viewFor(seat)` is the ONLY way state leaves this file, and it copies
 *   hole cards for exactly two cases — the recipient's own seat, and a seat
 *   that has voluntarily shown down. A mucked hand is never transmitted, not
 *   in a snapshot, not in a delta, not at the end of the hand. There is no
 *   code path that serializes `Seat.holeCards` directly.
 *
 * The room has no timers of its own: `tick(now)` is driven by the registry,
 * which makes shutdown, testing and time-warping trivial.
 */

import { STAKES } from '../src/core/stakes.ts';
import type {
  Action,
  ActionKind,
  BombPotConfig,
  CardId,
  GameVariant,
  PlayerRef,
  Pot,
  ReactionKind,
  SeatState,
  SeatStatus,
  ShowdownResult,
  Stake,
  StakeId,
  Street,
  TableFormat,
  TableState,
  TournamentState,
} from '../src/core/types.ts';
import type { LegalAction } from '../src/core/bus.ts';
import { Rng } from '../src/core/rng.ts';

import type { Logger } from './log.ts';
import { diffState, filterProfanity } from './protocol.ts';
import type { ServerPacket } from './protocol.ts';
import {
  Deck,
  buildPots,
  distribute,
  handRankOf,
  legalActions,
  potTotal,
  q,
  rankFor,
  resolveAction,
} from './poker.ts';
import type { LegalContext } from './poker.ts';
import { spawnBot } from './bots.ts';
import type { BotBrain } from './bots.ts';

// ═══════════════════════════════════════════════════════════════════
// Tunables
// ═══════════════════════════════════════════════════════════════════

const CLOCK_MS = 15_000;
const BANK_START_MS = 30_000;
const BANK_REGEN_MS = 2_000;
const BANK_MAX_MS = 60_000;
const DISCONNECT_GRACE_MS = 60_000;
const TIMEOUTS_TO_SITOUT = 3;
const TIMEOUTS_TO_KICK = 5;

const CHAT_BURST = 4;
const CHAT_WINDOW_MS = 12_000;
const REACT_BURST = 8;
const REACT_WINDOW_MS = 8_000;

const COLLUSION_MIN_CONFRONTS = 20;
const COLLUSION_FOLD_RATE = 0.85;

/** Pacing, ms. The rhythm is part of the product — chips settle, cards land. */
const BEAT = {
  betweenHands: 2400,
  dealStagger: 90,
  dealToAction: 460,
  collect: 520,
  streetGap: 700,
  runoutGap: 950,
  showdownStep: 420,
  award: 1050,
  afterAward: 1150,
};

const POSITIONS: Record<number, string[]> = {
  2: ['BB', 'BTN'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'CO', 'BTN'],
  5: ['SB', 'BB', 'HJ', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};

const SNG_LADDER: ReadonlyArray<readonly [number, number, number]> = [
  [10, 20, 0],
  [15, 30, 0],
  [20, 40, 0],
  [30, 60, 5],
  [40, 80, 10],
  [50, 100, 10],
  [75, 150, 15],
  [100, 200, 25],
  [150, 300, 30],
  [200, 400, 50],
  [300, 600, 75],
  [400, 800, 100],
  [600, 1200, 150],
  [800, 1600, 200],
];
const SNG_LEVEL_MS = 240_000;
const SNG_START_STACK = 1500;

// ═══════════════════════════════════════════════════════════════════
// Public surface
// ═══════════════════════════════════════════════════════════════════

/** What the socket layer must provide. The room never touches `ws`. */
export interface RoomClient {
  readonly id: string;
  name: string;
  avatarId: string;
  level: number;
  premium: boolean;
  connected: boolean;
  send(msg: ServerPacket): void;
}

export interface RoomConfig {
  id: string;
  variant: GameVariant;
  format: TableFormat;
  stakeId: StakeId;
  seatCount: number;
  /** 0..1 — biases bot personalities and the lobby "juicy" badge */
  looseness: number;
  /** occupied seats the room maintains with AI so there is always action */
  botFloor: number;
  seed: number;
  log: Logger;
}

export type JoinResult =
  | { ok: true; seat: number; buyIn: number }
  | { ok: false; reason: string; waitlist?: number };

interface Seat {
  index: number;
  status: SeatStatus;
  player: PlayerRef | null;
  clientId: string | null;
  bot: BotBrain | null;
  stack: number;
  committed: number;
  totalCommitted: number;
  holeCards: CardId[];
  folded: boolean;
  allIn: boolean;
  inHand: boolean;
  actedThisStreet: boolean;
  canReraise: boolean;
  sitOut: boolean;
  sitOutNextHand: boolean;
  wonLast: boolean;
  lastAction: Action | null;
  bankMs: number;
  timeouts: number;
  disconnectedAt: number | null;
  shown: boolean;
  mucked: boolean;
  buyIns: number;
  startHandStack: number;
  finishedPlace: number | null;
}

type Phase = 'idle' | 'between' | 'dealing' | 'betting' | 'runout' | 'showdown';

interface Job {
  at: number;
  fn: () => void;
}

// ═══════════════════════════════════════════════════════════════════
// Room
// ═══════════════════════════════════════════════════════════════════

export class Room {
  readonly id: string;
  readonly variant: GameVariant;
  readonly format: TableFormat;
  readonly stake: Stake;
  readonly seatCount: number;
  readonly looseness: number;

  private log: Logger;
  private rng: Rng;
  private deck: Deck;
  private seats: Seat[];
  private clients = new Map<string, RoomClient>();
  private seatOf = new Map<string, number>();
  private lastSent = new Map<string, TableState>();
  private waitlist: Array<{ clientId: string; buyIn: number }> = [];
  private jobs: Job[] = [];

  private phase: Phase = 'idle';
  private handId = 0;
  private buttonSeat = 0;
  private street: Street = 'preflop';
  private board: CardId[] = [];
  private pots: Pot[] = [];
  private currentBet = 0;
  private lastRaiseSize = 0;
  private minRaiseTo = 0;
  private actingSeat = -1;
  private actionSeq = 0;
  private lastAggressor = -1;
  private sawFlop = false;
  private rakeTaken = 0;
  private tick_ = 0;
  private chipUnit: number;
  private botFloor: number;
  private botEngine: unknown = null;

  private clockEndsAt = 0;
  private turnStartedAt = 0;
  private usingBank = false;

  private bombEvery: number;
  private bombIn: number;
  private bombActive = false;

  private tourneyLevel = 0;
  private tourneyLevelAt = 0;
  private tourneyPlaces: number[] = [];
  private prizePool = 0;

  private potSamples: number[] = [];
  private handTimes: number[] = [];
  private lastHandAt = 0;

  private chatHits = new Map<string, number[]>();
  private reactHits = new Map<string, number[]>();
  private confronts = new Map<string, { folds: number; total: number; flagged: boolean }>();

  constructor(cfg: RoomConfig) {
    this.id = cfg.id;
    this.variant = cfg.variant;
    this.format = cfg.format;
    this.stake = STAKES[cfg.stakeId];
    this.seatCount = Math.max(2, Math.min(9, cfg.seatCount));
    this.looseness = Math.max(0, Math.min(1, cfg.looseness));
    this.log = cfg.log.child({ table: cfg.id });
    this.rng = new Rng(cfg.seed >>> 0);
    this.deck = new Deck(new Rng((cfg.seed ^ 0x5bd1e995) >>> 0));
    this.chipUnit = this.format === 'sng' ? 1 : 0.01;
    this.botFloor = Math.max(0, Math.min(this.seatCount, cfg.botFloor));
    // Bomb tables run one every hand; cash tables every 14th. Tournaments
    // never run them — a forced ante would wreck the ICM the format is about.
    this.bombEvery = this.format === 'bomb' ? 1 : this.format === 'sng' ? 0 : 14;
    this.bombIn = this.format === 'bomb' ? 0 : this.bombEvery;

    this.seats = [];
    for (let i = 0; i < this.seatCount; i++) this.seats.push(this.emptySeat(i));

    if (this.format === 'sng') {
      this.prizePool = this.stake.bb * 100 * this.seatCount;
      this.tourneyLevelAt = Date.now();
    }
  }

  /** Late-bound: the engine bot module resolves asynchronously at boot. */
  setBotEngine(engine: unknown): void {
    this.botEngine = engine;
  }

  /**
   * How many seats the room keeps warm with AI. The registry drops this to 0
   * for tables nobody is watching, which is what lets 36 rooms coexist
   * without 36 simultaneous poker games burning CPU.
   */
  setBotFloor(n: number): void {
    this.botFloor = Math.max(0, Math.min(this.seatCount, Math.round(n)));
  }

  get idle(): boolean {
    return this.phase === 'idle' && this.jobs.length === 0;
  }

  /** Empty the bot seats once the last human has gone. */
  hibernate(): void {
    if (this.phase !== 'idle' || this.humans > 0) return;
    this.clearJobs();
    for (const seat of this.seats) {
      if (seat.bot) this.seats[seat.index] = this.emptySeat(seat.index);
    }
    this.potSamples.length = 0;
    this.handTimes.length = 0;
    this.lastHandAt = 0;
  }

  private emptySeat(index: number): Seat {
    return {
      index,
      status: 'empty',
      player: null,
      clientId: null,
      bot: null,
      stack: 0,
      committed: 0,
      totalCommitted: 0,
      holeCards: [],
      folded: false,
      allIn: false,
      inHand: false,
      actedThisStreet: false,
      canReraise: true,
      sitOut: false,
      sitOutNextHand: false,
      wonLast: false,
      lastAction: null,
      bankMs: BANK_START_MS,
      timeouts: 0,
      disconnectedAt: null,
      shown: false,
      mucked: false,
      buyIns: 0,
      startHandStack: 0,
      finishedPlace: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Lobby metrics
  // ─────────────────────────────────────────────────────────────────

  get occupied(): number {
    return this.seats.filter((s) => s.player !== null).length;
  }

  get humans(): number {
    return this.seats.filter((s) => s.clientId !== null).length;
  }

  get avgPot(): number {
    if (this.potSamples.length === 0) return 0;
    let t = 0;
    for (const p of this.potSamples) t += p;
    return q(t / this.potSamples.length, this.chipUnit);
  }

  get handsPerHour(): number {
    if (this.handTimes.length < 2) return 0;
    let t = 0;
    for (const d of this.handTimes) t += d;
    const avg = t / this.handTimes.length;
    return avg > 0 ? Math.round(3_600_000 / avg) : 0;
  }

  get bombPotIn(): number | null {
    return this.bombEvery > 0 ? this.bombIn : null;
  }

  get waitlistLength(): number {
    return this.waitlist.length;
  }

  // ─────────────────────────────────────────────────────────────────
  // Seat management
  // ─────────────────────────────────────────────────────────────────

  attach(client: RoomClient): void {
    this.clients.set(client.id, client);
  }

  /** Seat a client. Falls back to the waitlist when the table is full. */
  join(client: RoomClient, wanted: number | undefined, buyIn: number): JoinResult {
    this.clients.set(client.id, client);

    const existing = this.seatOf.get(client.id);
    if (existing !== undefined) {
      const seat = this.seats[existing];
      seat.disconnectedAt = null;
      this.sendSnapshot(client);
      return { ok: true, seat: existing, buyIn: seat.stack };
    }

    const min = this.format === 'sng' ? SNG_START_STACK : this.stake.minBuyIn;
    const max = this.format === 'sng' ? SNG_START_STACK : this.stake.maxBuyIn;
    const amount = this.format === 'sng' ? SNG_START_STACK : q(Math.min(Math.max(buyIn, min), max), this.chipUnit);
    if (!Number.isFinite(amount) || amount < min - 1e-9) {
      return { ok: false, reason: `buy-in must be between ${min} and ${max}` };
    }

    let index = -1;
    if (wanted !== undefined && wanted >= 0 && wanted < this.seatCount && this.canTake(wanted)) {
      index = wanted;
    } else {
      index = this.seats.findIndex((s) => this.canTake(s.index));
    }
    if (index < 0) {
      const already = this.waitlist.findIndex((w) => w.clientId === client.id);
      if (already >= 0) return { ok: false, reason: 'table full', waitlist: already + 1 };
      this.waitlist.push({ clientId: client.id, buyIn: amount });
      this.log.info('seat.waitlisted', { player: client.id, position: this.waitlist.length });
      return { ok: false, reason: 'table full', waitlist: this.waitlist.length };
    }

    this.takeSeat(index, client, amount);
    this.sendSnapshot(client);
    return { ok: true, seat: index, buyIn: amount };
  }

  /** A seat is takeable if it is empty or held by a bot we can bump. */
  private canTake(index: number): boolean {
    const s = this.seats[index];
    if (!s) return false;
    if (s.player === null) return true;
    return s.bot !== null && !s.inHand;
  }

  private takeSeat(index: number, client: RoomClient, buyIn: number): void {
    const s = this.seats[index];
    if (s.bot) this.log.debug('seat.bot-bumped', { seat: index, bot: s.player?.name });
    this.seats[index] = this.emptySeat(index);
    const seat = this.seats[index];
    seat.clientId = client.id;
    seat.stack = buyIn;
    seat.buyIns = buyIn;
    seat.status = 'waiting';
    seat.player = {
      id: client.id,
      name: client.name,
      avatarId: client.avatarId,
      frameId: null,
      titleId: null,
      emoteSetId: 'emote-core',
      level: client.level,
      premium: client.premium,
      heat: 0,
    };
    this.seatOf.set(client.id, index);
    this.log.info('seat.joined', { seat: index, player: client.id, buyIn });
  }

  leave(clientId: string): number {
    const index = this.seatOf.get(clientId);
    this.clients.delete(clientId);
    this.lastSent.delete(clientId);
    this.waitlist = this.waitlist.filter((w) => w.clientId !== clientId);
    if (index === undefined) return 0;
    const seat = this.seats[index];
    const cashOut = seat.stack;
    if (seat.inHand && this.phase === 'betting') {
      // Money already in the pot stays in the pot — fold the hand out.
      if (this.actingSeat === index) this.forceFold(index, 'left-table');
      else {
        seat.folded = true;
        seat.inHand = false;
        seat.status = 'folded';
      }
    }
    this.seats[index] = this.emptySeat(index);
    this.seatOf.delete(clientId);
    this.log.info('seat.left', { seat: index, player: clientId, cashOut });
    this.promoteWaitlist();
    return cashOut;
  }

  /** Connection dropped: hold the seat, sit the player out, start the clock. */
  markDisconnected(clientId: string, now: number): void {
    const index = this.seatOf.get(clientId);
    const client = this.clients.get(clientId);
    if (client) client.connected = false;
    if (index === undefined) {
      this.clients.delete(clientId);
      this.lastSent.delete(clientId);
      return;
    }
    const seat = this.seats[index];
    seat.disconnectedAt = now;
    seat.sitOutNextHand = true;
    this.log.info('seat.disconnected', { seat: index, player: clientId, graceMs: DISCONNECT_GRACE_MS });
  }

  /** Same player, new socket: adopt the reserved seat. */
  resume(client: RoomClient): boolean {
    const index = this.seatOf.get(client.id);
    this.clients.set(client.id, client);
    if (index === undefined) return false;
    const seat = this.seats[index];
    seat.disconnectedAt = null;
    seat.sitOutNextHand = false;
    if (seat.status === 'sitting-out' && seat.stack > 0) seat.status = 'waiting';
    seat.sitOut = false;
    this.lastSent.delete(client.id);
    this.sendSnapshot(client);
    this.log.info('seat.resumed', { seat: index, player: client.id });
    return true;
  }

  setSitOut(clientId: string, on: boolean): void {
    const index = this.seatOf.get(clientId);
    if (index === undefined) return;
    const seat = this.seats[index];
    seat.sitOutNextHand = on;
    if (!seat.inHand) {
      seat.sitOut = on;
      seat.status = on ? 'sitting-out' : seat.stack > 0 ? 'waiting' : 'busted';
    }
    if (!on) seat.timeouts = 0;
  }

  rebuy(clientId: string, amount: number): boolean {
    const index = this.seatOf.get(clientId);
    if (index === undefined || this.format === 'sng') return false;
    const seat = this.seats[index];
    const room = q(this.stake.maxBuyIn - seat.stack, this.chipUnit);
    const add = q(Math.min(Math.max(0, amount), Math.max(0, room)), this.chipUnit);
    if (add <= 0) return false;
    seat.stack = q(seat.stack + add, this.chipUnit);
    seat.buyIns = q(seat.buyIns + add, this.chipUnit);
    if (seat.status === 'busted') seat.status = 'waiting';
    this.log.info('seat.rebuy', { seat: index, player: clientId, amount: add });
    return true;
  }

  useTimeBank(clientId: string, now: number): void {
    const index = this.seatOf.get(clientId);
    if (index === undefined || index !== this.actingSeat || this.usingBank) return;
    const seat = this.seats[index];
    if (seat.bankMs <= 0) return;
    this.usingBank = true;
    this.clockEndsAt = now + seat.bankMs;
    this.sendTurn(seat, seat.bankMs, now);
  }

  private promoteWaitlist(): void {
    while (this.waitlist.length > 0) {
      const head = this.waitlist[0];
      const client = this.clients.get(head.clientId);
      if (!client || !client.connected) {
        this.waitlist.shift();
        continue;
      }
      const index = this.seats.findIndex((s) => s.player === null || (s.bot !== null && !s.inHand));
      if (index < 0) return;
      this.waitlist.shift();
      this.takeSeat(index, client, head.buyIn);
      client.send({ t: 'seated', tableId: this.id, seat: index, buyIn: head.buyIn });
      this.sendSnapshot(client);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Bots
  // ─────────────────────────────────────────────────────────────────

  private backfill(): void {
    if (this.botFloor <= 0) return;
    const exclude = this.seats.map((s) => s.player?.id).filter((x): x is string => !!x);
    for (const seat of this.seats) {
      if (this.occupied >= this.botFloor) break;
      if (seat.player !== null) continue;
      const brain = spawnBot(this.botEngine as never, {
        seat: seat.index,
        seed: (this.rng.nextU32() ^ (seat.index * 0x9e3779b1)) >>> 0,
        looseness: this.looseness,
        exclude,
      });
      if (exclude.includes(brain.ref.id)) continue;
      exclude.push(brain.ref.id);
      seat.bot = brain;
      seat.player = brain.ref;
      seat.stack = this.format === 'sng' ? SNG_START_STACK : q(this.stake.bb * (70 + this.rng.int(130)), this.chipUnit);
      seat.buyIns = seat.stack;
      seat.status = 'waiting';
    }
  }

  /** Bots top up or leave, so the table breathes instead of stagnating. */
  private groomBots(): void {
    for (const seat of this.seats) {
      if (!seat.bot || seat.inHand) continue;
      if (this.format === 'sng') continue;
      if (seat.stack < this.stake.bb * 12) {
        if (this.rng.bool(0.6)) {
          seat.stack = q(this.stake.bb * (80 + this.rng.int(120)), this.chipUnit);
          seat.buyIns = q(seat.buyIns + seat.stack, this.chipUnit);
          seat.status = 'waiting';
        } else {
          this.seats[seat.index] = this.emptySeat(seat.index);
        }
      } else if (seat.stack > this.stake.bb * 260 && this.rng.bool(0.12)) {
        // a big winner racks up and leaves — the seat opens for a human
        this.seats[seat.index] = this.emptySeat(seat.index);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Blinds / tournament
  // ─────────────────────────────────────────────────────────────────

  private sb(): number {
    if (this.format !== 'sng') return this.stake.sb;
    return SNG_LADDER[Math.min(this.tourneyLevel, SNG_LADDER.length - 1)][0];
  }
  private bb(): number {
    if (this.format !== 'sng') return this.stake.bb;
    return SNG_LADDER[Math.min(this.tourneyLevel, SNG_LADDER.length - 1)][1];
  }
  private ante(): number {
    if (this.format !== 'sng') return 0;
    return SNG_LADDER[Math.min(this.tourneyLevel, SNG_LADDER.length - 1)][2];
  }

  private tournamentState(now: number): TournamentState | null {
    if (this.format !== 'sng') return null;
    const left = this.seats.filter((s) => s.player && s.stack > 0).length;
    return {
      level: this.tourneyLevel + 1,
      sb: this.sb(),
      bb: this.bb(),
      ante: this.ante(),
      msUntilLevelUp: Math.max(0, this.tourneyLevelAt + SNG_LEVEL_MS - now),
      levelDurationMs: SNG_LEVEL_MS,
      playersLeft: left,
      entrants: this.seatCount,
      prizePool: this.prizePool,
      payouts: this.payouts(),
      finishedPlace: null,
    };
  }

  private payouts(): number[] {
    const p = this.prizePool;
    if (this.seatCount <= 3) return [q(p, 1)];
    if (this.seatCount <= 6) return [q(p * 0.5, 1), q(p * 0.3, 1), q(p * 0.2, 1)];
    return [q(p * 0.4, 1), q(p * 0.26, 1), q(p * 0.18, 1), q(p * 0.16, 1)];
  }

  // ─────────────────────────────────────────────────────────────────
  // Scheduling
  // ─────────────────────────────────────────────────────────────────

  private after(ms: number, fn: () => void): void {
    this.jobs.push({ at: Date.now() + Math.max(0, ms), fn });
  }

  private clearJobs(): void {
    this.jobs.length = 0;
  }

  /** Registry-driven heartbeat. Runs due work, the clock, then broadcasts. */
  tick(now: number): void {
    if (this.jobs.length > 0) {
      const due = this.jobs.filter((j) => j.at <= now);
      if (due.length > 0) {
        this.jobs = this.jobs.filter((j) => j.at > now);
        for (const job of due) {
          try {
            job.fn();
          } catch (err) {
            this.log.error('job.failed', { err: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }

    this.runClock(now);
    this.reapDisconnects(now);

    if (this.format === 'sng' && now - this.tourneyLevelAt >= SNG_LEVEL_MS && this.tourneyLevel < SNG_LADDER.length - 1) {
      this.tourneyLevel++;
      this.tourneyLevelAt = now;
      this.broadcastMsg({ t: 'sys', text: `Blinds up — ${this.sb()}/${this.bb()}`, tone: 'info' });
    }

    if (this.phase === 'idle') this.maybeStartHand(now);

    this.tick_++;
    this.broadcast();
  }

  private runClock(now: number): void {
    if (this.phase !== 'betting' || this.actingSeat < 0) return;
    const seat = this.seats[this.actingSeat];
    if (!seat || seat.bot) return;
    if (now < this.clockEndsAt) return;
    if (this.usingBank) seat.bankMs = 0;
    seat.timeouts++;
    this.log.info('clock.expired', { seat: seat.index, player: seat.clientId, timeouts: seat.timeouts });
    this.forceFold(seat.index, 'timeout');
    if (seat.timeouts >= TIMEOUTS_TO_KICK && seat.clientId) {
      const id = seat.clientId;
      this.clients.get(id)?.send({ t: 'sys', text: 'Removed for inactivity', tone: 'bad' });
      this.leave(id);
    } else if (seat.timeouts >= TIMEOUTS_TO_SITOUT) {
      seat.sitOutNextHand = true;
      if (seat.clientId) {
        this.clients.get(seat.clientId)?.send({ t: 'sys', text: 'Sat out — you missed the clock', tone: 'bad' });
      }
    }
  }

  private reapDisconnects(now: number): void {
    for (const seat of this.seats) {
      if (seat.disconnectedAt === null || !seat.clientId) continue;
      if (now - seat.disconnectedAt < DISCONNECT_GRACE_MS) continue;
      const id = seat.clientId;
      this.log.info('seat.grace-expired', { seat: seat.index, player: id });
      this.leave(id);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Hand lifecycle
  // ─────────────────────────────────────────────────────────────────

  private maybeStartHand(now: number): void {
    this.backfill();
    const ready = this.seats.filter((s) => s.player && !s.sitOut && s.stack > this.chipUnit / 2);
    if (ready.length < 2) return;
    this.phase = 'between';
    this.after(BEAT.betweenHands, () => this.beginHand(Date.now()));
    void now;
  }

  private beginHand(now: number): void {
    this.groomBots();
    this.backfill();

    for (const seat of this.seats) {
      if (!seat.player) continue;
      seat.sitOut = seat.sitOutNextHand || seat.stack <= this.chipUnit / 2 || seat.disconnectedAt !== null;
      seat.committed = 0;
      seat.totalCommitted = 0;
      seat.holeCards = [];
      seat.folded = false;
      seat.allIn = false;
      seat.actedThisStreet = false;
      seat.canReraise = true;
      seat.lastAction = null;
      seat.wonLast = false;
      seat.shown = false;
      seat.mucked = false;
      seat.startHandStack = seat.stack;
      seat.bankMs = Math.min(BANK_MAX_MS, seat.bankMs + BANK_REGEN_MS);
      seat.inHand = !seat.sitOut;
      seat.status = seat.inHand ? 'active' : seat.stack > 0 ? 'sitting-out' : 'busted';
    }

    const players = this.seats.filter((s) => s.inHand);
    if (players.length < 2) {
      this.phase = 'idle';
      return;
    }

    this.handId++;
    this.actionSeq = 0;
    this.street = 'preflop';
    this.board = [];
    this.pots = [];
    this.currentBet = 0;
    this.lastRaiseSize = 0;
    this.lastAggressor = -1;
    this.sawFlop = false;
    this.rakeTaken = 0;
    this.deck.reset();

    this.buttonSeat = this.nextOccupied(this.buttonSeat, (s) => s.inHand);
    this.bombActive = this.bombEvery > 0 && this.bombIn <= 0;

    if (this.lastHandAt > 0) {
      this.handTimes.push(now - this.lastHandAt);
      if (this.handTimes.length > 24) this.handTimes.shift();
    }
    this.lastHandAt = now;

    this.phase = 'dealing';
    this.broadcastMsg({ t: 'hand', phase: 'start', handId: this.handId, buttonSeat: this.buttonSeat });

    this.postForcedBets();
    this.dealHoleCards(() => {
      if (this.bombActive) this.startBombFlop();
      else this.startBetting('preflop');
    });
  }

  private postForcedBets(): void {
    const order = this.orbit();
    const bb = this.bb();
    const ante = this.ante();

    if (this.bombActive) {
      const anteChips = q(bb * 2, this.chipUnit);
      for (const s of order) this.commit(s, Math.min(anteChips, s.stack), 'ante');
      this.currentBet = 0;
      this.minRaiseTo = bb;
      return;
    }

    if (ante > 0) {
      for (const s of order) this.commit(s, Math.min(ante, s.stack), 'ante');
      for (const s of order) {
        s.totalCommitted = q(s.totalCommitted, this.chipUnit);
        s.committed = 0;
      }
    }

    const heads = order.length === 2;
    const sbSeat = heads ? this.seats[this.buttonSeat] : order[0];
    const bbSeat = heads ? order.find((s) => s.index !== this.buttonSeat)! : order[1];
    this.commit(sbSeat, Math.min(this.sb(), sbSeat.stack), 'post');
    this.commit(bbSeat, Math.min(bb, bbSeat.stack), 'post');
    this.currentBet = q(Math.max(sbSeat.committed, bbSeat.committed), this.chipUnit);
    this.lastRaiseSize = bb;
    this.minRaiseTo = q(this.currentBet + bb, this.chipUnit);
  }

  private commit(seat: Seat, amount: number, kind: ActionKind): void {
    const amt = q(Math.max(0, Math.min(amount, seat.stack)), this.chipUnit);
    if (amt <= 0) return;
    seat.stack = q(seat.stack - amt, this.chipUnit);
    seat.committed = q(seat.committed + amt, this.chipUnit);
    seat.totalCommitted = q(seat.totalCommitted + amt, this.chipUnit);
    if (seat.stack <= this.chipUnit / 2) {
      seat.allIn = true;
      seat.status = 'allin';
    }
    const action: Action = { kind, amount: seat.committed, seat: seat.index, seq: this.actionSeq++, street: this.street };
    seat.lastAction = action;
  }

  private dealHoleCards(done: () => void): void {
    const order = this.orbit();
    const per = this.variant === 'plo4' ? 4 : 2;
    let idx = 0;
    for (let round = 0; round < per; round++) {
      for (const s of order) {
        const card = this.deck.draw();
        s.holeCards.push(card);
        const seatIndex = s.index;
        const order_ = idx;
        this.after(idx * BEAT.dealStagger, () => this.sendHole(seatIndex, card, order_));
        idx++;
      }
    }
    this.after(idx * BEAT.dealStagger + BEAT.dealToAction, done);
  }

  /**
   * The one place a card leaves the room during a hand. Only the seat's own
   * client receives the value; everyone else is told a card arrived, not
   * which one.
   */
  private sendHole(seatIndex: number, card: CardId, order: number): void {
    const seat = this.seats[seatIndex];
    for (const [clientId, client] of this.clients) {
      const mySeat = this.seatOf.get(clientId);
      const mine = mySeat === seatIndex;
      client.send({
        t: 'hole',
        seat: seatIndex,
        cards: mine ? [card] : [],
        faceUp: mine,
        order,
      });
    }
    void seat;
  }

  private startBombFlop(): void {
    this.street = 'flop';
    this.sawFlop = true;
    const cards = [this.deck.draw(), this.deck.draw(), this.deck.draw()];
    this.board.push(...cards);
    this.rebuildPots();
    this.broadcastMsg({ t: 'deal', street: 'flop', cards });
    this.after(BEAT.streetGap, () => this.startBetting('flop'));
  }

  private startBetting(street: Street): void {
    this.street = street;
    this.phase = 'betting';
    for (const s of this.seats) {
      if (!s.inHand) continue;
      s.actedThisStreet = false;
      s.canReraise = true;
    }
    if (street !== 'preflop') {
      this.currentBet = 0;
      this.lastRaiseSize = this.bb();
      this.minRaiseTo = this.bb();
      for (const s of this.seats) s.committed = 0;
    }

    const live = this.seats.filter((s) => s.inHand && !s.folded && !s.allIn);
    if (live.length === 0 || this.remaining() <= 1) {
      this.closeStreet();
      return;
    }

    const first =
      street === 'preflop' && !this.bombActive
        ? this.firstToActPreflop()
        : this.nextOccupied(this.buttonSeat, (s) => s.inHand && !s.folded && !s.allIn);
    this.actingSeat = first;
    this.promptSeat();
  }

  private firstToActPreflop(): number {
    const order = this.orbit();
    const live = (s: Seat): boolean => s.inHand && !s.folded && !s.allIn;
    if (order.length === 2) {
      // Heads-up: the button is the small blind and acts first preflop.
      return live(this.seats[this.buttonSeat])
        ? this.buttonSeat
        : this.nextOccupied(this.buttonSeat, live);
    }
    // Walk past SB and BB on seat order (a blind-locked all-in still counts
    // as a seat, it just never gets asked), then find the first live actor.
    let idx = this.nextOccupied(this.buttonSeat, (s) => s.inHand);
    idx = this.nextOccupied(idx, (s) => s.inHand);
    return this.nextOccupied(idx, live);
  }

  private promptSeat(): void {
    const seat = this.seats[this.actingSeat];
    if (!seat || !seat.inHand || seat.folded || seat.allIn) {
      this.advance();
      return;
    }
    const now = Date.now();
    this.turnStartedAt = now;
    this.usingBank = false;
    const legal = this.legalFor(seat);
    if (legal.length === 0) {
      this.advance();
      return;
    }

    if (seat.bot) {
      this.clockEndsAt = now + 30_000;
      const choice = seat.bot.decide(this.botContext(seat, legal));
      // Cap the tank. A four-second think reads as human; nine reads as lag.
      const delay = Math.max(260, Math.min(3400, choice.thinkMs));
      const handAtRequest = this.handId;
      const seqAtRequest = this.actionSeq;
      this.sendTurn(seat, delay, now);
      this.after(delay, () => {
        if (this.handId !== handAtRequest || this.actionSeq !== seqAtRequest || this.actingSeat !== seat.index) return;
        const resolved = resolveAction(legal, choice.kind, choice.amount, this.chipUnit) ?? this.safeFallback(legal);
        this.applyAction(seat, resolved.kind, resolved.to, delay);
      });
      return;
    }

    if (seat.disconnectedAt !== null) {
      this.clockEndsAt = now + 2500;
      this.sendTurn(seat, 2500, now);
      return;
    }

    this.clockEndsAt = now + CLOCK_MS;
    this.sendTurn(seat, CLOCK_MS, now);
  }

  private safeFallback(legal: readonly LegalAction[]): { kind: LegalAction['kind']; to: number } {
    const check = legal.find((l) => l.kind === 'check');
    if (check) return { kind: 'check', to: check.max };
    const fold = legal.find((l) => l.kind === 'fold');
    if (fold) return { kind: 'fold', to: 0 };
    return { kind: legal[0].kind, to: legal[0].max };
  }

  private sendTurn(seat: Seat, timeMs: number, now: number): void {
    const legal = this.legalFor(seat);
    const msg: ServerPacket = {
      t: 'turn',
      seat: seat.index,
      handId: this.handId,
      timeMs,
      bankMs: seat.bankMs,
      legal: seat.clientId ? legal : [],
      serverTime: now,
    };
    for (const [clientId, client] of this.clients) {
      const mine = this.seatOf.get(clientId) === seat.index;
      client.send(mine ? msg : { ...msg, legal: [] });
    }
  }

  private legalFor(seat: Seat): LegalAction[] {
    const ctx: LegalContext = {
      variant: this.variant,
      street: this.street === 'showdown' ? 'river' : this.street,
      bb: this.bb(),
      step: this.chipUnit,
      potTotal: this.committedTotal(),
      currentBet: this.currentBet,
      lastRaiseSize: this.lastRaiseSize,
      seatCommitted: seat.committed,
      seatStack: seat.stack,
      canRaise: seat.canReraise,
    };
    return legalActions(ctx);
  }

  private committedTotal(): number {
    let t = 0;
    for (const s of this.seats) t += s.totalCommitted;
    return q(t, this.chipUnit);
  }

  private botContext(seat: Seat, legal: readonly LegalAction[]) {
    const raise = legal.find((l) => l.kind === 'raise' || l.kind === 'bet');
    const call = legal.find((l) => l.kind === 'call');
    const inHand = this.seats.filter((s) => s.inHand && !s.folded);
    const behind = this.seats.filter((s) => s.inHand && !s.folded && !s.allIn && s.index !== seat.index);
    const eff = Math.min(seat.stack, ...behind.map((s) => s.stack + s.committed), seat.stack);
    return {
      variant: this.variant,
      street: this.street,
      handId: this.handId,
      holeCards: seat.holeCards,
      board: this.board,
      pot: this.committedTotal(),
      toCall: call ? q(call.max - seat.committed, this.chipUnit) : 0,
      stack: seat.stack,
      committed: seat.committed,
      bb: this.bb(),
      minRaiseTo: raise ? raise.min : q(seat.committed + seat.stack, this.chipUnit),
      maxRaiseTo: raise ? raise.max : q(seat.committed + seat.stack, this.chipUnit),
      canCheck: legal.some((l) => l.kind === 'check'),
      canRaise: !!raise,
      position: this.positionOf(seat.index),
      seatsInHand: inHand.length,
      activeOpponents: behind.length,
      playersToActAfter: this.playersToActAfter(seat.index),
      preflopRaises: this.street === 'preflop' ? Math.max(0, this.actionSeq) : 0,
      raisesThisStreet: 0,
      effectiveStack: Number.isFinite(eff) ? eff : seat.stack,
      isBombPot: this.bombActive,
      chipUnit: this.chipUnit,
    };
  }

  private positionOf(index: number): 'UTG' | 'UTG1' | 'MP' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB' {
    const order = this.orbit();
    const names = POSITIONS[order.length] ?? POSITIONS[6];
    const at = order.findIndex((s) => s.index === index);
    const name = at >= 0 ? names[at] ?? 'MP' : 'MP';
    return name as 'UTG';
  }

  private playersToActAfter(index: number): number {
    let count = 0;
    for (let i = 1; i < this.seatCount; i++) {
      const s = this.seats[(index + i) % this.seatCount];
      if (!s.inHand || s.folded || s.allIn) continue;
      if (s.actedThisStreet && s.committed >= this.currentBet - this.chipUnit / 2) continue;
      count++;
    }
    return count;
  }

  // ─────────────────────────────────────────────────────────────────
  // Actions
  // ─────────────────────────────────────────────────────────────────

  /**
   * Inbound action from a real client. Every field is re-derived server-side;
   * `amount` is clamped into the legal band, never taken at face value.
   */
  submitAction(clientId: string, kind: string, amount: number, handId: number, seq: number): void {
    const client = this.clients.get(clientId);
    const index = this.seatOf.get(clientId);
    if (index === undefined) {
      client?.send({ t: 'reject', seq, handId, reason: 'not-seated' });
      return;
    }
    if (this.phase !== 'betting' || this.actingSeat !== index) {
      this.log.warn('action.out-of-turn', { player: clientId, seat: index, kind, acting: this.actingSeat });
      client?.send({ t: 'reject', seq, handId, reason: 'not-your-turn' });
      return;
    }
    if (handId !== this.handId) {
      client?.send({ t: 'reject', seq, handId, reason: 'stale-hand' });
      return;
    }
    const seat = this.seats[index];
    const legal = this.legalFor(seat);
    const resolved = resolveAction(legal, kind, amount, this.chipUnit);
    if (!resolved) {
      this.log.warn('action.illegal', {
        player: clientId,
        seat: index,
        kind,
        amount,
        legal: legal.map((l) => `${l.kind}:${l.min}-${l.max}`).join(','),
      });
      client?.send({ t: 'reject', seq, handId, reason: `illegal:${kind}` });
      return;
    }
    seat.timeouts = 0;
    this.applyAction(seat, resolved.kind, resolved.to, Date.now() - this.turnStartedAt);
  }

  private forceFold(index: number, why: string): void {
    const seat = this.seats[index];
    if (!seat || !seat.inHand || this.phase !== 'betting') return;
    const legal = this.legalFor(seat);
    const check = legal.find((l) => l.kind === 'check');
    this.log.debug('action.forced', { seat: index, why, as: check ? 'check' : 'fold' });
    if (check) this.applyAction(seat, 'check', check.max, CLOCK_MS);
    else this.applyAction(seat, 'fold', 0, CLOCK_MS);
  }

  private applyAction(seat: Seat, kind: LegalAction['kind'], to: number, tookMs: number): void {
    if (this.phase !== 'betting') return;
    const prevBet = this.currentBet;
    const step = this.chipUnit;

    if (kind === 'fold') {
      seat.folded = true;
      seat.inHand = false;
      seat.status = 'folded';
      this.noteConfrontation(seat.index, true);
    } else {
      if (kind !== 'check') {
        const delta = q(Math.max(0, to - seat.committed), step);
        this.commit(seat, delta, kind);
      }
      if (kind === 'call' || kind === 'check') this.noteConfrontation(seat.index, false);
      if (seat.committed > prevBet + step / 2) {
        const raiseSize = q(seat.committed - prevBet, step);
        this.currentBet = seat.committed;
        const full = raiseSize >= this.lastRaiseSize - step / 2;
        if (full) this.lastRaiseSize = raiseSize;
        this.minRaiseTo = q(this.currentBet + this.lastRaiseSize, step);
        this.lastAggressor = seat.index;
        for (const s of this.seats) {
          if (s.index === seat.index || !s.inHand || s.folded || s.allIn) continue;
          s.actedThisStreet = false;
          if (!full) s.canReraise = false;
        }
      }
    }

    seat.actedThisStreet = true;
    const action: Action = {
      kind,
      amount: kind === 'fold' ? 0 : seat.committed,
      seat: seat.index,
      seq: this.actionSeq++,
      street: this.street,
      tookMs: Math.round(Math.max(0, tookMs)),
    };
    seat.lastAction = action;
    this.actingSeat = -1;
    this.broadcastMsg({ t: 'action', action });
    this.advance();
  }

  /** Records "seat X folded facing aggression from seat Y" for the collusion signal. */
  private noteConfrontation(seatIndex: number, folded: boolean): void {
    if (this.lastAggressor < 0 || this.lastAggressor === seatIndex) return;
    const a = this.seats[seatIndex];
    const b = this.seats[this.lastAggressor];
    if (!a?.clientId || !b?.clientId) return;
    const key = `${a.clientId}>${b.clientId}`;
    const rec = this.confronts.get(key) ?? { folds: 0, total: 0, flagged: false };
    rec.total++;
    if (folded) rec.folds++;
    this.confronts.set(key, rec);
    if (!rec.flagged && rec.total >= COLLUSION_MIN_CONFRONTS && rec.folds / rec.total >= COLLUSION_FOLD_RATE) {
      rec.flagged = true;
      this.log.warn('security.collusion-signal', {
        from: a.clientId,
        to: b.clientId,
        folds: rec.folds,
        confrontations: rec.total,
        rate: Math.round((rec.folds / rec.total) * 100) / 100,
      });
    }
  }

  private advance(): void {
    if (this.remaining() <= 1) {
      this.closeStreet();
      return;
    }
    const next = this.nextToAct();
    if (next < 0) {
      this.closeStreet();
      return;
    }
    this.actingSeat = next;
    this.promptSeat();
  }

  private nextToAct(): number {
    const from = this.lastActedIndex();
    for (let i = 1; i <= this.seatCount; i++) {
      const s = this.seats[(from + i) % this.seatCount];
      if (!s.inHand || s.folded || s.allIn) continue;
      if (!s.actedThisStreet || s.committed < this.currentBet - this.chipUnit / 2) return s.index;
    }
    return -1;
  }

  private lastActedIndex(): number {
    let best = this.buttonSeat;
    let bestSeq = -1;
    for (const s of this.seats) {
      if (s.lastAction && s.lastAction.seq > bestSeq && s.lastAction.street === this.street) {
        bestSeq = s.lastAction.seq;
        best = s.index;
      }
    }
    return best;
  }

  private remaining(): number {
    return this.seats.filter((s) => s.inHand && !s.folded).length;
  }

  private closeStreet(): void {
    const moved: number[] = [];
    let total = 0;
    for (const s of this.seats) {
      if (s.committed > this.chipUnit / 2) {
        moved.push(s.index);
        total = q(total + s.committed, this.chipUnit);
      }
      s.committed = 0;
    }
    this.currentBet = 0;
    this.actingSeat = -1;
    this.rebuildPots();
    if (moved.length > 0) this.broadcastMsg({ t: 'collect', seats: moved, total });

    if (this.remaining() <= 1) {
      this.after(BEAT.collect, () => this.finishUncontested());
      return;
    }

    const canBet = this.seats.filter((s) => s.inHand && !s.folded && !s.allIn).length;
    const allInRunout = canBet <= 1;

    const nextStreet = this.nextStreet();
    if (!nextStreet) {
      this.after(BEAT.collect, () => this.showdown());
      return;
    }
    this.phase = allInRunout ? 'runout' : 'dealing';
    const gap = allInRunout ? BEAT.runoutGap : BEAT.streetGap;
    this.after(BEAT.collect, () => this.dealStreet(nextStreet, allInRunout, gap));
  }

  private nextStreet(): Street | null {
    if (this.street === 'preflop') return 'flop';
    if (this.street === 'flop') return 'turn';
    if (this.street === 'turn') return 'river';
    return null;
  }

  private dealStreet(street: Street, runout: boolean, gap: number): void {
    const count = street === 'flop' ? 3 : 1;
    const cards: CardId[] = [];
    for (let i = 0; i < count; i++) cards.push(this.deck.draw());
    this.board.push(...cards);
    this.street = street;
    if (street === 'flop') this.sawFlop = true;
    this.broadcastMsg({ t: 'deal', street, cards });

    if (runout) {
      const next = this.nextStreet();
      if (next) this.after(gap, () => this.dealStreet(next, true, gap));
      else this.after(gap, () => this.showdown());
      return;
    }
    this.after(gap, () => this.startBetting(street));
  }

  private rebuildPots(): void {
    const commitments = this.seats
      .filter((s) => s.totalCommitted > this.chipUnit / 2)
      .map((s) => ({ seat: s.index, total: s.totalCommitted, folded: s.folded || !s.inHand }));
    this.pots = buildPots(commitments, this.chipUnit);
    this.broadcastMsg({ t: 'pot', pots: this.pots.map((p) => ({ ...p })), total: potTotal(this.pots) });
  }

  // ─────────────────────────────────────────────────────────────────
  // Resolution
  // ─────────────────────────────────────────────────────────────────

  private finishUncontested(): void {
    this.phase = 'showdown';
    const winner = this.seats.find((s) => s.inHand && !s.folded);
    if (!winner) {
      this.endHand();
      return;
    }
    winner.mucked = true;
    const gross = potTotal(this.pots);
    const net = this.applyRake(gross);
    winner.stack = q(winner.stack + net, this.chipUnit);
    winner.wonLast = true;
    this.samplePot(gross);
    this.broadcastMsg({ t: 'showdown', results: [{ seat: winner.index, rank: null, won: net, mucked: true }], pots: this.pots.map((p) => ({ ...p })) });
    this.broadcastMsg({ t: 'award', seat: winner.index, amount: net, potIndex: 0 });
    for (const s of this.seats) {
      if (s.inHand && s.folded) this.broadcastMsg({ t: 'muck', seat: s.index });
    }
    this.after(BEAT.award, () => this.endHand());
  }

  private showdown(): void {
    this.phase = 'showdown';
    this.street = 'showdown';
    this.actingSeat = -1;
    this.rebuildPots();

    const contenders = this.seats.filter((s) => s.inHand && !s.folded);
    const values = new Map<number, number>();
    for (const s of contenders) values.set(s.index, rankFor(this.variant, s.holeCards, this.board));

    const gross = potTotal(this.pots);
    const rake = this.rakeFor(gross);
    const netPots = this.pots.map((p) => ({
      ...p,
      amount: q(p.amount - (gross > 0 ? (rake * p.amount) / gross : 0), this.chipUnit),
    }));
    this.rakeTaken = rake;

    const awards = distribute(netPots, values, this.buttonSeat, this.seatCount, this.chipUnit);
    const wonBy = new Map<number, number>();
    for (const a of awards) wonBy.set(a.seat, q((wonBy.get(a.seat) ?? 0) + a.amount, this.chipUnit));

    // Reveal order: last aggressor first, then clockwise. A player who cannot
    // win anything and cannot beat what is already face-up may muck.
    const order = this.showOrder(contenders);
    let bestShown = -1;
    const results: ShowdownResult[] = [];
    for (const seat of order) {
      const value = values.get(seat.index) ?? -1;
      const wins = (wonBy.get(seat.index) ?? 0) > 0;
      const mustShow = wins || value > bestShown;
      if (mustShow) {
        seat.shown = true;
        bestShown = Math.max(bestShown, value);
        results.push({
          seat: seat.index,
          rank: handRankOf(this.variant, seat.holeCards, this.board),
          won: wonBy.get(seat.index) ?? 0,
          mucked: false,
        });
      } else {
        seat.mucked = true;
        results.push({ seat: seat.index, rank: null, won: 0, mucked: true });
      }
    }

    for (const a of awards) {
      const seat = this.seats[a.seat];
      seat.stack = q(seat.stack + a.amount, this.chipUnit);
      seat.wonLast = true;
    }

    this.samplePot(gross);
    // Push a full snapshot first so every client already holds the revealed
    // hole cards by the time the showdown message asks it to turn them over.
    this.broadcastSnapshots();
    this.broadcastMsg({ t: 'showdown', results, pots: netPots.map((p) => ({ ...p })) });
    for (const seat of this.seats) {
      if (seat.mucked && seat.inHand) this.broadcastMsg({ t: 'muck', seat: seat.index });
    }

    let delay = BEAT.showdownStep * Math.max(1, results.length);
    for (const a of awards) {
      const at = delay;
      this.after(at, () => this.broadcastMsg({ t: 'award', seat: a.seat, amount: a.amount, potIndex: a.potIndex }));
      delay += 160;
    }
    this.after(delay + BEAT.award, () => this.endHand());
  }

  private showOrder(contenders: readonly Seat[]): Seat[] {
    const start = this.lastAggressor >= 0 ? this.lastAggressor : (this.buttonSeat + 1) % this.seatCount;
    const out: Seat[] = [];
    for (let i = 0; i < this.seatCount; i++) {
      const idx = (start + i) % this.seatCount;
      const seat = contenders.find((s) => s.index === idx);
      if (seat) out.push(seat);
    }
    return out;
  }

  private rakeFor(gross: number): number {
    if (this.format === 'sng' || !this.sawFlop || gross <= 0) return 0;
    const cap = this.stake.bb * 3;
    return q(Math.min(gross * 0.05, cap), this.chipUnit);
  }

  private applyRake(gross: number): number {
    const rake = this.rakeFor(gross);
    this.rakeTaken = rake;
    return q(gross - rake, this.chipUnit);
  }

  private samplePot(gross: number): void {
    this.potSamples.push(gross);
    if (this.potSamples.length > 30) this.potSamples.shift();
  }

  private endHand(): void {
    for (const seat of this.seats) {
      if (seat.bot && seat.inHand) {
        seat.bot.observe(q(seat.stack - seat.startHandStack, this.chipUnit), seat.shown);
      }
      seat.inHand = false;
      seat.holeCards = [];
      seat.shown = false;
      seat.mucked = false;
      if (seat.player && seat.stack <= this.chipUnit / 2) {
        seat.status = 'busted';
        if (this.format === 'sng' && seat.finishedPlace === null) {
          const left = this.seats.filter((s) => s.player && s.stack > 0).length;
          seat.finishedPlace = left + 1;
          this.tourneyPlaces.push(seat.index);
        }
      } else if (seat.player) {
        seat.status = seat.sitOut ? 'sitting-out' : 'waiting';
      }
    }
    this.pots = [];
    this.board = [];
    this.currentBet = 0;
    this.actingSeat = -1;
    this.broadcastMsg({ t: 'hand', phase: 'end', handId: this.handId, buttonSeat: this.buttonSeat });

    if (this.bombEvery > 0) {
      this.bombIn = this.bombActive ? this.bombEvery - 1 : Math.max(0, this.bombIn - 1);
    }
    this.bombActive = false;

    if (this.format === 'sng') {
      const alive = this.seats.filter((s) => s.player && s.stack > 0);
      if (alive.length <= 1) {
        this.finishTournament(alive[0]);
        return;
      }
    }

    this.promoteWaitlist();
    this.phase = 'idle';
  }

  private finishTournament(winner: Seat | undefined): void {
    const payouts = this.payouts();
    if (winner) {
      winner.stack = q(winner.stack + payouts[0], 1);
      this.broadcastMsg({ t: 'sys', text: `${winner.player?.name ?? 'Seat'} wins the tournament`, tone: 'epic' });
    }
    this.log.info('sng.finished', { winner: winner?.player?.id, prize: payouts[0] });
    // Reset for the next sit-and-go so the table never goes dead.
    this.tourneyLevel = 0;
    this.tourneyLevelAt = Date.now();
    this.tourneyPlaces = [];
    for (const seat of this.seats) {
      if (!seat.player) continue;
      if (seat.clientId) {
        seat.stack = SNG_START_STACK;
        seat.status = 'waiting';
        seat.finishedPlace = null;
      } else {
        this.seats[seat.index] = this.emptySeat(seat.index);
      }
    }
    this.phase = 'idle';
  }

  // ─────────────────────────────────────────────────────────────────
  // Social
  // ─────────────────────────────────────────────────────────────────

  chat(clientId: string, text: string): void {
    if (!this.allow(this.chatHits, clientId, CHAT_BURST, CHAT_WINDOW_MS)) {
      this.clients.get(clientId)?.send({ t: 'sys', text: 'Slow down a moment', tone: 'bad' });
      return;
    }
    const seat = this.seatOf.get(clientId) ?? -1;
    const { text: clean, flagged } = filterProfanity(text);
    if (flagged) this.log.info('chat.filtered', { player: clientId });
    this.broadcastMsg({ t: 'chat', fromSeat: seat, text: clean });
  }

  react(clientId: string, kind: ReactionKind, targetSeat: number): void {
    if (!this.allow(this.reactHits, clientId, REACT_BURST, REACT_WINDOW_MS)) return;
    const from = this.seatOf.get(clientId) ?? -1;
    const target = targetSeat >= 0 && targetSeat < this.seatCount ? targetSeat : -1;
    this.broadcastMsg({ t: 'react', kind, fromSeat: from, targetSeat: target });
  }

  private allow(store: Map<string, number[]>, key: string, burst: number, windowMs: number): boolean {
    const now = Date.now();
    const hits = (store.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= burst) {
      store.set(key, hits);
      return false;
    }
    hits.push(now);
    store.set(key, hits);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────
  // State projection + broadcast
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build the table as one seat is allowed to see it. This is the security
   * boundary: hole cards are copied for the viewer's own seat and for seats
   * that have shown down, and for nobody else, ever.
   */
  viewFor(you: number, now = Date.now()): TableState {
    const seats: SeatState[] = this.seats.map((s) => {
      const mine = s.index === you;
      const visible = mine || (s.shown && !s.mucked);
      return {
        index: s.index,
        status: s.status,
        player: s.player,
        stack: s.stack,
        committed: s.committed,
        totalCommitted: s.totalCommitted,
        holeCards: visible ? s.holeCards.slice() : [],
        revealed: visible && s.holeCards.length > 0,
        isButton: s.index === this.buttonSeat,
        isTurn: s.index === this.actingSeat,
        timeBankMs:
          s.index === this.actingSeat && this.phase === 'betting'
            ? Math.max(0, Math.round(this.clockEndsAt - now))
            : Math.round(s.bankMs),
        lastAction: s.lastAction,
        wonLast: s.wonLast,
        sitOutNextHand: s.sitOutNextHand,
      };
    });

    const bombPot: BombPotConfig | null =
      this.bombEvery > 0
        ? {
            anteBb: 2,
            boards: 1,
            triggerEveryHands: this.bombEvery,
            handsUntilNext: this.bombActive ? 0 : this.bombIn,
          }
        : null;

    return {
      id: this.id,
      variant: this.variant,
      format: this.format,
      stake: this.stake,
      seats,
      board: this.board.slice(),
      pots: this.pots.map((p) => ({ ...p })),
      street: this.street,
      handId: this.handId,
      buttonSeat: this.buttonSeat,
      actingSeat: this.actingSeat,
      currentBet: this.currentBet,
      lastRaiseSize: this.lastRaiseSize,
      minRaiseTo: this.minRaiseTo,
      bombPot,
      tournament: this.tournamentState(now),
      rake: this.rakeTaken,
      tick: this.tick_,
    };
  }

  sendSnapshot(client: RoomClient): void {
    const you = this.seatOf.get(client.id) ?? -1;
    const state = this.viewFor(you);
    this.lastSent.set(client.id, state);
    client.send({ t: 'state', state, you });
  }

  private broadcast(): void {
    const now = Date.now();
    for (const [clientId, client] of this.clients) {
      if (!client.connected) continue;
      const you = this.seatOf.get(clientId) ?? -1;
      const next = this.viewFor(you, now);
      const prev = this.lastSent.get(clientId);
      if (!prev) {
        this.lastSent.set(clientId, next);
        client.send({ t: 'state', state: next, you });
        continue;
      }
      const patch = diffState(prev, next);
      if (!patch) continue;
      this.lastSent.set(clientId, next);
      client.send({ t: 'delta', tick: next.tick, patch });
    }
  }

  private broadcastSnapshots(): void {
    for (const client of this.clients.values()) {
      if (client.connected) this.sendSnapshot(client);
    }
  }

  private broadcastMsg(msg: ServerPacket): void {
    for (const client of this.clients.values()) {
      if (client.connected) client.send(msg);
    }
  }

  detach(clientId: string): void {
    this.clients.delete(clientId);
    this.lastSent.delete(clientId);
  }

  /** Everything stops; used on shutdown. */
  destroy(): void {
    this.clearJobs();
    this.clients.clear();
    this.lastSent.clear();
    this.phase = 'idle';
  }

  // ─────────────────────────────────────────────────────────────────
  // Geometry helpers
  // ─────────────────────────────────────────────────────────────────

  /** Seats in the hand, clockwise from the seat left of the button. */
  private orbit(): Seat[] {
    const out: Seat[] = [];
    for (let i = 1; i <= this.seatCount; i++) {
      const s = this.seats[(this.buttonSeat + i) % this.seatCount];
      if (s.inHand) out.push(s);
    }
    return out;
  }

  private nextOccupied(from: number, ok: (s: Seat) => boolean): number {
    for (let i = 1; i <= this.seatCount; i++) {
      const idx = (from + i) % this.seatCount;
      if (ok(this.seats[idx])) return idx;
    }
    return from;
  }
}
