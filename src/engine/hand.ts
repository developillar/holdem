/**
 * One complete hand of poker, start to finish.
 *
 * The hand is an async state machine: it posts the forced bets, deals, runs a
 * betting round per street, deals the board, and settles the pot. Whenever it
 * needs a decision it publishes `hand:turn` and awaits a promise — the UI (or a
 * bot, or the network layer) resolves that promise with `submit()`. Nothing in
 * here knows about DOM, WebGL or sockets; everything the outside world needs
 * comes through the typed bus.
 *
 *   const hand = new PokerHand({ ...options });
 *   const done = hand.run();               // starts dealing immediately
 *   bus.on('hand:turn', ({ seat }) => …);  // UI renders the bet pad
 *   await hand.submit('raise', 30);        // resolves with the applied Action
 *   const result = await done;             // showdown + awards + replay
 *
 * Variants: 'nlhe' and 'plo4'. Formats: normal, bomb pots (forced ante, no
 * preflop betting) and run-it-twice / double board, where the pot is split
 * exactly between the boards with the odd chip riding on the first.
 */
import type {
  Action, ActionKind, BombPotConfig, CardId, GameVariant, HandRank, HandReplay,
  PlayerRef, Pot, SeatState, SeatStatus, ShowdownResult, Stake, Street, TableFormat, TableState,
} from '../core/types.ts';
import type { AppEvents, LegalAction } from '../core/bus.ts';
import { bus } from '../core/bus.ts';
import { Rng, secureRng } from '../core/rng.ts';
import { Deck, dealHoleCards, holeCardCount, parseCards } from './cards.ts';
import { evaluateHoldem, evaluateValue } from './evaluator.ts';
import { evaluatePlo, ploValue } from './plo.ts';
import { Betting, IllegalActionError, orderFrom } from './betting.ts';
import type { BettingSeat } from './betting.ts';
import type { Award } from './pots.ts';
import {
  buildPots, distribute, potTotal, roundChips, splitPotsAcrossBoards,
  takeRake, uncalledPortion, DEFAULT_CHIP_STEP,
} from './pots.ts';

// ─────────────────────────── options ───────────────────────────

export interface HandSeatSeed {
  seat: number;
  player: PlayerRef | null;
  stack: number;
  /** seat is present but not dealt in */
  sitOut?: boolean;
}

/** Forces specific cards, for tests, replays and scripted tutorials. */
export interface ScriptedDeal {
  /** seat -> hole cards, as CardIds or "AhKs" */
  hole?: Record<number, CardId[] | string>;
  /** board 0 (up to five cards); index 1 is the second run/board */
  boards?: Array<CardId[] | string>;
}

export interface ActionRequest {
  handId: number;
  seat: number;
  legal: LegalAction[];
  /** ms on the action clock */
  timeMs: number;
  state: TableState;
  /** set when the previous submission was rejected, so the UI can explain */
  error?: string;
}

export interface ActionSubmission {
  kind: ActionKind;
  amount?: number;
  tookMs?: number;
}

export interface HandOptions {
  handId: number;
  tableId?: string;
  variant: GameVariant;
  format?: TableFormat;
  stake: Stake;
  seats: HandSeatSeed[];
  buttonSeat: number;
  /** ring size; defaults to the highest seat index in play + 1 */
  seatCount?: number;
  /** per-player ante posted before the blinds */
  ante?: number;
  chipStep?: number;
  rng?: Rng;
  scripted?: ScriptedDeal;
  bombPot?: BombPotConfig | null;
  /** deal this many boards from the start (bomb pots use 2) */
  boards?: 1 | 2;
  /** when everyone is all-in before the river, run the rest out twice */
  runItTwice?: boolean;
  /** seats whose hole cards are dealt face-up to this client */
  faceUpSeats?: number[];
  actionTimeMs?: number;
  /** auto check/fold when the clock expires (bots and the server use this) */
  autoTimeout?: boolean;
  /** publish bus events; off for headless simulation */
  emit?: boolean;
  /** decision provider — bots and the net layer plug in here */
  decide?: (req: ActionRequest) => ActionSubmission | Promise<ActionSubmission>;
  rake?: { pct: number; cap: number } | null;
}

export interface SeatOutcome {
  seat: number;
  startStack: number;
  endStack: number;
  net: number;
  holeCards: CardId[];
  /** best hand per board, empty when the seat never reached showdown */
  ranks: HandRank[];
  folded: boolean;
  mucked: boolean;
  won: number;
}

export interface HandResult {
  handId: number;
  variant: GameVariant;
  /** board 0 */
  board: CardId[];
  boards: CardId[][];
  pots: Pot[];
  potTotal: number;
  rake: number;
  results: ShowdownResult[];
  awards: Award[];
  actions: Action[];
  wentToShowdown: boolean;
  outcomes: SeatOutcome[];
  replay: HandReplay;
}

// ─────────────────────────── the hand ───────────────────────────

const STATUS_BY_PHASE: Record<BettingSeat['phase'], SeatStatus> = {
  out: 'sitting-out',
  active: 'active',
  folded: 'folded',
  allin: 'allin',
};

export class PokerHand {
  readonly opts: HandOptions;
  readonly betting: Betting;
  readonly deck: Deck;
  readonly boards: CardId[][] = [[]];
  readonly hole = new Map<number, CardId[]>();
  readonly startStacks = new Map<number, number>();

  street: Street = 'preflop';
  boardCount = 1;
  rake = 0;
  private pots: Pot[] = [];
  private readonly step: number;
  private readonly seatCount: number;
  private readonly faceUp: Set<number>;
  private readonly revealed = new Set<number>();
  private readonly rng: Rng;
  private tick = 0;
  private finished = false;

  private pending: {
    seat: number;
    resolve: (s: ActionSubmission) => void;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private ack: { resolve: (a: Action) => void; reject: (e: unknown) => void } | null = null;
  /** the live request, so a reconnecting client can rebuild the bet pad */
  request: ActionRequest | null = null;

  constructor(opts: HandOptions) {
    this.opts = opts;
    this.step = opts.chipStep ?? DEFAULT_CHIP_STEP;
    this.rng = opts.rng ?? secureRng();
    this.seatCount = opts.seatCount ?? Math.max(...opts.seats.map((s) => s.seat)) + 1;
    this.faceUp = new Set(opts.faceUpSeats ?? []);
    this.boardCount = opts.boards ?? (opts.bombPot?.boards ?? 1);
    for (let b = 1; b < this.boardCount; b++) this.boards.push([]);

    const inPlay = opts.seats.filter((s) => !s.sitOut && s.stack > 0);
    this.betting = new Betting(
      {
        variant: opts.variant,
        sb: opts.stake.sb,
        bb: opts.stake.bb,
        ante: opts.ante ?? 0,
        step: this.step,
        seatCount: this.seatCount,
      },
      opts.seats.map((s) => ({ seat: s.seat, stack: s.stack, inHand: !s.sitOut && s.stack > 0 })),
      opts.buttonSeat,
    );
    for (const s of opts.seats) this.startStacks.set(s.seat, roundChips(s.stack, this.step));
    if (inPlay.length < 2) throw new Error('a hand needs at least two funded players');

    this.deck = Deck.shuffled(this.rng);
  }

  // ── public API ────────────────────────────────────────────────

  /** Plays the hand to completion. Resolves with the full result + replay. */
  async run(): Promise<HandResult> {
    this.emit('hand:start', { handId: this.opts.handId, buttonSeat: this.opts.buttonSeat });

    const bomb = this.opts.bombPot;
    if (bomb) {
      const posted = this.betting.postBombAnte(roundChips(bomb.anteBb * this.opts.stake.bb, this.step));
      for (const a of posted) this.emitAction(a);
    } else {
      const posted = this.betting.postForcedBets();
      for (const a of posted) this.emitAction(a);
    }
    this.dealHole();
    this.emitPots();

    if (!bomb) {
      await this.runBettingRound('preflop');
    }

    for (const street of ['flop', 'turn', 'river'] as const) {
      if (this.liveCount() <= 1) break;
      this.maybeSplitBoards();
      const skipBetting = this.betting.noMoreBetting();
      this.street = street;
      this.dealStreet(street);
      if (skipBetting) continue;
      this.betting.beginStreet(street);
      await this.runBettingRound(street);
    }

    return this.settle();
  }

  /**
   * Answers the open action request. Resolves with the Action the engine
   * applied, or rejects with `IllegalActionError` — the request stays open on
   * rejection so the UI can simply let the player try again.
   */
  submit(kind: ActionKind, amount = 0, tookMs?: number): Promise<Action> {
    const p = this.pending;
    if (!p) return Promise.reject(new IllegalActionError('no action is pending', -1));
    return new Promise<Action>((resolve, reject) => {
      this.ack = { resolve, reject };
      this.clearTimer();
      this.pending = null;
      p.resolve({ kind, amount, tookMs });
    });
  }

  /** Current public table snapshot. Safe to hand straight to the renderer. */
  snapshot(): TableState {
    const seats: SeatState[] = this.betting.seats.map((s) => {
      const seed = this.opts.seats.find((x) => x.seat === s.seat);
      const status: SeatStatus = seed
        ? (seed.sitOut ? 'sitting-out' : STATUS_BY_PHASE[s.phase])
        : 'empty';
      const showCards = this.faceUp.has(s.seat) || this.revealed.has(s.seat);
      return {
        index: s.seat,
        status,
        player: seed?.player ?? null,
        stack: s.stack,
        committed: s.committed,
        totalCommitted: s.totalCommitted,
        holeCards: showCards ? (this.hole.get(s.seat) ?? []).slice() : [],
        revealed: showCards,
        isButton: s.seat === this.opts.buttonSeat,
        isTurn: s.seat === this.betting.actingSeat,
        timeBankMs: s.seat === this.betting.actingSeat ? this.actionTimeMs() : 0,
        lastAction: s.lastAction,
        wonLast: false,
        sitOutNextHand: seed?.sitOut ?? false,
      };
    });
    return {
      id: this.opts.tableId ?? 'local',
      variant: this.opts.variant,
      format: this.opts.format ?? 'cash',
      stake: this.opts.stake,
      seats,
      board: this.boards[0].slice(),
      pots: this.pots.map((p) => ({ ...p, eligible: p.eligible.slice() })),
      street: this.street,
      handId: this.opts.handId,
      buttonSeat: this.opts.buttonSeat,
      actingSeat: this.betting.actingSeat,
      currentBet: this.betting.currentBet,
      lastRaiseSize: this.betting.lastFullRaiseSize,
      minRaiseTo: this.betting.minRaiseTo,
      bombPot: this.opts.bombPot ?? null,
      tournament: null,
      rake: this.rake,
      tick: ++this.tick,
    };
  }

  // ── dealing ───────────────────────────────────────────────────

  private dealHole(): void {
    const perSeat = holeCardCount(this.opts.variant);
    const players = this.betting.liveSeats();
    const order = orderFrom(players, this.opts.buttonSeat, this.seatCount).map((s) => s.seat);

    const script = this.opts.scripted?.hole;
    if (script) {
      for (const [key, spec] of Object.entries(script)) {
        const seat = Number(key);
        const cards = toCards(spec);
        this.deck.remove(cards);
        this.hole.set(seat, cards.slice());
      }
    }
    const needed = order.filter((s) => !this.hole.has(s));
    if (needed.length) {
      const dealt = dealHoleCards(this.deck, needed, perSeat);
      for (const [seat, cards] of dealt.hole) this.hole.set(seat, cards);
    }
    let i = 0;
    for (const seat of order) {
      const cards = this.hole.get(seat) ?? [];
      this.emit('hand:deal-hole', {
        seat,
        cards: cards.slice(),
        faceUp: this.faceUp.has(seat),
        order: i++,
      });
    }
  }

  /** Splits into two runs the moment the money is in and cards are still to come. */
  private maybeSplitBoards(): void {
    if (this.boardCount > 1) return;
    if (!this.opts.runItTwice) return;
    if (this.liveCount() < 2) return;
    if (!this.betting.noMoreBetting()) return;
    this.boardCount = 2;
    this.boards.push(this.boards[0].slice());
  }

  private dealStreet(street: Street): void {
    const count = street === 'flop' ? 3 : 1;
    for (let b = 0; b < this.boardCount; b++) {
      const cards = this.scriptedBoardCards(b, count) ?? this.deck.burnAndDeal(count);
      for (const c of cards) this.boards[b].push(c);
      this.emit('hand:deal-board', { street, cards: cards.slice(), boardIndex: b });
    }
  }

  /** Pulls the next scripted cards for a board, if the fixture supplied any. */
  private scriptedBoardCards(boardIndex: number, count: number): CardId[] | null {
    const spec = this.opts.scripted?.boards?.[boardIndex];
    if (!spec) return null;
    const all = toCards(spec);
    const have = this.boards[boardIndex].length;
    if (have + count > all.length) return null;
    const cards = all.slice(have, have + count);
    this.deck.remove(cards);
    return cards;
  }

  // ── betting ───────────────────────────────────────────────────

  private async runBettingRound(street: Street): Promise<void> {
    this.street = street;
    let error: string | undefined;
    let attempts = 0;
    let guard = 0;
    while (this.betting.actingSeat >= 0) {
      if (++guard > 1000) throw new Error('betting round failed to terminate');
      const seat = this.betting.actingSeat;
      const sub = await this.requestAction(seat, error);
      error = undefined;
      try {
        const action = this.betting.apply(seat, sub.kind, sub.amount ?? 0, sub.tookMs);
        attempts = 0;
        this.ack?.resolve(action);
        this.ack = null;
        this.emitAction(action);
        this.emitPots();
      } catch (err) {
        this.ack?.reject(err);
        this.ack = null;
        error = err instanceof Error ? err.message : String(err);
        if (++attempts >= 4) {
          // A provider that keeps sending garbage forfeits the decision.
          const fallback = this.betting.timeoutAction(seat);
          const action = this.betting.apply(seat, fallback.kind, fallback.amount);
          attempts = 0;
          this.emitAction(action);
          this.emitPots();
          error = undefined;
        }
      }
    }
    this.closeStreet();
  }

  private requestAction(seat: number, error?: string): Promise<ActionSubmission> {
    const legal = this.betting.legalActions(seat);
    const timeMs = this.actionTimeMs();
    const req: ActionRequest = {
      handId: this.opts.handId,
      seat,
      legal,
      timeMs,
      state: this.snapshot(),
      ...(error ? { error } : {}),
    };
    this.request = req;
    this.emit('hand:turn', { seat, timeMs, legal });

    return new Promise<ActionSubmission>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (this.opts.autoTimeout) {
        timer = setTimeout(() => {
          if (this.pending && this.pending.seat === seat) {
            this.pending = null;
            resolve({ ...this.betting.timeoutAction(seat), tookMs: timeMs });
          }
        }, timeMs);
      }
      this.pending = { seat, resolve, timer };
      const provider = this.opts.decide;
      if (provider) {
        const started = Date.now();
        Promise.resolve(provider(req)).then(
          (sub) => {
            if (this.pending && this.pending.seat === seat) {
              this.clearTimer();
              this.pending = null;
              resolve({ tookMs: Date.now() - started, ...sub });
            }
          },
          () => {
            if (this.pending && this.pending.seat === seat) {
              this.clearTimer();
              this.pending = null;
              resolve({ ...this.betting.timeoutAction(seat) });
            }
          },
        );
      }
    });
  }

  private clearTimer(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
  }

  /** Sweeps the street's chips into the middle and refunds any uncalled bet. */
  private closeStreet(): void {
    this.request = null;
    this.refundUncalled();
    const contributors = this.betting.seats.filter((s) => s.committed > 0).map((s) => s.seat);
    if (contributors.length) {
      this.emit('hand:collect', {
        seats: contributors,
        total: roundChips(this.betting.streetCommitted(), this.step),
      });
    }
    this.emitPots();
  }

  private refundUncalled(): void {
    const refund = uncalledPortion(
      this.betting.seats.map((s) => ({
        seat: s.seat,
        total: s.totalCommitted,
        folded: s.phase === 'folded' || s.phase === 'out',
      })),
      this.step,
    );
    if (!refund) return;
    const s = this.betting.seats[refund.seat];
    s.stack = roundChips(s.stack + refund.amount, this.step);
    s.totalCommitted = roundChips(s.totalCommitted - refund.amount, this.step);
    s.committed = roundChips(Math.max(0, s.committed - refund.amount), this.step);
    if (s.phase === 'allin' && s.stack > this.step / 2) s.phase = 'active';
  }

  // ── settlement ────────────────────────────────────────────────

  private settle(): HandResult {
    this.refundUncalled();
    this.pots = this.buildPotsNow();
    const rakeCfg = this.opts.rake;
    if (rakeCfg && this.boards[0].length > 0) {
      this.rake = takeRake(this.pots, rakeCfg.pct, rakeCfg.cap, this.step);
    }
    this.pushPots();

    const live = this.betting.liveSeats();
    const wentToShowdown = live.length > 1;
    const ranksBySeat = new Map<number, HandRank[]>();
    const strengthByBoard: Array<Map<number, number>> = [];

    if (wentToShowdown) {
      for (let b = 0; b < this.boardCount; b++) {
        const m = new Map<number, number>();
        for (const s of live) {
          const cards = this.hole.get(s.seat) ?? [];
          m.set(s.seat, this.strengthOf(cards, this.boards[b]));
        }
        strengthByBoard.push(m);
      }
      for (const s of live) {
        const cards = this.hole.get(s.seat) ?? [];
        const list: HandRank[] = [];
        for (let b = 0; b < this.boardCount; b++) list.push(this.rankOf(cards, this.boards[b]));
        ranksBySeat.set(s.seat, list);
      }
    } else if (live.length === 1) {
      const m = new Map<number, number>();
      m.set(live[0].seat, 1);
      strengthByBoard.push(m);
    }

    // Award every board.
    const perBoard = splitPotsAcrossBoards(this.pots, wentToShowdown ? this.boardCount : 1, this.step);
    const awards: Award[] = [];
    for (let b = 0; b < perBoard.length; b++) {
      const strength = strengthByBoard[b] ?? strengthByBoard[0];
      const boardAwards = distribute({
        pots: perBoard[b],
        strength,
        buttonSeat: this.opts.buttonSeat,
        seatCount: this.seatCount,
        step: this.step,
      });
      for (const a of boardAwards) awards.push(a);
    }

    const wonBySeat = new Map<number, number>();
    for (const a of awards) wonBySeat.set(a.seat, roundChips((wonBySeat.get(a.seat) ?? 0) + a.amount, this.step));

    // Who has to show, who gets to muck.
    const mucked = new Set<number>();
    // When someone is all-in there is no more betting, so every remaining hand
    // is tabled face-up — nobody gets to protect a bluff.
    const allInShowdown = live.some((s) => s.phase === 'allin');
    if (wentToShowdown && allInShowdown) {
      for (const s of live) this.revealed.add(s.seat);
    } else if (wentToShowdown) {
      for (const seat of this.showdownOrder()) {
        const wins = (wonBySeat.get(seat) ?? 0) > 0;
        if (wins) { this.revealed.add(seat); continue; }
        // You only turn your hand over if it beats everything already shown.
        const mine = strengthByBoard[0].get(seat) ?? -1;
        let bestShown = -Infinity;
        for (const shown of this.revealed) {
          bestShown = Math.max(bestShown, strengthByBoard[0].get(shown) ?? -1);
        }
        if (mine > bestShown) this.revealed.add(seat);
        else mucked.add(seat);
      }
    } else if (live.length === 1) {
      mucked.add(live[0].seat);
    }

    const results: ShowdownResult[] = [];
    for (const s of live) {
      const isMucked = mucked.has(s.seat);
      results.push({
        seat: s.seat,
        rank: isMucked ? null : (ranksBySeat.get(s.seat)?.[0] ?? null),
        won: wonBySeat.get(s.seat) ?? 0,
        mucked: isMucked,
      });
    }

    if (wentToShowdown) {
      this.street = 'showdown';
      this.emit('hand:showdown', { results, pots: this.pots.map((p) => ({ ...p })) });
    }
    for (const seat of mucked) this.emit('hand:muck', { seat });

    // Pay out.
    for (const a of awards) {
      const s = this.betting.seats[a.seat];
      s.stack = roundChips(s.stack + a.amount, this.step);
      this.emit('hand:award', { seat: a.seat, amount: a.amount, potIndex: a.potIndex });
    }

    const outcomes: SeatOutcome[] = this.opts.seats.map((seed) => {
      const s = this.betting.seats[seed.seat];
      const start = this.startStacks.get(seed.seat) ?? 0;
      return {
        seat: seed.seat,
        startStack: start,
        endStack: s.stack,
        net: roundChips(s.stack - start, this.step),
        holeCards: (this.hole.get(seed.seat) ?? []).slice(),
        ranks: ranksBySeat.get(seed.seat) ?? [],
        folded: s.phase === 'folded',
        mucked: mucked.has(seed.seat),
        won: wonBySeat.get(seed.seat) ?? 0,
      };
    });

    this.finished = true;
    this.request = null;
    this.emit('hand:end', { handId: this.opts.handId });

    const total = roundChips(potTotal(this.pots) + this.rake, this.step);
    return {
      handId: this.opts.handId,
      variant: this.opts.variant,
      board: this.boards[0].slice(),
      boards: this.boards.map((b) => b.slice()),
      pots: this.pots.map((p) => ({ ...p, eligible: p.eligible.slice() })),
      potTotal: total,
      rake: this.rake,
      results,
      awards,
      actions: this.betting.log.slice(),
      wentToShowdown,
      outcomes,
      replay: this.buildReplay(results, total),
    };
  }

  /**
   * Showdown order: the last player to bet or raise on the final street shows
   * first; if the street was checked through it starts left of the button.
   */
  private showdownOrder(): number[] {
    const live = this.betting.liveSeats();
    const log = this.betting.log;
    const lastStreet = log.length ? log[log.length - 1].street : 'preflop';
    let first = -1;
    for (let i = log.length - 1; i >= 0; i--) {
      const a = log[i];
      if (a.street !== lastStreet) break;
      if (a.kind === 'bet' || a.kind === 'raise' || a.kind === 'allin') { first = a.seat; break; }
    }
    const anchor = first >= 0
      ? (first - 1 + this.seatCount) % this.seatCount
      : this.opts.buttonSeat;
    return orderFrom(live, anchor, this.seatCount).map((s) => s.seat);
  }

  private buildPotsNow(): Pot[] {
    return buildPots(
      this.betting.seats.map((s) => ({
        seat: s.seat,
        total: s.totalCommitted,
        folded: s.phase === 'folded' || s.phase === 'out',
      })),
      this.step,
    );
  }

  private buildReplay(results: ShowdownResult[], total: number): HandReplay {
    return {
      handId: this.opts.handId,
      variant: this.opts.variant,
      stakeLabel: this.opts.stake.label,
      seats: this.opts.seats.map((seed) => ({
        seat: seed.seat,
        name: seed.player?.name ?? `Seat ${seed.seat + 1}`,
        avatarId: seed.player?.avatarId ?? 'default',
        startStack: this.startStacks.get(seed.seat) ?? 0,
        holeCards: this.revealed.has(seed.seat) || this.faceUp.has(seed.seat)
          ? (this.hole.get(seed.seat) ?? []).slice()
          : null,
      })),
      buttonSeat: this.opts.buttonSeat,
      board: this.boards[0].slice(),
      actions: this.betting.log.slice(),
      results,
      potTotal: total,
    };
  }

  // ── helpers ───────────────────────────────────────────────────

  private strengthOf(hole: readonly CardId[], board: readonly CardId[]): number {
    if (board.length < 3 || hole.length === 0) return -1;
    if (this.opts.variant === 'plo4') return ploValue(hole, board);
    const all = hole.concat(board as CardId[]);
    return evaluateValue(all, all.length);
  }

  private rankOf(hole: readonly CardId[], board: readonly CardId[]): HandRank {
    return this.opts.variant === 'plo4' ? evaluatePlo(hole, board) : evaluateHoldem(hole, board);
  }

  private liveCount(): number {
    return this.betting.liveSeats().length;
  }

  private actionTimeMs(): number {
    return this.opts.actionTimeMs ?? 25000;
  }

  private emitAction(action: Action): void {
    this.emit('hand:action', { action, state: this.snapshot() });
  }

  /** Rebuilds the side-pot structure from commitments and publishes it. */
  private emitPots(): void {
    this.pots = this.buildPotsNow();
    this.pushPots();
  }

  /** Publishes the pot structure as-is (after rake, it must not be rebuilt). */
  private pushPots(): void {
    this.emit('hand:pot-update', {
      pots: this.pots.map((p) => ({ ...p, eligible: p.eligible.slice() })),
      total: potTotal(this.pots),
    });
  }

  private emit<K extends keyof AppEvents>(key: K, payload: AppEvents[K]): void {
    if (this.opts.emit === false) return;
    bus.emit(key, payload);
  }

  get isFinished(): boolean {
    return this.finished;
  }
}

/** Plays a hand end to end with a decision provider. */
export async function playHand(opts: HandOptions): Promise<HandResult> {
  return new PokerHand(opts).run();
}

function toCards(spec: CardId[] | string): CardId[] {
  return typeof spec === 'string' ? parseCards(spec) : spec.slice();
}
