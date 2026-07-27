/**
 * ROYALE — gto/session.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Everything that persists between drills: per-drill accuracy, streaks, EV
 * lost, a leak report, and a spaced-repetition queue that brings back the
 * exact spots you got wrong.
 *
 * REPEATING A SPOT EXACTLY
 *   Spots are generated from a seed, so a miss is stored as
 *   `{ drill, tier, seed }` and regenerating it reproduces the same seat, the
 *   same hand and the same board. That is the whole trick — no spot state has
 *   to be serialised, and a repeat is byte-identical to the original.
 *
 * THE LEITNER SCHEDULE
 *   A miss goes into box 0 and comes back after three more spots. Get it right
 *   and it moves up a box; the gaps run 3, 8, 20, 45, 100 spots. Miss it again
 *   and it drops straight back to box 0. Intervals are counted in *spots seen*,
 *   not wall-clock time, so a five-minute session and a five-day gap schedule
 *   the same way.
 *
 * LEAKS
 *   Every attempt is bucketed by drill, seat, and the direction of the error —
 *   folding something the solution continues with, continuing with something
 *   it folds, or picking the wrong size. A bucket becomes a reported leak once
 *   it has four attempts and a mistake rate over 35%, and leaks are ranked by
 *   total EV surrendered rather than by count, so the one costing you real
 *   money sits at the top.
 */

import { bus } from '../core/bus.ts';
import { Rng } from '../core/rng.ts';
import type { PositionName, TrainerVerdict } from '../core/types.ts';
import { DRILLS, drillById, generateSpot, handLabelOf } from './drills.ts';
import type { DrillId, Spot, Tier, Verdict } from './drills.ts';
import { positionLabel, positionLong } from './ranges.ts';

const STORE_KEY = 'royale.trainer.v1';
const SCHEMA = 1;

// ═══════════════════════════ stored shapes ═══════════════════════════

export interface TierRecord {
  attempts: number;
  correct: number;
}

export interface DrillStats {
  drill: DrillId;
  attempts: number;
  correct: number;
  evLostBb: number;
  bestStreak: number;
  lastPlayedAt: number;
  byTier: Record<Tier, TierRecord>;
  /** rolling accuracy over the last 20 attempts, oldest first */
  recent: number[];
}

export interface Attempt {
  key: string;
  drill: DrillId;
  tier: Tier;
  seed: number;
  heroPos: PositionName;
  handLabel: string;
  chosen: string;
  optimal: string;
  chosenLabel: string;
  optimalLabel: string;
  score: number;
  evLossBb: number;
  at: number;
}

export interface RepeatItem {
  key: string;
  drill: DrillId;
  tier: Tier;
  seed: number;
  /** Leitner box, 0 = just missed */
  box: number;
  /** spot counter at which this becomes due again */
  dueAtCount: number;
}

export interface TrainerProfile {
  version: number;
  drills: Partial<Record<DrillId, DrillStats>>;
  attempts: Attempt[];
  repeats: RepeatItem[];
  /** total spots ever seen — the clock the Leitner schedule runs on */
  spotsSeen: number;
  totalEvLostBb: number;
  bestStreak: number;
  createdAt: number;
}

export interface Leak {
  id: string;
  title: string;
  detail: string;
  drill: DrillId;
  /** 0–1, share of the bucket that went wrong */
  rate: number;
  attempts: number;
  evLostBb: number;
  /** 0–1, ranking weight */
  severity: number;
}

// ═══════════════════════════ storage ═══════════════════════════

function blankStats(drill: DrillId): DrillStats {
  return {
    drill,
    attempts: 0,
    correct: 0,
    evLostBb: 0,
    bestStreak: 0,
    lastPlayedAt: 0,
    byTier: { core: { attempts: 0, correct: 0 }, sharp: { attempts: 0, correct: 0 }, expert: { attempts: 0, correct: 0 } },
    recent: [],
  };
}

function blankProfile(): TrainerProfile {
  return {
    version: SCHEMA,
    drills: {},
    attempts: [],
    repeats: [],
    spotsSeen: 0,
    totalEvLostBb: 0,
    bestStreak: 0,
    createdAt: Date.now(),
  };
}

let profile: TrainerProfile | null = null;
const listeners = new Set<(p: TrainerProfile) => void>();

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__royale_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function loadProfile(): TrainerProfile {
  if (profile) return profile;
  const store = storage();
  if (store) {
    try {
      const raw = store.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as TrainerProfile;
        if (parsed && parsed.version === SCHEMA && parsed.drills) {
          profile = { ...blankProfile(), ...parsed };
          return profile;
        }
      }
    } catch {
      // Corrupt or foreign data: start clean rather than crash the screen.
    }
  }
  profile = blankProfile();
  return profile;
}

export function saveProfile(): void {
  const p = loadProfile();
  const store = storage();
  if (!store) return;
  try {
    // Keep the attempt log bounded — 400 entries is ~40KB and plenty for the
    // leak report, which only reads the last 200.
    const trimmed: TrainerProfile = { ...p, attempts: p.attempts.slice(-400), repeats: p.repeats.slice(-300) };
    store.setItem(STORE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota or private mode. Stats stay in memory for this session.
  }
}

export function resetProfile(): void {
  profile = blankProfile();
  const store = storage();
  try {
    store?.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
  emit();
}

export function onProfile(fn: (p: TrainerProfile) => void, immediate = true): () => void {
  listeners.add(fn);
  if (immediate) fn(loadProfile());
  return () => listeners.delete(fn);
}

function emit(): void {
  const p = loadProfile();
  for (const fn of Array.from(listeners)) {
    try {
      fn(p);
    } catch (err) {
      console.error('[gto/session] listener failed', err);
    }
  }
}

export function statsFor(drill: DrillId): DrillStats {
  const p = loadProfile();
  return p.drills[drill] ?? blankStats(drill);
}

/** 0–1 mastery for a drill's progress ring: accuracy, damped by volume. */
export function masteryOf(drill: DrillId): number {
  const s = statsFor(drill);
  if (s.attempts === 0) return 0;
  const accuracy = s.correct / s.attempts;
  const confidence = Math.min(1, s.attempts / 30);
  return accuracy * confidence;
}

export function totalHands(): number {
  const p = loadProfile();
  let n = 0;
  for (const d of DRILLS) n += p.drills[d.id]?.attempts ?? 0;
  return n;
}

// ═══════════════════════════ spaced repetition ═══════════════════════════

/** Gaps, in spots seen, between reviews at each Leitner box. */
const BOX_GAPS = [3, 8, 20, 45, 100];

function scheduleRepeat(p: TrainerProfile, spot: Spot, correct: boolean): void {
  const seed = spot.sourceSeed ?? 0;
  if (!seed) return;
  const i = p.repeats.findIndex((r) => r.key === spot.key);
  if (!correct) {
    const item: RepeatItem = {
      key: spot.key,
      drill: spot.drill,
      tier: spot.tier,
      seed,
      box: 0,
      dueAtCount: p.spotsSeen + BOX_GAPS[0],
    };
    if (i >= 0) p.repeats[i] = item;
    else p.repeats.push(item);
    return;
  }
  if (i < 0) return;
  const item = p.repeats[i];
  item.box += 1;
  if (item.box >= BOX_GAPS.length) {
    p.repeats.splice(i, 1);
    return;
  }
  item.dueAtCount = p.spotsSeen + BOX_GAPS[item.box];
}

/** Repeats due now, oldest first. */
export function dueRepeats(drill?: DrillId): RepeatItem[] {
  const p = loadProfile();
  return p.repeats
    .filter((r) => r.dueAtCount <= p.spotsSeen && (!drill || r.drill === drill))
    .sort((a, b) => a.dueAtCount - b.dueAtCount);
}

export function repeatCount(drill?: DrillId): number {
  const p = loadProfile();
  return p.repeats.filter((r) => !drill || r.drill === drill).length;
}

// ═══════════════════════════ the live session ═══════════════════════════

export interface SessionSummary {
  drill: DrillId;
  tier: Tier;
  hands: number;
  correct: number;
  accuracy: number;
  evLostBb: number;
  evLostPerHand: number;
  bestStreak: number;
  streak: number;
  /** score 0–100 for the share card */
  grade: number;
  gradeLabel: string;
  mistakes: Verdict[];
  leaks: Leak[];
  startedAt: number;
  endedAt: number;
}

export interface Session {
  readonly id: string;
  readonly drill: DrillId;
  readonly tier: Tier;
  /** the next spot, taken from the repeat queue when one is due */
  next(): Spot;
  /** true when the spot just served came from the repeat queue */
  wasRepeat(): boolean;
  record(spot: Spot, verdict: Verdict): void;
  state(): TrainerSessionState;
  summary(): SessionSummary;
  end(): SessionSummary;
}

export interface TrainerSessionState {
  id: string;
  drill: DrillId;
  handsPlayed: number;
  totalScore: number;
  evLostBb: number;
  streak: number;
  bestStreak: number;
  mistakes: TrainerVerdict[];
}

let sessionSeq = 0;

export function startSession(drill: DrillId, tier: Tier = 'core', seed?: number): Session {
  sessionSeq += 1;
  const id = `ts-${Date.now().toString(36)}-${sessionSeq}`;
  const rng = new Rng(seed ?? ((Math.random() * 0xffffffff) >>> 0));
  const startedAt = Date.now();

  let hands = 0;
  let correct = 0;
  let totalScore = 0;
  let evLost = 0;
  let streak = 0;
  let bestStreak = 0;
  let fromRepeat = false;
  const mistakes: Verdict[] = [];

  const state = (): TrainerSessionState => ({
    id,
    drill,
    handsPlayed: hands,
    totalScore,
    evLostBb: evLost,
    streak,
    bestStreak,
    mistakes,
  });

  const summary = (): SessionSummary => {
    const accuracy = hands > 0 ? correct / hands : 0;
    const perHand = hands > 0 ? evLost / hands : 0;
    // 100 points for perfect play; EV loss costs more than a wrong label does,
    // because that is what actually shows up in your win rate.
    const grade = Math.round(clamp01(accuracy * 0.65 + clamp01(1 - perHand / 0.6) * 0.35) * 100);
    return {
      drill,
      tier,
      hands,
      correct,
      accuracy,
      evLostBb: evLost,
      evLostPerHand: perHand,
      bestStreak,
      streak,
      grade,
      gradeLabel: gradeLabelFor(grade),
      mistakes: mistakes.slice(-8),
      leaks: leakReport(drill),
      startedAt,
      endedAt: Date.now(),
    };
  };

  return {
    id,
    drill,
    tier,
    next(): Spot {
      const p = loadProfile();
      const due = dueRepeats(drill);
      if (due.length && hands > 0) {
        const item = due[0];
        fromRepeat = true;
        const spot = generateSpot(item.drill, new Rng(item.seed), item.tier);
        spot.sourceSeed = item.seed;
        return spot;
      }
      fromRepeat = false;
      const spotSeed = rng.nextU32();
      const spot = generateSpot(drill, new Rng(spotSeed), tier);
      spot.sourceSeed = spotSeed;
      void p;
      return spot;
    },
    wasRepeat: () => fromRepeat,
    record(spot, verdict) {
      const p = loadProfile();
      hands += 1;
      totalScore += verdict.score;
      evLost += verdict.evLossBb;
      if (verdict.correct) {
        correct += 1;
        streak += 1;
        if (streak > bestStreak) bestStreak = streak;
      } else {
        streak = 0;
        mistakes.push(verdict);
      }

      const stats = p.drills[spot.drill] ?? blankStats(spot.drill);
      stats.attempts += 1;
      if (verdict.correct) stats.correct += 1;
      stats.evLostBb += verdict.evLossBb;
      stats.bestStreak = Math.max(stats.bestStreak, bestStreak);
      stats.lastPlayedAt = Date.now();
      stats.byTier[spot.tier].attempts += 1;
      if (verdict.correct) stats.byTier[spot.tier].correct += 1;
      stats.recent.push(verdict.correct ? 1 : 0);
      if (stats.recent.length > 20) stats.recent.shift();
      p.drills[spot.drill] = stats;

      p.spotsSeen += 1;
      p.totalEvLostBb += verdict.evLossBb;
      p.bestStreak = Math.max(p.bestStreak, bestStreak);
      p.attempts.push({
        key: spot.key,
        drill: spot.drill,
        tier: spot.tier,
        seed: spot.sourceSeed ?? 0,
        heroPos: spot.heroPos,
        handLabel: handLabelOf(spot),
        chosen: verdict.chosen,
        optimal: verdict.optimal,
        chosenLabel: verdict.strategy.labels[verdict.chosen] ?? verdict.chosen,
        optimalLabel: verdict.strategy.labels[verdict.optimal] ?? verdict.optimal,
        score: verdict.score,
        evLossBb: verdict.evLossBb,
        at: Date.now(),
      });
      if (p.attempts.length > 400) p.attempts.splice(0, p.attempts.length - 400);

      scheduleRepeat(p, spot, verdict.correct);
      saveProfile();
      emit();
      bus.emit('gto:verdict', { verdict });
    },
    state,
    summary,
    end(): SessionSummary {
      const s = summary();
      bus.emit('gto:drill-complete', { score: s.grade, hands: s.hands });
      return s;
    },
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function gradeLabelFor(grade: number): string {
  if (grade >= 95) return 'Solver';
  if (grade >= 88) return 'Crushing';
  if (grade >= 78) return 'Solid';
  if (grade >= 66) return 'Getting there';
  if (grade >= 50) return 'Leaky';
  return 'Needs work';
}

// ═══════════════════════════ leak report ═══════════════════════════

type Direction = 'too-tight' | 'too-loose' | 'wrong-size' | 'ok';

const PASSIVE = new Set(['fold']);
const AGGRO = new Set(['raise', '3bet', '4bet', 'squeeze', 'jam', 'limp']);

function directionOf(chosen: string, optimal: string): Direction {
  if (chosen === optimal) return 'ok';
  if (PASSIVE.has(chosen) && !PASSIVE.has(optimal)) return 'too-tight';
  if (!PASSIVE.has(chosen) && PASSIVE.has(optimal)) return 'too-loose';
  if (chosen.startsWith('bet-') && optimal.startsWith('bet-')) return 'wrong-size';
  if (AGGRO.has(chosen) && optimal === 'call') return 'too-loose';
  if (chosen === 'call' && AGGRO.has(optimal)) return 'too-tight';
  return 'wrong-size';
}

interface Bucket {
  drill: DrillId;
  pos: PositionName;
  dir: Direction;
  attempts: number;
  wrong: number;
  evLost: number;
}

const DIRECTION_TEXT: Record<Exclude<Direction, 'ok'>, string> = {
  'too-tight': 'over-fold',
  'too-loose': 'continue too wide',
  'wrong-size': 'pick the wrong size',
};

/**
 * Builds the leak list from the last 200 attempts. Buckets need four attempts
 * and a 35% miss rate before they are reported, so one bad guess never turns
 * into a diagnosis.
 */
export function leakReport(drill?: DrillId, limit = 4): Leak[] {
  const p = loadProfile();
  const recent = p.attempts.slice(-200).filter((a) => !drill || a.drill === drill);
  const buckets = new Map<string, Bucket>();

  for (const a of recent) {
    const dir = directionOf(a.chosen, a.optimal);
    const key = `${a.drill}|${a.heroPos}|${dir === 'ok' ? 'ok' : dir}`;
    let b = buckets.get(key);
    if (!b) {
      b = { drill: a.drill, pos: a.heroPos, dir, attempts: 0, wrong: 0, evLost: 0 };
      buckets.set(key, b);
    }
    b.attempts += 1;
    if (dir !== 'ok') {
      b.wrong += 1;
      b.evLost += a.evLossBb;
    }
  }

  // Attempts per (drill, seat) so a rate means something.
  const seatTotals = new Map<string, number>();
  for (const a of recent) {
    const k = `${a.drill}|${a.heroPos}`;
    seatTotals.set(k, (seatTotals.get(k) ?? 0) + 1);
  }

  const leaks: Leak[] = [];
  for (const b of buckets.values()) {
    if (b.dir === 'ok') continue;
    const total = seatTotals.get(`${b.drill}|${b.pos}`) ?? b.attempts;
    if (total < 4 || b.wrong / total < 0.35) continue;
    const def = drillById(b.drill);
    const rate = b.wrong / total;
    leaks.push({
      id: `${b.drill}-${b.pos}-${b.dir}`,
      title: `You ${DIRECTION_TEXT[b.dir as Exclude<Direction, 'ok'>]} from ${positionLabel(b.pos)}`,
      detail:
        `${Math.round(rate * 100)}% of your ${def?.name.toLowerCase() ?? b.drill} decisions from ` +
        `${positionLong(b.pos)} went the wrong way, costing ${b.evLost.toFixed(2)}bb across ${b.wrong} spots.`,
      drill: b.drill,
      rate,
      attempts: total,
      evLostBb: b.evLost,
      severity: clamp01(b.evLost / 4) * 0.7 + rate * 0.3,
    });
  }

  leaks.sort((a, b) => b.severity - a.severity);
  return leaks.slice(0, limit);
}

/** The drill the profile says you should play next, and why. */
export function recommendation(): { drill: DrillId; reason: string } {
  const p = loadProfile();
  // Anything the spaced-repetition queue has waiting outranks everything
  // else — those are spots you have already proved you get wrong.
  const due = dueRepeats();
  if (due.length) {
    const counts = new Map<DrillId, number>();
    for (const r of due) counts.set(r.drill, (counts.get(r.drill) ?? 0) + 1);
    let top = due[0].drill;
    for (const [drill, n] of counts) if (n > (counts.get(top) ?? 0)) top = drill;
    const n = counts.get(top) ?? 0;
    return {
      drill: top,
      reason: `${n} spot${n === 1 ? '' : 's'} you missed ${n === 1 ? 'is' : 'are'} due for another look`,
    };
  }
  const leaks = leakReport(undefined, 1);
  if (leaks.length) {
    return { drill: leaks[0].drill, reason: leaks[0].title };
  }
  const unplayed = DRILLS.find((d) => (p.drills[d.id]?.attempts ?? 0) === 0);
  if (unplayed) return { drill: unplayed.id, reason: 'You have not tried this one yet' };
  let worst = DRILLS[0];
  let worstRate = 2;
  for (const d of DRILLS) {
    const s = p.drills[d.id];
    if (!s || s.attempts < 5) continue;
    const rate = s.correct / s.attempts;
    if (rate < worstRate) {
      worstRate = rate;
      worst = d;
    }
  }
  return { drill: worst.id, reason: `Your weakest drill at ${Math.round(worstRate * 100)}% accuracy` };
}

/** One-line share text for the summary card. */
export function shareText(s: SessionSummary): string {
  const def = drillById(s.drill);
  return (
    `ROYALE trainer — ${def?.name ?? s.drill} (${s.tier})\n` +
    `${s.correct}/${s.hands} correct · ${Math.round(s.accuracy * 100)}% · ` +
    `${s.evLostBb.toFixed(2)}bb lost · best streak ${s.bestStreak}\n` +
    `Grade ${s.grade} — ${s.gradeLabel}`
  );
}
