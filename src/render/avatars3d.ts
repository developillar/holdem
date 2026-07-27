/**
 * Seat presence.
 *
 * Not a character — a medallion. Each seat gets a machined disc floating just
 * above the rail: a dark glass plate, a gold inner bezel, a rarity frame, the
 * player's generated portrait, and a plinth underneath that the DOM stack pill
 * lands on. Text stays in the DOM; this is the physical object it sits on.
 *
 * The medallion is what carries emotion at a poker table, so it acts:
 *   idle       — a slow breath, out of phase per seat so nine seats never pulse
 *                together
 *   turn       — leans in toward the table and lights a ring
 *   fold       — slumps back and desaturates
 *   win        — a spring pop with a gold flash across the frame
 *   heat       — a procedural flame ring when the player is running hot
 *
 * The DEALER BUTTON is a real object here too: a machined puck that skates
 * around the ellipse between hands with a spin and a settle.
 */
import * as THREE from 'three';
import type { Rarity } from '../core/types.ts';

// ═══════════════════════════════════════════════════════════════════
// ADAPTER — the only coupling to sibling render modules.
// ═══════════════════════════════════════════════════════════════════
import { layout, type SeatAnchors } from './table.ts';
import type { PerfTier } from './renderer.ts';

const RAIL_H = layout.RAIL_H ?? 0.092;
// ═══════════════════════════════════════════════════════════════════

const R = 0.105;
const PLATE_T = 0.016;

// ─────────────────────────── palette ───────────────────────────

const RARITY_COLOR: Record<Rarity, string> = {
  common: '#8891a5',
  rare: '#47a9ff',
  epic: '#a855f7',
  legendary: '#f5a524',
  mythic: '#ff4d8d',
};

const RARITY_GLOW: Record<Rarity, number> = {
  common: 0.06,
  rare: 0.3,
  epic: 0.55,
  legendary: 0.8,
  mythic: 1,
};

/** Cosmetic frame ids carry their tier in the id; unknown falls back sanely. */
export function rarityForFrame(frameId: string | null | undefined): Rarity {
  if (!frameId) return 'common';
  const id = frameId.toLowerCase();
  if (id.includes('mythic')) return 'mythic';
  if (id.includes('legend')) return 'legendary';
  if (id.includes('epic')) return 'epic';
  if (id.includes('rare')) return 'rare';
  return 'common';
}

// ─────────────────────────── portrait art ───────────────────────────

const ART_SIZE = 192;
const artCache = new Map<string, THREE.CanvasTexture>();

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    const p = parts[0];
    return (p[0] + (p[1] ?? '')).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A deterministic geometric portrait. Five emblem families, a hue locked to
 * the id and a monogram — never an emoji, never a stock face, and identical
 * on every device for the same player.
 */
function buildPortrait(avatarId: string, name: string): THREE.CanvasTexture {
  const key = `${avatarId}|${name}`;
  const hit = artCache.get(key);
  if (hit) return hit;

  const c = document.createElement('canvas');
  c.width = ART_SIZE;
  c.height = ART_SIZE;
  const g = c.getContext('2d')!;
  const h = hashStr(key);
  const hue = h % 360;
  const emblem = (h >> 9) % 5;
  const S = ART_SIZE;

  const base = `hsl(${hue}, 42%, 22%)`;
  const deep = `hsl(${(hue + 26) % 360}, 48%, 11%)`;
  const lift = `hsl(${(hue + 340) % 360}, 60%, 46%)`;

  const bg = g.createLinearGradient(0, 0, S * 0.6, S);
  bg.addColorStop(0, base);
  bg.addColorStop(1, deep);
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);

  g.save();
  g.globalAlpha = 0.34;
  g.strokeStyle = lift;
  g.fillStyle = lift;
  g.lineWidth = S * 0.018;
  switch (emblem) {
    case 0: // concentric arcs
      for (let i = 1; i <= 5; i++) {
        g.beginPath();
        g.arc(S * 0.5, S * 0.94, S * 0.15 * i, Math.PI * 1.08, Math.PI * 1.92);
        g.stroke();
      }
      break;
    case 1: // chevrons
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        g.moveTo(0, S * (0.15 * i));
        g.lineTo(S * 0.5, S * (0.15 * i + 0.18));
        g.lineTo(S, S * (0.15 * i));
        g.stroke();
      }
      break;
    case 2: // diamond lattice
      for (let x = -1; x < 6; x++) {
        for (let y = -1; y < 6; y++) {
          g.beginPath();
          const cx = (x + (y % 2) * 0.5) * S * 0.24;
          const cy = y * S * 0.24;
          g.moveTo(cx, cy - S * 0.07);
          g.lineTo(cx + S * 0.06, cy);
          g.lineTo(cx, cy + S * 0.07);
          g.lineTo(cx - S * 0.06, cy);
          g.closePath();
          g.stroke();
        }
      }
      break;
    case 3: // sunburst
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        g.beginPath();
        g.moveTo(S * 0.5, S * 0.5);
        g.lineTo(S * 0.5 + Math.cos(a) * S, S * 0.5 + Math.sin(a) * S);
        g.lineWidth = i % 2 ? S * 0.03 : S * 0.012;
        g.stroke();
      }
      break;
    default: // stacked bars
      for (let i = 0; i < 7; i++) {
        g.globalAlpha = 0.1 + (i % 3) * 0.11;
        g.fillRect(0, S * (i * 0.145), S, S * 0.06);
      }
      break;
  }
  g.restore();

  // top light + floor bounce so the disc reads as lit, not printed
  const hi = g.createRadialGradient(S * 0.34, S * 0.2, S * 0.02, S * 0.34, S * 0.2, S * 0.85);
  hi.addColorStop(0, 'rgba(255,255,255,0.28)');
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hi;
  g.fillRect(0, 0, S, S);
  const vig = g.createRadialGradient(S * 0.5, S * 0.5, S * 0.24, S * 0.5, S * 0.56, S * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.52)');
  g.fillStyle = vig;
  g.fillRect(0, 0, S, S);

  // monogram
  const label = initialsOf(name || avatarId);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 ${S * 0.42}px -apple-system, 'SF Pro Display', 'Segoe UI', Inter, sans-serif`;
  g.fillStyle = 'rgba(0,0,0,0.4)';
  g.fillText(label, S * 0.5, S * 0.545);
  g.fillStyle = 'rgba(250,252,255,0.94)';
  g.fillText(label, S * 0.5, S * 0.53);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  artCache.set(key, t);
  return t;
}

function buildButtonFace(): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, S, S);
  grad.addColorStop(0, '#fdfcf7');
  grad.addColorStop(0.5, '#eae5d6');
  grad.addColorStop(1, '#cfc7b2');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#c08d21';
  g.lineWidth = S * 0.045;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.42, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(99,70,10,0.35)';
  g.lineWidth = S * 0.012;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.36, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#171c28';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `800 ${S * 0.46}px -apple-system, 'SF Pro Display', 'Segoe UI', Inter, sans-serif`;
  g.fillText('D', S / 2, S * 0.53);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ─────────────────────────── heat ring shader ───────────────────────────

const HEAT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HEAT_FRAG = /* glsl */ `
uniform float uTime;
uniform float uHeat;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float a = atan(p.y, p.x);

  // three detuned harmonics read as turbulence for a fraction of the cost
  // of noise, and they never repeat visibly because the periods are coprime
  float n = sin(a * 7.0 + uTime * 3.1) * 0.5
          + sin(a * 13.0 - uTime * 4.7) * 0.3
          + sin(a * 23.0 + uTime * 6.3) * 0.2;

  float inner = 0.66;
  float outer = 0.78 + n * 0.11 * uHeat + uHeat * 0.14;
  float flame = smoothstep(inner - 0.06, inner + 0.05, d) * (1.0 - smoothstep(outer - 0.16, outer, d));
  if (flame <= 0.004) discard;

  float k = clamp((d - inner) / max(0.001, outer - inner), 0.0, 1.0);
  vec3 hot  = vec3(1.0, 0.94, 0.72);
  vec3 mid  = vec3(1.0, 0.66, 0.18);
  vec3 cool = vec3(0.82, 0.16, 0.08);
  vec3 col = mix(hot, mid, smoothstep(0.0, 0.45, k));
  col = mix(col, cool, smoothstep(0.45, 1.0, k));

  gl_FragColor = vec4(col, flame * uHeat * (1.0 - k * 0.4));
}
`;

// ─────────────────────────── spring ───────────────────────────

class Spring {
  value: number;
  target: number;
  private v = 0;
  private k: number;
  private d: number;
  constructor(value: number, stiffness = 120, damping = 18) {
    this.value = value;
    this.target = value;
    this.k = stiffness;
    this.d = damping;
  }
  step(dt: number): number {
    const a = (this.target - this.value) * this.k - this.v * this.d;
    this.v += a * dt;
    this.value += this.v * dt;
    return this.value;
  }
  set(v: number): void {
    this.value = v;
    this.target = v;
    this.v = 0;
  }
  kick(v: number): void {
    this.v += v;
  }
  get settled(): boolean {
    return Math.abs(this.v) < 0.0005 && Math.abs(this.target - this.value) < 0.0005;
  }
}

// ─────────────────────────── public shape ───────────────────────────

export interface SeatVisual {
  occupied: boolean;
  name: string;
  avatarId: string;
  rarity: Rarity;
  folded: boolean;
  turn: boolean;
  allIn: boolean;
  won: boolean;
  /** 0-1 → flame ring intensity */
  heat: number;
  sittingOut: boolean;
}

export interface AvatarSystem {
  readonly group: THREE.Group;
  setTableSize(size: number): void;
  setHeroSeat(seat: number): void;
  /** null clears the seat. Partial updates merge. */
  setSeat(seat: number, v: Partial<SeatVisual> | null): void;
  /** slides the dealer button to a seat */
  setButton(seat: number, animate?: boolean): void;
  /** win pop */
  celebrate(seat: number): void;
  /** a nudge — use on bet/raise so the medallion reacts to its own action */
  bump(seat: number, amount?: number): void;
  /** world point of the medallion centre, for DOM pinning and FX targeting */
  anchor(seat: number): THREE.Vector3 | null;
  setVisible(seat: number, on: boolean): void;
  setQuality(tier: PerfTier): void;
  update(dt: number, elapsed: number, camera?: THREE.Camera | null): void;
  dispose(): void;
}

interface SeatNode {
  seat: number;
  group: THREE.Group;
  billboard: THREE.Group;
  plateMat: THREE.MeshPhysicalMaterial;
  artMat: THREE.MeshBasicMaterial;
  frameMat: THREE.MeshStandardMaterial;
  glowMat: THREE.MeshBasicMaterial;
  heatMat: THREE.ShaderMaterial;
  heatMesh: THREE.Mesh;
  glowMesh: THREE.Mesh;
  plinth: THREE.Mesh;
  base: THREE.Vector3;
  inward: THREE.Vector3;
  facing: number;
  phase: number;
  lean: Spring;
  pop: Spring;
  slump: Spring;
  glow: Spring;
  flash: number;
  vis: SeatVisual;
  visible: boolean;
}

function blankVisual(): SeatVisual {
  return {
    occupied: false,
    name: '',
    avatarId: '',
    rarity: 'common',
    folded: false,
    turn: false,
    allIn: false,
    won: false,
    heat: 0,
    sittingOut: false,
  };
}

// ─────────────────────────── geometry helpers ───────────────────────────

function roundedPlate(w: number, h: number, r: number, depth: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hh = h / 2;
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.35,
    bevelSize: depth * 0.35,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.center();
  return geo;
}

// ─────────────────────────── implementation ───────────────────────────

class Avatars implements AvatarSystem {
  readonly group = new THREE.Group();

  private nodes: SeatNode[] = [];
  private size = 9;
  private hero = 0;
  private tier: PerfTier;

  private plateGeo: THREE.CylinderGeometry;
  private artGeo: THREE.CircleGeometry;
  private bezelGeo: THREE.TorusGeometry;
  private frameGeo: THREE.TorusGeometry;
  private ringGeo: THREE.RingGeometry;
  private heatGeo: THREE.PlaneGeometry;
  private plinthGeo: THREE.ExtrudeGeometry;
  private bezelMat: THREE.MeshStandardMaterial;
  private plinthMat: THREE.MeshPhysicalMaterial;

  private button: THREE.Group;
  private buttonMats: THREE.Material[] = [];
  private buttonSeat = -1;
  private btnFrom = new THREE.Vector3();
  private btnTo = new THREE.Vector3();
  private btnT = 1;
  private btnDur = 0.62;
  private btnSpin = 0;

  private _q = new THREE.Quaternion();
  private _v = new THREE.Vector3();

  constructor(tier: PerfTier) {
    this.group.name = 'avatars';
    this.tier = tier;

    this.plateGeo = new THREE.CylinderGeometry(R, R * 0.985, PLATE_T, 46, 1);
    this.plateGeo.rotateX(Math.PI / 2);
    this.artGeo = new THREE.CircleGeometry(R * 0.83, 44);
    this.bezelGeo = new THREE.TorusGeometry(R * 0.86, R * 0.062, 8, 46);
    this.frameGeo = new THREE.TorusGeometry(R * 1.0, R * 0.056, 8, 50);
    this.ringGeo = new THREE.RingGeometry(R * 1.06, R * 1.34, 52);
    this.heatGeo = new THREE.PlaneGeometry(R * 3.1, R * 3.1);
    this.plinthGeo = roundedPlate(R * 2.05, R * 0.62, R * 0.2, 0.012);

    this.bezelMat = new THREE.MeshStandardMaterial({
      color: 0xd9a93a,
      metalness: 0.94,
      roughness: 0.24,
      envMapIntensity: 1.25,
    });
    this.plinthMat = new THREE.MeshPhysicalMaterial({
      color: 0x0d1119,
      metalness: 0.2,
      roughness: 0.4,
      clearcoat: 0.7,
      clearcoatRoughness: 0.22,
      envMapIntensity: 0.9,
    });

    for (let i = 0; i < 9; i++) this.nodes.push(this.makeNode(i));

    this.button = this.makeButton();
    this.group.add(this.button);

    this.layoutSeats();
  }

  private makeNode(seat: number): SeatNode {
    const group = new THREE.Group();
    group.name = `seat-${seat}`;
    group.visible = false;

    const billboard = new THREE.Group();
    group.add(billboard);

    const plateMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b0e16,
      metalness: 0.35,
      roughness: 0.34,
      clearcoat: 0.85,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.1,
    });
    const plate = new THREE.Mesh(this.plateGeo, plateMat);
    billboard.add(plate);

    // transparent from birth: toggling the flag later would recompile the
    // shader mid-hand, which is a guaranteed hitch on a phone
    const artMat = new THREE.MeshBasicMaterial({ toneMapped: true, transparent: true, depthWrite: true });
    const art = new THREE.Mesh(this.artGeo, artMat);
    art.position.z = PLATE_T * 0.51;
    billboard.add(art);

    const bezel = new THREE.Mesh(this.bezelGeo, this.bezelMat);
    bezel.position.z = PLATE_T * 0.42;
    billboard.add(bezel);

    const frameMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(RARITY_COLOR.common),
      metalness: 0.72,
      roughness: 0.3,
      emissive: new THREE.Color(RARITY_COLOR.common),
      emissiveIntensity: 0.06,
      envMapIntensity: 1.2,
    });
    const frame = new THREE.Mesh(this.frameGeo, frameMat);
    frame.position.z = PLATE_T * 0.1;
    billboard.add(frame);

    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xedc96b,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const glowMesh = new THREE.Mesh(this.ringGeo, glowMat);
    glowMesh.position.z = -PLATE_T * 0.2;
    glowMesh.visible = false;
    billboard.add(glowMesh);

    const heatMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uHeat: { value: 0 } },
      vertexShader: HEAT_VERT,
      fragmentShader: HEAT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    const heatMesh = new THREE.Mesh(this.heatGeo, heatMat);
    heatMesh.position.z = -PLATE_T * 0.35;
    heatMesh.visible = false;
    billboard.add(heatMesh);

    const plinth = new THREE.Mesh(this.plinthGeo, this.plinthMat);
    group.add(plinth);

    this.group.add(group);

    return {
      seat,
      group,
      billboard,
      plateMat,
      artMat,
      frameMat,
      glowMat,
      heatMat,
      heatMesh,
      glowMesh,
      plinth,
      base: new THREE.Vector3(),
      inward: new THREE.Vector3(0, 0, -1),
      facing: 0,
      phase: seat * 1.7,
      lean: new Spring(0, 140, 20),
      pop: new Spring(1, 220, 17),
      slump: new Spring(0, 110, 19),
      glow: new Spring(0, 90, 16),
      flash: 0,
      vis: blankVisual(),
      visible: true,
    };
  }

  private makeButton(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'dealer-button';
    const r = 0.038;
    const h = 0.011;
    const body = new THREE.CylinderGeometry(r, r * 0.96, h, 34, 1);
    const faceTex = buildButtonFace();
    const side = new THREE.MeshStandardMaterial({
      color: 0xd8d2c0,
      metalness: 0.55,
      roughness: 0.34,
      envMapIntensity: 1.1,
    });
    const face = new THREE.MeshStandardMaterial({
      map: faceTex,
      color: 0xffffff,
      metalness: 0.25,
      roughness: 0.3,
      envMapIntensity: 1.1,
    });
    const mesh = new THREE.Mesh(body, [side, face, face]);
    g.add(mesh);
    // a gold collar picks up the rail light and stops the puck reading flat
    const collarGeo = new THREE.TorusGeometry(r * 0.99, h * 0.28, 6, 34);
    const collar = new THREE.Mesh(collarGeo, this.bezelMat);
    collar.rotation.x = Math.PI / 2;
    g.add(collar);
    this.buttonMats.push(side, face);
    g.visible = false;
    g.userData.geos = [body, collarGeo];
    return g;
  }

  private layoutSeats(): void {
    const seats = layout.seats(this.size) as SeatAnchors[];
    for (let seat = 0; seat < 9; seat++) {
      const node = this.nodes[seat];
      if (seat >= this.size) {
        node.group.visible = false;
        continue;
      }
      const slot = layout.slotFor(seat, this.hero, this.size);
      const a = seats[slot];
      // sit the medallion just outboard of the rail crest and lift it clear
      const out = 1.045;
      node.base.set(a.plate.x * out, RAIL_H + 0.128, a.plate.z * out);
      node.inward.copy(a.inward);
      node.facing = a.facing;
      node.group.position.copy(node.base);
      node.plinth.position.set(
        a.inward.x * 0.008,
        -R * 0.98,
        a.inward.z * 0.008,
      );
      node.plinth.rotation.set(-0.42, a.facing, 0, 'YXZ');
      node.group.visible = node.visible && node.vis.occupied;
    }
    if (this.buttonSeat >= 0) this.setButton(this.buttonSeat, false);
  }

  setTableSize(size: number): void {
    const n = Math.max(1, Math.min(9, Math.round(size)));
    if (n === this.size) return;
    this.size = n;
    this.layoutSeats();
  }

  setHeroSeat(seat: number): void {
    if (seat === this.hero) return;
    this.hero = seat;
    this.layoutSeats();
  }

  setSeat(seat: number, v: Partial<SeatVisual> | null): void {
    const node = this.nodes[seat];
    if (!node) return;
    if (v === null) {
      node.vis = blankVisual();
      node.group.visible = false;
      return;
    }
    const prev = node.vis;
    const next: SeatVisual = { ...prev, ...v };
    node.vis = next;

    if (next.occupied && (next.avatarId !== prev.avatarId || next.name !== prev.name || !node.artMat.map)) {
      node.artMat.map = buildPortrait(next.avatarId || `seat${seat}`, next.name);
      node.artMat.needsUpdate = true;
    }
    if (next.rarity !== prev.rarity || !node.frameMat.userData.init) {
      const col = RARITY_COLOR[next.rarity] ?? RARITY_COLOR.common;
      node.frameMat.color.set(col);
      node.frameMat.emissive.set(col);
      node.frameMat.userData.init = true;
    }
    if (next.won && !prev.won) this.celebrate(seat);

    node.lean.target = next.turn ? 1 : 0;
    node.slump.target = next.folded ? 1 : 0;
    node.glow.target = next.turn ? 1 : next.allIn ? 0.55 : 0;
    node.group.visible = node.visible && next.occupied;
    node.artMat.opacity = next.sittingOut ? 0.42 : 1;
  }

  setVisible(seat: number, on: boolean): void {
    const node = this.nodes[seat];
    if (!node) return;
    node.visible = on;
    node.group.visible = on && node.vis.occupied;
  }

  celebrate(seat: number): void {
    const node = this.nodes[seat];
    if (!node) return;
    node.pop.set(1);
    node.pop.kick(9.5);
    node.flash = 1;
  }

  bump(seat: number, amount = 1): void {
    const node = this.nodes[seat];
    if (!node) return;
    node.pop.kick(2.6 * amount);
  }

  anchor(seat: number): THREE.Vector3 | null {
    const node = this.nodes[seat];
    if (!node || seat >= this.size) return null;
    return node.group.position;
  }

  setButton(seat: number, animate = true): void {
    const seats = layout.seats(this.size) as SeatAnchors[];
    if (seat < 0 || seat >= this.size) {
      this.button.visible = false;
      this.buttonSeat = -1;
      return;
    }
    const slot = layout.slotFor(seat, this.hero, this.size);
    const to = seats[slot].button;
    this.btnTo.copy(to);
    if (!this.button.visible || !animate) {
      this.button.position.copy(to);
      this.btnFrom.copy(to);
      this.btnT = 1;
    } else {
      this.btnFrom.copy(this.button.position);
      this.btnT = 0;
      this.btnDur = 0.62;
      this.btnSpin = this.button.rotation.y;
    }
    this.button.visible = true;
    this.buttonSeat = seat;
  }

  setQuality(tier: PerfTier): void {
    this.tier = tier;
    for (const n of this.nodes) {
      n.plateMat.clearcoat = tier === 'low' ? 0 : 0.85;
      n.plateMat.needsUpdate = true;
    }
  }

  update(dt: number, elapsed: number, camera?: THREE.Camera | null): void {
    const d = Math.min(dt, 0.05);

    if (camera) {
      camera.getWorldQuaternion(this._q);
    }

    for (const n of this.nodes) {
      if (!n.group.visible) continue;
      const v = n.vis;

      n.lean.step(d);
      n.pop.step(d);
      n.slump.step(d);
      n.glow.step(d);

      // idle breath — out of phase per seat so a full table never pulses as
      // one organism, which is the tell of a cheap animation system
      const breath = Math.sin(elapsed * 1.35 + n.phase);
      const breath2 = Math.sin(elapsed * 0.83 + n.phase * 1.7);
      const idleScale = 1 + breath * 0.008;
      const idleY = breath * 0.0032 + breath2 * 0.0016;

      const lean = n.lean.value;
      const slump = n.slump.value;
      const pop = n.pop.value;

      n.group.position.set(
        n.base.x + n.inward.x * lean * 0.026,
        n.base.y + idleY + lean * 0.016 - slump * 0.019,
        n.base.z + n.inward.z * lean * 0.026,
      );
      const s = idleScale * (1 + lean * 0.055) * pop * (1 - slump * 0.07);
      n.group.scale.setScalar(s);

      if (camera) {
        n.billboard.quaternion.copy(this._q);
        // a folded seat physically drops its head
        if (slump > 0.001) {
          this._v.set(1, 0, 0);
          n.billboard.rotateOnAxis(this._v, slump * 0.34);
        }
      }

      // turn / all-in ring
      const glow = n.glow.value;
      if (glow > 0.004 || n.flash > 0.004) {
        n.glowMesh.visible = true;
        const pulse = 0.72 + Math.sin(elapsed * 4.4) * 0.28;
        n.glowMat.opacity = Math.min(1, glow * 0.42 * pulse + n.flash * 0.75);
        n.glowMat.color.set(n.flash > 0.01 ? 0xfdf3d0 : v.allIn && !v.turn ? 0xf6534f : 0xedc96b);
        n.glowMesh.scale.setScalar(1 + n.flash * 0.28 + glow * 0.04);
      } else if (n.glowMesh.visible) {
        n.glowMesh.visible = false;
      }

      // rarity frame shimmer for the top tiers
      const rg = RARITY_GLOW[v.rarity] ?? 0.06;
      n.frameMat.emissiveIntensity =
        rg * (0.6 + 0.4 * Math.sin(elapsed * 2.1 + n.phase)) + n.flash * 1.6 + glow * 0.35;

      if (n.flash > 0) {
        n.flash -= d * 1.7;
        if (n.flash < 0) n.flash = 0;
      }

      // heat ring
      const heat = v.heat > 0.14 && !v.folded ? THREE.MathUtils.clamp((v.heat - 0.14) / 0.86, 0, 1) : 0;
      const shown = this.tier === 'low' ? heat > 0.5 : heat > 0.01;
      n.heatMesh.visible = shown;
      if (shown) {
        n.heatMat.uniforms.uTime.value = elapsed;
        n.heatMat.uniforms.uHeat.value = heat;
      }

      // folded seats desaturate toward the felt
      const fade = 1 - slump * 0.5;
      n.artMat.color.setScalar(fade * (v.sittingOut ? 0.55 : 1));
      n.plateMat.color.setRGB(0.043 * fade, 0.055 * fade, 0.086 * fade);
    }

    // ── dealer button ──────────────────────────────────────────
    if (this.button.visible && this.btnT < 1) {
      this.btnT = Math.min(1, this.btnT + d / this.btnDur);
      const u = this.btnT;
      const e = 1 - Math.pow(1 - u, 3);
      this.button.position.lerpVectors(this.btnFrom, this.btnTo, e);
      // skate: a low hop with a settle, plus a full turn on the way
      this.button.position.y =
        this.btnFrom.y + (this.btnTo.y - this.btnFrom.y) * e + Math.sin(Math.PI * u) * 0.035;
      this.button.rotation.y = this.btnSpin + Math.PI * 2 * e;
      this.button.rotation.z = Math.sin(Math.PI * u) * 0.22;
      if (u >= 1) {
        this.button.position.copy(this.btnTo);
        this.button.rotation.z = 0;
      }
    }
  }

  dispose(): void {
    this.plateGeo.dispose();
    this.artGeo.dispose();
    this.bezelGeo.dispose();
    this.frameGeo.dispose();
    this.ringGeo.dispose();
    this.heatGeo.dispose();
    this.plinthGeo.dispose();
    this.bezelMat.dispose();
    this.plinthMat.dispose();
    for (const n of this.nodes) {
      n.plateMat.dispose();
      n.artMat.dispose();
      n.frameMat.dispose();
      n.glowMat.dispose();
      n.heatMat.dispose();
    }
    for (const m of this.buttonMats) m.dispose();
    const geos = this.button.userData.geos as THREE.BufferGeometry[] | undefined;
    if (geos) for (const g of geos) g.dispose();
    for (const t of artCache.values()) t.dispose();
    artCache.clear();
    this.nodes.length = 0;
    this.group.clear();
  }
}

export function createAvatars(opts: { tier?: PerfTier } = {}): AvatarSystem {
  return new Avatars(opts.tier ?? 'high');
}
