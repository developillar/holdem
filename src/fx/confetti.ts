/**
 * ROYALE — fx/confetti.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The celebration system.
 *
 * WHY DOM AND NOT CANVAS (the call the brief asked me to justify):
 * A 2D canvas confetti is the usual answer, and it is the wrong one here.
 *  1. Our ceiling is 240 pieces. At that count the compositor handles 240
 *     ~10×14px layers far more cheaply than clearing and repainting a
 *     393×852 @ DPR3 surface — that is a 1179×2556 fill every frame, roughly
 *     3 megapixels of overdraw for maybe 30k pixels of actual confetti.
 *  2. Real paper tumbles in three dimensions. `rotateX`/`rotateY` under a CSS
 *     `perspective` gives that for free, with correct perspective foreshorten
 *     as pieces cross the screen. In canvas you hand-roll the projection and
 *     it still cannot show a *different colour on the back of the sheet* —
 *     which we get from `backface-visibility` and a `::before` back face, at
 *     zero extra DOM nodes.
 *  3. Everything else in this layer (text, banners, shine) is DOM. One
 *     runtime, one pool, one budget, one rAF.
 * The pieces come from the shared pool in `engine.ts`, so a session-long
 * sequence of celebrations allocates elements exactly once.
 */
import { engine, token, reduceMotion, rand, rangeOf, pick, type FxPoint, type Particle } from './engine.ts';

export type ConfettiVariant = 'party' | 'gold' | 'rare' | 'epic' | 'legendary' | 'mythic' | 'emerald';

export interface ConfettiOpts {
  /** burst origin; defaults to just above the vertical centre */
  origin?: FxPoint;
  /** piece count before the perf-tier density scale */
  count?: number;
  variant?: ConfettiVariant;
  /** launch direction, radians (−π/2 = up) */
  angle?: number;
  /** half-cone, radians */
  spread?: number;
  /** launch speed multiplier, 1 = default */
  power?: number;
  /** piece scale multiplier */
  scale?: number;
  /** add glinting star/spark sprites on top of the paper */
  glint?: boolean;
}

// ─────────────────────────── palettes ───────────────────────────

interface Palette {
  /** front faces */
  front: string[];
  /** back faces — always a shade or two down so tumbling reads */
  back: string[];
  /** glint colour */
  glint: string;
}

let palettes: Record<ConfettiVariant, Palette> | null = null;

/**
 * Built once, lazily, from `tokens.css`. Back faces are the darker stops of
 * the same ramp — that is what makes a tumbling piece look like one sheet of
 * paper rather than two random colours flickering.
 */
function paletteOf(variant: ConfettiVariant): Palette {
  if (!palettes) {
    const g100 = token('--c-gold-100', '#fdf3d0');
    const g200 = token('--c-gold-200', '#f6e0a0');
    const g300 = token('--c-gold-300', '#edc96b');
    const g400 = token('--c-gold-400', '#d9a93a');
    const g500 = token('--c-gold-500', '#c08d21');
    const g600 = token('--c-gold-600', '#94690f');
    const g700 = token('--c-gold-700', '#63460a');
    const white = token('--c-white', '#f7f9fd');
    const good = token('--c-good', '#34d399');
    const goodDim = token('--c-good-dim', '#0f5b41');
    const info = token('--c-info', '#60a5fa');
    const epic = token('--c-epic', '#a78bfa');
    const mythic = token('--c-mythic', '#f472b6');
    const rare = token('--c-rar-rare', '#47a9ff');
    const rareDim = token('--c-slate-600', '#2a3143');
    const felt = token('--c-felt-500', '#1c5a3c');
    const feltDim = token('--c-felt-800', '#0a2418');
    const epicDim = token('--c-rar-epic', '#a855f7');
    const slate = token('--c-slate-500', '#3b4356');

    palettes = {
      party: {
        front: [g300, g200, white, good, info, epic, mythic, g400],
        back: [g500, g400, slate, goodDim, rareDim, epicDim, g600, g500],
        glint: g200,
      },
      gold: {
        front: [g100, g200, g300, g300, g400, white],
        back: [g500, g500, g600, g400, g700, g300],
        glint: g100,
      },
      rare: {
        front: [rare, info, white, g200],
        back: [rareDim, rareDim, slate, g500],
        glint: white,
      },
      epic: {
        front: [epic, epicDim, white, g300],
        back: [slate, rareDim, slate, g500],
        glint: epic,
      },
      legendary: {
        front: [g100, g200, g300, g400, white, g300],
        back: [g500, g600, g500, g700, g300, g600],
        glint: g100,
      },
      mythic: {
        front: [mythic, epic, white, g200],
        back: [epicDim, rareDim, slate, g500],
        glint: mythic,
      },
      emerald: {
        front: [good, felt, white, g300],
        back: [goodDim, feltDim, slate, g500],
        glint: good,
      },
    };
  }
  return palettes[variant];
}

// ─────────────────────────── paper physics ───────────────────────────

/**
 * Per-piece randomisation applied after the generic emitter has done its job.
 * This is where a rectangle stops being a rectangle and becomes paper: its own
 * terminal velocity (mass/area ratio), its own flutter rate, and a shape that
 * is sometimes a square chit, sometimes a long streamer.
 */
function dressPaper(p: Particle, scale: number): void {
  const long = rand() < 0.24;
  const w = long ? rangeOf(5, 8) : rangeOf(8, 14);
  const h = long ? rangeOf(18, 30) : rangeOf(10, 17);
  engine.sizeOf(p, w * scale, h * scale);

  // Terminal velocity scales with how much air the sheet has to push. Small
  // dense chits drop; big flat sheets hang and drift.
  const area = w * h;
  p.terminal = 400 - Math.min(230, area * 1.6) + rangeOf(-24, 24);
  p.flutter = rangeOf(70, 190) * (long ? 0.6 : 1);
  p.flutterHz = rangeOf(0.75, 2.3);
  p.vrx = rangeOf(-1, 1) * rangeOf(240, 880);
  p.vry = rangeOf(-1, 1) * rangeOf(240, 880);
  p.vrot = rangeOf(-1, 1) * 150;
  p.scale = 1;
}

// ─────────────────────────── public API ───────────────────────────

/**
 * A directional burst — the workhorse. Defaults to a wide upward fountain
 * from just above centre, which is what a showdown win wants.
 */
export function confettiBurst(opts: ConfettiOpts = {}): number {
  if (reduceMotion()) return 0;
  const { w, h } = engine.viewport();
  const pal = paletteOf(opts.variant ?? 'party');
  const power = opts.power ?? 1;
  const scale = opts.scale ?? 1;
  const origin = opts.origin ?? { x: w / 2, y: h * 0.46 };

  const made = engine.emit({
    count: opts.count ?? 110,
    origin,
    originSpread: 14,
    sprite: 'confetti',
    angle: opts.angle ?? -Math.PI / 2,
    spread: opts.spread ?? 0.92,
    speed: 780 * power,
    speedVar: 0.5,
    gravity: 1180,
    drag: 1.5,
    life: 3.1,
    lifeVar: 0.32,
    fadeOut: 0.16,
    tumble: true,
    color: pal.front,
    color2: pal.back,
    weight: 3,
    onSpawn: (p) => dressPaper(p, scale),
  });

  if (opts.glint !== false) {
    engine.emit({
      count: Math.round((opts.count ?? 110) * 0.16),
      origin,
      originSpread: 10,
      sprite: 'star',
      angle: opts.angle ?? -Math.PI / 2,
      spread: (opts.spread ?? 0.92) * 0.8,
      speed: 620 * power,
      speedVar: 0.55,
      gravity: 900,
      drag: 2.2,
      life: 1.1,
      lifeVar: 0.35,
      size: 13,
      sizeVar: 0.45,
      scaleTo: 0.2,
      spin: 260,
      color: pal.glint,
      blend: 'plus',
      weight: 1,
    });
  }
  return made;
}

/**
 * The bottom-corner cannons. Two hard diagonal volleys that cross in the upper
 * third — reserved for tournament wins and royal flushes, because they own the
 * whole screen for about four seconds.
 */
export function confettiCannons(opts: ConfettiOpts = {}): void {
  if (reduceMotion()) return;
  const { w, h } = engine.viewport();
  const variant = opts.variant ?? 'gold';
  const count = Math.round((opts.count ?? 150) / 2);
  const power = opts.power ?? 1;

  const fire = (x: number, angle: number, delay: number): void => {
    engine.after(delay, () => {
      confettiBurst({
        ...opts,
        variant,
        origin: { x, y: h + 12 },
        count,
        angle,
        spread: 0.3,
        power: 2.3 * power,
        glint: true,
      });
    });
  };

  fire(-8, -Math.PI / 2 + 0.62, 0);
  fire(w + 8, -Math.PI / 2 - 0.62, 110);
}

/**
 * Sustained fall from above the top edge. Returns a stop function; also stops
 * itself after `ms`. Used behind unlock/level-up banners where the celebration
 * needs to last as long as the banner does.
 */
export function confettiRain(opts: ConfettiOpts & { ms?: number; rate?: number } = {}): () => void {
  if (reduceMotion()) return () => void 0;
  const pal = paletteOf(opts.variant ?? 'party');
  const scale = opts.scale ?? 1;
  const rate = opts.rate ?? 26;
  const ms = opts.ms ?? 2600;
  let elapsed = 0;
  let carry = 0;
  let stopped = false;

  const stopTick = engine.track((dt) => {
    if (stopped) return false;
    elapsed += dt * 1000;
    // Ease the emission off over the last third so it tapers instead of cuts.
    const fade = elapsed > ms * 0.66 ? Math.max(0, 1 - (elapsed - ms * 0.66) / (ms * 0.34)) : 1;
    carry += rate * dt * fade;
    const n = Math.floor(carry);
    if (n > 0) {
      carry -= n;
      const { w } = engine.viewport();
      engine.emit({
        count: n,
        origin: { x: rand() * w, y: -24 },
        originSpread: 0,
        sprite: 'confetti',
        angle: Math.PI / 2,
        spread: 0.34,
        speed: 130,
        speedVar: 0.5,
        gravity: 620,
        drag: 1.1,
        life: 6,
        lifeVar: 0.2,
        fadeOut: 0.1,
        tumble: true,
        color: pal.front,
        color2: pal.back,
        weight: 2,
        onSpawn: (p) => dressPaper(p, scale),
      });
    }
    return elapsed < ms;
  });

  return () => {
    stopped = true;
    stopTick();
  };
}

/**
 * The full package for a headline moment: a centre fountain, cannons on the
 * beat after it, and a light rain behind both. Tuned so the screen is busiest
 * at ~450ms and readable again by ~3.5s.
 */
export function confettiCelebrate(variant: ConfettiVariant = 'gold', origin?: FxPoint): void {
  if (reduceMotion()) return;
  confettiBurst({ variant, origin, count: 96, power: 1.05 });
  engine.after(180, () => confettiCannons({ variant, count: 120 }));
  engine.after(520, () => confettiRain({ variant, ms: 2200, rate: 18 }));
}

/** A small, cheap pop — used for row-level wins and reward claims. */
export function confettiPop(origin: FxPoint, variant: ConfettiVariant = 'gold'): void {
  if (reduceMotion()) return;
  const pal = paletteOf(variant);
  engine.emit({
    count: 26,
    origin,
    originSpread: 6,
    sprite: 'confetti',
    speed: 340,
    speedVar: 0.6,
    gravity: 1250,
    drag: 2,
    life: 1.5,
    lifeVar: 0.3,
    fadeOut: 0.24,
    tumble: true,
    color: pal.front,
    color2: pal.back,
    weight: 2,
    onSpawn: (p) => dressPaper(p, 0.82),
  });
  engine.emit({
    count: 10,
    origin,
    sprite: 'spark',
    speed: 300,
    speedVar: 0.6,
    drag: 5,
    life: 0.5,
    size: 5,
    scaleTo: 0.1,
    color: pick(pal.front),
    blend: 'plus',
    weight: 1,
  });
}
