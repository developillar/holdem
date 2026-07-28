/**
 * ROYALE — ui/feed/replay.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The full-screen hand replay. Pure DOM and CSS — it deliberately does not
 * touch the 3D stage, so it opens instantly from anywhere in the app and works
 * while a table is live underneath.
 *
 *   openReplay(post.hand, { focusSeat, title });
 *
 * It rebuilds the hand from its action list the same way the engine would:
 * blinds, streets, commitments, side-pot-free totals, and a showdown. Chips
 * physically travel from the acting seat to the pot, the board deals card by
 * card, and the scrubber can be dragged to any moment in the hand.
 */
import { h, cx, clear } from '../dom.ts';
import type { Action, CardId, HandReplay, Street } from '../../core/types.ts';
import { cash } from './util.ts';
import { Avatar } from '../components/avatar.ts';
import { haptic, reduceMotion, clamp } from '../components/util.ts';
import { MiniBoard, MiniCard } from './minicards.ts';
import { transportMark } from './glyphs.ts';

type Step =
  | { t: 'action'; action: Action }
  | { t: 'deal'; street: Street; cards: CardId[] }
  | { t: 'showdown' }
  | { t: 'award' };

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];
const STREET_LABEL: Record<Street, string> = {
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
};

const STEP_MS: Record<Step['t'], number> = {
  action: 880,
  deal: 760,
  showdown: 1500,
  award: 1400,
};

export interface ReplayOpts {
  /** the seat the post is about — gets the hero treatment at the bottom */
  focusSeat?: number;
  title?: string;
  subtitle?: string;
  onShare?: () => void;
}

export interface ReplayHandle {
  close(): void;
  el: HTMLElement;
}

interface SeatView {
  seat: number;
  root: HTMLElement;
  stack: HTMLElement;
  act: HTMLElement;
  bet: HTMLElement;
  cards: HTMLElement;
  inHand: boolean;
}

function actionText(a: Action, prevCommitted: number): string {
  switch (a.kind) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return `Call ${cash(a.amount)}`;
    case 'bet':
      return `Bet ${cash(a.amount)}`;
    case 'raise':
      return `Raise to ${cash(a.amount)}`;
    case 'allin':
      return `All in ${cash(a.amount)}`;
    case 'post':
      return `Post ${cash(a.amount)}`;
    case 'ante':
      return `Ante ${cash(a.amount)}`;
    default:
      return cash(Math.max(0, a.amount - prevCommitted));
  }
}

function buildSteps(replay: HandReplay): Step[] {
  const steps: Step[] = [];
  const of = (s: Street): Action[] => replay.actions.filter((a) => a.street === s);
  for (const a of of('preflop')) steps.push({ t: 'action', action: a });
  if (replay.board.length >= 3) {
    steps.push({ t: 'deal', street: 'flop', cards: replay.board.slice(0, 3) });
    for (const a of of('flop')) steps.push({ t: 'action', action: a });
  }
  if (replay.board.length >= 4) {
    steps.push({ t: 'deal', street: 'turn', cards: replay.board.slice(3, 4) });
    for (const a of of('turn')) steps.push({ t: 'action', action: a });
  }
  if (replay.board.length >= 5) {
    steps.push({ t: 'deal', street: 'river', cards: replay.board.slice(4, 5) });
    for (const a of of('river')) steps.push({ t: 'action', action: a });
  }
  if (replay.results.filter((r) => r.rank).length >= 2) steps.push({ t: 'showdown' });
  steps.push({ t: 'award' });
  return steps;
}

interface Frame {
  stacks: Map<number, number>;
  committed: Map<number, number>;
  folded: Set<number>;
  allin: Set<number>;
  board: CardId[];
  pot: number;
  street: Street;
  acting: number;
  lastText: Map<number, string>;
  revealed: boolean;
  awarded: boolean;
}

function frameAt(replay: HandReplay, steps: Step[], upTo: number): Frame {
  const f: Frame = {
    stacks: new Map(),
    committed: new Map(),
    folded: new Set(),
    allin: new Set(),
    board: [],
    pot: 0,
    street: 'preflop',
    acting: -1,
    lastText: new Map(),
    revealed: false,
    awarded: false,
  };
  for (const s of replay.seats) f.stacks.set(s.seat, s.startStack);

  let street: Street = 'preflop';
  for (let i = 0; i <= upTo && i < steps.length; i++) {
    const st = steps[i];
    if (st.t === 'deal') {
      street = st.street;
      f.street = street;
      for (const c of st.cards) if (!f.board.includes(c)) f.board.push(c);
      f.committed.clear();
      f.lastText.clear();
      f.acting = -1;
      continue;
    }
    if (st.t === 'showdown') {
      f.street = 'showdown';
      f.revealed = true;
      f.acting = -1;
      continue;
    }
    if (st.t === 'award') {
      f.awarded = true;
      f.revealed = true;
      f.acting = -1;
      continue;
    }
    const a = st.action;
    const prev = f.committed.get(a.seat) ?? 0;
    f.acting = a.seat;
    if (a.kind === 'fold') {
      f.folded.add(a.seat);
      f.lastText.set(a.seat, 'Fold');
      continue;
    }
    if (a.kind === 'check') {
      f.lastText.set(a.seat, 'Check');
      continue;
    }
    const delta = Math.max(0, a.amount - prev);
    f.committed.set(a.seat, a.amount);
    f.pot = Math.round((f.pot + delta) * 100) / 100;
    const stack = Math.round(((f.stacks.get(a.seat) ?? 0) - delta) * 100) / 100;
    f.stacks.set(a.seat, Math.max(0, stack));
    if (stack <= 0.001) f.allin.add(a.seat);
    f.lastText.set(a.seat, actionText(a, prev));
  }
  return f;
}

let host: HTMLElement | null = null;

/** Lets the shell nominate a layer; falls back to `document.body`. */
export function setReplayHost(el: HTMLElement): void {
  host = el;
}

export function openReplay(replay: HandReplay, opts: ReplayOpts = {}): ReplayHandle {
  const parent = host ?? document.body;
  const steps = buildSteps(replay);
  const last = steps.length - 1;
  const focus = opts.focusSeat ?? replay.results.slice().sort((a, b) => b.won - a.won)[0]?.seat ?? replay.seats[0]?.seat ?? 0;

  let index = 0;
  let playing = false;
  let timer = 0;
  let closed = false;

  // ── chrome ───────────────────────────────────────────────────────
  const closeBtn = h(
    'button',
    { class: 'rvw__x', type: 'button', 'aria-label': 'Close replay' },
    h(
      'svg',
      { attrs: { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' } },
      h('path', { attrs: { d: 'M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6', stroke: 'currentColor', 'stroke-width': 2.1, 'stroke-linecap': 'round' } }),
    ),
  ) as HTMLButtonElement;

  const shareBtn = opts.onShare
    ? (h(
        'button',
        { class: 'rvw__share', type: 'button', 'aria-label': 'Share this hand' },
        h(
          'svg',
          { attrs: { viewBox: '0 0 24 24', width: 17, height: 17, 'aria-hidden': 'true' } },
          h('path', { attrs: { d: 'M12 15.2V3.8M8.6 7.2L12 3.8l3.4 3.4', stroke: 'currentColor', 'stroke-width': 1.8, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }),
          h('path', { attrs: { d: 'M6.8 10.9H5.6a1.6 1.6 0 00-1.6 1.6v6.2a1.6 1.6 0 001.6 1.6h12.8a1.6 1.6 0 001.6-1.6v-6.2a1.6 1.6 0 00-1.6-1.6h-1.2', stroke: 'currentColor', 'stroke-width': 1.8, fill: 'none', 'stroke-linecap': 'round' } }),
        ),
      ) as HTMLButtonElement)
    : null;

  const top = h(
    'header',
    { class: 'rvw__top' },
    closeBtn,
    h(
      'div',
      { class: 'rvw__titles' },
      h('div', { class: 'rvw__title' }, opts.title ?? `Hand #${replay.handId}`),
      h(
        'div',
        { class: 'rvw__sub' },
        opts.subtitle ?? `${replay.stakeLabel} · ${replay.variant === 'plo4' ? 'PLO' : "Hold'em"}`,
      ),
    ),
    shareBtn,
  );

  // ── stage ────────────────────────────────────────────────────────
  const felt = h('div', { class: 'rvw__felt', 'aria-hidden': 'true' }, h('span', { class: 'rvw__feltring' }), h('span', { class: 'rvw__feltglow' }));
  const boardWrap = h('div', { class: 'rvw__board' });
  const potValue = h('span', { class: 'rvw__potv tnum' }, cash(0));
  const potChip = h(
    'div',
    { class: 'rvw__pot' },
    h('span', { class: 'rvw__potcap caps' }, 'Pot'),
    potValue,
  );
  const center = h('div', { class: 'rvw__center' }, potChip, boardWrap);
  const seatLayer = h('div', { class: 'rvw__seats' });
  const chipLayer = h('div', { class: 'rvw__chips', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'rvw__stage' }, felt, seatLayer, center, chipLayer);
  // Heads-up and three-handed tables need a tighter oval or the felt reads empty.
  const seatCountForFelt = replay.seats.filter((s) => replay.actions.some((a) => a.seat === s.seat) || (s.holeCards && s.holeCards.length > 0)).length;
  stage.dataset.seats = String(Math.max(2, seatCountForFelt));

  // ── seats ────────────────────────────────────────────────────────
  const seated = replay.seats.filter((s) => {
    const acted = replay.actions.some((a) => a.seat === s.seat);
    return acted || (s.holeCards && s.holeCards.length > 0);
  });
  const n = Math.max(2, seated.length);
  const focusIdx = Math.max(0, seated.findIndex((s) => s.seat === focus));
  const views = new Map<number, SeatView>();

  seated.forEach((row, i) => {
    // Rotate so the focused seat sits at the bottom of the oval.
    const slot = (i - focusIdx + n) % n;
    const angle = Math.PI / 2 + (slot * 2 * Math.PI) / n;
    const x = 50 + Math.cos(angle) * 37;
    const y = 48 + Math.sin(angle) * 32;
    const stackEl = h('span', { class: 'rvwseat__stack tnum' }, cash(row.startStack));
    const actEl = h('span', { class: 'rvwseat__act' });
    const betEl = h('span', { class: 'rvwseat__bet tnum' });
    const cardsEl = h('span', { class: 'rvwseat__cards' });
    const root = h(
      'div',
      {
        class: cx('rvwseat', slot === 0 && 'is-hero', row.seat === replay.buttonSeat && 'is-btn'),
        style: { left: `${x}%`, top: `${y}%` },
      },
      betEl,
      h(
        'div',
        { class: 'rvwseat__plate' },
        h('span', { class: 'rvwseat__av' }, Avatar({ name: row.name, avatarId: row.avatarId, size: 28, level: null })),
        h(
          'span',
          { class: 'rvwseat__col' },
          h('span', { class: 'rvwseat__name', title: row.name }, row.name),
          stackEl,
        ),
        row.seat === replay.buttonSeat ? h('span', { class: 'rvwseat__d' }, 'D') : null,
      ),
      cardsEl,
      actEl,
    );
    seatLayer.appendChild(root);
    views.set(row.seat, { seat: row.seat, root, stack: stackEl, act: actEl, bet: betEl, cards: cardsEl, inHand: true });
  });

  // ── controls ─────────────────────────────────────────────────────
  const streetStrip = h('div', { class: 'rvw__streets' });
  const streetEls = new Map<Street, HTMLElement>();
  for (const s of STREETS) {
    const stepsHere = steps.some((st) => (st.t === 'action' && st.action.street === s) || (st.t === 'deal' && st.street === s)) ||
      (s === 'showdown' && steps.some((st) => st.t === 'showdown'));
    const el = h('span', { class: cx('rvw__street', !stepsHere && 'is-off') }, STREET_LABEL[s]);
    streetEls.set(s, el);
    streetStrip.appendChild(el);
  }

  const scrubFill = h('span', { class: 'rvwscrub__fill' });
  const scrubThumb = h('span', { class: 'rvwscrub__thumb' });
  const scrubTicks = h('span', { class: 'rvwscrub__ticks', 'aria-hidden': 'true' });
  steps.forEach((st, i) => {
    if (st.t !== 'deal' && st.t !== 'showdown') return;
    scrubTicks.appendChild(h('i', { style: { left: `${(i / Math.max(1, last)) * 100}%` } }));
  });
  const scrub = h(
    'div',
    {
      class: 'rvwscrub',
      role: 'slider',
      tabIndex: 0,
      'aria-label': 'Scrub the hand',
      'aria-valuemin': '0',
      'aria-valuemax': String(last),
      'aria-valuenow': '0',
    },
    h('span', { class: 'rvwscrub__track' }, scrubFill, scrubTicks),
    scrubThumb,
  );

  const playBtn = h('button', { class: 'rvw__play', type: 'button', 'aria-label': 'Play' }, transportMark('play', 20)) as HTMLButtonElement;
  const prevBtn = h('button', { class: 'rvw__step', type: 'button', 'aria-label': 'Previous action' }, transportMark('prev', 17)) as HTMLButtonElement;
  const nextBtn = h('button', { class: 'rvw__step', type: 'button', 'aria-label': 'Next action' }, transportMark('next', 17)) as HTMLButtonElement;
  const speedBtn = h('button', { class: 'rvw__speed', type: 'button', 'aria-label': 'Playback speed' }, '1×') as HTMLButtonElement;
  let speed = 1;

  const caption = h('div', { class: 'rvw__caption' });

  const controls = h(
    'div',
    { class: 'rvw__ctl' },
    streetStrip,
    caption,
    scrub,
    h('div', { class: 'rvw__transport' }, prevBtn, playBtn, nextBtn, speedBtn),
  );

  const el = h('div', { class: 'rvw', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Hand replay' }, top, stage, controls);

  // ── chip flight ──────────────────────────────────────────────────
  const flyChips = (seat: number, amount: number): void => {
    if (reduceMotion() || amount <= 0) return;
    const view = views.get(seat);
    if (!view) return;
    const box = stage.getBoundingClientRect();
    const from = view.root.getBoundingClientRect();
    const to = potChip.getBoundingClientRect();
    const fx = from.left + from.width / 2 - box.left;
    const fy = from.top + from.height / 2 - box.top;
    const tx = to.left + to.width / 2 - box.left;
    const ty = to.top + to.height / 2 - box.top;
    const count = amount > 0 ? Math.min(5, 1 + Math.floor(Math.log10(1 + amount) * 2)) : 1;
    for (let i = 0; i < count; i++) {
      const chip = h('i', {
        class: 'rvwchip',
        style: {
          '--fx': `${fx.toFixed(1)}px`,
          '--fy': `${fy.toFixed(1)}px`,
          '--tx': `${(tx + (Math.random() - 0.5) * 16).toFixed(1)}px`,
          '--ty': `${(ty + (Math.random() - 0.5) * 12).toFixed(1)}px`,
          '--cd': `${i * 55}ms`,
        },
      });
      chipLayer.appendChild(chip);
      window.setTimeout(() => chip.remove(), 900 + i * 55);
    }
  };

  // ── painting ─────────────────────────────────────────────────────
  let lastBoardLen = -1;
  let lastPot = -1;

  const paint = (animate: boolean): void => {
    const f = frameAt(replay, steps, index);

    // board
    if (f.board.length !== lastBoardLen) {
      clear(boardWrap);
      boardWrap.appendChild(
        MiniBoard(f.board, { size: 36, slots: 5, highlight: f.revealed ? winningCards() : [] }),
      );
      lastBoardLen = f.board.length;
    } else if (f.revealed) {
      clear(boardWrap);
      boardWrap.appendChild(MiniBoard(f.board, { size: 36, slots: 5, highlight: winningCards() }));
    }

    // pot
    if (Math.abs(f.pot - lastPot) > 0.001) {
      potValue.textContent = cash(f.pot);
      if (animate && !reduceMotion()) {
        potChip.classList.remove('is-bump');
        void potChip.offsetWidth;
        potChip.classList.add('is-bump');
      }
      lastPot = f.pot;
    }

    // seats
    for (const [seat, view] of views) {
      const row = replay.seats.find((s) => s.seat === seat);
      const folded = f.folded.has(seat);
      view.root.classList.toggle('is-folded', folded);
      view.root.classList.toggle('is-acting', f.acting === seat && !f.awarded);
      view.root.classList.toggle('is-allin', f.allin.has(seat));
      view.stack.textContent = cash(f.stacks.get(seat) ?? 0);
      const bet = f.committed.get(seat) ?? 0;
      view.bet.textContent = bet > 0 ? cash(bet) : '';
      view.bet.classList.toggle('is-on', bet > 0);
      const txt = f.lastText.get(seat) ?? '';
      view.act.textContent = txt;
      view.act.classList.toggle('is-on', !!txt && !folded);

      // Hole cards. The seat the post is about is face-up from the first
      // action — you already saw those cards on the card you tapped, and
      // watching your own hand play out is the whole point of a replay.
      const known = !!row?.holeCards && row.holeCards.length > 0;
      // A mucked hand is never public, and `folded` does not cover it — a
      // player can reach showdown and still muck. Without this check the
      // replay would expose hole cards that were never shown at the table.
      const mucked = replay.results.some((r) => r.seat === seat && r.mucked);
      const show = known && !folded && !mucked && (f.revealed || seat === focus);
      const wantKey = show ? (row!.holeCards as CardId[]).join(',') : folded ? 'folded' : 'down';
      if (view.cards.dataset.key !== wantKey) {
        view.cards.dataset.key = wantKey;
        clear(view.cards);
        if (show) {
          const win = winningCardsFor(seat);
          for (const c of row!.holeCards as CardId[]) {
            view.cards.appendChild(MiniCard(c, { size: 23, win: win.includes(c) }));
          }
        } else if (!folded) {
          view.cards.appendChild(MiniCard(null, { size: 23, down: true }));
          view.cards.appendChild(MiniCard(null, { size: 23, down: true }));
        }
      }

      // award glow
      const won = f.awarded ? replay.results.find((r) => r.seat === seat && r.won > 0) : null;
      view.root.classList.toggle('is-winner', !!won);
    }

    // street strip
    for (const [s, node] of streetEls) node.classList.toggle('is-now', s === f.street);

    // caption
    const st = steps[index];
    caption.textContent = captionFor(st, f);

    // scrubber
    const pct = last > 0 ? (index / last) * 100 : 100;
    scrubFill.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
    scrubThumb.style.left = `${pct}%`;
    scrub.setAttribute('aria-valuenow', String(index));
    scrub.setAttribute('aria-valuetext', caption.textContent || STREET_LABEL[f.street]);
  };

  const winningCards = (): CardId[] => {
    const best = replay.results.filter((r) => r.won > 0 && r.rank).sort((a, b) => (b.rank?.value ?? 0) - (a.rank?.value ?? 0))[0];
    return best?.rank?.best ?? [];
  };
  const winningCardsFor = (seat: number): CardId[] => {
    const r = replay.results.find((x) => x.seat === seat);
    return r && r.won > 0 ? r.rank?.best ?? [] : [];
  };

  function captionFor(st: Step | undefined, f: Frame): string {
    if (!st) return '';
    if (st.t === 'deal') return `${STREET_LABEL[st.street]} — ${st.cards.length === 1 ? 'one card' : 'three cards'}`;
    if (st.t === 'showdown') return 'Cards on their backs';
    if (st.t === 'award') {
      const w = replay.results.filter((r) => r.won > 0);
      if (!w.length) return 'Hand complete';
      const names = w.map((r) => replay.seats.find((s) => s.seat === r.seat)?.name ?? `Seat ${r.seat + 1}`);
      const label = w[0].rank?.label;
      return `${names.join(' & ')} wins ${cash(w[0].won * w.length)}${label ? ` with ${label}` : ''}`;
    }
    const name = replay.seats.find((s) => s.seat === st.action.seat)?.name ?? `Seat ${st.action.seat + 1}`;
    return `${name} — ${f.lastText.get(st.action.seat) ?? ''}`;
  }

  // ── stepping ─────────────────────────────────────────────────────
  const applyStepEffects = (i: number): void => {
    const st = steps[i];
    if (!st) return;
    if (st.t === 'action') {
      const before = frameAt(replay, steps, i - 1);
      const prev = before.committed.get(st.action.seat) ?? 0;
      const delta = st.action.kind === 'fold' || st.action.kind === 'check' ? 0 : Math.max(0, st.action.amount - prev);
      if (delta > 0) flyChips(st.action.seat, delta);
      if (st.action.kind === 'allin') haptic('bet');
    } else if (st.t === 'deal') {
      haptic('deal');
    } else if (st.t === 'award') {
      haptic('win');
      el.classList.add('is-won');
      window.setTimeout(() => el.classList.remove('is-won'), 1400);
    }
  };

  const goTo = (i: number, effects: boolean): void => {
    const next = clamp(Math.round(i), 0, last);
    const moved = next !== index;
    index = next;
    if (effects && moved) applyStepEffects(index);
    paint(effects);
    if (index >= last) stop();
  };

  const tick = (): void => {
    if (!playing || closed) return;
    if (index >= last) {
      stop();
      return;
    }
    index += 1;
    applyStepEffects(index);
    paint(true);
    const st = steps[index];
    const base = STEP_MS[st?.t ?? 'action'];
    timer = window.setTimeout(tick, Math.max(180, base / speed));
  };

  function play(): void {
    if (playing) return;
    if (index >= last) {
      index = 0;
      lastBoardLen = -1;
      lastPot = -1;
      paint(false);
    }
    playing = true;
    playBtn.classList.add('is-playing');
    clear(playBtn);
    playBtn.appendChild(transportMark('pause', 20));
    playBtn.setAttribute('aria-label', 'Pause');
    timer = window.setTimeout(tick, 320);
  }

  function stop(): void {
    playing = false;
    window.clearTimeout(timer);
    playBtn.classList.remove('is-playing');
    clear(playBtn);
    playBtn.appendChild(transportMark(index >= last ? 'restart' : 'play', 20));
    playBtn.setAttribute('aria-label', index >= last ? 'Replay' : 'Play');
  }

  playBtn.addEventListener('click', () => {
    haptic('tick');
    if (playing) stop();
    else play();
  });
  prevBtn.addEventListener('click', () => {
    stop();
    haptic('tick');
    goTo(index - 1, false);
  });
  nextBtn.addEventListener('click', () => {
    stop();
    haptic('tick');
    goTo(index + 1, true);
  });
  speedBtn.addEventListener('click', () => {
    speed = speed === 1 ? 1.75 : speed === 1.75 ? 3 : 1;
    speedBtn.textContent = speed === 1.75 ? '1.75×' : `${speed}×`;
    haptic('tick');
  });

  // scrubbing
  let scrubbing = false;
  const seekFromEvent = (clientX: number): void => {
    const box = scrub.getBoundingClientRect();
    const t = clamp((clientX - box.left) / Math.max(1, box.width), 0, 1);
    goTo(t * last, false);
  };
  scrub.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    scrubbing = true;
    stop();
    scrub.setPointerCapture(e.pointerId);
    scrub.classList.add('is-drag');
    seekFromEvent(e.clientX);
  });
  scrub.addEventListener('pointermove', (ev) => {
    if (!scrubbing) return;
    seekFromEvent((ev as PointerEvent).clientX);
  });
  const endScrub = (ev: Event): void => {
    if (!scrubbing) return;
    scrubbing = false;
    scrub.classList.remove('is-drag');
    try {
      scrub.releasePointerCapture((ev as PointerEvent).pointerId);
    } catch {
      /* pointer already released */
    }
  };
  scrub.addEventListener('pointerup', endScrub);
  scrub.addEventListener('pointercancel', endScrub);
  scrub.addEventListener('keydown', (ev) => {
    const k = (ev as KeyboardEvent).key;
    if (k === 'ArrowRight') {
      ev.preventDefault();
      stop();
      goTo(index + 1, true);
    } else if (k === 'ArrowLeft') {
      ev.preventDefault();
      stop();
      goTo(index - 1, false);
    } else if (k === ' ') {
      ev.preventDefault();
      playing ? stop() : play();
    }
  });

  if (shareBtn) shareBtn.addEventListener('click', () => opts.onShare?.());

  // ── lifecycle ────────────────────────────────────────────────────
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
    }
  };

  function close(): void {
    if (closed) return;
    closed = true;
    playing = false;
    window.clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    el.classList.add('is-closing');
    window.setTimeout(() => el.remove(), reduceMotion() ? 0 : 260);
  }

  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);

  parent.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  paint(false);
  window.setTimeout(() => {
    if (!closed) play();
  }, 460);

  return { close, el };
}
