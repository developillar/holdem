/**
 * Seat nameplates — the DOM half of the table.
 *
 * Each plate is anchored to a 3D seat position published by the renderer and
 * repositioned every frame with `translate3d` only. Plates carry the avatar
 * with its rarity frame, the name, the stack in money *and* big blinds, a
 * draining timer ring, the last action pill, floating win deltas, sit-out /
 * disconnect states and an emote bubble anchor.
 *
 * The layer also guarantees two things the 3D projection cannot: plates never
 * overlap each other, and they never leave the safe viewport.
 */

import { bbCount } from '../../core/stakes.ts';
import type { ReactionKind, SeatState, TableState } from '../../core/types.ts';
import { cardRank, cardSuit, RANKS } from '../../core/types.ts';
import { clamp, cls, h, hash32, onFrame, press, s, setText, Spring } from './dom.ts';
import { reactionGlyph } from './icons.ts';

const RARITY_TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'] as const;
type RarityTier = (typeof RARITY_TIERS)[number];

/** Frame rarity: explicit cosmetic id if the player has one, else earned by level. */
function rarityFor(frameId: string | null, level: number): RarityTier {
  if (frameId) {
    for (const tier of RARITY_TIERS) if (frameId.includes(tier)) return tier;
  }
  if (level >= 60) return 'mythic';
  if (level >= 38) return 'legendary';
  if (level >= 22) return 'epic';
  if (level >= 9) return 'rare';
  return 'common';
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s_.-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic two-stop gradient per player — a procedural avatar. */
function avatarColors(key: string): [string, string] {
  const hv = hash32(key);
  const hue = hv % 360;
  const hue2 = (hue + 26 + ((hv >> 9) % 40)) % 360;
  return [`hsl(${hue} 62% 46%)`, `hsl(${hue2} 58% 24%)`];
}

/** Room reserved under a plate for its last-action pill. */
const PILL_CLEARANCE = 26;
/** Room reserved above a plate for the floating chip delta. */
const TOP_CLEARANCE = 6;

const TIMER_R = 21;
const TIMER_C = 2 * Math.PI * TIMER_R;

export interface PlateContext {
  bb: number;
  /** formats a chip amount for this table (money or tournament chips) */
  fmt: (amount: number) => string;
  muted: boolean;
  showBb: boolean;
}

export interface Nameplate {
  readonly el: HTMLElement;
  readonly seat: number;
  update(seat: SeatState, ctx: PlateContext): void;
  step(dtMs: number): void;
  showDelta(amount: number, fmt: (v: number) => string): void;
  showEmote(kind: ReactionKind): void;
  showChat(text: string): void;
  setMuted(on: boolean): void;
  /** measured size in CSS px, cached between content changes */
  measure(): { w: number; h: number };
  dispose(): void;
}

interface PlateInternals extends Nameplate {
  pos: { x: number; y: number };
  target: { x: number; y: number };
  visible: boolean;
  turn: boolean;
}

function createPlate(seat: number, isHero: boolean): PlateInternals {
  const initialsEl = h('span', { class: 'np__initials' });
  const avatar = h('div', { class: 'np__av' }, initialsEl, h('i', { class: 'np__sheen' }));

  const ringTrack = s('circle', {
    cx: '26', cy: '26', r: String(TIMER_R),
    fill: 'none', stroke: 'rgba(255,255,255,0.10)', 'stroke-width': '3',
  });
  const ringArc = s('circle', {
    cx: '26', cy: '26', r: String(TIMER_R),
    fill: 'none', stroke: 'currentColor', 'stroke-width': '3.4', 'stroke-linecap': 'round',
    'stroke-dasharray': String(TIMER_C), 'stroke-dashoffset': String(TIMER_C),
    transform: 'rotate(-90 26 26)',
  });
  const ring = s('svg', { class: 'np__ring', viewBox: '0 0 52 52', width: '52', height: '52', 'aria-hidden': 'true' }, ringTrack, ringArc);

  const avWrap = h('div', { class: 'np__avwrap' }, h('i', { class: 'np__frame' }), avatar, ring, h('i', { class: 'np__heat' }));

  const nameEl = h('div', { class: 'np__name' }, '—');
  const stackEl = h('div', { class: 'np__stack tnum' }, '');
  const bbEl = h('div', { class: 'np__bb tnum' }, '');
  const stateEl = h('div', { class: 'np__state' }, '');
  const info = h(
    'div',
    { class: 'np__info' },
    nameEl,
    h('div', { class: 'np__row' }, stackEl, bbEl),
    stateEl,
  );

  const card = h('div', { class: 'np__card' }, h('i', { class: 'np__scrim' }), avWrap, info);
  const pill = h('div', { class: 'np__pill' }, '');
  const delta = h('div', { class: 'np__delta tnum' }, '');
  const emote = h('div', { class: 'np__emote' });
  const chat = h('div', { class: 'np__chat' });

  const el = h(
    'div',
    { class: `np${isHero ? ' np--hero' : ''}`, 'data-seat': String(seat) },
    card,
    pill,
    delta,
    emote,
    chat,
  );

  // ── local state
  const scale = new Spring(0.92, 210, 26);
  let clockMs = 0;
  let clockTotal = 0;
  let clocking = false;
  let dirty = true;
  let cached = { w: 118, h: 46 };
  let lastActionSeq = -1;
  let pillTimer = 0;
  let deltaTimer = 0;
  let emoteTimer = 0;
  let chatTimer = 0;
  let muted = false;
  let lastKey = '';
  let empty = true;

  const setClockVisual = (frac: number): void => {
    ringArc.setAttribute('stroke-dashoffset', String((1 - frac) * TIMER_C));
    const urgency = frac < 0.18 ? 'crit' : frac < 0.42 ? 'warn' : 'ok';
    if (el.dataset.urgency !== urgency) el.dataset.urgency = urgency;
  };

  const plate: PlateInternals = {
    el,
    seat,
    pos: { x: -400, y: -400 },
    target: { x: -400, y: -400 },
    visible: false,
    turn: false,

    update(st: SeatState, ctx: PlateContext): void {
      const p = st.player;
      const wasEmpty = empty;
      empty = !p || st.status === 'empty';
      cls(el, 'is-empty', empty);
      if (empty) {
        if (!wasEmpty) dirty = true;
        setText(nameEl, 'Open seat');
        setText(stackEl, '');
        setText(bbEl, '');
        setText(stateEl, '');
        clocking = false;
        setClockVisual(0);
        return;
      }

      const key = `${p!.id}|${p!.name}|${p!.frameId ?? ''}|${p!.level}`;
      if (key !== lastKey) {
        lastKey = key;
        dirty = true;
        setText(nameEl, p!.name);
        setText(initialsEl, initials(p!.name));
        const [c1, c2] = avatarColors(p!.id || p!.name);
        avatar.style.setProperty('--av-a', c1);
        avatar.style.setProperty('--av-b', c2);
        el.dataset.rarity = rarityFor(p!.frameId, p!.level);
      }
      cls(el, 'is-hot', p!.heat >= 0.62);

      const stackText = ctx.fmt(st.stack);
      if (stackEl.textContent !== stackText) {
        dirty = true;
        setText(stackEl, stackText);
      }
      setText(bbEl, ctx.showBb && ctx.bb > 0 ? bbCount(st.stack, ctx.bb) : '');

      // ── status treatments
      const sitting = st.status === 'sitting-out';
      const busted = st.status === 'busted';
      const folded = st.status === 'folded';
      cls(el, 'is-folded', folded);
      cls(el, 'is-out', sitting || busted);
      cls(el, 'is-allin', st.status === 'allin');
      cls(el, 'is-won', st.wonLast);
      const stateText = busted ? 'BUSTED' : sitting ? 'SITTING OUT' : st.sitOutNextHand ? 'OUT NEXT HAND' : '';
      if (stateEl.textContent !== stateText) {
        setText(stateEl, stateText);
        cls(el, 'has-state', stateText !== '');
        dirty = true;
      }

      // ── turn
      if (st.isTurn !== plate.turn) {
        plate.turn = st.isTurn;
        cls(el, 'is-turn', st.isTurn);
        scale.target = st.isTurn ? 1.055 : 1;
        if (st.isTurn) {
          clockTotal = Math.max(1, st.timeBankMs || 25000);
          clockMs = clockTotal;
          clocking = clockTotal > 1;
          setClockVisual(1);
        } else {
          clocking = false;
          setClockVisual(0);
        }
      } else if (st.isTurn && st.timeBankMs > 0 && Math.abs(st.timeBankMs - clockMs) > 900) {
        // resync with the authority when it drifts
        clockMs = st.timeBankMs;
        clockTotal = Math.max(clockTotal, st.timeBankMs);
      }

      // ── last action pill
      const act = st.lastAction;
      if (act && act.seq !== lastActionSeq) {
        lastActionSeq = act.seq;
        const verb =
          act.kind === 'allin' ? 'ALL IN'
          : act.kind === 'raise' ? 'RAISE'
          : act.kind === 'bet' ? 'BET'
          : act.kind === 'call' ? 'CALL'
          : act.kind === 'check' ? 'CHECK'
          : act.kind === 'fold' ? 'FOLD'
          : act.kind === 'post' ? 'POST'
          : 'ANTE';
        const showAmount = act.kind !== 'fold' && act.kind !== 'check' && act.amount > 0;
        setText(pill, showAmount ? `${verb} ${ctx.fmt(act.amount)}` : verb);
        pill.dataset.kind = act.kind;
        cls(pill, 'is-shown', true);
        if (pillTimer) clearTimeout(pillTimer);
        pillTimer = window.setTimeout(() => cls(pill, 'is-shown', false), act.kind === 'fold' ? 1500 : 3200);
      } else if (!act && lastActionSeq !== -1) {
        lastActionSeq = -1;
        cls(pill, 'is-shown', false);
      }
    },

    step(dt: number): void {
      const sc = scale.step(dt);
      if (clocking) {
        clockMs = Math.max(0, clockMs - dt);
        setClockVisual(clockTotal > 0 ? clockMs / clockTotal : 0);
        if (clockMs <= 0) clocking = false;
      }
      const { x, y } = plate.pos;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${sc.toFixed(3)})`;
    },

    showDelta(amount: number, fmt: (v: number) => string): void {
      if (Math.abs(amount) < 1e-9) return;
      setText(delta, `${amount > 0 ? '+' : '−'}${fmt(Math.abs(amount))}`);
      delta.dataset.sign = amount > 0 ? 'up' : 'down';
      delta.classList.remove('is-float');
      void delta.offsetWidth;
      delta.classList.add('is-float');
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = window.setTimeout(() => delta.classList.remove('is-float'), 1500);
    },

    showEmote(kind: ReactionKind): void {
      if (muted) return;
      emote.replaceChildren(h('div', { class: 'np__emote-in' }, reactionGlyph(kind, 34)));
      emote.classList.remove('is-shown');
      void emote.offsetWidth;
      emote.classList.add('is-shown');
      if (emoteTimer) clearTimeout(emoteTimer);
      emoteTimer = window.setTimeout(() => emote.classList.remove('is-shown'), 1800);
    },

    showChat(text: string): void {
      if (muted) return;
      setText(chat, text);
      chat.classList.remove('is-shown');
      void chat.offsetWidth;
      chat.classList.add('is-shown');
      if (chatTimer) clearTimeout(chatTimer);
      chatTimer = window.setTimeout(() => chat.classList.remove('is-shown'), 2600);
    },

    setMuted(on: boolean): void {
      muted = on;
      cls(el, 'is-muted', on);
    },

    measure(): { w: number; h: number } {
      if (dirty) {
        const r = card.getBoundingClientRect();
        if (r.width > 0) cached = { w: r.width, h: r.height };
        dirty = false;
      }
      return cached;
    },

    dispose(): void {
      if (pillTimer) clearTimeout(pillTimer);
      if (deltaTimer) clearTimeout(deltaTimer);
      if (emoteTimer) clearTimeout(emoteTimer);
      if (chatTimer) clearTimeout(chatTimer);
      el.remove();
    },
  };

  return plate;
}

// ═══════════════════════════ layer ═══════════════════════════

export interface AnchorRead {
  x: number;
  y: number;
  visible: boolean;
}

export interface PlateBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ReservedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlateLayerOptions {
  seatCount: number;
  heroSeat: number;
  /** renderer anchor in CSS px, or null to use the fallback ellipse */
  getAnchor: (seat: number) => AnchorRead | null;
  bounds: () => PlateBounds;
  /** an immovable body plates must not cover — the pot readout */
  reserved?: () => ReservedRect | null;
  onLongPress?: (seat: number, el: HTMLElement) => void;
  onTap?: (seat: number, el: HTMLElement) => void;
}

export interface PlateLayer {
  el: HTMLElement;
  sync(state: TableState, ctx: PlateContext): void;
  plate(seat: number): Nameplate | null;
  showDelta(seat: number, amount: number, fmt: (v: number) => string): void;
  emote(seat: number, kind: ReactionKind): void;
  chat(seat: number, text: string): void;
  setMuted(seat: number, on: boolean): void;
  isMuted(seat: number): boolean;
  /** screen position of a seat plate, for flying emotes */
  positionOf(seat: number): { x: number; y: number };
  dispose(): void;
}

/** Fallback seat ring for when the renderer is unavailable. */
function fallbackAnchor(seat: number, count: number, hero: number, b: PlateBounds): AnchorRead {
  const rel = ((seat - hero + count) % count) / count;
  const angle = Math.PI / 2 + rel * Math.PI * 2;
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2 - 6;
  const rx = (b.right - b.left) / 2 - 62;
  const ry = (b.bottom - b.top) / 2 - 30;
  return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, visible: true };
}

export function createPlateLayer(opts: PlateLayerOptions): PlateLayer {
  const el = h('div', { class: 'plates', 'aria-hidden': 'false' });
  const plates: PlateInternals[] = [];
  const muted = new Set<number>();
  const releases: Array<() => void> = [];

  for (let i = 0; i < opts.seatCount; i++) {
    const p = createPlate(i, i === opts.heroSeat);
    plates.push(p);
    el.appendChild(p.el);
    releases.push(
      press(p.el, {
        slop: 22,
        longMs: 320,
        exclusiveLong: true,
        onLongPress: () => opts.onLongPress?.(i, p.el),
        onPress: () => opts.onTap?.(i, p.el),
      }),
    );
  }

  // Collision + clamp resolution, then a single transform write per plate.
  const xs = new Float32Array(opts.seatCount);
  const ys = new Float32Array(opts.seatCount);
  const ws = new Float32Array(opts.seatCount);
  const hs = new Float32Array(opts.seatCount);
  const live: number[] = [];

  const stopFrame = onFrame((dt) => {
    const b = opts.bounds();
    live.length = 0;
    for (let i = 0; i < plates.length; i++) {
      const p = plates[i];
      const a = opts.getAnchor(i) ?? fallbackAnchor(i, plates.length, opts.heroSeat, b);
      const m = p.measure();
      ws[i] = m.w;
      hs[i] = m.h;
      xs[i] = a.x;
      ys[i] = a.y;
      const vis = a.visible !== false;
      if (vis !== p.visible) {
        p.visible = vis;
        cls(p.el, 'is-hidden', !vis);
      }
      if (vis) live.push(i);
    }

    const res = opts.reserved?.() ?? null;
    // Two relaxation passes are enough for nine plates and stay stable.
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < live.length; a++) {
        for (let bIdx = a + 1; bIdx < live.length; bIdx++) {
          const i = live[a];
          const j = live[bIdx];
          const minX = (ws[i] + ws[j]) / 2 + 8;
          const minY = (hs[i] + hs[j]) / 2 + 6;
          const dx = xs[j] - xs[i];
          const dy = ys[j] - ys[i];
          if (Math.abs(dx) >= minX || Math.abs(dy) >= minY) continue;
          const pushX = minX - Math.abs(dx);
          const pushY = minY - Math.abs(dy);
          if (pushX <= pushY) {
            const sgn = dx === 0 ? (i < j ? -1 : 1) : Math.sign(dx);
            xs[i] -= (sgn * pushX) / 2;
            xs[j] += (sgn * pushX) / 2;
          } else {
            const sgn = dy === 0 ? (i < j ? -1 : 1) : Math.sign(dy);
            ys[i] -= (sgn * pushY) / 2;
            ys[j] += (sgn * pushY) / 2;
          }
        }
      }
      if (res) {
        for (const i of live) {
          const minX = (ws[i] + res.w) / 2 + 10;
          const minY = (hs[i] + res.h) / 2 + 8;
          const dx = xs[i] - res.x;
          const dy = ys[i] - res.y;
          if (Math.abs(dx) >= minX || Math.abs(dy) >= minY) continue;
          const pushX = minX - Math.abs(dx);
          const pushY = minY - Math.abs(dy);
          if (pushY <= pushX) ys[i] += (dy === 0 ? 1 : Math.sign(dy)) * pushY;
          else xs[i] += (dx === 0 ? 1 : Math.sign(dx)) * pushX;
        }
      }
      for (const i of live) {
        xs[i] = clamp(xs[i], b.left + ws[i] / 2, b.right - ws[i] / 2);
        // The last-action pill hangs below the card and the win delta floats
        // above it — both have to stay inside the playable band.
        ys[i] = clamp(ys[i], b.top + hs[i] / 2 + TOP_CLEARANCE, b.bottom - hs[i] / 2 - PILL_CLEARANCE);
      }
    }

    for (let i = 0; i < plates.length; i++) {
      const p = plates[i];
      p.target.x = xs[i];
      p.target.y = ys[i];
      // First placement snaps; afterwards the plate eases so a camera move
      // never makes the HUD jitter.
      if (p.pos.x < -300) {
        p.pos.x = p.target.x;
        p.pos.y = p.target.y;
      } else {
        const k = 1 - Math.pow(0.001, dt / 1000);
        p.pos.x += (p.target.x - p.pos.x) * k;
        p.pos.y += (p.target.y - p.pos.y) * k;
      }
      p.step(dt);
    }
  });

  return {
    el,
    sync(state: TableState, ctx: PlateContext): void {
      for (let i = 0; i < plates.length; i++) {
        const st = state.seats[i];
        if (!st) continue;
        plates[i].update(st, ctx);
      }
    },
    plate: (seat: number) => plates[seat] ?? null,
    showDelta(seat, amount, fmt): void {
      plates[seat]?.showDelta(amount, fmt);
    },
    emote(seat, kind): void {
      plates[seat]?.showEmote(kind);
    },
    chat(seat, text): void {
      plates[seat]?.showChat(text);
    },
    setMuted(seat, on): void {
      if (on) muted.add(seat);
      else muted.delete(seat);
      plates[seat]?.setMuted(on);
    },
    isMuted: (seat) => muted.has(seat),
    positionOf(seat): { x: number; y: number } {
      const p = plates[seat];
      return p ? { x: p.pos.x, y: p.pos.y } : { x: 0, y: 0 };
    },
    dispose(): void {
      stopFrame();
      for (const r of releases) r();
      for (const p of plates) p.dispose();
      el.remove();
    },
  };
}

/** Tiny helper shared with the history log. */
export function holeText(cards: readonly number[]): string {
  return cards.map((c) => `${RANKS[cardRank(c) - 2]}${['♣', '♦', '♥', '♠'][cardSuit(c)]}`).join('');
}
