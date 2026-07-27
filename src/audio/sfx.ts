/**
 * ROYALE — cue library.
 * ─────────────────────────────────────────────────────────────────────
 * Every sound the app makes, designed rather than sampled. The rules
 * this library follows:
 *
 *  • Nothing is ever identical twice. Pitch, timing, filter centres and
 *    the read offset into the noise beds are all jittered, so a hundred
 *    card deals in a session never machine-gun.
 *  • Distance is mixed, not implied. Dealing is dry, quiet and narrow —
 *    it happens 40 cm from your face. Wins are wide and sit in the hall.
 *  • Transients first. Almost every cue is a 3–8 ms impulse with a body
 *    behind it; that impulse is what your hand feels.
 *  • Nothing above ~9 kHz and nothing below ~28 Hz survives — phone
 *    speakers turn both into distortion.
 *
 * Every function is a safe no-op until the mixer is live.
 */
import type { ReactionKind, Rarity } from '../core/types.ts';
import type { FxBurstKind } from '../core/bus.ts';
import { mixer, type Strip, type StripOpts } from './mixer.ts';
import {
  ampEnv,
  arng,
  clamp,
  filterChain,
  fmVoice,
  rand,
  semi,
  sweep,
  vary,
  type AmpEnv,
  type FilterSpec,
  type NoiseKind,
} from './synth.ts';

/** Scheduling guard — never ask the graph to start something in the past. */
const LOOKAHEAD = 0.01;

/** Detail budget that scales with the perf tier. */
function detail(high: number, mid: number, low: number): number {
  return mixer.quality === 'high' ? high : mixer.quality === 'mid' ? mid : low;
}

function open(opts: StripOpts): Strip | null {
  return mixer.strip(opts);
}

/**
 * Some moments are announced twice — the engine emits `hand:award` and
 * the FX layer emits `fx:burst`/`chips-win` for the same pot. Stacking
 * two 1.2 s cascades sounds like a mistake and costs a thousand nodes,
 * so the expensive cues claim a short exclusive window.
 */
const claims = new Map<string, number>();
function claim(key: string, ms: number): boolean {
  const now = performance.now();
  const until = claims.get(key) ?? 0;
  if (now < until) return false;
  claims.set(key, now + ms);
  return true;
}

// ───────────────────────────── primitives ─────────────────────────────

interface NoiseOpts {
  kind?: NoiseKind;
  /** playback-rate scaling; also transposes the noise colour */
  rate?: number;
  /** sweep the first filter's cutoff from → to across `sweepSecs` */
  sweep?: [number, number];
  sweepSecs?: number;
}

/**
 * A band-limited noise burst: the workhorse behind cards, chips, cloth
 * and wood. Returns the absolute time the voice finishes.
 */
function noise(s: Strip, t: number, specs: FilterSpec[], env: AmpEnv, o: NoiseOpts = {}): number {
  const kind = o.kind ?? 'white';
  const dur = env.a + env.d + (env.hold ?? 0) + env.r + 0.02;
  const src = s.synth.noiseSource(kind, o.rate ?? 1);
  const chain = filterChain(s.ctx, specs);
  const g = s.ctx.createGain();

  src.connect(chain.input);
  chain.output.connect(g);
  g.connect(s.input);

  if (o.sweep && chain.filters.length > 0) {
    sweep(chain.filters[0].frequency, t, o.sweep[0], o.sweep[1], o.sweepSecs ?? dur * 0.8);
  }

  const end = ampEnv(g.gain, t, env);
  src.start(t, s.synth.noiseOffset(kind, dur));
  src.stop(end + 0.02);
  src.onended = () => {
    try {
      src.disconnect();
      chain.output.disconnect();
      g.disconnect();
    } catch {
      /* torn down */
    }
  };
  return end;
}

/** A pitched body: one oscillator with an optional glide. */
function tone(
  s: Strip,
  t: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  glide: number,
  env: AmpEnv,
  detune = 0,
): number {
  const osc = s.ctx.createOscillator();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(Math.max(20, f0), t);
  if (Math.abs(f1 - f0) > 0.5) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + Math.max(0.006, glide));
  }
  const g = s.ctx.createGain();
  osc.connect(g);
  g.connect(s.input);
  const end = ampEnv(g.gain, t, env);
  osc.start(t);
  osc.stop(end + 0.02);
  osc.onended = () => {
    try {
      osc.disconnect();
      g.disconnect();
    } catch {
      /* torn down */
    }
  };
  return end;
}

/** FM bell / Rhodes-ish note. `ratio` 1 = warm tine, 3.5+ = glassy. */
function bell(
  s: Strip,
  t: number,
  freq: number,
  env: AmpEnv,
  ratio = 1,
  index = 2.4,
  indexEnd = 0.12,
  type: OscillatorType = 'sine',
): number {
  const v = fmVoice(s.ctx, {
    freq,
    ratio,
    index,
    indexEnd,
    indexDecay: Math.max(0.03, env.d * 0.8),
    type,
  });
  v.out.connect(s.input);
  const end = ampEnv(v.amp, t, env);
  v.start(t);
  v.stop(end + 0.03);
  return end;
}

/** Karplus–Strong pluck — used for the felt-muted "chip on chip" ring. */
function pluck(s: Strip, t: number, freq: number, seconds: number, level: number, damping = 0.993): number {
  const buf = s.synth.pluck(freq, seconds, damping, 0.62);
  const src = s.ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = vary(1, 0.02);
  const g = s.ctx.createGain();
  g.gain.value = level;
  src.connect(g);
  g.connect(s.input);
  src.start(t);
  const end = t + seconds;
  src.onended = () => {
    try {
      src.disconnect();
      g.disconnect();
    } catch {
      /* torn down */
    }
  };
  return end;
}

/**
 * A single clay-chip impact: a 6 ms band-noise strike plus two inharmonic
 * partials that give it ceramic, not plastic, character.
 *
 * `light` drops the second partial and the shaping highpass. A pot push
 * fires sixty of these inside 1.2 s, and the difference between 8 nodes
 * and 4 nodes per chip is the difference between a smooth cascade and a
 * dropped frame on a three-year-old Android.
 */
function clay(s: Strip, t: number, level: number, bright = 1, light = false): number {
  const centre = vary(2150 * bright, 0.16);
  noise(
    s,
    t,
    light
      ? [{ type: 'bandpass', freq: centre, q: 2.4 }]
      : [
          { type: 'bandpass', freq: centre, q: 2.4 },
          { type: 'highpass', freq: 620 },
        ],
    { a: 0.0008, d: 0.011, r: 0.012, peak: 0.7 * level },
  );
  const p1 = vary(2380 * bright, 0.05);
  tone(s, t, 'sine', p1, p1 * 0.985, 0.03, { a: 0.0008, d: 0.028, r: 0.02, peak: 0.16 * level });
  if (!light) {
    tone(s, t + 0.0012, 'sine', p1 * 1.63, p1 * 1.6, 0.03, { a: 0.0008, d: 0.018, r: 0.014, peak: 0.09 * level });
  }
  return t + 0.06;
}

// ───────────────────────────── cards ─────────────────────────────

/**
 * The deal: a fast whisk of card stock across felt with a downward pitch
 * sweep. Deliberately quiet and dry — it should read as *close*, and it
 * fires up to nine times in two seconds so it can never be a feature.
 */
export function dealCard(pan = 0, speed = 1): void {
  const s = open({ bus: 'sfx', gain: 0.58, pan: clamp(pan, -0.7, 0.7), room: 0.07 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const rate = vary(1, 0.07) * speed;
  const end = noise(
    s,
    t,
    [
      { type: 'bandpass', freq: 2600, q: 1.05 },
      { type: 'highpass', freq: 460 },
    ],
    { a: 0.005, d: 0.062 / rate, r: 0.026, peak: 0.85 },
    { kind: 'white', sweep: [vary(3000, 0.12), vary(880, 0.12)], sweepSecs: 0.085 / rate },
  );
  // the card's edge catching the felt at the end of the throw
  noise(s, t + 0.05 / rate, [{ type: 'lowpass', freq: vary(700, 0.2), q: 0.9 }], {
    a: 0.002,
    d: 0.03,
    r: 0.02,
    peak: 0.3,
  });
  s.done(end + 0.05);
}

/** Card turning over and snapping flat: click, body, felt. */
export function cardFlip(pan = 0): void {
  const s = open({ bus: 'sfx', gain: 0.62, pan: clamp(pan, -0.6, 0.6), room: 0.12 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  noise(
    s,
    t,
    [
      { type: 'bandpass', freq: vary(3300, 0.12), q: 1.9 },
      { type: 'highpass', freq: 900 },
    ],
    { a: 0.0009, d: 0.018, r: 0.014, peak: 0.8 },
  );
  const body = vary(196, 0.08);
  tone(s, t, 'triangle', body, body * 0.6, 0.05, { a: 0.001, d: 0.045, r: 0.03, peak: 0.34 });
  const end = noise(s, t + 0.006, [{ type: 'lowpass', freq: vary(260, 0.18), q: 1.1 }], {
    a: 0.002,
    d: 0.055,
    r: 0.035,
    peak: 0.42,
  });
  s.done(end + 0.06);
}

/** Card sliding across felt — mucking, sliding a hand forward. */
export function cardSlide(pan = 0): void {
  const s = open({ bus: 'sfx', gain: 0.5, pan: clamp(pan, -0.6, 0.6), room: 0.06 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const end = noise(
    s,
    t,
    [
      { type: 'bandpass', freq: 820, q: 0.75 },
      { type: 'highpass', freq: 300 },
    ],
    { a: 0.03, d: 0.09, s: 0.5, hold: 0.04, r: 0.09, peak: 0.8 },
    { kind: 'pink', sweep: [vary(620, 0.15), vary(1250, 0.15)], sweepSecs: 0.16 },
  );
  s.done(end + 0.06);
}

/**
 * Riffle shuffle: ~24 micro-clicks whose spacing accelerates into the
 * middle of the riffle and decelerates out, with per-click jitter and a
 * final square-up tap on the table.
 */
export function riffleShuffle(level = 1): void {
  const s = open({ bus: 'sfx', gain: 1.0 * level, pan: rand(-0.12, 0.12), room: 0.16 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const n = detail(26, 20, 13);
  const span = rand(0.42, 0.52);
  let last = t;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    // ease-in-out spacing: dense in the middle of the riffle
    const shape = 0.35 + 1.35 * Math.abs(Math.cos(u * Math.PI));
    const step = (span / n) * shape * rand(0.72, 1.3);
    last += step;
    const amp = (0.28 + 0.55 * Math.sin(u * Math.PI)) * rand(0.7, 1.15);
    noise(
      s,
      last,
      [
        { type: 'bandpass', freq: rand(1500, 4300), q: rand(2.4, 5) },
        { type: 'highpass', freq: 700 },
      ],
      { a: 0.0006, d: rand(0.005, 0.011), r: 0.008, peak: amp },
    );
  }
  // the deck squared up against the felt
  const tap = last + rand(0.07, 0.11);
  noise(s, tap, [{ type: 'lowpass', freq: 420, q: 1.2 }], { a: 0.002, d: 0.05, r: 0.05, peak: 0.55 });
  noise(s, tap, [{ type: 'bandpass', freq: 2600, q: 2 }], { a: 0.0008, d: 0.012, r: 0.012, peak: 0.3 });
  const end = tap + 0.14;
  s.done(end);
}

// ───────────────────────────── chips ─────────────────────────────

/** One clay chip against another. The most-played sound in the app. */
export function chipClick(pan = 0, level = 1): void {
  const s = open({ bus: 'sfx', gain: 0.62 * level, pan: clamp(pan, -0.7, 0.7), room: 0.1 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const end = clay(s, t, 1, vary(1, 0.1));
  s.done(end + 0.04);
}

/** A short stack dropped: layered clicks landing on a low thud. */
export function chipStack(count = 4, pan = 0, level = 1): void {
  const s = open({ bus: 'sfx', gain: 1.05 * level, pan: clamp(pan, -0.6, 0.6), room: 0.14 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const n = clamp(Math.round(count), 2, detail(9, 7, 4));
  let at = t;
  for (let i = 0; i < n; i++) {
    // chips settle: intervals shorten as the stack finds the felt
    at += rand(0.011, 0.03) * (1 - i / (n + 2));
    clay(s, at, rand(0.55, 1) * (1 - i * 0.05), vary(1, 0.12));
  }
  const thud = vary(78, 0.1);
  tone(s, t + 0.004, 'sine', thud, thud * 0.72, 0.09, { a: 0.003, d: 0.09, r: 0.06, peak: 0.22 });
  noise(s, t + 0.004, [{ type: 'lowpass', freq: 300, q: 0.9 }], { a: 0.002, d: 0.06, r: 0.05, peak: 0.15 }, { kind: 'brown' });
  s.done(at + 0.24);
}

/**
 * Chips raked into the middle. Density and length scale with how much of
 * the pot is moving, so a min-raise and a pot-sized bet do not sound the same.
 */
export function chipsToPot(amount01 = 0.5, pan = 0): void {
  if (!claim('chipsToPot', 220)) return;
  const a = clamp(amount01, 0, 1);
  const s = open({ bus: 'sfx', gain: 0.66 + 0.26 * a, pan: clamp(pan, -0.5, 0.5), room: 0.2, hall: 0.06 * a });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const span = 0.24 + 0.28 * a;
  const n = Math.round(detail(16, 12, 8) * (0.6 + a));
  let at = t;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    at += (span / n) * rand(0.55, 1.5);
    clay(s, at, (0.35 + 0.5 * Math.sin(u * Math.PI)) * rand(0.7, 1.1), vary(1, 0.14), true);
  }
  // the slide of the whole mass across the felt underneath
  noise(
    s,
    t,
    [
      { type: 'bandpass', freq: 620, q: 0.7 },
      { type: 'highpass', freq: 180 },
    ],
    { a: 0.04, d: span * 0.7, s: 0.35, hold: span * 0.2, r: 0.14, peak: 0.4 + 0.25 * a },
    { kind: 'brown', sweep: [500, 900], sweepSecs: span },
  );
  s.done(at + 0.3);
}

/**
 * The pot pushed to a winner: a rolling 1.2 s cascade, wide and in the
 * hall. This is the payoff sound of the whole game — it gets the budget.
 */
export function potPush(amount01 = 1): void {
  if (!claim('potPush', 1400)) return;
  const a = clamp(amount01, 0.2, 1);
  const s = open({
    bus: 'sfx',
    gain: 0.62 + 0.2 * a,
    pan: 0,
    room: 0.22,
    hall: 0.16 + 0.2 * a,
    width: 1.3,
  });
  if (!s) return;
  mixer.duck(0.4 * a, 900);
  const t = s.t + LOOKAHEAD;
  const span = 1.05 + 0.25 * a;
  const n = Math.round(detail(52, 36, 20) * (0.55 + 0.45 * a));
  let at = t;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    // density envelope: builds, peaks a third of the way in, then scatters
    const density = 0.45 + 1.5 * Math.pow(Math.sin(Math.pow(u, 0.72) * Math.PI), 1.3);
    at += (span / n) * rand(0.4, 1.7) * Math.max(0.22, 1.75 - density);
    const amp = (0.25 + 0.6 * density) * rand(0.6, 1.15);
    clay(s, at, amp * 0.9, vary(1, 0.2), true);
    if (i % 7 === 3) {
      const thud = vary(66, 0.14);
      tone(s, at, 'sine', thud, thud * 0.68, 0.1, { a: 0.004, d: 0.1, r: 0.08, peak: 0.2 * a });
    }
  }
  // the mass of it
  noise(
    s,
    t,
    [
      { type: 'lowpass', freq: 340, q: 0.8 },
      { type: 'highpass', freq: 44 },
    ],
    { a: 0.09, d: span * 0.55, s: 0.4, hold: span * 0.25, r: 0.4, peak: 0.5 * a },
    { kind: 'brown', sweep: [220, 420], sweepSecs: span },
  );
  s.done(at + 0.9);
}

// ───────────────────────────── actions ─────────────────────────────

/** Two knuckles on the rail. Wood, not a beep. */
export function check(): void {
  const s = open({ bus: 'sfx', gain: 2.7, pan: rand(-0.16, 0.16), room: 0.18 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const rap = (at: number, tune: number, level: number) => {
    noise(
      s,
      at,
      [
        { type: 'bandpass', freq: vary(560 * tune, 0.06), q: 9 },
        { type: 'highpass', freq: 190 },
      ],
      { a: 0.0009, d: 0.055, r: 0.05, peak: 0.85 * level },
    );
    noise(s, at, [{ type: 'bandpass', freq: vary(1240 * tune, 0.08), q: 6 }], {
      a: 0.0008,
      d: 0.03,
      r: 0.026,
      peak: 0.42 * level,
    });
    // the rail itself moving — this is the part you feel
    noise(s, at, [{ type: 'lowpass', freq: vary(240, 0.12), q: 1.2 }], {
      a: 0.002,
      d: 0.05,
      r: 0.04,
      peak: 0.3 * level,
    });
    noise(s, at, [{ type: 'bandpass', freq: vary(3400, 0.1), q: 1.4 }], {
      a: 0.0006,
      d: 0.006,
      r: 0.006,
      peak: 0.12 * level,
    });
  };
  rap(t, 1, 1);
  const second = t + rand(0.096, 0.132);
  rap(second, vary(1.03, 0.02), 0.82);
  s.done(second + 0.2);
}

/** Cards pushed away. Resigned, soft, slightly off to one side. */
export function fold(): void {
  const s = open({ bus: 'sfx', gain: 0.5, pan: rand(-0.35, -0.12), room: 0.08 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const end = noise(
    s,
    t,
    [
      { type: 'lowpass', freq: 1900, q: 0.8 },
      { type: 'highpass', freq: 220 },
    ],
    { a: 0.025, d: 0.16, s: 0.3, hold: 0.03, r: 0.11, peak: 0.75 },
    { kind: 'pink', sweep: [vary(1900, 0.15), vary(430, 0.15)], sweepSecs: 0.26 },
  );
  noise(s, t + 0.16, [{ type: 'lowpass', freq: 300, q: 1 }], { a: 0.004, d: 0.05, r: 0.05, peak: 0.24 });
  s.done(end + 0.1);
}

/**
 * Bet / raise confirmation: a felt-damped "thock" with a pitched body.
 * `size01` is the bet relative to the pot — bigger bets get lower, longer
 * bodies and a sub underneath, so sizing is audible before you read it.
 */
export function betConfirm(size01 = 0.4): void {
  const z = clamp(size01, 0, 1);
  const s = open({ bus: 'sfx', gain: 0.62 + 0.2 * z, pan: rand(-0.1, 0.1), room: 0.12 + 0.12 * z, hall: 0.1 * z });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const body = vary(178 - 62 * z, 0.05);
  tone(s, t, 'triangle', body * 1.7, body, 0.055 + 0.05 * z, {
    a: 0.0015,
    d: 0.075 + 0.09 * z,
    r: 0.06,
    peak: 0.4,
  });
  // the wooden knock of the strike — this is what carries on a phone
  noise(s, t, [{ type: 'bandpass', freq: vary(760, 0.12), q: 1.1 }], { a: 0.0009, d: 0.032, r: 0.026, peak: 0.85 });
  noise(s, t, [{ type: 'bandpass', freq: vary(1900, 0.12), q: 1.6 }], { a: 0.0007, d: 0.016, r: 0.014, peak: 0.5 });
  noise(s, t, [{ type: 'bandpass', freq: vary(3400, 0.1), q: 2 }], { a: 0.0006, d: 0.009, r: 0.009, peak: 0.3 });
  if (z > 0.42) {
    const sub = vary(52, 0.06);
    tone(s, t + 0.004, 'sine', sub * 1.3, sub, 0.09, { a: 0.005, d: 0.18 + 0.2 * z, r: 0.12, peak: 0.18 * z });
  }
  chipStackInline(s, t + 0.028, Math.round(2 + z * 5));
  s.done(t + 0.6);
}

/** Chips layered into an existing strip — keeps a bet to one voice slot. */
function chipStackInline(s: Strip, t: number, count: number): void {
  const n = clamp(count, 2, detail(8, 6, 3));
  let at = t;
  for (let i = 0; i < n; i++) {
    at += rand(0.012, 0.032) * (1 - i / (n + 3));
    clay(s, at, rand(0.35, 0.7), vary(1, 0.12), true);
  }
}

/**
 * All-in: a sub swell that arrives before you consciously hear it, a
 * metallic inharmonic shimmer, and two heartbeats. Ducks the score hard.
 */
export function allIn(): void {
  if (!claim('allIn', 1600)) return;
  const s = open({ bus: 'sfx', gain: 0.8, pan: 0, room: 0.16, hall: 0.5, width: 1.45 });
  if (!s) return;
  mixer.duck(0.85, 1600);
  const t = s.t + LOOKAHEAD;

  // sub swell — rises through the whole cue
  const sub = vary(27, 0.04);
  tone(s, t, 'sine', sub, sub * 1.42, 0.95, { a: 0.28, d: 0.5, s: 0.75, hold: 0.28, r: 0.5, peak: 0.4 });
  // two octaves of the swell, so the dread is audible and not only felt
  tone(s, t + 0.02, 'triangle', sub * 2, sub * 2.84, 0.95, { a: 0.34, d: 0.5, s: 0.6, hold: 0.2, r: 0.45, peak: 0.16 });
  tone(s, t + 0.04, 'triangle', sub * 4, sub * 5.68, 0.95, { a: 0.42, d: 0.5, s: 0.5, hold: 0.16, r: 0.5, peak: 0.07 });

  // metallic shimmer: inharmonic FM partials, slow bloom
  const base = vary(880, 0.02);
  const partials = detail(5, 4, 2);
  for (let i = 0; i < partials; i++) {
    const f = base * (1 + i * 0.618) * vary(1, 0.01);
    bell(
      s,
      t + 0.06 + i * rand(0.03, 0.09),
      f,
      { a: 0.14 + i * 0.05, d: 0.7, s: 0.28, hold: 0.2, r: 0.9, peak: 0.34 / (1 + i * 0.45) },
      3.51,
      1.5,
      0.06,
    );
  }

  // heartbeat
  const beat = (at: number, level: number) => {
    const f = vary(56, 0.05);
    tone(s, at, 'sine', f * 1.5, f * 0.72, 0.1, { a: 0.006, d: 0.13, r: 0.09, peak: level * 0.7 });
    noise(s, at, [{ type: 'lowpass', freq: 190, q: 1.1 }], { a: 0.003, d: 0.07, r: 0.05, peak: level * 0.3 }, { kind: 'brown' });
    // the chest of it — a muffled mid thump so the pulse reads on any speaker
    noise(s, at, [{ type: 'bandpass', freq: vary(620, 0.1), q: 1.3 }], { a: 0.003, d: 0.06, r: 0.05, peak: level * 0.34 });
  };
  beat(t + 0.05, 0.62);
  beat(t + 0.44, 0.5);
  beat(t + 0.98, 0.4);

  // the rail hit
  noise(s, t + 0.02, [{ type: 'bandpass', freq: 2400, q: 1.4 }], { a: 0.002, d: 0.05, r: 0.06, peak: 0.55 });
  s.done(t + 2.6);
}

// ───────────────────────────── clock ─────────────────────────────

/** Escalating clock tick. `urgency` 0 → calm, 1 → about to be folded. */
export function timerTick(urgency = 0): void {
  const u = clamp(urgency, 0, 1);
  const s = open({ bus: 'ui', gain: 0.18 + 0.46 * u, pan: 0, room: 0.05 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const f = vary(720 + 640 * u * u, 0.012);
  tone(s, t, 'triangle', f, f * (1 - 0.06 * u), 0.03, { a: 0.0012, d: 0.026 + 0.02 * (1 - u), r: 0.03, peak: 0.55 });
  noise(s, t, [{ type: 'bandpass', freq: f * 2.4, q: 3 }], { a: 0.0006, d: 0.006, r: 0.008, peak: 0.22 + 0.2 * u });
  if (u > 0.72) {
    tone(s, t + 0.006, 'triangle', f * 1.4983, f * 1.48, 0.03, { a: 0.0012, d: 0.022, r: 0.024, peak: 0.28 });
  }
  s.done(t + 0.14);
}

/** Clock expired. Unpleasant on purpose, but short and not shrill. */
export function timeoutBuzz(): void {
  const s = open({ bus: 'sfx', gain: 0.72, pan: 0, room: 0.1 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const f = vary(196, 0.02);
  for (const d of [-9, 9]) {
    tone(s, t, 'sawtooth', f, f * 0.94, 0.42, { a: 0.006, d: 0.1, s: 0.7, hold: 0.2, r: 0.16, peak: 0.3 }, d);
  }
  // amplitude flutter via a second, detuned layer beating against the first
  tone(s, t, 'square', f * 2.006, f * 1.88, 0.42, { a: 0.01, d: 0.12, s: 0.5, hold: 0.16, r: 0.14, peak: 0.1 });
  noise(s, t, [{ type: 'bandpass', freq: 700, q: 1.6 }], { a: 0.004, d: 0.14, s: 0.4, hold: 0.14, r: 0.16, peak: 0.22 });
  s.done(t + 0.9);
}

/** Hero is on the clock: a warm two-note rise, close and unmistakable. */
export function yourTurn(): void {
  const s = open({ bus: 'sfx', gain: 0.92, pan: 0, room: 0.28, hall: 0.08, width: 1.15 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const root = vary(392, 0.004);
  bell(s, t, root, { a: 0.006, d: 0.3, s: 0.16, hold: 0.05, r: 0.3, peak: 0.42 }, 1, 1.5, 0.08);
  bell(s, t + 0.085, semi(root, 7), { a: 0.005, d: 0.36, s: 0.14, hold: 0.06, r: 0.42, peak: 0.36 }, 1, 1.2, 0.06);
  tone(s, t, 'sine', root / 4, root / 4, 0, { a: 0.02, d: 0.3, r: 0.2, peak: 0.16 });
  s.done(t + 1);
}

// ───────────────────────────── outcomes ─────────────────────────────

const MAJ_PENT = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

/** A modest pot. Warm, close, over quickly — you will hear this a lot. */
export function winSmall(): void {
  if (!claim('win', 700)) return;
  const s = open({ bus: 'sfx', gain: 0.98, pan: 0, room: 0.32, hall: 0.12, width: 1.2 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const root = vary(329.63, 0.003);
  const steps = [0, 4, 7];
  steps.forEach((st, i) => {
    bell(
      s,
      t + i * rand(0.062, 0.086),
      semi(root, st),
      { a: 0.005, d: 0.26 + i * 0.06, s: 0.14, hold: 0.04, r: 0.36, peak: 0.4 - i * 0.05 },
      1,
      1.9,
      0.09,
    );
  });
  tone(s, t, 'sine', root / 4, root / 4, 0, { a: 0.02, d: 0.35, r: 0.24, peak: 0.2 });
  s.done(t + 1.4);
}

/** A big pot. Wide, in the hall, with a sub and a shimmer tail. */
export function winBig(scale = 1): void {
  if (!claim('win', 1200)) return;
  const k = clamp(scale, 0.5, 1.6);
  const s = open({ bus: 'sfx', gain: 0.85, pan: 0, room: 0.24, hall: 0.5, width: 1.45 });
  if (!s) return;
  mixer.duck(0.8, 1700);
  const t = s.t + LOOKAHEAD;
  const root = vary(261.63, 0.002);
  const seq = [0, 4, 7, 11, 12, 16];
  seq.forEach((st, i) => {
    const at = t + i * rand(0.055, 0.078);
    bell(
      s,
      at,
      semi(root, st) * (i > 3 ? 2 : 1),
      { a: 0.004, d: 0.3 + i * 0.05, s: 0.18, hold: 0.06, r: 0.55 + i * 0.06, peak: (0.34 - i * 0.028) * k },
      1,
      2.3,
      0.1,
    );
  });
  // sub arrival
  const sub = root / 4;
  tone(s, t, 'sine', sub * 0.75, sub, 0.16, { a: 0.012, d: 0.5, s: 0.4, hold: 0.2, r: 0.5, peak: 0.26 * k });
  // shimmer swell
  noise(
    s,
    t + 0.04,
    [
      { type: 'bandpass', freq: 4200, q: 0.9 },
      { type: 'highpass', freq: 2400 },
    ],
    { a: 0.2, d: 0.5, s: 0.3, hold: 0.1, r: 0.7, peak: 0.16 * k },
    { kind: 'pink', sweep: [2800, 7200], sweepSecs: 0.8 },
  );
  // the chip cascade lands underneath
  chipStackInline(s, t + 0.1, 6);
  s.done(t + 2.6);
}

/** Bad beat: a detuned pair falling a tritone, hollow and lowpassed. */
export function badBeat(): void {
  if (!claim('win', 2000)) return;
  const s = open({ bus: 'sfx', gain: 0.62, pan: 0, room: 0.2, hall: 0.36, width: 1.25 });
  if (!s) return;
  mixer.duck(0.75, 1500);
  const t = s.t + LOOKAHEAD;
  const root = vary(220, 0.004);

  const lp = s.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1700, t);
  lp.frequency.exponentialRampToValueAtTime(320, t + 1.1);
  lp.Q.value = 1.6;
  lp.connect(s.input);
  const inner: Strip = { ...s, input: lp };

  for (const cents of [-16, 17]) {
    const osc = s.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.detune.value = cents;
    osc.frequency.setValueAtTime(root, t);
    osc.frequency.exponentialRampToValueAtTime(root * Math.pow(2, -6 / 12), t + 1.05);
    const g = s.ctx.createGain();
    osc.connect(g);
    g.connect(lp);
    const end = ampEnv(g.gain, t, { a: 0.02, d: 0.4, s: 0.55, hold: 0.3, r: 0.5, peak: 0.28 });
    osc.start(t);
    osc.stop(end + 0.03);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* torn down */
      }
    };
  }
  // a hollow bell on the way down — a fifth, then nothing
  bell(inner, t, root * 2, { a: 0.004, d: 0.5, s: 0.1, hold: 0.05, r: 0.7, peak: 0.22 }, 2.01, 3.2, 0.2);
  tone(s, t + 0.02, 'sine', root / 2, root / 2.83, 1.0, { a: 0.04, d: 0.5, s: 0.4, hold: 0.2, r: 0.6, peak: 0.3 });
  noise(s, t, [{ type: 'lowpass', freq: 600, q: 0.8 }], { a: 0.3, d: 0.4, s: 0.3, r: 0.6, peak: 0.12 }, { kind: 'brown' });
  s.done(t + 2.6);
  window.setTimeout(() => {
    try {
      lp.disconnect();
    } catch {
      /* torn down */
    }
  }, 3000);
}

// ───────────────────────────── UI ─────────────────────────────

/** Primary button. A damped thock with a pitched tail — feels like a key. */
export function tapPrimary(): void {
  const s = open({ bus: 'ui', gain: 0.55, pan: 0 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  noise(s, t, [{ type: 'lowpass', freq: vary(1400, 0.1), q: 1.3 }], { a: 0.0007, d: 0.016, r: 0.016, peak: 0.6 });
  const f = vary(520, 0.03);
  tone(s, t, 'sine', f, f * 0.68, 0.05, { a: 0.0012, d: 0.05, r: 0.04, peak: 0.36 });
  tone(s, t + 0.002, 'sine', f * 0.5, f * 0.42, 0.06, { a: 0.002, d: 0.06, r: 0.05, peak: 0.2 });
  s.done(t + 0.2);
}

/** Secondary / list row. Just the transient. */
export function tapSecondary(): void {
  const s = open({ bus: 'ui', gain: 0.58, pan: 0 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  noise(s, t, [{ type: 'bandpass', freq: vary(2500, 0.14), q: 2.6 }], { a: 0.0006, d: 0.01, r: 0.011, peak: 0.55 });
  const f = vary(760, 0.04);
  tone(s, t, 'sine', f, f * 0.8, 0.026, { a: 0.001, d: 0.024, r: 0.02, peak: 0.16 });
  s.done(t + 0.12);
}

/** Toggle. Two-tone, direction encodes the new state. */
export function tapToggle(on: boolean): void {
  const s = open({ bus: 'ui', gain: 0.44, pan: 0 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const a = on ? vary(620, 0.02) : vary(880, 0.02);
  const b = on ? a * 1.335 : a * 0.749;
  tone(s, t, 'triangle', a, a, 0, { a: 0.0012, d: 0.03, r: 0.025, peak: 0.34 });
  tone(s, t + 0.048, 'triangle', b, b, 0, { a: 0.0012, d: 0.05, r: 0.045, peak: 0.3 });
  noise(s, t, [{ type: 'highpass', freq: 3000 }], { a: 0.0005, d: 0.006, r: 0.006, peak: 0.2 });
  s.done(t + 0.22);
}

/** Rejected input. A short, dull double-buzz — never a shrill beep. */
export function tapError(): void {
  const s = open({ bus: 'ui', gain: 0.5, pan: 0 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const buzz = (at: number, f: number, peak: number) => {
    tone(s, at, 'square', f, f * 0.96, 0.08, { a: 0.002, d: 0.05, s: 0.4, hold: 0.02, r: 0.05, peak });
    tone(s, at, 'sawtooth', f * 1.059, f * 1.02, 0.08, { a: 0.002, d: 0.05, r: 0.05, peak: peak * 0.5 });
  };
  buzz(t, vary(174, 0.02), 0.26);
  buzz(t + 0.105, vary(164, 0.02), 0.22);
  noise(s, t, [{ type: 'lowpass', freq: 900, q: 1 }], { a: 0.002, d: 0.04, r: 0.04, peak: 0.2 });
  s.done(t + 0.4);
}

/** Sheet rising into place: airy sweep up, soft landing. */
export function sheetOpen(): void {
  const s = open({ bus: 'ui', gain: 0.5, pan: 0, room: 0.12 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  noise(
    s,
    t,
    [
      { type: 'bandpass', freq: 400, q: 0.85 },
      { type: 'highpass', freq: 200 },
    ],
    { a: 0.07, d: 0.14, s: 0.35, r: 0.1, peak: 0.34 },
    { kind: 'pink', sweep: [340, 2400], sweepSecs: 0.24 },
  );
  tone(s, t + 0.2, 'sine', vary(132, 0.03), vary(96, 0.03), 0.09, { a: 0.004, d: 0.1, r: 0.07, peak: 0.3 });
  s.done(t + 0.55);
}

/** Sheet dropping away. */
export function sheetClose(): void {
  const s = open({ bus: 'ui', gain: 1.6, pan: 0, room: 0.08 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  noise(
    s,
    t,
    [
      { type: 'bandpass', freq: 2000, q: 0.9 },
      { type: 'highpass', freq: 180 },
    ],
    { a: 0.012, d: 0.15, s: 0.25, r: 0.08, peak: 0.32 },
    { kind: 'pink', sweep: [2100, 300], sweepSecs: 0.2 },
  );
  noise(s, t + 0.17, [{ type: 'lowpass', freq: 420, q: 1.2 }], { a: 0.002, d: 0.05, r: 0.04, peak: 0.26 });
  s.done(t + 0.4);
}

/** Tab / segmented control. `dir` −1 left, +1 right. */
export function tabSwitch(dir = 1): void {
  const s = open({ bus: 'ui', gain: 0.36, pan: clamp(dir * 0.12, -0.2, 0.2) });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const f = vary(700 + dir * 110, 0.02);
  noise(s, t, [{ type: 'bandpass', freq: 3200, q: 3 }], { a: 0.0005, d: 0.007, r: 0.008, peak: 0.4 });
  tone(s, t, 'triangle', f, f * (1 + dir * 0.06), 0.03, { a: 0.001, d: 0.032, r: 0.028, peak: 0.28 });
  s.done(t + 0.14);
}

export type ToastTone = 'info' | 'good' | 'bad' | 'epic';

/** Notification. Tone maps to interval: rising for good, falling for bad. */
export function toast(tone_: ToastTone = 'info'): void {
  const s = open({ bus: 'ui', gain: 0.5, pan: 0, room: 0.24, hall: tone_ === 'epic' ? 0.22 : 0 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const root = vary(587.33, 0.003);
  const seqs: Record<ToastTone, number[]> = {
    info: [0, 5],
    good: [0, 7],
    bad: [3, -1],
    epic: [0, 7, 12],
  };
  const seq = seqs[tone_];
  seq.forEach((st, i) => {
    bell(
      s,
      t + i * 0.075,
      semi(root, st) * (tone_ === 'bad' ? 0.5 : 1),
      { a: 0.004, d: 0.2 + i * 0.06, s: 0.1, r: 0.28, peak: 0.3 - i * 0.04 },
      tone_ === 'bad' ? 2.02 : 1,
      tone_ === 'bad' ? 2.6 : 1.6,
      0.08,
    );
  });
  if (tone_ === 'epic') {
    noise(
      s,
      t + 0.05,
      [{ type: 'bandpass', freq: 5200, q: 1.1 }],
      { a: 0.12, d: 0.3, s: 0.2, r: 0.4, peak: 0.1 },
      { kind: 'pink', sweep: [3400, 7600], sweepSecs: 0.5 },
    );
  }
  s.done(t + 1.1);
}

// ───────────────────────────── rewards ─────────────────────────────

const RARITY_SCALE: Record<Rarity, number> = {
  common: 0.6,
  rare: 0.78,
  epic: 0.95,
  legendary: 1.15,
  mythic: 1.3,
};

/** Cosmetic unlock: a rising pentatonic run, a gold chord, a shimmer tail. */
export function unlockCosmetic(rarity: Rarity = 'rare'): void {
  const k = RARITY_SCALE[rarity] ?? 0.8;
  const s = open({ bus: 'sfx', gain: 0.62 * k, pan: 0, room: 0.22, hall: 0.34 * k, width: 1.35 });
  if (!s) return;
  mixer.duck(0.5 * k, 1300);
  const t = s.t + LOOKAHEAD;
  const root = vary(392, 0.002);
  const n = k > 1 ? 6 : 5;
  for (let i = 0; i < n; i++) {
    bell(
      s,
      t + i * rand(0.055, 0.072),
      semi(root, MAJ_PENT[i]),
      { a: 0.004, d: 0.22 + i * 0.05, s: 0.12, r: 0.35 + i * 0.05, peak: 0.3 - i * 0.025 },
      1,
      2.1,
      0.09,
    );
  }
  // a plucked-string ghost under the run — gives the gold some grain
  for (let i = 0; i < n; i += 2) {
    pluck(s, t + i * 0.066 + 0.004, semi(root, MAJ_PENT[i]) * 2, 0.5, 0.09 * k, 0.9915);
  }
  // the chord it lands on
  const land = t + n * 0.065 + 0.03;
  for (const st of [0, 7, 12, 16]) {
    bell(s, land, semi(root, st), { a: 0.008, d: 0.6, s: 0.22, hold: 0.1, r: 0.9, peak: 0.16 * k }, 1, 1.5, 0.06);
  }
  tone(s, land, 'sine', root / 4, root / 4, 0, { a: 0.02, d: 0.5, s: 0.3, r: 0.6, peak: 0.32 * k });
  noise(
    s,
    t,
    [{ type: 'bandpass', freq: 5000, q: 0.9 }],
    { a: 0.28, d: 0.5, s: 0.25, hold: 0.1, r: 0.8, peak: 0.14 * k },
    { kind: 'pink', sweep: [2600, 8400], sweepSecs: 1 },
  );
  s.done(land + 2.2);
}

/** Battle-pass tier: three-note brass-ish fanfare over a sub. */
export function passTierUp(): void {
  const s = open({ bus: 'sfx', gain: 0.72, pan: 0, room: 0.2, hall: 0.34, width: 1.3 });
  if (!s) return;
  mixer.duck(0.6, 1400);
  const t = s.t + LOOKAHEAD;
  const root = vary(293.66, 0.002);
  [0, 7, 12].forEach((st, i) => {
    const at = t + i * 0.11;
    bell(s, at, semi(root, st), { a: 0.01, d: 0.18, s: 0.5, hold: 0.09, r: 0.4, peak: 0.3 }, 1, 3.4, 0.5, 'triangle');
    bell(s, at, semi(root, st) * 2, { a: 0.014, d: 0.2, s: 0.3, hold: 0.06, r: 0.3, peak: 0.12 }, 2, 1.8, 0.1);
  });
  tone(s, t, 'sine', root / 4, root / 4, 0, { a: 0.015, d: 0.45, s: 0.4, hold: 0.2, r: 0.5, peak: 0.42 });
  chipStackInline(s, t + 0.3, 4);
  s.done(t + 2.2);
}

/** Level up: bigger, with an ascending run into a stacked chord. */
export function levelUp(): void {
  if (!claim('ceremony', 2200)) return;
  const s = open({ bus: 'sfx', gain: 0.8, pan: 0, room: 0.22, hall: 0.42, width: 1.4 });
  if (!s) return;
  mixer.duck(0.75, 1800);
  const t = s.t + LOOKAHEAD;
  const root = vary(261.63, 0.002);
  [0, 4, 7, 12].forEach((st, i) => {
    bell(
      s,
      t + i * 0.075,
      semi(root, st),
      { a: 0.005, d: 0.2, s: 0.25, hold: 0.04, r: 0.4, peak: 0.3 - i * 0.02 },
      1,
      2.6,
      0.12,
    );
  });
  const land = t + 0.34;
  for (const st of [0, 7, 12, 16, 19]) {
    bell(s, land, semi(root, st), { a: 0.01, d: 0.7, s: 0.25, hold: 0.14, r: 1.1, peak: 0.15 }, 1, 1.7, 0.07);
  }
  tone(s, land, 'sine', root / 4, root / 2, 0.3, { a: 0.02, d: 0.6, s: 0.4, hold: 0.25, r: 0.7, peak: 0.5 });
  noise(
    s,
    land - 0.2,
    [{ type: 'bandpass', freq: 5600, q: 0.85 }],
    { a: 0.3, d: 0.6, s: 0.25, hold: 0.14, r: 0.9, peak: 0.16 },
    { kind: 'pink', sweep: [3000, 9000], sweepSecs: 1.2 },
  );
  s.done(land + 2.6);
}

// ───────────────────────────── social ─────────────────────────────

const REACTION_PITCH: Record<ReactionKind, number> = {
  fire: 780,
  skull: 320,
  clown: 900,
  money: 660,
  shock: 1050,
  clap: 560,
  cold: 1180,
  heart: 700,
  laugh: 840,
  eyes: 980,
};

/** Emote pop. Pitched to the emote so a busy table reads as a chord, not a mess. */
export function reactionPop(kind: ReactionKind = 'fire', pan = rand(-0.45, 0.45)): void {
  const s = open({ bus: 'ui', gain: 0.3, pan: clamp(pan, -0.6, 0.6), room: 0.14 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const f = vary(REACTION_PITCH[kind] ?? 700, 0.03);
  // the pop: a fast upward pitch bloom, gone in 90 ms
  tone(s, t, 'sine', f * 0.42, f, 0.026, { a: 0.0015, d: 0.05, r: 0.035, peak: 0.42 });
  tone(s, t + 0.004, 'triangle', f * 0.84, f * 2, 0.03, { a: 0.002, d: 0.035, r: 0.03, peak: 0.14 });
  noise(s, t, [{ type: 'bandpass', freq: f * 3, q: 2.2 }], { a: 0.0005, d: 0.008, r: 0.008, peak: 0.2 });
  s.done(t + 0.2);
}

// ───────────────────────────── trainer ─────────────────────────────

/** Correct: a clean major interval. Higher score → wider, brighter interval. */
export function trainerCorrect(score = 1): void {
  const k = clamp(score, 0, 1);
  const s = open({ bus: 'sfx', gain: 0.72, pan: 0, room: 0.26, hall: 0.1 * k, width: 1.15 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const root = vary(523.25, 0.002);
  const top = k > 0.94 ? 12 : k > 0.8 ? 7 : 4;
  bell(s, t, root, { a: 0.003, d: 0.24, s: 0.12, r: 0.3, peak: 0.34 }, 1, 1.8, 0.07);
  bell(s, t + 0.045, semi(root, top), { a: 0.003, d: 0.3, s: 0.12, r: 0.4, peak: 0.3 }, 1, 1.5, 0.06);
  tone(s, t, 'sine', root / 4, root / 4, 0, { a: 0.012, d: 0.24, r: 0.2, peak: 0.14 });
  s.done(t + 0.9);
}

/** Incorrect: a muted minor second, lowpassed so it lands as a shrug, not a slap. */
export function trainerIncorrect(): void {
  const s = open({ bus: 'sfx', gain: 0.4, pan: 0, room: 0.14 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const root = vary(311.13, 0.003);
  const lp = s.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 980;
  lp.Q.value = 0.9;
  lp.connect(s.input);
  const inner: Strip = { ...s, input: lp };
  bell(inner, t, root, { a: 0.004, d: 0.2, s: 0.1, r: 0.26, peak: 0.4 }, 1.99, 2.4, 0.15);
  bell(inner, t + 0.03, semi(root, 1), { a: 0.004, d: 0.22, s: 0.1, r: 0.3, peak: 0.32 }, 1.99, 2.2, 0.14);
  tone(s, t, 'sine', root / 4, root / 4.6, 0.3, { a: 0.01, d: 0.26, r: 0.24, peak: 0.2 });
  s.done(t + 0.9);
  window.setTimeout(() => {
    try {
      lp.disconnect();
    } catch {
      /* torn down */
    }
  }, 1400);
}

/** Streak milestone. Length and brightness scale with the streak. */
export function streakMilestone(streak = 5): void {
  const k = clamp(streak / 20, 0.3, 1);
  const s = open({ bus: 'sfx', gain: 0.6, pan: 0, room: 0.24, hall: 0.24 * k, width: 1.25 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const root = vary(440, 0.002);
  const n = 3 + Math.round(k * 2);
  for (let i = 0; i < n; i++) {
    bell(
      s,
      t + i * 0.058,
      semi(root, MAJ_PENT[i]),
      { a: 0.003, d: 0.2 + i * 0.05, s: 0.12, r: 0.3 + i * 0.05, peak: 0.28 - i * 0.03 },
      1,
      2,
      0.08,
    );
  }
  noise(
    s,
    t,
    [{ type: 'bandpass', freq: 5400, q: 1 }],
    { a: 0.16, d: 0.3, s: 0.2, r: 0.4, peak: 0.1 * k },
    { kind: 'pink', sweep: [3200, 7800], sweepSecs: 0.6 },
  );
  s.done(t + 1.4);
}

// ───────────────────────────── impacts ─────────────────────────────

/** A dark, room-shaking boom — bomb pots and the SNG bubble. */
export function boom(scale = 1): void {
  if (!claim('ceremony', 1400)) return;
  const k = clamp(scale, 0.4, 1.4);
  const s = open({ bus: 'sfx', gain: 0.85, pan: 0, room: 0.2, hall: 0.45, width: 1.4 });
  if (!s) return;
  mixer.duck(0.9, 1200);
  const t = s.t + LOOKAHEAD;
  const f = vary(58, 0.06);
  tone(s, t, 'sine', f * 2.6, f * 0.62, 0.42, { a: 0.004, d: 0.45, s: 0.3, hold: 0.1, r: 0.6, peak: 0.9 * k });
  tone(s, t, 'triangle', f * 1.5, f * 0.9, 0.3, { a: 0.006, d: 0.3, r: 0.4, peak: 0.28 * k });
  noise(
    s,
    t,
    [
      { type: 'lowpass', freq: 900, q: 1.1 },
      { type: 'highpass', freq: 40 },
    ],
    { a: 0.003, d: 0.35, s: 0.2, r: 0.7, peak: 0.55 * k },
    { kind: 'brown', sweep: [1400, 160], sweepSecs: 0.7 },
  );
  noise(s, t, [{ type: 'bandpass', freq: 1500, q: 0.9 }], { a: 0.001, d: 0.07, r: 0.12, peak: 0.5 * k });
  noise(s, t, [{ type: 'bandpass', freq: 3600, q: 1.2 }], { a: 0.001, d: 0.035, r: 0.06, peak: 0.26 * k });
  s.done(t + 2.4);
}

/** A royal-flush-grade ceremonial chord. Rare on purpose. */
export function fanfareRoyal(): void {
  if (!claim('ceremony', 3000)) return;
  const s = open({ bus: 'sfx', gain: 0.85, pan: 0, room: 0.22, hall: 0.55, width: 1.5 });
  if (!s) return;
  mixer.duck(0.9, 2400);
  const t = s.t + LOOKAHEAD;
  const root = vary(196, 0.002);
  [0, 7, 12, 16, 19, 24].forEach((st, i) => {
    bell(
      s,
      t + i * 0.045,
      semi(root, st),
      { a: 0.006, d: 0.35, s: 0.34, hold: 0.4, r: 1.5, peak: 0.24 - i * 0.02 },
      1,
      2.4,
      0.12,
    );
  });
  tone(s, t, 'sine', root / 2, root / 2, 0, { a: 0.03, d: 0.6, s: 0.5, hold: 0.5, r: 1.1, peak: 0.55 });
  // struck strings on the top of the chord
  [12, 19, 24].forEach((st, i) => pluck(s, t + 0.02 + i * 0.05, semi(root, st) * 2, 0.9, 0.12, 0.9962));
  noise(
    s,
    t,
    [{ type: 'bandpass', freq: 6000, q: 0.8 }],
    { a: 0.5, d: 0.7, s: 0.3, hold: 0.3, r: 1.4, peak: 0.16 },
    { kind: 'pink', sweep: [2400, 9200], sweepSecs: 1.8 },
  );
  s.done(t + 4);
}

/** Camera-shake companion: a felt, not-quite-heard low rumble. */
export function rumble(amount = 0.5, ms = 300): void {
  const k = clamp(amount, 0, 1);
  const s = open({ bus: 'sfx', gain: 0.55 * k, pan: 0, room: 0.1 });
  if (!s) return;
  const t = s.t + LOOKAHEAD;
  const secs = clamp(ms, 80, 1200) / 1000;
  noise(
    s,
    t,
    [
      { type: 'lowpass', freq: 150, q: 1.2 },
      { type: 'highpass', freq: 32 },
    ],
    { a: 0.012, d: secs * 0.4, s: 0.5, hold: secs * 0.3, r: secs * 0.5, peak: 0.9 },
    { kind: 'brown' },
  );
  s.done(t + secs * 2);
}

/** Maps an `fx:burst` to its sound. */
export function impact(kind: FxBurstKind, scale = 1): void {
  switch (kind) {
    case 'chips-win':
      potPush(clamp(scale, 0.3, 1));
      break;
    case 'chips-push':
      chipsToPot(clamp(scale, 0.2, 1));
      break;
    case 'card-flip':
      cardFlip();
      break;
    case 'allin':
      allIn();
      break;
    case 'bomb':
      boom(scale);
      break;
    case 'royal':
      fanfareRoyal();
      break;
    case 'quads':
      winBig(1.2);
      break;
    case 'confetti':
      streakMilestone(14);
      break;
    case 'level-up':
      levelUp();
      break;
    case 'unlock':
      unlockCosmetic('epic');
      break;
    default:
      break;
  }
}

// ───────────────────────────── ambience ─────────────────────────────

interface Ambience {
  gain: GainNode;
  nodes: AudioNode[];
  osc: OscillatorNode[];
  src: AudioBufferSourceNode[];
}

let ambience: Ambience | null = null;
let ambienceWanted = false;

/**
 * Card-room presence: a very low noise floor with slow spectral drift.
 * You should never notice it playing — only notice the room go dead when
 * it stops.
 */
export function setAmbience(on: boolean): void {
  ambienceWanted = on;
  if (!mixer.live) return;
  if (on && !ambience) startAmbience();
  else if (!on && ambience) stopAmbience();
}

function startAmbience(): void {
  const bus = mixer.busInput('ambience');
  const synth = mixer.synth;
  const ctx = mixer.ctx;
  if (!bus || !synth || !ctx) return;

  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  gain.connect(bus);

  const src = synth.noiseSource('brown', 1, true);
  const bp = ctx.createBiquadFilter();
  bp.type = 'lowpass';
  bp.frequency.value = 420;
  bp.Q.value = 0.7;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 60;

  // slow spectral drift so the floor breathes
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.043;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 150;
  lfo.connect(lfoAmt);
  lfoAmt.connect(bp.frequency);

  // a second, slower amplitude drift
  const alfo = ctx.createOscillator();
  alfo.type = 'sine';
  alfo.frequency.value = 0.027;
  const alfoAmt = ctx.createGain();
  alfoAmt.gain.value = 0.22;
  alfo.connect(alfoAmt);
  alfoAmt.connect(gain.gain);

  src.connect(bp);
  bp.connect(hp);
  hp.connect(gain);

  const t = ctx.currentTime;
  src.start(t, arng.range(0, 2));
  lfo.start(t);
  alfo.start(t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.62, t + 2.2);

  ambience = { gain, nodes: [bp, hp, lfoAmt, alfoAmt], osc: [lfo, alfo], src: [src] };
}

function stopAmbience(): void {
  const amb = ambience;
  const ctx = mixer.ctx;
  if (!amb || !ctx) return;
  ambience = null;
  const t = ctx.currentTime;
  amb.gain.gain.cancelScheduledValues(t);
  amb.gain.gain.setValueAtTime(Math.max(0.0001, amb.gain.gain.value), t);
  amb.gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
  for (const o of amb.osc) o.stop(t + 1.2);
  for (const s of amb.src) s.stop(t + 1.2);
  window.setTimeout(() => {
    for (const n of [amb.gain, ...amb.nodes, ...amb.osc, ...amb.src]) {
      try {
        n.disconnect();
      } catch {
        /* torn down */
      }
    }
  }, 1500);
}

/** Re-arms ambience after the context unlocks or returns from background. */
export function resumeAmbience(): void {
  if (ambienceWanted && !ambience && mixer.live) startAmbience();
}

// ───────────────────────────── namespace ─────────────────────────────

/** Convenience bundle for call sites that prefer one import. */
export const sfx = {
  dealCard,
  cardFlip,
  cardSlide,
  riffleShuffle,
  chipClick,
  chipStack,
  chipsToPot,
  potPush,
  check,
  fold,
  betConfirm,
  allIn,
  timerTick,
  timeoutBuzz,
  yourTurn,
  winSmall,
  winBig,
  badBeat,
  tapPrimary,
  tapSecondary,
  tapToggle,
  tapError,
  sheetOpen,
  sheetClose,
  tabSwitch,
  toast,
  unlockCosmetic,
  passTierUp,
  levelUp,
  reactionPop,
  trainerCorrect,
  trainerIncorrect,
  streakMilestone,
  boom,
  fanfareRoyal,
  rumble,
  impact,
  setAmbience,
  resumeAmbience,
};
