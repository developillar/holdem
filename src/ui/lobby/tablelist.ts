/**
 * ROYALE — lobby/tablelist.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Every running room, as a dense but readable list. Each row carries a named
 * room, a variant glyph, seat pips that fill as players arrive, the average
 * pot, and — when the room is on the bomb-pot rotation — a live countdown
 * badge that actually ticks.
 *
 * Sorting is a real control, not decoration: Action (loosest first), Players,
 * Stakes and Speed each reorder with a keyed reconcile, so rows slide rather
 * than blink. Filtering to nothing gives a considered empty state with a way
 * out, never a blank panel.
 *
 *   const list = TableList({ onJoin });
 *   list.update(snapshot.tables, { mode, stakeFilter });
 */
import { cx, h, keyedList } from '../dom.ts';
import { Segmented } from '../components/segmented.ts';
import { EmptyState } from '../components/empty.ts';
import { icon } from '../components/icons.ts';
import { haptic, pressFeedback } from '../components/util.ts';
import { STAKES, STAKE_LIST } from '../../core/stakes.ts';
import type { LobbyTable, StakeId } from '../../core/types.ts';
import { cash, clockMs, tableName } from './data.ts';
import type { LobbyMode } from './modecard.ts';
import { chipFace, tierChip } from './stakecard.ts';

export type TableSort = 'action' | 'players' | 'stakes' | 'speed';

export interface TableListOpts {
  onJoin(table: LobbyTable): void;
  onClearFilter(): void;
  /** rooms currently passing every filter — drives the section header count */
  onCount?(shown: number): void;
}

export interface TableListEl extends HTMLDivElement {
  update(tables: readonly LobbyTable[], filter: { mode: LobbyMode; stakeId: StakeId | null }): void;
}

/** Looseness at which a room earns the flame — deliberately rare. */
const HOT = 0.8;

const SORTS: Array<{ id: TableSort; label: string }> = [
  { id: 'action', label: 'Action' },
  { id: 'players', label: 'Players' },
  { id: 'stakes', label: 'Stakes' },
  { id: 'speed', label: 'Speed' },
];

function seatPips(taken: number, total: number): HTMLElement {
  const box = h('span', { class: 'tl__pips', 'aria-label': `${taken} of ${total} seats taken` });
  for (let i = 0; i < total; i++) {
    box.appendChild(h('i', { class: i < taken ? 'is-on' : '' }));
  }
  return box;
}

function rowFor(t: LobbyTable, onJoin: (t: LobbyTable) => void): HTMLElement {
  const stake = STAKES[t.stakeId];
  const full = t.seatsTaken >= t.seatsTotal;
  const bombBadge =
    t.bombPotIn !== null
      ? h(
          'span',
          { class: 'tl__bomb' },
          icon('flame', { size: 11, solid: true }),
          h('b', { class: 'tnum' }, clockMs(t.bombPotIn)),
        )
      : null;

  const el = h(
    'button',
    {
      class: 'tl__row',
      type: 'button',
      dataset: { id: t.id },
      'aria-label': `${tableName(t.id)}, ${stake.label}, ${t.seatsTaken} of ${t.seatsTotal} seated`,
    },
    h(
      'span',
      { class: `tl__glyph tl__glyph--${t.variant}`, 'aria-hidden': 'true' },
      tierChip(stake.tier, chipFace(stake)),
      t.variant === 'plo4' ? h('i', { class: 'tl__plo' }, 'PLO') : null,
    ),
    h(
      'span',
      { class: 'tl__main' },
      h(
        'span',
        { class: 'tl__name' },
        tableName(t.id),
        h('i', { class: 'tl__hot', title: 'Loose table — pots run big' }, icon('flame', { size: 11, solid: true })),
      ),
      h(
        'span',
        { class: 'tl__meta tnum' },
        stake.label,
        h('i', { class: 'tl__dot' }),
        `${cash(t.avgPot)} pot`,
        h('i', { class: 'tl__dot' }),
        `${t.handsPerHour}/hr`,
      ),
    ),
    h(
      'span',
      { class: 'tl__right' },
      bombBadge,
      seatPips(t.seatsTaken, t.seatsTotal),
      h('span', { class: 'tl__seats tnum' }, full ? 'Full' : `${t.seatsTaken}/${t.seatsTotal}`),
    ),
  );
  el.classList.toggle('is-full', full);
  el.classList.toggle('is-hotrow', t.looseness >= HOT);
  pressFeedback(el);
  el.addEventListener('click', () => {
    haptic('tick');
    onJoin(t);
  });
  return el;
}

function patchRow(el: Element, t: LobbyTable): void {
  const row = el as HTMLElement;
  const full = t.seatsTaken >= t.seatsTotal;
  row.classList.toggle('is-full', full);
  const pips = row.querySelectorAll<HTMLElement>('.tl__pips i');
  pips.forEach((p, i) => p.classList.toggle('is-on', i < t.seatsTaken));
  const seats = row.querySelector<HTMLElement>('.tl__seats');
  if (seats) seats.textContent = full ? 'Full' : `${t.seatsTaken}/${t.seatsTotal}`;
  const bomb = row.querySelector<HTMLElement>('.tl__bomb b');
  if (bomb && t.bombPotIn !== null) bomb.textContent = clockMs(t.bombPotIn);
  const meta = row.querySelector<HTMLElement>('.tl__meta');
  if (meta) {
    const parts = meta.childNodes;
    // index 2 is the pot text node (label, dot, pot, dot, speed)
    if (parts[2]) parts[2].textContent = `${cash(t.avgPot)} pot`;
    if (parts[4]) parts[4].textContent = `${t.handsPerHour}/hr`;
  }
  row.classList.toggle('is-hotrow', t.looseness >= HOT);
}

export function TableList(opts: TableListOpts): TableListEl {
  let sort: TableSort = 'action';
  /** Chip-row narrowing, owned by the list. `null` = every level. */
  let stakePick: StakeId | null = null;

  const seg = Segmented({
    items: SORTS.map((s) => ({ id: s.id, label: s.label })),
    value: sort,
    size: 'sm',
    full: true,
    ariaLabel: 'Sort tables',
    onChange: (id) => {
      sort = id as TableSort;
      render();
    },
  });

  // ── stake chips ───────────────────────────────────────────────────
  const chips = new Map<StakeId | 'all', HTMLButtonElement>();
  const chipRow = h('div', { class: 'tl__chips', role: 'radiogroup', 'aria-label': 'Filter by stake' });

  const addChip = (id: StakeId | 'all', label: string, tier?: string) => {
    const b = h(
      'button',
      {
        class: cx('tl__chip', tier && `tl__chip--${tier}`),
        type: 'button',
        role: 'radio',
        'aria-checked': (stakePick ?? 'all') === id ? 'true' : 'false',
      },
      label,
    );
    pressFeedback(b);
    b.addEventListener('click', () => {
      haptic('select');
      stakePick = id === 'all' ? null : id;
      render();
    });
    chips.set(id, b);
    chipRow.appendChild(b);
  };
  addChip('all', 'All stakes');
  for (const st of STAKE_LIST) {
    addChip(st.id, st.bb < 1 ? `${Math.round(st.bb * 100)}¢` : `$${st.bb}`, st.tier);
  }

  const listEl = h('div', { class: 'tl__list' });
  const emptyWrap = h('div', { class: 'tl__empty' });

  /** The lobby leads with the twelve best rooms; the rest is one tap away. */
  const PAGE = 12;
  let expanded = false;
  const more = h('button', { class: 'tl__more', type: 'button' }, h('span', null, ''), icon('chevron-down', { size: 15, stroke: 2.2 }));
  pressFeedback(more);
  more.addEventListener('click', () => {
    expanded = !expanded;
    haptic('tick');
    render();
  });

  const el = h(
    'div',
    { class: 'tl' },
    h('div', { class: 'tl__sorts' }, seg),
    chipRow,
    listEl,
    more,
    emptyWrap,
  ) as TableListEl;

  const list = keyedList<LobbyTable>(listEl, {
    key: (t) => t.id,
    create: (t, _k, i) => {
      const row = rowFor(t, opts.onJoin);
      row.style.setProperty('--i', String(Math.min(i, 12)));
      row.classList.add('is-fresh');
      requestAnimationFrame(() => row.classList.remove('is-fresh'));
      return row;
    },
    update: (elm, t) => patchRow(elm, t),
  });

  let source: readonly LobbyTable[] = [];
  let filter: { mode: LobbyMode; stakeId: StakeId | null } = { mode: 'nlhe', stakeId: null };

  function matches(t: LobbyTable): boolean {
    const want = stakePick ?? filter.stakeId;
    if (want && t.stakeId !== want) return false;
    switch (filter.mode) {
      case 'nlhe':
        return t.variant === 'nlhe' && t.format === 'cash';
      case 'plo4':
        return t.variant === 'plo4' && t.format === 'cash';
      case 'sng':
        return t.format === 'sng';
      case 'bomb':
        return t.bombPotIn !== null;
    }
  }

  function ordered(items: LobbyTable[]): LobbyTable[] {
    const by: Record<TableSort, (a: LobbyTable, b: LobbyTable) => number> = {
      action: (a, b) => b.looseness - a.looseness || b.avgPot - a.avgPot,
      players: (a, b) => b.seatsTaken - a.seatsTaken || a.seatsTotal - b.seatsTotal,
      stakes: (a, b) => STAKES[b.stakeId].bb - STAKES[a.stakeId].bb || b.avgPot - a.avgPot,
      speed: (a, b) => b.handsPerHour - a.handsPerHour,
    };
    return items.sort(by[sort]);
  }

  function render(): void {
    for (const [id, b] of chips) {
      const on = (stakePick ?? 'all') === id;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    const all = ordered(source.filter(matches));
    opts.onCount?.(all.length);
    const items = expanded ? all : all.slice(0, PAGE);
    list.update(items);
    const hidden = all.length - items.length;
    more.classList.toggle('is-on', all.length > PAGE);
    more.classList.toggle('is-open', expanded);
    more.firstElementChild!.textContent = expanded
      ? 'Show fewer rooms'
      : `Show ${hidden} more room${hidden === 1 ? '' : 's'}`;
    const empty = items.length === 0;
    listEl.classList.toggle('is-hidden', empty);
    emptyWrap.classList.toggle('is-on', empty);
    if (empty && !emptyWrap.firstChild) {
      emptyWrap.appendChild(
        EmptyState({
          art: 'search',
          title: 'No rooms match that yet',
          body: 'The pool moves fast at this hour. Widen the filter and the tables come straight back.',
          actionLabel: 'Show every table',
          onAction: () => {
            stakePick = null;
            opts.onClearFilter();
            render();
          },
          compact: true,
        }),
      );
    }
  }

  el.update = (tables, f) => {
    source = tables;
    filter = f;
    render();
  };

  return el;
}
