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

/** Splits a comment body into its @mention and the rest. */
export function splitMention(text: string): { mention: string | null; rest: string } {
  const m = /^@(\S+)\s+([\s\S]*)$/.exec(text);
  if (!m) return { mention: null, rest: text };
  return { mention: m[1], rest: m[2] };
}
