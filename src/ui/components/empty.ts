/**
 * ROYALE — components/empty.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Empty states with real, hand-drawn illustrations — never a lonely icon and
 * never an apology. Each scene is inline SVG built from the token palette:
 * a warm halo, the object, and a contact shadow so it sits on the surface.
 *
 *   EmptyState({
 *     art: 'cards',
 *     title: 'No hands yet tonight',
 *     body: 'Take a seat and your history starts filling in.',
 *     actionLabel: 'Find a table',
 *     onAction: () => nav('lobby'),
 *   })
 *
 * Art keys: 'cards' · 'chips' · 'feed' · 'store' · 'search' · 'trophy'
 *           · 'stats' · 'lock'
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { Button } from './button.ts';
import { uid } from './util.ts';

export type EmptyArt = 'cards' | 'chips' | 'feed' | 'store' | 'search' | 'trophy' | 'stats' | 'lock';

const GOLD = ['#fdf3d0', '#edc96b', '#94690f'];
const SLATE = ['#2b3447', '#161b28'];

function defs(id: string): SVGElement {
  return h(
    'defs',
    null,
    h('linearGradient', { attrs: { id: `${id}-c`, x1: '0', y1: '0', x2: '0.35', y2: '1' } },
      h('stop', { attrs: { offset: '0', 'stop-color': SLATE[0] } }),
      h('stop', { attrs: { offset: '1', 'stop-color': SLATE[1] } }),
    ),
    h('linearGradient', { attrs: { id: `${id}-g`, x1: '0', y1: '0', x2: '0.9', y2: '1' } },
      h('stop', { attrs: { offset: '0', 'stop-color': GOLD[0] } }),
      h('stop', { attrs: { offset: '0.48', 'stop-color': GOLD[1] } }),
      h('stop', { attrs: { offset: '1', 'stop-color': GOLD[2] } }),
    ),
    h('radialGradient', { attrs: { id: `${id}-h`, cx: '0.5', cy: '0.5', r: '0.5' } },
      h('stop', { attrs: { offset: '0', 'stop-color': GOLD[1], 'stop-opacity': '0.24' } }),
      h('stop', { attrs: { offset: '0.62', 'stop-color': GOLD[1], 'stop-opacity': '0.06' } }),
      h('stop', { attrs: { offset: '1', 'stop-color': GOLD[1], 'stop-opacity': '0' } }),
    ),
  );
}

function card(id: string, x: number, y: number, rot: number, w = 42, ht = 60): SVGElement {
  return h(
    'g',
    { attrs: { transform: `rotate(${rot} ${x + w / 2} ${y + ht}) translate(${x} ${y})` } },
    h('rect', { attrs: { x: 0, y: 0, width: w, height: ht, rx: 7, fill: `url(#${id}-c)`, stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 1 } }),
    h('rect', { attrs: { x: 2.5, y: 2.5, width: w - 5, height: ht - 5, rx: 5, fill: 'none', stroke: `url(#${id}-g)`, 'stroke-width': 0.9, opacity: 0.5 } }),
    h('path', {
      attrs: {
        transform: `translate(${w / 2 - 8} ${ht / 2 - 9}) scale(0.68)`,
        d: 'M12 3.4c3.15 3.4 6.9 5.6 6.9 9.1a3.7 3.7 0 01-6.15 2.75c.2 2 .8 3.4 1.7 4.2H9.55c.9-.8 1.5-2.2 1.7-4.2A3.7 3.7 0 015.1 12.5c0-3.5 3.75-5.7 6.9-9.1z',
        fill: `url(#${id}-g)`,
        opacity: 0.9,
      },
    }),
  );
}

function scene(id: string, ...kids: (SVGElement | null)[]): SVGSVGElement {
  return h(
    'svg',
    { class: 'r-empty__art', attrs: { viewBox: '0 0 176 136', width: 176, height: 136, 'aria-hidden': 'true', focusable: 'false' } },
    defs(id),
    h('ellipse', { attrs: { cx: 88, cy: 66, rx: 78, ry: 60, fill: `url(#${id}-h)` } }),
    ...kids,
    h('ellipse', { attrs: { cx: 88, cy: 122, rx: 44, ry: 5.5, fill: '#03050a', opacity: 0.5 } }),
  );
}

function art(kind: EmptyArt): SVGSVGElement {
  const id = uid('art');
  switch (kind) {
    case 'cards':
      return scene(id, card(id, 46, 46, -19), card(id, 88, 46, 19), card(id, 67, 40, 0, 44, 66));
    case 'chips':
      return scene(
        id,
        ...[0, 1, 2, 3].map((i) =>
          h('g', { attrs: { transform: `translate(0 ${-i * 11})` } },
            h('ellipse', { attrs: { cx: 88, cy: 106, rx: 34, ry: 12.5, fill: `url(#${id}-c)`, stroke: 'rgba(255,255,255,0.13)' } }),
            h('ellipse', { attrs: { cx: 88, cy: 103.5, rx: 34, ry: 12.5, fill: i === 3 ? `url(#${id}-g)` : 'rgba(43,52,71,0.96)', stroke: 'rgba(255,255,255,0.16)' } }),
            i === 3 ? h('ellipse', { attrs: { cx: 88, cy: 103.5, rx: 19, ry: 6.8, fill: 'none', stroke: 'rgba(11,14,22,0.5)', 'stroke-width': 2 } }) : null,
          ),
        ),
      );
    case 'feed':
      return scene(
        id,
        h('rect', { attrs: { x: 40, y: 40, width: 96, height: 66, rx: 12, fill: `url(#${id}-c)`, stroke: 'rgba(255,255,255,0.13)' } }),
        h('circle', { attrs: { cx: 58, cy: 60, r: 9, fill: `url(#${id}-g)`, opacity: 0.85 } }),
        h('rect', { attrs: { x: 73, y: 54, width: 46, height: 5, rx: 2.5, fill: 'rgba(255,255,255,0.22)' } }),
        h('rect', { attrs: { x: 73, y: 63, width: 28, height: 5, rx: 2.5, fill: 'rgba(255,255,255,0.12)' } }),
        h('rect', { attrs: { x: 52, y: 80, width: 72, height: 5, rx: 2.5, fill: 'rgba(255,255,255,0.1)' } }),
        h('rect', { attrs: { x: 52, y: 90, width: 44, height: 5, rx: 2.5, fill: 'rgba(255,255,255,0.07)' } }),
        h('path', { attrs: { d: 'M128 24l2.6 7.4 7.4 2.6-7.4 2.6-2.6 7.4-2.6-7.4-7.4-2.6 7.4-2.6L128 24z', fill: `url(#${id}-g)` } }),
      );
    case 'store':
      return scene(
        id,
        h('path', { attrs: { d: 'M58 52h60l6 54a8 8 0 01-8 9H60a8 8 0 01-8-9l6-54z', fill: `url(#${id}-c)`, stroke: 'rgba(255,255,255,0.14)' } }),
        h('path', { attrs: { d: 'M73 56V44a15 15 0 0130 0v12', fill: 'none', stroke: `url(#${id}-g)`, 'stroke-width': 3.4, 'stroke-linecap': 'round' } }),
        h('path', { attrs: { d: 'M88 70l14 10-5.4 16.5H79.4L74 80l14-10z', fill: `url(#${id}-g)`, opacity: 0.92 } }),
      );
    case 'search':
      return scene(
        id,
        ...[0, 1, 2].map((r) =>
          h('g', null,
            ...[0, 1, 2, 3].map((c) =>
              h('circle', { attrs: { cx: 52 + c * 24, cy: 46 + r * 24, r: 2.4, fill: 'rgba(255,255,255,0.14)' } }),
            ),
          ),
        ),
        h('circle', { attrs: { cx: 82, cy: 66, r: 26, fill: 'rgba(12,16,26,0.72)', stroke: `url(#${id}-g)`, 'stroke-width': 3.6 } }),
        h('path', { attrs: { d: 'M101 85l16 16', stroke: `url(#${id}-g)`, 'stroke-width': 6, 'stroke-linecap': 'round' } }),
        h('path', { attrs: { d: 'M70 58a17 17 0 0110-8', stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 2.6, 'stroke-linecap': 'round', fill: 'none' } }),
      );
    case 'trophy':
      return scene(
        id,
        h('path', { attrs: { d: 'M66 34h44v28a22 22 0 01-44 0V34z', fill: `url(#${id}-g)` } }),
        h('path', { attrs: { d: 'M66 40H52a8 8 0 00-8 8c0 12 9 21 22 22M110 40h14a8 8 0 018 8c0 12-9 21-22 22', fill: 'none', stroke: `url(#${id}-g)`, 'stroke-width': 4, 'stroke-linecap': 'round' } }),
        h('rect', { attrs: { x: 82, y: 82, width: 12, height: 16, rx: 3, fill: `url(#${id}-c)`, stroke: 'rgba(255,255,255,0.14)' } }),
        h('path', { attrs: { d: 'M64 116l3-11a5 5 0 015-4h32a5 5 0 015 4l3 11H64z', fill: `url(#${id}-c)`, stroke: 'rgba(255,255,255,0.16)' } }),
        h('path', { attrs: { d: 'M78 46l4.6 9.5 10.4 1.4-7.6 7.2 1.9 10.3L78 69.5 68.7 74.4l1.9-10.3L63 56.9l10.4-1.4L78 46z', fill: 'rgba(9,12,20,0.32)' } }),
      );
    case 'stats':
      return scene(
        id,
        h('rect', { attrs: { x: 36, y: 34, width: 104, height: 76, rx: 12, fill: `url(#${id}-c)`, stroke: 'rgba(255,255,255,0.12)' } }),
        h('path', { attrs: { d: 'M48 96h80', stroke: 'rgba(255,255,255,0.12)', 'stroke-width': 1.6 } }),
        h('path', { attrs: { d: 'M48 78h80M48 60h80', stroke: 'rgba(255,255,255,0.07)', 'stroke-width': 1.4 } }),
        h('path', { attrs: { d: 'M48 92l16-14 13 9 15-20 16 12 20-28', fill: 'none', stroke: `url(#${id}-g)`, 'stroke-width': 3.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }),
        h('circle', { attrs: { cx: 128, cy: 51, r: 4.6, fill: GOLD[0] } }),
      );
    case 'lock':
      return scene(
        id,
        h('path', { attrs: { d: 'M70 60V48a18 18 0 0136 0v12', fill: 'none', stroke: `url(#${id}-g)`, 'stroke-width': 5, 'stroke-linecap': 'round' } }),
        h('rect', { attrs: { x: 54, y: 58, width: 68, height: 54, rx: 14, fill: `url(#${id}-c)`, stroke: 'rgba(255,255,255,0.14)' } }),
        h('path', { attrs: { d: 'M88 74l8 6-3 10h-10l-3-10 8-6z', fill: `url(#${id}-g)` } }),
        h('rect', { attrs: { x: 85.5, y: 88, width: 5, height: 12, rx: 2.5, fill: `url(#${id}-g)` } }),
      );
  }
}

export interface EmptyStateOpts {
  art?: EmptyArt;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** quieter, inline variant for use inside a card */
  compact?: boolean;
  class?: ClassValue;
}

export function EmptyState(opts: EmptyStateOpts): HTMLElement {
  return h(
    'div',
    { class: cx('r-empty', opts.compact && 'is-compact', opts.class), role: 'status' },
    opts.art ? h('div', { class: 'r-empty__artwrap' }, art(opts.art)) : null,
    h('h3', { class: 'r-empty__title' }, opts.title),
    opts.body ? h('p', { class: 'r-empty__body' }, opts.body) : null,
    opts.actionLabel
      ? h(
          'div',
          { class: 'r-empty__cta' },
          Button({ label: opts.actionLabel, variant: 'primary', size: 'md', onTap: () => opts.onAction?.() }),
        )
      : null,
  );
}
