/**
 * ROYALE — ui/econ/preview.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Live previews. A store tile never shows a colour swatch: a table skin is a
 * real felt-and-rail render, a card back is the actual back the table will
 * deal, a chip set is a stack you could count, an emote set is the six marks
 * you will actually send. Everything is drawn procedurally, so a preview and
 * the thing it previews can never drift apart.
 *
 *   previewNode(item, { size: 96 })     → the right element for the kind
 *   previewNode(item, { size: 240, hero: true })  → the detail-sheet render
 *
 * Canvas-backed kinds are rasterised once per (id, size) and reused as an
 * <img>, which keeps a scrolling grid of ninety tiles allocation-free.
 */
import type { CosmeticItem, ReactionKind } from '../../core/types.ts';
import { h } from '../dom.ts';
import { createAvatarElement, getAvatarDataUrl } from '../../econ/avatars.ts';

type C2D = CanvasRenderingContext2D;

// ─────────────────────────── canvas plumbing ───────────────────────────

const rasterCache = new Map<string, string>();

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: C2D; dpr: number } | null {
  const dpr = Math.min(3, Math.max(1, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  return { canvas, ctx, dpr };
}

function raster(key: string, w: number, h: number, paint: (ctx: C2D, w: number, h: number) => void): string {
  const cacheKey = `${key}@${Math.round(w)}x${Math.round(h)}`;
  const hit = rasterCache.get(cacheKey);
  if (hit) return hit;
  const made = makeCanvas(w, h);
  if (!made) return '';
  paint(made.ctx, w, h);
  const url = made.canvas.toDataURL('image/png');
  if (rasterCache.size > 220) rasterCache.clear();
  rasterCache.set(cacheKey, url);
  return url;
}

function img(src: string, w: number, hgt: number, cls: string): HTMLElement {
  return h('img', {
    class: cls,
    attrs: { src, alt: '', width: Math.round(w), height: Math.round(hgt), decoding: 'async' },
  });
}

// ─────────────────────────── colour helpers ───────────────────────────

function rgba(hex: string, a: number): string {
  let s = String(hex).replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function shade(hex: string, amount: number): string {
  let s = String(hex).replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return String(hex);
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  const mix = (c: number) => Math.round((t - c) * p + c);
  return `#${((1 << 24) | (mix((n >> 16) & 255) << 16) | (mix((n >> 8) & 255) << 8) | mix(n & 255)).toString(16).slice(1)}`;
}

const METALS: Record<string, [string, string, string]> = {
  gold: ['#fdf3d0', '#d9a93a', '#7a5709'],
  brass: ['#f3dfa8', '#b98d2e', '#5f4409'],
  chrome: ['#ffffff', '#b9c3d4', '#4b5468'],
  copper: ['#ffd9be', '#c9773f', '#5f3113'],
  gunmetal: ['#9aa5b8', '#4a5364', '#1b202b'],
  rose: ['#ffd8d8', '#d98a8a', '#6e3a3a'],
  steel: ['#e9eef7', '#93a0b6', '#3a4354'],
  holo: ['#c9f7ff', '#ff9ae0', '#8f7bff'],
  none: ['#dfe4ee', '#8891a5', '#3b4356'],
};

function metalGradient(ctx: C2D, name: string, x0: number, y0: number, x1: number, y1: number): CanvasGradient {
  const [a, b, c] = METALS[name] ?? METALS.none;
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, a);
  g.addColorStop(0.38, b);
  g.addColorStop(0.62, a);
  g.addColorStop(1, c);
  return g;
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

// ─────────────────────────── table skin ───────────────────────────

const LOGOS: Record<string, string> = {
  spade: 'M50 18c14 15 30 25 30 41a16.5 16.5 0 01-27.5 12.3c.9 9 3.6 15.2 7.6 18.7H39.9c4-3.5 6.7-9.7 7.6-18.7A16.5 16.5 0 0120 59c0-16 16-26 30-41z',
  crown: 'M14 36l16 11 20-24 20 24 16-11-7 38H21L14 36z',
  diamond: 'M50 14l26 36-26 36-26-36 26-36z',
  shield: 'M50 14l30 12v24c0 20-30 32-30 32S20 70 20 50V26l30-12z',
  anchor: 'M50 14a7 7 0 100 14 7 7 0 000-14zm-4 16h8v50h-8V30zm-16 8h40v7H30v-7zM22 56c0 16 12 26 28 26s28-10 28-26h-9c0 11-8 18-19 18s-19-7-19-18h-9z',
  sun: 'M50 26a24 24 0 100 48 24 24 0 000-48zm0-18l6 12h-12l6-12zm0 84l-6-12h12l-6 12zM8 50l12-6v12L8 50zm84 0l-12 6V44l12 6zM20 20l13 4-9 9-4-13zm60 60l-13-4 9-9 4 13zM80 20l-4 13-9-9 13-4zM20 80l4-13 9 9-13 4z',
  lotus: 'M50 16c8 12 12 22 12 32s-4 20-12 30c-8-10-12-20-12-30s4-20 12-32zM24 38c10 4 17 11 21 20s3 20-2 30c-10-6-16-14-19-24s-2-20 0-26zm52 0c2 6 3 16 0 26s-9 18-19 24c-5-10-6-21-2-30s11-16 21-20z',
  crest: 'M50 12l30 10v26c0 22-14 34-30 42-16-8-30-20-30-42V22l30-10zm0 16l-18 6v22c0 13 8 21 18 27 10-6 18-14 18-27V34l-18-6z',
  orchid: 'M50 14c6 10 8 18 6 26 8-6 16-8 24-6-4 8-10 14-18 18 8 4 14 10 18 18-8 2-16 0-24-6 2 8 0 16-6 26-6-10-8-18-6-26-8 6-16 8-24 6 4-8 10-14 18-18-8-4-14-10-18-18 8-2 16 0 24 6-2-8 0-16 6-26z',
  aurora: 'M18 78c8-22 14-38 16-52 4 16 6 30 4 52h-20zm26 0c4-26 6-44 6-60 2 16 4 34 6 60H44zm26 0c-2-22 0-36 4-52 2 14 8 30 16 52H70z',
};

function drawTableSkin(ctx: C2D, w: number, hgt: number, p: CosmeticItem['params']): void {
  const felt = str(p.feltColor, '#14432d');
  const deep = str(p.feltDeep, '#06180f');
  const rail = str(p.railMaterial, 'leather');
  const trim = str(p.trimMetal, 'gold');
  const logo = LOGOS[str(p.logoId, 'spade')] ?? LOGOS.spade;
  const glow = num(p.glow, 0.2);

  ctx.clearRect(0, 0, w, hgt);

  // Room behind the table
  const bg = ctx.createRadialGradient(w * 0.5, hgt * 0.34, 2, w * 0.5, hgt * 0.5, w * 0.72);
  bg.addColorStop(0, shade(deep, 0.24));
  bg.addColorStop(1, '#05060a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, hgt);

  const cx = w * 0.5;
  const cy = hgt * 0.56;
  const rx = w * 0.46;
  const ry = hgt * 0.34;

  // Rail — an outer ellipse with a material-specific treatment
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  const railGrad = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
  switch (rail) {
    case 'walnut':
      railGrad.addColorStop(0, '#6b4426');
      railGrad.addColorStop(0.45, '#40260f');
      railGrad.addColorStop(1, '#201206');
      break;
    case 'carbon':
      railGrad.addColorStop(0, '#3a4150');
      railGrad.addColorStop(0.45, '#1a1f28');
      railGrad.addColorStop(1, '#0a0d12');
      break;
    case 'suede':
      railGrad.addColorStop(0, '#4c3a52');
      railGrad.addColorStop(0.45, '#2b2033');
      railGrad.addColorStop(1, '#150f1a');
      break;
    case 'lacquer':
      railGrad.addColorStop(0, '#3d1b52');
      railGrad.addColorStop(0.35, '#160a20');
      railGrad.addColorStop(0.6, '#2a1038');
      railGrad.addColorStop(1, '#0b0410');
      break;
    case 'marble':
      railGrad.addColorStop(0, '#e6e6ea');
      railGrad.addColorStop(0.4, '#a9adb8');
      railGrad.addColorStop(1, '#5a5f6b');
      break;
    default:
      railGrad.addColorStop(0, '#2b2018');
      railGrad.addColorStop(0.42, '#17100b');
      railGrad.addColorStop(1, '#0a0705');
  }
  ctx.fillStyle = railGrad;
  ctx.fill();
  // top specular on the rail
  ctx.clip();
  const spec = ctx.createLinearGradient(0, cy - ry, 0, cy - ry * 0.1);
  spec.addColorStop(0, 'rgba(255,255,255,0.3)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(0, cy - ry, w, ry);
  if (rail === 'carbon') {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let x = -hgt; x < w + hgt; x += 5) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + hgt, hgt);
      ctx.stroke();
    }
  }
  if (rail === 'marble') {
    ctx.strokeStyle = 'rgba(60,66,80,0.4)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(w * (0.1 + i * 0.25), cy - ry);
      ctx.bezierCurveTo(w * (0.2 + i * 0.2), cy, w * (0.05 + i * 0.26), cy + ry * 0.4, w * (0.24 + i * 0.22), cy + ry);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Trim ring
  const tr = rx * 0.87;
  const trY = ry * 0.79;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, tr, trY, 0, 0, Math.PI * 2);
  ctx.strokeStyle = metalGradient(ctx, trim, 0, cy - trY, 0, cy + trY);
  ctx.lineWidth = Math.max(1.4, w * 0.012);
  ctx.stroke();
  ctx.restore();

  // Felt
  const fx = rx * 0.83;
  const fy = ry * 0.74;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, fx, fy, 0, 0, Math.PI * 2);
  const fg = ctx.createRadialGradient(cx, cy - fy * 0.3, 2, cx, cy, fx);
  fg.addColorStop(0, shade(felt, 0.22));
  fg.addColorStop(0.58, felt);
  fg.addColorStop(1, deep);
  ctx.fillStyle = fg;
  ctx.fill();
  ctx.clip();

  // Felt nap — fine diagonal noise lines, very low contrast
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.7;
  for (let i = -hgt; i < w + hgt; i += 3) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + hgt * 0.7, hgt);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Centre logo
  const scale = (fx * 1.06) / 100;
  ctx.save();
  ctx.translate(cx - 50 * scale, cy - 50 * scale);
  ctx.scale(scale, scale);
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = metalGradient(ctx, trim, 0, 0, 30, 100);
  ctx.fill(new Path2D(logo));
  ctx.globalAlpha = 0.34;
  ctx.strokeStyle = metalGradient(ctx, trim, 0, 0, 30, 100);
  ctx.lineWidth = 1.6 / scale;
  ctx.stroke(new Path2D(logo));
  ctx.restore();

  // Felt glow from the overhead lamp
  const lamp = ctx.createRadialGradient(cx, cy - fy * 0.25, 1, cx, cy, fx * 1.1);
  lamp.addColorStop(0, `rgba(255,238,200,${(0.1 + glow * 0.22).toFixed(3)})`);
  lamp.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = lamp;
  ctx.fillRect(cx - fx, cy - fy, fx * 2, fy * 2);
  ctx.restore();

  // Inner shadow where the felt meets the rail
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, fx, fy, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(2, w * 0.02);
  ctx.stroke();
  ctx.restore();

  // Table shadow on the floor
  const shadow = ctx.createRadialGradient(cx, cy + ry * 1.05, 2, cx, cy + ry * 1.05, rx);
  shadow.addColorStop(0, 'rgba(0,0,0,0.5)');
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shadow;
  ctx.fillRect(0, cy, w, hgt - cy);
}

// ─────────────────────────── felt swatch ───────────────────────────

function drawFelt(ctx: C2D, w: number, hgt: number, p: CosmeticItem['params']): void {
  const felt = str(p.feltColor, '#14432d');
  const deep = str(p.feltDeep, '#06180f');
  const pattern = str(p.pattern, 'plain');
  const sheen = num(p.sheen, 0.25);

  const g = ctx.createRadialGradient(w * 0.42, hgt * 0.3, 2, w * 0.5, hgt * 0.55, w * 0.8);
  g.addColorStop(0, shade(felt, 0.24));
  g.addColorStop(0.55, felt);
  g.addColorStop(1, deep);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, hgt);

  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.strokeStyle = '#ffffff';
  switch (pattern) {
    case 'herringbone': {
      ctx.lineWidth = 1.1;
      const step = Math.max(6, w * 0.07);
      for (let y = -hgt; y < hgt * 2; y += step) {
        for (let x = -w; x < w * 2; x += step * 2) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + step, y + step);
          ctx.lineTo(x + step * 2, y);
          ctx.stroke();
        }
      }
      break;
    }
    case 'diamond': {
      ctx.lineWidth = 0.9;
      const step = Math.max(8, w * 0.1);
      for (let i = -hgt; i < w + hgt; i += step) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + hgt, hgt);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(i, hgt);
        ctx.lineTo(i + hgt, 0);
        ctx.stroke();
      }
      break;
    }
    case 'starfield': {
      ctx.globalAlpha = 1;
      for (let i = 0; i < 60; i++) {
        const t = (i * 2654435761) >>> 0;
        const x = ((t >>> 3) % 1000) / 1000 * w;
        const y = ((t >>> 13) % 1000) / 1000 * hgt;
        const r = 0.4 + (((t >>> 21) % 100) / 100) * 1.4;
        ctx.fillStyle = `rgba(255,255,255,${(0.15 + ((t >>> 7) % 60) / 160).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default: {
      ctx.globalAlpha = 0.05;
      ctx.lineWidth = 0.7;
      for (let i = -hgt; i < w + hgt; i += 3) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + hgt * 0.6, hgt);
        ctx.stroke();
      }
    }
  }
  ctx.restore();

  const s = ctx.createLinearGradient(0, 0, w * 0.7, hgt);
  s.addColorStop(0, `rgba(255,255,255,${(sheen * 0.28).toFixed(3)})`);
  s.addColorStop(0.5, 'rgba(255,255,255,0.01)');
  s.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = s;
  ctx.fillRect(0, 0, w, hgt);
}

// ─────────────────────────── card back ───────────────────────────

function roundRectPath(ctx: C2D, x: number, y: number, w: number, hgt: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hgt, r);
  ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
  ctx.arcTo(x, y + hgt, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCardBack(ctx: C2D, w: number, hgt: number, p: CosmeticItem['params']): void {
  const baseA = str(p.baseA, '#1b2740');
  const baseB = str(p.baseB, '#0d1426');
  const ink = str(p.ink, '#8aa0cc');
  const metal = str(p.metal, 'none');
  const pattern = str(p.pattern, 'lattice');

  // Card geometry: 0.7 aspect, centred, with a drop shadow.
  const cw = Math.min(w * 0.82, hgt * 0.62);
  const ch = cw / 0.68;
  const x = (w - cw) / 2;
  const y = (hgt - ch) / 2;
  const r = cw * 0.11;

  ctx.clearRect(0, 0, w, hgt);
  ctx.save();
  ctx.shadowColor = 'rgba(2,4,8,0.7)';
  ctx.shadowBlur = cw * 0.24;
  ctx.shadowOffsetY = cw * 0.09;
  roundRectPath(ctx, x, y, cw, ch, r);
  const g = ctx.createLinearGradient(x, y, x + cw * 0.5, y + ch);
  g.addColorStop(0, shade(baseA, 0.1));
  g.addColorStop(0.55, baseA);
  g.addColorStop(1, baseB);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, x, y, cw, ch, r);
  ctx.clip();

  const px = x + cw * 0.085;
  const py = y + ch * 0.06;
  const pw = cw - cw * 0.17;
  const ph = ch - ch * 0.12;
  ctx.strokeStyle = rgba(ink, 0.75);
  ctx.lineWidth = Math.max(1, cw * 0.018);

  switch (pattern) {
    case 'lattice': {
      const step = pw / 5;
      ctx.globalAlpha = 0.7;
      for (let i = -6; i < 12; i++) {
        ctx.beginPath();
        ctx.moveTo(px + i * step, py);
        ctx.lineTo(px + i * step + ph, py + ph);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px + i * step, py + ph);
        ctx.lineTo(px + i * step + ph, py);
        ctx.stroke();
      }
      break;
    }
    case 'weave': {
      const step = pw / 9;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = Math.max(0.9, cw * 0.014);
      for (let i = 0; i <= 9; i++) {
        ctx.beginPath();
        ctx.moveTo(px + i * step, py);
        ctx.lineTo(px + i * step, py + ph);
        ctx.stroke();
      }
      for (let j = 0; j * step < ph; j++) {
        ctx.beginPath();
        ctx.moveTo(px, py + j * step);
        ctx.lineTo(px + pw, py + j * step);
        ctx.stroke();
      }
      break;
    }
    case 'chevron': {
      const step = ph / 9;
      ctx.globalAlpha = 0.8;
      for (let j = 0; j <= 9; j++) {
        ctx.beginPath();
        ctx.moveTo(px, py + j * step);
        ctx.lineTo(px + pw / 2, py + j * step - step * 0.62);
        ctx.lineTo(px + pw, py + j * step);
        ctx.stroke();
      }
      break;
    }
    case 'guilloche': {
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = Math.max(0.7, cw * 0.009);
      const ccx = x + cw / 2;
      const ccy = y + ch / 2;
      for (let k = 0; k < 5; k++) {
        ctx.beginPath();
        for (let t = 0; t <= 200; t++) {
          const a = (t / 200) * Math.PI * 2;
          const rr = pw * 0.3 + Math.sin(a * 7 + k * 0.7) * pw * 0.07;
          const xx = ccx + Math.cos(a) * rr;
          const yy = ccy + Math.sin(a) * rr * (ph / pw);
          if (t === 0) ctx.moveTo(xx, yy);
          else ctx.lineTo(xx, yy);
        }
        ctx.closePath();
        ctx.stroke();
      }
      break;
    }
    case 'scale': {
      const rr = pw / 5.2;
      ctx.globalAlpha = 0.62;
      for (let row = 0; row * rr * 0.72 < ph + rr; row++) {
        for (let col = -1; col * rr < pw + rr; col++) {
          ctx.beginPath();
          ctx.arc(px + col * rr + (row % 2 ? rr / 2 : 0), py + row * rr * 0.72, rr * 0.56, Math.PI, 0);
          ctx.stroke();
        }
      }
      break;
    }
    case 'starfield': {
      ctx.globalAlpha = 1;
      for (let i = 0; i < 90; i++) {
        const t = (i * 2654435761) >>> 0;
        const sx = px + (((t >>> 3) % 1000) / 1000) * pw;
        const sy = py + (((t >>> 13) % 1000) / 1000) * ph;
        const rr = 0.4 + (((t >>> 21) % 100) / 100) * (cw * 0.016);
        ctx.fillStyle = rgba(ink, 0.3 + (((t >>> 7) % 70) / 100));
        ctx.beginPath();
        ctx.arc(sx, sy, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'crest':
    case 'monogram': {
      ctx.globalAlpha = 0.22;
      const step = pw / 3;
      ctx.lineWidth = Math.max(0.8, cw * 0.012);
      for (let row = 0; row * step * 1.1 < ph + step; row++) {
        for (let col = 0; col * step < pw + step; col++) {
          const mx = px + col * step + (row % 2 ? step / 2 : 0);
          const my = py + row * step * 1.1;
          ctx.save();
          ctx.translate(mx, my);
          ctx.scale(step / 100, step / 100);
          ctx.strokeStyle = rgba(ink, 0.9);
          ctx.lineWidth = 6;
          ctx.stroke(new Path2D(pattern === 'crest' ? LOGOS.crest : LOGOS.crown));
          ctx.restore();
        }
      }
      break;
    }
  }
  ctx.globalAlpha = 1;

  // Border frame — a metal hairline inset from the edge
  if (metal !== 'none') {
    ctx.strokeStyle = metalGradient(ctx, metal, x, y, x + cw * 0.6, y + ch);
    ctx.lineWidth = Math.max(1.2, cw * 0.022);
    roundRectPath(ctx, x + cw * 0.055, y + cw * 0.055, cw - cw * 0.11, ch - cw * 0.11, r * 0.72);
    ctx.stroke();
    // Central medallion for the richest patterns
    if (pattern === 'monogram' || pattern === 'crest' || pattern === 'guilloche') {
      ctx.save();
      ctx.translate(x + cw / 2 - cw * 0.18, y + ch / 2 - cw * 0.18);
      ctx.scale((cw * 0.36) / 100, (cw * 0.36) / 100);
      ctx.fillStyle = metalGradient(ctx, metal, 0, 0, 40, 100);
      ctx.fill(new Path2D(pattern === 'crest' ? LOGOS.crest : pattern === 'guilloche' ? LOGOS.diamond : LOGOS.crown));
      ctx.restore();
    }
  } else {
    ctx.strokeStyle = rgba(ink, 0.5);
    ctx.lineWidth = Math.max(1, cw * 0.016);
    roundRectPath(ctx, x + cw * 0.055, y + cw * 0.055, cw - cw * 0.11, ch - cw * 0.11, r * 0.72);
    ctx.stroke();
  }

  // Card gloss
  const gloss = ctx.createLinearGradient(x, y, x + cw, y + ch * 0.8);
  gloss.addColorStop(0, 'rgba(255,255,255,0.18)');
  gloss.addColorStop(0.42, 'rgba(255,255,255,0.02)');
  gloss.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = gloss;
  ctx.fillRect(x, y, cw, ch);
  ctx.restore();

  // Outer hairline
  roundRectPath(ctx, x + 0.5, y + 0.5, cw - 1, ch - 1, r);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ─────────────────────────── chip set ───────────────────────────

function drawChipSet(ctx: C2D, w: number, hgt: number, p: CosmeticItem['params']): void {
  const primary = str(p.primary, '#c9302c');
  const secondary = str(p.secondary, '#f7f9fd');
  const edge = str(p.edge, '#7d1a17');
  const inlay = str(p.inlay, 'ring');
  const stripes = Math.max(4, Math.min(24, num(p.stripes, 8)));

  ctx.clearRect(0, 0, w, hgt);
  const rx = w * 0.3;
  const ry = rx * 0.34;
  const thick = ry * 0.72;
  const count = 5;
  const baseY = hgt * 0.68;

  // contact shadow
  const sh = ctx.createRadialGradient(w * 0.5, baseY + ry * 0.5, 1, w * 0.5, baseY + ry * 0.5, rx * 1.5);
  sh.addColorStop(0, 'rgba(0,0,0,0.55)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(0, baseY - ry, w, hgt - baseY + ry * 2);

  const chipAt = (cx: number, cy: number, top: boolean) => {
    // side wall
    ctx.beginPath();
    ctx.moveTo(cx - rx, cy);
    ctx.lineTo(cx - rx, cy - thick);
    ctx.ellipse(cx, cy - thick, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(cx + rx, cy);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI, false);
    ctx.closePath();
    const wall = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
    wall.addColorStop(0, shade(edge, -0.35));
    wall.addColorStop(0.3, primary);
    wall.addColorStop(0.55, shade(primary, 0.14));
    wall.addColorStop(1, shade(edge, -0.2));
    ctx.fillStyle = wall;
    ctx.fill();

    // edge spots on the wall
    ctx.save();
    ctx.clip();
    ctx.fillStyle = secondary;
    for (let i = 0; i < stripes; i++) {
      const a = (i / stripes) * Math.PI * 2;
      const sx = cx + Math.cos(a) * rx;
      if (Math.sin(a) > 0) continue;
      ctx.globalAlpha = 0.85 - Math.abs(Math.cos(a)) * 0.35;
      ctx.fillRect(sx - rx * 0.055, cy - thick, rx * 0.11, thick + ry * 0.3);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (!top) return;
    // face
    ctx.beginPath();
    ctx.ellipse(cx, cy - thick, rx, ry, 0, 0, Math.PI * 2);
    const face = ctx.createRadialGradient(cx - rx * 0.3, cy - thick - ry * 0.4, 1, cx, cy - thick, rx);
    face.addColorStop(0, shade(primary, 0.28));
    face.addColorStop(0.7, primary);
    face.addColorStop(1, shade(edge, -0.1));
    ctx.fillStyle = face;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.24)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy - thick, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = secondary;
    ctx.fillStyle = secondary;
    switch (inlay) {
      case 'dots':
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.ellipse(cx + Math.cos(a) * rx * 0.66, cy - thick + Math.sin(a) * ry * 0.66, rx * 0.07, ry * 0.2, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case 'bar':
        ctx.globalAlpha = 0.9;
        ctx.fillRect(cx - rx * 0.62, cy - thick - ry * 0.16, rx * 1.24, ry * 0.32);
        ctx.globalAlpha = 1;
        break;
      case 'disc': {
        ctx.beginPath();
        ctx.ellipse(cx, cy - thick, rx * 0.52, ry * 0.52, 0, 0, Math.PI * 2);
        const disc = ctx.createLinearGradient(cx - rx * 0.5, 0, cx + rx * 0.5, 0);
        disc.addColorStop(0, shade(secondary, 0.2));
        disc.addColorStop(0.5, secondary);
        disc.addColorStop(1, shade(secondary, -0.3));
        ctx.fillStyle = disc;
        ctx.fill();
        break;
      }
      case 'crest':
        ctx.save();
        ctx.translate(cx - rx * 0.3, cy - thick - ry * 0.62);
        ctx.scale((rx * 0.6) / 100, (ry * 1.24) / 100);
        ctx.fillStyle = secondary;
        ctx.fill(new Path2D(LOGOS.crown));
        ctx.restore();
        break;
      default:
        ctx.lineWidth = Math.max(1.2, rx * 0.055);
        ctx.beginPath();
        ctx.ellipse(cx, cy - thick, rx * 0.62, ry * 0.62, 0, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();

    // top specular
    const glossG = ctx.createLinearGradient(cx - rx, cy - thick - ry, cx + rx * 0.4, cy - thick + ry);
    glossG.addColorStop(0, 'rgba(255,255,255,0.26)');
    glossG.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    glossG.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy - thick, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = glossG;
    ctx.fillRect(cx - rx, cy - thick - ry, rx * 2, ry * 2);
    ctx.restore();
  };

  // Back stack, slightly right and behind
  for (let i = 0; i < 3; i++) {
    chipAt(w * 0.66, baseY - i * thick * 0.94 - hgt * 0.02, i === 2);
  }
  for (let i = 0; i < count; i++) {
    chipAt(w * 0.42, baseY - i * thick * 0.94, i === count - 1);
  }
}

// ─────────────────────────── frames ───────────────────────────

/**
 * A frame previews as the ring it is, wrapped around the player's own avatar —
 * which is the only honest way to show one.
 */
function frameNode(item: CosmeticItem, size: number, innerAvatarId: string): HTMLElement {
  const metal = str(item.params.metal, 'gold');
  const style = str(item.params.style, 'hairline');
  const glow = str(item.params.glow, '#edc96b');
  const [m1, m2, m3] = METALS[metal] ?? METALS.gold;
  const id = `fr-${item.id.replace(/[^a-z0-9]/gi, '')}`;
  const s = size;
  const c = s / 2;
  const rOuter = s * 0.47;

  const ornaments: Node[] = [];
  const ring = (r: number, wdt: number, dash?: string, op = 1) =>
    h('circle', {
      attrs: {
        cx: c, cy: c, r, fill: 'none', stroke: `url(#${id}-m)`,
        'stroke-width': wdt, 'stroke-dasharray': dash ?? null, opacity: op,
        'stroke-linecap': 'round',
      },
    });

  switch (style) {
    case 'hairline':
      ornaments.push(ring(rOuter, s * 0.022), ring(rOuter - s * 0.05, s * 0.008, undefined, 0.55));
      break;
    case 'bevel':
      ornaments.push(ring(rOuter, s * 0.05), ring(rOuter - s * 0.032, s * 0.012, undefined, 0.45));
      break;
    case 'laurel': {
      ornaments.push(ring(rOuter, s * 0.026));
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        const lx = c + Math.cos(a) * rOuter;
        const ly = c + Math.sin(a) * rOuter;
        ornaments.push(
          h('ellipse', {
            attrs: {
              cx: lx, cy: ly, rx: s * 0.045, ry: s * 0.017,
              fill: `url(#${id}-m)`,
              transform: `rotate(${(a * 180) / Math.PI + 22} ${lx} ${ly})`,
              opacity: 0.92,
            },
          }),
        );
      }
      break;
    }
    case 'rope': {
      ornaments.push(ring(rOuter, s * 0.05, `${s * 0.055} ${s * 0.03}`), ring(rOuter, s * 0.014, undefined, 0.6));
      break;
    }
    case 'serrated': {
      ornaments.push(ring(rOuter, s * 0.02));
      for (let i = 0; i < 30; i++) {
        const a = (i / 30) * Math.PI * 2;
        ornaments.push(
          h('line', {
            attrs: {
              x1: c + Math.cos(a) * (rOuter - s * 0.03),
              y1: c + Math.sin(a) * (rOuter - s * 0.03),
              x2: c + Math.cos(a) * (rOuter + s * 0.035),
              y2: c + Math.sin(a) * (rOuter + s * 0.035),
              stroke: `url(#${id}-m)`, 'stroke-width': s * 0.014, 'stroke-linecap': 'round',
            },
          }),
        );
      }
      break;
    }
    case 'flame': {
      ornaments.push(ring(rOuter, s * 0.024));
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 - Math.PI / 2;
        const x1 = c + Math.cos(a) * rOuter;
        const y1 = c + Math.sin(a) * rOuter;
        const x2 = c + Math.cos(a + 0.16) * (rOuter + s * 0.06);
        const y2 = c + Math.sin(a + 0.16) * (rOuter + s * 0.06);
        const x3 = c + Math.cos(a + 0.32) * rOuter;
        const y3 = c + Math.sin(a + 0.32) * rOuter;
        ornaments.push(
          h('path', {
            attrs: { d: `M${x1} ${y1} Q${x2} ${y2} ${x3} ${y3}`, fill: 'none', stroke: `url(#${id}-m)`, 'stroke-width': s * 0.018, 'stroke-linecap': 'round' },
          }),
        );
      }
      break;
    }
    case 'circuit': {
      ornaments.push(ring(rOuter, s * 0.018, `${s * 0.14} ${s * 0.05}`));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        ornaments.push(
          h('circle', {
            attrs: { cx: c + Math.cos(a) * rOuter, cy: c + Math.sin(a) * rOuter, r: s * 0.028, fill: `url(#${id}-m)` },
          }),
          h('line', {
            attrs: {
              x1: c + Math.cos(a) * (rOuter - s * 0.055), y1: c + Math.sin(a) * (rOuter - s * 0.055),
              x2: c + Math.cos(a) * rOuter, y2: c + Math.sin(a) * rOuter,
              stroke: `url(#${id}-m)`, 'stroke-width': s * 0.012,
            },
          }),
        );
      }
      break;
    }
  }

  const svg = h(
    'svg',
    { class: 'ec-frame__ring', attrs: { viewBox: `0 0 ${s} ${s}`, width: s, height: s, 'aria-hidden': 'true' } },
    h(
      'defs',
      null,
      h('linearGradient', { attrs: { id: `${id}-m`, x1: '0', y1: '0', x2: '0.4', y2: '1' } },
        h('stop', { attrs: { offset: '0', 'stop-color': m1 } }),
        h('stop', { attrs: { offset: '0.4', 'stop-color': m2 } }),
        h('stop', { attrs: { offset: '0.66', 'stop-color': m1 } }),
        h('stop', { attrs: { offset: '1', 'stop-color': m3 } }),
      ),
    ),
    ...ornaments,
  );

  return h(
    'span',
    {
      class: 'ec-frame',
      style: { '--fr-size': `${s}px`, '--fr-glow': glow },
    },
    h('img', {
      class: 'ec-frame__av',
      attrs: { src: getAvatarDataUrl(innerAvatarId, Math.round(s * 0.74)), alt: '', decoding: 'async' },
    }),
    svg,
  );
}

// ─────────────────────────── emotes ───────────────────────────

const EMOTE_PATHS: Record<string, string> = {
  fire: 'M12 2.6c.4 3 2.3 4.5 4 6.3 1.9 2 3 3.9 3 6.1a7 7 0 11-14 0c0-1.8.7-3.5 2-4.9.2 1.2.8 2.1 1.7 2.6-.6-3.8 1.3-7.5 3.3-10.1z',
  skull: 'M12 2.4a8 8 0 00-8 8c0 2.6 1.2 4.4 2.6 5.5v2.3c0 1.6 1.3 2.9 2.9 2.9h5c1.6 0 2.9-1.3 2.9-2.9v-2.3c1.4-1.1 2.6-2.9 2.6-5.5a8 8 0 00-8-8zm-3 8.4a1.9 1.9 0 110 3.8 1.9 1.9 0 010-3.8zm6 0a1.9 1.9 0 110 3.8 1.9 1.9 0 010-3.8z',
  clown: 'M12 4.2a7.4 7.4 0 100 14.8 7.4 7.4 0 000-14.8zm-3.6 5.6a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zm7.2 0a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zM12 12.6a2.1 2.1 0 012.1 2.1 2.1 2.1 0 01-4.2 0A2.1 2.1 0 0112 12.6zM5.4 6.1L8.9 4l.4 3.2L5.4 6.1zm13.2 0l-3.9 1.1.4-3.2 3.5 2.1z',
  money: 'M12 2.8a9.2 9.2 0 100 18.4 9.2 9.2 0 000-18.4zm.9 3.4v1.3c1.3.2 2.3.8 2.8 1.7l-1.7 1c-.3-.5-.9-.9-1.9-.9-.9 0-1.5.4-1.5 1 0 .5.4.8 1.7 1.1 2 .5 3.4 1.1 3.4 3 0 1.5-1.1 2.5-2.8 2.8v1.4h-1.8v-1.4c-1.5-.2-2.6-1-3.2-2l1.8-1c.4.7 1.1 1.2 2.2 1.2 1 0 1.6-.4 1.6-1s-.5-.9-1.9-1.2c-1.8-.4-3.2-1.1-3.2-2.9 0-1.4 1.1-2.4 2.7-2.8V6.2h1.8z',
  shock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8.6 8.2a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4zm6.8 0a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4zM12 13.4c1.7 0 3 1.2 3 2.7s-1.3 2.7-3 2.7-3-1.2-3-2.7 1.3-2.7 3-2.7z',
  clap: 'M9.4 3.4l1.6 5.2 1.5-.5-1.6-5.2-1.5.5zm5.2.4l-2.2 4.9 1.4.7 2.2-4.9-1.4-.7zM5.6 6.9l3.5 4.2 1.2-1L6.8 5.9l-1.2 1zM8 12.4a3.4 3.4 0 00-2.4 5.8l2.6 2.6a5 5 0 003.6 1.5h3.6a4.8 4.8 0 004.8-4.8v-3.9a1.7 1.7 0 00-3.4 0v-.9a1.7 1.7 0 00-3.4 0v-.6a1.7 1.7 0 00-3.4 0v-.6A1.7 1.7 0 008 12.4z',
  cold: 'M12 2.6v18.8M4 7l16 10M20 7L4 17M12 5.4l-2.2 2.2M12 5.4l2.2 2.2M12 18.6l-2.2-2.2M12 18.6l2.2-2.2M5.6 9.4l3-.8M5.6 14.6l3 .8M18.4 9.4l-3-.8M18.4 14.6l-3 .8',
  heart: 'M12 20.4S3.4 15.3 3.4 9.4A4.6 4.6 0 0112 6.9a4.6 4.6 0 018.6 2.5c0 5.9-8.6 11-8.6 11z',
  laugh: 'M12 3a9 9 0 100 18 9 9 0 000-18zM7.4 9.2c.6-.9 1.5-1.4 2.4-1.4s1.8.5 2.4 1.4M12.2 9.2c.6-.9 1.5-1.4 2.4-1.4s1.8.5 2.4 1.4M6.6 13.4h10.8c0 3-2.4 5.2-5.4 5.2s-5.4-2.2-5.4-5.2z',
  eyes: 'M6.6 8.4c2.6 0 4.6 1.8 4.6 3.9s-2 3.9-4.6 3.9S2 14.4 2 12.3s2-3.9 4.6-3.9zm10.8 0c2.6 0 4.6 1.8 4.6 3.9s-2 3.9-4.6 3.9-4.6-1.8-4.6-3.9 2-3.9 4.6-3.9zM7.4 10.6a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4zm10.8 0a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4z',
  crown: 'M3.3 8.1l3.9 2.7L12 5.2l4.8 5.6 3.9-2.7-1.7 9.1H5L3.3 8.1zM5.4 20.1h13.2',
};

const STROKED = new Set(['cold', 'laugh']);

export function emoteGlyph(kind: string, size: number, tint: string): SVGSVGElement {
  const d = EMOTE_PATHS[kind] ?? EMOTE_PATHS.fire;
  const stroked = STROKED.has(kind);
  return h(
    'svg',
    {
      class: 'ec-emote__g',
      attrs: { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    },
    h('path', {
      attrs: {
        d,
        fill: stroked ? 'none' : tint,
        stroke: stroked ? tint : 'none',
        'stroke-width': stroked ? 1.7 : 0,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
    }),
  );
}

function emoteNode(item: CosmeticItem, size: number): HTMLElement {
  const tint = str(item.params.tint, '#edc96b');
  const set = str(item.params.set, 'fire,skull,clown,money,shock,clap')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
  const glyph = Math.max(14, Math.round(size * 0.26));
  return h(
    'span',
    { class: 'ec-emote', style: { '--ec-size': `${size}px`, '--ec-tint': tint } },
    ...set.map((k) =>
      h('span', { class: 'ec-emote__cell' }, emoteGlyph(k as ReactionKind, glyph, tint)),
    ),
  );
}

// ─────────────────────────── titles ───────────────────────────

const TITLE_TONE: Record<string, string> = {
  neutral: '#b7bfd0',
  cool: '#7fc4ea',
  warm: '#f0b23f',
  good: '#34d399',
  bad: '#f6534f',
  gold: '#edc96b',
  epic: '#c9a0ff',
  mythic: '#ff88bb',
};

function titleNode(item: CosmeticItem, size: number, playerName: string): HTMLElement {
  const tone = TITLE_TONE[str(item.params.tone, 'neutral')] ?? TITLE_TONE.neutral;
  const text = str(item.params.text, item.name);
  return h(
    'span',
    { class: 'ec-title', style: { '--ec-size': `${size}px`, '--ec-tone': tone } },
    h('span', { class: 'ec-title__name' }, playerName),
    h(
      'span',
      { class: 'ec-title__plate' },
      h('i', { class: 'ec-title__dot', 'aria-hidden': 'true' }),
      h('span', { class: 'ec-title__t' }, text),
    ),
  );
}

// ─────────────────────────── entry point ───────────────────────────

export interface PreviewOpts {
  /** the preview's square-ish edge, in CSS px */
  size?: number;
  /** the big detail-sheet treatment: wider, more detail */
  hero?: boolean;
  /** avatar shown inside frame previews */
  avatarId?: string;
  /** name shown in title previews */
  playerName?: string;
  /** force the animated treatment on avatars */
  animate?: boolean;
}

/**
 * The right live preview for any cosmetic. Always returns a node sized to
 * `size`; the caller only has to place it.
 */
export function previewNode(item: CosmeticItem, opts: PreviewOpts = {}): HTMLElement {
  const size = opts.size ?? 96;
  const wide = opts.hero ? size * 1.45 : size;

  switch (item.kind) {
    case 'avatar':
      return createAvatarElement({
        id: item.id,
        size,
        animate: opts.animate,
        alt: item.name,
        class: 'ec-prev ec-prev--avatar',
      });
    case 'frame':
      return frameNode(item, size, opts.avatarId ?? 'avatar-first-light');
    case 'title':
      return titleNode(item, size, opts.playerName ?? 'You');
    case 'emote':
      return emoteNode(item, size);
    case 'table-skin':
      return img(
        raster(item.id, wide, size, (c, w, hh) => drawTableSkin(c, w, hh, item.params)),
        wide, size, 'ec-prev ec-prev--table',
      );
    case 'felt':
      return img(
        raster(item.id, wide, size, (c, w, hh) => drawFelt(c, w, hh, item.params)),
        wide, size, 'ec-prev ec-prev--felt',
      );
    case 'card-back':
      return img(
        raster(item.id, size, size, (c, w, hh) => drawCardBack(c, w, hh, item.params)),
        size, size, 'ec-prev ec-prev--card',
      );
    case 'chip-set':
      return img(
        raster(item.id, size, size, (c, w, hh) => drawChipSet(c, w, hh, item.params)),
        size, size, 'ec-prev ec-prev--chips',
      );
  }
}

/** Drops every cached raster — call after a DPR change. */
export function clearPreviewCache(): void {
  rasterCache.clear();
}
