/**
 * ROYALE — lobby/stakecard.ts
 * ────────────────────────────────────────────────────────────────────────────
 * One row per stake, but built like a card: a milled tier chip on the left,
 * the blind level set in tight display type, the buy-in range underneath, and
 * a live column carrying players online, average pot and the "juicy table"
 * flame whose intensity tracks how loose the level is playing.
 *
 * Locked levels keep every number visible and swap the action column for a
 * bankroll-cushion meter — the copy explains the rule instead of scolding.
 *
 *   const row = StakeRow({ stake, onOpen, onWatch });
 *   row.update(live, gate);
 */
import { h } from '../dom.ts';
import { icon } from '../components/icons.ts';
import { haptic, pressFeedback } from '../components/util.ts';

import type { Stake } from '../../core/types.ts';
import type { StakeLive } from './data.ts';
import { cash, compactCount } from './data.ts';
import type { StakeGate } from './bankroll.ts';

export interface StakeRowOpts {
  stake: Stake;
  onOpen(stake: Stake): void;
  onWatch(stake: Stake): void;
}

export interface StakeRowEl extends HTMLButtonElement {
  update(live: StakeLive, gate: StakeGate): void;
}

const TIER_TINT: Record<Stake['tier'], string> = {
  micro: '#3d8bfd',
  low: '#22a06b',
  mid: '#a78bfa',
  high: '#edc96b',
};

/** A milled casino chip, drawn to the tier colour. Reused by the table list. */
export function tierChip(tier: Stake['tier'], label: string): SVGSVGElement {
  const tint = TIER_TINT[tier];
  return h(
    'svg',
    { class: 'sk__chip', attrs: { viewBox: '0 0 44 44', 'aria-hidden': 'true', focusable: 'false' } },
    h('defs', null,
      h('linearGradient', { attrs: { id: `sc-${tier}`, x1: '0', y1: '0', x2: '0.35', y2: '1' } },
        h('stop', { attrs: { offset: '0', 'stop-color': tint, 'stop-opacity': '0.95' } }),
        h('stop', { attrs: { offset: '1', 'stop-color': tint, 'stop-opacity': '0.42' } }),
      ),
    ),
    h('circle', { attrs: { cx: 22, cy: 23.2, r: 19.4, fill: 'rgba(3,5,10,0.6)' } }),
    h('circle', { attrs: { cx: 22, cy: 22, r: 19.4, fill: `url(#sc-${tier})`, stroke: 'rgba(255,255,255,0.28)', 'stroke-width': 1 } }),
    // knurled edge segments
    ...Array.from({ length: 8 }, (_, i) => {
      const a0 = (i / 8) * Math.PI * 2;
      const a1 = a0 + Math.PI / 11;
      const R = 19.4;
      return h('path', {
        attrs: {
          d: `M${22 + Math.cos(a0) * R} ${22 + Math.sin(a0) * R} A${R} ${R} 0 0 1 ${22 + Math.cos(a1) * R} ${22 + Math.sin(a1) * R}`,
          stroke: 'rgba(255,255,255,0.6)', 'stroke-width': 3.4, fill: 'none', 'stroke-linecap': 'butt',
        },
      });
    }),
    h('circle', { attrs: { cx: 22, cy: 22, r: 13.4, fill: 'rgba(8,11,18,0.62)', stroke: 'rgba(255,255,255,0.18)', 'stroke-width': 1 } }),
    h('text', {
      attrs: {
        x: 22, y: 26.4, 'text-anchor': 'middle', fill: '#f7f9fd',
        'font-size': 11.4, 'font-weight': 700, 'font-family': 'system-ui, -apple-system, sans-serif',
        'letter-spacing': '-0.4',
      },
    }, label),
    h('path', { attrs: { d: 'M8.6 12.4A19.4 19.4 0 0 1 30 5.4', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1.6, fill: 'none', 'stroke-linecap': 'round' } }),
  );
}

/** Short chip face text: 10¢, 20¢, 50¢, $1, $2, $5 — the big blind. */
export function chipFace(stake: Stake): string {
  return stake.bb < 1 ? `${Math.round(stake.bb * 100)}¢` : `$${stake.bb}`;
}

function flameGlyph(): SVGSVGElement {
  return icon('flame', { size: 13, solid: true });
}

export function StakeRow(opts: StakeRowOpts): StakeRowEl {
  const { stake } = opts;

  const players = h('b', { class: 'tnum' }, '—');
  const trend = h('i', { class: 'sk__trend', 'aria-hidden': 'true' });
  const pot = h('b', { class: 'tnum' }, '—');
  const openSeats = h('span', { class: 'sk__seats tnum' }, '');
  const flame = h(
    'span',
    { class: 'sk__flame', 'aria-hidden': 'true' },
    flameGlyph(),
    h('span', { class: 'sk__flamet caps' }, 'Juicy'),
  );

  const meterFill = h('i', { class: 'sk__meterfill' });
  const lockNote = h('b', { class: 'sk__locknote tnum' }, '—');
  const lockBox = h(
    'div',
    { class: 'sk__lock' },
    h(
      'span',
      { class: 'sk__lockhead' },
      icon('lock', { size: 12, stroke: 2.1 }),
      lockNote,
      h('span', { class: 'sk__locksuf' }, 'to unlock'),
    ),
    h('span', { class: 'sk__meter' }, meterFill),
  );

  const watch = h(
    'button',
    { class: 'sk__watch', type: 'button', 'aria-label': `Watch ${stake.label} from the rail` },
    icon('eye', { size: 15, stroke: 1.9 }),
    h('span', null, 'Rail'),
  );
  pressFeedback(watch);
  watch.addEventListener('click', (ev) => {
    ev.stopPropagation();
    haptic('tick');
    opts.onWatch(stake);
  });

  const go = h(
    'span',
    { class: 'sk__go', 'aria-hidden': 'true' },
    icon('chevron-right', { size: 17, stroke: 2.3 }),
  );

  const el = h(
    'button',
    {
      class: 'sk',
      type: 'button',
      'aria-label': `${stake.label}, buy in ${cash(stake.minBuyIn)} to ${cash(stake.maxBuyIn)}`,
    },
    h('span', { class: 'sk__chipwrap', 'aria-hidden': 'true' }, tierChip(stake.tier, chipFace(stake))),
    h(
      'span',
      { class: 'sk__main' },
      h(
        'span',
        { class: 'sk__top' },
        h('span', { class: 'sk__blinds tnum' }, stake.label),
        flame,
      ),
      h(
        'span',
        { class: 'sk__range tnum' },
        `${cash(stake.minBuyIn)} – ${cash(stake.maxBuyIn)}`,
        openSeats,
      ),
      lockBox,
    ),
    h(
      'span',
      { class: 'sk__live' },
      h('span', { class: 'sk__stat' }, h('i', { class: 'sk__dot', 'aria-hidden': 'true' }), players, trend),
      h('span', { class: 'sk__statl caps' }, 'playing'),
      h('span', { class: 'sk__stat sk__stat--pot' }, pot),
      h('span', { class: 'sk__statl caps' }, 'avg pot'),
    ),
    h('span', { class: 'sk__tail' }, watch, go),
    h('span', { class: 'sk__edge', 'aria-hidden': 'true' }),
  ) as StakeRowEl;

  pressFeedback(el);
  el.addEventListener('click', () => {
    haptic('select');
    opts.onOpen(stake);
  });

  let lastPlayers = -1;
  el.update = (live, gate) => {
    if (live.players !== lastPlayers) {
      players.textContent = compactCount(live.players);
      lastPlayers = live.players;
    }
    const dir = live.trend > 2 ? 1 : live.trend < -2 ? -1 : 0;
    trend.dataset.dir = String(dir);
    pot.textContent = cash(live.avgPot);

    openSeats.textContent = live.seatsOpen > 0 ? ` · ${live.seatsOpen} seats open` : ' · full';

    const hot = live.looseness >= 0.6;
    el.classList.toggle('is-hot', hot);
    flame.style.setProperty('--heat', ((live.looseness - 0.6) / 0.4).toFixed(3));
    flame.setAttribute(
      'title',
      `${Math.round(live.looseness * 100)}% of players seeing a flop — pots run big here`,
    );

    // Deliberately not `aria-disabled`: a locked row is still actionable — it
    // opens the explainer — so it must stay a live, focusable control.
    el.classList.toggle('is-locked', gate.locked);
    if (gate.locked) {
      meterFill.style.transform = `scaleX(${gate.progress.toFixed(4)})`;
      lockNote.textContent = cash(gate.remaining);
      el.setAttribute(
        'aria-label',
        `${stake.label}, not open yet. ${cash(gate.required)} bankroll recommended, ${cash(
          gate.remaining,
        )} to go.`,
      );
    }
  };

  return el;
}

// ── ladder ───────────────────────────────────────────────────────────

export interface StakeLadderOpts {
  stakes: readonly Stake[];
  onOpen(stake: Stake): void;
  onWatch(stake: Stake): void;
}

export interface StakeLadderEl extends HTMLDivElement {
  update(live: readonly StakeLive[], gates: Map<string, StakeGate>): void;
}

/** The six rows, staggered on entrance so the ladder assembles top-down. */
export function StakeLadder(opts: StakeLadderOpts): StakeLadderEl {
  const rows = new Map<string, StakeRowEl>();
  const el = h('div', { class: 'sk-ladder' }) as StakeLadderEl;
  opts.stakes.forEach((stake, i) => {
    const row = StakeRow({ stake, onOpen: opts.onOpen, onWatch: opts.onWatch });
    row.style.setProperty('--i', String(i));
    rows.set(stake.id, row);
    el.appendChild(row);
  });
  el.update = (live, gates) => {
    for (const l of live) {
      const row = rows.get(l.stake.id);
      const gate = gates.get(l.stake.id);
      if (row && gate) row.update(l, gate);
    }
  };
  return el;
}
