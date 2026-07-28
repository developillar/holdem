/**
 * ROYALE — the community board, and the card layer that owns it.
 *
 * Five slots in the clear middle band of the felt. Empty slots are recessed
 * wells with a dashed hairline, filled slots are real cards, and the ratio of
 * one to the other is how you read the street from across the room — which is
 * why there is no label telling you.
 *
 * The choreography follows a live dealer, not a database:
 *   flop     three cards land 112 ms apart, snapping face-up as they arrive
 *   turn     one card, slower, from further away, with a gold bloom on landing
 *   river    the same beat again, longer and brighter — the last card matters
 *   showdown the five that make the winning hand take a gold rim; the rest dim
 *
 * The burn is still a real object on the felt: `render/dealing.ts` skates a
 * face-down slab to the muck before every street. That is the one part of the
 * board nobody ever has to read, so it stays where physicality is free.
 *
 * ── Ordering, and why nothing here races ──────────────────────────────────
 * Two sources describe the same board: `hand:deal-board` (an event, worth an
 * animation) and `table:state` (a snapshot, authoritative but silent). Which
 * arrives first depends on the driver, so a snapshot that runs ahead of its
 * deal event schedules a *silent* fill 150 ms out, and the deal event — if it
 * turns up inside that window — cancels it and plays the real entrance
 * instead. The board ends up correct whichever way round they land, and
 * correct with no bus traffic at all: `showBoard()` is the whole contract.
 */
import { bus } from '../../core/bus.ts';
import type { CardId, ShowdownResult, TableState } from '../../core/types.ts';
import { clamp, delay, h, onFrame, replay } from './dom.ts';
import {
  createCard,
  createHeroHand,
  flyIn,
  motionMs,
  EASE_OUT,
  EASE_SPRING,
  type CardEl,
  type HeroHand,
} from './herocards.ts';

// ─────────────────────────── the board row ───────────────────────────

const SLOTS = 5;
const MAX_HOLE = 4;

interface StreetDeal {
  fly: number;
  stagger: number;
  flip: number;
  spin: number;
  scale: number;
}

/** Per-street flight, in ms. The later the street, the more air it gets. */
const DEAL: Record<'flop' | 'turn' | 'river', StreetDeal> = {
  flop: { fly: 430, stagger: 112, flip: 320, spin: -16, scale: 0.52 },
  turn: { fly: 560, stagger: 0, flip: 380, spin: -26, scale: 0.44 },
  river: { fly: 650, stagger: 0, flip: 440, spin: -34, scale: 0.4 },
};

function streetKey(street: string): 'flop' | 'turn' | 'river' {
  if (street === 'turn') return 'turn';
  if (street === 'river') return 'river';
  return 'flop';
}

export interface BoardRow {
  readonly el: HTMLElement;
  /** how many community cards are on the felt */
  readonly count: number;
  /** Appends cards with the full street choreography. */
  reveal(cards: readonly CardId[], street: string): void;
  /** Reconciles to an exact board with no entrance flight. */
  sync(cards: readonly CardId[]): void;
  /** Gold rim on the cards that make the winning hand; null clears it. */
  highlight(cards: readonly CardId[] | null): void;
  clear(): void;
  /** Centres the row on a viewport point, in CSS px. */
  place(x: number, y: number): void;
  dispose(): void;
}

class Board implements BoardRow {
  readonly el: HTMLElement;

  private slots: HTMLElement[] = [];
  private flies: HTMLElement[] = [];
  private cards: CardEl[] = [];
  private anims: Array<Animation | null> = [];
  private blooms: Array<() => void> = [];
  private shown: Array<CardId | null> = new Array(SLOTS).fill(null);
  private origin: () => { x: number; y: number };
  private x = -1;
  private y = -1;

  constructor(origin: () => { x: number; y: number }) {
    this.origin = origin;
    this.el = h('div', { class: 'rboard', role: 'group', 'aria-label': 'Community cards' });
    for (let i = 0; i < SLOTS; i++) {
      const card = createCard();
      const fly = h('span', { class: 'rboard__fly' }, card.el);
      const well = h('span', { class: 'rboard__well', 'aria-hidden': 'true' });
      const slot = h('span', { class: 'rboard__slot' }, well, fly);
      slot.style.setProperty('--i', String(i));
      this.slots.push(slot);
      this.flies.push(fly);
      this.cards.push(card);
      this.anims.push(null);
      this.el.appendChild(slot);
    }
    this.el.dataset.filled = '0';
  }

  get count(): number {
    let n = 0;
    for (const c of this.shown) if (c !== null) n++;
    return n;
  }

  place(x: number, y: number): void {
    const px = Math.round(x * 2) / 2;
    const py = Math.round(y * 2) / 2;
    if (px === this.x && py === this.y) return;
    this.x = px;
    this.y = py;
    this.el.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -50%)`;
  }

  // ── content ─────────────────────────────────────────────────────

  private put(index: number, card: CardId): void {
    this.shown[index] = card;
    this.cards[index].setCard(card);
    this.cards[index].setWin(false);
    this.cards[index].setDim(false);
    this.slots[index].classList.add('is-on');
    this.el.dataset.filled = String(this.count);
  }

  reveal(cards: readonly CardId[], street: string): void {
    const key = streetKey(street);
    const t = DEAL[key];
    const empty = this.shown.findIndex((c) => c === null);
    const from = empty < 0 ? SLOTS : empty;

    for (let k = 0; k < cards.length; k++) {
      const i = from + k;
      if (i >= SLOTS) break;
      this.anims[i]?.cancel();
      this.cards[i].cancel();
      this.put(i, cards[k]);
      this.cards[i].setFaceUp(false, 0);

      const o = this.origin();
      const r = this.slots[i].getBoundingClientRect();
      const dx = o.x - (r.left + r.width / 2);
      const dy = o.y - (r.top + r.height / 2);
      const wait = k * t.stagger;

      this.anims[i] = flyIn(this.flies[i], dx, dy, {
        duration: t.fly,
        delay: wait,
        easing: key === 'flop' ? EASE_SPRING : EASE_OUT,
        spin: t.spin,
        scale: t.scale,
      });
      this.cards[i].setFaceUp(true, t.flip, wait + t.fly * 0.44);

      // The reveal beat: a rim bloom timed to the moment the face squares up.
      const slot = this.slots[i];
      slot.classList.toggle('is-drama', key !== 'flop');
      this.blooms.push(delay(motionMs(wait + t.fly * 0.66), () => replay(slot, 'is-bloom')));
    }
    if (this.blooms.length > 12) this.blooms.splice(0, this.blooms.length - 12);
  }

  sync(cards: readonly CardId[]): void {
    const next = cards.slice(0, SLOTS);
    for (let i = 0; i < SLOTS; i++) {
      const want = i < next.length ? next[i] : null;
      if (want === this.shown[i]) continue;
      this.anims[i]?.cancel();
      this.anims[i] = null;
      this.cards[i].cancel();
      if (want === null) {
        this.shown[i] = null;
        this.slots[i].classList.remove('is-on', 'is-bloom', 'is-drama', 'is-pop');
        this.cards[i].setFaceUp(false, 0);
        continue;
      }
      this.put(i, want);
      this.cards[i].setFaceUp(true, 0);
      replay(this.slots[i], 'is-pop');
    }
    this.el.dataset.filled = String(this.count);
  }

  highlight(cards: readonly CardId[] | null): void {
    if (!cards) {
      for (let i = 0; i < SLOTS; i++) {
        this.cards[i].setWin(false);
        this.cards[i].setDim(false);
      }
      this.el.classList.remove('is-showdown');
      return;
    }
    const set = new Set(cards);
    this.el.classList.add('is-showdown');
    for (let i = 0; i < SLOTS; i++) {
      const c = this.shown[i];
      const win = c !== null && set.has(c);
      this.cards[i].setWin(win);
      this.cards[i].setDim(c !== null && !win);
    }
  }

  clear(): void {
    for (const off of this.blooms) off();
    this.blooms.length = 0;
    for (let i = 0; i < SLOTS; i++) {
      this.anims[i]?.cancel();
      this.anims[i] = null;
      this.cards[i].cancel();
      this.cards[i].setWin(false);
      this.cards[i].setDim(false);
      this.cards[i].setFaceUp(false, 0);
      this.shown[i] = null;
      this.slots[i].classList.remove('is-on', 'is-bloom', 'is-drama', 'is-pop');
    }
    this.el.classList.remove('is-showdown');
    this.el.dataset.filled = '0';
  }

  dispose(): void {
    this.clear();
    this.el.remove();
  }
}

export function createBoard(origin: () => { x: number; y: number }): BoardRow {
  return new Board(origin);
}

// ─────────────────────────── the card layer ───────────────────────────

interface StageAnchorLike {
  x: number;
  y: number;
  visible: boolean;
}

interface StageBridge {
  anchors?: {
    board: StageAnchorLike[];
    pot: StageAnchorLike;
    dealer: StageAnchorLike;
  };
}

function stage(): StageBridge | null {
  const w = window as unknown as { __royale?: { renderer?: StageBridge } };
  return w.__royale?.renderer ?? null;
}

/** How long a silent state fill waits for its deal event to overtake it. */
const DEAL_GRACE_MS = 150;
/** Layout is re-measured on a cadence; the anchors are read every frame. */
const MEASURE_MS = 240;

export interface CardLayer {
  readonly el: HTMLElement;
  /** true while the layer is mounted in a live document */
  readonly active: boolean;
  readonly board: BoardRow;
  readonly hero: HeroHand;
  setHeroSeat(seat: number): void;
  /** Imperative: put exactly these community cards on the felt. */
  showBoard(cards: readonly CardId[]): void;
  /** Imperative: put exactly these hole cards in a seat's hand. */
  showHole(seat: number, cards: readonly CardId[]): void;
  /** Imperative: strip the felt of every readable card. */
  clear(): void;
  setVisible(on: boolean): void;
  /** Re-parents into the live table screen. Cheap, idempotent. */
  remount(): void;
  dispose(): void;
}

class Layer implements CardLayer {
  readonly el: HTMLElement;
  readonly board: BoardRow;
  readonly hero: HeroHand;

  private host: HTMLElement | null = null;
  private offs: Array<() => void> = [];
  private stopFrame: (() => void) | null = null;
  private pending: Array<() => void> = [];
  /** the board+hole the in-flight silent fill is targeting, or '' for none */
  private pendingKey = '';
  private heroCards: CardId[] = [];
  private heroSeat = 0;

  private measureAcc = 1e4;
  private topLimit = 124;
  private bottomLimit = 520;
  private heroGap = 152;
  private gapFloor = Number.POSITIVE_INFINITY;
  private lastVh = 0;
  private boardHalf = 38;
  private dead = false;

  constructor() {
    this.el = h('div', { class: 'rcards' });
    const origin = () => this.dealOrigin();
    this.board = createBoard(origin);
    this.hero = createHeroHand({ origin });
    this.el.append(this.board.el, this.hero.el);
    this.bindBus();
    this.startFrame();
    this.remeasure();
  }

  get active(): boolean {
    return !this.dead && this.el.isConnected;
  }

  /**
   * The frame loop exists only while the felt is on screen. A layer that kept
   * a rAF alive on the lobby would cost a phone battery for nothing, and the
   * shared table loop is meant to go quiet the moment the table does.
   */
  private startFrame(): void {
    if (this.stopFrame || this.dead) return;
    this.measureAcc = 1e4;
    this.stopFrame = onFrame((dt) => this.tick(dt));
  }

  private endFrame(): void {
    this.stopFrame?.();
    this.stopFrame = null;
  }

  // ── placement ───────────────────────────────────────────────────

  private dealOrigin(): { x: number; y: number } {
    const a = stage()?.anchors?.dealer;
    if (a && a.visible) return { x: a.x, y: a.y };
    return { x: window.innerWidth / 2, y: this.topLimit };
  }

  /**
   * Measured on a cadence, never per frame. The frame loop writes transforms
   * only; a layout read in the same loop would undo the point of it.
   */
  private remeasure(): void {
    const cs = getComputedStyle(document.documentElement);
    const px = (name: string): number => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : 0;
    };
    const vh = window.innerHeight;
    this.topLimit = px('--safe-t') + 124;
    this.boardHalf = (this.board.el.offsetHeight || 76) / 2;

    // The pot readout owns the band just below the board; never sit on it.
    const pot = document.querySelector<HTMLElement>('.pot');
    const potTop = pot ? pot.getBoundingClientRect().top : 0;
    this.bottomLimit = potTop > 40 ? potTop - 8 : vh * 0.52;

    // The hand sits just above the action bar, and never under the home bar.
    //
    // The action bar changes height as it swaps between its idle, pre-action
    // and live-turn layouts, so its top edge is not a stable rail. Tracking
    // the *smallest* gap it has ever asked for parks the hand as low as the
    // tallest state allows and then leaves it there — a hand that hopped 12 px
    // every time it became your turn would be the most distracting object on
    // the screen. The floor is reset whenever the viewport itself changes.
    if (vh !== this.lastVh) {
      this.lastVh = vh;
      this.gapFloor = Number.POSITIVE_INFINITY;
    }
    const zone = document.querySelector<HTMLElement>('.hero-zone');
    const zoneTop = zone ? zone.getBoundingClientRect().top : 0;
    const raw = zoneTop > 120 ? vh - zoneTop + 6 : px('--safe-b') + 152;
    this.gapFloor = Math.min(this.gapFloor, raw);
    this.heroGap = clamp(this.gapFloor, px('--safe-b') + 118, vh * 0.42);

    this.remount();
  }

  /**
   * The table screen owns a stacking order; live inside it when it exists so
   * its sheets, menus and modals still come out on top of the cards. That
   * screen is torn down and rebuilt on every route change, so this is checked
   * rather than assumed.
   */
  remount(): void {
    if (this.dead) return;
    const screen = document.querySelector<HTMLElement>('.table-screen');
    const want = screen ?? document.getElementById('ui-root') ?? document.body;
    if (this.host === want && this.el.isConnected) return;
    this.host = want;
    want.appendChild(this.el);
  }

  private tick(dtMs: number): void {
    this.measureAcc += dtMs;
    if (this.measureAcc > MEASURE_MS) {
      this.measureAcc = 0;
      this.remeasure();
    }

    const a = stage()?.anchors;
    const w = window.innerWidth;
    let cx = w / 2;
    let cy = window.innerHeight * 0.38;
    if (a?.board) {
      let sum = 0;
      let n = 0;
      for (const b of a.board) {
        if (!b.visible) continue;
        sum += b.x;
        n++;
      }
      if (n > 0) cx = sum / n;
      const mid = a.board[2];
      if (mid && mid.visible) cy = mid.y;
    }
    const lo = this.topLimit + this.boardHalf;
    const hi = this.bottomLimit - this.boardHalf;
    this.board.place(
      clamp(cx, w * 0.42, w * 0.58),
      hi > lo ? clamp(cy, lo, hi) : (lo + hi) / 2,
    );
    this.hero.place(this.heroGap);
  }

  // ── bus ─────────────────────────────────────────────────────────

  private cancelPending(): void {
    for (const off of this.pending) off();
    this.pending.length = 0;
    this.pendingKey = '';
  }

  private bindBus(): void {
    this.offs.push(
      bus.on('hand:start', () => {
        this.cancelPending();
        this.heroCards = [];
        this.board.clear();
        this.hero.clear();
      }),

      bus.on('hand:deal-board', ({ cards, street, boardIndex }) => {
        // A bomb pot's second board is a felt-level object; the readable row
        // always shows the first, which is the one every hand has.
        if (boardIndex > 0) return;
        this.cancelPending();
        this.board.reveal(cards, street);
      }),

      bus.on('hand:deal-hole', ({ seat, cards }) => {
        if (seat !== this.heroSeat) return;
        this.cancelPending();
        this.heroCards = this.heroCards.concat(cards).slice(0, MAX_HOLE);
        this.hero.show(this.heroCards, true);
      }),

      bus.on('table:state', ({ state, you }) => {
        if (you >= 0 && you !== this.heroSeat) this.setHeroSeat(you);
        this.syncFromState(state);
      }),

      bus.on('hand:muck', ({ seat }) => {
        if (seat !== this.heroSeat) return;
        this.cancelPending();
        this.heroCards = [];
        this.hero.muck();
      }),

      bus.on('hand:showdown', ({ results }) => this.onShowdown(results)),

      bus.on('nav:route', ({ route }) => this.setVisible(route === 'table')),
    );
  }

  /**
   * The snapshot is authoritative but silent. Anything it adds that a deal
   * event has not already animated is filled in after a short grace period,
   * so whichever of the two arrives first, the player still sees an entrance.
   */
  private syncFromState(state: TableState): void {
    const board = (state.board ?? []).slice(0, SLOTS);
    const seat = state.seats?.[this.heroSeat];
    const live = !!seat && seat.status !== 'folded' && seat.status !== 'empty';
    const hole = live ? (seat.holeCards ?? []).slice(0, MAX_HOLE) : [];

    const boardBehind = board.length !== this.board.count;
    const heroBehind =
      hole.length !== this.heroCards.length || hole.some((c, i) => c !== this.heroCards[i]);
    if (!boardBehind && !heroBehind) {
      this.pendingKey = '';
      return;
    }

    // A server-driven table publishes `table:state` far more often than every
    // 150 ms. Re-arming the timer on each identical snapshot would push the
    // fill permanently into the future and the cards would simply never
    // arrive, so an unchanged target leaves the timer that is already running
    // exactly where it is.
    const key = `${board.join(',')}|${hole.join(',')}`;
    if (key === this.pendingKey) return;
    this.cancelPending();
    this.pendingKey = key;
    this.pending.push(
      delay(DEAL_GRACE_MS, () => {
        this.pendingKey = '';
        if (board.length !== this.board.count) this.board.sync(board);
        const stale =
          hole.length !== this.heroCards.length || hole.some((c, i) => c !== this.heroCards[i]);
        if (!stale) return;
        if (hole.length === 0) {
          this.heroCards = [];
          this.hero.muck();
          return;
        }
        const fresh = this.hero.count === 0;
        this.heroCards = hole;
        this.hero.show(hole, fresh);
      }),
    );
  }

  private onShowdown(results: readonly ShowdownResult[]): void {
    let winner: ShowdownResult | null = null;
    for (const r of results) if (r.won > 0 && (!winner || r.won > winner.won)) winner = r;
    const best = winner?.rank?.best;
    if (!best || best.length === 0) return;
    this.board.highlight(best);
    const mine = results.find((r) => r.seat === this.heroSeat);
    this.hero.highlight(mine?.rank?.best ?? best);
  }

  // ── public API ──────────────────────────────────────────────────

  setHeroSeat(seat: number): void {
    if (seat === this.heroSeat) return;
    this.heroSeat = seat;
    this.heroCards = [];
    this.hero.clear();
  }

  showBoard(cards: readonly CardId[]): void {
    this.cancelPending();
    this.board.sync(cards);
  }

  showHole(seat: number, cards: readonly CardId[]): void {
    // Only the hero's hand is drawn here; every other seat's cards are felt
    // objects on the 3D stage, because nobody ever has to read them.
    if (seat !== this.heroSeat) return;
    this.cancelPending();
    this.heroCards = cards.slice(0, MAX_HOLE);
    this.hero.show(this.heroCards, false);
  }

  clear(): void {
    this.cancelPending();
    this.heroCards = [];
    this.board.clear();
    this.hero.clear();
  }

  setVisible(on: boolean): void {
    this.el.classList.toggle('is-off', !on);
    if (on) {
      this.startFrame();
      this.remount();
      return;
    }
    this.clear();
    this.endFrame();
  }

  dispose(): void {
    this.dead = true;
    this.cancelPending();
    this.endFrame();
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.board.dispose();
    this.hero.dispose();
    this.el.remove();
  }
}

let singleton: Layer | null = null;

/**
 * Builds — or simply re-homes — the readable card layer.
 *
 * Idempotent by design: the table screen can own this call without ever having
 * to check whether something else already made it, and calling it again after
 * a route change re-parents the same layer instead of building a second one.
 */
export function mountCardLayer(): CardLayer {
  if (!singleton) {
    singleton = new Layer();
    // QA harness hook, the same shape `render/renderer.ts` publishes its own
    // handle with. Merge, never overwrite: the renderer and the shell both
    // live on this object and boot order between the three is not fixed.
    const w = window as unknown as Record<string, Record<string, unknown>>;
    w.__royale = Object.assign(w.__royale ?? {}, { cards: singleton });
  }
  singleton.setVisible(true);
  return singleton;
}

/** The live layer, or null if it has never been mounted. */
export function cardLayer(): CardLayer | null {
  return singleton && singleton.active ? singleton : null;
}

export function disposeCardLayer(): void {
  singleton?.dispose();
  singleton = null;
}

/** Puts exactly these community cards on the felt, mounting the layer if needed. */
export function showBoard(cards: readonly CardId[]): void {
  mountCardLayer().showBoard(cards);
}

/** Puts exactly these hole cards in a seat's hand, mounting the layer if needed. */
export function showHole(seat: number, cards: readonly CardId[]): void {
  mountCardLayer().showHole(seat, cards);
}

/** Strips every readable card off the felt. */
export function clear(): void {
  singleton?.clear();
}
