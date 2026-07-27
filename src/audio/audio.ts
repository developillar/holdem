/**
 * ROYALE — audio entry point.
 * ─────────────────────────────────────────────────────────────────────
 * Builds the graph, subscribes to the bus, and turns game events into
 * sound. Nothing else in the app imports `sfx`/`music`/`mixer` directly;
 * they emit on the bus and this file decides what that should sound like.
 *
 * `initAudio()` is called during boot, before any user gesture. It never
 * throws and never makes noise: the context comes up suspended, every
 * buffer and impulse response is pre-rendered while the loading bar is
 * still on screen, and the first touch anywhere in the app resumes it.
 */
import { bus } from '../core/bus.ts';
import type { RouteName } from '../core/bus.ts';
import type { TableState } from '../core/types.ts';
import { mixer, type BusName } from './mixer.ts';
import { music, type MusicBed } from './music.ts';
import { haptics } from './haptics.ts';
import * as cues from './sfx.ts';
import { sfx } from './sfx.ts';
import { clamp } from './synth.ts';

export type { BusName } from './mixer.ts';
export type { MusicBed } from './music.ts';
export { sfx } from './sfx.ts';

// ───────────────────────── local game mirror ─────────────────────────

let state: TableState | null = null;
let youSeat = -1;
let bb = 1;
let inited = false;

function seatCount(): number {
  return state?.seats.length ?? 6;
}

function potTotal(): number {
  if (!state) return 0;
  let sum = 0;
  for (const p of state.pots) sum += p.amount;
  for (const s of state.seats) sum += s.committed;
  return sum;
}

/**
 * Stereo placement for a seat, hero-relative. Hero sits dead centre and
 * the table wraps around them, so a raise from the cutoff arrives from
 * the correct side even though the mix is otherwise very narrow.
 */
function panForSeat(seat: number): number {
  if (seat < 0) return 0;
  const n = Math.max(2, seatCount());
  const hero = youSeat >= 0 ? youSeat : 0;
  const rel = ((seat - hero) % n + n) % n;
  return Math.sin((rel / n) * Math.PI * 2) * 0.5;
}

/** Pot-relative bet size, 0..1, where ~1 is a pot-sized commitment. */
function sizeOf(amount: number): number {
  const pot = Math.max(bb, potTotal());
  return clamp(amount / (pot * 1.2), 0, 1);
}

/** How loud the room should feel right now, from money on the table. */
function potIntensity(): number {
  const potBb = potTotal() / Math.max(0.0001, bb);
  return clamp(potBb / 90, 0, 1);
}

// ───────────────────────── deal spacing ─────────────────────────

let lastDealAt = 0;

/**
 * Deals are spaced to at least 72 ms apart regardless of whether the
 * engine emits them staggered or in one burst — a pitch-perfect rhythm
 * of card throws either way, and never a single mushy chord of nine.
 */
function queueDeal(pan: number, speed: number): void {
  const now = performance.now();
  const at = Math.max(now, lastDealAt + 72);
  if (at - now > 900) return;
  lastDealAt = at;
  const delay = at - now;
  if (delay < 4) cues.dealCard(pan, speed);
  else window.setTimeout(() => cues.dealCard(pan, speed), delay);
}

// ───────────────────────── the action clock ─────────────────────────

let clockTimer: number | null = null;
let clockEndsAt = 0;
let clockTotal = 0;

function stopClock(): void {
  if (clockTimer !== null) {
    window.clearTimeout(clockTimer);
    clockTimer = null;
  }
}

function startClock(totalMs: number): void {
  stopClock();
  clockTotal = Math.max(2000, totalMs);
  clockEndsAt = performance.now() + clockTotal;
  clockStep();
}

function clockStep(): void {
  const remain = clockEndsAt - performance.now();
  if (remain <= 0) {
    clockTimer = null;
    cues.timeoutBuzz();
    haptics.play('error');
    return;
  }
  // Silence for the comfortable part of the clock; the tick only appears
  // once the decision is genuinely running out.
  const audibleFrom = Math.min(clockTotal, 9500);
  if (remain > audibleFrom) {
    clockTimer = window.setTimeout(clockStep, remain - audibleFrom);
    return;
  }
  const urgency = clamp(1 - remain / audibleFrom, 0, 1);
  cues.timerTick(urgency);
  if (urgency > 0.55) haptics.play('tick');
  const gap = remain > 5000 ? 1000 : remain > 2600 ? 620 : remain > 1200 ? 400 : 280;
  clockTimer = window.setTimeout(clockStep, Math.max(110, Math.min(gap, remain)));
}

// ───────────────────────── route → bed ─────────────────────────

function bedForRoute(route: RouteName): MusicBed {
  switch (route) {
    case 'table':
      return 'table';
    case 'trainer':
      return 'trainer';
    case 'store':
    case 'pass':
      return 'store';
    case 'boot':
      return 'none';
    default:
      return 'lobby';
  }
}

// ───────────────────────── bus wiring ─────────────────────────

function wire(): void {
  // ── table mirror
  bus.on('table:state', ({ state: s, you }) => {
    state = s;
    youSeat = you;
    bb = s.tournament ? s.tournament.bb : s.stake.bb;
    if (s.actingSeat !== you) stopClock();
    music.setIntensity(Math.max(music.getIntensity() * 0.9, potIntensity()));
  });

  // ── dealing: quiet, close, and the score gets out of the way
  bus.on('hand:start', () => {
    stopClock();
    music.resetIntensity(0.05);
    music.duckForDeal(1100);
    cues.riffleShuffle(0.7);
  });

  bus.on('hand:deal-hole', ({ seat, cards, order }) => {
    music.duckForDeal(600);
    const pan = panForSeat(seat);
    const speed = 1 + ((order % 3) - 1) * 0.05;
    for (let i = 0; i < Math.max(1, cards.length); i++) queueDeal(pan, speed);
    if (seat === youSeat) haptics.play('deal');
  });

  bus.on('hand:deal-board', ({ cards, street }) => {
    music.duckForDeal(street === 'flop' ? 900 : 650);
    cues.cardSlide(-0.1);
    cards.forEach((_, i) => {
      window.setTimeout(() => cues.cardFlip(-0.18 + i * 0.09), 90 + i * 135);
    });
    haptics.play('deal');
  });

  bus.on('hand:muck', ({ seat }) => cues.cardSlide(panForSeat(seat)));

  // ── actions
  bus.on('hand:action', ({ action, state: s }) => {
    state = s;
    bb = s.tournament ? s.tournament.bb : s.stake.bb;
    // the clock only ever runs for the hero, so only the hero stops it
    if (action.seat === youSeat) stopClock();

    const pan = panForSeat(action.seat);
    const mine = action.seat === youSeat;
    const size = sizeOf(action.amount);

    switch (action.kind) {
      case 'fold':
        cues.fold();
        if (mine) haptics.play('fold');
        break;
      case 'check':
        cues.check();
        if (mine) haptics.play('select');
        break;
      case 'call':
        cues.chipStack(3 + Math.round(size * 4), pan);
        if (mine) haptics.play('bet');
        break;
      case 'bet':
      case 'raise':
        cues.betConfirm(size);
        if (mine) haptics.play('bet');
        music.setIntensity(Math.max(potIntensity(), 0.35 + size * 0.5));
        break;
      case 'allin':
        cues.allIn();
        if (mine) haptics.play('big-win');
        music.setIntensity(1);
        break;
      case 'post':
        cues.chipClick(pan, 0.75);
        break;
      case 'ante':
        cues.chipClick(pan, 0.55);
        break;
      default:
        break;
    }
  });

  bus.on('hand:turn', ({ seat, timeMs, legal }) => {
    if (seat !== youSeat) {
      stopClock();
      return;
    }
    cues.yourTurn();
    haptics.play('select');
    startClock(timeMs);

    // facing a big decision → the score leans in
    const call = legal.find((l) => l.kind === 'call');
    const stack = state?.seats[youSeat]?.stack ?? 0;
    const pressure = call && stack > 0 ? clamp(call.max / stack, 0, 1) : 0;
    music.setIntensity(Math.max(potIntensity(), 0.3 + pressure * 0.7));
  });

  bus.on('hand:pot-update', ({ total }) => {
    const potBb = total / Math.max(0.0001, bb);
    music.setIntensity(Math.max(music.getIntensity() * 0.85, clamp(potBb / 90, 0, 1)));
  });

  bus.on('hand:collect', ({ total }) => {
    const potBb = total / Math.max(0.0001, bb);
    cues.chipsToPot(clamp(potBb / 45, 0.15, 1));
  });

  // ── showdown & payout
  bus.on('hand:showdown', ({ results }) => {
    results.forEach((r, i) => {
      if (r.mucked) return;
      window.setTimeout(() => cues.cardFlip(panForSeat(r.seat)), i * 160);
    });
  });

  bus.on('hand:award', ({ seat, amount }) => {
    const bbWon = amount / Math.max(0.0001, bb);
    if (seat === youSeat) {
      if (bbWon >= 55) {
        cues.winBig(clamp(bbWon / 140, 0.7, 1.5));
        haptics.play('big-win');
        music.triumph();
      } else {
        cues.winSmall();
        haptics.play('win');
      }
      cues.potPush(clamp(bbWon / 120, 0.3, 1));
    } else {
      const hero = youSeat >= 0 ? state?.seats[youSeat] : null;
      const heroCommitted = (hero?.totalCommitted ?? 0) / Math.max(0.0001, bb);
      // hero shipped a big stack and lost it — that is a bad beat by any
      // definition the player cares about
      if (heroCommitted >= 35 && bbWon >= 55) {
        playBadBeat();
      } else {
        cues.chipsToPot(clamp(bbWon / 90, 0.15, 0.8), panForSeat(seat));
      }
    }
  });

  bus.on('hand:end', () => {
    stopClock();
    music.setIntensity(0.08);
  });

  // ── presentation
  bus.on('fx:burst', ({ kind, seat }) => {
    cues.impact(kind, 1);
    if (kind === 'allin' || kind === 'bomb' || kind === 'royal') haptics.play('big-win');
    else if (kind === 'chips-win' && seat === youSeat) haptics.play('win');
  });

  bus.on('cam:shake', ({ amount, ms }) => cues.rumble(amount, ms));

  // ── social
  bus.on('social:reaction', ({ kind, fromSeat }) => cues.reactionPop(kind, panForSeat(fromSeat)));
  bus.on('social:chat', () => cues.tapSecondary());
  bus.on('feed:react', ({ on }) => {
    if (on) cues.reactionPop('heart', 0);
    haptics.play('select');
  });

  // ── economy
  bus.on('econ:purchase', ({ item }) => {
    cues.unlockCosmetic(item.rarity);
    haptics.play('big-win');
  });
  bus.on('econ:equip', () => {
    cues.tapToggle(true);
    haptics.play('select');
  });
  bus.on('econ:pass-xp', ({ leveled }) => {
    if (!leveled) return;
    cues.passTierUp();
    haptics.play('win');
  });

  // ── trainer
  bus.on('gto:verdict', ({ verdict }) => {
    if (verdict.score >= 0.82) {
      cues.trainerCorrect(verdict.score);
      haptics.play('select');
    } else {
      cues.trainerIncorrect();
      haptics.play('error');
    }
  });
  bus.on('gto:drill-complete', ({ score, hands }) => {
    if (score >= 0.9) cues.levelUp();
    else cues.streakMilestone(Math.max(3, Math.round(hands / 4)));
    haptics.play('win');
  });

  // ── shell
  bus.on('nav:route', ({ route }) => {
    const bed = bedForRoute(route);
    music.setBed(bed);
    cues.setAmbience(route === 'table');
    if (route !== 'table') {
      stopClock();
      music.resetIntensity(0);
    }
  });

  bus.on('ui:toast', ({ tone }) => {
    cues.toast(tone);
    if (tone === 'bad') haptics.play('error');
  });

  bus.on('ui:modal', ({ id }) => {
    if (id) cues.sheetOpen();
    else cues.sheetClose();
  });

  bus.on('ui:haptic', ({ pattern }) => haptics.play(pattern));

  bus.on('audio:duck', ({ amount, ms }) => mixer.duck(amount, ms));

  bus.on('perf:tier', ({ tier }) => mixer.setQuality(tier));
}

// ───────────────────────── public API ─────────────────────────

/**
 * Builds the audio graph and wires the bus. Idempotent, never throws,
 * and produces no sound until the first user gesture unlocks the context.
 */
export async function initAudio(): Promise<void> {
  if (inited) return;
  inited = true;
  try {
    mixer.build();
    wire();
    // If the app was reached via a gesture (most warm loads) this resolves
    // immediately; otherwise the mixer's own listeners handle the unlock.
    void mixer.unlock();
    void mixer.whenLive().then(() => {
      cues.resumeAmbience();
    });
  } catch (err) {
    console.warn('[audio] unavailable', err);
  }
  await Promise.resolve();
}

/** Resumes the context. Call from an explicit "enable sound" affordance. */
export function unlockAudio(): Promise<void> {
  return mixer.unlock();
}

/** True once audio is actually running (context resumed, not muted-by-OS). */
export function isAudioReady(): boolean {
  return mixer.live;
}

export function setVolume(busName: BusName, v: number): void {
  mixer.setVolume(busName, v);
}

export function getVolume(busName: BusName): number {
  return mixer.getVolume(busName);
}

export function getVolumes(): Record<BusName, number> {
  return mixer.getVolumes();
}

export function setMuted(m: boolean): void {
  mixer.setMuted(m);
}

export function isMuted(): boolean {
  return mixer.isMuted();
}

export function setHapticsEnabled(on: boolean): void {
  haptics.setEnabled(on);
}

export function hapticsEnabled(): boolean {
  return haptics.isEnabled();
}

export function hapticsSupported(): boolean {
  return haptics.supported;
}

/** Bus list + labels for the settings screen's sliders. */
export const AUDIO_BUSES: ReadonlyArray<{ id: BusName; label: string }> = [
  { id: 'master', label: 'Master' },
  { id: 'music', label: 'Music' },
  { id: 'sfx', label: 'Game' },
  { id: 'ui', label: 'Interface' },
  { id: 'ambience', label: 'Room tone' },
];

/** Plays a representative cue so a volume slider has something to move against. */
export function previewBus(busName: BusName): void {
  switch (busName) {
    case 'sfx':
      cues.chipStack(5, 0);
      break;
    case 'ui':
    case 'master':
      cues.tapPrimary();
      break;
    case 'ambience':
      cues.rumble(0.35, 260);
      break;
    case 'music':
      music.triumph();
      break;
    default:
      break;
  }
}

/** Explicit bad-beat sting, for callers that know the equity story. */
export function playBadBeat(): void {
  cues.badBeat();
  music.badBeat();
  haptics.play('error');
}

/** Manual override for screens that want a specific bed. */
export function setMusicBed(bed: MusicBed): void {
  music.setBed(bed);
}

/** Manual intensity override, 0..1. */
export function setMusicIntensity(v: number): void {
  music.setIntensity(v);
}

/** Cuts all sound immediately, then restores the user's levels. */
export function panicStop(): void {
  stopClock();
  mixer.panic();
}

export { sfx as cueLibrary };
export { music, haptics, mixer };
export default {
  initAudio,
  unlockAudio,
  isAudioReady,
  setVolume,
  getVolume,
  getVolumes,
  setMuted,
  isMuted,
  setHapticsEnabled,
  hapticsEnabled,
  hapticsSupported,
  previewBus,
  playBadBeat,
  setMusicBed,
  setMusicIntensity,
  panicStop,
  sfx,
};
