/**
 * ROYALE — live lobby.
 *
 * The lobby is a *feed*, not a page load: seat counts, average pots and bomb-pot
 * countdowns move while you are looking at them. This module owns that feed and
 * hides where it comes from.
 *
 *   · online  — the server pushes `{t:'lobby'}` every few seconds
 *   · offline — an identical-looking population model runs locally, seeded so
 *               the same table is always the same table, and drifting on a
 *               slow sine so the list breathes instead of freezing
 *
 * Both expose `LobbySource`, so the lobby screen never branches on transport.
 */

import { LOBBY_STAKES, STAKES } from '../core/stakes.ts';
import type { GameVariant, LobbyTable, StakeId, TableFormat } from '../core/types.ts';
import { Rng } from '../core/rng.ts';
import type { NetClient } from './client.ts';

const VARIANTS: readonly GameVariant[] = ['nlhe', 'plo4'];
const FORMATS: readonly TableFormat[] = ['cash', 'sng', 'bomb'];
const SEATS_TOTAL = 6;

/** Must mirror `server/tables.ts` — the two lobbies have to agree on ids. */
const ROOMS: Record<TableFormat, number> = { cash: 2, sng: 1, bomb: 1 };

/** `cash-nlhe-nl10`, `cash-nlhe-nl10-b`, … */
export function roomId(format: TableFormat, variant: GameVariant, stakeId: StakeId, n: number): string {
  return n === 0 ? `${format}-${variant}-${stakeId}` : `${format}-${variant}-${stakeId}-${String.fromCharCode(98 + n - 1)}`;
}

export interface QuickSeatRequest {
  stakeId: StakeId;
  variant: GameVariant;
  format: TableFormat;
  /** absolute chips; clamped to the stake's buy-in band */
  buyIn?: number;
}

export interface QuickSeatResult {
  ok: boolean;
  tableId: string | null;
  seat: number;
  buyIn: number;
  reason?: string;
  waitlist?: number;
}

export interface LobbyFilter {
  variant?: GameVariant;
  format?: TableFormat;
  stakeId?: StakeId;
  /** only tables with at least this many players seated */
  minSeats?: number;
  /** only tables with a free seat */
  openOnly?: boolean;
}

export interface LobbySource {
  readonly live: boolean;
  tables(filter?: LobbyFilter): LobbyTable[];
  subscribe(fn: (tables: LobbyTable[]) => void): () => void;
  refresh(): void;
  quickSeat(req: QuickSeatRequest): Promise<QuickSeatResult>;
  dispose(): void;
}

// ═══════════════════════════════════════════════════════════════════
// Shared ranking
// ═══════════════════════════════════════════════════════════════════

/**
 * How good is this table for a player who asked for `req`? The sweet spot is
 * a table with company and a seat: four of six is better than six of six
 * (nowhere to sit) and better than one of six (no game).
 */
export function scoreTable(t: LobbyTable, req: QuickSeatRequest): number {
  if (t.variant !== req.variant || t.format !== req.format) return -Infinity;
  const wantIdx = LOBBY_STAKES.indexOf(req.stakeId);
  const haveIdx = LOBBY_STAKES.indexOf(t.stakeId);
  const stakeDelta = wantIdx < 0 || haveIdx < 0 ? 3 : Math.abs(wantIdx - haveIdx);

  let score = 100 - stakeDelta * 34;
  const open = t.seatsTotal - t.seatsTaken;
  score += open >= 1 ? 18 : -70;
  score += t.seatsTaken >= 2 ? 14 : -8;
  score += t.seatsTaken >= 3 && open >= 1 ? 12 : 0;
  score += t.looseness * 16;
  const bb = STAKES[t.stakeId]?.bb ?? 1;
  score += Math.min(10, (t.avgPot / bb) * 0.35);
  if (t.bombPotIn !== null && t.bombPotIn <= 2) score += 6;
  return score;
}

export function bestTable(tables: readonly LobbyTable[], req: QuickSeatRequest): LobbyTable | null {
  let best: LobbyTable | null = null;
  let bestScore = -Infinity;
  for (const t of tables) {
    const s = scoreTable(t, req);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return bestScore === -Infinity ? null : best;
}

export function applyFilter(tables: readonly LobbyTable[], f?: LobbyFilter): LobbyTable[] {
  if (!f) return tables.slice();
  return tables.filter((t) => {
    if (f.variant && t.variant !== f.variant) return false;
    if (f.format && t.format !== f.format) return false;
    if (f.stakeId && t.stakeId !== f.stakeId) return false;
    if (f.minSeats !== undefined && t.seatsTaken < f.minSeats) return false;
    if (f.openOnly && t.seatsTaken >= t.seatsTotal) return false;
    return true;
  });
}

/** Default buy-in: 100 big blinds, clamped into the stake's band. */
export function defaultBuyIn(stakeId: StakeId): number {
  const stake = STAKES[stakeId];
  if (!stake) return 10;
  return Math.min(stake.maxBuyIn, Math.max(stake.minBuyIn, Math.round(stake.bb * 100 * 100) / 100));
}

// ═══════════════════════════════════════════════════════════════════
// Online
// ═══════════════════════════════════════════════════════════════════

class NetLobby implements LobbySource {
  readonly live = true;
  private client: NetClient;
  private listeners = new Set<(t: LobbyTable[]) => void>();
  private off: (() => void) | null = null;
  private cache: LobbyTable[] = [];

  constructor(client: NetClient) {
    this.client = client;
    this.cache = client.lobby();
    this.off = client.onLobby((tables) => {
      this.cache = tables;
      this.publish();
    });
    client.subscribeLobby(true);
  }

  tables(filter?: LobbyFilter): LobbyTable[] {
    return applyFilter(this.cache, filter);
  }

  subscribe(fn: (t: LobbyTable[]) => void): () => void {
    this.listeners.add(fn);
    if (this.cache.length) fn(this.cache.slice());
    return () => this.listeners.delete(fn);
  }

  refresh(): void {
    this.client.subscribeLobby(true);
  }

  async quickSeat(req: QuickSeatRequest): Promise<QuickSeatResult> {
    const buyIn = req.buyIn ?? defaultBuyIn(req.stakeId);
    const outcome = await this.client.quickSeat({
      stakeId: req.stakeId,
      variant: req.variant,
      format: req.format,
      buyIn,
    });
    return {
      ok: outcome.ok,
      tableId: this.client.tableId,
      seat: outcome.seat,
      buyIn: outcome.buyIn,
      reason: outcome.reason,
      waitlist: outcome.waitlist,
    };
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    this.listeners.clear();
    this.client.subscribeLobby(false);
  }

  private publish(): void {
    const copy = this.cache.slice();
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(copy);
      } catch (err) {
        console.error('[lobby] listener failed', err);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Offline
// ═══════════════════════════════════════════════════════════════════

interface Synthetic {
  table: LobbyTable;
  phase: number;
  popularity: number;
}

/**
 * The offline lobby. Deliberately not random noise: each table gets a fixed
 * personality (popularity, looseness) from a seeded RNG, then a two-harmonic
 * sine drives its population so numbers move at a believable pace — a table
 * fills over a couple of minutes, it does not teleport from 2 to 6.
 */
class LocalLobby implements LobbySource {
  readonly live = false;
  private rows: Synthetic[] = [];
  private listeners = new Set<(t: LobbyTable[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private handsPlayed = new Map<string, number>();
  private intervalMs: number;

  constructor(seed = 0x0ff5eed1, intervalMs = 2600) {
    this.intervalMs = intervalMs;
    const rng = new Rng(seed >>> 0);
    for (const stakeId of LOBBY_STAKES) {
      for (const variant of VARIANTS) {
        for (const format of FORMATS) {
          for (let copy = 0; copy < ROOMS[format]; copy++) {
            const looseness = Math.round((0.28 + rng.next() * 0.58) * 100) / 100;
            const popularity =
              (stakeId === 'nl10' || stakeId === 'nl20' ? 1 : stakeId === 'nl50' || stakeId === 'nl100' ? 0.82 : 0.55) *
              (variant === 'nlhe' ? 1 : 0.62) *
              (format === 'cash' ? 1 : format === 'bomb' ? 0.7 : 0.55) *
              (copy === 0 ? 1 : 0.7);
            this.rows.push({
              phase: rng.next() * Math.PI * 2,
              popularity,
              table: {
                id: roomId(format, variant, stakeId, copy),
                variant,
                format,
                stakeId,
                seatsTaken: 0,
                seatsTotal: SEATS_TOTAL,
                avgPot: 0,
                handsPerHour: 0,
                looseness,
                bombPotIn: format === 'bomb' ? 0 : 4 + rng.int(12),
              },
            });
          }
        }
      }
    }
    this.recompute(Date.now());
    this.timer = setInterval(() => {
      this.recompute(Date.now());
      this.publish();
    }, this.intervalMs);
  }

  private recompute(now: number): void {
    for (const row of this.rows) {
      const t = now / 60000 + row.phase;
      const wave = (Math.sin(t * 0.37) + Math.sin(t * 0.11 + 1.7)) * 0.25 + 0.5;
      const stake = STAKES[row.table.stakeId];
      const seats = Math.max(0, Math.min(SEATS_TOTAL, Math.round(wave * SEATS_TOTAL * row.popularity + 0.6)));
      row.table.seatsTaken = seats;
      if (seats < 2) {
        row.table.avgPot = 0;
        row.table.handsPerHour = 0;
      } else {
        row.table.avgPot =
          Math.round(stake.bb * (11 + wave * 16) * (row.table.variant === 'plo4' ? 1.7 : 1) * 100) / 100;
        row.table.handsPerHour = Math.round(62 + wave * 34);
      }
      if (row.table.format !== 'bomb' && row.table.bombPotIn !== null) {
        // count the bomb-pot timer down on the same cadence the server would
        const played = (this.handsPlayed.get(row.table.id) ?? 0) + (seats >= 2 ? 1 : 0);
        this.handsPlayed.set(row.table.id, played);
        const period = 14;
        row.table.bombPotIn = period - (played % period);
      }
    }
  }

  tables(filter?: LobbyFilter): LobbyTable[] {
    return applyFilter(
      this.rows.map((r) => ({ ...r.table })),
      filter,
    );
  }

  subscribe(fn: (t: LobbyTable[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.tables());
    return () => this.listeners.delete(fn);
  }

  refresh(): void {
    this.recompute(Date.now());
    this.publish();
  }

  async quickSeat(req: QuickSeatRequest): Promise<QuickSeatResult> {
    const best = bestTable(this.tables(), req);
    if (!best) return { ok: false, tableId: null, seat: -1, buyIn: 0, reason: 'no table available' };
    return {
      ok: true,
      tableId: best.id,
      seat: 0,
      buyIn: req.buyIn ?? defaultBuyIn(best.stakeId),
    };
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private publish(): void {
    const snapshot = this.tables();
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(snapshot);
      } catch (err) {
        console.error('[lobby] listener failed', err);
      }
    }
  }
}

/**
 * One lobby, whichever transport is live. Pass the connected client to get
 * server data; pass `null` for the static-deploy path.
 */
export function createLobby(client: NetClient | null, seed = 0x0ff5eed1): LobbySource {
  return client && client.online ? new NetLobby(client) : new LocalLobby(seed);
}
