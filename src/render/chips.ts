/**
 * Chips.
 *
 * Real casino chip geometry — a raised centre inlay, a recessed ring, a
 * chamfered rim and a knurled edge — drawn as ONE InstancedMesh so a table
 * can show four hundred chips without dropping a frame. Denomination is a
 * per-instance attribute that offsets into a texture atlas, which means the
 * six clay colours and the six premium metals all share a single draw call
 * per material group.
 *
 * Motion is where chips earn their keep:
 *   • settle   — a stack drops in with a per-chip stagger and a real bounce
 *   • slide    — a bet skates to the line on a shallow arc with a spin
 *   • cascade  — the pot pushes to a winner, chip by chip, staggered
 *   • splash   — an all-in scatters ballistically and bounces off the felt
 *
 * Everything is preallocated. No object, vector or matrix is created after
 * `createChipSystem()` returns.
 */
import * as THREE from 'three';

// ═══════════════════════════════════════════════════════════════════
// ADAPTER — the only coupling to sibling render modules.
// ═══════════════════════════════════════════════════════════════════
import { layout } from './table.ts';
import type { PerfTier } from './renderer.ts';
import { Ease, Dur, type EaseFn } from './cards.ts';

const CHIP_R = layout.CHIP_SIZE?.r ?? 0.058;
const CHIP_H = layout.CHIP_SIZE?.h ?? 0.011;
const FELT_Y = layout.FELT_Y ?? 0;
// ═══════════════════════════════════════════════════════════════════

export type ChipSetId = 'classic' | 'metal';

export const DENOMS = [1, 5, 25, 100, 500, 1000] as const;

interface ChipSkin {
  body: string;
  /** edge-spot and face-wedge colour */
  accent: string;
  /** numeral colour on the inlay */
  ink: string;
  /** inlay base */
  inlay: string;
  metal: number;
  rough: number;
  /** dashes per spot group around the edge */
  spots: number;
}

function hex(c: string): [number, number, number] {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mix(a: string, b: string, t: number): string {
  const A = hex(a);
  const B = hex(b);
  const r = Math.round(A[0] + (B[0] - A[0]) * t);
  const g = Math.round(A[1] + (B[1] - A[1]) * t);
  const bl = Math.round(A[2] + (B[2] - A[2]) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}
function lighten(c: string, t: number): string {
  return mix(c, '#ffffff', t);
}
function darken(c: string, t: number): string {
  return mix(c, '#000000', t);
}

// Clay composite is matte. An over-glossy chip mirrors the overhead softbox
// and the denomination colour vanishes into a white blob — the fastest way
// to make a casino chip look like a plastic checker.
const CLASSIC: ChipSkin[] = [
  { body: '#e6e3d6', accent: '#2d4270', ink: '#1c2333', inlay: '#f4f2ea', metal: 0.0, rough: 0.86, spots: 3 },
  { body: '#b02029', accent: '#f4ece0', ink: '#7d0f16', inlay: '#f2e7e2', metal: 0.0, rough: 0.85, spots: 3 },
  { body: '#166b42', accent: '#eef6ef', ink: '#0c4229', inlay: '#e8f2ea', metal: 0.0, rough: 0.85, spots: 6 },
  { body: '#121724', accent: '#d9a93a', ink: '#0b0e16', inlay: '#e2dfd4', metal: 0.0, rough: 0.83, spots: 6 },
  { body: '#542a8c', accent: '#efe4ff', ink: '#33116b', inlay: '#eae2f6', metal: 0.0, rough: 0.83, spots: 6 },
  { body: '#c68f14', accent: '#2a1d03', ink: '#3b2905', inlay: '#f8ebc6', metal: 0.0, rough: 0.8, spots: 6 },
];

const METAL: ChipSkin[] = [
  { body: '#aab4c4', accent: '#eef3fb', ink: '#2a3140', inlay: '#cdd6e4', metal: 0.92, rough: 0.24, spots: 3 },
  { body: '#c07f65', accent: '#ffe3d4', ink: '#4a2418', inlay: '#e6b8a2', metal: 0.92, rough: 0.24, spots: 3 },
  { body: '#2c9a78', accent: '#d5fff0', ink: '#0c3a2b', inlay: '#8fe0c6', metal: 0.88, rough: 0.26, spots: 6 },
  { body: '#454d5d', accent: '#c8d2e2', ink: '#0d1119', inlay: '#7d8797', metal: 0.94, rough: 0.2, spots: 6 },
  { body: '#8f61cf', accent: '#f0e2ff', ink: '#2e0f5c', inlay: '#c6a5f0', metal: 0.9, rough: 0.22, spots: 6 },
  { body: '#d9a93a', accent: '#fdf3d0', ink: '#4a3306', inlay: '#f6e0a0', metal: 0.96, rough: 0.17, spots: 6 },
];

const SKINS: ChipSkin[] = [...CLASSIC, ...METAL];
const ROWS = SKINS.length;

// ─────────────────────────── textures ───────────────────────────

const FACE_CELL = 168;
const EDGE_W = 256;
const EDGE_H = 44;

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('canvas 2d unavailable');
  return [c, g];
}

function drawFaceCell(g: CanvasRenderingContext2D, s: ChipSkin, denom: number, pbr: boolean): void {
  const S = FACE_CELL;
  const c = S / 2;
  const R = S / 2 - 1;

  if (pbr) {
    // r = metalness, g = roughness. The inlay is a printed label: always a
    // touch glossier than the clay, and never metal even on the metal set.
    g.fillStyle = `rgb(${Math.round(s.metal * 255)},${Math.round(s.rough * 255)},0)`;
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = `rgb(${Math.round(s.metal * 90)},${Math.round((s.rough - 0.16) * 255)},0)`;
    g.beginPath();
    g.arc(c, c, R * 0.575, 0, Math.PI * 2);
    g.fill();
    // groove reads as a darker, rougher band
    g.strokeStyle = `rgb(${Math.round(s.metal * 255)},${Math.round((s.rough + 0.16) * 255)},0)`;
    g.lineWidth = R * 0.055;
    g.beginPath();
    g.arc(c, c, R * 0.605, 0, Math.PI * 2);
    g.stroke();
    return;
  }

  // body
  const body = g.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.1, c, c, R);
  body.addColorStop(0, lighten(s.body, 0.16));
  body.addColorStop(0.62, s.body);
  body.addColorStop(1, darken(s.body, 0.28));
  g.fillStyle = body;
  g.beginPath();
  g.arc(c, c, R, 0, Math.PI * 2);
  g.fill();

  // edge spots wrapping onto the face — the single most recognisable
  // feature of a casino chip
  const groups = s.spots;
  g.fillStyle = s.accent;
  for (let k = 0; k < groups; k++) {
    const a0 = (k / groups) * Math.PI * 2;
    const half = (Math.PI * 2) / groups / 2 / 2.05;
    g.beginPath();
    g.arc(c, c, R, a0 - half, a0 + half);
    g.arc(c, c, R * 0.615, a0 + half, a0 - half, true);
    g.closePath();
    g.fill();
  }

  // rim shadow so the chamfer reads
  g.strokeStyle = 'rgba(0,0,0,0.34)';
  g.lineWidth = R * 0.055;
  g.beginPath();
  g.arc(c, c, R * 0.975, 0, Math.PI * 2);
  g.stroke();

  // inlay
  const inl = g.createLinearGradient(0, c - R * 0.6, 0, c + R * 0.6);
  inl.addColorStop(0, lighten(s.inlay, 0.28));
  inl.addColorStop(1, darken(s.inlay, 0.12));
  g.fillStyle = inl;
  g.beginPath();
  g.arc(c, c, R * 0.575, 0, Math.PI * 2);
  g.fill();

  // guilloche rings on the inlay
  g.strokeStyle = 'rgba(0,0,0,0.09)';
  g.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.arc(c, c, R * (0.24 + i * 0.062), 0, Math.PI * 2);
    g.stroke();
  }
  // radial ticks
  g.strokeStyle = 'rgba(0,0,0,0.14)';
  g.lineWidth = 1.4;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * R * 0.5, c + Math.sin(a) * R * 0.5);
    g.lineTo(c + Math.cos(a) * R * 0.555, c + Math.sin(a) * R * 0.555);
    g.stroke();
  }
  // groove ring
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = R * 0.045;
  g.beginPath();
  g.arc(c, c, R * 0.6, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.24)';
  g.lineWidth = 1.4;
  g.beginPath();
  g.arc(c, c, R * 0.578, 0, Math.PI * 2);
  g.stroke();

  // denomination
  const label = denom >= 1000 ? `${denom / 1000}K` : `${denom}`;
  g.fillStyle = s.ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const size = label.length >= 3 ? R * 0.44 : label.length === 2 ? R * 0.56 : R * 0.68;
  g.font = `800 ${size}px -apple-system, 'SF Pro Display', 'Segoe UI', Inter, sans-serif`;
  g.fillText(label, c, c + size * 0.04);
}

function drawEdgeCell(g: CanvasRenderingContext2D, s: ChipSkin, y0: number, pbr: boolean): void {
  if (pbr) {
    g.fillStyle = `rgb(${Math.round(s.metal * 255)},${Math.round((s.rough + 0.06) * 255)},0)`;
    g.fillRect(0, y0, EDGE_W, EDGE_H);
    // knurling alternates roughness so the rim catches a moving highlight
    g.fillStyle = `rgb(${Math.round(s.metal * 255)},${Math.round((s.rough - 0.1) * 255)},0)`;
    for (let x = 0; x < EDGE_W; x += 6) g.fillRect(x, y0, 2, EDGE_H);
    return;
  }
  const grad = g.createLinearGradient(0, y0, 0, y0 + EDGE_H);
  grad.addColorStop(0, darken(s.body, 0.42));
  grad.addColorStop(0.24, lighten(s.body, 0.06));
  grad.addColorStop(0.5, s.body);
  grad.addColorStop(0.76, lighten(s.body, 0.04));
  grad.addColorStop(1, darken(s.body, 0.46));
  g.fillStyle = grad;
  g.fillRect(0, y0, EDGE_W, EDGE_H);

  // spot groups: three thin bars per group, the classic dealer's tell for
  // denomination when the chips are edge-on in a stack
  const groups = s.spots;
  const bars = 3;
  const barW = Math.max(3, Math.round(EDGE_W / groups / 12));
  g.fillStyle = s.accent;
  for (let k = 0; k < groups; k++) {
    const cx = ((k + 0.5) / groups) * EDGE_W;
    for (let b = 0; b < bars; b++) {
      const x = cx + (b - (bars - 1) / 2) * barW * 2.4 - barW / 2;
      g.fillRect(x, y0 + EDGE_H * 0.1, barW, EDGE_H * 0.8);
    }
  }
  // mould seam
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(0, y0 + EDGE_H * 0.47, EDGE_W, Math.max(1, EDGE_H * 0.05));
  g.fillStyle = 'rgba(255,255,255,0.1)';
  g.fillRect(0, y0 + EDGE_H * 0.52, EDGE_W, 1);
}

function buildChipTextures(): {
  face: THREE.CanvasTexture;
  facePbr: THREE.CanvasTexture;
  edge: THREE.CanvasTexture;
  edgePbr: THREE.CanvasTexture;
} {
  const mk = (w: number, h: number) => canvasOf(w, h);
  const [fc, fg] = mk(FACE_CELL, FACE_CELL * ROWS);
  const [fpc, fpg] = mk(FACE_CELL, FACE_CELL * ROWS);
  const [ec, eg] = mk(EDGE_W, EDGE_H * ROWS);
  const [epc, epg] = mk(EDGE_W, EDGE_H * ROWS);

  for (let i = 0; i < ROWS; i++) {
    const skin = SKINS[i];
    const denom = DENOMS[i % DENOMS.length];
    fg.save();
    fg.translate(0, i * FACE_CELL);
    drawFaceCell(fg, skin, denom, false);
    fg.restore();
    fpg.save();
    fpg.translate(0, i * FACE_CELL);
    drawFaceCell(fpg, skin, denom, true);
    fpg.restore();
    drawEdgeCell(eg, skin, i * EDGE_H, false);
    drawEdgeCell(epg, skin, i * EDGE_H, true);
  }

  const tex = (c: HTMLCanvasElement, srgb: boolean, wrapU: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = wrapU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return {
    face: tex(fc, true, false),
    facePbr: tex(fpc, false, false),
    edge: tex(ec, true, true),
    edgePbr: tex(epc, false, true),
  };
}

// ─────────────────────────── geometry ───────────────────────────

/**
 * Surface of revolution. The top carries the full profile (inlay lift,
 * groove, chamfer) because that is the face you look down on; the underside
 * gets a cheap two-ring version because it is only ever seen mid-toss.
 */
function buildChipGeometry(r: number, h: number, seg = 26): THREE.BufferGeometry {
  /**
   * The top profile in (radius fraction, height above the top plane × h).
   * Reading outward: raised inlay, the recessed groove that rings it, the
   * flat clay shoulder, then the chamfer down to the rim.
   */
  const TOP: Array<[number, number]> = [
    [0, 0.055],
    [0.5, 0.05],
    [0.565, -0.02],
    [0.63, 0.018],
    [0.93, 0.018],
    [1, -0.13],
  ];
  /** The underside is only seen mid-toss, so it is a flat disc + chamfer. */
  const BOT: Array<[number, number]> = [
    [0, 0],
    [0.93, 0],
    [1, -0.13],
  ];

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const capIdx: number[] = [];
  const sideIdx: number[] = [];

  /**
   * `up` is +1 for the top cap and -1 for the underside. The profile is
   * mirrored through the mid-plane for the underside, and BOTH the vertex
   * normal and the triangle winding are mirrored with it — getting only one
   * of the two right leaves a face that is either invisible or unlit, which
   * is exactly what a black chip top looks like.
   */
  const emitCap = (prof: Array<[number, number]>, up: 1 | -1) => {
    const planeY = (up * h) / 2;
    const rings: number[][] = [];
    for (let p = 0; p < prof.length; p++) {
      const [rf, dy] = prof[p];
      const y = planeY + up * dy * h;
      // central-difference tangent of the profile, in world units
      const prev = prof[Math.max(0, p - 1)];
      const next = prof[Math.min(prof.length - 1, p + 1)];
      const tr = (next[0] - prev[0]) * r;
      const ty = (next[1] - prev[1]) * h;
      const nl = Math.hypot(tr, ty) || 1;
      // rotate the tangent to face away from the body, then mirror for the
      // underside: (-ty, tr) points outward-and-up for a descending profile
      const nr = -ty / nl;
      const ny = (tr / nl) * up;
      const ring: number[] = [];
      if (rf === 0) {
        pos.push(0, y, 0);
        nor.push(0, up, 0);
        uv.push(0.5, 0.5);
        ring.push(pos.length / 3 - 1);
      } else {
        for (let i = 0; i < seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          const cx = Math.cos(a);
          const cz = Math.sin(a);
          pos.push(cx * rf * r, y, cz * rf * r);
          nor.push(cx * nr, ny, cz * nr);
          // planar UV; mirrored on the underside so the print is not reversed
          uv.push(0.5 + cx * rf * 0.5 * up, 0.5 + cz * rf * 0.5);
          ring.push(pos.length / 3 - 1);
        }
      }
      rings.push(ring);
    }
    // Winding: with the ring running counter-clockwise in XZ, (centre, j, i)
    // is the order whose geometric normal points +Y.
    const flip = up < 0;
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const a = rings[0][0];
      const b = rings[1][i];
      const c = rings[1][j];
      if (flip) capIdx.push(a, b, c);
      else capIdx.push(a, c, b);
    }
    for (let p = 1; p < rings.length - 1; p++) {
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        const a = rings[p][i];
        const b = rings[p][j];
        const c = rings[p + 1][i];
        const d = rings[p + 1][j];
        if (flip) capIdx.push(a, c, d, a, d, b);
        else capIdx.push(a, d, c, a, b, d);
      }
    }
  };

  emitCap(TOP, 1);
  emitCap(BOT, -1);

  // side wall: three rings with a slight barrel so the rim highlight rolls
  const yTop = h / 2 - 0.13 * h;
  const yBot = -h / 2 + 0.13 * h;
  const sideRings: number[][] = [];
  for (let k = 0; k < 3; k++) {
    const v = k / 2;
    const y = yTop + (yBot - yTop) * v;
    const bulge = 1 + Math.sin(v * Math.PI) * 0.02;
    const ring: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      pos.push(cx * r * bulge, y, cz * r * bulge);
      const yn = k === 0 ? 0.24 : k === 2 ? -0.24 : 0;
      const l = Math.hypot(1, yn);
      nor.push((cx / l) * 1, yn / l, (cz / l) * 1);
      // v = 0 at the top ring, matching the cell-local convention in chipUv
      uv.push(i / seg, v);
      ring.push(pos.length / 3 - 1);
    }
    sideRings.push(ring);
  }
  // rings run counter-clockwise in XZ and descend, so (a, d, c) is the order
  // whose geometric normal points outward
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < seg; i++) {
      const a = sideRings[k][i];
      const b = sideRings[k][i + 1];
      const c = sideRings[k + 1][i];
      const d = sideRings[k + 1][i + 1];
      sideIdx.push(a, d, c, a, b, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(capIdx.concat(sideIdx));
  geo.addGroup(0, capIdx.length, 0);
  geo.addGroup(capIdx.length, sideIdx.length, 1);
  geo.computeBoundingSphere();
  return geo;
}

// ─────────────────────────── atlas-row shader ───────────────────────────

const ROW_PARS_VERT = /* glsl */ `
attribute float aRow;
varying float vRow;
`;
const ROW_PARS_FRAG = /* glsl */ `
varying float vRow;
uniform sampler2D uPbr;
uniform float uRows;
// Cell-local uv.y runs 0 at the TOP of the drawn cell to 1 at the bottom.
// Canvas textures upload flipped (flipY), so row r lives at
// v ∈ [1-(r+1)/rows, 1-r/rows] *and* its content is mirrored inside that
// band — both are undone by the single subtraction below.
vec2 chipUv(vec2 uv) {
  float e = 0.75 / (168.0 * uRows);
  float y = clamp(uv.y, 0.0, 1.0);
  return vec2(uv.x, 1.0 - (vRow + y) / uRows + (y < 0.5 ? -e : e));
}
`;

function applyRowAtlas(mat: THREE.MeshStandardMaterial, pbr: THREE.Texture, key: string): void {
  mat.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uPbr = { value: pbr };
    shader.uniforms.uRows = { value: ROWS };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROW_PARS_VERT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n  vRow = aRow;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROW_PARS_FRAG}`)
      // the atlas is an sRGB texture, so the sampler decodes it in hardware —
      // all we change is *where* it samples
      .replace('#include <map_fragment>', `diffuseColor *= texture2D( map, chipUv( vMapUv ) );`)
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness * texture2D( uPbr, chipUv( vMapUv ) ).g;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = metalness * texture2D( uPbr, chipUv( vMapUv ) ).r;`,
      );
  };
  mat.customProgramCacheKey = () => key;
}

// ─────────────────────────── instance model ───────────────────────────

const MODE_IDLE = 0;
const MODE_TWEEN = 1;
const MODE_BALLISTIC = 2;

interface ChipInst {
  slot: number;
  used: boolean;
  row: number;
  stack: number;
  x: number;
  y: number;
  z: number;
  spin: number;
  tiltX: number;
  tiltZ: number;
  scale: number;
  mode: number;
  t: number;
  dur: number;
  delay: number;
  ease: EaseFn;
  sx: number;
  sy: number;
  sz: number;
  ex: number;
  ey: number;
  ez: number;
  arc: number;
  spin0: number;
  spin1: number;
  tilt0: number;
  tilt1: number;
  vx: number;
  vy: number;
  vz: number;
  av: number;
  rest: number;
  bounce: number;
  fade: number;
  fadeDur: number;
  dying: boolean;
  onEnd: (() => void) | null;
}

function newInst(slot: number): ChipInst {
  return {
    slot,
    used: false,
    row: 0,
    stack: -1,
    x: 0,
    y: -99,
    z: 0,
    spin: 0,
    tiltX: 0,
    tiltZ: 0,
    scale: 0,
    mode: MODE_IDLE,
    t: 0,
    dur: 0,
    delay: 0,
    ease: Ease.out,
    sx: 0,
    sy: 0,
    sz: 0,
    ex: 0,
    ey: 0,
    ez: 0,
    arc: 0,
    spin0: 0,
    spin1: 0,
    tilt0: 0,
    tilt1: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    av: 0,
    rest: 0,
    bounce: 0,
    fade: 0,
    fadeDur: 1,
    dying: false,
    onEnd: null,
  };
}

export interface StackOptions {
  /** rows per visible column before it starts a new one */
  columnHeight?: number;
  /** drop the stack in rather than popping it into place */
  settle?: boolean;
  /** seconds before the first chip lands */
  delay?: number;
  /** override the denomination breakdown with a raw chip count */
  forceChips?: number;
  /**
   * Chip budget for this stack. The breakdown colours up until it fits, so a
   * nine-handed table full of deep stacks still reads instantly and still
   * fits inside the instance cap. Default 26.
   */
  maxChips?: number;
}

export interface SlideOptions {
  duration?: number;
  delay?: number;
  /** seconds between successive chips */
  stagger?: number;
  arc?: number;
  spin?: number;
  ease?: EaseFn;
  /** rebuild the stack shape at the destination instead of keeping it */
  restack?: boolean;
}

export interface ChipStackHandle {
  readonly id: number;
  readonly amount: number;
  readonly chipCount: number;
  readonly alive: boolean;
  readonly position: THREE.Vector3;
  /** rebuilds the breakdown in place */
  setAmount(amount: number, opts?: StackOptions): void;
  moveTo(target: THREE.Vector3, opts?: SlideOptions): Promise<void>;
  /** the pot push: staggered per chip with a long settle */
  cascadeTo(target: THREE.Vector3, opts?: SlideOptions): Promise<void>;
  /** all-in: chips scatter ballistically and bounce on the felt */
  splash(power?: number): void;
  settle(delay?: number): void;
  fadeOut(duration?: number): Promise<void>;
  release(): void;
}

// ─────────────────────────── the system ───────────────────────────

export interface ChipSystem {
  readonly group: THREE.Group;
  readonly liveChips: number;
  /** chips per money unit; set from the stake so $0.05 blinds still rack */
  setDenomUnit(unit: number): void;
  breakdown(amount: number): Array<{ denom: number; count: number }>;
  makeStack(amount: number, at: THREE.Vector3, opts?: StackOptions): ChipStackHandle;
  setChipSet(id: ChipSetId): void;
  setQuality(tier: PerfTier): void;
  update(dt: number, elapsed: number): void;
  releaseAll(): void;
  dispose(): void;
}

const CAP: Record<PerfTier, number> = { low: 190, mid: 320, high: 440 };
const MAX_STACKS = 72;

class Stack implements ChipStackHandle {
  readonly id: number;
  amount = 0;
  alive = false;
  readonly position = new THREE.Vector3();
  chips: number[] = [];
  columnOf: number[] = [];
  indexInCol: number[] = [];
  columns = 1;
  private sys: System;

  constructor(id: number, sys: System) {
    this.id = id;
    this.sys = sys;
  }

  get chipCount(): number {
    return this.chips.length;
  }

  setAmount(amount: number, opts: StackOptions = {}): void {
    this.sys.rebuild(this, amount, opts);
  }

  moveTo(target: THREE.Vector3, opts: SlideOptions = {}): Promise<void> {
    return this.sys.slide(this, target, opts);
  }

  cascadeTo(target: THREE.Vector3, opts: SlideOptions = {}): Promise<void> {
    return this.sys.slide(this, target, {
      duration: opts.duration ?? 0.62,
      stagger: opts.stagger ?? 0.028,
      arc: opts.arc ?? 0.085,
      spin: opts.spin ?? 1.35,
      ease: opts.ease ?? Ease.drop,
      delay: opts.delay ?? 0,
      restack: opts.restack ?? true,
    });
  }

  splash(power = 1): void {
    this.sys.splash(this, power);
  }

  settle(delay = 0): void {
    this.sys.settle(this, delay);
  }

  fadeOut(duration = Dur.slow): Promise<void> {
    return this.sys.fade(this, duration);
  }

  release(): void {
    this.sys.releaseStack(this);
  }
}

class System implements ChipSystem {
  readonly group = new THREE.Group();

  private geo: THREE.BufferGeometry;
  private capMat: THREE.MeshStandardMaterial;
  private sideMat: THREE.MeshStandardMaterial;
  private mesh: THREE.InstancedMesh;
  private rowAttr: THREE.InstancedBufferAttribute;
  private tex: ReturnType<typeof buildChipTextures>;

  private shadowMesh: THREE.InstancedMesh;
  private shadowGeo: THREE.PlaneGeometry;
  private shadowMat: THREE.MeshBasicMaterial;

  private chips: ChipInst[] = [];
  private freeChips: number[] = [];
  private stacks: Stack[] = [];
  private freeStacks: number[] = [];

  private setOffset = 0;
  private unit = 1;
  private cap: number;
  private maxUsed = 0;

  // scratch — allocated once
  private _m = new THREE.Matrix4();
  private _p = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _s = new THREE.Vector3(1, 1, 1);
  private _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private _zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private pending = new Map<number, () => void>();
  private seq = 0;

  constructor(tier: PerfTier) {
    this.group.name = 'chips';
    this.cap = CAP[tier] ?? CAP.mid;
    this.geo = buildChipGeometry(CHIP_R, CHIP_H);
    this.tex = buildChipTextures();

    const rows = new Float32Array(this.cap);
    this.rowAttr = new THREE.InstancedBufferAttribute(rows, 1);
    this.rowAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aRow', this.rowAttr);

    // roughness/metalness are multipliers of the per-denomination PBR atlas,
    // so both stay at 1 here and the texture does the work
    this.capMat = new THREE.MeshStandardMaterial({
      map: this.tex.face,
      roughness: 1,
      metalness: 1,
      envMapIntensity: 0.62,
    });
    this.sideMat = new THREE.MeshStandardMaterial({
      map: this.tex.edge,
      roughness: 1,
      metalness: 1,
      envMapIntensity: 0.62,
    });
    applyRowAtlas(this.capMat, this.tex.facePbr, 'royale-chip-cap');
    applyRowAtlas(this.sideMat, this.tex.edgePbr, 'royale-chip-side');

    this.mesh = new THREE.InstancedMesh(this.geo, [this.capMat, this.sideMat], this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'chip-instances';
    this.mesh.count = 0;
    this.group.add(this.mesh);

    this.shadowGeo = new THREE.PlaneGeometry(1, 1);
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: makeBlobShadow(),
      transparent: true,
      depthWrite: false,
      opacity: 0.5,
      color: 0x02040a,
    });
    this.shadowMesh = new THREE.InstancedMesh(this.shadowGeo, this.shadowMat, MAX_STACKS);
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.renderOrder = 1;
    this.shadowMesh.count = MAX_STACKS;
    this.group.add(this.shadowMesh);

    for (let i = 0; i < this.cap; i++) {
      this.chips.push(newInst(i));
      // park every instance at zero scale; a stale identity matrix would
      // otherwise park a chip at the world origin the first time count grows
      this.mesh.setMatrixAt(i, this._zero);
    }
    // The free list is a LIFO, so it is seeded in DESCENDING order: `pop()`
    // then hands out slot 0 first and the live instances stay packed at the
    // bottom of the buffer. `mesh.count` is the high-water mark, so filling
    // from the top instead would make every draw submit all 440 instances.
    for (let i = this.cap - 1; i >= 0; i--) this.freeChips.push(i);
    this.mesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < MAX_STACKS; i++) {
      this.stacks.push(new Stack(i, this));
      this.freeStacks.push(i);
      this.shadowMesh.setMatrixAt(i, this._zero);
    }
    this.shadowMesh.instanceMatrix.needsUpdate = true;
  }

  get liveChips(): number {
    return this.cap - this.freeChips.length;
  }

  setDenomUnit(unit: number): void {
    this.unit = unit > 0 ? unit : 1;
  }

  /**
   * Greedy largest-first, then COLOUR UP.
   *
   * A dealer facing a mountain of $1000 chips does not build a taller
   * mountain — they colour up, so the rack stays readable and countable. We
   * do the same: if the greedy breakdown overflows the chip budget, each
   * chip is quietly worth five times more and we try again. The pile stays
   * proportional to the pot, the denominations stay in the standard set, and
   * the exact figure lives where it belongs — in the DOM, as text.
   */
  breakdown(amount: number, maxChips = 26): Array<{ denom: number; count: number }> {
    const out: Array<{ denom: number; count: number }> = [];
    const units = Math.max(0, Math.round(amount / this.unit));
    if (units <= 0) return out;
    const MAX_CHIPS = Math.max(1, Math.round(maxChips));
    const TOP = DENOMS[DENOMS.length - 1];

    for (let scale = 1; ; scale *= 5) {
      out.length = 0;
      let rest = Math.max(1, Math.round(units / scale));
      let total = 0;
      for (let i = DENOMS.length - 1; i >= 0; i--) {
        const d = DENOMS[i];
        // the last denomination rounds rather than floors, so the stack is
        // never systematically short by half a chip
        const n = i === 0 ? Math.max(0, Math.round(rest / d)) : Math.floor(rest / d);
        if (n > 0) {
          out.push({ denom: d, count: n });
          rest -= n * d;
          total += n;
        }
      }
      if (total > 0 && total <= MAX_CHIPS) break;
      if (units / scale <= TOP) break;
    }
    if (out.length === 0) out.push({ denom: DENOMS[0], count: 1 });
    // hard clamp: a pathological amount must never blow the instance budget
    let budget = MAX_CHIPS;
    for (let i = 0; i < out.length; i++) {
      if (out[i].count > budget) out[i].count = budget;
      budget -= out[i].count;
      if (budget <= 0) {
        out.length = out[i].count > 0 ? i + 1 : i;
        break;
      }
    }
    return out;
  }

  makeStack(amount: number, at: THREE.Vector3, opts: StackOptions = {}): ChipStackHandle {
    const id = this.freeStacks.pop();
    const stack = id !== undefined ? this.stacks[id] : this.stealStack();
    stack.alive = true;
    stack.position.copy(at);
    stack.chips.length = 0;
    stack.columnOf.length = 0;
    stack.indexInCol.length = 0;
    this.rebuild(stack, amount, opts);
    return stack;
  }

  private stealStack(): Stack {
    // Never allocate mid-hand: recycle the oldest live stack instead.
    let oldest: Stack | null = null;
    for (const s of this.stacks) if (s.alive && (!oldest || s.chips.length < oldest.chips.length)) oldest = s;
    const victim = oldest ?? this.stacks[0];
    this.releaseStack(victim);
    this.freeStacks.pop();
    return victim;
  }

  rebuild(stack: Stack, amount: number, opts: StackOptions = {}): void {
    const colH = Math.max(4, Math.round(opts.columnHeight ?? 14));
    const parts = opts.forceChips
      ? [{ denom: DENOMS[0] as number, count: Math.max(1, Math.round(opts.forceChips)) }]
      : this.breakdown(amount, opts.maxChips);
    stack.amount = amount;

    const want: number[] = [];
    for (const p of parts) {
      const di = denomIndex(p.denom);
      for (let i = 0; i < p.count; i++) want.push(di);
    }

    // reuse the chips already in this stack, top-down
    while (stack.chips.length > want.length) {
      const slot = stack.chips.pop()!;
      stack.columnOf.pop();
      stack.indexInCol.pop();
      this.killChip(slot);
    }
    while (stack.chips.length < want.length) {
      const slot = this.takeChip();
      if (slot < 0) break;
      const c = this.chips[slot];
      c.stack = stack.id;
      stack.chips.push(slot);
      stack.columnOf.push(0);
      stack.indexInCol.push(0);
    }

    const n = stack.chips.length;
    stack.columns = Math.max(1, Math.ceil(n / colH));
    const settle = opts.settle ?? false;
    const baseDelay = opts.delay ?? 0;
    for (let i = 0; i < n; i++) {
      const c = this.chips[stack.chips[i]];
      c.row = this.setOffset + (want[i] ?? 0);
      const col = Math.floor(i / colH);
      const inCol = i % colH;
      stack.columnOf[i] = col;
      stack.indexInCol[i] = inCol;
      const o = columnOffset(col);
      const tx = stack.position.x + o[0] * CHIP_R * 2.14;
      const tz = stack.position.z + o[1] * CHIP_R * 2.14;
      const ty = FELT_Y + CHIP_H * (0.5 + inCol) + inCol * 0.00018;
      // real stacks are never perfectly aligned — a sub-millimetre offset
      // and a random facing is the difference between chips and coins
      const jx = hash01(stack.id * 977 + i * 31) - 0.5;
      const jz = hash01(stack.id * 613 + i * 57) - 0.5;
      const fx = tx + jx * CHIP_R * 0.075;
      const fz = tz + jz * CHIP_R * 0.075;
      c.spin1 = hash01(stack.id * 131 + i * 17) * Math.PI * 2;
      if (settle) {
        c.mode = MODE_TWEEN;
        c.sx = fx;
        c.sz = fz;
        c.sy = ty + 0.055 + inCol * 0.004;
        c.ex = fx;
        c.ey = ty;
        c.ez = fz;
        c.spin0 = c.spin1 - 0.5;
        c.tilt0 = 0.12;
        c.tilt1 = 0;
        c.arc = 0;
        c.t = 0;
        c.dur = 0.3;
        c.delay = baseDelay + i * 0.026;
        c.ease = Ease.drop;
        c.bounce = CHIP_H * 0.9;
        c.scale = 1;
        c.x = fx;
        c.y = c.sy;
        c.z = fz;
      } else {
        c.mode = MODE_IDLE;
        c.x = fx;
        c.y = ty;
        c.z = fz;
        c.spin = c.spin1;
        c.tiltX = 0;
        c.tiltZ = 0;
        c.scale = 1;
      }
    }
  }

  private takeChip(): number {
    let slot = this.freeChips.pop();
    if (slot === undefined) {
      // recycle the chip that has been idle in the largest stack
      let victim = -1;
      let best = -1;
      for (const s of this.stacks) {
        if (!s.alive || s.chips.length <= best) continue;
        best = s.chips.length;
        victim = s.id;
      }
      if (victim < 0) return -1;
      const s = this.stacks[victim];
      const gone = s.chips.pop();
      s.columnOf.pop();
      s.indexInCol.pop();
      if (gone === undefined) return -1;
      this.killChip(gone);
      slot = this.freeChips.pop();
      if (slot === undefined) return -1;
    }
    const c = this.chips[slot];
    c.used = true;
    c.dying = false;
    c.fade = 0;
    c.scale = 1;
    c.onEnd = null;
    c.mode = MODE_IDLE;
    if (slot + 1 > this.maxUsed) this.maxUsed = slot + 1;
    return slot;
  }

  private killChip(slot: number): void {
    const c = this.chips[slot];
    if (!c.used) return;
    c.used = false;
    c.dying = false;
    c.stack = -1;
    c.scale = 0;
    c.y = -99;
    c.mode = MODE_IDLE;
    c.onEnd = null;
    this.freeChips.push(slot);
  }

  settle(stack: Stack, delay = 0): void {
    this.rebuild(stack, stack.amount, { settle: true, delay });
  }

  slide(stack: Stack, target: THREE.Vector3, opts: SlideOptions): Promise<void> {
    const dur = opts.duration ?? 0.42;
    const stagger = opts.stagger ?? 0.012;
    const arc = opts.arc ?? 0.06;
    const spin = opts.spin ?? 0.85;
    const ease = opts.ease ?? Ease.out;
    const delay = opts.delay ?? 0;
    const restack = opts.restack ?? true;
    const dx = target.x - stack.position.x;
    const dz = target.z - stack.position.z;
    const colH = 14;
    stack.position.copy(target);

    let last = 0;
    for (let i = 0; i < stack.chips.length; i++) {
      const c = this.chips[stack.chips[i]];
      c.mode = MODE_TWEEN;
      c.sx = c.x;
      c.sy = c.y;
      c.sz = c.z;
      if (restack) {
        const col = Math.floor(i / colH);
        const inCol = i % colH;
        const o = columnOffset(col);
        const jx = hash01(stack.id * 977 + i * 31) - 0.5;
        const jz = hash01(stack.id * 613 + i * 57) - 0.5;
        c.ex = target.x + o[0] * CHIP_R * 2.14 + jx * CHIP_R * 0.075;
        c.ez = target.z + o[1] * CHIP_R * 2.14 + jz * CHIP_R * 0.075;
        c.ey = FELT_Y + CHIP_H * (0.5 + inCol) + inCol * 0.00018;
        stack.columnOf[i] = col;
        stack.indexInCol[i] = inCol;
      } else {
        c.ex = c.x + dx;
        c.ey = c.y;
        c.ez = c.z + dz;
      }
      c.spin0 = c.spin;
      c.spin1 = c.spin + spin * Math.PI * 2;
      c.tilt0 = c.tiltX;
      c.tilt1 = 0;
      c.arc = arc * (0.72 + hash01(i * 71 + stack.id) * 0.5);
      c.t = 0;
      c.dur = dur;
      c.delay = delay + i * stagger;
      c.ease = ease;
      c.bounce = CHIP_H * 1.1;
      c.onEnd = null;
      last = Math.max(last, c.delay + c.dur + 0.26);
    }
    stack.columns = Math.max(1, Math.ceil(stack.chips.length / colH));
    return this.after(last);
  }

  splash(stack: Stack, power: number): void {
    for (let i = 0; i < stack.chips.length; i++) {
      const c = this.chips[stack.chips[i]];
      const a = hash01(stack.id * 37 + i * 101) * Math.PI * 2;
      const sp = (0.32 + hash01(i * 13 + 7) * 0.5) * power;
      c.mode = MODE_BALLISTIC;
      c.vx = Math.cos(a) * sp;
      c.vz = Math.sin(a) * sp;
      c.vy = (0.55 + hash01(i * 53) * 0.55) * power;
      c.av = (hash01(i * 29) - 0.5) * 26 * power;
      c.rest = 0;
      c.tiltX = (hash01(i * 91) - 0.5) * 0.5;
      c.tiltZ = (hash01(i * 43) - 0.5) * 0.5;
      c.delay = i * 0.004;
      c.onEnd = null;
    }
  }

  fade(stack: Stack, duration: number): Promise<void> {
    const per = Math.max(0.05, duration);
    for (let i = 0; i < stack.chips.length; i++) {
      const c = this.chips[stack.chips[i]];
      c.dying = true;
      c.fadeDur = per;
      // top of the stack goes first, so it reads as being swept away
      c.fade = per * (0.55 + 0.45 * (i / Math.max(1, stack.chips.length - 1)));
    }
    stack.amount = 0;
    return this.after(per + 0.02).then(() => {
      this.releaseStack(stack);
    });
  }

  releaseStack(stack: Stack): void {
    for (const slot of stack.chips) this.killChip(slot);
    stack.chips.length = 0;
    stack.columnOf.length = 0;
    stack.indexInCol.length = 0;
    stack.amount = 0;
    if (stack.alive) {
      stack.alive = false;
      this.freeStacks.push(stack.id);
    }
    this.shadowMesh.setMatrixAt(stack.id, this._zero);
    this.shadowMesh.instanceMatrix.needsUpdate = true;
  }

  releaseAll(): void {
    for (const s of this.stacks) if (s.alive) this.releaseStack(s);
  }

  setChipSet(id: ChipSetId): void {
    const next = id === 'metal' ? DENOMS.length : 0;
    if (next === this.setOffset) return;
    const delta = next - this.setOffset;
    this.setOffset = next;
    for (const c of this.chips) if (c.used) c.row += delta;
  }

  setQuality(tier: PerfTier): void {
    this.shadowMat.opacity = tier === 'low' ? 0.34 : 0.5;
    this.capMat.envMapIntensity = tier === 'low' ? 0.5 : 0.62;
    this.sideMat.envMapIntensity = tier === 'low' ? 0.5 : 0.62;
  }

  /** Resolves after `t` seconds using the render clock, never a timer. */
  private after(t: number): Promise<void> {
    if (t <= 0) return Promise.resolve();
    const key = ++this.seq;
    this.timers.push({ key, t });
    return new Promise<void>((res) => this.pending.set(key, res));
  }
  private timers: Array<{ key: number; t: number }> = [];

  update(dt: number, _elapsed: number): void {
    const d = Math.min(dt, 0.05);

    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      tm.t -= d;
      if (tm.t <= 0) {
        const res = this.pending.get(tm.key);
        this.pending.delete(tm.key);
        this.timers.splice(i, 1);
        if (res) res();
      }
    }

    const restY = FELT_Y + CHIP_H * 0.5;
    let highest = 0;
    for (let i = 0; i < this.cap; i++) {
      const c = this.chips[i];
      if (!c.used) {
        if (c.scale !== 0) {
          c.scale = 0;
          this.mesh.setMatrixAt(i, this._zero);
        }
        continue;
      }
      highest = i + 1;

      if (c.dying) {
        c.fade -= d;
        // shrink with a touch of lift so chips look swept, not deleted
        const k = THREE.MathUtils.clamp(c.fade / c.fadeDur, 0, 1);
        c.scale = k * k;
        c.y += d * 0.06 * (1 - k);
        if (c.fade <= 0) {
          c.scale = 0;
          this.mesh.setMatrixAt(i, this._zero);
          continue;
        }
      }

      if (c.mode === MODE_TWEEN) {
        if (c.delay > 0) {
          c.delay -= d;
        } else {
          c.t += d;
          const total = c.dur + 0.24;
          const u = THREE.MathUtils.clamp(c.t / c.dur, 0, 1);
          const e = c.ease(u);
          c.x = c.sx + (c.ex - c.sx) * e;
          c.z = c.sz + (c.ez - c.sz) * e;
          c.y = c.sy + (c.ey - c.sy) * e + Math.sin(Math.PI * u) * c.arc;
          c.spin = c.spin0 + (c.spin1 - c.spin0) * Ease.out(u);
          c.tiltX = c.tilt0 + (c.tilt1 - c.tilt0) * u;
          c.tiltZ *= 1 - Math.min(1, d * 8);
          if (u >= 1) {
            // landing hop, then rest
            const bt = THREE.MathUtils.clamp((c.t - c.dur) / 0.24, 0, 1);
            c.y = c.ey + Math.abs(Math.sin(Math.PI * bt * 1.85)) * Math.pow(1 - bt, 2.6) * c.bounce;
            if (c.t >= total) {
              c.x = c.ex;
              c.y = c.ey;
              c.z = c.ez;
              c.tiltX = c.tilt1;
              c.tiltZ = 0;
              c.mode = MODE_IDLE;
              const cb = c.onEnd;
              c.onEnd = null;
              if (cb) cb();
            }
          }
        }
      } else if (c.mode === MODE_BALLISTIC) {
        if (c.delay > 0) {
          c.delay -= d;
        } else {
          c.vy -= 3.4 * d;
          c.x += c.vx * d;
          c.y += c.vy * d;
          c.z += c.vz * d;
          c.spin += c.av * d;
          c.tiltX *= 1 - Math.min(1, d * 2.2);
          c.tiltZ *= 1 - Math.min(1, d * 2.2);
          if (c.y <= restY) {
            c.y = restY;
            if (Math.abs(c.vy) > 0.09) {
              c.vy = -c.vy * 0.36;
              c.vx *= 0.7;
              c.vz *= 0.7;
              c.av *= 0.55;
            } else {
              c.vy = 0;
              c.vx *= 1 - Math.min(1, d * 9);
              c.vz *= 1 - Math.min(1, d * 9);
              c.av *= 1 - Math.min(1, d * 9);
              if (Math.hypot(c.vx, c.vz) < 0.01) {
                c.vx = 0;
                c.vz = 0;
                c.av = 0;
                c.tiltX = 0;
                c.tiltZ = 0;
                c.mode = MODE_IDLE;
              }
            }
          }
        }
      }

      this._e.set(c.tiltX, c.spin, c.tiltZ);
      this._q.setFromEuler(this._e);
      this._p.set(c.x, c.y, c.z);
      this._s.setScalar(c.scale);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
      this.rowAttr.setX(i, c.row);
    }

    this.maxUsed = Math.max(highest, 0);
    this.mesh.count = this.maxUsed;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.rowAttr.needsUpdate = true;

    // stack shadows: one soft blob per stack, sized to its footprint
    for (const s of this.stacks) {
      if (!s.alive || s.chips.length === 0) {
        this.shadowMesh.setMatrixAt(s.id, this._zero);
        continue;
      }
      const spread = CHIP_R * (2.5 + (s.columns - 1) * 1.9);
      this._p.set(s.position.x, FELT_Y + 0.0011, s.position.z);
      this._e.set(-Math.PI / 2, 0, 0);
      this._q.setFromEuler(this._e);
      this._s.set(spread, spread, 1);
      this._m.compose(this._p, this._q, this._s);
      this.shadowMesh.setMatrixAt(s.id, this._m);
    }
    this.shadowMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.capMat.dispose();
    this.sideMat.dispose();
    this.shadowGeo.dispose();
    this.shadowMat.dispose();
    this.tex.face.dispose();
    this.tex.facePbr.dispose();
    this.tex.edge.dispose();
    this.tex.edgePbr.dispose();
    this.mesh.dispose();
    this.shadowMesh.dispose();
    this.group.clear();
    this.pending.clear();
    this.timers.length = 0;
  }
}

// ─────────────────────────── helpers ───────────────────────────

function denomIndex(denom: number): number {
  for (let i = 0; i < DENOMS.length; i++) if (DENOMS[i] === denom) return i;
  return 0;
}

/** Deterministic [0,1) — cheaper and more repeatable than Math.random here. */
function hash01(n: number): number {
  let x = (n | 0) + 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** Columns spiral outward so a big pot grows into a cluster, not a wall. */
const COLUMN_RING: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [0.5, 0.87],
  [-0.5, 0.87],
  [-1, 0],
  [-0.5, -0.87],
  [0.5, -0.87],
  [1.5, 0.87],
  [1.5, -0.87],
  [0, 1.74],
  [0, -1.74],
  [-1.5, 0.87],
  [-1.5, -0.87],
  [2, 0],
  [-2, 0],
];
function columnOffset(i: number): [number, number] {
  return COLUMN_RING[i % COLUMN_RING.length];
}

let blobTex: THREE.Texture | null = null;
function makeBlobShadow(): THREE.Texture {
  if (blobTex) return blobTex;
  const size = 96;
  const [c, g] = canvasOf(size, size);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.9)');
  grad.addColorStop(0.4, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0.14)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  blobTex = t;
  return t;
}

export function createChipSystem(opts: { tier?: PerfTier } = {}): ChipSystem {
  return new System(opts.tier ?? 'high');
}

export const CHIP_DIMS = { r: CHIP_R, h: CHIP_H } as const;
