/**
 * ROYALE — fx/transitions.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Shared-element and route transitions, implemented with FLIP.
 *
 * FLIP = First, Last, Invert, Play. Read the element's rect before the layout
 * change (First), let the real layout happen, read it again (Last), apply the
 * inverse transform so it *looks* like it never moved, then animate that
 * transform away. The browser only ever composites — no layout runs during the
 * animation, which is why this stays smooth on a mid-tier phone where an
 * animated `width`/`top` would not.
 *
 * Two deliberate constraints:
 *  • Scaling is always UNIFORM. A non-uniform FLIP scale stretches every glyph
 *    inside the element, which is the single most common tell of a cheap web
 *    transition. Instead the destination scales uniformly from the source's
 *    width ratio and a ghost of the source cross-fades over the difference.
 *  • Only `transform` and `opacity` animate. No `clip-path`, no `filter`, no
 *    `width` — the three things that would drop frames here.
 */
import { engine, reduceMotion, token } from './engine.ts';

export interface FlipOpts {
  ms?: number;
  easing?: string;
  /** cross-fade the moving element as well as move it */
  fade?: boolean;
  delayMs?: number;
}

let easeOut = '';
let easeSpring = '';
let easeSnap = '';

function easings(): void {
  if (easeOut) return;
  easeOut = token('--ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)');
  easeSpring = token('--ease-spring', 'cubic-bezier(0.34, 1.56, 0.64, 1)');
  easeSnap = token('--ease-snap', 'cubic-bezier(0.2, 0.9, 0.15, 1)');
}

function finished(anim: Animation | null): Promise<void> {
  if (!anim) return Promise.resolve();
  return anim.finished.then(
    () => void 0,
    () => void 0,
  );
}

// ─────────────────────────── ghosts ───────────────────────────

/**
 * A visual copy of `el` parked in the FX layer at its current viewport rect.
 * Inert, unfocusable and hidden from assistive tech — it exists only to be
 * animated and thrown away. Canvas contents are not copied by `cloneNode`, so
 * ghosting a WebGL surface gives a blank rect; nothing in the app ghosts one.
 */
export function ghostOf(el: Element): { el: HTMLElement; rect: DOMRect } {
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true) as HTMLElement;
  clone.classList.add('fx-ghost');
  clone.setAttribute('aria-hidden', 'true');
  clone.removeAttribute('id');
  clone.style.left = `${rect.left}px`;
  clone.style.top = `${rect.top}px`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  clone.querySelectorAll('input,button,a,select,textarea').forEach((n) => n.setAttribute('tabindex', '-1'));
  engine.layer('banner').appendChild(clone);
  return { el: clone, rect };
}

// ─────────────────────────── core FLIP ───────────────────────────

/** Capture positions for a set of elements before a layout change. */
export function captureRects(els: Iterable<Element>): Map<Element, DOMRect> {
  const map = new Map<Element, DOMRect>();
  for (const el of els) map.set(el, el.getBoundingClientRect());
  return map;
}

/**
 * Invert-and-play a previously captured set. Elements that did not move are
 * skipped, so a list where only two rows swapped animates exactly two nodes.
 */
export function playFlip(first: Map<Element, DOMRect>, opts: FlipOpts = {}): Promise<void> {
  easings();
  if (reduceMotion()) return Promise.resolve();
  const ms = opts.ms ?? 380;
  const easing = opts.easing ?? easeOut;
  const anims: Animation[] = [];
  for (const [el, before] of first) {
    if (!el.isConnected) continue;
    const after = el.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    const sx = after.width > 0 ? before.width / after.width : 1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01) continue;
    const s = Math.abs(sx - 1) < 0.01 ? 1 : sx;
    anims.push(
      el.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})`, transformOrigin: '0 0' },
          { transform: 'translate3d(0,0,0) scale(1)', transformOrigin: '0 0' },
        ],
        { duration: ms, easing, delay: opts.delayMs ?? 0, fill: 'none' },
      ),
    );
  }
  return Promise.all(anims.map((a) => finished(a))).then(() => void 0);
}

/** Convenience: capture, mutate the DOM synchronously, then animate the delta. */
export function flipList(els: Iterable<Element>, mutate: () => void, opts: FlipOpts = {}): Promise<void> {
  const first = captureRects(els);
  mutate();
  return playFlip(first, opts);
}

// ─────────────────────────── shared element ───────────────────────────

export interface SharedOpts extends FlipOpts {
  /** hold the ghost this fraction of the duration before it fades (0..1) */
  ghostHold?: number;
  /** spring the destination in rather than easing it */
  spring?: boolean;
}

/**
 * Grow `to` out of the position and size of `from`, with a ghost of `from`
 * carrying the pixels across. This is the "card opens into a full screen"
 * transition the router uses for the store, feed detail and hand replay.
 *
 * `to` must already be laid out at its final position when this is called.
 */
export function sharedElement(from: Element, to: HTMLElement, opts: SharedOpts = {}): Promise<void> {
  easings();
  if (reduceMotion() || !from.isConnected || !to.isConnected) return Promise.resolve();
  const ms = opts.ms ?? 460;
  const easing = opts.easing ?? (opts.spring ? easeSpring : easeOut);

  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (a.width < 1 || b.width < 1) return Promise.resolve();

  const scaleUp = a.width / b.width;
  const dx = a.left + a.width / 2 - (b.left + b.width / 2);
  const dy = a.top + a.height / 2 - (b.top + b.height / 2);

  const dest = to.animate(
    [
      { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scaleUp.toFixed(4)})`, opacity: 0.15 },
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
    ],
    { duration: ms, easing, fill: 'none' },
  );

  const g = ghostOf(from);
  const scaleDown = b.width / a.width;
  const hold = opts.ghostHold ?? 0.34;
  g.el.animate(
    [
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1, offset: 0 },
      { opacity: 0.85, offset: hold },
      { transform: `translate3d(${-dx}px, ${-dy}px, 0) scale(${scaleDown.toFixed(4)})`, opacity: 0, offset: 1 },
    ],
    { duration: ms, easing, fill: 'forwards' },
  ).onfinish = (): void => g.el.remove();
  engine.after(ms + 240, () => g.el.remove());

  return finished(dest);
}

/**
 * The reverse: collapse `from` back down into `to`'s tile. Used on dismiss so
 * the screen returns to the thing that spawned it instead of just sliding off.
 */
export function collapseInto(from: HTMLElement, to: Element, opts: SharedOpts = {}): Promise<void> {
  easings();
  if (reduceMotion() || !from.isConnected) return Promise.resolve();
  const ms = opts.ms ?? 340;
  const a = from.getBoundingClientRect();
  const b = to.isConnected ? to.getBoundingClientRect() : null;
  if (!b || a.width < 1) {
    return finished(
      from.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.96)' }], {
        duration: ms,
        easing: easeSnap,
        fill: 'forwards',
      }),
    );
  }
  const scale = b.width / a.width;
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  return finished(
    from.animate(
      [
        { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scale.toFixed(4)})`, opacity: 0 },
      ],
      { duration: ms, easing: opts.easing ?? easeSnap, fill: 'forwards' },
    ),
  );
}

/**
 * A sheet that morphs out of the tile that spawned it: it rises from the
 * tile's centre-line, over-shoots by a hair and settles. The scrim fades
 * linearly so it never draws attention to itself.
 */
export function morphSheetFrom(tile: Element | null, sheet: HTMLElement, scrim?: HTMLElement | null): Promise<void> {
  easings();
  if (reduceMotion()) return Promise.resolve();
  const ms = 480;
  if (scrim) scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'linear', fill: 'none' });

  const b = sheet.getBoundingClientRect();
  let dy = Math.min(240, b.height * 0.5);
  let dx = 0;
  let scale = 0.94;
  if (tile && tile.isConnected) {
    const a = tile.getBoundingClientRect();
    dy = a.top + a.height / 2 - (b.top + b.height / 2);
    dx = (a.left + a.width / 2 - (b.left + b.width / 2)) * 0.35;
    scale = Math.max(0.86, Math.min(0.99, a.width / Math.max(1, b.width)));
    // Never launch a sheet from above its final resting place.
    if (dy < 0) dy = Math.max(dy, -60);
  }

  return finished(
    sheet.animate(
      [
        { transform: `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`, opacity: 0 },
        { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
      ],
      { duration: ms, easing: easeSpring, fill: 'none' },
    ),
  );
}

// ─────────────────────────── route transitions ───────────────────────────

export type RouteDir = 'push' | 'pop' | 'fade' | 'up';

/**
 * The router calls this with the outgoing and incoming screen roots. Push and
 * pop use an iOS-style parallax — the outgoing screen moves a third as far as
 * the incoming one and dims, which is what makes the stack feel like it has
 * depth rather than like two slides.
 *
 * Resolves when the incoming screen has settled; the caller removes the
 * outgoing node.
 */
export function routeTransition(out: HTMLElement | null, inc: HTMLElement | null, dir: RouteDir = 'push'): Promise<void> {
  easings();
  if (reduceMotion()) {
    if (out) out.style.opacity = '0';
    return Promise.resolve();
  }
  const ms = dir === 'fade' ? 260 : 420;
  const easing = dir === 'up' ? easeSpring : easeSnap;
  const sign = dir === 'pop' ? -1 : 1;
  const anims: Animation[] = [];

  if (inc) {
    const frames: Keyframe[] =
      dir === 'fade'
        ? [
            { opacity: 0, transform: 'scale(1.015)' },
            { opacity: 1, transform: 'scale(1)' },
          ]
        : dir === 'up'
          ? [
              { opacity: 0, transform: 'translate3d(0, 7%, 0) scale(0.985)' },
              { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
            ]
          : [
              { opacity: 0.55, transform: `translate3d(${sign * 100}%, 0, 0)` },
              { opacity: 1, transform: 'translate3d(0,0,0)' },
            ];
    anims.push(inc.animate(frames, { duration: ms, easing, fill: 'none' }));
  }

  if (out) {
    const frames: Keyframe[] =
      dir === 'fade'
        ? [
            { opacity: 1, transform: 'scale(1)' },
            { opacity: 0, transform: 'scale(0.99)' },
          ]
        : dir === 'up'
          ? [
              { opacity: 1, transform: 'scale(1)' },
              { opacity: 0.4, transform: 'scale(0.97)' },
            ]
          : [
              { opacity: 1, transform: 'translate3d(0,0,0)' },
              { opacity: 0.35, transform: `translate3d(${-sign * 32}%, 0, 0)` },
            ];
    anims.push(out.animate(frames, { duration: ms, easing, fill: 'forwards' }));
  }

  return Promise.all(anims.map((a) => finished(a))).then(() => void 0);
}

/**
 * Pop an element in with a spring — the standard "this just appeared and
 * matters" entrance for modals, reward cards and newly unlocked tiles.
 */
export function popIn(el: HTMLElement, opts: FlipOpts = {}): Promise<void> {
  easings();
  if (reduceMotion()) return Promise.resolve();
  return finished(
    el.animate(
      [
        { transform: 'scale(0.82) translate3d(0, 12px, 0)', opacity: 0 },
        { transform: 'scale(1) translate3d(0,0,0)', opacity: 1 },
      ],
      { duration: opts.ms ?? 460, easing: opts.easing ?? easeSpring, delay: opts.delayMs ?? 0, fill: 'none' },
    ),
  );
}

/**
 * Stagger children in. `from` picks the direction of travel; the delay ramp is
 * capped so a 40-row list does not take four seconds to finish arriving.
 */
export function staggerIn(
  els: Iterable<HTMLElement>,
  opts: FlipOpts & { stepMs?: number; from?: 'bottom' | 'top' | 'right' } = {},
): void {
  easings();
  if (reduceMotion()) return;
  const step = opts.stepMs ?? 42;
  const ms = opts.ms ?? 460;
  const dirs = { bottom: 'translate3d(0, 18px, 0)', top: 'translate3d(0, -18px, 0)', right: 'translate3d(22px, 0, 0)' };
  const start = dirs[opts.from ?? 'bottom'];
  let i = 0;
  for (const el of els) {
    el.animate([{ opacity: 0, transform: start }, { opacity: 1, transform: 'translate3d(0,0,0)' }], {
      duration: ms,
      easing: easeOut,
      delay: Math.min(420, i * step) + (opts.delayMs ?? 0),
      fill: 'backwards',
    });
    i++;
  }
}
