/**
 * ROYALE — local table driver.
 *
 * Runs a complete single-player table: seats bots, deals, drives betting,
 * builds side pots, resolves showdowns, handles rebuys and sit-outs, and
 * keeps a hand history. Everything it does is announced on `core/bus.ts`
 * using exactly the events the network client emits, so the UI, renderer,
 * audio and FX layers cannot tell offline play from online play.
 *
 * It also owns the pacing. Chips settle, cards stagger, the river takes a
 * beat longer than the flop — the timing is part of the product, not an
 * afterthought, so it lives here rather than in the view.
 */

import { bus } from '../core/bus.ts';
import type { LegalAction } from '../core/bus.ts';
import { Rng, secureRng } from '../core/rng.ts';
import { STAKES } from '../core/stakes.ts';
import type {
  Action,
  ActionKind,
  CardId,
  FeedPost,
  GameVariant,
  HandRank,
  HandReplay,
  PlayerRef,
  PositionName,
  Pot,
  SeatState,
  SeatStatus,
  ShowdownResult,
  Stake,
  StakeId,
  Street,
  TableFormat,
  TableState,
} from '../core/types.ts';
import { cardName } from '../core/types.ts';

import { BombPotScheduler, resolveMultiBoard } from './bomb.ts';
import type { BombPlan, BombPotSettings } from './bomb.ts';
import {
  botBeginHand,
  botChatter,
  botObserveResult,
  createBot,
  decideBotAction,
  showdownRank,
} from './bots.ts';
import type { BotContext, BotState } from './bots.ts';
import { pickOpponents, toPlayerRef } from './profiles.ts';
import type { BotProfile } from './profiles.ts';
import { SitAndGo, ordinal } from './sng.ts';
import type { SngConfig } from './sng.ts';

// ═══════════════════════════════════════════════════════════════════
// Adapter — the entire coupling surface with the shared hand modules.
//
// `src/engine/evaluator.ts`, `pots.ts` and `plo.ts` are owned by another
// module. Rather than binding to their exact signatures, the driver runs on
// its own implementations and lets them be swapped in at boot. If their
// shapes differ slightly, only this block changes.
// ═══════════════════════════════════════════════════════════════════

export interface HandEngineAdapter {
  evaluate7?(cards: CardId[]): HandRank;
  evaluatePlo?(hole: CardId[], board: CardId[]): HandRank;
  buildPots?(commitments: number[], folded: boolean[]): Pot[];
}

let adapter: HandEngineAdapter = {};

/** Swap in the shared evaluator/pot builder. Safe to call before `start()`. */
export function setHandEngine(next: HandEngineAdapter): void {
  adapter = next ?? {};
}

function evalHand(variant: GameVariant, hole: readonly CardId[], board: readonly CardId[]): HandRank {
  if (variant === 'plo4') {
    if (adapter.evaluatePlo) {
      try {
        return adapter.evaluatePlo(hole.slice(), board.slice());
      } catch {
        /* fall through to the built-in */
      }
    }
    return showdownRank('plo4', hole, board);
  }
  if (adapter.evaluate7) {
    try {
      return adapter.evaluate7([...hole, ...board]);
    } catch {
      /* fall through to the built-in */
    }
  }
  return showdownRank('nlhe', hole, board);
}

// ═══════════════════════════════════════════════════════════════════
// Scheduling
// ═══════════════════════════════════════════════════════════════════

function nowMs(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * A pausable timer queue. Virtual time only advances while the table runs, so
 * pausing mid-hand freezes every pending beat instead of dumping them all at
 * once on resume.
 */
class Scheduler {
  private items = new Map<number, { due: number; fn: () => void }>();
  private nextId = 1;
  private t = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  running = false;
  onTick: ((dt: number) => void) | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = nowMs();
    this.handle = setTimeout(this.loop, 16);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
  }

  after(ms: number, fn: () => void): number {
    const id = this.nextId++;
    this.items.set(id, { due: this.t + Math.max(0, ms), fn });
    return id;
  }

  cancel(id: number | null): void {
    if (id !== null) this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
  }

  private loop = (): void => {
    if (!this.running) return;
    const n = nowMs();
    const dt = Math.min(250, Math.max(0, n - this.last));
    this.last = n;
    this.t += dt;
    if (this.onTick) this.onTick(dt);
    let due: Array<() => void> | null = null;
    for (const [id, item] of this.items) {
      if (item.due <= this.t) {
        (due ??= []).push(item.fn);
        this.items.delete(id);
      }
    }
    if (due) for (const fn of due) fn();
    if (this.running) this.handle = setTimeout(this.loop, 33);
  };
}

// ═══════════════════════════════════════════════════════════════════
// Options & internal seat model
// ═══════════════════════════════════════════════════════════════════

export interface LocalTableOptions {
  id?: string;
  variant?: GameVariant;
  format?: TableFormat;
  stakeId?: StakeId;
  /** 6 or 9 — also the SNG field size */
  seatCount?: number;
  /** where the human sits; -1 to observe */
  heroSeat?: number;
  heroBuyIn?: number;
  hero?: Partial<PlayerRef>;
  seed?: number;
  /** 0.5 = half speed, 2 = double speed. Bot think-time scales with it. */
  pace?: number;
  bomb?: Partial<BombPotSettings>;
  sng?: SngConfig;
  /** how loose the table plays — biases which personalities get seated */
  looseness?: number;
  /** seat a specific cast instead of drawing one from the roster */
  opponents?: readonly BotProfile[];
  /** cash only: top the human back up automatically when they bust */
  autoRebuy?: boolean;
  /** deal continuously (default) or stop after each hand */
  continuous?: boolean;
}

interface Seat {
  index: number;
  status: SeatStatus;
  player: PlayerRef | null;
  profile: BotProfile | null;
  bot: BotState | null;
  isHuman: boolean;
  stack: number;
  committed: number;
  totalCommitted: number;
  holeCards: CardId[];
  folded: boolean;
  allIn: boolean;
  actedThisStreet: boolean;
  inHand: boolean;
  sitOut: boolean;
  sitOutNextHand: boolean;
  wonLast: boolean;
  lastAction: Action | null;
  timeBankMs: number;
  /** hole cards are face-up to the local client */
  revealed: boolean;
  /** threw the hand away at showdown without showing */
  mucked: boolean;
  startHandStack: number;
  buyIns: number;
  netSession: number;
  postflopAggro: number;
}

type Phase = 'idle' | 'between' | 'dealing' | 'betting' | 'runout' | 'showdown' | 'complete';

const POSITIONS_BY_COUNT: Record<number, PositionName[]> = {
  2: ['BB', 'BTN'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'CO', 'BTN'],
  5: ['SB', 'BB', 'HJ', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};

const HERO_CLOCK_MS = 25_000;

/** Pacing, in ms at pace = 1. */
const BEAT = {
  betweenHands: 1500,
  postBlind: 200,
  dealStagger: 85,
  dealToAction: 420,
  collect: 520,
  streetGap: 620,
  boardCard: 200,
  runoutGap: 900,
  showdownReveal: 380,
  award: 1000,
  afterAward: 1100,
};

// ═══════════════════════════════════════════════════════════════════
// LocalTable
// ═══════════════════════════════════════════════════════════════════

export class LocalTable {
  readonly id: string;
  readonly variant: GameVariant;
  readonly format: TableFormat;
  readonly stake: Stake;
  readonly seatCount: number;
  readonly heroSeat: number;

  private seats: Seat[];
  private rng: Rng;
  private botSeed: number;
  private sched = new Scheduler();
  private bomb: BombPotScheduler;
  private tourney: SitAndGo | null = null;

  private phase: Phase = 'idle';
  private handId = 0;
  private buttonSeat = 0;
  private street: Street = 'preflop';
  private boards: CardId[][] = [[]];
  private deck: number[] = [];
  private deckPos = 0;
  private pots: Pot[] = [];
  private currentBet = 0;
  private lastRaiseSize = 0;
  private minRaiseTo = 0;
  private actingSeat = -1;
  private actionSeq = 0;
  private actions: Action[] = [];
  private preflopRaises = 0;
  private raisesThisStreet = 0;
  private postflopAggroTotal = 0;
  private rakeTaken = 0;
  private tick = 0;
  private bombPlan: BombPlan = { active: false, boards: 1, anteBb: 0, anteChips: 0, seedPot: 0 };
  private sawFlop = false;
  private lastAggressor = -1;
  private heroTimer: number | null = null;
  private heroClockLeft = 0;
  private replays: HandReplay[] = [];
  private chipUnit: number;
  private pace: number;
  private continuous: boolean;
  private autoRebuy: boolean;
  private stopping = false;
  private lastChatterAt = 0;
  private handStartStacks = new Map<number, number>();

  constructor(opts: LocalTableOptions = {}) {
    this.id = opts.id ?? `local-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.variant = opts.variant ?? 'nlhe';
    this.format = opts.format ?? 'cash';
    this.stake = STAKES[opts.stakeId ?? 'nl10'];
    this.seatCount = opts.sng ? opts.sng.seats : Math.max(2, Math.min(9, opts.seatCount ?? 6));
    this.heroSeat = opts.heroSeat ?? 0;
    this.pace = Math.max(0.25, Math.min(4, opts.pace ?? 1));
    this.continuous = opts.continuous ?? true;
    this.autoRebuy = opts.autoRebuy ?? true;
    this.chipUnit = this.format === 'sng' ? 1 : 0.01;

    const seed = opts.seed ?? secureRng().nextU32();
    this.rng = new Rng(seed >>> 0);
    this.botSeed = (seed ^ 0x5bd1e995) >>> 0;
    this.bomb = new BombPotScheduler(
      { enabled: this.format === 'bomb' || (opts.bomb?.enabled ?? false), ...opts.bomb },
      seed ^ 0x2545f491,
    );

    const startStack = opts.sng
      ? opts.sng.startingStack
      : this.q(opts.heroBuyIn ?? this.stake.bb * 100);

    // Cast the table.
    const needed = this.seatCount - (this.heroSeat >= 0 && this.heroSeat < this.seatCount ? 1 : 0);
    const profiles = opts.opponents
      ? opts.opponents.slice(0, needed)
      : pickOpponents(needed, seed >>> 0, { looseness: opts.looseness ?? 0.5 });
    let p = 0;
    this.seats = [];
    for (let i = 0; i < this.seatCount; i++) {
      const isHero = i === this.heroSeat;
      const profile = isHero ? null : (profiles[p++] ?? null);
      const player: PlayerRef | null = isHero
        ? {
            id: opts.hero?.id ?? 'you',
            name: opts.hero?.name ?? 'You',
            avatarId: opts.hero?.avatarId ?? 'av-you',
            frameId: opts.hero?.frameId ?? null,
            titleId: opts.hero?.titleId ?? null,
            emoteSetId: opts.hero?.emoteSetId ?? 'emote-core',
            level: opts.hero?.level ?? 1,
            premium: opts.hero?.premium ?? false,
            heat: opts.hero?.heat ?? 0,
            countryCode: opts.hero?.countryCode,
          }
        : profile
          ? toPlayerRef(profile)
          : null;
      const stack = profile && !opts.sng ? this.q(this.stake.bb * this.rng.range(72, 145)) : startStack;
      this.seats.push({
        index: i,
        status: player ? 'waiting' : 'empty',
        player,
        profile,
        bot: profile ? createBot(profile, i, this.botSeed) : null,
        isHuman: isHero,
        stack: player ? stack : 0,
        committed: 0,
        totalCommitted: 0,
        holeCards: [],
        folded: false,
        allIn: false,
        actedThisStreet: false,
        inHand: false,
        sitOut: false,
        sitOutNextHand: false,
        wonLast: false,
        lastAction: null,
        timeBankMs: 0,
        revealed: isHero,
        mucked: false,
        startHandStack: stack,
        buyIns: player ? stack : 0,
        netSession: 0,
        postflopAggro: 0,
      });
    }

    if (opts.sng) {
      this.tourney = new SitAndGo(
        opts.sng,
        this.seats
          .filter((s) => s.player)
          .map((s) => ({
            seat: s.index,
            id: s.player!.id,
            name: s.player!.name,
            isHuman: s.isHuman,
          })),
        seed ^ 0x1b873593,
      );
    }

    this.buttonSeat = this.rng.int(this.seatCount);
    this.sched.onTick = (dt) => this.onTick(dt);
  }

  // ── lifecycle ────────────────────────────────────────────────────

  start(): void {
    if (this.phase !== 'idle' && this.phase !== 'complete') {
      this.resume();
      return;
    }
    this.stopping = false;
    this.phase = 'between';
    this.sched.start();
    this.emitState();
    this.sched.after(600 / this.pace, () => this.beginHand());
  }

  /** Finish the current hand, then stop dealing. */
  stop(): void {
    this.stopping = true;
    if (this.phase === 'between' || this.phase === 'idle') this.halt();
  }

  /** Freeze immediately — clocks, bots and animations all hold. */
  pause(): void {
    this.sched.stop();
  }

  resume(): void {
    if (this.phase === 'idle' || this.phase === 'complete') return;
    this.sched.start();
  }

  get paused(): boolean {
    return !this.sched.running;
  }

  destroy(): void {
    this.halt();
    this.sched.clear();
  }

  private halt(): void {
    this.sched.stop();
    this.sched.clear();
    this.phase = this.phase === 'complete' ? 'complete' : 'idle';
  }

  // ── public reads ─────────────────────────────────────────────────

  state(): TableState {
    return this.buildState();
  }

  /** The second runout during a double-board bomb pot, else null. */
  secondBoard(): CardId[] | null {
    return this.boards.length > 1 ? this.boards[1].slice() : null;
  }

  allBoards(): CardId[][] {
    return this.boards.map((b) => b.slice());
  }

  tournament(): SitAndGo | null {
    return this.tourney;
  }

  bombStatus() {
    return this.bomb.status();
  }

  history(): HandReplay[] {
    return this.replays;
  }

  lastHand(): HandReplay | null {
    return this.replays.length ? this.replays[this.replays.length - 1] : null;
  }

  /** Legal actions for the human, or an empty list when it is not their turn. */
  legalActions(): LegalAction[] {
    if (this.actingSeat < 0 || !this.seats[this.actingSeat]?.isHuman) return [];
    return this.legalFor(this.seats[this.actingSeat]);
  }

  // ── public writes ────────────────────────────────────────────────

  /** Submit the human's action. Returns false if it was not legal. */
  act(kind: ActionKind, amount = 0): boolean {
    const seat = this.seats[this.actingSeat];
    if (!seat || !seat.isHuman || this.phase !== 'betting') return false;
    const legal = this.legalFor(seat);
    const entry = legal.find((l) => l.kind === kind);
    if (!entry) return false;
    const target = kind === 'bet' || kind === 'raise' ? this.clampAmount(amount, entry.min, entry.max) : entry.max;
    this.sched.cancel(this.heroTimer);
    this.heroTimer = null;
    this.applyAction(seat, kind, target, 0);
    return true;
  }

  sitOut(on: boolean): void {
    const seat = this.seats[this.heroSeat];
    if (!seat) return;
    seat.sitOutNextHand = on;
    if (!seat.inHand) {
      seat.sitOut = on;
      seat.status = on ? 'sitting-out' : 'waiting';
    }
    this.emitState();
  }

  /** Add chips to the human's stack. Applies between hands. */
  rebuy(amount: number): boolean {
    const seat = this.seats[this.heroSeat];
    if (!seat || this.format === 'sng') return false;
    const add = this.q(Math.max(0, amount));
    if (add <= 0) return false;
    seat.stack = this.q(seat.stack + add);
    seat.buyIns = this.q(seat.buyIns + add);
    if (seat.status === 'busted') seat.status = 'waiting';
    seat.sitOut = false;
    this.emitState();
    bus.emit('ui:toast', { text: `Added ${this.fmt(add)}`, tone: 'good' });
    return true;
  }

  /** Pacing multiplier — used by the "fast forward" control. */
  setPace(p: number): void {
    this.pace = Math.max(0.25, Math.min(4, p));
  }

  // ── hand lifecycle ───────────────────────────────────────────────

  private beginHand(): void {
    if (this.stopping) {
      this.halt();
      return;
    }
    if (this.tourney) {
      this.syncTournament();
      if (this.tourney.finished) {
        this.finishTournament();
        return;
      }
    }
    this.applySitOuts();
    this.refillTable();

    const eligible = this.seats.filter((s) => s.player && !s.sitOut && s.stack > 0);
    if (eligible.length < 2) {
      this.phase = 'between';
      this.emitState();
      this.sched.after(1200 / this.pace, () => this.beginHand());
      return;
    }

    // Button moves to the next live seat.
    this.buttonSeat = this.nextOccupied(this.buttonSeat, (s) => s.player !== null && !s.sitOut && s.stack > 0);

    this.handId++;
    this.street = 'preflop';
    this.actions = [];
    this.actionSeq = 0;
    this.preflopRaises = 0;
    this.raisesThisStreet = 0;
    this.postflopAggroTotal = 0;
    this.rakeTaken = 0;
    this.sawFlop = false;
    this.lastAggressor = -1;
    this.pots = [];
    this.handStartStacks.clear();

    const sb = this.tourney ? this.tourney.level.sb : this.stake.sb;
    const bb = this.tourney ? this.tourney.level.bb : this.stake.bb;
    const ante = this.tourney ? this.tourney.level.ante : 0;

    this.bombPlan = this.bomb.beginHand(bb, eligible.length, this.chipUnit);
    this.boards = this.bombPlan.active && this.bombPlan.boards === 2 ? [[], []] : [[]];

    for (const s of this.seats) {
      s.committed = 0;
      s.totalCommitted = 0;
      s.holeCards = [];
      s.folded = false;
      s.allIn = false;
      s.actedThisStreet = false;
      s.lastAction = null;
      s.postflopAggro = 0;
      s.timeBankMs = 0;
      s.revealed = s.isHuman;
      s.mucked = false;
      s.startHandStack = s.stack;
      s.inHand = !!s.player && !s.sitOut && s.stack > 0;
      s.status = s.inHand ? 'active' : s.player ? (s.sitOut ? 'sitting-out' : 'waiting') : 'empty';
      if (s.inHand) this.handStartStacks.set(s.index, s.stack);
      if (s.bot) botBeginHand(s.bot, this.handId);
    }

    this.shuffleDeck();
    this.phase = 'dealing';
    bus.emit('hand:start', { handId: this.handId, buttonSeat: this.buttonSeat });
    bus.emit('cam:focus', { seat: null, intensity: 0.2 });

    if (this.bombPlan.active) {
      this.postBombAntes();
      bus.emit('ui:toast', {
        text: this.bombPlan.boards === 2 ? 'DOUBLE BOARD BOMB POT' : 'BOMB POT',
        tone: 'epic',
        ms: 2200,
      });
      bus.emit('fx:burst', { kind: 'bomb' });
      bus.emit('ui:haptic', { pattern: 'big-win' });
      this.tableChatter('bomb');
    } else {
      this.postBlinds(sb, bb, ante);
    }

    this.dealHoleCards(() => {
      if (this.bombPlan.active) {
        // No preflop street at all: the flop is already on its way.
        this.street = 'flop';
        this.sawFlop = true;
        this.dealBoards(3, 'flop', () => this.beginBettingRound('flop'));
      } else {
        this.beginBettingRound('preflop');
      }
    });
  }

  private postBlinds(sb: number, bb: number, ante: number): void {
    const order = this.orbit();
    if (order.length === 0) return;
    let sbSeat: Seat;
    let bbSeat: Seat;
    if (order.length === 2) {
      sbSeat = this.seats[this.buttonSeat];
      bbSeat = order[0].index === this.buttonSeat ? order[1] : order[0];
    } else {
      sbSeat = order[0];
      bbSeat = order[1];
    }
    // Tournament big-blind ante: the big blind posts for the whole table.
    if (ante > 0) {
      const total = this.q(ante * order.length);
      this.commit(bbSeat, Math.min(total, bbSeat.stack));
    }
    this.commit(sbSeat, Math.min(sb, sbSeat.stack));
    this.commit(bbSeat, Math.min(bb, bbSeat.stack));
    this.currentBet = bb;
    this.lastRaiseSize = bb;
    this.minRaiseTo = this.q(bb * 2);
    // The blinds are dead money, not an action — neither seat has acted yet.
    sbSeat.actedThisStreet = false;
    bbSeat.actedThisStreet = false;
  }

  private postBombAntes(): void {
    for (const s of this.seats) {
      if (!s.inHand) continue;
      this.commit(s, Math.min(this.bombPlan.anteChips, s.stack));
      s.actedThisStreet = false;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.tourney ? this.tourney.level.bb : this.stake.bb;
    this.minRaiseTo = this.lastRaiseSize;
    for (const s of this.seats) if (s.inHand) s.committed = 0;
  }

  private dealHoleCards(done: () => void): void {
    const order = this.orbit();
    const per = this.variant === 'plo4' ? 4 : 2;
    let idx = 0;
    // Two passes round the table, exactly like a live deal.
    for (let round = 0; round < per; round++) {
      for (const s of order) {
        const card = this.draw();
        s.holeCards.push(card);
        const delay = (idx * BEAT.dealStagger) / this.pace;
        const seatIndex = s.index;
        const faceUp = s.isHuman;
        this.sched.after(delay, () => {
          bus.emit('hand:deal-hole', {
            seat: seatIndex,
            cards: [card],
            faceUp,
            order: idx,
          });
        });
        idx++;
      }
    }
    const total = (idx * BEAT.dealStagger + BEAT.dealToAction) / this.pace;
    this.sched.after(total, () => {
      this.emitState();
      done();
    });
  }

  private dealBoards(count: number, street: Street, done: () => void): void {
    let delay = 0;
    for (let b = 0; b < this.boards.length; b++) {
      const cards: CardId[] = [];
      for (let i = 0; i < count; i++) cards.push(this.draw());
      this.boards[b].push(...cards);
      const boardIndex = b;
      this.sched.after(delay, () => {
        bus.emit('hand:deal-board', { street, cards, boardIndex });
        bus.emit('ui:haptic', { pattern: 'deal' });
      });
      delay += (count * BEAT.boardCard + 120) / this.pace;
    }
    this.sched.after(delay + BEAT.streetGap / this.pace, () => {
      this.emitState();
      done();
    });
  }

  // ── betting ──────────────────────────────────────────────────────

  private beginBettingRound(street: Street): void {
    this.street = street;
    this.raisesThisStreet = 0;
    this.phase = 'betting';
    if (street !== 'preflop') {
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind();
      this.minRaiseTo = this.bigBlind();
      for (const s of this.seats) {
        s.committed = 0;
        s.actedThisStreet = false;
      }
      this.lastAggressor = -1;
    }

    const contenders = this.seats.filter((s) => s.inHand && !s.folded);
    if (contenders.length <= 1) {
      this.finishHand();
      return;
    }
    if (contenders.filter((s) => !s.allIn && s.stack > 0).length <= 1) {
      // Nobody left to bet into — run the rest of the board out.
      const needsAction = contenders.filter((s) => !s.allIn && s.stack > 0);
      const owes = needsAction.some((s) => s.committed < this.currentBet);
      if (!owes) {
        this.runOutRemaining();
        return;
      }
    }
    this.emitState();
    this.advanceAction(this.firstToAct(street));
  }

  private firstToAct(street: Street): number {
    const order = this.orbit().filter((s) => s.inHand && !s.folded);
    if (order.length === 0) return -1;
    if (street === 'preflop' && !this.bombPlan.active) {
      if (order.length === 2) {
        // Heads up: the button is the small blind and acts first preflop.
        const btn = order.find((s) => s.index === this.buttonSeat);
        return (btn ?? order[0]).index;
      }
      return (order[2] ?? order[0]).index;
    }
    return order[0].index;
  }

  private advanceAction(from: number): void {
    if (this.phase !== 'betting') return;
    const seat = this.findNextToAct(from);
    if (!seat) {
      this.closeStreet();
      return;
    }
    this.actingSeat = seat.index;
    const clock = seat.isHuman ? HERO_CLOCK_MS : 0;
    seat.timeBankMs = clock;
    this.heroClockLeft = clock;
    const legal = this.legalFor(seat);
    bus.emit('hand:turn', { seat: seat.index, timeMs: clock, legal });
    bus.emit('cam:focus', { seat: seat.index, intensity: seat.isHuman ? 0.35 : 0.6 });
    this.emitState();

    if (seat.isHuman) {
      bus.emit('ui:haptic', { pattern: 'select' });
      this.heroTimer = this.sched.after(clock, () => {
        this.heroTimer = null;
        const toCall = this.q(this.currentBet - seat.committed);
        if (toCall <= 0) this.applyAction(seat, 'check', seat.committed, clock);
        else this.applyAction(seat, 'fold', 0, clock);
        bus.emit('ui:toast', { text: 'Time expired', tone: 'bad', ms: 1400 });
      });
      return;
    }

    const decision = decideBotAction(seat.bot!, this.botContext(seat));
    const wait = Math.max(220, decision.thinkMs / this.pace);
    this.sched.after(wait, () => {
      if (this.phase !== 'betting' || this.actingSeat !== seat.index) return;
      this.applyAction(seat, decision.kind, decision.amount, decision.thinkMs);
    });
  }

  private findNextToAct(from: number): Seat | null {
    const order = this.orbit();
    const start = order.findIndex((s) => s.index === from);
    if (start < 0) return null;
    for (let i = 0; i < order.length; i++) {
      const s = order[(start + i) % order.length];
      if (!s.inHand || s.folded || s.allIn || s.stack <= 0) continue;
      if (!s.actedThisStreet || s.committed < this.currentBet - 1e-9) return s;
    }
    return null;
  }

  private applyAction(seat: Seat, kind: ActionKind, amount: number, tookMs: number): void {
    if (this.phase !== 'betting') return;
    const toCall = this.q(Math.min(this.currentBet - seat.committed, seat.stack));
    let recorded = 0;

    switch (kind) {
      case 'fold':
        seat.folded = true;
        seat.status = 'folded';
        recorded = 0;
        break;
      case 'check':
        recorded = seat.committed;
        break;
      case 'call': {
        this.commit(seat, toCall);
        recorded = seat.committed;
        break;
      }
      case 'bet':
      case 'raise':
      case 'allin': {
        const cap = this.q(seat.committed + seat.stack);
        const target = kind === 'allin' ? cap : this.clampAmount(amount, this.minRaiseTo, cap);
        const add = this.q(Math.min(target - seat.committed, seat.stack));
        this.commit(seat, add);
        recorded = seat.committed;
        if (seat.committed > this.currentBet + 1e-9) {
          const raiseSize = this.q(seat.committed - this.currentBet);
          // An all-in that does not complete a full raise does NOT reopen the
          // betting for players who have already acted — a real rule, and the
          // one people notice when a game gets it wrong.
          const fullRaise = raiseSize >= this.lastRaiseSize - 1e-9;
          if (fullRaise) this.lastRaiseSize = raiseSize;
          this.currentBet = seat.committed;
          this.minRaiseTo = this.q(this.currentBet + this.lastRaiseSize);
          if (fullRaise) {
            for (const o of this.seats) {
              if (o !== seat && o.inHand && !o.folded && !o.allIn) o.actedThisStreet = false;
            }
          }
          this.lastAggressor = seat.index;
          if (this.street === 'preflop') this.preflopRaises++;
          this.raisesThisStreet++;
          if (this.street !== 'preflop') {
            this.postflopAggroTotal++;
            seat.postflopAggro++;
          }
        }
        break;
      }
      default:
        recorded = seat.committed;
        break;
    }

    seat.actedThisStreet = true;
    if (seat.stack <= 1e-9 && !seat.folded) {
      seat.allIn = true;
      seat.status = 'allin';
      bus.emit('fx:burst', { kind: 'allin', seat: seat.index });
      bus.emit('cam:shake', { amount: 0.35, ms: 260 });
    }

    const action: Action = {
      kind: seat.allIn && kind !== 'fold' && kind !== 'check' ? 'allin' : kind,
      amount: this.q(recorded),
      seat: seat.index,
      seq: this.actionSeq++,
      street: this.street,
      tookMs: Math.round(tookMs),
    };
    seat.lastAction = action;
    this.actions.push(action);
    this.actingSeat = -1;

    bus.emit('hand:action', { action, state: this.buildState() });
    bus.emit('ui:haptic', { pattern: kind === 'fold' ? 'fold' : kind === 'check' ? 'tick' : 'bet' });
    this.recomputePots();

    const live = this.seats.filter((s) => s.inHand && !s.folded);
    if (live.length <= 1) {
      this.sched.after(340 / this.pace, () => this.finishHand());
      return;
    }
    this.sched.after(180 / this.pace, () => this.advanceAction(this.nextSeatIndex(seat.index)));
  }

  private closeStreet(): void {
    const moved = this.seats.filter((s) => s.inHand && s.committed > 0).map((s) => s.index);
    const total = this.q(this.seats.reduce((a, s) => a + s.committed, 0));
    if (total > 0) bus.emit('hand:collect', { seats: moved, total });
    for (const s of this.seats) s.committed = 0;
    this.currentBet = 0;
    this.recomputePots();

    const live = this.seats.filter((s) => s.inHand && !s.folded);
    if (live.length <= 1) {
      this.sched.after(BEAT.collect / this.pace, () => this.finishHand());
      return;
    }
    const canStillBet = live.filter((s) => !s.allIn && s.stack > 0);
    if (canStillBet.length <= 1) {
      this.sched.after(BEAT.collect / this.pace, () => this.runOutRemaining());
      return;
    }

    const next = this.nextStreet(this.street);
    if (!next) {
      this.sched.after(BEAT.collect / this.pace, () => this.finishHand());
      return;
    }
    this.sched.after(BEAT.collect / this.pace, () => {
      if (next === 'flop') this.sawFlop = true;
      this.dealBoards(next === 'flop' ? 3 : 1, next, () => this.beginBettingRound(next));
    });
  }

  private nextStreet(s: Street): Street | null {
    if (s === 'preflop') return 'flop';
    if (s === 'flop') return 'turn';
    if (s === 'turn') return 'river';
    return null;
  }

  /** Everyone is all-in — deal what is left with a beat between each card. */
  private runOutRemaining(): void {
    this.phase = 'runout';
    this.actingSeat = -1;
    this.emitState();
    const step = (): void => {
      const next = this.nextStreet(this.street);
      if (!next) {
        this.sched.after(BEAT.runoutGap / this.pace, () => this.finishHand());
        return;
      }
      this.street = next;
      if (next === 'flop') this.sawFlop = true;
      this.dealBoards(next === 'flop' ? 3 : 1, next, () => {
        this.sched.after(BEAT.runoutGap / this.pace, step);
      });
    };
    this.sched.after(BEAT.runoutGap / this.pace, step);
  }

  // ── pots ─────────────────────────────────────────────────────────

  private recomputePots(): void {
    this.pots = this.buildPots();
    const total = this.q(this.pots.reduce((a, p) => a + p.amount, 0));
    bus.emit('hand:pot-update', { pots: this.pots.map((p) => ({ ...p })), total });
  }

  private buildPots(): Pot[] {
    const commitments = this.seats.map((s) => (s.inHand ? this.q(s.totalCommitted) : 0));
    const folded = this.seats.map((s) => !s.inHand || s.folded);
    if (adapter.buildPots) {
      try {
        const out = adapter.buildPots(commitments, folded);
        if (Array.isArray(out) && out.length) return out;
      } catch {
        /* fall through to the built-in */
      }
    }
    const levels = Array.from(new Set(commitments.filter((c) => c > 0))).sort((a, b) => a - b);
    const pots: Pot[] = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0;
      const eligible: number[] = [];
      for (let i = 0; i < commitments.length; i++) {
        const c = commitments[i];
        if (c <= prev) continue;
        amount += Math.min(c, lvl) - prev;
        if (!folded[i] && c >= lvl - 1e-9) eligible.push(i);
      }
      amount = this.q(amount);
      if (amount <= 0) continue;
      const last = pots[pots.length - 1];
      // Merge layers that nobody can win separately, and dead layers.
      if (last && (eligible.length === 0 || sameSet(last.eligible, eligible))) {
        last.amount = this.q(last.amount + amount);
      } else {
        pots.push({ amount, eligible, index: pots.length });
      }
      prev = lvl;
    }
    return pots.map((p, i) => ({ ...p, index: i }));
  }

  private takeRake(pots: Pot[]): number {
    if (this.format === 'sng' || !this.sawFlop) return 0;
    const total = pots.reduce((a, p) => a + p.amount, 0);
    const cap = this.stake.bb * 3;
    let rake = Math.min(this.q(total * 0.05), this.q(cap));
    if (rake <= 0) return 0;
    // Taken off the main pot first, exactly like a live drop.
    for (const p of pots) {
      const take = Math.min(rake, p.amount);
      p.amount = this.q(p.amount - take);
      rake = this.q(rake - take);
      if (rake <= 0) break;
    }
    const taken = this.q(Math.min(this.q(total * 0.05), cap) - rake);
    this.rakeTaken = taken;
    return taken;
  }

  // ── showdown & payout ────────────────────────────────────────────

  private finishHand(): void {
    this.phase = 'showdown';
    this.actingSeat = -1;
    const pots = this.buildPots();
    this.takeRake(pots);
    const live = this.seats.filter((s) => s.inHand && !s.folded);
    const boardCount = this.boards.length;
    const results: ShowdownResult[] = [];
    const ranks = new Map<string, HandRank>();

    const rankKey = (seat: number, board: number): string => `${seat}:${board}`;
    if (live.length > 1) {
      for (const s of live) {
        for (let b = 0; b < boardCount; b++) {
          if (this.boards[b].length >= 3) {
            ranks.set(rankKey(s.index, b), evalHand(this.variant, s.holeCards, this.boards[b]));
          }
        }
      }
    }

    const resolution = resolveMultiBoard({
      pots,
      boards: boardCount === 2 ? 2 : 1,
      rankOf: (seat, board) => {
        const s = this.seats[seat];
        if (!s || !s.inHand || s.folded) return -1;
        if (live.length === 1) return s.folded ? -1 : 1;
        return ranks.get(rankKey(seat, board))?.value ?? -1;
      },
      oddChipOrder: this.orbit().map((s) => s.index),
      chipUnit: this.chipUnit,
    });

    // Reveal order: last aggressor first, then clockwise.
    const showOrder = this.showdownOrder(live);
    let best = -1;
    let delay = 0;
    const contested = live.length > 1;

    for (const s of showOrder) {
      const primary = ranks.get(rankKey(s.index, 0));
      const value = primary?.value ?? -1;
      const beats = value >= best;
      const mustShow = s.allIn || beats || boardCount > 1 || s.isHuman;
      if (beats) best = value;
      const won = this.q(resolution.totals.get(s.index) ?? 0);
      const mucked = contested && !mustShow && won <= 0;
      results.push({ seat: s.index, rank: mucked ? null : (primary ?? null), won, mucked });
      if (contested) {
        const seatIndex = s.index;
        this.sched.after(delay, () => {
          const target = this.seats[seatIndex];
          if (mucked) {
            target.mucked = true;
            bus.emit('hand:muck', { seat: seatIndex });
          } else {
            target.revealed = true;
          }
          this.emitState();
        });
        delay += BEAT.showdownReveal / this.pace;
      }
    }
    if (!contested && live.length === 1) {
      const s = live[0];
      results.push({
        seat: s.index,
        rank: null,
        won: this.q(resolution.totals.get(s.index) ?? 0),
        mucked: true,
      });
    }

    this.sched.after(delay, () => {
      if (contested) {
        bus.emit('hand:showdown', { results, pots: pots.map((p) => ({ ...p })) });
      }
      this.payout(resolution.awards, resolution.scoopers, results, pots);
    });
  }

  private showdownOrder(live: Seat[]): Seat[] {
    const orbit = this.orbit().filter((s) => live.includes(s));
    if (this.lastAggressor >= 0) {
      const i = orbit.findIndex((s) => s.index === this.lastAggressor);
      if (i > 0) return [...orbit.slice(i), ...orbit.slice(0, i)];
    }
    return orbit;
  }

  private payout(
    awards: Array<{ seat: number; amount: number; potIndex: number; boardIndex: number }>,
    scoopers: number[],
    results: ShowdownResult[],
    pots: Pot[],
  ): void {
    let delay = 0;
    const bySeat = new Map<number, number>();
    for (const a of awards) {
      const seatIndex = a.seat;
      const amount = a.amount;
      bySeat.set(seatIndex, this.q((bySeat.get(seatIndex) ?? 0) + amount));
      this.sched.after(delay, () => {
        const s = this.seats[seatIndex];
        if (!s) return;
        s.stack = this.q(s.stack + amount);
        bus.emit('hand:award', { seat: seatIndex, amount, potIndex: a.potIndex });
        bus.emit('fx:burst', { kind: 'chips-win', seat: seatIndex });
        this.emitState();
      });
      delay += 160 / this.pace;
    }

    this.sched.after(delay + BEAT.award / this.pace, () => {
      this.celebrate(bySeat, scoopers, results, pots);
      this.endHand(bySeat, results, pots);
    });
  }

  private celebrate(
    bySeat: Map<number, number>,
    scoopers: number[],
    results: ShowdownResult[],
    pots: Pot[],
  ): void {
    const potTotal = this.q(pots.reduce((a, p) => a + p.amount, 0));
    const bb = this.bigBlind();
    const heroWon = this.q(bySeat.get(this.heroSeat) ?? 0);
    const big = potTotal >= bb * 40;

    for (const [seat, amount] of bySeat) {
      const s = this.seats[seat];
      if (!s || amount <= 0) continue;
      s.wonLast = true;
    }
    for (const s of this.seats) if (!bySeat.has(s.index)) s.wonLast = false;

    const bestRank = results.reduce<HandRank | null>(
      (a, r) => (r.rank && (!a || r.rank.value > a.value) ? r.rank : a),
      null,
    );
    if (bestRank && (bestRank.category === 'quads' || bestRank.category === 'straight-flush')) {
      bus.emit('fx:burst', { kind: bestRank.label === 'Royal Flush' ? 'royal' : 'quads' });
      bus.emit('cam:shake', { amount: 0.6, ms: 420 });
      bus.emit('ui:toast', { text: bestRank.label.toUpperCase(), tone: 'epic', ms: 2600 });
    }
    if (scoopers.length === 1 && this.boards.length > 1) {
      const s = this.seats[scoopers[0]];
      bus.emit('ui:toast', { text: `${s?.player?.name ?? 'Seat'} SCOOPS BOTH BOARDS`, tone: 'epic', ms: 2600 });
      bus.emit('fx:burst', { kind: 'confetti' });
    }
    if (heroWon > 0) {
      bus.emit('ui:haptic', { pattern: big ? 'big-win' : 'win' });
      if (big) bus.emit('fx:burst', { kind: 'confetti', seat: this.heroSeat });
    }
    if (big) this.publishFeedPost(bySeat, results, potTotal, bestRank);
    this.tableChatter(heroWon > 0 ? 'lost-big' : 'won-big');
  }

  private endHand(bySeat: Map<number, number>, results: ShowdownResult[], pots: Pot[]): void {
    const potTotal = this.q(pots.reduce((a, p) => a + p.amount, 0));
    // Session bookkeeping + bot emotional state.
    for (const s of this.seats) {
      if (!s.inHand) continue;
      const net = this.q(s.stack - (this.handStartStacks.get(s.index) ?? s.stack));
      s.netSession = this.q(s.netSession + net);
      if (s.bot) {
        const r = results.find((x) => x.seat === s.index);
        const beaten = !!r && !r.mucked && r.won <= 0 && s.totalCommitted > this.bigBlind() * 12;
        botObserveResult(s.bot, {
          net,
          bigBlind: this.bigBlind(),
          badBeat: beaten,
          wonAtShowdown: (r?.won ?? 0) > 0 && !r?.mucked,
        });
      }
      if (s.stack <= 0) {
        s.status = 'busted';
        s.allIn = false;
      }
      s.inHand = false;
    }

    this.replays.push(this.buildReplay(results, potTotal));
    if (this.replays.length > 120) this.replays.shift();

    this.bomb.endHand();
    bus.emit('hand:end', { handId: this.handId });
    bus.emit('cam:focus', { seat: null, intensity: 0.15 });

    if (this.tourney) {
      this.tourney.noteHandComplete();
      this.syncTournament();
      if (this.tourney.finished) {
        this.sched.after(BEAT.afterAward / this.pace, () => this.finishTournament());
        return;
      }
    }

    this.phase = 'between';
    this.emitState();
    if (!this.continuous || this.stopping) {
      if (this.stopping) this.halt();
      return;
    }
    this.sched.after(BEAT.betweenHands / this.pace, () => this.beginHand());
  }

  // ── tournament & table upkeep ────────────────────────────────────

  private syncTournament(): void {
    if (!this.tourney) return;
    const stacks = new Map<number, number>();
    for (const s of this.seats) if (s.player) stacks.set(s.index, s.stack);
    const elims = this.tourney.syncStacks(stacks, this.handId);
    for (const e of elims) {
      const s = this.seats[e.seat];
      if (s) {
        s.status = 'busted';
        s.sitOut = true;
      }
      const prize = e.prize > 0 ? ` — ${this.fmt(e.prize)}` : '';
      bus.emit('ui:toast', {
        text: `${e.name} out in ${ordinal(e.place)}${prize}`,
        tone: e.isHuman ? 'bad' : 'info',
        ms: 2400,
      });
      if (e.isHuman) bus.emit('ui:haptic', { pattern: 'error' });
      else if (e.wasBubble) {
        bus.emit('ui:toast', { text: 'IN THE MONEY', tone: 'epic', ms: 2600 });
        bus.emit('fx:burst', { kind: 'confetti' });
      }
    }
  }

  private finishTournament(): void {
    if (!this.tourney) return;
    this.phase = 'complete';
    const place = this.tourney.humanPlace();
    const prize = place ? this.tourney.prizeFor(place) : 0;
    if (place === 1) {
      bus.emit('fx:burst', { kind: 'confetti' });
      bus.emit('ui:toast', { text: `Champion — ${this.fmt(prize)}`, tone: 'epic', ms: 3600 });
      bus.emit('ui:haptic', { pattern: 'big-win' });
    } else if (place) {
      bus.emit('ui:toast', {
        text: prize > 0 ? `${ordinal(place)} — ${this.fmt(prize)}` : `Finished ${ordinal(place)}`,
        tone: prize > 0 ? 'good' : 'bad',
        ms: 3200,
      });
    }
    this.emitState();
    this.halt();
  }

  private applySitOuts(): void {
    for (const s of this.seats) {
      if (!s.player) continue;
      if (s.sitOutNextHand !== s.sitOut) {
        s.sitOut = s.sitOutNextHand;
        s.status = s.sitOut ? 'sitting-out' : 'waiting';
      }
    }
  }

  /** Cash games only: bust-outs either reload or make way for a new face. */
  private refillTable(): void {
    if (this.format === 'sng') return;
    const bb = this.stake.bb;
    for (const s of this.seats) {
      if (!s.player || s.stack > this.q(bb * 0.5)) continue;
      if (s.isHuman) {
        if (this.autoRebuy && s.buyIns > 0) {
          const add = this.q(bb * 100);
          s.stack = this.q(s.stack + add);
          s.buyIns = this.q(s.buyIns + add);
          s.status = 'waiting';
          bus.emit('ui:toast', { text: `Auto top-up ${this.fmt(add)}`, tone: 'info', ms: 1800 });
        } else {
          s.sitOut = true;
          s.sitOutNextHand = true;
          s.status = 'busted';
        }
        continue;
      }
      if (this.rng.bool(0.55)) {
        // Reload and keep grinding.
        const add = this.q(bb * this.rng.range(80, 140));
        s.stack = this.q(s.stack + add);
        s.status = 'waiting';
      } else {
        // Rack up and leave; someone new sits down.
        const seated = new Set(this.seats.map((x) => x.profile?.id).filter(Boolean) as string[]);
        const replacement = pickOpponents(1, this.rng.nextU32(), { exclude: Array.from(seated) })[0];
        if (!replacement) {
          const add = this.q(bb * 100);
          s.stack = this.q(s.stack + add);
          s.status = 'waiting';
          continue;
        }
        const leaving = s.player?.name ?? 'Seat';
        s.profile = replacement;
        s.player = toPlayerRef(replacement);
        s.bot = createBot(replacement, s.index, this.rng.nextU32());
        s.stack = this.q(bb * this.rng.range(85, 165));
        s.status = 'waiting';
        s.netSession = 0;
        bus.emit('ui:toast', { text: `${leaving} left · ${replacement.name} joined`, tone: 'info', ms: 1800 });
      }
    }
  }

  // ── bot plumbing ─────────────────────────────────────────────────

  private botContext(seat: Seat): BotContext {
    const bb = this.bigBlind();
    const potTotal = this.q(this.seats.reduce((a, s) => a + s.totalCommitted, 0));
    const toCall = this.q(Math.max(0, Math.min(this.currentBet - seat.committed, seat.stack)));
    const live = this.seats.filter((s) => s.inHand && !s.folded);
    const activeOpponents = live.filter((s) => s.index !== seat.index && !s.allIn && s.stack > 0).length;
    const effective = this.effectiveStack(seat, live);
    const cap = this.q(seat.committed + seat.stack);
    const maxRaiseTo = this.variant === 'plo4' ? Math.min(cap, this.potLimitCap(seat, potTotal, toCall)) : cap;
    const orbit = this.orbit().filter((s) => s.inHand && !s.folded);
    const myOrbit = orbit.findIndex((s) => s.index === seat.index);
    const behind = myOrbit < 0 ? 0 : orbit.length - 1 - myOrbit;

    return {
      variant: this.variant,
      street: this.street,
      handId: this.handId,
      holeCards: seat.holeCards,
      board: this.boards[0],
      boards: this.boards,
      pot: potTotal,
      toCall,
      stack: seat.stack,
      committed: seat.committed,
      bb,
      ante: this.tourney ? this.tourney.level.ante : 0,
      minRaiseTo: Math.min(this.q(Math.max(this.minRaiseTo, this.currentBet + this.lastRaiseSize)), cap),
      maxRaiseTo,
      canCheck: toCall <= 1e-9,
      canRaise: seat.stack > toCall + 1e-9 && maxRaiseTo > seat.committed + 1e-9,
      position: this.positionOf(seat.index),
      seatsInHand: live.length,
      activeOpponents,
      playersToActAfter: behind,
      preflopRaises: this.preflopRaises,
      raisesThisStreet: this.raisesThisStreet,
      opponentPostflopBets: Math.max(0, this.postflopAggroTotal - seat.postflopAggro),
      effectiveStack: effective,
      icmPressure: this.tourney ? this.tourney.icmPressure(seat.index) : 1,
      isBombPot: this.bombPlan.active,
      chipUnit: this.chipUnit,
    };
  }

  private effectiveStack(seat: Seat, live: Seat[]): number {
    let max = 0;
    for (const s of live) {
      if (s.index === seat.index) continue;
      const total = this.q(s.stack + s.committed);
      if (total > max) max = total;
    }
    return this.q(Math.min(this.q(seat.stack + seat.committed), max || this.q(seat.stack + seat.committed)));
  }

  private potLimitCap(seat: Seat, potTotal: number, toCall: number): number {
    return this.q(this.currentBet + potTotal + toCall);
  }

  private tableChatter(trigger: 'won-big' | 'lost-big' | 'bad-beat' | 'bluff-shown' | 'idle' | 'bomb'): void {
    const t = nowMs();
    if (t - this.lastChatterAt < 6000) return;
    const talkers = this.seats.filter((s) => s.bot && s.player);
    if (!talkers.length) return;
    const s = talkers[this.rng.int(talkers.length)];
    const line = botChatter(s.bot!, trigger);
    if (!line) return;
    this.lastChatterAt = t;
    const seatIndex = s.index;
    this.sched.after(this.rng.range(500, 2200) / this.pace, () => {
      bus.emit('social:chat', { fromSeat: seatIndex, text: line });
    });
  }

  // ── legality ─────────────────────────────────────────────────────

  private legalFor(seat: Seat): LegalAction[] {
    const out: LegalAction[] = [];
    const bb = this.bigBlind();
    const potTotal = this.q(this.seats.reduce((a, s) => a + s.totalCommitted, 0));
    const toCall = this.q(Math.max(0, Math.min(this.currentBet - seat.committed, seat.stack)));
    const cap = this.q(seat.committed + seat.stack);
    const maxRaiseTo = this.variant === 'plo4' ? Math.min(cap, this.potLimitCap(seat, potTotal, toCall)) : cap;

    if (toCall > 1e-9) {
      out.push({ kind: 'fold', min: 0, max: 0 });
      out.push({ kind: 'call', min: this.q(seat.committed + toCall), max: this.q(seat.committed + toCall) });
    } else {
      out.push({ kind: 'check', min: seat.committed, max: seat.committed });
    }

    if (seat.stack > toCall + 1e-9) {
      const minTo = Math.min(
        this.q(Math.max(this.currentBet + this.lastRaiseSize, this.currentBet > 0 ? this.currentBet + bb : bb)),
        maxRaiseTo,
      );
      const kind: ActionKind = this.currentBet > 1e-9 ? 'raise' : 'bet';
      const potAfterCall = this.q(potTotal + toCall);
      const presets: Array<{ label: string; amount: number }> = [];
      const add = (label: string, amount: number): void => {
        const a = this.clampAmount(amount, minTo, maxRaiseTo);
        if (!presets.some((x) => Math.abs(x.amount - a) < this.chipUnit / 2)) presets.push({ label, amount: a });
      };
      if (this.street === 'preflop' && this.currentBet > 1e-9) {
        add('2.5x', this.q(this.currentBet * 2.5));
        add('3x', this.q(this.currentBet * 3));
        add('4x', this.q(this.currentBet * 4));
      } else {
        add('⅓', this.q(seat.committed + toCall + potAfterCall * 0.33));
        add('½', this.q(seat.committed + toCall + potAfterCall * 0.5));
        add('¾', this.q(seat.committed + toCall + potAfterCall * 0.75));
        add('Pot', this.q(seat.committed + toCall + potAfterCall));
      }
      add('All in', maxRaiseTo);
      out.push({ kind, min: minTo, max: maxRaiseTo, presets });
      out.push({ kind: 'allin', min: cap, max: cap });
    }
    return out;
  }

  private clampAmount(v: number, min: number, max: number): number {
    const q = this.q(v);
    if (q <= min) return min;
    if (q >= max) return max;
    return q;
  }

  // ── deck ─────────────────────────────────────────────────────────

  private shuffleDeck(): void {
    this.deck = [];
    for (let c = 0; c < 52; c++) this.deck.push(c);
    this.rng.shuffle(this.deck);
    this.deckPos = 0;
  }

  private draw(): CardId {
    if (this.deckPos >= this.deck.length) {
      // Cannot happen with 9 seats and two boards, but never deal a bad card.
      this.shuffleDeck();
    }
    return this.deck[this.deckPos++];
  }

  // ── geometry ─────────────────────────────────────────────────────

  /** Seats in clockwise order starting left of the button. */
  private orbit(): Seat[] {
    const out: Seat[] = [];
    for (let i = 1; i <= this.seatCount; i++) {
      const s = this.seats[(this.buttonSeat + i) % this.seatCount];
      if (s.inHand) out.push(s);
    }
    if (out.length === 0) {
      for (let i = 1; i <= this.seatCount; i++) {
        const s = this.seats[(this.buttonSeat + i) % this.seatCount];
        if (s.player && !s.sitOut && s.stack > 0) out.push(s);
      }
    }
    return out;
  }

  private nextSeatIndex(from: number): number {
    return (from + 1) % this.seatCount;
  }

  private nextOccupied(from: number, ok: (s: Seat) => boolean): number {
    for (let i = 1; i <= this.seatCount; i++) {
      const idx = (from + i) % this.seatCount;
      if (ok(this.seats[idx])) return idx;
    }
    return from;
  }

  private positionOf(seatIndex: number): PositionName {
    const orbit = this.orbit();
    const n = orbit.length;
    const i = orbit.findIndex((s) => s.index === seatIndex);
    if (i < 0 || n < 2) return 'BTN';
    const table = POSITIONS_BY_COUNT[Math.min(9, n)] ?? POSITIONS_BY_COUNT[9];
    return table[Math.min(i, table.length - 1)];
  }

  // ── helpers ──────────────────────────────────────────────────────

  private bigBlind(): number {
    return this.tourney ? this.tourney.level.bb : this.stake.bb;
  }

  private q(v: number): number {
    const u = this.chipUnit;
    return Math.round(Math.round(v / u) * u * 1e6) / 1e6;
  }

  private fmt(v: number): string {
    if (this.format === 'sng') return Math.round(v).toLocaleString();
    return `$${v.toFixed(v >= 100 ? 0 : 2)}`;
  }

  private commit(seat: Seat, amount: number): void {
    const add = this.q(Math.max(0, Math.min(amount, seat.stack)));
    if (add <= 0) return;
    seat.stack = this.q(seat.stack - add);
    seat.committed = this.q(seat.committed + add);
    seat.totalCommitted = this.q(seat.totalCommitted + add);
    if (seat.stack <= 1e-9) {
      seat.allIn = true;
      if (!seat.folded) seat.status = 'allin';
    }
  }

  private onTick(dt: number): void {
    this.tick++;
    if (this.tourney) {
      const leveled = this.tourney.tick(dt);
      if (leveled) {
        bus.emit('ui:toast', {
          text: `Level ${leveled.level} — ${leveled.sb}/${leveled.bb}${leveled.ante ? ` ante ${leveled.ante}` : ''}`,
          tone: 'info',
          ms: 2400,
        });
        this.emitState();
      }
    }
    if (this.heroTimer !== null) {
      this.heroClockLeft = Math.max(0, this.heroClockLeft - dt);
      const hero = this.seats[this.heroSeat];
      if (hero) hero.timeBankMs = this.heroClockLeft;
    }
  }

  // ── state projection ─────────────────────────────────────────────

  private buildState(): TableState {
    const seats: SeatState[] = this.seats.map((s) => ({
      index: s.index,
      status: s.status,
      player: s.player,
      stack: s.stack,
      committed: s.committed,
      totalCommitted: s.totalCommitted,
      holeCards: s.revealed ? s.holeCards.slice() : [],
      revealed: s.revealed,
      isButton: s.index === this.buttonSeat,
      isTurn: s.index === this.actingSeat,
      timeBankMs: s.timeBankMs,
      lastAction: s.lastAction,
      wonLast: s.wonLast,
      sitOutNextHand: s.sitOutNextHand,
    }));
    return {
      id: this.id,
      variant: this.variant,
      format: this.format,
      stake: this.stake,
      seats,
      board: this.boards[0].slice(),
      pots: this.pots.map((p) => ({ ...p })),
      street: this.street,
      handId: this.handId,
      buttonSeat: this.buttonSeat,
      actingSeat: this.actingSeat,
      currentBet: this.currentBet,
      lastRaiseSize: this.lastRaiseSize,
      minRaiseTo: this.minRaiseTo,
      bombPot: this.bomb.config(),
      tournament: this.tourney ? this.tourney.state() : null,
      rake: this.rakeTaken,
      tick: this.tick,
    };
  }

  private emitState(): void {
    bus.emit('table:state', { state: this.buildState(), you: this.heroSeat });
  }

  private buildReplay(results: ShowdownResult[], potTotal: number): HandReplay {
    return {
      handId: this.handId,
      variant: this.variant,
      stakeLabel: this.tourney ? `L${this.tourney.level.level}` : this.stake.label,
      seats: this.seats
        .filter((s) => this.handStartStacks.has(s.index))
        .map((s) => ({
          seat: s.index,
          name: s.player?.name ?? `Seat ${s.index + 1}`,
          avatarId: s.player?.avatarId ?? 'av-01',
          startStack: this.handStartStacks.get(s.index) ?? 0,
          holeCards: s.holeCards.length ? s.holeCards.slice() : null,
        })),
      buttonSeat: this.buttonSeat,
      board: this.boards[0].slice(),
      actions: this.actions.slice(),
      results,
      potTotal,
    };
  }

  private publishFeedPost(
    bySeat: Map<number, number>,
    results: ShowdownResult[],
    potTotal: number,
    bestRank: HandRank | null,
  ): void {
    let winnerSeat = -1;
    let winnerAmount = 0;
    for (const [seat, amount] of bySeat) {
      if (amount > winnerAmount) {
        winnerAmount = amount;
        winnerSeat = seat;
      }
    }
    const s = this.seats[winnerSeat];
    if (!s || !s.player) return;
    const kind = bestRank?.category === 'straight-flush'
      ? (bestRank.label === 'Royal Flush' ? 'royal' : 'straight-flush')
      : bestRank?.category === 'quads'
        ? 'quads'
        : this.bombPlan.active
          ? 'bomb-pot'
          : 'big-win';
    const tier = kind === 'royal' ? 'legendary' : kind === 'quads' || kind === 'straight-flush' ? 'epic' : 'rare';
    const post: FeedPost = {
      id: `hand-${this.id}-${this.handId}`,
      kind,
      author: s.player,
      createdAt: Date.now(),
      headline:
        kind === 'big-win'
          ? `${s.player.name} takes ${this.fmt(potTotal)}`
          : `${s.player.name} — ${bestRank?.label ?? 'bomb pot'}`,
      body: bestRank ? `${bestRank.best.map(cardName).join(' ')} on ${this.boards[0].map(cardName).join(' ')}` : undefined,
      hand: this.buildReplay(results, potTotal),
      reactions: [],
      comments: [],
      stakeLabel: this.stake.short,
      variant: this.variant,
      amount: winnerAmount,
      tier,
    };
    bus.emit('feed:post', { post });
  }
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Convenience factory — mirrors the shape of the network client's `connect()`. */
export function createLocalTable(opts: LocalTableOptions = {}): LocalTable {
  return new LocalTable(opts);
}
