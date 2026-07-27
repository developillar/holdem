/**
 * ROYALE — synthesis toolkit.
 * ─────────────────────────────────────────────────────────────────────
 * Everything audible in this app is made here. Zero sample files, zero
 * network fetches: noise beds, impulse responses, plucked strings and
 * waveshaper curves are all computed with plain maths into AudioBuffers
 * the first time they are asked for, then cached for the life of the
 * AudioContext.
 *
 * Design intent: warm, close, expensive. Poker audio should feel like
 * felt and clay, not like a phone game. That means band-limited noise
 * (never raw white), short exponential envelopes, resonant bodies, and
 * real convolution space instead of a delay-based fake.
 */
import { Rng } from '../core/rng.ts';

/** Shared jitter source. Deterministic so bug reports are reproducible. */
export const arng = new Rng(0x5ca1ab1e);

export type NoiseKind = 'white' | 'pink' | 'brown';
export type SpaceName = 'room' | 'hall' | 'plate';

/** Amplitude floor for exponential ramps — WebAudio forbids exact zero. */
export const FLOOR = 1e-4;

// ───────────────────────────── small maths ─────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Uniform random in [a,b) from the shared audio RNG. */
export function rand(a: number, b: number): number {
  return arng.range(a, b);
}

/** Multiplicative detune helper: `vary(440, 0.03)` → ±3 % around 440 Hz. */
export function vary(base: number, amount: number): number {
  return base * (1 + arng.range(-amount, amount));
}

/** Equal-tempered pitch from a reference. `semi(220, 7)` → 329.63 Hz. */
export function semi(base: number, semitones: number): number {
  return base * Math.pow(2, semitones / 12);
}

/** Perceptual gain curve for volume sliders: 0..1 → 0..1, cubic-ish. */
export function gainCurve(v: number): number {
  const c = clamp(v, 0, 1);
  return c * c * (0.35 + 0.65 * c);
}

// ───────────────────────────── envelopes ─────────────────────────────

export interface AmpEnv {
  /** attack seconds */
  a: number;
  /** decay seconds */
  d: number;
  /** sustain level 0..1 relative to peak (0 = pure percussive) */
  s?: number;
  /** seconds held at the sustain level */
  hold?: number;
  /** release seconds */
  r: number;
  /** peak level */
  peak?: number;
}

/**
 * Schedules a percussive/sustained amplitude envelope on a gain param and
 * returns the absolute time the envelope finishes. Exponential segments —
 * linear amplitude ramps sound synthetic and cheap.
 */
export function ampEnv(param: AudioParam, t0: number, env: AmpEnv): number {
  const peak = Math.max(FLOOR, env.peak ?? 1);
  const sus = env.s ?? 0;
  const hold = env.hold ?? 0;
  const a = Math.max(0.0006, env.a);
  const d = Math.max(0.001, env.d);
  const r = Math.max(0.004, env.r);

  param.cancelScheduledValues(t0);
  param.setValueAtTime(FLOOR, t0);
  param.exponentialRampToValueAtTime(peak, t0 + a);
  const tDecay = t0 + a + d;
  param.exponentialRampToValueAtTime(Math.max(FLOOR, peak * sus), tDecay);
  const tHold = tDecay + hold;
  if (hold > 0) param.setValueAtTime(Math.max(FLOOR, peak * sus), tHold);
  param.exponentialRampToValueAtTime(FLOOR, tHold + r);
  return tHold + r;
}

/** Linear sweep for filter cutoffs — exponential in frequency, which is linear in pitch. */
export function sweep(param: AudioParam, t0: number, from: number, to: number, secs: number): void {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(20, from), t0);
  param.exponentialRampToValueAtTime(Math.max(20, to), t0 + Math.max(0.005, secs));
}

// ───────────────────────────── filter chain ─────────────────────────────

export interface FilterSpec {
  type: BiquadFilterType;
  freq: number;
  q?: number;
  gain?: number;
}

export interface Chain {
  input: AudioNode;
  output: AudioNode;
  filters: BiquadFilterNode[];
}

/** Builds a serial biquad chain. Always returns a usable input/output pair. */
export function filterChain(ctx: BaseAudioContext, specs: FilterSpec[]): Chain {
  if (specs.length === 0) {
    const g = ctx.createGain();
    return { input: g, output: g, filters: [] };
  }
  const filters: BiquadFilterNode[] = [];
  let prev: BiquadFilterNode | null = null;
  for (const spec of specs) {
    const f = ctx.createBiquadFilter();
    f.type = spec.type;
    f.frequency.value = Math.max(20, Math.min(ctx.sampleRate * 0.48, spec.freq));
    f.Q.value = spec.q ?? 0.707;
    if (spec.gain !== undefined) f.gain.value = spec.gain;
    if (prev) prev.connect(f);
    filters.push(f);
    prev = f;
  }
  return { input: filters[0], output: filters[filters.length - 1], filters };
}

// ───────────────────────────── FM operator ─────────────────────────────

export interface FmSpec {
  freq: number;
  /** modulator : carrier frequency ratio */
  ratio: number;
  /** modulation index at note-on (in units of carrier frequency) */
  index: number;
  /** index falls to this over `indexDecay` seconds — gives the "tine" bite */
  indexEnd?: number;
  indexDecay?: number;
  type?: OscillatorType;
  modType?: OscillatorType;
  detune?: number;
}

export interface Voice {
  out: GainNode;
  amp: AudioParam;
  start(t: number): void;
  stop(t: number): void;
}

/**
 * A single FM pair. Two operators is all you need for Rhodes, bells,
 * clav-ish thocks and metallic shimmer — anything more and it stops
 * sounding like an instrument and starts sounding like a demo.
 */
export function fmVoice(ctx: BaseAudioContext, spec: FmSpec): Voice {
  const carrier = ctx.createOscillator();
  carrier.type = spec.type ?? 'sine';
  carrier.frequency.value = spec.freq;
  if (spec.detune) carrier.detune.value = spec.detune;

  const mod = ctx.createOscillator();
  mod.type = spec.modType ?? 'sine';
  mod.frequency.value = spec.freq * spec.ratio;

  const modDepth = ctx.createGain();
  const idx0 = spec.index * spec.freq;
  const idx1 = (spec.indexEnd ?? spec.index * 0.08) * spec.freq;
  modDepth.gain.value = idx0;

  const amp = ctx.createGain();
  amp.gain.value = FLOOR;

  mod.connect(modDepth);
  modDepth.connect(carrier.frequency);
  carrier.connect(amp);

  return {
    out: amp,
    amp: amp.gain,
    start(t: number) {
      if (spec.indexDecay && spec.indexDecay > 0) {
        modDepth.gain.setValueAtTime(Math.max(FLOOR, idx0), t);
        modDepth.gain.exponentialRampToValueAtTime(Math.max(FLOOR, idx1), t + spec.indexDecay);
      }
      mod.start(t);
      carrier.start(t);
    },
    stop(t: number) {
      mod.stop(t);
      carrier.stop(t);
      carrier.onended = () => {
        try {
          carrier.disconnect();
          mod.disconnect();
          modDepth.disconnect();
          amp.disconnect();
        } catch {
          /* already torn down */
        }
      };
    },
  };
}

// ───────────────────────────── raw buffer generators ─────────────────────

function fillWhite(out: Float32Array, rng: Rng): void {
  for (let i = 0; i < out.length; i++) out[i] = rng.next() * 2 - 1;
}

/** Paul Kellet's refined pink filter — flat-ish −3 dB/octave, no DC drift. */
function fillPink(out: Float32Array, rng: Rng): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
    b6 = w * 0.115926;
  }
}

/** Leaky-integrated white → −6 dB/octave. The bed under thuds and rumbles. */
function fillBrown(out: Float32Array, rng: Rng): void {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    last = (last + 0.019 * w) / 1.019;
    out[i] = last * 3.5;
  }
}

function normalize(data: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i] < 0 ? -data[i] : data[i];
    if (a > peak) peak = a;
  }
  if (peak > 1e-6) {
    const g = target / peak;
    for (let i = 0; i < data.length; i++) data[i] *= g;
  }
}

/** Fades the last `ms` of a buffer to zero so looped/truncated reads never click. */
function fadeTail(data: Float32Array, sr: number, ms: number): void {
  const n = Math.min(data.length, Math.round((ms / 1000) * sr));
  for (let i = 0; i < n; i++) {
    const k = i / n;
    data[data.length - 1 - i] *= k;
  }
}

// ───────────────────────── Karplus–Strong ─────────────────────────

/**
 * Plucked string, rendered offline into a buffer. Cheaper than a live
 * delay-line feedback graph and gives sample-exact control of the decay,
 * which matters when 40 chip clicks land in 1.2 s.
 */
export function karplusStrong(
  sr: number,
  freq: number,
  seconds: number,
  damping: number,
  brightness: number,
  rng: Rng,
): Float32Array {
  const n = Math.max(2, Math.round(sr / Math.max(20, freq)));
  const line = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.next() * 2 - 1;
    lp += (w - lp) * clamp(brightness, 0.02, 1);
    line[i] = lp;
  }
  // remove DC so the string does not push the speaker cone off-centre
  let mean = 0;
  for (let i = 0; i < n; i++) mean += line[i];
  mean /= n;
  for (let i = 0; i < n; i++) line[i] -= mean;

  const len = Math.max(16, Math.round(seconds * sr));
  const out = new Float32Array(len);
  const damp = clamp(damping, 0.5, 0.9999);
  let idx = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const cur = line[idx];
    out[i] = cur;
    line[idx] = (cur + prev) * 0.5 * damp;
    prev = cur;
    idx = idx + 1 === n ? 0 : idx + 1;
  }
  normalize(out, 0.9);
  fadeTail(out, sr, 12);
  return out;
}

// ───────────────────────── impulse responses ─────────────────────────

export interface SpaceSpec {
  seconds: number;
  /** higher = faster decay */
  decay: number;
  preDelay: number;
  /** damping sweep: cutoff at t=0 → cutoff at the tail */
  hfStart: number;
  hfEnd: number;
  /** number of discrete early reflections */
  early: number;
  /** stereo decorrelation of the early cluster */
  spread: number;
  seed: number;
}

export const SPACES: Record<SpaceName, SpaceSpec> = {
  // tight, woody, close-mic'd — the table itself
  room: { seconds: 0.72, decay: 2.6, preDelay: 0.005, hfStart: 7200, hfEnd: 1100, early: 9, spread: 0.55, seed: 0x1a2b },
  // the big card room: wins, all-ins, ceremony
  hall: { seconds: 2.9, decay: 1.9, preDelay: 0.024, hfStart: 5400, hfEnd: 380, early: 14, spread: 0.9, seed: 0x7f31 },
  // bright and shimmery — music tails only
  plate: { seconds: 1.9, decay: 2.2, preDelay: 0.011, hfStart: 9600, hfEnd: 1500, early: 6, spread: 0.7, seed: 0x33c9 },
};

/**
 * Exponentially decaying, progressively damped noise with a sparse early
 * reflection cluster. Decorrelated per channel, which is what makes a
 * generated IR read as a *place* rather than as a stereo effect.
 */
export function makeImpulseResponse(ctx: BaseAudioContext, spec: SpaceSpec): AudioBuffer {
  const sr = ctx.sampleRate;
  const pd = Math.round(spec.preDelay * sr);
  const total = Math.round(spec.seconds * sr) + pd;
  const buf = ctx.createBuffer(2, total, sr);
  const hpA = 1 - Math.exp((-2 * Math.PI * 48) / sr);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rng = new Rng(spec.seed + ch * 0x9e37);
    const body = total - pd;
    let lp = 0;
    let hp = 0;
    for (let i = 0; i < body; i++) {
      const t = i / body;
      const env = Math.pow(1 - t, spec.decay) * Math.exp(-2.1 * t);
      const fc = spec.hfStart * Math.pow(spec.hfEnd / spec.hfStart, t);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      const w = rng.next() * 2 - 1;
      lp += (w - lp) * a;
      hp += (lp - hp) * hpA;
      d[pd + i] = (lp - hp) * env;
    }
    // early reflections: discrete, decorrelated, decaying
    for (let k = 0; k < spec.early; k++) {
      const jitter = 1 + (ch === 1 ? spec.spread * (rng.next() - 0.5) : 0);
      const pos = pd + Math.floor(rng.range(0.003, 0.068) * sr * jitter);
      if (pos > 0 && pos < total) {
        d[pos] += (rng.next() * 2 - 1) * 0.6 * (1 - k / spec.early);
      }
    }
    normalize(d, 0.66);
    fadeTail(d, sr, 30);
  }
  return buf;
}

// ───────────────────────── waveshaping ─────────────────────────

/**
 * tanh soft-clip, normalised so unity in ≈ unity out. Used as the final
 * safety stage on the master and as deliberate saturation on big cues —
 * digital clipping on a phone speaker sounds like a broken app.
 */
export function softClipCurve(drive: number, n = 2048): Float32Array {
  const curve = new Float32Array(n);
  const k = Math.max(0.2, drive);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

// ───────────────────────── stereo widener ─────────────────────────

export interface Widener {
  input: GainNode;
  output: ChannelMergerNode;
  /** 1 = untouched, 0 = mono, >1 = wider */
  width: AudioParam;
  disconnect(): void;
}

/**
 * True mid/side widener. Mono sources are up-mixed first so a widened
 * one-shot still lands in both ears; side content is scaled, then the
 * pair is re-encoded. No phasey Haas delay — that collapses on a
 * single-speaker phone, and half our players are on one.
 */
export function stereoWidener(ctx: BaseAudioContext, width = 1.35): Widener {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';

  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);

  const midL = ctx.createGain();
  const midR = ctx.createGain();
  midL.gain.value = 0.5;
  midR.gain.value = 0.5;
  const sideL = ctx.createGain();
  const sideR = ctx.createGain();
  sideL.gain.value = 0.5;
  sideR.gain.value = -0.5;

  const mid = ctx.createGain();
  const side = ctx.createGain();
  side.gain.value = width;

  const outML = ctx.createGain();
  const outMR = ctx.createGain();
  const outSL = ctx.createGain();
  const outSR = ctx.createGain();
  outSR.gain.value = -1;

  input.connect(split);
  split.connect(midL, 0);
  split.connect(midR, 1);
  split.connect(sideL, 0);
  split.connect(sideR, 1);
  midL.connect(mid);
  midR.connect(mid);
  sideL.connect(side);
  sideR.connect(side);

  mid.connect(outML);
  mid.connect(outMR);
  side.connect(outSL);
  side.connect(outSR);
  outML.connect(merge, 0, 0);
  outSL.connect(merge, 0, 0);
  outMR.connect(merge, 0, 1);
  outSR.connect(merge, 0, 1);

  return {
    input,
    output: merge,
    width: side.gain,
    disconnect() {
      for (const n of [input, split, midL, midR, sideL, sideR, mid, side, outML, outMR, outSL, outSR, merge]) {
        try {
          n.disconnect();
        } catch {
          /* noop */
        }
      }
    },
  };
}

// ───────────────────────── the cached kit ─────────────────────────

/**
 * Per-context cache of every generated asset. Constructing this is the
 * one heavy moment in the audio boot (~10 ms on a mid-tier phone) and it
 * happens while the loading bar is still on screen.
 */
export class Synth {
  readonly ctx: AudioContext;
  private noiseCache = new Map<NoiseKind, AudioBuffer>();
  private spaceCache = new Map<SpaceName, AudioBuffer>();
  private curveCache = new Map<number, Float32Array>();
  private pluckCache = new Map<string, AudioBuffer>();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /** Pre-renders the assets every cue depends on, so first-play is glitch-free. */
  warm(): void {
    this.noise('white');
    this.noise('pink');
    this.noise('brown');
    this.space('room');
    this.space('hall');
    this.space('plate');
    this.curve(1.6);
  }

  noise(kind: NoiseKind): AudioBuffer {
    const hit = this.noiseCache.get(kind);
    if (hit) return hit;
    const sr = this.ctx.sampleRate;
    const seconds = kind === 'white' ? 2.2 : kind === 'pink' ? 3.4 : 4.5;
    const n = Math.round(sr * seconds);
    const buf = this.ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      const rng = new Rng(0x51de + ch * 7919 + kind.charCodeAt(0) * 131);
      if (kind === 'white') fillWhite(data, rng);
      else if (kind === 'pink') fillPink(data, rng);
      else fillBrown(data, rng);
      normalize(data, 0.92);
    }
    this.noiseCache.set(kind, buf);
    return buf;
  }

  space(name: SpaceName): AudioBuffer {
    const hit = this.spaceCache.get(name);
    if (hit) return hit;
    const buf = makeImpulseResponse(this.ctx, SPACES[name]);
    this.spaceCache.set(name, buf);
    return buf;
  }

  curve(drive: number): Float32Array {
    const key = Math.round(drive * 10);
    const hit = this.curveCache.get(key);
    if (hit) return hit;
    const c = softClipCurve(key / 10);
    this.curveCache.set(key, c);
    return c;
  }

  /** Cached Karplus–Strong buffer. Quantised keys keep the cache small. */
  pluck(freq: number, seconds: number, damping = 0.994, brightness = 0.5): AudioBuffer {
    const key = `${Math.round(freq)}|${Math.round(seconds * 50)}|${Math.round(damping * 2000)}|${Math.round(
      brightness * 40,
    )}`;
    const hit = this.pluckCache.get(key);
    if (hit) return hit;
    const data = karplusStrong(this.ctx.sampleRate, freq, seconds, damping, brightness, new Rng(Math.round(freq * 977)));
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.getChannelData(0).set(data);
    if (this.pluckCache.size > 64) this.pluckCache.clear();
    this.pluckCache.set(key, buf);
    return buf;
  }

  /**
   * A noise source cued to a random offset inside the cached bed, so two
   * consecutive card deals never read the same samples.
   */
  noiseSource(kind: NoiseKind, playbackRate = 1, loop = false): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise(kind);
    src.playbackRate.value = playbackRate;
    src.loop = loop;
    return src;
  }

  /** Random start offset (seconds) inside a noise bed, leaving room for `need`. */
  noiseOffset(kind: NoiseKind, need: number): number {
    const dur = this.noise(kind).duration;
    return arng.range(0, Math.max(0.001, dur - need - 0.05));
  }

  /**
   * Convolver with `normalize` left on: our impulse responses are
   * arbitrary generated noise, and an un-normalised 2.9 s tail applies
   * 10–20× of convolution gain — which is exactly how a mix ends up
   * permanently pinned against the limiter.
   */
  convolver(name: SpaceName): ConvolverNode {
    const c = this.ctx.createConvolver();
    c.normalize = true;
    c.buffer = this.space(name);
    return c;
  }

  shaper(drive: number): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    // copy: WaveShaperNode.curve wants a buffer it owns
    w.curve = new Float32Array(this.curve(drive));
    w.oversample = '2x';
    return w;
  }
}
