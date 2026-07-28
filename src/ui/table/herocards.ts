/**
 * ROYALE — the hero's hole cards, and the DOM card primitive they are built on.
 *
 * ── Why these cards are DOM and not three.js meshes ────────────────────────
 * The stage draws real card slabs — bevelled, varnished, bending, with a
 * contact shadow. They are lovely, and at this camera they are also *illegible*:
 * `renderer.anchors` reports ~180 CSS px per world unit at the community band,
 * and `layout.CARD_SIZE.w` is 0.21 world units, so a felt card lands on screen
 * about 38 px wide and — lying flat, foreshortened by the camera — roughly
 * 30 px tall. The rank glyph inside that is four pixels. No amount of atlas
 * resolution rescues a card that small, and "I don't see my own cards" is
 * exactly the complaint this module exists to answer.
 *
 * So the cards a player has to *read* are DOM. The rank is real text, hinted
 * and positioned by the browser at the device's own pixel ratio; the pip is a
 * vector path, not a sampled texture; and the whole thing keeps working when
 * the WebGL stage is hidden, throttled, or has lost its context. The 3D layer
 * keeps everything nobody reads — the opponents' face-down hands, the burn,
 * the muck, the chips — which is where a mesh's physicality actually pays for
 * itself. Legibility beat realism, as briefed.
 *
 * Composition, outside in. Each level does exactly one job, so an entrance
 * animation can never fight a finger:
 *
 *   .rhero          fixed, bottom-anchored; JS writes only its translate
 *     .rhero__deck  the group tilt toward the player (CSS only)
 *       .rhero__slot   fan position + the live squeeze, driven by --sq
 *         .rhero__fly  entrance flight (Web Animations, cancellable)
 *           .rc        the card, and the perspective host for its own flip
 *
 * The squeeze is a real drag: pulling up on the hand lifts it, widens the fan
 * and tips it toward your face. It can only ever make the cards bigger and
 * more visible — a peek gesture that could hide your hand would be a bug.
 */

// Vite compiles this import; the project has no ambient CSS module declaration,
// so the checker is told to stand down on this one line.
// @ts-ignore -- CSS side-effect import handled by the bundler
import '../styles/cards.css';

import { cardRank, cardSuit, RANKS } from '../../core/types.ts';
import type { CardId, Suit } from '../../core/types.ts';
import { clamp, h, s, setText } from './dom.ts';

// ─────────────────────────── the card primitive ───────────────────────────

/**
 * Suit silhouettes on a 24-unit grid. Identical paths to the ones the feed
 * screen prints on its post cards — the same club has to be the same club in
 * both places, or the app stops feeling like one app.
 */
const SUIT_PATH: Record<Suit, string> = {
  0: 'M12 2.9a3.75 3.75 0 013.25 5.62A3.75 3.75 0 1113.6 15.1c.16 2.3.92 3.95 2.05 5.1H8.35c1.13-1.15 1.89-2.8 2.05-5.1a3.75 3.75 0 11-1.65-6.58A3.75 3.75 0 0112 2.9z',
  1: 'M12 2.1l8.7 9.9-8.7 9.9-8.7-9.9L12 2.1z',
  2: 'M12 21.2c-.6-.5-9-6.2-9-12.05A5.55 5.55 0 0112 5.9a5.55 5.55 0 019 3.25c0 5.85-8.4 11.55-9 12.05z',
  3: 'M12 2.4c3.35 3.7 7.35 6.05 7.35 9.85A4 4 0 0112.7 15.2c.2 2.15.9 3.7 1.85 4.6H9.45c.95-.9 1.65-2.45 1.85-4.6a4 4 0 01-6.65-2.95c0-3.8 4-6.15 7.35-9.85z',
};

const SUIT_NAME = ['clubs', 'diamonds', 'hearts', 'spades'] as const;

const REDUCED =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** Scales every duration in this module. Reduced motion gets the end state. */
export function motionMs(ms: number): number {
  return REDUCED?.matches ? 1 : ms;
}

/**
 * True when the player has asked the OS for less motion.
 *
 * `motionMs` covers everything with a duration, but the hand's parking pass is
 * a per-frame spring rather than a keyframed animation, and a spring has no
 * duration to collapse — it has to be told to arrive instead.
 */
export function reducedMotion(): boolean {
  return !!REDUCED?.matches;
}

export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
export const EASE_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
export const EASE_SNAP = 'cubic-bezier(0.2, 0.9, 0.15, 1)';

export interface CardEl {
  readonly el: HTMLElement;
  readonly card: CardId | null;
  readonly faceUp: boolean;
  /** Reprints the face in place — no element is ever thrown away. */
  setCard(card: CardId | null): void;
  setFaceUp(up: boolean, ms?: number, delayMs?: number): void;
  /** gold rim: this card is one of the five that make the winning hand */
  setWin(on: boolean): void;
  /** greyed back: on the felt, but not part of the hand being celebrated */
  setDim(on: boolean): void;
  cancel(): void;
}

class Card implements CardEl {
  readonly el: HTMLElement;
  card: CardId | null = null;
  faceUp = false;

  private flip: HTMLElement;
  private rank: HTMLElement;
  private pip: SVGPathElement;
  private mark: SVGPathElement;
  private anim: Animation | null = null;

  constructor() {
    this.rank = h('span', { class: 'rc__rank tnum' }, 'A');
    this.pip = s('path', { d: SUIT_PATH[3], fill: 'currentColor' }) as SVGPathElement;
    this.mark = s('path', { d: SUIT_PATH[3], fill: 'currentColor' }) as SVGPathElement;

    const face = h(
      'span',
      { class: 'rc__face', 'aria-hidden': 'true' },
      h(
        'span',
        { class: 'rc__corner' },
        this.rank,
        s('svg', { class: 'rc__pip', viewBox: '0 0 24 24' }, this.pip),
      ),
      // A watermark, not a second pip: it gives the card suit *mass* at a
      // glance from across the screen without competing with the index.
      s('svg', { class: 'rc__mark', viewBox: '0 0 24 24' }, this.mark),
      h('span', { class: 'rc__gloss' }),
    );

    const back = h(
      'span',
      { class: 'rc__back', 'aria-hidden': 'true' },
      h('span', { class: 'rc__weave' }),
      h('span', { class: 'rc__medal' }, 'R'),
    );

    this.flip = h('span', { class: 'rc__flip' }, back, face);
    this.el = h('span', { class: 'rc', role: 'img', 'aria-label': 'Hidden card' }, this.flip);
  }

  setCard(card: CardId | null): void {
    this.card = card;
    if (card === null) {
      this.el.setAttribute('aria-label', 'Hidden card');
      return;
    }
    const suit = cardSuit(card);
    const r = cardRank(card);
    const label = RANKS[r - 2];
    setText(this.rank, label);
    this.rank.classList.toggle('is-wide', label.length > 1);
    this.pip.setAttribute('d', SUIT_PATH[suit]);
    this.mark.setAttribute('d', SUIT_PATH[suit]);
    this.el.dataset.suit = String(suit);
    // Court cards and aces earn a gold keyline — rank tier you can read
    // before you have read the glyph.
    this.el.classList.toggle('is-court', r >= 11);
    this.el.setAttribute('aria-label', `${label} of ${SUIT_NAME[suit]}`);
  }

  /**
   * Turns the card.
   *
   * `is-flip` is what puts the card into 3D — see the note over `.rc__flip` in
   * cards.css. It goes on for the duration of the turn and comes off on the
   * last frame, because a card left in a 3D rendering context is rasterised at
   * a third of this screen's density and its rank stops being crisp. The class
   * is dropped on cancel too: an interrupted turn must not strand the card in
   * the soft state, which is the whole reason this is a class and not a
   * one-way stylesheet rule.
   */
  setFaceUp(up: boolean, ms = 300, delayMs = 0): void {
    this.anim?.cancel();
    this.anim = null;
    const changed = up !== this.faceUp;
    this.faceUp = up;
    this.el.classList.toggle('is-up', up);
    const dur = motionMs(ms);
    if (!changed || dur <= 1) {
      this.el.classList.remove('is-flip');
      return;
    }
    const from = up ? 'rotateY(180deg)' : 'rotateY(0deg)';
    const to = up ? 'rotateY(0deg)' : 'rotateY(180deg)';
    this.el.classList.add('is-flip');
    this.anim = this.flip.animate(
      [
        { transform: from, offset: 0 },
        // The card commits past square before it settles: a real turn has a
        // moment where it stands on its edge and the light rakes across it.
        { transform: up ? 'rotateY(96deg)' : 'rotateY(84deg)', offset: 0.46, easing: 'linear' },
        { transform: to, offset: 1 },
      ],
      { duration: dur, delay: motionMs(delayMs), easing: EASE_SNAP, fill: 'backwards' },
    );
    this.anim.addEventListener(
      'finish',
      () => {
        this.anim = null;
        this.el.classList.remove('is-flip');
      },
      { once: true },
    );
  }

  setWin(on: boolean): void {
    this.el.classList.toggle('is-win', on);
  }

  setDim(on: boolean): void {
    this.el.classList.toggle('is-dim', on);
  }

  cancel(): void {
    this.anim?.cancel();
    this.anim = null;
    this.el.classList.remove('is-flip');
  }
}

/** One DOM playing card. Its width comes from the `--rc-w` custom property. */
export function createCard(): CardEl {
  return new Card();
}

export interface FlyOpts {
  duration: number;
  delay?: number;
  easing?: string;
  /** degrees of in-plane spin bled off during the flight */
  spin?: number;
  /** starting scale — a card thrown from the chute is further away */
  scale?: number;
}

/**
 * Flies an element in from a screen-space offset. Returns the Animation so the
 * caller can cancel it: every entrance here is interruptible, because a player
 * who folds mid-deal must never strand a card in the air.
 */
export function flyIn(el: HTMLElement, dx: number, dy: number, opts: FlyOpts): Animation | null {
  const dur = motionMs(opts.duration);
  const delay = motionMs(opts.delay ?? 0);
  if (dur <= 1) return null;
  const spin = opts.spin ?? 0;
  const from = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) rotate(${spin}deg) scale(${opts.scale ?? 0.62})`;
  return el.animate(
    [
      { transform: from, opacity: 0, offset: 0 },
      { transform: from, opacity: 1, offset: 0.02 },
      { transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)', opacity: 1, offset: 1 },
    ],
    { duration: dur, delay, easing: opts.easing ?? EASE_OUT, fill: 'backwards' },
  );
}

// ─────────────────────────── the hero's hand ───────────────────────────

const HERO_DEAL_MS = 480;
const HERO_STAGGER_MS = 105;
const HERO_FLIP_MS = 340;
/** A hero hand holds at most four cards — PLO deals four. */
const MAX_HOLE = 4;

/**
 * Pointer capture, defensively. A pointer can be gone by the time we ask for
 * it — a cancelled touch, a synthetic event from a test harness — and the DOM
 * throws rather than shrugging. Losing capture costs the drag nothing that
 * matters; an exception here would abort the gesture entirely.
 */
function capture(el: HTMLElement, id: number, on: boolean): void {
  try {
    if (on) el.setPointerCapture?.(id);
    else el.releasePointerCapture?.(id);
  } catch {
    /* the pointer is already gone */
  }
}

export interface HeroHandOpts {
  /** where a dealt card flies in from, in CSS px; defaults to the felt's top */
  origin?: () => { x: number; y: number };
}

export interface HeroHand {
  readonly el: HTMLElement;
  /** how many cards are currently held */
  readonly count: number;
  /**
   * Sets the hand. `animate` deals them in one at a time; without it they just
   * appear, which is what a mid-hand state reconciliation wants.
   */
  show(cards: readonly CardId[], animate?: boolean): void;
  /** Folds the hand away — the cards skate down and out. */
  muck(): void;
  /** Empties the hand with no animation. */
  clear(): void;
  /** Gold rim on the cards that make the winning hand; null clears it. */
  highlight(cards: readonly CardId[] | null): void;
  /**
   * Parks the hand so its lowest *painted* pixel sits `clearance` CSS px above
   * the bottom of the viewport. Not the border box — the fan splays past it,
   * and the difference is the number that decides whether the player's own
   * cards get sliced off by the bar underneath them.
   */
  place(clearance: number): void;
  /**
   * Re-reads the fan's overhang from the live layout. Called on the host's
   * measure cadence; it is a layout read, so never call it per frame.
   */
  measure(): void;
  /** The hand's full painted height, in CSS px — box plus fan overhang. */
  readonly paintedHeight: number;
  dispose(): void;
}

class Hero implements HeroHand {
  readonly el: HTMLElement;

  private deck: HTMLElement;
  private slots: HTMLElement[] = [];
  private flies: HTMLElement[] = [];
  private cards: Card[] = [];
  private anims: Array<Animation | null> = [];
  private held: CardId[] = [];
  private origin: () => { x: number; y: number };
  private offDrag: () => void = () => undefined;

  private squeeze = 0;
  private squeezeTarget = 0;
  private vel = 0;
  private dragging = false;
  private pointerId = -1;
  private startY = 0;
  private raf = 0;
  private gap = -1;
  private drop = 0;

  constructor(opts: HeroHandOpts) {
    this.origin = opts.origin ?? (() => ({ x: window.innerWidth / 2, y: window.innerHeight * 0.2 }));
    this.deck = h('div', { class: 'rhero__deck' });
    this.el = h('div', { class: 'rhero', 'aria-label': 'Your hand' }, this.deck);
    // The stylesheet gives `.rhero` a transform transition, from the days when
    // the park height moved once a session. It moves on every sizer tap now,
    // and `board.ts` springs it frame by frame against the live hero-zone
    // height — so a transition on top would only add its own duration as lag
    // to a motion that is already eased, and the hand would crawl after the
    // bar instead of riding it. Opacity keeps its transition; transform is
    // handed to the frame loop.
    this.el.style.transition = 'opacity var(--d-base) var(--ease-out)';
    for (let i = 0; i < MAX_HOLE; i++) {
      const card = new Card();
      const fly = h('span', { class: 'rhero__fly' }, card.el);
      const slot = h('span', { class: 'rhero__slot' }, fly);
      this.slots.push(slot);
      this.flies.push(fly);
      this.cards.push(card);
      this.anims.push(null);
      this.deck.appendChild(slot);
    }
    this.applyFan();
    this.writeSqueeze();
    this.bindDrag();
  }

  get count(): number {
    return this.held.length;
  }

  // ── layout ──────────────────────────────────────────────────────

  /**
   * The fan. `t` is a card's signed distance from the middle of the hand, so
   * two cards straddle the centre and four splay symmetrically. Everything
   * else — the lift, the widening, the tilt — is a function of the squeeze,
   * computed in CSS from `--sq`, so the finger drives it with zero latency.
   */
  private applyFan(): void {
    const n = Math.max(2, this.held.length);
    const tight = n > 2;
    this.el.style.setProperty('--n', String(n));
    // Below 0.5 the cards overlap, which is what a hand held in one hand
    // actually does. 0.44 hides about an eighth of the card underneath —
    // enough to read as held, never enough to touch a rank.
    this.el.style.setProperty('--fan-x', tight ? '0.38' : '0.44');
    this.el.style.setProperty('--fan-rot', tight ? '6' : '9');
    for (let i = 0; i < MAX_HOLE; i++) {
      const t = i - (n - 1) / 2;
      this.slots[i].style.setProperty('--t', t.toFixed(3));
      this.slots[i].style.setProperty('--at', Math.abs(t).toFixed(3));
      this.slots[i].style.zIndex = String(10 + i);
    }
  }

  place(clearance: number): void {
    const g = Math.round(clearance * 2) / 2;
    if (g === this.gap) return;
    this.gap = g;
    this.write();
  }

  private write(): void {
    if (this.gap < 0) return;
    this.el.style.transform = `translate3d(-50%, ${(-(this.gap + this.drop)).toFixed(1)}px, 0)`;
  }

  /**
   * The fan's overhang, measured rather than derived.
   *
   * `.rhero` is exactly one card tall, but the slots are nudged down by a
   * fraction of a card and then rotated about a point below their own bottom
   * edge, so the ink reaches a few pixels past the border box — 5.2 px on a
   * 393 pt screen with two cards, more with four. That number is a pure
   * consequence of `--fan-x`, `--fan-rot` and the slot's transform origin, all
   * of which live in CSS and are meant to be tuned there, so it is read off
   * the live layout instead of being re-derived here every time somebody
   * retunes the fan.
   *
   * Only ever measured at rest: a card mid-flight is 200 px from where it will
   * land, and a squeeze in progress is lifting the whole hand.
   */
  measure(): void {
    if (this.dragging || this.raf !== 0 || this.held.length === 0) return;
    for (const a of this.anims) if (a && a.playState === 'running') return;
    const base = this.el.getBoundingClientRect();
    if (base.height <= 0) return;
    let low = base.bottom;
    for (let i = 0; i < this.held.length; i++) {
      const r = this.slots[i].getBoundingClientRect();
      if (r.height > 0 && r.bottom > low) low = r.bottom;
    }
    // Capped at a quarter card: a bad read must never be able to shove the
    // hand off the top of the felt.
    const next = clamp(low - base.bottom, 0, base.height * 0.25);
    if (Math.abs(next - this.drop) < 0.5) return;
    this.drop = next;
    this.write();
  }

  get paintedHeight(): number {
    return (this.el.offsetHeight || 0) + this.drop;
  }

  // ── content ─────────────────────────────────────────────────────

  show(cards: readonly CardId[], animate = false): void {
    const next = cards.slice(0, MAX_HOLE);
    const same = next.length === this.held.length && next.every((c, i) => c === this.held[i]);
    if (same && this.el.classList.contains('is-live')) return;

    this.held = next;
    this.applyFan();
    this.el.classList.toggle('is-live', next.length > 0);
    this.el.classList.remove('is-mucked', 'is-showdown');

    for (let i = 0; i < MAX_HOLE; i++) {
      const on = i < next.length;
      this.anims[i]?.cancel();
      this.anims[i] = null;
      this.cards[i].cancel();
      this.cards[i].setWin(false);
      this.cards[i].setDim(false);
      this.slots[i].classList.toggle('is-on', on);
      if (!on) {
        this.cards[i].setFaceUp(false, 0);
        continue;
      }
      this.cards[i].setCard(next[i]);
      if (!animate) {
        this.cards[i].setFaceUp(true, 0);
        continue;
      }
      const o = this.origin();
      const r = this.slots[i].getBoundingClientRect();
      const dx = o.x - (r.left + r.width / 2);
      const dy = o.y - (r.top + r.height / 2);
      this.cards[i].setFaceUp(false, 0);
      this.anims[i] = flyIn(this.flies[i], dx, dy, {
        duration: HERO_DEAL_MS,
        delay: i * HERO_STAGGER_MS,
        easing: EASE_SPRING,
        spin: -24,
        scale: 0.46,
      });
      // The turn starts while the card is still travelling, so by the time it
      // lands in your hand it is already yours to read.
      this.cards[i].setFaceUp(true, HERO_FLIP_MS, i * HERO_STAGGER_MS + HERO_DEAL_MS * 0.42);
    }
  }

  muck(): void {
    if (this.held.length === 0) return;
    this.held = [];
    this.el.classList.add('is-mucked');
    this.el.classList.remove('is-live', 'is-showdown');
    for (let i = 0; i < MAX_HOLE; i++) {
      this.anims[i]?.cancel();
      this.anims[i] = null;
      this.cards[i].cancel();
      this.cards[i].setWin(false);
    }
    this.setSqueeze(0, true);
  }

  clear(): void {
    this.held = [];
    this.el.classList.remove('is-live', 'is-mucked', 'is-showdown');
    for (let i = 0; i < MAX_HOLE; i++) {
      this.anims[i]?.cancel();
      this.anims[i] = null;
      this.cards[i].cancel();
      this.cards[i].setWin(false);
      this.cards[i].setDim(false);
      this.slots[i].classList.remove('is-on');
    }
    this.setSqueeze(0, true);
  }

  highlight(cards: readonly CardId[] | null): void {
    if (!cards) {
      for (const c of this.cards) {
        c.setWin(false);
        c.setDim(false);
      }
      this.el.classList.remove('is-showdown');
      return;
    }
    const set = new Set(cards);
    this.el.classList.add('is-showdown');
    for (let i = 0; i < MAX_HOLE; i++) {
      const held = i < this.held.length;
      const win = held && set.has(this.held[i]);
      this.cards[i].setWin(win);
      this.cards[i].setDim(held && !win);
    }
  }

  // ── the squeeze ─────────────────────────────────────────────────

  private setSqueeze(v: number, immediate = false): void {
    this.squeezeTarget = clamp(v, 0, 1);
    if (immediate) {
      this.squeeze = this.squeezeTarget;
      this.vel = 0;
      this.writeSqueeze();
      return;
    }
    this.startSpring();
  }

  private writeSqueeze(): void {
    this.el.style.setProperty('--sq', this.squeeze.toFixed(4));
  }

  /** A damped spring that only exists while it has work to do. */
  private startSpring(): void {
    if (this.raf) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.vel += ((this.squeezeTarget - this.squeeze) * 240 - this.vel * 27) * dt;
      this.squeeze += this.vel * dt;
      this.writeSqueeze();
      const settled =
        Math.abs(this.vel) < 0.003 && Math.abs(this.squeezeTarget - this.squeeze) < 0.003;
      if (settled && !this.dragging) {
        this.squeeze = this.squeezeTarget;
        this.vel = 0;
        this.writeSqueeze();
        this.raf = 0;
        return;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private bindDrag(): void {
    const down = (ev: PointerEvent) => {
      if (this.dragging || this.held.length === 0) return;
      this.dragging = true;
      this.pointerId = ev.pointerId;
      this.startY = ev.clientY;
      capture(this.el, ev.pointerId, true);
      this.el.classList.add('is-held');
      this.setSqueeze(0.2);
    };
    const move = (ev: PointerEvent) => {
      if (!this.dragging || ev.pointerId !== this.pointerId) return;
      // A fifth of the screen height is about a thumb's natural arc.
      const travel = Math.max(90, window.innerHeight * 0.18);
      this.setSqueeze(0.2 + (this.startY - ev.clientY) / travel);
      ev.preventDefault();
    };
    const up = (ev: PointerEvent) => {
      if (!this.dragging || ev.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = -1;
      capture(this.el, ev.pointerId, false);
      this.el.classList.remove('is-held');
      this.setSqueeze(0);
    };
    this.el.addEventListener('pointerdown', down, { passive: true });
    this.el.addEventListener('pointermove', move, { passive: false });
    this.el.addEventListener('pointerup', up, { passive: true });
    this.el.addEventListener('pointercancel', up, { passive: true });
    this.offDrag = () => {
      this.el.removeEventListener('pointerdown', down);
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
    };
  }

  dispose(): void {
    this.offDrag();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const a of this.anims) a?.cancel();
    for (const c of this.cards) c.cancel();
    this.el.remove();
  }
}

export function createHeroHand(opts: HeroHandOpts = {}): HeroHand {
  return new Hero(opts);
}
