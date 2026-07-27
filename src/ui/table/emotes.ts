/**
 * Reactions: the radial emote wheel, the flying bubble, and per-seat muting.
 *
 * Press and hold the emote key (or any avatar) to bloom a wheel under your
 * thumb; slide to an emote and release to send. The reaction leaves the hero
 * seat as a physical bubble, springs across the felt to its target and pops.
 *
 * Rate limited, mutable per player, and always emitted on the bus as
 * `social:reaction` so the renderer and audio layers stay in sync.
 */

import { bus } from '../../core/bus.ts';
import type { ReactionKind } from '../../core/types.ts';
import { clamp, cls, cue, h, haptic, onFrame, Spring } from './dom.ts';
import { icon, REACTION_LABEL, REACTION_ORDER, reactionGlyph } from './icons.ts';

const WHEEL_RADIUS = 92;
const DEAD_ZONE = 34;
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 14_000;
const MIN_GAP_MS = 1400;

export interface EmoteWheel {
  el: HTMLElement;
  /** Bloom the wheel at a screen point. `dragging` = opened from a hold. */
  open(x: number, y: number, targetSeat: number, dragging: boolean): void;
  close(): void;
  readonly isOpen: boolean;
  dispose(): void;
}

export interface EmoteWheelOptions {
  heroSeat: () => number;
  /** local echo — the caller flies the bubble and updates plates */
  onSend?: (kind: ReactionKind, targetSeat: number) => void;
}

export function createEmoteWheel(opts: EmoteWheelOptions): EmoteWheel {
  const items: HTMLElement[] = [];
  const ring = h('div', { class: 'ew__ring' });
  const hubLabel = h('span', { class: 'ew__hub-t' }, 'Cancel');
  const hub = h('div', { class: 'ew__hub' }, hubLabel);
  const caption = h('div', { class: 'ew__caption' }, '');
  const wheel = h('div', { class: 'ew__wheel' }, ring, hub, caption);
  const el = h('div', { class: 'ew' }, h('i', { class: 'ew__scrim' }), wheel);

  for (let i = 0; i < REACTION_ORDER.length; i++) {
    const kind = REACTION_ORDER[i];
    const angle = -Math.PI / 2 + (i / REACTION_ORDER.length) * Math.PI * 2;
    const item = h('div', { class: 'ew__item', 'data-i': String(i) }, h('i', { class: 'ew__glow' }), reactionGlyph(kind, 32));
    item.style.setProperty('--x', `${(Math.cos(angle) * WHEEL_RADIUS).toFixed(1)}px`);
    item.style.setProperty('--y', `${(Math.sin(angle) * WHEEL_RADIUS).toFixed(1)}px`);
    item.style.setProperty('--d', `${i * 18}ms`);
    items.push(item);
    ring.appendChild(item);
  }

  let open = false;
  let dragMode = false;
  let cx = 0;
  let cy = 0;
  let target = -1;
  let active = -1;
  let dragHint = 'Pick a reaction';
  const sent: number[] = [];

  const setActive = (i: number): void => {
    if (i === active) return;
    active = i;
    for (let k = 0; k < items.length; k++) cls(items[k], 'is-active', k === i);
    cls(hub, 'is-armed', i >= 0);
    hubLabel.textContent = i >= 0 ? 'Release' : 'Cancel';
    caption.textContent = i >= 0 ? REACTION_LABEL[REACTION_ORDER[i]] : dragHint;
    if (i >= 0) {
      haptic('tick');
      cue('tapSecondary');
    }
  };

  const pointAt = (x: number, y: number): void => {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < DEAD_ZONE) {
      setActive(-1);
      return;
    }
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    while (a < 0) a += Math.PI * 2;
    const idx = Math.round((a / (Math.PI * 2)) * REACTION_ORDER.length) % REACTION_ORDER.length;
    setActive(idx);
  };

  const rateOk = (): boolean => {
    const now = performance.now();
    while (sent.length && now - sent[0] > BURST_WINDOW_MS) sent.shift();
    if (sent.length >= BURST_LIMIT) return false;
    if (sent.length && now - sent[sent.length - 1] < MIN_GAP_MS) return false;
    return true;
  };

  const send = (i: number): void => {
    const kind = REACTION_ORDER[i];
    if (!rateOk()) {
      haptic('error');
      cue('tapError');
      bus.emit('ui:toast', { text: 'Easy on the emotes', tone: 'info', ms: 1300 });
      return;
    }
    sent.push(performance.now());
    const from = opts.heroSeat();
    bus.emit('social:reaction', { kind, fromSeat: from, targetSeat: target < 0 ? from : target });
    haptic('select');
    opts.onSend?.(kind, target < 0 ? from : target);
  };

  const onMove = (e: PointerEvent): void => {
    if (!open || !dragMode) return;
    pointAt(e.clientX, e.clientY);
  };

  const onUp = (e: PointerEvent): void => {
    if (!open) return;
    if (dragMode) {
      pointAt(e.clientX, e.clientY);
      if (active >= 0) send(active);
      api.close();
    }
  };

  const onTapSelect = (e: PointerEvent): void => {
    if (!open || dragMode) return;
    const item = (e.target as HTMLElement | null)?.closest?.('.ew__item') as HTMLElement | null;
    if (item) {
      send(Number(item.dataset.i));
      api.close();
    } else {
      api.close();
    }
  };

  const api: EmoteWheel = {
    el,
    get isOpen(): boolean {
      return open;
    },
    open(x, y, targetSeat, dragging): void {
      if (open) return;
      open = true;
      dragMode = dragging;
      target = targetSeat;
      active = -2;
      const pad = WHEEL_RADIUS + 40;
      cx = clamp(x, pad, window.innerWidth - pad);
      cy = clamp(y, pad + 24, window.innerHeight - pad - 56);
      wheel.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0) translate(-50%, -50%)`;
      dragHint = dragging ? 'Slide to react' : 'Pick a reaction';
      caption.textContent = dragHint;
      setActive(-1);
      cls(el, 'is-open', true);
      cue('sheetOpen');
      haptic('select');
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      if (!dragging) el.addEventListener('pointerup', onTapSelect);
    },
    close(): void {
      if (!open) return;
      open = false;
      cls(el, 'is-open', false);
      setActive(-1);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerup', onTapSelect);
    },
    dispose(): void {
      api.close();
      el.remove();
    },
  };

  return api;
}

// ═══════════════════════ flying bubble ═══════════════════════

export interface EmoteFlight {
  el: HTMLElement;
  fly(kind: ReactionKind, from: { x: number; y: number }, to: { x: number; y: number }, onArrive?: () => void): void;
  dispose(): void;
}

/**
 * Springs a reaction bubble from the sender to the target. Physical, not a
 * linear tween — it overshoots a touch and settles, which is what makes it
 * read as thrown rather than animated.
 */
export function createEmoteFlight(): EmoteFlight {
  const el = h('div', { class: 'ef' });

  return {
    el,
    fly(kind, from, to, onArrive): void {
      const bubble = h('div', { class: 'ef__bubble' }, reactionGlyph(kind, 34), h('i', { class: 'ef__tail' }));
      el.appendChild(bubble);
      const sx = new Spring(from.x, 150, 19);
      const sy = new Spring(from.y, 150, 19);
      sx.target = to.x;
      sy.target = to.y;
      let life = 0;
      let arrived = false;
      const stop = onFrame((dt) => {
        life += dt;
        const x = sx.step(dt);
        const y = sy.step(dt);
        const t = Math.min(1, life / 260);
        const scale = 0.4 + 0.6 * (1 - Math.pow(1 - t, 3));
        bubble.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        if (!arrived && (sx.settled || life > 620)) {
          arrived = true;
          onArrive?.();
          bubble.classList.add('is-pop');
        }
        if (life > 980) {
          stop();
          bubble.remove();
        }
      });
    },
    dispose(): void {
      el.replaceChildren();
      el.remove();
    },
  };
}

// ═══════════════════════ seat menu ═══════════════════════

export interface SeatMenu {
  el: HTMLElement;
  open(seat: number, name: string, x: number, y: number, muted: boolean): void;
  close(): void;
  dispose(): void;
}

export interface SeatMenuOptions {
  onMute: (seat: number, on: boolean) => void;
  onReact: (seat: number, x: number, y: number) => void;
}

/** Long-pressing an opponent's plate: react at them, or mute them. */
export function createSeatMenu(opts: SeatMenuOptions): SeatMenu {
  const title = h('div', { class: 'sm__title' }, '');
  const reactBtn = h('button', { class: 'sm__row', type: 'button' }, icon('emote', 18), h('span', null, 'Send reaction'));
  const muteBtn = h('button', { class: 'sm__row', type: 'button' }, icon('mute-user', 18), h('span', { class: 'sm__mute-t' }, 'Mute player'));
  const card = h('div', { class: 'sm__card' }, title, reactBtn, muteBtn);
  const el = h('div', { class: 'sm' }, h('i', { class: 'sm__scrim' }), card);

  let seat = -1;
  let muted = false;
  let px = 0;
  let py = 0;

  const close = (): void => {
    cls(el, 'is-open', false);
    seat = -1;
  };

  el.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest('.sm__card')) close();
  });
  reactBtn.addEventListener('click', () => {
    const target = seat;
    close();
    opts.onReact(target, px, py);
  });
  muteBtn.addEventListener('click', () => {
    opts.onMute(seat, !muted);
    close();
  });

  return {
    el,
    open(nextSeat, name, x, y, isMuted): void {
      seat = nextSeat;
      muted = isMuted;
      px = x;
      py = y;
      title.textContent = name;
      (muteBtn.querySelector('.sm__mute-t') as HTMLElement).textContent = isMuted ? 'Unmute player' : 'Mute player';
      const w = 208;
      card.style.transform = `translate3d(${clamp(x - w / 2, 10, window.innerWidth - w - 10).toFixed(1)}px, ${clamp(y + 18, 70, window.innerHeight - 170).toFixed(1)}px, 0)`;
      cls(el, 'is-open', true);
      cue('sheetOpen');
      haptic('select');
    },
    close,
    dispose(): void {
      el.remove();
    },
  };
}
