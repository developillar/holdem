/**
 * ROYALE — gto/equity.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Monte Carlo equity for Hold'em and PLO4: hand vs hand, hand vs range and
 * range vs range, with the whole simulation living in a Web Worker so the UI
 * never drops a frame.
 *
 * HOW THE WORKER IS BUILT
 *   There is no separate worker entry point and no build-config change. The
 *   four hot functions below (`straightHigh`, `evalHand`, `evalPlo`, `simInit`,
 *   `simStep`) are written so they close over nothing, are stringified with
 *   `Function.prototype.toString()`, concatenated with a small message pump and
 *   handed to `new Worker(URL.createObjectURL(new Blob([src])))`. Because the
 *   glue references them through `fn.name`, this survives minification: the
 *   bundler renames all of them consistently.
 *
 *   The worker runs the simulation in slices and yields to its own event loop
 *   between slices, so `cancel` and progress messages are actually delivered.
 *   If Workers or blob URLs are unavailable (strict CSP, old webview) the exact
 *   same functions run on the main thread, sliced across animation frames.
 *
 * ACCURACY
 *   Standard error of a Monte Carlo equity is ≈ 0.5/√n, so 20k iterations is
 *   ±0.35% and 100k is ±0.16%. Whenever the spot is small enough the engine
 *   enumerates instead of sampling and reports `exact: true` — river spots with
 *   known hands are computed in a single evaluation, turn spots by walking the
 *   44 remaining cards.
 *
 * HAND SCORES
 *   `evalHand` returns a single comparable int: category << 20 | five rank
 *   nibbles. Higher is better, ties are exact equality. It handles 5, 6 and 7
 *   cards; PLO uses the exactly-two-from-four rule via `evalPlo`.
 */

import type { CardId, GameVariant, RangeGrid } from '../core/types.ts';
import { expandRange } from './ranges.ts';

// ═══════════════════════════ hand evaluation ═══════════════════════════
// Everything in this block must stay self-contained: it is stringified into
// the worker. No imports, no module-scope references, no closures.

/** High card rank (5–14) of the best straight in a 13-bit rank mask, else 0. */
export function straightHigh(mask: number): number {
  const x = mask & (mask >> 1) & (mask >> 2) & (mask >> 3) & (mask >> 4);
  if (x !== 0) return (31 - Math.clz32(x)) + 6;
  // wheel: A 5 4 3 2 — bits 12,3,2,1,0
  if ((mask & 0x100f) === 0x100f) return 5;
  return 0;
}

export interface EvalScratch {
  cnt: Int32Array;
  suits: Int32Array;
  sMask: Int32Array;
  five: Int32Array;
  seven: Int32Array;
}

/**
 * Best five-card value out of `n` cards (5, 6 or 7).
 * Returns `category << 20 | r1<<16 | r2<<12 | r3<<8 | r4<<4 | r5`.
 */
export function evalHand(cards: ArrayLike<number>, n: number, sc: EvalScratch): number {
  const cnt = sc.cnt;
  const suits = sc.suits;
  const sMask = sc.sMask;
  cnt.fill(0);
  suits.fill(0);
  sMask.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const card = cards[i];
    const r = card >> 2;
    const s = card & 3;
    cnt[r]++;
    suits[s]++;
    rankMask |= 1 << r;
    sMask[s] |= 1 << r;
  }

  let flushSuit = -1;
  if (suits[0] >= 5) flushSuit = 0;
  else if (suits[1] >= 5) flushSuit = 1;
  else if (suits[2] >= 5) flushSuit = 2;
  else if (suits[3] >= 5) flushSuit = 3;

  if (flushSuit >= 0) {
    const fm = sMask[flushSuit];
    const x = fm & (fm >> 1) & (fm >> 2) & (fm >> 3) & (fm >> 4);
    let sf = 0;
    if (x !== 0) sf = (31 - Math.clz32(x)) + 6;
    else if ((fm & 0x100f) === 0x100f) sf = 5;
    if (sf !== 0) return (8 << 20) | (sf << 16);
    let v = 0;
    let taken = 0;
    for (let r = 12; r >= 0 && taken < 5; r--) {
      if ((fm & (1 << r)) !== 0) {
        v = (v << 4) | (r + 2);
        taken++;
      }
    }
    return (5 << 20) | v;
  }

  let quad = -1;
  let trips = -1;
  let trips2 = -1;
  let pair = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const k = cnt[r];
    if (k === 4) {
      if (quad < 0) quad = r;
    } else if (k === 3) {
      if (trips < 0) trips = r;
      else if (trips2 < 0) trips2 = r;
    } else if (k === 2) {
      if (pair < 0) pair = r;
      else if (pair2 < 0) pair2 = r;
    }
  }

  if (quad >= 0) {
    let kick = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== quad && cnt[r] > 0) {
        kick = r;
        break;
      }
    }
    return (7 << 20) | ((quad + 2) << 16) | ((kick + 2) << 12);
  }

  if (trips >= 0 && (trips2 >= 0 || pair >= 0)) {
    const second = trips2 >= 0 && (pair < 0 || trips2 > pair) ? trips2 : pair;
    return (6 << 20) | ((trips + 2) << 16) | ((second + 2) << 12);
  }

  const st = straightHigh(rankMask);
  if (st !== 0) return (4 << 20) | (st << 16);

  if (trips >= 0) {
    let v = (trips + 2) << 16;
    let taken = 0;
    for (let r = 12; r >= 0 && taken < 2; r--) {
      if (r !== trips && cnt[r] > 0) {
        v |= (r + 2) << (12 - taken * 4);
        taken++;
      }
    }
    return (3 << 20) | v;
  }

  if (pair >= 0 && pair2 >= 0) {
    let kick = -1;
    for (let r = 12; r >= 0; r--) {
      if (r !== pair && r !== pair2 && cnt[r] > 0) {
        kick = r;
        break;
      }
    }
    return (2 << 20) | ((pair + 2) << 16) | ((pair2 + 2) << 12) | ((kick + 2) << 8);
  }

  if (pair >= 0) {
    let v = (pair + 2) << 16;
    let taken = 0;
    for (let r = 12; r >= 0 && taken < 3; r--) {
      if (r !== pair && cnt[r] > 0) {
        v |= (r + 2) << (12 - taken * 4);
        taken++;
      }
    }
    return (1 << 20) | v;
  }

  let v = 0;
  let taken = 0;
  for (let r = 12; r >= 0 && taken < 5; r--) {
    if ((rankMask & (1 << r)) !== 0) {
      v = (v << 4) | (r + 2);
      taken++;
    }
  }
  return v;
}

/** PLO: exactly two hole cards plus exactly three board cards. */
export function evalPlo(
  hole: ArrayLike<number>,
  board: ArrayLike<number>,
  nb: number,
  sc: EvalScratch,
): number {
  const five = sc.five;
  let best = -1;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      five[0] = hole[i];
      five[1] = hole[j];
      for (let a = 0; a < nb; a++) {
        five[2] = board[a];
        for (let b = a + 1; b < nb; b++) {
          five[3] = board[b];
          for (let c = b + 1; c < nb; c++) {
            five[4] = board[c];
            const v = evalHand(five, 5, sc);
            if (v > best) best = v;
          }
        }
      }
    }
  }
  return best;
}

// ═══════════════════════════ simulation core ═══════════════════════════

export interface SimSide {
  kind: 'hand' | 'range' | 'random';
  cards?: number[];
  combos?: number[][];
  weights?: number[];
}

export interface SimJob {
  variant: 'nlhe' | 'plo4';
  sides: SimSide[];
  board: number[];
  dead: number[];
  iterations: number;
  seed: number;
}

export interface SimState {
  job: SimJob;
  done: number;
  valid: number;
  win: Float64Array;
  tie: Float64Array;
  [key: string]: unknown;
}

/** Builds the per-job scratch. Self-contained: stringified into the worker. */
export function simInit(job: SimJob): SimState {
  const holeLen = job.variant === 'plo4' ? 4 : 2;
  const n = job.sides.length;
  const blocked = new Uint8Array(52);
  for (let i = 0; i < job.board.length; i++) blocked[job.board[i]] = 1;
  for (let i = 0; i < job.dead.length; i++) blocked[job.dead[i]] = 1;
  for (let p = 0; p < n; p++) {
    const s = job.sides[p];
    if (s.kind === 'hand' && s.cards) for (let i = 0; i < s.cards.length; i++) blocked[s.cards[i]] = 1;
  }
  const cums: Array<Float64Array | null> = [];
  const totals: number[] = [];
  for (let p = 0; p < n; p++) {
    const s = job.sides[p];
    if (s.kind !== 'range' || !s.weights) {
      cums.push(null);
      totals.push(0);
      continue;
    }
    const c = new Float64Array(s.weights.length);
    let acc = 0;
    for (let i = 0; i < s.weights.length; i++) {
      acc += s.weights[i];
      c[i] = acc;
    }
    cums.push(c);
    totals.push(acc);
  }
  const hands: Int32Array[] = [];
  for (let p = 0; p < n; p++) hands.push(new Int32Array(holeLen));
  return {
    job,
    done: 0,
    valid: 0,
    win: new Float64Array(n),
    tie: new Float64Array(n),
    holeLen,
    blocked,
    cums,
    totals,
    hands,
    scores: new Float64Array(n),
    used: new Uint8Array(52),
    deck: new Int32Array(52),
    full: new Int32Array(5),
    seed: job.seed >>> 0,
    sc: {
      cnt: new Int32Array(13),
      suits: new Int32Array(4),
      sMask: new Int32Array(4),
      five: new Int32Array(5),
      seven: new Int32Array(7),
    },
  };
}

/** Runs up to `count` more iterations. Self-contained for the worker. */
export function simStep(state: SimState, count: number): void {
  const job = state.job as SimJob;
  const holeLen = state.holeLen as number;
  const blocked = state.blocked as Uint8Array;
  const cums = state.cums as Array<Float64Array | null>;
  const totals = state.totals as number[];
  const hands = state.hands as Int32Array[];
  const scores = state.scores as Float64Array;
  const used = state.used as Uint8Array;
  const deck = state.deck as Int32Array;
  const full = state.full as Int32Array;
  const sc = state.sc as EvalScratch;
  const seven = sc.seven;
  const nSides = job.sides.length;
  const board = job.board;
  const nb = board.length;
  const need = 5 - nb;
  let seed = state.seed as number;

  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const limit = Math.min(count, job.iterations - state.done);
  for (let it = 0; it < limit; it++) {
    state.done++;
    used.set(blocked);
    let ok = true;
    for (let p = 0; p < nSides; p++) {
      const side = job.sides[p];
      const hand = hands[p];
      if (side.kind === 'hand') {
        const cards = side.cards as number[];
        for (let k = 0; k < holeLen; k++) hand[k] = cards[k];
        continue;
      }
      if (side.kind === 'range') {
        const cum = cums[p] as Float64Array;
        const total = totals[p];
        const combos = side.combos as number[][];
        let got = false;
        for (let tries = 0; tries < 64 && !got; tries++) {
          const target = rnd() * total;
          let lo = 0;
          let hi = cum.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cum[mid] < target) lo = mid + 1;
            else hi = mid;
          }
          const combo = combos[lo];
          let clash = false;
          for (let k = 0; k < combo.length; k++) {
            if (used[combo[k]] === 1) {
              clash = true;
              break;
            }
          }
          if (clash) continue;
          for (let k = 0; k < combo.length; k++) {
            hand[k] = combo[k];
            used[combo[k]] = 1;
          }
          got = true;
        }
        if (!got) {
          ok = false;
          break;
        }
        continue;
      }
      let filled = 0;
      while (filled < holeLen) {
        const c = (rnd() * 52) | 0;
        if (used[c] === 1) continue;
        used[c] = 1;
        hand[filled++] = c;
      }
    }
    if (!ok) continue;

    let nd = 0;
    for (let c = 0; c < 52; c++) if (used[c] === 0) deck[nd++] = c;
    for (let k = 0; k < nb; k++) full[k] = board[k];
    for (let k = 0; k < need; k++) {
      const j = k + ((rnd() * (nd - k)) | 0);
      const tmp = deck[k];
      deck[k] = deck[j];
      deck[j] = tmp;
      full[nb + k] = deck[k];
    }

    let best = -1;
    let nBest = 0;
    for (let p = 0; p < nSides; p++) {
      const hand = hands[p];
      let v: number;
      if (holeLen === 4) {
        v = evalPlo(hand, full, 5, sc);
      } else {
        seven[0] = hand[0];
        seven[1] = hand[1];
        seven[2] = full[0];
        seven[3] = full[1];
        seven[4] = full[2];
        seven[5] = full[3];
        seven[6] = full[4];
        v = evalHand(seven, 7, sc);
      }
      scores[p] = v;
      if (v > best) {
        best = v;
        nBest = 1;
      } else if (v === best) {
        nBest++;
      }
    }
    state.valid++;
    if (nBest === 1) {
      for (let p = 0; p < nSides; p++) {
        if (scores[p] === best) {
          state.win[p]++;
          break;
        }
      }
    } else {
      const share = 1 / nBest;
      for (let p = 0; p < nSides; p++) if (scores[p] === best) state.tie[p] += share;
    }
  }
  state.seed = seed;
}

// ═══════════════════════════ worker plumbing ═══════════════════════════

function fnSrc(fn: { name: string; toString(): string }): string {
  return `const ${fn.name} = ${fn.toString()};`;
}

function buildWorkerSource(): string {
  return [
    fnSrc(straightHigh),
    fnSrc(evalHand),
    fnSrc(evalPlo),
    fnSrc(simInit),
    fnSrc(simStep),
    `
const running = new Map();
self.onmessage = function (ev) {
  const m = ev.data;
  if (m.t === 'cancel') { const j = running.get(m.id); if (j) j.stop = true; return; }
  if (m.t !== 'run') return;
  const state = ${simInit.name}(m.job);
  const entry = { stop: false };
  running.set(m.id, entry);
  const slice = Math.max(512, m.slice | 0);
  const tick = function () {
    if (entry.stop) { running.delete(m.id); self.postMessage({ t: 'cancelled', id: m.id }); return; }
    ${simStep.name}(state, slice);
    if (state.done >= state.job.iterations) {
      running.delete(m.id);
      self.postMessage({ t: 'done', id: m.id, win: Array.from(state.win), tie: Array.from(state.tie), n: state.valid });
      return;
    }
    self.postMessage({ t: 'progress', id: m.id, win: Array.from(state.win), tie: Array.from(state.tie), n: state.valid, done: state.done });
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
};
`,
  ].join('\n');
}

interface Pending {
  resolve(r: EquityResult): void;
  reject(e: Error): void;
  onProgress?: (r: EquityResult) => void;
  players: number;
  iterations: number;
  variant: GameVariant;
}

let workerRef: Worker | null = null;
let workerBroken = false;
let seq = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (workerRef) return workerRef;
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    workerBroken = true;
    return null;
  }
  try {
    const blob = new Blob([buildWorkerSource()], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data as {
        t: string;
        id: number;
        win?: number[];
        tie?: number[];
        n?: number;
        done?: number;
      };
      const job = pending.get(m.id);
      if (!job) return;
      if (m.t === 'progress') {
        job.onProgress?.(makeResult(m.win!, m.tie!, m.n!, job, false));
      } else if (m.t === 'done') {
        pending.delete(m.id);
        job.resolve(makeResult(m.win!, m.tie!, m.n!, job, false));
      } else if (m.t === 'cancelled') {
        pending.delete(m.id);
        job.reject(new Error('equity: cancelled'));
      }
    };
    w.onerror = () => {
      workerBroken = true;
      workerRef = null;
      for (const [, job] of pending) job.reject(new Error('equity: worker failed'));
      pending.clear();
    };
    workerRef = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

// ═══════════════════════════ public API ═══════════════════════════

export interface EquityResult {
  /** win + tie share per player, 0–1, in input order */
  equity: number[];
  /** outright win share */
  win: number[];
  /** split share */
  tie: number[];
  /** iterations that actually produced a showdown */
  iterations: number;
  /** true when the answer was enumerated rather than sampled */
  exact: boolean;
  /** ±standard error on each equity, 0 when exact */
  stdErr: number;
}

export type EquityInput =
  | CardId[]
  | RangeGrid
  | { random: true };

export interface EquityOptions {
  variant?: GameVariant;
  board?: CardId[];
  /** cards removed from the deck that belong to nobody (folded, exposed) */
  dead?: CardId[];
  /** sampling budget; ignored when the spot can be enumerated */
  iterations?: number;
  /** deterministic runs for tests and replays */
  seed?: number;
  onProgress?(partial: EquityResult): void;
}

function makeResult(
  win: number[] | Float64Array,
  tie: number[] | Float64Array,
  n: number,
  job: { players: number },
  exact: boolean,
): EquityResult {
  const w: number[] = [];
  const t: number[] = [];
  const eq: number[] = [];
  const denom = n > 0 ? n : 1;
  for (let p = 0; p < job.players; p++) {
    const wp = (win[p] ?? 0) / denom;
    const tp = (tie[p] ?? 0) / denom;
    w.push(wp);
    t.push(tp);
    eq.push(wp + tp);
  }
  return {
    equity: eq,
    win: w,
    tie: t,
    iterations: n,
    exact,
    stdErr: exact || n <= 0 ? 0 : 0.5 / Math.sqrt(n),
  };
}

function toSide(input: EquityInput, variant: GameVariant, dead: CardId[]): SimSide {
  if (Array.isArray(input)) return { kind: 'hand', cards: input.slice() };
  if ('random' in input) return { kind: 'random' };
  if (variant === 'plo4') {
    throw new Error('equity: 169-cell ranges describe two-card hands, not PLO — pass combos');
  }
  const combos = expandRange(input, dead);
  if (!combos.length) throw new Error('equity: range is empty after card removal');
  return {
    kind: 'range',
    combos: combos.map((c) => [c.cards[0], c.cards[1]]),
    weights: combos.map((c) => c.weight),
  };
}

/**
 * Runs an equity calculation. Resolves with the final numbers; call
 * `onProgress` for a live readout while it converges.
 */
export function equity(
  players: EquityInput[],
  opts: EquityOptions = {},
): Promise<EquityResult> & { cancel(): void } {
  const variant = opts.variant ?? 'nlhe';
  const board = (opts.board ?? []).slice();
  const dead = (opts.dead ?? []).slice();
  const iterations = Math.max(200, Math.round(opts.iterations ?? 20000));
  const seed = opts.seed ?? ((Math.random() * 0xffffffff) >>> 0);

  let sides: SimSide[];
  try {
    sides = players.map((p) => toSide(p, variant, [...board, ...dead]));
  } catch (err) {
    const p = Promise.reject(err instanceof Error ? err : new Error(String(err))) as Promise<
      EquityResult
    > & { cancel(): void };
    p.cancel = () => void 0;
    p.catch(() => void 0);
    return p;
  }

  const job: SimJob = { variant, sides, board, dead, iterations, seed };
  const exact = exactPlan(job);
  if (exact) {
    const res = Promise.resolve(exact) as Promise<EquityResult> & { cancel(): void };
    res.cancel = () => void 0;
    return res;
  }

  const id = seq++;
  let cancelled = false;
  const worker = getWorker();

  const promise = new Promise<EquityResult>((resolve, reject) => {
    const meta: Pending = {
      resolve,
      reject,
      onProgress: opts.onProgress,
      players: players.length,
      iterations,
      variant,
    };
    if (worker) {
      pending.set(id, meta);
      worker.postMessage({ t: 'run', id, job, slice: sliceFor(job) });
      return;
    }
    // Main-thread fallback: identical maths, sliced across frames.
    const state = simInit(job);
    const slice = Math.max(256, Math.round(sliceFor(job) / 4));
    const step = () => {
      if (cancelled) {
        reject(new Error('equity: cancelled'));
        return;
      }
      simStep(state, slice);
      if (state.done >= iterations) {
        resolve(makeResult(state.win, state.tie, state.valid, meta, false));
        return;
      }
      meta.onProgress?.(makeResult(state.win, state.tie, state.valid, meta, false));
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
      else setTimeout(step, 0);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
    else setTimeout(step, 0);
  }) as Promise<EquityResult> & { cancel(): void };

  promise.cancel = () => {
    cancelled = true;
    if (worker && pending.has(id)) worker.postMessage({ t: 'cancel', id });
  };
  return promise;
}

/** Bigger slices for cheap jobs, smaller ones for PLO which is 60× the work. */
function sliceFor(job: SimJob): number {
  const heavy = job.variant === 'plo4' ? 8 : 1;
  const players = Math.max(2, job.sides.length);
  return Math.max(512, Math.round(24000 / (heavy * players)));
}

/**
 * When every hand is known and at most one card is missing we can enumerate,
 * which is both instant and exact. Anything larger goes to Monte Carlo.
 */
function exactPlan(job: SimJob): EquityResult | null {
  if (job.sides.some((s) => s.kind !== 'hand')) return null;
  const missing = 5 - job.board.length;
  if (missing > 1) return null;
  const holeLen = job.variant === 'plo4' ? 4 : 2;
  const sc: EvalScratch = {
    cnt: new Int32Array(13),
    suits: new Int32Array(4),
    sMask: new Int32Array(4),
    five: new Int32Array(5),
    seven: new Int32Array(7),
  };
  const used = new Uint8Array(52);
  for (const c of job.board) used[c] = 1;
  for (const c of job.dead) used[c] = 1;
  for (const s of job.sides) for (const c of s.cards ?? []) used[c] = 1;

  const n = job.sides.length;
  const win = new Float64Array(n);
  const tie = new Float64Array(n);
  const full = new Int32Array(5);
  const seven = sc.seven;
  const scores = new Float64Array(n);
  let count = 0;

  const runOne = (): void => {
    let best = -1;
    let nBest = 0;
    for (let p = 0; p < n; p++) {
      const hole = job.sides[p].cards as number[];
      let v: number;
      if (holeLen === 4) {
        v = evalPlo(hole, full, 5, sc);
      } else {
        seven[0] = hole[0];
        seven[1] = hole[1];
        for (let k = 0; k < 5; k++) seven[k + 2] = full[k];
        v = evalHand(seven, 7, sc);
      }
      scores[p] = v;
      if (v > best) {
        best = v;
        nBest = 1;
      } else if (v === best) nBest++;
    }
    count++;
    if (nBest === 1) {
      for (let p = 0; p < n; p++) {
        if (scores[p] === best) {
          win[p]++;
          break;
        }
      }
    } else {
      const share = 1 / nBest;
      for (let p = 0; p < n; p++) if (scores[p] === best) tie[p] += share;
    }
  };

  for (let k = 0; k < job.board.length; k++) full[k] = job.board[k];
  if (missing === 0) {
    runOne();
  } else {
    for (let c = 0; c < 52; c++) {
      if (used[c] === 1) continue;
      full[4] = c;
      runOne();
    }
  }
  return makeResult(win, tie, count, { players: n }, true);
}

// ═══════════════════════════ conveniences ═══════════════════════════

const sharedScratch: EvalScratch = {
  cnt: new Int32Array(13),
  suits: new Int32Array(4),
  sMask: new Int32Array(4),
  five: new Int32Array(5),
  seven: new Int32Array(7),
};

/** Synchronous best-five score for 5–7 cards. Used by the solver. */
export function score(cards: readonly CardId[]): number {
  return evalHand(cards, cards.length, sharedScratch);
}

/** Synchronous PLO score: two of four hole cards, three of the board. */
export function scorePlo(hole: readonly CardId[], board: readonly CardId[]): number {
  return evalPlo(hole, board, board.length, sharedScratch);
}

export const CATEGORY_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
] as const;

export function categoryOf(scoreValue: number): number {
  return scoreValue >>> 20;
}

export function categoryName(scoreValue: number): string {
  return CATEGORY_NAMES[scoreValue >>> 20] ?? 'High card';
}

/** Hand vs hand, or hand vs range — the shape the drills use most. */
export function equityVs(
  hero: CardId[],
  villain: EquityInput,
  opts: EquityOptions = {},
): Promise<EquityResult> & { cancel(): void } {
  return equity([hero, villain], opts);
}

/** Releases the worker. The next call transparently spins up a new one. */
export function disposeEquity(): void {
  if (workerRef) {
    workerRef.terminate();
    workerRef = null;
  }
  for (const [, job] of pending) job.reject(new Error('equity: disposed'));
  pending.clear();
}
