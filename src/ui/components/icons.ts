/**
 * ROYALE — components/icons.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Hand-drawn inline SVG icon set. One 24×24 grid, 1.7px stroke, round joins,
 * optically balanced so a 20px `chip` and a 20px `gem` read at the same
 * weight. No icon fonts, no emoji, no external files — ever.
 *
 *   icon('gem')                       → 20px, currentColor, stroked
 *   icon('crown', { size: 16 })       → sized
 *   icon('check', { stroke: 2.4 })    → heavier
 *   icon('flame', { solid: true })    → filled silhouette where defined
 *   icon('close', { title: 'Close' }) → adds <title> for screen readers
 *
 * Icons inherit `currentColor`, so tint them with CSS `color`.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';

interface Shape {
  d: string;
  /** filled instead of stroked */
  f?: boolean;
  /** relative opacity for secondary detail strokes */
  o?: number;
}

const P = (d: string): Shape[] => [{ d }];

const ICONS: Record<string, Shape[]> = {
  plus: P('M12 5v14M5 12h14'),
  minus: P('M5 12h14'),
  close: P('M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8'),
  check: P('M4.6 12.6l4.9 4.9L19.4 7'),
  'chevron-left': P('M15 4.8l-7.2 7.2L15 19.2'),
  'chevron-right': P('M9 4.8l7.2 7.2L9 19.2'),
  'chevron-down': P('M4.8 9l7.2 7.2L19.2 9'),
  'chevron-up': P('M4.8 15l7.2-7.2L19.2 15'),
  'arrow-left': P('M19.4 12H4.6M10.8 5.8L4.6 12l6.2 6.2'),
  'arrow-right': P('M4.6 12h14.8M13.2 5.8L19.4 12l-6.2 6.2'),
  'arrow-up-right': P('M7 17L17 7M8.6 7H17v8.4'),
  'trend-up': P('M3.5 16.5l5.2-5.4 3.4 3.2 6.1-7M18.2 7.3h2.3v2.4'),

  chip: [
    { d: 'M12 21.2a9.2 9.2 0 100-18.4 9.2 9.2 0 000 18.4z' },
    { d: 'M12 16.6a4.6 4.6 0 100-9.2 4.6 4.6 0 000 9.2z', o: 0.6 },
    { d: 'M12 2.8v2.6M12 21.2v-2.6M2.8 12h2.6M21.2 12h-2.6' },
  ],
  gem: [
    { d: 'M6.4 3.2h11.2l3.6 6.2L12 21 2.8 9.4l3.6-6.2z' },
    { d: 'M2.8 9.4h18.4', o: 0.55 },
    { d: 'M8.6 9.4L12 21l3.4-11.6M6.4 3.2l2.2 6.2M17.6 3.2l-2.2 6.2', o: 0.55 },
  ],
  crown: [
    { d: 'M3.3 8.1l3.9 2.7L12 5.2l4.8 5.6 3.9-2.7-1.7 9.1H5L3.3 8.1z' },
    { d: 'M5.4 20.1h13.2', o: 0.6 },
  ],
  star: P('M12 3.4l2.65 5.5 6.05.82-4.4 4.2 1.06 6.02L12 17.1l-5.36 2.84L7.7 13.92l-4.4-4.2 6.05-.82L12 3.4z'),
  heart: P('M12 20.4S3.4 15.3 3.4 9.4A4.6 4.6 0 0112 6.9a4.6 4.6 0 018.6 2.5c0 5.9-8.6 11-8.6 11z'),
  flame: [
    { d: 'M12 21.2c4 0 6.7-2.6 6.7-6.2 0-4.8-4.5-7.4-5.4-12.4-2.1 1.7-3.8 4.5-3.8 6.7 0 1.4.5 2.4.5 2.4s-1.2-1.6-2.5-.4c-1.5 1.4-2.4 3.2-2.4 5.1 0 2.6 2.7 4.8 6.9 4.8z' },
  ],
  sparkle: [
    { d: 'M11 2.9l1.75 5.05L17.8 9.7l-5.05 1.75L11 16.5l-1.75-5.05L4.2 9.7l5.05-1.75L11 2.9z' },
    { d: 'M18.4 14.4l.85 2.35 2.35.85-2.35.85-.85 2.35-.85-2.35-2.35-.85 2.35-.85.85-2.35z', o: 0.7 },
  ],
  trophy: [
    { d: 'M8 3.8h8v5.6a4 4 0 01-8 0V3.8z' },
    { d: 'M8 5.4H5.5A1.5 1.5 0 004 6.9c0 2.4 1.8 4.3 4.2 4.6M16 5.4h2.5A1.5 1.5 0 0120 6.9c0 2.4-1.8 4.3-4.2 4.6' },
    { d: 'M12 13.5v3.2M8.4 20.2h7.2l-.6-2.3a1.1 1.1 0 00-1.05-.8h-3.9a1.1 1.1 0 00-1.05.8l-.6 2.3z' },
  ],
  clock: [
    { d: 'M12 21.2a9.2 9.2 0 100-18.4 9.2 9.2 0 000 18.4z' },
    { d: 'M12 6.9V12l3.4 2.1' },
  ],
  bolt: P('M13.6 2.4L4.4 13.7h6.3l-1 7.9 9.2-11.3h-6.3l1-7.9z'),
  shield: [
    { d: 'M12 21.1s7.5-3.5 7.5-9.4V5.6L12 2.9 4.5 5.6v6.1c0 5.9 7.5 9.4 7.5 9.4z' },
    { d: 'M9.2 12.1l2 2 3.6-4', o: 0.75 },
  ],
  lock: [
    { d: 'M8.1 10.4V7.9a3.9 3.9 0 117.8 0v2.5' },
    { d: 'M6.6 10.4h10.8a1.6 1.6 0 011.6 1.6v6.5a1.6 1.6 0 01-1.6 1.6H6.6A1.6 1.6 0 015 18.5V12a1.6 1.6 0 011.6-1.6z' },
  ],
  gear: [
    { d: 'M19.5 13.9a7.9 7.9 0 000-3.8l2-1.55-2-3.45-2.35 1a7.7 7.7 0 00-3.3-1.9L13.45 1.8h-2.9l-.4 2.4a7.7 7.7 0 00-3.3 1.9l-2.35-1-2 3.45L4.5 10.1a7.9 7.9 0 000 3.8l-2 1.55 2 3.45 2.35-1a7.7 7.7 0 003.3 1.9l.4 2.4h2.9l.4-2.4a7.7 7.7 0 003.3-1.9l2.35 1 2-3.45-2-1.55z' },
    { d: 'M12 15.3a3.3 3.3 0 100-6.6 3.3 3.3 0 000 6.6z' },
  ],
  search: [
    { d: 'M10.9 18.3a7.4 7.4 0 100-14.8 7.4 7.4 0 000 14.8z' },
    { d: 'M16.3 16.3L21 21' },
  ],
  eye: [
    { d: 'M2.6 12S6.2 5.7 12 5.7 21.4 12 21.4 12 17.8 18.3 12 18.3 2.6 12 2.6 12z' },
    { d: 'M12 14.9a2.9 2.9 0 100-5.8 2.9 2.9 0 000 5.8z' },
  ],
  share: [
    { d: 'M12 15.4V3.6M8.5 7.1L12 3.6l3.5 3.5' },
    { d: 'M6.6 10.9H5.4A1.6 1.6 0 003.8 12.5v6.4a1.6 1.6 0 001.6 1.6h13.2a1.6 1.6 0 001.6-1.6v-6.4a1.6 1.6 0 00-1.6-1.6h-1.2' },
  ],
  bell: [
    { d: 'M18 9.6a6 6 0 10-12 0c0 4.8-2 6.3-2 6.3h16s-2-1.5-2-6.3z' },
    { d: 'M13.7 19.2a2 2 0 01-3.4 0' },
  ],
  info: [
    { d: 'M12 21.2a9.2 9.2 0 100-18.4 9.2 9.2 0 000 18.4z' },
    { d: 'M12 11.2v5.4' },
    { d: 'M12.9 7.7a.9.9 0 11-1.8 0 .9.9 0 011.8 0z', f: true },
  ],
  warning: [
    { d: 'M10.25 4.15L2.6 17.4a2 2 0 001.75 3h15.3a2 2 0 001.75-3L13.75 4.15a2 2 0 00-3.5 0z' },
    { d: 'M12 9.3v4.3' },
    { d: 'M12.9 17.1a.9.9 0 11-1.8 0 .9.9 0 011.8 0z', f: true },
  ],
  users: [
    { d: 'M15.4 20.4v-1.8a3.7 3.7 0 00-3.7-3.7H6.5a3.7 3.7 0 00-3.7 3.7v1.8' },
    { d: 'M9.1 11.3a3.65 3.65 0 100-7.3 3.65 3.65 0 000 7.3z' },
    { d: 'M21.2 20.4v-1.8a3.7 3.7 0 00-2.8-3.6M15.7 4.2a3.65 3.65 0 010 7.1', o: 0.7 },
  ],
  comment: P('M20.6 12.3c0 3.9-3.85 7.1-8.6 7.1a10 10 0 01-2.9-.42L4.2 20.8l1.45-3.7a6.9 6.9 0 01-2.25-4.8c0-3.9 3.85-7.1 8.6-7.1s8.6 3.2 8.6 7.1z'),
  cards: [
    { d: 'M8.9 5.5L5.1 6.8a1.7 1.7 0 00-1.05 2.15l3.3 9.7a1.7 1.7 0 002.15 1.05l.85-.3', o: 0.72 },
    { d: 'M11.6 3.6h6.3A1.75 1.75 0 0119.65 5.35v13.3A1.75 1.75 0 0117.9 20.4h-6.3a1.75 1.75 0 01-1.75-1.75V5.35A1.75 1.75 0 0111.6 3.6z' },
    { d: 'M14.75 8.2l2.05 2.4c.6.7.1 1.8-.8 1.8h-2.5c-.9 0-1.4-1.1-.8-1.8l2.05-2.4z', f: true },
  ],
  spade: P('M12 3.4c3.15 3.4 6.9 5.6 6.9 9.1a3.7 3.7 0 01-6.15 2.75c.2 2 .8 3.4 1.7 4.2H9.55c.9-.8 1.5-2.2 1.7-4.2A3.7 3.7 0 015.1 12.5c0-3.5 3.75-5.7 6.9-9.1z'),
  target: [
    { d: 'M12 21.2a9.2 9.2 0 100-18.4 9.2 9.2 0 000 18.4z' },
    { d: 'M12 16.7a4.7 4.7 0 100-9.4 4.7 4.7 0 000 9.4z', o: 0.72 },
    { d: 'M13.3 12a1.3 1.3 0 11-2.6 0 1.3 1.3 0 012.6 0z', f: true },
  ],
  bag: [
    { d: 'M5.7 7.7h12.6l1.05 11.1a1.7 1.7 0 01-1.7 1.85H6.35a1.7 1.7 0 01-1.7-1.85L5.7 7.7z' },
    { d: 'M8.85 10V6.8a3.15 3.15 0 016.3 0V10' },
  ],
  person: [
    { d: 'M12 12.3a4.15 4.15 0 100-8.3 4.15 4.15 0 000 8.3z' },
    { d: 'M4.7 20.4a7.35 7.35 0 0114.6 0' },
  ],
  feed: [
    { d: 'M4.6 4h14.8A1.6 1.6 0 0121 5.6v12.8a1.6 1.6 0 01-1.6 1.6H4.6A1.6 1.6 0 013 18.4V5.6A1.6 1.6 0 014.6 4z' },
    { d: 'M8.15 10.4a1.9 1.9 0 100-3.8 1.9 1.9 0 000 3.8z' },
    { d: 'M12.6 8.5h5.1M6.25 14.1h11.45M6.25 17h7.3', o: 0.65 },
  ],
  chart: [
    { d: 'M3.4 20.4h17.2' },
    { d: 'M7 20.4v-5.2M12 20.4V8.6M17 20.4v-8.4' },
  ],
  money: P('M12 2.6v18.8M16.7 6.9H9.9a3.15 3.15 0 000 6.3h4.3a3.15 3.15 0 010 6.3H7.1'),
  refresh: [
    { d: 'M20.4 12a8.4 8.4 0 11-2.55-6.05' },
    { d: 'M20.7 4.4v4.6h-4.6' },
  ],
  sliders: [
    { d: 'M3.4 7h17M3.4 12h17M3.4 17h17', o: 0.55 },
    { d: 'M8.6 9.4A2.4 2.4 0 108.6 4.6a2.4 2.4 0 000 4.8zM15.4 14.4a2.4 2.4 0 100-4.8 2.4 2.4 0 000 4.8zM10.6 19.4a2.4 2.4 0 100-4.8 2.4 2.4 0 000 4.8z' },
  ],
  ellipsis: [
    { d: 'M6.7 12a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM13.5 12a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM20.3 12a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z', f: true },
  ],
  exit: [
    { d: 'M14.9 4.4h3.5A1.6 1.6 0 0120 6v12a1.6 1.6 0 01-1.6 1.6h-3.5' },
    { d: 'M10 16.2L13.8 12 10 7.8M13.5 12H3.6' },
  ],
  copy: [
    { d: 'M9.6 9.6h8.8a1.6 1.6 0 011.6 1.6v8.8a1.6 1.6 0 01-1.6 1.6H9.6A1.6 1.6 0 018 20v-8.8a1.6 1.6 0 011.6-1.6z' },
    { d: 'M5.6 15.4H5A1.6 1.6 0 013.4 13.8V5A1.6 1.6 0 015 3.4h8.8A1.6 1.6 0 0115.4 5v.6', o: 0.7 },
  ],
};

export type IconName = keyof typeof ICONS & string;

export interface IconOpts {
  /** px, default 20 */
  size?: number;
  /** stroke width on the 24-grid, default 1.7 */
  stroke?: number;
  class?: ClassValue;
  /** render the primary shape filled (silhouette) */
  solid?: boolean;
  /** accessible name; without it the icon is aria-hidden */
  title?: string;
}

/** Builds an icon. Unknown names render an empty box rather than throwing. */
export function icon(name: IconName, opts: IconOpts = {}): SVGSVGElement {
  const size = opts.size ?? 20;
  const shapes = ICONS[name] ?? [];
  const svg = h(
    'svg',
    {
      class: cx('r-ic', opts.class),
      attrs: {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': opts.stroke ?? 1.7,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        role: opts.title ? 'img' : 'presentation',
        'aria-hidden': opts.title ? null : 'true',
        focusable: 'false',
      },
    },
    opts.title ? h('title', null, opts.title) : null,
  );
  for (let i = 0; i < shapes.length; i++) {
    const sh = shapes[i];
    const filled = sh.f || (opts.solid && i === 0);
    svg.appendChild(
      h('path', {
        attrs: {
          d: sh.d,
          fill: filled ? 'currentColor' : 'none',
          stroke: filled ? 'none' : 'currentColor',
          opacity: sh.o ?? null,
        },
      }),
    );
  }
  return svg;
}

/** True if the name exists — lets screens fall back gracefully. */
export function hasIcon(name: string): name is IconName {
  return name in ICONS;
}
