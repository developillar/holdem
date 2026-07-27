/**
 * ROYALE — adaptive score.
 * ─────────────────────────────────────────────────────────────────────
 * There are no loops in this file. The score is a small generative
 * ensemble — a warm sub, a four-voice filtered pad, a breathing noise
 * texture and a sparse Rhodes-ish voice walking a pentatonic — driven by
 * a look-ahead scheduler. Chord lengths, note spacing, register and
 * velocity are all stochastic, so nothing ever repeats verbatim and an
 * hour of play never produces a phrase you start to anticipate.
 *
 * It listens to the game. Pot size and pressure raise `intensity`, which
 * opens the pad filter, thickens the sub, tightens note spacing and, past
 * the halfway mark, introduces a slow pulse. Dealing drops it to almost
 * nothing. A pot won gets a short triumphant motif; a bad beat detunes
 * the whole bed a third of a semitone flat and closes the filter.
 */
import { mixer } from './mixer.ts';
import { arng, clamp, rand, type NoiseKind } from './synth.ts';

export type MusicBed = 'lobby' | 'table' | 'trainer' | 'store' | 'none';

interface Chord {
  /** semitone transposition of the bed root */
  t: number;
  /** pad voicing above the chord root, in semitones */
  v: number[];
}

interface BedSpec {
  /** sub-bass root in Hz */
  root: number;
  /** pentatonic degrees for the melodic voice */
  scale: number[];
  progression: Chord[];
  padType: OscillatorType;
  /** base lowpass cutoff of the pad, in Hz, before intensity */
  padCutoff: number;
  padQ: number;
  padLevel: number;
  subLevel: number;
  noise: NoiseKind;
  noiseLevel: number;
  noiseCentre: number;
  /** FM settings for the melodic voice */
  bellRatio: number;
  bellIndex: number;
  bellLevel: number;
  /** seconds between note onsets at intensity 0 → 1 */
  spacing: [number, number];
  /** index window into the generated pitch table */
  register: [number, number];
  /** plate-reverb send */
  plate: number;
  /** chord length range, seconds */
  chordLen: [number, number];
  /** probability of a rest instead of a note */
  rest: number;
  /** does this bed get the intensity pulse */
  pulse: boolean;
  /** filter LFO depth in Hz */
  drift: number;
}

const BEDS: Record<Exclude<MusicBed, 'none'>, BedSpec> = {
  // Calm, unhurried, faintly nocturnal. This plays while people browse.
  lobby: {
    root: 55,
    scale: [0, 3, 5, 7, 10],
    progression: [
      { t: 0, v: [0, 7, 12, 15] },
      { t: -4, v: [0, 7, 12, 16] },
      { t: 3, v: [0, 7, 12, 16] },
      { t: -2, v: [0, 7, 12, 14] },
    ],
    padType: 'sawtooth',
    padCutoff: 560,
    padQ: 1.6,
    padLevel: 0.2,
    subLevel: 0.055,
    noise: 'pink',
    noiseLevel: 0.035,
    noiseCentre: 900,
    bellRatio: 1,
    bellIndex: 2.1,
    bellLevel: 0.2,
    spacing: [2.1, 1.1],
    register: [2, 11],
    plate: 0.42,
    chordLen: [11, 19],
    rest: 0.24,
    pulse: false,
    drift: 90,
  },
  // Warm but wound. Sub-forward, filter tracks the pressure of the hand.
  table: {
    root: 49,
    scale: [0, 3, 5, 7, 10],
    progression: [
      { t: 0, v: [0, 7, 12, 15] },
      { t: -3, v: [0, 7, 12, 16] },
      { t: 5, v: [0, 7, 12, 15] },
      { t: -5, v: [0, 7, 12, 14] },
    ],
    padType: 'sawtooth',
    padCutoff: 420,
    padQ: 2.1,
    padLevel: 0.2,
    subLevel: 0.08,
    noise: 'brown',
    noiseLevel: 0.045,
    noiseCentre: 480,
    bellRatio: 1,
    bellIndex: 2.6,
    bellLevel: 0.19,
    spacing: [2.6, 1.0],
    register: [0, 9],
    plate: 0.34,
    chordLen: [13, 24],
    rest: 0.3,
    pulse: true,
    drift: 70,
  },
  // Minimal and clean — it must not compete with thinking.
  trainer: {
    root: 65.41,
    scale: [0, 2, 5, 7, 9],
    progression: [
      { t: 0, v: [0, 7, 12] },
      { t: -3, v: [0, 7, 12] },
      { t: 4, v: [0, 7, 14] },
    ],
    padType: 'triangle',
    padCutoff: 720,
    padQ: 0.9,
    padLevel: 0.15,
    subLevel: 0.035,
    noise: 'pink',
    noiseLevel: 0.018,
    noiseCentre: 1400,
    bellRatio: 1,
    bellIndex: 1.5,
    bellLevel: 0.17,
    spacing: [3.4, 2.2],
    register: [3, 10],
    plate: 0.3,
    chordLen: [16, 26],
    rest: 0.42,
    pulse: false,
    drift: 40,
  },
  // Glossy: brighter FM, wider voicings, more plate. Sells the goods.
  store: {
    root: 73.42,
    scale: [0, 2, 4, 7, 9],
    progression: [
      { t: 0, v: [0, 4, 7, 11] },
      { t: 5, v: [0, 4, 7, 11] },
      { t: -2, v: [0, 4, 7, 14] },
      { t: 2, v: [0, 3, 7, 10] },
    ],
    padType: 'triangle',
    padCutoff: 860,
    padQ: 1.1,
    padLevel: 0.16,
    subLevel: 0.045,
    noise: 'pink',
    noiseLevel: 0.026,
    noiseCentre: 2400,
    bellRatio: 3.51,
    bellIndex: 1.3,
    bellLevel: 0.18,
    spacing: [1.9, 1.2],
    register: [4, 13],
    plate: 0.5,
    chordLen: [10, 16],
    rest: 0.2,
    pulse: false,
    drift: 130,
  },
};

const FADE = 1.5;
const LOOKAHEAD = 0.55;
const TICK_MS = 90;

/** Weighted random walk step. Small moves dominate; leaps are rare and earn attention. */
const STEPS = [-4, -3, -2, -1, -1, 0, 1, 1, 2, 3, 4];
const STEP_W = [0.03, 0.07, 0.13, 0.19, 0.12, 0.06, 0.19, 0.11, 0.06, 0.03, 0.01];

function pickStep(): number {
  let r = arng.next();
  for (let i = 0; i < STEPS.length; i++) {
    r -= STEP_W[i];
    if (r <= 0) return STEPS[i];
  }
  return 0;
}

class Bed {
  readonly spec: BedSpec;
  private ctx: AudioContext;
  readonly out: GainNode;

  private padGain: GainNode;
  private padFilter: BiquadFilterNode;
  private padOsc: OscillatorNode[] = [];
  private subOsc: OscillatorNode[] = [];
  private subGain: GainNode;
  private noiseGain: GainNode;
  private noiseFilter: BiquadFilterNode;
  private noiseSrc: AudioBufferSourceNode | null = null;
  private voiceGain: GainNode;
  private plate: GainNode | null = null;
  private lfo: OscillatorNode;
  private lfoAmt: GainNode;

  private pitches: number[] = [];
  private chordIdx = 0;
  private nextChordAt = 0;
  private nextNoteAt = 0;
  private nextPulseAt = 0;
  private degree = 4;
  private intensity = 0;
  private stopped = false;

  constructor(ctx: AudioContext, spec: BedSpec, dest: AudioNode, plateSend: AudioNode | null) {
    this.ctx = ctx;
    this.spec = spec;

    this.out = ctx.createGain();
    this.out.gain.value = 0.0001;
    this.out.connect(dest);
    if (plateSend && spec.plate > 0) {
      const send = ctx.createGain();
      send.gain.value = spec.plate;
      this.out.connect(send);
      send.connect(plateSend);
      this.plate = send;
    }

    // pad
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = spec.padCutoff;
    this.padFilter.Q.value = spec.padQ;
    this.padGain = ctx.createGain();
    this.padGain.gain.value = spec.padLevel;
    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.out);

    // slow filter drift, so the pad is never static
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.031 + arng.range(0, 0.02);
    this.lfoAmt = ctx.createGain();
    this.lfoAmt.gain.value = spec.drift;
    this.lfo.connect(this.lfoAmt);
    this.lfoAmt.connect(this.padFilter.frequency);

    // sub
    this.subGain = ctx.createGain();
    this.subGain.gain.value = spec.subLevel;
    this.subGain.connect(this.out);

    // noise texture
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = spec.noiseCentre;
    this.noiseFilter.Q.value = 0.8;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = spec.noiseLevel;
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.out);

    // melodic voice
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = spec.bellLevel;
    this.voiceGain.connect(this.out);

    for (let oct = 0; oct < 3; oct++) {
      for (const s of spec.scale) this.pitches.push(s + 12 * oct);
    }
    this.degree = clamp(Math.round((spec.register[0] + spec.register[1]) / 2), 0, this.pitches.length - 1);
    this.chordIdx = arng.int(spec.progression.length);
  }

  private chord(): Chord {
    return this.spec.progression[this.chordIdx];
  }

  start(t: number, synthNoise: AudioBuffer): void {
    const spec = this.spec;
    const c = this.chord();

    for (let i = 0; i < 4; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = spec.padType;
      // ±7 cents of spread keeps the pad alive without sounding out of tune
      osc.detune.value = (i - 1.5) * 5.2;
      osc.frequency.value = this.padFreq(i, c);
      const g = this.ctx.createGain();
      g.gain.value = i === 0 ? 0.42 : 0.3 - i * 0.05;
      osc.connect(g);
      g.connect(this.padFilter);
      osc.start(t + i * 0.004);
      this.padOsc.push(osc);
    }

    for (let i = 0; i < 2; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.value = this.subFreq(c) * (i === 0 ? 1 : 2);
      const g = this.ctx.createGain();
      // the octave is what makes a 45 Hz root audible on a phone speaker
      g.gain.value = i === 0 ? 1 : 0.34;
      osc.connect(g);
      g.connect(this.subGain);
      osc.start(t);
      this.subOsc.push(osc);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = synthNoise;
    src.loop = true;
    src.playbackRate.value = 0.85 + arng.range(0, 0.3);
    src.connect(this.noiseFilter);
    src.start(t, arng.range(0, Math.max(0.1, synthNoise.duration - 1)));
    this.noiseSrc = src;

    this.lfo.start(t);

    const now = this.ctx.currentTime;
    this.nextChordAt = now + rand(this.spec.chordLen[0], this.spec.chordLen[1]) * 0.55;
    this.nextNoteAt = now + rand(0.6, 2.2);
    this.nextPulseAt = now + 2;
  }

  private padFreq(i: number, c: Chord): number {
    const v = c.v[i % c.v.length] + (i >= c.v.length ? 12 : 0);
    return this.spec.root * 4 * Math.pow(2, (c.t + v) / 12);
  }

  /** Chord root folded into a narrow, reproducible sub window. */
  private subFreq(c: Chord): number {
    let f = this.spec.root * Math.pow(2, c.t / 12);
    while (f > 84) f /= 2;
    while (f < 41) f *= 2;
    return f;
  }

  fadeTo(level: number, secs: number): void {
    const t = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.exponentialRampToValueAtTime(Math.max(0.0001, level), t + Math.max(0.05, secs));
  }

  setIntensity(v: number): void {
    this.intensity = clamp(v, 0, 1);
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    const k = this.intensity;
    this.padFilter.frequency.setTargetAtTime(this.spec.padCutoff * (1 + k * 2.6), t, 1.6);
    this.padFilter.Q.setTargetAtTime(this.spec.padQ * (1 + k * 0.5), t, 1.6);
    this.subGain.gain.setTargetAtTime(this.spec.subLevel * (0.55 + 0.7 * k), t, 1.4);
    this.padGain.gain.setTargetAtTime(this.spec.padLevel * (0.85 + 0.3 * k), t, 1.6);
    this.noiseGain.gain.setTargetAtTime(this.spec.noiseLevel * (0.65 + 0.8 * k), t, 2.2);
    this.voiceGain.gain.setTargetAtTime(this.spec.bellLevel * (0.85 + 0.4 * k), t, 1.2);
  }

  /** Advances chord + note scheduling up to `horizon` (absolute context time). */
  schedule(horizon: number): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    if (this.nextNoteAt < now - 2) this.nextNoteAt = now + 0.2;
    if (this.nextChordAt < now - 2) this.nextChordAt = now + 1;
    if (this.nextPulseAt < now - 2) this.nextPulseAt = now + 1;

    while (this.nextChordAt < horizon) {
      this.advanceChord(this.nextChordAt);
      this.nextChordAt += rand(this.spec.chordLen[0], this.spec.chordLen[1]);
    }

    while (this.nextNoteAt < horizon) {
      const at = this.nextNoteAt;
      const rest = this.spec.rest * (1 - this.intensity * 0.4);
      if (arng.next() > rest) {
        this.degree = clamp(this.degree + pickStep(), this.spec.register[0], this.spec.register[1]);
        const vel = rand(0.42, 0.95) * (0.8 + this.intensity * 0.35);
        const dur = rand(1.3, 3.4) * (1.25 - this.intensity * 0.35);
        this.note(at, this.degreeFreq(this.degree), vel, dur);
        // occasional grace pair — a fourth or fifth stacked a beat later
        if (arng.next() < 0.14) {
          const d2 = clamp(this.degree + (arng.bool() ? 2 : -2), this.spec.register[0], this.spec.register[1]);
          this.note(at + rand(0.1, 0.2), this.degreeFreq(d2), vel * 0.6, dur * 0.8);
        }
      }
      const sp = this.spec.spacing;
      const base = sp[0] + (sp[1] - sp[0]) * this.intensity;
      this.nextNoteAt += base * rand(0.6, 1.55);
    }

    if (this.spec.pulse && this.intensity > 0.48) {
      while (this.nextPulseAt < horizon) {
        this.pulse(this.nextPulseAt, (this.intensity - 0.48) / 0.52);
        this.nextPulseAt += 2.6 - this.intensity * 1.0;
      }
    } else {
      this.nextPulseAt = Math.max(this.nextPulseAt, now + 1);
    }
  }

  private degreeFreq(deg: number): number {
    const c = this.chord();
    const p = this.pitches[clamp(deg, 0, this.pitches.length - 1)];
    return this.spec.root * 4 * Math.pow(2, (c.t + p) / 12);
  }

  private advanceChord(t: number): void {
    const n = this.spec.progression.length;
    // Never repeat the same chord twice in a row; otherwise walk freely.
    // (A one-chord progression would spin here forever, hence the guard.)
    if (n > 1) {
      let next = this.chordIdx;
      while (next === this.chordIdx) next = arng.int(n);
      this.chordIdx = next;
    }
    const c = this.chord();
    for (let i = 0; i < this.padOsc.length; i++) {
      this.padOsc[i].frequency.setTargetAtTime(this.padFreq(i, c), t, 1.4);
    }
    const sf = this.subFreq(c);
    for (let i = 0; i < this.subOsc.length; i++) {
      this.subOsc[i].frequency.setTargetAtTime(sf * (i === 0 ? 1 : 2), t, 2.2);
    }
  }

  /** One Rhodes-ish note: FM pair with a fast index decay for the tine. */
  note(t: number, freq: number, vel: number, dur: number, bright = 1): void {
    if (this.stopped || freq < 25 || freq > 4000) return;
    const ctx = this.ctx;
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;
    carrier.detune.value = arng.range(-4, 4);

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * this.spec.bellRatio;
    const modAmt = ctx.createGain();
    const idx = this.spec.bellIndex * bright * (0.7 + vel * 0.6);
    modAmt.gain.setValueAtTime(idx * freq, t);
    modAmt.gain.exponentialRampToValueAtTime(Math.max(0.001, idx * freq * 0.05), t + Math.min(0.9, dur * 0.45));
    mod.connect(modAmt);
    modAmt.connect(carrier.frequency);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel), t + 0.012);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel * 0.22), t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    carrier.connect(g);
    g.connect(this.voiceGain);
    mod.start(t);
    carrier.start(t);
    mod.stop(t + dur + 0.05);
    carrier.stop(t + dur + 0.05);
    carrier.onended = () => {
      try {
        carrier.disconnect();
        mod.disconnect();
        modAmt.disconnect();
        g.disconnect();
      } catch {
        /* torn down */
      }
    };
  }

  /** The slow low pulse that appears when a hand gets expensive. */
  private pulse(t: number, k: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f = this.subFreq(this.chord()) * 0.75;
    osc.frequency.setValueAtTime(f * 1.8, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * k, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(g);
    g.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.56);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* torn down */
      }
    };
  }

  /** Short triumphant motif over the current harmony. */
  triumph(t: number): void {
    const c = this.chord();
    const base = this.spec.root * 8 * Math.pow(2, c.t / 12);
    [0, 4, 7, 12].forEach((st, i) => {
      this.note(t + i * 0.11, base * Math.pow(2, st / 12), 0.85 - i * 0.06, 2.2 - i * 0.2, 1.5);
    });
    const g = this.padGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.spec.padLevel * 2.1, t + 0.35);
    g.setValueAtTime(this.spec.padLevel * 2.1, t + 1.1);
    g.linearRampToValueAtTime(this.spec.padLevel, t + 2.8);
    this.padFilter.frequency.cancelScheduledValues(t);
    this.padFilter.frequency.setTargetAtTime(this.spec.padCutoff * 3.6, t, 0.25);
    this.padFilter.frequency.setTargetAtTime(this.spec.padCutoff * (1 + this.intensity * 2.6), t + 1.4, 1.2);
  }

  /** Hollow, flat, detuned. The sound of the river card ruining your night. */
  badBeat(t: number): void {
    for (const o of this.padOsc) {
      o.detune.cancelScheduledValues(t);
      o.detune.setValueAtTime(o.detune.value, t);
      o.detune.linearRampToValueAtTime(o.detune.value - 38, t + 1.1);
      o.detune.linearRampToValueAtTime(o.detune.value, t + 4.6);
    }
    this.padFilter.frequency.cancelScheduledValues(t);
    this.padFilter.frequency.setTargetAtTime(this.spec.padCutoff * 0.42, t, 0.4);
    this.padFilter.frequency.setTargetAtTime(this.spec.padCutoff * (1 + this.intensity * 2.6), t + 2.6, 1.6);
    const c = this.chord();
    const base = this.spec.root * 4 * Math.pow(2, c.t / 12);
    this.note(t + 0.05, base * 3, 0.5, 2.4, 2.4);
    this.note(t + 0.42, base * 2, 0.42, 3.2, 2.2);
  }

  stop(t: number): void {
    if (this.stopped) return;
    this.stopped = true;
    const end = t + 0.08;
    for (const o of [...this.padOsc, ...this.subOsc, this.lfo]) {
      try {
        o.stop(end);
      } catch {
        /* never started */
      }
    }
    try {
      this.noiseSrc?.stop(end);
    } catch {
      /* never started */
    }
    const ms = Math.max(0, (end - this.ctx.currentTime) * 1000) + 200;
    window.setTimeout(() => {
      for (const n of [
        this.out,
        this.padGain,
        this.padFilter,
        this.subGain,
        this.noiseGain,
        this.noiseFilter,
        this.voiceGain,
        this.lfoAmt,
        ...(this.plate ? [this.plate] : []),
      ]) {
        try {
          n.disconnect();
        } catch {
          /* torn down */
        }
      }
    }, ms);
  }
}

class Music {
  private active: Bed | null = null;
  private activeName: MusicBed = 'none';
  private timer: number | null = null;
  private intensity = 0;
  private target = 0;
  private lastFrame = 0;

  /** Current bed, for callers that want to avoid redundant switches. */
  get bed(): MusicBed {
    return this.activeName;
  }

  /**
   * Crossfades to a new bed over ~1.5 s. Safe before the context is
   * unlocked: the request is remembered and the bed is built the moment
   * audio actually starts running, so no oscillator is ever scheduled
   * against a frozen clock.
   */
  setBed(name: MusicBed): void {
    if (name === this.activeName) return;
    this.activeName = name;

    const ctx = mixer.ctx;
    const old = this.active;
    this.active = null;
    if (old) {
      old.fadeTo(0.0001, FADE);
      old.stop((ctx?.currentTime ?? 0) + FADE + 0.1);
    }

    if (name === 'none') {
      this.stopLoop();
      return;
    }
    this.startLoop();
    this.ensureBed(old !== null);
  }

  /** Builds the requested bed once the mixer is genuinely running. */
  private ensureBed(crossfading = false): void {
    if (this.active || this.activeName === 'none') return;
    const ctx = mixer.ctx;
    const dest = mixer.busInput('music');
    if (!ctx || !dest || !mixer.synth || !mixer.live) return;

    const spec = BEDS[this.activeName];
    const bed = new Bed(ctx, spec, dest, mixer.musicSendInput());
    bed.start(ctx.currentTime + 0.05, mixer.synth.noise(spec.noise));
    bed.setIntensity(this.intensity);
    bed.fadeTo(1, crossfading ? FADE : FADE * 1.6);
    this.active = bed;
  }

  /**
   * 0 = still, 1 = a stack is in the middle. Smoothed internally over a
   * couple of seconds so the score never lurches.
   */
  setIntensity(v: number): void {
    this.target = clamp(v, 0, 1);
  }

  /** Immediate, unsmoothed — used when a hand ends and the table resets. */
  resetIntensity(v = 0): void {
    this.target = clamp(v, 0, 1);
    this.intensity = this.target;
    this.active?.setIntensity(this.intensity);
  }

  getIntensity(): number {
    return this.intensity;
  }

  /** Pull the score back so the deal reads clean. */
  duckForDeal(ms = 700): void {
    mixer.duck(0.62, ms);
  }

  triumph(): void {
    const ctx = mixer.ctx;
    if (!ctx || !this.active) return;
    this.active.triumph(ctx.currentTime + 0.03);
  }

  badBeat(): void {
    const ctx = mixer.ctx;
    if (!ctx || !this.active) return;
    this.active.badBeat(ctx.currentTime + 0.03);
  }

  private startLoop(): void {
    if (this.timer !== null || typeof window === 'undefined') return;
    this.lastFrame = Date.now();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const ctx = mixer.ctx;
    const now = Date.now();
    const dt = Math.min(0.5, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    // exponential approach: ~2 s to close most of the gap
    const k = 1 - Math.exp(-dt / 1.6);
    const next = this.intensity + (this.target - this.intensity) * k;
    if (Math.abs(next - this.intensity) > 0.004) {
      this.intensity = next;
      this.active?.setIntensity(this.intensity);
    }

    if (!ctx || !mixer.live) return;
    if (!this.active) {
      this.ensureBed();
      return;
    }
    this.active.schedule(ctx.currentTime + LOOKAHEAD);
  }

  /** Stops everything and tears the graph down. */
  stop(): void {
    this.setBed('none');
    this.stopLoop();
  }
}

export const music = new Music();
