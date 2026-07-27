/**
 * ROYALE — fx/engine.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The runtime every DOM effect in the app rides on.
 *
 * Design notes, because the constraints here are unusual:
 *
 *  • ONE requestAnimationFrame loop for the whole app's FX. Confetti, coin
 *    arcs, screen shake, timed callbacks and interval sweeps are all steps of
 *    the same tick, so we never pay for a second scheduler and effects stay
 *    frame-coherent with each other.
 *  • DOM nodes are POOLED, never created per particle. A burst of 180 pieces
 *    on the second showdown of a session allocates zero elements. Pooled nodes
 *    are detached, so they hold no layer and cost nothing while idle.
 *  • The per-frame write set is `style.transform` + `style.opacity` only.
 *    Nothing in the loop reads layout, so there is no forced reflow anywhere.
 *  • A hard global budget (60 / 120 / 240 by perf tier) is enforced at spawn
 *    time. When a burst would exceed it, low-weight veterans are retired so
 *    the *newest, most meaningful* effect is always the one you see.
 *
 * Why DOM and not canvas: see the header of `confetti.ts` — short version is
 * that these counts composite better as tiny GPU layers than as a full-screen
 * DPR-3 surface we would have to clear and repaint every single frame.
 */

// ─────────────────────────── public types ───────────────────────────

export type PerfTier = 'low' | 'mid' | 'high';

/** Every particle look the CSS layer knows how to draw. All procedural. */
export type FxSprite =
  | 'dot'
  | 'spark'
  | 'streak'
  | 'confetti'
  | 'ribbon'
  | 'chip'
  | 'coin'
  | 'gem'
  | 'star'
  | 'ring'
  | 'glow';

export type FxBlend = 'normal' | 'screen' | 'plus';

export interface FxPoint {
  x: number;
  y: number;
}

export type ParticleUpdate = (p: Particle, dt: number, t: number) => boolean;

/**
 * A live particle. Structs are pooled alongside their element, so the fields
 * are plain numbers and the whole thing is reset on acquire — no allocation
 * happens once the pool has warmed.
 */
export interface Particle {
  el: HTMLElement;
  sprite: FxSprite;
  /** centre position, CSS px, viewport space */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** constant acceleration (gravity / wind), px·s⁻² */
  ax: number;
  ay: number;
  /** exponential velocity damping, per second */
  drag: number;
  /** vertical speed cap, px·s⁻¹ (0 = uncapped) */
  terminal: number;
  rot: number;
  vrot: number;
  rx: number;
  ry: number;
  vrx: number;
  vry: number;
  tumble: boolean;
  scale: number;
  scaleTo: number;
  alpha: number;
  fadeIn: number;
  fadeOut: number;
  age: number;
  life: number;
  /** lateral sway amplitude (paper flutter), px·s⁻¹ */
  flutter: number;
  flutterHz: number;
  phase: number;
  /** half-extent offsets so `x,y` means centre */
  ox: number;
  oy: number;
  /** retirement priority — low values are recycled first under pressure */
  weight: number;
  /** kill once fully outside the viewport */
  cull: boolean;
  /** pooled scratch for custom integrators; never reallocated */
  data: number[];
  update: ParticleUpdate | null;
  done: ((p: Particle) => void) | null;
}

export interface EmitSpec {
  count: number;
  origin: FxPoint;
  /** random radius around the origin, px */
  originSpread?: number;
  /** emission direction, radians. −π/2 is straight up. Omit for full circle. */
  angle?: number;
  /** half-cone around `angle`, radians */
  spread?: number;
  /** initial speed, px·s⁻¹ */
  speed?: number;
  /** ± fraction of `speed`, 0..1 */
  speedVar?: number;
  /** downward acceleration, px·s⁻² */
  gravity?: number;
  /** horizontal acceleration, px·s⁻² */
  wind?: number;
  /** exponential damping per second; 0 = frictionless, 3 ≈ heavy air */
  drag?: number;
  /** terminal fall speed, px·s⁻¹ */
  terminal?: number;
  /** seconds */
  life?: number;
  /** ± fraction of `life`, 0..1 */
  lifeVar?: number;
  scale?: number;
  scaleVar?: number;
  /** scale multiplier reached at end of life */
  scaleTo?: number;
  /** z-rotation speed, deg·s⁻¹ */
  spin?: number;
  spinVar?: number;
  /** enable rotateX/rotateY tumbling (paper, coins) */
  tumble?: boolean;
  /** tumble rate, deg·s⁻¹ */
  tumbleRate?: number;
  /** lateral sway amplitude, px·s⁻¹ */
  flutter?: number;
  /** sway frequency, Hz */
  flutterHz?: number;
  /** one colour, or a palette sampled per particle */
  color?: string | readonly string[];
  /** optional second colour (confetti backface, gem facet) */
  color2?: string | readonly string[];
  sprite?: FxSprite;
  blend?: FxBlend;
  /** seconds of opacity ramp-in */
  fadeIn?: number;
  /** fraction of life spent fading out, 0..1 */
  fadeOut?: number;
  /** px, overrides the sprite's natural size */
  size?: number;
  /** width/height ratio for rectangular sprites */
  aspect?: number;
  sizeVar?: number;
  weight?: number;
  cull?: boolean;
  /** spawn ramp — particle i starts `stagger * i` seconds late */
  stagger?: number;
  update?: ParticleUpdate;
  onSpawn?: (p: Particle, i: number, count: number) => void;
}

export interface FxStats {
  live: number;
  pooled: number;
  tasks: number;
  tier: PerfTier;
  budget: number;
}

// ─────────────────────────── small utilities ───────────────────────────

const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cheap uniform. Cosmetic only — the seeded Rng is reserved for gameplay. */
function rand(): number {
  return Math.random();
}

function rangeOf(min: number, max: number): number {
  return min + rand() * (max - min);
}

function pick<T>(list: readonly T[]): T {
  return list[(rand() * list.length) | 0];
}

const easings = {
  outCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number): number => t * t * t,
  outQuint: (t: number): number => 1 - Math.pow(1 - t, 5),
  inOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number): number => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2),
  outElastic: (t: number): number =>
    t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
};
export const ease = easings;

// ─────────────────────────── design tokens ───────────────────────────

let rootStyle: CSSStyleDeclaration | null = null;
const tokenCache = new Map<string, string>();

/**
 * Reads a design token from `tokens.css`. Cached — the FX layer never mutates
 * tokens, so one read per name for the lifetime of the page is correct.
 * The fallback keeps effects on-brand if a burst somehow fires before the
 * stylesheet has landed (first frame of a cold boot).
 */
export function token(name: string, fallback: string): string {
  const hit = tokenCache.get(name);
  if (hit !== undefined) return hit;
  let value = fallback;
  if (typeof document !== 'undefined') {
    if (!rootStyle) rootStyle = getComputedStyle(document.documentElement);
    const read = rootStyle.getPropertyValue(name).trim();
    if (read) value = read;
  }
  tokenCache.set(name, value);
  return value;
}

// ─────────────────────────── reduced motion ───────────────────────────

let reducedMq: MediaQueryList | null = null;
let reduced = false;
if (typeof matchMedia === 'function') {
  reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  reduced = reducedMq.matches;
  const onChange = (): void => {
    reduced = reducedMq!.matches;
    if (reduced) engine.clear();
  };
  if (reducedMq.addEventListener) reducedMq.addEventListener('change', onChange);
  else reducedMq.addListener(onChange);
}

/** True when the user has asked the OS to cut animation. Honour it everywhere. */
export function reduceMotion(): boolean {
  return reduced;
}

// ─────────────────────────── layers ───────────────────────────

/**
 * Fixed paint order inside `#fx-root`. Declaring the stack up front means no
 * effect ever has to guess a z-index, and the layers themselves are created
 * lazily so a session that never celebrates never builds them.
 */
export type FxLayerName = 'dim' | 'particles' | 'coins' | 'text' | 'banner' | 'screen';

const LAYER_ORDER: FxLayerName[] = ['dim', 'particles', 'coins', 'text', 'banner', 'screen'];

// ─────────────────────────── the engine ───────────────────────────

const BUDGET: Record<PerfTier, number> = { low: 60, mid: 120, high: 240 };
/** Emit counts are scaled before the hard cap, so bursts stay shaped, not clipped. */
const DENSITY: Record<PerfTier, number> = { low: 0.45, mid: 0.75, high: 1 };

interface Task {
  fn: (dt: number, now: number) => boolean;
  dead: boolean;
}

/** Natural pixel size per sprite: [width, height]. Overridable per emit. */
const SPRITE_SIZE: Record<FxSprite, [number, number]> = {
  dot: [7, 7],
  spark: [4, 4],
  streak: [3, 16],
  confetti: [9, 13],
  ribbon: [7, 20],
  chip: [16, 16],
  coin: [15, 15],
  gem: [14, 14],
  star: [15, 15],
  ring: [26, 26],
  glow: [40, 40],
};

class FxEngine {
  root: HTMLElement | null = null;
  tier: PerfTier = 'mid';
  budget = BUDGET.mid;
  density = DENSITY.mid;

  private layers = new Map<FxLayerName, HTMLElement>();
  private live: Particle[] = [];
  private pool = new Map<FxSprite, Particle[]>();
  private pooledCount = 0;
  private tasks: Task[] = [];
  private raf = 0;
  private last = 0;
  private running = false;
  private vw = 0;
  private vh = 0;

  // ── lifecycle ────────────────────────────────────────────────

  init(root: HTMLElement): void {
    if (this.root === root) return;
    this.root = root;
    root.classList.add('fx-root');
    this.layers.clear();
    this.measure();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize, { passive: true });
      window.addEventListener('orientationchange', this.onResize, { passive: true });
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.publishStats();
  }

  private onResize = (): void => {
    this.measure();
  };

  /**
   * A backgrounded tab freezes rAF; on return the first dt would be huge and
   * every live particle would teleport. Dropping them is both cheaper and more
   * honest than clamping — the celebration is over, the user missed it.
   */
  private onVisibility = (): void => {
    if (document.hidden) this.clear();
  };

  private measure(): void {
    if (typeof window === 'undefined') return;
    const r = this.root?.getBoundingClientRect();
    this.vw = r && r.width > 0 ? r.width : window.innerWidth;
    this.vh = r && r.height > 0 ? r.height : window.innerHeight;
  }

  viewport(): { w: number; h: number } {
    if (this.vw === 0) this.measure();
    return { w: this.vw, h: this.vh };
  }

  setTier(tier: PerfTier): void {
    this.tier = tier;
    this.budget = BUDGET[tier];
    this.density = DENSITY[tier];
    // Shrink to the new ceiling immediately rather than waiting for attrition.
    while (this.live.length > this.budget) this.retireWeakest();
    this.publishStats();
  }

  // ── layers ───────────────────────────────────────────────────

  layer(name: FxLayerName): HTMLElement {
    let el = this.layers.get(name);
    if (el && el.isConnected) return el;
    const host = this.host();
    el = document.createElement('div');
    el.className = `fx-layer fx-layer--${name}`;
    el.style.zIndex = String(LAYER_ORDER.indexOf(name) + 1);
    // Keep the stack ordered even though layers are created on demand.
    const mine = LAYER_ORDER.indexOf(name);
    let before: HTMLElement | null = null;
    for (const other of LAYER_ORDER) {
      if (LAYER_ORDER.indexOf(other) <= mine) continue;
      const cand = this.layers.get(other);
      if (cand && cand.isConnected) {
        before = cand;
        break;
      }
    }
    host.insertBefore(el, before);
    this.layers.set(name, el);
    return el;
  }

  host(): HTMLElement {
    if (this.root && this.root.isConnected) return this.root;
    const found = typeof document !== 'undefined' ? document.getElementById('fx-root') : null;
    if (found) {
      if (this.root !== found) this.init(found);
      return found;
    }
    // Last resort so an effect fired during boot still has somewhere to live.
    const made = document.createElement('div');
    made.id = 'fx-root';
    made.setAttribute('aria-hidden', 'true');
    document.body.appendChild(made);
    this.init(made);
    return made;
  }

  // ── pooling ──────────────────────────────────────────────────

  private make(sprite: FxSprite): Particle {
    const el = document.createElement('i');
    el.className = `fx-p fx-p--${sprite}`;
    return {
      el,
      sprite,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      drag: 0,
      terminal: 0,
      rot: 0,
      vrot: 0,
      rx: 0,
      ry: 0,
      vrx: 0,
      vry: 0,
      tumble: false,
      scale: 1,
      scaleTo: 1,
      alpha: 1,
      fadeIn: 0,
      fadeOut: 0.25,
      age: 0,
      life: 1,
      flutter: 0,
      flutterHz: 0,
      phase: 0,
      ox: 0,
      oy: 0,
      weight: 1,
      cull: true,
      data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      update: null,
      done: null,
    };
  }

  private acquire(sprite: FxSprite): Particle {
    const bucket = this.pool.get(sprite);
    const p = bucket && bucket.length ? bucket.pop()! : this.make(sprite);
    p.x = p.y = p.vx = p.vy = p.ax = p.ay = 0;
    p.drag = 0;
    p.terminal = 0;
    p.rot = p.vrot = p.rx = p.ry = p.vrx = p.vry = 0;
    p.tumble = false;
    p.scale = 1;
    p.scaleTo = 1;
    p.alpha = 1;
    p.fadeIn = 0;
    p.fadeOut = 0.25;
    p.age = 0;
    p.life = 1;
    p.flutter = 0;
    p.flutterHz = 0;
    p.phase = 0;
    p.weight = 1;
    p.cull = true;
    p.update = null;
    p.done = null;
    return p;
  }

  private release(p: Particle): void {
    const el = p.el;
    if (el.parentNode) el.parentNode.removeChild(el);
    el.style.transform = '';
    el.style.opacity = '';
    el.style.mixBlendMode = '';
    p.update = null;
    p.done = null;
    let bucket = this.pool.get(p.sprite);
    if (!bucket) {
      bucket = [];
      this.pool.set(p.sprite, bucket);
    }
    // Cap the pool so a one-off 240-piece royal-flush shower does not pin
    // hundreds of elements in memory for the rest of the session.
    if (bucket.length < 64) bucket.push(p);
  }

  /** Recycle the least important live particle to make room for a new one. */
  private retireWeakest(): void {
    if (!this.live.length) return;
    let worst = 0;
    let worstScore = Infinity;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      // Older + lighter dies first.
      const score = p.weight * 100 - (p.age / p.life) * 100;
      if (score < worstScore) {
        worstScore = score;
        worst = i;
      }
    }
    const p = this.live[worst];
    this.live[worst] = this.live[this.live.length - 1];
    this.live.pop();
    this.release(p);
  }

  budgetLeft(): number {
    return Math.max(0, this.budget - this.live.length);
  }

  // ── spawning ─────────────────────────────────────────────────

  /**
   * Low-level spawn. Returns null when the budget is exhausted and nothing was
   * worth retiring. Callers that want shaping should use `emit`.
   */
  spawn(sprite: FxSprite, x: number, y: number, layer: FxLayerName = 'particles'): Particle | null {
    if (this.live.length >= this.budget) {
      this.retireWeakest();
      if (this.live.length >= this.budget) return null;
    }
    const p = this.acquire(sprite);
    p.x = x;
    p.y = y;
    const [w, h] = SPRITE_SIZE[sprite];
    p.ox = -w / 2;
    p.oy = -h / 2;
    p.el.style.width = `${w}px`;
    p.el.style.height = `${h}px`;
    this.layer(layer).appendChild(p.el);
    this.live.push(p);
    // Place it before the browser can paint it at 0,0 — the caller may still
    // adjust it, but a freshly attached node is never seen in the wrong spot.
    this.write(p, 0);
    this.start();
    return p;
  }

  /** Resize a particle after spawn, keeping `x,y` centred. */
  sizeOf(p: Particle, w: number, h: number): void {
    p.ox = -w / 2;
    p.oy = -h / 2;
    p.el.style.width = `${w}px`;
    p.el.style.height = `${h}px`;
  }

  emit(spec: EmitSpec, layer: FxLayerName = 'particles'): number {
    if (reduced) return 0;
    const sprite = spec.sprite ?? 'dot';
    const wanted = Math.max(0, Math.round(spec.count * this.density));
    if (wanted <= 0) return 0;
    const count = Math.min(wanted, this.budget);

    const life = spec.life ?? 1.2;
    const lifeVar = spec.lifeVar ?? 0.3;
    const speed = spec.speed ?? 220;
    const speedVar = spec.speedVar ?? 0.4;
    const baseScale = spec.scale ?? 1;
    const scaleVar = spec.scaleVar ?? 0.25;
    const spin = spec.spin ?? 0;
    const spinVar = spec.spinVar ?? 1;
    const spread = spec.spread ?? Math.PI;
    const angle = spec.angle ?? -Math.PI / 2;
    const full = spec.angle === undefined && spec.spread === undefined;
    const colors = spec.color === undefined ? null : Array.isArray(spec.color) ? spec.color : [spec.color as string];
    const colors2 =
      spec.color2 === undefined ? null : Array.isArray(spec.color2) ? spec.color2 : [spec.color2 as string];
    const [natW, natH] = SPRITE_SIZE[sprite];
    const aspect = spec.aspect ?? natW / natH;
    const sizeVar = spec.sizeVar ?? 0;

    let made = 0;
    for (let i = 0; i < count; i++) {
      const a = full ? rand() * TAU : angle + (rand() * 2 - 1) * spread;
      let ox = 0;
      let oy = 0;
      if (spec.originSpread) {
        const ra = rand() * TAU;
        const rr = Math.sqrt(rand()) * spec.originSpread;
        ox = Math.cos(ra) * rr;
        oy = Math.sin(ra) * rr;
      }
      const p = this.spawn(sprite, spec.origin.x + ox, spec.origin.y + oy, layer);
      if (!p) break;
      made++;

      const sp = speed * (1 + (rand() * 2 - 1) * speedVar);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.ax = spec.wind ?? 0;
      p.ay = spec.gravity ?? 0;
      p.drag = spec.drag ?? 0;
      p.terminal = spec.terminal ?? 0;
      p.life = Math.max(0.05, life * (1 + (rand() * 2 - 1) * lifeVar));
      p.age = spec.stagger ? -spec.stagger * i : 0;
      p.scale = baseScale * (1 + (rand() * 2 - 1) * scaleVar);
      p.scaleTo = spec.scaleTo ?? 1;
      p.fadeIn = spec.fadeIn ?? 0;
      p.fadeOut = spec.fadeOut ?? 0.3;
      p.vrot = spin * (1 + (rand() * 2 - 1) * spinVar);
      p.rot = rand() * 360;
      p.weight = spec.weight ?? 1;
      p.cull = spec.cull ?? true;
      p.update = spec.update ?? null;
      p.flutter = spec.flutter ?? 0;
      p.flutterHz = spec.flutterHz ?? 1.4;
      p.phase = rand() * TAU;

      if (spec.tumble) {
        p.tumble = true;
        const rate = spec.tumbleRate ?? 420;
        p.vrx = (rand() * 2 - 1) * rate;
        p.vry = (rand() * 2 - 1) * rate;
        p.rx = rand() * 360;
        p.ry = rand() * 360;
      }

      if (spec.size || sizeVar) {
        const s = (spec.size ?? natH) * (1 + (rand() * 2 - 1) * sizeVar);
        this.sizeOf(p, Math.max(2, s * aspect), Math.max(2, s));
      }

      const style = p.el.style;
      if (colors) style.setProperty('--fx-c', pick(colors));
      if (colors2) style.setProperty('--fx-c2', pick(colors2));
      if (spec.blend && spec.blend !== 'normal') {
        style.mixBlendMode = spec.blend === 'plus' ? 'plus-lighter' : 'screen';
      }
      // First frame placed before paint so nothing pops in at 0,0.
      this.write(p, 0);
      spec.onSpawn?.(p, i, count);
    }
    this.publishStats();
    return made;
  }

  // ── tasks ────────────────────────────────────────────────────

  /** Per-frame callback on the shared clock. Return false to unsubscribe. */
  track(fn: (dt: number, now: number) => boolean): () => void {
    const task: Task = { fn, dead: false };
    this.tasks.push(task);
    this.start();
    return () => {
      task.dead = true;
    };
  }

  /** rAF-clock timeout — pauses with the tab instead of firing in a batch. */
  after(ms: number, fn: () => void): () => void {
    let left = ms / 1000;
    return this.track((dt) => {
      left -= dt;
      if (left > 0) return true;
      fn();
      return false;
    });
  }

  /** rAF-clock interval. */
  every(ms: number, fn: () => void): () => void {
    const period = ms / 1000;
    let left = period;
    return this.track((dt) => {
      left -= dt;
      while (left <= 0) {
        fn();
        left += period;
      }
      return true;
    });
  }

  // ── loop ─────────────────────────────────────────────────────

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    const dt = this.last === 0 ? 1 / 60 : Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    const live = this.live;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i];
      if (!this.step(p, dt)) {
        live[i] = live[live.length - 1];
        live.pop();
        p.done?.(p);
        this.release(p);
      }
    }

    const tasks = this.tasks;
    let w = 0;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.dead) continue;
      let keep = true;
      try {
        keep = t.fn(dt, now);
      } catch (err) {
        console.error('[fx] task failed', err);
        keep = false;
      }
      if (keep && !t.dead) tasks[w++] = t;
    }
    tasks.length = w;

    this.publishStats();

    if (live.length || tasks.length) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.running = false;
      this.raf = 0;
    }
  };

  /** Integrate one particle. Returns false when it should die. */
  private step(p: Particle, dt: number): boolean {
    p.age += dt;
    if (p.age < 0) {
      // Staggered spawn: hold invisible until its slot comes up.
      p.el.style.opacity = '0';
      return true;
    }
    if (p.age >= p.life) return false;

    if (p.update && !p.update(p, dt, p.age / p.life)) return false;

    if (!p.update) {
      p.vx += p.ax * dt;
      p.vy += p.ay * dt;
      if (p.drag) {
        const f = Math.exp(-p.drag * dt);
        p.vx *= f;
        p.vy *= f;
      }
      if (p.terminal && p.vy > p.terminal) p.vy = p.terminal;

      let sway = 0;
      if (p.flutter) {
        p.phase += p.flutterHz * TAU * dt;
        // Paper flutters hardest when broadside; project the sway through the
        // current tumble so the drift and the spin read as one motion.
        const broad = p.tumble ? Math.abs(Math.cos((p.ry * Math.PI) / 180)) : 1;
        sway = Math.sin(p.phase) * p.flutter * (0.35 + 0.65 * broad);
      }
      p.x += (p.vx + sway) * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      if (p.tumble) {
        p.rx += p.vrx * dt;
        p.ry += p.vry * dt;
      }
    }

    if (p.cull) {
      const m = 64;
      if (p.y > this.vh + m || p.y < -m * 3 || p.x < -m || p.x > this.vw + m) return false;
    }

    this.write(p, p.age / p.life);
    return true;
  }

  /**
   * The only DOM write in the hot path: one transform string and one opacity.
   * Values are rounded so the compositor gets stable, short strings.
   */
  private write(p: Particle, t: number): void {
    const s = p.scale * (p.scaleTo === 1 ? 1 : lerp(1, p.scaleTo, t));
    let tr = 'translate3d(';
    tr += (p.x + p.ox).toFixed(1);
    tr += 'px,';
    tr += (p.y + p.oy).toFixed(1);
    tr += 'px,0)';
    if (p.rot) {
      tr += ' rotate(';
      tr += p.rot.toFixed(1);
      tr += 'deg)';
    }
    if (p.tumble) {
      tr += ' rotateX(';
      tr += p.rx.toFixed(0);
      tr += 'deg) rotateY(';
      tr += p.ry.toFixed(0);
      tr += 'deg)';
    }
    if (s !== 1) {
      tr += ' scale(';
      tr += s.toFixed(3);
      tr += ')';
    }
    p.el.style.transform = tr;

    let a = p.alpha;
    if (p.fadeIn > 0 && p.age < p.fadeIn) a *= p.age / p.fadeIn;
    if (p.fadeOut > 0 && t > 1 - p.fadeOut) a *= (1 - t) / p.fadeOut;
    if (a <= 0) a = 0;
    p.el.style.opacity = a >= 0.999 ? '1' : a.toFixed(3);
  }

  // ── teardown ─────────────────────────────────────────────────

  clear(): void {
    for (const p of this.live) this.release(p);
    this.live.length = 0;
    for (const t of this.tasks) t.dead = true;
    this.tasks.length = 0;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
    this.publishStats();
  }

  /** Drops pooled nodes too. Used by teardown in tests / hot reload. */
  destroy(): void {
    this.clear();
    for (const [, bucket] of this.pool) bucket.length = 0;
    this.pool.clear();
    this.pooledCount = 0;
    for (const [, el] of this.layers) el.remove();
    this.layers.clear();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('orientationchange', this.onResize);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    this.root = null;
    this.publishStats();
  }

  stats(): FxStats {
    let pooled = 0;
    for (const [, bucket] of this.pool) pooled += bucket.length;
    this.pooledCount = pooled;
    return { live: this.live.length, pooled, tasks: this.tasks.length, tier: this.tier, budget: this.budget };
  }

  private statsOut: FxStats = { live: 0, pooled: 0, tasks: 0, tier: 'mid', budget: BUDGET.mid };

  /**
   * `window.__fxStats` is the contract the perf harness reads. It is mutated
   * in place (no allocation per frame) and always reflects the true node
   * census: `live` is exactly the number of particle elements attached under
   * `#fx-root`, `pooled` exactly the number parked detached.
   */
  private publishStats(): void {
    let pooled = 0;
    for (const [, bucket] of this.pool) pooled += bucket.length;
    this.pooledCount = pooled;
    const s = this.statsOut;
    s.live = this.live.length;
    s.pooled = pooled;
    s.tasks = this.tasks.length;
    s.tier = this.tier;
    s.budget = this.budget;
    if (typeof window !== 'undefined') {
      (window as unknown as { __fxStats: FxStats }).__fxStats = s;
    }
  }
}

export const engine = new FxEngine();

// ─────────────────────────── geometry helpers ───────────────────────────

/** Resolve an element, a selector or a point to viewport coordinates. */
export function pointOf(target: FxPoint | Element | string | null | undefined, fallback?: FxPoint): FxPoint {
  if (!target) return fallback ?? centreOfScreen();
  if (typeof target === 'string') {
    const el = document.querySelector(target);
    return el ? (rectCentre(el) ?? fallback ?? centreOfScreen()) : (fallback ?? centreOfScreen());
  }
  if (target instanceof Element) return rectCentre(target) ?? fallback ?? centreOfScreen();
  return target;
}

/**
 * Centre of an element in viewport coordinates, or null when the element is
 * detached / display:none — an all-zero rect would otherwise fling an effect
 * into the top-left corner, which is the classic "why is my confetti in the
 * corner" bug.
 */
export function rectCentre(el: Element): FxPoint | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function centreOfScreen(): FxPoint {
  const { w, h } = engine.viewport();
  return { x: w / 2, y: h / 2 };
}

/** First matching element for any of the selectors, or null. */
export function queryAny(...selectors: string[]): HTMLElement | null {
  for (const s of selectors) {
    const el = document.querySelector<HTMLElement>(s);
    if (el && el.isConnected) return el;
  }
  return null;
}

export { rand, rangeOf, pick, TAU };
