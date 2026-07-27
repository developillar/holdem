/**
 * ROYALE — server-side opponents.
 *
 * The client ships a very strong bot stack in `src/engine/bots.ts`. If Node's
 * type-stripping loader can pull it in, we use it: identical opponents online
 * and offline is a real product property, not a nicety. If it cannot load —
 * different signature, a syntax form the stripper rejects, a mid-flight edit —
 * we fall back to an internal policy that is deliberately simple but never
 * silly: it respects pot odds, position, board texture and stack depth.
 *
 * Either way the room only ever sees `BotBrain`.
 */

import { Rng } from '../src/core/rng.ts';
import type {
  ActionKind,
  CardId,
  GameVariant,
  PlayerRef,
  PositionName,
  Street,
} from '../src/core/types.ts';
import { rank7, rankFor, q } from './poker.ts';
import type { Logger } from './log.ts';

export interface BotDecideCtx {
  variant: GameVariant;
  street: Street;
  handId: number;
  holeCards: readonly CardId[];
  board: readonly CardId[];
  pot: number;
  toCall: number;
  stack: number;
  committed: number;
  bb: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  canCheck: boolean;
  canRaise: boolean;
  position: PositionName;
  seatsInHand: number;
  activeOpponents: number;
  playersToActAfter: number;
  preflopRaises: number;
  raisesThisStreet: number;
  effectiveStack: number;
  isBombPot: boolean;
  chipUnit: number;
}

export interface BotChoice {
  kind: ActionKind;
  /** total street commitment after the action (raise-to semantics) */
  amount: number;
  thinkMs: number;
  note: string;
}

export interface BotBrain {
  readonly ref: PlayerRef;
  beginHand(handId: number): void;
  decide(ctx: BotDecideCtx): BotChoice;
  observe(won: number, showedDown: boolean): void;
}

// ═══════════════════════════════════════════════════════════════════
// Engine bridge — dynamic, optional, never fatal
// ═══════════════════════════════════════════════════════════════════

interface EngineShape {
  createBot(profile: unknown, seat: number, seed: number): unknown;
  botBeginHand(bot: unknown, handId: number): void;
  decideBotAction(bot: unknown, ctx: unknown): { kind: ActionKind; amount: number; thinkMs: number; note: string };
  botObserveResult?(bot: unknown, info: unknown): void;
  pickOpponents(n: number, seed: number, opts?: unknown): unknown[];
  toPlayerRef(profile: unknown): PlayerRef;
}

let enginePromise: Promise<EngineShape | null> | null = null;

/**
 * Load `src/engine/{bots,profiles}.ts` once. Any failure resolves to `null`
 * and the fallback takes over for the process lifetime.
 */
export function loadEngineBots(log?: Logger): Promise<EngineShape | null> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    try {
      const bots = (await import('../src/engine/bots.ts')) as unknown as Record<string, unknown>;
      const profiles = (await import('../src/engine/profiles.ts')) as unknown as Record<string, unknown>;
      const need = ['createBot', 'botBeginHand', 'decideBotAction'];
      for (const k of need) {
        if (typeof bots[k] !== 'function') throw new Error(`bots.${k} missing`);
      }
      if (typeof profiles.pickOpponents !== 'function' || typeof profiles.toPlayerRef !== 'function') {
        throw new Error('profiles.pickOpponents/toPlayerRef missing');
      }
      log?.info('bots.engine-loaded', { source: 'src/engine/bots.ts' });
      return {
        createBot: bots.createBot as EngineShape['createBot'],
        botBeginHand: bots.botBeginHand as EngineShape['botBeginHand'],
        decideBotAction: bots.decideBotAction as EngineShape['decideBotAction'],
        botObserveResult: bots.botObserveResult as EngineShape['botObserveResult'] | undefined,
        pickOpponents: profiles.pickOpponents as EngineShape['pickOpponents'],
        toPlayerRef: profiles.toPlayerRef as EngineShape['toPlayerRef'],
      };
    } catch (err) {
      log?.warn('bots.engine-unavailable', {
        reason: err instanceof Error ? err.message : String(err),
        fallback: 'internal',
      });
      return null;
    }
  })();
  return enginePromise;
}

class EngineBrain implements BotBrain {
  readonly ref: PlayerRef;
  private handId = 0;
  private engine: EngineShape;
  private bot: unknown;
  private fallback: BotBrain;

  constructor(engine: EngineShape, bot: unknown, ref: PlayerRef, fallback: BotBrain) {
    this.engine = engine;
    this.bot = bot;
    this.ref = ref;
    this.fallback = fallback;
  }

  beginHand(handId: number): void {
    this.handId = handId;
    try {
      this.engine.botBeginHand(this.bot, handId);
    } catch {
      /* the fallback needs no per-hand setup */
    }
    this.fallback.beginHand(handId);
  }

  decide(ctx: BotDecideCtx): BotChoice {
    try {
      const d = this.engine.decideBotAction(this.bot, {
        ...ctx,
        boards: [ctx.board],
        ante: 0,
        opponentPostflopBets: ctx.raisesThisStreet,
        icmPressure: 1,
        handId: this.handId,
      });
      if (d && typeof d.kind === 'string' && Number.isFinite(d.amount)) {
        return {
          kind: d.kind,
          amount: d.amount,
          thinkMs: Number.isFinite(d.thinkMs) ? Math.max(160, Math.min(9000, d.thinkMs)) : 900,
          note: typeof d.note === 'string' ? d.note : 'engine',
        };
      }
    } catch {
      /* fall through */
    }
    return this.fallback.decide(ctx);
  }

  observe(won: number, showedDown: boolean): void {
    this.fallback.observe(won, showedDown);
    if (!this.engine.botObserveResult) return;
    try {
      this.engine.botObserveResult(this.bot, { won, showedDown, wentToShowdown: showedDown });
    } catch {
      /* non-fatal */
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Internal fallback policy
// ═══════════════════════════════════════════════════════════════════

const FALLBACK_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['Nils Bergman', 'SE'],
  ['RiverQueen', 'US'],
  ['Takeshi Ono', 'JP'],
  ['Marta Sosa', 'AR'],
  ['ColdDeckCliff', 'GB'],
  ['Ayşe Yıldız', 'TR'],
  ['Dmytro K.', 'UA'],
  ['SlowRollSam', 'CA'],
  ['Leila Haddad', 'MA'],
  ['Pieter Jansen', 'NL'],
  ['ThreeBetTina', 'AU'],
  ['Rui Almeida', 'PT'],
  ['MinRaiseMike', 'US'],
  ['Jae-won Park', 'KR'],
  ['Chiara Rossi', 'IT'],
  ['NutPeddler', 'DE'],
];

type Style = 'tight' | 'solid' | 'loose' | 'wild';
const STYLE_ORDER: readonly Style[] = ['tight', 'solid', 'solid', 'loose', 'loose', 'wild'];

/** 169-entry preflop strength approximation, 0 (worst) .. 1 (AA). */
function preflopStrength(hole: readonly CardId[]): number {
  if (hole.length < 2) return 0.3;
  const ranks = hole.map((c) => c >> 2).sort((a, b) => b - a);
  const suits = hole.map((c) => c & 3);
  const hi = ranks[0];
  const lo = ranks[1];
  const suited = suits[0] === suits[1];
  const gap = hi - lo;

  if (hole.length >= 4) {
    // Omaha: reward connectedness, pairs and double-suitedness
    let s = 0;
    const uniqSuits = new Set(suits).size;
    s += (ranks[0] + ranks[1]) / 24 * 0.45;
    const pairs = ranks.length - new Set(ranks).size;
    s += pairs * 0.12;
    const spread = ranks[0] - ranks[ranks.length - 1];
    s += spread <= 4 ? 0.2 : spread <= 6 ? 0.1 : 0;
    s += uniqSuits <= 2 ? 0.18 : uniqSuits === 3 ? 0.08 : 0;
    return Math.max(0, Math.min(1, s));
  }

  if (hi === lo) return 0.52 + (hi / 12) * 0.48; // pairs: 22 → .52, AA → 1
  let s = 0.06 + (hi / 12) * 0.42 + (lo / 12) * 0.18;
  if (suited) s += 0.07;
  if (gap === 1) s += 0.06;
  else if (gap === 2) s += 0.03;
  else if (gap > 4) s -= 0.06;
  return Math.max(0, Math.min(0.95, s));
}

/** 0..1 made-hand strength from the integer rank of the current holding. */
function madeStrength(variant: GameVariant, hole: readonly CardId[], board: readonly CardId[]): number {
  const value = rankFor(variant, hole, board);
  const cat = value >>> 20;
  const kicker = ((value >> 16) & 15) / 12;
  const base = [0.06, 0.3, 0.52, 0.68, 0.78, 0.84, 0.92, 0.97, 1][cat] ?? 0.1;
  return Math.min(1, base + kicker * (cat <= 1 ? 0.14 : 0.03));
}

/** Rough flush/straight draw detection: does one more card change everything? */
function drawStrength(hole: readonly CardId[], board: readonly CardId[]): number {
  if (board.length < 3 || board.length > 4) return 0;
  const all = [...hole, ...board];
  const suits = [0, 0, 0, 0];
  let mask = 0;
  for (const c of all) {
    suits[c & 3]++;
    mask |= 1 << (c >> 2);
  }
  let draw = 0;
  if (Math.max(...suits) === 4) draw = Math.max(draw, 0.34);
  for (let hi = 12; hi >= 3; hi--) {
    let run = 0;
    for (let r = hi; r > hi - 5 && r >= 0; r--) if (mask & (1 << r)) run++;
    if (run === 4) {
      draw = Math.max(draw, 0.22);
      break;
    }
  }
  return draw;
}

const LATE: ReadonlySet<PositionName> = new Set<PositionName>(['CO', 'BTN']);

class FallbackBrain implements BotBrain {
  readonly ref: PlayerRef;
  private rng: Rng;
  private style: Style;
  private tilt = 0;

  constructor(seat: number, seed: number, looseness: number) {
    this.rng = new Rng((seed ^ (seat * 0x9e3779b1)) >>> 0);
    const styleBias = Math.min(5, Math.floor(this.rng.next() * 3 + looseness * 3));
    this.style = STYLE_ORDER[styleBias] ?? 'solid';
    const [name, country] = FALLBACK_NAMES[(seed + seat * 7) % FALLBACK_NAMES.length];
    this.ref = {
      id: `bot-${seat}-${(seed >>> 0).toString(36)}`,
      name,
      avatarId: `av-${String(1 + ((seed + seat * 5) % 48)).padStart(2, '0')}`,
      frameId: null,
      titleId: null,
      emoteSetId: 'emote-core',
      level: 4 + ((seed + seat * 13) % 44),
      premium: this.rng.bool(0.18),
      heat: Math.round(this.rng.next() * 40) / 100,
      countryCode: country,
    };
  }

  beginHand(): void {
    this.tilt *= 0.7;
  }

  observe(won: number, showedDown: boolean): void {
    if (won <= 0 && showedDown) this.tilt = Math.min(1, this.tilt + 0.25);
    else if (won > 0) this.tilt = Math.max(0, this.tilt - 0.2);
  }

  decide(ctx: BotDecideCtx): BotChoice {
    const aggro = { tight: 0.16, solid: 0.28, loose: 0.4, wild: 0.58 }[this.style] + this.tilt * 0.15;
    const looseCall = { tight: 0.9, solid: 1, loose: 1.18, wild: 1.4 }[this.style];

    const strength =
      ctx.street === 'preflop'
        ? preflopStrength(ctx.holeCards)
        : Math.min(1, madeStrength(ctx.variant, ctx.holeCards, ctx.board) + drawStrength(ctx.holeCards, ctx.board));

    const potOdds = ctx.toCall > 0 ? ctx.toCall / Math.max(ctx.chipUnit, ctx.pot + ctx.toCall) : 0;
    const positional = LATE.has(ctx.position) ? 0.06 : ctx.position === 'BB' ? 0.03 : 0;
    const multiway = Math.max(0, ctx.seatsInHand - 2) * 0.035;
    const effective = strength + positional - multiway;

    const think = (base: number, spread: number): number =>
      Math.round(base + this.rng.next() * spread + (ctx.street === 'preflop' ? 0 : 220));

    // ── nothing to call: check or take the betting lead
    if (ctx.canCheck) {
      const wantBet =
        ctx.canRaise &&
        ctx.maxRaiseTo > ctx.minRaiseTo &&
        (effective > 0.62 - aggro * 0.35 || (this.rng.next() < aggro * 0.5 && ctx.seatsInHand <= 3));
      if (wantBet) {
        const frac = effective > 0.85 ? 0.75 : effective > 0.6 ? 0.55 : 0.4;
        const to = q(ctx.committed + (ctx.pot + ctx.toCall) * frac, ctx.chipUnit);
        return {
          kind: ctx.street === 'preflop' && ctx.pot > ctx.bb ? 'raise' : 'bet',
          amount: Math.min(Math.max(to, ctx.minRaiseTo), ctx.maxRaiseTo),
          thinkMs: think(520, 900),
          note: effective > 0.75 ? 'value' : 'initiative',
        };
      }
      return { kind: 'check', amount: ctx.committed, thinkMs: think(320, 700), note: 'check back' };
    }

    // ── facing a bet
    const shoveable = ctx.effectiveStack <= ctx.bb * 12 && ctx.street === 'preflop';
    if (shoveable && effective > 0.66 && ctx.canRaise) {
      return { kind: 'allin', amount: ctx.maxRaiseTo, thinkMs: think(600, 900), note: 'short-stack jam' };
    }

    const raiseBar = 0.8 - aggro * 0.22;
    if (ctx.canRaise && effective > raiseBar && ctx.maxRaiseTo > ctx.minRaiseTo && this.rng.next() < 0.72) {
      const target = q(
        ctx.committed + ctx.toCall + (ctx.pot + ctx.toCall) * (effective > 0.9 ? 0.85 : 0.62),
        ctx.chipUnit,
      );
      return {
        kind: 'raise',
        amount: Math.min(Math.max(target, ctx.minRaiseTo), ctx.maxRaiseTo),
        thinkMs: think(900, 1600),
        note: 'raise for value',
      };
    }

    // bluff-raise a small slice of the time when last to act heads-up
    if (
      ctx.canRaise &&
      ctx.seatsInHand === 2 &&
      ctx.playersToActAfter === 0 &&
      ctx.maxRaiseTo > ctx.minRaiseTo &&
      this.rng.next() < aggro * 0.16
    ) {
      return { kind: 'raise', amount: ctx.minRaiseTo, thinkMs: think(1100, 1800), note: 'bluff raise' };
    }

    const callBar = potOdds * looseCall + 0.14 - positional;
    if (effective >= callBar) {
      if (ctx.toCall >= ctx.stack - ctx.chipUnit / 2) {
        return { kind: 'allin', amount: q(ctx.committed + ctx.stack, ctx.chipUnit), thinkMs: think(900, 1500), note: 'call all-in' };
      }
      return { kind: 'call', amount: q(ctx.committed + ctx.toCall, ctx.chipUnit), thinkMs: think(420, 1100), note: 'pot odds' };
    }

    return { kind: 'fold', amount: ctx.committed, thinkMs: think(260, 620), note: 'no equity' };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════

export interface BotSpawnOptions {
  seat: number;
  seed: number;
  looseness: number;
  /** profile ids already at the table — never seat the same face twice */
  exclude: readonly string[];
}

/**
 * Build a brain for one seat. Resolves synchronously against whatever the
 * engine loader has produced so far; the very first tables on a cold start
 * therefore get fallback bots, and every table after that gets engine bots.
 */
export function spawnBot(engine: EngineShape | null, opts: BotSpawnOptions): BotBrain {
  const fallback = new FallbackBrain(opts.seat, opts.seed, opts.looseness);
  if (!engine) return fallback;
  try {
    const picked = engine.pickOpponents(1, (opts.seed ^ (opts.seat * 2654435761)) >>> 0, {
      looseness: opts.looseness,
      exclude: opts.exclude,
    });
    const profile = picked[0];
    if (!profile) return fallback;
    const ref = engine.toPlayerRef(profile);
    if (!ref || typeof ref.id !== 'string') return fallback;
    const bot = engine.createBot(profile, opts.seat, (opts.seed + opts.seat * 7919) >>> 0);
    return new EngineBrain(engine, bot, ref, fallback);
  } catch {
    return fallback;
  }
}

/** Exposed for the room's showdown labelling when the engine is absent. */
export { rank7 };
