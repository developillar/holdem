/**
 * ROYALE — ui/feed/util.ts
 * Small shared helpers for the feed surface: relative time, safe text, and a
 * keyboard-aware inset so a compose row never hides behind the on-screen
 * keyboard on iOS.
 */

/** "now · 4m · 3h · yesterday · Tue · 12 Mar" — the way a feed prints time. */
export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 90) return '1m';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const hr = m / 60;
  if (hr < 24) return `${Math.floor(hr)}h`;
  const d = hr / 24;
  if (d < 2) return 'yesterday';
  if (d < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Long form for the accessible title attribute. */
export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Money the way a poker room prints it. `core/stakes.ts` `money()` is tuned
 * for dense lobby chrome and renders $87 as "$87.0", which reads as a typo on
 * a stack. Here: two decimals when they carry information, none when they do
 * not, and compaction only once the number gets long.
 */
export function cash(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 100_000) return `${sign}$${Math.round(a / 1000)}K`;
  if (a >= 10_000) return `${sign}$${(a / 1000).toFixed(1)}K`;
  if (a >= 1000) return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
  const fixed = a.toFixed(2);
  return `${sign}$${fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed}`;
}

/** 1.2K / 18.4K / 240 — used for reaction totals and pot chips. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${Math.round(n / 1000)}K`;
  if (a >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Tracks the on-screen keyboard. `visualViewport` shrinks when the keyboard
 * opens; the difference between the layout viewport and the visual viewport
 * bottom is exactly how far a fixed element must lift. Falls back to 0 where
 * `visualViewport` is unavailable, which is correct on desktop.
 */
export function watchKeyboard(onChange: (inset: number) => void): () => void {
  const vv = window.visualViewport;
  if (!vv) {
    onChange(0);
    return () => {};
  }
  let raf = 0;
  const measure = (): void => {
    raf = 0;
    const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
    onChange(inset);
  };
  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(measure);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  measure();
  return () => {
    if (raf) cancelAnimationFrame(raf);
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
  };
}

// ─────────────────────────── rarity gate ───────────────────────────

/**
 * How rare a post *looks*.
 *
 * `post.tier` is the model's idea of importance and it is generous: it hands
 * `epic` to every sit-and-go win and to any big-win/bluff over a low pot
 * threshold, which puts a decorated rim on the majority of the list. A frame
 * that fires on most cards is wallpaper, not information — so the UI applies
 * its own, much tighter gate before it paints one.
 *
 * The ladder the eye actually reads:
 *
 *   normal      plain glass — the default, and the common case
 *   rare        a brighter neutral hairline; "worth a look"
 *   epic        the teal rim; roughly one card in eight
 *   legendary   24k foil with the sheen; a handful per session
 *
 * Everything is derived from data already on the post (kind, pot in big
 * blinds, table size), so no model change is needed and the ranking the feed
 * does on `tier` is left untouched.
 */
export function bigBlindOf(stakeLabel: string | undefined): number {
  if (!stakeLabel) return 0;
  const m = /\$?([\d.]+)\s*\/\s*\$?([\d.]+)/.exec(stakeLabel);
  const bb = m ? Number(m[2]) : NaN;
  return Number.isFinite(bb) && bb > 0 ? bb : 0;
}

export type VisualTier = 'normal' | 'rare' | 'epic' | 'legendary';

export interface TierInput {
  kind: string;
  tier: VisualTier;
  amount?: number;
  stakeLabel?: string;
  hand?: { seats: readonly unknown[] } | null;
}

export function visualTier(post: TierInput): VisualTier {
  const bb = bigBlindOf(post.stakeLabel);
  const potBb = bb > 0 && post.amount !== undefined ? post.amount / bb : 0;
  const seats = post.hand ? post.hand.seats.length : 0;

  switch (post.kind) {
    // Hands you tell people about years later. The foil is theirs alone.
    case 'royal':
      return 'legendary';
    case 'straight-flush':
      return potBb > 560 ? 'legendary' : 'epic';
    case 'quads':
      return potBb > 640 ? 'legendary' : potBb > 420 ? 'epic' : 'rare';

    // A sit-and-go win is a headline when it was a real final table or the
    // last pot was genuinely enormous. Shipping a turbo is a Tuesday.
    case 'sng-win':
      return seats >= 6 || potBb > 560 ? 'epic' : 'rare';

    // For the everyday kinds the pot has to be outsized for its own class,
    // not merely above average — otherwise the frame just tracks "is a post".
    case 'bad-beat':
      return potBb > 560 ? 'epic' : potBb > 460 ? 'rare' : 'normal';
    case 'big-win':
      return potBb > 600 ? 'epic' : potBb > 480 ? 'rare' : 'normal';
    case 'bluff':
      return potBb > 400 ? 'epic' : potBb > 230 ? 'rare' : 'normal';
    case 'bomb-pot':
      return potBb > 1100 ? 'epic' : potBb > 950 ? 'rare' : 'normal';

    // Milestones and unlocks never outrank a hand: a cosmetic drop carries its
    // own rarity chip inside the card, so the card edge stays quiet.
    case 'cosmetic':
      return post.tier === 'epic' || post.tier === 'legendary' ? 'rare' : 'normal';
    case 'streak':
    case 'bounty':
    case 'level-up':
      return post.tier === 'normal' ? 'normal' : 'rare';
    default:
      return 'normal';
  }
}

/** Splits a comment body into its @mention and the rest. */
export function splitMention(text: string): { mention: string | null; rest: string } {
  const m = /^@(\S+)\s+([\s\S]*)$/.exec(text);
  if (!m) return { mention: null, rest: text };
  return { mention: m[1], rest: m[2] };
}
