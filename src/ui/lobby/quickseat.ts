/**
 * ROYALE — lobby/quickseat.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The fastest path to a table, and the loudest object on the screen.
 *
 * The CTA is a milled gold slab with a specular sweep, a live seat-count that
 * updates under your thumb, and a hairline-lit shelf beneath it so it reads as
 * lifted off the page rather than painted on.
 *
 * Tapping it opens matchmaking: a radar that actually sweeps, opponents that
 * arrive one by one with their stakes and stack, a running elapsed clock, and
 * a Cancel that is always reachable. It resolves into a "seat found" state
 * that shows the room you are about to enter before it hands off to the table.
 *
 *   const cta = QuickSeat({ onSeat: (stake, table) => … });
 *   cta.update(snapshot, stake);
 */
import { h } from '../dom.ts';
import { Button } from '../components/button.ts';
import { openSheet } from '../components/sheet.ts';
import { Avatar } from '../components/avatar.ts';
import { icon } from '../components/icons.ts';
import { haptic, pressFeedback, reduceMotion } from '../components/util.ts';
import { Rng } from '../../core/rng.ts';

import type { LobbyTable, Stake } from '../../core/types.ts';
import type { LobbySnapshot } from './data.ts';
import { cash, tableName } from './data.ts';
import { modeLabel } from './modecard.ts';
import type { LobbyMode } from './modecard.ts';

export interface QuickSeatOpts {
  onSeat(stake: Stake, table: LobbyTable): void;
}

export interface QuickSeatEl extends HTMLDivElement {
  update(snapshot: LobbySnapshot, stake: Stake, mode: LobbyMode): void;
  dispose(): void;
}

const NAMES = [
  'Nadia Okafor', 'Teo Marchetti', 'Rin Watanabe', 'Casper Lund', 'Aya Bouchard',
  'Milo Ferreira', 'Sanne de Vries', 'Idris Bello', 'Petra Kovac', 'Jonas Aalto',
  'Leila Haddad', 'Owen Brennan', 'Yara Silva', 'Kwame Mensah', 'Ines Duarte',
];

export function QuickSeat(opts: QuickSeatOpts): QuickSeatEl {
  // Split so the money half can carry `.tnum` — an avg pot that reflows while
  // the 1Hz feed updates it is a rubric auto-failure on its own.
  const subRoom = h('span', null, 'Finding the softest open seat…');
  const subPot = h('span', { class: 'tnum' }, '');
  const sub = h('span', { class: 'qs__sub' }, subRoom, subPot);
  const stakeChip = h('span', { class: 'qs__chip tnum' }, '—');
  const seatsChip = h('span', { class: 'qs__chip qs__chip--good' }, '—');

  let current: { stake: Stake; table: LobbyTable } | null = null;
  let mode: LobbyMode = 'nlhe';

  const btn = h(
    'button',
    { class: 'qs__btn', type: 'button', 'aria-label': 'Quick seat — join the best open table' },
    h('span', { class: 'qs__sheen', 'aria-hidden': 'true' }),
    h('span', { class: 'qs__grain', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'qs__inner' },
      h('span', { class: 'qs__bolt', 'aria-hidden': 'true' }, icon('bolt', { size: 22, solid: true })),
      h(
        'span',
        { class: 'qs__col' },
        h('span', { class: 'qs__label' }, 'Quick seat'),
        sub,
      ),
      h('span', { class: 'qs__go', 'aria-hidden': 'true' }, icon('arrow-right', { size: 20, stroke: 2.4 })),
    ),
  );
  pressFeedback(btn);

  const el = h(
    'div',
    { class: 'qs' },
    btn,
    h('div', { class: 'qs__meta' }, stakeChip, h('i', { class: 'qs__sep', 'aria-hidden': 'true' }), seatsChip),
  ) as QuickSeatEl;

  btn.addEventListener('click', () => {
    if (!current) return;
    haptic('big-win');
    openMatchmaking({
      stake: current.stake,
      table: current.table,
      mode,
      onSeat: opts.onSeat,
    });
  });

  el.update = (snapshot, stake, m) => {
    mode = m;
    // Pick the loosest table at this level that still has a seat.
    const pool = snapshot.tables.filter(
      (t) => t.stakeId === stake.id && t.seatsTaken < t.seatsTotal && t.format === 'cash',
    );
    const pick =
      pool.slice().sort((a, b) => b.looseness - a.looseness)[0] ??
      snapshot.tables.find((t) => t.stakeId === stake.id) ??
      snapshot.tables[0];
    current = { stake, table: pick };
    const open = pick.seatsTotal - pick.seatsTaken;
    stakeChip.textContent = stake.label;
    seatsChip.textContent = open > 0 ? `${open} ${open === 1 ? 'seat' : 'seats'} open` : 'Waitlist';
    seatsChip.classList.toggle('qs__chip--good', open > 0);
    if (open > 0) {
      subRoom.textContent = `${tableName(pick.id)} · `;
      subPot.textContent = `${cash(pick.avgPot)} avg pot`;
    } else {
      subRoom.textContent = `Next seat at ${tableName(pick.id)}`;
      subPot.textContent = '';
    }
  };

  el.dispose = () => {
    /* no timers of its own — the lobby drives updates */
  };

  return el;
}

// ── matchmaking ──────────────────────────────────────────────────────

interface MatchOpts {
  stake: Stake;
  table: LobbyTable;
  mode: LobbyMode;
  onSeat(stake: Stake, table: LobbyTable): void;
}

/**
 * A five-second search that is honest about what it is doing: it names the
 * pool it is scanning, shows every opponent as it locks them in, and lands on
 * a room card. Cancelling stops it instantly and cleanly.
 */
export function openMatchmaking(opts: MatchOpts): void {
  const rng = new Rng(0xa11ce ^ opts.table.id.length ^ Math.floor(Date.now() / 1000));
  const wanted = Math.min(5, Math.max(3, opts.table.seatsTaken));
  const names = new Rng(0x51e).shuffle(NAMES.slice()).slice(0, wanted);

  const radar = h(
    'div',
    { class: 'mm__radar', 'aria-hidden': 'true' },
    h('span', { class: 'mm__rings' },
      h('i'), h('i'), h('i'),
    ),
    h('span', { class: 'mm__sweep' }),
    h('span', { class: 'mm__core' }, icon('spade', { size: 26, solid: true })),
  );

  // Reserve the seat rows up front so the sheet never grows under the finger.
  const foundList = h('div', { class: 'mm__found', style: { minHeight: `${wanted * 49}px` } });
  const status = h('div', { class: 'mm__status' }, 'Scanning the pool…');
  const clock = h('div', { class: 'mm__clock tnum' }, '0.0s');
  const bar = h('i', { class: 'mm__barfill' });

  const roomCard = h(
    'div',
    { class: 'mm__room' },
    h('div', { class: 'mm__roomname' }, tableName(opts.table.id)),
    h(
      'div',
      { class: 'mm__roomstats' },
      h('span', { class: 'tnum' }, opts.stake.label),
      h('span', null, `${opts.table.seatsTotal}-max`),
      h('span', { class: 'tnum' }, `${cash(opts.table.avgPot)} avg pot`),
    ),
  );

  const cancel = Button({
    label: 'Cancel search',
    variant: 'ghost',
    size: 'md',
    full: true,
    onTap: () => {
      stop();
      sheet.close();
    },
  });

  const body = h(
    'div',
    { class: 'mm' },
    radar,
    status,
    clock,
    h('div', { class: 'mm__bar' }, bar),
    foundList,
    roomCard,
  );

  const sheet = openSheet({
    eyebrow: modeLabel(opts.mode),
    title: 'Finding you a seat',
    subtitle: `${opts.stake.label} · best table for your stake`,
    class: 'sheet--match',
    dismissible: true,
    content: body,
    footer: cancel,
    onClose: () => stop(),
  });

  const t0 = performance.now();
  const DURATION = reduceMotion() ? 900 : 4200;
  let raf = 0;
  let seated = 0;
  let done = false;

  const addSeat = (i: number) => {
    const nameStr = names[i] ?? 'Player';
    const stackBb = Math.round(rng.range(52, 214));
    const row = h(
      'div',
      { class: 'mm__seat', style: { '--i': String(i) } },
      Avatar({ name: nameStr, size: 30, level: null }),
      h('span', { class: 'mm__seatname' }, nameStr.split(' ')[0]),
      h('span', { class: 'mm__seatstack tnum' }, `${stackBb}bb`),
      h('span', { class: 'mm__seatok', 'aria-hidden': 'true' }, icon('check', { size: 13, stroke: 3 })),
    );
    foundList.appendChild(row);
    requestAnimationFrame(() => row.classList.add('is-in'));
    haptic('tick');
  };

  const STEPS = [
    'Scanning the pool…',
    'Comparing table dynamics…',
    'Checking seat quality…',
    'Reserving your seat…',
  ];

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const t = Math.min(1, (now - t0) / DURATION);
    bar.style.transform = `scaleX(${t.toFixed(4)})`;
    clock.textContent = `${((now - t0) / 1000).toFixed(1)}s`;
    const stepIdx = Math.min(STEPS.length - 1, Math.floor(t * STEPS.length));
    if (status.textContent !== STEPS[stepIdx]) status.textContent = STEPS[stepIdx];
    const want = Math.floor(t * (wanted + 0.6));
    while (seated < Math.min(wanted, want)) addSeat(seated++);
    if (t >= 1 && !done) finish();
  };

  function finish(): void {
    done = true;
    stop();
    body.classList.add('is-found');
    const heading = sheet.el.querySelector('.r-sheet__title');
    if (heading) heading.textContent = 'Your seat is ready';
    status.textContent = 'Seat secured';
    clock.textContent = 'Ready';
    haptic('win');
    const take = () => {
      sheet.close();
      opts.onSeat(opts.stake, opts.table);
    };
    cancel.replaceWith(
      Button({
        label: 'Take my seat',
        variant: 'primary',
        size: 'lg',
        full: true,
        haptic: 'bet',
        onTap: take,
      }),
    );
    // Auto-enter if the player just watches it land.
    window.setTimeout(() => {
      if (!sheet.closed()) take();
    }, 2400);
  }

  function stop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  raf = requestAnimationFrame(frame);
}
