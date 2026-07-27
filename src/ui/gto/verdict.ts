/**
 * ROYALE — ui/gto/verdict.ts
 * ────────────────────────────────────────────────────────────────────────────
 * What you see after you commit to an action.
 *
 * Correct answers get a green confirm, a tick that draws itself, and the
 * streak counter ticking up. Mistakes get a calm slate treatment — no red
 * flash, no buzzer — because the point is to teach, and a player who feels
 * punished stops reading the explanation. The EV cost is stated plainly and
 * the frequency board does the rest of the talking.
 */

import { h, cx } from '../dom.ts';
import { icon } from '../components/icons.ts';
import { Button } from '../components/button.ts';
import { haptic, reduceMotion } from '../components/util.ts';
import type { Spot, Verdict } from '../../gto/drills.ts';
import { FreqBars } from './freqbar.ts';
import { CardRow, BoardRow } from './cards.ts';

export interface VerdictPanelOpts {
  spot: Spot;
  verdict: Verdict;
  streak: number;
  /** null when the drill has no range layers (postflop) */
  onRanges?: () => void;
  onNext(): void;
  /** true when this spot came back from the repeat queue */
  repeat?: boolean;
}

export interface VerdictPanelEl extends HTMLElement {
  reveal(): void;
}

export function VerdictPanel(opts: VerdictPanelOpts): VerdictPanelEl {
  const { spot, verdict } = opts;
  const good = verdict.correct;
  const partial = !good && verdict.score > 0.25;

  const bars = FreqBars({ node: verdict.strategy, chosen: verdict.chosen, showEv: true });

  // A correct answer that is not the majority line still carries a sliver of
  // model EV. Calling that "lost" in red would be a lie about a fine play.
  const lossText = verdict.evLossBb < 0.005
    ? 'No EV lost'
    : good
      ? `${verdict.evLossBb.toFixed(2)}bb`
      : `−${verdict.evLossBb.toFixed(2)}bb`;

  const banner = h(
    'div',
    { class: cx('tv-banner', good ? 'is-good' : partial ? 'is-part' : 'is-miss') },
    h('span', { class: 'tv-banner__glow', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'tv-banner__mark', 'aria-hidden': 'true' },
      good ? checkMark() : partial ? icon('minus', { size: 20, stroke: 2.6 }) : icon('close', { size: 18, stroke: 2.6 }),
    ),
    h(
      'div',
      { class: 'tv-banner__text' },
      h('div', { class: 'tv-banner__title' }, good ? 'Correct' : partial ? 'Part of the mix' : 'Not the line'),
      h(
        'div',
        { class: 'tv-banner__sub' },
        good
          ? `${verdict.strategy.labels[verdict.chosen] ?? verdict.chosen} · ${Math.round((verdict.strategy.freq[verdict.chosen] ?? 0) * 100)}% of the time`
          : `Solution plays ${verdict.strategy.labels[verdict.optimal] ?? verdict.optimal}`,
      ),
    ),
    h(
      'div',
      { class: 'tv-banner__right' },
      good && opts.streak > 1
        ? h('div', { class: 'tv-streak' },
            h('span', { class: 'tv-streak__n tnum' }, String(opts.streak)),
            h('span', { class: 'tv-streak__l caps' }, 'streak'))
        : h('div', { class: cx('tv-loss', verdict.evLossBb < 0.005 && 'is-zero', good && verdict.evLossBb >= 0.005 && 'is-ok') },
            h('span', { class: 'tv-loss__v tnum' }, lossText),
            h('span', { class: 'tv-loss__l caps' }, 'ev')),
    ),
  );

  const chips = h('div', { class: 'tv-chips' });
  if (opts.repeat) chips.appendChild(chip('refresh', 'Repeat', 'gold'));
  if (verdict.detail.equity !== undefined) {
    chips.appendChild(chip('target', `${Math.round(verdict.detail.equity * 100)}% equity`));
  }
  if (verdict.detail.outs) chips.appendChild(chip('bolt', `${verdict.detail.outs} outs`));
  if (verdict.detail.texture) chips.appendChild(chip('cards', verdict.detail.texture));
  if (verdict.detail.rangePct !== undefined) {
    chips.appendChild(chip('chart', `${(verdict.detail.rangePct * 100).toFixed(1)}% range`));
  }

  const recap = h(
    'div',
    { class: 'tv-recap' },
    h('div', { class: 'tv-recap__hand' }, CardRow(spot.hero, { size: spot.hero.length > 2 ? 'sm' : 'md' })),
    spot.board.length
      ? h('div', { class: 'tv-recap__board' },
          h('span', { class: 'tv-recap__sep', 'aria-hidden': 'true' }),
          BoardRow(spot.board, { size: 'xs' }))
      : null,
    h('div', { class: 'tv-recap__label' }, verdict.detail.handLabel),
  );

  const actions = h('div', { class: 'tv-actions' });
  if (opts.onRanges && verdict.detail.layers.length) {
    actions.appendChild(
      Button({
        label: 'View range',
        variant: 'secondary',
        icon: icon('sliders', { size: 18 }),
        onTap: opts.onRanges,
      }),
    );
  }
  actions.appendChild(
    Button({ label: 'Next hand', variant: 'primary', full: !actions.childNodes.length, onTap: opts.onNext, haptic: 'select' }),
  );

  const el = h(
    'section',
    { class: 'tv', 'aria-label': 'Verdict' },
    banner,
    recap,
    chips.childNodes.length ? chips : null,
    h('div', { class: 'tv-bars' },
      h('h3', { class: 'tv-h caps' }, 'Optimal mix'),
      bars),
    h('div', { class: 'tv-why' },
      h('h3', { class: 'tv-h caps' }, 'Why'),
      h('p', { class: 'tv-why__p' }, verdict.explanation)),
    actions,
  ) as VerdictPanelEl;

  el.reveal = () => {
    bars.reveal();
    if (!reduceMotion()) {
      el.classList.remove('is-in');
      void el.offsetWidth;
      el.classList.add('is-in');
    }
    haptic(good ? 'win' : 'tick');
  };

  return el;
}

function chip(name: string, text: string, tone = 'neutral'): HTMLElement {
  return h(
    'span',
    { class: cx('tv-chip', `is-${tone}`) },
    icon(name as 'chart', { size: 13, stroke: 1.9 }),
    h('span', null, text),
  );
}

/** A tick that draws itself — cheap, and it makes "correct" feel earned. */
function checkMark(): SVGSVGElement {
  const svg = h('svg', {
    class: 'tv-check',
    attrs: { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', 'aria-hidden': 'true' },
  });
  svg.appendChild(
    h('path', {
      attrs: {
        d: 'M4.8 12.6l4.7 4.7L19.4 7.2',
        stroke: 'currentColor',
        'stroke-width': 2.8,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': '24',
        'stroke-dashoffset': '24',
      },
    }),
  );
  return svg;
}
