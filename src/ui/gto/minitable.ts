/**
 * ROYALE — ui/gto/minitable.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The drill table. Not the 3D stage — a compact DOM diagram whose only job is
 * to answer three questions at a glance: where am I, what happened, and what
 * is in the middle.
 *
 * Seats sit on an ellipse with hero pinned to the bottom centre, so the same
 * component works for 6 and 9 handed without a second layout. Folded seats
 * drop to 34% opacity and lose their ring; the seat that just acted keeps a
 * gold hairline and its action badge. The felt itself is four stacked
 * gradients (rail, bevel, cloth, vignette) because a flat green rectangle
 * reads as a wireframe.
 */

import { h, cx, clear } from '../dom.ts';
import type { PositionName } from '../../core/types.ts';
import type { Spot, SpotSeat } from '../../gto/drills.ts';
import { positionLabel } from '../../gto/ranges.ts';
import { BoardRow } from './cards.ts';

export interface MiniTableEl extends HTMLElement {
  update(spot: Spot): void;
}

interface SeatNodes {
  root: HTMLElement;
  stack: HTMLElement;
  tag: HTMLElement;
  chips: HTMLElement;
}

export function MiniTable(spot: Spot): MiniTableEl {
  const felt = h(
    'div',
    { class: 'tg-felt', 'aria-hidden': 'true' },
    h('span', { class: 'tg-felt__rail' }),
    h('span', { class: 'tg-felt__cloth' }),
    h('span', { class: 'tg-felt__glow' }),
    h('span', { class: 'tg-felt__line' }),
  );

  const potEl = h('div', { class: 'tg-pot' },
    h('span', { class: 'tg-pot__label caps' }, 'Pot'),
    h('span', { class: 'tg-pot__value tnum' }, ''),
  );
  const boardWrap = h('div', { class: 'tg-tableboard' });
  const centre = h('div', { class: 'tg-centre' }, potEl, boardWrap);
  const seatLayer = h('div', { class: 'tg-seats' });

  const el = h('div', { class: 'tg-table' }, felt, seatLayer, centre) as unknown as MiniTableEl;
  const seatNodes = new Map<PositionName, SeatNodes>();

  const layout = (seats: SpotSeat[], heroPos: PositionName): void => {
    clear(seatLayer);
    seatNodes.clear();
    const n = seats.length;
    const heroIdx = seats.findIndex((s) => s.pos === heroPos);
    for (let i = 0; i < n; i++) {
      const seat = seats[i];
      // Hero sits at the bottom; the seats that act after them run up the
      // right-hand side, which is how every poker client lays a table out.
      const rel = (i - heroIdx + n) % n;
      const angle = Math.PI / 2 - (rel * 2 * Math.PI) / n;
      const x = 50 + 46 * Math.cos(angle);
      const y = 50 + 40 * Math.sin(angle);

      const stack = h('span', { class: 'tg-seat__stack tnum' });
      const tag = h('span', { class: 'tg-seat__tag' });
      const chips = h('span', { class: 'tg-seat__chips tnum' });
      const root = h(
        'div',
        {
          class: cx('tg-seat', seat.hero && 'is-hero'),
          style: { left: `${x}%`, top: `${y}%`, '--i': String(rel) },
        },
        h('span', { class: 'tg-seat__ring', 'aria-hidden': 'true' }),
        h('span', { class: 'tg-seat__pos' }, positionLabel(seat.pos)),
        stack,
        tag,
        chips,
      );
      seatLayer.appendChild(root);
      seatNodes.set(seat.pos, { root, stack, tag, chips });
    }
  };

  const paint = (s: Spot): void => {
    if (seatNodes.size !== s.seats.length || !seatNodes.has(s.heroPos)) layout(s.seats, s.heroPos);
    el.dataset.seats = String(s.seats.length);
    for (const seat of s.seats) {
      const nodes = seatNodes.get(seat.pos);
      if (!nodes) continue;
      nodes.root.classList.toggle('is-folded', seat.folded);
      nodes.root.classList.toggle('is-hero', seat.hero);
      nodes.root.classList.toggle('is-live', !seat.folded && !seat.hero && seat.committedBb > 0);
      nodes.stack.textContent = `${fmtBb(seat.stackBb)}`;
      nodes.tag.textContent = seat.tag ?? '';
      nodes.tag.classList.toggle('is-on', !!seat.tag);
      const committed = seat.committedBb;
      nodes.chips.textContent = committed > 0 ? fmtBb(committed) : '';
      nodes.chips.classList.toggle('is-on', committed > 0);
    }
    potEl.querySelector('.tg-pot__value')!.textContent = `${fmtBb(s.potBb)}`;
    clear(boardWrap);
    if (s.board.length) boardWrap.appendChild(BoardRow(s.board, { size: 'sm' }));
    el.classList.toggle('has-board', s.board.length > 0);
  };

  el.update = paint;
  paint(spot);
  return el;
}

function fmtBb(v: number): string {
  if (v >= 100) return `${Math.round(v)}`;
  if (v >= 10) return v.toFixed(v % 1 === 0 ? 0 : 1);
  return v.toFixed(v % 1 === 0 ? 0 : 1);
}

/** The action history as a compact, readable ledger. */
export function ActionLog(spot: Spot): HTMLElement {
  const el = h('div', { class: 'tg-log' });
  const shown = spot.history.filter((s) => s.kind !== 'fold').slice(-5);
  const folded = spot.history.filter((s) => s.kind === 'fold').length;
  if (folded > 0) {
    el.appendChild(
      h('div', { class: 'tg-log__row is-quiet' },
        h('span', { class: 'tg-log__pos' }, '—'),
        h('span', { class: 'tg-log__txt' }, `${folded} fold${folded === 1 ? '' : 's'}`),
      ),
    );
  }
  for (const step of shown) {
    el.appendChild(
      h('div', { class: cx('tg-log__row', `is-${step.kind}`) },
        h('span', { class: 'tg-log__pos' }, positionLabel(step.pos)),
        h('span', { class: 'tg-log__txt' }, step.text),
      ),
    );
  }
  if (!el.childNodes.length) {
    el.appendChild(
      h('div', { class: 'tg-log__row is-quiet' },
        h('span', { class: 'tg-log__pos' }, '—'),
        h('span', { class: 'tg-log__txt' }, 'No action yet'),
      ),
    );
  }
  return el;
}
