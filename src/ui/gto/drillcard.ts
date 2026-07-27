/**
 * ROYALE — ui/gto/drillcard.ts
 * ────────────────────────────────────────────────────────────────────────────
 * A drill in the picker. Progress lives in the ring on the left — mastery, not
 * a raw count, so a drill you have answered five times correctly does not read
 * as finished. Difficulty is a tier chip, and anything waiting in the spaced
 * repetition queue wears a gold "due" badge, because that is the strongest
 * reason to open a drill.
 */

import { h, cx } from '../dom.ts';
import { icon } from '../components/icons.ts';
import { RingProgress } from '../components/progress.ts';
import { pressFeedback } from '../components/util.ts';
import type { DrillDef, Tier } from '../../gto/drills.ts';
import { TIER_LABEL } from '../../gto/drills.ts';
import type { DrillStats } from '../../gto/session.ts';

export interface DrillCardOpts {
  def: DrillDef;
  stats: DrillStats;
  mastery: number;
  due: number;
  onTap(): void;
}

const TIER_TONE: Record<Tier, string> = { core: 'core', sharp: 'sharp', expert: 'expert' };

export function DrillCard(opts: DrillCardOpts): HTMLElement {
  const { def, stats, mastery, due } = opts;
  const accuracy = stats.attempts > 0 ? stats.correct / stats.attempts : 0;

  const ring = RingProgress({
    value: mastery,
    size: 52,
    stroke: 4,
    tone: mastery >= 0.8 ? 'good' : 'gold',
    center: h(
      'span',
      { class: 'td-ring__c' },
      icon(def.icon as 'cards', { size: 19, stroke: 1.8 }),
    ),
  });

  const spark = h('div', { class: 'td-spark', 'aria-hidden': 'true' });
  const recent = stats.recent.slice(-14);
  for (let i = 0; i < 14; i++) {
    const v = recent[i - (14 - recent.length)];
    spark.appendChild(
      h('span', { class: cx('td-spark__t', v === 1 ? 'is-hit' : v === 0 ? 'is-miss' : 'is-none') }),
    );
  }

  const el = h(
    'button',
    {
      class: cx('td', `is-${TIER_TONE[def.tier]}`, stats.attempts === 0 && 'is-fresh'),
      type: 'button',
      'aria-label': `${def.name}. ${def.blurb}`,
    },
    h('span', { class: 'td__edge', 'aria-hidden': 'true' }),
    h('span', { class: 'td__wash', 'aria-hidden': 'true' }),
    h('div', { class: 'td__ring' }, ring),
    h(
      'div',
      { class: 'td__body' },
      h(
        'div',
        { class: 'td__top' },
        h('h3', { class: 'td__name' }, def.name),
        due > 0
          ? h('span', { class: 'td__due' }, h('span', { class: 'td__duedot' }), `${due} due`)
          : null,
      ),
      h('p', { class: 'td__blurb' }, def.blurb),
      h(
        'div',
        { class: 'td__foot' },
        h('span', { class: cx('td__tier', `is-${def.tier}`) }, TIER_LABEL[def.tier]),
        h('span', { class: 'td__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'td__cat' }, def.category),
        stats.attempts > 0
          ? h('span', { class: 'td__acc tnum' }, `${Math.round(accuracy * 100)}% · ${stats.attempts}`)
          : h('span', { class: 'td__acc is-new' }, 'New'),
      ),
      stats.attempts > 0 ? spark : null,
    ),
    h('span', { class: 'td__go', 'aria-hidden': 'true' }, icon('chevron-right', { size: 18 })),
  );

  pressFeedback(el);
  el.addEventListener('click', opts.onTap);
  return el;
}
