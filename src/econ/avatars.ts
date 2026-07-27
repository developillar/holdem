/**
 * ROYALE — econ/avatars.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Every avatar in the game is drawn at runtime. Nothing is downloaded, nothing
 * is an atlas, and nothing is noise — each portrait is a deliberate five-layer
 * composition rendered to a canvas:
 *
 *   1  ground      two-stop gradient + a vignette so the disc has depth
 *   2  pattern     rays / rings / grid / motes, hashed from the id
 *   3  spotlight   a soft radial behind the subject, offset up and left
 *   4  subject     a stylised portrait or an emblem, drawn from the motif
 *   5  finish      rim light, hairline edge, and a rarity aura for epic+
 *
 * Catalog avatars carry authored params (`motif`, `bgA`, `bgB`, `accent`).
 * Anything else — an NPC's `av-onyx`, a persona id — is hashed into a coherent
 * palette instead, so a face never looks like a missing image.
 *
 *   getAvatarDataUrl('avatar-the-phantom', 128)   → data: URL, cached
 *   createAvatarElement({ id, size: 96 })         → animated for premium items
 *
 * The element factory adds the treatments a still image cannot do: a slow
 * gradient drift, a specular sweep, and a field of rising motes. All three are
 * pure CSS on transform/opacity, so a store grid full of them still holds
 * 60fps on a mid-tier phone.
 */
import type { Rarity } from '../core/types.ts';
import { itemById } from '../data/catalog.ts';

export type AvatarMotif =
  | 'sunrise' | 'lamp' | 'moon' | 'gears' | 'visor' | 'crown' | 'crystal'
  | 'anchor' | 'sun' | 'hands' | 'eye' | 'fox' | 'shield' | 'flare'
  | 'spade' | 'mask' | 'suit' | 'card' | 'aurora' | 'eclipse' | 'crest';

export type AvatarAnim = 'none' | 'shift' | 'shimmer' | 'particles';

export interface AvatarSpec {
  id: string;
  motif: AvatarMotif;
  bgA: string;
  bgB: string;
  accent: string;
  ink: string;
  anim: AvatarAnim;
  rarity: Rarity;
  /** background pattern picked from the hash */
  pattern: 'rays' | 'rings' | 'grid' | 'motes' | 'arcs';
  /** stable per-id jitter, 0–1 */
  seed: number;
}

const MOTIFS: AvatarMotif[] = [
  'sunrise', 'lamp', 'moon', 'gears', 'visor', 'crown', 'crystal', 'anchor',
  'sun', 'hands', 'eye', 'fox', 'shield', 'flare', 'spade', 'mask', 'suit',
  'card', 'aurora', 'eclipse', 'crest',
];

const PATTERNS: AvatarSpec['pattern'][] = ['rays', 'rings', 'grid', 'motes', 'arcs'];

const RARITY_TINT: Record<Rarity, string> = {
  common: '#8891a5',
  rare: '#47a9ff',
  epic: '#a855f7',
  legendary: '#f5a524',
  mythic: '#ff4d8d',
};

// ─────────────────────────── colour helpers ───────────────────────────

function hash(str: string): number {
  let hv = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hv ^= str.charCodeAt(i);
    hv = Math.imul(hv, 0x01000193) >>> 0;
  }
  return hv >>> 0;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${((h % 360) + 360) % 360} ${s}% ${l}%)`;
}

function rgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Lightens or darkens a hex by mixing toward white/black. */
function shade(hex: string, amount: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return hex;
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  const mix = (c: number) => Math.round((t - c) * p + c);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ─────────────────────────── spec resolution ───────────────────────────

const specCache = new Map<string, AvatarSpec>();

/** The resolved parameters for an avatar id — authored or hashed. */
export function avatarSpec(id: string): AvatarSpec {
  const hit = specCache.get(id);
  if (hit) return hit;

  const seedN = hash(id);
  const seed = (seedN % 10_000) / 10_000;
  const item = itemById(id);
  let spec: AvatarSpec;

  if (item && item.kind === 'avatar') {
    const p = item.params;
    spec = {
      id,
      motif: (MOTIFS.includes(p.motif as AvatarMotif) ? p.motif : 'spade') as AvatarMotif,
      bgA: String(p.bgA ?? '#2b3d55'),
      bgB: String(p.bgB ?? '#0a0e19'),
      accent: String(p.accent ?? '#edc96b'),
      ink: String(p.ink ?? '#f4f7fd'),
      anim: (p.anim as AvatarAnim) ?? 'none',
      rarity: item.rarity,
      pattern: PATTERNS[seedN % PATTERNS.length],
      seed,
    };
  } else {
    // Hashed fallback: one hue family, two stops apart, always legible.
    const hue = seedN % 360;
    const hue2 = (hue + 24 + ((seedN >>> 9) % 46)) % 360;
    const sat = 38 + ((seedN >>> 5) % 22);
    const accentHue = (hue + 150 + ((seedN >>> 17) % 70)) % 360;
    spec = {
      id,
      motif: MOTIFS[(seedN >>> 3) % MOTIFS.length],
      bgA: hsl(hue, sat, 26),
      bgB: hsl(hue2, sat - 10, 9),
      accent: hsl(accentHue, 74, 63),
      ink: hsl(hue, 24, 94),
      anim: 'none',
      rarity: 'common',
      pattern: PATTERNS[seedN % PATTERNS.length],
      seed,
    };
  }
  specCache.set(id, spec);
  return spec;
}

// ─────────────────────────── drawing ───────────────────────────

type C2D = CanvasRenderingContext2D;

/** Everything below works on a 100×100 unit square, scaled by the caller. */
const U = 100;

function ground(ctx: C2D, s: AvatarSpec): void {
  const g = ctx.createLinearGradient(0, 0, U * 0.42, U);
  g.addColorStop(0, shade(s.bgA, 0.1));
  g.addColorStop(0.55, s.bgA);
  g.addColorStop(1, s.bgB);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, U, U);
}

function pattern(ctx: C2D, s: AvatarSpec): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const a = rgba(s.accent, 0.09);
  const b = rgba(s.ink, 0.055);
  switch (s.pattern) {
    case 'rays': {
      ctx.translate(U * 0.5, U * 0.86);
      const n = 11;
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.rotate(-Math.PI * 0.5 + (i - (n - 1) / 2) * 0.18 + s.seed * 0.1);
        ctx.fillStyle = i % 2 ? a : b;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-2.6, -U * 1.2);
        ctx.lineTo(2.6, -U * 1.2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      break;
    }
    case 'rings': {
      ctx.strokeStyle = a;
      ctx.lineWidth = 1.1;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(U * 0.5, U * 0.52, 14 + i * 11 + s.seed * 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = b;
      ctx.beginPath();
      ctx.arc(U * 0.5, U * 0.52, 20 + s.seed * 6, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'grid': {
      ctx.strokeStyle = b;
      ctx.lineWidth = 0.8;
      const step = 11;
      for (let x = step / 2; x < U; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, U);
        ctx.stroke();
      }
      for (let y = step / 2; y < U; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(U, y);
        ctx.stroke();
      }
      break;
    }
    case 'motes': {
      for (let i = 0; i < 26; i++) {
        const t = (i * 2654435761) >>> 0;
        const x = ((t >>> 3) % 1000) / 10;
        const y = ((t >>> 13) % 1000) / 10;
        const r = 0.5 + (((t >>> 23) % 100) / 100) * 1.7;
        ctx.fillStyle = i % 3 === 0 ? a : b;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'arcs': {
      ctx.strokeStyle = a;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(U * 0.5, U * 0.55, 26 + i * 13, Math.PI * (0.9 + i * 0.06), Math.PI * (1.75 - i * 0.05));
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

function spotlight(ctx: C2D, s: AvatarSpec): void {
  const g = ctx.createRadialGradient(U * 0.42, U * 0.36, 2, U * 0.5, U * 0.5, U * 0.62);
  g.addColorStop(0, rgba(s.accent, 0.24));
  g.addColorStop(0.45, rgba(s.accent, 0.07));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, U, U);
}

function vignette(ctx: C2D): void {
  const g = ctx.createRadialGradient(U * 0.5, U * 0.46, U * 0.24, U * 0.5, U * 0.5, U * 0.62);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(3,4,8,0.6)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, U, U);
}

/** Metal-ish vertical gradient used for every emblem and accessory. */
function accentFill(ctx: C2D, s: AvatarSpec, y0 = U * 0.2, y1 = U * 0.82): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, U * 0.3, y1);
  g.addColorStop(0, shade(s.accent, 0.45));
  g.addColorStop(0.42, s.accent);
  g.addColorStop(1, shade(s.accent, -0.34));
  return g;
}

function poly(ctx: C2D, pts: number[][]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// ── the shared stylised bust used by the "portrait" motifs ──────────────

function bust(ctx: C2D, s: AvatarSpec): { headX: number; headY: number; headR: number } {
  const headX = U * 0.5;
  const headY = U * 0.415;
  const headR = U * 0.155;

  // shoulders
  const sg = ctx.createLinearGradient(0, U * 0.55, 0, U);
  sg.addColorStop(0, shade(s.bgB, 0.34));
  sg.addColorStop(1, shade(s.bgB, 0.06));
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.moveTo(U * 0.13, U);
  ctx.bezierCurveTo(U * 0.16, U * 0.71, U * 0.34, U * 0.6, U * 0.5, U * 0.6);
  ctx.bezierCurveTo(U * 0.66, U * 0.6, U * 0.84, U * 0.71, U * 0.87, U);
  ctx.closePath();
  ctx.fill();

  // neck
  ctx.fillStyle = shade(s.bgB, 0.2);
  ctx.fillRect(U * 0.44, U * 0.5, U * 0.12, U * 0.13);

  // head
  const hg = ctx.createLinearGradient(headX - headR, headY - headR, headX + headR, headY + headR);
  hg.addColorStop(0, shade(s.bgA, 0.5));
  hg.addColorStop(1, shade(s.bgA, 0.14));
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(headX, headY, headR, 0, Math.PI * 2);
  ctx.fill();

  // rim light along the upper-left of the head and shoulder
  ctx.save();
  ctx.strokeStyle = rgba(s.accent, 0.55);
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(headX, headY, headR - 0.4, Math.PI * 0.82, Math.PI * 1.62);
  ctx.stroke();
  ctx.strokeStyle = rgba(s.accent, 0.3);
  ctx.beginPath();
  ctx.moveTo(U * 0.145, U * 0.98);
  ctx.bezierCurveTo(U * 0.18, U * 0.72, U * 0.35, U * 0.615, U * 0.47, U * 0.61);
  ctx.stroke();
  ctx.restore();

  return { headX, headY, headR };
}

// ── emblem + accessory drawing ─────────────────────────────────────────

function drawMotif(ctx: C2D, s: AvatarSpec): void {
  const fill = accentFill(ctx, s);
  const cx = U * 0.5;

  switch (s.motif) {
    // ── portrait family ────────────────────────────────────────────
    case 'visor': {
      const { headX, headY, headR } = bust(ctx, s);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(headX - headR * 1.06, headY - headR * 0.34, headR * 2.12, headR * 0.62, headR * 0.3);
      ctx.fill();
      ctx.fillStyle = rgba(s.ink, 0.85);
      ctx.beginPath();
      ctx.roundRect(headX - headR * 0.92, headY - headR * 0.2, headR * 0.7, headR * 0.16, 1.4);
      ctx.fill();
      break;
    }
    case 'crown': {
      const { headX, headY, headR } = bust(ctx, s);
      ctx.fillStyle = fill;
      poly(ctx, [
        [headX - headR * 1.05, headY - headR * 0.72],
        [headX - headR * 0.55, headY - headR * 1.28],
        [headX, headY - headR * 0.86],
        [headX + headR * 0.55, headY - headR * 1.28],
        [headX + headR * 1.05, headY - headR * 0.72],
        [headX + headR * 0.86, headY - headR * 0.42],
        [headX - headR * 0.86, headY - headR * 0.42],
      ]);
      ctx.fill();
      ctx.fillStyle = rgba(s.ink, 0.9);
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(headX + i * headR * 0.55, headY - headR * 0.6, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'mask': {
      const { headX, headY, headR } = bust(ctx, s);
      ctx.fillStyle = rgba('#05060a', 0.88);
      ctx.beginPath();
      ctx.moveTo(headX - headR * 1.02, headY - headR * 0.36);
      ctx.quadraticCurveTo(headX, headY - headR * 0.06, headX + headR * 1.02, headY - headR * 0.36);
      ctx.quadraticCurveTo(headX + headR * 0.9, headY + headR * 0.42, headX, headY + headR * 0.3);
      ctx.quadraticCurveTo(headX - headR * 0.9, headY + headR * 0.42, headX - headR * 1.02, headY - headR * 0.36);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = fill;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = s.accent;
      for (const dx of [-0.42, 0.42]) {
        ctx.beginPath();
        ctx.ellipse(headX + headR * dx, headY - headR * 0.02, headR * 0.19, headR * 0.11, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'suit': {
      const { headX, headY, headR } = bust(ctx, s);
      // lapels
      ctx.fillStyle = shade(s.bgB, 0.44);
      poly(ctx, [[cx - U * 0.11, U * 0.62], [cx, U * 0.78], [cx - U * 0.26, U]]);
      ctx.fill();
      poly(ctx, [[cx + U * 0.11, U * 0.62], [cx, U * 0.78], [cx + U * 0.26, U]]);
      ctx.fill();
      ctx.fillStyle = fill;
      poly(ctx, [[cx - U * 0.038, U * 0.68], [cx + U * 0.038, U * 0.68], [cx + U * 0.026, U], [cx - U * 0.026, U]]);
      ctx.fill();
      ctx.fillStyle = rgba(s.ink, 0.14);
      ctx.beginPath();
      ctx.arc(headX, headY + headR * 0.1, headR * 0.72, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'hands': {
      const { headX, headY, headR } = bust(ctx, s);
      ctx.fillStyle = rgba(s.ink, 0.1);
      ctx.beginPath();
      ctx.arc(headX, headY, headR * 0.7, 0, Math.PI * 2);
      ctx.fill();
      // a fan of three cards held in front of the chest
      for (let i = -1; i <= 1; i++) {
        ctx.save();
        ctx.translate(cx + i * U * 0.11, U * 0.86);
        ctx.rotate(i * 0.28);
        ctx.fillStyle = i === 0 ? fill : shade(s.bgA, 0.55);
        ctx.beginPath();
        ctx.roundRect(-U * 0.075, -U * 0.13, U * 0.15, U * 0.26, 2.6);
        ctx.fill();
        ctx.strokeStyle = rgba(s.ink, 0.3);
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
    case 'fox': {
      ctx.fillStyle = fill;
      poly(ctx, [
        [cx, U * 0.78], [cx - U * 0.24, U * 0.52], [cx - U * 0.29, U * 0.24],
        [cx - U * 0.13, U * 0.37], [cx + U * 0.13, U * 0.37], [cx + U * 0.29, U * 0.24],
        [cx + U * 0.24, U * 0.52],
      ]);
      ctx.fill();
      ctx.fillStyle = rgba('#05060a', 0.72);
      poly(ctx, [[cx, U * 0.7], [cx - U * 0.145, U * 0.5], [cx + U * 0.145, U * 0.5]]);
      ctx.fill();
      ctx.fillStyle = s.ink;
      for (const dx of [-0.11, 0.11]) {
        ctx.beginPath();
        ctx.ellipse(cx + U * dx, U * 0.5, U * 0.032, U * 0.019, dx > 0 ? -0.4 : 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    // ── emblem family ──────────────────────────────────────────────
    case 'spade': {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(cx, U * 0.22);
      ctx.bezierCurveTo(cx + U * 0.3, U * 0.44, cx + U * 0.28, U * 0.62, cx + U * 0.11, U * 0.63);
      ctx.bezierCurveTo(cx + U * 0.03, U * 0.63, cx + U * 0.02, U * 0.58, cx + U * 0.02, U * 0.58);
      ctx.lineTo(cx + U * 0.075, U * 0.78);
      ctx.lineTo(cx - U * 0.075, U * 0.78);
      ctx.lineTo(cx - U * 0.02, U * 0.58);
      ctx.bezierCurveTo(cx - U * 0.02, U * 0.58, cx - U * 0.03, U * 0.63, cx - U * 0.11, U * 0.63);
      ctx.bezierCurveTo(cx - U * 0.28, U * 0.62, cx - U * 0.3, U * 0.44, cx, U * 0.22);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'crest': {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(cx - U * 0.23, U * 0.24);
      ctx.lineTo(cx + U * 0.23, U * 0.24);
      ctx.lineTo(cx + U * 0.23, U * 0.55);
      ctx.quadraticCurveTo(cx + U * 0.21, U * 0.74, cx, U * 0.83);
      ctx.quadraticCurveTo(cx - U * 0.21, U * 0.74, cx - U * 0.23, U * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba('#05060a', 0.5);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = rgba('#05060a', 0.45);
      poly(ctx, [[cx - U * 0.23, U * 0.24], [cx, U * 0.4], [cx + U * 0.23, U * 0.24], [cx + U * 0.23, U * 0.33], [cx, U * 0.49], [cx - U * 0.23, U * 0.33]]);
      ctx.fill();
      ctx.fillStyle = rgba(s.ink, 0.86);
      ctx.beginPath();
      ctx.arc(cx, U * 0.6, U * 0.055, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'shield': {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(cx, U * 0.2);
      ctx.lineTo(cx + U * 0.25, U * 0.31);
      ctx.lineTo(cx + U * 0.25, U * 0.56);
      ctx.quadraticCurveTo(cx + U * 0.24, U * 0.74, cx, U * 0.84);
      ctx.quadraticCurveTo(cx - U * 0.24, U * 0.74, cx - U * 0.25, U * 0.56);
      ctx.lineTo(cx - U * 0.25, U * 0.31);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba('#05060a', 0.55);
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(cx - U * 0.09, U * 0.52);
      ctx.lineTo(cx - U * 0.01, U * 0.6);
      ctx.lineTo(cx + U * 0.12, U * 0.42);
      ctx.stroke();
      break;
    }
    case 'eye': {
      ctx.strokeStyle = fill;
      ctx.lineWidth = 4.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - U * 0.28, U * 0.5);
      ctx.quadraticCurveTo(cx, U * 0.22, cx + U * 0.28, U * 0.5);
      ctx.quadraticCurveTo(cx, U * 0.78, cx - U * 0.28, U * 0.5);
      ctx.stroke();
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(cx, U * 0.5, U * 0.105, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba('#05060a', 0.8);
      ctx.beginPath();
      ctx.arc(cx, U * 0.5, U * 0.045, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(s.accent, 0.4);
      ctx.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI * 0.85 + i * 0.34;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * U * 0.33, U * 0.5 + Math.sin(a) * U * 0.33);
        ctx.lineTo(cx + Math.cos(a) * U * 0.42, U * 0.5 + Math.sin(a) * U * 0.42);
        ctx.stroke();
      }
      break;
    }
    case 'sun':
    case 'flare': {
      const rays = s.motif === 'flare' ? 4 : 12;
      ctx.fillStyle = fill;
      ctx.save();
      ctx.translate(cx, U * 0.5);
      for (let i = 0; i < rays; i++) {
        ctx.save();
        ctx.rotate((i / rays) * Math.PI * 2 + s.seed);
        const len = s.motif === 'flare' ? U * 0.44 : U * 0.36;
        poly(ctx, [[0, -len], [U * 0.042, -U * 0.13], [-U * 0.042, -U * 0.13]]);
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, U * (s.motif === 'flare' ? 0.115 : 0.15), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'sunrise': {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(cx, U * 0.6, U * 0.2, Math.PI, 0);
      ctx.fill();
      ctx.strokeStyle = rgba(s.accent, 0.75);
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const w = U * (0.32 - i * 0.06);
        ctx.beginPath();
        ctx.moveTo(cx - w, U * (0.66 + i * 0.07));
        ctx.lineTo(cx + w, U * (0.66 + i * 0.07));
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(s.ink, 0.32);
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 7; i++) {
        const a = Math.PI + (i / 6) * Math.PI;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * U * 0.25, U * 0.6 + Math.sin(a) * U * 0.25);
        ctx.lineTo(cx + Math.cos(a) * U * 0.33, U * 0.6 + Math.sin(a) * U * 0.33);
        ctx.stroke();
      }
      break;
    }
    case 'moon': {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(cx + U * 0.03, U * 0.47, U * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx + U * 0.14, U * 0.4, U * 0.21, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = rgba(s.ink, 0.8);
      for (const [dx, dy, r] of [[-0.3, -0.22, 1.9], [0.3, 0.16, 1.5], [0.22, -0.3, 1.2]]) {
        ctx.beginPath();
        ctx.arc(cx + U * dx, U * 0.5 + U * dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'crystal': {
      ctx.fillStyle = fill;
      poly(ctx, [[cx, U * 0.18], [cx + U * 0.21, U * 0.42], [cx, U * 0.84], [cx - U * 0.21, U * 0.42]]);
      ctx.fill();
      ctx.fillStyle = rgba('#ffffff', 0.24);
      poly(ctx, [[cx, U * 0.18], [cx - U * 0.21, U * 0.42], [cx, U * 0.84]]);
      ctx.fill();
      ctx.strokeStyle = rgba('#05060a', 0.42);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cx - U * 0.21, U * 0.42);
      ctx.lineTo(cx + U * 0.21, U * 0.42);
      ctx.moveTo(cx, U * 0.18);
      ctx.lineTo(cx, U * 0.84);
      ctx.stroke();
      break;
    }
    case 'anchor': {
      ctx.strokeStyle = fill;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, U * 0.3);
      ctx.lineTo(cx, U * 0.76);
      ctx.moveTo(cx - U * 0.13, U * 0.4);
      ctx.lineTo(cx + U * 0.13, U * 0.4);
      ctx.stroke();
      ctx.lineWidth = 4.6;
      ctx.beginPath();
      ctx.arc(cx, U * 0.63, U * 0.2, Math.PI * 0.12, Math.PI * 0.88);
      ctx.stroke();
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(cx, U * 0.27, U * 0.055, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'gears': {
      const gear = (gx: number, gy: number, r: number, teeth: number, rot: number) => {
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate(rot);
        ctx.fillStyle = fill;
        ctx.beginPath();
        for (let i = 0; i < teeth * 2; i++) {
          const a = (i / (teeth * 2)) * Math.PI * 2;
          const rr = i % 2 ? r : r * 1.24;
          ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };
      gear(cx - U * 0.1, U * 0.44, U * 0.18, 9, s.seed);
      gear(cx + U * 0.15, U * 0.63, U * 0.12, 8, -s.seed * 2);
      break;
    }
    case 'lamp': {
      ctx.strokeStyle = rgba(s.ink, 0.4);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, U * 0.32);
      ctx.stroke();
      ctx.fillStyle = fill;
      poly(ctx, [[cx - U * 0.16, U * 0.46], [cx + U * 0.16, U * 0.46], [cx + U * 0.07, U * 0.31], [cx - U * 0.07, U * 0.31]]);
      ctx.fill();
      const cone = ctx.createLinearGradient(0, U * 0.46, 0, U);
      cone.addColorStop(0, rgba(s.accent, 0.5));
      cone.addColorStop(1, rgba(s.accent, 0));
      ctx.fillStyle = cone;
      poly(ctx, [[cx - U * 0.15, U * 0.47], [cx + U * 0.15, U * 0.47], [cx + U * 0.42, U], [cx - U * 0.42, U]]);
      ctx.fill();
      ctx.fillStyle = shade(s.accent, 0.6);
      ctx.beginPath();
      ctx.arc(cx, U * 0.49, U * 0.05, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'card': {
      ctx.save();
      ctx.translate(cx, U * 0.51);
      ctx.rotate(-0.22);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(-U * 0.19, -U * 0.28, U * 0.38, U * 0.56, 5);
      ctx.fill();
      ctx.strokeStyle = rgba('#05060a', 0.5);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.roundRect(-U * 0.15, -U * 0.24, U * 0.3, U * 0.48, 3.4);
      ctx.stroke();
      ctx.fillStyle = rgba('#05060a', 0.62);
      ctx.beginPath();
      ctx.moveTo(0, -U * 0.11);
      ctx.bezierCurveTo(U * 0.12, -U * 0.02, U * 0.11, U * 0.06, U * 0.04, U * 0.065);
      ctx.lineTo(U * 0.03, U * 0.14);
      ctx.lineTo(-U * 0.03, U * 0.14);
      ctx.lineTo(-U * 0.04, U * 0.065);
      ctx.bezierCurveTo(-U * 0.11, U * 0.06, -U * 0.12, -U * 0.02, 0, -U * 0.11);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'aurora': {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const g = ctx.createLinearGradient(0, U * 0.2, 0, U * 0.85);
        g.addColorStop(0, rgba(s.accent, 0));
        g.addColorStop(0.4, rgba(i % 2 ? s.accent : s.ink, 0.42));
        g.addColorStop(1, rgba(s.accent, 0));
        ctx.strokeStyle = g;
        ctx.lineWidth = 6 - i;
        ctx.beginPath();
        const off = (i - 1.5) * U * 0.11;
        ctx.moveTo(cx + off - U * 0.1, U * 0.22);
        ctx.bezierCurveTo(
          cx + off + U * 0.16, U * 0.4,
          cx + off - U * 0.16, U * 0.6,
          cx + off + U * 0.06, U * 0.84,
        );
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'eclipse': {
      ctx.save();
      const corona = ctx.createRadialGradient(cx, U * 0.5, U * 0.18, cx, U * 0.5, U * 0.44);
      corona.addColorStop(0, rgba(s.accent, 0.85));
      corona.addColorStop(0.35, rgba(s.accent, 0.28));
      corona.addColorStop(1, rgba(s.accent, 0));
      ctx.fillStyle = corona;
      ctx.beginPath();
      ctx.arc(cx, U * 0.5, U * 0.44, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#05060a';
      ctx.beginPath();
      ctx.arc(cx, U * 0.5, U * 0.21, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(s.ink, 0.55);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
      break;
    }
  }
}

function finish(ctx: C2D, s: AvatarSpec): void {
  // A soft specular band across the upper third — the layer that makes the
  // portrait read as a physical object rather than a flat illustration.
  const g = ctx.createLinearGradient(0, 0, U * 0.8, U * 0.7);
  g.addColorStop(0, 'rgba(255,255,255,0.12)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.02)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, U, U);

  vignette(ctx);

  if (s.rarity === 'epic' || s.rarity === 'legendary' || s.rarity === 'mythic') {
    const tint = RARITY_TINT[s.rarity];
    ctx.strokeStyle = rgba(tint, 0.5);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(U * 0.5, U * 0.5, U * 0.49 - 1.2, 0, Math.PI * 2);
    ctx.stroke();
    const glow = ctx.createRadialGradient(U * 0.5, U * 0.5, U * 0.36, U * 0.5, U * 0.5, U * 0.5);
    glow.addColorStop(0, rgba(tint, 0));
    glow.addColorStop(1, rgba(tint, 0.3));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, U, U);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(U * 0.5, U * 0.5, U * 0.49, 0, Math.PI * 2);
  ctx.stroke();
}

/** Paints the full composition into a context already scaled to 100×100. */
export function drawAvatar(ctx: C2D, id: string): void {
  const s = avatarSpec(id);
  ctx.save();
  ctx.beginPath();
  ctx.arc(U * 0.5, U * 0.5, U * 0.5, 0, Math.PI * 2);
  ctx.clip();
  ground(ctx, s);
  pattern(ctx, s);
  spotlight(ctx, s);
  drawMotif(ctx, s);
  finish(ctx, s);
  ctx.restore();
}

// ─────────────────────────── raster cache ───────────────────────────

const urlCache = new Map<string, string>();
/** Bucketed so a grid of 62/64/66px avatars shares one raster. */
const SIZE_BUCKETS = [48, 64, 96, 128, 192, 256];

function bucket(size: number): number {
  for (const b of SIZE_BUCKETS) if (size <= b) return b;
  return 256;
}

/**
 * A `data:` URL for an avatar at (at least) `size` CSS px, device-pixel aware
 * and cached. Returns an empty string in a non-DOM context.
 */
export function getAvatarDataUrl(id: string, size = 96): string {
  if (typeof document === 'undefined') return '';
  const px = bucket(size);
  const key = `${id}@${px}`;
  const hit = urlCache.get(key);
  if (hit) return hit;

  const dpr = Math.min(3, Math.max(1, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(px * dpr);
  canvas.height = Math.round(px * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(canvas.width / U, canvas.height / U);
  drawAvatar(ctx, id);
  const url = canvas.toDataURL('image/png');
  // Bound the cache — a long session browsing the store must not grow forever.
  if (urlCache.size > 260) urlCache.clear();
  urlCache.set(key, url);
  return url;
}

export function clearAvatarCache(): void {
  urlCache.clear();
  specCache.clear();
}

// ─────────────────────────── animated element ───────────────────────────

const STYLE_ID = 'royale-avatar-art';

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const css = `
.av-art{position:relative;display:block;width:var(--av-art,64px);height:var(--av-art,64px);
  border-radius:50%;overflow:hidden;flex:none;isolation:isolate;
  box-shadow:0 1px 2px rgba(3,5,10,.5),0 6px 18px rgba(3,5,10,.4),inset 0 1px 0 rgba(255,255,255,.08)}
.av-art__img{position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:50%}
.av-art__layer{position:absolute;inset:-25%;pointer-events:none}
.av-art--shift .av-art__layer{
  background:conic-gradient(from 0deg,var(--av-tint,#edc96b) 0deg,transparent 70deg,transparent 290deg,var(--av-tint,#edc96b) 360deg);
  opacity:.3;mix-blend-mode:screen;animation:avSpin 9s linear infinite}
.av-art--shimmer .av-art__sweep{position:absolute;top:-40%;left:-70%;width:52%;height:180%;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.42),transparent);
  transform:rotate(18deg) translate3d(0,0,0);animation:avSweep 4.4s var(--ease-out,cubic-bezier(.16,1,.3,1)) infinite}
.av-art__mote{position:absolute;bottom:-8%;width:3px;height:3px;border-radius:50%;
  background:var(--av-tint,#edc96b);box-shadow:0 0 6px var(--av-tint,#edc96b);opacity:0;
  animation:avRise var(--mote-dur,5s) linear infinite;animation-delay:var(--mote-delay,0s)}
@keyframes avSpin{to{transform:rotate(1turn)}}
@keyframes avSweep{0%{transform:rotate(18deg) translateX(0)}
  55%,100%{transform:rotate(18deg) translateX(340%)}}
@keyframes avRise{0%{opacity:0;transform:translate3d(0,0,0) scale(.6)}
  12%{opacity:.9}70%{opacity:.55}
  100%{opacity:0;transform:translate3d(var(--mote-dx,4px),-320%,0) scale(1.1)}}
@media (prefers-reduced-motion:reduce){
  .av-art--shift .av-art__layer,.av-art--shimmer .av-art__sweep,.av-art__mote{animation:none}
  .av-art__mote{opacity:.5}}
`;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

export interface AvatarArtOpts {
  id: string;
  /** CSS px */
  size?: number;
  /** force the animated treatment on/off; defaults to the item's own param */
  animate?: boolean;
  alt?: string;
  class?: string;
}

export interface AvatarArtEl extends HTMLElement {
  /** swap to a different avatar without rebuilding the node */
  setAvatar(id: string): void;
}

/**
 * The avatar as a live element. Premium items get their authored treatment:
 * `shift` drifts a conic tint, `shimmer` sweeps a specular band, `particles`
 * floats motes up through the portrait. Everything is composited.
 */
export function createAvatarElement(opts: AvatarArtOpts): AvatarArtEl {
  ensureStyles();
  const size = opts.size ?? 64;
  let spec = avatarSpec(opts.id);

  const el = document.createElement('span') as unknown as AvatarArtEl;
  el.className = `av-art${opts.class ? ` ${opts.class}` : ''}`;
  el.style.setProperty('--av-art', `${size}px`);
  el.style.setProperty('--av-tint', spec.accent);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', opts.alt ?? 'Avatar');

  const img = document.createElement('img');
  img.className = 'av-art__img';
  img.alt = '';
  img.decoding = 'async';
  img.src = getAvatarDataUrl(opts.id, size);
  el.appendChild(img);

  const decorate = () => {
    for (const n of Array.from(el.querySelectorAll('.av-art__layer,.av-art__sweep,.av-art__mote'))) n.remove();
    el.classList.remove('av-art--shift', 'av-art--shimmer', 'av-art--particles');
    const on = opts.animate ?? spec.anim !== 'none';
    if (!on) return;
    const anim = opts.animate && spec.anim === 'none' ? 'shimmer' : spec.anim;
    if (anim === 'shift') {
      el.classList.add('av-art--shift');
      const layer = document.createElement('span');
      layer.className = 'av-art__layer';
      el.appendChild(layer);
    } else if (anim === 'shimmer') {
      el.classList.add('av-art--shimmer');
      const sweep = document.createElement('span');
      sweep.className = 'av-art__sweep';
      el.appendChild(sweep);
    } else if (anim === 'particles') {
      el.classList.add('av-art--particles');
      const n = size >= 96 ? 12 : 7;
      for (let i = 0; i < n; i++) {
        const m = document.createElement('span');
        m.className = 'av-art__mote';
        m.style.left = `${8 + ((i * 37) % 82)}%`;
        m.style.setProperty('--mote-delay', `${(i * 0.47).toFixed(2)}s`);
        m.style.setProperty('--mote-dur', `${(4.2 + (i % 4) * 0.7).toFixed(2)}s`);
        m.style.setProperty('--mote-dx', `${(i % 2 ? 1 : -1) * (3 + (i % 3) * 3)}px`);
        el.appendChild(m);
      }
    }
  };
  decorate();

  el.setAvatar = (id: string) => {
    spec = avatarSpec(id);
    img.src = getAvatarDataUrl(id, size);
    el.style.setProperty('--av-tint', spec.accent);
    decorate();
  };
  return el;
}
