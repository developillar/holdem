/**
 * The action bar — the highest-stakes surface in the app.
 *
 * Everything a player touches while a hand is live lives here: fold / check /
 * call / bet / raise with the amounts inline, a bet sizer with preset chips, a
 * snapping slider with haptic ticks and an exact-amount keypad, pre-actions
 * that arm while it is somebody else's turn and fire the instant the action
 * arrives, and a hold-to-confirm ring on any all-in so nobody ships a stack by
 * accident.
 *
 * Every press emits `ui:haptic` and a synthesised cue.
 */

import type { LegalAction } from '../../core/bus.ts';
import type { ActionKind, Street } from '../../core/types.ts';
import {
  clamp,
  cls,
  cue,
  feedback,
  h,
  haptic,
  onFrame,
  press,
  s,
  setText,
} from './dom.ts';
import { icon } from './icons.ts';

export type PreAction = 'none' | 'check-fold' | 'call-any' | 'check';

export interface ActionBarContext {
  /** chips still owed to call */
  toCall: number;
  pot: number;
  stack: number;
  bb: number;
  street: Street;
}

export interface ActionBarOptions {
  fmt: (v: number) => string;
  /** smallest legal chip increment (0.01 cash, 1 tournament) */
  step: number;
  onAct: (kind: ActionKind, amount: number) => void;
  /** fired whenever the armed pre-action changes, for the caller's chrome */
  onPreAction?: (pre: PreAction) => void;
}

export interface ActionBar {
  el: HTMLElement;
  /** It is the hero's turn: render the legal set and start the clock. */
  setTurn(legal: readonly LegalAction[], timeMs: number, ctx: ActionBarContext): void;
  /** The hero acted, timed out, or the hand moved on. */
  endTurn(): void;
  /** Keeps pot / stack / blind context fresh between turns. */
  setContext(ctx: ActionBarContext): void;
  /** Bar is present but nothing can be done (waiting, sitting out, observing). */
  setIdleMessage(text: string | null): void;
  armedPreAction(): PreAction;
  clearPreAction(): void;
  dispose(): void;
}

const HOLD_MS = 620;

export function createActionBar(opts: ActionBarOptions): ActionBar {
  const { fmt, step } = opts;

  /**
   * Money for a figure the finger is holding.
   *
   * `opts.fmt` is the room's compact formatter: it prints $8.00 as "$8", which
   * is right on a stack pill and wrong on the one number being dragged — the
   * string loses two characters mid-sweep and shoves a centred row sideways.
   * `screens/table.ts` keeps a `cashExact` for exactly this reason but does not
   * export it, so the bar carries its own: same digits, fixed length, grouped
   * thousands, and the caller's own currency mark so tournament chips still
   * read as chips.
   */
  const exactDecimals = step < 1 ? 2 : 0;
  const currencyMark = (/^[^0-9-]*/.exec(fmt(0)) ?? [''])[0];
  const fmtExact = (v: number): string => {
    const fixed = Math.abs(v).toFixed(exactDecimals);
    const cut = exactDecimals > 0 ? fixed.length - exactDecimals - 1 : fixed.length;
    const grouped = fixed.slice(0, cut).replace(/\B(?=(\d{3})+$)/g, ',');
    return `${v < 0 ? '-' : ''}${currencyMark}${grouped}${fixed.slice(cut)}`;
  };

  // ── timer ribbon
  const timerFill = h('i', { class: 'ab__timer-fill' });
  const timer = h('div', { class: 'ab__timer', 'aria-hidden': 'true' }, timerFill);

  // ── sizer: presets
  const presetsEl = h('div', { class: 'ab__presets scroll' });

  // ── sizer: slider
  const ticksEl = h('div', { class: 'ab__ticks', 'aria-hidden': 'true' });
  const fillEl = h('i', { class: 'ab__fill' });
  const thumbEl = h('div', { class: 'ab__thumb' }, h('i', { class: 'ab__knurl' }), h('i', { class: 'ab__knurl' }), h('i', { class: 'ab__knurl' }));
  const trackEl = h('div', { class: 'ab__track' }, h('i', { class: 'ab__groove' }), fillEl, ticksEl, thumbEl);
  const minusBtn = h('button', { class: 'ab__step', type: 'button', 'aria-label': 'Decrease bet' }, icon('minus', 20));
  const plusBtn = h('button', { class: 'ab__step', type: 'button', 'aria-label': 'Increase bet' }, icon('plus', 20));
  const sliderRow = h('div', { class: 'ab__slider-row' }, minusBtn, trackEl, plusBtn);

  // ── sizer: exact amount
  const amountText = h('span', { class: 'ab__amt-v tnum' }, fmtExact(0));
  const amountBb = h('span', { class: 'ab__amt-bb tnum' }, '');
  const amountBtn = h(
    'button',
    { class: 'ab__amount', type: 'button', 'aria-label': 'Type an exact amount' },
    amountText,
    amountBb,
    h('i', { class: 'ab__amt-ic' }, icon('keypad', 15)),
  );

  const sizer = h('div', { class: 'ab__sizer' }, presetsEl, sliderRow, amountBtn);

  // ── pre-actions
  const preDefs: Array<{ id: PreAction; label: string }> = [
    { id: 'check-fold', label: 'Check / Fold' },
    { id: 'call-any', label: 'Call Any' },
    { id: 'check', label: 'Check' },
  ];
  const preButtons = new Map<PreAction, HTMLElement>();
  const preRow = h('div', { class: 'ab__row ab__row--pre' });
  for (const def of preDefs) {
    const box = h('i', { class: 'ab__box' }, icon('check', 14));
    const btn = h('button', { class: 'ab__pre', type: 'button', role: 'checkbox', 'aria-checked': 'false' }, box, h('span', null, def.label));
    preButtons.set(def.id, btn);
    preRow.appendChild(btn);
  }

  // ── main buttons
  const foldLabel = h('span', { class: 'ab__b-t' }, 'Fold');
  const foldBtn = h('button', { class: 'ab__b ab__b--fold', type: 'button' }, h('i', { class: 'ab__b-sheen' }), foldLabel);

  const callTop = h('span', { class: 'ab__b-t' }, 'Check');
  const callSub = h('span', { class: 'ab__b-s tnum' }, '');
  const callBtn = h('button', { class: 'ab__b ab__b--call', type: 'button' }, h('i', { class: 'ab__b-sheen' }), callTop, callSub);

  const raiseTop = h('span', { class: 'ab__b-t' }, 'Raise');
  const raiseSub = h('span', { class: 'ab__b-s tnum' }, '');
  const holdArc = s('circle', {
    cx: '16', cy: '16', r: '13', fill: 'none', stroke: 'currentColor', 'stroke-width': '3',
    'stroke-linecap': 'round', 'stroke-dasharray': String(2 * Math.PI * 13), 'stroke-dashoffset': String(2 * Math.PI * 13),
    transform: 'rotate(-90 16 16)',
  });
  const holdRing = s(
    'svg',
    { class: 'ab__hold-ring', viewBox: '0 0 32 32', width: '30', height: '30', 'aria-hidden': 'true' },
    s('circle', { cx: '16', cy: '16', r: '13', fill: 'none', stroke: 'rgba(0,0,0,0.32)', 'stroke-width': '3' }),
    holdArc,
  );
  const holdSweep = h('i', { class: 'ab__hold-sweep' });
  const raiseBtn = h(
    'button',
    { class: 'ab__b ab__b--raise', type: 'button' },
    holdSweep,
    h('i', { class: 'ab__b-sheen' }),
    h('span', { class: 'ab__b-stack' }, raiseTop, raiseSub),
    holdRing,
  );

  const mainRow = h('div', { class: 'ab__row ab__row--main' }, foldBtn, callBtn, raiseBtn);

  // ── idle message
  const idleEl = h('div', { class: 'ab__idle' }, '');

  // ── keypad
  const kpValue = h('div', { class: 'kp__value tnum' }, '');
  const kpBb = h('div', { class: 'kp__bb tnum' }, '');
  const kpKeys = h('div', { class: 'kp__keys' });
  const kpDone = h('button', { class: 'kp__done', type: 'button' }, 'Set amount');
  const kpQuick = h('div', { class: 'kp__quick' });
  const keypad = h(
    'div',
    { class: 'kp' },
    h('div', { class: 'kp__head' }, h('span', { class: 'kp__title' }, 'Exact amount'), h('div', { class: 'kp__read' }, kpValue, kpBb)),
    kpQuick,
    kpKeys,
    kpDone,
  );
  const kpScrim = h('div', { class: 'kp__scrim' });

  const el = h('div', { class: 'ab' }, timer, kpScrim, keypad, sizer, idleEl, preRow, mainRow);

  // ═══════════════════ state ═══════════════════

  let ctx: ActionBarContext = { toCall: 0, pot: 0, stack: 0, bb: 1, street: 'preflop' };
  let legal: readonly LegalAction[] = [];
  let onTurn = false;
  let sizing = false;
  let amount = 0;
  let minTo = 0;
  let maxTo = 0;
  let raiseKind: ActionKind = 'raise';
  let presets: Array<{ label: string; amount: number }> = [];
  let pre: PreAction = 'none';
  let clockLeft = 0;
  let clockTotal = 0;
  let stopClock: (() => void) | null = null;
  let holding = false;
  let holdT = 0;
  let stopHold: (() => void) | null = null;
  let holdTicks = 0;
  let kpBuffer = '';
  let kpOpen = false;

  // ── slider geometry and drag state
  /** Must match the `.ab__thumb` width in table.css. */
  const THUMB_PX = 30;
  /** Preset magnet radius in track pixels. Deliberately narrower than a
   *  fingertip: it exists to make a preset landable to the exact cent, not to
   *  drag the thumb around. Anything wider and the magnet becomes a flat spot
   *  the finger can feel — which is the bug, not the feature. */
  const LOCK_PX = 3;
  /** How much track every gap between two named sizings wants. */
  const ANCHOR_GAP_PX = 40;
  /**
   * How far a single legal chip may be stretched.
   *
   * Between two nearby sizings there may only be a handful of legal amounts —
   * five cents separate a 2.5x and a 3x open at these stakes — and no curve can
   * put more numbers on the track than the chip grid contains. Past this the
   * value would stand still under a moving finger for longer than the preset
   * magnet already does (2 × LOCK_PX), which is the widest plateau this track
   * is willing to own.
   */
  const MAX_PX_PER_CHIP = 6;

  /** One span of the track between two anchors, shifted-geometric inside. */
  interface CurveSeg {
    t0: number;
    t1: number;
    v0: number;
    v1: number;
    /** v(u) = (v0 + shift)·e^(u·logR) − shift; logR = 0 means linear. */
    shift: number;
    logR: number;
  }

  let trackW = 0;
  let segs: CurveSeg[] = [];
  const presetT: number[] = [];
  let maxPresetIndex = -1;
  let dragLeft = 0;
  let grabOffset = 0;
  let lastPx = -1;
  let snapIndex = -1;
  let dragPointerId = -1;
  /**
   * The all-in hold prompt. In hold mode the raise button gives 40px to the
   * filling ring, which leaves ~85px of label even on a 430pt phone — the old
   * "Hold to confirm" measured 102px and was clipped at every width. The ring
   * and the "All In" title above it carry the rest of the sentence.
   */
  const HOLD_PROMPT = 'Hold';

  const round = (v: number): number => Math.round(v / step) * step;
  const isAllIn = (): boolean => maxTo > 0 && amount >= maxTo - step / 2;
  const legalOf = (kind: ActionKind): LegalAction | undefined => legal.find((l) => l.kind === kind);

  // ═══════════════════ slider maths ═══════════════════

  const travelPx = (): number => Math.max(1, trackW - THUMB_PX);

  /**
   * The gentlest shifted-geometric shape over [v0, v1] whose slope at v0 is
   * still worth at least one chip per pixel:
   *
   *   v(u) = (v0 + k)·R^u − k,   R = (v1 + k)/(v0 + k)
   *
   * k = 0 is the pure geometric curve, k → ∞ is linear, and dv/du at u = 0 is
   * monotone in k, so a bisection finds the smallest k that clears the bar.
   * Used where there is no anchor to hang the span on: with nothing to aim at,
   * resolution wins.
   */
  const solveShift = (v0: number, v1: number, widthPx: number): number => {
    const need = step * Math.max(1, widthPx);
    const slopeAt0 = (k: number): number => {
      const base = v0 + k;
      return base > 0 ? base * Math.log((v1 + k) / base) : 0;
    };
    // Past this offset the curve is linear to within a thousandth and the
    // exponential starts shedding precision, so it doubles as the cap.
    const cap = (v1 - v0) * 1000;
    if (slopeAt0(cap) < need) return cap; // range too tight to curve at all
    if (slopeAt0(0) >= need) return 0;
    let lo = 0;
    let hi = cap;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (slopeAt0(mid) < need) lo = mid;
      else hi = mid;
    }
    return hi;
  };

  const makeSeg = (t0: number, t1: number, v0: number, v1: number, shift: number): CurveSeg => {
    const base = v0 + shift;
    const r = base > 0 ? Math.log((v1 + shift) / base) : 0;
    return { t0, t1, v0, v1, shift, logR: Number.isFinite(r) && r > 1e-9 ? r : 0 };
  };

  /**
   * The track curve, built against the presets.
   *
   * A slider is only as good as the sizes a thumb can actually land on, and
   * the sizes that matter are the ones the room already names: ⅓ pot, ½ pot,
   * ¾ pot, pot. A single curve fitted to the whole range — linear or geometric
   * — packs all four into the first few percent of the track the moment a deep
   * stack is behind them, and no amount of tuning fixes that, because the
   * problem is the *shape*, not its parameters.
   *
   * So the presets are the ruler. Every gap between two named sizings gets its
   * own span of track, asking for `ANCHOR_GAP_PX` and settling for whatever the
   * chip grid can honestly fill; inside a span the value runs geometrically, so
   * the curve is continuous and monotone with no kink to see. Whatever is left
   * over goes to the overbet tail, which is the only part of the range that can
   * afford to be coarse.
   */
  const buildCurve = (): void => {
    segs = [];
    if (maxTo <= minTo) return;
    const travel = travelPx();

    // ── anchors: the minimum, every preset strictly inside the range, the max
    const vals: number[] = [minTo];
    const sorted = presets.map((p) => p.amount).sort((a, b) => a - b);
    for (const a of sorted) {
      if (a <= minTo + step / 2 || a >= maxTo - step / 2) continue;
      if (a <= vals[vals.length - 1] + step / 2) continue;
      vals.push(a);
    }
    vals.push(maxTo);
    const n = vals.length - 1;
    if (n < 2) {
      segs = [makeSeg(0, 1, minTo, maxTo, solveShift(minTo, maxTo, travel))];
      return;
    }

    // ── how much track each span wants
    const shift0 = minTo > 0 ? 0 : step;
    const nat: number[] = [];
    let natSum = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.log((vals[i + 1] + shift0) / (vals[i] + shift0));
      nat.push(w);
      natSum += w;
    }
    // Half an even share, half the span's own geometric weight: even alone
    // hands a five-cent gap the same room as the entire overbet range, weight
    // alone starves it. Then floors and caps have the final say.
    const floor = Math.min(ANCHOR_GAP_PX, travel / (n + 1));
    const caps: number[] = [];
    const w: number[] = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const cap = Math.max(1, (MAX_PX_PER_CHIP * (vals[i + 1] - vals[i])) / step);
      const share = natSum > 0 ? nat[i] / natSum : 1 / n;
      const raw = travel * (0.5 / n + 0.5 * share);
      caps.push(cap);
      w.push(Math.min(Math.max(raw, Math.min(floor, cap)), cap));
      sum += w[i];
    }
    // Spare track goes to whatever still has room, by geometric weight — in
    // practice the tail above pot, which is where the coarseness belongs.
    for (let pass = 0; pass < 8 && travel - sum > 0.05; pass++) {
      let room = 0;
      for (let i = 0; i < n; i++) if (caps[i] - w[i] > 1e-9) room += nat[i] + 1e-6;
      if (room <= 0) break;
      const spare = travel - sum;
      for (let i = 0; i < n; i++) {
        if (caps[i] - w[i] <= 1e-9) continue;
        const give = Math.min(caps[i] - w[i], (spare * (nat[i] + 1e-6)) / room);
        w[i] += give;
        sum += give;
      }
    }
    // Every span capped (a range with fewer chips in it than the track has
    // pixels) or floors that overran the track: scale the whole ruler to fit.
    if (sum > 0 && Math.abs(sum - travel) > 0.05) {
      const scale = travel / sum;
      for (let i = 0; i < n; i++) w[i] *= scale;
    }

    let t = 0;
    for (let i = 0; i < n; i++) {
      const next = i === n - 1 ? 1 : clamp(t + w[i] / travel, 0, 1);
      segs.push(makeSeg(t, Math.max(next, t + 1e-6), vals[i], vals[i + 1], shift0));
      t = next;
    }
  };

  const segAtV = (v: number): CurveSeg | null => {
    for (let i = 0; i < segs.length; i++) {
      if (v <= segs[i].v1 || i === segs.length - 1) return segs[i];
    }
    return null;
  };

  const segAtT = (t: number): CurveSeg | null => {
    for (let i = 0; i < segs.length; i++) {
      if (t <= segs[i].t1 || i === segs.length - 1) return segs[i];
    }
    return null;
  };

  const toT = (v: number): number => {
    const c = clamp(v, minTo, maxTo);
    const sg = segAtV(c);
    if (!sg) return 0;
    const span = sg.t1 - sg.t0;
    if (sg.logR <= 0) {
      const d = sg.v1 - sg.v0;
      return clamp(sg.t0 + (d > 0 ? ((c - sg.v0) / d) * span : 0), 0, 1);
    }
    return clamp(sg.t0 + (Math.log((c + sg.shift) / (sg.v0 + sg.shift)) / sg.logR) * span, 0, 1);
  };

  const fromT = (t: number): number => {
    const c = clamp(t, 0, 1);
    const sg = segAtT(c);
    if (!sg) return minTo;
    const span = sg.t1 - sg.t0;
    const u = span > 0 ? clamp((c - sg.t0) / span, 0, 1) : 0;
    if (sg.logR <= 0) return sg.v0 + (sg.v1 - sg.v0) * u;
    return (sg.v0 + sg.shift) * Math.exp(u * sg.logR) - sg.shift;
  };

  /** What one pixel of travel is worth, in money, at `v`. */
  const slopePerPx = (v: number): number => {
    const c = clamp(v, minTo, maxTo);
    const sg = segAtV(c);
    if (!sg) return step;
    const px = (sg.t1 - sg.t0) * travelPx();
    if (px <= 0) return step;
    if (sg.logR <= 0) return Math.max(0, sg.v1 - sg.v0) / px;
    return ((c + sg.shift) * sg.logR) / px;
  };

  /** Largest 1–2–5 multiple of the chip step that still fits inside `span`. */
  const niceUnits = (span: number): number => {
    const units = span / step;
    if (!(units > 1)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(units)));
    let best = mag;
    if (2 * mag <= units) best = 2 * mag;
    if (5 * mag <= units) best = 5 * mag;
    return Math.max(1, Math.round(best));
  };

  /**
   * Quantise a dragged value. The increment follows the curve's local slope —
   * cents down at the minimum, dimes at the top of a deep stack — and is never
   * coarser than one pixel of travel, so the number moves as often as the chip
   * grid allows and never in a jump the finger did not ask for. Where a span
   * holds fewer legal amounts than it has pixels the grid wins: nothing can
   * invent a bet size between two adjacent cents, which is why `buildCurve`
   * refuses to stretch a span past `MAX_PX_PER_CHIP` in the first place.
   */
  const quantiseDrag = (v: number): number => {
    const incU = niceUnits(slopePerPx(v));
    const inc = incU * step;
    const q = Math.round(Math.round(v / step) / incU) * inc;
    // Both ends are values a player has to be able to land on exactly.
    if (q >= maxTo - inc / 2) return maxTo;
    if (q <= minTo + inc / 2) return minTo;
    return q;
  };

  /** Preset positions along the track, plus the tick marks that show them. */
  const buildTicks = (): void => {
    presetT.length = 0;
    maxPresetIndex = -1;
    ticksEl.replaceChildren();
    for (let i = 0; i < presets.length; i++) {
      presetT.push(toT(presets[i].amount));
      if (presets[i].amount >= maxTo - step / 2) maxPresetIndex = i;
    }
    if (maxTo <= minTo) return;
    for (let i = 0; i < presets.length; i++) {
      // Either end stop carries its own affordance; a tick there is just a
      // second line drawn on the track's own edge. A preset that clamped down
      // onto the minimum — ⅓ pot in a tiny pot — lands on the left one.
      if (i === maxPresetIndex || presetT[i] <= 0.0005) continue;
      const tick = h('i', { class: 'ab__tick' });
      tick.style.left = `${(presetT[i] * 100).toFixed(2)}%`;
      ticksEl.appendChild(tick);
    }
  };

  /**
   * `width` lets a gesture hand in the rect it already measured: the drag and
   * the paint must agree on the travel to the pixel, and reading the layout a
   * second time is both a forced reflow and a chance for them to disagree.
   */
  const measureTrack = (force = false, width?: number): void => {
    const next = width && width > 1 ? width : trackEl.clientWidth || trackW || 260;
    if (!force && Math.abs(next - trackW) < 0.5) return;
    trackW = next;
    buildCurve();
    buildTicks();
  };

  const paintSlider = (): void => {
    if (trackW === 0) measureTrack(true);
    const t = toT(amount);
    thumbEl.style.transform = `translate3d(${(t * travelPx()).toFixed(2)}px, 0, 0)`;
    fillEl.style.transform = `scaleX(${t.toFixed(4)})`;
    cls(trackEl, 'is-max', isAllIn());
  };

  const paintAmount = (): void => {
    setText(amountText, fmtExact(amount));
    // One decimal at every size: `toFixed(0)` above 100bb shortens the string
    // as the number grows, which is a jitter in the opposite direction.
    setText(amountBb, ctx.bb > 0 ? `${(amount / ctx.bb).toFixed(1)} bb` : '');
    const aggressive = legalOf('raise') ?? legalOf('bet');
    const allIn = isAllIn();
    if (aggressive) {
      const verb = aggressive.kind === 'bet' ? 'Bet' : 'Raise';
      setText(raiseTop, allIn ? 'All In' : sizing ? `${verb} to` : verb);
      setText(raiseSub, allIn ? (sizing ? HOLD_PROMPT : fmtExact(amount)) : fmtExact(amount));
    } else if (legalOf('allin')) {
      setText(raiseTop, 'All In');
      setText(raiseSub, sizing ? HOLD_PROMPT : fmtExact(amount));
    }
    cls(raiseBtn, 'is-allin', allIn);
    cls(raiseBtn, 'is-hold', sizing && allIn);
    for (const [chip, value] of presetChips) {
      cls(chip, 'is-active', Math.abs(value - amount) < step / 2);
    }
  };

  const setAmount = (v: number): void => {
    const next = clamp(round(v), minTo, maxTo);
    if (Math.abs(next - amount) >= step / 4) {
      amount = next;
      paintAmount();
    }
    paintSlider();
  };

  // ═══════════════════ presets ═══════════════════

  const presetChips = new Map<HTMLElement, number>();

  const buildPresets = (): void => {
    presetChips.clear();
    presetsEl.replaceChildren();
    for (const p of presets) {
      const chip = h('button', { class: 'ab__chip', type: 'button' }, h('span', null, p.label));
      presetChips.set(chip, p.amount);
      press(chip, {
        haptic: 'select',
        sfx: 'chipClick',
        onPress: () => {
          setAmount(p.amount);
          snapIndex = presets.indexOf(p);
        },
      });
      presetsEl.appendChild(chip);
    }
  };

  // ═══════════════════ slider interaction ═══════════════════

  /** Nearest magnetised preset to a track position, or -1. */
  const nearestPreset = (px: number, travel: number): number => {
    let idx = -1;
    let best = LOCK_PX;
    for (let i = 0; i < presetT.length; i++) {
      if (i === maxPresetIndex) continue; // all-in is deliberate, never magnetic
      const d = Math.abs(px - presetT[i] * travel);
      if (d <= best) {
        best = d;
        idx = i;
      }
    }
    return idx;
  };

  /**
   * Drive the slider from a pointer position.
   *
   * The track is measured once per gesture, not once per move: the geometry
   * cannot change mid-drag, and re-reading it on every pointermove is both a
   * forced layout and a way for the thumb to disagree with the paint.
   */
  const applyDrag = (clientX: number, silent = false): void => {
    if (dragPointerId === -1 || !sizing) return;
    const travel = travelPx();
    const px = clamp(clientX - grabOffset - dragLeft - THUMB_PX / 2, 0, travel);
    let value = quantiseDrag(fromT(px / travel));

    // Detents: a tick as the finger crosses a preset, and a LOCK_PX magnet so
    // a deliberate landing is exact to the cent. The tick fires on the
    // crossing, not on the magnet, so a fast drag still counts off the presets
    // it flies past.
    let crossed = false;
    for (let i = 0; i < presetT.length; i++) {
      if (i === maxPresetIndex) continue;
      const p = presetT[i] * travel;
      if (lastPx >= 0 && (lastPx < p) !== (px < p)) crossed = true;
    }
    const lock = nearestPreset(px, travel);
    if (lock >= 0) value = presets[lock].amount;
    if (silent) {
      snapIndex = lock;
    } else if (lock !== snapIndex) {
      snapIndex = lock;
      if (lock >= 0) {
        haptic('tick');
        cue('chipClick', 0, 0.5);
      }
    } else if (crossed && lock < 0) {
      haptic('tick');
      cue('chipClick', 0, 0.42);
    }
    lastPx = px;
    setAmount(value);
  };

  /**
   * Tear a gesture down from the outside.
   *
   * A hand can end with a finger still on the track: the clock expires, the
   * engine acts for us, `setTurn` rebuilds min/max under a live sweep and every
   * further pointermove writes a bet into a hand that is already over. Dropping
   * the class is not enough — the pointer is *captured*, so the moves keep
   * arriving here no matter where the finger goes. Release the capture and
   * cancel the press so the helper forgets the pointer too.
   */
  const cancelDrag = (): void => {
    cls(trackEl, 'is-dragging', false);
    grabOffset = 0;
    lastPx = -1;
    snapIndex = -1;
    if (dragPointerId === -1) return;
    const id = dragPointerId;
    dragPointerId = -1;
    try {
      if (trackEl.hasPointerCapture(id)) trackEl.releasePointerCapture(id);
    } catch {
      /* the platform may have released it already */
    }
    try {
      trackEl.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id }));
    } catch {
      /* synthetic events are best-effort; the guard above already stopped it */
    }
  };

  press(trackEl, {
    slop: 10000,
    haptic: 'tick',
    sfx: 'chipClick',
    onDown: (e) => {
      dragPointerId = e.pointerId;
      cls(trackEl, 'is-dragging', true);
      const rect = trackEl.getBoundingClientRect();
      dragLeft = rect.left;
      measureTrack(false, rect.width);
      const travel = travelPx();
      const centre = dragLeft + THUMB_PX / 2 + toT(amount) * travel;
      const off = e.clientX - centre;
      // Grabbing the thumb picks it up exactly where it sits — the value must
      // not move a cent. Pressing bare track jumps to the press. That split is
      // what every native slider does, and it is what stops the "it teleported
      // the moment I touched it" feeling.
      const onThumb = Math.abs(off) <= THUMB_PX / 2;
      grabOffset = onThumb ? off : 0;
      if (onThumb) {
        lastPx = toT(amount) * travel;
        snapIndex = nearestPreset(lastPx, travel);
        paintSlider();
      } else {
        lastPx = -1;
        applyDrag(e.clientX, true);
      }
    },
    onMove: (e) => applyDrag(e.clientX),
    onUp: () => {
      // A gesture that was cancelled from the outside has already been torn
      // down, and its lift is not a landing worth a sound.
      if (dragPointerId === -1) return;
      dragPointerId = -1;
      cls(trackEl, 'is-dragging', false);
      grabOffset = 0;
      lastPx = -1;
      cue('chipStack', 2, 0, 0.5);
    },
  });

  const nudge = (dir: number): void => {
    // The buttons speak the track's language: at least half a blind, and never
    // finer than the increment the track itself is quantising to, so a tap
    // always moves both the number and the thumb.
    const bbStep = ctx.bb > 0 ? Math.max(step, round(ctx.bb / 2)) : step;
    const trackStep = niceUnits(slopePerPx(amount)) * step;
    setAmount(amount + dir * Math.max(bbStep, trackStep));
    haptic('tick');
    cue('chipClick', 0, 0.4);
  };
  press(minusBtn, { onPress: () => nudge(-1) });
  press(plusBtn, { onPress: () => nudge(1) });

  // ═══════════════════ keypad ═══════════════════

  const kpRefresh = (): void => {
    const v = kpBuffer === '' ? 0 : Number(kpBuffer);
    setText(kpValue, kpBuffer === '' ? fmtExact(amount) : `${kpBuffer}`);
    setText(kpBb, ctx.bb > 0 ? `${((kpBuffer === '' ? amount : v) / ctx.bb).toFixed(1)} bb` : '');
    const valid = kpBuffer === '' || (v >= minTo - 1e-9 && v <= maxTo + 1e-9);
    cls(kpValue, 'is-bad', !valid);
    cls(kpDone, 'is-disabled', !valid);
  };

  const openKeypad = (): void => {
    if (kpOpen) return;
    kpOpen = true;
    kpBuffer = '';
    kpRefresh();
    cls(el, 'kp-open', true);
    cue('sheetOpen');
    haptic('select');
  };

  const closeKeypad = (commit: boolean): void => {
    if (!kpOpen) return;
    kpOpen = false;
    cls(el, 'kp-open', false);
    if (commit && kpBuffer !== '') {
      const v = Number(kpBuffer);
      if (Number.isFinite(v)) {
        setAmount(v);
        snapIndex = -1;
      }
    }
    cue('sheetClose');
  };

  const kpKey = (label: string, action: () => void, cssName = ''): HTMLElement => {
    const b = h('button', { class: `kp__k ${cssName}`, type: 'button' }, label);
    press(b, { haptic: 'tick', sfx: 'tapSecondary', onPress: action });
    return b;
  };

  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    kpKeys.appendChild(kpKey(d, () => {
      if (kpBuffer.length < 9) kpBuffer += d;
      kpRefresh();
    }));
  }
  kpKeys.appendChild(kpKey('.', () => {
    if (step < 1 && !kpBuffer.includes('.')) kpBuffer = (kpBuffer === '' ? '0' : kpBuffer) + '.';
    kpRefresh();
  }));
  kpKeys.appendChild(kpKey('0', () => {
    if (kpBuffer.length < 9 && kpBuffer !== '0') kpBuffer += '0';
    kpRefresh();
  }));
  const backKey = h('button', { class: 'kp__k kp__k--back', type: 'button' }, icon('backspace', 20));
  press(backKey, {
    haptic: 'tick',
    sfx: 'tapSecondary',
    onPress: () => {
      kpBuffer = kpBuffer.slice(0, -1);
      kpRefresh();
    },
  });
  kpKeys.appendChild(backKey);

  for (const q of [
    { label: 'Min', get: (): number => minTo },
    { label: 'Pot', get: (): number => clamp(round(ctx.pot + ctx.toCall * 2), minTo, maxTo) },
    { label: 'Max', get: (): number => maxTo },
  ]) {
    const b = h('button', { class: 'kp__q', type: 'button' }, q.label);
    press(b, {
      haptic: 'select',
      sfx: 'chipClick',
      onPress: () => {
        kpBuffer = String(round(q.get()));
        kpRefresh();
      },
    });
    kpQuick.appendChild(b);
  }

  press(amountBtn, { haptic: 'select', sfx: 'tapSecondary', onPress: openKeypad });
  press(kpDone, { haptic: 'select', sfx: 'tapPrimary', onPress: () => closeKeypad(true) });
  press(kpScrim, { onPress: () => closeKeypad(false) });

  // ═══════════════════ pre-actions ═══════════════════

  const paintPre = (): void => {
    for (const [id, btn] of preButtons) {
      const on = pre === id;
      cls(btn, 'is-on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };

  const setPre = (next: PreAction): void => {
    pre = pre === next ? 'none' : next;
    paintPre();
    feedback(pre === 'none' ? 'tick' : 'select', pre === 'none' ? 'tapSecondary' : 'tapToggle', 1);
    opts.onPreAction?.(pre);
  };

  for (const def of preDefs) {
    const btn = preButtons.get(def.id)!;
    press(btn, { onPress: () => setPre(def.id) });
  }

  // ═══════════════════ commit ═══════════════════

  const fire = (kind: ActionKind, value: number): void => {
    if (!onTurn) return;
    onTurn = false;
    collapseSizer();
    stopClockLoop();
    cls(el, 'is-turn', false);
    if (kind === 'fold') feedback('fold', 'fold');
    else if (kind === 'check') feedback('tick', 'check');
    else if (kind === 'allin') feedback('big-win', 'allIn');
    else feedback('bet', kind === 'call' ? 'chipsToPot' : 'betConfirm', 0.5);
    opts.onAct(kind, value);
  };

  const collapseSizer = (): void => {
    cancelDrag();
    if (!sizing) return;
    sizing = false;
    cls(el, 'is-sizing', false);
    cls(raiseBtn, 'is-hold', false);
  };

  const expandSizer = (): void => {
    if (sizing) return;
    sizing = true;
    cls(el, 'is-sizing', true);
    // Forced: the all-in fallback below rewrites min/max without a new turn,
    // and the curve is solved from those.
    measureTrack(true);
    paintSlider();
    paintAmount();
    cue('sheetOpen');
  };

  // ── hold-to-confirm on all-in
  const holdCircumference = 2 * Math.PI * 13;
  const resetHold = (): void => {
    holding = false;
    holdT = 0;
    holdTicks = 0;
    holdArc.setAttribute('stroke-dashoffset', String(holdCircumference));
    holdSweep.style.transform = 'scaleX(0)';
    cls(raiseBtn, 'is-holding', false);
    if (stopHold) {
      stopHold();
      stopHold = null;
    }
  };

  const beginHold = (): void => {
    if (holding) return;
    holding = true;
    holdT = 0;
    holdTicks = 0;
    cls(raiseBtn, 'is-holding', true);
    haptic('select');
    cue('chipStack', 3, 0, 0.7);
    stopHold = onFrame((dt) => {
      holdT = Math.min(1, holdT + dt / HOLD_MS);
      holdArc.setAttribute('stroke-dashoffset', String(holdCircumference * (1 - holdT)));
      holdSweep.style.transform = `scaleX(${holdT.toFixed(3)})`;
      const ticksDue = Math.floor(holdT * 4);
      if (ticksDue > holdTicks) {
        holdTicks = ticksDue;
        haptic('tick');
        cue('chipClick', 0, 0.35 + holdT * 0.5);
      }
      if (holdT >= 1) {
        const value = amount;
        resetHold();
        fire(maxTo > 0 && value >= maxTo - step / 2 ? 'allin' : raiseKind, value);
      }
    });
  };

  const cancelHold = (): void => {
    if (!holding) return;
    const wasComplete = holdT >= 1;
    resetHold();
    if (!wasComplete) {
      haptic('error');
      cue('tapError');
    }
  };

  press(foldBtn, {
    haptic: 'tick',
    onPress: () => {
      if (!legalOf('fold')) return;
      fire('fold', 0);
    },
  });

  press(callBtn, {
    haptic: 'tick',
    onPress: () => {
      const check = legalOf('check');
      if (check) {
        fire('check', check.max);
        return;
      }
      const call = legalOf('call');
      if (call) fire('call', call.max);
    },
  });

  press(raiseBtn, {
    slop: 24,
    onDown: () => {
      if (!onTurn) return;
      if (sizing && isAllIn()) beginHold();
    },
    onUp: (_e, completed) => {
      if (holding) {
        cancelHold();
        return;
      }
      if (!completed) return;
    },
    onPress: () => {
      if (!onTurn) return;
      const raise = legalOf('raise') ?? legalOf('bet');
      if (!raise) {
        const allin = legalOf('allin');
        if (allin) {
          // No sizing room: the only aggressive line is all-in, so make the
          // button itself the hold target.
          amount = allin.max;
          maxTo = allin.max;
          minTo = allin.max;
          expandSizer();
          paintAmount();
        }
        return;
      }
      if (!sizing) {
        expandSizer();
        haptic('select');
        return;
      }
      if (isAllIn()) return; // handled by hold
      fire(raiseKind, amount);
    },
  });

  // A rotation or a keyboard resize changes the track's width, and every
  // position on it is derived from that width — so the curve is re-solved and
  // the ticks re-laid the moment it moves.
  const onViewportResize = (): void => {
    measureTrack();
    paintSlider();
  };
  window.addEventListener('resize', onViewportResize, { passive: true });

  // ═══════════════════ clock ═══════════════════

  const stopClockLoop = (): void => {
    if (stopClock) {
      stopClock();
      stopClock = null;
    }
    timerFill.style.transform = 'scaleX(0)';
    el.dataset.urgency = 'ok';
  };

  const startClock = (ms: number): void => {
    stopClockLoop();
    if (ms <= 0) return;
    clockTotal = ms;
    clockLeft = ms;
    let warned = 0;
    stopClock = onFrame((dt) => {
      clockLeft = Math.max(0, clockLeft - dt);
      const frac = clockTotal > 0 ? clockLeft / clockTotal : 0;
      timerFill.style.transform = `scaleX(${frac.toFixed(4)})`;
      const urgency = frac < 0.18 ? 'crit' : frac < 0.42 ? 'warn' : 'ok';
      if (el.dataset.urgency !== urgency) {
        el.dataset.urgency = urgency;
        if (urgency !== 'ok') haptic('tick');
      }
      if (frac < 0.34) {
        const beat = Math.floor((clockTotal - clockLeft) / 900);
        if (beat > warned) {
          warned = beat;
          cue('timerTick', 1 - frac);
        }
      }
      if (clockLeft <= 0) stopClockLoop();
    });
  };

  // ═══════════════════ render ═══════════════════

  const paintButtons = (): void => {
    const fold = legalOf('fold');
    const check = legalOf('check');
    const call = legalOf('call');
    const raise = legalOf('raise') ?? legalOf('bet');
    const allin = legalOf('allin');

    cls(foldBtn, 'is-disabled', !fold);
    setText(foldLabel, 'Fold');

    if (check) {
      setText(callTop, 'Check');
      setText(callSub, '');
      cls(callBtn, 'is-check', true);
    } else if (call) {
      setText(callTop, ctx.toCall >= ctx.stack ? 'Call All In' : 'Call');
      // Same formatter as the raise beside it: "$8" next to "$8.60" in one row
      // reads as two different currencies.
      setText(callSub, fmtExact(ctx.toCall));
      cls(callBtn, 'is-check', false);
    }
    cls(callBtn, 'is-disabled', !check && !call);

    if (raise) {
      raiseKind = raise.kind;
      setText(raiseTop, raise.kind === 'bet' ? 'Bet' : 'Raise');
      cls(raiseBtn, 'is-disabled', false);
    } else if (allin) {
      raiseKind = 'allin';
      setText(raiseTop, 'All In');
      cls(raiseBtn, 'is-disabled', false);
    } else {
      setText(raiseTop, 'Raise');
      setText(raiseSub, '');
      cls(raiseBtn, 'is-disabled', true);
    }
    cls(el, 'can-size', !!raise);
  };

  return {
    el,

    setTurn(nextLegal, timeMs, nextCtx): void {
      legal = nextLegal;
      ctx = nextCtx;
      onTurn = true;
      resetHold();
      cls(el, 'is-turn', true);
      cls(el, 'is-idle', false);

      const raise = legalOf('raise') ?? legalOf('bet');
      const allin = legalOf('allin');
      if (raise) {
        minTo = raise.min;
        maxTo = raise.max;
        presets = (raise.presets ?? []).filter((p) => p.amount >= minTo - 1e-9 && p.amount <= maxTo + 1e-9);
        if (presets.length === 0) {
          presets = [
            { label: 'Min', amount: minTo },
            { label: '½ Pot', amount: clamp(round(ctx.pot / 2 + ctx.toCall), minTo, maxTo) },
            { label: 'Pot', amount: clamp(round(ctx.pot + ctx.toCall * 2), minTo, maxTo) },
            { label: 'All in', amount: maxTo },
          ];
        }
        // Default to the most standard sizing available, never the minimum.
        const preferred = presets.find((p) => /½|1\/2|3x/i.test(p.label)) ?? presets[Math.min(1, presets.length - 1)];
        amount = clamp(round(preferred?.amount ?? minTo), minTo, maxTo);
      } else if (allin) {
        minTo = allin.min;
        maxTo = allin.max;
        amount = allin.max;
        presets = [{ label: 'All in', amount: allin.max }];
      } else {
        minTo = 0;
        maxTo = 0;
        amount = 0;
        presets = [];
      }

      // A new turn never inherits a live gesture from the last one.
      cancelDrag();
      buildPresets();
      // Solve the curve and lay the ticks out before anything reads `toT`.
      measureTrack(true);
      paintButtons();
      paintAmount();
      paintSlider();
      startClock(timeMs);
      feedback('select', 'yourTurn');

      // Armed pre-action fires as soon as the action lands on us.
      if (pre !== 'none') {
        const armed = pre;
        pre = 'none';
        paintPre();
        opts.onPreAction?.('none');
        window.setTimeout(() => {
          if (!onTurn) return;
          if (armed === 'call-any') {
            const call = legalOf('call');
            const check = legalOf('check');
            if (call) fire('call', call.max);
            else if (check) fire('check', check.max);
          } else if (armed === 'check') {
            const check = legalOf('check');
            if (check) fire('check', check.max);
          } else if (armed === 'check-fold') {
            const check = legalOf('check');
            if (check) fire('check', check.max);
            else fire('fold', 0);
          }
        }, 220);
      }
    },

    endTurn(): void {
      onTurn = false;
      legal = [];
      resetHold();
      collapseSizer();
      stopClockLoop();
      cls(el, 'is-turn', false);
      closeKeypad(false);
    },

    setContext(next): void {
      ctx = next;
      if (!onTurn) paintAmount();
    },

    setIdleMessage(text): void {
      setText(idleEl, text ?? '');
      cls(el, 'is-idle', text !== null);
    },

    armedPreAction: () => pre,

    clearPreAction(): void {
      if (pre === 'none') return;
      pre = 'none';
      paintPre();
      opts.onPreAction?.('none');
    },

    dispose(): void {
      stopClockLoop();
      resetHold();
      window.removeEventListener('resize', onViewportResize);
      el.remove();
    },
  };
}
