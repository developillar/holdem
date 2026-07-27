/**
 * ROYALE — lobby/data.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Single-player has no server, so the lobby simulates one. Everything here is
 * derived from the seeded RNG plus the wall clock, which buys two things:
 *
 *   • **Determinism.** The same minute always produces the same lobby, so a
 *     screenshot or a bug report is reproducible.
 *   • **Believable life.** Player counts breathe on a smooth value-noise curve
 *     instead of jittering, tables fill and empty, the bomb-pot clock actually
 *     counts down, and traffic follows a real time-of-day curve (dead at 6am,
 *     rammed at 9pm) so the numbers never feel like `Math.random()`.
 *
 *   const feed = createLobbyFeed();
 *   feed.snapshot()                 // LobbySnapshot right now
 *   const off = feed.subscribe(render); // ~1Hz, only when something moved
 *   feed.dispose();
 */
import { Rng } from '../../core/rng.ts';
import { STAKE_LIST } from '../../core/stakes.ts';
import type { GameVariant, LobbyTable, Stake, StakeId, TableFormat } from '../../core/types.ts';

export interface StakeLive {
  stake: Stake;
  /** humans sitting at this level right now */
  players: number;
  /** running tables */
  tables: number;
  /** average pot in dollars */
  avgPot: number;
  /** 0–1; ≥0.62 lights the flame badge */
  looseness: number;
  /** hands dealt per hour across the level, used for the "fast" hint */
  handsPerHour: number;
  /** seats waiting to be filled — drives "seat open now" */
  seatsOpen: number;
  /** how much the player count moved in the last minute, for the trend arrow */
  trend: number;
}

export interface LobbySnapshot {
  /** epoch ms this snapshot was produced */
  at: number;
  /** everyone online across all levels and formats */
  totalPlayers: number;
  stakes: StakeLive[];
  tables: LobbyTable[];
  /** ms until the next scheduled bomb pot */
  bombPotInMs: number;
  /** the level the next bomb pot runs at */
  bombPotStake: StakeId;
  /** seats already claimed in the featured sit & go */
  sngSeats: number;
  sngTotal: number;
  sngPrizePool: number;
  /** ms left on the season pass */
  seasonEndsInMs: number;
}

export interface LobbyFeed {
  snapshot(): LobbySnapshot;
  subscribe(fn: (s: LobbySnapshot) => void): () => void;
  dispose(): void;
}

// ── noise ────────────────────────────────────────────────────────────
// A hashed 1-D value noise, smoothstep-interpolated. Continuous in time, so a
// player count eases between values instead of teleporting, and identical on
// every device for a given clock reading.

function hash2(a: number, b: number): number {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35);
  x = Math.imul(x ^ (x >>> 15), 0x2545f491);
  return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Smooth 0–1 wander for `seed`, one full cycle every `periodMs`. */
function wander(seed: number, now: number, periodMs: number): number {
  const p = now / periodMs;
  const i = Math.floor(p);
  const f = smooth(p - i);
  return hash2(seed, i) * (1 - f) + hash2(seed, i + 1) * f;
}

/** Two octaves — a slow tide with a small ripple on top. */
function wander2(seed: number, now: number, periodMs: number): number {
  return wander(seed, now, periodMs) * 0.72 + wander(seed ^ 0x5bf03635, now, periodMs / 3.7) * 0.28;
}

/**
 * Traffic multiplier for the local hour. Peaks at 21:00, troughs at 05:00,
 * with the small post-work bump every real poker lobby has.
 */
function timeOfDayLoad(now: number): number {
  const d = new Date(now);
  const hour = d.getHours() + d.getMinutes() / 60;
  const main = Math.cos(((hour - 21) / 24) * Math.PI * 2);
  const evening = Math.exp(-Math.pow((hour - 19.5) / 2.6, 2)) * 0.34;
  const lunch = Math.exp(-Math.pow((hour - 13) / 1.8, 2)) * 0.12;
  return Math.max(0.16, 0.58 + main * 0.36 + evening + lunch);
}

// ── table names ──────────────────────────────────────────────────────
// Rooms are named, not numbered — "Obsidian 3" reads like a place you sit at.

const ROOM_NAMES = [
  'Obsidian', 'Vermeil', 'Cinder', 'Kingfisher', 'Halcyon', 'Meridian',
  'Nightjar', 'Ivory', 'Cobalt', 'Ember', 'Verdigris', 'Onyx',
  'Peregrine', 'Solstice', 'Bellwether', 'Tanager', 'Lantern', 'Quicksilver',
];

export function tableName(id: string): string {
  let hv = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hv ^= id.charCodeAt(i);
    hv = Math.imul(hv, 0x01000193) >>> 0;
  }
  return `${ROOM_NAMES[hv % ROOM_NAMES.length]} ${((hv >> 9) % 9) + 1}`;
}

// ── generation ───────────────────────────────────────────────────────

interface TableSeed {
  id: string;
  stakeId: StakeId;
  variant: GameVariant;
  format: TableFormat;
  seatsTotal: number;
  /** stable personality: base fill, base looseness, base speed */
  fill: number;
  loose: number;
  speed: number;
  noise: number;
  /** bomb pots run on this table */
  bomb: boolean;
}

/** Fixed roster of rooms. Stable identity, live occupancy. */
function buildRoster(): TableSeed[] {
  const rng = new Rng(0x0b0551e);
  const out: TableSeed[] = [];
  let n = 0;
  for (const stake of STAKE_LIST) {
    // Micro levels run far more rooms than the high stakes — that shape is
    // what makes a lobby feel like a real player pool.
    const count = stake.tier === 'micro' ? 7 : stake.tier === 'low' ? 5 : stake.tier === 'mid' ? 4 : 3;
    for (let i = 0; i < count; i++) {
      const plo = rng.bool(0.26);
      const sng = !plo && rng.bool(0.16);
      out.push({
        id: `t${(n++).toString(36)}${stake.id}`,
        stakeId: stake.id,
        variant: plo ? 'plo4' : 'nlhe',
        format: sng ? 'sng' : 'cash',
        seatsTotal: rng.bool(0.34) ? 9 : 6,
        fill: rng.range(0.42, 0.98),
        loose: rng.range(0.18, 0.92),
        speed: rng.range(0.74, 1.28),
        noise: rng.nextU32(),
        bomb: rng.bool(0.22),
      });
    }
  }
  return out;
}

const ROSTER = buildRoster();

/** Bomb pots run on a strict 8-minute cadence, so the countdown is honest. */
const BOMB_PERIOD_MS = 8 * 60_000;
const SEASON_END = Date.UTC(2026, 8, 30, 23, 59, 0);

function computeTables(now: number, load: number): LobbyTable[] {
  const out: LobbyTable[] = new Array(ROSTER.length);
  for (let i = 0; i < ROSTER.length; i++) {
    const t = ROSTER[i];
    const drift = wander2(t.noise, now, 128_000);
    const occupancy = Math.min(1, t.fill * (0.62 + load * 0.5) * (0.82 + drift * 0.36));
    const seatsTaken = Math.max(
      t.format === 'sng' ? 1 : 2,
      Math.min(t.seatsTotal, Math.round(occupancy * t.seatsTotal)),
    );
    const stake = STAKE_LIST.find((s) => s.id === t.stakeId) ?? STAKE_LIST[0];
    const looseness = Math.max(0.05, Math.min(0.99, t.loose * 0.72 + drift * 0.34));
    // Pot size scales with the big blind, how loose the table is and how many
    // players see a flop — 5.5bb is a nailed-on tight table, 19bb is a circus.
    const potBb = 4.4 + looseness * 13 + (seatsTaken / t.seatsTotal) * 3.6;
    out[i] = {
      id: t.id,
      variant: t.variant,
      format: t.format,
      stakeId: t.stakeId,
      seatsTaken,
      seatsTotal: t.seatsTotal,
      avgPot: Math.round(potBb * stake.bb * 100) / 100,
      handsPerHour: Math.round((58 + (1 - looseness) * 26) * t.speed * (t.seatsTotal === 6 ? 1.18 : 1)),
      looseness,
      bombPotIn: t.bomb ? Math.max(0, BOMB_PERIOD_MS - (now % BOMB_PERIOD_MS)) : null,
    };
  }
  return out;
}

function computeSnapshot(now: number): LobbySnapshot {
  const load = timeOfDayLoad(now);
  const tables = computeTables(now, load);
  // One extra evaluation a minute back gives every level an honest trend
  // arrow without storing any history.
  const before = now - 60_000;
  const past = computeTables(before, timeOfDayLoad(before));

  const stakes: StakeLive[] = STAKE_LIST.map((stake, idx) => {
    const mine = tables.filter((t) => t.stakeId === stake.id);
    const seated = mine.reduce((a, t) => a + t.seatsTaken, 0);
    const seats = mine.reduce((a, t) => a + t.seatsTotal, 0);
    // Visible rooms are the tip of the pool: multiply up so the headline
    // "players online" reads like a real level, not like a demo.
    const scale = stake.tier === 'micro' ? 46 : stake.tier === 'low' ? 24 : stake.tier === 'mid' ? 11 : 4.2;
    const players = Math.round(seated * scale * (0.9 + wander2(0x1000 + idx, now, 96_000) * 0.2));
    const seatedBefore = past.reduce((a, t) => (t.stakeId === stake.id ? a + t.seatsTaken : a), 0);
    const prev = Math.round(
      seatedBefore * scale * (0.9 + wander2(0x1000 + idx, before, 96_000) * 0.2),
    );
    const looseness =
      mine.reduce((a, t) => a + t.looseness, 0) / Math.max(1, mine.length);
    return {
      stake,
      players,
      tables: Math.round(mine.length * scale * 0.16) + mine.length,
      avgPot:
        Math.round((mine.reduce((a, t) => a + t.avgPot, 0) / Math.max(1, mine.length)) * 100) / 100,
      looseness,
      handsPerHour: Math.round(
        mine.reduce((a, t) => a + t.handsPerHour, 0) / Math.max(1, mine.length),
      ),
      seatsOpen: seats - seated,
      trend: players - prev,
    };
  });

  const totalPlayers = stakes.reduce((a, s) => a + s.players, 0);
  const bombPotInMs = BOMB_PERIOD_MS - (now % BOMB_PERIOD_MS);
  // Which level hosts the next bomb pot rotates with the schedule slot.
  const slot = Math.floor(now / BOMB_PERIOD_MS);
  const bombPotStake = STAKE_LIST[slot % Math.min(4, STAKE_LIST.length)].id;

  const sngTotal = 9;
  const sngSeats = Math.max(
    1,
    Math.min(sngTotal - 1, Math.round(wander2(0x5c0, now, 74_000) * (sngTotal - 1) + 1)),
  );

  return {
    at: now,
    totalPlayers,
    stakes,
    tables,
    bombPotInMs,
    bombPotStake,
    sngSeats,
    sngTotal,
    sngPrizePool: 45,
    seasonEndsInMs: Math.max(0, SEASON_END - now),
  };
}

export function createLobbyFeed(): LobbyFeed {
  let current = computeSnapshot(Date.now());
  const subs = new Set<(s: LobbySnapshot) => void>();
  let timer = 0;

  const tick = () => {
    current = computeSnapshot(Date.now());
    for (const fn of Array.from(subs)) {
      try {
        fn(current);
      } catch (err) {
        console.error('[lobby-feed] subscriber failed', err);
      }
    }
  };

  const start = () => {
    if (timer) return;
    timer = window.setInterval(tick, 1000);
  };
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = 0;
  };

  const onVis = () => (document.hidden ? stop() : (tick(), start()));
  document.addEventListener('visibilitychange', onVis);
  start();

  return {
    snapshot: () => current,
    subscribe(fn) {
      subs.add(fn);
      fn(current);
      return () => subs.delete(fn);
    },
    dispose() {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      subs.clear();
    },
  };
}

// ── formatting helpers shared across the lobby ───────────────────────

/** `mm:ss`, or `h:mm:ss` past an hour. Always tabular-safe (fixed width). */
export function clockMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const hrs = Math.floor(total / 3600);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return hrs > 0 ? `${hrs}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** "6d 4h" — coarse countdown for the season / pass strip. */
export function coarseMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const hrs = Math.floor((total % 86400) / 3600);
  if (d > 0) return `${d}d ${hrs}h`;
  const m = Math.floor((total % 3600) / 60);
  return `${hrs}h ${m}m`;
}

/** 12480 → "12.5K". Player counts only; money uses core/stakes `money()`. */
export function compactCount(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}K`;
  return String(Math.round(n));
}

/** The greeting is time-aware — small touch, reads as a considered app. */
export function greeting(now = new Date()): string {
  const hr = now.getHours();
  if (hr < 5) return 'Still up';
  if (hr < 12) return 'Good morning';
  if (hr < 17) return 'Good afternoon';
  if (hr < 22) return 'Good evening';
  return 'Good evening';
}
