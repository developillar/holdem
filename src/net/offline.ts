/**
 * ROYALE — one session API, two transports.
 *
 * The app ships as a static bundle. Most of the time there is no server to
 * talk to, and the product must still be a complete poker game — so the
 * default path is the local engine, and the live server is an *upgrade* that
 * takes over silently when it happens to be reachable.
 *
 * `getSession()` is the only thing the UI calls. Behind it:
 *
 *   NetSession   — a real socket, an authoritative table, other humans
 *   LocalSession — `src/engine/table.ts` driving bots in-process
 *
 * Both emit the identical bus events, so screens, renderer, audio and FX are
 * transport-agnostic by construction. The façade can swap its implementation
 * underneath — a server that appears is adopted between hands, a server that
 * dies is abandoned mid-hand into a fresh local table — and the only visible
 * consequence is the connection badge changing.
 */

import { bus } from '../core/bus.ts';
import type { LegalAction } from '../core/bus.ts';
import { STAKES } from '../core/stakes.ts';
import type {
  ActionKind,
  GameVariant,
  ReactionKind,
  StakeId,
  TableFormat,
  TableState,
} from '../core/types.ts';

import { NetClient } from './client.ts';
import type { NetStatus } from './client.ts';
import { createLobby, defaultBuyIn } from './lobby.ts';
import type { LobbySource, QuickSeatRequest, QuickSeatResult } from './lobby.ts';
import { createLocalTable, engineError } from './engineAdapter.ts';
import type { LocalTableHandle } from './engineAdapter.ts';

export type SessionMode = 'net' | 'local';
export type SessionStatus = NetStatus | 'local';

export interface JoinOptions {
  tableId?: string;
  variant?: GameVariant;
  format?: TableFormat;
  stakeId?: StakeId;
  buyIn?: number;
  seat?: number;
  /** local only: table speed multiplier */
  pace?: number;
}

export interface SeatOutcome {
  ok: boolean;
  tableId: string | null;
  seat: number;
  buyIn: number;
  waitlist?: number;
  reason?: string;
}

export interface Session {
  readonly mode: SessionMode;
  readonly status: SessionStatus;
  readonly lobby: LobbySource;
  /** round-trip time in ms; 0 offline */
  readonly rtt: number;
  readonly playerId: string;

  state(): TableState | null;
  youSeat(): number;
  legalActions(): LegalAction[];

  join(opts: JoinOptions): Promise<SeatOutcome>;
  quickSeat(req: QuickSeatRequest): Promise<SeatOutcome>;
  leave(): void;

  act(kind: ActionKind, amount?: number): boolean;
  sitOut(on: boolean): void;
  rebuy(amount: number): boolean;
  useTimeBank(): void;
  chat(text: string): void;
  react(kind: ReactionKind, targetSeat: number): void;
  setPace(p: number): void;

  onStatus(fn: (status: SessionStatus, mode: SessionMode) => void): () => void;
  dispose(): void;
}

export interface SessionOptions {
  /** explicit websocket url; `null` disables the network entirely */
  url?: string | null;
  name?: string;
  avatarId?: string;
  token?: string | null;
  /** how long to wait for the server before falling back (ms) */
  probeMs?: number;
  /** never attempt a socket — used by tests and the static demo */
  forceLocal?: boolean;
  /** keep probing for a server while playing locally */
  autoUpgrade?: boolean;
}

const UPGRADE_INTERVAL_MS = 30_000;
const TOKEN_KEY = 'royale.playerToken';

// ═══════════════════════════════════════════════════════════════════
// Endpoint discovery
// ═══════════════════════════════════════════════════════════════════

/**
 * Where is the server? In order: an explicit option, a global injected by the
 * host page, a `?ws=` query override, then the dev-server convention
 * (`ws://<host>:8787/ws`) when we are on localhost. A production static host
 * gets `null` — no server, no failed connection, no console noise.
 */
export function resolveEndpoint(explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit;

  const g = globalThis as { __ROYALE_WS__?: string; location?: Location };
  if (typeof g.__ROYALE_WS__ === 'string' && g.__ROYALE_WS__) return g.__ROYALE_WS__;

  const loc = g.location;
  if (!loc || !loc.protocol) return null;

  try {
    const qs = new URLSearchParams(loc.search ?? '');
    const override = qs.get('ws');
    if (override) return override;
  } catch {
    /* no search params available */
  }

  const host = loc.hostname ?? '';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local');
  if (!isLocal) return null;
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${host}:8787/ws`;
}

function readToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}
function writeToken(token: string): void {
  try {
    globalThis.localStorage?.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode; a fresh identity each load is acceptable */
  }
}

// ═══════════════════════════════════════════════════════════════════
// Local session
// ═══════════════════════════════════════════════════════════════════

class LocalSession {
  readonly mode: SessionMode = 'local';
  readonly status: SessionStatus = 'local';
  readonly rtt = 0;
  readonly playerId = 'local-hero';
  lobby: LobbySource;

  private table: LocalTableHandle | null = null;
  private opts: SessionOptions;
  private pace = 1;

  constructor(opts: SessionOptions, lobby: LobbySource) {
    this.opts = opts;
    this.lobby = lobby;
  }

  state(): TableState | null {
    if (!this.table) return null;
    try {
      return this.table.state();
    } catch {
      return null;
    }
  }

  youSeat(): number {
    return this.table ? this.table.heroSeat : -1;
  }

  legalActions(): LegalAction[] {
    if (!this.table) return [];
    try {
      return this.table.legalActions();
    } catch {
      return [];
    }
  }

  async join(opts: JoinOptions): Promise<SeatOutcome> {
    this.destroyTable();
    const parsed = parseTableId(opts.tableId);
    const stakeId = opts.stakeId ?? parsed?.stakeId ?? 'nl10';
    const variant = opts.variant ?? parsed?.variant ?? 'nlhe';
    const format = opts.format ?? parsed?.format ?? 'cash';
    const buyIn = clampBuyIn(stakeId, opts.buyIn ?? defaultBuyIn(stakeId));

    const table = await createLocalTable({
      id: opts.tableId ?? `${format}-${variant}-${stakeId}`,
      variant,
      format,
      stakeId,
      seatCount: 6,
      heroSeat: 0,
      heroBuyIn: buyIn,
      hero: { name: this.opts.name ?? 'You', avatarId: this.opts.avatarId ?? 'av-01' },
      pace: opts.pace ?? this.pace,
      autoRebuy: true,
      continuous: true,
    });

    if (!table) {
      const reason = engineError() ?? 'local engine unavailable';
      bus.emit('ui:toast', { text: 'Table unavailable', tone: 'bad', ms: 2400 });
      return { ok: false, tableId: null, seat: -1, buyIn: 0, reason };
    }

    this.table = table;
    table.start();
    return { ok: true, tableId: table.id, seat: table.heroSeat, buyIn };
  }

  async quickSeat(req: QuickSeatRequest): Promise<SeatOutcome> {
    const pick = await this.lobby.quickSeat(req);
    if (!pick.ok || !pick.tableId) {
      return { ok: false, tableId: null, seat: -1, buyIn: 0, reason: pick.reason ?? 'no table' };
    }
    return this.join({
      tableId: pick.tableId,
      stakeId: req.stakeId,
      variant: req.variant,
      format: req.format,
      buyIn: pick.buyIn,
    });
  }

  leave(): void {
    this.destroyTable();
  }

  act(kind: ActionKind, amount = 0): boolean {
    if (!this.table) return false;
    try {
      return this.table.act(kind, amount);
    } catch {
      return false;
    }
  }

  sitOut(on: boolean): void {
    this.table?.sitOut(on);
  }

  rebuy(amount: number): boolean {
    return this.table ? this.table.rebuy(amount) : false;
  }

  useTimeBank(): void {
    // The local table gives the hero a generous fixed clock; there is nothing
    // to extend, and silently doing nothing is the correct behaviour.
  }

  chat(text: string): void {
    bus.emit('social:chat', { fromSeat: this.youSeat(), text });
  }

  react(kind: ReactionKind, targetSeat: number): void {
    bus.emit('social:reaction', { kind, fromSeat: this.youSeat(), targetSeat });
  }

  setPace(p: number): void {
    this.pace = Math.max(0.25, Math.min(4, p));
    this.table?.setPace(this.pace);
  }

  dispose(): void {
    this.destroyTable();
    this.lobby.dispose();
  }

  private destroyTable(): void {
    if (!this.table) return;
    try {
      this.table.destroy();
    } catch {
      /* engine already torn down */
    }
    this.table = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Net session
// ═══════════════════════════════════════════════════════════════════

class NetSession {
  readonly mode: SessionMode = 'net';
  lobby: LobbySource;
  private client: NetClient;

  constructor(client: NetClient) {
    this.client = client;
    this.lobby = createLobby(client);
  }

  get status(): SessionStatus {
    return this.client.status;
  }
  get rtt(): number {
    return this.client.rtt;
  }
  get playerId(): string {
    return this.client.playerId;
  }

  state(): TableState | null {
    return this.client.state();
  }
  youSeat(): number {
    return this.client.youSeat();
  }
  legalActions(): LegalAction[] {
    return this.client.legalActions();
  }

  async join(opts: JoinOptions): Promise<SeatOutcome> {
    const parsed = parseTableId(opts.tableId);
    const stakeId = opts.stakeId ?? parsed?.stakeId ?? 'nl10';
    const tableId = opts.tableId ?? `${opts.format ?? 'cash'}-${opts.variant ?? 'nlhe'}-${stakeId}`;
    const buyIn = clampBuyIn(stakeId, opts.buyIn ?? defaultBuyIn(stakeId));
    const out = await this.client.joinTable(tableId, buyIn, opts.seat);
    return {
      ok: out.ok,
      tableId: this.client.tableId,
      seat: out.seat,
      buyIn: out.buyIn,
      waitlist: out.waitlist,
      reason: out.reason,
    };
  }

  async quickSeat(req: QuickSeatRequest): Promise<SeatOutcome> {
    const out = await this.lobby.quickSeat(req);
    return {
      ok: out.ok,
      tableId: out.tableId,
      seat: out.seat,
      buyIn: out.buyIn,
      waitlist: out.waitlist,
      reason: out.reason,
    };
  }

  leave(): void {
    this.client.leaveTable();
  }
  act(kind: ActionKind, amount = 0): boolean {
    return this.client.act(kind, amount);
  }
  sitOut(on: boolean): void {
    this.client.sitOut(on);
  }
  rebuy(amount: number): boolean {
    this.client.rebuy(amount);
    return true;
  }
  useTimeBank(): void {
    this.client.useTimeBank();
  }
  chat(text: string): void {
    this.client.chat(text);
  }
  react(kind: ReactionKind, targetSeat: number): void {
    this.client.react(kind, targetSeat);
  }
  setPace(): void {
    // Pacing is server-authoritative online; a client cannot speed up a table
    // other people are sitting at.
  }
  dispose(): void {
    this.lobby.dispose();
    this.client.dispose();
  }
}

type Impl = LocalSession | NetSession;

// ═══════════════════════════════════════════════════════════════════
// Façade
// ═══════════════════════════════════════════════════════════════════

class RoyaleSession implements Session {
  private impl: Impl;
  private opts: SessionOptions;
  private listeners = new Set<(s: SessionStatus, m: SessionMode) => void>();
  private offStatus: (() => void) | null = null;
  private upgradeTimer: ReturnType<typeof setInterval> | null = null;
  private seated = false;
  private disposed = false;

  constructor(impl: Impl, opts: SessionOptions) {
    this.impl = impl;
    this.opts = opts;
    this.bindImpl();
    if (opts.autoUpgrade !== false && impl.mode === 'local' && resolveEndpoint(opts.url) !== null) {
      this.upgradeTimer = setInterval(() => void this.tryUpgrade(), UPGRADE_INTERVAL_MS);
    }
  }

  get mode(): SessionMode {
    return this.impl.mode;
  }
  get status(): SessionStatus {
    return this.impl.status;
  }
  get lobby(): LobbySource {
    return this.impl.lobby;
  }
  get rtt(): number {
    return this.impl.rtt;
  }
  get playerId(): string {
    return this.impl.playerId;
  }

  state(): TableState | null {
    return this.impl.state();
  }
  youSeat(): number {
    return this.impl.youSeat();
  }
  legalActions(): LegalAction[] {
    return this.impl.legalActions();
  }

  async join(opts: JoinOptions): Promise<SeatOutcome> {
    const out = await this.impl.join(opts);
    this.seated = out.ok;
    return out;
  }

  async quickSeat(req: QuickSeatRequest): Promise<SeatOutcome> {
    const out = await this.impl.quickSeat(req);
    this.seated = out.ok;
    return out;
  }

  leave(): void {
    this.seated = false;
    this.impl.leave();
  }

  act(kind: ActionKind, amount = 0): boolean {
    return this.impl.act(kind, amount);
  }
  sitOut(on: boolean): void {
    this.impl.sitOut(on);
  }
  rebuy(amount: number): boolean {
    return this.impl.rebuy(amount);
  }
  useTimeBank(): void {
    this.impl.useTimeBank();
  }
  chat(text: string): void {
    this.impl.chat(text);
  }
  react(kind: ReactionKind, targetSeat: number): void {
    this.impl.react(kind, targetSeat);
  }
  setPace(p: number): void {
    this.impl.setPace(p);
  }

  onStatus(fn: (status: SessionStatus, mode: SessionMode) => void): () => void {
    this.listeners.add(fn);
    fn(this.status, this.mode);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    if (this.upgradeTimer !== null) clearInterval(this.upgradeTimer);
    this.upgradeTimer = null;
    this.offStatus?.();
    this.offStatus = null;
    this.impl.dispose();
    this.listeners.clear();
    if (active === this) active = null;
  }

  // ── transport swapping ───────────────────────────────────────────

  private bindImpl(): void {
    this.offStatus?.();
    this.offStatus = null;
    if (this.impl instanceof NetSession) {
      const client = (this.impl as unknown as { client: NetClient }).client;
      this.offStatus = client.onStatus((s) => {
        this.emit(s);
        if (s === 'failed') void this.downgrade('server unreachable');
      });
    } else {
      this.emit('local');
    }
  }

  private emit(status: SessionStatus): void {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(status, this.mode);
      } catch (err) {
        console.error('[session] status listener failed', err);
      }
    }
  }

  /** A server appeared. Adopt it — but never in the middle of a hand. */
  private async tryUpgrade(): Promise<void> {
    if (this.disposed || this.impl.mode === 'net' || this.seated) return;
    const url = resolveEndpoint(this.opts.url);
    if (!url) return;
    const client = await probe(url, this.opts, 2000);
    if (!client) return;
    if (this.disposed || this.seated) {
      client.dispose();
      return;
    }
    const old = this.impl;
    this.impl = new NetSession(client);
    old.dispose();
    if (this.upgradeTimer !== null) clearInterval(this.upgradeTimer);
    this.upgradeTimer = null;
    this.bindImpl();
    bus.emit('ui:toast', { text: 'Live tables connected', tone: 'good', ms: 1800 });
  }

  /** The server died. Fall back so the player keeps playing. */
  private async downgrade(reason: string): Promise<void> {
    if (this.disposed || this.impl.mode === 'local') return;
    const old = this.impl;
    this.impl = new LocalSession(this.opts, createLobby(null));
    old.dispose();
    this.seated = false;
    this.bindImpl();
    bus.emit('ui:toast', { text: 'Playing offline', tone: 'info', ms: 2000 });
    console.info('[session] downgraded to local:', reason);
    if (this.opts.autoUpgrade !== false && this.upgradeTimer === null) {
      this.upgradeTimer = setInterval(() => void this.tryUpgrade(), UPGRADE_INTERVAL_MS);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════

let active: RoyaleSession | null = null;
let pending: Promise<Session> | null = null;

/**
 * The one call the UI makes. Returns immediately-usable session — connected
 * if a server answered inside `probeMs`, local otherwise.
 */
export function getSession(opts: SessionOptions = {}): Promise<Session> {
  if (active) return Promise.resolve(active);
  if (pending) return pending;
  pending = build(opts).then((s) => {
    active = s;
    pending = null;
    return s;
  });
  return pending;
}

/** Synchronous accessor for code that knows the session already exists. */
export function currentSession(): Session | null {
  return active;
}

/** Tear the singleton down — used on hot reload and by tests. */
export function resetSession(): void {
  active?.dispose();
  active = null;
  pending = null;
}

async function build(opts: SessionOptions): Promise<RoyaleSession> {
  const merged: SessionOptions = {
    name: 'You',
    avatarId: 'av-01',
    probeMs: 2500,
    ...opts,
    token: opts.token ?? readToken(),
  };

  const url = merged.forceLocal ? null : resolveEndpoint(merged.url);
  if (url) {
    const client = await probe(url, merged, merged.probeMs ?? 2500);
    if (client) return new RoyaleSession(new NetSession(client), merged);
  }
  return new RoyaleSession(new LocalSession(merged, createLobby(null)), merged);
}

/** Try to connect within `timeoutMs`. Never throws; returns `null` on failure. */
async function probe(url: string, opts: SessionOptions, timeoutMs: number): Promise<NetClient | null> {
  if (typeof WebSocket === 'undefined') return null;
  const client = new NetClient({
    url,
    name: opts.name ?? 'You',
    avatarId: opts.avatarId ?? 'av-01',
    token: opts.token ?? null,
    // During the probe a single failure is enough — we do not want a static
    // deploy retrying forever against a server that does not exist.
    maxRetries: 0,
    connectTimeoutMs: timeoutMs,
  });

  const connected = await Promise.race([
    client.connect().then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);

  if (!connected || !client.online) {
    client.dispose();
    return null;
  }
  if (client.playerId) writeToken(client.playerId);
  // Now that we are in, allow the resilient reconnect policy.
  (client as unknown as { opts: { maxRetries?: number } }).opts.maxRetries = Infinity;
  return client;
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

const FORMATS: readonly TableFormat[] = ['cash', 'sng', 'bomb'];
const VARIANTS: readonly GameVariant[] = ['nlhe', 'plo4'];

/** Table ids are `format-variant-stake`, which the lobby and both sessions share. */
export function parseTableId(
  id: string | undefined,
): { format: TableFormat; variant: GameVariant; stakeId: StakeId } | null {
  if (!id) return null;
  const parts = id.split('-');
  if (parts.length < 3) return null;
  const [format, variant, stakeId] = parts;
  if (!FORMATS.includes(format as TableFormat)) return null;
  if (!VARIANTS.includes(variant as GameVariant)) return null;
  if (!(stakeId in STAKES)) return null;
  return { format: format as TableFormat, variant: variant as GameVariant, stakeId: stakeId as StakeId };
}

function clampBuyIn(stakeId: StakeId, amount: number): number {
  const stake = STAKES[stakeId];
  if (!stake) return amount;
  if (!Number.isFinite(amount)) return stake.bb * 100;
  return Math.min(stake.maxBuyIn, Math.max(stake.minBuyIn, amount));
}
