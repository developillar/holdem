/**
 * ROYALE — fx/index.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The FX layer's front door. `initFx(root)` mounts the runtime into `#fx-root`
 * and subscribes it to the bus; after that no other module ever imports an
 * effect directly unless it wants fine control — emitting `fx:burst`,
 * `fx:flash`, `econ:purchase`, `econ:pass-xp`, `hand:award`, `gto:verdict` or
 * `ui:toast` is enough to get the right celebration.
 *
 * Screen anchors: the FX layer has no knowledge of the 3D scene, so it
 * resolves seat/pot positions in this order —
 *   1. a resolver installed by the table screen via `setAnchorResolver`
 *   2. a DOM element carrying `[data-fx-anchor]` or `[data-seat]`
 *   3. a portrait-tuned geometric fallback, so an effect never fires into the
 *      void even before the table has mounted.
 */
import '../ui/styles/fx.css';

import { bus, type FxBurstKind } from '../core/bus.ts';
import { money } from '../core/stakes.ts';
import type { CosmeticKind, Rarity } from '../core/types.ts';

import {
  engine,
  reduceMotion,
  token,
  pointOf,
  queryAny,
  clamp,
  type FxPoint,
  type PerfTier,
} from './engine.ts';
import { confettiBurst, confettiCannons, confettiCelebrate, confettiPop, confettiRain } from './confetti.ts';
import { coinBurst, coinsFromWallet, coinsToWallet, chipShower, pulse } from './coinburst.ts';
import { autoShine, shine, shineOnce, unshine } from './shine.ts';
import { dramaticDim, flash, glowSwell, impact, releaseDim, shake, shockwave, stopShake, sweepLight, vignetteHold, vignettePulse } from './screen.ts';
import { callout, clearText, floatText, floatValue, floatXp, headline, streakCounter } from './text.ts';
import { clearBanners, levelUpBanner, passTierBanner, unlockBanner } from './toastfx.ts';

// ─────────────────────────── anchors ───────────────────────────

export type AnchorResolver = (seat: number) => FxPoint | null;

let anchorResolver: AnchorResolver | null = null;
let heroSeat = -1;
let seatCount = 6;

/**
 * The table screen (or the renderer's projected anchors) installs this so
 * bursts land on the right seat. Pass `null` to uninstall on unmount.
 */
export function setAnchorResolver(fn: AnchorResolver | null): void {
  anchorResolver = fn;
}

/** Portrait fallback ring: hero at the bottom, others fanned across the top. */
function fallbackSeat(seat: number): FxPoint {
  const { w, h } = engine.viewport();
  const n = Math.max(2, seatCount);
  if (seat === heroSeat) return { x: w / 2, y: h * 0.72 };
  const others = n - 1;
  const rel = heroSeat >= 0 ? (seat - heroSeat + n) % n : seat + 1;
  const t = others <= 1 ? 0.5 : (rel - 1) / (others - 1);
  const angle = Math.PI * (0.82 - t * 0.64);
  return { x: w / 2 + Math.cos(angle) * w * 0.4, y: h * 0.4 - Math.sin(angle) * h * 0.1 };
}

export function seatPoint(seat: number | undefined): FxPoint {
  if (seat === undefined || seat < 0) return potPoint();
  const custom = anchorResolver?.(seat);
  if (custom) return custom;
  const el = queryAny(`[data-fx-anchor="seat-${seat}"]`, `.np[data-seat="${seat}"]`, `[data-seat="${seat}"]`);
  if (el) return pointOf(el);
  return fallbackSeat(seat);
}

export function potPoint(): FxPoint {
  const el = queryAny('[data-fx-anchor="pot"]', '.pot', '.pot__main');
  if (el) return pointOf(el);
  const { w, h } = engine.viewport();
  return { x: w / 2, y: h * 0.4 };
}

// ─────────────────────────── burst router ───────────────────────────

/** Volume curve: a $4 pot should not look like a $400 one, but nor should it
 *  scale linearly and fill the screen. Log-shaped, clamped both ends. */
function volumeFor(amount: number, min: number, max: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return min;
  const k = clamp(Math.log10(amount + 1) / 3, 0, 1);
  return Math.round(min + (max - min) * k);
}

function gold(): string {
  return token('--c-gold-300', '#edc96b');
}

/**
 * Every `FxBurstKind` has a hand-tuned recipe. They are written as complete
 * beats — light, motion, particles and type land on the same frames — rather
 * than as a generic "spawn some particles" switch.
 */
export function burst(kind: FxBurstKind, seat?: number, amount?: number): void {
  const at = seat === undefined ? potPoint() : seatPoint(seat);
  const isHero = seat !== undefined && seat === heroSeat;

  switch (kind) {
    case 'chips-win': {
      const n = volumeFor(amount ?? 0, 10, 26);
      coinBurst({ from: potPoint(), to: at, count: n, kind: 'chip', travelMs: 620, staggerMs: 34 });
      glowSwell(at, gold(), 820);
      if (isHero) shockwave(at, { size: 260, rings: 1, color: gold(), thickness: 1.5 });
      break;
    }
    case 'chips-push': {
      engine.emit({
        count: 22,
        origin: potPoint(),
        originSpread: 18,
        sprite: 'chip',
        speed: 260,
        speedVar: 0.7,
        gravity: 900,
        drag: 2.4,
        life: 0.9,
        lifeVar: 0.3,
        size: 15,
        sizeVar: 0.2,
        tumble: true,
        tumbleRate: 520,
        color: gold(),
        weight: 2,
      });
      break;
    }
    case 'card-flip': {
      engine.emit({
        count: 10,
        origin: at,
        originSpread: 12,
        sprite: 'spark',
        speed: 190,
        speedVar: 0.6,
        drag: 6,
        life: 0.4,
        size: 5,
        scaleTo: 0,
        color: [token('--c-gold-100', '#fdf3d0'), gold()],
        blend: 'plus',
        weight: 0.5,
      });
      break;
    }
    case 'allin': {
      const bad = token('--c-bad', '#f6534f');
      impact({ power: 0.66, color: gold(), at });
      vignettePulse({ color: bad, strength: 0.5, ms: 720 });
      headline('ALL IN', { tone: 'gold', kicker: isHero ? 'YOU ARE' : undefined, holdMs: 900, stepMs: 44 });
      engine.emit({
        count: 30,
        origin: at,
        originSpread: 16,
        sprite: 'streak',
        angle: -Math.PI / 2,
        spread: Math.PI,
        speed: 520,
        speedVar: 0.6,
        drag: 3.4,
        life: 0.72,
        lifeVar: 0.3,
        scaleTo: 0.2,
        color: [gold(), token('--c-gold-100', '#fdf3d0')],
        blend: 'plus',
        weight: 2,
      });
      break;
    }
    case 'bomb': {
      impact({ power: 1, color: token('--c-warn', '#fbbf24'), at: potPoint() });
      headline('BOMB POT', { tone: 'gold', sub: 'EVERYBODY IN', holdMs: 1100 });
      confettiBurst({ origin: potPoint(), count: 70, variant: 'gold', power: 1.15 });
      break;
    }
    case 'royal': {
      flash({ color: token('--c-gold-100', '#fdf3d0'), ms: 420, peak: 0.6, blend: 'plus' });
      shake(9, 380);
      headline('ROYAL FLUSH', { tone: 'gold', sub: 'ONE IN 649,740', holdMs: 2000, stepMs: 40 });
      confettiCelebrate('legendary', at);
      shockwave(at, { size: 640, rings: 3, color: gold() });
      break;
    }
    case 'quads': {
      flash({ color: gold(), ms: 300, peak: 0.36, blend: 'plus' });
      shake(6, 300);
      headline('QUADS', { tone: 'gold', holdMs: 1400 });
      confettiBurst({ origin: at, count: 90, variant: 'gold', power: 1.05 });
      break;
    }
    case 'confetti': {
      confettiBurst({ origin: at, count: 110, variant: 'party' });
      break;
    }
    case 'level-up': {
      confettiCannons({ variant: 'gold', count: 110 });
      flash({ color: gold(), ms: 340, peak: 0.26, blend: 'plus' });
      break;
    }
    case 'unlock': {
      confettiPop(at, 'legendary');
      shockwave(at, { size: 220, rings: 1, color: gold(), thickness: 1.5 });
      break;
    }
  }
}

// ─────────────────────────── bus wiring ───────────────────────────

function toRarity(v: unknown): Rarity {
  const s = String(v);
  return s === 'common' || s === 'rare' || s === 'epic' || s === 'legendary' || s === 'mythic' ? s : 'rare';
}

function wire(): Array<() => void> {
  const off: Array<() => void> = [];

  off.push(bus.on('perf:tier', ({ tier }) => engine.setTier(tier as PerfTier)));

  off.push(
    bus.on('table:state', ({ state, you }) => {
      heroSeat = you;
      if (state?.seats?.length) seatCount = state.seats.length;
    }),
  );

  off.push(bus.on('fx:burst', ({ kind, seat }) => burst(kind, seat)));

  off.push(bus.on('fx:flash', ({ color, ms }) => flash({ color, ms })));

  // ── the money shot: a pot arriving.
  off.push(
    bus.on('hand:award', ({ seat, amount, potIndex }) => {
      const target = seatPoint(seat);
      const hero = seat === heroSeat;
      // Side pots land in sequence, so stagger them off their index.
      const delay = potIndex > 0 ? potIndex * 260 : 0;
      engine.after(delay, () => {
        coinBurst({
          from: potPoint(),
          to: target,
          count: volumeFor(amount, hero ? 12 : 8, hero ? 28 : 16),
          kind: 'chip',
          travelMs: hero ? 660 : 520,
          staggerMs: 32,
          haptics: hero,
        });
        glowSwell(target, gold(), hero ? 900 : 640);
        if (hero) {
          floatValue(amount, { at: { x: target.x, y: target.y - 34 }, tone: 'good', size: 'lg' });
          bus.emit('ui:haptic', { pattern: amount > 0 ? 'win' : 'tick' });
        }
      });
    }),
  );

  // ── store / cosmetics
  off.push(
    bus.on('econ:purchase', ({ item }) => {
      const rarity = toRarity(item?.rarity);
      const centre: FxPoint = { x: engine.viewport().w / 2, y: engine.viewport().h * 0.42 };
      if (item?.priceGems) coinsFromWallet(centre, 'gems', 10);
      unlockBanner({
        title: item?.name ?? 'New item',
        subtitle: item?.description,
        rarity,
        kind: item?.kind as CosmeticKind | undefined,
        eyebrow: 'PURCHASED',
      });
      if (rarity === 'legendary' || rarity === 'mythic') {
        confettiRain({ variant: rarity === 'mythic' ? 'mythic' : 'legendary', ms: 1800, rate: 16 });
      }
    }),
  );

  off.push(
    bus.on('econ:equip', ({ item }) => {
      const el = queryAny(`[data-item-id="${item?.id}"]`, '[data-fx-anchor="equip"]');
      if (el) {
        shineOnce(el, { width: 0.3, strength: 0.85 });
        pulse(el, 'pop');
      }
    }),
  );

  off.push(
    bus.on('econ:wallet', () => {
      // The counters own their own roll; we only add the tactile notch.
      pulse(queryAny('[data-fx-target="chips"]', '.wal--chips'), 'gain');
    }),
  );

  // ── battle pass
  off.push(
    bus.on('econ:pass-xp', ({ amount, tier, leveled }) => {
      if (leveled) {
        passTierBanner({ tier, rewardLabel: `Tier ${tier} reward unlocked` });
        confettiCannons({ variant: 'gold', count: 96 });
        flash({ color: gold(), ms: 320, peak: 0.24, blend: 'plus' });
        bus.emit('ui:haptic', { pattern: 'big-win' });
      } else if (amount > 0) {
        const host = queryAny('[data-fx-anchor="pass"]', '[data-fx-target="pass"]', '.topbar__pass');
        const at = host ? pointOf(host) : { x: engine.viewport().w / 2, y: engine.viewport().h * 0.2 };
        floatXp(amount, { at });
      }
    }),
  );

  // ── trainer
  off.push(
    bus.on('gto:verdict', ({ verdict }) => {
      const { w, h } = engine.viewport();
      const at: FxPoint = { x: w / 2, y: h * 0.36 };
      if (verdict.score >= 0.98) {
        floatText('PERFECT', { at, tone: 'good', size: 'lg' });
        engine.emit({
          count: 18,
          origin: at,
          sprite: 'star',
          speed: 300,
          speedVar: 0.6,
          gravity: 620,
          drag: 3,
          life: 0.9,
          size: 12,
          sizeVar: 0.4,
          scaleTo: 0.2,
          spin: 200,
          color: token('--c-good', '#34d399'),
          blend: 'plus',
        });
        bus.emit('ui:haptic', { pattern: 'select' });
      } else if (verdict.score >= 0.7) {
        floatText(`${Math.round(verdict.score * 100)}%`, { at, tone: 'good' });
      } else {
        vignettePulse({ strength: 0.55, ms: 560 });
        shake(4, 180);
        floatText(`−${verdict.evLossBb.toFixed(2)} bb`, { at, tone: 'bad' });
        bus.emit('ui:haptic', { pattern: 'error' });
      }
    }),
  );

  off.push(
    bus.on('gto:drill-complete', ({ score, hands }) => {
      if (score >= 0.9) {
        headline('FLAWLESS', { tone: 'good', sub: `${hands} HANDS`, holdMs: 1400 });
        confettiBurst({ variant: 'emerald', count: 80 });
      }
    }),
  );

  // ── an epic toast gets sparkle; other tones are the UI layer's business.
  off.push(
    bus.on('ui:toast', ({ tone }) => {
      if (tone !== 'epic') return;
      const { w } = engine.viewport();
      engine.emit({
        count: 14,
        origin: { x: w / 2, y: 96 },
        originSpread: 70,
        sprite: 'star',
        speed: 90,
        speedVar: 0.8,
        gravity: -60,
        drag: 2.4,
        life: 0.9,
        lifeVar: 0.4,
        size: 11,
        sizeVar: 0.5,
        scaleTo: 0.15,
        spin: 180,
        color: [token('--c-gold-100', '#fdf3d0'), gold()],
        blend: 'plus',
        weight: 0.6,
      });
    }),
  );

  // ── a route change ends any celebration that is still on screen; nothing is
  //    more broken-feeling than confetti from the last screen raining on this
  //    one. Held state (dim, shake) is released too.
  off.push(
    bus.on('nav:route', () => {
      releaseDim();
      stopShake();
      clearText();
      clearBanners();
      vignetteHold(false);
    }),
  );

  return off;
}

// ─────────────────────────── mount ───────────────────────────

let mounted = false;
let teardown: Array<() => void> = [];

/**
 * Mount the FX layer into `#fx-root`. Idempotent. Returns a disposer that
 * unsubscribes everything and empties the layer — call it only on a real
 * teardown; the app keeps this alive for its whole lifetime.
 */
export function initFx(root: HTMLElement): () => void {
  if (mounted) return disposeFx;
  mounted = true;
  engine.init(root);
  teardown = wire();
  // Declarative sweeps: any element with `data-shine` anywhere in the app.
  teardown.push(autoShine(document));
  return disposeFx;
}

export function disposeFx(): void {
  if (!mounted) return;
  mounted = false;
  for (const off of teardown) {
    try {
      off();
    } catch (err) {
      console.error('[fx] teardown failed', err);
    }
  }
  teardown = [];
  clearBanners();
  clearText();
  releaseDim();
  stopShake();
  engine.destroy();
}

// ─────────────────────────── public surface ───────────────────────────

export {
  engine,
  reduceMotion,
  token as fxToken,
  pointOf,
  clamp,
  confettiBurst,
  confettiCannons,
  confettiCelebrate,
  confettiPop,
  confettiRain,
  coinBurst,
  coinsToWallet,
  coinsFromWallet,
  chipShower,
  pulse,
  shine,
  shineOnce,
  unshine,
  autoShine,
  flash,
  vignettePulse,
  vignetteHold,
  shake,
  stopShake,
  shockwave,
  impact,
  glowSwell,
  sweepLight,
  dramaticDim,
  releaseDim,
  floatText,
  floatValue,
  floatXp,
  streakCounter,
  headline,
  callout,
  clearText,
  unlockBanner,
  levelUpBanner,
  passTierBanner,
  clearBanners,
  money as fxMoney,
};

export * from './transitions.ts';
export type { FxPoint, PerfTier, Particle, EmitSpec, FxSprite, FxBlend, FxStats } from './engine.ts';
export type { ConfettiOpts, ConfettiVariant } from './confetti.ts';
export type { CoinBurstOpts, CoinKind } from './coinburst.ts';
export type { ShineOpts, ShineHandle } from './shine.ts';
export type { FlashOpts, VignetteOpts, ShockwaveOpts, DimOpts, ImpactOpts } from './screen.ts';
export type { FloatTextOpts, HeadlineOpts, StreakOpts, TextTone } from './text.ts';
export type { BannerOpts, UnlockBannerOpts, LevelUpOpts, PassTierOpts } from './toastfx.ts';
