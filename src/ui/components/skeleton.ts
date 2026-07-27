/**
 * ROYALE — components/skeleton.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Loading placeholders that mirror the shape of the real content — the
 * shimmer is a translated overlay (transform only, never `background-position`)
 * so a full screen of them still holds 60fps.
 *
 *   Skeleton({ w: '60%', h: 14 })
 *   SkeletonText({ lines: 3, lastWidth: '48%' })
 *   SkeletonRow({ avatar: true, lines: 2 })
 *   SkeletonList(6, () => SkeletonRow({ avatar: true }))
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';

export interface SkeletonOpts {
  w?: number | string;
  h?: number | string;
  /** border radius; number → px, string → raw */
  r?: number | string;
  /** stagger the shimmer so a stack ripples instead of pulsing in unison */
  delay?: number;
  class?: ClassValue;
}

export function Skeleton(opts: SkeletonOpts = {}): HTMLElement {
  const size = (v: number | string | undefined, fallback: string) =>
    v === undefined ? fallback : typeof v === 'number' ? `${v}px` : v;
  return h('span', {
    class: cx('r-skel', opts.class),
    'aria-hidden': 'true',
    style: {
      width: size(opts.w, '100%'),
      height: size(opts.h, '12px'),
      borderRadius: size(opts.r, '6px'),
      '--skel-delay': `${opts.delay ?? 0}ms`,
    },
  });
}

export interface SkeletonTextOpts {
  lines?: number;
  lastWidth?: string;
  lineHeight?: number;
  gap?: number;
  class?: ClassValue;
}

export function SkeletonText(opts: SkeletonTextOpts = {}): HTMLElement {
  const lines = opts.lines ?? 3;
  const out: HTMLElement[] = [];
  for (let i = 0; i < lines; i++) {
    const last = i === lines - 1;
    out.push(
      Skeleton({
        w: last ? (opts.lastWidth ?? '54%') : `${88 - ((i * 7) % 18)}%`,
        h: opts.lineHeight ?? 11,
        delay: i * 90,
      }),
    );
  }
  return h(
    'span',
    { class: cx('r-skel-text', opts.class), style: { gap: `${opts.gap ?? 8}px` }, 'aria-hidden': 'true' },
    ...out,
  );
}

export interface SkeletonRowOpts {
  avatar?: boolean;
  avatarSize?: number;
  lines?: number;
  trailing?: boolean;
  class?: ClassValue;
  delay?: number;
}

/** Matches the metrics of `ListRow`, so the swap to real data doesn't jump. */
export function SkeletonRow(opts: SkeletonRowOpts = {}): HTMLElement {
  return h(
    'div',
    { class: cx('r-skel-row', opts.class), 'aria-hidden': 'true' },
    opts.avatar !== false
      ? Skeleton({ w: opts.avatarSize ?? 44, h: opts.avatarSize ?? 44, r: '50%', delay: opts.delay })
      : null,
    h(
      'span',
      { class: 'r-skel-row__col' },
      Skeleton({ w: '58%', h: 12, delay: (opts.delay ?? 0) + 70 }),
      (opts.lines ?? 2) > 1 ? Skeleton({ w: '36%', h: 10, delay: (opts.delay ?? 0) + 140 }) : null,
    ),
    opts.trailing !== false ? Skeleton({ w: 56, h: 20, r: 10, delay: (opts.delay ?? 0) + 210 }) : null,
  );
}

/** Repeats a skeleton factory with an automatic stagger. */
export function SkeletonList(count: number, make: (i: number) => HTMLElement): HTMLElement {
  const box = h('div', { class: 'r-skel-list', 'aria-hidden': 'true', 'aria-busy': 'true' });
  for (let i = 0; i < count; i++) {
    const node = make(i);
    node.style.setProperty('--skel-delay', `${i * 110}ms`);
    box.appendChild(node);
  }
  return box;
}
