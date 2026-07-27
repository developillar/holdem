/**
 * ROYALE — client transport.
 *
 * The design constraint that shapes this whole file: **the UI must not be
 * able to tell whether it is online.** Everything the local engine emits on
 * `core/bus.ts`, this client emits too, in the same order, with the same
 * payload shapes. No screen, renderer or audio module imports anything from
 * `src/net/*` — they listen to the bus, and the bus is the only thing that
 * changes when a real socket appears.
 *
 * On top of that: exponential backoff with jitter, a heartbeat that measures
 * RTT, an outbound queue that survives a lift-doors-closing disconnect, a
 * full-snapshot resync on reconnect, and clean teardown.
 *
 * ── One renderer accommodation, documented on purpose ─────────────────────
 * The 3D dealer sets a card's face when the card is *dealt*. Online, we do
 * not know an opponent's cards at deal time (and must not), so the bridge
 * deals face-down placeholders and, at showdown, mucks the placeholders and
 * re-deals the real cards before the reveal flip. `refaceStrategy` switches
 * this off the moment `src/render/dealing.ts` learns to re-face a hole card
 * from `table:state` — see the report accompanying this module.
 */

import { bus } from '../core/bus.ts';
import type { LegalAction } from '../core/bus.ts';
import type {
  Action,
  ActionKind,
  CardId,
  LobbyTable,
  Pot,
  ReactionKind,
  ShowdownResult,
  TableState,
} from '../core/types.ts';

import { applyPatch, decodeServer, encode } from '../../server/protocol.ts';
import type { ClientPacket, ServerPacket, StatePatch } from '../../server/protocol.ts';
import { Predictor, ServerClock, TableSmoother } from './prediction.ts';

export type NetStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'closed' | 'failed';

export interface NetClientOptions {
  url: string;
  name: string;
  avatarId: string;
  /** resume token from a previous session (this is the player id) */
  token?: string | null;
  /** give up after this many consecutive failures (default: never) */
  maxRetries?: number;
  /** ms before the first connection attempt is considered failed */
  connectTimeoutMs?: number;
  /** how showdown hole cards are re-faced — see the header note */
  refaceStrategy?: 'redeal' | 'state';
  onStatus?(status: NetStatus, detail?: string): void;
}

export interface JoinOutcome {
  ok: boolean;
  seat: number;
  buyIn: number;
  waitlist?: number;
  reason?: string;
}

const BACKOFF_BASE_MS = 400;
const BACKOFF_FACTOR = 1.7;
const BACKOFF_CAP_MS = 12_000;
const PING_MS = 5_000;
const QUEUE_MAX = 48;
const REQUEST_TIMEOUT_MS = 8_000;
/** delay between re-dealing the true showdown cards and flipping them */
const REVEAL_SETTLE_MS = 360;

interface Waiter {
  resolve(v: JoinOutcome): void;
  timer: ReturnType<typeof setTimeout>;
}

export class NetClient {
  readonly smoothing = new TableSmoother();
  readonly clock = new ServerClock();

  private opts: NetClientOptions;
  private ws: WebSocket | null = null;
  private status_: NetStatus = 'idle';
  private playerId_ = '';
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private queue: ClientPacket[] = [];
  private disposed = false;
  private userClosed = false;

  private state_: TableState | null = null;
  private you_ = -1;
  private tableId_: string | null = null;
  private legal_: LegalAction[] = [];
  private turnHandId = -1;
  private actSeq = 0;
  private lobby_: LobbyTable[] = [];
  private lobbySubscribed = false;
  private lobbyListeners = new Set<(tables: LobbyTable[]) => void>();
  private statusListeners = new Set<(s: NetStatus, detail?: string) => void>();

  private predictor: Predictor;
  /** placeholder faces we dealt for hidden hole cards, per seat */
  private placeholders: CardId[][] = [];
  private joinWaiter: Waiter | null = null;
  private pendingPings = new Map<number, number>();
  /** what to re-take on reconnect; cleared by an explicit leave */
  private lastJoin: { tableId: string; buyIn: number; seat?: number } | null = null;

  constructor(opts: NetClientOptions) {
    this.opts = opts;
    this.predictor = new Predictor({
      onState: (s) => this.publishState(s),
      onAction: (a, s) => bus.emit('hand:action', { action: a, state: s }),
      onRollback: (s, reason) => {
        this.publishState(s);
        bus.emit('ui:toast', { text: rollbackText(reason), tone: 'bad', ms: 1600 });
        bus.emit('ui:haptic', { pattern: 'error' });
      },
    });
    if (opts.onStatus) this.statusListeners.add(opts.onStatus);
  }

  // ─────────────────────────────────────────────────────────────────
  // Public state
  // ─────────────────────────────────────────────────────────────────

  get status(): NetStatus {
    return this.status_;
  }
  get online(): boolean {
    return this.status_ === 'online';
  }
  get playerId(): string {
    return this.playerId_;
  }
  get rtt(): number {
    return this.clock.rtt;
  }
  get jitter(): number {
    return this.clock.jitter;
  }
  get tableId(): string | null {
    return this.tableId_;
  }

  state(): TableState | null {
    return this.state_;
  }
  youSeat(): number {
    return this.you_;
  }
  legalActions(): LegalAction[] {
    return this.legal_.slice();
  }
  lobby(): LobbyTable[] {
    return this.lobby_.slice();
  }

  onLobby(fn: (tables: LobbyTable[]) => void): () => void {
    this.lobbyListeners.add(fn);
    if (this.lobby_.length) fn(this.lobby_.slice());
    return () => this.lobbyListeners.delete(fn);
  }

  onStatus(fn: (s: NetStatus, detail?: string) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status_);
    return () => this.statusListeners.delete(fn);
  }

  // ─────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────────────

  /** Resolves on the first successful `welcome`, rejects if we give up. */
  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('client disposed'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const off = this.onStatus((s, detail) => {
        if (settled) return;
        if (s === 'online') {
          settled = true;
          off();
          resolve();
        } else if (s === 'failed' || s === 'closed') {
          settled = true;
          off();
          reject(new Error(detail ?? 'connection failed'));
        }
      });
      this.open();
    });
  }

  private open(): void {
    if (this.disposed || this.userClosed) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.opts.url);
    } catch (err) {
      this.scheduleRetry(err instanceof Error ? err.message : 'bad url');
      return;
    }
    this.ws = socket;

    const guard = setTimeout(() => {
      if (socket.readyState === 0) {
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      }
    }, this.opts.connectTimeoutMs ?? 6000);

    socket.onopen = () => {
      clearTimeout(guard);
      this.attempt = 0;
      this.send({
        t: 'hello',
        name: this.opts.name,
        avatarId: this.opts.avatarId,
        ...(this.opts.token ? { token: this.opts.token } : {}),
      });
      // Re-take our seat before replaying anything we buffered. `join` is
      // idempotent: a server that still holds the reserved seat hands it
      // straight back, and a server that restarted seats us fresh. Either way
      // it answers with a full snapshot, which is the resync.
      if (this.lastJoin) {
        this.send({ t: 'join', tableId: this.lastJoin.tableId, buyIn: this.lastJoin.buyIn, seat: this.lastJoin.seat });
        this.send({ t: 'resync' });
      }
      if (this.lobbySubscribed) this.send({ t: 'lobby', sub: true });
      this.flushQueue();
      this.startPing();
    };

    socket.onmessage = (ev: MessageEvent) => {
      const msg = decodeServer(ev.data);
      if (!msg) return;
      try {
        this.route(msg);
      } catch (err) {
        console.error('[net] message handler failed', msg.t, err);
      }
    };

    socket.onerror = () => {
      /* onclose always follows; the retry lives there */
    };

    socket.onclose = (ev: CloseEvent) => {
      clearTimeout(guard);
      this.stopPing();
      this.ws = null;
      this.predictor.clear();
      if (this.userClosed || this.disposed) {
        this.setStatus('closed');
        return;
      }
      this.scheduleRetry(ev.reason || `closed (${ev.code})`);
    };
  }

  /** Exponential backoff with ±30 % jitter, so a fleet does not stampede. */
  private scheduleRetry(detail: string): void {
    if (this.disposed || this.userClosed) return;
    const max = this.opts.maxRetries ?? Infinity;
    if (this.attempt >= max) {
      this.setStatus('failed', detail);
      return;
    }
    const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, this.attempt));
    const jitter = raw * (0.7 + Math.random() * 0.6);
    this.attempt++;
    this.setStatus('reconnecting', detail);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), Math.round(jitter));
  }

  private startPing(): void {
    this.stopPing();
    const beat = (): void => {
      const ts = Date.now();
      this.pendingPings.set(ts, ts);
      if (this.pendingPings.size > 8) {
        const oldest = this.pendingPings.keys().next().value;
        if (oldest !== undefined) this.pendingPings.delete(oldest);
      }
      this.sendNow({ t: 'ping', ts });
    };
    beat();
    this.pingTimer = setInterval(beat, PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pendingPings.clear();
  }

  private setStatus(next: NetStatus, detail?: string): void {
    if (this.status_ === next) return;
    this.status_ = next;
    for (const fn of Array.from(this.statusListeners)) {
      try {
        fn(next, detail);
      } catch (err) {
        console.error('[net] status listener failed', err);
      }
    }
  }

  /** Stop for good. Safe to call twice. */
  close(): void {
    this.userClosed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPing();
    if (this.joinWaiter) {
      clearTimeout(this.joinWaiter.timer);
      this.joinWaiter.resolve({ ok: false, seat: -1, buyIn: 0, reason: 'closed' });
      this.joinWaiter = null;
    }
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(encode({ t: 'bye' }));
      } catch {
        /* best effort */
      }
    }
    try {
      this.ws?.close(1000, 'client-close');
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.setStatus('closed');
  }

  dispose(): void {
    this.disposed = true;
    this.close();
    this.lobbyListeners.clear();
    this.statusListeners.clear();
    this.queue.length = 0;
    this.state_ = null;
    this.smoothing.reset();
    this.clock.reset();
  }

  // ─────────────────────────────────────────────────────────────────
  // Sending
  // ─────────────────────────────────────────────────────────────────

  /** Queues when offline; the queue survives a brief drop and replays in order. */
  send(msg: ClientPacket): void {
    if (this.ws && this.ws.readyState === 1) {
      this.sendNow(msg);
      return;
    }
    if (msg.t === 'ping') return;
    // An action for a hand that will be long gone is worse than no action.
    this.queue = this.queue.filter((m) => !(m.t === 'act' && msg.t === 'act'));
    this.queue.push(msg);
    if (this.queue.length > QUEUE_MAX) this.queue.shift();
  }

  private sendNow(msg: ClientPacket): void {
    try {
      this.ws?.send(encode(msg));
    } catch (err) {
      console.warn('[net] send failed', err);
    }
  }

  private flushQueue(): void {
    if (this.queue.length === 0) return;
    const pending = this.queue.slice();
    this.queue.length = 0;
    for (const msg of pending) {
      // Stale actions are dropped rather than replayed into the wrong hand.
      if (msg.t === 'act' && this.state_ && msg.handId !== this.state_.handId) continue;
      this.sendNow(msg);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Commands
  // ─────────────────────────────────────────────────────────────────

  joinTable(tableId: string, buyIn: number, seat?: number): Promise<JoinOutcome> {
    this.tableId_ = tableId;
    this.lastJoin = { tableId, buyIn, ...(seat === undefined ? {} : { seat }) };
    this.send({ t: 'join', tableId, buyIn, ...(seat === undefined ? {} : { seat }) });
    return this.awaitSeat();
  }

  quickSeat(req: {
    stakeId: TableState['stake']['id'];
    variant: TableState['variant'];
    format: TableState['format'];
    buyIn: number;
  }): Promise<JoinOutcome> {
    this.send({ t: 'quickseat', ...req });
    return this.awaitSeat();
  }

  private awaitSeat(): Promise<JoinOutcome> {
    if (this.joinWaiter) {
      clearTimeout(this.joinWaiter.timer);
      this.joinWaiter.resolve({ ok: false, seat: -1, buyIn: 0, reason: 'superseded' });
    }
    return new Promise<JoinOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.joinWaiter = null;
        resolve({ ok: false, seat: -1, buyIn: 0, reason: 'timed out' });
      }, REQUEST_TIMEOUT_MS);
      this.joinWaiter = { resolve, timer };
    });
  }

  private settleJoin(outcome: JoinOutcome): void {
    if (!this.joinWaiter) return;
    clearTimeout(this.joinWaiter.timer);
    const { resolve } = this.joinWaiter;
    this.joinWaiter = null;
    resolve(outcome);
  }

  leaveTable(): void {
    this.send({ t: 'leave' });
    this.tableId_ = null;
    this.lastJoin = null;
    this.you_ = -1;
    this.legal_ = [];
    this.predictor.clear();
  }

  /**
   * Submit the hero's action. Applied locally first — the button responds on
   * the frame it is pressed, not on the frame the packet comes home.
   */
  act(kind: ActionKind, amount = 0): boolean {
    const state = this.state_;
    if (!state || this.you_ < 0) return false;
    // The legal set is the authority on "is it my turn": the server ships it
    // only to the seat that must act, and clears it the moment we act.
    const legal = this.legal_;
    if (legal.length === 0 || this.turnHandId !== state.handId) return false;
    if (!legal.some((l) => l.kind === kind)) return false;

    const seq = ++this.actSeq;
    const predicted = this.predictor.predict(state, this.you_, kind, amount, legal, seq);
    if (!predicted) return false;
    this.state_ = predicted;
    this.legal_ = [];
    this.send({ t: 'act', kind, amount, handId: state.handId, seq });
    bus.emit('ui:haptic', { pattern: kind === 'fold' ? 'fold' : kind === 'check' ? 'tick' : 'bet' });
    return true;
  }

  sitOut(on: boolean): void {
    this.send({ t: 'sitout', on });
  }
  rebuy(amount: number): void {
    this.send({ t: 'rebuy', amount });
  }
  useTimeBank(): void {
    this.send({ t: 'timebank' });
  }
  chat(text: string): void {
    const clean = text.trim().slice(0, 160);
    if (clean) this.send({ t: 'chat', text: clean });
  }
  react(kind: ReactionKind, targetSeat: number): void {
    this.send({ t: 'react', kind, targetSeat });
  }
  subscribeLobby(on: boolean): void {
    this.lobbySubscribed = on;
    this.send({ t: 'lobby', sub: on });
  }
  resync(): void {
    this.send({ t: 'resync' });
  }

  // ─────────────────────────────────────────────────────────────────
  // Inbound routing → bus
  // ─────────────────────────────────────────────────────────────────

  private route(msg: ServerPacket): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId_ = msg.playerId;
        this.opts.token = msg.playerId;
        this.lobby_ = msg.tables;
        this.emitLobby();
        this.setStatus('online');
        return;

      case 'pong': {
        const sentAt = this.pendingPings.get(msg.ts) ?? msg.ts;
        this.pendingPings.delete(msg.ts);
        this.clock.notePong(sentAt);
        return;
      }

      case 'lobby':
        this.lobby_ = msg.tables;
        this.emitLobby();
        return;

      case 'seated':
        this.tableId_ = msg.tableId;
        this.you_ = msg.seat;
        this.lastJoin = {
          tableId: msg.tableId,
          buyIn: this.lastJoin?.buyIn ?? msg.buyIn,
          seat: msg.seat,
        };
        this.settleJoin({ ok: true, seat: msg.seat, buyIn: msg.buyIn });
        return;

      case 'waitlist':
        this.tableId_ = msg.tableId;
        this.settleJoin({ ok: false, seat: -1, buyIn: 0, waitlist: msg.position, reason: 'table full' });
        bus.emit('ui:toast', { text: `Waitlisted — #${msg.position}`, tone: 'info', ms: 2200 });
        return;

      case 'left':
        this.tableId_ = null;
        this.you_ = -1;
        this.state_ = null;
        this.legal_ = [];
        this.predictor.clear();
        this.smoothing.reset();
        return;

      case 'state': {
        this.you_ = msg.you;
        this.predictor.setChipStep(msg.state.format === 'sng' ? 1 : 0.01);
        const reconciled = this.predictor.reconcile(msg.state);
        this.publishState(reconciled, msg.state);
        return;
      }

      case 'delta': {
        if (!this.authoritative) {
          this.resync();
          return;
        }
        const next = applyPatch(this.authoritative, msg.patch as StatePatch);
        const reconciled = this.predictor.reconcile(next);
        this.publishState(reconciled, next);
        return;
      }

      case 'hand':
        if (msg.phase === 'start') {
          this.placeholders = [];
          this.predictor.clear();
          bus.emit('hand:start', { handId: msg.handId, buttonSeat: msg.buttonSeat });
          bus.emit('cam:focus', { seat: null, intensity: 0.2 });
        } else {
          this.legal_ = [];
          bus.emit('hand:end', { handId: msg.handId });
          bus.emit('cam:focus', { seat: null, intensity: 0.15 });
        }
        return;

      case 'hole': {
        const mine = msg.cards.length > 0;
        const card = mine ? msg.cards[0] : this.placeholderFor(msg.seat, msg.order);
        this.recordPlaceholder(msg.seat, card, mine);
        bus.emit('hand:deal-hole', { seat: msg.seat, cards: [card], faceUp: msg.faceUp, order: msg.order });
        return;
      }

      case 'deal':
        bus.emit('hand:deal-board', { street: msg.street, cards: msg.cards, boardIndex: 0 });
        bus.emit('ui:haptic', { pattern: 'deal' });
        return;

      case 'action': {
        const state = this.state_;
        if (state) {
          const seat = state.seats[msg.action.seat];
          if (seat) seat.lastAction = msg.action;
          bus.emit('hand:action', { action: msg.action, state });
        }
        if (msg.action.kind === 'allin') {
          bus.emit('fx:burst', { kind: 'allin', seat: msg.action.seat });
          bus.emit('cam:shake', { amount: 0.35, ms: 260 });
        }
        return;
      }

      case 'turn': {
        this.clock.noteServerTime(msg.serverTime);
        const ms = this.clock.remaining(msg.serverTime, msg.timeMs);
        this.turnHandId = msg.handId;
        this.legal_ = msg.seat === this.you_ ? msg.legal : [];
        // `turn` is the server telling us the action moved — believe it now
        // rather than waiting for the next tick's delta to say the same thing.
        // Without this the hero's first tap after their turn opens is refused
        // for up to a full tick, which reads as a dropped input.
        if (this.state_ && this.state_.handId === msg.handId && this.state_.actingSeat !== msg.seat) {
          this.state_.actingSeat = msg.seat;
          for (const s of this.state_.seats) s.isTurn = s.index === msg.seat;
        }
        bus.emit('hand:turn', { seat: msg.seat, timeMs: Math.round(ms), legal: this.legal_ });
        bus.emit('cam:focus', { seat: msg.seat, intensity: msg.seat === this.you_ ? 0.35 : 0.6 });
        if (msg.seat === this.you_) bus.emit('ui:haptic', { pattern: 'select' });
        return;
      }

      case 'pot':
        bus.emit('hand:pot-update', { pots: msg.pots, total: msg.total });
        return;

      case 'collect':
        bus.emit('hand:collect', { seats: msg.seats, total: msg.total });
        return;

      case 'award':
        bus.emit('hand:award', { seat: msg.seat, amount: msg.amount, potIndex: msg.potIndex });
        bus.emit('fx:burst', { kind: 'chips-win', seat: msg.seat });
        if (msg.seat === this.you_) {
          const bb = this.state_?.stake.bb ?? 1;
          const big = msg.amount > bb * 25;
          bus.emit('ui:haptic', { pattern: big ? 'big-win' : 'win' });
          if (big) bus.emit('fx:burst', { kind: 'confetti', seat: this.you_ });
        }
        return;

      case 'muck':
        bus.emit('hand:muck', { seat: msg.seat });
        return;

      case 'showdown':
        this.runShowdown(msg.results, msg.pots);
        return;

      case 'chat':
        bus.emit('social:chat', { fromSeat: msg.fromSeat, text: msg.text });
        return;

      case 'react':
        bus.emit('social:reaction', { kind: msg.kind, fromSeat: msg.fromSeat, targetSeat: msg.targetSeat });
        return;

      case 'reject':
        this.predictor.reject(msg.seq, msg.reason, this.authoritative);
        if (this.authoritative) this.legal_ = [];
        this.resync();
        return;

      case 'sys':
        bus.emit('ui:toast', { text: msg.text, tone: msg.tone, ms: 2200 });
        return;

      case 'error':
        this.settleJoin({ ok: false, seat: -1, buyIn: 0, reason: msg.message });
        bus.emit('ui:toast', { text: msg.message, tone: 'bad', ms: 2400 });
        return;

      default:
        return;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // State publication
  // ─────────────────────────────────────────────────────────────────

  /** The last state the server actually asserted, before prediction overlay. */
  private authoritative: TableState | null = null;

  private publishState(state: TableState, authoritative?: TableState): void {
    if (authoritative) this.authoritative = authoritative;
    this.state_ = state;
    this.smoothing.ingest(state);
    bus.emit('table:state', { state, you: this.you_ });
  }

  private emitLobby(): void {
    const copy = this.lobby_.slice();
    for (const fn of Array.from(this.lobbyListeners)) {
      try {
        fn(copy);
      } catch (err) {
        console.error('[net] lobby listener failed', err);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Hidden hole cards + showdown reveal
  // ─────────────────────────────────────────────────────────────────

  /**
   * A stable, meaningless face for a card we are not allowed to see. It is
   * never turned over: the reveal path below replaces it with the truth.
   */
  private placeholderFor(seat: number, order: number): CardId {
    const h = this.state_?.handId ?? 0;
    const mix = Math.imul(h * 2654435761 + seat * 40503 + order * 97, 0x9e3779b1) >>> 0;
    return mix % 52;
  }

  private recordPlaceholder(seat: number, card: CardId, real: boolean): void {
    if (!this.placeholders[seat]) this.placeholders[seat] = [];
    this.placeholders[seat].push(real ? -1 : card);
  }

  private runShowdown(results: ShowdownResult[], pots: Pot[]): void {
    const strategy = this.opts.refaceStrategy ?? 'redeal';
    const state = this.authoritative ?? this.state_;
    const needsReface: number[] = [];

    if (strategy === 'redeal' && state) {
      for (const r of results) {
        if (r.mucked || r.seat === this.you_) continue;
        const seat = state.seats[r.seat];
        if (!seat || seat.holeCards.length === 0) continue;
        const dealt = this.placeholders[r.seat] ?? [];
        const wasHidden = dealt.some((c) => c >= 0);
        if (wasHidden) needsReface.push(r.seat);
      }
    }

    if (needsReface.length === 0) {
      bus.emit('hand:showdown', { results, pots });
      return;
    }

    // Push the placeholders away, deal the truth face-down, then reveal.
    for (const seat of needsReface) {
      bus.emit('hand:muck', { seat });
    }
    for (const seat of needsReface) {
      const cards = state?.seats[seat]?.holeCards ?? [];
      cards.forEach((card, i) => {
        bus.emit('hand:deal-hole', { seat, cards: [card], faceUp: false, order: i });
      });
      this.placeholders[seat] = cards.map(() => -1);
    }
    setTimeout(() => bus.emit('hand:showdown', { results, pots }), REVEAL_SETTLE_MS);
  }
}

function rollbackText(reason: string): string {
  if (reason.startsWith('illegal')) return 'That bet was not legal';
  if (reason === 'not-your-turn') return 'Too slow — the action moved on';
  if (reason === 'stale-hand') return 'That hand is over';
  if (reason === 'timed-out') return 'Connection hiccup — resynced';
  return 'Action rejected';
}

export type { Action, LegalAction, TableState };
