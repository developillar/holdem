/**
 * ROYALE — econ/pass.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The Premium Pass: fifty tiers, two tracks, one season.
 *
 *   TRACK          every player gets the free lane. Premium adds the second
 *                  lane and back-pays every tier already passed, so upgrading
 *                  late is never a punishment.
 *   CURVE          tier N costs 700 + 38·(N−1) xp. Fifty tiers ≈ 81k xp,
 *                  which is roughly 55 hours of ordinary play or 30 with the
 *                  challenges — a season you can finish, not a treadmill.
 *   CHALLENGES     six dailies (reset at local midnight) and six weeklies
 *                  (reset Monday). They are the bulk of the xp; grinding
 *                  without them still finishes the pass, just slower.
 *
 * XP is earned from real events on the bus — hands played, pots won,
 * showdowns reached, all-ins survived — so nothing here needs the UI to be
 * open to make progress.
 *
 *   import { passState, claimTier, challenges, awardXp } from '../econ/pass.ts';
 */
import { bus } from '../core/bus.ts';
import type { PassReward, PassTier, Rarity } from '../core/types.ts';
import { itemById } from '../data/catalog.ts';
import {
  econ, grant, addChips, addGems, spendGems, grantPremium, isPremium, setPassProgress,
} from './wallet.ts';

const STORE_KEY = 'royale.pass.v1';
const DAY_MS = 86_400_000;

export const MAX_TIER = 50;

// ─────────────────────────── the season ───────────────────────────

/** Seasons are 70 days and roll forever from this anchor. */
const SEASON_EPOCH = Date.UTC(2026, 0, 5, 0, 0, 0);
const SEASON_LEN = 70 * DAY_MS;

export interface Season {
  index: number;
  /** display number, 1-based */
  number: number;
  name: string;
  /** the line under the season name on the pass screen */
  tagline: string;
  startsAt: number;
  endsAt: number;
}

const SEASON_NAMES: Array<[string, string]> = [
  ['Opening Range', 'Where every story starts: one raise, one caller, one flop.'],
  ['Cold Deck', 'The season the run-outs stopped being fair. Play through it.'],
  ['Gilded Hour', 'The game gets loose at 2am. So does the loot.'],
  ['Black Orchid', 'The back room, the long night, and the pot nobody talks about.'],
  ['Aurora', 'Somewhere north of the nosebleeds the sky does something strange.'],
];

export function seasonAt(now = Date.now()): Season {
  const index = Math.max(0, Math.floor((now - SEASON_EPOCH) / SEASON_LEN));
  const [name, tagline] = SEASON_NAMES[index % SEASON_NAMES.length];
  return {
    index,
    number: index + 1,
    name,
    tagline,
    startsAt: SEASON_EPOCH + index * SEASON_LEN,
    endsAt: SEASON_EPOCH + (index + 1) * SEASON_LEN,
  };
}

export interface Countdown {
  ms: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** "12d 04h" / "4h 12m" / "9m 30s" */
  label: string;
}

export function countdown(until: number, now = Date.now()): Countdown {
  const ms = Math.max(0, until - now);
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const label =
    days > 0 ? `${days}d ${String(hours).padStart(2, '0')}h`
      : hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m`
        : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return { ms, days, hours, minutes, seconds, label };
}

export function seasonCountdown(now = Date.now()): Countdown {
  return countdown(seasonAt(now).endsAt, now);
}

/** 0–1 through the current season, for the header's thin progress rail. */
export function seasonProgress(now = Date.now()): number {
  const s = seasonAt(now);
  return Math.max(0, Math.min(1, (now - s.startsAt) / (s.endsAt - s.startsAt)));
}

// ─────────────────────────── xp curve ───────────────────────────

/** xp required to move from `tier` to `tier + 1`. */
export function xpForTier(tier: number): number {
  return 700 + (Math.max(1, tier) - 1) * 38;
}

/** Cumulative xp required to have reached `tier`. */
export function xpToReach(tier: number): number {
  let total = 0;
  for (let t = 1; t < tier; t++) total += xpForTier(t);
  return total;
}

export const TOTAL_XP = xpToReach(MAX_TIER + 1);

export interface TierPosition {
  tier: number;
  /** xp banked inside the current tier */
  into: number;
  /** xp the current tier requires */
  need: number;
  /** 0–1 through the current tier */
  pct: number;
  maxed: boolean;
}

export function positionFor(totalXp: number): TierPosition {
  let tier = 1;
  let left = Math.max(0, totalXp);
  while (tier < MAX_TIER) {
    const need = xpForTier(tier);
    if (left < need) break;
    left -= need;
    tier += 1;
  }
  if (tier >= MAX_TIER) {
    return { tier: MAX_TIER, into: xpForTier(MAX_TIER), need: xpForTier(MAX_TIER), pct: 1, maxed: true };
  }
  const need = xpForTier(tier);
  return { tier, into: left, need, pct: need > 0 ? left / need : 0, maxed: false };
}

// ─────────────────────────── reward tracks ───────────────────────────

function cosmetic(itemId: string): PassReward {
  const item = itemById(itemId);
  return {
    kind: 'cosmetic',
    itemId,
    label: item?.name ?? itemId,
    rarity: item?.rarity ?? 'common',
  };
}

function gemsReward(amount: number, rarity: Rarity = 'rare'): PassReward {
  return { kind: 'gems', amount, label: `${amount} gems`, rarity };
}

function chipsReward(amount: number, rarity: Rarity = 'common'): PassReward {
  return { kind: 'chips', amount, label: `${amount.toLocaleString('en-US')} chips`, rarity };
}

function ticket(label: string, rarity: Rarity = 'epic'): PassReward {
  return { kind: 'ticket', amount: 1, label, rarity };
}

/**
 * Hand-placed rewards. The premium lane always has something; the free lane
 * lands on roughly every other tier so the empty slots read as deliberate
 * pacing rather than a missing row.
 */
const FREE_TRACK: Record<number, PassReward> = {
  1: chipsReward(2500),
  3: gemsReward(40, 'common'),
  5: chipsReward(4000),
  7: cosmetic('title-regular'),
  9: gemsReward(60, 'common'),
  11: chipsReward(6000),
  13: ticket('Sit & Go ticket', 'rare'),
  15: cosmetic('emote-tilt'),
  17: gemsReward(80, 'rare'),
  19: chipsReward(9000),
  21: cosmetic('title-river-rat'),
  23: gemsReward(90, 'rare'),
  25: chipsReward(12_000),
  27: cosmetic('back-pinstripe'),
  29: gemsReward(100, 'rare'),
  31: chipsReward(15_000),
  33: ticket('Bomb-pot table pass', 'rare'),
  35: cosmetic('felt-slate'),
  37: gemsReward(120, 'rare'),
  39: chipsReward(20_000),
  41: cosmetic('frame-bevel'),
  43: gemsReward(140, 'rare'),
  45: chipsReward(26_000),
  47: cosmetic('chips-clay-classic'),
  49: gemsReward(160, 'epic'),
  50: chipsReward(50_000, 'epic'),
};

const PREMIUM_TRACK: Record<number, PassReward> = {
  1: gemsReward(100),
  2: chipsReward(6000),
  3: cosmetic('title-nit'),
  4: gemsReward(90),
  5: cosmetic('frame-brass'),
  6: chipsReward(8000),
  7: gemsReward(110),
  8: cosmetic('back-linen'),
  9: chipsReward(10_000),
  10: cosmetic('emote-riverboat'),
  11: gemsReward(130),
  12: chipsReward(12_000),
  13: cosmetic('title-bankroll-nit'),
  14: gemsReward(140),
  15: cosmetic('felt-molten'),
  16: chipsReward(15_000),
  17: cosmetic('back-jade-scale'),
  18: gemsReward(160),
  19: chipsReward(18_000),
  20: cosmetic('avatar-solar-flare'),
  21: gemsReward(170),
  22: cosmetic('chips-monaco'),
  23: chipsReward(20_000),
  24: gemsReward(180),
  25: cosmetic('frame-serpentine'),
  26: chipsReward(24_000),
  27: cosmetic('skin-oxblood'),
  28: gemsReward(200),
  29: chipsReward(28_000),
  30: cosmetic('title-the-mechanic'),
  31: gemsReward(210),
  32: cosmetic('back-copper-weave'),
  33: chipsReward(32_000),
  34: gemsReward(220),
  35: cosmetic('emote-villain'),
  36: chipsReward(36_000),
  37: cosmetic('frame-glacier'),
  38: gemsReward(240),
  39: chipsReward(40_000),
  40: cosmetic('back-liquid-gold'),
  41: gemsReward(260),
  42: cosmetic('chips-ivory-inlay'),
  43: chipsReward(46_000),
  44: gemsReward(280),
  45: cosmetic('chips-obsidian-royale'),
  46: chipsReward(52_000),
  47: cosmetic('skin-sapphire-room'),
  48: gemsReward(320),
  49: chipsReward(60_000),
  50: cosmetic('skin-black-orchid'),
};

/** The whole ladder, built once. */
export const TIERS: PassTier[] = Array.from({ length: MAX_TIER }, (_, i) => {
  const tier = i + 1;
  return {
    tier,
    xpRequired: xpToReach(tier),
    freeReward: FREE_TRACK[tier] ?? null,
    premiumReward: PREMIUM_TRACK[tier] ?? gemsReward(120),
  };
});

export interface TrackContents {
  cosmetics: number;
  /** cosmetics on this lane that are never sold in the store */
  exclusives: number;
  gems: number;
  chips: number;
  tickets: number;
}

/**
 * What a lane actually pays out. Deliberately reported as its contents rather
 * than a headline "worth N gems!" multiple — the honest version of this claim
 * is the itemised one, and it is the one a player can check.
 */
export function trackContents(track: ClaimTrack): TrackContents {
  const out: TrackContents = { cosmetics: 0, exclusives: 0, gems: 0, chips: 0, tickets: 0 };
  for (const t of TIERS) {
    const r = track === 'free' ? t.freeReward : t.premiumReward;
    if (!r) continue;
    if (r.kind === 'gems') out.gems += r.amount ?? 0;
    else if (r.kind === 'chips') out.chips += r.amount ?? 0;
    else if (r.kind === 'ticket') out.tickets += r.amount ?? 1;
    else if (r.kind === 'cosmetic') {
      out.cosmetics += 1;
      if (r.itemId && itemById(r.itemId)?.priceGems === null) out.exclusives += 1;
    }
  }
  return out;
}

// ─────────────────────────── challenges ───────────────────────────

export type ChallengeMetric =
  | 'hands' | 'wins' | 'showdown-wins' | 'showdowns' | 'raises' | 'allins'
  | 'big-pots' | 'folds' | 'sessions' | 'drills' | 'bombs' | 'premium-hands';

export interface Challenge {
  id: string;
  scope: 'daily' | 'weekly';
  title: string;
  detail: string;
  metric: ChallengeMetric;
  goal: number;
  xp: number;
}

/** Six a day, six a week. Written to be achievable by playing normally. */
export const CHALLENGES: Challenge[] = [
  { id: 'd-hands', scope: 'daily', title: 'Put in an orbit', detail: 'Play 40 hands in any game', metric: 'hands', goal: 40, xp: 320 },
  { id: 'd-wins', scope: 'daily', title: 'Take it down', detail: 'Win 8 pots', metric: 'wins', goal: 8, xp: 300 },
  { id: 'd-showdown', scope: 'daily', title: 'Show it', detail: 'Win 3 hands at showdown', metric: 'showdown-wins', goal: 3, xp: 340 },
  { id: 'd-aggr', scope: 'daily', title: 'Apply pressure', detail: 'Make 15 bets or raises', metric: 'raises', goal: 15, xp: 260 },
  { id: 'd-big', scope: 'daily', title: 'Scoop a big one', detail: 'Win a pot worth 40 big blinds or more', metric: 'big-pots', goal: 1, xp: 380 },
  { id: 'd-drill', scope: 'daily', title: 'Sharpen up', detail: 'Finish one Trainer drill', metric: 'drills', goal: 1, xp: 300 },

  { id: 'w-volume', scope: 'weekly', title: 'The long grind', detail: 'Play 400 hands this week', metric: 'hands', goal: 400, xp: 1600 },
  { id: 'w-wins', scope: 'weekly', title: 'Collector', detail: 'Win 60 pots', metric: 'wins', goal: 60, xp: 1500 },
  { id: 'w-allin', scope: 'weekly', title: 'No fold equity required', detail: 'Get all in 10 times', metric: 'allins', goal: 10, xp: 1400 },
  { id: 'w-sessions', scope: 'weekly', title: 'Show up', detail: 'Play on 5 separate days', metric: 'sessions', goal: 5, xp: 1800 },
  { id: 'w-bomb', scope: 'weekly', title: 'Detonate', detail: 'Play 6 bomb pots', metric: 'bombs', goal: 6, xp: 1300 },
  { id: 'w-showdowns', scope: 'weekly', title: 'Go the distance', detail: 'Reach 40 showdowns', metric: 'showdowns', goal: 40, xp: 1450 },
];

export interface ChallengeState {
  progress: number;
  claimed: boolean;
  /** timestamp the goal was met, for the "done" tick animation */
  completedAt: number | null;
}

interface PassStore {
  seasonIndex: number;
  claimedFree: number[];
  claimedPremium: number[];
  /** local day index the dailies were last rolled */
  dailyDay: number;
  /** local week index the weeklies were last rolled */
  weeklyWeek: number;
  challenges: Record<string, ChallengeState>;
  /** distinct local days played this week, for the `sessions` metric */
  daysPlayed: number[];
  /** lifetime xp earned this season, for the header */
  seasonXp: number;
}

function dayIndex(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / DAY_MS);
}

function weekIndex(now = Date.now()): number {
  // ISO-ish: weeks roll on Monday local time.
  return Math.floor((dayIndex(now) + 3) / 7);
}

function emptyChallenges(scope?: 'daily' | 'weekly'): Record<string, ChallengeState> {
  const out: Record<string, ChallengeState> = {};
  for (const c of CHALLENGES) {
    if (scope && c.scope !== scope) continue;
    out[c.id] = { progress: 0, claimed: false, completedAt: null };
  }
  return out;
}

function freshStore(now: number): PassStore {
  return {
    seasonIndex: seasonAt(now).index,
    claimedFree: [],
    claimedPremium: [],
    dailyDay: dayIndex(now),
    weeklyWeek: weekIndex(now),
    challenges: emptyChallenges(),
    daysPlayed: [],
    seasonXp: 0,
  };
}

function loadStore(): PassStore {
  const now = Date.now();
  const base = freshStore(now);
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<PassStore>;
    const s: PassStore = {
      seasonIndex: typeof p.seasonIndex === 'number' ? p.seasonIndex : base.seasonIndex,
      claimedFree: Array.isArray(p.claimedFree) ? p.claimedFree.filter((n) => typeof n === 'number') : [],
      claimedPremium: Array.isArray(p.claimedPremium) ? p.claimedPremium.filter((n) => typeof n === 'number') : [],
      dailyDay: typeof p.dailyDay === 'number' ? p.dailyDay : base.dailyDay,
      weeklyWeek: typeof p.weeklyWeek === 'number' ? p.weeklyWeek : base.weeklyWeek,
      challenges: { ...emptyChallenges(), ...(p.challenges ?? {}) },
      daysPlayed: Array.isArray(p.daysPlayed) ? p.daysPlayed.filter((n) => typeof n === 'number') : [],
      seasonXp: typeof p.seasonXp === 'number' ? p.seasonXp : 0,
    };
    return s;
  } catch {
    return base;
  }
}

let store = loadStore();

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* memory only */
  }
}

/** Rolls dailies/weeklies and resets the pass when a new season starts. */
function roll(now = Date.now()): boolean {
  let changed = false;
  const season = seasonAt(now);
  if (season.index !== store.seasonIndex) {
    store = freshStore(now);
    setPassProgress(1, 0);
    changed = true;
  }
  const d = dayIndex(now);
  if (d !== store.dailyDay) {
    store.dailyDay = d;
    store.challenges = { ...store.challenges, ...emptyChallenges('daily') };
    changed = true;
  }
  const w = weekIndex(now);
  if (w !== store.weeklyWeek) {
    store.weeklyWeek = w;
    store.challenges = { ...store.challenges, ...emptyChallenges('weekly') };
    store.daysPlayed = [];
    changed = true;
  }
  if (changed) save();
  return changed;
}

// ─────────────────────────── public state ───────────────────────────

export interface PassSnapshot {
  season: Season;
  tier: number;
  xp: number;
  into: number;
  need: number;
  pct: number;
  maxed: boolean;
  premium: boolean;
  /** tiers with an unclaimed reward the player is entitled to */
  claimableFree: number[];
  claimablePremium: number[];
  claimedFree: number[];
  claimedPremium: number[];
  seasonXp: number;
}

const subs = new Set<(s: PassSnapshot) => void>();

export function passState(now = Date.now()): PassSnapshot {
  roll(now);
  const w = econ();
  const pos = positionFor(w.passXp);
  const premium = isPremium();
  const claimableFree: number[] = [];
  const claimablePremium: number[] = [];
  for (const t of TIERS) {
    if (t.tier > pos.tier) break;
    if (t.freeReward && !store.claimedFree.includes(t.tier)) claimableFree.push(t.tier);
    if (premium && !store.claimedPremium.includes(t.tier)) claimablePremium.push(t.tier);
  }
  return {
    season: seasonAt(now),
    tier: pos.tier,
    xp: w.passXp,
    into: pos.into,
    need: pos.need,
    pct: pos.pct,
    maxed: pos.maxed,
    premium,
    claimableFree,
    claimablePremium,
    claimedFree: store.claimedFree.slice(),
    claimedPremium: store.claimedPremium.slice(),
    seasonXp: store.seasonXp,
  };
}

function publish(): void {
  const snap = passState();
  for (const fn of Array.from(subs)) {
    try {
      fn(snap);
    } catch (err) {
      console.error('[pass] subscriber failed', err);
    }
  }
}

export function onPass(fn: (s: PassSnapshot) => void): () => void {
  subs.add(fn);
  fn(passState());
  return () => subs.delete(fn);
}

// ─────────────────────────── xp + claiming ───────────────────────────

export interface XpAward {
  gained: number;
  tier: number;
  leveled: boolean;
  tiersGained: number;
}

/** Adds xp, advances the tier, and publishes `econ:pass-xp`. */
export function awardXp(amount: number): XpAward {
  const n = Math.max(0, Math.round(amount));
  const before = positionFor(econ().passXp).tier;
  if (n === 0) return { gained: 0, tier: before, leveled: false, tiersGained: 0 };
  const nextXp = Math.min(TOTAL_XP, econ().passXp + n);
  const pos = positionFor(nextXp);
  setPassProgress(pos.tier, nextXp);
  store.seasonXp += n;
  save();
  const leveled = pos.tier > before;
  bus.emit('econ:pass-xp', { amount: n, tier: pos.tier, leveled });
  publish();
  return { gained: n, tier: pos.tier, leveled, tiersGained: pos.tier - before };
}

export type ClaimTrack = 'free' | 'premium';

export interface ClaimResult {
  ok: boolean;
  reward?: PassReward;
  message?: string;
}

function payout(reward: PassReward): void {
  switch (reward.kind) {
    case 'gems':
      addGems(reward.amount ?? 0);
      break;
    case 'chips':
      addChips(reward.amount ?? 0);
      break;
    case 'cosmetic':
      if (reward.itemId) grant(reward.itemId, { announce: false });
      break;
    case 'ticket':
      // Tickets are entry credits; until the tournament lobby lands they are
      // paid as their chip equivalent so the reward is never a dead slot.
      addChips(5000);
      break;
  }
}

export function claimTier(tier: number, track: ClaimTrack): ClaimResult {
  const def = TIERS[tier - 1];
  if (!def) return { ok: false, message: 'That tier does not exist.' };
  const snap = passState();
  if (tier > snap.tier) return { ok: false, message: `Reach tier ${tier} to claim this.` };
  if (track === 'premium' && !snap.premium) {
    return { ok: false, message: 'The premium lane needs an active Pass.' };
  }
  const list = track === 'free' ? store.claimedFree : store.claimedPremium;
  if (list.includes(tier)) return { ok: false, message: 'Already claimed.' };
  const reward = track === 'free' ? def.freeReward : def.premiumReward;
  if (!reward) return { ok: false, message: 'Nothing on this tier.' };
  list.push(tier);
  save();
  payout(reward);
  bus.emit('fx:burst', { kind: 'unlock' });
  publish();
  return { ok: true, reward };
}

/** Claims every entitled reward on both lanes. Returns what was collected. */
export function claimAll(): PassReward[] {
  const snap = passState();
  const out: PassReward[] = [];
  for (const tier of snap.claimableFree) {
    const r = claimTier(tier, 'free');
    if (r.ok && r.reward) out.push(r.reward);
  }
  for (const tier of snap.claimablePremium) {
    const r = claimTier(tier, 'premium');
    if (r.ok && r.reward) out.push(r.reward);
  }
  return out;
}

export function isClaimed(tier: number, track: ClaimTrack): boolean {
  return (track === 'free' ? store.claimedFree : store.claimedPremium).includes(tier);
}

// ─────────────────────────── challenge progress ───────────────────────────

export interface ChallengeView extends Challenge {
  progress: number;
  claimed: boolean;
  complete: boolean;
  pct: number;
}

export function challenges(now = Date.now()): ChallengeView[] {
  roll(now);
  return CHALLENGES.map((c) => {
    const st = store.challenges[c.id] ?? { progress: 0, claimed: false, completedAt: null };
    const progress = Math.min(c.goal, st.progress);
    return {
      ...c,
      progress,
      claimed: st.claimed,
      complete: progress >= c.goal,
      pct: c.goal > 0 ? progress / c.goal : 0,
    };
  });
}

/** Advances a metric across every live challenge that tracks it. */
export function trackMetric(metric: ChallengeMetric, amount = 1): void {
  if (amount <= 0) return;
  roll();
  let touched = false;
  for (const c of CHALLENGES) {
    if (c.metric !== metric) continue;
    const st = store.challenges[c.id] ?? (store.challenges[c.id] = { progress: 0, claimed: false, completedAt: null });
    if (st.progress >= c.goal) continue;
    st.progress = Math.min(c.goal, st.progress + amount);
    if (st.progress >= c.goal && st.completedAt === null) {
      st.completedAt = Date.now();
      bus.emit('ui:toast', { text: `Challenge complete — ${c.title}`, tone: 'epic', ms: 2600 });
    }
    touched = true;
  }
  if (touched) {
    save();
    publish();
  }
}

export function claimChallenge(id: string): ClaimResult {
  const def = CHALLENGES.find((c) => c.id === id);
  if (!def) return { ok: false, message: 'Unknown challenge.' };
  const st = store.challenges[id];
  if (!st || st.progress < def.goal) return { ok: false, message: 'Not finished yet.' };
  if (st.claimed) return { ok: false, message: 'Already claimed.' };
  st.claimed = true;
  save();
  awardXp(def.xp);
  bus.emit('fx:burst', { kind: 'level-up' });
  return { ok: true };
}

/** Everything finished and unclaimed, in one tap. */
export function claimAllChallenges(): number {
  let xp = 0;
  for (const c of challenges()) {
    if (c.complete && !c.claimed) {
      const r = claimChallenge(c.id);
      if (r.ok) xp += c.xp;
    }
  }
  return xp;
}

/** Marks today as played, which is what the weekly `sessions` goal counts. */
function markDayPlayed(): void {
  const d = dayIndex();
  if (store.daysPlayed.includes(d)) return;
  store.daysPlayed.push(d);
  save();
  trackMetric('sessions', 1);
}

// ─────────────────────────── xp from play ───────────────────────────

/** Base xp for finishing a hand, before the bonuses below. */
const XP_HAND = 6;
const XP_WIN = 14;
const XP_SHOWDOWN = 10;
const XP_SHOWDOWN_WIN = 22;
const XP_ALLIN = 18;

let wired = false;
let bigBlind = 1;

/**
 * Subscribes the pass to the table. Idempotent — the shell can call it on
 * boot and the pass screen can call it defensively.
 */
export function wirePassToPlay(): () => void {
  if (wired) return () => undefined;
  wired = true;
  const offs: Array<() => void> = [];

  offs.push(bus.on('table:state', ({ state }) => {
    bigBlind = state.stake?.bb ?? bigBlind;
  }));

  offs.push(bus.on('hand:end', () => {
    markDayPlayed();
    awardXp(XP_HAND);
    trackMetric('hands', 1);
  }));

  offs.push(bus.on('hand:action', ({ action }) => {
    if (action.kind === 'bet' || action.kind === 'raise') trackMetric('raises', 1);
    if (action.kind === 'allin') {
      trackMetric('allins', 1);
      awardXp(XP_ALLIN);
    }
    if (action.kind === 'fold') trackMetric('folds', 1);
  }));

  offs.push(bus.on('hand:showdown', ({ results }) => {
    trackMetric('showdowns', 1);
    awardXp(XP_SHOWDOWN);
    const winner = results.find((r) => r.won > 0 && !r.mucked);
    if (winner) {
      trackMetric('showdown-wins', 1);
      awardXp(XP_SHOWDOWN_WIN);
    }
  }));

  offs.push(bus.on('hand:award', ({ amount }) => {
    trackMetric('wins', 1);
    awardXp(XP_WIN);
    if (bigBlind > 0 && amount / bigBlind >= 40) trackMetric('big-pots', 1);
  }));

  offs.push(bus.on('gto:drill-complete', () => {
    trackMetric('drills', 1);
    awardXp(240);
  }));

  offs.push(bus.on('fx:burst', ({ kind }) => {
    if (kind === 'bomb') trackMetric('bombs', 1);
  }));

  return () => {
    for (const off of offs) off();
    wired = false;
  };
}

/**
 * Seeds a believable mid-season position for a brand-new install so the pass
 * screen never opens on tier 1 with an empty track. Only runs once.
 */
export function seedPassIfEmpty(): void {
  const w = econ();
  if (w.passXp > 0 || store.claimedFree.length > 0) return;
  const elapsed = seasonProgress();
  // Roughly on-pace-but-behind: two thirds of the season's expected xp.
  const target = Math.round(TOTAL_XP * Math.min(0.46, Math.max(0.08, elapsed * 0.62)));
  const pos = positionFor(target);
  setPassProgress(pos.tier, target);
  store.seasonXp = target;
  // The first handful of free rewards have already been collected.
  for (const t of TIERS) {
    if (t.tier >= Math.max(1, pos.tier - 3)) break;
    if (t.freeReward) {
      store.claimedFree.push(t.tier);
      payout(t.freeReward);
    }
  }
  // Progress on a couple of challenges, so the list is not a row of zeroes.
  const seedProgress: Record<string, number> = {
    'd-hands': 26, 'd-wins': 5, 'd-aggr': 11, 'w-volume': 268, 'w-wins': 41, 'w-showdowns': 27, 'w-sessions': 3,
  };
  for (const [id, v] of Object.entries(seedProgress)) {
    const c = CHALLENGES.find((x) => x.id === id);
    if (!c) continue;
    store.challenges[id] = { progress: Math.min(c.goal, v), claimed: false, completedAt: null };
  }
  save();
  publish();
}

// ─────────────────────────── premium purchase ───────────────────────────

export interface PassOffer {
  id: string;
  label: string;
  /** what the player pays, in gems */
  gems: number;
  /** tiers granted immediately */
  tiers: number;
  days: number;
  blurb: string;
}

/**
 * The two ways in. The bundle is priced so it is obviously the better deal
 * without hiding the arithmetic — the value line on the screen states the
 * gem-equivalent of everything the premium lane pays out.
 */
export const PASS_OFFERS: PassOffer[] = [
  {
    id: 'pass-premium',
    label: 'Premium Pass',
    gems: 950,
    tiers: 0,
    days: 70,
    blurb: 'Unlocks the premium lane for the whole season, including every tier you have already passed.',
  },
  {
    id: 'pass-bundle',
    label: 'Premium + 20 Tiers',
    gems: 2200,
    tiers: 20,
    days: 70,
    blurb: 'The same pass, plus a twenty-tier head start. Worth it if the season is already half gone.',
  },
];

export interface PassPurchase {
  ok: boolean;
  message?: string;
}

/** Buys a pass offer with gems and back-pays the premium lane. */
export function buyPass(offer: PassOffer): PassPurchase {
  const spend = spendGems(offer.gems);
  if (!spend.ok) return { ok: false, message: spend.message ?? 'Not enough gems.' };
  grantPremium(offer.days);
  if (offer.tiers > 0) {
    const target = xpToReach(Math.min(MAX_TIER, positionFor(econ().passXp).tier + offer.tiers));
    const delta = Math.max(0, target - econ().passXp);
    if (delta > 0) awardXp(delta);
  }
  publish();
  bus.emit('fx:burst', { kind: 'confetti' });
  bus.emit('ui:toast', { text: 'Premium Pass active — the second lane is yours', tone: 'epic', ms: 3200 });
  return { ok: true };
}

// A fresh install opens on a lived-in season rather than an empty track.
seedPassIfEmpty();
