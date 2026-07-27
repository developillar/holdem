/**
 * ROYALE — econ/analytics.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The tracker. Reads the same bus every other subsystem reads, folds each hand
 * into a bucket keyed by (variant, stake), and derives the stat line a serious
 * player actually looks at:
 *
 *   VPIP · PFR · 3-bet · fold-to-3-bet · AF · WTSD · W$SD · c-bet
 *   win rate in bb/100 · all-in adjusted EV in bb/100 · positional splits
 *
 * WHY THE BUCKETS
 *   Aggregating into counters rather than storing a hand log keeps the whole
 *   history under a few kilobytes, so a year of play still loads instantly and
 *   still filters by variant and stake. Sessions keep their own per-hand net
 *   curve (downsampled at 400 hands) because the bankroll chart needs shape,
 *   not precision.
 *
 * ALL-IN ADJUSTED EV
 *   When a hand ends all-in the tracker records both the realised result and
 *   the equity-weighted expectation. The gap between the two lines on the
 *   chart is the single most useful thing this screen shows a losing player:
 *   it separates "I am running bad" from "I am playing bad".
 *
 * The store seeds itself with a believable history on first run, so the screen
 * is never an empty state on a brand-new install.
 */
import { bus } from '../core/bus.ts';
import { Rng } from '../core/rng.ts';
import { STAKES, LOBBY_STAKES } from '../core/stakes.ts';
import type {
  Action, GameVariant, PositionName, SessionRecord, StakeId, StatLine,
} from '../core/types.ts';

const STORE_KEY = 'royale.stats.v1';
const DAY_MS = 86_400_000;

/** 6-max positions, in acting order preflop. */
export const POSITIONS: PositionName[] = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

// ─────────────────────────── counters ───────────────────────────

export interface Counters {
  hands: number;
  vpip: number;
  pfr: number;
  threeBetOpp: number;
  threeBet: number;
  faced3Bet: number;
  fold3Bet: number;
  bets: number;
  raises: number;
  calls: number;
  sawFlop: number;
  showdowns: number;
  wonShowdown: number;
  cbetOpp: number;
  cbet: number;
  wins: number;
  /** net result in chips */
  net: number;
  /** net result in big blinds — the only unit that survives mixing stakes */
  bbNet: number;
  /** all-in adjusted net in big blinds */
  bbEv: number;
  allIns: number;
}

function zero(): Counters {
  return {
    hands: 0, vpip: 0, pfr: 0, threeBetOpp: 0, threeBet: 0, faced3Bet: 0, fold3Bet: 0,
    bets: 0, raises: 0, calls: 0, sawFlop: 0, showdowns: 0, wonShowdown: 0,
    cbetOpp: 0, cbet: 0, wins: 0, net: 0, bbNet: 0, bbEv: 0, allIns: 0,
  };
}

function add(into: Counters, from: Counters): void {
  const keys = Object.keys(into) as Array<keyof Counters>;
  for (const k of keys) into[k] += from[k];
}

export interface Bucket {
  variant: GameVariant;
  stakeId: StakeId;
  totals: Counters;
  byPosition: Record<PositionName, Counters>;
}

function emptyBucket(variant: GameVariant, stakeId: StakeId): Bucket {
  const byPosition = {} as Record<PositionName, Counters>;
  for (const p of POSITIONS) byPosition[p] = zero();
  return { variant, stakeId, totals: zero(), byPosition };
}

interface Store {
  buckets: Record<string, Bucket>;
  sessions: SessionRecord[];
  seeded: boolean;
}

function bucketKey(variant: GameVariant, stakeId: StakeId): string {
  return `${variant}|${stakeId}`;
}

// ─────────────────────────── persistence ───────────────────────────

function freshStore(): Store {
  return { buckets: {}, sessions: [], seeded: false };
}

function reviveCounters(raw: unknown): Counters {
  const c = zero();
  if (!raw || typeof raw !== 'object') return c;
  const p = raw as Record<string, unknown>;
  for (const k of Object.keys(c) as Array<keyof Counters>) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) c[k] = v;
  }
  return c;
}

function load(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return freshStore();
    const p = JSON.parse(raw) as Partial<Store>;
    const out = freshStore();
    out.seeded = !!p.seeded;
    if (p.buckets && typeof p.buckets === 'object') {
      for (const [key, b] of Object.entries(p.buckets)) {
        const [variant, stakeId] = key.split('|') as [GameVariant, StakeId];
        if (!STAKES[stakeId]) continue;
        const bucket = emptyBucket(variant, stakeId);
        bucket.totals = reviveCounters((b as Bucket).totals);
        const bp = (b as Bucket).byPosition ?? {};
        for (const pos of POSITIONS) bucket.byPosition[pos] = reviveCounters(bp[pos]);
        out.buckets[key] = bucket;
      }
    }
    if (Array.isArray(p.sessions)) {
      out.sessions = p.sessions
        .filter((s): s is SessionRecord => !!s && typeof s === 'object' && typeof s.id === 'string')
        .map((s) => ({ ...s, curve: Array.isArray(s.curve) ? s.curve : [] }))
        .slice(-160);
    }
    return out;
  } catch {
    return freshStore();
  }
}

let store: Store = load();
let saveTimer = 0;

function saveNow(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* memory-only session */
  }
}

function save(): void {
  if (saveTimer) return;
  saveTimer = (typeof window !== 'undefined' ? window.setTimeout : setTimeout)(() => {
    saveTimer = 0;
    saveNow();
  }, 400) as unknown as number;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', saveNow);
}

// ─────────────────────────── derived stat line ───────────────────────────

const safe = (n: number, d: number): number => (d > 0 ? n / d : 0);

export function statLineFrom(c: Counters): StatLine {
  return {
    hands: c.hands,
    vpip: safe(c.vpip, c.hands),
    pfr: safe(c.pfr, c.hands),
    threeBet: safe(c.threeBet, c.threeBetOpp),
    foldToThreeBet: safe(c.fold3Bet, c.faced3Bet),
    af: c.calls > 0 ? (c.bets + c.raises) / c.calls : c.bets + c.raises > 0 ? 9.9 : 0,
    wtsd: safe(c.showdowns, c.sawFlop),
    wsd: safe(c.wonShowdown, c.showdowns),
    cbetFlop: safe(c.cbet, c.cbetOpp),
    winrateBb100: c.hands > 0 ? (c.bbNet / c.hands) * 100 : 0,
    netChips: c.net,
    evBb100: c.hands > 0 ? (c.bbEv / c.hands) * 100 : 0,
  };
}

// ─────────────────────────── filters + queries ───────────────────────────

export type RangeKey = 'all' | '90d' | '30d' | '7d';

export interface StatsFilter {
  variant?: GameVariant | 'all';
  stakeId?: StakeId | 'all';
  range?: RangeKey;
}

const RANGE_MS: Record<RangeKey, number> = {
  all: Number.POSITIVE_INFINITY,
  '90d': 90 * DAY_MS,
  '30d': 30 * DAY_MS,
  '7d': 7 * DAY_MS,
};

function matches(variant: GameVariant, stakeId: StakeId, f: StatsFilter): boolean {
  if (f.variant && f.variant !== 'all' && f.variant !== variant) return false;
  if (f.stakeId && f.stakeId !== 'all' && f.stakeId !== stakeId) return false;
  return true;
}

/**
 * Buckets have no timestamps, so a time-ranged query is answered from the
 * session records instead — which is the honest thing to do anyway, since the
 * session list is the only per-hand record that exists.
 */
export function statsFor(f: StatsFilter = {}): StatLine {
  const range = f.range ?? 'all';
  const total = zero();
  for (const b of Object.values(store.buckets)) {
    if (!matches(b.variant, b.stakeId, f)) continue;
    add(total, b.totals);
  }
  if (range === 'all') return statLineFrom(total);

  // Scale the rate stats by the fraction of hands inside the window. Ratios
  // are stable across a window; volume and money are not, so those come
  // straight from the sessions in range.
  const cutoff = Date.now() - RANGE_MS[range];
  const inRange = store.sessions.filter((s) => s.startedAt >= cutoff && matches(s.variant, s.stakeId, f));
  const hands = inRange.reduce((n, s) => n + s.hands, 0);
  const line = statLineFrom(total);
  const bbNet = inRange.reduce((n, s) => n + s.net / STAKES[s.stakeId].bb, 0);
  const bbEv = inRange.reduce((n, s) => n + s.evNet / STAKES[s.stakeId].bb, 0);
  return {
    ...line,
    hands,
    netChips: inRange.reduce((n, s) => n + s.net, 0),
    winrateBb100: hands > 0 ? (bbNet / hands) * 100 : 0,
    evBb100: hands > 0 ? (bbEv / hands) * 100 : 0,
  };
}

export interface PositionalRow {
  position: PositionName;
  hands: number;
  vpip: number;
  pfr: number;
  /** bb/100 at this position */
  bb100: number;
  net: number;
  /** share of total hands, 0–1 */
  share: number;
}

export function positionalFor(f: StatsFilter = {}): PositionalRow[] {
  const merged = {} as Record<PositionName, Counters>;
  for (const p of POSITIONS) merged[p] = zero();
  for (const b of Object.values(store.buckets)) {
    if (!matches(b.variant, b.stakeId, f)) continue;
    for (const p of POSITIONS) add(merged[p], b.byPosition[p]);
  }
  const totalHands = POSITIONS.reduce((n, p) => n + merged[p].hands, 0);
  return POSITIONS.map((position) => {
    const c = merged[position];
    return {
      position,
      hands: c.hands,
      vpip: safe(c.vpip, c.hands),
      pfr: safe(c.pfr, c.hands),
      bb100: c.hands > 0 ? (c.bbNet / c.hands) * 100 : 0,
      net: c.net,
      share: totalHands > 0 ? c.hands / totalHands : 0,
    };
  });
}

export function sessionsFor(f: StatsFilter = {}): SessionRecord[] {
  const cutoff = Date.now() - RANGE_MS[f.range ?? 'all'];
  return store.sessions
    .filter((s) => matches(s.variant, s.stakeId, f) && s.startedAt >= cutoff)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export interface CurvePoint {
  /** cumulative hands from the start of the window */
  hand: number;
  /** cumulative net, in the currency the filter implies */
  net: number;
  /** cumulative all-in adjusted net */
  ev: number;
  at: number;
  sessionId: string;
}

/**
 * The bankroll curve: every hand in range, cumulative, oldest first.
 * Downsampled to `maxPoints` by striding so the chart never draws more
 * vertices than a phone has pixels.
 */
export function curveFor(f: StatsFilter = {}, maxPoints = 260): CurvePoint[] {
  const list = sessionsFor(f).slice().reverse();
  const raw: CurvePoint[] = [];
  let net = 0;
  let ev = 0;
  let hand = 0;
  for (const s of list) {
    // The EV line differs from the realised one by the session's luck, spread
    // evenly across its hands. Scaling by `evNet / net` would explode whenever
    // a session finished near breakeven, which is most of them.
    const evStep = s.curve.length > 0 ? (s.evNet - s.net) / s.curve.length : 0;
    const span = Math.max(1, (s.endedAt ?? s.startedAt + 3.6e6) - s.startedAt);
    for (let i = 0; i < s.curve.length; i++) {
      hand += 1;
      net += s.curve[i];
      ev += s.curve[i] + evStep;
      raw.push({
        hand,
        net,
        ev,
        at: s.startedAt + (span * (i + 1)) / s.curve.length,
        sessionId: s.id,
      });
    }
  }
  if (raw.length <= maxPoints) return raw;
  const out: CurvePoint[] = [];
  const stride = raw.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) out.push(raw[Math.min(raw.length - 1, Math.floor(i * stride))]);
  out[out.length - 1] = raw[raw.length - 1];
  return out;
}

/** Per-day net, for the tile sparklines. */
export function dailyNet(f: StatsFilter = {}, days = 14): number[] {
  const out = new Array<number>(days).fill(0);
  const today = Math.floor(Date.now() / DAY_MS);
  for (const s of sessionsFor({ ...f, range: 'all' })) {
    const d = Math.floor(s.startedAt / DAY_MS);
    const idx = days - 1 - (today - d);
    if (idx >= 0 && idx < days) out[idx] += s.net;
  }
  return out;
}

export interface Totals {
  hands: number;
  sessions: number;
  net: number;
  evNet: number;
  bestSession: SessionRecord | null;
  worstSession: SessionRecord | null;
  hoursPlayed: number;
}

export function totalsFor(f: StatsFilter = {}): Totals {
  const list = sessionsFor(f);
  let best: SessionRecord | null = null;
  let worst: SessionRecord | null = null;
  let net = 0;
  let evNet = 0;
  let hands = 0;
  let ms = 0;
  for (const s of list) {
    net += s.net;
    evNet += s.evNet;
    hands += s.hands;
    ms += Math.max(0, (s.endedAt ?? s.startedAt) - s.startedAt);
    if (!best || s.net > best.net) best = s;
    if (!worst || s.net < worst.net) worst = s;
  }
  return { hands, sessions: list.length, net, evNet, bestSession: best, worstSession: worst, hoursPlayed: ms / 3_600_000 };
}

// ─────────────────────────── leak detection ───────────────────────────

export interface Leak {
  id: string;
  /** which tile the hint belongs under */
  stat: keyof StatLine;
  severity: 'high' | 'medium' | 'low';
  title: string;
  body: string;
}

interface LeakRule {
  id: string;
  stat: keyof StatLine;
  severity: Leak['severity'];
  title: string;
  body: string;
  test(s: StatLine): boolean;
}

/**
 * Deliberately few rules, each with a threshold a coach would actually use,
 * and each phrased as a fix rather than a scolding. A screen that flags nine
 * things flags nothing.
 */
const RULES: LeakRule[] = [
  {
    id: 'fold3bet-high', stat: 'foldToThreeBet', severity: 'high',
    title: 'You are over-folding to three-bets',
    body: 'Folding {v} of the time to a three-bet lets opponents print with any two from the blinds. Defend more suited broadways and pocket pairs in position, and four-bet your very best hands for value.',
    test: (s) => s.foldToThreeBet > 0.62 && s.hands >= 250,
  },
  {
    id: 'passive', stat: 'af', severity: 'high',
    title: 'Your line is too passive',
    body: 'An aggression factor of {v} means you are calling far more than betting. Turn your medium-strength calls on the flop into raises when you have a draw to go with them.',
    test: (s) => s.af > 0 && s.af < 1.35 && s.hands >= 200,
  },
  {
    id: 'limpy', stat: 'pfr', severity: 'high',
    title: 'Too many hands enter the pot passively',
    body: 'Your VPIP is {vpip} but your PFR is only {v}. That gap is limps and cold-calls. Either raise the hand or fold it — the middle option is where money goes to die.',
    test: (s) => s.vpip > 0.24 && s.pfr / Math.max(0.0001, s.vpip) < 0.58 && s.hands >= 200,
  },
  {
    id: 'loose', stat: 'vpip', severity: 'medium',
    title: 'You are playing too many hands',
    body: 'A VPIP of {v} at six-max is a wide net. Trim the offsuit gappers from early position first — they cost the most and win the least.',
    test: (s) => s.vpip > 0.34 && s.hands >= 200,
  },
  {
    id: 'nit', stat: 'vpip', severity: 'medium',
    title: 'You are folding away your button',
    body: 'A VPIP of {v} is tight even for a full ring game. Open more from the cutoff and button — steals are the cheapest chips at the table.',
    test: (s) => s.vpip < 0.17 && s.hands >= 200,
  },
  {
    id: 'stationy', stat: 'wtsd', severity: 'medium',
    title: 'You are calling down too light',
    body: 'Going to showdown {v} of the time with a W$SD of {wsd} means the hands arriving there are not strong enough. Fold more rivers where you beat only bluffs.',
    test: (s) => s.wtsd > 0.32 && s.wsd < 0.5 && s.hands >= 250,
  },
  {
    id: 'cbet-wide', stat: 'cbetFlop', severity: 'low',
    title: 'Your c-bet is a little wide',
    body: 'C-betting {v} of flops works against players who fold, and bleeds against players who do not. Check back more on low, connected boards where you have no equity.',
    test: (s) => s.cbetFlop > 0.76 && s.hands >= 250,
  },
  {
    id: 'cbet-thin', stat: 'cbetFlop', severity: 'low',
    title: 'You are giving up on the flop too often',
    body: 'A {v} c-bet rate leaves free cards everywhere. On dry ace-high boards, a small bet takes it down often enough to be nearly free.',
    test: (s) => s.cbetFlop > 0 && s.cbetFlop < 0.42 && s.hands >= 250,
  },
  {
    id: 'threebet-low', stat: 'threeBet', severity: 'low',
    title: 'Your three-bet is readable',
    body: 'Three-betting only {v} of the time means everyone folds when you do. Add suited aces and small pairs in position to make the range unreadable.',
    test: (s) => s.threeBet > 0 && s.threeBet < 0.05 && s.hands >= 300,
  },
  {
    id: 'below-ev', stat: 'evBb100', severity: 'low',
    title: 'You are running below expectation',
    body: 'Your all-in adjusted line is {v} against an actual {win}. That gap is variance, not strategy — the play is fine, the deck is not.',
    test: (s) => s.hands >= 300 && s.evBb100 - s.winrateBb100 > 2.5,
  },
];

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function fillCopy(rule: LeakRule, s: StatLine): string {
  const val = s[rule.stat];
  const shown =
    rule.stat === 'af' ? (val as number).toFixed(2)
      : rule.stat === 'evBb100' || rule.stat === 'winrateBb100' ? `${(val as number).toFixed(1)}bb/100`
        : pct(val as number);
  return rule.body
    .replace('{v}', shown)
    .replace('{vpip}', pct(s.vpip))
    .replace('{wsd}', pct(s.wsd))
    .replace('{win}', `${s.winrateBb100.toFixed(1)}bb/100`);
}

/** Ranked leaks for a stat line. Never more than four — that is a plan. */
export function leaksFor(s: StatLine): Leak[] {
  const order: Record<Leak['severity'], number> = { high: 0, medium: 1, low: 2 };
  const out: Leak[] = [];
  for (const rule of RULES) {
    let hit = false;
    try {
      hit = rule.test(s);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    out.push({
      id: rule.id,
      stat: rule.stat,
      severity: rule.severity,
      title: rule.title,
      body: fillCopy(rule, s),
    });
  }
  return out.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 4);
}

/** The single hint attached to a tile, if any. */
export function leakForStat(s: StatLine, stat: keyof StatLine): Leak | null {
  return leaksFor(s).find((l) => l.stat === stat) ?? null;
}

// ─────────────────────────── live tracking ───────────────────────────

interface HandScratch {
  seat: number;
  variant: GameVariant;
  stakeId: StakeId;
  bb: number;
  position: PositionName;
  startStack: number;
  vpip: boolean;
  pfr: boolean;
  raisesPre: number;
  threeBetOpp: boolean;
  threeBet: boolean;
  faced3Bet: boolean;
  fold3Bet: boolean;
  bets: number;
  raises: number;
  calls: number;
  sawFlop: boolean;
  wasPfAggressor: boolean;
  cbetOpp: boolean;
  cbet: boolean;
  showdown: boolean;
  wonShowdown: boolean;
  allIn: boolean;
  won: number;
  invested: number;
}

let scratch: HandScratch | null = null;
let liveSession: SessionRecord | null = null;
let ctx = {
  seat: -1,
  variant: 'nlhe' as GameVariant,
  stakeId: 'nl10' as StakeId,
  bb: 0.1,
  seats: 6,
  buttonSeat: 0,
};

function positionOf(seat: number, buttonSeat: number, seats: number): PositionName {
  const offset = ((seat - buttonSeat) % seats + seats) % seats;
  // 0 = button, 1 = SB, 2 = BB, then forward from UTG.
  if (offset === 0) return 'BTN';
  if (offset === 1) return 'SB';
  if (offset === 2) return 'BB';
  const fromUtg = offset - 3;
  const early: PositionName[] = ['UTG', 'MP', 'CO'];
  return early[Math.min(early.length - 1, fromUtg)];
}

function bucketFor(variant: GameVariant, stakeId: StakeId): Bucket {
  const key = bucketKey(variant, stakeId);
  let b = store.buckets[key];
  if (!b) {
    b = emptyBucket(variant, stakeId);
    store.buckets[key] = b;
  }
  return b;
}

function ensureSession(now: number): SessionRecord {
  const gapOk = liveSession && now - (liveSession.endedAt ?? liveSession.startedAt) < 45 * 60_000;
  if (liveSession && gapOk && liveSession.variant === ctx.variant && liveSession.stakeId === ctx.stakeId) {
    return liveSession;
  }
  liveSession = {
    id: `s-${now.toString(36)}`,
    startedAt: now,
    endedAt: null,
    variant: ctx.variant,
    stakeId: ctx.stakeId,
    hands: 0,
    net: 0,
    evNet: 0,
    curve: [],
  };
  store.sessions.push(liveSession);
  if (store.sessions.length > 160) store.sessions.splice(0, store.sessions.length - 160);
  return liveSession;
}

function finishHand(): void {
  const s = scratch;
  scratch = null;
  if (!s || s.seat < 0) return;
  const now = Date.now();
  const c = zero();
  c.hands = 1;
  c.vpip = s.vpip ? 1 : 0;
  c.pfr = s.pfr ? 1 : 0;
  c.threeBetOpp = s.threeBetOpp ? 1 : 0;
  c.threeBet = s.threeBet ? 1 : 0;
  c.faced3Bet = s.faced3Bet ? 1 : 0;
  c.fold3Bet = s.fold3Bet ? 1 : 0;
  c.bets = s.bets;
  c.raises = s.raises;
  c.calls = s.calls;
  c.sawFlop = s.sawFlop ? 1 : 0;
  c.showdowns = s.showdown ? 1 : 0;
  c.wonShowdown = s.wonShowdown ? 1 : 0;
  c.cbetOpp = s.cbetOpp ? 1 : 0;
  c.cbet = s.cbet ? 1 : 0;
  c.wins = s.won > 0 ? 1 : 0;
  c.allIns = s.allIn ? 1 : 0;
  const net = s.won - s.invested;
  c.net = net;
  c.bbNet = s.bb > 0 ? net / s.bb : 0;
  // Without solver equity from the engine, an all-in pot's expectation is the
  // pot share the hand had going in; everything else realises exactly.
  c.bbEv = s.allIn ? c.bbNet * 0.94 + (s.invested / Math.max(s.bb, 1e-6)) * 0.06 : c.bbNet;

  const b = bucketFor(s.variant, s.stakeId);
  add(b.totals, c);
  add(b.byPosition[s.position], c);

  const session = ensureSession(now);
  session.hands += 1;
  session.net += net;
  session.evNet += s.allIn ? net * 0.94 + s.invested * 0.06 : net;
  session.endedAt = now;
  session.curve.push(net);
  if (session.curve.length > 400) {
    // Halve by pairwise sum — keeps the shape and the endpoint exact.
    const next: number[] = [];
    for (let i = 0; i < session.curve.length; i += 2) {
      next.push(session.curve[i] + (session.curve[i + 1] ?? 0));
    }
    session.curve = next;
  }
  save();
  notify();
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (err) {
      console.error('[analytics] listener failed', err);
    }
  }
}

export function onAnalytics(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let wired = false;

/** Attaches the tracker to the bus. Idempotent. */
export function wireAnalytics(): () => void {
  if (wired) return () => undefined;
  wired = true;
  const offs: Array<() => void> = [];

  offs.push(bus.on('table:state', ({ state, you }) => {
    ctx = {
      seat: you,
      variant: state.variant,
      stakeId: state.stake?.id ?? ctx.stakeId,
      bb: state.stake?.bb ?? ctx.bb,
      seats: state.seats?.length ?? ctx.seats,
      buttonSeat: state.buttonSeat ?? 0,
    };
  }));

  offs.push(bus.on('hand:start', ({ buttonSeat }) => {
    ctx.buttonSeat = buttonSeat;
    scratch = {
      seat: ctx.seat,
      variant: ctx.variant,
      stakeId: ctx.stakeId,
      bb: ctx.bb,
      position: positionOf(ctx.seat, buttonSeat, Math.max(2, ctx.seats)),
      startStack: 0,
      vpip: false, pfr: false, raisesPre: 0,
      threeBetOpp: false, threeBet: false, faced3Bet: false, fold3Bet: false,
      bets: 0, raises: 0, calls: 0,
      sawFlop: false, wasPfAggressor: false, cbetOpp: false, cbet: false,
      showdown: false, wonShowdown: false, allIn: false,
      won: 0, invested: 0,
    };
  }));

  offs.push(bus.on('hand:action', ({ action }) => {
    const s = scratch;
    if (!s) return;
    trackAction(s, action);
  }));

  offs.push(bus.on('hand:deal-board', ({ street }) => {
    const s = scratch;
    if (!s) return;
    if (street === 'flop') {
      s.sawFlop = true;
      if (s.wasPfAggressor) s.cbetOpp = true;
    }
  }));

  offs.push(bus.on('hand:showdown', ({ results }) => {
    const s = scratch;
    if (!s) return;
    const mine = results.find((r) => r.seat === s.seat);
    if (!mine) return;
    s.showdown = true;
    if (mine.won > 0) s.wonShowdown = true;
  }));

  offs.push(bus.on('hand:award', ({ seat, amount }) => {
    const s = scratch;
    if (!s || seat !== s.seat) return;
    s.won += amount;
  }));

  offs.push(bus.on('hand:end', () => finishHand()));

  return () => {
    for (const off of offs) off();
    wired = false;
  };
}

/** Pure so the seeder can drive the same code path the live table does. */
function trackAction(s: HandScratch, action: Action): void {
  if (action.seat !== s.seat) {
    if (action.street === 'preflop' && (action.kind === 'raise' || action.kind === 'bet')) {
      s.raisesPre += 1;
      // A single raise in front of us is our three-bet opportunity.
      if (s.raisesPre === 1) s.threeBetOpp = true;
      if (s.raisesPre === 2 && s.pfr) s.faced3Bet = true;
    }
    return;
  }
  if (action.kind === 'post' || action.kind === 'ante') {
    s.invested += action.amount;
    return;
  }
  s.invested += action.amount;
  if (action.street === 'preflop') {
    if (action.kind === 'call') {
      s.vpip = true;
      s.calls += 1;
    } else if (action.kind === 'raise' || action.kind === 'bet') {
      s.vpip = true;
      s.pfr = true;
      s.wasPfAggressor = true;
      s.raises += 1;
      if (s.threeBetOpp && s.raisesPre === 1) s.threeBet = true;
      s.raisesPre += 1;
    } else if (action.kind === 'fold') {
      if (s.faced3Bet) s.fold3Bet = true;
    } else if (action.kind === 'allin') {
      s.vpip = true;
      s.pfr = true;
      s.allIn = true;
      s.raises += 1;
    }
  } else {
    if (action.kind === 'call') s.calls += 1;
    else if (action.kind === 'bet') {
      s.bets += 1;
      if (action.street === 'flop' && s.cbetOpp) s.cbet = true;
    } else if (action.kind === 'raise') s.raises += 1;
    else if (action.kind === 'allin') {
      s.allIn = true;
      s.raises += 1;
    }
    if (action.kind !== 'fold') s.wasPfAggressor = s.wasPfAggressor && action.kind !== 'check';
  }
}

// ─────────────────────────── seeded history ───────────────────────────

/** Each seeded stake is normalised onto its own target rate, in bb/100. */
interface SeedPlan {
  stakeId: StakeId;
  variant: GameVariant;
  weight: number;
  bb100: number;
}

const SEED_PLAN: SeedPlan[] = [
  { stakeId: 'nl10', variant: 'nlhe', weight: 0.44, bb100: 9.5 },
  { stakeId: 'nl20', variant: 'nlhe', weight: 0.3, bb100: 6.2 },
  { stakeId: 'nl50', variant: 'nlhe', weight: 0.14, bb100: 2.8 },
  { stakeId: 'nl10', variant: 'plo4', weight: 0.08, bb100: 11 },
  // The shot above the roll that ate a chunk of the year — the story the
  // stake filter and the leak hints exist to make visible.
  { stakeId: 'nl100', variant: 'nlhe', weight: 0.04, bb100: -5 },
];

/**
 * The analytic mean of the per-hand mixture below, in big blinds. Subtracting
 * it makes the distribution zero-mean, so the only drift left is the intended
 * win rate — without this the shape's own bias dominates everything.
 */
const MIX_DRIFT_BB = -0.62 * 0.625 + 0.24 * 2.55 + 0.1 * 3;

/**
 * Where money is made and lost by seat, in big blinds per hand. These are the
 * shape every real database has: the button prints, the cutoff is fine, the
 * blinds bleed because they pay before they look. They sum to exactly zero, so
 * spreading them over a full orbit leaves the session's total untouched.
 */
const POS_EDGE_BB: Record<PositionName, number> = {
  UTG: -0.03, MP: 0.02, CO: 0.18, BTN: 0.35, SB: -0.3, BB: -0.22,
  UTG1: 0, LJ: 0, HJ: 0,
};

/** One hand's result in big blinds: usually nothing, rarely stacks. */
function seedHandBb(rng: Rng): number {
  const r = rng.next();
  const v =
    r < 0.62 ? -rng.range(0.05, 1.2) // folded, or missed and gave up
      : r < 0.86 ? rng.range(0.6, 4.5) // took it down
        : r < 0.96 ? rng.normal(3, 14) // contested pot
          : rng.normal(0, 42); // stacks in
  return v - MIX_DRIFT_BB;
}

/**
 * A believable nine-week history for a small winning player: about 8,000 hands
 * across nl10 → nl100, a losing shot at a stake above their roll, a handful of
 * PLO nights, and one genuinely horrible Tuesday.
 *
 * Generated in two passes. The first draws real per-hand results, which gives
 * the curve its shape and its session-level variance. The second shifts every
 * hand within a stake by one constant so that stake's win rate lands on its
 * plan — otherwise eight thousand hands of real variance routinely produces a
 * 30bb/100 headline, which is true to poker and useless as a demo. Session
 * shape, ordering and swings all survive the shift untouched.
 */
export function seedHistory(force = false): void {
  if (store.seeded && !force) return;
  if (!force && Object.keys(store.buckets).length > 0) {
    store.seeded = true;
    save();
    return;
  }
  store = freshStore();
  const rng = new Rng(0x8a1e5f);
  const now = Date.now();

  const plan = SEED_PLAN;

  interface Draft {
    record: SessionRecord;
    bb: number;
    plo: boolean;
    key: string;
    target: number;
  }
  const drafts: Draft[] = [];
  const SESSIONS = 46;

  // ── pass one: draw the sessions ────────────────────────────────────
  for (let i = 0; i < SESSIONS; i++) {
    // Oldest first, clustered into evenings across the last nine weeks.
    const daysAgo = 62 - Math.floor((i / SESSIONS) * 62) - rng.int(2);
    const startedAt = now - daysAgo * DAY_MS + (18 + rng.int(5)) * 3_600_000 + rng.int(50) * 60_000;

    let roll = rng.next();
    let pick = plan[0];
    for (const p of plan) {
      if (roll < p.weight) {
        pick = p;
        break;
      }
      roll -= p.weight;
    }
    const bb = STAKES[pick.stakeId].bb;
    const hands = 60 + rng.int(230);
    const perHandEv = (pick.bb100 / 100) * bb;

    const curve: number[] = [];
    let net = 0;
    for (let hIdx = 0; hIdx < hands; hIdx++) {
      const chipsWon = seedHandBb(rng) * bb + perHandEv;
      curve.push(chipsWon);
      net += chipsWon;
    }
    // All-in expectation sits a session's worth of luck away from the realised
    // line — the gap between the two is the entire point of the second series.
    const evNet = net + rng.normal(0, 3.2) * bb * Math.sqrt(hands);

    drafts.push({
      record: {
        id: `seed-${i.toString(36)}`,
        startedAt,
        endedAt: startedAt + hands * rng.range(22_000, 40_000),
        variant: pick.variant,
        stakeId: pick.stakeId,
        hands,
        net,
        evNet,
        curve,
      },
      bb,
      plo: pick.variant === 'plo4',
      key: bucketKey(pick.variant, pick.stakeId),
      target: pick.bb100,
    });
  }

  // ── normalise each stake onto its planned win rate ─────────────────
  const groups = new Map<string, { hands: number; bb: number; target: number }>();
  for (const d of drafts) {
    let g = groups.get(d.key);
    if (!g) {
      g = { hands: 0, bb: 0, target: d.target };
      groups.set(d.key, g);
    }
    g.hands += d.record.hands;
    g.bb += d.record.net / d.bb;
  }
  for (const d of drafts) {
    const g = groups.get(d.key);
    if (!g || g.hands === 0) continue;
    const step = (g.target / 100 - g.bb / g.hands) * d.bb;
    if (step === 0) continue;
    for (let i = 0; i < d.record.curve.length; i++) d.record.curve[i] += step;
    d.record.net += step * d.record.hands;
    d.record.evNet += step * d.record.hands;
  }

  // ── pass two: fold the hands into the counters ─────────────────────
  for (const d of drafts) {
    const { record, bb, plo } = d;
    store.sessions.push(record);
    const b = bucketFor(record.variant, record.stakeId);
    const vpipRate = plo ? 0.38 : 0.255;
    const pfrRate = plo ? 0.24 : 0.199;
    // Positions cycle like a real orbit, so every seat gets the same share of
    // hands and the positional edges below cancel out over each full lap.
    let residual = 0;
    for (let hIdx = 0; hIdx < record.hands; hIdx++) {
      const c = zero();
      const position = POSITIONS[hIdx % POSITIONS.length];
      c.hands = 1;
      const positional = position === 'BTN' ? 1.5 : position === 'CO' ? 1.24 : position === 'UTG' ? 0.62 : 1;
      const voluntarily = rng.bool(vpipRate * positional);
      c.vpip = voluntarily ? 1 : 0;
      const raised = voluntarily && rng.bool(pfrRate / vpipRate);
      c.pfr = raised ? 1 : 0;
      if (rng.bool(0.19)) {
        c.threeBetOpp = 1;
        if (rng.bool(0.083)) c.threeBet = 1;
      }
      if (raised && rng.bool(0.12)) {
        c.faced3Bet = 1;
        if (rng.bool(0.655)) c.fold3Bet = 1;
      }
      if (voluntarily) {
        c.sawFlop = rng.bool(0.72) ? 1 : 0;
        c.calls = rng.int(3);
        c.bets = rng.int(2);
        c.raises = rng.int(2);
        if (c.sawFlop && raised) {
          c.cbetOpp = 1;
          if (rng.bool(0.63)) c.cbet = 1;
        }
        if (c.sawFlop && rng.bool(0.285)) {
          c.showdowns = 1;
          if (rng.bool(0.523)) c.wonShowdown = 1;
        }
      }
      const raw = record.curve[hIdx];
      const isLast = hIdx === record.hands - 1;
      const offset = POS_EDGE_BB[position] * bb;
      residual += offset;
      /**
       * Per-hand results are damped toward the session mean before being
       * attributed to a seat. Deviations still sum to zero, so the totals are
       * untouched — but 1,300 hands of raw 9.7bb variance would swamp the
       * positional signal entirely and the seat table would read as noise.
       * The last hand absorbs the remainder of a partial final orbit.
       */
      const mean = record.net / Math.max(1, record.hands);
      const v = mean + (raw - mean) * 0.28 + offset - (isLast ? residual : 0);
      if (v > 0) c.wins = 1;
      if (Math.abs(raw) > bb * 45) c.allIns = 1;
      c.net = v;
      c.bbNet = v / bb;
      c.bbEv = c.allIns ? c.bbNet * 0.94 + 0.4 : c.bbNet;
      add(b.totals, c);
      add(b.byPosition[position], c);
    }
  }

  store.sessions.sort((a, b) => a.startedAt - b.startedAt);
  store.seeded = true;
  saveNow();
  notify();
}

/** Stakes that actually have hands on them — drives the filter chips. */
export function stakesPlayed(): StakeId[] {
  const seen = new Set<StakeId>();
  for (const b of Object.values(store.buckets)) if (b.totals.hands > 0) seen.add(b.stakeId);
  return LOBBY_STAKES.filter((id) => seen.has(id));
}

export function variantsPlayed(): GameVariant[] {
  const seen = new Set<GameVariant>();
  for (const b of Object.values(store.buckets)) if (b.totals.hands > 0) seen.add(b.variant);
  return (['nlhe', 'plo4'] as GameVariant[]).filter((v) => seen.has(v));
}

export function resetAnalytics(): void {
  store = freshStore();
  saveNow();
  notify();
}

seedHistory();
