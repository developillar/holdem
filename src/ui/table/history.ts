/**
 * Session hand history + last-hand replay.
 *
 * The recorder listens to the same bus events the renderer does, so it works
 * identically whether the local engine or the scripted demo is driving. Every
 * completed hand becomes a compact log row — hand number, your holding, the
 * result and the net — and any row can be opened in a replay viewer that steps
 * through the action with a scrubber.
 */

import type { Action, CardId, HandReplay, ShowdownResult, Street, TableState } from '../../core/types.ts';
import { cardBack, cardFace, cardRow } from './cardface.ts';
import { clamp, cls, cue, h, haptic, onFrame, press, setText } from './dom.ts';
import { icon } from './icons.ts';
import { createSheet, emptyState } from './sheet.ts';
import type { Sheet } from './sheet.ts';

export interface HandLogEntry {
  handId: number;
  at: number;
  hole: CardId[];
  board: CardId[];
  net: number;
  potTotal: number;
  outcome: 'won' | 'lost' | 'folded' | 'chopped';
  label: string;
  /** dead money already in the pot before the first recorded action */
  deadMoney: number;
  replay: HandReplay;
}

interface Live {
  handId: number;
  you: number;
  buttonSeat: number;
  startStacks: Map<number, number>;
  names: Map<number, string>;
  avatars: Map<number, string>;
  hole: Map<number, CardId[]>;
  actions: Action[];
  board: CardId[];
  results: ShowdownResult[];
  awards: Map<number, number>;
  deadMoney: number;
  stakeLabel: string;
  variant: TableState['variant'];
}

const STREET_ORDER: Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];

/** Hole cards always read best-first, the way a player says them out loud. */
function byRankDesc(cards: readonly CardId[]): CardId[] {
  return cards.slice().sort((a, b) => (b >> 2) - (a >> 2) || (a & 3) - (b & 3));
}

/** Builds `HandReplay`s from bus traffic. Independent of the engine module. */
export class HandRecorder {
  private live: Live | null = null;
  private log: HandLogEntry[] = [];
  private limit = 60;

  begin(state: TableState, you: number): void {
    const names = new Map<number, string>();
    const avatars = new Map<number, string>();
    const startStacks = new Map<number, number>();
    for (const s of state.seats) {
      if (!s.player) continue;
      names.set(s.index, s.player.name);
      avatars.set(s.index, s.player.avatarId);
      startStacks.set(s.index, s.stack);
    }
    this.live = {
      handId: state.handId || (this.log.length + 1),
      you,
      buttonSeat: state.buttonSeat,
      startStacks,
      names,
      avatars,
      hole: new Map(),
      actions: [],
      board: [],
      results: [],
      awards: new Map(),
      deadMoney: 0,
      stakeLabel: state.tournament ? `L${state.tournament.level}` : state.stake.label,
      variant: state.variant,
    };
  }

  /** Called on every table snapshot: picks up blinds, reveals and ids. */
  observe(state: TableState): void {
    const l = this.live;
    if (!l) return;
    if (l.handId <= 0) l.handId = state.handId;
    if (l.actions.length === 0) {
      const posted = state.seats.reduce((a, s) => a + s.committed, 0);
      if (posted > l.deadMoney) l.deadMoney = posted;
    }
    for (const s of state.seats) {
      if (s.holeCards.length) l.hole.set(s.index, s.holeCards.slice());
      if (s.player && !l.names.has(s.index)) l.names.set(s.index, s.player.name);
    }
    if (state.board.length > l.board.length) l.board = state.board.slice();
  }

  action(a: Action): void {
    this.live?.actions.push({ ...a });
  }

  board(cards: CardId[]): void {
    const l = this.live;
    if (!l) return;
    for (const c of cards) if (!l.board.includes(c)) l.board.push(c);
  }

  showdown(results: ShowdownResult[]): void {
    if (this.live) this.live.results = results.map((r) => ({ ...r }));
  }

  award(seat: number, amount: number): void {
    const l = this.live;
    if (!l) return;
    l.awards.set(seat, (l.awards.get(seat) ?? 0) + amount);
  }

  /** Seals the hand and returns the log row, or null if nothing was recorded. */
  end(state: TableState): HandLogEntry | null {
    const l = this.live;
    this.live = null;
    if (!l) return null;

    const you = l.you;
    const startStack = l.startStacks.get(you) ?? 0;
    const endStack = state.seats[you]?.stack ?? startStack;
    const net = Math.round((endStack - startStack) * 1e6) / 1e6;
    const wonAmount = l.awards.get(you) ?? 0;
    const heroResult = l.results.find((r) => r.seat === you);
    const winners = Array.from(l.awards.entries()).filter(([, v]) => v > 0);

    let outcome: HandLogEntry['outcome'];
    if (wonAmount > 0 && winners.length > 1) outcome = 'chopped';
    else if (wonAmount > 0) outcome = 'won';
    else if (l.actions.some((a) => a.seat === you && a.kind === 'fold')) outcome = 'folded';
    else outcome = 'lost';

    const label = heroResult?.rank?.label
      ?? (outcome === 'won' ? 'Took it down' : outcome === 'folded' ? 'Folded' : 'Lost the pot');

    const potTotal = Array.from(l.awards.values()).reduce((a, v) => a + v, 0);

    const replay: HandReplay = {
      handId: l.handId,
      variant: l.variant,
      stakeLabel: l.stakeLabel,
      seats: Array.from(l.startStacks.keys()).map((seat) => ({
        seat,
        name: l.names.get(seat) ?? `Seat ${seat + 1}`,
        avatarId: l.avatars.get(seat) ?? 'av-01',
        startStack: l.startStacks.get(seat) ?? 0,
        holeCards: l.hole.get(seat) ?? null,
      })),
      buttonSeat: l.buttonSeat,
      board: l.board.slice(),
      actions: l.actions.slice(),
      results: l.results.slice(),
      potTotal,
    };

    const entry: HandLogEntry = {
      handId: l.handId,
      at: Date.now(),
      hole: l.hole.get(you)?.slice() ?? [],
      board: l.board.slice(),
      net,
      potTotal,
      outcome,
      label,
      deadMoney: l.deadMoney,
      replay,
    };
    this.log.unshift(entry);
    if (this.log.length > this.limit) this.log.pop();
    return entry;
  }

  entries(): readonly HandLogEntry[] {
    return this.log;
  }

  last(): HandLogEntry | null {
    return this.log[0] ?? null;
  }

  net(): number {
    return this.log.reduce((a, e) => a + e.net, 0);
  }

  clear(): void {
    this.log = [];
    this.live = null;
  }
}

// ═══════════════════════ replay reconstruction ═══════════════════════

interface ReplayFrame {
  pot: number;
  committed: Map<number, number>;
  folded: Set<number>;
  boardCount: number;
  street: Street;
  line: string;
  actorSeat: number;
}

function verbFor(a: Action): string {
  switch (a.kind) {
    case 'fold': return 'folds';
    case 'check': return 'checks';
    case 'call': return 'calls';
    case 'bet': return 'bets';
    case 'raise': return 'raises to';
    case 'allin': return 'is all in for';
    case 'post': return 'posts';
    default: return 'antes';
  }
}

function boardCountFor(street: Street): number {
  return street === 'preflop' ? 0 : street === 'flop' ? 3 : street === 'turn' ? 4 : 5;
}

function buildFrames(replay: HandReplay, deadMoney: number, nameOf: (seat: number) => string, fmt: (v: number) => string): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  const committed = new Map<number, number>();
  const folded = new Set<number>();
  let pot = deadMoney;
  let street: Street = 'preflop';

  frames.push({
    pot,
    committed: new Map(committed),
    folded: new Set(folded),
    boardCount: 0,
    street: 'preflop',
    line: 'Blinds posted — cards in the air',
    actorSeat: -1,
  });

  for (const a of replay.actions) {
    if (a.street !== street) {
      for (const v of committed.values()) pot += v;
      committed.clear();
      street = a.street;
      frames.push({
        pot,
        committed: new Map(),
        folded: new Set(folded),
        boardCount: boardCountFor(street),
        street,
        line: `${street.charAt(0).toUpperCase()}${street.slice(1)}`,
        actorSeat: -1,
      });
    }
    if (a.kind === 'fold') folded.add(a.seat);
    else if (a.amount > 0) committed.set(a.seat, a.amount);
    const shown = a.kind === 'fold' || a.kind === 'check' ? '' : ` ${fmt(a.amount)}`;
    frames.push({
      pot,
      committed: new Map(committed),
      folded: new Set(folded),
      boardCount: boardCountFor(street),
      street,
      line: `${nameOf(a.seat)} ${verbFor(a)}${shown}`,
      actorSeat: a.seat,
    });
  }

  for (const v of committed.values()) pot += v;
  const winners = replay.results.filter((r) => r.won > 0);
  frames.push({
    pot,
    committed: new Map(),
    folded: new Set(folded),
    boardCount: replay.board.length,
    street: 'showdown',
    line: winners.length
      ? winners.map((w) => `${nameOf(w.seat)} wins ${fmt(w.won)}`).join(' · ')
      : 'Pot awarded',
    actorSeat: winners[0]?.seat ?? -1,
  });

  return frames;
}

// ═══════════════════════ panel ═══════════════════════

export interface HistoryPanel {
  el: HTMLElement;
  openLog(): void;
  openReplay(entry: HandLogEntry): void;
  /** Opens the most recent hand, or shows the log's empty state. */
  openLastHand(): void;
  refresh(): void;
  close(): void;
  dispose(): void;
}

export interface HistoryPanelOptions {
  recorder: HandRecorder;
  fmt: (v: number) => string;
  heroSeat: () => number;
}

export function createHistoryPanel(opts: HistoryPanelOptions): HistoryPanel {
  const { recorder, fmt } = opts;

  const netEl = h('span', { class: 'hl__net tnum' }, fmt(0));
  const handsEl = h('span', { class: 'hl__hands tnum' }, '0 hands');
  const summary = h(
    'div',
    { class: 'hl__summary' },
    h('div', { class: 'hl__sum-l' }, h('span', { class: 'hl__cap' }, 'SESSION'), netEl),
    handsEl,
  );
  const list = h('div', { class: 'hl__list' });
  const logSheet = createSheet({ title: 'Hand History', className: 'sheet--tall', id: 'table-history' });
  logSheet.body.append(summary, list);

  // ── replay viewer
  const rpBoard = h('div', { class: 'rp__board' });
  const rpPot = h('div', { class: 'rp__pot tnum' }, fmt(0));
  const rpSeats = h('div', { class: 'rp__seats' });
  const rpLine = h('div', { class: 'rp__line' }, '');
  const rpFill = h('i', { class: 'rp__fill' });
  const rpThumb = h('i', { class: 'rp__thumb' });
  const rpTrack = h('div', { class: 'rp__track' }, h('i', { class: 'rp__groove' }), rpFill, rpThumb);
  const rpStreetEl = h('div', { class: 'rp__street' }, 'PREFLOP');
  const rpStep = h('div', { class: 'rp__stepn tnum' }, '');
  const prevBtn = h('button', { class: 'rp__b', type: 'button', 'aria-label': 'Previous action' }, icon('step', 18));
  prevBtn.classList.add('is-flip');
  const playBtn = h('button', { class: 'rp__b rp__b--play', type: 'button', 'aria-label': 'Play' }, icon('play', 20));
  const nextBtn = h('button', { class: 'rp__b', type: 'button', 'aria-label': 'Next action' }, icon('step', 18));
  const controls = h('div', { class: 'rp__ctrl' }, prevBtn, playBtn, nextBtn);
  const rp = h(
    'div',
    { class: 'rp' },
    h('div', { class: 'rp__stage' }, rpStreetEl, rpBoard, h('div', { class: 'rp__potwrap' }, h('span', { class: 'rp__pot-l' }, 'POT'), rpPot)),
    rpSeats,
    rpLine,
    h('div', { class: 'rp__scrub' }, rpTrack, rpStep),
    controls,
  );
  const replaySheet = createSheet({ title: 'Replay', className: 'sheet--tall', id: 'table-replay' });
  replaySheet.body.appendChild(rp);

  const el = h('div', { class: 'history-host' }, logSheet.el, replaySheet.el);

  // ── replay state
  let frames: ReplayFrame[] = [];
  let current: HandLogEntry | null = null;
  let index = 0;
  let playing = false;
  let stopPlay: (() => void) | null = null;
  let acc = 0;

  const nameOf = (seat: number): string =>
    current?.replay.seats.find((s) => s.seat === seat)?.name ?? `Seat ${seat + 1}`;

  const paintFrame = (): void => {
    if (!current || frames.length === 0) return;
    const f = frames[clamp(index, 0, frames.length - 1)];
    rpBoard.replaceChildren(
      ...current.replay.board.slice(0, f.boardCount).map((c) => cardFace(c, 'md')),
      ...Array.from({ length: Math.max(0, 5 - Math.min(5, f.boardCount)) }, () => h('i', { class: 'rp__slot' })),
    );
    setText(rpPot, fmt(f.pot + Array.from(f.committed.values()).reduce((a, v) => a + v, 0)));
    setText(rpStreetEl, f.street.toUpperCase());
    setText(rpLine, f.line);
    setText(rpStep, `${index + 1} / ${frames.length}`);
    const t = frames.length > 1 ? index / (frames.length - 1) : 1;
    rpFill.style.transform = `scaleX(${t.toFixed(4)})`;
    rpThumb.style.transform = `translate3d(${(t * Math.max(0, rpTrack.clientWidth - 18)).toFixed(1)}px, 0, 0)`;

    for (const row of rpSeats.children) {
      const seat = Number((row as HTMLElement).dataset.seat);
      cls(row as HTMLElement, 'is-folded', f.folded.has(seat));
      cls(row as HTMLElement, 'is-actor', seat === f.actorSeat);
      const bet = f.committed.get(seat) ?? 0;
      const betEl = (row as HTMLElement).querySelector('.rps__bet') as HTMLElement | null;
      if (betEl) {
        setText(betEl, bet > 0 ? fmt(bet) : '');
        cls(betEl, 'is-shown', bet > 0);
      }
    }
  };

  const setIndex = (i: number): void => {
    const next = clamp(Math.round(i), 0, Math.max(0, frames.length - 1));
    if (next === index) return;
    index = next;
    paintFrame();
    haptic('tick');
  };

  const setPlaying = (on: boolean): void => {
    playing = on;
    playBtn.replaceChildren(icon(on ? 'pause' : 'play', 20));
    if (on) {
      if (index >= frames.length - 1) {
        index = 0;
        paintFrame();
      }
      acc = 0;
      stopPlay = onFrame((dt) => {
        acc += dt;
        if (acc < 780) return;
        acc = 0;
        if (index >= frames.length - 1) {
          setPlaying(false);
          return;
        }
        index++;
        paintFrame();
        cue('chipClick', 0, 0.35);
      });
    } else if (stopPlay) {
      stopPlay();
      stopPlay = null;
    }
  };

  press(playBtn, {
    haptic: 'select',
    sfx: 'tapPrimary',
    onPress: () => setPlaying(!playing),
  });
  press(prevBtn, {
    haptic: 'tick',
    sfx: 'tapSecondary',
    onPress: () => {
      setPlaying(false);
      setIndex(index - 1);
    },
  });
  press(nextBtn, {
    haptic: 'tick',
    sfx: 'tapSecondary',
    onPress: () => {
      setPlaying(false);
      setIndex(index + 1);
    },
  });
  press(rpTrack, {
    slop: 10000,
    onDown: (e) => {
      setPlaying(false);
      scrubTo(e.clientX);
    },
    onMove: (e) => scrubTo(e.clientX),
  });

  function scrubTo(clientX: number): void {
    const r = rpTrack.getBoundingClientRect();
    const t = clamp((clientX - r.left - 9) / Math.max(1, r.width - 18), 0, 1);
    setIndex(t * Math.max(0, frames.length - 1));
  }

  replaySheet.onClosed = () => setPlaying(false);

  const openReplay = (entry: HandLogEntry): void => {
    current = entry;
    index = 0;
    frames = buildFrames(entry.replay, entry.deadMoney, nameOf, fmt);
    replaySheet.setTitle(`Hand #${entry.handId}`);
    rpSeats.replaceChildren(
      ...entry.replay.seats.map((sd) => {
        const isHero = sd.seat === opts.heroSeat();
        const cards = sd.holeCards && sd.holeCards.length
          ? cardRow(byRankDesc(sd.holeCards), 'xs')
          : h('div', { class: 'mcard-row' }, cardBack('xs'), cardBack('xs'));
        return h(
          'div',
          { class: `rps${isHero ? ' is-hero' : ''}`, 'data-seat': String(sd.seat) },
          h('span', { class: 'rps__name' }, sd.name),
          cards,
          h('span', { class: 'rps__stack tnum' }, fmt(sd.startStack)),
          h('span', { class: 'rps__bet tnum' }, ''),
        );
      }),
    );
    paintFrame();
    replaySheet.open();
    // Track width is only measurable once the sheet is laid out.
    requestAnimationFrame(paintFrame);
  };

  const rowFor = (entry: HandLogEntry): HTMLElement => {
    const netClass = entry.net > 0 ? 'is-up' : entry.net < 0 ? 'is-down' : 'is-flat';
    const row = h(
      'button',
      { class: `hl__row ${netClass}`, type: 'button' },
      h('span', { class: 'hl__n tnum' }, `#${entry.handId}`),
      entry.hole.length ? cardRow(byRankDesc(entry.hole), 'xs') : h('div', { class: 'mcard-row' }, cardBack('xs'), cardBack('xs')),
      h('span', { class: 'hl__label' }, entry.label),
      h('span', { class: 'hl__delta tnum' }, `${entry.net > 0 ? '+' : entry.net < 0 ? '−' : ''}${fmt(Math.abs(entry.net))}`),
      h('i', { class: 'hl__chev' }, icon('chevron-right', 15)),
    );
    press(row, { haptic: 'select', sfx: 'tapPrimary', onPress: () => openReplay(entry) });
    return row;
  };

  const refresh = (): void => {
    const entries = recorder.entries();
    const net = recorder.net();
    setText(netEl, `${net > 0 ? '+' : net < 0 ? '−' : ''}${fmt(Math.abs(net))}`);
    cls(netEl, 'is-up', net > 0);
    cls(netEl, 'is-down', net < 0);
    setText(handsEl, `${entries.length} hand${entries.length === 1 ? '' : 's'}`);
    if (entries.length === 0) {
      list.replaceChildren(
        emptyState(
          'No hands yet',
          'Your session log fills in as you play. Every hand can be replayed here, step by step.',
          icon('history', 26),
        ),
      );
      return;
    }
    list.replaceChildren(...entries.map(rowFor));
  };

  return {
    el,
    openLog(): void {
      refresh();
      logSheet.open();
    },
    openReplay,
    openLastHand(): void {
      const last = recorder.last();
      if (last) openReplay(last);
      else {
        refresh();
        logSheet.open();
      }
    },
    refresh,
    close(): void {
      setPlaying(false);
      replaySheet.close();
      logSheet.close();
    },
    dispose(): void {
      setPlaying(false);
      logSheet.dispose();
      replaySheet.dispose();
      el.remove();
    },
  };
}

export { STREET_ORDER };
