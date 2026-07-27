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
  onConfirm: (amount: number) => void;
  onCancel?: () => void;
}

export function createBuyInSheet(opts: BuyInOptions): BuyInSheet {
  const sheet = createSheet({ title: 'Buy in', className: 'sheet--buyin', id: 'table-buyin' });

  const contextEl = h('div', { class: 'bi__context' }, '');
  const amountEl = h('div', { class: 'bi__amt tnum' }, opts.fmt(0));
  const bbEl = h('div', { class: 'bi__bb tnum' }, '');
  const readout = h('div', { class: 'bi__readout' }, amountEl, bbEl);

  const fill = h('i', { class: 'bi__fill' });
  const thumb = h('div', { class: 'bi__thumb' }, h('i', { class: 'bi__knurl' }), h('i', { class: 'bi__knurl' }), h('i', { class: 'bi__knurl' }));
  const track = h('div', { class: 'bi__track' }, h('i', { class: 'bi__groove' }), fill, thumb);
  const minLabel = h('span', { class: 'bi__end tnum' }, '');
  const maxLabel = h('span', { class: 'bi__end tnum' }, '');
  const ends = h('div', { class: 'bi__ends' }, minLabel, maxLabel);

  const presetsEl = h('div', { class: 'bi__presets' });
  const confirm = h('button', { class: 'bi__go', type: 'button' }, h('i', { class: 'bi__go-sheen' }), h('span', { class: 'bi__go-t' }, 'Sit down'));

  sheet.body.append(contextEl, readout, track, ends, presetsEl, confirm);

  let min = 0;
  let max = 0;
  let bb = 1;
  let value = 0;

  const paint = (): void => {
    setText(amountEl, opts.fmt(value));
    setText(bbEl, bb > 0 ? `${Math.round(value / bb)} big blinds` : '');
    const t = max > min ? (value - min) / (max - min) : 0;
    fill.style.transform = `scaleX(${t.toFixed(4)})`;
    thumb.style.transform = `translate3d(${(t * Math.max(0, track.clientWidth - 34)).toFixed(1)}px, 0, 0)`;
    for (const chip of presetsEl.children) {
      const v = Number((chip as HTMLElement).dataset.v);
      cls(chip as HTMLElement, 'is-active', Math.abs(v - value) < 0.005);
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
    onUp: () => cls(track, 'is-dragging', false),
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
      (confirm.querySelector('.bi__go-t') as HTMLElement).textContent = req.confirmLabel ?? 'Sit down';

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
        const chip = h('button', { class: 'bi__chip', type: 'button', 'data-v': String(rounded) }, o.label);
        press(chip, { haptic: 'select', sfx: 'chipClick', onPress: () => setValue(rounded) });
        presetsEl.appendChild(chip);
      }

      sheet.open();
      paint();
      requestAnimationFrame(paint);
    },
    close: () => sheet.close(),
    dispose: () => sheet.dispose(),
  };
}
