/**
 * GPU particle systems.
 *
 * Every particle's whole life is a closed-form function of time, evaluated in
 * the vertex shader: position, drag, gravity, spin, fade and size all fall
 * out of `uTime - birth`. The CPU touches a particle exactly once, when it is
 * emitted. There is no per-frame allocation, no simulation loop and no
 * readback — a two-thousand-particle bomb-pot explosion costs one uniform
 * write per frame.
 *
 * Two draw calls carry everything:
 *   • an ADDITIVE points cloud for sparks, gold dust, shimmer and embers
 *   • an ALPHA points cloud for confetti, which needs to occlude, tumble
 *     and darken on its back face like real paper
 * plus a tiny pool of expanding shockwave rings for all-ins and bomb pots.
 *
 * Driven by the `fx:burst` bus event. Counts halve on the low perf tier.
 */
import * as THREE from 'three';
import { bus, type FxBurstKind } from '../core/bus.ts';

// ═══════════════════════════════════════════════════════════════════
// ADAPTER — the only coupling to sibling render modules.
// ═══════════════════════════════════════════════════════════════════
import { layout } from './table.ts';
import type { PerfTier } from './renderer.ts';

const POT_CENTER: THREE.Vector3 = layout.POT_CENTER ?? new THREE.Vector3(0, 0, 0.24);
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────── shaders ───────────────────────────

const POINTS_VERT = /* glsl */ `
uniform float uTime;
uniform float uPixel;
uniform float uFade;

attribute vec3 aVel;
attribute vec3 aTint;
attribute vec4 aLife;   // x birth · y lifetime · z size · w seed
attribute vec3 aPhys;   // x gravity · y drag · z spin

varying vec3  vTint;
varying float vAlpha;
varying float vSpin;
varying float vSeed;

void main() {
  float age = uTime - aLife.x;
  float lt  = max(aLife.y, 0.0001);

  if (age < 0.0 || age > lt) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }

  float u = age / lt;

  // exact integral of exponential drag, so the launch reads as a snap and
  // the tail as a float — a linear velocity never does both
  float k  = aPhys.y;
  float ex = k > 0.001 ? (1.0 - exp(-k * age)) / k : age;
  vec3 p = position + aVel * ex;
  p.y -= 0.5 * aPhys.x * age * age;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  // in for 8% of life, out on a curve that keeps a bright core the longest
  float fadeIn  = smoothstep(0.0, 0.08, u);
  float fadeOut = pow(1.0 - u, 1.35);
  vAlpha = fadeIn * fadeOut * uFade;

  float grow = 1.0 + 0.35 * smoothstep(0.0, 0.25, u) - 0.5 * smoothstep(0.35, 1.0, u);
  gl_PointSize = aLife.z * grow * projectionMatrix[1][1] * uPixel * 0.5 / max(0.001, -mv.z);
  gl_PointSize = clamp(gl_PointSize, 0.0, 128.0);

  vTint = aTint;
  vSpin = aPhys.z * age + aLife.w * 6.2831;
  vSeed = aLife.w;
  gl_Position = projectionMatrix * mv;
}
`;

const SPARK_FRAG = /* glsl */ `
varying vec3  vTint;
varying float vAlpha;
varying float vSpin;
varying float vSeed;

void main() {
  if (vAlpha <= 0.002) discard;
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  // soft body plus a hot core: one falloff reads as a blob, two as a spark
  float body = smoothstep(0.5, 0.06, d);
  float core = pow(smoothstep(0.34, 0.0, d), 2.4);
  // a faint four-point star sells the specular glint at almost no cost
  float star = pow(max(0.0, 1.0 - abs(c.x * c.y) * 42.0), 6.0) * smoothstep(0.5, 0.1, d);
  float a = body * 0.7 + core * 0.9 + star * 0.35;
  gl_FragColor = vec4(vTint * (0.85 + core * 1.5), a * vAlpha);
}
`;

const CONFETTI_FRAG = /* glsl */ `
varying vec3  vTint;
varying float vAlpha;
varying float vSpin;
varying float vSeed;

void main() {
  if (vAlpha <= 0.004) discard;
  vec2 c = gl_PointCoord - 0.5;
  float s = sin(vSpin);
  float k = cos(vSpin);
  vec2 r = vec2(c.x * k - c.y * s, c.x * s + c.y * k);
  // the horizontal squash is the flutter: the slip turns edge-on and back
  float squash = abs(cos(vSpin * 0.73 + vSeed * 5.0));
  r.x /= max(0.12, squash);
  if (abs(r.x) > 0.34 || abs(r.y) > 0.5) discard;
  // shade the back face darker so the tumble reads
  float face = cos(vSpin * 0.73 + vSeed * 5.0) > 0.0 ? 1.0 : 0.55;
  float edge = 1.0 - smoothstep(0.42, 0.5, abs(r.y));
  gl_FragColor = vec4(vTint * face * (0.72 + 0.4 * edge), vAlpha);
}
`;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uProgress;
uniform float uAlpha;
varying vec2 vUv;

void main() {
  float d = length(vUv - 0.5) * 2.0;
  float r = uProgress;
  float w = mix(0.06, 0.3, uProgress);
  // a hard leading edge with a long trailing wash — a real shock front
  float lead = 1.0 - smoothstep(r, r + 0.045, d);
  float tail = smoothstep(r - w, r, d);
  float ring = lead * tail;
  float glow = pow(max(0.0, 1.0 - abs(d - r) / (w * 2.2)), 2.5) * 0.4;
  float a = (ring + glow) * uAlpha * (1.0 - smoothstep(0.86, 1.0, d));
  if (a <= 0.003) discard;
  gl_FragColor = vec4(uColor * (1.0 + ring * 1.6), a);
}
`;

// ─────────────────────────── palettes ───────────────────────────

const C_GOLD = new THREE.Color('#edc96b');
const C_GOLD_HI = new THREE.Color('#fdf3d0');
const C_GOLD_DEEP = new THREE.Color('#c08d21');
const C_WHITE = new THREE.Color('#f7f9fd');
const C_EMERALD = new THREE.Color('#34d399');
const C_BLUE = new THREE.Color('#3d8bfd');
const C_RED = new THREE.Color('#e5484d');
const C_EPIC = new THREE.Color('#a78bfa');
const C_CLAY = new THREE.Color('#c8ccd6');

const CONFETTI_PALETTE = [C_GOLD, C_GOLD_HI, C_WHITE, C_EMERALD, C_BLUE, C_RED, C_EPIC];

// ─────────────────────────── emitter spec ───────────────────────────

export interface EmitSpec {
  count: number;
  /** metres of random jitter applied to the spawn point */
  spread: number;
  /** radial speed range, m/s */
  speed: [number, number];
  /** additional upward bias, m/s */
  lift: [number, number];
  life: [number, number];
  /** world-space size, pre-perspective */
  size: [number, number];
  gravity: number;
  drag: number;
  spin: number;
  colors: THREE.Color[];
  /** 0 = a flat disc of directions, 1 = a full sphere */
  dome: number;
  confetti?: boolean;
}

const PRESETS: Record<string, EmitSpec> = {
  spark: {
    count: 34,
    spread: 0.018,
    speed: [0.35, 1.15],
    lift: [0.25, 0.75],
    life: [0.36, 0.72],
    size: [0.012, 0.03],
    gravity: 2.6,
    drag: 5.2,
    spin: 0,
    colors: [C_GOLD, C_GOLD_HI, C_CLAY],
    dome: 0.75,
  },
  dust: {
    count: 80,
    spread: 0.06,
    speed: [0.06, 0.42],
    lift: [0.16, 0.62],
    life: [0.9, 1.9],
    size: [0.008, 0.022],
    gravity: 0.16,
    drag: 1.5,
    spin: 0,
    colors: [C_GOLD, C_GOLD_HI, C_GOLD_DEEP],
    dome: 0.85,
  },
  shimmer: {
    count: 22,
    spread: 0.05,
    speed: [0.05, 0.3],
    lift: [0.1, 0.34],
    life: [0.3, 0.6],
    size: [0.01, 0.026],
    gravity: -0.35,
    drag: 3.4,
    spin: 0,
    colors: [C_GOLD_HI, C_WHITE],
    dome: 0.5,
  },
  ember: {
    count: 60,
    spread: 0.05,
    speed: [0.25, 1.05],
    lift: [0.7, 1.7],
    life: [0.7, 1.5],
    size: [0.01, 0.032],
    gravity: 1.1,
    drag: 2.4,
    spin: 0,
    colors: [C_GOLD, C_GOLD_HI, C_RED],
    dome: 0.95,
  },
  confetti: {
    count: 130,
    spread: 0.1,
    speed: [0.55, 1.9],
    lift: [1.0, 2.5],
    life: [1.7, 3.1],
    size: [0.02, 0.042],
    gravity: 2.5,
    drag: 1.05,
    spin: 9,
    colors: CONFETTI_PALETTE,
    dome: 1,
    confetti: true,
  },
};

// ─────────────────────────── the system ───────────────────────────

export interface BurstOptions {
  at?: THREE.Vector3;
  /** multiplies the preset's particle count */
  scale?: number;
  colors?: THREE.Color[];
}

export interface ParticleSystem {
  readonly group: THREE.Group;
  /** maps an engine seat index to a world point; set by the dealing system */
  setSeatResolver(fn: ((seat: number) => THREE.Vector3 | null) | null): void;
  burst(kind: FxBurstKind, opts?: BurstOptions): void;
  emit(preset: keyof typeof PRESETS | EmitSpec, at: THREE.Vector3, opts?: BurstOptions): void;
  shockwave(at: THREE.Vector3, radius: number, ms: number, color?: THREE.Color): void;
  setQuality(tier: PerfTier): void;
  update(dt: number, elapsed: number): void;
  clear(): void;
  dispose(): void;
}

interface Cloud {
  points: THREE.Points;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  cap: number;
  cursor: number;
  pos: Float32Array;
  vel: Float32Array;
  tint: Float32Array;
  life: Float32Array;
  phys: Float32Array;
  aPos: THREE.BufferAttribute;
  aVel: THREE.BufferAttribute;
  aTint: THREE.BufferAttribute;
  aLife: THREE.BufferAttribute;
  aPhys: THREE.BufferAttribute;
  /** latest death time in the buffer — lets the loop idle when empty */
  until: number;
}

const CAPS: Record<PerfTier, { spark: number; confetti: number }> = {
  low: { spark: 520, confetti: 220 },
  mid: { spark: 1000, confetti: 400 },
  high: { spark: 1600, confetti: 640 },
};

const RING_POOL = 5;

class Particles implements ParticleSystem {
  readonly group = new THREE.Group();

  private sparks: Cloud;
  private confetti: Cloud;
  private rings: Array<{
    mesh: THREE.Mesh;
    mat: THREE.ShaderMaterial;
    t: number;
    dur: number;
    radius: number;
  }> = [];
  private ringGeo: THREE.PlaneGeometry;

  private tier: PerfTier;
  private density = 1;
  private time = 0;
  private seatResolver: ((seat: number) => THREE.Vector3 | null) | null = null;
  private offs: Array<() => void> = [];

  private _v = new THREE.Vector3();
  private _v2 = new THREE.Vector3();
  private _c = new THREE.Color();
  private rnd = 0x2f6e5b;

  constructor(tier: PerfTier) {
    this.group.name = 'particles';
    this.tier = tier;
    const caps = CAPS[tier] ?? CAPS.mid;
    this.density = tier === 'low' ? 0.5 : tier === 'mid' ? 0.78 : 1;

    this.sparks = this.makeCloud(caps.spark, SPARK_FRAG, THREE.AdditiveBlending, false);
    this.confetti = this.makeCloud(caps.confetti, CONFETTI_FRAG, THREE.NormalBlending, true);
    this.group.add(this.sparks.points, this.confetti.points);

    this.ringGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < RING_POOL; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: C_GOLD.clone() },
          uProgress: { value: 0 },
          uAlpha: { value: 0 },
        },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 6;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, t: 0, dur: 0, radius: 1 });
    }

    this.bind();
    this.onResize();
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  private onResize = (): void => {
    const px = (window.innerHeight || 800) * Math.min(window.devicePixelRatio || 1, 3);
    this.sparks.mat.uniforms.uPixel.value = px;
    this.confetti.mat.uniforms.uPixel.value = px;
  };

  private makeCloud(
    cap: number,
    frag: string,
    blending: THREE.Blending,
    isConfetti: boolean,
  ): Cloud {
    const pos = new Float32Array(cap * 3);
    const vel = new Float32Array(cap * 3);
    const tint = new Float32Array(cap * 3);
    const life = new Float32Array(cap * 4);
    const phys = new Float32Array(cap * 3);
    // birth far in the past, lifetime zero → every slot starts dead
    for (let i = 0; i < cap; i++) life[i * 4 + 1] = 0.0001;

    const geo = new THREE.BufferGeometry();
    const aPos = new THREE.BufferAttribute(pos, 3);
    const aVel = new THREE.BufferAttribute(vel, 3);
    const aTint = new THREE.BufferAttribute(tint, 3);
    const aLife = new THREE.BufferAttribute(life, 4);
    const aPhys = new THREE.BufferAttribute(phys, 3);
    for (const a of [aPos, aVel, aTint, aLife, aPhys]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos);
    geo.setAttribute('aVel', aVel);
    geo.setAttribute('aTint', aTint);
    geo.setAttribute('aLife', aLife);
    geo.setAttribute('aPhys', aPhys);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixel: { value: 1000 },
        uFade: { value: isConfetti ? 1 : 0.95 },
      },
      vertexShader: POINTS_VERT,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
      toneMapped: false,
      fog: false,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 8;
    points.visible = false;
    return {
      points,
      geo,
      mat,
      cap,
      cursor: 0,
      pos,
      vel,
      tint,
      life,
      phys,
      aPos,
      aVel,
      aTint,
      aLife,
      aPhys,
      until: -1,
    };
  }

  private rand(): number {
    this.rnd = (Math.imul(this.rnd ^ (this.rnd >>> 15), 0x2c1b3c6d) + 0x1b873593) >>> 0;
    return this.rnd / 4294967296;
  }

  private range(a: number, b: number): number {
    return a + (b - a) * this.rand();
  }

  private bind(): void {
    this.offs.push(
      bus.on('fx:burst', ({ kind, seat, at }) => {
        const p = this._v;
        if (at) p.set(at[0], at[1], at[2]);
        else if (seat !== undefined && this.seatResolver) {
          const r = this.seatResolver(seat);
          if (r) p.copy(r);
          else p.copy(POT_CENTER);
        } else p.copy(POT_CENTER);
        this.burst(kind, { at: p });
      }),
    );
  }

  setSeatResolver(fn: ((seat: number) => THREE.Vector3 | null) | null): void {
    this.seatResolver = fn;
  }

  emit(preset: keyof typeof PRESETS | EmitSpec, at: THREE.Vector3, opts: BurstOptions = {}): void {
    const spec = typeof preset === 'string' ? PRESETS[preset] : preset;
    if (!spec) return;
    const cloud = spec.confetti ? this.confetti : this.sparks;
    const n = Math.max(1, Math.round(spec.count * this.density * (opts.scale ?? 1)));
    const colors = opts.colors ?? spec.colors;
    const birth = this.time;
    const until = birth + spec.life[1];
    if (until > cloud.until) cloud.until = until;
    cloud.points.visible = true;

    for (let i = 0; i < n; i++) {
      const idx = cloud.cursor;
      cloud.cursor = (cloud.cursor + 1) % cloud.cap;

      // direction: a cone that opens from a flat ring (dome 0) to a full
      // sphere (dome 1). Chips spray flat, confetti goes everywhere.
      const theta = this.rand() * Math.PI * 2;
      const cosPhi = 1 - this.rand() * spec.dome;
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
      const sp = this.range(spec.speed[0], spec.speed[1]);
      const lift = this.range(spec.lift[0], spec.lift[1]);

      const p3 = idx * 3;
      const p4 = idx * 4;
      cloud.pos[p3] = at.x + (this.rand() - 0.5) * spec.spread * 2;
      cloud.pos[p3 + 1] = at.y + (this.rand() - 0.5) * spec.spread;
      cloud.pos[p3 + 2] = at.z + (this.rand() - 0.5) * spec.spread * 2;
      cloud.vel[p3] = Math.cos(theta) * sinPhi * sp;
      cloud.vel[p3 + 1] = cosPhi * sp + lift;
      cloud.vel[p3 + 2] = Math.sin(theta) * sinPhi * sp;

      const col = colors[(this.rand() * colors.length) | 0] ?? C_GOLD;
      this._c.copy(col);
      // a small value jitter keeps a hundred identical sprites from reading
      // as a decal sheet
      const j = 0.82 + this.rand() * 0.36;
      cloud.tint[p3] = this._c.r * j;
      cloud.tint[p3 + 1] = this._c.g * j;
      cloud.tint[p3 + 2] = this._c.b * j;

      cloud.life[p4] = birth + this.rand() * 0.06;
      cloud.life[p4 + 1] = this.range(spec.life[0], spec.life[1]);
      cloud.life[p4 + 2] = this.range(spec.size[0], spec.size[1]);
      cloud.life[p4 + 3] = this.rand();

      cloud.phys[p3] = spec.gravity;
      cloud.phys[p3 + 1] = spec.drag;
      cloud.phys[p3 + 2] = spec.spin * (this.rand() - 0.5) * 2;
    }

    cloud.aPos.needsUpdate = true;
    cloud.aVel.needsUpdate = true;
    cloud.aTint.needsUpdate = true;
    cloud.aLife.needsUpdate = true;
    cloud.aPhys.needsUpdate = true;
  }

  shockwave(at: THREE.Vector3, radius: number, ms: number, color = C_GOLD): void {
    let slot = this.rings.find((r) => !r.mesh.visible);
    if (!slot) slot = this.rings[0];
    slot.mesh.position.set(at.x, at.y + 0.004, at.z);
    slot.mesh.scale.setScalar(radius * 2);
    slot.mesh.visible = true;
    slot.mat.uniforms.uColor.value.copy(color);
    slot.mat.uniforms.uProgress.value = 0;
    slot.mat.uniforms.uAlpha.value = 1;
    slot.t = 0;
    slot.dur = ms / 1000;
    slot.radius = radius;
  }

  burst(kind: FxBurstKind, opts: BurstOptions = {}): void {
    const at = opts.at ?? POT_CENTER;
    const s = opts.scale ?? 1;
    switch (kind) {
      case 'chips-win':
        this.emit('spark', at, { scale: s });
        this.emit('dust', at, { scale: s * 0.7 });
        break;
      case 'chips-push':
        this.emit('spark', at, { scale: s * 0.55, colors: [C_CLAY, C_GOLD, C_WHITE] });
        break;
      case 'card-flip':
        this.emit('shimmer', at, { scale: s });
        break;
      case 'allin':
        this.emit('ember', at, { scale: s * 1.1 });
        this.emit('spark', at, { scale: s });
        this.shockwave(at, 0.62, 760, C_GOLD);
        break;
      case 'bomb':
        this.emit('ember', at, { scale: s * 2.1 });
        this.emit('spark', at, { scale: s * 1.6, colors: [C_GOLD_HI, C_GOLD, C_RED] });
        this.emit('dust', at, { scale: s * 1.4 });
        this.shockwave(at, 1.05, 900, C_GOLD_HI);
        this.shockwave(at, 0.7, 620, C_RED);
        break;
      case 'royal':
      case 'quads':
        this.emit('dust', at, { scale: s * 1.8 });
        this.emit('spark', at, { scale: s * 1.3, colors: [C_GOLD_HI, C_GOLD, C_WHITE] });
        this.shockwave(at, 0.86, 820, C_GOLD_HI);
        break;
      case 'confetti':
        // confetti launches from above head height so it rains down through
        // frame rather than erupting out of the felt
        this.emit('confetti', this._v2.set(at.x, at.y + 0.92, at.z), { scale: s });
        this.emit('dust', at, { scale: s * 0.8 });
        break;
      case 'level-up':
        this.emit('dust', at, { scale: s * 1.2 });
        this.emit('shimmer', at, { scale: s * 1.6 });
        this.shockwave(at, 0.5, 620, C_GOLD);
        break;
      case 'unlock':
        this.emit('spark', at, { scale: s * 0.9, colors: [C_EPIC, C_GOLD_HI, C_WHITE] });
        this.emit('shimmer', at, { scale: s * 1.2 });
        break;
      default:
        this.emit('spark', at, { scale: s });
        break;
    }
  }

  setQuality(tier: PerfTier): void {
    this.tier = tier;
    this.density = tier === 'low' ? 0.5 : tier === 'mid' ? 0.78 : 1;
    this.sparks.mat.uniforms.uFade.value = tier === 'low' ? 0.8 : 0.95;
  }

  update(_dt: number, elapsed: number): void {
    this.time = elapsed;
    this.sparks.mat.uniforms.uTime.value = elapsed;
    this.confetti.mat.uniforms.uTime.value = elapsed;
    // a cloud whose newest particle has expired stops being drawn at all
    this.sparks.points.visible = elapsed <= this.sparks.until;
    this.confetti.points.visible = elapsed <= this.confetti.until;

    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += _dt;
      const u = THREE.MathUtils.clamp(r.t / r.dur, 0, 1);
      // decelerating front: fast out of the gate, coasting at the edge
      const p = 1 - Math.pow(1 - u, 2.6);
      r.mat.uniforms.uProgress.value = p * 0.94;
      r.mat.uniforms.uAlpha.value = Math.pow(1 - u, 1.5);
      if (u >= 1) r.mesh.visible = false;
    }
  }

  clear(): void {
    for (const cloud of [this.sparks, this.confetti]) {
      cloud.life.fill(0);
      for (let i = 0; i < cloud.cap; i++) cloud.life[i * 4 + 1] = 0.0001;
      cloud.aLife.needsUpdate = true;
      cloud.until = -1;
      cloud.points.visible = false;
    }
    for (const r of this.rings) r.mesh.visible = false;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    window.removeEventListener('resize', this.onResize);
    for (const cloud of [this.sparks, this.confetti]) {
      cloud.geo.dispose();
      cloud.mat.dispose();
    }
    for (const r of this.rings) r.mat.dispose();
    this.ringGeo.dispose();
    this.group.clear();
  }
}

export function createParticles(opts: { tier?: PerfTier } = {}): ParticleSystem {
  return new Particles(opts.tier ?? 'high');
}
