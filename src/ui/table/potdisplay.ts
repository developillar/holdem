/**
 * The pot readout.
 *
 * Sits over the middle of the felt, anchored to the renderer's pot position.
 * Counts up when chips arrive rather than snapping, itemises side pots, and
 * promotes itself to a "TOTAL POT" treatment the moment someone is all-in —
 * the number people stare at when the decision actually matters.
 */

import type { Pot } from '../../core/types.ts';
import { countUp, h, cls, setText, replay } from './dom.ts';
import type { CountUp } from './dom.ts';

export interface PotDisplay {
  el: HTMLElement;
  /**
   * Full pot state. Side pots are only itemised when `showSides` is true —
   * uneven contributions mid-street are not side pots, and labelling them
   * that way is the single most common tell of an amateur poker client.
   */
  setPots(pots: readonly Pot[], total: number, showSides?: boolean): void;
  /** Chips just landed: pulse the plate and re-count. */
  collect(total: number): void;
  setAllIn(on: boolean): void;
  setVisible(on: boolean): void;
  /** Places the plate at a screen position, in CSS px. */
  place(x: number, y: number): void;
  reset(): void;
  dispose(): void;
}

export function createPotDisplay(fmt: (v: number) => string): PotDisplay {
  const label = h('span', { class: 'pot__label' }, 'POT');
  const amountEl = h('span', { class: 'pot__amt tnum' }, fmt(0));
  const chip = h('i', { class: 'pot__chip', 'aria-hidden': 'true' });
  const main = h('div', { class: 'pot__main' }, chip, h('div', { class: 'pot__stack' }, label, amountEl));
  const sides = h('div', { class: 'pot__sides' });
  const el = h('div', { class: 'pot', role: 'status', 'aria-live': 'polite' }, main, sides);

  const counter: CountUp = countUp(amountEl, fmt, 0);
  let sideKey = '';
  let visible = false;
  let allIn = false;
  let x = 0;
  let y = 0;

  const paintSides = (pots: readonly Pot[]): void => {
    // Itemise the whole split, not just the side pots: naming a side pot
    // without naming the main one leaves the reader doing arithmetic.
    const parts = pots.filter((p) => p.amount > 0);
    const items = parts.length > 1 ? parts : [];
    const key = items.map((p) => `${p.index}:${p.amount}`).join('|');
    if (key === sideKey) return;
    sideKey = key;
    sides.replaceChildren(
      ...items.map((p) =>
        h(
          'div',
          { class: 'pot__side' },
          h('span', { class: 'pot__side-n' }, p.index === 0 ? 'MAIN' : `SIDE ${p.index}`),
          h('span', { class: 'pot__side-v tnum' }, fmt(p.amount)),
        ),
      ),
    );
    cls(el, 'has-sides', items.length > 0);
  };

  return {
    el,

    setPots(pots, total, showSides = false): void {
      if (total > 0 && !visible) {
        visible = true;
        cls(el, 'is-shown', true);
      }
      counter.to(total, total > counter.value() ? 560 : 240);
      paintSides(showSides ? pots : []);
      cls(el, 'is-fat', total > 0 && String(fmt(total)).length > 6);
    },

    collect(total): void {
      counter.to(total, 640);
      replay(main, 'is-bump');
      if (!visible) {
        visible = true;
        cls(el, 'is-shown', true);
      }
    },

    setAllIn(on): void {
      if (on === allIn) return;
      allIn = on;
      cls(el, 'is-total', on);
      setText(label, on ? 'TOTAL POT' : 'POT');
      if (on) replay(main, 'is-promote');
    },

    setVisible(on): void {
      visible = on;
      cls(el, 'is-shown', on);
    },

    place(nx, ny): void {
      if (nx === x && ny === y) return;
      x = nx;
      y = ny;
      el.style.transform = `translate3d(${nx.toFixed(1)}px, ${ny.toFixed(1)}px, 0) translate(-50%, -50%)`;
    },

    reset(): void {
      counter.set(0);
      sides.replaceChildren();
      sideKey = '';
      allIn = false;
      visible = false;
      cls(el, 'is-shown', false);
      cls(el, 'is-total', false);
      cls(el, 'has-sides', false);
      setText(label, 'POT');
    },

    dispose(): void {
      counter.dispose();
      el.remove();
    },
  };
}
