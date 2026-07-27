/**
 * The card object pool.
 *
 * A card is a real object: a rounded-rect slab with non-zero thickness and a
 * 45° bevel around the die-cut, a printed face and back, a varnish clearcoat
 * with an anisotropic normal so the highlight streaks across the print the
 * way a real plastic-coated card does, and a soft contact shadow that tracks
 * its height above the felt.
 *
 * Two things make it feel alive rather than modelled:
 *
 *  • BEND. Cards warp. A vertex-shader bend curls the long axis and cups the
 *    short one, with the normal transformed by the exact inverse-transpose of
 *    the deformation so the lighting bends with the geometry instead of
 *    sliding over it. Squeezing a hole card, a landing bounce and a card
 *    riding a stack all use it.
 *  • POOLING. Thirty cards are built once. Nothing is allocated during a
 *    hand — no geometry, no material, no vector. `acquire()` hands out a
 *    parked instance and `release()` takes it back.
 *
 * This module also owns the shared tween core (`Ease`, `Dur`, `cubicBezier`)
 * that the dealing choreography builds on, so both use identical curves and
 * the app's motion reads as one system.
 */
import * as THREE from 'three';
import type { CardId } from '../core/types.ts';
import { cardFaces, type CardBackId } from './cardFaces.ts';

// ═══════════════════════════════════════════════════════════════════
// ADAPTER — the only coupling to sibling render modules.
// If table.ts / textures.ts / renderer.ts drift, this block is the fix.
// ═══════════════════════════════════════════════════════════════════
import { layout } from './table.ts';
import { textures } from './textures.ts';
import type { PerfTier } from './renderer.ts';

/** Card dimensions in metres, from the table's proportion contract. */
const CARD_W = layout.CARD_SIZE?.w ?? 0.19;
const CARD_H = layout.CARD_SIZE?.h ?? 0.265;
const CARD_T = layout.CARD_SIZE?.t ?? 0.0055;
const FELT_Y = layout.FELT_Y ?? 0;

/** Optional textures. Never fatal — every one has a local fallback. */
function optionalTexture(key: string): THREE.Texture | null {
  try {
    const t = textures().get(key as never);
    return t ?? null;
  } catch {
    return null;
  }
}
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────── motion core ───────────────────────────

export type EaseFn = (t: number) => number;

/**
 * Solves a CSS cubic-bezier into a sampled table. Newton on a 16-sample
 * lookup converges in two iterations and costs nothing at runtime, which
 * matters when forty tweens are stepping every frame.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const SAMPLES = 16;
  const table = new Float32Array(SAMPLES + 1);
  const cx = (t: number) => ((1 - t) * (1 - t) * 3 * t * x1) + ((1 - t) * 3 * t * t * x2) + t * t * t;
  const cy = (t: number) => ((1 - t) * (1 - t) * 3 * t * y1) + ((1 - t) * 3 * t * t * y2) + t * t * t;
  const dx = (t: number) =>
    3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
  for (let i = 0; i <= SAMPLES; i++) table[i] = cx(i / SAMPLES);
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let i = 1;
    while (i < SAMPLES && table[i] < x) i++;
    const t0 = (i - 1) / SAMPLES;
    const span = table[i] - table[i - 1];
    let t = span > 1e-6 ? t0 + ((x - table[i - 1]) / span) * (1 / SAMPLES) : t0;
    for (let k = 0; k < 2; k++) {
      const d = dx(t);
      if (Math.abs(d) < 1e-5) break;
      t -= (cx(t) - x) / d;
    }
    return cy(THREE.MathUtils.clamp(t, 0, 1));
  };
}

/** The four motion curves from tokens.css, plus the two we derive from them. */
export const Ease = {
  out: cubicBezier(0.16, 1, 0.3, 1),
  inOut: cubicBezier(0.65, 0, 0.35, 1),
  spring: cubicBezier(0.34, 1.56, 0.64, 1),
  snap: cubicBezier(0.2, 0.9, 0.15, 1),
  linear: ((t: number) => t) as EaseFn,
  /** heavy object arriving: fast start, long settle */
  drop: cubicBezier(0.24, 0.86, 0.32, 1),
  /** anticipation then release, for a dealer's flick */
  flick: cubicBezier(0.5, -0.35, 0.2, 1.2),
} as const;

/** Durations in seconds, mirroring --d-* so 3D and DOM stay in step. */
export const Dur = {
  instant: 0.09,
  fast: 0.16,
  base: 0.24,
  slow: 0.38,
  lux: 0.62,
} as const;

const REDUCED =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

function motionScale(): number {
  return REDUCED?.matches ? 0.001 : 1;
}

// ─────────────────────────── geometry ───────────────────────────

interface Outline {
  pts: Float32Array;
  /** outward 2D normals, same indexing */
  nrm: Float32Array;
  count: number;
}

/**
 * Even arc-length samples around a rounded rect, with true outward normals.
 * Even spacing matters: it keeps the radial triangulation well-conditioned
 * so the bend deforms smoothly instead of pinching at the corners.
 */
function roundedOutline(w: number, h: number, r: number, count: number): Outline {
  const hw = w / 2;
  const hh = h / 2;
  const rr = Math.min(r, hw, hh);
  type Seg =
    | { kind: 0; ax: number; ay: number; bx: number; by: number; len: number }
    | { kind: 1; cx: number; cy: number; a0: number; a1: number; len: number };
  const straightX = w - rr * 2;
  const straightY = h - rr * 2;
  const quarter = (Math.PI / 2) * rr;
  const segs: Seg[] = [
    { kind: 0, ax: -hw + rr, ay: -hh, bx: hw - rr, by: -hh, len: straightX },
    { kind: 1, cx: hw - rr, cy: -hh + rr, a0: -Math.PI / 2, a1: 0, len: quarter },
    { kind: 0, ax: hw, ay: -hh + rr, bx: hw, by: hh - rr, len: straightY },
    { kind: 1, cx: hw - rr, cy: hh - rr, a0: 0, a1: Math.PI / 2, len: quarter },
    { kind: 0, ax: hw - rr, ay: hh, bx: -hw + rr, by: hh, len: straightX },
    { kind: 1, cx: -hw + rr, cy: hh - rr, a0: Math.PI / 2, a1: Math.PI, len: quarter },
    { kind: 0, ax: -hw, ay: hh - rr, bx: -hw, by: -hh + rr, len: straightY },
    { kind: 1, cx: -hw + rr, cy: -hh + rr, a0: Math.PI, a1: Math.PI * 1.5, len: quarter },
  ];
  const total = segs.reduce((a, s) => a + s.len, 0);
  const pts = new Float32Array(count * 2);
  const nrm = new Float32Array(count * 2);
  let seg = 0;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    while (seg < segs.length - 1 && acc + segs[seg].len < target) {
      acc += segs[seg].len;
      seg++;
    }
    const s = segs[seg];
    const u = THREE.MathUtils.clamp((target - acc) / Math.max(1e-6, s.len), 0, 1);
    let x: number;
    let y: number;
    let nx: number;
    let ny: number;
    if (s.kind === 0) {
      x = s.ax + (s.bx - s.ax) * u;
      y = s.ay + (s.by - s.ay) * u;
      const tx = s.bx - s.ax;
      const ty = s.by - s.ay;
      const il = 1 / Math.hypot(tx, ty);
      nx = ty * il;
      ny = -tx * il;
    } else {
      const a = s.a0 + (s.a1 - s.a0) * u;
      nx = Math.cos(a);
      ny = Math.sin(a);
      x = s.cx + nx * rr;
      y = s.cy + ny * rr;
    }
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
    nrm[i * 2] = nx;
    nrm[i * 2 + 1] = ny;
  }
  return { pts, nrm, count };
}

/**
 * Card slab. Three geometry groups so the front print, the back print and
 * the paper edge each get their own material:
 *   group 0 → front face · group 1 → back face · group 2 → bevel + edge
 */
function buildCardGeometry(w: number, h: number, t: number, segs = 48, rings = 4): THREE.BufferGeometry {
  const radius = w * 0.058;
  const bevW = t * 0.36;
  const bevH = t * 0.3;
  const out = roundedOutline(w, h, radius, segs);
  const hz = t / 2;

  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const frontIdx: number[] = [];
  const backIdx: number[] = [];
  const edgeIdx: number[] = [];

  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, mirror: boolean) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    uvs.push(mirror ? 0.5 - x / w : 0.5 + x / w, 0.5 + y / h);
    return pos.length / 3 - 1;
  };

  // ── front face: centre vertex + `rings` radial rings ──────────────
  for (const side of [1, -1]) {
    const mirror = side < 0;
    const z = hz * side;
    const nz = side;
    const centre = push(0, 0, z, 0, 0, nz, mirror);
    const ringStart: number[] = [];
    for (let r = 1; r <= rings; r++) {
      const k = r / rings;
      const start = pos.length / 3;
      ringStart.push(start);
      for (let i = 0; i < segs; i++) {
        const ox = out.pts[i * 2];
        const oy = out.pts[i * 2 + 1];
        const fx = (ox - out.nrm[i * 2] * bevW) * k;
        const fy = (oy - out.nrm[i * 2 + 1] * bevW) * k;
        push(fx, fy, z, 0, 0, nz, mirror);
      }
    }
    const idx = side > 0 ? frontIdx : backIdx;
    const flip = side < 0;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      const a = ringStart[0] + i;
      const b = ringStart[0] + j;
      if (flip) idx.push(centre, b, a);
      else idx.push(centre, a, b);
    }
    for (let r = 0; r < rings - 1; r++) {
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % segs;
        const a = ringStart[r] + i;
        const b = ringStart[r] + j;
        const c = ringStart[r + 1] + i;
        const d = ringStart[r + 1] + j;
        if (flip) idx.push(a, d, c, a, b, d);
        else idx.push(a, c, d, a, d, b);
      }
    }
  }

  // ── edge band: bevel → wall → bevel ───────────────────────────────
  // four rings of `segs` vertices, each with its own normal
  const bevLen = Math.hypot(bevW, bevH);
  const ringVerts: number[][] = [];
  const profile: Array<{ inset: number; z: number; nr: number; nz: number }> = [
    { inset: bevW, z: hz, nr: bevH / bevLen, nz: bevW / bevLen },
    { inset: 0, z: hz - bevH, nr: 1, nz: 0 },
    { inset: 0, z: -hz + bevH, nr: 1, nz: 0 },
    { inset: bevW, z: -hz, nr: bevH / bevLen, nz: -bevW / bevLen },
  ];
  for (const p of profile) {
    const ring: number[] = [];
    for (let i = 0; i < segs; i++) {
      const nx = out.nrm[i * 2];
      const ny = out.nrm[i * 2 + 1];
      const x = out.pts[i * 2] - nx * p.inset;
      const y = out.pts[i * 2 + 1] - ny * p.inset;
      ring.push(push(x, y, p.z, nx * p.nr, ny * p.nr, p.nz, false));
    }
    ringVerts.push(ring);
  }
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      const a = ringVerts[r][i];
      const b = ringVerts[r][j];
      const c = ringVerts[r + 1][i];
      const d = ringVerts[r + 1][j];
      edgeIdx.push(a, c, d, a, d, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const all = frontIdx.concat(backIdx, edgeIdx);
  geo.setIndex(all);
  geo.addGroup(0, frontIdx.length, 0);
  geo.addGroup(frontIdx.length, backIdx.length, 1);
  geo.addGroup(frontIdx.length + backIdx.length, edgeIdx.length, 2);
  geo.computeBoundingSphere();
  return geo;
}

// ─────────────────────────── bend shader ───────────────────────────

interface BendUniforms {
  uBend: { value: number };
  uCup: { value: number };
  uTwist: { value: number };
  uHalf: { value: THREE.Vector2 };
}

const BEND_PARS = /* glsl */ `
uniform float uBend;
uniform float uCup;
uniform float uTwist;
uniform vec2  uHalf;
`;

const BEND_NORMAL = /* glsl */ `
{
  float bnx = position.x / uHalf.x;
  float bny = position.y / uHalf.y;
  float fx = 2.0 * uCup * bnx;
  float fy = 2.0 * uBend * bny;
  // inverse-transpose of the shear J = [[1,0,0],[0,1,0],[fx,fy,1]]
  objectNormal = vec3(
    objectNormal.x - fx * objectNormal.z,
    objectNormal.y - fy * objectNormal.z,
    objectNormal.z
  );
}
`;

const BEND_VERTEX = /* glsl */ `
{
  float bnx = position.x / uHalf.x;
  float bny = position.y / uHalf.y;
  transformed.z += uBend * (bny * bny - 0.3333) * uHalf.y
                 + uCup  * (bnx * bnx - 0.3333) * uHalf.x;
  float tw = uTwist * bny;
  float cs = cos(tw);
  float sn = sin(tw);
  transformed.xz = vec2(transformed.x * cs + transformed.z * sn,
                        -transformed.x * sn + transformed.z * cs);
}
`;

function applyBend(mat: THREE.Material, u: BendUniforms): void {
  mat.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uBend = u.uBend;
    shader.uniforms.uCup = u.uCup;
    shader.uniforms.uTwist = u.uTwist;
    shader.uniforms.uHalf = u.uHalf;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BEND_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${BEND_NORMAL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${BEND_VERTEX}`);
  };
  mat.customProgramCacheKey = () => 'royale-card-bend';
}

// ─────────────────────────── shared assets ───────────────────────────

let sharedGeo: THREE.BufferGeometry | null = null;
function cardGeometry(): THREE.BufferGeometry {
  if (!sharedGeo) sharedGeo = buildCardGeometry(CARD_W, CARD_H, CARD_T);
  return sharedGeo;
}

/**
 * Signed distance to a rounded rectangle, in pixels. Negative inside.
 * Both the contact shadow and the showdown rim are painted from this field
 * rather than from a radial gradient, because an elliptical blur under a
 * rectangular card is the single loudest tell that a 3D scene is faked.
 */
function roundRectSdf(px: number, py: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Solves a card-silhouette field where `spread` is the bleed beyond the die
 * cut, expressed as a multiple of the card's WIDTH so the margin is uniform
 * on all four sides. Returns the plane size to render it on, so the texture
 * and the quad can never drift out of proportion.
 */
interface SdfField {
  canvas: HTMLCanvasElement;
  planeW: number;
  planeH: number;
}

function paintCardField(
  spread: number,
  baseW: number,
  write: (d: number, out: Uint8ClampedArray, i: number) => void,
): SdfField {
  const bleed = spread * CARD_W;
  const planeW = CARD_W + bleed * 2;
  const planeH = CARD_H + bleed * 2;
  const w = Math.round(baseW);
  const h = Math.round((baseW * planeH) / planeW);
  const px = w / planeW;
  const hw = (CARD_W / 2) * px;
  const hh = (CARD_H / 2) * px;
  const radius = CARD_W * 0.058 * px;

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = roundRectSdf(x - w / 2 + 0.5, y - h / 2 + 0.5, hw, hh, radius);
      write(d / px, data, (y * w + x) * 4);
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, planeW, planeH };
}

const SHADOW_SPREAD = 0.34;
const HALO_SPREAD = 0.3;

let shadowField: { tex: THREE.Texture; w: number; h: number } | null = null;
/**
 * The contact shadow. Dense and tight against the die cut, falling off over
 * a third of the card's width — a soft-box penumbra, not a blob.
 */
function contactShadow(): { tex: THREE.Texture; w: number; h: number } {
  if (shadowField) return shadowField;
  const falloff = SHADOW_SPREAD * CARD_W * 0.94;
  const f = paintCardField(SHADOW_SPREAD, 128, (d, out, i) => {
    const t = THREE.MathUtils.clamp(d / falloff, 0, 1);
    // smootherstep: no visible banding on a big soft gradient
    const s = t * t * t * (t * (t * 6 - 15) + 10);
    out[i] = 0;
    out[i + 1] = 0;
    out[i + 2] = 0;
    out[i + 3] = Math.round((1 - s) * 255);
  });
  const tex = new THREE.CanvasTexture(f.canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  shadowField = { tex, w: f.planeW, h: f.planeH };
  return shadowField;
}

let haloField: { tex: THREE.Texture; w: number; h: number } | null = null;
/**
 * The showdown rim: a gold aura that hugs the silhouette and stays dark
 * through the middle, so it lights the edge without washing out the print.
 */
function haloAura(): { tex: THREE.Texture; w: number; h: number } {
  if (haloField) return haloField;
  const bleed = HALO_SPREAD * CARD_W;
  const inner = bleed * 0.42;
  const f = paintCardField(HALO_SPREAD, 160, (d, out, i) => {
    let a: number;
    if (d >= 0) a = Math.pow(Math.max(0, 1 - d / bleed), 2.3);
    else a = Math.pow(Math.max(0, 1 + d / inner), 3.2) * 0.8;
    // a hot line exactly on the boundary reads as a lit edge
    const line = Math.exp(-(d * d) / (bleed * bleed * 0.014)) * 0.55;
    const v = THREE.MathUtils.clamp(a + line, 0, 1);
    out[i] = 255;
    out[i + 1] = Math.round(205 + 40 * v);
    out[i + 2] = Math.round(120 + 70 * v);
    out[i + 3] = Math.round(v * 235);
  });
  const tex = new THREE.CanvasTexture(f.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  haloField = { tex, w: f.planeW, h: f.planeH };
  return haloField;
}

// ─────────────────────────── card handle ───────────────────────────

export interface CardMoveOpts {
  /** seconds; defaults to Dur.slow */
  duration?: number;
  /** seconds of lead-in before the move starts */
  delay?: number;
  ease?: EaseFn;
  /** metres of vertical arc at the apex — the flick of a real deal */
  arc?: number;
  /** extra turns about the card's long axis during flight */
  spin?: number;
  /** land with a small vertical bounce and a bend ripple */
  bounce?: number;
  onDone?: () => void;
}

export interface CardHandle {
  readonly index: number;
  readonly active: boolean;
  readonly object: THREE.Object3D;
  /** live world position — read it, do not mutate it */
  readonly position: THREE.Vector3;
  readonly cardId: CardId | null;
  readonly faceUp: boolean;
  readonly busy: boolean;

  setFace(card: CardId | null): void;
  setBack(id: CardBackId): void;
  /** teleports — no animation */
  setPose(pos: THREE.Vector3, quat: THREE.Quaternion): void;
  moveTo(pos: THREE.Vector3, quat: THREE.Quaternion, opts?: CardMoveOpts): Promise<void>;
  /** rotates about the card's long axis; resolves on landing */
  flip(duration?: number, faceUp?: boolean): Promise<void>;
  setFaceUp(up: boolean): void;
  /** long-axis curl, short-axis cup, long-axis twist — all in local units */
  setBend(bend: number, cup?: number, twist?: number): void;
  setOpacity(a: number): void;
  /** 0 = off, 1 = full gold showdown rim */
  setGlow(strength: number): void;
  setShadow(on: boolean): void;
  setRenderOrder(o: number): void;
  cancel(): void;
  release(): void;
}

type Phase = 'idle' | 'delay' | 'move' | 'bounce';

class Card implements CardHandle {
  readonly index: number;
  readonly object: THREE.Group;
  readonly position: THREE.Vector3;

  active = false;
  cardId: CardId | null = null;
  faceUp = false;

  private mesh: THREE.Mesh;
  private shadow: THREE.Mesh;
  private halo: THREE.Mesh;
  private front: THREE.MeshPhysicalMaterial;
  private back: THREE.MeshPhysicalMaterial;
  private edge: THREE.MeshStandardMaterial;
  private faceTex: THREE.Texture;
  private bend: BendUniforms;
  private pool: Pool;

  // pose. `logical` is where the card *is*; `object.position` is that plus
  // the transient offsets a flip or a bounce adds, so an interrupted flip
  // can never leave the card floating.
  private logical = new THREE.Vector3();
  private base = new THREE.Quaternion();
  private flipAngle = 0;
  private flipLift = 0;
  private glow = 0;
  private opacity = 1;
  private shadowOn = true;

  // move state
  private phase: Phase = 'idle';
  private t = 0;
  private dur = 0;
  private delay = 0;
  private ease: EaseFn = Ease.out;
  private arc = 0;
  private spin = 0;
  private bounceAmt = 0;
  private fromPos = new THREE.Vector3();
  private toPos = new THREE.Vector3();
  private fromQuat = new THREE.Quaternion();
  private toQuat = new THREE.Quaternion();
  private moveDone: (() => void) | null = null;
  private moveCb: (() => void) | null = null;

  // flip state
  private flipT = 0;
  private flipDur = 0;
  private flipFrom = 0;
  private flipTo = 0;
  private flipActive = false;
  private flipDone: (() => void) | null = null;

  // steady-state bend the caller asked for; the landing ripple adds to it
  private bendTarget = 0;
  private cupTarget = 0;
  private twistTarget = 0;
  private ripple = 0;

  constructor(index: number, pool: Pool, geo: THREE.BufferGeometry, backId: CardBackId) {
    this.index = index;
    this.pool = pool;
    const atlas = cardFaces();
    this.faceTex = atlas.texture.clone();
    this.faceTex.needsUpdate = true;

    this.bend = {
      uBend: { value: 0 },
      uCup: { value: 0 },
      uTwist: { value: 0 },
      uHalf: { value: new THREE.Vector2(CARD_W / 2, CARD_H / 2) },
    };

    const varnish = optionalTexture('card-varnish');
    // Card stock under varnish: a fairly matte base with a tight clearcoat
    // on top. A high base gloss turns the print into a white sheet the
    // moment the card faces a softbox, which is exactly what a peeled hole
    // card does.
    const common = {
      roughness: 0.62,
      metalness: 0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.22,
      envMapIntensity: 0.55,
      transparent: true,
      opacity: 1,
      depthWrite: true,
    } as const;

    this.front = new THREE.MeshPhysicalMaterial({ ...common, map: this.faceTex });
    this.back = new THREE.MeshPhysicalMaterial({ ...common, map: atlas.back(backId) });
    if (varnish) {
      this.front.clearcoatNormalMap = varnish;
      this.back.clearcoatNormalMap = varnish;
      this.front.clearcoatNormalScale = new THREE.Vector2(0.14, 0.14);
      this.back.clearcoatNormalScale = new THREE.Vector2(0.14, 0.14);
    }
    this.edge = new THREE.MeshStandardMaterial({
      color: 0xe6e3da,
      roughness: 0.8,
      metalness: 0,
      transparent: true,
      opacity: 1,
      depthWrite: true,
      emissive: new THREE.Color(0xedc96b),
      emissiveIntensity: 0,
    });
    applyBend(this.front, this.bend);
    applyBend(this.back, this.bend);
    applyBend(this.edge, this.bend);

    this.mesh = new THREE.Mesh(geo, [this.front, this.back, this.edge]);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;

    // just proud of the printed face, so the aura lights the edge from the
    // viewer's side rather than sinking into the felt
    this.halo = new THREE.Mesh(pool.haloGeo, pool.haloMat.clone());
    this.halo.position.z = CARD_T * 0.5 + 0.0006;
    this.halo.renderOrder = 5;
    this.halo.visible = false;

    this.object = new THREE.Group();
    this.object.name = `card-${index}`;
    this.object.add(this.mesh, this.halo);
    this.object.visible = false;
    this.position = this.object.position;

    this.shadow = new THREE.Mesh(pool.shadowGeo, pool.shadowMat.clone());
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.visible = false;
    this.shadow.renderOrder = 1;
  }

  get busy(): boolean {
    return this.phase !== 'idle' || this.flipActive;
  }

  attach(cards: THREE.Group, shadows: THREE.Group): void {
    cards.add(this.object);
    shadows.add(this.shadow);
  }

  reset(backId: CardBackId): void {
    this.active = true;
    this.cardId = null;
    this.faceUp = false;
    this.flipAngle = Math.PI;
    this.phase = 'idle';
    this.flipActive = false;
    this.moveDone = null;
    this.moveCb = null;
    this.flipDone = null;
    this.bendTarget = 0;
    this.cupTarget = 0;
    this.twistTarget = 0;
    this.ripple = 0;
    this.glow = 0;
    this.opacity = 1;
    this.shadowOn = true;
    this.flipLift = 0;
    this.setBack(backId);
    this.setOpacity(1);
    this.setGlow(0);
    this.object.visible = true;
    this.object.scale.set(1, 1, 1);
    this.mesh.renderOrder = 4;
    this.applyQuat();
  }

  setFace(card: CardId | null): void {
    this.cardId = card;
    if (card === null) return;
    // offset/repeat feed the texture matrix, which three refreshes per draw —
    // no re-upload, which is the whole point of a single shared atlas
    const uv = cardFaces().getCardUV(card);
    this.faceTex.offset.copy(uv.offset);
    this.faceTex.repeat.copy(uv.repeat);
  }

  setBack(id: CardBackId): void {
    this.back.map = cardFaces().back(id);
    this.back.needsUpdate = true;
  }

  setPose(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    this.logical.copy(pos);
    this.object.position.copy(pos);
    this.base.copy(quat);
    this.phase = 'idle';
    this.flipLift = 0;
    this.applyQuat();
  }

  private applyQuat(): void {
    Q_TMP.setFromAxisAngle(AXIS_Y, this.flipAngle);
    this.object.quaternion.copy(this.base).multiply(Q_TMP);
    this.faceUp = Math.cos(this.flipAngle) > 0;
  }

  moveTo(pos: THREE.Vector3, quat: THREE.Quaternion, opts: CardMoveOpts = {}): Promise<void> {
    const ms = motionScale();
    this.fromPos.copy(this.logical);
    this.toPos.copy(pos);
    this.fromQuat.copy(this.base);
    this.toQuat.copy(quat);
    this.dur = Math.max(0.001, (opts.duration ?? Dur.slow) * ms);
    this.delay = Math.max(0, (opts.delay ?? 0) * ms);
    this.ease = opts.ease ?? Ease.out;
    this.arc = (opts.arc ?? 0) * (ms < 0.5 ? 0 : 1);
    this.spin = (opts.spin ?? 0) * (ms < 0.5 ? 0 : 1);
    this.bounceAmt = (opts.bounce ?? 0) * (ms < 0.5 ? 0 : 1);
    this.t = 0;
    this.phase = this.delay > 0 ? 'delay' : 'move';
    this.moveCb = opts.onDone ?? null;
    const prev = this.moveDone;
    if (prev) prev();
    return new Promise<void>((res) => {
      this.moveDone = res;
    });
  }

  flip(duration = Dur.slow, faceUp?: boolean): Promise<void> {
    const want = faceUp ?? !this.faceUp;
    const target = want ? 0 : Math.PI;
    // always take the short way round, and never unwind a half-done flip
    let to = target;
    const cur = this.flipAngle;
    const twoPi = Math.PI * 2;
    let d = (to - cur) % twoPi;
    if (d > Math.PI) d -= twoPi;
    if (d < -Math.PI) d += twoPi;
    to = cur + d;
    this.flipFrom = cur;
    this.flipTo = to;
    this.flipT = 0;
    this.flipDur = Math.max(0.001, duration * motionScale());
    this.flipActive = Math.abs(d) > 1e-4;
    const prev = this.flipDone;
    if (prev) prev();
    if (!this.flipActive) {
      this.flipDone = null;
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      this.flipDone = res;
    });
  }

  setFaceUp(up: boolean): void {
    this.flipActive = false;
    this.flipAngle = up ? 0 : Math.PI;
    this.applyQuat();
  }

  setBend(bend: number, cup = 0, twist = 0): void {
    this.bendTarget = bend;
    this.cupTarget = cup;
    this.twistTarget = twist;
  }

  setOpacity(a: number): void {
    this.opacity = a;
    this.front.opacity = a;
    this.back.opacity = a;
    this.edge.opacity = a;
    const hm = this.halo.material as THREE.MeshBasicMaterial;
    hm.opacity = this.glow * a;
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.5 * a;
  }

  setGlow(strength: number): void {
    this.glow = THREE.MathUtils.clamp(strength, 0, 1);
    this.edge.emissiveIntensity = this.glow * 1.35;
    const hm = this.halo.material as THREE.MeshBasicMaterial;
    hm.opacity = this.glow * this.opacity;
    this.halo.visible = this.glow > 0.002;
    this.halo.scale.setScalar(1 + this.glow * 0.06);
  }

  setShadow(on: boolean): void {
    this.shadowOn = on;
  }

  setRenderOrder(o: number): void {
    this.mesh.renderOrder = o;
    this.halo.renderOrder = o + 1;
  }

  cancel(): void {
    this.phase = 'idle';
    this.flipActive = false;
    if (this.moveDone) {
      const d = this.moveDone;
      this.moveDone = null;
      d();
    }
    if (this.flipDone) {
      const d = this.flipDone;
      this.flipDone = null;
      d();
    }
  }

  release(): void {
    this.cancel();
    this.active = false;
    this.object.visible = false;
    this.shadow.visible = false;
    this.halo.visible = false;
    this.cardId = null;
    this.pool.recycle(this);
  }

  step(dt: number): void {
    let hop = 0;

    // ── translation ─────────────────────────────────────────────
    if (this.phase === 'delay') {
      this.delay -= dt;
      if (this.delay <= 0) {
        this.t = -this.delay;
        this.phase = 'move';
      }
    }
    if (this.phase === 'move') {
      this.t += dt;
      const u = THREE.MathUtils.clamp(this.t / this.dur, 0, 1);
      const e = this.ease(u);
      this.logical.lerpVectors(this.fromPos, this.toPos, e);
      if (this.arc !== 0) {
        // a real flick peaks early — sin^0.85 skews the apex toward the
        // launch, which is what makes the toss read as thrown, not lobbed
        this.logical.y += Math.pow(Math.sin(Math.PI * u), 0.85) * this.arc;
      }
      this.base.slerpQuaternions(this.fromQuat, this.toQuat, e);
      if (this.spin !== 0) {
        Q_TMP.setFromAxisAngle(AXIS_Y, this.spin * Math.PI * 2 * (1 - u) * u * 4);
        this.base.multiply(Q_TMP);
      }
      if (u >= 1) {
        this.logical.copy(this.toPos);
        this.base.copy(this.toQuat);
        if (this.bounceAmt > 0) {
          this.phase = 'bounce';
          this.t = 0;
          this.ripple = Math.max(this.ripple, this.bounceAmt * 220);
        } else {
          this.phase = 'idle';
        }
        const d = this.moveDone;
        const cb = this.moveCb;
        this.moveDone = null;
        this.moveCb = null;
        if (cb) cb();
        if (d) d();
      }
    } else if (this.phase === 'bounce') {
      this.t += dt;
      const dur = 0.26;
      const u = THREE.MathUtils.clamp(this.t / dur, 0, 1);
      // two decaying half-sines: the card kisses the felt, lifts, settles
      hop = Math.abs(Math.sin(Math.PI * u * 1.9)) * Math.pow(1 - u, 2.4) * this.bounceAmt;
      if (u >= 1) {
        hop = 0;
        this.phase = 'idle';
      }
    }

    // ── flip ────────────────────────────────────────────────────
    if (this.flipActive) {
      this.flipT += dt;
      const u = THREE.MathUtils.clamp(this.flipT / this.flipDur, 0, 1);
      // snap with a small overshoot past the halfway point: the card
      // commits to the turn, then settles back onto the felt
      const e = Ease.snap(u);
      const over = u > 0.55 ? Math.sin(Math.PI * u) * 0.055 * (1 - u) : 0;
      this.flipAngle = this.flipFrom + (this.flipTo - this.flipFrom) * (e + over);
      this.flipLift = Math.sin(Math.PI * u) * CARD_T * 3.2;
      if (u >= 1) {
        this.flipAngle = this.flipTo;
        this.flipActive = false;
        this.flipLift = 0;
        this.ripple = Math.max(this.ripple, 0.55);
        const d = this.flipDone;
        this.flipDone = null;
        if (d) d();
      }
    }

    this.object.position.copy(this.logical);
    this.object.position.y += this.flipLift + hop;
    this.applyQuat();

    // ── bend: target plus the decaying landing ripple ───────────
    if (this.ripple > 0.0005) {
      this.ripple *= Math.pow(0.0016, dt);
      if (this.ripple < 0.0005) this.ripple = 0;
    }
    const wobble = this.ripple > 0 ? Math.sin(this.ripple * 26) * this.ripple * 0.09 : 0;
    const k = 1 - Math.pow(0.0009, dt);
    this.bend.uBend.value += (this.bendTarget + wobble - this.bend.uBend.value) * k;
    this.bend.uCup.value += (this.cupTarget - this.bend.uCup.value) * k;
    this.bend.uTwist.value += (this.twistTarget - this.bend.uTwist.value) * k;

    // ── contact shadow ──────────────────────────────────────────
    if (this.shadowOn && this.opacity > 0.02) {
      const h = Math.max(0, this.object.position.y - FELT_Y);
      const spread = 1 + Math.min(h * 7.5, 2.4);
      this.shadow.visible = true;
      this.shadow.position.set(
        this.object.position.x + h * 0.16,
        FELT_Y + 0.0012,
        this.object.position.z + h * 0.2,
      );
      this.shadow.scale.set(spread, spread, 1);
      this.shadow.rotation.z = yawOf(this.object.quaternion);
      const m = this.shadow.material as THREE.MeshBasicMaterial;
      m.opacity = this.opacity * 0.52 * Math.max(0.1, 1 - h * 2.6);
    } else {
      this.shadow.visible = false;
    }
  }

  dispose(): void {
    this.faceTex.dispose();
    this.front.dispose();
    this.back.dispose();
    this.edge.dispose();
    (this.halo.material as THREE.Material).dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const Q_TMP = new THREE.Quaternion();
const E_TMP = new THREE.Euler();

function yawOf(q: THREE.Quaternion): number {
  E_TMP.setFromQuaternion(q, 'YXZ');
  return E_TMP.y;
}

// ─────────────────────────── pool ───────────────────────────

export interface CardPool {
  readonly group: THREE.Group;
  readonly activeCount: number;
  readonly capacity: number;
  acquire(): CardHandle;
  releaseAll(): void;
  update(dt: number): void;
  setQuality(tier: PerfTier): void;
  setBackId(id: CardBackId): void;
  readonly backId: CardBackId;
  dispose(): void;
}

class Pool implements CardPool {
  readonly group = new THREE.Group();
  readonly haloGeo: THREE.PlaneGeometry;
  readonly haloMat: THREE.MeshBasicMaterial;
  readonly shadowGeo: THREE.PlaneGeometry;
  readonly shadowMat: THREE.MeshBasicMaterial;

  private cards: Card[] = [];
  private free: Card[] = [];
  private live: Card[] = [];
  private cardsGroup = new THREE.Group();
  private shadowGroup = new THREE.Group();
  backId: CardBackId = 'royale-gold';

  constructor(size: number) {
    this.group.name = 'cards';
    this.cardsGroup.name = 'card-slabs';
    this.shadowGroup.name = 'card-shadows';
    this.group.add(this.shadowGroup, this.cardsGroup);

    const halo = haloAura();
    this.haloGeo = new THREE.PlaneGeometry(halo.w, halo.h);
    this.haloMat = new THREE.MeshBasicMaterial({
      map: halo.tex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const shadow = contactShadow();
    this.shadowGeo = new THREE.PlaneGeometry(shadow.w, shadow.h);
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: shadow.tex,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      color: 0x02040a,
    });

    const geo = cardGeometry();
    for (let i = 0; i < size; i++) {
      const c = new Card(i, this, geo, this.backId);
      c.attach(this.cardsGroup, this.shadowGroup);
      this.cards.push(c);
      this.free.push(c);
    }
  }

  get activeCount(): number {
    return this.live.length;
  }

  get capacity(): number {
    return this.cards.length;
  }

  acquire(): CardHandle {
    let c = this.free.pop();
    if (!c) {
      // Never fail mid-hand: steal the oldest live card rather than allocate.
      c = this.live.shift();
      if (!c) throw new Error('card pool exhausted');
      c.cancel();
    }
    c.reset(this.backId);
    this.live.push(c);
    return c;
  }

  recycle(c: Card): void {
    const i = this.live.indexOf(c);
    if (i >= 0) this.live.splice(i, 1);
    if (this.free.indexOf(c) < 0) this.free.push(c);
  }

  releaseAll(): void {
    for (const c of this.cards.slice()) if (c.active) c.release();
  }

  update(dt: number): void {
    const d = Math.min(dt, 0.05);
    for (let i = 0; i < this.live.length; i++) this.live[i].step(d);
  }

  setQuality(tier: PerfTier): void {
    // the contact shadow stays on every tier — it is what glues a card to
    // the felt — but it flattens out on low so the fill rate drops
    this.shadowMat.opacity = tier === 'low' ? 0.34 : 0.52;
  }

  setBackId(id: CardBackId): void {
    this.backId = id;
    for (const c of this.cards) c.setBack(id);
  }

  dispose(): void {
    for (const c of this.cards) c.dispose();
    this.cards.length = 0;
    this.free.length = 0;
    this.live.length = 0;
    this.haloGeo.dispose();
    this.haloMat.dispose();
    this.shadowGeo.dispose();
    this.shadowMat.dispose();
    this.group.clear();
  }
}

export interface CardPoolOptions {
  size?: number;
  backId?: CardBackId;
}

export function createCardPool(opts: CardPoolOptions = {}): CardPool {
  const p = new Pool(Math.max(8, Math.round(opts.size ?? 30)));
  if (opts.backId) p.setBackId(opts.backId);
  return p;
}

// ─────────────────────────── pose helpers ───────────────────────────

const _e = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Orientation for a card resting on the felt.
 *
 * These helpers return the card's BASE orientation only. Whether the card is
 * face up or face down is the card's own state — `setFaceUp()` / `flip()` —
 * and is composed on top of this. Baking a turn into the pose as well would
 * double-flip it, which is exactly the kind of bug that only shows up on a
 * screen, so the option deliberately does not exist here.
 *
 * `facing` is the Y rotation (0 puts the card's head away from the camera,
 * i.e. upright to read); `tilt` leans it back toward the viewer.
 */
export function feltQuat(out: THREE.Quaternion, facing: number, tilt = 0): THREE.Quaternion {
  _e.set(-Math.PI / 2 + tilt, facing, 0);
  return out.setFromEuler(_e);
}

/**
 * Orientation for a card standing toward the camera — the hero peel.
 * `lean` of π/2 is flat on the felt; ~0.96 is square to a 55° camera.
 * `roll` spins the card in its own plane, which is what fans a hand.
 */
export function uprightQuat(
  out: THREE.Quaternion,
  facing: number,
  lean: number,
  roll = 0,
): THREE.Quaternion {
  _e.set(-lean, facing, roll);
  return out.setFromEuler(_e);
}

export const CARD_DIMS = { w: CARD_W, h: CARD_H, t: CARD_T } as const;
