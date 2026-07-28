/**
 * Dealing choreography — the app's core tactile loop.
 *
 * This module owns nothing physical; it owns TIMING. It wires the card pool,
 * the chip system, the seat medallions and the particle systems to the
 * engine's bus events and performs the hand the way a live dealer would:
 *
 *   deal      two passes round the table, one card at a time, ~70 ms apart,
 *             each card arcing off the chute with a spin about its long axis
 *             and landing with a bounce and a settle
 *   peel      the hero's cards rise and fan toward the camera; dragging on
 *             them squeezes the pair — real rotation following the finger,
 *             with the card physically bending under the pressure
 *   flop      burn to the muck, then three cards snap face-up in sequence,
 *             each rotating on its long axis with a small overshoot
 *   turn/river a single card, slower, landing with a bloom pulse
 *   muck      folded cards skate face-down to the pile and fade
 *   showdown  winners' cards arc up with a gold rim
 *
 * Every animation is interruptible: a new instruction for a card cancels the
 * one in flight and resolves its promise, so a fast-forwarding player never
 * strands an object mid-air. All scheduling runs off the render clock through
 * the local `Sched`, never `setTimeout`, so it pauses when the tab does.
 *
 * ── Who may see a card ─────────────────────────────────────────────────────
 * Exactly one field decides it: `SeatState.revealed`. Not the presence of hole
 * cards in an event, not the `faceUp` flag on `hand:deal-hole`, not whether a
 * seat happens to be in the hand. The drivers hand this module every card at
 * the table because the showdown has to be able to turn them over; none of it
 * is visible until the flag says the local client may see it, and the flag is
 * revoked on every `hand:start` and on every muck. The hero's own hand is the
 * one exception, and it is the local client's hand by definition.
 *
 * `render/cards.ts` enforces the same rule a level down: an unrevealed card
 * binds its BACK print to both sides of the slab, so a mistake here is a card
 * that fails to appear, never a card that leaks.
 */
import * as THREE from 'three';
import { bus } from '../core/bus.ts';
import type { CardId, Rarity, SeatState, ShowdownResult, TableState } from '../core/types.ts';

import {
  createCardPool,
  feltQuat,
  uprightQuat,
  Ease,
  Dur,
  CARD_DIMS,
  type CardHandle,
  type CardPool,
} from './cards.ts';
import { createChipSystem, type ChipStackHandle, type ChipSystem } from './chips.ts';
import { createAvatars, rarityForFrame, type AvatarSystem } from './avatars3d.ts';
import { createParticles, type ParticleSystem } from './particles.ts';
import { cardFaces, initCardFaces, type CardBackId } from './cardFaces.ts';

// ═══════════════════════════════════════════════════════════════════
// ADAPTER — the only coupling to sibling render modules.
// ═══════════════════════════════════════════════════════════════════
import { layout } from './table.ts';
import { getStageHandle, type PerfTier, type RendererHandle } from './renderer.ts';

const BOARD_SLOT = (i: number): THREE.Vector3 => layout.boardSlot(i);
const POT_CENTER = layout.POT_CENTER;
const DEALER_POS = layout.DEALER_POS;
const MUCK_POS = layout.MUCK_POS;
const FELT_Y = layout.FELT_Y ?? 0;
const CARD_LIFT = CARD_DIMS.t * 0.5 + 0.0006;
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────── timing ───────────────────────────

/** Seconds. Tuned against the engine's BEAT table so visuals lead audio. */
const T = {
  dealFlight: 0.3,
  dealStagger: 0.07,
  dealArc: 0.1,
  heroPeel: 0.42,
  heroPeelDelay: 0.34,
  burnFlight: 0.26,
  boardFlight: 0.32,
  boardStagger: 0.115,
  boardFlip: 0.3,
  riverFlight: 0.44,
  riverFlip: 0.4,
  muckFlight: 0.34,
  muckFade: 0.26,
  showdownFlip: 0.34,
  betSlide: 0.34,
  collect: 0.46,
  award: 0.66,
} as const;

// ─────────────────────────── scheduler ───────────────────────────

interface Task {
  t: number;
  fn: () => void;
  tag: number;
}

/**
 * Render-clock scheduler. Everything staged here pauses with the tab, scales
 * with the animation budget and can be cancelled per-tag when a hand is torn
 * down mid-flight — three things `setTimeout` cannot do.
 */
class Sched {
  private tasks: Task[] = [];
  private pool: Task[] = [];

  after(t: number, fn: () => void, tag = 0): void {
    const task = this.pool.pop();
    if (task) {
      task.t = t;
      task.fn = fn;
      task.tag = tag;
      this.tasks.push(task);
    } else {
      this.tasks.push({ t, fn, tag });
    }
  }

  clear(tag?: number): void {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      if (tag === undefined || this.tasks[i].tag === tag) {
        const [t] = this.tasks.splice(i, 1);
        t.fn = noop;
        this.pool.push(t);
      }
    }
  }

  step(dt: number): void {
    if (this.tasks.length === 0) return;
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const task = this.tasks[i];
      task.t -= dt;
      if (task.t <= 0) {
        this.tasks.splice(i, 1);
        const fn = task.fn;
        task.fn = noop;
        this.pool.push(task);
        try {
          fn();
        } catch (err) {
          console.error('[dealing] scheduled step failed', err);
        }
      }
    }
  }

  get busy(): boolean {
    return this.tasks.length > 0;
  }
}

function noop(): void {
  /* intentionally empty — a recycled task must not fire twice */
}

/** Critically-tunable spring. Used for the squeeze, which must feel physical. */
class Spring {
  value: number;
  target: number;
  private v = 0;
  private stiffness: number;
  private damping: number;
  constructor(value: number, stiffness = 170, damping = 22) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }
  step(dt: number): number {
    // sub-step so a 30 Hz frame cannot make a stiff spring explode
    const steps = dt > 1 / 45 ? 2 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (this.target - this.value) * this.stiffness - this.v * this.damping;
      this.v += a * h;
      this.value += this.v * h;
    }
    return this.value;
  }
  set(v: number): void {
    this.value = v;
    this.target = v;
    this.v = 0;
  }
  get settled(): boolean {
    return Math.abs(this.v) < 0.001 && Math.abs(this.target - this.value) < 0.001;
  }
}

// ─────────────────────────── fades ───────────────────────────

interface Fade {
  card: CardHandle;
  t: number;
  dur: number;
  from: number;
  to: number;
  release: boolean;
}

interface Glow {
  card: CardHandle;
  t: number;
  dur: number;
  peak: number;
  hold: number;
}

// ─────────────────────────── system ───────────────────────────

export interface DealingSystem {
  readonly group: THREE.Group;
  readonly cards: CardPool;
  readonly chips: ChipSystem;
  readonly avatars: AvatarSystem;
  readonly particles: ParticleSystem;

  attach(parent: THREE.Object3D): void;
  setTableSize(size: number): void;
  setHeroSeat(seat: number): void;
  setQuality(tier: PerfTier): void;
  setCardBack(id: CardBackId): void;
  /** enables the drag-to-squeeze gesture on the hero's hole cards */
  bindInput(canvas: HTMLElement, camera: THREE.Camera): () => void;
  /** clears the felt: every card, chip and animation */
  reset(): void;
  update(dt: number, elapsed: number, camera?: THREE.Camera | null): void;
  dispose(): void;
}

const TAG_HAND = 1;
const TAG_BOARD = 2;
const TAG_HERO = 3;

// ─────────────────── the readable card layer ───────────────────

/**
 * The two card groups a player has to *read* — their own hand and the
 * community board — are drawn by `src/ui/table/board.ts` as DOM, because at
 * this camera a felt card projects to about 38 CSS px wide and its rank glyph
 * to four. That module owns their whole presentation: the deal flight, the
 * turn, the squeeze, the showdown rim.
 *
 * Everything the player never reads stays here, on the felt, where a real
 * bevelled slab with a contact shadow is worth what it costs: the opponents'
 * face-down hands, the burn, the muck, and every chip on the table.
 *
 * The handshake is a capability check, not a hard dependency. If the layer
 * has not been mounted — an older host screen, a failed chunk — this module
 * falls back to dealing all of it in 3D, which is small but never absent.
 */
interface ReadableCards {
  readonly active: boolean;
  setHeroSeat(seat: number): void;
  showBoard(cards: readonly CardId[]): void;
  showHole(seat: number, cards: readonly CardId[]): void;
}

let readable: ReadableCards | null = null;
/**
 * `pending` covers the window between asking for the layer's chunk and getting
 * it. It counts as present: the first hand of a quick-seated table can start
 * inside that window, and dealing those two cards on the felt only to have the
 * readable layer draw them again a frame later is the one outcome worse than
 * either on its own.
 */
let readableState: 'off' | 'pending' | 'on' = 'off';

function readableCards(): boolean {
  if (readableState === 'pending') return true;
  return readableState === 'on' && !!readable && readable.active;
}

class Dealing implements DealingSystem {
  readonly group = new THREE.Group();
  readonly cards: CardPool;
  readonly chips: ChipSystem;
  readonly avatars: AvatarSystem;
  readonly particles: ParticleSystem;

  private sched = new Sched();
  private size = 9;
  private hero = 0;
  private tier: PerfTier;
  private perHand = 2;

  private hole: CardHandle[][] = Array.from({ length: 9 }, () => []);
  /**
   * The visibility ledger, and the only thing on the felt allowed to turn a
   * hand over.
   *
   *   `mayShow[seat]`  what SeatState.revealed last said about this seat. It
   *                    is cleared on every `hand:start`, so a reveal can never
   *                    survive into the hand after it.
   *   `showing[seat]`  what the felt is actually doing, so a snapshot that
   *                    repeats forty times a second does not re-flip a hand
   *                    forty times.
   *
   * Card DATA arriving for a seat says nothing about either — the drivers hand
   * this module every hole card at the table so the showdown has something to
   * turn over, and none of it is visible until the flag says so.
   */
  private mayShow: boolean[] = new Array(9).fill(false);
  private showing: boolean[] = new Array(9).fill(false);
  /** parallel arrays: the card, which board it belongs to, and its slot 0-4 */
  private board: CardHandle[] = [];
  private boardOwner: number[] = [];
  private boardSlotIdx: number[] = [];
  private pile: CardHandle[] = [];
  private fades: Fade[] = [];
  private glows: Glow[] = [];

  private betStacks: Array<ChipStackHandle | null> = new Array(9).fill(null);
  private seatStacks: Array<ChipStackHandle | null> = new Array(9).fill(null);
  private potStack: ChipStackHandle | null = null;
  private potAmount = 0;
  private boardCounts = [0, 0];
  private boards = 1;
  private buttonSeat = -1;
  /** last snapshot seen, so a late-arriving card layer can be caught up */
  private lastState: TableState | null = null;

  // hero peek
  private heroSettled = false;
  private squeeze = new Spring(0, 150, 21);
  private lateral = new Spring(0, 120, 20);
  private peeked = false;
  private dragging = false;
  private dragStart = new THREE.Vector2();
  private pointerId = -1;

  // scratch
  private _q = new THREE.Quaternion();
  private _q2 = new THREE.Quaternion();
  private _p = new THREE.Vector3();
  private _p2 = new THREE.Vector3();
  private _tan = new THREE.Vector3();
  private _ray = new THREE.Raycaster();
  private _ndc = new THREE.Vector2();
  private offs: Array<() => void> = [];
  private inputOff: (() => void) | null = null;

  constructor(tier: PerfTier) {
    this.group.name = 'play-objects';
    this.tier = tier;
    this.cards = createCardPool({ size: 30 });
    this.chips = createChipSystem({ tier });
    this.avatars = createAvatars({ tier });
    this.particles = createParticles({ tier });
    this.group.add(this.cards.group, this.chips.group, this.avatars.group, this.particles.group);

    this.particles.setSeatResolver((seat) => this.seatFxPoint(seat));
    this.bindBus();
  }

  // ─────────────────── geometry helpers ───────────────────

  private slotOf(seat: number): number {
    return layout.slotFor(seat, this.hero, this.size);
  }

  private anchors(seat: number) {
    return layout.seat(this.size, this.slotOf(seat));
  }

  /**
   * Every card reads upright. A table where opponents' cards are rotated to
   * their own seat is technically correct and practically unreadable on a
   * 390pt screen, so cards get only a whisper of per-seat rotation — enough
   * to look hand-dealt, never enough to make a rank ambiguous.
   */
  private heading(seat: number, index: number): number {
    const h = Math.sin(seat * 12.9898 + index * 78.233) * 43758.5453;
    return (h - Math.floor(h) - 0.5) * 0.16;
  }

  private tangentOf(seat: number): THREE.Vector3 {
    const a = this.anchors(seat);
    return this._tan.set(-a.inward.z, 0, a.inward.x);
  }

  private seatFxPoint(seat: number): THREE.Vector3 | null {
    if (seat < 0 || seat >= this.size) return null;
    const a = this.anchors(seat);
    return this._p2.set(a.bet.x, FELT_Y + 0.03, a.bet.z);
  }

  private boardZ(boardIndex: number): number {
    if (this.boards < 2) return 0;
    return boardIndex === 0 ? -0.105 : 0.105;
  }

  private boardSlotPos(out: THREE.Vector3, index: number, boardIndex: number): THREE.Vector3 {
    const base = BOARD_SLOT(index);
    return out.set(base.x, base.y + CARD_LIFT, base.z + this.boardZ(boardIndex));
  }

  // ─────────────────── bus ───────────────────

  private bindBus(): void {
    this.offs.push(
      bus.on('table:state', ({ state, you }) => this.syncState(state, you)),
      bus.on('hand:start', ({ buttonSeat }) => this.onHandStart(buttonSeat)),
      bus.on('hand:deal-hole', ({ seat, cards, faceUp, order }) =>
        this.dealHole(seat, cards, faceUp, order),
      ),
      bus.on('hand:deal-board', ({ street, cards, boardIndex }) =>
        this.dealBoard(street, cards, boardIndex),
      ),
      bus.on('hand:action', ({ action, state }) => this.onAction(action.kind, action.seat, state)),
      bus.on('hand:collect', ({ seats }) => this.collect(seats)),
      bus.on('hand:pot-update', ({ total }) => this.onPot(total)),
      bus.on('hand:showdown', ({ results }) => this.onShowdown(results)),
      bus.on('hand:award', ({ seat, amount }) => this.onAward(seat, amount)),
      bus.on('hand:muck', ({ seat }) => this.muckSeat(seat)),
      bus.on('hand:end', () => this.onHandEnd()),
      bus.on('hand:turn', ({ seat }) => this.avatars.bump(seat, 0.5)),
      bus.on('perf:tier', ({ tier }) => this.setQuality(tier)),
      bus.on('econ:equip', ({ item }) => {
        if (item.kind === 'card-back') this.setCardBack(String(item.params.backId ?? item.id) as CardBackId);
        if (item.kind === 'chip-set') this.chips.setChipSet(item.params.metal ? 'metal' : 'classic');
      }),
    );
  }

  // ─────────────────── state sync ───────────────────

  private syncState(state: TableState, you: number): void {
    this.lastState = state;
    const size = state.seats.length;
    if (size >= 1 && size <= 9 && size !== this.size) {
      this.size = size;
      this.avatars.setTableSize(size);
      this.relayout();
    }
    if (you >= 0 && you !== this.hero) {
      this.hero = you;
      this.avatars.setHeroSeat(you);
      this.relayout();
    }
    this.perHand = state.variant === 'plo4' ? 4 : 2;
    const unit = Math.max(1e-6, state.stake?.sb ?? 1);
    this.chips.setDenomUnit(unit);
    this.boards = state.bombPot?.boards ?? 1;

    for (const s of state.seats) this.syncSeat(s);

    if (state.buttonSeat !== this.buttonSeat) {
      this.buttonSeat = state.buttonSeat;
      this.avatars.setButton(state.buttonSeat, true);
    }
  }

  /**
   * Applies a seat's `revealed` flag to the cards on the felt.
   *
   * This is the whole visibility rule, in one place, driven by one field.
   * A folded, empty or sitting-out seat is never revealed no matter what the
   * flag says — a hand that is out of play has nothing to table.
   */
  private applyReveal(seat: number, may: boolean): void {
    // The hero's own hand is turned over by the peel, which owns its pose and
    // its timing; re-flipping it from a snapshot would fight that animation.
    if (seat === this.hero) return;
    this.mayShow[seat] = may;
    if (this.showing[seat] === may) return;
    const list = this.hole[seat];
    if (list.length === 0) {
      this.showing[seat] = false;
      return;
    }
    this.showing[seat] = may;
    for (const h of list) void h.flip(T.showdownFlip, may);
  }

  private syncSeat(s: SeatState): void {
    const dead = s.status === 'folded' || s.status === 'empty' || s.status === 'sitting-out';
    this.applyReveal(s.index, s.revealed && !dead);

    const p = s.player;
    if (!p || s.status === 'empty') {
      this.avatars.setSeat(s.index, { occupied: false });
      this.dropStack(this.seatStacks, s.index);
      return;
    }
    const rarity: Rarity = rarityForFrame(p.frameId);
    this.avatars.setSeat(s.index, {
      occupied: true,
      name: p.name,
      avatarId: p.avatarId,
      rarity,
      folded: s.status === 'folded',
      turn: s.isTurn,
      allIn: s.status === 'allin',
      heat: p.heat,
      sittingOut: s.status === 'sitting-out' || s.sitOutNextHand,
      won: s.wonLast,
    });

    // seat rack: a representative stack, not a literal chip count
    const cap = this.tier === 'low' ? 5 : 8;
    if (s.stack > 0) {
      const anchor = this.anchors(s.index).stack;
      const cur = this.seatStacks[s.index];
      if (cur && cur.alive) {
        // table:state lands many times a second; only rebuild when the rack
        // has actually changed, or every chip teleports on every tick
        if (cur.amount !== s.stack) cur.setAmount(s.stack, { columnHeight: 5, maxChips: cap });
      } else {
        this.seatStacks[s.index] = this.chips.makeStack(s.stack, anchor, {
          columnHeight: 5,
          maxChips: cap,
        });
      }
    } else {
      this.dropStack(this.seatStacks, s.index);
    }
  }

  private relayout(): void {
    // seat-relative objects move when the table size or hero seat changes
    for (let seat = 0; seat < 9; seat++) {
      const cards = this.hole[seat];
      if (cards.length === 0) continue;
      const a = this.anchors(seat);
      for (let i = 0; i < cards.length; i++) {
        cards[i].setPose(a.cards[i], feltQuat(this._q, this.heading(seat, i)));
      }
    }
    for (let seat = 0; seat < 9; seat++) {
      const st = this.seatStacks[seat];
      if (st && st.alive) st.moveTo(this.anchors(seat).stack, { duration: 0.2, arc: 0 });
      const bt = this.betStacks[seat];
      if (bt && bt.alive) bt.moveTo(this.anchors(seat).bet, { duration: 0.2, arc: 0 });
    }
    this.heroSettled = false;
  }

  private dropStack(list: Array<ChipStackHandle | null>, seat: number): void {
    const s = list[seat];
    if (s) {
      s.release();
      list[seat] = null;
    }
  }

  // ─────────────────── hand lifecycle ───────────────────

  private onHandStart(buttonSeat: number): void {
    this.sched.clear();
    // Before anything else: revoke every reveal from the hand that just ended.
    // The drivers deal before they publish the first snapshot of the new hand,
    // so the newest `revealed` this module has seen is still last showdown's.
    this.mayShow.fill(false);
    this.showing.fill(false);
    this.clearCards();
    this.fades.length = 0;
    this.glows.length = 0;
    this.boardCounts[0] = 0;
    this.boardCounts[1] = 0;
    this.boardOwner.length = 0;
    this.boardSlotIdx.length = 0;
    this.potAmount = 0;
    this.peeked = false;
    this.heroSettled = false;
    this.squeeze.set(0);
    this.lateral.set(0);
    for (let i = 0; i < 9; i++) this.dropStack(this.betStacks, i);
    if (this.potStack) {
      this.potStack.release();
      this.potStack = null;
    }
    this.buttonSeat = buttonSeat;
    this.avatars.setButton(buttonSeat, true);
  }

  private onHandEnd(): void {
    this.sched.after(
      0.5,
      () => {
        this.clearCards();
        for (let i = 0; i < 9; i++) this.dropStack(this.betStacks, i);
        if (this.potStack) {
          this.potStack.release();
          this.potStack = null;
        }
      },
      TAG_HAND,
    );
  }

  private clearCards(): void {
    for (let seat = 0; seat < 9; seat++) {
      for (const c of this.hole[seat]) c.release();
      this.hole[seat].length = 0;
      this.showing[seat] = false;
    }
    for (const c of this.board) c.release();
    this.board.length = 0;
    for (const c of this.pile) c.release();
    this.pile.length = 0;
  }

  /**
   * Hands the hero's cards and the community row over to the readable layer
   * mid-hand. Only ever called once, when that layer arrives after the deal
   * has already begun — the felt gives its copies straight back to the pool.
   */
  dropReadableCards(): void {
    this.sched.clear(TAG_HERO);
    for (const c of this.hole[this.hero]) c.release();
    this.hole[this.hero].length = 0;
    this.showing[this.hero] = false;
    for (const c of this.board) c.release();
    this.board.length = 0;
    this.boardOwner.length = 0;
    this.boardSlotIdx.length = 0;
    // a glow still pointing at a card we just recycled would light up whatever
    // the pool hands out next
    this.glows.length = 0;
    this.peeked = false;
    this.heroSettled = false;
    this.squeeze.set(0);
    this.lateral.set(0);
  }

  /**
   * Catches a freshly-mounted card layer up to the hand already in progress.
   *
   * Deal events are one-shot: a layer that arrives after the flop has been
   * dealt would otherwise sit empty until the next `table:state`, and between
   * a player's own turn arriving and their acting on it there is no next
   * `table:state` — the hand simply waits for them, with their cards nowhere.
   * Replaying the last snapshot through the imperative API costs nothing and
   * removes that hole entirely.
   */
  pushReadable(layer: ReadableCards): void {
    const state = this.lastState;
    if (!state) return;
    layer.setHeroSeat(this.hero);
    if (state.board && state.board.length > 0) layer.showBoard(state.board);
    const seat = state.seats?.[this.hero];
    if (seat && seat.status !== 'folded' && seat.holeCards?.length) {
      layer.showHole(this.hero, seat.holeCards);
    }
  }

  // ─────────────────── the deal ───────────────────

  private dealerQuat(out: THREE.Quaternion): THREE.Quaternion {
    return feltQuat(out, 0.22, -0.18);
  }

  private dealHole(seat: number, cards: CardId[], faceUp: boolean, order: number): void {
    // The hero's hand belongs to the readable layer, which runs its own deal
    // flight from the same event — putting a second, smaller copy of it on the
    // felt would just be two hands where the player has one.
    if (seat === this.hero && readableCards()) return;
    const list = this.hole[seat];
    for (const card of cards) {
      const index = list.length;
      if (index >= 4) break;
      const h = this.cards.acquire();
      // Data first, and the card stays hidden through it: `setFace()` loads
      // the rank, `setFaceUp(false)` is the explicit instruction not to show
      // it. Nothing here reveals, so nothing here can leak.
      h.setFace(card);
      h.setFaceUp(false);
      h.setRenderOrder(4 + index);
      this.dealerQuat(this._q);
      this._p.copy(DEALER_POS);
      // fan the chute so successive cards do not launch from one pixel
      this._p.x += ((order % 3) - 1) * 0.018;
      h.setPose(this._p, this._q);
      list.push(h);

      const a = this.anchors(seat);
      const dest = a.cards[Math.min(index, a.cards.length - 1)];
      this._p2.set(dest.x, dest.y + CARD_LIFT, dest.z);
      feltQuat(this._q2, this.heading(seat, index));
      const dist = this._p2.distanceTo(DEALER_POS);

      h.moveTo(this._p2, this._q2, {
        duration: T.dealFlight + dist * 0.055,
        ease: Ease.out,
        // A pitched card spins in its own plane — the dealer's flick. It used
        // to turn over about its long axis instead, which pointed the print at
        // the camera for most of the flight and, because `Ease.out` puts the
        // card at the seat by the time the spin peaks, showed every opponent's
        // hand face-up at their seat on the way in.
        arc: T.dealArc + dist * 0.02,
        spin: 0.62,
        spinAxis: 'plane',
        bounce: 0.0055,
      });

      if (seat === this.hero) {
        // hero cards reveal as a group once the pass is done
        this.sched.clear(TAG_HERO);
        this.sched.after(T.heroPeelDelay, () => this.peelHero(), TAG_HERO);
      } else if (faceUp && this.mayShow[seat]) {
        // A driver asking for a face-up deal is a REQUEST, never an authority:
        // it is honoured only for a seat whose `revealed` flag already says
        // this client is allowed to see the hand. Everything else turns over
        // when — and only when — a snapshot or the showdown says so.
        this.sched.after(T.dealFlight + 0.1, () => void h.flip(T.showdownFlip, true), TAG_HAND);
      }
    }
  }

  /** Hero's cards rise, fan and turn over toward the camera. */
  private peelHero(): void {
    const list = this.hole[this.hero];
    if (list.length === 0) return;
    this.peeked = true;
    this.heroSettled = false;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const h = list[i];
      this.heroPose(i, n, 0, this._p, this._q);
      h.setRenderOrder(10 + i);
      h.moveTo(this._p, this._q, {
        duration: T.heroPeel,
        delay: i * 0.055,
        ease: Ease.spring,
        arc: 0.02,
        onDone: i === n - 1 ? () => (this.heroSettled = true) : undefined,
      });
      void h.flip(T.heroPeel * 0.82, true);
    }
    bus.emit('fx:burst', {
      kind: 'card-flip',
      at: [list[0].position.x, list[0].position.y + 0.04, list[0].position.z],
    });
  }

  /**
   * Where a hero card sits for a given squeeze amount.
   * lean 1.57 = flat on the felt, 0.96 = square to the camera. The squeeze
   * pushes past square so the pair tips toward your face, which is exactly
   * what the gesture does at a real table.
   */
  private heroPose(
    i: number,
    n: number,
    squeeze: number,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): void {
    const a = this.anchors(this.hero);
    const tan = this.tangentOf(this.hero);
    const mid = (n - 1) / 2;
    const t = i - mid;
    const spread = (0.052 + squeeze * 0.016) * (n > 2 ? 0.82 : 1);
    const lift = 0.052 + squeeze * 0.055;
    const lean = 1.3 - 0.3 * (1 - squeeze) - 0.42 * squeeze;
    const roll = -t * (0.15 + squeeze * 0.075) + this.lateral.value * 0.1;
    const base = a.cards[0];
    const cx = base.x - tan.x * mid * 0.062;
    const cz = base.z - tan.z * mid * 0.062;
    outPos.set(
      cx + tan.x * t * spread + a.inward.x * (0.012 + squeeze * 0.018),
      FELT_Y + lift + i * 0.0016,
      cz + tan.z * t * spread + a.inward.z * (0.012 + squeeze * 0.018),
    );
    uprightQuat(outQuat, this.lateral.value * 0.12, lean, roll);
  }

  // ─────────────────── board ───────────────────

  private burnCard(delay: number): void {
    this.sched.after(
      delay,
      () => {
        const h = this.cards.acquire();
        h.setFace(null);
        h.setFaceUp(false);
        h.setRenderOrder(3);
        this.dealerQuat(this._q);
        h.setPose(DEALER_POS, this._q);
        this.pile.push(h);
        const n = this.pile.length;
        this._p.set(
          MUCK_POS.x + Math.sin(n * 2.3) * 0.014,
          FELT_Y + CARD_LIFT + n * 0.0016,
          MUCK_POS.z + Math.cos(n * 1.7) * 0.014,
        );
        feltQuat(this._q2, 0.5 + Math.sin(n * 3.1) * 0.3);
        h.moveTo(this._p, this._q2, {
          duration: T.burnFlight,
          ease: Ease.snap,
          arc: 0.05,
          spin: 0.35,
          spinAxis: 'plane',
          bounce: 0.004,
        });
      },
      TAG_BOARD,
    );
  }

  private dealBoard(street: string, cards: CardId[], boardIndex: number): void {
    if (boardIndex > 0 && this.boards < 2) {
      this.boards = 2;
      this.restackBoards();
    }
    // a live dealer burns before every community street
    this.burnCard(0);

    // The community row is drawn by the readable layer; the burn above is the
    // part of this street nobody has to read, so it stays a felt object.
    if (readableCards()) {
      const b = Math.min(1, Math.max(0, boardIndex));
      this.boardCounts[b] = Math.min(5, this.boardCounts[b] + cards.length);
      return;
    }

    const dramatic = street === 'turn' || street === 'river';
    const flight = dramatic ? T.riverFlight : T.boardFlight;
    const flipDur = dramatic ? T.riverFlip : T.boardFlip;
    const stagger = dramatic ? 0 : T.boardStagger;

    const bi = Math.min(1, Math.max(0, boardIndex));
    const start = this.boardCounts[bi];
    cards.forEach((card, k) => {
      const slot = Math.min(4, start + k);
      const at = 0.16 + k * stagger;
      this.sched.after(
        at,
        () => {
          const h = this.cards.acquire();
          h.setFace(card);
          h.setFaceUp(false);
          h.setRenderOrder(4);
          this.dealerQuat(this._q);
          h.setPose(DEALER_POS, this._q);
          this.board.push(h);
          this.boardOwner.push(bi);
          this.boardSlotIdx.push(slot);

          this.boardSlotPos(this._p, slot, bi);
          feltQuat(this._q2, this.heading(90 + slot, bi));
          h.moveTo(this._p, this._q2, {
            duration: flight,
            ease: dramatic ? Ease.drop : Ease.out,
            arc: dramatic ? 0.16 : 0.1,
            // in-plane too: a community card that flashed its rank in flight
            // would spend the landing flip revealing something already seen
            spin: dramatic ? 0.85 : 0.55,
            spinAxis: 'plane',
            bounce: 0.005,
            onDone: () => {
              void h.flip(flipDur, true);
              // the reveal beat: a rim bloom on the card plus a shimmer
              this.glows.push({ card: h, t: 0, dur: dramatic ? 0.95 : 0.6, peak: dramatic ? 0.95 : 0.55, hold: 0.12 });
              this.particles.emit('shimmer', h.position, { scale: dramatic ? 1.5 : 0.9 });
            },
          });
        },
        TAG_BOARD,
      );
    });
    this.boardCounts[bi] = Math.min(5, start + cards.length);
  }

  /** A second board appeared — slide the first one clear of it. */
  private restackBoards(): void {
    for (let i = 0; i < this.board.length; i++) {
      const owner = this.boardOwner[i] ?? 0;
      const idx = this.boardSlotIdx[i] ?? 0;
      this.boardSlotPos(this._p, idx, owner);
      feltQuat(this._q2, this.heading(90 + idx, owner));
      void this.board[i].moveTo(this._p, this._q2, { duration: Dur.slow, ease: Ease.out });
    }
  }

  // ─────────────────── actions, bets, pot ───────────────────

  private onAction(kind: string, seat: number, state: TableState): void {
    const s = state.seats[seat];
    if (!s) return;

    if (kind === 'fold') {
      this.avatars.setSeat(seat, { folded: true, turn: false });
      this.muckSeat(seat);
      return;
    }

    this.avatars.bump(seat, kind === 'raise' || kind === 'allin' ? 1.4 : 0.7);

    const committed = s.committed;
    if (committed <= 0) return;

    const anchor = this.anchors(seat).bet;
    const cur = this.betStacks[seat];
    const cap = this.tier === 'low' ? 7 : 11;
    if (cur && cur.alive) {
      if (cur.amount !== committed) {
        cur.setAmount(committed, { columnHeight: 6, maxChips: cap, settle: true });
      }
    } else {
      // chips travel from the player's rack to the betting line
      const from = this.anchors(seat).stack;
      const st = this.chips.makeStack(committed, from, { columnHeight: 6, maxChips: cap });
      this.betStacks[seat] = st;
      void st.moveTo(anchor, {
        duration: T.betSlide,
        stagger: 0.014,
        arc: 0.055,
        spin: 0.9,
        ease: Ease.out,
      });
    }

    if (kind === 'allin') {
      this.sched.after(
        0.16,
        () => {
          const st = this.betStacks[seat];
          if (st && st.alive) st.splash(0.55);
        },
        TAG_HAND,
      );
    }
  }

  private collect(seats: number[]): void {
    for (const seat of seats) {
      const st = this.betStacks[seat];
      if (!st || !st.alive) continue;
      this.betStacks[seat] = null;
      void st.moveTo(POT_CENTER, {
        duration: T.collect,
        stagger: 0.016,
        arc: 0.075,
        spin: 1.1,
        ease: Ease.drop,
        restack: true,
      });
      this.sched.after(T.collect + 0.32, () => void st.fadeOut(0.16), TAG_HAND);
    }
    this.sched.after(T.collect + 0.34, () => this.refreshPot(), TAG_HAND);
    this.particles.emit('spark', POT_CENTER, { scale: 0.5 });
  }

  private onPot(total: number): void {
    this.potAmount = total;
    this.sched.after(0.02, () => this.refreshPot(), TAG_HAND);
  }

  private refreshPot(): void {
    const cap = this.tier === 'low' ? 12 : 20;
    if (this.potAmount <= 0) {
      if (this.potStack) {
        this.potStack.release();
        this.potStack = null;
      }
      return;
    }
    if (this.potStack && this.potStack.alive) {
      this.potStack.setAmount(this.potAmount, { columnHeight: 7, maxChips: cap, settle: true });
    } else {
      this.potStack = this.chips.makeStack(this.potAmount, POT_CENTER, {
        columnHeight: 7,
        maxChips: cap,
        settle: true,
      });
    }
  }

  private onAward(seat: number, amount: number): void {
    this.avatars.celebrate(seat);
    const target = this.anchors(seat).stack;
    const pot = this.potStack;
    if (pot && pot.alive) {
      this.potStack = null;
      void pot.cascadeTo(target, { duration: T.award, stagger: 0.03, arc: 0.11, spin: 1.5 });
      this.sched.after(T.award + 0.42, () => void pot.fadeOut(0.22), TAG_HAND);
    } else if (amount > 0) {
      const cap = this.tier === 'low' ? 8 : 14;
      const st = this.chips.makeStack(amount, POT_CENTER, { columnHeight: 6, maxChips: cap });
      void st.cascadeTo(target, { duration: T.award, stagger: 0.03, arc: 0.11, spin: 1.5 });
      this.sched.after(T.award + 0.42, () => void st.fadeOut(0.22), TAG_HAND);
    }
    this.potAmount = 0;
  }

  // ─────────────────── muck & showdown ───────────────────

  private muckSeat(seat: number): void {
    // A mucked hand is out of the hand: revoke first, so nothing that arrives
    // later — a stale snapshot, a showdown result — can turn it back over.
    this.mayShow[seat] = false;
    this.showing[seat] = false;
    const list = this.hole[seat];
    if (list.length === 0) return;
    this.hole[seat] = [];
    if (seat === this.hero) {
      this.peeked = false;
      this.heroSettled = false;
      this.squeeze.set(0);
      this.sched.clear(TAG_HERO);
    }
    list.forEach((h, i) => {
      const n = this.pile.length + i + 1;
      this._p.set(
        MUCK_POS.x + Math.sin(n * 2.3) * 0.018,
        FELT_Y + CARD_LIFT + n * 0.0016,
        MUCK_POS.z + Math.cos(n * 1.7) * 0.018,
      );
      feltQuat(this._q2, 0.4 + Math.sin(n * 3.1) * 0.42);
      h.setGlow(0);
      h.setRenderOrder(3);
      void h.flip(T.muckFlight * 0.6, false);
      void h.moveTo(this._p, this._q2, {
        duration: T.muckFlight,
        delay: i * 0.045,
        ease: Ease.snap,
        arc: 0.045,
        spin: 0.5,
        spinAxis: 'plane',
      });
      this.fades.push({
        card: h,
        t: -(T.muckFlight + i * 0.045),
        dur: T.muckFade,
        from: 1,
        to: 0,
        release: true,
      });
    });
    this.pile.push(...list);
  }

  private onShowdown(results: readonly ShowdownResult[]): void {
    let delay = 0;
    for (const r of results) {
      // A hand that was mucked is never turned over, and neither is one whose
      // seat has already folded out of the hand — `muckSeat` revoked those.
      if (r.mucked) continue;
      const folded = this.lastState?.seats?.[r.seat]?.status === 'folded';
      if (folded) continue;
      // The hero's showdown is the readable layer's — gold rim included.
      if (r.seat === this.hero && readableCards()) continue;
      const list = this.hole[r.seat];
      if (list.length === 0) continue;
      const seat = r.seat;
      const winner = r.won > 0;
      // Only the five cards that actually make the hand take the gold rim.
      const best = winner && r.rank ? r.rank.best : null;
      this.mayShow[seat] = true;
      this.showing[seat] = true;
      const a = this.anchors(seat);
      const tan = this.tangentOf(seat).clone();
      list.forEach((h, i) => {
        const mid = (list.length - 1) / 2;
        const t = i - mid;
        // captured per card: the scratch vectors are long gone by the time
        // these staggered reveals actually run
        const pos = new THREE.Vector3(
          a.cards[0].x - tan.x * mid * 0.062 + tan.x * t * 0.07 + a.inward.x * 0.035,
          FELT_Y + CARD_LIFT + 0.004 + i * 0.0012,
          a.cards[0].z - tan.z * mid * 0.062 + tan.z * t * 0.07 + a.inward.z * 0.035,
        );
        const quat = feltQuat(new THREE.Quaternion(), this.heading(seat, i) * 0.4);
        this.sched.after(
          delay + i * 0.07,
          () => {
            h.setRenderOrder(8);
            // the one place on the felt that is allowed to show a face, and
            // it says so out loud
            void h.flip(T.showdownFlip, true);
            void h.moveTo(pos, quat, {
              duration: T.showdownFlip + 0.1,
              ease: Ease.spring,
              arc: 0.05,
              bounce: 0.004,
            });
            const plays = !best || (h.cardId !== null && best.includes(h.cardId));
            if (winner && plays) this.glows.push({ card: h, t: 0, dur: 2.4, peak: 1, hold: 1.4 });
          },
          TAG_HAND,
        );
      });
      delay += 0.34;
    }
  }

  // ─────────────────── input: the squeeze ───────────────────

  bindInput(canvas: HTMLElement, camera: THREE.Camera): () => void {
    this.inputOff?.();
    const rectOf = () => canvas.getBoundingClientRect();

    const hitHero = (ev: PointerEvent): boolean => {
      const list = this.hole[this.hero];
      if (list.length === 0 || !this.peeked) return false;
      const r = rectOf();
      this._ndc.set(
        ((ev.clientX - r.left) / r.width) * 2 - 1,
        -((ev.clientY - r.top) / r.height) * 2 + 1,
      );
      this._ray.setFromCamera(this._ndc, camera as THREE.PerspectiveCamera);
      for (const h of list) {
        const hits = this._ray.intersectObject(h.object, true);
        if (hits.length > 0) return true;
      }
      // a generous fallback band: the hero's cards are small, thumbs are not
      const r2 = rectOf();
      const px = (ev.clientX - r2.left) / r2.width;
      const py = (ev.clientY - r2.top) / r2.height;
      return px > 0.24 && px < 0.76 && py > 0.6 && py < 0.94;
    };

    const onDown = (ev: PointerEvent) => {
      if (this.dragging || !hitHero(ev)) return;
      this.dragging = true;
      this.pointerId = ev.pointerId;
      this.dragStart.set(ev.clientX, ev.clientY);
      canvas.setPointerCapture?.(ev.pointerId);
      bus.emit('ui:haptic', { pattern: 'tick' });
    };

    const onMove = (ev: PointerEvent) => {
      if (!this.dragging || ev.pointerId !== this.pointerId) return;
      const r = rectOf();
      const dy = this.dragStart.y - ev.clientY;
      const dx = ev.clientX - this.dragStart.x;
      // pulling up squeezes; the travel is a fifth of the screen height, which
      // is about a thumb's natural arc
      this.squeeze.target = THREE.MathUtils.clamp(dy / (r.height * 0.2), 0, 1);
      this.lateral.target = THREE.MathUtils.clamp(dx / (r.width * 0.5), -1, 1);
      ev.preventDefault();
    };

    const onUp = (ev: PointerEvent) => {
      if (!this.dragging || ev.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = -1;
      this.squeeze.target = 0;
      this.lateral.target = 0;
      canvas.releasePointerCapture?.(ev.pointerId);
    };

    canvas.addEventListener('pointerdown', onDown, { passive: true });
    canvas.addEventListener('pointermove', onMove, { passive: false });
    canvas.addEventListener('pointerup', onUp, { passive: true });
    canvas.addEventListener('pointercancel', onUp, { passive: true });

    const off = () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      this.dragging = false;
    };
    this.inputOff = off;
    return off;
  }

  // ─────────────────── frame ───────────────────

  update(dt: number, elapsed: number, camera?: THREE.Camera | null): void {
    const d = Math.min(dt, 0.05);
    this.sched.step(d);
    this.cards.update(d);
    this.chips.update(d, elapsed);
    this.avatars.update(d, elapsed, camera ?? null);
    this.particles.update(d, elapsed);

    // hero squeeze — driven every frame once the peel has landed so the
    // cards track the finger with no latency
    const sq = this.squeeze.step(d);
    this.lateral.step(d);
    if (this.heroSettled && this.peeked) {
      const list = this.hole[this.hero];
      const n = list.length;
      for (let i = 0; i < n; i++) {
        const h = list[i];
        if (h.busy) continue;
        this.heroPose(i, n, sq, this._p, this._q);
        h.setPose(this._p, this._q);
        // the card physically curls under the thumb, and the near edge
        // curls harder than the far one
        h.setBend(sq * (0.16 + i * 0.03), sq * 0.07, sq * 0.05 * (i - (n - 1) / 2));
      }
    }

    // fades
    for (let i = this.fades.length - 1; i >= 0; i--) {
      const f = this.fades[i];
      f.t += d;
      if (f.t < 0) continue;
      const u = THREE.MathUtils.clamp(f.t / f.dur, 0, 1);
      f.card.setOpacity(f.from + (f.to - f.from) * u);
      if (u >= 1) {
        this.fades.splice(i, 1);
        if (f.release) {
          const idx = this.pile.indexOf(f.card);
          if (idx >= 0) this.pile.splice(idx, 1);
          f.card.release();
        }
      }
    }

    // rim glows
    for (let i = this.glows.length - 1; i >= 0; i--) {
      const g = this.glows[i];
      g.t += d;
      const u = g.t / g.dur;
      let k: number;
      if (u < 0.16) k = u / 0.16;
      else if (u < 0.16 + g.hold / g.dur) k = 1;
      else k = Math.max(0, 1 - (u - 0.16 - g.hold / g.dur) / Math.max(0.001, 1 - 0.16 - g.hold / g.dur));
      g.card.setGlow(g.peak * k);
      if (u >= 1) {
        g.card.setGlow(0);
        this.glows.splice(i, 1);
      }
    }
  }

  // ─────────────────── plumbing ───────────────────

  attach(parent: THREE.Object3D): void {
    parent.add(this.group);
  }

  setTableSize(size: number): void {
    const n = Math.max(1, Math.min(9, Math.round(size)));
    if (n === this.size) return;
    this.size = n;
    this.avatars.setTableSize(n);
    this.relayout();
  }

  setHeroSeat(seat: number): void {
    if (seat === this.hero) return;
    this.hero = seat;
    this.avatars.setHeroSeat(seat);
    this.relayout();
  }

  setQuality(tier: PerfTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.cards.setQuality(tier);
    this.chips.setQuality(tier);
    this.avatars.setQuality(tier);
    this.particles.setQuality(tier);
  }

  setCardBack(id: CardBackId): void {
    this.cards.setBackId(id);
  }

  reset(): void {
    this.sched.clear();
    this.mayShow.fill(false);
    this.showing.fill(false);
    this.clearCards();
    this.fades.length = 0;
    this.glows.length = 0;
    this.chips.releaseAll();
    this.particles.clear();
    for (let i = 0; i < 9; i++) {
      this.betStacks[i] = null;
      this.seatStacks[i] = null;
      this.avatars.setSeat(i, null);
    }
    this.potStack = null;
    this.potAmount = 0;
    this.boardCounts[0] = 0;
    this.boardCounts[1] = 0;
    this.boardOwner.length = 0;
    this.boardSlotIdx.length = 0;
    this.peeked = false;
    this.heroSettled = false;
    this.squeeze.set(0);
    this.lateral.set(0);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.inputOff?.();
    this.inputOff = null;
    this.sched.clear();
    this.cards.dispose();
    this.chips.dispose();
    this.avatars.dispose();
    this.particles.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

// ─────────────────────────── factory ───────────────────────────

export interface DealingOptions {
  tier?: PerfTier;
  /** attach to this parent instead of the renderer's play root */
  parent?: THREE.Object3D | null;
  /** false to skip the drag-to-squeeze binding (e.g. in a replay viewer) */
  input?: boolean;
  /**
   * false keeps every card on the felt — no DOM card layer. Used by surfaces
   * that render a table without a HUD, such as a hand replay thumbnail.
   */
  readable?: boolean;
}

export function createDealing(opts: DealingOptions = {}): DealingSystem {
  const sys = new Dealing(opts.tier ?? 'high');
  if (opts.parent) sys.attach(opts.parent);
  return sys;
}

let singleton: DealingSystem | null = null;
let detach: (() => void) | null = null;

/**
 * Builds the play systems and wires them to the live renderer: attaches to
 * the stage's play root, subscribes to the frame loop, binds the squeeze
 * gesture to the canvas and warms the card atlas.
 */
export function initDealing(opts: DealingOptions = {}): DealingSystem {
  disposeDealing();
  const stage: RendererHandle | null = getStageHandle();
  const tier = opts.tier ?? stage?.tier ?? 'high';

  // ── the readable card layer, requested FIRST ───────────────────────────
  // Deliberately ahead of `new Dealing()`. That constructor builds thirty card
  // slabs, the chip system, the seat avatars and the particle pools — hundreds
  // of milliseconds of synchronous geometry on a mid-tier phone, and seconds
  // on software GL. Asking for this chunk before any of it starts lets the
  // fetch and parse ride along with that work instead of queueing behind it,
  // which is the difference between the player's hand appearing a beat after
  // they sit down and appearing after the first hand is already over.
  const wantReadable = opts.readable !== false;
  const layerChunk = wantReadable ? import('../ui/table/board.ts') : null;
  if (wantReadable) readableState = 'pending';

  // ── size the printed atlas to the job it actually has ──────────────────
  // Every face on the felt belongs to an opponent, and an opponent's card
  // projects to roughly 38 CSS px wide — 114 device px on a 3× phone. A full
  // retina atlas is a 3016×1296 canvas painted with 52 engraved faces, which
  // is several hundred milliseconds of blocked main thread per suit row and
  // more than twice the resolution those cards can ever show. Sizing the cell
  // to the card gives back that time, and the readable cards are DOM text,
  // so nothing a player has to read loses a single pixel.
  const atlasScale = tier === 'high' ? 0.62 : tier === 'mid' ? 0.5 : 0.4;
  initCardFaces({ scale: wantReadable ? atlasScale : 1, anisotropy: 4 });

  const sys = new Dealing(tier);

  // The atlas paints one suit per macrotask so mounting the table never
  // blocks. Forcing it to finish is a real stall, so it is demanded at the
  // exact moment a printed face has to exist on the felt: a showdown, or —
  // when the readable layer is absent and the felt is drawing every card
  // itself — the start of the hand.
  const atlas = cardFaces();
  const offAtlas = bus.on('hand:start', () => {
    if (!readableCards()) atlas.ensureBuilt();
  });
  const offAtlasShow = bus.on('hand:showdown', () => atlas.ensureBuilt());

  const parent = opts.parent ?? stage?.root ?? null;
  if (parent) sys.attach(parent);

  const cleanups: Array<() => void> = [offAtlas, offAtlasShow];
  if (stage) {
    cleanups.push(stage.onFrame((_alpha, dt, elapsed) => sys.update(dt, elapsed, stage.camera)));
    if (opts.input !== false) {
      cleanups.push(sys.bindInput(stage.renderer.domElement, stage.camera));
    }
  }

  // ── mount the readable card layer ──────────────────────────────────────
  // This is a *bootstrap*, not a dependency: `mountCardLayer()` is idempotent
  // and the host screen is meant to own the call (see the module header in
  // src/ui/table/board.ts). Until it does, the felt is opened here — because
  // the stage becoming visible is the one moment in the app that reliably
  // means "a table is on screen", and a player must never arrive at a table
  // that cannot show them their own hand. Delete these lines the day
  // src/ui/screens/table.ts calls mountCardLayer() itself.
  if (layerChunk) {
    void layerChunk
      .then((mod) => {
        if (singleton !== sys) return;
        readable = mod.mountCardLayer();
        readableState = 'on';
        // A hand that started inside the import window may already have put
        // the hero's hand or the board on the felt. Take them back, then hand
        // the layer the hand that is already in progress.
        sys.dropReadableCards();
        sys.pushReadable(readable);
        cleanups.push(() => mod.disposeCardLayer());
      })
      .catch((err) => {
        // Not fatal: `dealHole`/`dealBoard` fall back to felt cards.
        readableState = 'off';
        console.warn('[dealing] readable card layer unavailable', err);
      });
  }

  detach = () => {
    for (const c of cleanups) c();
    readable = null;
    readableState = 'off';
  };
  singleton = sys;
  return sys;
}

export function dealing(): DealingSystem | null {
  return singleton;
}

export function disposeDealing(): void {
  detach?.();
  detach = null;
  singleton?.dispose();
  singleton = null;
}
