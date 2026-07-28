/**
 * Procedural playing-card art.
 *
 * Every one of the 52 faces is drawn with canvas2d into a single texture
 * atlas (13 rank columns × 4 suit rows) at retina density, plus a set of
 * standalone card-back textures used for cosmetics. Nothing is downloaded.
 *
 * Art direction
 * ─────────────
 * • FOUR-COLOUR DECK. Red/black is illegible at phone size once two cards
 *   overlap; clubs go green, diamonds blue, hearts red, spades near-black,
 *   matching the `--c-suit-*` tokens exactly.
 * • Large corner index. The single most common failure in poker apps is a
 *   rank glyph sized for a desktop table. Ours is ~17% of the card height
 *   and optically normalised: every glyph is measured and scaled so its ink
 *   box — not its font metrics — fills the same cap box. "10" is condensed
 *   so the index column stays a constant width.
 * • Court cards are heraldic monograms, not portraits. A crowned monogram
 *   inside a guilloche panel, point-symmetric like a real court card, reads
 *   cleanly at 40px tall where a painted king turns into mud.
 * • The paper is never flat white: a warm off-white with a vertical tone
 *   shift, a soft vignette and a fine grain tile at 3% — the thing that
 *   stops a procedural card from looking like a CSS div.
 *
 * The atlas is built in four chunks (one per suit) so the main thread never
 * blocks for more than a few milliseconds; `ready` resolves when it is done
 * and `ensureBuilt()` forces completion if a card is needed sooner.
 */
import * as THREE from 'three';
import type { CardId, Suit } from '../core/types.ts';

// ─────────────────────────── palette ───────────────────────────

interface SuitPalette {
  /** the token colour */
  main: string;
  /** shadow stop for metallic fills */
  deep: string;
  /** highlight stop */
  light: string;
  /** faint tint for guilloche behind the aces */
  wash: string;
  /** court-card panel fill — heavy enough to give the face real weight */
  panel: string;
  /** panel rule */
  rule: string;
}

const SUIT_PALETTE: Record<Suit, SuitPalette> = {
  0: {
    main: '#22a06b',
    deep: '#0f6f47',
    light: '#7fdcb0',
    wash: 'rgba(34,160,107,0.13)',
    panel: 'rgba(34,160,107,0.17)',
    rule: 'rgba(15,111,71,0.55)',
  },
  1: {
    main: '#3d8bfd',
    deep: '#1c5cc4',
    light: '#9cc4ff',
    wash: 'rgba(61,139,253,0.13)',
    panel: 'rgba(61,139,253,0.16)',
    rule: 'rgba(28,92,196,0.55)',
  },
  2: {
    main: '#e5484d',
    deep: '#a4161f',
    light: '#ffa3a0',
    wash: 'rgba(229,72,77,0.13)',
    panel: 'rgba(229,72,77,0.15)',
    rule: 'rgba(164,22,31,0.5)',
  },
  3: {
    main: '#1c2333',
    deep: '#05080f',
    light: '#6b7488',
    wash: 'rgba(28,35,51,0.12)',
    panel: 'rgba(28,35,51,0.13)',
    rule: 'rgba(28,35,51,0.55)',
  },
};

const GOLD_100 = '#fdf3d0';
const GOLD_300 = '#edc96b';
const GOLD_400 = '#d9a93a';
const GOLD_500 = '#c08d21';
const GOLD_700 = '#63460a';

// Warm ivory, not paper white. Under a bright key with ACES tone mapping a
// 0.99 albedo clips to a flat white slab; ivory keeps a highlight roll-off
// and reads as card stock rather than as printer paper.
const PAPER_TOP = '#f9f7f1';
const PAPER_BOT = '#e9e5da';
const PAPER_EDGE = 'rgba(28,35,51,0.16)';

const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const SERIF =
  "'Iowan Old Style','Palatino Linotype',Palatino,'Hoefler Text',Georgia,'Times New Roman','Noto Serif',serif";

// ─────────────────────────── atlas geometry ───────────────────────────

const COLS = 13;
const ROWS = 4;
/** Base cell at scale 1. 63:88 to two decimals, which is a real card. */
const BASE_CELL_W = 232;
const BASE_CELL_H = 324;

export type CardBackId =
  | 'royale-gold'
  | 'obsidian'
  | 'crimson'
  | 'emerald'
  | 'platinum';

export interface CardBackDef {
  id: CardBackId;
  name: string;
  /** field, pattern, rim — consumed by the back painter */
  field: [string, string];
  pattern: string;
  rim: [string, string, string];
  medallion: string;
  /** rosette frequency — each back gets its own figure */
  petals: number;
}

export const CARD_BACKS: CardBackDef[] = [
  {
    id: 'royale-gold',
    name: 'Royale Gold',
    field: ['#1c2438', '#0a0f1c'],
    pattern: 'rgba(237,201,107,0.6)',
    rim: [GOLD_100, GOLD_300, GOLD_700],
    medallion: '#edc96b',
    petals: 13,
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    field: ['#232a3a', '#0a0e16'],
    pattern: 'rgba(196,205,224,0.46)',
    rim: ['#e8edf6', '#98a3b8', '#333b4c'],
    medallion: '#cfd6e2',
    petals: 9,
  },
  {
    id: 'crimson',
    name: 'Crimson Court',
    field: ['#4d131c', '#1d060a'],
    pattern: 'rgba(255,190,150,0.46)',
    rim: [GOLD_100, GOLD_300, '#4a2c06'],
    medallion: '#f3c98f',
    petals: 17,
  },
  {
    id: 'emerald',
    name: 'Emerald Room',
    field: ['#123c29', '#061a10'],
    pattern: 'rgba(160,240,198,0.44)',
    rim: [GOLD_100, GOLD_300, '#3d3005'],
    medallion: '#d8f0dd',
    petals: 11,
  },
  {
    id: 'platinum',
    name: 'Platinum Ice',
    field: ['#273448', '#0b1220'],
    pattern: 'rgba(206,230,255,0.48)',
    rim: ['#f4f8ff', '#b9c8de', '#3b4457'],
    medallion: '#e6f0ff',
    petals: 21,
  },
];

// ─────────────────────────── tiny 2d helpers ───────────────────────────

type Ctx = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c: HTMLCanvasElement): Ctx {
  const g = c.getContext('2d', { alpha: true, willReadFrequently: false });
  if (!g) throw new Error('canvas 2d unavailable');
  return g;
}

function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

function linGrad(g: Ctx, x0: number, y0: number, x1: number, y1: number, stops: Array<[number, string]>) {
  const grad = g.createLinearGradient(x0, y0, x1, y1);
  for (const [p, c] of stops) grad.addColorStop(p, c);
  return grad;
}

/**
 * Draws text scaled so its *ink* box fills `boxH`, centred on (cx, cy).
 * Font metrics vary wildly between the serif that actually resolves on iOS
 * and the one on Android; normalising on the measured bounding box is what
 * keeps every rank the same optical size on every device.
 */
function inkText(
  g: Ctx,
  text: string,
  cx: number,
  cy: number,
  boxH: number,
  opts: { maxW?: number; condense?: number; weight?: number; font?: string } = {},
): void {
  const weight = opts.weight ?? 700;
  const family = opts.font ?? SERIF;
  g.font = `${weight} 160px ${family}`;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const m = g.measureText(text);
  const asc = m.actualBoundingBoxAscent || 112;
  const desc = m.actualBoundingBoxDescent || 0;
  const left = m.actualBoundingBoxLeft || 0;
  const right = m.actualBoundingBoxRight || m.width;
  const gh = Math.max(1, asc + desc);
  const gw = Math.max(1, left + right);
  let s = boxH / gh;
  const condense = opts.condense ?? 1;
  if (opts.maxW && gw * s * condense > opts.maxW) s = opts.maxW / (gw * condense);
  g.save();
  g.translate(cx, cy);
  g.scale(s * condense, s);
  g.fillText(text, (left - right) / 2, (asc - desc) / 2);
  g.restore();
}

// ─────────────────────────── suit pip paths ───────────────────────────

/**
 * Each pip is authored in a unit box centred on the origin, y down, so the
 * layout engine only ever deals in "pip height" and never in per-suit magic
 * numbers. Shapes are hand-tuned béziers — the club's lobes are slightly
 * over-round and the spade's shoulders slightly square, which is what makes
 * them legible at 12px instead of turning into blobs.
 */
function pipPath(g: Ctx, suit: Suit): void {
  g.beginPath();
  switch (suit) {
    case 3: // spade
      g.moveTo(0, -0.5);
      g.bezierCurveTo(0.04, -0.3, 0.19, -0.17, 0.33, -0.04);
      g.bezierCurveTo(0.5, 0.11, 0.48, 0.31, 0.32, 0.38);
      g.bezierCurveTo(0.21, 0.43, 0.11, 0.38, 0.055, 0.28);
      g.bezierCurveTo(0.07, 0.4, 0.13, 0.47, 0.215, 0.5);
      g.lineTo(-0.215, 0.5);
      g.bezierCurveTo(-0.13, 0.47, -0.07, 0.4, -0.055, 0.28);
      g.bezierCurveTo(-0.11, 0.38, -0.21, 0.43, -0.32, 0.38);
      g.bezierCurveTo(-0.48, 0.31, -0.5, 0.11, -0.33, -0.04);
      g.bezierCurveTo(-0.19, -0.17, -0.04, -0.3, 0, -0.5);
      g.closePath();
      break;
    case 2: // heart
      g.moveTo(0, 0.5);
      g.bezierCurveTo(-0.09, 0.35, -0.44, 0.12, -0.47, -0.13);
      g.bezierCurveTo(-0.5, -0.37, -0.31, -0.5, -0.17, -0.47);
      g.bezierCurveTo(-0.07, -0.45, -0.01, -0.36, 0, -0.27);
      g.bezierCurveTo(0.01, -0.36, 0.07, -0.45, 0.17, -0.47);
      g.bezierCurveTo(0.31, -0.5, 0.5, -0.37, 0.47, -0.13);
      g.bezierCurveTo(0.44, 0.12, 0.09, 0.35, 0, 0.5);
      g.closePath();
      break;
    case 1: // diamond
      g.moveTo(0, -0.5);
      g.bezierCurveTo(0.13, -0.29, 0.29, -0.11, 0.35, 0);
      g.bezierCurveTo(0.29, 0.11, 0.13, 0.29, 0, 0.5);
      g.bezierCurveTo(-0.13, 0.29, -0.29, 0.11, -0.35, 0);
      g.bezierCurveTo(-0.29, -0.11, -0.13, -0.29, 0, -0.5);
      g.closePath();
      break;
    default: {
      // club — three lobes plus a flared stem
      const r = 0.205;
      g.moveTo(0, -0.5 + r);
      g.arc(0, -0.5 + r + 0.02, r, -Math.PI * 0.98, Math.PI * 0.16, false);
      g.arc(0.278, 0.055, r, -Math.PI * 0.62, Math.PI * 0.52, false);
      g.lineTo(0.075, 0.14);
      g.bezierCurveTo(0.09, 0.3, 0.15, 0.44, 0.235, 0.5);
      g.lineTo(-0.235, 0.5);
      g.bezierCurveTo(-0.15, 0.44, -0.09, 0.3, -0.075, 0.14);
      g.lineTo(-0.278 + 0.16, 0.16);
      g.arc(-0.278, 0.055, r, Math.PI * 0.48, Math.PI * 1.62, false);
      g.closePath();
      break;
    }
  }
}

function drawPip(g: Ctx, suit: Suit, cx: number, cy: number, h: number, flip: boolean, pal: SuitPalette): void {
  g.save();
  g.translate(cx, cy);
  g.scale(h, h);
  if (flip) g.rotate(Math.PI);
  pipPath(g, suit);
  const grad = g.createLinearGradient(0, -0.5, 0, 0.5);
  grad.addColorStop(0, pal.main);
  grad.addColorStop(0.62, pal.main);
  grad.addColorStop(1, pal.deep);
  g.fillStyle = grad;
  g.fill();
  // hairline that separates the pip from the paper without reading as a stroke
  g.lineWidth = 0.018;
  g.strokeStyle = 'rgba(0,0,0,0.14)';
  g.stroke();
  g.restore();
}

// ─────────────────────────── ornaments ───────────────────────────

/** A five-point crown in a unit box, y down. Used by kings. */
function crownPath(g: Ctx): void {
  g.beginPath();
  g.moveTo(-0.5, 0.3);
  g.lineTo(-0.46, -0.14);
  g.lineTo(-0.24, 0.1);
  g.lineTo(-0.015, -0.36);
  g.lineTo(0.015, -0.36);
  g.lineTo(0.24, 0.1);
  g.lineTo(0.46, -0.14);
  g.lineTo(0.5, 0.3);
  g.closePath();
}

function drawCrown(g: Ctx, cx: number, cy: number, w: number, pal: SuitPalette): void {
  const h = w;
  g.save();
  g.translate(cx, cy);
  g.scale(w, h);
  crownPath(g);
  const grad = g.createLinearGradient(0, -0.4, 0, 0.35);
  grad.addColorStop(0, GOLD_100);
  grad.addColorStop(0.4, GOLD_300);
  grad.addColorStop(1, GOLD_500);
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 0.022;
  g.strokeStyle = 'rgba(99,70,10,0.55)';
  g.stroke();
  // finials
  g.fillStyle = GOLD_100;
  for (const [px, py] of [
    [-0.46, -0.2],
    [0, -0.42],
    [0.46, -0.2],
  ] as const) {
    g.beginPath();
    g.arc(px, py, 0.068, 0, Math.PI * 2);
    g.fill();
  }
  // band
  g.beginPath();
  g.rect(-0.52, 0.3, 1.04, 0.17);
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 0.02;
  g.stroke();
  g.fillStyle = pal.main;
  for (const px of [-0.28, 0, 0.28]) {
    g.beginPath();
    g.moveTo(px, 0.33);
    g.lineTo(px + 0.045, 0.385);
    g.lineTo(px, 0.44);
    g.lineTo(px - 0.045, 0.385);
    g.closePath();
    g.fill();
  }
  g.restore();
}

/** A queen's arched coronet. */
function drawTiara(g: Ctx, cx: number, cy: number, w: number, pal: SuitPalette): void {
  g.save();
  g.translate(cx, cy);
  g.scale(w, w);
  const grad = g.createLinearGradient(0, -0.4, 0, 0.4);
  grad.addColorStop(0, GOLD_100);
  grad.addColorStop(0.45, GOLD_300);
  grad.addColorStop(1, GOLD_500);
  g.beginPath();
  g.moveTo(-0.5, 0.3);
  g.bezierCurveTo(-0.46, -0.1, -0.24, -0.34, 0, -0.34);
  g.bezierCurveTo(0.24, -0.34, 0.46, -0.1, 0.5, 0.3);
  g.lineTo(0.36, 0.3);
  g.bezierCurveTo(0.33, 0.0, 0.18, -0.18, 0, -0.18);
  g.bezierCurveTo(-0.18, -0.18, -0.33, 0.0, -0.36, 0.3);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 0.02;
  g.strokeStyle = 'rgba(99,70,10,0.5)';
  g.stroke();
  g.beginPath();
  g.rect(-0.52, 0.3, 1.04, 0.15);
  g.fillStyle = grad;
  g.fill();
  g.stroke();
  // pearls along the arch
  g.fillStyle = GOLD_100;
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const a = Math.PI * (1 - t);
    g.beginPath();
    g.arc(Math.cos(a) * 0.43, -0.04 - Math.sin(a) * 0.26, 0.052, 0, Math.PI * 2);
    g.fill();
  }
  // centre jewel
  g.beginPath();
  g.moveTo(0, -0.06);
  g.lineTo(0.075, 0.05);
  g.lineTo(0, 0.17);
  g.lineTo(-0.075, 0.05);
  g.closePath();
  g.fillStyle = pal.main;
  g.fill();
  g.restore();
}

/** A jack's fleur-de-lys plume. */
function drawFleur(g: Ctx, cx: number, cy: number, w: number, pal: SuitPalette): void {
  g.save();
  g.translate(cx, cy);
  g.scale(w, w);
  const grad = g.createLinearGradient(0, -0.45, 0, 0.4);
  grad.addColorStop(0, GOLD_100);
  grad.addColorStop(0.45, GOLD_300);
  grad.addColorStop(1, GOLD_500);
  g.beginPath();
  // centre petal
  g.moveTo(0, -0.46);
  g.bezierCurveTo(0.11, -0.28, 0.13, -0.05, 0.075, 0.12);
  g.lineTo(-0.075, 0.12);
  g.bezierCurveTo(-0.13, -0.05, -0.11, -0.28, 0, -0.46);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 0.02;
  g.strokeStyle = 'rgba(99,70,10,0.5)';
  g.stroke();
  // side petals
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(s * 0.07, 0.06);
    g.bezierCurveTo(s * 0.3, -0.06, s * 0.46, -0.22, s * 0.44, -0.02);
    g.bezierCurveTo(s * 0.42, 0.12, s * 0.24, 0.15, s * 0.1, 0.13);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    g.stroke();
  }
  // binding band
  g.beginPath();
  g.rect(-0.22, 0.13, 0.44, 0.1);
  g.fillStyle = grad;
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(0, 0.26);
  g.lineTo(0.06, 0.35);
  g.lineTo(0, 0.45);
  g.lineTo(-0.06, 0.35);
  g.closePath();
  g.fillStyle = pal.main;
  g.fill();
  g.restore();
}

// ─────────────────────────── paper ───────────────────────────

let grainTile: HTMLCanvasElement | null = null;

function getGrain(): HTMLCanvasElement {
  if (grainTile) return grainTile;
  const size = 128;
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  let seed = 0x9e3779b9;
  for (let i = 0; i < size * size; i++) {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x1b873593) >>> 0;
    const n = (seed >>> 24) - 128;
    const v = 128 + n * 0.5;
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

function paintPaper(g: Ctx, w: number, h: number, radius: number): void {
  g.save();
  roundRect(g, 0, 0, w, h, radius);
  g.clip();
  g.fillStyle = linGrad(g, 0, 0, 0, h, [
    [0, PAPER_TOP],
    [0.55, '#f3f0e8'],
    [1, PAPER_BOT],
  ]);
  g.fillRect(0, 0, w, h);

  // soft vignette so the card has volume before a single light hits it
  const vg = g.createRadialGradient(w * 0.5, h * 0.42, w * 0.1, w * 0.5, h * 0.5, h * 0.72);
  vg.addColorStop(0, 'rgba(255,255,255,0)');
  vg.addColorStop(0.72, 'rgba(120,116,104,0.05)');
  vg.addColorStop(1, 'rgba(96,92,80,0.16)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);

  // fine grain
  const pat = g.createPattern(getGrain(), 'repeat');
  if (pat) {
    g.globalAlpha = 0.055;
    g.globalCompositeOperation = 'overlay';
    g.fillStyle = pat;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }
  g.restore();

  // border: a hairline just inside the die-cut, with an inner light lift
  g.save();
  g.lineWidth = Math.max(1.2, w * 0.008);
  g.strokeStyle = PAPER_EDGE;
  roundRect(g, g.lineWidth * 1.6, g.lineWidth * 1.6, w - g.lineWidth * 3.2, h - g.lineWidth * 3.2, radius * 0.86);
  g.stroke();
  g.lineWidth = Math.max(1, w * 0.005);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  roundRect(g, g.lineWidth * 3.4, g.lineWidth * 3.4, w - g.lineWidth * 6.8, h - g.lineWidth * 6.8, radius * 0.74);
  g.stroke();
  g.restore();
}

// ─────────────────────────── pip layouts ───────────────────────────

/** column (−1,0,1) · row (−1..1 in card space) · inverted */
type PipSpot = [number, number, boolean];

const Y_TOP = -0.312;
const Y_MID_HI = -0.156;
const Y_QTR = -0.104;

const PIP_LAYOUT: Record<number, PipSpot[]> = {
  2: [
    [0, Y_TOP, false],
    [0, -Y_TOP, true],
  ],
  3: [
    [0, Y_TOP, false],
    [0, 0, false],
    [0, -Y_TOP, true],
  ],
  4: [
    [-1, Y_TOP, false],
    [1, Y_TOP, false],
    [-1, -Y_TOP, true],
    [1, -Y_TOP, true],
  ],
  5: [
    [-1, Y_TOP, false],
    [1, Y_TOP, false],
    [0, 0, false],
    [-1, -Y_TOP, true],
    [1, -Y_TOP, true],
  ],
  6: [
    [-1, Y_TOP, false],
    [1, Y_TOP, false],
    [-1, 0, false],
    [1, 0, false],
    [-1, -Y_TOP, true],
    [1, -Y_TOP, true],
  ],
  7: [
    [-1, Y_TOP, false],
    [1, Y_TOP, false],
    [0, Y_MID_HI, false],
    [-1, 0, false],
    [1, 0, false],
    [-1, -Y_TOP, true],
    [1, -Y_TOP, true],
  ],
  8: [
    [-1, Y_TOP, false],
    [1, Y_TOP, false],
    [0, Y_MID_HI, false],
    [-1, 0, false],
    [1, 0, false],
    [0, -Y_MID_HI, true],
    [-1, -Y_TOP, true],
    [1, -Y_TOP, true],
  ],
  9: [
    [-1, Y_TOP, false],
    [1, Y_TOP, false],
    [-1, Y_QTR, false],
    [1, Y_QTR, false],
    [0, 0, false],
    [-1, -Y_QTR, true],
    [1, -Y_QTR, true],
    [-1, -Y_TOP, true],
    [1, -Y_TOP, true],
  ],
  10: [
    [-1, Y_TOP, false],
    [1, Y_TOP, false],
    [0, -0.208, false],
    [-1, Y_QTR, false],
    [1, Y_QTR, false],
    [-1, -Y_QTR, true],
    [1, -Y_QTR, true],
    [0, 0.208, true],
    [-1, -Y_TOP, true],
    [1, -Y_TOP, true],
  ],
};

// ─────────────────────────── face painters ───────────────────────────

/**
 * The corner index.
 *
 * A real playing card gives its index about 11% of the card's height, because
 * a real card is read at arm's length in a lit room. A phone is neither: on a
 * 393 pt screen a felt card is a few dozen pixels tall, and 11% of that is a
 * glyph nobody can resolve. Ours takes 17.5% — half again as large as a Bee —
 * and the suit pip under it grows with it. The whole index column is still
 * inside the same margin, so the pip layouts and the court panel below are
 * untouched; it is only the ink that got confident.
 */
function paintIndex(g: Ctx, w: number, h: number, rank: number, suit: Suit, pal: SuitPalette): void {
  const label = RANK_CHARS[rank - 2];
  const isTen = label === '10';
  const glyphH = h * 0.16;
  const pipH = h * 0.098;
  const colX = w * 0.122;
  const glyphY = h * 0.112;
  const pipY = glyphY + glyphH * 0.6 + pipH * 0.66;

  for (const flip of [false, true]) {
    g.save();
    if (flip) {
      g.translate(w, h);
      g.rotate(Math.PI);
    }
    // A soft halo of paper behind the index keeps it legible where it crosses
    // a court panel or an ace's guilloche, without reading as an outline.
    g.save();
    g.shadowColor = 'rgba(249,247,241,0.95)';
    g.shadowBlur = w * 0.035;
    g.fillStyle = pal.main;
    inkText(g, label, colX, glyphY, glyphH, {
      maxW: w * 0.205,
      condense: isTen ? 0.78 : 1,
      weight: 700,
    });
    drawPip(g, suit, colX, pipY, pipH, false, pal);
    g.restore();
    g.restore();
  }
}

/** A faint engine-turned rosette used behind aces and inside court panels. */
function guilloche(
  g: Ctx,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  petals: number,
  lines: number,
  lineWidth: number,
): void {
  g.save();
  g.translate(cx, cy);
  g.strokeStyle = color;
  g.lineWidth = lineWidth;
  g.lineJoin = 'round';
  for (let k = 0; k < lines; k++) {
    const phase = (k / lines) * Math.PI * 2;
    const amp = radius * (0.16 + 0.05 * Math.sin(k * 1.7));
    const base = radius * (0.62 + 0.3 * (k / lines));
    g.beginPath();
    const steps = 220;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const r = base + amp * Math.cos(petals * t + phase);
      const x = Math.cos(t) * r;
      const y = Math.sin(t) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.stroke();
  }
  g.restore();
}

function paintAce(g: Ctx, w: number, h: number, suit: Suit, pal: SuitPalette): void {
  const cx = w * 0.5;
  const cy = h * 0.5;
  guilloche(g, cx, cy, w * 0.3, pal.wash, 7, 4, Math.max(0.8, w * 0.004));
  // ornamental collar
  g.save();
  g.strokeStyle = 'rgba(192,141,33,0.42)';
  g.lineWidth = Math.max(1, w * 0.006);
  g.beginPath();
  g.arc(cx, cy, w * 0.318, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = Math.max(0.8, w * 0.003);
  g.beginPath();
  g.arc(cx, cy, w * 0.345, 0, Math.PI * 2);
  g.stroke();
  g.restore();

  const big = suit === 3 ? h * 0.42 : h * 0.36;
  // drop shadow gives the ace pip physical presence at any size
  g.save();
  g.translate(0, h * 0.006);
  g.globalAlpha = 0.16;
  drawPip(g, suit, cx, cy, big, false, { ...pal, main: '#000', deep: '#000', light: '#000' });
  g.restore();
  drawPip(g, suit, cx, cy, big, false, pal);

  if (suit === 3) {
    // the ace of spades earns its flourish
    g.save();
    g.strokeStyle = 'rgba(253,243,208,0.5)';
    g.lineWidth = Math.max(1, w * 0.005);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + s * w * 0.13, cy + h * 0.2);
      g.bezierCurveTo(
        cx + s * w * 0.28,
        cy + h * 0.19,
        cx + s * w * 0.33,
        cy + h * 0.1,
        cx + s * w * 0.28,
        cy + h * 0.03,
      );
      g.stroke();
    }
    g.restore();
  }
}

function paintCourtHalf(g: Ctx, w: number, h: number, rankChar: string, suit: Suit, pal: SuitPalette): void {
  const cx = w * 0.5;
  if (rankChar === 'K') drawCrown(g, cx, h * 0.206, w * 0.36, pal);
  else if (rankChar === 'Q') drawTiara(g, cx, h * 0.206, w * 0.36, pal);
  else drawFleur(g, cx, h * 0.204, w * 0.32, pal);

  // Monogram.
  //
  // Solid suit colour, deliberately — not a metal ramp. `inkText` scales the
  // glyph to normalise its ink box, and a gradient authored in card space gets
  // scaled with it, so the letter ends up sampling only the pale top third of
  // the ramp and reads as a pink ghost on a pink panel. At 40 px tall the
  // court card's job is to say K, and one confident colour says it.
  const monoH = h * 0.196;
  const monoY = h * 0.366;
  g.save();
  // a dark contact shadow, then a paper halo, then the letter
  g.globalAlpha = 0.2;
  g.fillStyle = '#000';
  g.translate(0, h * 0.005);
  inkText(g, rankChar, cx, monoY, monoH, { maxW: w * 0.46, weight: 700 });
  g.restore();

  g.save();
  g.shadowColor = 'rgba(252,250,244,0.95)';
  g.shadowBlur = w * 0.05;
  g.fillStyle = pal.main;
  inkText(g, rankChar, cx, monoY, monoH, { maxW: w * 0.46, weight: 700 });
  // a second pass paints the halo up to full opacity without darkening the ink
  inkText(g, rankChar, cx, monoY, monoH, { maxW: w * 0.46, weight: 700 });
  g.restore();

  // flanking pips lock the monogram to its suit
  drawPip(g, suit, cx - w * 0.253, h * 0.352, h * 0.062, false, pal);
  drawPip(g, suit, cx + w * 0.253, h * 0.352, h * 0.062, false, pal);
}

function paintCourt(g: Ctx, w: number, h: number, rankChar: string, suit: Suit, pal: SuitPalette): void {
  const px = w * 0.115;
  const py = h * 0.098;
  const pw = w - px * 2;
  const ph = h - py * 2;
  const rad = w * 0.05;

  g.save();
  roundRect(g, px, py, pw, ph, rad);
  g.clip();
  g.fillStyle = pal.panel;
  g.fillRect(px, py, pw, ph);
  guilloche(g, w * 0.5, h * 0.5, w * 0.46, pal.rule.replace('0.5', '0.1').replace('0.55', '0.1'), 9, 5, Math.max(0.8, w * 0.004));
  // 45° lattice — the texture that separates an engraved panel from a swatch
  g.strokeStyle = 'rgba(0,0,0,0.055)';
  g.lineWidth = Math.max(0.8, w * 0.0034);
  const step = w * 0.055;
  for (let i = -ph; i < pw + ph; i += step) {
    g.beginPath();
    g.moveTo(px + i, py);
    g.lineTo(px + i + ph, py + ph);
    g.stroke();
    g.beginPath();
    g.moveTo(px + i, py + ph);
    g.lineTo(px + i + ph, py);
    g.stroke();
  }
  // a soft light from top-left so the panel has a direction
  const sheen = g.createLinearGradient(px, py, px + pw, py + ph);
  sheen.addColorStop(0, 'rgba(255,255,255,0.4)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.06)');
  g.fillStyle = sheen;
  g.fillRect(px, py, pw, ph);
  g.restore();

  // triple panel rule: gold, suit, gold hairline
  g.save();
  g.strokeStyle = 'rgba(192,141,33,0.7)';
  g.lineWidth = Math.max(1.4, w * 0.0075);
  roundRect(g, px, py, pw, ph, rad);
  g.stroke();
  g.strokeStyle = pal.rule;
  g.lineWidth = Math.max(0.9, w * 0.004);
  roundRect(g, px + w * 0.019, py + w * 0.019, pw - w * 0.038, ph - w * 0.038, rad * 0.72);
  g.stroke();
  g.strokeStyle = 'rgba(253,243,208,0.85)';
  g.lineWidth = Math.max(0.7, w * 0.0026);
  roundRect(g, px + w * 0.027, py + w * 0.027, pw - w * 0.054, ph - w * 0.054, rad * 0.6);
  g.stroke();
  g.restore();

  for (const flip of [false, true]) {
    g.save();
    if (flip) {
      g.translate(w, h);
      g.rotate(Math.PI);
    }
    paintCourtHalf(g, w, h, rankChar, suit, pal);
    g.restore();
  }

  // centre divider with a gold lozenge
  g.save();
  g.strokeStyle = 'rgba(192,141,33,0.62)';
  g.lineWidth = Math.max(1, w * 0.005);
  for (const dy of [-h * 0.008, h * 0.008]) {
    g.beginPath();
    g.moveTo(px + w * 0.036, h * 0.5 + dy);
    g.lineTo(px + pw - w * 0.036, h * 0.5 + dy);
    g.stroke();
  }
  const lz = g.createLinearGradient(w * 0.5 - w * 0.04, 0, w * 0.5 + w * 0.04, 0);
  lz.addColorStop(0, GOLD_500);
  lz.addColorStop(0.45, GOLD_100);
  lz.addColorStop(1, GOLD_400);
  g.fillStyle = lz;
  g.beginPath();
  g.moveTo(w * 0.5, h * 0.5 - h * 0.027);
  g.lineTo(w * 0.5 + w * 0.038, h * 0.5);
  g.lineTo(w * 0.5, h * 0.5 + h * 0.027);
  g.lineTo(w * 0.5 - w * 0.038, h * 0.5);
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(99,70,10,0.5)';
  g.lineWidth = Math.max(0.7, w * 0.0028);
  g.stroke();
  g.restore();
}

function paintNumberFace(g: Ctx, w: number, h: number, rank: number, suit: Suit, pal: SuitPalette): void {
  const spots = PIP_LAYOUT[rank];
  if (!spots) return;
  const colDx = w * 0.207;
  const pipH = h * 0.152;
  for (const [col, ry, flip] of spots) {
    drawPip(g, suit, w * 0.5 + col * colDx, h * 0.5 + ry * h, pipH, flip, pal);
  }
}

function paintFace(g: Ctx, w: number, h: number, card: CardId): void {
  const rank = (card >> 2) + 2;
  const suit = (card & 3) as Suit;
  const pal = SUIT_PALETTE[suit];
  const radius = w * 0.058;

  paintPaper(g, w, h, radius);

  g.save();
  roundRect(g, 0, 0, w, h, radius);
  g.clip();
  if (rank === 14) paintAce(g, w, h, suit, pal);
  else if (rank >= 11) paintCourt(g, w, h, RANK_CHARS[rank - 2], suit, pal);
  else paintNumberFace(g, w, h, rank, suit, pal);
  paintIndex(g, w, h, rank, suit, pal);
  g.restore();
}

// ─────────────────────────── card backs ───────────────────────────

function paintBack(g: Ctx, w: number, h: number, def: CardBackDef): void {
  const radius = w * 0.058;
  g.save();
  roundRect(g, 0, 0, w, h, radius);
  g.clip();

  // field
  const bg = g.createRadialGradient(w * 0.5, h * 0.42, w * 0.05, w * 0.5, h * 0.55, h * 0.68);
  bg.addColorStop(0, def.field[0]);
  bg.addColorStop(1, def.field[1]);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  // Engine-turned plate. A dense diagonal moiré under two clean rosettes:
  // the lattice gives the field an even weave at any zoom, the rosettes give
  // it a focal figure. Both are needed — rosettes alone read as scribble.
  g.save();
  g.strokeStyle = def.pattern;
  g.lineWidth = Math.max(0.8, w * 0.0042);
  g.globalAlpha = 0.5;
  const step = w * 0.052;
  for (let i = -h; i < w + h; i += step) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + h, h);
    g.stroke();
    g.beginPath();
    g.moveTo(i, h);
    g.lineTo(i + h, 0);
    g.stroke();
  }
  g.restore();

  guilloche(g, w * 0.5, h * 0.5, w * 0.66, def.pattern, def.petals, 4, Math.max(1.1, w * 0.0058));
  guilloche(g, w * 0.5, h * 0.5, w * 0.42, def.pattern, def.petals - 4, 3, Math.max(1, w * 0.005));

  // vignette pulls the eye to the medallion without eating the pattern
  const vg = g.createRadialGradient(w * 0.5, h * 0.5, w * 0.2, w * 0.5, h * 0.5, h * 0.7);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(0.72, 'rgba(0,0,0,0.14)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);

  // double rim
  const rimGrad = linGrad(g, 0, 0, w, h, [
    [0, def.rim[0]],
    [0.35, def.rim[1]],
    [0.62, def.rim[2]],
    [1, def.rim[1]],
  ]);
  g.strokeStyle = rimGrad;
  g.lineWidth = Math.max(1.6, w * 0.011);
  roundRect(g, w * 0.045, w * 0.045, w - w * 0.09, h - w * 0.09, radius * 0.82);
  g.stroke();
  g.lineWidth = Math.max(0.8, w * 0.004);
  roundRect(g, w * 0.078, w * 0.078, w - w * 0.156, h - w * 0.156, radius * 0.66);
  g.stroke();

  // Medallion. At phone scale a card back is about 34 px wide, so this is
  // the ONLY element that has to survive: a solid dark disc, a bright metal
  // ring and a monogram with maximum contrast against both.
  const cx = w * 0.5;
  const cy = h * 0.5;
  const r = w * 0.235;
  const disc = g.createRadialGradient(cx - r * 0.3, cy - r * 0.42, r * 0.08, cx, cy, r);
  disc.addColorStop(0, 'rgba(255,255,255,0.1)');
  disc.addColorStop(0.5, 'rgba(2,4,9,0.72)');
  disc.addColorStop(1, 'rgba(2,4,9,0.92)');
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = disc;
  g.fill();
  g.strokeStyle = rimGrad;
  g.lineWidth = Math.max(2, w * 0.014);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, r * 1.2, 0, Math.PI * 2);
  g.lineWidth = Math.max(0.9, w * 0.004);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
  g.lineWidth = Math.max(0.8, w * 0.0035);
  g.stroke();

  // monogram
  g.fillStyle = linGrad(g, 0, cy - r * 0.6, 0, cy + r * 0.6, [
    [0, def.rim[0]],
    [0.42, def.medallion],
    [1, def.rim[1]],
  ]);
  inkText(g, 'R', cx, cy - h * 0.004, r * 1.06, { maxW: r * 1.34, weight: 700 });

  // corner fleurons
  g.strokeStyle = rimGrad;
  g.lineWidth = Math.max(0.8, w * 0.004);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const ox = cx + sx * (w * 0.5 - w * 0.135);
      const oy = cy + sy * (h * 0.5 - w * 0.135);
      g.beginPath();
      g.arc(ox, oy, w * 0.048, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(ox - sx * w * 0.048, oy);
      g.lineTo(ox - sx * w * 0.12, oy);
      g.moveTo(ox, oy - sy * w * 0.048);
      g.lineTo(ox, oy - sy * w * 0.12);
      g.stroke();
    }
  }
  g.restore();
}

// ─────────────────────────── the atlas ───────────────────────────

export interface AtlasUV {
  offset: THREE.Vector2;
  repeat: THREE.Vector2;
}

export interface CardFaceAtlas {
  /** the 13×4 face atlas; clone it per card and apply a UV rect */
  texture: THREE.Texture;
  /** resolves once every suit row has been painted */
  ready: Promise<void>;
  /** UV rect for a card id, cached and safe to hold */
  getCardUV(card: CardId): AtlasUV;
  /** a standalone back texture; built lazily and cached */
  back(id: CardBackId): THREE.Texture;
  /** forces any outstanding chunks to paint right now */
  ensureBuilt(): void;
  readonly built: boolean;
  dispose(): void;
}

class Atlas implements CardFaceAtlas {
  readonly texture: THREE.CanvasTexture;
  readonly ready: Promise<void>;

  private canvas: HTMLCanvasElement;
  private g: Ctx;
  private cellW: number;
  private cellH: number;
  private uv: Array<AtlasUV | null> = new Array(52).fill(null);
  private backs = new Map<CardBackId, THREE.CanvasTexture>();
  private pending: number[] = [0, 1, 2, 3];
  private timer = 0;
  private resolve!: () => void;
  private backScale: number;

  constructor(scale: number, aniso: number) {
    this.cellW = Math.round(BASE_CELL_W * scale);
    this.cellH = Math.round(BASE_CELL_H * scale);
    this.backScale = scale;
    this.canvas = makeCanvas(this.cellW * COLS, this.cellH * ROWS);
    this.g = ctx2d(this.canvas);
    this.g.fillStyle = PAPER_TOP;
    this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = aniso;
    this.texture.needsUpdate = true;

    this.ready = new Promise<void>((res) => {
      this.resolve = res;
    });
    this.schedule();
  }

  get built(): boolean {
    return this.pending.length === 0;
  }

  private schedule(): void {
    if (this.pending.length === 0) return;
    this.timer = (setTimeout(() => {
      this.timer = 0;
      this.paintRow();
      this.schedule();
    }, 0) as unknown) as number;
  }

  private paintRow(): void {
    const row = this.pending.shift();
    if (row === undefined) return;
    const g = this.g;
    for (let col = 0; col < COLS; col++) {
      const card = col * 4 + row;
      g.save();
      g.translate(col * this.cellW, row * this.cellH);
      g.beginPath();
      g.rect(0, 0, this.cellW, this.cellH);
      g.clip();
      paintFace(g, this.cellW, this.cellH, card);
      g.restore();
    }
    this.texture.needsUpdate = true;
    if (this.pending.length === 0) this.resolve();
  }

  ensureBuilt(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    while (this.pending.length) this.paintRow();
  }

  getCardUV(card: CardId): AtlasUV {
    const id = Math.max(0, Math.min(51, card | 0));
    const hit = this.uv[id];
    if (hit) return hit;
    const col = id >> 2;
    const row = id & 3;
    // half-texel inset: stops the mip chain from bleeding a neighbouring
    // rank into the die-cut corners when a card is small on screen
    const iu = 0.5 / this.canvas.width;
    const iv = 0.5 / this.canvas.height;
    const made: AtlasUV = {
      offset: new THREE.Vector2(col / COLS + iu, 1 - (row + 1) / ROWS + iv),
      repeat: new THREE.Vector2(1 / COLS - iu * 2, 1 / ROWS - iv * 2),
    };
    this.uv[id] = made;
    return made;
  }

  back(id: CardBackId): THREE.Texture {
    const hit = this.backs.get(id);
    if (hit) return hit;
    const def = CARD_BACKS.find((b) => b.id === id) ?? CARD_BACKS[0];
    const w = Math.round(BASE_CELL_W * this.backScale);
    const h = Math.round(BASE_CELL_H * this.backScale);
    const c = makeCanvas(w, h);
    const g = ctx2d(c);
    paintBack(g, w, h, def);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = this.texture.anisotropy;
    t.needsUpdate = true;
    this.backs.set(id, t);
    return t;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.pending.length = 0;
    this.texture.dispose();
    for (const t of this.backs.values()) t.dispose();
    this.backs.clear();
  }
}

let singleton: Atlas | null = null;

export interface CardFaceOptions {
  /** 1 = full retina atlas (~3016×1296), 0.5 = low tier */
  scale?: number;
  anisotropy?: number;
}

export function initCardFaces(opts: CardFaceOptions = {}): CardFaceAtlas {
  singleton?.dispose();
  singleton = new Atlas(
    THREE.MathUtils.clamp(opts.scale ?? 1, 0.35, 1.25),
    Math.max(1, Math.round(opts.anisotropy ?? 4)),
  );
  return singleton;
}

/** Shared atlas. Builds a default one on first touch. */
export function cardFaces(): CardFaceAtlas {
  if (!singleton) singleton = new Atlas(1, 4);
  return singleton;
}

export function disposeCardFaces(): void {
  singleton?.dispose();
  singleton = null;
}

/** UV rect for a card in the shared atlas. */
export function getCardUV(card: CardId): AtlasUV {
  return cardFaces().getCardUV(card);
}

/** Suit accent colours, re-exported so chips/avatars stay on-palette. */
export function suitColor(suit: Suit): string {
  return SUIT_PALETTE[suit].main;
}
