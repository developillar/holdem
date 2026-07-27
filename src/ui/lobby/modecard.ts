/**
 * ROYALE — lobby/modecard.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The four ways to play, as physical cards rather than a segmented control.
 * Each one gets its own art treatment — a spade cut from gold, four fanned
 * PLO cards, a tournament ladder, a detonation — so the grid reads as four
 * different *places*, not four labels.
 *
 * Selection is a spring: the chosen card lifts, its hairline turns gold, an
 * inner bloom fades up and a check seal pops in. The others recede.
 *
 *   const sel = ModeSelector({ value: 'nlhe', onChange: (m) => …, });
 *   sel.setLive({ nlhe: 4820, plo4: 1190, sng: 640, bomb: 310 });
 */
import { h } from '../dom.ts';
import { icon } from '../components/icons.ts';
import { haptic, pressFeedback } from '../components/util.ts';
import { compactCount } from './data.ts';

export type LobbyMode = 'nlhe' | 'plo4' | 'sng' | 'bomb';

export interface ModeSelectorOpts {
  value?: LobbyMode;
  onChange(mode: LobbyMode): void;
}

export interface ModeSelectorEl extends HTMLElement {
  setValue(mode: LobbyMode, silent?: boolean): void;
  setLive(counts: Record<LobbyMode, number>): void;
  value(): LobbyMode;
}

interface ModeDef {
  id: LobbyMode;
  label: string;
  line2?: string;
  blurb: string;
  art(): SVGSVGElement;
}

// ── artwork ──────────────────────────────────────────────────────────

function svg(...kids: Node[]): SVGSVGElement {
  return h(
    'svg',
    { class: 'md__art', attrs: { viewBox: '0 0 120 80', 'aria-hidden': 'true', focusable: 'false' } },
    ...kids,
  );
}

function grad(id: string, a: string, b: string, c?: string): SVGElement {
  return h(
    'defs',
    null,
    h('linearGradient', { attrs: { id, x1: '0', y1: '0', x2: '0.5', y2: '1' } },
      h('stop', { attrs: { offset: '0', 'stop-color': a } }),
      h('stop', { attrs: { offset: c ? '0.5' : '1', 'stop-color': b } }),
      c ? h('stop', { attrs: { offset: '1', 'stop-color': c } }) : null,
    ),
  );
}

function holdemArt(): SVGSVGElement {
  return svg(
    grad('md-g1', '#fdf3d0', '#edc96b', '#94690f'),
    h('circle', { attrs: { cx: 86, cy: 30, r: 30, fill: 'rgba(237,201,107,0.09)' } }),
    h('circle', { attrs: { cx: 86, cy: 30, r: 20, fill: 'rgba(237,201,107,0.07)' } }),
    h('g', { attrs: { transform: 'translate(60 12) rotate(-9)' } },
      h('rect', { attrs: { x: 0, y: 0, width: 34, height: 48, rx: 6, fill: '#161b28', stroke: 'rgba(255,255,255,0.16)' } }),
      h('rect', { attrs: { x: 2.4, y: 2.4, width: 29.2, height: 43.2, rx: 4.2, fill: 'none', stroke: 'url(#md-g1)', 'stroke-width': 0.8, opacity: 0.5 } }),
      h('path', { attrs: { transform: 'translate(9 13) scale(0.68)', d: 'M12 3.4c3.15 3.4 6.9 5.6 6.9 9.1a3.7 3.7 0 01-6.15 2.75c.2 2 .8 3.4 1.7 4.2H9.55c.9-.8 1.5-2.2 1.7-4.2A3.7 3.7 0 015.1 12.5c0-3.5 3.75-5.7 6.9-9.1z', fill: 'url(#md-g1)' } }),
    ),
    h('g', { attrs: { transform: 'translate(82 18) rotate(11)' } },
      h('rect', { attrs: { x: 0, y: 0, width: 34, height: 48, rx: 6, fill: '#1e2433', stroke: 'rgba(255,255,255,0.2)' } }),
      h('rect', { attrs: { x: 2.4, y: 2.4, width: 29.2, height: 43.2, rx: 4.2, fill: 'none', stroke: 'url(#md-g1)', 'stroke-width': 0.8, opacity: 0.62 } }),
      h('text', { attrs: { x: 17, y: 30, 'text-anchor': 'middle', fill: 'url(#md-g1)', 'font-size': 20, 'font-weight': 700, 'font-family': 'system-ui, sans-serif' } }, 'A'),
    ),
  );
}

function ploArt(): SVGSVGElement {
  const cards = [-24, -8, 8, 24].map((rot, i) =>
    h('g', { attrs: { transform: `rotate(${rot} 86 74) translate(${72 + i * 0.4} ${24 + Math.abs(i - 1.5) * 1.5})` } },
      h('rect', { attrs: { x: 0, y: 0, width: 28, height: 40, rx: 5, fill: i % 2 ? '#152233' : '#101827', stroke: 'rgba(120,190,255,0.32)' } }),
      h('rect', { attrs: { x: 2, y: 2, width: 24, height: 36, rx: 3.6, fill: 'none', stroke: 'url(#md-g2)', 'stroke-width': 0.8, opacity: 0.55 } }),
      h('circle', { attrs: { cx: 14, cy: 20, r: 4.6, fill: 'url(#md-g2)', opacity: 0.9 } }),
    ),
  );
  return svg(
    grad('md-g2', '#bfe0ff', '#3d8bfd', '#1c4fa8'),
    h('circle', { attrs: { cx: 86, cy: 34, r: 30, fill: 'rgba(61,139,253,0.1)' } }),
    ...cards,
  );
}

function sngArt(): SVGSVGElement {
  return svg(
    grad('md-g3', '#f6e0a0', '#a78bfa', '#5b3fc4'),
    h('circle', { attrs: { cx: 86, cy: 34, r: 30, fill: 'rgba(167,139,250,0.12)' } }),
    ...[0, 1, 2].map((i) =>
      h('rect', {
        attrs: {
          x: 62 + i * 16, y: 62 - (i === 1 ? 34 : i === 0 ? 20 : 26),
          width: 13, height: (i === 1 ? 34 : i === 0 ? 20 : 26), rx: 3,
          fill: i === 1 ? 'url(#md-g3)' : 'rgba(167,139,250,0.28)',
          stroke: 'rgba(255,255,255,0.16)',
        },
      }),
    ),
    h('path', { attrs: { transform: 'translate(78 4) scale(0.82)', d: 'M8 3.8h8v5.6a4 4 0 01-8 0V3.8z', fill: 'url(#md-g3)' } }),
    h('path', { attrs: { transform: 'translate(78 4) scale(0.82)', d: 'M8 5.4H5.5A1.5 1.5 0 004 6.9c0 2.4 1.8 4.3 4.2 4.6M16 5.4h2.5A1.5 1.5 0 0120 6.9c0 2.4-1.8 4.3-4.2 4.6', fill: 'none', stroke: 'url(#md-g3)', 'stroke-width': 1.8, 'stroke-linecap': 'round' } }),
  );
}

function bombArt(): SVGSVGElement {
  return svg(
    grad('md-g4', '#ffd9a8', '#ff8a3d', '#c2410c'),
    h('circle', { attrs: { cx: 86, cy: 34, r: 31, fill: 'rgba(255,138,61,0.13)' } }),
    ...[0, 1, 2].map((i) =>
      h('circle', {
        attrs: {
          cx: 86, cy: 34, r: 12 + i * 10, fill: 'none',
          stroke: 'url(#md-g4)', 'stroke-width': 1.8 - i * 0.4,
          opacity: (0.62 - i * 0.16).toFixed(2),
          'stroke-dasharray': i ? '4 6' : 'none',
        },
      }),
    ),
    h('path', {
      attrs: {
        transform: 'translate(72 18) scale(1.18)',
        d: 'M12.4 2.4c.2 2.9 2.1 4.3 3.9 6.1 2 2 3.2 3.9 3.2 6.2a7.5 7.5 0 01-15 0c0-1.7.6-3.4 1.8-4.8.1 1.1.7 2 1.6 2.5-.5-3.7 1.3-7.4 4.5-10z',
        fill: 'url(#md-g4)',
      },
    }),
  );
}

const MODES: ModeDef[] = [
  { id: 'nlhe', label: "No Limit", line2: "Hold'em", blurb: 'The classic', art: holdemArt },
  { id: 'plo4', label: 'Pot Limit', line2: 'Omaha 4', blurb: 'Four cards, big pots', art: ploArt },
  { id: 'sng', label: 'Sit &', line2: 'Go', blurb: '9 seats, one winner', art: sngArt },
  { id: 'bomb', label: 'Bomb', line2: 'Pot', blurb: 'Ante up, see a flop', art: bombArt },
];

function sealMark(): SVGSVGElement {
  return h(
    'svg',
    { class: 'md__sealic', attrs: { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' } },
    h('path', {
      attrs: {
        d: 'M4.6 12.6l4.9 4.9L19.4 7',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 3.2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      },
    }),
  );
}

export function ModeSelector(opts: ModeSelectorOpts): ModeSelectorEl {
  let current: LobbyMode = opts.value ?? 'nlhe';
  const cards = new Map<LobbyMode, { el: HTMLButtonElement; live: HTMLElement }>();

  const el = h('div', {
    class: 'md',
    role: 'radiogroup',
    'aria-label': 'Game mode',
  }) as ModeSelectorEl;

  for (const def of MODES) {
    const live = h('span', { class: 'md__live tnum' }, '—');
    const card = h(
      'button',
      {
        class: `md__card md__card--${def.id}`,
        type: 'button',
        role: 'radio',
        'aria-checked': def.id === current ? 'true' : 'false',
        'aria-label': `${def.label} ${def.line2 ?? ''}`.trim(),
      },
      h('span', { class: 'md__glow', 'aria-hidden': 'true' }),
      h('span', { class: 'md__artwrap', 'aria-hidden': 'true' }, def.art()),
      h(
        'span',
        { class: 'md__copy' },
        h('span', { class: 'md__label' }, def.label, def.line2 ? h('b', null, def.line2) : null),
        h('span', { class: 'md__blurb' }, def.blurb),
      ),
      h('span', { class: 'md__foot' }, h('i', { class: 'md__pulse', 'aria-hidden': 'true' }), live, ' playing'),
      h('span', { class: 'md__seal', 'aria-hidden': 'true' }, sealMark()),
      h('span', { class: 'md__edge', 'aria-hidden': 'true' }),
    );
    pressFeedback(card);
    card.addEventListener('click', () => {
      if (current === def.id) {
        haptic('tick');
        return;
      }
      select(def.id, false);
      haptic('select');
    });
    cards.set(def.id, { el: card, live });
    el.appendChild(card);
  }

  function select(mode: LobbyMode, silent: boolean): void {
    current = mode;
    for (const [id, c] of cards) {
      const on = id === mode;
      c.el.classList.toggle('is-on', on);
      c.el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (!silent) opts.onChange(mode);
  }

  el.setValue = (mode, silent = true) => select(mode, silent);
  el.setLive = (counts) => {
    for (const [id, c] of cards) c.live.textContent = compactCount(counts[id] ?? 0);
  };
  el.value = () => current;

  select(current, true);
  return el;
}

/** Small helper the lobby uses for its section header. */
export function modeLabel(mode: LobbyMode): string {
  switch (mode) {
    case 'nlhe':
      return "No Limit Hold'em";
    case 'plo4':
      return 'Pot Limit Omaha';
    case 'sng':
      return 'Sit & Go';
    case 'bomb':
      return 'Bomb Pot';
  }
}

/** The icon that marks a mode in dense contexts (rows, pills). */
export function modeIcon(mode: LobbyMode, size = 14): SVGSVGElement {
  switch (mode) {
    case 'nlhe':
      return icon('spade', { size, solid: true });
    case 'plo4':
      return icon('cards', { size });
    case 'sng':
      return icon('trophy', { size });
    case 'bomb':
      return icon('flame', { size, solid: true });
  }
}
