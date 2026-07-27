/**
 * Drawn icon set for the table HUD. Every glyph here is hand-built vector —
 * no icon font, no emoji, no downloaded asset. They share a 24×24 grid, a
 * 1.7px optical stroke and rounded joins so they read as one family at
 * phone size.
 */

import { s } from './dom.ts';
import type { ReactionKind } from '../../core/types.ts';

function frame(size: number, ...kids: SVGElement[]): SVGElement {
  return s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: String(size),
      height: String(size),
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    ...kids,
  );
}

function stroke(d: string, extra?: Record<string, string>): SVGElement {
  return s('path', {
    d,
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    ...(extra ?? {}),
  });
}

function fill(d: string, extra?: Record<string, string>): SVGElement {
  return s('path', { d, fill: 'currentColor', ...(extra ?? {}) });
}

export type IconName =
  | 'menu'
  | 'close'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'sound-on'
  | 'sound-off'
  | 'clock'
  | 'replay'
  | 'history'
  | 'leave'
  | 'chair'
  | 'skin'
  | 'coins'
  | 'plus'
  | 'minus'
  | 'backspace'
  | 'check'
  | 'mute-user'
  | 'emote'
  | 'keypad'
  | 'play'
  | 'pause'
  | 'step'
  | 'trophy'
  | 'shield'
  | 'wifi-off'
  | 'eye-off'
  | 'spark';

export function icon(name: IconName, size = 20): SVGElement {
  switch (name) {
    case 'menu':
      return frame(size, stroke('M4 7h16'), stroke('M4 12h16'), stroke('M4 17h10'));
    case 'close':
      return frame(size, stroke('M6 6l12 12'), stroke('M18 6L6 18'));
    case 'chevron-down':
      return frame(size, stroke('M6 9.5l6 5.5 6-5.5'));
    case 'chevron-left':
      return frame(size, stroke('M14.5 5.5L8 12l6.5 6.5'));
    case 'chevron-right':
      return frame(size, stroke('M9.5 5.5L16 12l-6.5 6.5'));
    case 'sound-on':
      return frame(
        size,
        fill('M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4z'),
        stroke('M15.6 9.1a4 4 0 0 1 0 5.8'),
        stroke('M18.2 6.6a7.4 7.4 0 0 1 0 10.8'),
      );
    case 'sound-off':
      return frame(
        size,
        fill('M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4z'),
        stroke('M16 10l4.5 4.5'),
        stroke('M20.5 10L16 14.5'),
      );
    case 'clock':
      return frame(size, s('circle', { cx: '12', cy: '12', r: '8.2', stroke: 'currentColor', 'stroke-width': '1.7', fill: 'none' }), stroke('M12 7.4V12l3.2 2'));
    case 'replay':
      return frame(
        size,
        stroke('M20 12a8 8 0 1 1-2.6-5.9'),
        stroke('M20.4 4.6V9h-4.4'),
      );
    case 'history':
      return frame(size, stroke('M4.5 6.5h15'), stroke('M4.5 12h15'), stroke('M4.5 17.5h9'), fill('M20.2 16l1.5 3-3 .1z'));
    case 'leave':
      return frame(size, stroke('M14 5.5H6.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1H14'), stroke('M17 8.5l3.5 3.5L17 15.5'), stroke('M20 12h-9'));
    case 'chair':
      return frame(
        size,
        stroke('M7.6 10.6V6.6a1.8 1.8 0 0 1 1.8-1.8h5.2a1.8 1.8 0 0 1 1.8 1.8v4'),
        stroke('M5.4 10.8h13.2a1 1 0 0 1 1 1v1.5a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1v-1.5a1 1 0 0 1 1-1z'),
        stroke('M6.8 14.5v4.2'),
        stroke('M17.2 14.5v4.2'),
      );
    case 'skin':
      return frame(
        size,
        s('ellipse', { cx: '12', cy: '12', rx: '8.4', ry: '6', stroke: 'currentColor', 'stroke-width': '1.7', fill: 'none' }),
        s('ellipse', { cx: '12', cy: '12', rx: '5.1', ry: '3.4', stroke: 'currentColor', 'stroke-width': '1.2', fill: 'none', opacity: '0.55' }),
      );
    case 'coins':
      return frame(
        size,
        s('ellipse', { cx: '12', cy: '7.4', rx: '6.6', ry: '2.8', stroke: 'currentColor', 'stroke-width': '1.7', fill: 'none' }),
        stroke('M5.4 7.4v4.2c0 1.55 2.96 2.8 6.6 2.8s6.6-1.25 6.6-2.8V7.4'),
        stroke('M5.4 11.6v4.2c0 1.55 2.96 2.8 6.6 2.8s6.6-1.25 6.6-2.8v-4.2'),
      );
    case 'plus':
      return frame(size, stroke('M12 5.5v13'), stroke('M5.5 12h13'));
    case 'minus':
      return frame(size, stroke('M5.5 12h13'));
    case 'backspace':
      return frame(size, stroke('M9 5.5h10a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9L3 12z'), stroke('M11.5 9.5l5 5'), stroke('M16.5 9.5l-5 5'));
    case 'check':
      return frame(size, stroke('M5 12.6l4.6 4.4L19 7'));
    case 'mute-user':
      return frame(
        size,
        s('circle', { cx: '10', cy: '8.4', r: '3.4', stroke: 'currentColor', 'stroke-width': '1.7', fill: 'none' }),
        stroke('M3.6 19c.5-3.4 3.2-5.2 6.4-5.2 1.1 0 2.1.2 3 .6'),
        stroke('M15 16.4h5.4'),
      );
    case 'emote':
      return frame(
        size,
        s('circle', { cx: '12', cy: '12', r: '8.2', stroke: 'currentColor', 'stroke-width': '1.7', fill: 'none' }),
        fill('M9.3 10.6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'),
        fill('M14.7 10.6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'),
        stroke('M8.4 13.8a4.3 4.3 0 0 0 7.2 0'),
      );
    case 'keypad':
      return frame(
        size,
        ...[6, 12, 18].flatMap((y) =>
          [6, 12, 18].map((x) => s('circle', { cx: String(x), cy: String(y), r: '1.5', fill: 'currentColor' })),
        ),
      );
    case 'play':
      return frame(size, fill('M8 5.6l11 6.4-11 6.4z'));
    case 'pause':
      return frame(size, fill('M7.5 5.5h3.2v13H7.5z'), fill('M13.3 5.5h3.2v13h-3.2z'));
    case 'step':
      return frame(size, fill('M7 5.6l9 6.4-9 6.4z'), fill('M17 5.6h2.2v12.8H17z'));
    case 'trophy':
      return frame(
        size,
        stroke('M8 4.5h8v4.2a4 4 0 0 1-8 0z'),
        stroke('M8 5.6H5.4v1.5a3 3 0 0 0 3 3'),
        stroke('M16 5.6h2.6v1.5a3 3 0 0 1-3 3'),
        stroke('M12 12.7v3.1'),
        stroke('M8.8 19h6.4l-.7-3.2H9.5z'),
      );
    case 'shield':
      return frame(size, stroke('M12 4l6.6 2.4v5.1c0 3.7-2.6 6.6-6.6 8.1-4-1.5-6.6-4.4-6.6-8.1V6.4z'));
    case 'wifi-off':
      return frame(
        size,
        stroke('M4 8.4A13.4 13.4 0 0 1 9.6 6.2'),
        stroke('M7 12a8.8 8.8 0 0 1 2.4-1.5'),
        fill('M12 18.6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'),
        stroke('M19.6 5.2L5 19'),
        stroke('M20 8.4a13.6 13.6 0 0 0-4.2-2'),
      );
    case 'eye-off':
      return frame(
        size,
        stroke('M4 12s3.2-5 8-5c1.2 0 2.3.3 3.2.8'),
        stroke('M19.4 9.6c.4.5.6 1 .6 1 0 1 .1 5-8 5-1 0-1.9-.1-2.7-.4'),
        stroke('M5 19.5L19.5 5'),
      );
    case 'spark':
      return frame(size, fill('M12 3.6l1.9 5.3 5.3 1.9-5.3 1.9L12 18l-1.9-5.3-5.3-1.9 5.3-1.9z'));
    default:
      return frame(size, stroke('M12 5.5v13'));
  }
}

// ───────────────────────── reaction glyphs ─────────────────────────

/**
 * The ten reaction faces. These carry the personality of the emote wheel,
 * so each is drawn with its own palette rather than inheriting currentColor.
 */
export function reactionGlyph(kind: ReactionKind, size = 30): SVGElement {
  const v = (...kids: SVGElement[]): SVGElement =>
    s('svg', { viewBox: '0 0 32 32', width: String(size), height: String(size), fill: 'none', 'aria-hidden': 'true' }, ...kids);
  const circle = (fillColor: string): SVGElement =>
    s('circle', { cx: '16', cy: '16', r: '12.4', fill: fillColor });
  const eye = (cx: number, cy = 13.6, r = 1.7, color = '#20160a'): SVGElement =>
    s('circle', { cx: String(cx), cy: String(cy), r: String(r), fill: color });
  const line = (d: string, color: string, w = 2): SVGElement =>
    s('path', { d, stroke: color, 'stroke-width': String(w), 'stroke-linecap': 'round', fill: 'none' });

  switch (kind) {
    case 'fire':
      return v(
        s('path', { d: 'M16 3c3.6 4.4 2.1 6.6 4.3 8.2 1.4-1 1.6-2.5 1.6-2.5 3 3.2 4.1 6.4 4.1 9.4 0 5.6-4.5 9.4-10 9.4S6 23.7 6 18.1c0-4.6 3.3-7.5 5.6-11 .9 1.7 2 2.6 3 3 .9-2.2 1-4.7 1.4-7.1z', fill: '#ff7a1a' }),
        s('path', { d: 'M16 29c-3.3 0-6-2.3-6-5.5 0-3 2.4-4.5 3.6-7 .7 1.3 1.6 2 2.5 2.3.9-1.6 1.1-3 1.3-4.5 2.2 2.7 4.6 5 4.6 8.6 0 3.5-2.7 6.1-6 6.1z', fill: '#ffd23f' }),
      );
    case 'skull':
      return v(
        s('path', { d: 'M16 3c6.4 0 11 4.4 11 10.4 0 3.6-1.7 5.9-3.4 7.2v3.1a2 2 0 0 1-2 2h-1.2v-2.6h-1.9V28h-4.9v-2.9h-1.9v2.6h-1.3a2 2 0 0 1-2-2v-3.1C6.7 19.3 5 17 5 13.4 5 7.4 9.6 3 16 3z', fill: '#e8edf7' }),
        s('ellipse', { cx: '11.3', cy: '14.2', rx: '2.9', ry: '3.3', fill: '#151a26' }),
        s('ellipse', { cx: '20.7', cy: '14.2', rx: '2.9', ry: '3.3', fill: '#151a26' }),
        s('path', { d: 'M16 17.4l1.5 3h-3z', fill: '#151a26' }),
      );
    case 'clown':
      return v(
        s('path', { d: 'M6 12c-2.6-1.6-3-4.8-.6-6.2 2-1.2 4.4.2 5.6 2.2z', fill: '#ff4d6d' }),
        s('path', { d: 'M26 12c2.6-1.6 3-4.8.6-6.2-2-1.2-4.4.2-5.6 2.2z', fill: '#ff4d6d' }),
        circle('#ffe9d6'),
        eye(11.6, 14, 1.8),
        eye(20.4, 14, 1.8),
        line('M10.6 20.4c1.6 2.4 3.4 3.5 5.4 3.5s3.8-1.1 5.4-3.5', '#c0392b', 2.2),
        s('circle', { cx: '16', cy: '18.3', r: '2.7', fill: '#ff3b3b' }),
      );
    case 'money':
      return v(
        s('rect', { x: '3', y: '7.5', width: '26', height: '17', rx: '3', fill: '#1f8f5f' }),
        s('rect', { x: '5.6', y: '10', width: '20.8', height: '12', rx: '2', fill: 'none', stroke: '#7ff0b6', 'stroke-width': '1.2' }),
        s('circle', { cx: '16', cy: '16', r: '4.6', fill: '#0f6b45' }),
        s('path', { d: 'M16 11.9v8.2M18 13.5c-.6-.8-3.9-1.2-3.9.6 0 1.7 3.9 1 3.9 2.8 0 1.9-3.3 1.5-3.9.7', stroke: '#eaffe9', 'stroke-width': '1.4', 'stroke-linecap': 'round', fill: 'none' }),
      );
    case 'shock':
      return v(
        circle('#ffd85e'),
        s('ellipse', { cx: '11.4', cy: '13.2', rx: '2.1', ry: '2.6', fill: '#20160a' }),
        s('ellipse', { cx: '20.6', cy: '13.2', rx: '2.1', ry: '2.6', fill: '#20160a' }),
        s('ellipse', { cx: '16', cy: '21.4', rx: '3.2', ry: '4', fill: '#20160a' }),
      );
    case 'clap':
      return v(
        s('path', { d: 'M13.6 29.2c-3.6-1-6.2-3.5-7.4-6.6-.7-1.9-.2-3.4 1.3-4.1l-2-3.5c-.6-1.1-.2-2.4.9-3 1.1-.6 2.4-.2 3 .9l1.3 2.2-3-5.2c-.6-1.1-.2-2.4.9-3 1.1-.6 2.4-.2 3 .9l3 5.2-2.1-3.6c-.6-1.1-.2-2.4.9-3 1.1-.6 2.4-.2 3 .9l3.4 5.9c2.2 3.8.7 8.7-3.2 10.9-.9.5-1.9.9-3 1.1z', fill: '#ffc46b' }),
        line('M23.6 6.6l2.6-2.4', '#ffd23f', 2),
        line('M26.6 12l3.2-.7', '#ffd23f', 2),
        line('M20.4 4.2l.5-3.1', '#ffd23f', 2),
      );
    case 'cold':
      return v(
        ...[0, 60, 120].map((deg) =>
          s('g', { transform: `rotate(${deg} 16 16)` },
            line('M16 3.4v25.2', '#9fe4ff', 2.4),
            line('M16 8.4l-3.4-3.2', '#9fe4ff', 2.2),
            line('M16 8.4l3.4-3.2', '#9fe4ff', 2.2),
            line('M16 23.6l-3.4 3.2', '#9fe4ff', 2.2),
            line('M16 23.6l3.4 3.2', '#9fe4ff', 2.2),
          ),
        ),
        s('circle', { cx: '16', cy: '16', r: '2.4', fill: '#dff6ff' }),
      );
    case 'heart':
      return v(
        s('path', { d: 'M16 28S3.4 20.6 3.4 12.6C3.4 8.2 6.8 5 10.8 5c2.5 0 4.3 1.3 5.2 2.7C16.9 6.3 18.7 5 21.2 5c4 0 7.4 3.2 7.4 7.6C28.6 20.6 16 28 16 28z', fill: '#ff4d6d' }),
        s('path', { d: 'M9.4 9.2c-1.6.3-2.6 1.6-2.8 3.2', stroke: '#ffd0d8', 'stroke-width': '1.8', 'stroke-linecap': 'round', fill: 'none' }),
      );
    case 'laugh':
      return v(
        circle('#ffd85e'),
        line('M8.6 12.6c1-1.6 3.2-1.6 4.2 0', '#20160a', 2.2),
        line('M19.2 12.6c1-1.6 3.2-1.6 4.2 0', '#20160a', 2.2),
        s('path', { d: 'M8.8 17.8h14.4c0 4.3-3.2 7.2-7.2 7.2s-7.2-2.9-7.2-7.2z', fill: '#20160a' }),
        s('path', { d: 'M11.4 23.6c1.3-1 7.9-1 9.2 0-1.2 1-7.9 1-9.2 0z', fill: '#ff5470' }),
        s('circle', { cx: '26.4', cy: '19.6', r: '2.6', fill: '#63c8ff' }),
      );
    case 'eyes':
      return v(
        s('ellipse', { cx: '10.4', cy: '16', rx: '7.2', ry: '8.4', fill: '#f7f9fd' }),
        s('ellipse', { cx: '21.6', cy: '16', rx: '7.2', ry: '8.4', fill: '#f7f9fd' }),
        s('circle', { cx: '12.4', cy: '16.6', r: '3.6', fill: '#1b2438' }),
        s('circle', { cx: '23.6', cy: '16.6', r: '3.6', fill: '#1b2438' }),
        s('circle', { cx: '13.6', cy: '15.2', r: '1.2', fill: '#ffffff' }),
        s('circle', { cx: '24.8', cy: '15.2', r: '1.2', fill: '#ffffff' }),
      );
    default:
      return v(circle('#ffd85e'));
  }
}

export const REACTION_ORDER: ReactionKind[] = [
  'fire',
  'laugh',
  'shock',
  'money',
  'clap',
  'skull',
  'cold',
  'clown',
];

export const REACTION_LABEL: Record<ReactionKind, string> = {
  fire: 'Heater',
  skull: 'Dead',
  clown: 'Clown',
  money: 'Ship it',
  shock: 'Wow',
  clap: 'Nice',
  cold: 'Ice cold',
  heart: 'Love',
  laugh: 'LOL',
  eyes: 'Watching',
};
