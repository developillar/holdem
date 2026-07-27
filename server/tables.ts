/**
 * ROYALE — table registry.
 *
 * Owns every `Room` in the process, drives their heartbeat from a single
 * interval, publishes the lobby, and does matchmaking.
 *
 * A note on scale: the lobby advertises six stakes × two variants × three
 * formats = 36 tables. Running 36 live poker games on an idle server would
 * be absurd, so a room with no humans keeps its bot floor at zero and stays
 * dormant. Its lobby row is still *alive* — seat counts and average pots
 * come from a seeded, slowly-drifting population model, so the lobby breathes
 * the way a real one does. The moment a human sits, the room wakes, backfills
 * real AI opponents and the numbers become measurements instead of estimates.
 */

import { LOBBY_STAKES, STAKES } from '../src/core/stakes.ts';
import type { GameVariant, LobbyTable, StakeId, TableFormat } from '../src/core/types.ts';
import { Rng } from '../src/core/rng.ts';

import { Room } from './room.ts';
import type { JoinResult, RoomClient, RoomConfig } from './room.ts';
import type { Logger } from './log.ts';
import { loadEngineBots } from './bots.ts';

const VARIANTS: readonly GameVariant[] = ['nlhe', 'plo4'];
const FORMATS: readonly TableFormat[] = ['cash', 'sng', 'bomb'];

/** Seats per format. SNGs are six-max; cash runs six-max at every stake. */
const SEAT_COUNT: Record<TableFormat, number> = { cash: 6, sng: 6, bomb: 6 };

/** How many AI opponents a woken room keeps seated. */
const BOT_FLOOR: Record<TableFormat, number> = { cash: 5, sng: 6, bomb: 5 };

/**
 * Rooms per (stake × variant). Cash gets two so quick-seat has a real choice
 * and a full table is never a dead end; the scheduled formats get one each.
 */
const ROOMS: Record<TableFormat, number> = { cash: 2, sng: 1, bomb: 1 };

/** `cash-nlhe-nl10`, `cash-nlhe-nl10-b`, … — parseable by the client. */
function roomId(format: TableFormat, variant: GameVariant, stakeId: StakeId, n: number): string {
  return n === 0 ? `${format}-${variant}-${stakeId}` : `${format}-${variant}-${stakeId}-${String.fromCharCode(98 + n - 1)}`;
}

export interface RegistryOptions {
  log: Logger;
  seed?: number;
  /** room heartbeat, ms */
  tickMs?: number;
  /** lobby push interval, ms */
  lobbyMs?: number;
}

interface Entry {
  room: Room;
  variant: GameVariant;
  format: TableFormat;
  stakeId: StakeId;
  /** deterministic phase offset so synthetic populations don't move in lockstep */
  phase: number;
  popularity: number;
  looseness: number;
}

export class TableRegistry {
  private entries = new Map<string, Entry>();
  private log: Logger;
  private tickMs: number;
  private lobbyMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lobbyTimer: ReturnType<typeof setInterval> | null = null;
  private subscribers = new Set<string>();
  private clients = new Map<string, RoomClient>();
  /** clientId → tableId */
  private location = new Map<string, string>();
  private lobbyCache: LobbyTable[] = [];
  private lobbyCacheAt = 0;

  constructor(opts: RegistryOptions) {
    this.log = opts.log.child({ mod: 'registry' });
    this.tickMs = opts.tickMs ?? 100;
    this.lobbyMs = opts.lobbyMs ?? 3000;
    const seed = (opts.seed ?? 0x1234abcd) >>> 0;
    const rng = new Rng(seed);

    let n = 0;
    for (const stakeId of LOBBY_STAKES) {
      for (const variant of VARIANTS) {
        for (const format of FORMATS) {
          for (let copy = 0; copy < ROOMS[format]; copy++) {
            const id = roomId(format, variant, stakeId, copy);
            const looseness = Math.round((0.28 + rng.next() * 0.58) * 100) / 100;
            const cfg: RoomConfig = {
              id,
              variant,
              format,
              stakeId,
              seatCount: SEAT_COUNT[format],
              looseness,
              botFloor: 0,
              seed: (seed ^ (n * 0x9e3779b1)) >>> 0,
              log: this.log,
            };
            this.entries.set(id, {
              room: new Room(cfg),
              variant,
              format,
              stakeId,
              phase: rng.next() * Math.PI * 2,
              // micro stakes and NLHE cash draw the biggest crowds
              popularity:
                (stakeId === 'nl10' || stakeId === 'nl20' ? 1 : stakeId === 'nl50' || stakeId === 'nl100' ? 0.82 : 0.55) *
                (variant === 'nlhe' ? 1 : 0.62) *
                (format === 'cash' ? 1 : format === 'bomb' ? 0.7 : 0.55) *
                (copy === 0 ? 1 : 0.7),
              looseness,
            });
            n++;
          }
        }
      }
    }
    this.log.info('registry.built', { tables: this.entries.size });
  }

  async start(): Promise<void> {
    const engine = await loadEngineBots(this.log);
    for (const entry of this.entries.values()) entry.room.setBotEngine(engine);

    this.timer = setInterval(() => {
      const now = Date.now();
      for (const entry of this.entries.values()) {
        try {
          entry.room.tick(now);
        } catch (err) {
          this.log.error('room.tick-failed', {
            table: entry.room.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }, this.tickMs);

    this.lobbyTimer = setInterval(() => this.pushLobby(), this.lobbyMs);
    this.log.info('registry.started', { tickMs: this.tickMs, engineBots: engine !== null });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.lobbyTimer !== null) clearInterval(this.lobbyTimer);
    this.timer = null;
    this.lobbyTimer = null;
    for (const entry of this.entries.values()) entry.room.destroy();
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: string): Room | null {
    return this.entries.get(id)?.room ?? null;
  }

  roomOf(clientId: string): Room | null {
    const id = this.location.get(clientId);
    return id ? this.entries.get(id)?.room ?? null : null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Client lifecycle
  // ─────────────────────────────────────────────────────────────────

  register(client: RoomClient): void {
    this.clients.set(client.id, client);
    // A reconnecting player may still hold a reserved seat.
    const room = this.roomOf(client.id);
    if (room) room.resume(client);
  }

  unregister(clientId: string, now = Date.now()): void {
    this.subscribers.delete(clientId);
    const room = this.roomOf(clientId);
    if (room) room.markDisconnected(clientId, now);
    this.clients.delete(clientId);
  }

  join(client: RoomClient, tableId: string, seat: number | undefined, buyIn: number): JoinResult {
    const entry = this.entries.get(tableId);
    if (!entry) return { ok: false, reason: 'no-such-table' };

    const current = this.location.get(client.id);
    if (current && current !== tableId) this.leave(client.id);

    entry.room.setBotFloor(BOT_FLOOR[entry.format]);
    const result = entry.room.join(client, seat, buyIn);
    if (result.ok) {
      this.location.set(client.id, tableId);
      this.clients.set(client.id, client);
    } else if (result.waitlist !== undefined) {
      this.location.set(client.id, tableId);
    }
    return result;
  }

  /** Watch a table without sitting — used by the lobby preview. */
  watch(client: RoomClient, tableId: string): boolean {
    const entry = this.entries.get(tableId);
    if (!entry) return false;
    entry.room.attach(client);
    entry.room.sendSnapshot(client);
    return true;
  }

  leave(clientId: string): number {
    const tableId = this.location.get(clientId);
    if (!tableId) return 0;
    const entry = this.entries.get(tableId);
    this.location.delete(clientId);
    if (!entry) return 0;
    const cashOut = entry.room.leave(clientId);
    entry.room.detach(clientId);
    if (entry.room.humans === 0) {
      entry.room.setBotFloor(0);
      entry.room.hibernate();
    }
    return cashOut;
  }

  // ─────────────────────────────────────────────────────────────────
  // Lobby
  // ─────────────────────────────────────────────────────────────────

  subscribe(clientId: string, on: boolean): void {
    if (on) this.subscribers.add(clientId);
    else this.subscribers.delete(clientId);
  }

  /**
   * Live lobby rows. Woken rooms report measurements; dormant rooms report a
   * smooth synthetic population so the list never looks abandoned.
   */
  lobby(now = Date.now()): LobbyTable[] {
    if (now - this.lobbyCacheAt < 900 && this.lobbyCache.length > 0) return this.lobbyCache;
    const out: LobbyTable[] = [];
    for (const entry of this.entries.values()) {
      const room = entry.room;
      const stake = STAKES[entry.stakeId];
      const live = room.humans > 0;
      const seatsTotal = SEAT_COUNT[entry.format];

      let seatsTaken: number;
      let avgPot: number;
      let handsPerHour: number;
      if (live) {
        seatsTaken = room.occupied;
        avgPot = room.avgPot;
        handsPerHour = room.handsPerHour || 78;
      } else {
        const t = now / 60000 + entry.phase;
        const wave = (Math.sin(t * 0.37) + Math.sin(t * 0.11 + 1.7)) * 0.25 + 0.5;
        seatsTaken = Math.max(0, Math.min(seatsTotal, Math.round(wave * seatsTotal * entry.popularity + 0.6)));
        avgPot = Math.round(stake.bb * (11 + wave * 16) * (entry.variant === 'plo4' ? 1.7 : 1) * 100) / 100;
        handsPerHour = Math.round(62 + wave * 34);
        if (seatsTaken < 2) {
          avgPot = 0;
          handsPerHour = 0;
        }
      }

      out.push({
        id: room.id,
        variant: entry.variant,
        format: entry.format,
        stakeId: entry.stakeId,
        seatsTaken,
        seatsTotal,
        avgPot,
        handsPerHour,
        looseness: entry.looseness,
        bombPotIn: entry.format === 'bomb' ? 0 : room.bombPotIn,
      });
    }
    this.lobbyCache = out;
    this.lobbyCacheAt = now;
    return out;
  }

  private pushLobby(): void {
    if (this.subscribers.size === 0) return;
    const tables = this.lobby();
    for (const clientId of this.subscribers) {
      const client = this.clients.get(clientId);
      if (client?.connected) client.send({ t: 'lobby', tables });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Matchmaking
  // ─────────────────────────────────────────────────────────────────

  /**
   * Best table for a request. Scores on: exact stake/variant/format match,
   * a sweet spot of 3-5 occupied seats (action, but a seat to sit in),
   * looseness, and an empty waitlist. Falls back to the closest stake.
   */
  quickSeat(req: { stakeId: StakeId; variant: GameVariant; format: TableFormat }): Room | null {
    const ladder = LOBBY_STAKES.indexOf(req.stakeId);
    let best: Room | null = null;
    let bestScore = -Infinity;

    for (const entry of this.entries.values()) {
      if (entry.variant !== req.variant || entry.format !== req.format) continue;
      const room = entry.room;
      const seatsTotal = SEAT_COUNT[entry.format];
      const taken = room.humans > 0 ? room.occupied : 0;
      if (taken >= seatsTotal && room.waitlistLength > 2) continue;

      const stakeDelta = Math.abs(LOBBY_STAKES.indexOf(entry.stakeId) - (ladder < 0 ? 0 : ladder));
      let score = 100 - stakeDelta * 34;
      // prefer a table with company but room to sit
      const open = seatsTotal - taken;
      score += open >= 1 ? 18 : -60;
      score += taken >= 2 ? 14 : 0;
      score += taken >= 3 && taken <= seatsTotal - 1 ? 12 : 0;
      score += entry.looseness * 14;
      score -= room.waitlistLength * 25;
      score += room.humans > 0 ? 8 : 0;

      if (score > bestScore) {
        bestScore = score;
        best = room;
      }
    }
    return best;
  }
}
