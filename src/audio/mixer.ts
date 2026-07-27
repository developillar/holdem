/**
 * ROYALE — mixer.
 * ─────────────────────────────────────────────────────────────────────
 *                      ┌── music ─┬─ duck ─┐
 *                      ├── sfx  ──┤        │
 *   one-shots ─ strip ─┤── ui   ──┤        ├─ master ─ sat ─ glue ─ limiter ─ out
 *                      └─ ambience┘        │
 *          sends ─ room/hall convolvers ───┘
 *
 * Four addressable buses, one glue compressor and a hard limiter on the
 * master, sidechain ducking driven by the `audio:duck` bus event, volumes
 * persisted to localStorage, page-visibility fade-out, and the iOS
 * unlock-on-first-gesture dance handled once, correctly.
 *
 * Every public method is safe to call before the context exists. That is
 * the whole contract: `initAudio()` runs during boot with no user gesture,
 * so nothing here may throw and nothing may make noise until unlocked.
 */
import { Synth, gainCurve, clamp, stereoWidener } from './synth.ts';

export type BusName = 'master' | 'music' | 'sfx' | 'ui' | 'ambience';
export type SendName = 'room' | 'hall';
export type Quality = 'low' | 'mid' | 'high';

export const BUS_NAMES: BusName[] = ['master', 'music', 'sfx', 'ui', 'ambience'];

export interface StripOpts {
  bus?: Exclude<BusName, 'master'>;
  /** linear gain, pre-bus */
  gain?: number;
  /** −1 left … +1 right */
  pan?: number;
  /** send level into the small warm room */
  room?: number;
  /** send level into the big hall */
  hall?: number;
  /** mid/side width; 1 = untouched. Costs 12 nodes, use it on hero cues only. */
  width?: number;
}

/** A disposable channel strip for one cue. Connect voices into `input`. */
export interface Strip {
  ctx: AudioContext;
  synth: Synth;
  /** where voices connect — any node, so cues can splice a filter in front */
  input: AudioNode;
  /** absolute time base for scheduling */
  t: number;
  /** schedules teardown shortly after `endTime` */
  done(endTime: number): void;
}

interface Persisted {
  v: Record<BusName, number>;
  muted: boolean;
}

const STORE_KEY = 'royale.audio.v1';

const DEFAULT_VOLUMES: Record<BusName, number> = {
  master: 0.9,
  music: 0.6,
  sfx: 0.9,
  ui: 0.8,
  ambience: 0.5,
};

/**
 * Fixed inter-bus balance, measured rather than guessed: with these trims
 * a ceremonial cue peaks near −3.5 dBFS, a chip stack near −16 dBFS, the
 * score sits around −24 dBFS RMS and the room tone around −34 dBFS. The
 * user's sliders move on top of this, they do not define it.
 */
const BUS_TRIM: Record<Exclude<BusName, 'master'>, number> = {
  music: 0.55,
  sfx: 1.0,
  ui: 0.9,
  ambience: 0.35,
};

const MAX_VOICES: Record<Quality, number> = { low: 20, mid: 36, high: 56 };

/** Kept as a call so control-flow analysis never narrows `ctx.state` away. */
function isRunning(ctx: AudioContext): boolean {
  return ctx.state === 'running';
}

function loadPersisted(): Persisted {
  const base: Persisted = { v: { ...DEFAULT_VOLUMES }, muted: false };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (parsed && typeof parsed === 'object') {
      if (parsed.v) {
        for (const k of BUS_NAMES) {
          const val = parsed.v[k];
          if (typeof val === 'number' && Number.isFinite(val)) base.v[k] = clamp(val, 0, 1);
        }
      }
      if (typeof parsed.muted === 'boolean') base.muted = parsed.muted;
    }
  } catch {
    /* private mode / disabled storage — defaults are fine */
  }
  return base;
}

class Mixer {
  ctx: AudioContext | null = null;
  synth: Synth | null = null;
  /** true once the graph exists AND the context is running */
  get live(): boolean {
    return this.ctx !== null && isRunning(this.ctx);
  }
  /** true once the graph exists, even if still suspended */
  get built(): boolean {
    return this.ctx !== null;
  }

  quality: Quality = 'high';

  private volumes: Record<BusName, number>;
  private muted: boolean;

  private masterGain: GainNode | null = null;
  private limiterNode: DynamicsCompressorNode | null = null;
  private meterNode: AnalyserNode | null = null;
  private duckGain: GainNode | null = null;
  private busGains = new Map<Exclude<BusName, 'master'>, GainNode>();
  private sends = new Map<SendName, GainNode>();
  private musicSend: GainNode | null = null;

  private voices = 0;
  private hidden = false;
  private unlockBound = false;
  private readyWaiters: Array<() => void> = [];

  constructor() {
    const p = loadPersisted();
    this.volumes = p.v;
    this.muted = p.muted;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  /**
   * Builds the graph. Called from `initAudio()` during boot — before any
   * gesture — so the context will usually come up `suspended`. That is
   * fine: every buffer, IR and curve is generated here while the loading
   * bar is still visible, and the first tap only has to call resume().
   */
  build(): boolean {
    if (this.ctx) return true;
    if (typeof window === 'undefined') return false;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;

    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return false;
    }
    this.ctx = ctx;
    this.synth = new Synth(ctx);

    // ── master chain: gain → saturation → glue → limiter → out
    const master = ctx.createGain();
    master.gain.value = 0;

    const sat = this.synth.shaper(1.35);

    const glue = ctx.createDynamicsCompressor();
    // High enough that the score and ordinary table action pass untouched;
    // only the ceremonial tier gets glued, which is where it helps.
    glue.threshold.value = -14;
    glue.knee.value = 20;
    glue.ratio.value = 2.4;
    glue.attack.value = 0.008;
    glue.release.value = 0.22;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.0015;
    limiter.release.value = 0.09;

    master.connect(sat);
    sat.connect(glue);
    glue.connect(limiter);
    limiter.connect(ctx.destination);
    this.masterGain = master;
    this.limiterNode = limiter;

    // ── music leg gets its own duck node before the master
    const duck = ctx.createGain();
    duck.gain.value = 1;
    duck.connect(master);
    this.duckGain = duck;

    for (const name of ['music', 'sfx', 'ui', 'ambience'] as const) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(name === 'music' ? duck : master);
      this.busGains.set(name, g);
    }

    // ── shared reverb returns. SFX/UI share room+hall; music has a plate.
    const sfxBus = this.busGains.get('sfx')!;
    for (const name of ['room', 'hall'] as const) {
      const send = ctx.createGain();
      send.gain.value = 1;
      const conv = this.synth.convolver(name);
      const ret = ctx.createGain();
      ret.gain.value = name === 'room' ? 0.85 : 1.05;
      // Tame the return so tails stay behind the transient, never in front.
      const tone = ctx.createBiquadFilter();
      tone.type = 'highpass';
      tone.frequency.value = name === 'room' ? 260 : 150;
      send.connect(conv);
      conv.connect(tone);
      tone.connect(ret);
      ret.connect(sfxBus);
      this.sends.set(name, send);
    }

    const musicBus = this.busGains.get('music')!;
    const mSend = ctx.createGain();
    mSend.gain.value = 1;
    const mConv = this.synth.convolver('plate');
    const mRet = ctx.createGain();
    mRet.gain.value = 0.9;
    mSend.connect(mConv);
    mConv.connect(mRet);
    mRet.connect(musicBus);
    this.musicSend = mSend;

    this.synth.warm();
    this.applyVolumes(0);
    this.bindUnlock();
    this.bindVisibility();
    return true;
  }

  /** Resumes the context. Safe to call repeatedly; resolves once running. */
  async unlock(): Promise<void> {
    if (!this.ctx) this.build();
    const ctx = this.ctx;
    if (!ctx) return;
    if (isRunning(ctx)) {
      this.flushReady();
      return;
    }
    try {
      await ctx.resume();
    } catch {
      return;
    }
    if (isRunning(ctx)) {
      // A one-sample silent buffer convinces older iOS that we are serious.
      try {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.start(0);
      } catch {
        /* noop */
      }
      this.applyVolumes(0.35);
      this.flushReady();
    }
  }

  /** Resolves the first time the context is actually running. */
  whenLive(): Promise<void> {
    if (this.live) return Promise.resolve();
    return new Promise((res) => this.readyWaiters.push(res));
  }

  private flushReady(): void {
    const list = this.readyWaiters;
    this.readyWaiters = [];
    for (const fn of list) fn();
  }

  private bindUnlock(): void {
    if (this.unlockBound || typeof window === 'undefined') return;
    this.unlockBound = true;
    const events = ['pointerdown', 'touchend', 'mousedown', 'keydown'] as const;
    const handler = () => {
      void this.unlock().then(() => {
        if (this.live) for (const e of events) window.removeEventListener(e, handler);
      });
    };
    for (const e of events) window.addEventListener(e, handler, { passive: true });
  }

  private bindVisibility(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      const hidden = document.visibilityState === 'hidden';
      if (hidden === this.hidden) return;
      this.hidden = hidden;
      if (!this.ctx) return;
      if (hidden) {
        this.applyVolumes(0.22, true);
        window.setTimeout(() => {
          if (this.hidden && this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
        }, 300);
      } else {
        const resume = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
        void resume.then(() => this.applyVolumes(0.5));
      }
    });
  }

  // ── volumes ──────────────────────────────────────────────────────────

  private applyVolumes(ramp: number, forceSilent = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    const t = ctx.currentTime;
    const silent = forceSilent || this.hidden || this.muted;
    const target = silent ? 0 : gainCurve(this.volumes.master);
    const set = (p: AudioParam, v: number) => {
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      if (ramp <= 0) p.setValueAtTime(v, t);
      else p.linearRampToValueAtTime(v, t + ramp);
    };
    set(this.masterGain.gain, target);
    for (const [name, node] of this.busGains) {
      set(node.gain, gainCurve(this.volumes[name]) * BUS_TRIM[name]);
    }
  }

  setVolume(bus: BusName, v: number): void {
    this.volumes[bus] = clamp(v, 0, 1);
    this.applyVolumes(0.06);
    this.persist();
  }

  getVolume(bus: BusName): number {
    return this.volumes[bus];
  }

  getVolumes(): Record<BusName, number> {
    return { ...this.volumes };
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolumes(0.12);
    this.persist();
  }

  isMuted(): boolean {
    return this.muted;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: this.volumes, muted: this.muted } satisfies Persisted));
    } catch {
      /* storage unavailable — settings are session-only */
    }
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const room = this.sends.get('room');
    const hall = this.sends.get('hall');
    const scale = q === 'low' ? 0.45 : q === 'mid' ? 0.8 : 1;
    if (this.ctx) {
      const t = this.ctx.currentTime;
      room?.gain.setTargetAtTime(scale, t, 0.08);
      hall?.gain.setTargetAtTime(scale, t, 0.08);
    }
  }

  // ── ducking ──────────────────────────────────────────────────────────

  /**
   * Sidechain dip on the music leg. `amount` 0..1 is how far down it goes
   * (1 = fully out of the way); `ms` is the hold before it climbs back.
   */
  duck(amount: number, ms: number): void {
    const ctx = this.ctx;
    const duck = this.duckGain;
    if (!ctx || !duck) return;
    const t = ctx.currentTime;
    const depth = clamp(1 - clamp(amount, 0, 1) * 0.92, 0.08, 1);
    const hold = clamp(ms, 60, 6000) / 1000;
    duck.gain.cancelScheduledValues(t);
    duck.gain.setValueAtTime(Math.min(duck.gain.value, 1), t);
    duck.gain.linearRampToValueAtTime(depth, t + 0.045);
    duck.gain.setValueAtTime(depth, t + hold);
    duck.gain.linearRampToValueAtTime(1, t + hold + 0.55);
  }

  // ── strips ───────────────────────────────────────────────────────────

  /** Bus input node, for long-lived sources (music beds, ambience). */
  busInput(name: Exclude<BusName, 'master'>): GainNode | null {
    return this.busGains.get(name) ?? null;
  }

  /** Music-only plate send input. */
  musicSendInput(): GainNode | null {
    return this.musicSend;
  }

  /**
   * Allocates a channel strip for a single cue. Returns null when audio is
   * not running or the voice budget is spent — every cue therefore
   * degrades to a silent no-op instead of throwing.
   */
  strip(opts: StripOpts = {}): Strip | null {
    const ctx = this.ctx;
    const synth = this.synth;
    if (!ctx || !synth || !this.live) return null;
    if (this.voices >= MAX_VOICES[this.quality]) return null;

    const busName = opts.bus ?? 'sfx';
    const bus = this.busGains.get(busName);
    if (!bus) return null;

    const input = ctx.createGain();
    input.gain.value = opts.gain ?? 1;

    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(opts.pan ?? 0, -1, 1);
    input.connect(pan);

    let tail: AudioNode = pan;
    let widener: { disconnect(): void } | null = null;
    if (opts.width !== undefined && opts.width !== 1 && this.quality !== 'low') {
      // Costs a dozen nodes, so only hero cues ask for it.
      const w = stereoWidener(ctx, opts.width);
      pan.connect(w.input);
      tail = w.output;
      widener = w;
    }
    tail.connect(bus);

    const qScale = this.quality === 'low' ? 0.4 : this.quality === 'mid' ? 0.8 : 1;
    const sendNodes: GainNode[] = [];
    for (const name of ['room', 'hall'] as const) {
      const level = name === 'room' ? opts.room : opts.hall;
      if (!level || level <= 0) continue;
      const dest = this.sends.get(name);
      if (!dest) continue;
      const s = ctx.createGain();
      s.gain.value = level * qScale;
      tail.connect(s);
      s.connect(dest);
      sendNodes.push(s);
    }

    this.voices++;
    let released = false;
    const strip: Strip = {
      ctx,
      synth,
      input,
      t: ctx.currentTime,
      done: (endTime: number) => {
        if (released) return;
        released = true;
        const ms = Math.max(0, (endTime - ctx.currentTime) * 1000) + 90;
        window.setTimeout(() => {
          this.voices = Math.max(0, this.voices - 1);
          try {
            input.disconnect();
            pan.disconnect();
            for (const s of sendNodes) s.disconnect();
            widener?.disconnect();
          } catch {
            /* already gone */
          }
        }, Math.min(ms, 20000));
      },
    };
    return strip;
  }

  /**
   * Post-limiter analyser, created on first request. Lets the settings
   * screen show a live output meter — and proves to the player that the
   * app is making sound when their phone is on silent.
   */
  meter(): AnalyserNode | null {
    if (this.meterNode) return this.meterNode;
    if (!this.ctx || !this.limiterNode) return null;
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.6;
    this.limiterNode.connect(an);
    this.meterNode = an;
    return an;
  }

  /** Peak output level 0..1 since the previous call. For meters. */
  outputPeak(): number {
    const an = this.meter();
    if (!an) return 0;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = buf[i] < 0 ? -buf[i] : buf[i];
      if (a > peak) peak = a;
    }
    return peak;
  }

  /** Emergency stop used by the settings screen's "mute everything" affordance. */
  panic(): void {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, t);
    this.masterGain.gain.linearRampToValueAtTime(0, t + 0.04);
    window.setTimeout(() => this.applyVolumes(0.25), 220);
  }
}

/** The one mixer. Everything else in `src/audio` talks to this instance. */
export const mixer = new Mixer();
