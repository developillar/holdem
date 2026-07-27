/**
 * ROYALE — gto/solver.ts
 * ────────────────────────────────────────────────────────────────────────────
 * A POSTFLOP STRATEGY MODEL. Read this before you trust a number.
 *
 * WHAT IS ACTUALLY COMPUTED
 *   • Board texture — pairedness, suitedness, and a straightiness score built
 *     from how many of the ten five-card windows the board reaches into.
 *   • Every combo in both ranges is evaluated on the real board, with exact
 *     card removal, giving each hand its showdown rank against the opposing
 *     range and its percentile among all holdings the board allows.
 *   • Draws are counted structurally (flush draws, open-enders, gutshots,
 *     live overcards) the way a player counts them.
 *   • Hero's own equity is a real Monte Carlo run against the villain's range
 *     — sampled runouts, not a proxy. 4000 samples is ±0.8%.
 *   • Fold equity is the share of the villain's range that cannot clear the
 *     price being laid, floored by minimum defense so the model never assumes
 *     an opponent folds more than a competent one would.
 *   • Equity-when-called is hero's equity minus how much the villain's range
 *     improved by continuing.
 *   • Bluff frequency is the balancing ratio s/(1+2s) applied to the value mass
 *     that is actually betting; defend frequency starts at MDF = 1/(1+s) and is
 *     corrected for position (equity realisation) and for how polarised the
 *     bettor is.
 *   • Bet sizing follows the solver shape: small and often when the range
 *     advantage is broad and the board is static; big and rarer when the nut
 *     advantage is what decides the pot.
 *
 * WHAT THIS IS NOT
 *   Not CFR. There is no game tree and no iteration. Consequences:
 *     – EVs are model EVs. Their ordering and their differences are reliable;
 *       treat the absolute figure as ±0.3bb.
 *     – One betting round is modelled at a time. Multi-street effects (range
 *       protection, delayed c-bets, river blocker overbets) show up only
 *       through one-street proxies.
 *     – Multiway pots are modelled as hero versus the single strongest
 *       opponent, which understates how much you should tighten.
 *   Range equities carry a documented realisation correction (`vulnerability`)
 *   because raw showdown-now equity badly overstates unmade hands with cards
 *   still to come. Everything the trainer displays comes from here.
 */

import type { CardId, GameVariant, RangeGrid, Street, StrategyNode } from '../core/types.ts';
import { expandRange } from './ranges.ts';
import { score as scoreCards, scorePlo, categoryName, categoryOf } from './equity.ts';

// ═══════════════════════════ board texture ═══════════════════════════

export interface BoardTexture {
  board: CardId[];
  street: Street;
  paired: boolean;
  trips: boolean;
  monotone: boolean;
  twoTone: boolean;
  rainbow: boolean;
  /** 3+ to a suit — a flush is live */
  flushLive: boolean;
  /** 4+ to a suit */
  flushHeavy: boolean;
  /** highest board rank, 2–14 */
  highCard: number;
  /** 0–1, how high the board runs */
  highness: number;
  /** 0–1, how many straights the board brings into play */
  straightiness: number;
  /** 0–1, how much flush pressure there is */
  flushiness: number;
  /** 0–1, how much equity can still change hands */
  dynamism: number;
  /** 1 − dynamism */
  staticness: number;
  /** short human description, e.g. "Dry · rainbow · ace-high" */
  label: string;
  tags: string[];
}

const RANK_WORD = [
  '', '', 'deuce', 'trey', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace',
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function analyzeBoard(board: readonly CardId[]): BoardTexture {
  const ranks = board.map((c) => (c >> 2) + 2).sort((a, b) => b - a);
  const suits = [0, 0, 0, 0];
  for (const c of board) suits[c & 3]++;
  const maxSuit = Math.max(suits[0], suits[1], suits[2], suits[3]);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  let maxRankCount = 0;
  for (const v of counts.values()) if (v > maxRankCount) maxRankCount = v;
  const distinct = Array.from(counts.keys());

  let windows3 = 0;
  let windows2 = 0;
  for (let lo = 1; lo <= 10; lo++) {
    let inWindow = 0;
    for (const r of distinct) {
      const rr = r === 14 && lo === 1 ? 1 : r;
      if (rr >= lo && rr <= lo + 4) inWindow++;
    }
    if (inWindow >= 3) windows3++;
    else if (inWindow === 2) windows2++;
  }
  const straightiness = Math.min(1, windows3 * 0.35 + windows2 * 0.06);

  const isFlop = board.length <= 3;
  const flushiness = isFlop
    ? maxSuit >= 3 ? 0.9 : maxSuit === 2 ? 0.45 : 0.05
    : maxSuit >= 4 ? 1 : maxSuit === 3 ? 0.55 : 0.12;

  const paired = maxRankCount >= 2;
  const dynamism = clamp01(0.08 + 0.45 * flushiness + 0.42 * straightiness - (paired ? 0.06 : 0));
  const highCard = ranks[0] ?? 2;

  const tags: string[] = [];
  tags.push(dynamism > 0.62 ? 'Wet' : dynamism > 0.36 ? 'Semi-wet' : 'Dry');
  if (maxRankCount >= 3) tags.push('trips');
  else if (paired) tags.push('paired');
  if (isFlop) {
    if (maxSuit >= 3) tags.push('monotone');
    else if (maxSuit === 2) tags.push('two-tone');
    else tags.push('rainbow');
  } else if (maxSuit >= 4) tags.push('four-flush');
  else if (maxSuit === 3) tags.push('flush live');
  if (windows3 >= 2) tags.push('connected');
  if (highCard >= 12) tags.push(`${RANK_WORD[highCard]}-high`);
  else if (highCard <= 9) tags.push('low');

  const street: Street = board.length <= 3 ? 'flop' : board.length === 4 ? 'turn' : 'river';

  return {
    board: board.slice(),
    street,
    paired,
    trips: maxRankCount >= 3,
    monotone: isFlop && maxSuit >= 3,
    twoTone: isFlop && maxSuit === 2,
    rainbow: isFlop && maxSuit === 1,
    flushLive: maxSuit >= 3,
    flushHeavy: maxSuit >= 4,
    highCard,
    highness: (highCard - 2) / 12,
    straightiness,
    flushiness,
    dynamism,
    staticness: 1 - dynamism,
    label: tags.slice(0, 3).join(' · '),
    tags,
  };
}

// ═══════════════════════════ draws, counted like a player ═══════════════════════════

export interface DrawInfo {
  outs: number;
  flushDraw: boolean;
  oesd: boolean;
  gutshot: boolean;
  overcards: number;
  label: string;
}

const NO_DRAW: DrawInfo = { outs: 0, flushDraw: false, oesd: false, gutshot: false, overcards: 0, label: '' };

/**
 * Structural out count for a two-card holding. Backdoor draws are ignored;
 * overcards count at half weight because pairing one is not always enough.
 */
export function drawOuts(hole: readonly CardId[], board: readonly CardId[]): DrawInfo {
  if (board.length >= 5 || hole.length < 2) return NO_DRAW;
  const all = [...hole, ...board];

  const suitAll = [0, 0, 0, 0];
  const suitHole = [0, 0, 0, 0];
  for (const c of all) suitAll[c & 3]++;
  for (const c of hole) suitHole[c & 3]++;
  let flushDraw = false;
  let flushMade = false;
  for (let s = 0; s < 4; s++) {
    if (suitAll[s] >= 5) flushMade = true;
    else if (suitAll[s] === 4 && suitHole[s] >= 1) flushDraw = true;
  }

  // 14-bit rank mask, bit 0 = ace playing low.
  const maskOf = (cards: readonly CardId[]): number => {
    let m = 0;
    for (const c of cards) {
      const r = (c >> 2) + 2;
      m |= 1 << (r - 1);
      if (r === 14) m |= 1;
    }
    return m;
  };
  const hasStraight = (m: number): boolean => {
    for (let i = 0; i <= 9; i++) {
      const w = 0b11111 << i;
      if ((m & w) === w) return true;
    }
    return false;
  };
  const maskAll = maskOf(all);
  const maskBoard = maskOf(board);
  let straightOutRanks = 0;
  let straightMade = hasStraight(maskAll);
  if (!straightMade) {
    for (let r = 2; r <= 14; r++) {
      const bit = 1 << (r - 1);
      if (maskAll & bit) continue;
      const withCard = maskAll | bit | (r === 14 ? 1 : 0);
      const boardWith = maskBoard | bit | (r === 14 ? 1 : 0);
      // Only count it if the hole cards are part of the straight.
      if (hasStraight(withCard) && !hasStraight(boardWith)) straightOutRanks++;
    }
  }
  const oesd = straightOutRanks >= 2;
  const gutshot = straightOutRanks === 1;

  const topBoard = board.reduce((m, c) => Math.max(m, (c >> 2) + 2), 0);
  const heroScore = scoreCards(all);
  const madePair = categoryOf(heroScore) >= 1;
  let overcards = 0;
  if (!madePair) {
    for (const c of hole) if ((c >> 2) + 2 > topBoard) overcards++;
  }

  let outs = 0;
  if (flushDraw) outs += 9;
  outs += straightOutRanks * 4;
  if (flushDraw && straightOutRanks > 0) outs -= straightOutRanks; // shared cards
  if (flushMade || straightMade) outs = 0;
  outs += overcards * 1.5;
  outs = Math.max(0, Math.min(18, Math.round(outs)));

  const bits: string[] = [];
  if (flushDraw) bits.push('flush draw');
  if (oesd) bits.push('open-ender');
  else if (gutshot) bits.push('gutshot');
  if (!bits.length && overcards > 0) bits.push(overcards === 2 ? 'two overcards' : 'one overcard');
  return {
    outs,
    flushDraw,
    oesd,
    gutshot,
    overcards,
    label: bits.join(' + '),
  };
}

// ═══════════════════════════ ranges on a board ═══════════════════════════

export interface ComboStat {
  cards: [CardId, CardId];
  hand: number;
  weight: number;
  /** best-five score on the current board */
  score: number;
  /** showdown-now equity vs the opposing range, 0–1 */
  showdown: number;
  /** showdown equity corrected for cards to come — the number used downstream */
  eq: number;
  outs: number;
  /** made-hand percentile among every holding the board allows */
  percentile: number;
}

export interface RangeOnBoard {
  combos: ComboStat[];
  totalWeight: number;
  /** weighted mean corrected equity vs the opposing range */
  equity: number;
  /** weighted share in the top 5% of hands the board allows */
  nut: number;
  /** weighted share under 30% equity */
  air: number;
  /** weighted share 30–68% */
  medium: number;
  /** weighted share 68%+ */
  value: number;
  /** ten equity buckets, each the weighted share of the range */
  buckets: number[];
}

function scoreOn(hole: readonly CardId[], board: readonly CardId[], variant: GameVariant): number {
  if (variant === 'plo4' && hole.length >= 4) return scorePlo(hole, board);
  return scoreCards([...hole, ...board]);
}

function boardScoreLadder(board: readonly CardId[], dead: readonly CardId[]): Float64Array {
  const blocked = new Uint8Array(52);
  for (const c of board) blocked[c] = 1;
  for (const c of dead) blocked[c] = 1;
  const live: number[] = [];
  for (let c = 0; c < 52; c++) if (!blocked[c]) live.push(c);
  const out = new Float64Array((live.length * (live.length - 1)) / 2);
  let n = 0;
  const buf = [0, 0, ...board] as number[];
  for (let i = 0; i < live.length; i++) {
    buf[0] = live[i];
    for (let j = i + 1; j < live.length; j++) {
      buf[1] = live[j];
      out[n++] = scoreCards(buf);
    }
  }
  const arr = out.subarray(0, n);
  arr.sort();
  return arr as Float64Array;
}

function percentileIn(ladder: Float64Array, value: number): number {
  let lo = 0;
  let hi = ladder.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ladder[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return ladder.length ? lo / ladder.length : 0;
}

/**
 * How much of a hand's showdown-now edge survives the cards still to come.
 * An unmade hand that "beats 80% of their range" on the flop is nowhere near
 * 80% to win the pot; a set on the river is exactly what it says it is.
 */
function vulnerabilityOf(category: number, street: Street, dynamism: number): number {
  if (street === 'river') return 0;
  const base = street === 'flop' ? 0.30 : 0.17;
  const extra = category === 0 ? 0.30 : category === 1 ? 0.09 : category === 2 ? 0.04 : 0;
  return clamp((base + extra) * (0.65 + 0.7 * dynamism), 0, 0.85);
}

function correctEquity(
  showdown: number,
  category: number,
  outs: number,
  street: Street,
  dynamism: number,
): number {
  const vuln = vulnerabilityOf(category, street, dynamism);
  const drawWeight = street === 'flop' ? 0.021 : street === 'turn' ? 0.012 : 0;
  const settled = 0.5 + (showdown - 0.5) * (1 - vuln);
  return clamp01(settled + (1 - showdown) * outs * drawWeight);
}

/** Cross-evaluates two ranges on a board with exact card removal. */
export function crossRanges(
  heroRange: RangeGrid,
  villainRange: RangeGrid,
  board: readonly CardId[],
  opts: { variant?: GameVariant; dead?: readonly CardId[] } = {},
): { hero: RangeOnBoard; villain: RangeOnBoard; texture: BoardTexture } {
  const variant = opts.variant ?? 'nlhe';
  const dead = opts.dead ?? [];
  const blockers = [...board, ...dead];
  const ladder = boardScoreLadder(board, dead);
  const texture = analyzeBoard(board);

  const build = (g: RangeGrid): ComboStat[] =>
    expandRange(g, blockers).map((c) => {
      const s = scoreOn(c.cards, board, variant);
      return {
        cards: c.cards,
        hand: c.hand,
        weight: c.weight,
        score: s,
        showdown: 0,
        eq: 0,
        outs: drawOuts(c.cards, board).outs,
        percentile: percentileIn(ladder, s),
      };
    });

  const hero = build(heroRange);
  const villain = build(villainRange);
  pairwise(hero, villain);
  pairwise(villain, hero);
  for (const c of [...hero, ...villain]) {
    c.eq = correctEquity(c.showdown, categoryOf(c.score), c.outs, texture.street, texture.dynamism);
  }

  const nutLine = ladder.length ? ladder[Math.floor(ladder.length * 0.95)] : 0;
  return {
    hero: summarise(hero, nutLine),
    villain: summarise(villain, nutLine),
    texture,
  };
}

/** Fills `a[i].showdown` against `b`, discounting the combos `a[i]` blocks. */
function pairwise(a: ComboStat[], b: ComboStat[]): void {
  if (!b.length) {
    for (const x of a) x.showdown = 0.5;
    return;
  }
  const sorted = b.slice().sort((p, q) => p.score - q.score);
  const prefix = new Float64Array(sorted.length + 1);
  for (let i = 0; i < sorted.length; i++) prefix[i + 1] = prefix[i] + sorted[i].weight;
  const total = prefix[sorted.length];

  const bound = (v: number, strict: boolean): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const s = sorted[mid].score;
      if (strict ? s <= v : s < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const byCard: ComboStat[][] = [];
  for (let c = 0; c < 52; c++) byCard.push([]);
  for (const v of b) {
    byCard[v.cards[0]].push(v);
    byCard[v.cards[1]].push(v);
  }

  const seen = new Set<ComboStat>();
  for (const h of a) {
    let beat = prefix[bound(h.score, false)];
    let split = prefix[bound(h.score, true)] - beat;
    let live = total;
    seen.clear();
    for (const card of h.cards) {
      for (const v of byCard[card]) {
        if (seen.has(v)) continue;
        seen.add(v);
        live -= v.weight;
        if (v.score < h.score) beat -= v.weight;
        else if (v.score === h.score) split -= v.weight;
      }
    }
    h.showdown = live > 0 ? clamp01((beat + split * 0.5) / live) : 0.5;
  }
}

function summarise(combos: ComboStat[], nutLine: number): RangeOnBoard {
  let total = 0;
  let eq = 0;
  let nut = 0;
  let air = 0;
  let medium = 0;
  let value = 0;
  const buckets = new Array<number>(10).fill(0);
  for (const c of combos) {
    total += c.weight;
    eq += c.weight * c.eq;
    if (c.score >= nutLine) nut += c.weight;
    // Made-hand buckets use showdown-now strength: "air" means it cannot win
    // unimproved, which is what decides whether a hand is a bluff candidate.
    if (c.showdown < 0.3) air += c.weight;
    else if (c.showdown < 0.68) medium += c.weight;
    else value += c.weight;
    buckets[Math.min(9, Math.floor(c.eq * 10))] += c.weight;
  }
  const inv = total > 0 ? 1 / total : 0;
  return {
    combos,
    totalWeight: total,
    equity: eq * inv,
    nut: nut * inv,
    air: air * inv,
    medium: medium * inv,
    value: value * inv,
    buckets: buckets.map((b) => b * inv),
  };
}

// ═══════════════════════════ hero equity, for real ═══════════════════════════

/**
 * Monte Carlo equity for one holding against a weighted combo list, sampling
 * both the villain's hand and the runout. Synchronous and fast enough to run
 * inside a solve: 4000 samples is roughly ±0.8%.
 */
export function heroEquityMC(
  hero: readonly CardId[],
  board: readonly CardId[],
  villain: ReadonlyArray<{ cards: readonly [CardId, CardId]; weight: number }>,
  variant: GameVariant = 'nlhe',
  iterations = 4000,
  seed = 0x9e3779b9,
): number {
  if (!villain.length) return 0.5;
  const holeLen = variant === 'plo4' ? 4 : 2;
  const cum = new Float64Array(villain.length);
  let acc = 0;
  for (let i = 0; i < villain.length; i++) {
    acc += villain[i].weight;
    cum[i] = acc;
  }
  if (acc <= 0) return 0.5;

  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const blocked = new Uint8Array(52);
  for (const c of board) blocked[c] = 1;
  for (const c of hero) blocked[c] = 1;
  const used = new Uint8Array(52);
  const deck = new Int32Array(52);
  const full: number[] = new Array(5);
  const need = 5 - board.length;
  const heroBuf: number[] = new Array(holeLen + 5);
  const vilBuf: number[] = new Array(holeLen + 5);
  let win = 0;
  let tie = 0;
  let n = 0;

  for (let it = 0; it < iterations; it++) {
    used.set(blocked);
    let pick: { cards: readonly [CardId, CardId]; weight: number } | null = null;
    for (let tries = 0; tries < 40 && !pick; tries++) {
      const target = rnd() * acc;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      const cand = villain[lo];
      if (used[cand.cards[0]] === 0 && used[cand.cards[1]] === 0) pick = cand;
    }
    if (!pick) continue;
    used[pick.cards[0]] = 1;
    used[pick.cards[1]] = 1;

    let nd = 0;
    for (let c = 0; c < 52; c++) if (used[c] === 0) deck[nd++] = c;
    for (let k = 0; k < board.length; k++) full[k] = board[k];
    for (let k = 0; k < need; k++) {
      const j = k + ((rnd() * (nd - k)) | 0);
      const tmp = deck[k];
      deck[k] = deck[j];
      deck[j] = tmp;
      full[board.length + k] = deck[k];
    }

    let hs: number;
    let vs: number;
    if (holeLen === 4) {
      hs = scorePlo(hero, full);
      vs = scorePlo(pick.cards, full);
    } else {
      heroBuf[0] = hero[0];
      heroBuf[1] = hero[1];
      vilBuf[0] = pick.cards[0];
      vilBuf[1] = pick.cards[1];
      for (let k = 0; k < 5; k++) {
        heroBuf[k + 2] = full[k];
        vilBuf[k + 2] = full[k];
      }
      hs = scoreCards(heroBuf);
      vs = scoreCards(vilBuf);
    }
    n++;
    if (hs > vs) win++;
    else if (hs === vs) tie++;
  }
  return n > 0 ? (win + tie * 0.5) / n : 0.5;
}

// ═══════════════════════════ frequency maths ═══════════════════════════

/** Minimum defense frequency against a bet of `s` × pot. */
export function mdf(s: number): number {
  return 1 / (1 + s);
}
/** Equilibrium bluff share of a betting range using size `s` × pot. */
export function bluffShare(s: number): number {
  return s / (1 + 2 * s);
}
/** Break-even calling equity facing a bet of `s` × pot. */
export function callThreshold(s: number): number {
  return s / (1 + 2 * s);
}

export interface SizeOption {
  id: string;
  label: string;
  fraction: number;
}

const FLOP_SIZES: SizeOption[] = [
  { id: 'bet-33', label: '⅓ pot', fraction: 0.33 },
  { id: 'bet-75', label: '¾ pot', fraction: 0.75 },
];
const TURN_SIZES: SizeOption[] = [
  { id: 'bet-50', label: '½ pot', fraction: 0.5 },
  { id: 'bet-100', label: 'Pot', fraction: 1 },
];
const RIVER_SIZES: SizeOption[] = [
  { id: 'bet-33', label: '⅓ pot', fraction: 0.33 },
  { id: 'bet-75', label: '¾ pot', fraction: 0.75 },
  { id: 'bet-150', label: 'Overbet', fraction: 1.5 },
];

export function sizesFor(street: Street): SizeOption[] {
  if (street === 'turn') return TURN_SIZES;
  if (street === 'river') return RIVER_SIZES;
  return FLOP_SIZES;
}

// ═══════════════════════════ the spot ═══════════════════════════

export interface PostflopSpot {
  variant: GameVariant;
  street: Street;
  board: CardId[];
  hero: CardId[];
  heroRange: RangeGrid;
  villainRange: RangeGrid;
  /** hero acts after the villain on every later street */
  heroIP: boolean;
  /** hero was the preflop raiser */
  heroAggressor: boolean;
  /** everything in the middle right now, INCLUDING any bet hero is facing */
  potBb: number;
  /** the smaller of the two remaining stacks, in bb */
  effectiveBb: number;
  /** the bet hero must call, in bb; 0 when hero may bet */
  facingBb: number;
  opponents?: number;
  /** deterministic Monte Carlo for replays and tests */
  seed?: number;
}

export interface SolveResult extends StrategyNode {
  order: string[];
  labels: Record<string, string>;
  heroEquity: number;
  heroPercentile: number;
  heroOuts: number;
  heroDraw: DrawInfo;
  heroCategory: string;
  texture: BoardTexture;
  hero: RangeOnBoard;
  villain: RangeOnBoard;
  /** hero range equity minus 50% */
  rangeAdvantage: number;
  /** hero nut share minus villain nut share */
  nutAdvantage: number;
  /** how often the villain folds to the model's main line */
  foldEquity: number;
  best: string;
  notes: string[];
}

export function solve(spot: PostflopSpot, heroEquityOverride?: number): SolveResult {
  const { hero, villain, texture } = crossRanges(spot.heroRange, spot.villainRange, spot.board, {
    variant: spot.variant,
    dead: spot.hero,
  });

  const ladder = boardScoreLadder(spot.board, spot.hero);
  const heroScore = scoreOn(spot.hero, spot.board, spot.variant);
  const heroPercentile = percentileIn(ladder, heroScore);
  const heroDraw = drawOuts(spot.hero, spot.board);
  const heroEquity =
    heroEquityOverride ??
    heroEquityMC(spot.hero, spot.board, villain.combos, spot.variant, 4000, spot.seed ?? 0x9e3779b9);

  const ctx: Ctx = {
    spot,
    texture,
    hero,
    villain,
    villainSorted: villain.combos.slice().sort((a, b) => b.eq - a.eq),
    heroEquity,
    heroOuts: heroDraw.outs,
    heroPercentile,
  };

  const node = spot.facingBb > 0 ? facingBet(ctx) : mayBet(ctx);

  let best = node.order[0];
  for (const id of node.order) if ((node.freq[id] ?? 0) > (node.freq[best] ?? 0)) best = id;

  return {
    freq: node.freq,
    ev: node.ev,
    order: node.order,
    labels: node.labels,
    notes: node.notes,
    foldEquity: node.foldEquity,
    heroEquity,
    heroPercentile,
    heroOuts: heroDraw.outs,
    heroDraw,
    heroCategory: categoryName(heroScore),
    texture,
    hero,
    villain,
    rangeAdvantage: hero.equity - 0.5,
    nutAdvantage: hero.nut - villain.nut,
    best,
  };
}

interface Ctx {
  spot: PostflopSpot;
  texture: BoardTexture;
  hero: RangeOnBoard;
  villain: RangeOnBoard;
  /** villain combos sorted best-equity-first, shared by every fold-equity call */
  villainSorted: ComboStat[];
  heroEquity: number;
  heroOuts: number;
  heroPercentile: number;
}

interface RawNode {
  freq: Record<string, number>;
  ev: Record<string, number>;
  order: string[];
  labels: Record<string, string>;
  notes: string[];
  foldEquity: number;
}

/**
 * How often the villain folds to a bet of `s` × pot, and how strong the part
 * of their range that continues is.
 *
 * Defense frequency is minimum defense — 1/(1+s) — nudged by whether the
 * villain has position, because that is what an opponent playing the
 * equilibrium actually does. It is then capped by how much of their range can
 * hold a hand at all: on a board that smashes the bettor, the villain really
 * does get to over-fold, and the model has to let them.
 *
 * The continuing set is the top of their range by equity, so its mean equity
 * falls straight out of the same sort.
 */
function foldEquityAgainst(
  sortedVillain: ComboStat[],
  totalWeight: number,
  rangeEquity: number,
  s: number,
  villainIP: boolean,
): { fold: number; villainCalledEq: number } {
  const target = mdf(s) * (villainIP ? 1.02 : 0.94);
  const floor = callThreshold(s) * 0.5;
  const total = totalWeight || 1;
  let capMass = 0;
  for (const c of sortedVillain) {
    if (c.eq < floor) break;
    capMass += c.weight;
  }
  const cont = clamp(Math.min(target, capMass / total), 0.05, 0.95);
  const want = cont * total;
  let acc = 0;
  let eq = 0;
  for (const c of sortedVillain) {
    if (acc >= want) break;
    const take = Math.min(c.weight, want - acc);
    acc += take;
    eq += take * c.eq;
  }
  return { fold: 1 - cont, villainCalledEq: acc > 0 ? eq / acc : rangeEquity };
}

// ─────────────────────── node: hero may bet ───────────────────────

function mayBet(ctx: Ctx): RawNode {
  const { spot, texture, hero, villain, villainSorted, heroEquity, heroOuts } = ctx;
  const sizes = sizesFor(spot.street);
  const pot = spot.potBb;
  const notes: string[] = [];
  const rangeAdv = hero.equity - 0.5;
  const nutAdv = hero.nut - villain.nut;

  const aggressorBonus = spot.heroAggressor ? 0.1 : -0.05;
  const posBonus = spot.heroIP ? 0.05 : -0.03;
  let betFreqRange = clamp(
    0.30 + 1.5 * rangeAdv + 0.85 * nutAdv + 0.28 * (texture.staticness - 0.5) + aggressorBonus + posBonus,
    0.08,
    0.92,
  );
  if ((spot.opponents ?? 1) > 1) betFreqRange *= 0.72;

  const smallBias = clamp(
    0.5 + 1.5 * (texture.staticness - 0.5) + 1.1 * rangeAdv - 1.0 * nutAdv,
    0.08,
    0.92,
  );
  const rangeShares = splitSizes(sizes.length, smallBias, nutAdv, false);

  const avgFraction = sizes.reduce((acc, s, i) => acc + s.fraction * rangeShares[i], 0);
  const r = bluffShare(avgFraction);
  const valueBetting = hero.value * clamp(betFreqRange / Math.max(0.05, hero.value), 0.4, 0.96);
  const bluffMassNeeded = (valueBetting * r) / Math.max(0.02, 1 - r);
  const bluffFreqBase = clamp(bluffMassNeeded / Math.max(0.05, hero.air), 0.04, 0.85);
  const blockerScore = blockerValue(spot.hero, villain);

  const isValue = heroEquity >= 0.68;
  const isMedium = heroEquity >= 0.42 && heroEquity < 0.68;
  const isDraw = heroOuts >= 8 && heroEquity < 0.62;
  const strongDraw = heroOuts >= 12;

  let betTotal: number;
  if (isValue) {
    betTotal = clamp(0.62 + (heroEquity - 0.68) * 2.6 + 0.5 * nutAdv, 0.55, 0.97);
    if (texture.staticness > 0.62 && heroEquity > 0.88 && spot.street !== 'river') {
      betTotal = Math.min(betTotal, 0.82);
      notes.push('A slice of your strongest hands checks on a board this static — otherwise your checking range is pure air and unbettable later.');
    }
  } else if (isDraw) {
    betTotal = clamp(0.42 + (strongDraw ? 0.22 : 0) + 0.5 * nutAdv + 0.25 * blockerScore, 0.2, 0.85);
    notes.push(`${heroOuts} outs — betting wins it outright often enough, and you still have a way to win when called.`);
  } else if (isMedium) {
    betTotal = clamp(
      0.14 + 0.5 * Math.max(0, texture.staticness - 0.45) + 0.4 * Math.max(0, heroEquity - 0.55),
      0.04,
      0.5,
    );
    notes.push('Showdown value with little to protect — checking keeps the pot small and keeps their worse hands in.');
  } else {
    betTotal = clamp(bluffFreqBase * (0.7 + 0.9 * blockerScore), 0.03, 0.8);
    if (blockerScore > 0.55) notes.push('Useful blockers: your cards remove a slice of the hands that could continue.');
  }
  if ((spot.opponents ?? 1) > 1 && !isValue) betTotal *= 0.6;

  const handSmallBias = clamp(
    smallBias + (isMedium ? 0.25 : 0) - (isDraw ? 0.2 : 0) - (heroEquity > 0.85 ? 0.12 * texture.dynamism : 0),
    0.05,
    0.95,
  );
  const handShares = splitSizes(sizes.length, handSmallBias, nutAdv, heroEquity > 0.85 || heroEquity < 0.2);

  const freq: Record<string, number> = { check: 0 };
  const ev: Record<string, number> = {};
  const labels: Record<string, string> = { check: 'Check' };
  const order = ['check'];
  let mainFold = 0;
  let mainWeight = 0;

  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    const amount = Math.min(spot.effectiveBb, pot * s.fraction);
    const f = betTotal * handShares[i];
    freq[s.id] = f;
    labels[s.id] = `Bet ${amount.toFixed(1)}bb · ${s.label}`;
    order.push(s.id);
    const eff = amount / Math.max(0.01, pot);
    const { fold, villainCalledEq } = foldEquityAgainst(
      villainSorted, villain.totalWeight, villain.equity, eff, !spot.heroIP,
    );
    const eqCalled = clamp01(heroEquity - (villainCalledEq - villain.equity) * 1.1);
    ev[s.id] = fold * pot + (1 - fold) * (eqCalled * (pot + amount) - (1 - eqCalled) * amount);
    mainFold += fold * f;
    mainWeight += f;
  }

  let betSum = 0;
  for (const id of order) if (id !== 'check') betSum += freq[id];
  freq.check = Math.max(0, 1 - betSum);
  const realisation = (spot.heroIP ? 1.0 : 0.88) * (spot.street === 'river' ? 1 : 0.95);
  ev.check = heroEquity * pot * realisation;

  normalise(freq);
  return {
    freq,
    ev,
    order,
    labels,
    notes,
    foldEquity: mainWeight > 0 ? mainFold / mainWeight : 0,
  };
}

function splitSizes(n: number, smallBias: number, nutAdv: number, polarised: boolean): number[] {
  if (n <= 1) return [1];
  if (n === 2) return [smallBias, 1 - smallBias];
  const over = clamp((0.05 + 1.4 * Math.max(0, nutAdv)) * (polarised ? 1.5 : 0.5), 0, 0.42);
  const rest = 1 - over;
  return [smallBias * rest, (1 - smallBias) * rest, over];
}

function blockerValue(hero: readonly CardId[], villain: RangeOnBoard): number {
  let strong = 0;
  let strongBlocked = 0;
  for (const c of villain.combos) {
    if (c.eq < 0.68) continue;
    strong += c.weight;
    for (const h of hero) {
      if (h === c.cards[0] || h === c.cards[1]) {
        strongBlocked += c.weight;
        break;
      }
    }
  }
  if (strong <= 0) return 0.3;
  return clamp01(0.3 + (strongBlocked / strong - 0.08) * 4);
}

// ─────────────────────── node: hero faces a bet ───────────────────────

function facingBet(ctx: Ctx): RawNode {
  const { spot, hero, villain, villainSorted, heroEquity, heroOuts } = ctx;
  const pot = spot.potBb;
  const bet = spot.facingBb;
  const potBefore = Math.max(0.01, pot - bet);
  const s = bet / potBefore;
  const need = callThreshold(s);
  const defense = mdf(s);
  const notes: string[] = [];

  const realisation = spot.heroIP ? 1.05 : 0.93;
  const polarity = clamp01(0.3 + 1.6 * Math.max(0, villain.nut - hero.nut) + 0.5 * Math.max(0, s - 0.8));
  const targetDefense = clamp(defense * realisation * (1 - 0.25 * polarity), 0.15, 0.95);

  const raiseTo = Math.min(spot.effectiveBb, bet * (spot.street === 'river' ? 2.6 : 2.9));
  const strongDraw = heroOuts >= 12;
  const margin = heroEquity - need;

  let raiseFreq: number;
  let callFreq: number;
  if (heroEquity >= 0.78) {
    raiseFreq = clamp(0.45 + 1.2 * (heroEquity - 0.78) + 0.6 * (hero.nut - villain.nut), 0.3, 0.9);
    callFreq = 1 - raiseFreq;
    notes.push('Clear value — raising gets money in against worse and charges the draws.');
  } else if (heroEquity >= 0.62) {
    raiseFreq = clamp(0.12 + 0.8 * (heroEquity - 0.62), 0.05, 0.35);
    callFreq = 1 - raiseFreq;
    notes.push('Strong but not nutted — calling keeps their bluffs in and avoids being blown off a good hand.');
  } else if (margin > 0.06) {
    raiseFreq = strongDraw ? clamp(0.18 + heroOuts * 0.008, 0.1, 0.4) : 0.03;
    callFreq = clamp(0.95 - raiseFreq, 0.3, 0.97);
  } else if (margin > -0.05 || strongDraw) {
    const bias = clamp01(0.5 + margin * 6 + heroOuts * 0.02);
    raiseFreq = strongDraw ? clamp(0.15 + heroOuts * 0.006, 0.05, 0.35) : 0.02;
    callFreq = clamp(bias * targetDefense * 1.4, 0.05, 1 - raiseFreq);
    notes.push(
      `You need ${(need * 100).toFixed(0)}% to call and you have ${(heroEquity * 100).toFixed(0)}% — close to indifferent, so a mix is right.`,
    );
  } else {
    const blockers = blockerValue(spot.hero, villain);
    raiseFreq = clamp((blockers - 0.55) * 0.5, 0, 0.16);
    callFreq = clamp(0.12 + heroOuts * 0.012 + margin * 1.5, 0, 0.35);
    if (raiseFreq > 0.04) notes.push('Not enough equity to call, but the right blockers to turn it into a raise part of the time.');
  }
  if ((spot.opponents ?? 1) > 1) {
    raiseFreq *= 0.7;
    callFreq *= 0.85;
  }

  const freq: Record<string, number> = {
    fold: Math.max(0, 1 - raiseFreq - callFreq),
    call: callFreq,
    raise: raiseFreq,
  };
  normalise(freq);

  const raiseExtra = raiseTo - bet;
  const raiseS = raiseExtra / Math.max(0.01, pot);
  const { fold, villainCalledEq } = foldEquityAgainst(
    villainSorted, villain.totalWeight, villain.equity, raiseS, !spot.heroIP,
  );
  const eqVsRaiseCall = clamp01(heroEquity - (villainCalledEq - villain.equity) * 1.25);

  const ev: Record<string, number> = {
    fold: 0,
    call: heroEquity * pot - (1 - heroEquity) * bet,
    raise:
      fold * pot +
      (1 - fold) * (eqVsRaiseCall * (pot + raiseExtra) - (1 - eqVsRaiseCall) * raiseTo),
  };

  notes.push(
    `Minimum defense against a ${(s * 100).toFixed(0)}%-pot bet is ${(defense * 100).toFixed(0)}%; ` +
      (spot.heroIP
        ? 'in position you realise your equity, so you can defend a shade wider.'
        : 'out of position you realise less of it, so defend a shade under.'),
  );

  return {
    freq,
    ev,
    order: ['fold', 'call', 'raise'],
    labels: {
      fold: 'Fold',
      call: `Call ${bet.toFixed(1)}bb`,
      raise: `Raise to ${raiseTo.toFixed(1)}bb`,
    },
    notes,
    foldEquity: fold,
  };
}

function normalise(freq: Record<string, number>): void {
  let sum = 0;
  for (const k in freq) sum += Math.max(0, freq[k]);
  if (sum <= 0) {
    const keys = Object.keys(freq);
    for (const k of keys) freq[k] = 1 / keys.length;
    return;
  }
  for (const k in freq) freq[k] = Math.max(0, freq[k]) / sum;
}

// ═══════════════════════════ explanation ═══════════════════════════

const pctText = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Turns a solve into a sentence a player can act on. Every number quoted came
 * out of the model above — nothing is invented at the UI layer.
 */
export function explainPostflop(res: SolveResult, chosen: string): string {
  const parts: string[] = [];
  const t = res.texture;

  parts.push(
    `${t.label}. Your range holds ${pctText(res.hero.equity)} equity — ` +
      (res.rangeAdvantage >= 0.03
        ? 'a real range advantage'
        : res.rangeAdvantage <= -0.03
          ? 'a range disadvantage'
          : 'no meaningful edge') +
      ` — and ${pctText(res.hero.nut)} of it is nutted against their ${pctText(res.villain.nut)}.`,
  );

  const drawText = res.heroDraw.label ? ` (${res.heroDraw.label}, ${res.heroOuts} outs)` : '';
  parts.push(
    `You hold ${res.heroCategory.toLowerCase()}${drawText}: ${pctText(res.heroEquity)} against their range.`,
  );

  const bestFreq = res.freq[res.best] ?? 0;
  const bestLabel = res.labels[res.best] ?? res.best;
  if (bestFreq > 0.85) {
    parts.push(`The solution is near-pure: ${bestLabel.toLowerCase()} ${pctText(bestFreq)} of the time.`);
  } else {
    const mix = res.order
      .filter((id) => (res.freq[id] ?? 0) > 0.04)
      .map((id) => `${res.labels[id] ?? id} ${pctText(res.freq[id])}`)
      .join(', ');
    parts.push(`The equilibrium mixes: ${mix}.`);
  }

  if ((res.freq[chosen] ?? 0) < 0.05 && bestFreq > 0.2) {
    parts.push(`${res.labels[chosen] ?? chosen} is not part of the strategy on this texture.`);
  }
  for (const n of res.notes.slice(0, 2)) parts.push(n);
  return parts.join(' ');
}

// ═══════════════════════════ conditioning a range on an action ═══════════════════════════

export interface NarrowOpts {
  /** share of the range that takes the action, 0–1 */
  keep: number;
  /** 0 = linear (top of the range down), 1 = fully polarised (top + bottom) */
  polar?: number;
  dead?: readonly CardId[];
  variant?: GameVariant;
}

/**
 * Approximates the subset of a range that takes an aggressive line, so the
 * next street can be solved against a realistic opponent instead of their
 * whole preflop range. Hands are ordered by made strength on the board; a
 * polarised line also keeps a slice from the bottom as bluffs.
 *
 * This is a model of a betting range, not a solve of one. It is deliberately
 * simple and it is the single biggest approximation in the multi-street
 * drills — a real solver's turn range is shaped by blockers as much as by
 * strength.
 */
export function narrowRange(
  range: RangeGrid,
  board: readonly CardId[],
  opts: NarrowOpts,
): RangeGrid {
  const dead = opts.dead ?? [];
  const combos = expandRange(range, [...board, ...dead]).map((c) => ({
    ...c,
    score: scoreOn(c.cards, board, opts.variant ?? 'nlhe'),
  }));
  if (!combos.length) return { weights: new Float32Array(169) };
  combos.sort((a, b) => b.score - a.score);
  const total = combos.reduce((a, c) => a + c.weight, 0);
  const keep = clamp(opts.keep, 0.02, 1);
  const polar = clamp01(opts.polar ?? 0);
  const topWant = total * keep * (1 - polar);
  const botWant = total * keep * polar;

  const kept = new Float64Array(169);
  const present = new Float64Array(169);
  for (const c of combos) present[c.hand] += c.weight;

  let acc = 0;
  for (const c of combos) {
    if (acc >= topWant) break;
    const take = Math.min(c.weight, topWant - acc);
    acc += take;
    kept[c.hand] += take;
  }
  acc = 0;
  for (let i = combos.length - 1; i >= 0; i--) {
    const c = combos[i];
    if (acc >= botWant) break;
    const take = Math.min(c.weight, botWant - acc);
    acc += take;
    kept[c.hand] += take;
  }

  const weights = new Float32Array(169);
  for (let i = 0; i < 169; i++) {
    if (present[i] > 0) weights[i] = clamp01(kept[i] / present[i]) * (range.weights[i] || 0);
  }
  return { weights };
}
