/**
 * ROYALE — lobby/prefs.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The app's single preference store. Owned by the settings screen but readable
 * by anything: audio reads the mixer levels, the renderer reads the quality
 * tier, the table reads the gameplay switches.
 *
 *   import { prefs, onPrefs, setPref } from '../lobby/prefs.ts';
 *   prefs().sfxVolume            // 0..1
 *   setPref('fourColor', true)   // persists + notifies
 *   const off = onPrefs((p) => applyMixer(p));
 *
 * Changes are broadcast three ways so no subsystem has to import this file:
 *   • `window` CustomEvent `royale:prefs`  → detail is the full frozen Prefs
 *   • bus `perf:tier`                      → when the graphics tier changes
 *   • bus `ui:haptic`                      → a confirming tick when haptics
 *                                            are switched back on
 *
 * Everything is persisted to `localStorage['royale.prefs']` and survives a
 * private-mode failure by simply staying in memory.
 */
import { bus } from '../../core/bus.ts';

export type QualityTier = 'auto' | 'low' | 'mid' | 'high';
export type HapticStrength = 'light' | 'medium' | 'strong';
export type TableSkin = 'emerald' | 'obsidian' | 'bordeaux' | 'cobalt';
export type SessionLimit = 0 | 30 | 60 | 120;

export interface Prefs {
  // ── audio
  muted: boolean;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  uiVolume: number;
  // ── haptics
  haptics: boolean;
  hapticStrength: HapticStrength;
  // ── graphics
  quality: QualityTier;
  showFps: boolean;
  reduceMotion: boolean;
  // ── gameplay
  fourColor: boolean;
  handStrength: boolean;
  autoMuck: boolean;
  preAction: boolean;
  confirmAllIn: boolean;
  tableSkin: TableSkin;
  // ── account
  displayName: string;
  // ── privacy
  publicStats: boolean;
  friendRequests: boolean;
  leaderboards: boolean;
  shareHands: boolean;
  // ── responsible play
  sessionLimitMin: SessionLimit;
  lossLimit: number;
  realityChecks: boolean;
  breakUntil: number | null;
}

export const DEFAULT_PREFS: Prefs = {
  muted: false,
  masterVolume: 0.8,
  musicVolume: 0.45,
  sfxVolume: 0.85,
  uiVolume: 0.7,

  haptics: true,
  hapticStrength: 'medium',

  quality: 'auto',
  showFps: false,
  reduceMotion: false,

  fourColor: true,
  handStrength: true,
  autoMuck: true,
  preAction: true,
  confirmAllIn: true,
  tableSkin: 'emerald',

  displayName: 'Kieran',

  publicStats: true,
  friendRequests: true,
  leaderboards: true,
  shareHands: false,

  sessionLimitMin: 0,
  lossLimit: 0,
  realityChecks: true,
  breakUntil: null,
};

const KEY = 'royale.prefs';

function load(): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return out;
  }
  if (!raw) return out;
  try {
    const saved = JSON.parse(raw) as Partial<Prefs>;
    for (const k of Object.keys(DEFAULT_PREFS) as Array<keyof Prefs>) {
      const v = saved[k];
      if (v === undefined || v === null) continue;
      if (typeof v === typeof DEFAULT_PREFS[k]) {
        (out as unknown as Record<string, unknown>)[k] = v;
      }
    }
    if (typeof saved.breakUntil === 'number') out.breakUntil = saved.breakUntil;
  } catch {
    /* corrupt blob — defaults win */
  }
  return out;
}

let state: Prefs = load();
const subs = new Set<(p: Prefs) => void>();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode: prefs live for this session only */
  }
}

function broadcast(): void {
  const frozen = Object.freeze({ ...state });
  for (const fn of Array.from(subs)) {
    try {
      fn(frozen);
    } catch (err) {
      console.error('[prefs] subscriber failed', err);
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<Prefs>('royale:prefs', { detail: frozen }));
  }
}

/** Current preferences. Cheap — returns the live object, treat as read-only. */
export function prefs(): Readonly<Prefs> {
  return state;
}

/** Subscribe. Fires immediately with the current value unless `immediate` is false. */
export function onPrefs(fn: (p: Prefs) => void, immediate = true): () => void {
  subs.add(fn);
  if (immediate) fn(state);
  return () => subs.delete(fn);
}

/** Writes one key, persists, and notifies — a no-op when the value is unchanged. */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  if (Object.is(state[key], value)) return;
  state = { ...state, [key]: value };
  persist();
  if (key === 'quality') {
    const q = state.quality;
    if (q !== 'auto') bus.emit('perf:tier', { tier: q, fps: 60 });
  }
  if (key === 'haptics' && state.haptics) bus.emit('ui:haptic', { pattern: 'select' });
  broadcast();
}

/** Bulk write used by "restore defaults" and the break-lock flow. */
export function setPrefs(patch: Partial<Prefs>): void {
  let changed = false;
  const next: Prefs = { ...state };
  for (const k of Object.keys(patch) as Array<keyof Prefs>) {
    const v = patch[k];
    if (v === undefined) continue;
    if (Object.is(next[k], v)) continue;
    (next as unknown as Record<string, unknown>)[k] = v;
    changed = true;
  }
  if (!changed) return;
  state = next;
  persist();
  broadcast();
}

export function resetPrefs(): void {
  state = { ...DEFAULT_PREFS, displayName: state.displayName };
  persist();
  broadcast();
}

/**
 * The effective audio gain for a channel, already folded through master + mute.
 * The audio module can call this every time it builds a node.
 */
export function channelGain(channel: 'music' | 'sfx' | 'ui'): number {
  if (state.muted) return 0;
  const ch =
    channel === 'music' ? state.musicVolume : channel === 'sfx' ? state.sfxVolume : state.uiVolume;
  return Math.max(0, Math.min(1, ch * state.masterVolume));
}

// ── session clock ─────────────────────────────────────────────────────
// Responsible-play needs a session length that survives route changes, so it
// lives here rather than inside the settings screen.

const SESSION_KEY = 'royale.session-start';

function readSessionStart(): number {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const n = raw ? Number(raw) : NaN;
    // A "session" older than 6h is stale — treat this as a fresh one.
    if (Number.isFinite(n) && Date.now() - n < 6 * 3600_000) return n;
  } catch {
    /* fall through */
  }
  const now = Date.now();
  try {
    localStorage.setItem(SESSION_KEY, String(now));
  } catch {
    /* memory only */
  }
  return now;
}

let sessionStart = readSessionStart();

/** Milliseconds the player has had the app open this session. */
export function sessionElapsedMs(): number {
  return Date.now() - sessionStart;
}

export function resetSessionClock(): void {
  sessionStart = Date.now();
  try {
    localStorage.setItem(SESSION_KEY, String(sessionStart));
  } catch {
    /* memory only */
  }
}

/** True while a self-imposed break is still running. */
export function onBreak(): boolean {
  return !!state.breakUntil && state.breakUntil > Date.now();
}
