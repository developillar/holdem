/**
 * ROYALE — screens/lobby.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The front door. Read top to bottom it answers, in order: who are you, what
 * is hot right now, what do you get for coming back, how do I play in one tap,
 * what am I playing, for how much, and where.
 *
 *   hero greeting + live player ticker
 *   featured carousel        pass · bomb pot · sit & go
 *   daily streak strip
 *   QUICK SEAT               the one-tap path, impossible to miss
 *   game mode                NLHE · PLO4 · SNG · BOMB
 *   stakes ladder            six levels, live, bankroll-gated
 *   live tables              sortable, seat pips, bomb countdowns
 *
 * The screen mounts in a loading state built from Skeletons that mirror the
 * real geometry, then springs each section in 30ms apart so the page assembles
 * instead of appearing. Everything past that point is driven by one 1Hz feed
 * and one rAF-free update path — no layout thrash, no per-frame allocation.
 */
import '../styles/lobby.css';
import { bus } from '../../core/bus.ts';
import { STAKE_LIST } from '../../core/stakes.ts';
import type { LobbyTable, Stake, StakeId } from '../../core/types.ts';
import { h, clear } from '../dom.ts';
import { SectionHeader } from '../components/surface.ts';
import { Skeleton } from '../components/skeleton.ts';
import { icon } from '../components/icons.ts';
import { haptic, pressFeedback, reduceMotion } from '../components/util.ts';
import { cash, createLobbyFeed, fmtCount, greeting } from '../lobby/data.ts';
import type { LobbyFeed, LobbySnapshot } from '../lobby/data.ts';
import { BannerCarousel } from '../lobby/banner.ts';
import { ModeSelector } from '../lobby/modecard.ts';
import type { LobbyMode, ModeSelectorEl } from '../lobby/modecard.ts';
import { StakeLadder } from '../lobby/stakecard.ts';
import type { StakeLadderEl } from '../lobby/stakecard.ts';
import { TableList } from '../lobby/tablelist.ts';
import type { TableListEl } from '../lobby/tablelist.ts';
import { QuickSeat } from '../lobby/quickseat.ts';
import type { QuickSeatEl } from '../lobby/quickseat.ts';
import { DailyStrip } from '../lobby/daily.ts';
import type { DailyEl } from '../lobby/daily.ts';
import { openBuyIn, openLockedStake } from '../lobby/buyin.ts';
import { bankroll, gateFor, onBankroll, bestOpenStake } from '../lobby/bankroll.ts';
import type { StakeGate } from '../lobby/bankroll.ts';
import { prefs } from '../lobby/prefs.ts';

const MODE_KEY = 'royale.lobby-mode';

function readMode(): LobbyMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'nlhe' || v === 'plo4' || v === 'sng' || v === 'bomb') return v;
  } catch {
    /* default below */
  }
  return 'nlhe';
}

// ── loading state ────────────────────────────────────────────────────

/** Mirrors the real geometry so the swap to data never jumps the page. */
function skeletonScreen(): HTMLElement {
  const sec = (i: number, ...kids: Node[]) =>
    h('div', { class: 'lb__sk-sec', style: { '--i': String(i) } }, ...kids);
  return h(
    'div',
    { class: 'lb__sk', 'aria-busy': 'true', 'aria-label': 'Loading the lobby' },
    sec(0, Skeleton({ w: 130, h: 13, r: 7 }), Skeleton({ w: 196, h: 26, r: 9, delay: 60 })),
    sec(1, Skeleton({ w: '100%', h: 172, r: 24, delay: 90 })),
    sec(2, Skeleton({ w: '100%', h: 118, r: 20, delay: 140 })),
    sec(3, Skeleton({ w: '100%', h: 76, r: 22, delay: 190 })),
    sec(
      4,
      h(
        'div',
        { class: 'lb__sk-grid' },
        ...[0, 1, 2, 3].map((i) => Skeleton({ w: '100%', h: 112, r: 18, delay: 220 + i * 55 })),
      ),
    ),
    sec(
      5,
      ...[0, 1, 2, 3].map((i) => Skeleton({ w: '100%', h: 74, r: 18, delay: 300 + i * 60 })),
    ),
  );
}

// ── screen ───────────────────────────────────────────────────────────

export interface LobbyInstance {
  unmount(): void;
}

export function mount(container: HTMLElement): LobbyInstance {
  // The lobby is an off-table route, and base.css is explicit that the felt
  // must not bleed through one. The shell's own stage toggle early-outs on the
  // boot path (it is asked to hide a canvas it already believes is hidden), so
  // the class never lands and the table composites straight up through the
  // middle of this screen. Claim it here, synchronously, before the first
  // paint of the screen rather than on a transition end — `.is-hidden` also
  // carries `visibility: hidden` now, so there is no frame in which a
  // half-faded felt can leak. Deliberately not undone on unmount: the shell
  // clears it when the table route opens, and dropping it early would show a
  // frame of felt during the outgoing transition.
  document.getElementById('stage')?.classList.add('is-hidden');

  const root = h('div', { class: 'lb scroll' });
  const aura = h('div', { class: 'lb__aura', 'aria-hidden': 'true' });
  const inner = h('div', { class: 'lb__inner' });
  root.append(aura, inner);
  container.appendChild(root);

  const skel = skeletonScreen();
  inner.appendChild(skel);

  let disposed = false;
  const cleanups: Array<() => void> = [];
  let feed: LobbyFeed | null = null;
  let banner: ReturnType<typeof BannerCarousel> | null = null;
  let daily: DailyEl | null = null;
  let quick: QuickSeatEl | null = null;
  let modes: ModeSelectorEl | null = null;
  let ladder: StakeLadderEl | null = null;
  let tables: TableListEl | null = null;
  let mode: LobbyMode = readMode();
  let stakeFilter: StakeId | null = null;
  let latest: LobbySnapshot | null = null;
  /** Set once `build()` has run; repaints every live surface from a snapshot. */
  let repaint: ((s: LobbySnapshot) => void) | null = null;

  // The lobby is "loading" for one honest beat — long enough for the
  // skeletons to register, short enough that it never feels like waiting.
  const bootTimer = window.setTimeout(() => {
    if (disposed) return;
    build();
  }, reduceMotion() ? 60 : 420);
  cleanups.push(() => clearTimeout(bootTimer));

  function go(route: 'table' | 'pass' | 'store' | 'settings' | 'stats', params?: Record<string, string>): void {
    bus.emit('nav:route', { route, params });
  }

  function seatMe(stake: Stake, table: LobbyTable, amount: number, rebuy: boolean): void {
    bus.emit('ui:toast', {
      text: `Sitting down at ${stake.label} with ${cash(amount)}`,
      tone: 'good',
      ms: 2000,
    });
    go('table', {
      stake: stake.id,
      table: table.id,
      variant: table.variant,
      format: table.format,
      buyIn: String(amount),
      autoRebuy: rebuy ? '1' : '0',
      seats: String(table.seatsTotal),
    });
  }

  function pickTableFor(stake: Stake): LobbyTable {
    const snap = latest;
    const wantVariant = mode === 'plo4' ? 'plo4' : 'nlhe';
    const pool =
      snap?.tables.filter(
        (t) =>
          t.stakeId === stake.id &&
          t.seatsTaken < t.seatsTotal &&
          (mode === 'sng' ? t.format === 'sng' : t.variant === wantVariant),
      ) ?? [];
    const fallback = snap?.tables.filter((t) => t.stakeId === stake.id) ?? [];
    const best = pool.sort((a, b) => b.looseness - a.looseness)[0] ?? fallback[0];
    return (
      best ?? {
        id: `adhoc-${stake.id}`,
        variant: wantVariant,
        format: mode === 'sng' ? 'sng' : 'cash',
        stakeId: stake.id,
        seatsTaken: 0,
        seatsTotal: 6,
        avgPot: stake.bb * 9,
        handsPerHour: 68,
        looseness: 0.5,
        bombPotIn: null,
      }
    );
  }

  function openStake(stake: Stake): void {
    const gate = gateFor(stake);
    if (gate.locked) {
      openLockedStake({
        stake,
        required: gate.required,
        remaining: gate.remaining,
        progress: gate.progress,
        onWatch: () => watchStake(stake),
        onPickLower: () => {
          const open = bestOpenStake(STAKE_LIST);
          openStake(open);
        },
      });
      return;
    }
    const table = pickTableFor(stake);
    const live = latest?.stakes.find((s) => s.stake.id === stake.id);
    openBuyIn({
      stake,
      mode,
      bankroll: bankroll(),
      avgStack: stake.bb * 88,
      seatsOpen: live?.seatsOpen,
      onConfirm: (amount, rebuy) => seatMe(stake, table, amount, rebuy),
    });
  }

  function watchStake(stake: Stake): void {
    const table = pickTableFor(stake);
    bus.emit('ui:toast', { text: `Railing ${stake.label}`, tone: 'info', ms: 1800 });
    go('table', {
      stake: stake.id,
      table: table.id,
      variant: table.variant,
      format: table.format,
      spectate: '1',
    });
  }

  function setMode(next: LobbyMode): void {
    mode = next;
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* not persisted in private mode */
    }
    root.dataset.mode = next;
    if (latest) repaint?.(latest);
  }

  // ── the built screen ───────────────────────────────────────────────

  function build(): void {
    const name = prefs().displayName;
    const onlineN = h('b', { class: 'tnum' }, '—');
    const hero = h(
      'header',
      { class: 'lb__hero lb__sec', style: { '--i': '0' } },
      h(
        'div',
        { class: 'lb__greet' },
        h('span', { class: 'lb__eyebrow caps' }, greeting()),
        h('h1', { class: 'lb__name' }, name),
      ),
      h(
        'button',
        {
          class: 'lb__online',
          type: 'button',
          'aria-label': 'Players online — open statistics',
          onclick: () => {
            haptic('tick');
            go('stats');
          },
        },
        h('i', { class: 'lb__pulse', 'aria-hidden': 'true' }),
        onlineN,
        h('span', { class: 'lb__onlinel caps' }, 'online'),
      ),
    );

    banner = BannerCarousel({
      onAction: (id) => {
        if (id === 'pass') go('pass');
        else if (id === 'bomb') {
          modes?.setValue('bomb', false);
          setMode('bomb');
          tablesSec.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
        } else {
          modes?.setValue('sng', false);
          setMode('sng');
          tablesSec.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
        }
      },
    });
    banner.classList.add('lb__sec');
    banner.style.setProperty('--i', '1');

    daily = DailyStrip();
    daily.classList.add('lb__sec');
    daily.style.setProperty('--i', '2');

    quick = QuickSeat({
      onSeat: (stake, table) => {
        const amount = Math.min(stake.maxBuyIn, Math.max(stake.minBuyIn, stake.bb * 100));
        seatMe(stake, table, amount, false);
      },
    });
    quick.classList.add('lb__sec');
    quick.style.setProperty('--i', '3');

    modes = ModeSelector({
      value: mode,
      onChange: (m) => setMode(m),
    });
    const modeSec = h(
      'section',
      { class: 'lb__sec', style: { '--i': '4' } },
      SectionHeader({ eyebrow: 'Choose your game', title: 'Game mode' }),
      modes,
    );

    const rollPill = h(
      'button',
      { class: 'lb__roll', type: 'button', 'aria-label': 'Your balance — open the cashier' },
      icon('chip', { size: 13 }),
      h('b', { class: 'tnum' }, cash(bankroll())),
    );
    pressFeedback(rollPill);
    rollPill.addEventListener('click', () => {
      haptic('tick');
      go('store');
    });

    ladder = StakeLadder({
      stakes: STAKE_LIST,
      onOpen: openStake,
      onWatch: watchStake,
    });
    const stakeSec = h(
      'section',
      { class: 'lb__sec', style: { '--i': '5' } },
      SectionHeader({ eyebrow: 'Cash games', title: 'Stakes', action: rollPill }),
      ladder,
      h(
        'p',
        { class: 'lb__footnote' },
        icon('info', { size: 12.5 }),
        h('span', null, 'Levels open once your roll covers 30 buy-ins. You can rail any game before you sit.'),
      ),
    );

    const tableCount = h('span', { class: 'lb__count tnum' }, '—');
    tables = TableList({
      onJoin: (t) => {
        const stake = STAKE_LIST.find((s) => s.id === t.stakeId) ?? STAKE_LIST[0];
        if (t.seatsTaken >= t.seatsTotal) {
          bus.emit('ui:toast', { text: 'That table is full — you are on the list', tone: 'info', ms: 1900 });
          return;
        }
        openStake(stake);
      },
      onClearFilter: () => {
        stakeFilter = null;
        modes?.setValue('nlhe', false);
        setMode('nlhe');
      },
      onCount: (n) => {
        tableCount.textContent = `${n} ${n === 1 ? 'room' : 'rooms'}`;
      },
    });
    const tablesSec = h(
      'section',
      { class: 'lb__sec lb__sec--tables', style: { '--i': '6' } },
      SectionHeader({ eyebrow: 'Running now', title: 'Live tables', action: tableCount }),
      tables,
    );

    const footer = h(
      'footer',
      { class: 'lb__foot lb__sec', style: { '--i': '7' } },
      h(
        'button',
        {
          class: 'lb__footbtn',
          type: 'button',
          onclick: () => {
            haptic('tick');
            go('settings');
          },
        },
        icon('gear', { size: 15 }),
        h('span', null, 'Settings & play limits'),
        icon('chevron-right', { size: 14, stroke: 2.2 }),
      ),
      h(
        'p',
        { class: 'lb__legal' },
        'Play money only. Set a session limit any time in Settings — ',
        h('b', null, 'Responsible Play'),
        '.',
      ),
    );

    const built = h(
      'div',
      { class: 'lb__built' },
      hero,
      banner,
      daily,
      quick,
      modeSec,
      stakeSec,
      tablesSec,
      footer,
    );

    // ── swap loading → loaded ────────────────────────────────────────
    skel.classList.add('is-out');
    inner.appendChild(built);
    window.setTimeout(() => skel.remove(), 320);
    requestAnimationFrame(() => built.classList.add('is-in'));

    // ── live data ────────────────────────────────────────────────────
    root.dataset.mode = mode;
    feed = createLobbyFeed();
    cleanups.push(
      feed.subscribe((s) => {
        latest = s;
        onlineN.textContent = fmtCount(s.totalPlayers);
        paintFrom(s);
      }),
    );
    cleanups.push(
      onBankroll(() => {
        rollPill.querySelector('b')!.textContent = cash(bankroll());
        if (latest) paintFrom(latest);
      }),
    );

    const dailyTimer = window.setInterval(() => daily?.tick(), 30_000);
    cleanups.push(() => clearInterval(dailyTimer));

    // Parallax the ambient wash against the scroll — transform only.
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        aura.style.transform = `translate3d(0,${(root.scrollTop * -0.22).toFixed(1)}px,0)`;
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    cleanups.push(() => root.removeEventListener('scroll', onScroll));

    function paintFrom(s: LobbySnapshot): void {
      banner?.update(s);
      const gates = new Map<string, StakeGate>();
      for (const st of STAKE_LIST) gates.set(st.id, gateFor(st));
      ladder?.update(s.stakes, gates);
      // The list owns the stake chips, so it reports the count back rather
      // than the screen re-deriving the same filter.
      tables?.update(s.tables, { mode, stakeId: stakeFilter });

      modes?.setLive({
        nlhe: Math.round(s.totalPlayers * 0.58),
        plo4: Math.round(s.totalPlayers * 0.21),
        sng: Math.round(s.totalPlayers * 0.13),
        bomb: Math.round(s.totalPlayers * 0.08),
      });

      const target = bestOpenStake(STAKE_LIST);
      quick?.update(s, target, mode);
    }

    repaint = paintFrom;
  }

  return {
    unmount() {
      disposed = true;
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch (err) {
          console.error('[lobby] cleanup failed', err);
        }
      }
      banner?.dispose();
      quick?.dispose();
      daily?.dispose();
      feed?.dispose();
      clear(root);
      root.remove();
    },
  };
}
