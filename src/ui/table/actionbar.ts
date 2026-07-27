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
  let trackW = 0;
  let snapIndex = -1;
  let kpBuffer = '';
  let kpOpen = false;

  const round = (v: number): number => Math.round(v / step) * step;
  const isAllIn = (): boolean => maxTo > 0 && amount >= maxTo - step / 2;
  const legalOf = (kind: ActionKind): LegalAction | undefined => legal.find((l) => l.kind === kind);

  // ═══════════════════ slider maths ═══════════════════

  // A geometric mapping, not a linear one: a linear slider buries every
  // sensible bet in the first 15% of the track once a deep stack is behind it.
  // On this curve ½-pot, pot and all-in land roughly a third apart.
  const toT = (v: number): number => {
    if (maxTo <= minTo) return 0;
    if (minTo > 0) return clamp(Math.log(Math.max(v, minTo) / minTo) / Math.log(maxTo / minTo), 0, 1);
    return clamp((v - minTo) / (maxTo - minTo), 0, 1);
  };
  const fromT = (t: number): number => {
    if (maxTo <= minTo) return minTo;
    const c = clamp(t, 0, 1);
    if (minTo > 0) return minTo * Math.pow(maxTo / minTo, c);
    return minTo + c * (maxTo - minTo);
  };

  const measureTrack = (): void => {
    trackW = trackEl.clientWidth || 260;
  };

  const paintSlider = (): void => {
    const t = toT(amount);
    if (trackW === 0) measureTrack();
    const travel = Math.max(0, trackW - 30);
    thumbEl.style.transform = `translate3d(${(t * travel).toFixed(1)}px, 0, 0)`;
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
      setText(raiseSub, allIn ? (sizing ? 'Hold to confirm' : fmt(amount)) : fmt(amount));
    } else if (legalOf('allin')) {
      setText(raiseTop, 'All In');
      setText(raiseSub, sizing ? 'Hold to confirm' : fmt(amount));
    }
    cls(raiseBtn, 'is-allin', allIn);
    cls(raiseBtn, 'is-hold', sizing && allIn);
    for (const [chip, value] of presetChips) {
      cls(chip, 'is-active', Math.abs(value - amount) < step / 2);
    }
  };

  const setAmount = (v: number, fromSlider = false): void => {
    const next = clamp(round(v), minTo, maxTo);
    if (Math.abs(next - amount) < step / 4) {
      if (fromSlider) paintSlider();
      return;
    }
    amount = next;
    paintAmount();
    if (!fromSlider) paintSlider();
    else paintSlider();
  };

  // ═══════════════════ presets ═══════════════════

  const presetChips = new Map<HTMLElement, number>();

  const buildPresets = (): void => {
    presetChips.clear();
    presetsEl.replaceChildren();
    ticksEl.replaceChildren();
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
      if (maxTo > minTo) {
        const t = toT(p.amount);
        const tick = h('i', { class: 'ab__tick' });
        tick.style.left = `${(t * 100).toFixed(2)}%`;
        ticksEl.appendChild(tick);
      }
    }
  };

  // ═══════════════════ slider interaction ═══════════════════

  const sliderFromX = (clientX: number): void => {
    const rect = trackEl.getBoundingClientRect();
    trackW = rect.width;
    const travel = Math.max(1, rect.width - 30);
    const t = clamp((clientX - rect.left - 15) / travel, 0, 1);
    let value = fromT(t);

    // Snap to the nearest preset when the finger is close to it.
    let best = -1;
    let bestDist = 0.032;
    for (let i = 0; i < presets.length; i++) {
      const d = Math.abs(toT(presets[i].amount) - t);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best >= 0) {
      value = presets[best].amount;
      if (best !== snapIndex) {
        snapIndex = best;
        haptic('tick');
        cue('chipClick', 0, 0.5);
      }
    } else if (snapIndex !== -1) {
      snapIndex = -1;
    }
    setAmount(value, true);
  };

  press(trackEl, {
    slop: 10000,
    haptic: 'tick',
    sfx: 'chipClick',
    onDown: (e) => {
      cls(trackEl, 'is-dragging', true);
      sliderFromX(e.clientX);
    },
    onMove: (e) => sliderFromX(e.clientX),
    onUp: () => {
      cls(trackEl, 'is-dragging', false);
      cue('chipStack', 2, 0, 0.5);
    },
  });

  const nudge = (dir: number): void => {
    const bbStep = ctx.bb > 0 ? Math.max(step, round(ctx.bb / 2)) : step;
    setAmount(amount + dir * bbStep);
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
  };

  const expandSizer = (): void => {
    if (sizing) return;
    sizing = true;
    cls(el, 'is-sizing', true);
    measureTrack();
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
      buildPresets();
      paintButtons();
      paintAmount();
      measureTrack();
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
      el.remove();
    },
  };
}
