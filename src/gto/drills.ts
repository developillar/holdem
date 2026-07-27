/**
 * ROYALE — gto/drills.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The drill catalogue: twelve trainable spots, each of which can generate a
 * situation, produce the equilibrium strategy for it, and grade a choice.
 *
 * HOW A SPOT IS SCORED
 *   Frequency decides whether you were right. If the equilibrium takes your
 *   action 40% of the time, you were right — mixing is the strategy, not a
 *   hedge. The score is `(f / fBest)^0.55`, so the top action is 1.00, a
 *   healthy mixed action lands around 0.7, and a line the solution never takes
 *   is 0.
 *
 *   EV loss comes from the models: the preflop EV model below for preflop
 *   nodes, `solver.ts` for postflop ones. One deliberate correction: when the
 *   equilibrium takes an action with meaningful frequency, that action is by
 *   definition close to indifferent, so the reported EV loss is capped. Without
 *   that cap, model noise would print "you lost 0.4bb" for a play the solution
 *   makes half the time, which is simply false.
 *
 * PREFLOP EV MODEL
 *   Each preflop node is expanded into its real branches — everyone folds, one
 *   player calls, someone raises — with the branch probabilities taken from the
 *   actual ranges in `ranges.ts` and the equity taken from a Monte Carlo run
 *   against the continuing range. Postflop play inside a branch is collapsed
 *   into a single equity-realisation factor (1.0 in position, 0.88 out of it),
 *   which is the model's main simplification and is why absolute numbers carry
 *   roughly ±0.2bb.
 */

import type {
  CardId, GameVariant, PositionName, RangeGrid, StrategyNode, Street, TrainerVerdict,
} from '../core/types.ts';
import { Rng } from '../core/rng.ts';
import {
  COMBOS, HAND_COUNT, bbDefendCall, cellCombos, emptyGrid, expandRange, fiveBetCallRange,
  fiveBetJamRange, flatCallRange, fourBetCallRange, fourBetRange, handIndex, handLabel,
  openSize as stdOpenSize, playersBehind, positionLabel, positionLong, pushRange, callJamRange,
  parseRange, rangePct, rfiRange, sbLimpRange, seatsFor, squeezeRange, squeezeSize,
  threeBetRange, threeBetSize,
} from './ranges.ts';
import {
  analyzeBoard, drawOuts, explainPostflop, heroEquityMC, narrowRange, solve,
} from './solver.ts';
import type { PostflopSpot, SolveResult } from './solver.ts';
import { ploFacing3Bet, ploFacingOpen, ploRfi, ploScore, potRaiseTo } from './plo.ts';

// ═══════════════════════════ shapes ═══════════════════════════

export type DrillId =
  | 'rfi' | 'vs-3bet' | 'blind-defense' | 'squeeze' | '4bet-5bet'
  | 'cbet-flop' | 'turn-barrel' | 'river-bluffcatch'
  | 'plo-preflop' | 'bomb-pot' | 'push-fold' | 'icm-bubble';

export type Tier = 'core' | 'sharp' | 'expert';

export const TIERS: Tier[] = ['core', 'sharp', 'expert'];
export const TIER_LABEL: Record<Tier, string> = {
  core: 'Core', sharp: 'Sharp', expert: 'Expert',
};

export type ActionKindUi = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin' | 'limp';

export interface DrillAction {
  id: string;
  label: string;
  sub?: string;
  kind: ActionKindUi;
  /** total chips this action puts in, in bb */
  amountBb: number;
}

export interface SpotSeat {
  pos: PositionName;
  stackBb: number;
  hero: boolean;
  folded: boolean;
  committedBb: number;
  /** short badge, e.g. "Raise 2.5" */
  tag?: string;
}

export interface HistoryStep {
  pos: PositionName;
  text: string;
  kind: ActionKindUi | 'post';
  amountBb?: number;
}

export interface SpotContext {
  heroRange?: RangeGrid;
  villainRange?: RangeGrid;
  openerPos?: PositionName;
  callerPos?: PositionName;
  openBb?: number;
  heroIP?: boolean;
  heroAggressor?: boolean;
  icmPressure?: number;
  /** the drill's own bookkeeping */
  extra?: Record<string, number | string | boolean>;
}

export interface Spot {
  id: string;
  /** stable identity for spaced repetition: same drill, seat, hand class, node */
  key: string;
  drill: DrillId;
  tier: Tier;
  variant: GameVariant;
  tableSize: 6 | 9;
  heroPos: PositionName;
  hero: CardId[];
  board: CardId[];
  street: Street;
  potBb: number;
  effectiveBb: number;
  facingBb: number;
  seats: SpotSeat[];
  history: HistoryStep[];
  prompt: string;
  subPrompt: string;
  actions: DrillAction[];
  ctx: SpotContext;
  /** seed for this spot's Monte Carlo runs, so a verdict is reproducible */
  seed: number;
  /** the RNG seed the spot was generated from — replayable for repetition */
  sourceSeed?: number;
}

export interface DrillStrategy extends StrategyNode {
  order: string[];
  labels: Record<string, string>;
}

export interface RangeLayer {
  action: string;
  label: string;
  grid: RangeGrid;
  /** css color token for the range viewer */
  tone: string;
}

export interface VerdictDetail {
  handLabel: string;
  /** share of all hands the main aggressive action covers here */
  rangePct?: number;
  equity?: number;
  outs?: number;
  texture?: string;
  boardLabel?: string;
  /** layers for the range viewer, empty for postflop nodes */
  layers: RangeLayer[];
  headline: string;
}

export interface Verdict extends TrainerVerdict {
  strategy: DrillStrategy;
  correct: boolean;
  detail: VerdictDetail;
}

export interface DrillDef {
  id: DrillId;
  name: string;
  short: string;
  blurb: string;
  icon: string;
  tier: Tier;
  variant: GameVariant;
  category: 'Preflop' | 'Postflop' | 'Tournament';
  generate(rng: Rng, tier: Tier): Spot;
}

// ═══════════════════════════ small helpers ═══════════════════════════

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `s${idSeq.toString(36)}`;
}

/** Draws `n` cards that are not in `dead`. */
function draw(rng: Rng, n: number, dead: CardId[]): CardId[] {
  const out: CardId[] = [];
  const used = new Set(dead);
  while (out.length < n) {
    const c = rng.int(52);
    if (used.has(c)) continue;
    used.add(c);
    out.push(c);
  }
  return out;
}

/** A concrete two-card combo for a grid index. */
function comboFor(rng: Rng, idx: number, dead: CardId[]): CardId[] {
  const all = cellCombos(idx).filter((c) => !dead.includes(c[0]) && !dead.includes(c[1]));
  if (!all.length) return draw(rng, 2, dead);
  const pick = all[rng.int(all.length)];
  return [pick[0], pick[1]];
}

/**
 * Picks a hand to test. Hands the strategy mixes on are worth far more
 * training reps than hands that are obviously in or obviously out, so they are
 * sampled several times as often — and the harder the tier, the more the
 * sampler leans on the boundary.
 */
function sampleHand(rng: Rng, grids: RangeGrid[], tier: Tier): number {
  const boundaryPull = tier === 'core' ? 1.6 : tier === 'sharp' ? 3.0 : 4.6;
  const weights = new Float64Array(HAND_COUNT);
  let total = 0;
  for (let i = 0; i < HAND_COUNT; i++) {
    let inRange = 0;
    let mixed = 0;
    for (const g of grids) {
      const f = g.weights[i];
      inRange = Math.max(inRange, Math.min(1, f * 2));
      mixed = Math.max(mixed, 1 - Math.abs(2 * f - 1));
    }
    const w = COMBOS[i] * (0.1 + inRange + boundaryPull * mixed);
    weights[i] = w;
    total += w;
  }
  let r = rng.next() * total;
  for (let i = 0; i < HAND_COUNT; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return HAND_COUNT - 1;
}

function seatList(
  tableSize: 6 | 9,
  heroPos: PositionName,
  stacks: number,
  marks: Partial<Record<PositionName, { folded?: boolean; committed?: number; tag?: string }>> = {},
): SpotSeat[] {
  return seatsFor(tableSize).map((pos) => {
    const m = marks[pos] ?? {};
    return {
      pos,
      stackBb: stacks,
      hero: pos === heroPos,
      folded: m.folded ?? false,
      committedBb: m.committed ?? (pos === 'SB' ? 0.5 : pos === 'BB' ? 1 : 0),
      tag: m.tag,
    };
  });
}

function foldsBefore(tableSize: 6 | 9, upTo: PositionName): HistoryStep[] {
  const seats = seatsFor(tableSize);
  const idx = seats.indexOf(upTo);
  const out: HistoryStep[] = [];
  for (let i = 0; i < idx; i++) {
    out.push({ pos: seats[i], text: 'folds', kind: 'fold' });
  }
  return out;
}

const ALL_HANDS: RangeGrid = { weights: new Float32Array(HAND_COUNT).fill(1) };

// ═══════════════════════════ the preflop EV model ═══════════════════════════

interface Branch {
  p: number;
  ev: number;
}

function mixBranches(branches: Branch[]): number {
  let total = 0;
  let ev = 0;
  for (const b of branches) {
    total += b.p;
    ev += b.p * b.ev;
  }
  return total > 0 ? ev / total : 0;
}

const EQ_ITERS = 2000;

/**
 * Preflop equity against a range. Memoised per (range, hand) because the EV
 * anchoring below asks for the same range with two or three different hands.
 */
const eqMemo = new WeakMap<RangeGrid, Map<string, number>>();

function equityVsRange(hero: CardId[], range: RangeGrid, seed: number, variant: GameVariant = 'nlhe'): number {
  let byHand = eqMemo.get(range);
  if (!byHand) {
    byHand = new Map();
    eqMemo.set(range, byHand);
  }
  const key = hero.join(',');
  const hit = byHand.get(key);
  if (hit !== undefined) return hit;
  const combos = expandRange(range, hero).map((c) => ({ cards: c.cards, weight: c.weight }));
  const val = combos.length ? heroEquityMC(hero, [], combos, variant, EQ_ITERS, seed) : 0.5;
  byHand.set(key, val);
  return val;
}

// ─────────────────────── equilibrium anchoring ───────────────────────

/**
 * Sample hands that sit on a range's boundary. At equilibrium the *worst* hand
 * that takes an action is the indifferent one, so the anchor is the minimum
 * raw EV across a spread of hands the solution actually plays that way — five
 * probes spaced through the range, which is enough to find the margin without
 * paying for a full sweep.
 */
function boundaryProbes(grid: RangeGrid, count = 5): CardId[][] {
  const live: number[] = [];
  for (let i = 0; i < HAND_COUNT; i++) if (grid.weights[i] >= 0.25) live.push(i);
  if (!live.length) {
    for (let i = 0; i < HAND_COUNT; i++) if (grid.weights[i] > 0.02) live.push(i);
  }
  if (!live.length) return [];
  const out: CardId[][] = [];
  const step = Math.max(1, Math.floor(live.length / count));
  for (let k = 0; k < live.length && out.length < count; k += step) {
    const combo = firstCombo(live[k]);
    if (combo) out.push(combo);
  }
  const last = firstCombo(live[live.length - 1]);
  if (last && out.length < count + 1) out.push(last);
  return out;
}

function firstCombo(idx: number): CardId[] | null {
  const all = cellCombos(idx);
  return all.length ? [all[0][0], all[0][1]] : null;
}

export interface AnchorSpec {
  /** non-fold actions, each with the range whose boundary anchors it */
  actions: Array<{ id: string; grid: RangeGrid }>;
  /** raw branch EV for an arbitrary holding, in bb, folding = 0 */
  compute(hero: CardId[]): Record<string, number>;
}

/**
 * Shifts every action's EV so that the weakest hand the equilibrium takes it
 * with is exactly break-even against folding. This is what makes the numbers
 * usable: a fixed-range branch model always overvalues aggression (the real
 * opponent would widen), and anchoring on the range boundary removes that bias
 * while keeping the differences between hands intact. Reported EV is therefore
 * "how much better or worse than the marginal hand this line is".
 */
function anchoredEv(hero: CardId[], spec: AnchorSpec): Record<string, number> {
  const raw = spec.compute(hero);
  const out: Record<string, number> = { fold: 0 };
  for (const a of spec.actions) {
    const probes = boundaryProbes(a.grid);
    let margin: number | null = null;
    for (const p of probes) {
      const v = spec.compute(p)[a.id];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (margin === null || v < margin) margin = v;
    }
    out[a.id] = (raw[a.id] ?? 0) - (margin ?? 0);
  }
  return out;
}

/** Blends several ranges by how often each is the one you actually face. */
function blendRanges(parts: Array<{ grid: RangeGrid; weight: number }>): RangeGrid {
  const out = new Float32Array(HAND_COUNT);
  let total = 0;
  for (const p of parts) total += p.weight;
  if (total <= 0) return ALL_HANDS;
  for (const p of parts) {
    const k = p.weight / total;
    for (let i = 0; i < HAND_COUNT; i++) out[i] += p.grid.weights[i] * k;
  }
  return { weights: out };
}

/**
 * EV of a wager, measured as the change in your stack from this moment on.
 *
 *   potBefore  everything already in the middle, including your own earlier
 *              commitment (which is sunk — folding is the zero baseline)
 *   cost       the new chips this action takes out of your stack
 *   finalPot   the pot if the wager is called
 *
 * Villain folds → you gain `potBefore`. Called and you win → `finalPot − cost`.
 * Called and you lose → `−cost`. With fold equity set at minimum defense a
 * pure bluff comes out at exactly zero, which is the check that the algebra is
 * right.
 */
function wagerEv(
  potBefore: number,
  cost: number,
  finalPot: number,
  pFold: number,
  eqWhenCalled: number,
): number {
  return pFold * potBefore + (1 - pFold) * (eqWhenCalled * (finalPot - cost) - (1 - eqWhenCalled) * cost);
}

/** Fold equity can never exceed the level that makes a pure bluff break even. */
function mdfFoldCap(potBefore: number, risk: number): number {
  return risk / (risk + potBefore);
}

interface OpenBranches {
  foldOut: number;
  threeBet: number;
  called: number;
  callerRange: RangeGrid;
}

function openBranches(heroPos: PositionName, tableSize: 6 | 9, size: number): OpenBranches {
  const seats = seatsFor(tableSize);
  const behind = seats.slice(seats.indexOf(heroPos) + 1);
  let noAction = 1;
  let noRaise = 1;
  const callers: Array<{ grid: RangeGrid; weight: number }> = [];
  for (const pos of behind) {
    const raise = rangePct(threeBetRange(heroPos, pos, tableSize));
    const callGrid = pos === 'BB' ? bbDefendCall(heroPos, size) : flatCallRange(heroPos, pos);
    const call = rangePct(callGrid);
    noAction *= clamp(1 - raise - call, 0, 1);
    noRaise *= clamp(1 - raise, 0, 1);
    callers.push({ grid: callGrid, weight: call });
  }
  const foldOut = clamp(noAction, 0, 1);
  const threeBet = clamp(1 - noRaise, 0, 1);
  return {
    foldOut,
    threeBet,
    called: clamp(1 - foldOut - threeBet, 0, 1),
    callerRange: blendRanges(callers.length ? callers : [{ grid: ALL_HANDS, weight: 1 }]),
  };
}

/**
 * Raw EV of opening for `size`. Three branches: everyone folds, one player
 * calls, someone re-raises. The re-raise branch is valued by how much of your
 * own hand can continue against a 4-bet.
 */
function evOpenRaise(
  hero: CardId[],
  heroPos: PositionName,
  tableSize: 6 | 9,
  size: number,
  seed: number,
  branches: OpenBranches,
): number {
  const posted = heroPos === 'SB' ? 0.5 : heroPos === 'BB' ? 1 : 0;
  const cost = size - posted;
  const potBefore = 1.5;
  const seats = seatsFor(tableSize);
  const behind = seats.slice(seats.indexOf(heroPos) + 1);
  const foldedBlinds =
    (behind.includes('SB') ? 0 : 0.5) + (behind.includes('BB') ? 0 : 1) - posted;
  const finalPot = size * 2 + Math.max(0, foldedBlinds);
  const eq = equityVsRange(hero, branches.callerRange, seed);
  // Collapsed postflop play: you realise almost all of your equity in position
  // against the blinds, noticeably less against a caller who acts after you.
  const realisation = heroPos === 'BTN' || heroPos === 'CO' ? 0.97 : 0.9;
  const eqR = clamp(eq * realisation, 0, 1);

  const idx = handIndex(hero[0], hero[1]);
  const continueVs4bet = clamp(
    fourBetRange(heroPos, 'BB').weights[idx] + fourBetCallRange(heroPos, 'BB').weights[idx],
    0,
    1,
  );

  return mixBranches([
    { p: branches.foldOut, ev: potBefore },
    { p: branches.called, ev: eqR * (finalPot - cost) - (1 - eqR) * cost },
    { p: branches.threeBet, ev: -cost + continueVs4bet * size * 1.7 },
  ]);
}

// ═══════════════════════════ scoring ═══════════════════════════

function bestOf(node: DrillStrategy): string {
  let best = node.order[0];
  for (const id of node.order) if ((node.freq[id] ?? 0) > (node.freq[best] ?? 0)) best = id;
  return best;
}

/**
 * An action the equilibrium plays with real frequency is close to indifferent
 * by construction, so the model's EV gap for it is noise. Cap it.
 */
function cappedLoss(rawLoss: number, freq: number): number {
  if (freq <= 0.02) return Math.max(0, rawLoss);
  return Math.max(0, Math.min(rawLoss, 0.13 * (1 - Math.min(1, freq))));
}

function scoreFor(freq: number, bestFreq: number): number {
  if (bestFreq <= 0) return 0;
  return Math.pow(clamp(freq / bestFreq, 0, 1), 0.55);
}

function buildVerdict(
  node: DrillStrategy,
  chosenRaw: string,
  explanation: string,
  detail: VerdictDetail,
): Verdict {
  // An id the node does not contain would score against nothing and print a
  // fabricated EV loss. Snap it to the nearest action the node does offer.
  const chosen = node.order.includes(chosenRaw) ? chosenRaw : nearestAction(node, chosenRaw);
  const best = bestOf(node);
  const f = node.freq[chosen] ?? 0;
  const bestF = node.freq[best] ?? 0;
  const raw = (node.ev[best] ?? 0) - (node.ev[chosen] ?? 0);
  const evLossBb = cappedLoss(raw, f);
  return {
    chosen,
    optimal: best,
    score: scoreFor(f, bestF),
    evLossBb,
    explanation,
    strategy: node,
    correct: f >= 0.15 || f >= bestF * 0.45,
    detail,
  };
}

/** Nearest offered action to an unknown id, matched on bet fraction. */
function nearestAction(node: DrillStrategy, id: string): string {
  const want = /^bet-(\d+)$/.exec(id);
  if (want) {
    const target = Number(want[1]);
    let best = node.order[0];
    let bestD = Infinity;
    for (const candidate of node.order) {
      const m = /^bet-(\d+)$/.exec(candidate);
      if (!m) continue;
      const d = Math.abs(Number(m[1]) - target);
      if (d < bestD) {
        bestD = d;
        best = candidate;
      }
    }
    if (bestD < Infinity) return best;
  }
  return node.order.includes('check') ? 'check' : node.order[0];
}

function normFreq(freq: Record<string, number>): Record<string, number> {
  let sum = 0;
  for (const k in freq) sum += Math.max(0, freq[k]);
  const out: Record<string, number> = {};
  for (const k in freq) out[k] = sum > 0 ? Math.max(0, freq[k]) / sum : 0;
  return out;
}

const pctText = (v: number): string => `${Math.round(v * 100)}%`;
const bbText = (v: number): string => `${v.toFixed(v >= 10 ? 0 : 1)}bb`;

// ═══════════════════════════ drill 1 — preflop RFI ═══════════════════════════

function genRfi(rng: Rng, tier: Tier): Spot {
  const tableSize: 6 | 9 = tier === 'core' ? 6 : rng.bool(0.5) ? 6 : 9;
  const seats = seatsFor(tableSize).filter((p) => p !== 'BB');
  const heroPos = seats[rng.int(seats.length)];
  const rfi = rfiRange(heroPos, tableSize);
  const limp = heroPos === 'SB' ? sbLimpRange() : emptyGrid();
  const idx = sampleHand(rng, heroPos === 'SB' ? [rfi, limp] : [rfi], tier);
  const hero = comboFor(rng, idx, []);
  const size = stdOpenSize(heroPos);
  const stacks = 100;

  const actions: DrillAction[] = [
    { id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 },
  ];
  if (heroPos === 'SB') actions.push({ id: 'limp', label: 'Limp', sub: '1bb', kind: 'limp', amountBb: 1 });
  actions.push({ id: 'raise', label: `Raise ${size}bb`, sub: `${(size / 1).toFixed(1)}× the blind`, kind: 'raise', amountBb: size });

  return {
    id: nextId(),
    key: `rfi:${tableSize}:${heroPos}:${handLabel(idx)}`,
    drill: 'rfi',
    tier,
    variant: 'nlhe',
    tableSize,
    heroPos,
    hero,
    board: [],
    street: 'preflop',
    potBb: 1.5,
    effectiveBb: stacks,
    facingBb: 0,
    seats: seatList(tableSize, heroPos, stacks),
    history: foldsBefore(tableSize, heroPos),
    prompt: 'Folded to you',
    subPrompt: `${positionLabel(heroPos)} · ${tableSize}-max · 100bb`,
    actions,
    ctx: { heroRange: rfi, openBb: size },
    seed: rng.nextU32(),
  };
}

function strategyRfi(spot: Spot): DrillStrategy {
  const idx = handIndex(spot.hero[0], spot.hero[1]);
  const rfi = rfiRange(spot.heroPos, spot.tableSize);
  const limpGrid = spot.heroPos === 'SB' ? sbLimpRange() : emptyGrid();
  const size = spot.ctx.openBb ?? 2.5;
  const raise = rfi.weights[idx];
  const limp = limpGrid.weights[idx];
  const freq = normFreq({ fold: Math.max(0, 1 - raise - limp), limp, raise });
  const branches = openBranches(spot.heroPos, spot.tableSize, size);
  const bbRange = bbDefendCall(spot.heroPos, size);

  const spec: AnchorSpec = {
    actions:
      spot.heroPos === 'SB'
        ? [{ id: 'limp', grid: limpGrid }, { id: 'raise', grid: rfi }]
        : [{ id: 'raise', grid: rfi }],
    compute: (hand) => {
      const out: Record<string, number> = {
        raise: evOpenRaise(hand, spot.heroPos, spot.tableSize, size, spot.seed, branches),
      };
      if (spot.heroPos === 'SB') {
        // Limping builds a 2bb pot the BB always sees, played out of position
        // with the worst realisation in the game.
        const eq = equityVsRange(hand, bbRange, spot.seed ^ 0x515);
        out.limp = eq * 0.82 * 1.5 - (1 - eq * 0.82) * 0.5;
      }
      return out;
    },
  };

  return {
    freq,
    ev: anchoredEv(spot.hero, spec),
    order: spot.heroPos === 'SB' ? ['fold', 'limp', 'raise'] : ['fold', 'raise'],
    labels: { fold: 'Fold', limp: 'Limp', raise: `Raise ${size}bb` },
  };
}

// ═══════════════════════════ drill 2 — facing a 3-bet ═══════════════════════════

function genVs3Bet(rng: Rng, tier: Tier): Spot {
  const tableSize: 6 | 9 = tier === 'core' ? 6 : rng.bool(0.6) ? 6 : 9;
  const seats = seatsFor(tableSize);
  const openable = seats.filter((p) => p !== 'BB' && p !== 'SB');
  const heroPos = openable[rng.int(openable.length)];
  const after = seats.slice(seats.indexOf(heroPos) + 1);
  const threeBettor = after[rng.int(after.length)];
  const openBb = stdOpenSize(heroPos);
  const threeBb = Math.round(threeBetSize(threeBettor, openBb) * 2) / 2;

  const fourBet = fourBetRange(heroPos, threeBettor);
  const callGrid = fourBetCallRange(heroPos, threeBettor);
  const idx = sampleHand(rng, [rfiRange(heroPos, tableSize), fourBet, callGrid], tier);
  const hero = comboFor(rng, idx, []);
  const stacks = 100;
  const fourBetTo = Math.round((threeBettor === 'SB' || threeBettor === 'BB' ? threeBb * 2.4 : threeBb * 2.2) * 2) / 2;

  const history = [
    ...foldsBefore(tableSize, heroPos),
    { pos: heroPos, text: `raises to ${openBb}bb`, kind: 'raise' as const, amountBb: openBb },
    ...seats.slice(seats.indexOf(heroPos) + 1, seats.indexOf(threeBettor)).map((p) => ({
      pos: p, text: 'folds', kind: 'fold' as const,
    })),
    { pos: threeBettor, text: `3-bets to ${threeBb}bb`, kind: 'raise' as const, amountBb: threeBb },
  ];

  return {
    id: nextId(),
    key: `vs3b:${heroPos}:${threeBettor}:${handLabel(idx)}`,
    drill: 'vs-3bet',
    tier,
    variant: 'nlhe',
    tableSize,
    heroPos,
    hero,
    board: [],
    street: 'preflop',
    potBb: openBb + threeBb + (threeBettor === 'BB' ? 0.5 : threeBettor === 'SB' ? 1 : 1.5),
    effectiveBb: stacks,
    facingBb: threeBb - openBb,
    seats: seatList(tableSize, heroPos, stacks, {
      [heroPos]: { committed: openBb, tag: `Raise ${openBb}` },
      [threeBettor]: { committed: threeBb, tag: `3-bet ${threeBb}` },
    }),
    history,
    prompt: `${positionLabel(threeBettor)} 3-bets to ${threeBb}bb`,
    subPrompt: `You opened ${openBb}bb from ${positionLabel(heroPos)}`,
    actions: [
      { id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 },
      { id: 'call', label: 'Call', sub: `${bbText(threeBb - openBb)} more`, kind: 'call', amountBb: threeBb },
      { id: '4bet', label: `4-bet ${fourBetTo}bb`, kind: 'raise', amountBb: fourBetTo },
    ],
    ctx: { openerPos: heroPos, callerPos: threeBettor, openBb, extra: { threeBb, fourBetTo } },
    seed: rng.nextU32(),
  };
}

function strategyVs3Bet(spot: Spot): DrillStrategy {
  const idx = handIndex(spot.hero[0], spot.hero[1]);
  const villain = spot.ctx.callerPos as PositionName;
  const openBb = spot.ctx.openBb ?? 2.5;
  const threeBb = Number(spot.ctx.extra?.threeBb ?? 7.5);
  const fourBetTo = Number(spot.ctx.extra?.fourBetTo ?? 22);
  const fourBet = fourBetRange(spot.heroPos, villain).weights[idx];
  const call = Math.max(0, fourBetCallRange(spot.heroPos, villain).weights[idx] - fourBet);
  const freq = normFreq({ fold: Math.max(0, 1 - fourBet - call), call, '4bet': fourBet });

  const threeBetGrid = threeBetRange(spot.heroPos, villain, spot.tableSize);
  const dead = spot.potBb - openBb - threeBb;
  const potBefore = openBb + threeBb + dead;
  const jam = fiveBetJamRange();
  const callFive = fiveBetCallRange();
  const continueGrid = blendRanges([
    { grid: jam, weight: rangePct(jam) },
    { grid: callFive, weight: rangePct(callFive) },
  ]);
  const threeBetMass = Math.max(0.01, rangePct(threeBetGrid));
  const byRange = clamp((rangePct(jam) + rangePct(callFive)) / threeBetMass, 0.05, 0.95);
  const fourBetRisk = fourBetTo - openBb;
  const pFold4bet = Math.min(1 - byRange, mdfFoldCap(potBefore, fourBetRisk));

  const spec: AnchorSpec = {
    actions: [
      { id: 'call', grid: fourBetCallRange(spot.heroPos, villain) },
      { id: '4bet', grid: fourBetRange(spot.heroPos, villain) },
    ],
    compute: (hand) => {
      const eq = equityVsRange(hand, threeBetGrid, spot.seed);
      const realisation = villain === 'SB' || villain === 'BB' ? 0.98 : 0.89;
      const eqR = clamp(eq * realisation, 0, 1);
      const callCost = threeBb - openBb;
      const eqVsContinue = equityVsRange(hand, continueGrid, spot.seed ^ 0x5bf0);
      return {
        call: eqR * (threeBb * 2 + dead - callCost) - (1 - eqR) * callCost,
        '4bet': wagerEv(potBefore, fourBetRisk, fourBetTo * 2 + dead, pFold4bet, eqVsContinue),
      };
    },
  };

  return {
    freq,
    ev: anchoredEv(spot.hero, spec),
    order: ['fold', 'call', '4bet'],
    labels: { fold: 'Fold', call: `Call ${bbText(threeBb - openBb)}`, '4bet': `4-bet ${fourBetTo}bb` },
  };
}

// ═══════════════════════════ drill 3 — blind defense ═══════════════════════════

const OPEN_SIZES: number[] = [2, 2.5, 3];

function genBlindDefense(rng: Rng, tier: Tier): Spot {
  const tableSize: 6 | 9 = tier === 'core' ? 6 : rng.bool(0.6) ? 6 : 9;
  const seats = seatsFor(tableSize);
  const openers = seats.filter((p) => p !== 'BB');
  const opener = openers[rng.int(openers.length)];
  const openBb = tier === 'core'
    ? 2.5
    : opener === 'SB'
      ? (rng.bool(0.5) ? 3 : 2)
      : OPEN_SIZES[rng.int(OPEN_SIZES.length)];

  const callGrid = bbDefendCall(opener, openBb);
  const threeBet = threeBetRange(opener, 'BB', tableSize);
  const idx = sampleHand(rng, [callGrid, threeBet], tier);
  const hero = comboFor(rng, idx, []);
  const threeBetTo = Math.round(openBb * 3.6 * 2) / 2;
  const stacks = 100;
  const dead = opener === 'SB' ? 0 : 0.5;

  return {
    id: nextId(),
    key: `bbdef:${opener}:${openBb}:${handLabel(idx)}`,
    drill: 'blind-defense',
    tier,
    variant: 'nlhe',
    tableSize,
    heroPos: 'BB',
    hero,
    board: [],
    street: 'preflop',
    potBb: openBb + 1 + dead,
    effectiveBb: stacks,
    facingBb: openBb - 1,
    seats: seatList(tableSize, 'BB', stacks, {
      [opener]: { committed: openBb, tag: `Raise ${openBb}` },
    }),
    history: [
      ...foldsBefore(tableSize, opener),
      { pos: opener, text: `raises to ${openBb}bb`, kind: 'raise', amountBb: openBb },
      ...seats.slice(seats.indexOf(opener) + 1, seats.length - 1).map((p) => ({
        pos: p, text: 'folds', kind: 'fold' as const,
      })),
    ],
    prompt: `${positionLabel(opener)} opens to ${openBb}bb`,
    subPrompt: `You are in the big blind, closing the action`,
    actions: [
      { id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 },
      { id: 'call', label: 'Call', sub: `${bbText(openBb - 1)} more`, kind: 'call', amountBb: openBb },
      { id: '3bet', label: `3-bet ${threeBetTo}bb`, kind: 'raise', amountBb: threeBetTo },
    ],
    ctx: { openerPos: opener, openBb, extra: { threeBetTo } },
    seed: rng.nextU32(),
  };
}

function strategyBlindDefense(spot: Spot): DrillStrategy {
  const idx = handIndex(spot.hero[0], spot.hero[1]);
  const opener = spot.ctx.openerPos as PositionName;
  const openBb = spot.ctx.openBb ?? 2.5;
  const threeBetTo = Number(spot.ctx.extra?.threeBetTo ?? 9);
  const threeBet = threeBetRange(opener, 'BB', spot.tableSize).weights[idx];
  const call = bbDefendCall(opener, openBb).weights[idx];
  const freq = normFreq({ fold: Math.max(0, 1 - threeBet - call), call, '3bet': threeBet });

  const openRange = rfiRange(opener, spot.tableSize);
  const dead = opener === 'SB' ? 0 : 0.5;
  const potBefore = openBb + 1 + dead;
  const fourBet = fourBetRange(opener, 'BB');
  const callThree = fourBetCallRange(opener, 'BB');
  const openMass = Math.max(0.01, rangePct(openRange));
  const threeRisk = threeBetTo - 1;
  const byRange = clamp((rangePct(fourBet) + rangePct(callThree)) / openMass, 0.05, 0.95);
  const pFold3bet = Math.min(1 - byRange, mdfFoldCap(potBefore, threeRisk));
  const pFourBet = clamp(rangePct(fourBet) / openMass, 0.02, 0.5);

  const spec: AnchorSpec = {
    actions: [
      { id: 'call', grid: bbDefendCall(opener, openBb) },
      { id: '3bet', grid: threeBetRange(opener, 'BB', spot.tableSize) },
    ],
    compute: (hand) => {
      const eq = equityVsRange(hand, openRange, spot.seed);
      // The BB is out of position against everyone except the small blind.
      const eqR = clamp(eq * (opener === 'SB' ? 0.99 : 0.85), 0, 1);
      const callCost = openBb - 1;
      const eqVsCall = equityVsRange(hand, callThree, spot.seed ^ 0x11ee);
      const hIdx = handIndex(hand[0], hand[1]);
      const continueVs4bet = clamp(
        fiveBetJamRange().weights[hIdx] + fiveBetCallRange().weights[hIdx],
        0,
        1,
      );
      const called = mixBranches([
        { p: 1 - pFourBet, ev: eqVsCall * 0.98 * (threeBetTo * 2 + dead - threeRisk) - (1 - eqVsCall * 0.98) * threeRisk },
        { p: pFourBet, ev: -threeRisk + continueVs4bet * threeBetTo * 1.5 },
      ]);
      return {
        call: eqR * (openBb * 2 + dead - callCost) - (1 - eqR) * callCost,
        '3bet': pFold3bet * potBefore + (1 - pFold3bet) * called,
      };
    },
  };

  return {
    freq,
    ev: anchoredEv(spot.hero, spec),
    order: ['fold', 'call', '3bet'],
    labels: { fold: 'Fold', call: `Call ${bbText(openBb - 1)}`, '3bet': `3-bet ${threeBetTo}bb` },
  };
}

// ═══════════════════════════ drill 4 — squeeze ═══════════════════════════

function genSqueeze(rng: Rng, tier: Tier): Spot {
  const tableSize: 6 | 9 = tier === 'core' ? 6 : rng.bool(0.5) ? 6 : 9;
  const seats = seatsFor(tableSize);
  const openIdx = rng.int(Math.max(1, seats.length - 4));
  const opener = seats[openIdx];
  const between = seats.slice(openIdx + 1, seats.length - 2);
  const caller = between.length ? between[rng.int(between.length)] : seats[seats.length - 3];
  const heroPos: PositionName = rng.bool(0.6) ? 'BB' : 'SB';
  const openBb = stdOpenSize(opener);
  const squeezeTo = Math.round(squeezeSize(heroPos, openBb, 1) * 2) / 2;

  const sq = squeezeRange(opener, heroPos);
  const flat = heroPos === 'BB' ? bbDefendCall(opener, openBb) : flatCallRange(opener, 'SB');
  const idx = sampleHand(rng, [sq, flat], tier);
  const hero = comboFor(rng, idx, []);
  const stacks = 100;
  const dead = heroPos === 'BB' ? 0.5 : 1;

  return {
    id: nextId(),
    key: `sqz:${opener}:${caller}:${heroPos}:${handLabel(idx)}`,
    drill: 'squeeze',
    tier,
    variant: 'nlhe',
    tableSize,
    heroPos,
    hero,
    board: [],
    street: 'preflop',
    potBb: openBb * 2 + dead + (heroPos === 'BB' ? 1 : 0.5),
    effectiveBb: stacks,
    facingBb: openBb - (heroPos === 'BB' ? 1 : 0.5),
    seats: seatList(tableSize, heroPos, stacks, {
      [opener]: { committed: openBb, tag: `Raise ${openBb}` },
      [caller]: { committed: openBb, tag: 'Call' },
    }),
    history: [
      ...foldsBefore(tableSize, opener),
      { pos: opener, text: `raises to ${openBb}bb`, kind: 'raise', amountBb: openBb },
      { pos: caller, text: `calls ${openBb}bb`, kind: 'call', amountBb: openBb },
    ],
    prompt: `${positionLabel(opener)} opens, ${positionLabel(caller)} calls`,
    subPrompt: `${positionLabel(heroPos)} · two players already in`,
    actions: [
      { id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 },
      { id: 'call', label: 'Call', sub: `${bbText(openBb - (heroPos === 'BB' ? 1 : 0.5))} more`, kind: 'call', amountBb: openBb },
      { id: 'squeeze', label: `Squeeze ${squeezeTo}bb`, kind: 'raise', amountBb: squeezeTo },
    ],
    ctx: { openerPos: opener, callerPos: caller, openBb, extra: { squeezeTo } },
    seed: rng.nextU32(),
  };
}

function strategySqueeze(spot: Spot): DrillStrategy {
  const idx = handIndex(spot.hero[0], spot.hero[1]);
  const opener = spot.ctx.openerPos as PositionName;
  const openBb = spot.ctx.openBb ?? 2.5;
  const squeezeTo = Number(spot.ctx.extra?.squeezeTo ?? 12);
  const sq = squeezeRange(opener, spot.heroPos).weights[idx];
  // Cold-calling gets much worse with a player already in and more behind, so
  // the flatting range is a discounted version of the heads-up one.
  const flatBase = spot.heroPos === 'BB'
    ? bbDefendCall(opener, openBb).weights[idx]
    : flatCallRange(opener, 'SB').weights[idx];
  const call = Math.max(0, flatBase * 0.62 - sq);
  const freq = normFreq({ fold: Math.max(0, 1 - sq - call), call, squeeze: sq });

  const opponents = blendRanges([
    { grid: rfiRange(opener, spot.tableSize), weight: 1 },
    { grid: flatCallRange(opener, 'BTN'), weight: 1 },
  ]);
  const posted = spot.heroPos === 'BB' ? 1 : 0.5;
  const toCall = openBb - posted;
  const potBefore = spot.potBb;
  const squeezeRisk = squeezeTo - posted;

  // Both opponents have to clear a far steeper price than the original raise.
  const openerContinue = clamp(
    rangePct(fourBetRange(opener, spot.heroPos)) + rangePct(fourBetCallRange(opener, spot.heroPos)),
    0.02,
    1,
  );
  const openMass = Math.max(0.01, rangePct(rfiRange(opener, spot.tableSize)));
  const pOpener = clamp(openerContinue / openMass, 0.05, 0.7);
  const pCaller = 0.22;
  const byRange = 1 - (1 - pOpener) * (1 - pCaller);
  const pFoldOut = Math.min(1 - byRange, mdfFoldCap(potBefore, squeezeRisk));
  const continueGrid = fourBetCallRange(opener, spot.heroPos);
  const flatGrid = spot.heroPos === 'BB' ? bbDefendCall(opener, openBb) : flatCallRange(opener, 'SB');

  const spec: AnchorSpec = {
    actions: [
      { id: 'call', grid: flatGrid },
      { id: 'squeeze', grid: squeezeRange(opener, spot.heroPos) },
    ],
    compute: (hand) => {
      const eq = equityVsRange(hand, opponents, spot.seed);
      // Three-way, out of position, from the blinds: realisation is poor.
      const eqR = clamp(eq * 0.78, 0, 1);
      const eqVsContinue = equityVsRange(hand, continueGrid, spot.seed ^ 0x2f19);
      return {
        call: eqR * (potBefore + toCall * 2 - toCall) - (1 - eqR) * toCall,
        squeeze: wagerEv(
          potBefore,
          squeezeRisk,
          squeezeTo * 2 + openBb + (spot.heroPos === 'BB' ? 0.5 : 1),
          pFoldOut,
          clamp(eqVsContinue * 0.95, 0, 1),
        ),
      };
    },
  };

  return {
    freq,
    ev: anchoredEv(spot.hero, spec),
    order: ['fold', 'call', 'squeeze'],
    labels: { fold: 'Fold', call: `Call ${bbText(toCall)}`, squeeze: `Squeeze ${squeezeTo}bb` },
  };
}

// ═══════════════════════════ drill 5 — 4-bet / 5-bet ═══════════════════════════

function genFourBet(rng: Rng, tier: Tier): Spot {
  const tableSize: 6 | 9 = 6;
  const seats = seatsFor(tableSize);
  const openers = seats.filter((p) => p !== 'BB' && p !== 'SB');
  const opener = openers[rng.int(openers.length)];
  const heroChoices = seats.slice(seats.indexOf(opener) + 1);
  const heroPos = heroChoices[rng.int(heroChoices.length)];
  const openBb = stdOpenSize(opener);
  const threeBb = Math.round(threeBetSize(heroPos, openBb) * 2) / 2;
  const fourBetTo = Math.round((heroPos === 'SB' || heroPos === 'BB' ? threeBb * 2.4 : threeBb * 2.2) * 2) / 2;

  const jam = fiveBetJamRange();
  const callFive = fiveBetCallRange();
  const idx = sampleHand(rng, [threeBetRange(opener, heroPos, tableSize), jam, callFive], tier);
  const hero = comboFor(rng, idx, []);
  const stacks = 100;
  const dead = 1.5 - (heroPos === 'SB' ? 0.5 : 0) - (heroPos === 'BB' ? 1 : 0);

  return {
    id: nextId(),
    key: `4b5b:${opener}:${heroPos}:${handLabel(idx)}`,
    drill: '4bet-5bet',
    tier,
    variant: 'nlhe',
    tableSize,
    heroPos,
    hero,
    board: [],
    street: 'preflop',
    potBb: fourBetTo + threeBb + dead,
    effectiveBb: stacks,
    facingBb: fourBetTo - threeBb,
    seats: seatList(tableSize, heroPos, stacks, {
      [opener]: { committed: fourBetTo, tag: `4-bet ${fourBetTo}` },
      [heroPos]: { committed: threeBb, tag: `3-bet ${threeBb}` },
    }),
    history: [
      ...foldsBefore(tableSize, opener),
      { pos: opener, text: `raises to ${openBb}bb`, kind: 'raise', amountBb: openBb },
      { pos: heroPos, text: `3-bets to ${threeBb}bb`, kind: 'raise', amountBb: threeBb },
      { pos: opener, text: `4-bets to ${fourBetTo}bb`, kind: 'raise', amountBb: fourBetTo },
    ],
    prompt: `${positionLabel(opener)} 4-bets to ${fourBetTo}bb`,
    subPrompt: `You 3-bet to ${threeBb}bb from ${positionLabel(heroPos)} · 100bb deep`,
    actions: [
      { id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 },
      { id: 'call', label: 'Call', sub: `${bbText(fourBetTo - threeBb)} more`, kind: 'call', amountBb: fourBetTo },
      { id: 'jam', label: 'All in', sub: `${stacks}bb`, kind: 'allin', amountBb: stacks },
    ],
    ctx: { openerPos: opener, openBb, extra: { threeBb, fourBetTo } },
    seed: rng.nextU32(),
  };
}

function strategyFourBet(spot: Spot): DrillStrategy {
  const idx = handIndex(spot.hero[0], spot.hero[1]);
  const opener = spot.ctx.openerPos as PositionName;
  const threeBb = Number(spot.ctx.extra?.threeBb ?? 9);
  const fourBetTo = Number(spot.ctx.extra?.fourBetTo ?? 22);
  const jam = fiveBetJamRange().weights[idx];
  const call = Math.max(0, fiveBetCallRange().weights[idx] - jam);
  const freq = normFreq({ fold: Math.max(0, 1 - jam - call), call, jam });

  const fourBetGrid = fourBetRange(opener, spot.heroPos);
  const dead = spot.potBb - fourBetTo - threeBb;
  const stack = spot.effectiveBb;
  const potBefore = fourBetTo + threeBb + dead;
  const callCost = fourBetTo - threeBb;
  const jamCost = stack - threeBb;
  // Facing the jam, the 4-bettor continues only with the top of their range.
  const callJamGrid = parseRange('QQ+, AKs, AKo@0.6, JJ@0.35');
  const fourBetMass = Math.max(0.01, rangePct(fourBetGrid));
  const byRange = clamp(rangePct(callJamGrid) / fourBetMass, 0.15, 0.95);
  const pFoldJam = Math.min(1 - byRange, mdfFoldCap(potBefore, jamCost));

  const spec: AnchorSpec = {
    actions: [
      { id: 'call', grid: fiveBetCallRange() },
      { id: 'jam', grid: fiveBetJamRange() },
    ],
    compute: (hand) => {
      const eq = clamp(equityVsRange(hand, fourBetGrid, spot.seed) * 0.96, 0, 1);
      const eqVsJamCall = equityVsRange(hand, callJamGrid, spot.seed ^ 0x7bb1);
      return {
        call: eq * (fourBetTo * 2 + dead - callCost) - (1 - eq) * callCost,
        jam: wagerEv(potBefore, jamCost, stack * 2 + dead, pFoldJam, eqVsJamCall),
      };
    },
  };

  return {
    freq,
    ev: anchoredEv(spot.hero, spec),
    order: ['fold', 'call', 'jam'],
    labels: { fold: 'Fold', call: `Call ${bbText(fourBetTo - threeBb)}`, jam: `All in ${stack}bb` },
  };
}

// ═══════════════════════════ postflop drills ═══════════════════════════

function postflopSpotFrom(spot: Spot): PostflopSpot {
  return {
    variant: spot.variant,
    street: spot.street,
    board: spot.board,
    hero: spot.hero,
    heroRange: spot.ctx.heroRange ?? ALL_HANDS,
    villainRange: spot.ctx.villainRange ?? ALL_HANDS,
    heroIP: spot.ctx.heroIP ?? true,
    heroAggressor: spot.ctx.heroAggressor ?? true,
    potBb: spot.potBb,
    effectiveBb: spot.effectiveBb,
    facingBb: spot.facingBb,
    seed: spot.seed,
  };
}

function actionsFromSolve(res: SolveResult): DrillAction[] {
  return res.order.map((id) => {
    const label = res.labels[id] ?? id;
    const kind: ActionKindUi =
      id === 'fold' ? 'fold' : id === 'check' ? 'check' : id === 'call' ? 'call' : id === 'raise' ? 'raise' : 'bet';
    const m = /([\d.]+)bb/.exec(label);
    return { id, label: label.split(' · ')[0], sub: label.split(' · ')[1], kind, amountBb: m ? Number(m[1]) : 0 };
  });
}

const CBET_HEROES: PositionName[] = ['CO', 'BTN', 'MP'];

function genCbet(rng: Rng, tier: Tier): Spot {
  const heroPos = CBET_HEROES[rng.int(tier === 'core' ? 2 : CBET_HEROES.length)];
  const openBb = 2.5;
  const heroRange = rfiRange(heroPos, 6);
  const villainRange = bbDefendCall(heroPos, openBb);
  const hero = draw(rng, 2, []);
  const board = draw(rng, 3, hero);
  const pot = openBb * 2 + 0.5;
  const spot: Spot = {
    id: nextId(),
    key: `cbet:${heroPos}:${handLabel(handIndex(hero[0], hero[1]))}`,
    drill: 'cbet-flop',
    tier,
    variant: 'nlhe',
    tableSize: 6,
    heroPos,
    hero,
    board,
    street: 'flop',
    potBb: pot,
    effectiveBb: 100 - openBb,
    facingBb: 0,
    seats: seatList(6, heroPos, 100 - openBb, {
      [heroPos]: { committed: openBb, tag: `Raise ${openBb}` },
      BB: { committed: openBb, tag: 'Call' },
    }),
    history: [
      ...foldsBefore(6, heroPos),
      { pos: heroPos, text: `raises to ${openBb}bb`, kind: 'raise', amountBb: openBb },
      { pos: 'BB', text: `calls ${openBb}bb`, kind: 'call', amountBb: openBb },
      { pos: 'BB', text: 'checks', kind: 'check' },
    ],
    prompt: 'The big blind checks to you',
    subPrompt: `${positionLabel(heroPos)} vs BB · ${pot.toFixed(1)}bb pot`,
    actions: [],
    ctx: { heroRange, villainRange, heroIP: true, heroAggressor: true, openerPos: heroPos, openBb },
    seed: rng.nextU32(),
  };
  spot.actions = actionsFromSolve(solve(postflopSpotFrom(spot)));
  return spot;
}

function genTurnBarrel(rng: Rng, tier: Tier): Spot {
  const heroPos = CBET_HEROES[rng.int(tier === 'core' ? 2 : CBET_HEROES.length)];
  const openBb = 2.5;
  const hero = draw(rng, 2, []);
  const board = draw(rng, 4, hero);
  const flop = board.slice(0, 3);
  const potFlop = openBb * 2 + 0.5;
  const cbet = Math.round(potFlop * 0.33 * 10) / 10;
  const pot = potFlop + cbet * 2;

  const heroRange = narrowRange(rfiRange(heroPos, 6), flop, { keep: 0.62, polar: 0.35 });
  // Their flop call keeps the middle and the draws, and folds the worst air.
  const villainRange = narrowRange(bbDefendCall(heroPos, openBb), flop, { keep: 0.55, polar: 0.12 });

  const spot: Spot = {
    id: nextId(),
    key: `turn:${heroPos}:${handLabel(handIndex(hero[0], hero[1]))}`,
    drill: 'turn-barrel',
    tier,
    variant: 'nlhe',
    tableSize: 6,
    heroPos,
    hero,
    board,
    street: 'turn',
    potBb: pot,
    effectiveBb: 100 - openBb - cbet,
    facingBb: 0,
    seats: seatList(6, heroPos, 100 - openBb - cbet, {
      [heroPos]: { committed: openBb + cbet, tag: `Bet ${cbet}` },
      BB: { committed: openBb + cbet, tag: 'Call' },
    }),
    history: [
      { pos: heroPos, text: `raises to ${openBb}bb`, kind: 'raise', amountBb: openBb },
      { pos: 'BB', text: 'calls', kind: 'call', amountBb: openBb },
      { pos: heroPos, text: `bets ${cbet}bb on the flop`, kind: 'bet', amountBb: cbet },
      { pos: 'BB', text: 'calls', kind: 'call', amountBb: cbet },
      { pos: 'BB', text: 'checks', kind: 'check' },
    ],
    prompt: 'They check the turn to you',
    subPrompt: `You c-bet ${cbet}bb and got called · ${pot.toFixed(1)}bb pot`,
    actions: [],
    ctx: { heroRange, villainRange, heroIP: true, heroAggressor: true, openerPos: heroPos, openBb },
    seed: rng.nextU32(),
  };
  spot.actions = actionsFromSolve(solve(postflopSpotFrom(spot)));
  return spot;
}

function genRiverBluffCatch(rng: Rng, tier: Tier): Spot {
  const villainPos = CBET_HEROES[rng.int(tier === 'core' ? 2 : CBET_HEROES.length)];
  const openBb = 2.5;
  const hero = draw(rng, 2, []);
  const board = draw(rng, 5, hero);
  const flop = board.slice(0, 3);
  const turn = board.slice(0, 4);
  const potFlop = openBb * 2 + 0.5;
  const cbet = Math.round(potFlop * 0.33 * 10) / 10;
  const potTurn = potFlop + cbet * 2;
  const barrel = Math.round(potTurn * 0.66 * 10) / 10;
  const pot = potTurn + barrel * 2;
  const riverBet = Math.round(pot * (tier === 'expert' && rng.bool(0.4) ? 1.25 : 0.7) * 10) / 10;

  const heroRange = narrowRange(
    narrowRange(bbDefendCall(villainPos, openBb), flop, { keep: 0.55, polar: 0.12 }),
    turn,
    { keep: 0.5, polar: 0.1 },
  );
  // Three barrels: their range narrows on every street and gets more
  // polarised each time, which is what makes the river a genuine bluff-catch.
  const villainRange = narrowRange(
    narrowRange(
      narrowRange(rfiRange(villainPos, 6), flop, { keep: 0.62, polar: 0.35 }),
      turn,
      { keep: 0.48, polar: 0.5 },
    ),
    board,
    { keep: 0.52, polar: 0.32 },
  );

  const spot: Spot = {
    id: nextId(),
    key: `river:${villainPos}:${handLabel(handIndex(hero[0], hero[1]))}`,
    drill: 'river-bluffcatch',
    tier,
    variant: 'nlhe',
    tableSize: 6,
    heroPos: 'BB',
    hero,
    board,
    street: 'river',
    potBb: pot + riverBet,
    effectiveBb: 100 - openBb - cbet - barrel,
    facingBb: riverBet,
    seats: seatList(6, 'BB', 100 - openBb - cbet - barrel, {
      [villainPos]: { committed: openBb + cbet + barrel + riverBet, tag: `Bet ${riverBet}` },
      BB: { committed: openBb + cbet + barrel, tag: 'Call' },
    }),
    history: [
      { pos: villainPos, text: `raises to ${openBb}bb`, kind: 'raise', amountBb: openBb },
      { pos: 'BB', text: 'calls', kind: 'call', amountBb: openBb },
      { pos: villainPos, text: `bets ${cbet}bb`, kind: 'bet', amountBb: cbet },
      { pos: 'BB', text: 'calls the flop', kind: 'call', amountBb: cbet },
      { pos: villainPos, text: `bets ${barrel}bb`, kind: 'bet', amountBb: barrel },
      { pos: 'BB', text: 'calls the turn', kind: 'call', amountBb: barrel },
      { pos: villainPos, text: `bets ${riverBet}bb on the river`, kind: 'bet', amountBb: riverBet },
    ],
    prompt: `${positionLabel(villainPos)} fires ${riverBet}bb on the river`,
    subPrompt: `${(pot + riverBet).toFixed(1)}bb in the middle · you are last to act`,
    actions: [],
    ctx: { heroRange, villainRange, heroIP: false, heroAggressor: false, openerPos: villainPos, openBb },
    seed: rng.nextU32(),
  };
  spot.actions = actionsFromSolve(solve(postflopSpotFrom(spot)));
  return spot;
}

function genBombPot(rng: Rng, tier: Tier): Spot {
  const ante = tier === 'expert' ? 4 : 2;
  const players = tier === 'core' ? 4 : 4 + rng.int(3);
  const pot = ante * players;
  const hero = draw(rng, 2, []);
  const board = draw(rng, 3, hero);
  const heroPos: PositionName = rng.bool(0.5) ? 'BTN' : 'BB';

  const spot: Spot = {
    id: nextId(),
    key: `bomb:${heroPos}:${handLabel(handIndex(hero[0], hero[1]))}`,
    drill: 'bomb-pot',
    tier,
    variant: 'nlhe',
    tableSize: 6,
    heroPos,
    hero,
    board,
    street: 'flop',
    potBb: pot,
    effectiveBb: 100 - ante,
    facingBb: 0,
    seats: seatList(6, heroPos, 100 - ante),
    history: [
      { pos: heroPos, text: `everyone antes ${ante}bb`, kind: 'post', amountBb: ante },
      { pos: heroPos, text: 'no preflop betting — straight to the flop', kind: 'check' },
    ],
    prompt: `Bomb pot · ${pot}bb already in the middle`,
    subPrompt: `${players} players, no preflop action, checked to you`,
    actions: [],
    // Nobody folded preflop, so both ranges are genuinely every hand. That is
    // what makes bomb pots play so differently: no range advantage exists.
    ctx: { heroRange: ALL_HANDS, villainRange: ALL_HANDS, heroIP: heroPos === 'BTN', heroAggressor: false, extra: { players } },
    seed: rng.nextU32(),
  };
  spot.actions = actionsFromSolve(solve(postflopSpotFrom(spot)));
  return spot;
}

function strategyPostflop(spot: Spot): { node: DrillStrategy; res: SolveResult } {
  const res = solve(postflopSpotFrom(spot));
  return {
    node: { freq: res.freq, ev: res.ev, order: res.order, labels: res.labels },
    res,
  };
}

// ═══════════════════════════ drill 9 — PLO preflop ═══════════════════════════

function genPloPreflop(rng: Rng, tier: Tier): Spot {
  const tableSize: 6 | 9 = 6;
  const seats = seatsFor(tableSize);
  const facing = tier === 'core' ? false : rng.bool(0.45);
  const heroIdx = facing ? 1 + rng.int(seats.length - 1) : rng.int(seats.length - 1);
  const heroPos = seats[heroIdx];
  const opener = facing ? seats[rng.int(heroIdx)] : null;
  const hero = draw(rng, 4, []);
  const openBb = 3.5;
  const potRaise = facing ? potRaiseTo(1.5 + openBb, openBb) : 3.5;

  const actions: DrillAction[] = [{ id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 }];
  if (facing) {
    actions.push({ id: 'call', label: 'Call', sub: `${bbText(openBb)}`, kind: 'call', amountBb: openBb });
    actions.push({ id: '3bet', label: `Pot ${potRaise.toFixed(1)}bb`, kind: 'raise', amountBb: potRaise });
  } else {
    actions.push({ id: 'raise', label: `Raise ${openBb}bb`, sub: 'pot', kind: 'raise', amountBb: openBb });
  }

  return {
    id: nextId(),
    key: `plo:${heroPos}:${facing ? 'vs' : 'rfi'}`,
    drill: 'plo-preflop',
    tier,
    variant: 'plo4',
    tableSize,
    heroPos,
    hero,
    board: [],
    street: 'preflop',
    potBb: facing ? 1.5 + openBb : 1.5,
    effectiveBb: 100,
    facingBb: facing ? openBb : 0,
    seats: seatList(tableSize, heroPos, 100, opener ? { [opener]: { committed: openBb, tag: `Raise ${openBb}` } } : {}),
    history: opener
      ? [...foldsBefore(tableSize, opener), { pos: opener, text: `raises to ${openBb}bb`, kind: 'raise' as const, amountBb: openBb }]
      : foldsBefore(tableSize, heroPos),
    prompt: opener ? `${positionLabel(opener)} opens to ${openBb}bb` : 'Folded to you',
    subPrompt: `Pot-Limit Omaha · ${positionLabel(heroPos)} · 100bb`,
    actions,
    ctx: { openerPos: opener ?? undefined, openBb, extra: { facing: facing ? 1 : 0, potRaise } },
    seed: rng.nextU32(),
  };
}

function strategyPlo(spot: Spot): DrillStrategy {
  const facing = Number(spot.ctx.extra?.facing ?? 0) === 1;
  const potRaise = Number(spot.ctx.extra?.potRaise ?? 12);
  const openBb = spot.ctx.openBb ?? 3.5;
  // PLO EV is anchored the same way as Hold'em: the hand sitting exactly on
  // the range boundary is worth zero, and every percentile above it is worth a
  // slice of the pot the action contests. Equities run so close together in
  // PLO that the slope is gentle, which is exactly why the marginal hands cost
  // so little either way.
  if (!facing) {
    const st = ploRfi(spot.hero, playersBehind(spot.heroPos, spot.tableSize));
    const boundary = 1 - st.threshold;
    return {
      freq: normFreq(st.freq),
      ev: { fold: 0, raise: (st.info.percentile - boundary) * (openBb + 1.5) * 0.9 },
      order: ['fold', 'raise'],
      labels: { fold: 'Fold', raise: `Raise ${openBb}bb` },
    };
  }
  const inPosition = seatsFor(spot.tableSize).indexOf(spot.heroPos) >
    seatsFor(spot.tableSize).indexOf((spot.ctx.openerPos ?? 'UTG') as PositionName);
  const isBlind = spot.heroPos === 'SB' || spot.heroPos === 'BB';
  const st = ploFacingOpen(spot.hero, inPosition, isBlind);
  const callBoundary = 1 - st.threshold;
  const raiseBoundary = 1 - (inPosition ? 0.09 : 0.075);
  return {
    freq: normFreq(st.freq),
    ev: {
      fold: 0,
      call: (st.info.percentile - callBoundary) * (openBb * 2 + 1.5) * (inPosition ? 0.9 : 0.7),
      '3bet': (st.info.percentile - raiseBoundary) * (potRaise + openBb) * 0.55,
    },
    order: ['fold', 'call', '3bet'],
    labels: { fold: 'Fold', call: `Call ${bbText(openBb)}`, '3bet': `Pot ${potRaise.toFixed(1)}bb` },
  };
}

// ═══════════════════════════ drills 11 & 12 — push/fold and ICM ═══════════════════════════

function genPushFold(rng: Rng, tier: Tier): Spot {
  const tableSize: 6 | 9 = rng.bool(0.5) ? 6 : 9;
  const seats = seatsFor(tableSize);
  const late = seats.slice(Math.max(0, seats.length - (tier === 'core' ? 4 : 6)), seats.length - 1);
  const heroPos = late[rng.int(late.length)];
  const stack = tier === 'core'
    ? [8, 10, 12][rng.int(3)]
    : Math.round((5 + rng.next() * 14) * 2) / 2;
  const jamGrid = pushRange(heroPos, stack, tableSize, 0);
  const idx = sampleHand(rng, [jamGrid], tier);
  const hero = comboFor(rng, idx, []);

  return {
    id: nextId(),
    key: `pf:${heroPos}:${Math.round(stack)}:${handLabel(idx)}`,
    drill: 'push-fold',
    tier,
    variant: 'nlhe',
    tableSize,
    heroPos,
    hero,
    board: [],
    street: 'preflop',
    potBb: 1.5,
    effectiveBb: stack,
    facingBb: 0,
    seats: seatList(tableSize, heroPos, stack),
    history: foldsBefore(tableSize, heroPos),
    prompt: `Folded to you · ${stack}bb effective`,
    subPrompt: `Turbo SNG · ${positionLabel(heroPos)} · jam or fold`,
    actions: [
      { id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 },
      { id: 'jam', label: 'All in', sub: `${stack}bb`, kind: 'allin', amountBb: stack },
    ],
    ctx: { extra: { stack } },
    seed: rng.nextU32(),
  };
}

function genIcm(rng: Rng, tier: Tier): Spot {
  const tableSize: 6 | 9 = 9;
  const seats = seatsFor(tableSize);
  const facingJam = rng.bool(0.5);
  const stack = Math.round((6 + rng.next() * 11) * 2) / 2;
  const pressure = tier === 'core' ? 0.5 : 0.35 + rng.next() * 0.5;
  const left = 4 + rng.int(3);
  const paid = left - 1;

  if (facingJam) {
    const jammerPool = seats.slice(2, seats.length - 2);
    const jammer = jammerPool[rng.int(jammerPool.length)];
    const heroChoices = seats.slice(seats.indexOf(jammer) + 1);
    const heroPos = heroChoices[rng.int(heroChoices.length)];
    const behind = seats.length - 1 - seats.indexOf(heroPos);
    const callGrid = callJamRange(stack, behind, pressure);
    const idx = sampleHand(rng, [callGrid], tier);
    const hero = comboFor(rng, idx, []);
    return {
      id: nextId(),
      key: `icm-call:${heroPos}:${Math.round(stack)}:${handLabel(idx)}`,
      drill: 'icm-bubble',
      tier,
      variant: 'nlhe',
      tableSize,
      heroPos,
      hero,
      board: [],
      street: 'preflop',
      potBb: 1.5 + stack,
      effectiveBb: stack,
      facingBb: stack,
      seats: seatList(tableSize, heroPos, stack, { [jammer]: { committed: stack, tag: 'All in' } }),
      history: [
        ...foldsBefore(tableSize, jammer),
        { pos: jammer, text: `jams ${stack}bb`, kind: 'allin', amountBb: stack },
      ],
      prompt: `${positionLabel(jammer)} shoves ${stack}bb`,
      subPrompt: `Bubble · ${left} left, ${paid} get paid · calling risks your tournament`,
      actions: [
        { id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 },
        { id: 'call', label: 'Call all in', sub: `${stack}bb`, kind: 'call', amountBb: stack },
      ],
      ctx: { openerPos: jammer, icmPressure: pressure, extra: { stack, behind, mode: 'call', left, paid } },
      seed: rng.nextU32(),
    };
  }

  const late = seats.slice(seats.length - 5, seats.length - 1);
  const heroPos = late[rng.int(late.length)];
  const jamGrid = pushRange(heroPos, stack, tableSize, pressure);
  const idx = sampleHand(rng, [jamGrid], tier);
  const hero = comboFor(rng, idx, []);
  return {
    id: nextId(),
    key: `icm-jam:${heroPos}:${Math.round(stack)}:${handLabel(idx)}`,
    drill: 'icm-bubble',
    tier,
    variant: 'nlhe',
    tableSize,
    heroPos,
    hero,
    board: [],
    street: 'preflop',
    potBb: 1.5,
    effectiveBb: stack,
    facingBb: 0,
    seats: seatList(tableSize, heroPos, stack),
    history: foldsBefore(tableSize, heroPos),
    prompt: `Folded to you · ${stack}bb`,
    subPrompt: `Bubble · ${left} left, ${paid} get paid · ${positionLabel(heroPos)}`,
    actions: [
      { id: 'fold', label: 'Fold', kind: 'fold', amountBb: 0 },
      { id: 'jam', label: 'All in', sub: `${stack}bb`, kind: 'allin', amountBb: stack },
    ],
    ctx: { icmPressure: pressure, extra: { stack, mode: 'jam', left, paid } },
    seed: rng.nextU32(),
  };
}

function strategyPushFold(spot: Spot): DrillStrategy {
  const idx = handIndex(spot.hero[0], spot.hero[1]);
  const stack = Number(spot.ctx.extra?.stack ?? spot.effectiveBb);
  const pressure = spot.ctx.icmPressure ?? 0;
  const mode = String(spot.ctx.extra?.mode ?? 'jam');

  if (mode === 'call') {
    const behind = Number(spot.ctx.extra?.behind ?? 0);
    const grid = callJamRange(stack, behind, pressure);
    const call = grid.weights[idx];
    const jammer = pushRange((spot.ctx.openerPos ?? 'BTN') as PositionName, stack, spot.tableSize, pressure);
    const posted = spot.heroPos === 'SB' ? 0.5 : spot.heroPos === 'BB' ? 1 : 0;
    const dead = 1.5 - posted;
    // Chips you win are worth less than chips you lose on a bubble — that
    // asymmetry *is* ICM, and it is why the calling range collapses.
    const riskPremium = 1 + pressure * 0.95;
    const spec: AnchorSpec = {
      actions: [{ id: 'call', grid }],
      compute: (hand) => {
        const eq = equityVsRange(hand, jammer, spot.seed);
        return { call: eq * (stack + dead) - (1 - eq) * (stack - posted) * riskPremium };
      },
    };
    return {
      freq: normFreq({ fold: 1 - call, call }),
      ev: anchoredEv(spot.hero, spec),
      order: ['fold', 'call'],
      labels: { fold: 'Fold', call: `Call ${stack}bb` },
    };
  }

  const grid = pushRange(spot.heroPos, stack, spot.tableSize, pressure);
  const jam = grid.weights[idx];
  const seats = seatsFor(spot.tableSize);
  const behind = seats.slice(seats.indexOf(spot.heroPos) + 1);
  let allFold = 1;
  const callers: Array<{ grid: RangeGrid; weight: number }> = [];
  for (let i = 0; i < behind.length; i++) {
    const g = callJamRange(stack, behind.length - 1 - i, pressure);
    const p = rangePct(g);
    allFold *= clamp(1 - p, 0, 1);
    callers.push({ grid: g, weight: p });
  }
  const callerRange = blendRanges(callers);
  const posted = spot.heroPos === 'SB' ? 0.5 : spot.heroPos === 'BB' ? 1 : 0;
  const dead = 1.5 - posted;
  const riskPremium = 1 + pressure * 0.7;
  const spec: AnchorSpec = {
    actions: [{ id: 'jam', grid }],
    compute: (hand) => {
      const eq = equityVsRange(hand, callerRange, spot.seed);
      return {
        jam: mixBranches([
          { p: allFold, ev: 1.5 },
          { p: 1 - allFold, ev: eq * (stack + dead) - (1 - eq) * (stack - posted) * riskPremium },
        ]),
      };
    },
  };
  return {
    freq: normFreq({ fold: 1 - jam, jam }),
    ev: anchoredEv(spot.hero, spec),
    order: ['fold', 'jam'],
    labels: { fold: 'Fold', jam: `All in ${stack}bb` },
  };
}

// ═══════════════════════════ catalogue ═══════════════════════════

export const DRILLS: DrillDef[] = [
  {
    id: 'rfi',
    name: 'Preflop RFI',
    short: 'RFI',
    blurb: 'Which hands open, from every seat, at 6-max and full ring.',
    icon: 'cards',
    tier: 'core',
    variant: 'nlhe',
    category: 'Preflop',
    generate: genRfi,
  },
  {
    id: 'blind-defense',
    name: 'Blind Defense',
    short: 'BB defense',
    blurb: 'You are getting a discount. Work out how much of it to take.',
    icon: 'shield',
    tier: 'core',
    variant: 'nlhe',
    category: 'Preflop',
    generate: genBlindDefense,
  },
  {
    id: 'vs-3bet',
    name: 'Facing a 3-bet',
    short: 'vs 3-bet',
    blurb: 'Fold, flat or blast it back — the node most players leak in.',
    icon: 'bolt',
    tier: 'sharp',
    variant: 'nlhe',
    category: 'Preflop',
    generate: genVs3Bet,
  },
  {
    id: 'squeeze',
    name: 'Squeeze Spots',
    short: 'Squeeze',
    blurb: 'An opener and a caller. Their ranges are capped — punish them.',
    icon: 'target',
    tier: 'sharp',
    variant: 'nlhe',
    category: 'Preflop',
    generate: genSqueeze,
  },
  {
    id: '4bet-5bet',
    name: '4-bet / 5-bet',
    short: '4-bet',
    blurb: 'The deepest preflop node, where blockers decide everything.',
    icon: 'flame',
    tier: 'expert',
    variant: 'nlhe',
    category: 'Preflop',
    generate: genFourBet,
  },
  {
    id: 'cbet-flop',
    name: 'C-bet Flop',
    short: 'C-bet',
    blurb: 'Texture, range advantage, and picking the right size.',
    icon: 'chart',
    tier: 'core',
    variant: 'nlhe',
    category: 'Postflop',
    generate: genCbet,
  },
  {
    id: 'turn-barrel',
    name: 'Turn Barrel',
    short: 'Turn',
    blurb: 'They called the flop. Which turns do you keep firing?',
    icon: 'trend-up',
    tier: 'sharp',
    variant: 'nlhe',
    category: 'Postflop',
    generate: genTurnBarrel,
  },
  {
    id: 'river-bluffcatch',
    name: 'River Bluff-Catch',
    short: 'Bluff-catch',
    blurb: 'Three streets of pressure. Do the odds say call?',
    icon: 'eye',
    tier: 'expert',
    variant: 'nlhe',
    category: 'Postflop',
    generate: genRiverBluffCatch,
  },
  {
    id: 'bomb-pot',
    name: 'Bomb-Pot Flop',
    short: 'Bomb pot',
    blurb: 'Everyone antes, nobody folded. Nobody has a range advantage.',
    icon: 'sparkle',
    tier: 'sharp',
    variant: 'nlhe',
    category: 'Postflop',
    generate: genBombPot,
  },
  {
    id: 'plo-preflop',
    name: 'PLO Preflop',
    short: 'PLO',
    blurb: 'Four cards, two of them must play. Danglers cost you money.',
    icon: 'gem',
    tier: 'sharp',
    variant: 'plo4',
    category: 'Preflop',
    generate: genPloPreflop,
  },
  {
    id: 'push-fold',
    name: 'Push / Fold',
    short: 'Push/fold',
    blurb: 'Short-stack Nash. Solved poker — there is a right answer.',
    icon: 'bolt',
    tier: 'core',
    variant: 'nlhe',
    category: 'Tournament',
    generate: genPushFold,
  },
  {
    id: 'icm-bubble',
    name: 'ICM Bubble',
    short: 'ICM',
    blurb: 'Chips you win are worth less than chips you lose. Adjust.',
    icon: 'trophy',
    tier: 'expert',
    variant: 'nlhe',
    category: 'Tournament',
    generate: genIcm,
  },
];

export function drillById(id: DrillId): DrillDef | undefined {
  return DRILLS.find((d) => d.id === id);
}

export function generateSpot(id: DrillId, rng: Rng, tier: Tier = 'core'): Spot {
  const def = drillById(id) ?? DRILLS[0];
  return def.generate(rng, tier);
}

// ═══════════════════════════ strategy + grading ═══════════════════════════

export function strategyFor(spot: Spot): DrillStrategy {
  switch (spot.drill) {
    case 'rfi': return strategyRfi(spot);
    case 'vs-3bet': return strategyVs3Bet(spot);
    case 'blind-defense': return strategyBlindDefense(spot);
    case 'squeeze': return strategySqueeze(spot);
    case '4bet-5bet': return strategyFourBet(spot);
    case 'plo-preflop': return strategyPlo(spot);
    case 'push-fold':
    case 'icm-bubble': return strategyPushFold(spot);
    default: return strategyPostflop(spot).node;
  }
}

/** The range layers a spot can show in the range viewer. Preflop only. */
export function spotRangeLayers(spot: Spot): RangeLayer[] {
  switch (spot.drill) {
    case 'rfi': {
      const rfi = rfiRange(spot.heroPos, spot.tableSize);
      const layers: RangeLayer[] = [{ action: 'raise', label: 'Raise', grid: rfi, tone: 'aggro' }];
      if (spot.heroPos === 'SB') layers.push({ action: 'limp', label: 'Limp', grid: sbLimpRange(), tone: 'passive' });
      return layers;
    }
    case 'blind-defense': {
      const opener = spot.ctx.openerPos as PositionName;
      const openBb = spot.ctx.openBb ?? 2.5;
      return [
        { action: '3bet', label: '3-bet', grid: threeBetRange(opener, 'BB', spot.tableSize), tone: 'aggro' },
        { action: 'call', label: 'Call', grid: bbDefendCall(opener, openBb), tone: 'passive' },
      ];
    }
    case 'vs-3bet': {
      const villain = spot.ctx.callerPos as PositionName;
      return [
        { action: '4bet', label: '4-bet', grid: fourBetRange(spot.heroPos, villain), tone: 'aggro' },
        { action: 'call', label: 'Call', grid: fourBetCallRange(spot.heroPos, villain), tone: 'passive' },
      ];
    }
    case 'squeeze': {
      const opener = spot.ctx.openerPos as PositionName;
      return [{ action: 'squeeze', label: 'Squeeze', grid: squeezeRange(opener, spot.heroPos), tone: 'aggro' }];
    }
    case '4bet-5bet':
      return [
        { action: 'jam', label: '5-bet jam', grid: fiveBetJamRange(), tone: 'aggro' },
        { action: 'call', label: 'Call', grid: fiveBetCallRange(), tone: 'passive' },
      ];
    case 'push-fold':
      return [{
        action: 'jam',
        label: 'Jam',
        grid: pushRange(spot.heroPos, Number(spot.ctx.extra?.stack ?? spot.effectiveBb), spot.tableSize, 0),
        tone: 'aggro',
      }];
    case 'icm-bubble': {
      const stack = Number(spot.ctx.extra?.stack ?? spot.effectiveBb);
      const pressure = spot.ctx.icmPressure ?? 0;
      if (String(spot.ctx.extra?.mode) === 'call') {
        return [{
          action: 'call',
          label: 'Call a jam',
          grid: callJamRange(stack, Number(spot.ctx.extra?.behind ?? 0), pressure),
          tone: 'passive',
        }];
      }
      return [{ action: 'jam', label: 'Jam', grid: pushRange(spot.heroPos, stack, spot.tableSize, pressure), tone: 'aggro' }];
    }
    default:
      return [];
  }
}

export function handLabelOf(spot: Spot): string {
  if (spot.variant === 'plo4') {
    return [...spot.hero].sort((a, b) => b - a).map((c) => cardText(c)).join(' ');
  }
  return handLabel(handIndex(spot.hero[0], spot.hero[1]));
}

const RANKS_TXT = '23456789TJQKA';
const SUITS_TXT = 'cdhs';
function cardText(c: CardId): string {
  return RANKS_TXT[c >> 2] + SUITS_TXT[c & 3];
}

/** Grades a chosen action, producing the full teaching verdict. */
export function grade(spot: Spot, chosen: string): Verdict {
  if (spot.street !== 'preflop') return gradePostflop(spot, chosen);

  const node = strategyFor(spot);
  const layers = spotRangeLayers(spot);
  const label = handLabelOf(spot);
  const best = bestOf(node);
  const f = node.freq[chosen] ?? 0;
  const explanation = explainPreflop(spot, node, chosen, best, f);
  const mainGrid = layers[0]?.grid;

  return buildVerdict(node, chosen, explanation, {
    handLabel: label,
    rangePct: mainGrid ? rangePct(mainGrid) : undefined,
    layers,
    headline: headlineFor(spot),
  });
}

function gradePostflop(spot: Spot, chosen: string): Verdict {
  const { node, res } = strategyPostflop(spot);
  const explanation = explainPostflop(res, chosen);
  return buildVerdict(node, chosen, explanation, {
    handLabel: handLabelOf(spot),
    equity: res.heroEquity,
    outs: res.heroOuts,
    texture: res.texture.label,
    boardLabel: spot.board.map(cardText).join(' '),
    layers: [],
    headline: headlineFor(spot),
  });
}

function headlineFor(spot: Spot): string {
  const def = drillById(spot.drill);
  return def ? def.name : spot.drill;
}

// ═══════════════════════════ preflop explanations ═══════════════════════════

function explainPreflop(
  spot: Spot,
  node: DrillStrategy,
  chosen: string,
  best: string,
  chosenFreq: number,
): string {
  const label = handLabelOf(spot);
  const parts: string[] = [];
  const mix = node.order
    .filter((id) => (node.freq[id] ?? 0) > 0.02)
    .map((id) => `${node.labels[id] ?? id} ${pctText(node.freq[id])}`)
    .join(', ');
  const bestFreq = node.freq[best] ?? 0;

  switch (spot.drill) {
    case 'rfi': {
      const rfi = rfiRange(spot.heroPos, spot.tableSize);
      parts.push(
        `${positionLabel(spot.heroPos)} opens ${pctText(rangePct(rfi))} of hands at ${spot.tableSize}-max with ${playersBehind(spot.heroPos, spot.tableSize)} left to act.`,
      );
      break;
    }
    case 'blind-defense': {
      const opener = spot.ctx.openerPos as PositionName;
      const openBb = spot.ctx.openBb ?? 2.5;
      const price = openBb - 1;
      const potAfter = openBb * 2 + (opener === 'SB' ? 0 : 0.5);
      parts.push(
        `You pay ${bbText(price)} into a ${potAfter.toFixed(1)}bb pot — ${(price / potAfter * 100).toFixed(0)}% equity is enough to continue, which is why the BB defends ${pctText(rangePct(bbDefendCall(opener, openBb)) + rangePct(threeBetRange(opener, 'BB', spot.tableSize)))} against ${positionLong(opener)}.`,
      );
      break;
    }
    case 'vs-3bet': {
      const villain = spot.ctx.callerPos as PositionName;
      parts.push(
        `${positionLabel(villain)} 3-bets ${pctText(rangePct(threeBetRange(spot.heroPos, villain, spot.tableSize)))} here. You 4-bet ${pctText(rangePct(fourBetRange(spot.heroPos, villain)))} and continue with another ${pctText(rangePct(fourBetCallRange(spot.heroPos, villain)))}.`,
      );
      break;
    }
    case 'squeeze': {
      const opener = spot.ctx.openerPos as PositionName;
      parts.push(
        `The caller's range is capped — they would have 3-bet their best hands — so the squeeze works on both players at once. ${positionLabel(spot.heroPos)} squeezes ${pctText(rangePct(squeezeRange(opener, spot.heroPos)))} of hands here.`,
      );
      break;
    }
    case '4bet-5bet':
      parts.push(
        'Against a 4-bet you are choosing between the top of your range and the hands whose ace or king blocks the hands that can call. Everything else folds.',
      );
      break;
    case 'plo-preflop': {
      const info = ploScore(spot.hero);
      parts.push(`${info.label} — top ${pctText(1 - info.percentile)} of all PLO hands.`);
      break;
    }
    case 'push-fold':
    case 'icm-bubble': {
      const stack = Number(spot.ctx.extra?.stack ?? spot.effectiveBb);
      const pressure = spot.ctx.icmPressure ?? 0;
      if (String(spot.ctx.extra?.mode) === 'call') {
        parts.push(
          `Calling risks ${bbText(stack)} to win ${bbText(stack + 1.5)}. On the bubble those are not the same chips: the model prices your losses ${(1 + pressure * 0.95).toFixed(2)}× because busting costs you a pay jump.`,
        );
      } else {
        parts.push(
          `At ${bbText(stack)} this is a solved node. The Nash jamming range from ${positionLabel(spot.heroPos)} is ${pctText(rangePct(pushRange(spot.heroPos, stack, spot.tableSize, pressure)))} of hands.`,
        );
      }
      break;
    }
    default:
      break;
  }

  if (bestFreq > 0.93) {
    parts.push(`${label} is a pure ${(node.labels[best] ?? best).toLowerCase()} — the solution never does anything else.`);
  } else {
    parts.push(`${label} mixes: ${mix}.`);
  }

  if (chosenFreq < 0.03 && bestFreq > 0.2) {
    const gap = (node.ev[best] ?? 0) - (node.ev[chosen] ?? 0);
    parts.push(
      `${node.labels[chosen] ?? chosen} is not in the strategy${gap > 0.03 ? ` — it costs about ${gap.toFixed(2)}bb` : ''}.`,
    );
  } else if (chosenFreq > 0.02 && chosenFreq < 0.5) {
    parts.push('That is inside the mix, so it is not a mistake — just not the majority line.');
  }
  return parts.join(' ');
}

// ═══════════════════════════ hand-history review ═══════════════════════════

export interface ReviewDecision {
  seq: number;
  street: Street;
  board: CardId[];
  hero: CardId[];
  heroPos: PositionName;
  potBb: number;
  facingBb: number;
  chosen: string;
  verdict: Verdict;
}

export interface ReviewInput {
  variant: GameVariant;
  tableSize: 6 | 9;
  heroPos: PositionName;
  hero: CardId[];
  villainPos: PositionName;
  bbSize: number;
  /** [street, board so far, pot in bb, bet faced in bb, action taken] */
  steps: Array<{
    street: Street;
    board: CardId[];
    potBb: number;
    facingBb: number;
    chosen: string;
  }>;
}

/**
 * Scores a sequence of real decisions from a hand replay. Every street is
 * re-solved against the range the previous action implies, which is the same
 * machinery the drills use — so a review and a drill agree on the same spot.
 */
export function reviewHand(input: ReviewInput, seed = 0x1234567): ReviewDecision[] {
  const out: ReviewDecision[] = [];
  const rng = new Rng(seed);
  let heroRange = rfiRange(input.heroPos, input.tableSize);
  let villainRange = bbDefendCall(input.villainPos === 'BB' ? input.heroPos : input.villainPos, 2.5);

  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    if (step.street === 'preflop') continue;
    const spot: Spot = {
      id: nextId(),
      key: `review:${i}`,
      drill: step.street === 'flop' ? 'cbet-flop' : step.street === 'turn' ? 'turn-barrel' : 'river-bluffcatch',
      tier: 'sharp',
      variant: input.variant,
      tableSize: input.tableSize,
      heroPos: input.heroPos,
      hero: input.hero,
      board: step.board,
      street: step.street,
      potBb: step.potBb,
      effectiveBb: 100,
      facingBb: step.facingBb,
      seats: seatList(input.tableSize, input.heroPos, 100),
      history: [],
      prompt: '',
      subPrompt: '',
      actions: [],
      ctx: { heroRange, villainRange, heroIP: true, heroAggressor: true },
      seed: rng.nextU32(),
    };
    const verdict = gradePostflop(spot, step.chosen);
    out.push({
      seq: i,
      street: step.street,
      board: step.board,
      hero: input.hero,
      heroPos: input.heroPos,
      potBb: step.potBb,
      facingBb: step.facingBb,
      chosen: step.chosen,
      verdict,
    });
    // Both ranges narrow as the hand goes on.
    heroRange = narrowRange(heroRange, step.board, { keep: 0.6, polar: 0.3 });
    villainRange = narrowRange(villainRange, step.board, { keep: 0.55, polar: 0.15 });
  }
  return out;
}

/** Board texture summary, re-exported so the UI has one import for spots. */
export { analyzeBoard, drawOuts };
