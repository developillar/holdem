/**
 * ROYALE — opponent roster.
 *
 * A deterministic cast of believable poker screen names. Everything here is
 * derived from a single seed so replays, hand histories and lobby snapshots
 * are reproducible: same seed → same 64 humans, same stats, same avatars.
 *
 * Stat lines are not decoration. They are generated inside the band that
 * genuinely belongs to each personality (a nit really does show up with
 * VPIP 13 / PFR 11) and `src/engine/bots.ts` reads the same personality to
 * drive its decisions, so the HUD the player sees matches how the bot plays.
 */

import { Rng } from '../core/rng.ts';
import type { PlayerRef, StatLine } from '../core/types.ts';

// ─────────────────────────── Personality ───────────────────────────

export type Personality = 'nit' | 'tag' | 'lag' | 'station' | 'maniac' | 'pro';

export const PERSONALITIES: readonly Personality[] = ['nit', 'tag', 'lag', 'station', 'maniac', 'pro'];

export interface PersonalityMeta {
  /** short badge text used on seat HUDs */
  label: string;
  /** one-line read the UI can show on the player card */
  blurb: string;
  /** semantic tone key — UI maps this to a token colour */
  tone: 'info' | 'good' | 'warn' | 'bad' | 'epic';
}

export const PERSONALITY_META: Record<Personality, PersonalityMeta> = {
  nit: { label: 'Rock', blurb: 'Waits for the nuts. Fold to pressure, pay off value.', tone: 'info' },
  tag: { label: 'Solid', blurb: 'Tight, aggressive, textbook. Punishes limps.', tone: 'good' },
  lag: { label: 'Pressure', blurb: 'Wide opens, relentless barrels, hard to read.', tone: 'warn' },
  station: { label: 'Caller', blurb: 'Never folds a pair. Bet big, bluff never.', tone: 'good' },
  maniac: { label: 'Wildcard', blurb: 'Raises everything. Trap it, then hold on.', tone: 'bad' },
  pro: { label: 'Shark', blurb: 'Balanced ranges, correct sizings, no leaks.', tone: 'epic' },
};

/** Statistical bands each personality lives inside: [min, max]. */
interface StatBand {
  vpip: [number, number];
  pfr: [number, number];
  threeBet: [number, number];
  foldToThreeBet: [number, number];
  af: [number, number];
  wtsd: [number, number];
  wsd: [number, number];
  cbetFlop: [number, number];
  /** bb/100 the profile is advertised at */
  winrate: [number, number];
  skill: [number, number];
}

const BANDS: Record<Personality, StatBand> = {
  nit: {
    vpip: [10.5, 17], pfr: [8.5, 14], threeBet: [1.8, 4.2], foldToThreeBet: [68, 82],
    af: [1.7, 2.6], wtsd: [17, 23], wsd: [52, 59], cbetFlop: [52, 67],
    winrate: [-1.5, 3.5], skill: [0.42, 0.62],
  },
  tag: {
    vpip: [19.5, 25.5], pfr: [16.5, 21.5], threeBet: [5, 8.4], foldToThreeBet: [52, 64],
    af: [2.5, 3.4], wtsd: [24, 28], wsd: [51, 56], cbetFlop: [61, 73],
    winrate: [0.5, 6.5], skill: [0.6, 0.8],
  },
  lag: {
    vpip: [27, 34.5], pfr: [22, 28.5], threeBet: [8.6, 13.5], foldToThreeBet: [40, 52],
    af: [3.2, 4.5], wtsd: [26, 31.5], wsd: [47, 52], cbetFlop: [68, 81],
    winrate: [-3, 6], skill: [0.55, 0.78],
  },
  station: {
    vpip: [44, 58], pfr: [7, 13], threeBet: [1.2, 3], foldToThreeBet: [30, 44],
    af: [0.8, 1.5], wtsd: [37, 47], wsd: [44, 49], cbetFlop: [38, 53],
    winrate: [-14, -3], skill: [0.2, 0.4],
  },
  maniac: {
    vpip: [44, 62], pfr: [33, 48], threeBet: [13.5, 22], foldToThreeBet: [22, 38],
    af: [4.5, 7.2], wtsd: [29, 37], wsd: [42, 48], cbetFlop: [77, 91],
    winrate: [-22, 2], skill: [0.25, 0.5],
  },
  pro: {
    vpip: [21.5, 27], pfr: [18, 23.5], threeBet: [7, 11.5], foldToThreeBet: [48, 58],
    af: [2.8, 3.9], wtsd: [24.5, 29], wsd: [52, 58], cbetFlop: [56, 71],
    winrate: [3, 11], skill: [0.82, 0.98],
  },
};

// ─────────────────────────── Cosmetic id hooks ───────────────────────────

/**
 * Bots equip cosmetics by id. The economy module owns the real registry, so
 * these are kept in one place and can be re-pointed at runtime rather than
 * hard-coded through 64 profiles.
 */
export const BOT_COSMETIC_IDS = {
  frames: ['frame-brass', 'frame-onyx', 'frame-royal', 'frame-aurora', 'frame-champion'] as string[],
  titles: ['title-shark', 'title-grinder', 'title-highroller', 'title-nightowl', 'title-crusher'] as string[],
};

/** Re-point bot cosmetics at the real catalogue once econ has registered it. */
export function configureBotCosmetics(frames: string[], titles: string[]): void {
  if (frames.length) BOT_COSMETIC_IDS.frames = frames.slice();
  if (titles.length) BOT_COSMETIC_IDS.titles = titles.slice();
}

/** Number of distinct procedural avatars the render layer generates. */
export const AVATAR_COUNT = 48;

export function avatarIdFor(n: number): string {
  return `av-${String((((n % AVATAR_COUNT) + AVATAR_COUNT) % AVATAR_COUNT) + 1).padStart(2, '0')}`;
}

// ─────────────────────────── Profile ───────────────────────────

export interface BotProfile {
  id: string;
  name: string;
  avatarId: string;
  /** ISO-3166 alpha-2 */
  countryCode: string;
  level: number;
  personality: Personality;
  premium: boolean;
  frameId: string | null;
  titleId: string | null;
  /** full HUD stat line, consistent with `personality` */
  stats: StatLine;
  /** one-line flavour for the player card */
  tagline: string;
  /** 0..1 — how reliably the bot executes its own strategy */
  skill: number;
  /** 0..1 — hot-streak ring intensity, refreshed by the table driver */
  heat: number;
}

// ─────────────────────────── Name pool ───────────────────────────

/** [display name, country, personality lean] — hand-written, 64 entries. */
const NAMES: ReadonlyArray<readonly [string, string, Personality]> = [
  ['Kenta Ishii', 'JP', 'pro'],
  ['RiverRatBK', 'US', 'station'],
  ['Sofía Márquez', 'ES', 'tag'],
  ['Tomasz Wójcik', 'PL', 'nit'],
  ['NguyenHa89', 'VN', 'lag'],
  ['Lars Bergström', 'SE', 'pro'],
  ['ChipDoctorMD', 'US', 'tag'],
  ['Anastasiya V.', 'UA', 'tag'],
  ['MelbourneMax', 'AU', 'lag'],
  ['Yusuf Demir', 'TR', 'maniac'],
  ['SnapCallSven', 'NO', 'station'],
  ['Priya Raghavan', 'IN', 'tag'],
  ['El Tiburón', 'MX', 'maniac'],
  ['Kim Da-eun', 'KR', 'pro'],
  ['FoldEquityFred', 'GB', 'nit'],
  ['Mateus Ribeiro', 'BR', 'lag'],
  ['Hana Kováčová', 'SK', 'tag'],
  ['BluffCityJoe', 'US', 'lag'],
  ['Omar Haddad', 'MA', 'station'],
  ['Wei Chen', 'SG', 'pro'],
  ['4BetDonkey', 'DE', 'maniac'],
  ['Ingrid Halvorsen', 'NO', 'nit'],
  ['PocketRockets77', 'CA', 'tag'],
  ['Andrea Bianchi', 'IT', 'tag'],
  ['Şule Aydın', 'TR', 'lag'],
  ['GutshotGus', 'IE', 'station'],
  ['Rafael Duarte', 'PT', 'pro'],
  ['Miki Tanaka', 'JP', 'nit'],
  ['ValueTownVic', 'AU', 'tag'],
  ['Sanne de Vries', 'NL', 'pro'],
  ['CheckRaiseKate', 'US', 'lag'],
  ['Bogdan Petrescu', 'RO', 'maniac'],
  ['Aiko Nakamura', 'JP', 'tag'],
  ['TheQuietOne', 'FI', 'nit'],
  ['Diego Salazar', 'CO', 'lag'],
  ['Émile Laurent', 'FR', 'pro'],
  ['ShoveMonkey', 'ZA', 'maniac'],
  ['Katarzyna Nowak', 'PL', 'tag'],
  ['NitVanWinkle', 'NL', 'nit'],
  ['Bilal Karim', 'PK', 'station'],
  ['Freya Lindqvist', 'SE', 'tag'],
  ['AllInAntonio', 'AR', 'maniac'],
  ['Chloé Beaumont', 'FR', 'tag'],
  ['RunItTwiceRay', 'US', 'pro'],
  ['Jonas Møller', 'DK', 'nit'],
  ['Mei Ling Ho', 'HK', 'tag'],
  ['CoolerCollector', 'GB', 'station'],
  ['Tariq El-Amin', 'EG', 'lag'],
  ['Vera Kuznetsova', 'RU', 'pro'],
  ['SlowRollSlim', 'US', 'maniac'],
  ['Ana Lúcia Costa', 'BR', 'tag'],
  ['BackdoorBrent', 'CA', 'lag'],
  ['Hiroshi Sato', 'JP', 'nit'],
  ['Zeynep Kaya', 'TR', 'tag'],
  ['MinRaiseMarco', 'IT', 'station'],
  ['Ola Adeyemi', 'NG', 'pro'],
  ['Jitka Horáková', 'CZ', 'tag'],
  ['PolarizedPete', 'GB', 'pro'],
  ['Camila Rojas', 'CL', 'lag'],
  ['ThreeBetTheo', 'GR', 'maniac'],
  ['Astrid Nilsen', 'NO', 'tag'],
  ['LimpKingLenny', 'US', 'station'],
  ['Rahul Mehta', 'IN', 'tag'],
  ['SuitedGapper', 'AU', 'lag'],
];

const TAGLINES: Record<Personality, readonly string[]> = {
  nit: [
    'Folded 14 hours straight. Regrets nothing.',
    'If I bet, you are drawing dead.',
    'Patience is a bankroll strategy.',
    'Two hands an orbit. Both of them aces.',
  ],
  tag: [
    'Position, then pressure. In that order.',
    'Small edges, taken forever.',
    'Range advantage is a real thing.',
    'I only barrel when the story checks out.',
  ],
  lag: [
    'Every pot is negotiable.',
    'You will fold eventually.',
    'Wide open, wider follow-up.',
    'Fold equity is my whole personality.',
  ],
  station: [
    'I came here to see cards.',
    'Bluffing is rude. I call.',
    'Second pair plays fine, actually.',
    'Show me. I paid for it.',
  ],
  maniac: [
    'Raise. Then raise the raise.',
    'Chips are for moving.',
    'Sleep when the tournament ends.',
    'Variance is just fun with a spreadsheet.',
  ],
  pro: [
    'Balanced enough to be boring.',
    'Solver-approved, table-tested.',
    'Ranges, blockers, node locks.',
    'I make the same mistake exactly 32% of the time.',
  ],
};

// ─────────────────────────── Generation ───────────────────────────

export const ROSTER_SEED = 0x0ff5eed;

function band(rng: Rng, b: [number, number], round = 1): number {
  // Beta-ish shaping: cluster toward the middle of the band, occasional edge.
  const u = (rng.next() + rng.next() + rng.next()) / 3;
  const v = b[0] + u * (b[1] - b[0]);
  return Math.round(v * round) / round;
}

function buildStats(rng: Rng, p: Personality, skill: number): StatLine {
  const b = BANDS[p];
  const hands = 800 + Math.round(Math.pow(rng.next(), 2.1) * 184_000);
  let vpip = band(rng, b.vpip, 10);
  let pfr = band(rng, b.pfr, 10);
  // A stat line where PFR exceeds VPIP is impossible; keep a believable gap.
  if (pfr > vpip - 1.2) pfr = Math.round((vpip - 1.2 - rng.next() * 1.5) * 10) / 10;
  const winrate = band(rng, b.winrate, 10);
  const bbSize = 1;
  const netChips = Math.round((winrate / 100) * hands * bbSize * 100) / 100;
  return {
    hands,
    vpip,
    pfr,
    threeBet: band(rng, b.threeBet, 10),
    foldToThreeBet: band(rng, b.foldToThreeBet, 10),
    af: band(rng, b.af, 100),
    wtsd: band(rng, b.wtsd, 10),
    wsd: band(rng, b.wsd, 10),
    cbetFlop: band(rng, b.cbetFlop, 10),
    winrateBb100: winrate,
    netChips,
    // All-in adjusted EV drifts toward the truth: better players run closer to it.
    evBb100: Math.round((winrate + rng.normal(0, 2.4 * (1.15 - skill))) * 10) / 10,
  };
}

function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Builds the full 64-strong roster. Pure and deterministic: the same seed
 * always yields byte-identical profiles.
 */
export function buildRoster(seed: number = ROSTER_SEED): BotProfile[] {
  const rng = new Rng(seed);
  // Avatar assignment: walk a shuffled bag so no two adjacent seats collide.
  const bag: number[] = [];
  for (let i = 0; i < AVATAR_COUNT; i++) bag.push(i);
  rng.shuffle(bag);
  let bagIndex = 0;

  const out: BotProfile[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const entry = NAMES[i];
    const personality = entry[2];
    const skill = band(rng, BANDS[personality].skill, 1000);
    // Level: heavy low tail, pros run higher, premium correlates with level.
    const base = 3 + Math.floor(Math.pow(rng.next(), 1.85) * 92);
    const level = Math.min(99, base + (personality === 'pro' ? 12 : 0) + (personality === 'nit' ? 4 : 0));
    const premium = rng.next() < Math.min(0.58, 0.08 + level / 190);
    if (bagIndex >= bag.length) {
      rng.shuffle(bag);
      bagIndex = 0;
    }
    const avatarId = avatarIdFor(bag[bagIndex++]);
    const lines = TAGLINES[personality];
    out.push({
      id: `bot-${slug(entry[0])}`,
      name: entry[0],
      avatarId,
      countryCode: entry[1],
      level,
      personality,
      premium,
      frameId: premium ? BOT_COSMETIC_IDS.frames[rng.int(BOT_COSMETIC_IDS.frames.length)] : null,
      titleId:
        premium && level > 46 ? BOT_COSMETIC_IDS.titles[rng.int(BOT_COSMETIC_IDS.titles.length)] : null,
      stats: buildStats(rng, personality, skill),
      tagline: lines[rng.int(lines.length)],
      skill,
      heat: Math.round(Math.pow(rng.next(), 2.4) * 100) / 100,
    });
  }
  return out;
}

/** The canonical roster. Stable across reloads. */
export const ROSTER: BotProfile[] = buildRoster();

const BY_ID = new Map<string, BotProfile>(ROSTER.map((p) => [p.id, p]));

export function profileById(id: string): BotProfile | null {
  return BY_ID.get(id) ?? null;
}

export function profilesByPersonality(p: Personality): BotProfile[] {
  return ROSTER.filter((x) => x.personality === p);
}

// ─────────────────────────── Table casting ───────────────────────────

export interface CastOptions {
  /** bias the table toward looser play — used by "juicy" lobby tables */
  looseness?: number;
  /** minimum distinct personalities at the table */
  minVariety?: number;
  /** ids that must not be seated (e.g. already at another table) */
  exclude?: readonly string[];
  /** pull from a custom roster instead of the canonical one */
  roster?: readonly BotProfile[];
}

/**
 * Casts `n` opponents for a table. This is deliberately not a plain random
 * sample: a table of six nits is technically random and completely lifeless.
 * We guarantee a spread of personalities, weight toward the requested
 * looseness, and never seat the same profile twice.
 */
export function pickOpponents(n: number, seed: number, opts: CastOptions = {}): BotProfile[] {
  const rng = new Rng(seed >>> 0);
  const looseness = Math.max(0, Math.min(1, opts.looseness ?? 0.5));
  const exclude = new Set(opts.exclude ?? []);
  const pool = (opts.roster ?? ROSTER).filter((p) => !exclude.has(p.id));
  if (pool.length === 0) return [];

  // How likely each personality is to be dealt in, given table looseness.
  const weight: Record<Personality, number> = {
    nit: 1.15 - looseness * 0.75,
    tag: 1.25 - looseness * 0.25,
    lag: 0.55 + looseness * 0.85,
    station: 0.4 + looseness * 1.35,
    maniac: 0.18 + looseness * 1.0,
    pro: 0.85 - looseness * 0.3,
  };

  const chosen: BotProfile[] = [];
  const used = new Set<string>();
  const seenPersonality = new Map<Personality, number>();
  const minVariety = Math.min(opts.minVariety ?? Math.min(4, n), PERSONALITIES.length, n);

  const scoreOf = (p: BotProfile): number => {
    const seen = seenPersonality.get(p.personality) ?? 0;
    // Diminishing returns for repeating a personality keeps the table varied.
    const variety = 1 / (1 + seen * 1.6);
    return weight[p.personality] * variety * (0.65 + rng.next() * 0.7);
  };

  while (chosen.length < n && used.size < pool.length) {
    // Sample a candidate window then take the best — cheap weighted draw.
    let best: BotProfile | null = null;
    let bestScore = -1;
    const tries = Math.min(pool.length, 14);
    for (let t = 0; t < tries; t++) {
      const cand = pool[rng.int(pool.length)];
      if (used.has(cand.id)) continue;
      const need = seenPersonality.size < minVariety && seenPersonality.has(cand.personality);
      const s = scoreOf(cand) * (need ? 0.25 : 1);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
    if (!best) {
      // Window missed entirely (small pool): take the first unused profile.
      best = pool.find((p) => !used.has(p.id)) ?? null;
      if (!best) break;
    }
    used.add(best.id);
    seenPersonality.set(best.personality, (seenPersonality.get(best.personality) ?? 0) + 1);
    chosen.push(best);
  }
  return chosen;
}

/** Adapts a profile into the shared `PlayerRef` the whole app renders from. */
export function toPlayerRef(p: BotProfile): PlayerRef {
  return {
    id: p.id,
    name: p.name,
    avatarId: p.avatarId,
    frameId: p.frameId,
    titleId: p.titleId,
    emoteSetId: 'emote-core',
    level: p.level,
    premium: p.premium,
    heat: p.heat,
    countryCode: p.countryCode,
  };
}

/** A neutral, empty stat line — useful for freshly seated humans. */
export function emptyStatLine(): StatLine {
  return {
    hands: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    foldToThreeBet: 0,
    af: 0,
    wtsd: 0,
    wsd: 0,
    cbetFlop: 0,
    winrateBb100: 0,
    netChips: 0,
    evBb100: 0,
  };
}
