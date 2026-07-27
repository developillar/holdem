/**
 * Buy-in / top-up sheet.
 *
 * One decision, made beautiful: how much to sit down with. Big money readout
 * in both currency and big blinds, a snapping slider, three presets, and a
 * gold commit button. Reused verbatim for mid-session rebuys.
 */

import { clamp, cls, cue, h, haptic, press, setText } from './dom.ts';
import { createSheet } from './sheet.ts';

export interface BuyInRequest {
  min: number;
  max: number;
  value: number;
  bb: number;
  title?: string;
  confirmLabel?: string;
  /** shown under the title, e.g. "$0.05/$0.10 · 6-max" */
  context?: string;
}

export interface BuyInSheet {
  el: HTMLElement;
  open(req: BuyInRequest): void;
  close(): void;
  readonly isOpen: boolean;
  dispose(): void;
}

export interface BuyInOptions {
  fmt: (v: number) => string;
  /**
   * Formatter for the hero readout. Unlike `fmt` — which drops trailing
   * zeroes so stack pills stay dense — this one must be fixed-precision:
   * "$10.00", never "$10". The stakes line right above reads "$0.05/$0.10",
   * so a bare "$10" reads as an integer label rather than money, and the
   * string length must not change as the value is dragged.
   */
  fmtHero?: (v: number) => string;
  onConfirm: (amount: number) => void;
  onCancel?: () => void;
}

/** Step the hero down only if a very long string would crowd the sheet. */
function heroSize(text: string): string {
  const n = text.length;
  if (n <= 9) return '52px';
  if (n === 10) return '46px';
  if (n === 11) return '41px';
  return '36px';
}

export function createBuyInSheet(opts: BuyInOptions): BuyInSheet {
  const sheet = createSheet({ title: 'Buy in', className: 'sheet--buyin', id: 'table-buyin' });
  const fmtHero = opts.fmtHero ?? opts.fmt;

  const contextEl = h('div', { class: 'bi__context' }, '');
  // The ghost holds the widest string this sheet can produce so the readout
  // reserves its final width up front; the live value is centred over it and
  // therefore never reflows mid-drag.
  const amountGhost = h('span', { class: 'bi__amt-ghost', 'aria-hidden': 'true' }, '');
  const amountValue = h('span', { class: 'bi__amt-v' }, fmtHero(0));
  const amountEl = h('div', { class: 'bi__amt tnum', role: 'status', 'aria-live': 'polite' }, amountGhost, amountValue);
  const bbEl = h('div', { class: 'bi__bb tnum' }, '');
  const readout = h('div', { class: 'bi__readout' }, amountEl, bbEl);

  const aura = h('i', { class: 'bi__aura' });
  const fill = h('i', { class: 'bi__fill' });
  const cap = h('i', { class: 'bi__cap' });
  const thumb = h('div', { class: 'bi__thumb' }, h('i', { class: 'bi__knurl' }), h('i', { class: 'bi__knurl' }), h('i', { class: 'bi__knurl' }));
  // Cap under the bar: the circle's topmost point is tangent to the bar's top
  // edge at x=4, so the inner highlight runs from arc into straight line with
  // no seam. Painted the other way round the arc cuts across the bar.
  const track = h(
    'div',
    { class: 'bi__track', role: 'slider', tabindex: '0', 'aria-label': 'Buy-in amount' },
    h('i', { class: 'bi__groove' }),
    aura,
    cap,
    fill,
    thumb,
  );
  const minLabel = h('span', { class: 'bi__end tnum' }, '');
  const maxLabel = h('span', { class: 'bi__end tnum' }, '');
  const ends = h('div', { class: 'bi__ends' }, minLabel, maxLabel);

  const presetsEl = h('div', { class: 'bi__presets' });
  const sheen = h('i', { class: 'bi__go-sheen' });
  const confirm = h('button', { class: 'bi__go', type: 'button' }, sheen, h('span', { class: 'bi__go-t' }, 'Sit down'));

  sheet.body.append(contextEl, readout, track, ends, presetsEl, confirm);

  let min = 0;
  let max = 0;
  let bb = 1;
  let value = 0;

  // ── the CTA sheen fires once on open and once per committed value. Never
  // a loop: a perpetual shine keeps a compositor layer awake and reads as
  // free-to-play casino chrome.
  let sweepRaf = 0;
  let sweepTimer = 0;
  sheen.addEventListener('animationend', () => cls(confirm, 'is-sweeping', false));
  const sweep = (): void => {
    cls(confirm, 'is-sweeping', false);
    if (sweepRaf) cancelAnimationFrame(sweepRaf);
    // Two frames so the removed class is committed before it is re-added,
    // which restarts the animation without reading layout.
    sweepRaf = requestAnimationFrame(() => {
      sweepRaf = requestAnimationFrame(() => {
        sweepRaf = 0;
        cls(confirm, 'is-sweeping', true);
      });
    });
  };

  const paint = (): void => {
    setText(amountValue, fmtHero(value));
    setText(bbEl, bb > 0 ? `${Math.round(value / bb)} big blinds` : '');
    const t = max > min ? (value - min) / (max - min) : 0;
    const w = track.clientWidth;
    const travel = Math.max(0, w - 34);
    // The bar runs from the round cap's centre (x=4) to the thumb's centre
    // (x = 17 + t·travel). It is scaled, so its own radius would render as an
    // ellipse — the round end lives on `.bi__cap`, which is never transformed.
    const s = w > 34 ? (13 + t * travel) / Math.max(1, w - 21) : 0;
    fill.style.transform = `scaleX(${s.toFixed(4)})`;
    aura.style.transform = `scaleX(${s.toFixed(4)})`;
    thumb.style.transform = `translate3d(${(t * travel).toFixed(1)}px, 0, 0)`;
    track.setAttribute('aria-valuenow', value.toFixed(2));
    track.setAttribute('aria-valuetext', `${fmtHero(value)}, ${Math.round(value / bb)} big blinds`);
    for (const chip of presetsEl.children) {
      const el = chip as HTMLElement;
      const on = Math.abs(Number(el.dataset.v) - value) < 0.005;
      cls(el, 'is-active', on);
      el.setAttribute('aria-pressed', String(on));
    }
  };

  const setValue = (v: number, silent = false): void => {
    const next = clamp(Math.round(v / 0.01) * 0.01, min, max);
    if (Math.abs(next - value) < 0.005) return;
    value = next;
    if (!silent) {
      haptic('tick');
      cue('chipClick', 0, 0.4);
    }
    paint();
  };

  const fromX = (clientX: number): void => {
    const r = track.getBoundingClientRect();
    const t = clamp((clientX - r.left - 17) / Math.max(1, r.width - 34), 0, 1);
    let v = min + t * (max - min);
    // Snap to whole big blinds — nobody buys in for 63.4 blinds.
    const inBb = Math.round(v / bb);
    if (Math.abs(inBb * bb - v) < bb * 0.4) v = inBb * bb;
    setValue(v);
  };

  press(track, {
    slop: 10000,
    haptic: 'tick',
    onDown: (e) => {
      cls(track, 'is-dragging', true);
      fromX(e.clientX);
    },
    onMove: (e) => fromX(e.clientX),
    onUp: () => {
      cls(track, 'is-dragging', false);
      sweep();
    },
  });

  // Keyboard parity with the drag: same snap, same haptic, same cue.
  track.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = e.shiftKey ? bb * 10 : bb;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else return;
    e.preventDefault();
    setValue(next);
    sweep();
  });

  press(confirm, {
    haptic: 'bet',
    sfx: 'betConfirm',
    onPress: () => {
      const amount = value;
      sheet.close();
      opts.onConfirm(amount);
    },
  });

  sheet.onClosed = () => opts.onCancel?.();

  return {
    el: sheet.el,
    get isOpen(): boolean {
      return sheet.isOpen;
    },
    open(req): void {
      min = req.min;
      max = req.max;
      bb = req.bb;
      value = clamp(req.value, min, max);
      sheet.setTitle(req.title ?? 'Buy in');
      setText(contextEl, req.context ?? '');
      cls(contextEl, 'is-shown', !!req.context);
      setText(minLabel, `${Math.round(min / bb)}bb min`);
      setText(maxLabel, `${Math.round(max / bb)}bb max`);
      track.setAttribute('aria-valuemin', min.toFixed(2));
      track.setAttribute('aria-valuemax', max.toFixed(2));
      (confirm.querySelector('.bi__go-t') as HTMLElement).textContent = req.confirmLabel ?? 'Sit down';

      // Reserve the readout's width for the longest string this range can
      // produce, and drop the type size only if that string is unusually long.
      const widest = fmtHero(max).length >= fmtHero(min).length ? fmtHero(max) : fmtHero(min);
      setText(amountGhost, widest);
      amountEl.style.setProperty('--bi-amt-size', heroSize(widest));

      presetsEl.replaceChildren();
      const options: Array<{ label: string; v: number }> = [
        { label: `${Math.round(min / bb)}bb`, v: min },
        { label: '100bb', v: clamp(bb * 100, min, max) },
        { label: `${Math.round(max / bb)}bb`, v: max },
      ];
      const seen = new Set<number>();
      for (const o of options) {
        const rounded = Math.round(o.v * 100) / 100;
        if (seen.has(rounded)) continue;
        seen.add(rounded);
        const chip = h('button', { class: 'bi__chip', type: 'button', 'data-v': String(rounded), 'aria-pressed': 'false' }, o.label);
        press(chip, {
          haptic: 'select',
          sfx: 'chipClick',
          onPress: () => {
            setValue(rounded);
            sweep();
          },
        });
        presetsEl.appendChild(chip);
      }

      sheet.open();
      paint();
      requestAnimationFrame(paint);
      // Wait out the CTA's staggered entrance so the light catches a button
      // that has already landed, not one still fading in.
      if (sweepTimer) clearTimeout(sweepTimer);
      sweepTimer = window.setTimeout(() => {
        sweepTimer = 0;
        sweep();
      }, 620);
    },
    close: () => sheet.close(),
    dispose: (): void => {
      if (sweepRaf) cancelAnimationFrame(sweepRaf);
      if (sweepTimer) clearTimeout(sweepTimer);
      sweepRaf = 0;
      sweepTimer = 0;
      sheet.dispose();
    },
  };
}
