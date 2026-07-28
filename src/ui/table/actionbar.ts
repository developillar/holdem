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
  const amountText = h('span', { class: 'ab__amt-v tnum' }, fmt(0));
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
  let trackW = 0;
  let curveK = 0;
  let curveBase = 1;
  let curveLogR = 0;
  let curveLinear = true;
  const presetT: number[] = [];
  let maxPresetIndex = -1;
  let dragLeft = 0;
  let dragW = 0;
  let grabOffset = 0;
  let lastPx = -1;
  let snapIndex = -1;
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
   * The track curve.
   *
   * A linear slider buries every sensible bet in the first fifth of the track
   * once a deep stack is behind it, so this one is geometric — but a *pure*
   * geometric curve collapses the bottom of the range: 500bb deep, six pixels
   * of travel above the minimum are worth less than one legal chip, so the
   * number sticks while the finger keeps moving. What is solved here is the
   * most geometric shifted-log curve whose slope at the minimum is still at
   * least one chip per pixel: the shape the range wants, with no flat spot
   * anywhere for the thumb to fall into.
   *
   *   v(t) = (min + k)·R^t − k,   R = (max + k)/(min + k)
   *
   * k = 0 is the pure geometric curve, k → ∞ is linear, and dv/dt at t = 0 is
   * monotone in k — so a bisection finds the smallest k that clears the bar.
   */
  const solveCurve = (): void => {
    curveK = 0;
    curveBase = Math.max(minTo, 1e-9);
    curveLogR = 0;
    curveLinear = true;
    if (maxTo <= minTo) return;

    const slopeAt0 = (k: number): number => {
      const base = minTo + k;
      return base > 0 ? base * Math.log((maxTo + k) / base) : 0;
    };
    const need = step * travelPx();
    // Past this offset the curve is linear to within a thousandth and the
    // exponential starts shedding precision, so it doubles as the cap.
    const cap = (maxTo - minTo) * 1000;
    if (slopeAt0(cap) < need) return; // range too tight to curve at all

    let k = 0;
    if (slopeAt0(0) < need) {
      let lo = 0;
      let hi = cap;
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        if (slopeAt0(mid) < need) lo = mid;
        else hi = mid;
      }
      k = hi;
    }
    const base = minTo + k;
    const logR = base > 0 ? Math.log((maxTo + k) / base) : 0;
    if (!(logR > 1e-9) || !Number.isFinite(logR)) return;
    curveK = k;
    curveBase = base;
    curveLogR = logR;
    curveLinear = false;
  };

  const toT = (v: number): number => {
    if (maxTo <= minTo) return 0;
    if (curveLinear) return clamp((v - minTo) / (maxTo - minTo), 0, 1);
    return clamp(Math.log((clamp(v, minTo, maxTo) + curveK) / curveBase) / curveLogR, 0, 1);
  };

  const fromT = (t: number): number => {
    if (maxTo <= minTo) return minTo;
    const c = clamp(t, 0, 1);
    if (curveLinear) return minTo + c * (maxTo - minTo);
    return curveBase * Math.exp(c * curveLogR) - curveK;
  };

  /** What one pixel of travel is worth, in money, at `v`. */
  const slopePerPx = (v: number): number => {
    if (maxTo <= minTo) return step;
    if (curveLinear) return (maxTo - minTo) / travelPx();
    return ((clamp(v, minTo, maxTo) + curveK) * curveLogR) / travelPx();
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
   * coarser than one pixel of travel, so every pixel changes the number.
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
      // All-in sits on the end stop and carries its own affordance; a tick
      // there is just a second line drawn on the track's own edge.
      if (i === maxPresetIndex) continue;
      const tick = h('i', { class: 'ab__tick' });
      tick.style.left = `${(presetT[i] * 100).toFixed(2)}%`;
      ticksEl.appendChild(tick);
    }
  };

  const measureTrack = (force = false): void => {
    const next = trackEl.clientWidth || trackW || 260;
    if (!force && Math.abs(next - trackW) < 0.5) return;
    trackW = next;
    solveCurve();
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
    setText(amountText, fmt(amount));
    setText(amountBb, ctx.bb > 0 ? `${(amount / ctx.bb).toFixed(amount / ctx.bb >= 100 ? 0 : 1)} bb` : '');
    const aggressive = legalOf('raise') ?? legalOf('bet');
    const allIn = isAllIn();
    if (aggressive) {
      const verb = aggressive.kind === 'bet' ? 'Bet' : 'Raise';
      setText(raiseTop, allIn ? 'All In' : sizing ? `${verb} to` : verb);
      setText(raiseSub, allIn ? (sizing ? HOLD_PROMPT : fmt(amount)) : fmt(amount));
    } else if (legalOf('allin')) {
      setText(raiseTop, 'All In');
      setText(raiseSub, sizing ? HOLD_PROMPT : fmt(amount));
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
    const travel = Math.max(1, dragW - THUMB_PX);
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

  press(trackEl, {
    slop: 10000,
    haptic: 'tick',
    sfx: 'chipClick',
    onDown: (e) => {
      cls(trackEl, 'is-dragging', true);
      const rect = trackEl.getBoundingClientRect();
      dragLeft = rect.left;
      dragW = rect.width;
      measureTrack();
      const travel = Math.max(1, dragW - THUMB_PX);
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
    setText(kpValue, kpBuffer === '' ? fmt(amount) : `${kpBuffer}`);
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
    if (!sizing) return;
    sizing = false;
    cls(el, 'is-sizing', false);
    cls(raiseBtn, 'is-hold', false);
    // A hand can end with a finger still on the track. Leaving `is-dragging`
    // behind would strand the thumb with its transition switched off.
    cls(trackEl, 'is-dragging', false);
    grabOffset = 0;
    lastPx = -1;
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
      setText(callSub, fmt(ctx.toCall));
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

      snapIndex = -1;
      lastPx = -1;
      grabOffset = 0;
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
