/**
 * ROYALE — haptics.
 * ─────────────────────────────────────────────────────────────────────
 * `navigator.vibrate` is a blunt instrument: one motor, one amplitude,
 * millisecond on/off pairs. Everything expressive therefore has to come
 * from *rhythm*. These are designed as short rhythmic figures, not
 * buzzes — a fold is a soft double that decays, a big win is a rising
 * triplet that lands on a long final pulse.
 *
 * Degrades silently: no API, no permission, user setting off, or a
 * desktop browser → the calls are free no-ops.
 */
import type { HapticPattern } from '../core/bus.ts';

const STORE_KEY = 'royale.haptics.v1';

/**
 * Patterns are `[buzz, pause, buzz, pause, …]` in milliseconds.
 * Under ~10 ms most phone motors produce a tap; 30 ms+ reads as a hit.
 */
const PATTERNS: Record<HapticPattern, number[]> = {
  // metronomic, barely there — the action clock
  tick: [7],
  // a single crisp confirmation for taps and list selection
  select: [11],
  // chips committed: a firm double with a short gap, like a stack landing
  bet: [16, 26, 22],
  // resigned: soft, trailing off
  fold: [9, 34, 6],
  // three even pulses, the last slightly longer
  win: [16, 44, 16, 44, 28],
  // rising triplet into a landing hit
  'big-win': [12, 40, 20, 36, 30, 32, 58],
  // two hard, close pulses — unmistakably a rejection
  error: [34, 46, 34],
  // one flick per card, light and fast
  deal: [5, 24, 5],
};

type Vibrator = (pattern: number | number[]) => boolean;

function vibrator(): Vibrator | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { vibrate?: Vibrator };
  if (typeof nav.vibrate !== 'function') return null;
  return nav.vibrate.bind(nav) as Vibrator;
}

function loadEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    /* storage unavailable */
  }
  return true;
}

class Haptics {
  private enabled = loadEnabled();
  private vibrate: Vibrator | null = null;
  private probed = false;
  private lastAt = 0;
  /** floor between fires so a burst of events cannot lock the motor on */
  private minGapMs = 34;

  get supported(): boolean {
    if (!this.probed) {
      this.vibrate = vibrator();
      this.probed = true;
    }
    return this.vibrate !== null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(STORE_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable — session-only */
    }
    if (!on) this.cancel();
    else if (this.supported) this.fire(PATTERNS.select);
  }

  /** Plays a named pattern. Silently ignored when unsupported or disabled. */
  play(pattern: HapticPattern): void {
    if (!this.enabled || !this.supported) return;
    const p = PATTERNS[pattern];
    if (!p) return;
    const now = Date.now();
    // ticks are allowed to be dense; everything else respects the floor
    const gap = pattern === 'tick' ? 90 : this.minGapMs;
    if (now - this.lastAt < gap) return;
    this.lastAt = now;
    this.fire(p);
  }

  /** Escape hatch for one-off custom figures (e.g. a countdown ramp). */
  custom(pattern: number[]): void {
    if (!this.enabled || !this.supported) return;
    const now = Date.now();
    if (now - this.lastAt < this.minGapMs) return;
    this.lastAt = now;
    this.fire(pattern);
  }

  cancel(): void {
    if (!this.supported) return;
    this.fire(0);
  }

  private fire(p: number | number[]): void {
    try {
      this.vibrate?.(p);
    } catch {
      /* some browsers throw inside iframes without user activation */
    }
  }
}

export const haptics = new Haptics();

export function setHapticsEnabled(on: boolean): void {
  haptics.setEnabled(on);
}

export function hapticsEnabled(): boolean {
  return haptics.isEnabled();
}

export function hapticsSupported(): boolean {
  return haptics.supported;
}

export function playHaptic(pattern: HapticPattern): void {
  haptics.play(pattern);
}
