/**
 * ROYALE — fx/toastfx.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The celebratory end of the toast family: unlock, level-up and pass-tier
 * banners. These are deliberately NOT the same object as `ui:toast` — a toast
 * is information ("seat reserved"), a banner is a reward, and a reward gets
 * art, a rarity treatment, a specular sweep and a confetti pop.
 *
 * Banners queue rather than stack: two rewards landing in the same frame play
 * one after the other, because two celebrations on screen at once reads as a
 * bug. The queue is drained on the shared FX clock, so it pauses with the tab.
 *
 * All art is drawn here as inline SVG against the rarity ramp — no emoji, no
 * image assets, and no import from the UI icon set (this layer must not depend
 * on another subsystem).
 */
import type { CosmeticKind, Rarity } from '../core/types.ts';
import { engine, token, reduceMotion } from './engine.ts';
import { confettiPop, type ConfettiVariant } from './confetti.ts';
import { shineOnce } from './shine.ts';
import { bus } from '../core/bus.ts';

export interface BannerOpts {
  title: string;
  subtitle?: string;
  rarity?: Rarity;
  /** how long it holds on screen before leaving, ms */
  ms?: number;
  /** replaces the generated art */
  art?: Element | null;
  onTap?: () => void;
}

const RARITY_TOKEN: Record<Rarity, [string, string]> = {
  common: ['--c-rar-common', '#8891a5'],
  rare: ['--c-rar-rare', '#47a9ff'],
  epic: ['--c-rar-epic', '#a855f7'],
  legendary: ['--c-rar-legendary', '#f5a524'],
  mythic: ['--c-rar-mythic', '#ff4d8d'],
};

const RARITY_CONFETTI: Record<Rarity, ConfettiVariant> = {
  common: 'party',
  rare: 'rare',
  epic: 'epic',
  legendary: 'legendary',
  mythic: 'mythic',
};

const RARITY_LABEL: Record<Rarity, string> = {
  common: 'COMMON',
  rare: 'RARE',
  epic: 'EPIC',
  legendary: 'LEGENDARY',
  mythic: 'MYTHIC',
};

// ─────────────────────────── procedural art ───────────────────────────

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

/** Per-kind pictogram, drawn on a 40×40 grid. Stroked, never filled-flat. */
const KIND_PATHS: Record<CosmeticKind, string> = {
  avatar:
    '<circle cx="20" cy="15.5" r="6.2"/><path d="M8.5 32.5c1.4-6 6-9.2 11.5-9.2s10.1 3.2 11.5 9.2"/>',
  frame:
    '<rect x="6.5" y="6.5" width="27" height="27" rx="6"/><rect x="11.5" y="11.5" width="17" height="17" rx="3"/><path d="M6.5 14V9.5A3 3 0 0 1 9.5 6.5H14"/>',
  'table-skin':
    '<ellipse cx="20" cy="20" rx="14.5" ry="10"/><ellipse cx="20" cy="20" rx="9.5" ry="6"/><path d="M5.5 20v3.4c0 4.1 6.5 7.4 14.5 7.4s14.5-3.3 14.5-7.4V20"/>',
  'card-back':
    '<rect x="8.5" y="5.5" width="17" height="25" rx="3.2"/><rect x="14.5" y="9.5" width="17" height="25" rx="3.2"/><path d="M18.5 17.5h9M18.5 22.5h9M18.5 27.5h5"/>',
  emote: '<circle cx="20" cy="20" r="13.5"/><path d="M14 17.5h.02M26 17.5h.02M13.6 25c1.7 2.6 4 3.9 6.4 3.9s4.7-1.3 6.4-3.9"/>',
  title: '<path d="M6.5 13.5h27M6.5 20h20M6.5 26.5h13"/>',
  'chip-set':
    '<circle cx="15" cy="22" r="8.5"/><circle cx="26" cy="16" r="8.5"/><path d="M15 15.5v-2M15 30.5v-2M7.5 22h2M22 22h-2"/>',
  felt: '<path d="M5.5 27c4-7 9-10.5 14.5-10.5S30 20 34.5 27"/><path d="M5.5 32c4-7 9-10.5 14.5-10.5S30 25 34.5 32"/><path d="M20 16.5V7"/>',
};

/**
 * The reward token: a faceted gem-shell in the rarity colour with the item's
 * pictogram floating inside and a light rake across the top-left facet. Two
 * gradients and a stroke — enough depth to read as an object, cheap enough to
 * build sixty of in a session.
 */
function makeArt(kind: CosmeticKind | 'level' | 'pass', rarity: Rarity, badge?: string): SVGElement {
  const uid = `fxa${Math.random().toString(36).slice(2, 8)}`;
  const [tk, fb] = RARITY_TOKEN[rarity];
  const c = token(tk, fb);
  const gold = token('--c-gold-200', '#f6e0a0');

  const root = svgEl('svg', { viewBox: '0 0 40 40', class: 'fx-banner__artsvg', 'aria-hidden': 'true' });
  root.innerHTML =
    `<defs>` +
    `<linearGradient id="${uid}g" x1="0" y1="0" x2="0.55" y2="1">` +
    `<stop offset="0" stop-color="${c}" stop-opacity="0.92"/>` +
    `<stop offset="0.52" stop-color="${c}" stop-opacity="0.34"/>` +
    `<stop offset="1" stop-color="${c}" stop-opacity="0.1"/>` +
    `</linearGradient>` +
    `<linearGradient id="${uid}h" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>` +
    `<stop offset="0.45" stop-color="#ffffff" stop-opacity="0.06"/>` +
    `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<path d="M20 1.6 36.2 10v20L20 38.4 3.8 30V10z" fill="url(#${uid}g)" stroke="${c}" stroke-width="1.1" stroke-opacity="0.75" stroke-linejoin="round"/>` +
    `<path d="M20 1.6 36.2 10 20 18.4 3.8 10z" fill="url(#${uid}h)"/>`;

  if (kind === 'level' || kind === 'pass') {
    root.innerHTML +=
      `<text x="20" y="${kind === 'level' ? 26 : 25.5}" text-anchor="middle" ` +
      `font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-weight="700" ` +
      `font-size="${(badge ?? '').length > 2 ? 11 : 13}" fill="${gold}">${badge ?? ''}</text>`;
  } else {
    root.innerHTML +=
      `<g transform="translate(20 21) scale(0.62) translate(-20 -20)" fill="none" stroke="${gold}" ` +
      `stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.94">${KIND_PATHS[kind]}</g>`;
  }
  return root;
}

// ─────────────────────────── queue ───────────────────────────

type Job = () => void;
const queue: Job[] = [];
let busy = false;

function enqueue(job: Job): void {
  queue.push(job);
  if (!busy) drain();
}

function drain(): void {
  const next = queue.shift();
  if (!next) {
    busy = false;
    return;
  }
  busy = true;
  next();
}

// ─────────────────────────── banner ───────────────────────────

interface BuildSpec {
  variant: 'unlock' | 'level' | 'pass';
  eyebrow: string;
  title: string;
  subtitle?: string;
  rarity: Rarity;
  art: Element;
  ms: number;
  onTap?: () => void;
}

function build(spec: BuildSpec): void {
  const host = engine.layer('banner');
  const [tk, fb] = RARITY_TOKEN[spec.rarity];
  const accent = token(tk, fb);

  const el = document.createElement('div');
  el.className = `fx-banner fx-banner--${spec.variant} fx-banner--${spec.rarity}`;
  el.setAttribute('role', 'status');
  el.style.setProperty('--fx-c', accent);

  const glow = document.createElement('i');
  glow.className = 'fx-banner__glow';

  const artWrap = document.createElement('div');
  artWrap.className = 'fx-banner__art';
  artWrap.appendChild(spec.art);

  const body = document.createElement('div');
  body.className = 'fx-banner__body';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'fx-banner__eyebrow caps';
  eyebrow.textContent = spec.eyebrow;

  const title = document.createElement('div');
  title.className = 'fx-banner__title';
  title.textContent = spec.title;

  body.append(eyebrow, title);
  if (spec.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'fx-banner__sub';
    sub.textContent = spec.subtitle;
    body.appendChild(sub);
  }

  const chevron = svgEl('svg', { viewBox: '0 0 24 24', class: 'fx-banner__chev', 'aria-hidden': 'true' });
  chevron.innerHTML =
    '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';

  const rail = document.createElement('i');
  rail.className = 'fx-banner__rail';
  rail.style.setProperty('--fx-hold', `${spec.ms}ms`);

  el.append(glow, artWrap, body, chevron, rail);
  host.appendChild(el);

  let closed = false;
  let cancelHold: (() => void) | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    cancelHold?.();
    el.classList.remove('is-in');
    el.classList.add('is-out');
    engine.after(reduceMotion() ? 1 : 380, () => {
      el.remove();
      drain();
    });
  };

  el.addEventListener(
    'click',
    () => {
      bus.emit('ui:haptic', { pattern: 'select' });
      spec.onTap?.();
      close();
    },
    { once: false },
  );

  // Enter on the next frame so the entry keyframes actually run.
  engine.after(16, () => {
    el.classList.add('is-in');
    if (!reduceMotion()) {
      const r = el.getBoundingClientRect();
      confettiPop({ x: r.left + 40, y: r.top + r.height / 2 }, RARITY_CONFETTI[spec.rarity]);
      if (spec.rarity === 'legendary' || spec.rarity === 'mythic' || spec.variant !== 'unlock') {
        engine.after(240, () => shineOnce(el, { width: 0.34, angle: 14, strength: 0.55 }));
      }
    }
  });
  cancelHold = engine.after(spec.ms, close);
}

// ─────────────────────────── public API ───────────────────────────

export interface UnlockBannerOpts extends BannerOpts {
  kind?: CosmeticKind;
  /** override the eyebrow, e.g. "PURCHASED" */
  eyebrow?: string;
}

/** "UNLOCKED — Obsidian Frame". The reward banner for cosmetics and drops. */
export function unlockBanner(opts: UnlockBannerOpts): void {
  const rarity = opts.rarity ?? 'rare';
  enqueue(() =>
    build({
      variant: 'unlock',
      eyebrow: opts.eyebrow ?? `${RARITY_LABEL[rarity]} UNLOCKED`,
      title: opts.title,
      subtitle: opts.subtitle,
      rarity,
      art: opts.art ?? makeArt(opts.kind ?? 'frame', rarity),
      ms: opts.ms ?? 3400,
      onTap: opts.onTap,
    }),
  );
}

export interface LevelUpOpts extends Omit<BannerOpts, 'title'> {
  level: number;
  title?: string;
}

/** "LEVEL 24" — fires on player level, not pass tier. */
export function levelUpBanner(opts: LevelUpOpts): void {
  const rarity = opts.rarity ?? 'legendary';
  enqueue(() =>
    build({
      variant: 'level',
      eyebrow: 'LEVEL UP',
      title: opts.title ?? `Level ${opts.level}`,
      subtitle: opts.subtitle ?? 'New table stakes unlocked',
      rarity,
      art: opts.art ?? makeArt('level', rarity, String(opts.level)),
      ms: opts.ms ?? 3600,
      onTap: opts.onTap,
    }),
  );
}

export interface PassTierOpts extends Omit<BannerOpts, 'title'> {
  tier: number;
  rewardLabel?: string;
  premium?: boolean;
  title?: string;
}

/** "ROYALE PASS — TIER 12" with the reward that just landed. */
export function passTierBanner(opts: PassTierOpts): void {
  const rarity = opts.rarity ?? (opts.premium ? 'legendary' : 'epic');
  enqueue(() =>
    build({
      variant: 'pass',
      eyebrow: opts.premium ? 'ROYALE PASS · PREMIUM' : 'ROYALE PASS',
      title: opts.title ?? `Tier ${opts.tier}`,
      subtitle: opts.rewardLabel ?? 'Reward unlocked',
      rarity,
      art: opts.art ?? makeArt('pass', rarity, String(opts.tier)),
      ms: opts.ms ?? 3600,
      onTap: opts.onTap,
    }),
  );
}

/** Drop every queued and visible banner. Called on route changes and teardown. */
export function clearBanners(): void {
  queue.length = 0;
  const layer = engine.layer('banner');
  layer.querySelectorAll('.fx-banner').forEach((n) => n.remove());
  busy = false;
}
