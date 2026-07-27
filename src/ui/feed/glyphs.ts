/**
 * ROYALE — ui/feed/glyphs.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Every mark the feed draws, as inline SVG. No emoji, no icon font, no images.
 *
 *   reactionGlyph('skull', 22)   → the reaction face/object, in colour
 *   suitPip(2)                   → a filled heart pip for a mini card
 *   kindEmblem('bad-beat')       → the little event badge on a post header
 *   spinnerMark()                → the pull-to-refresh spinner
 *
 * Reaction glyphs are deliberately *illustrations* rather than monochrome
 * icons: a skull is bone-white with dark sockets, a snowflake is ice blue.
 * That colour is what makes a reaction row read at a glance on a dark card,
 * and it is the difference between a real product and a wireframe.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { CardId, FeedEventKind, ReactionKind, Suit } from '../../core/types.ts';
import { cardSuit } from '../../core/types.ts';
import { REACTION_META } from '../../social/reactions.ts';

interface Shape {
  d: string;
  fill?: string;
  stroke?: string;
  /** stroke width on the 24 grid */
  w?: number;
  o?: number;
}

function draw(size: number, shapes: Shape[], klass?: ClassValue, title?: string): SVGSVGElement {
  const svg = h('svg', {
    class: cx('fg', klass),
    attrs: {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      role: title ? 'img' : 'presentation',
      'aria-hidden': title ? null : 'true',
      focusable: 'false',
    },
  });
  if (title) svg.appendChild(h('title', null, title));
  for (const s of shapes) {
    svg.appendChild(
      h('path', {
        attrs: {
          d: s.d,
          fill: s.fill ?? 'none',
          stroke: s.stroke ?? 'none',
          'stroke-width': s.stroke ? s.w ?? 1.6 : null,
          'stroke-linecap': s.stroke ? 'round' : null,
          'stroke-linejoin': s.stroke ? 'round' : null,
          opacity: s.o ?? null,
        },
      }),
    );
  }
  return svg;
}

const INK = '#171226';
const INK_SOFT = 'rgba(23,18,38,0.55)';
const SHEEN = 'rgba(255,255,255,0.55)';

/** Circle path helper — `c(cx, cy, r)`. */
function circle(x: number, y: number, r: number): string {
  return `M${x + r} ${y}a${r} ${r} 0 11-${r * 2} 0 ${r} ${r} 0 01${r * 2} 0z`;
}
/** Ellipse path helper. */
function ellipse(x: number, y: number, rx: number, ry: number): string {
  return `M${x + rx} ${y}a${rx} ${ry} 0 11-${rx * 2} 0 ${rx} ${ry} 0 01${rx * 2} 0z`;
}

function shapesFor(kind: ReactionKind): Shape[] {
  const m = REACTION_META[kind];
  switch (kind) {
    case 'fire':
      return [
        { d: 'M12.7 1.9c.15 3.1-1.6 4.4-3.1 6.1C7.8 9.8 6.4 11.7 6.4 14a5.9 5.9 0 0011.8 0c0-2.4-1.3-4.2-2.9-5.9-1.6-1.7-2.6-3.4-2.6-6.2z', fill: m.tint },
        { d: 'M12.2 11.6c1.5 1.5 2.4 2.7 2.4 4.1a2.7 2.7 0 01-5.4 0c0-1.5 1.3-3 3-4.1z', fill: m.tint2 },
        { d: 'M9.3 5.6c-.2 1.1-.7 2-1.6 2.7', stroke: m.tint2, w: 1.2, o: 0.75 },
      ];
    case 'skull':
      return [
        { d: 'M12 2.3c4.7 0 8.1 3.3 8.1 7.8 0 2.5-1.1 4.4-2.7 5.6v2.2c0 1.1-.9 2-2 2H8.6c-1.1 0-2-.9-2-2v-2.2C5 14.5 3.9 12.6 3.9 10.1 3.9 5.6 7.3 2.3 12 2.3z', fill: m.tint },
        { d: ellipse(8.5, 10.2, 2.05, 2.4), fill: INK },
        { d: ellipse(15.5, 10.2, 2.05, 2.4), fill: INK },
        { d: 'M12 12.9l1.6 2.7h-3.2l1.6-2.7z', fill: INK },
        { d: 'M9.6 17.5v2.4M12 17.5v2.4M14.4 17.5v2.4', stroke: INK, w: 1.1, o: 0.65 },
        { d: 'M7.4 6.2a5.6 5.6 0 013.1-2.1', stroke: SHEEN, w: 1.3, o: 0.5 },
      ];
    case 'clown':
      return [
        { d: circle(5.6, 8.6, 2.9), fill: m.tint },
        { d: circle(18.4, 8.6, 2.9), fill: m.tint },
        { d: circle(12, 12, 8.1), fill: '#f6efe6' },
        { d: 'M9.6 6.6l2.4-4.4 2.4 4.4a6.6 6.6 0 00-4.8 0z', fill: m.tint2 },
        { d: ellipse(9.1, 10.6, 1.1, 1.5), fill: INK },
        { d: ellipse(14.9, 10.6, 1.1, 1.5), fill: INK },
        { d: 'M8.4 14.6a4.4 4.4 0 007.2 0', stroke: INK, w: 1.5 },
        { d: circle(12, 13.1, 2), fill: '#ef4a5f' },
        { d: 'M11.1 12.3a1 1 0 011-.5', stroke: SHEEN, w: 0.9, o: 0.8 },
      ];
    case 'money':
      return [
        { d: 'M3.4 8.2h17.2a1.4 1.4 0 011.4 1.4v8.6a1.4 1.4 0 01-1.4 1.4H3.4A1.4 1.4 0 012 18.2V9.6a1.4 1.4 0 011.4-1.4z', fill: '#177a53', o: 0.75 },
        { d: 'M2.4 4.6h17.2a1.4 1.4 0 011.4 1.4v8.6a1.4 1.4 0 01-1.4 1.4H2.4A1.4 1.4 0 011 14.6V6a1.4 1.4 0 011.4-1.4z', fill: m.tint },
        { d: 'M13.1 7.9h-3.3a1.5 1.5 0 000 3h1.5a1.5 1.5 0 010 3H7.8M10.6 6.2v1.7M10.6 13.9v1.7', stroke: '#06371f', w: 1.7 },
        { d: 'M2.9 6.1h1.6M17.5 13.5h1.6', stroke: '#06371f', w: 1.2, o: 0.45 },
      ];
    case 'shock':
      return [
        { d: circle(12, 12, 9.3), fill: m.tint },
        { d: ellipse(8.7, 10.1, 1.35, 2.1), fill: INK },
        { d: ellipse(15.3, 10.1, 1.35, 2.1), fill: INK },
        { d: 'M6.5 6.4a4 4 0 013.6-.7M17.5 6.4a4 4 0 00-3.6-.7', stroke: INK, w: 1.4, o: 0.8 },
        { d: ellipse(12, 16.2, 2.5, 3.1), fill: INK },
        { d: 'M6.8 5.8a7.6 7.6 0 013.4-2.2', stroke: SHEEN, w: 1.4, o: 0.6 },
      ];
    case 'clap':
      return [
        { d: 'M6.9 8.2l5.1 3-3 5.2a3 3 0 11-5.2-3l3.1-5.2z', fill: m.tint },
        { d: 'M17.1 8.2l-5.1 3 3 5.2a3 3 0 105.2-3l-3.1-5.2z', fill: m.tint2 },
        { d: 'M12 1.9v3M7.4 3.4l1.4 2.6M16.6 3.4l-1.4 2.6', stroke: m.tint, w: 1.6 },
        { d: 'M8.9 10.4l1.6 1M15.1 10.4l-1.6 1', stroke: 'rgba(60,36,8,0.3)', w: 1.1 },
      ];
    case 'laugh':
      return [
        { d: circle(12, 12, 9.3), fill: m.tint },
        { d: 'M6.4 10.4a2.9 2.9 0 014.2 0M13.4 10.4a2.9 2.9 0 014.2 0', stroke: INK, w: 1.7 },
        { d: 'M6.2 13.6h11.6a5.8 5.8 0 01-11.6 0z', fill: INK },
        { d: 'M9 18.4a3.4 3.4 0 016 0 6 6 0 01-6 0z', fill: '#f2647c' },
        { d: 'M3.6 12.4c-1 1.6-1.5 2.6-1.5 3.3a1.5 1.5 0 003 0c0-.7-.5-1.7-1.5-3.3z', fill: '#8fd7ff' },
        { d: 'M20.4 12.4c1 1.6 1.5 2.6 1.5 3.3a1.5 1.5 0 01-3 0c0-.7.5-1.7 1.5-3.3z', fill: '#8fd7ff' },
      ];
    case 'cold':
      return [
        { d: 'M12 2.4v19.2M3.7 7.2l16.6 9.6M20.3 7.2L3.7 16.8', stroke: m.tint, w: 1.7 },
        { d: 'M12 6.1L9.9 4M12 6.1L14.1 4M12 17.9L9.9 20M12 17.9l2.1 2.1', stroke: m.tint, w: 1.5 },
        { d: 'M6.9 9.1l-2.9-.2M6.9 9.1l-.6-2.9M17.1 14.9l2.9.2M17.1 14.9l.6 2.9', stroke: m.tint, w: 1.5 },
        { d: 'M17.1 9.1l2.9-.2M17.1 9.1l.6-2.9M6.9 14.9l-2.9.2M6.9 14.9l-.6 2.9', stroke: m.tint, w: 1.5 },
        { d: circle(12, 12, 1.9), fill: m.tint2 },
      ];
    case 'heart':
      return [
        { d: 'M12 20.8C10.3 19.4 3 14.4 3 9.2A5 5 0 0112 6a5 5 0 019 3.2c0 5.2-7.3 10.2-9 11.6z', fill: m.tint },
        { d: 'M6.6 7.6a3.2 3.2 0 013.1-1.4', stroke: SHEEN, w: 1.5, o: 0.85 },
        { d: 'M12 20.8C10.3 19.4 3 14.4 3 9.2', stroke: 'rgba(120,10,30,0.28)', w: 1.1 },
      ];
    case 'eyes':
      return [
        { d: ellipse(7.4, 12, 4.4, 3.4), fill: '#f4f7ff' },
        { d: ellipse(16.6, 12, 4.4, 3.4), fill: '#f4f7ff' },
        { d: circle(8.5, 12, 1.75), fill: m.tint2 },
        { d: circle(17.7, 12, 1.75), fill: m.tint2 },
        { d: circle(8.5, 12, 0.8), fill: INK },
        { d: circle(17.7, 12, 0.8), fill: INK },
        { d: circle(7.7, 11.2, 0.55), fill: '#ffffff' },
        { d: circle(16.9, 11.2, 0.55), fill: '#ffffff' },
        { d: 'M3.4 10a5 5 0 018-1.4M12.6 10a5 5 0 018-1.4', stroke: INK_SOFT, w: 1.1, o: 0.5 },
      ];
    default:
      return [{ d: circle(12, 12, 8), fill: m.tint }];
  }
}

/** A reaction, drawn at `size` px. */
export function reactionGlyph(kind: ReactionKind, size = 20, klass?: ClassValue): SVGSVGElement {
  return draw(size, shapesFor(kind), cx('fg--react', klass), REACTION_META[kind].label);
}

// ───────────────────────────── suits ─────────────────────────────

const SUIT_PATH: Record<Suit, string> = {
  0: 'M12 2.9a3.75 3.75 0 013.25 5.62A3.75 3.75 0 1113.6 15.1c.16 2.3.92 3.95 2.05 5.1H8.35c1.13-1.15 1.89-2.8 2.05-5.1a3.75 3.75 0 11-1.65-6.58A3.75 3.75 0 0112 2.9z',
  1: 'M12 2.1l8.7 9.9-8.7 9.9-8.7-9.9L12 2.1z',
  2: 'M12 21.2c-.6-.5-9-6.2-9-12.05A5.55 5.55 0 0112 5.9a5.55 5.55 0 019 3.25c0 5.85-8.4 11.55-9 12.05z',
  3: 'M12 2.4c3.35 3.7 7.35 6.05 7.35 9.85A4 4 0 0112.7 15.2c.2 2.15.9 3.7 1.85 4.6H9.45c.95-.9 1.65-2.45 1.85-4.6a4 4 0 01-6.65-2.95c0-3.8 4-6.15 7.35-9.85z',
};

const SUIT_VAR: Record<Suit, string> = {
  0: 'var(--c-suit-c)',
  1: 'var(--c-suit-d)',
  2: 'var(--c-suit-h)',
  3: 'var(--c-suit-s)',
};

export function suitColor(suit: Suit): string {
  return SUIT_VAR[suit];
}

/** A filled suit pip, tinted by the four-colour deck. */
export function suitPip(suit: Suit, size = 10, klass?: ClassValue): SVGSVGElement {
  return draw(size, [{ d: SUIT_PATH[suit], fill: 'currentColor' }], cx('fg--pip', klass));
}

export function cardSuitPip(card: CardId, size = 10): SVGSVGElement {
  return suitPip(cardSuit(card), size);
}

// ───────────────────────────── event emblems ─────────────────────────────

const EMBLEM: Record<FeedEventKind, Shape[]> = {
  'bad-beat': [
    { d: 'M8.4 3.4h7.2a2 2 0 012 2v13.2a2 2 0 01-2 2H8.4a2 2 0 01-2-2V5.4a2 2 0 012-2z', stroke: 'currentColor', w: 1.6 },
    { d: 'M13.6 6.2l-3.4 5.1h3.2l-2.6 6', stroke: 'currentColor', w: 1.6 },
  ],
  'big-win': [
    { d: 'M4.2 15.6c0-1.3 3.5-2.4 7.8-2.4s7.8 1.1 7.8 2.4v2.6c0 1.3-3.5 2.4-7.8 2.4s-7.8-1.1-7.8-2.4v-2.6z', stroke: 'currentColor', w: 1.6 },
    { d: 'M4.2 15.6c0 1.3 3.5 2.4 7.8 2.4s7.8-1.1 7.8-2.4', stroke: 'currentColor', w: 1.4, o: 0.6 },
    { d: 'M6.6 11.4c0-1.1 2.4-2 5.4-2s5.4.9 5.4 2', stroke: 'currentColor', w: 1.5, o: 0.75 },
    { d: 'M12 3.2v4.6M9.8 5.4L12 3.2l2.2 2.2', stroke: 'currentColor', w: 1.6 },
  ],
  bluff: [
    { d: 'M3.2 8.6h17.6v2.5c0 2.9-2.3 5.2-5.2 5.2-1.9 0-3.4-1-4.4-2.6-1 1.6-2.5 2.6-4.4 2.6-2.9 0-5.2-2.3-5.2-5.2V8.6z', stroke: 'currentColor', w: 1.6 },
    { d: 'M6.4 5.4a9 9 0 0111.2 0', stroke: 'currentColor', w: 1.5, o: 0.65 },
  ],
  quads: [
    { d: 'M4.4 4.4h6v6h-6zM13.6 4.4h6v6h-6zM4.4 13.6h6v6h-6zM13.6 13.6h6v6h-6z', stroke: 'currentColor', w: 1.6 },
  ],
  'straight-flush': [
    { d: 'M3.6 19.4l4.2-5.6 3.4 3 4-6.2 5.2 4.4', stroke: 'currentColor', w: 1.8 },
    { d: 'M15.6 4.6h4.8v4.6', stroke: 'currentColor', w: 1.6, o: 0.7 },
  ],
  royal: [
    { d: 'M3.4 8.2l4 2.9L12 5.3l4.6 5.8 4-2.9-1.8 9.4H5.2L3.4 8.2z', stroke: 'currentColor', w: 1.6 },
    { d: 'M5.6 20.4h12.8', stroke: 'currentColor', w: 1.5, o: 0.65 },
  ],
  bounty: [
    { d: circle(12, 12, 8.4), stroke: 'currentColor', w: 1.6 },
    { d: circle(12, 12, 4.2), stroke: 'currentColor', w: 1.5, o: 0.7 },
    { d: circle(12, 12, 1.3), fill: 'currentColor' },
  ],
  'level-up': [
    { d: 'M5.6 13.4L12 7l6.4 6.4', stroke: 'currentColor', w: 1.8 },
    { d: 'M5.6 18.6L12 12.2l6.4 6.4', stroke: 'currentColor', w: 1.6, o: 0.55 },
  ],
  'sng-win': [
    { d: 'M8 3.6h8v5.8a4 4 0 01-8 0V3.6z', stroke: 'currentColor', w: 1.6 },
    { d: 'M8 5.4H5.4A1.5 1.5 0 003.9 6.9c0 2.5 1.9 4.5 4.4 4.8M16 5.4h2.6A1.5 1.5 0 0120.1 6.9c0 2.5-1.9 4.5-4.4 4.8', stroke: 'currentColor', w: 1.5 },
    { d: 'M12 13.6v3.2M8.2 20.4h7.6l-.6-2.4a1.2 1.2 0 00-1.1-.9h-4.2a1.2 1.2 0 00-1.1.9l-.6 2.4z', stroke: 'currentColor', w: 1.5 },
  ],
  'bomb-pot': [
    { d: circle(11, 14.4, 6.4), stroke: 'currentColor', w: 1.6 },
    { d: 'M15.4 9.8l2.4-2.4M17.8 7.4c0-1.8 1.2-3 3-3', stroke: 'currentColor', w: 1.6 },
    { d: 'M7.6 12.4a4.4 4.4 0 012.6-2.2', stroke: 'currentColor', w: 1.4, o: 0.6 },
  ],
  streak: [
    { d: 'M12.4 2.4c.2 2.9 2.1 4.3 3.9 6.1 2 2 3.2 3.9 3.2 6.2a7.5 7.5 0 01-15 0c0-1.7.6-3.4 1.8-4.8.1 1.1.7 2 1.6 2.5-.5-3.7 1.3-7.4 4.5-10z', stroke: 'currentColor', w: 1.6 },
  ],
  'friend-joined': [
    { d: 'M9.6 11.8a3.9 3.9 0 100-7.8 3.9 3.9 0 000 7.8z', stroke: 'currentColor', w: 1.6 },
    { d: 'M2.8 20.2a6.8 6.8 0 0113.6 0', stroke: 'currentColor', w: 1.6 },
    { d: 'M18.6 7.4v5.2M16 10h5.2', stroke: 'currentColor', w: 1.6 },
  ],
  cosmetic: [
    { d: 'M10.8 2.6l1.8 5.2 5.2 1.8-5.2 1.8-1.8 5.2L9 11.4 3.8 9.6 9 7.8l1.8-5.2z', stroke: 'currentColor', w: 1.6 },
    { d: 'M18.2 14.2l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9.9-2.5z', stroke: 'currentColor', w: 1.5, o: 0.7 },
  ],
};

export const KIND_LABEL: Record<FeedEventKind, string> = {
  'bad-beat': 'Bad beat',
  'big-win': 'Big pot',
  bluff: 'Bluff',
  quads: 'Quads',
  'straight-flush': 'Straight flush',
  royal: 'Royal flush',
  bounty: 'Bounty',
  'level-up': 'Level up',
  'sng-win': 'SNG win',
  'bomb-pot': 'Bomb pot',
  streak: 'Heater',
  'friend-joined': 'New player',
  cosmetic: 'Unlock',
};

export function kindEmblem(kind: FeedEventKind, size = 15, klass?: ClassValue): SVGSVGElement {
  return draw(size, EMBLEM[kind] ?? EMBLEM['big-win'], cx('fg--emblem', klass));
}

// ───────────────────────────── misc marks ─────────────────────────────

/** The pull-to-refresh mark: a broken ring with a gold pip on the leading end. */
export function spinnerMark(size = 26): SVGSVGElement {
  const svg = h('svg', {
    class: 'fg fg--spin',
    attrs: { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
  });
  svg.appendChild(
    h('circle', {
      attrs: { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, opacity: 0.16 },
    }),
  );
  svg.appendChild(
    h('path', {
      class: 'fg__arc',
      attrs: {
        d: 'M21 12a9 9 0 00-6.3-8.6',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2.2,
        'stroke-linecap': 'round',
      },
    }),
  );
  svg.appendChild(h('circle', { class: 'fg__pip', attrs: { cx: 12, cy: 3, r: 1.6, fill: 'currentColor' } }));
  return svg;
}

/** Small chevron used by "show more" affordances. */
export function chevron(dir: 'down' | 'up' | 'right', size = 14): SVGSVGElement {
  const d =
    dir === 'down' ? 'M5 9l7 7 7-7' : dir === 'up' ? 'M5 15l7-7 7 7' : 'M9 5l7 7-7 7';
  return draw(size, [{ d, stroke: 'currentColor', w: 2 }]);
}

/** The comment bubble on the action row. */
export function commentMark(size = 17): SVGSVGElement {
  return draw(size, [
    {
      d: 'M20.6 11.9c0 3.8-3.85 6.9-8.6 6.9a10 10 0 01-2.9-.4L4.2 20.4l1.45-3.6a6.7 6.7 0 01-2.25-4.9C3.4 8.1 7.25 5 12 5s8.6 3.1 8.6 6.9z',
      stroke: 'currentColor',
      w: 1.7,
    },
  ]);
}

/**
 * The "add a reaction" mark.
 *
 * This used to render the post's *default* reaction illustration, which meant
 * a big-win post drew the same banknote here that already sat in the leftmost
 * aggregate chip — one mark meaning two different things in a single row.
 * A neutral monoline face is the affordance ("react"), and the gold plus badge
 * on the corner says "add"; the specific reaction stays where it belongs, on
 * the chips and in the long-press picker.
 */
export function reactAddMark(size = 21): SVGSVGElement {
  return draw(size, [
    { d: 'M20.4 12a8.4 8.4 0 11-8.4-8.4', stroke: 'currentColor', w: 1.7 },
    { d: 'M8.6 14.3a4.4 4.4 0 006.8 0', stroke: 'currentColor', w: 1.7 },
    { d: circle(9.1, 9.9, 1.15), fill: 'currentColor' },
    { d: circle(14.9, 9.9, 1.15), fill: 'currentColor' },
  ]);
}

/** Share arrow for the post overflow row. */
export function shareMark(size = 17): SVGSVGElement {
  return draw(size, [
    { d: 'M12 15.2V3.8M8.6 7.2L12 3.8l3.4 3.4', stroke: 'currentColor', w: 1.7 },
    {
      d: 'M6.8 10.9H5.6a1.6 1.6 0 00-1.6 1.6v6.2a1.6 1.6 0 001.6 1.6h12.8a1.6 1.6 0 001.6-1.6v-6.2a1.6 1.6 0 00-1.6-1.6h-1.2',
      stroke: 'currentColor',
      w: 1.7,
    },
  ]);
}

/** Playback transport marks for the replay viewer. */
export function transportMark(name: 'play' | 'pause' | 'prev' | 'next' | 'restart', size = 20): SVGSVGElement {
  switch (name) {
    case 'play':
      return draw(size, [{ d: 'M7.6 4.6l12 7.4-12 7.4V4.6z', fill: 'currentColor' }]);
    case 'pause':
      return draw(size, [
        { d: 'M7.2 4.6h3.4v14.8H7.2zM13.4 4.6h3.4v14.8h-3.4z', fill: 'currentColor' },
      ]);
    case 'prev':
      return draw(size, [
        { d: 'M18.4 5.2v13.6L8.6 12l9.8-6.8z', fill: 'currentColor' },
        { d: 'M6.2 5.2h2.2v13.6H6.2z', fill: 'currentColor' },
      ]);
    case 'next':
      return draw(size, [
        { d: 'M5.6 5.2v13.6L15.4 12 5.6 5.2z', fill: 'currentColor' },
        { d: 'M15.6 5.2h2.2v13.6h-2.2z', fill: 'currentColor' },
      ]);
    default:
      return draw(size, [
        { d: 'M20.2 12a8.2 8.2 0 11-2.5-5.9', stroke: 'currentColor', w: 1.9 },
        { d: 'M20.5 4.8v4.5H16', stroke: 'currentColor', w: 1.9 },
      ]);
  }
}
