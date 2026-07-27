/**
 * ROYALE — ui/gto/freqbar.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The frequency board — the thing the whole verdict hangs on.
 *
 * One row per action: a tinted dot, the action's label, a track whose fill is
 * a real metal gradient with a lit leading edge, the frequency as a counted-up
 * percentage, and the model's EV underneath. The row you picked carries a gold
 * marker and a YOU chip; the row the solution takes most often carries a
 * quieter "GTO" tag. Fills stagger in at 55ms apart, which is slow enough to
 * read as a ranking and fast enough not to feel like a loading screen.
 *
 *   const bars = FreqBars({ node, chosen });
 *   bars.reveal();       // triggers the staggered animation
 *
 * Colour follows meaning, not decoration: folds are cool grey, passive lines
 * are teal, aggression is gold. That mapping is used identically in the range
 * viewer so a colour means the same thing everywhere in the trainer.
 */

import { h, cx, clear } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { reduceMotion } from '../components/util.ts';
import type { DrillStrategy } from '../../gto/drills.ts';

export type ActionTone = 'fold' | 'passive' | 'call' | 'aggro' | 'jam';

const TONE_BY_ID: Record<string, ActionTone> = {
  fold: 'fold',
  check: 'passive',
  call: 'call',
  limp: 'passive',
  raise: 'aggro',
  '3bet': 'aggro',
  '4bet': 'aggro',
  squeeze: 'aggro',
  jam: 'jam',
  allin: 'jam',
};

export function toneFor(id: string): ActionTone {
  if (TONE_BY_ID[id]) return TONE_BY_ID[id];
  if (id.startsWith('bet-')) {
    const pct = Number(id.slice(4));
    return pct >= 100 ? 'jam' : 'aggro';
  }
  return 'passive';
}

export interface FreqBarsOpts {
  node: DrillStrategy;
  /** the action the player picked, highlighted */
  chosen?: string;
  /** show the model EV under each label */
  showEv?: boolean;
  /** compact variant used inside the range inspector */
  dense?: boolean;
  class?: ClassValue;
}

export interface FreqBarsEl extends HTMLElement {
  reveal(): void;
  setNode(node: DrillStrategy, chosen?: string): void;
}

export function FreqBars(opts: FreqBarsOpts): FreqBarsEl {
  const el = h('div', {
    class: cx('tg-freq', opts.dense && 'tg-freq--dense', opts.class),
    role: 'list',
  }) as unknown as FreqBarsEl;

  let rows: Array<{ fill: HTMLElement; pct: HTMLElement; value: number }> = [];

  const build = (node: DrillStrategy, chosen?: string): void => {
    clear(el);
    rows = [];
    let best = node.order[0];
    for (const id of node.order) if ((node.freq[id] ?? 0) > (node.freq[best] ?? 0)) best = id;

    node.order.forEach((id, i) => {
      const f = node.freq[id] ?? 0;
      const ev = node.ev[id];
      const tone = toneFor(id);
      const fill = h('span', { class: 'tg-freq__fill' }, h('span', { class: 'tg-freq__edge' }));
      const pct = h('span', { class: 'tg-freq__pct tnum' }, '0%');

      const row = h(
        'div',
        {
          class: cx(
            'tg-freq__row',
            `is-${tone}`,
            chosen === id && 'is-chosen',
            best === id && 'is-best',
            f < 0.005 && 'is-zero',
          ),
          style: { '--i': String(i) },
          role: 'listitem',
        },
        h(
          'div',
          { class: 'tg-freq__head' },
          h('span', { class: 'tg-freq__dot', 'aria-hidden': 'true' }),
          h('span', { class: 'tg-freq__label' }, node.labels[id] ?? id),
          chosen === id ? h('span', { class: 'tg-freq__you' }, 'You') : null,
          best === id && chosen !== id ? h('span', { class: 'tg-freq__gto' }, 'GTO') : null,
          pct,
        ),
        h('div', { class: 'tg-freq__track' }, fill),
        opts.showEv !== false && ev !== undefined
          ? h(
              'div',
              { class: 'tg-freq__ev' },
              h('span', { class: 'tg-freq__evk caps' }, 'EV'),
              h(
                'span',
                { class: cx('tg-freq__evv tnum', ev > 0.005 ? 'is-pos' : ev < -0.005 ? 'is-neg' : 'is-flat') },
                `${ev >= 0 ? '+' : '−'}${Math.abs(ev).toFixed(2)}bb`,
              ),
            )
          : null,
      );
      el.appendChild(row);
      rows.push({ fill, pct, value: f });
    });
  };

  el.setNode = (node, chosen) => {
    build(node, chosen);
  };

  el.reveal = () => {
    const instant = reduceMotion();
    rows.forEach((r, i) => {
      const run = () => {
        r.fill.style.transform = `scaleX(${Math.max(0.008, r.value).toFixed(4)})`;
        countUp(r.pct, r.value, instant ? 0 : 520);
      };
      if (instant) run();
      else window.setTimeout(run, 60 + i * 55);
    });
  };

  build(opts.node, opts.chosen);
  return el;
}

function countUp(node: HTMLElement, target: number, ms: number): void {
  if (ms <= 0) {
    node.textContent = `${Math.round(target * 100)}%`;
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = `${Math.round(target * eased * 100)}%`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * A single stacked bar showing an entire mix in one line. Used in the range
 * viewer's cell inspector, where vertical space is precious.
 */
export function MixStrip(node: DrillStrategy, opts: { class?: ClassValue } = {}): HTMLElement {
  const el = h('div', { class: cx('tg-mixstrip', opts.class), role: 'img' });
  const labels: string[] = [];
  for (const id of node.order) {
    const f = node.freq[id] ?? 0;
    if (f <= 0.004) continue;
    labels.push(`${node.labels[id] ?? id} ${Math.round(f * 100)}%`);
    el.appendChild(
      h('span', {
        class: cx('tg-mixstrip__seg', `is-${toneFor(id)}`),
        style: { flexGrow: String(f) },
        title: `${node.labels[id] ?? id} ${Math.round(f * 100)}%`,
      }),
    );
  }
  el.setAttribute('aria-label', labels.join(', '));
  return el;
}
