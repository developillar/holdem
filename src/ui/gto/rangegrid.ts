/**
 * ROYALE — ui/gto/rangegrid.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The 13×13 range viewer. This is a tool, not an illustration: every cell is
 * legible at 360px, every number is exact, and tapping a hand tells you its
 * precise mix and combo count.
 *
 * HOW A CELL IS PAINTED
 *   A cell's fill is a stacked gradient built from the action layers, filling
 *   from the bottom. A hand that 3-bets 35% and calls 40% shows 40% teal, then
 *   35% gold, then 25% empty track — so you can read a mixed strategy without
 *   tapping anything. Colours match the frequency bars exactly.
 *
 * GESTURES
 *   Pinch to zoom between 1× and 3.2×, drag to pan when zoomed, double-tap to
 *   snap between fit and 2.2×. A drag never fires a selection, so panning
 *   cannot accidentally change the inspected hand.
 */

import { h, cx, clear } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { COMBOS, HAND_COUNT, handLabel } from '../../gto/ranges.ts';
import type { RangeLayer } from '../../gto/drills.ts';
import { haptic } from '../components/util.ts';

const TONE_VAR: Record<string, string> = {
  aggro: 'var(--tg-aggro)',
  passive: 'var(--tg-passive)',
  call: 'var(--tg-call)',
  jam: 'var(--tg-jam)',
  fold: 'var(--tg-fold)',
};

export interface RangeViewOpts {
  layers: RangeLayer[];
  /** grid index to ring in gold — normally the hand you were just dealt */
  highlight?: number;
  /** starts with this cell inspected */
  selected?: number;
  class?: ClassValue;
  onSelect?(idx: number, layers: RangeLayer[]): void;
}

export interface RangeViewEl extends HTMLElement {
  setLayers(layers: RangeLayer[], highlight?: number): void;
  select(idx: number): void;
}

export function RangeView(opts: RangeViewOpts): RangeViewEl {
  let layers = opts.layers;
  let highlight = opts.highlight ?? -1;
  let selected = opts.selected ?? -1;

  const cells: HTMLButtonElement[] = [];
  const grid = h('div', { class: 'tg-grid', role: 'grid', 'aria-label': 'Range grid' });
  const stage = h('div', { class: 'tg-grid__stage' }, grid);
  const viewport = h('div', { class: 'tg-grid__vp' }, stage);

  const legend = h('div', { class: 'tg-legend' });
  const readout = h('div', { class: 'tg-readout' });
  const inspector = h('div', { class: 'tg-inspect', 'aria-live': 'polite' });

  const el = h('div', { class: cx('tg-range', opts.class) }, legend, viewport, readout, inspector) as unknown as RangeViewEl;

  // ── cells
  for (let i = 0; i < HAND_COUNT; i++) {
    const r = (i / 13) | 0;
    const c = i % 13;
    const btn = h(
      'button',
      {
        class: cx('tg-cell', r === c && 'is-pair', c > r ? 'is-suited' : c < r ? 'is-offsuit' : null),
        type: 'button',
        role: 'gridcell',
        dataset: { idx: String(i) },
        'aria-label': handLabel(i),
      },
      h('span', { class: 'tg-cell__fill', 'aria-hidden': 'true' }),
      h('span', { class: 'tg-cell__txt' }, handLabel(i)),
    ) as HTMLButtonElement;
    cells.push(btn);
    grid.appendChild(btn);
  }

  const paint = (): void => {
    for (let i = 0; i < HAND_COUNT; i++) {
      const btn = cells[i];
      const fill = btn.firstElementChild as HTMLElement;
      let acc = 0;
      const stops: string[] = [];
      for (const layer of layers) {
        const w = Math.max(0, Math.min(1, layer.grid.weights[i]));
        if (w <= 0.004) continue;
        const from = acc * 100;
        acc = Math.min(1, acc + w);
        const to = acc * 100;
        const color = TONE_VAR[layer.tone] ?? TONE_VAR.aggro;
        stops.push(`${color} ${from.toFixed(1)}% ${to.toFixed(1)}%`);
      }
      if (stops.length) {
        fill.style.backgroundImage = `linear-gradient(to top, ${stops.join(', ')}, transparent ${(acc * 100).toFixed(1)}%)`;
        btn.classList.toggle('is-in', acc > 0.5);
        btn.classList.toggle('is-part', acc > 0.004 && acc <= 0.5);
        btn.classList.remove('is-out');
      } else {
        fill.style.backgroundImage = '';
        btn.classList.remove('is-in', 'is-part');
        btn.classList.add('is-out');
      }
      btn.classList.toggle('is-mark', i === highlight);
      btn.classList.toggle('is-sel', i === selected);
    }
    paintLegend();
    paintReadout();
    paintInspector();
  };

  const paintLegend = (): void => {
    clear(legend);
    for (const layer of layers) {
      let combos = 0;
      for (let i = 0; i < HAND_COUNT; i++) combos += layer.grid.weights[i] * COMBOS[i];
      legend.appendChild(
        h(
          'div',
          { class: cx('tg-legend__item', `is-${layer.tone}`) },
          h('span', { class: 'tg-legend__sw', 'aria-hidden': 'true' }),
          h('span', { class: 'tg-legend__lbl' }, layer.label),
          h('span', { class: 'tg-legend__pct tnum' }, `${((combos / 1326) * 100).toFixed(1)}%`),
        ),
      );
    }
  };

  const paintReadout = (): void => {
    clear(readout);
    let total = 0;
    for (const layer of layers) {
      for (let i = 0; i < HAND_COUNT; i++) total += layer.grid.weights[i] * COMBOS[i];
    }
    readout.append(
      stat(`${total.toFixed(0)}`, 'combos'),
      stat(`${((total / 1326) * 100).toFixed(1)}%`, 'of all hands'),
      stat(`${countHands(layers)}`, 'hand classes'),
    );
  };

  const paintInspector = (): void => {
    clear(inspector);
    if (selected < 0) {
      inspector.appendChild(
        h('p', { class: 'tg-inspect__hint' }, 'Tap any hand to see its exact mix. Pinch to zoom.'),
      );
      return;
    }
    const label = handLabel(selected);
    const combos = COMBOS[selected];
    const rows = h('div', { class: 'tg-inspect__rows' });
    let used = 0;
    for (const layer of layers) {
      const w = layer.grid.weights[selected];
      used += w;
      rows.appendChild(
        h(
          'div',
          { class: cx('tg-inspect__row', `is-${layer.tone}`) },
          h('span', { class: 'tg-inspect__sw', 'aria-hidden': 'true' }),
          h('span', { class: 'tg-inspect__lbl' }, layer.label),
          h('span', { class: 'tg-inspect__bar' }, h('span', { style: { width: `${(w * 100).toFixed(1)}%` } })),
          h('span', { class: 'tg-inspect__pct tnum' }, `${(w * 100).toFixed(0)}%`),
          h('span', { class: 'tg-inspect__cmb tnum' }, `${(w * combos).toFixed(1)}`),
        ),
      );
    }
    const fold = Math.max(0, 1 - used);
    rows.appendChild(
      h(
        'div',
        { class: 'tg-inspect__row is-fold' },
        h('span', { class: 'tg-inspect__sw', 'aria-hidden': 'true' }),
        h('span', { class: 'tg-inspect__lbl' }, 'Fold'),
        h('span', { class: 'tg-inspect__bar' }, h('span', { style: { width: `${(fold * 100).toFixed(1)}%` } })),
        h('span', { class: 'tg-inspect__pct tnum' }, `${(fold * 100).toFixed(0)}%`),
        h('span', { class: 'tg-inspect__cmb tnum' }, `${(fold * combos).toFixed(1)}`),
      ),
    );

    inspector.append(
      h(
        'div',
        { class: 'tg-inspect__head' },
        h('span', { class: 'tg-inspect__hand' }, label),
        h('span', { class: 'tg-inspect__meta' }, `${combos} combos`),
      ),
      rows,
    );
  };

  // ── selection
  grid.addEventListener('click', (ev) => {
    if (dragged) return;
    const target = (ev.target as HTMLElement).closest<HTMLElement>('.tg-cell');
    if (!target) return;
    const idx = Number(target.dataset.idx);
    if (!Number.isFinite(idx)) return;
    selected = selected === idx ? -1 : idx;
    haptic('tick');
    paint();
    opts.onSelect?.(selected, layers);
  });

  // ── pinch / pan / double-tap
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragged = false;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchStart = 0;
  let scaleStart = 1;
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 };
  let lastTap = 0;

  const apply = (): void => {
    const max = (scale - 1) * 0.5;
    tx = Math.max(-max * viewport.clientWidth, Math.min(max * viewport.clientWidth, tx));
    ty = Math.max(-max * viewport.clientHeight, Math.min(max * viewport.clientHeight, ty));
    stage.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
    viewport.classList.toggle('is-zoomed', scale > 1.02);
  };

  viewport.addEventListener('pointerdown', (ev) => {
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      scaleStart = scale;
    } else if (pointers.size === 1) {
      panStart = { x: ev.clientX, y: ev.clientY, tx, ty };
    }
  });

  viewport.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart > 0) {
        scale = Math.max(1, Math.min(3.2, (scaleStart * dist) / pinchStart));
        dragged = true;
        apply();
      }
      return;
    }
    if (scale > 1.02) {
      const dx = ev.clientX - panStart.x;
      const dy = ev.clientY - panStart.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) dragged = true;
      tx = panStart.tx + dx;
      ty = panStart.ty + dy;
      apply();
    }
  }, { passive: true });

  const release = (ev: PointerEvent): void => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchStart = 0;
    if (pointers.size === 0 && !dragged) {
      const now = performance.now();
      if (now - lastTap < 320) {
        scale = scale > 1.5 ? 1 : 2.2;
        if (scale === 1) {
          tx = 0;
          ty = 0;
        }
        apply();
        haptic('select');
        lastTap = 0;
      } else {
        lastTap = now;
      }
    }
  };
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);

  el.setLayers = (next, mark) => {
    layers = next;
    if (mark !== undefined) highlight = mark;
    paint();
  };
  el.select = (idx) => {
    selected = idx;
    paint();
  };

  paint();
  return el;
}

function stat(value: string, label: string): HTMLElement {
  return h(
    'div',
    { class: 'tg-readout__i' },
    h('span', { class: 'tg-readout__v tnum' }, value),
    h('span', { class: 'tg-readout__l caps' }, label),
  );
}

function countHands(layers: RangeLayer[]): number {
  let n = 0;
  for (let i = 0; i < HAND_COUNT; i++) {
    let any = false;
    for (const l of layers) if (l.grid.weights[i] > 0.004) any = true;
    if (any) n++;
  }
  return n;
}
