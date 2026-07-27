/**
 * The poker table.
 *
 * An oval sized for a portrait phone: long axis running into the screen so
 * the hero seat lands in the lower third and the board sits just above the
 * optical centre. Everything is a procedural sweep — no imported meshes.
 *
 * Layers, outside in:
 *   floor + contact shadow → pedestal → skirt → padded leather rail →
 *   brushed metal trim bead → felt
 *
 * `layout` is the world-space contract the card and chip systems build
 * against: seat anchors, board slots, pot centre, dealer and muck.
 */
import * as THREE from 'three';
import {
  feltColorFragment,
  feltNormalFragment,
  feltParsFragment,
  feltParsVertex,
  feltRoughnessFragment,
  feltVertex,
} from '../shaders/felt.ts';
import {
  railColorFragment,
  railNormalFragment,
  railParsFragment,
  railParsVertex,
  railRoughnessFragment,
  railVertex,
} from '../shaders/rail.ts';
import { floorFragment, floorVertex } from '../shaders/env.ts';
import { textures } from './textures.ts';

// ─────────────────────────── dimensions ───────────────────────────

/** Playing surface half-extents, in metres. */
const FELT_RX = 0.86;
const FELT_RZ = 1.3;
/** Padded rail: width across the roll and height at the crest. */
const RAIL_W = 0.17;
const RAIL_H = 0.092;
const RAIL_CX = FELT_RX + RAIL_W / 2;
const RAIL_CZ = FELT_RZ + RAIL_W / 2;
const RAIL_OUT_X = FELT_RX + RAIL_W;
const RAIL_OUT_Z = FELT_RZ + RAIL_W;

const FELT_Y = 0;
const CARD_LIFT = 0.0035;
const CHIP_LIFT = 0.002;

const BET_RX = 0.68;
const BET_RZ = 1.0;

const BOARD_PITCH = 0.205;
const BOARD_Z = -0.115;

const FLOOR_Y = -0.88;

const SEG_U = 168;

// ─────────────────────────── seat angles ───────────────────────────

/**
 * Hand-authored per table size. Slot 0 is always the hero at θ=90°, i.e.
 * nearest the camera, and every table is mirror-symmetric about the screen's
 * vertical axis — asymmetric seat rings read as a bug even when they are not.
 */
const SEAT_ANGLES_DEG: Record<number, number[]> = {
  1: [90],
  2: [90, 270],
  3: [90, 210, 330],
  4: [90, 170, 270, 10],
  5: [90, 150, 210, 330, 30],
  6: [90, 150, 205, 270, 335, 30],
  7: [90, 141, 192, 243, 297, 348, 39],
  8: [90, 138, 186, 234, 270, 306, 354, 42],
  9: [90, 130, 170, 210, 250, 290, 330, 10, 50],
};

export interface SeatAnchors {
  slot: number;
  /** radians, 90° = nearest the camera */
  angle: number;
  /** rail crest — where the DOM nameplate pins */
  plate: THREE.Vector3;
  /** felt position for hole cards, index 0..3 (PLO uses all four) */
  cards: THREE.Vector3[];
  /** where this seat's street bet lands, just inside the betting line */
  bet: THREE.Vector3;
  /** where this seat's chip stack rests on the felt */
  stack: THREE.Vector3;
  /** dealer button resting spot when this seat has the button */
  button: THREE.Vector3;
  /** unit vector from the seat toward the table centre */
  inward: THREE.Vector3;
  /** Y rotation that makes a card's "up" point at this seat */
  facing: number;
}

function ellipse(rx: number, rz: number, a: number, y: number): THREE.Vector3 {
  return new THREE.Vector3(rx * Math.cos(a), y, rz * Math.sin(a));
}

function buildSeats(size: number): SeatAnchors[] {
  const degs = SEAT_ANGLES_DEG[size] ?? SEAT_ANGLES_DEG[9];
  return degs.map((deg, slot) => {
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const edge = new THREE.Vector3(FELT_RX * cos, FELT_Y, FELT_RZ * sin);
    const inward = new THREE.Vector3(-edge.x, 0, -edge.z).normalize();
    const tangent = new THREE.Vector3(-inward.z, 0, inward.x);
    const hero = slot === 0;
    const cardR = hero ? 0.845 : 0.8;
    const spread = hero ? 0.062 : 0.05;
    const cardOrigin = new THREE.Vector3(edge.x * cardR, FELT_Y + CARD_LIFT, edge.z * cardR);
    const cards: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      const t = (i - 1.5) * spread;
      cards.push(
        new THREE.Vector3(
          cardOrigin.x + tangent.x * t,
          cardOrigin.y + i * 0.0006,
          cardOrigin.z + tangent.z * t,
        ),
      );
    }
    const betPoint = ellipse(BET_RX, BET_RZ, a, FELT_Y + CHIP_LIFT).multiplyScalar(1);
    betPoint.multiplyScalar(0.9);
    betPoint.y = FELT_Y + CHIP_LIFT;
    const stack = new THREE.Vector3(
      edge.x * 0.9 + tangent.x * 0.2,
      FELT_Y + CHIP_LIFT,
      edge.z * 0.9 + tangent.z * 0.2,
    );
    const button = new THREE.Vector3(
      edge.x * 0.7 - tangent.x * 0.17,
      FELT_Y + 0.004,
      edge.z * 0.7 - tangent.z * 0.17,
    );
    return {
      slot,
      angle: a,
      // Pulled a little inside the rail crest: pinned at the true widest
      // point a 120 px nameplate hangs off the screen on a 360 px device.
      plate: ellipse(RAIL_CX * 0.93, RAIL_CZ * 0.965, a, RAIL_H * 0.96),
      cards,
      bet: betPoint,
      stack,
      button,
      inward,
      facing: Math.atan2(inward.x, inward.z),
    };
  });
}

const SEAT_CACHE = new Map<number, SeatAnchors[]>();
function seatsFor(size: number): SeatAnchors[] {
  const n = Math.max(1, Math.min(9, Math.round(size)));
  let hit = SEAT_CACHE.get(n);
  if (!hit) {
    hit = buildSeats(n);
    SEAT_CACHE.set(n, hit);
  }
  return hit;
}

const BOARD_SLOTS: THREE.Vector3[] = [0, 1, 2, 3, 4].map(
  (i) => new THREE.Vector3((i - 2) * BOARD_PITCH, FELT_Y + CARD_LIFT, BOARD_Z),
);

const SEAT_POSITIONS: Record<number, THREE.Vector3[]> = {};
for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  SEAT_POSITIONS[size] = seatsFor(size).map((s) => s.plate.clone());
}

/**
 * World-space anchor contract. Imported by the card and chip systems:
 *   import { layout } from './table.ts'
 */
export const layout = {
  FELT_RX,
  FELT_RZ,
  FELT_Y,
  RAIL_W,
  RAIL_H,
  RAIL_CX,
  RAIL_CZ,
  RAIL_OUT_X,
  RAIL_OUT_Z,
  FLOOR_Y,
  BET_RX,
  BET_RZ,
  /** rail-crest anchors, keyed by table size */
  SEAT_POSITIONS,
  SEAT_ANGLES_DEG,
  BOARD_SLOTS,
  POT_CENTER: new THREE.Vector3(0, FELT_Y + CHIP_LIFT, 0.24),
  /** deal origin — the dealer's chute at the far end of the felt */
  DEALER_POS: new THREE.Vector3(0, FELT_Y + 0.03, -(FELT_RZ - 0.1)),
  /** folded cards fly here and fade */
  MUCK_POS: new THREE.Vector3(0.46, FELT_Y + 0.02, -(FELT_RZ - 0.26)),
  /** suggested render sizes so cards and chips stay in proportion */
  CARD_SIZE: { w: 0.19, h: 0.265, t: 0.0055 },
  CHIP_SIZE: { r: 0.058, h: 0.011 },
  BOARD_PITCH,
  sizes: [2, 3, 4, 5, 6, 7, 8, 9],
  seats: seatsFor,
  seat(size: number, slot: number): SeatAnchors {
    const all = seatsFor(size);
    return all[((slot % all.length) + all.length) % all.length];
  },
  /** engine seat index → visual slot, so the local player is always slot 0 */
  slotFor(seat: number, heroSeat: number, size: number): number {
    return ((seat - heroSeat) % size + size) % size;
  },
  boardSlot(i: number): THREE.Vector3 {
    return BOARD_SLOTS[Math.max(0, Math.min(4, i))];
  },
};

export type TableLayout = typeof layout;

// ─────────────────────────── skin ───────────────────────────

export type RailMaterialId = 'leather' | 'suede' | 'carbon' | 'wood';
export type TrimMetalId = 'gold' | 'platinum' | 'copper' | 'gunmetal';

export interface TableSkin {
  feltColor: string;
  feltAccent: string;
  feltEdge: string;
  feltSheen: string;
  railMaterial: RailMaterialId;
  railColor: string;
  stitchColor: string;
  seamColor: string;
  logoId: string;
  logoTint: string;
  logoOpacity: number;
  trimMetal: TrimMetalId;
  betLineColor: string;
  betLineStrength: number;
}

export const DEFAULT_SKIN: TableSkin = {
  feltColor: '#103a28',
  feltAccent: '#175139',
  feltEdge: '#06180f',
  feltSheen: '#3f6b54',
  railMaterial: 'leather',
  railColor: '#3a2a20',
  stitchColor: '#8f7448',
  seamColor: '#0a0705',
  logoId: 'royale-classic',
  logoTint: '#dfe4ee',
  logoOpacity: 0.26,
  trimMetal: 'gold',
  betLineColor: '#edc96b',
  betLineStrength: 0.34,
};

const TRIM_METALS: Record<TrimMetalId, { color: string; roughness: number; aniso: number }> = {
  gold: { color: '#b58a30', roughness: 0.66, aniso: 0.3 },
  platinum: { color: '#b4bdcb', roughness: 0.58, aniso: 0.32 },
  copper: { color: '#9d6234', roughness: 0.68, aniso: 0.3 },
  gunmetal: { color: '#474e59', roughness: 0.72, aniso: 0.26 },
};

// ─────────────────────────── geometry builders ───────────────────────────

interface ProfilePoint {
  w: number;
  h: number;
}

/**
 * Sweeps a 2D profile around an ellipse. `w` is the outward offset from the
 * centreline, `h` the height. UVs come out as (around, across-profile), which
 * is exactly what the rail shader's analytic stitching expects.
 */
function buildSweep(
  cx: number,
  cz: number,
  profile: ProfilePoint[],
  segU: number,
): THREE.BufferGeometry {
  const nV = profile.length;
  const count = (segU + 1) * nV;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  // arc-length parameterisation across the profile keeps texel density even
  const vCoord = new Float32Array(nV);
  let total = 0;
  for (let j = 1; j < nV; j++) {
    const dw = profile[j].w - profile[j - 1].w;
    const dh = profile[j].h - profile[j - 1].h;
    total += Math.hypot(dw, dh);
    vCoord[j] = total;
  }
  for (let j = 0; j < nV; j++) vCoord[j] = total > 0 ? vCoord[j] / total : j / Math.max(1, nV - 1);

  // 2D profile normals from neighbour tangents
  const pn = new Float32Array(nV * 2);
  for (let j = 0; j < nV; j++) {
    const a = profile[Math.max(0, j - 1)];
    const b = profile[Math.min(nV - 1, j + 1)];
    let tw = b.w - a.w;
    let th = b.h - a.h;
    const len = Math.hypot(tw, th) || 1;
    tw /= len;
    th /= len;
    pn[j * 2] = -th;
    pn[j * 2 + 1] = tw;
  }

  let p = 0;
  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    const cos = Math.cos(u);
    const sin = Math.sin(u);
    // outward normal of the ellipse in XZ
    let nx = cos / cx;
    let nz = sin / cz;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const px = cx * cos;
    const pz = cz * sin;
    for (let j = 0; j < nV; j++) {
      const prof = profile[j];
      const o = p * 3;
      pos[o] = px + nx * prof.w;
      pos[o + 1] = prof.h;
      pos[o + 2] = pz + nz * prof.w;
      const n2w = pn[j * 2];
      const n2h = pn[j * 2 + 1];
      nor[o] = nx * n2w;
      nor[o + 1] = n2h;
      nor[o + 2] = nz * n2w;
      uvs[p * 2] = i / segU;
      uvs[p * 2 + 1] = vCoord[j];
      p++;
    }
  }

  const idx: number[] = [];
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < nV - 1; j++) {
      const a = i * nV + j;
      const b = (i + 1) * nV + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  fixWinding(geo);
  geo.computeBoundingSphere();
  return geo;
}

/** Flips the index buffer if the first face disagrees with its vertex normals. */
function fixWinding(geo: THREE.BufferGeometry): void {
  const index = geo.getIndex();
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  if (!index || index.count < 3) return;
  const a = index.getX(0);
  const b = index.getX(1);
  const c = index.getX(2);
  const va = new THREE.Vector3().fromBufferAttribute(pos, a);
  const vb = new THREE.Vector3().fromBufferAttribute(pos, b);
  const vc = new THREE.Vector3().fromBufferAttribute(pos, c);
  const face = vb.sub(va).cross(vc.sub(va));
  const vn = new THREE.Vector3().fromBufferAttribute(nor, a);
  if (face.dot(vn) < 0) {
    const arr = index.array as Uint32Array | Uint16Array;
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    index.needsUpdate = true;
  }
}

/**
 * The felt disc. Its boundary is the rail's inner lip pushed 14 mm under the
 * leather, so there is no seam to catch the light no matter the camera angle.
 */
function buildFelt(rings: number, segU: number): THREE.BufferGeometry {
  const bx = RAIL_CX;
  const bz = RAIL_CZ;
  const inset = RAIL_W / 2 - 0.014;
  const count = (segU + 1) * (rings + 1);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  let p = 0;
  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    const cos = Math.cos(u);
    const sin = Math.sin(u);
    let nx = cos / bx;
    let nz = sin / bz;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const ex = bx * cos - nx * inset;
    const ez = bz * sin - nz * inset;
    for (let r = 0; r <= rings; r++) {
      // squared ramp packs vertices toward the rim where the AO gradient is
      const t = Math.pow(r / rings, 0.85);
      const o = p * 3;
      pos[o] = ex * t;
      pos[o + 1] = FELT_Y;
      pos[o + 2] = ez * t;
      nor[o] = 0;
      nor[o + 1] = 1;
      nor[o + 2] = 0;
      // world-space UV so the fibre tiles evenly, no polar pinch
      uvs[p * 2] = ex * t;
      uvs[p * 2 + 1] = ez * t;
      p++;
    }
  }
  const idx: number[] = [];
  const stride = rings + 1;
  for (let i = 0; i < segU; i++) {
    for (let r = 0; r < rings; r++) {
      const a = i * stride + r;
      const b = (i + 1) * stride + r;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  fixWinding(geo);
  geo.computeBoundingSphere();
  return geo;
}

/** Flat elliptical cap, used to close the pedestal and the skirt underside. */
function buildCap(rx: number, rz: number, y: number, segU: number, up: boolean): THREE.BufferGeometry {
  const pos = new Float32Array((segU + 2) * 3);
  const nor = new Float32Array((segU + 2) * 3);
  const uvs = new Float32Array((segU + 2) * 2);
  pos[1] = y;
  nor[1] = up ? 1 : -1;
  uvs[0] = 0.5;
  uvs[1] = 0.5;
  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    const o = (i + 1) * 3;
    pos[o] = rx * Math.cos(u);
    pos[o + 1] = y;
    pos[o + 2] = rz * Math.sin(u);
    nor[o + 1] = up ? 1 : -1;
    uvs[(i + 1) * 2] = Math.cos(u) * 0.5 + 0.5;
    uvs[(i + 1) * 2 + 1] = Math.sin(u) * 0.5 + 0.5;
  }
  const idx: number[] = [];
  for (let i = 1; i <= segU; i++) idx.push(0, i, i + 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  fixWinding(geo);
  geo.computeBoundingSphere();
  return geo;
}

// ─────────────────────────── the table ───────────────────────────

export interface TableHandle {
  group: THREE.Group;
  felt: THREE.Mesh;
  rail: THREE.Mesh;
  trim: THREE.Mesh;
  skin: TableSkin;
  setSkin(params: Partial<TableSkin>): void;
  /** Tells the felt where the key light lands so the pool matches. */
  setLightPool(x: number, z: number, inner: number, outer: number, strength: number): void;
  setQuality(tier: 'low' | 'mid' | 'high'): void;
  update(elapsed: number): void;
  dispose(): void;
}

export function createTable(env: THREE.Texture | null): TableHandle {
  const tex = textures();
  const group = new THREE.Group();
  group.name = 'table';

  const skin: TableSkin = { ...DEFAULT_SKIN };

  // ── felt ───────────────────────────────────────────────────────────
  const feltUniforms = {
    uFeltRadii: { value: new THREE.Vector2(FELT_RX, FELT_RZ) },
    uFeltEdge: { value: new THREE.Color(skin.feltEdge) },
    uFeltAccent: { value: new THREE.Color(skin.feltAccent) },
    uFiberScale: { value: 30.0 },
    uNapStrength: { value: 0.055 },
    uWear: { value: 0.2 },
    uLogoMap: { value: tex.get(`logo:${skin.logoId}`) },
    uLogoRect: { value: new THREE.Vector4(0, 0.06, 0.34, 0.34) },
    uLogoTint: { value: new THREE.Color(skin.logoTint) },
    uLogoOpacity: { value: skin.logoOpacity },
    uBetRadii: { value: new THREE.Vector2(BET_RX, BET_RZ) },
    uBetColor: { value: new THREE.Color(skin.betLineColor) },
    uBetStrength: { value: skin.betLineStrength },
    uPool: { value: new THREE.Vector4(0, -0.05, 0.5, 1.95) },
    uPoolStrength: { value: 0.3 },
    uPoolTint: { value: new THREE.Color('#3a2a12') },
  };

  const feltMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(skin.feltColor),
    roughness: 0.95,
    metalness: 0,
    sheen: 0.3,
    sheenColor: new THREE.Color(skin.feltSheen),
    sheenRoughness: 0.85,
    normalMap: tex.get('felt-normal'),
    normalScale: new THREE.Vector2(0.62, 0.62),
    roughnessMap: tex.get('felt-rough'),
    envMapIntensity: 0.07,
    dithering: true,
  });
  feltMat.normalMap!.repeat.set(4.5, 4.5);
  feltMat.roughnessMap!.repeat.set(9, 9);
  feltMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, feltUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${feltParsVertex}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${feltVertex}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${feltParsFragment}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${feltColorFragment}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${feltRoughnessFragment}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${feltNormalFragment}`,
      );
  };
  feltMat.customProgramCacheKey = () => 'royale-felt-v1';

  const felt = new THREE.Mesh(buildFelt(14, SEG_U), feltMat);
  felt.name = 'felt';
  felt.receiveShadow = true;
  felt.renderOrder = 0;
  group.add(felt);

  // ── rail ───────────────────────────────────────────────────────────
  const hw = RAIL_W / 2;
  const railProfile: ProfilePoint[] = [
    { w: -hw - 0.006, h: 0.004 },
    { w: -hw + 0.004, h: 0.016 },
    { w: -hw + 0.014, h: 0.038 },
    { w: -hw + 0.032, h: 0.062 },
    { w: -hw + 0.056, h: 0.081 },
    { w: -0.012, h: RAIL_H },
    { w: 0.022, h: RAIL_H - 0.002 },
    { w: hw - 0.05, h: 0.079 },
    { w: hw - 0.026, h: 0.058 },
    { w: hw - 0.008, h: 0.03 },
    { w: hw, h: 0.008 },
    { w: hw - 0.002, h: -0.012 },
    { w: hw - 0.014, h: -0.03 },
  ];

  const railUniforms = {
    uGrainScale: { value: 5.5 },
    uGrainDepth: { value: 0.18 },
    uCreaseDepth: { value: 0.2 },
    uSeamColor: { value: new THREE.Color(skin.seamColor) },
    uThreadColor: { value: new THREE.Color(skin.stitchColor) },
    uCrestTint: { value: new THREE.Color('#c9a878') },
    uStitch: { value: new THREE.Vector4(0.2, 148.0, 0.014, 0.026) },
    uStitchOn: { value: 1.0 },
    uPolish: { value: 0.85 },
    uRailWear: { value: 0.12 },
    uArcAspect: { value: 7.4 },
  };

  const railMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(skin.railColor),
    roughness: 0.64,
    metalness: 0,
    clearcoat: 0.42,
    clearcoatRoughness: 0.36,
    normalMap: tex.get('leather-normal'),
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughnessMap: tex.get('leather-rough'),
    aoMap: tex.get('rail-ao'),
    aoMapIntensity: 0.9,
    envMapIntensity: 1.45,
    dithering: true,
  });
  railMat.normalMap!.repeat.set(20, 3);
  railMat.roughnessMap!.repeat.set(20, 3);
  railMat.aoMap!.repeat.set(1, 1);
  railMat.aoMap!.wrapS = THREE.ClampToEdgeWrapping;
  railMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, railUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${railParsVertex}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${railVertex}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${railParsFragment}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${railColorFragment}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n${railRoughnessFragment}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${railNormalFragment}`,
      );
  };
  railMat.customProgramCacheKey = () => 'royale-rail-v1';

  const rail = new THREE.Mesh(buildSweep(RAIL_CX, RAIL_CZ, railProfile, SEG_U), railMat);
  rail.name = 'rail';
  rail.castShadow = true;
  rail.receiveShadow = true;
  group.add(rail);

  // ── metal trim bead between felt and leather ───────────────────────
  const trimMeta = TRIM_METALS[skin.trimMetal];
  const trimMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(trimMeta.color),
    metalness: 1,
    roughness: trimMeta.roughness,
    roughnessMap: tex.get('metal-rough'),
    normalMap: tex.get('metal-normal'),
    normalScale: new THREE.Vector2(0.18, 0.18),
    anisotropy: trimMeta.aniso,
    anisotropyRotation: 0,
    envMapIntensity: 0.34,
    dithering: true,
  });
  trimMat.roughnessMap!.repeat.set(6, 1);
  trimMat.normalMap!.repeat.set(6, 1);

  const beadR = 0.017;
  const beadProfile: ProfilePoint[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * (1 - i / 10);
    beadProfile.push({ w: Math.cos(a) * beadR, h: 0.006 + Math.sin(a) * beadR });
  }
  const trimCX = FELT_RX + 0.004;
  const trimCZ = FELT_RZ + 0.004;
  const trim = new THREE.Mesh(buildSweep(trimCX, trimCZ, beadProfile, SEG_U), trimMat);
  trim.name = 'trim';
  trim.castShadow = false;
  trim.receiveShadow = true;
  group.add(trim);

  // ── outer trim band around the skirt ───────────────────────────────
  const bandProfile: ProfilePoint[] = [
    { w: 0.0, h: -0.028 },
    { w: 0.004, h: -0.034 },
    { w: 0.005, h: -0.052 },
    { w: 0.001, h: -0.07 },
    { w: -0.004, h: -0.078 },
  ];
  const band = new THREE.Mesh(
    buildSweep(RAIL_OUT_X - 0.014, RAIL_OUT_Z - 0.014, bandProfile, SEG_U),
    trimMat,
  );
  band.name = 'trim-band';
  group.add(band);

  // ── skirt + pedestal ───────────────────────────────────────────────
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#0b0d12'),
    roughness: 0.44,
    metalness: 0.25,
    clearcoat: 0.3,
    clearcoatRoughness: 0.5,
    envMapIntensity: 0.5,
    dithering: true,
  });

  const skirtProfile: ProfilePoint[] = [
    { w: -0.012, h: -0.072 },
    { w: -0.026, h: -0.11 },
    { w: -0.05, h: -0.17 },
    { w: -0.086, h: -0.225 },
    { w: -0.13, h: -0.256 },
  ];
  const skirt = new THREE.Mesh(
    buildSweep(RAIL_OUT_X - 0.014, RAIL_OUT_Z - 0.014, skirtProfile, SEG_U),
    bodyMat,
  );
  skirt.name = 'skirt';
  skirt.castShadow = true;
  group.add(skirt);

  const underCap = new THREE.Mesh(
    buildCap(RAIL_OUT_X - 0.144, RAIL_OUT_Z - 0.144, -0.256, 64, false),
    bodyMat,
  );
  group.add(underCap);

  const columnProfile: ProfilePoint[] = [
    { w: 0.0, h: -0.256 },
    { w: -0.02, h: -0.34 },
    { w: -0.03, h: -0.58 },
    { w: -0.014, h: -0.78 },
    { w: 0.06, h: -0.85 },
    { w: 0.09, h: FLOOR_Y + 0.005 },
  ];
  const column = new THREE.Mesh(buildSweep(0.3, 0.42, columnProfile, 72), bodyMat);
  column.name = 'pedestal';
  column.castShadow = true;
  group.add(column);

  const footCap = new THREE.Mesh(buildCap(0.39, 0.51, FLOOR_Y + 0.005, 64, true), bodyMat);
  group.add(footCap);

  // ── floor + contact shadow ─────────────────────────────────────────
  const floorUniforms = {
    uNear: { value: new THREE.Color('#0b0d13') },
    uFar: { value: new THREE.Color('#04050a') },
    uTableRadii: { value: new THREE.Vector2(RAIL_OUT_X, RAIL_OUT_Z) },
    uShadow: { value: 0.62 },
  };
  const floorMat = new THREE.ShaderMaterial({
    uniforms: floorUniforms,
    vertexShader: floorVertex,
    fragmentShader: floorFragment,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(11, 11, 1, 1), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.name = 'floor';
  floor.renderOrder = -2;
  group.add(floor);

  const contactMat = new THREE.MeshBasicMaterial({
    map: tex.get('radial-shadow'),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    toneMapped: false,
    color: 0x000000,
  });
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), contactMat);
  contact.scale.set(RAIL_OUT_X * 2.7, RAIL_OUT_Z * 2.2, 1);
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = FLOOR_Y + 0.004;
  contact.renderOrder = -1;
  contact.name = 'contact-shadow';
  group.add(contact);

  // ── env map wiring ─────────────────────────────────────────────────
  const materials = [feltMat, railMat, trimMat, bodyMat];
  if (env) for (const m of materials) m.envMap = env;

  // ─────────────────────── skin application ────────────────────────
  function applyRailMaterial(id: RailMaterialId): void {
    const t = textures();
    switch (id) {
      case 'leather':
        railMat.map = null;
        railMat.normalMap = t.get('leather-normal');
        railMat.roughnessMap = t.get('leather-rough');
        railMat.normalScale.set(0.5, 0.5);
        railMat.roughness = 0.64;
        railMat.metalness = 0;
        railMat.clearcoat = 0.42;
        railMat.clearcoatRoughness = 0.36;
        railMat.sheen = 0;
        railUniforms.uStitchOn.value = 1;
        railUniforms.uGrainScale.value = 34;
        railUniforms.uPolish.value = 0.7;
        railMat.normalMap.repeat.set(22, 3);
        railMat.roughnessMap.repeat.set(22, 3);
        break;
      case 'suede':
        railMat.map = null;
        railMat.normalMap = t.get('suede-normal');
        railMat.roughnessMap = null;
        railMat.normalScale.set(0.5, 0.5);
        railMat.roughness = 0.95;
        railMat.metalness = 0;
        railMat.clearcoat = 0;
        railMat.sheen = 1;
        railMat.sheenRoughness = 0.6;
        railMat.sheenColor.set('#6a5a4a');
        railUniforms.uStitchOn.value = 1;
        railUniforms.uGrainScale.value = 46;
        railUniforms.uPolish.value = 0.25;
        railMat.normalMap.repeat.set(26, 4);
        break;
      case 'carbon':
        railMat.map = null;
        railMat.normalMap = t.get('carbon-normal');
        railMat.roughnessMap = null;
        railMat.normalScale.set(0.7, 0.7);
        railMat.roughness = 0.3;
        railMat.metalness = 0.2;
        railMat.clearcoat = 0.85;
        railMat.clearcoatRoughness = 0.14;
        railMat.sheen = 0;
        railUniforms.uStitchOn.value = 0;
        railUniforms.uGrainScale.value = 20;
        railUniforms.uPolish.value = 0.4;
        railMat.normalMap.repeat.set(30, 4);
        break;
      case 'wood':
        railMat.map = t.get('wood-color');
        railMat.normalMap = t.get('wood-normal');
        railMat.roughnessMap = t.get('wood-rough');
        railMat.normalScale.set(0.55, 0.55);
        railMat.roughness = 0.2;
        railMat.metalness = 0;
        railMat.clearcoat = 0.95;
        railMat.clearcoatRoughness = 0.08;
        railMat.sheen = 0;
        railUniforms.uStitchOn.value = 0;
        railUniforms.uGrainScale.value = 14;
        railUniforms.uPolish.value = 0.5;
        railMat.map.repeat.set(6, 1);
        railMat.normalMap.repeat.set(6, 1);
        railMat.roughnessMap.repeat.set(6, 1);
        break;
    }
    if (env) railMat.envMap = env;
    railMat.needsUpdate = true;
  }

  function setSkin(params: Partial<TableSkin>): void {
    Object.assign(skin, params);
    feltMat.color.set(skin.feltColor);
    feltMat.sheenColor.set(skin.feltSheen);
    feltUniforms.uFeltAccent.value.set(skin.feltAccent);
    feltUniforms.uFeltEdge.value.set(skin.feltEdge);
    feltUniforms.uBetColor.value.set(skin.betLineColor);
    feltUniforms.uBetStrength.value = skin.betLineStrength;
    feltUniforms.uLogoTint.value.set(skin.logoTint);
    feltUniforms.uLogoOpacity.value = skin.logoOpacity;
    feltUniforms.uLogoMap.value = textures().get(`logo:${skin.logoId}`);

    railMat.color.set(skin.railMaterial === 'wood' ? '#ffffff' : skin.railColor);
    railUniforms.uThreadColor.value.set(skin.stitchColor);
    railUniforms.uSeamColor.value.set(skin.seamColor);
    if (params.railMaterial !== undefined || !railMat.userData.railApplied) {
      applyRailMaterial(skin.railMaterial);
      railMat.userData.railApplied = true;
    }

    const meta = TRIM_METALS[skin.trimMetal] ?? TRIM_METALS.gold;
    trimMat.color.set(meta.color);
    trimMat.roughness = meta.roughness;
    trimMat.anisotropy = meta.aniso;
    trimMat.needsUpdate = true;
  }

  setSkin({});

  let quality: 'low' | 'mid' | 'high' = 'high';

  return {
    group,
    felt,
    rail,
    trim,
    skin,
    setSkin,
    setLightPool(x, z, inner, outer, strength) {
      feltUniforms.uPool.value.set(x, z, inner, outer);
      feltUniforms.uPoolStrength.value = strength;
    },
    setQuality(tier) {
      quality = tier;
      const low = tier === 'low';
      feltMat.sheen = low ? 0 : 0.85;
      railMat.clearcoat = low ? 0 : skin.railMaterial === 'wood' ? 0.95 : 0.42;
      trimMat.anisotropy = low ? 0 : (TRIM_METALS[skin.trimMetal] ?? TRIM_METALS.gold).aniso;
      contact.visible = tier !== 'low';
      feltUniforms.uWear.value = low ? 0.08 : 0.16;
      feltMat.needsUpdate = true;
      railMat.needsUpdate = true;
      trimMat.needsUpdate = true;
    },
    update() {
      /* the table is static geometry; light pool + skin drive all change */
      void quality;
    },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      for (const m of materials) m.dispose();
      floorMat.dispose();
      contactMat.dispose();
    },
  };
}
