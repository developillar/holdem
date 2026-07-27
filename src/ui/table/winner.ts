/**
 * The winner banner — the payoff beat.
 *
 * Winner, hand category in big gold type, the exact five cards that made it,
 * and the amount counting up. Quads, straight flushes and royals get their own
 * escalated treatment: rays, a longer hold, a heavier shimmer. This and the
 * chip push are the two moments the whole screen exists to deliver, so nothing
 * here is subtle-by-default.
 */

import { bus } from '../../core/bus.ts';
import type { CardId, HandCategory } from '../../core/types.ts';
import { cardFace } from './cardface.ts';
import { countUp, cls, cue, h, haptic, setText } from './dom.ts';
import { icon } from './icons.ts';

export type WinnerTier = 'normal' | 'big' | 'epic' | 'royal';

export interface WinnerInfo {
  seat: number;
  name: string;
  amount: number;
  /** null when everyone folded */
  category: HandCategory | null;
  label: string;
  cards: readonly CardId[];
  hero: boolean;
  /** true when the pot was taken without a showdown */
  uncontested: boolean;
  /** split pots name every winner */
  splitWith?: number;
}

export interface WinnerBanner {
  el: HTMLElement;
  show(info: WinnerInfo): void;
  hide(): void;
  dispose(): void;
}

function tierOf(info: WinnerInfo): WinnerTier {
  if (info.label === 'Royal Flush') return 'royal';
  if (info.category === 'straight-flush' || info.category === 'quads') return 'epic';
  if (info.category === 'full-house' || info.category === 'flush' || info.category === 'straight') return 'big';
  return 'normal';
}

const HOLD_MS: Record<WinnerTier, number> = { normal: 2400, big: 2800, epic: 3800, royal: 4600 };

export function createWinnerBanner(fmt: (v: number) => string): WinnerBanner {
  const rays = h('i', { class: 'wn__rays', 'aria-hidden': 'true' });
  const crest = h('div', { class: 'wn__crest' }, icon('trophy', 18));
  const nameEl = h('div', { class: 'wn__name' }, '');
  const catEl = h('div', { class: 'wn__cat' }, '');
  const detailEl = h('div', { class: 'wn__detail' }, '');
  const cardsEl = h('div', { class: 'wn__cards' });
  const amountEl = h('div', { class: 'wn__amt tnum' }, fmt(0));
  const splitEl = h('div', { class: 'wn__split' }, '');
  const plate = h(
    'div',
    { class: 'wn__plate' },
    h('i', { class: 'wn__shimmer' }),
    h('div', { class: 'wn__head' }, crest, nameEl),
    catEl,
    detailEl,
    cardsEl,
    h('div', { class: 'wn__amt-wrap' }, h('span', { class: 'wn__amt-l' }, 'WINS'), amountEl),
    splitEl,
  );
  const el = h('div', { class: 'wn', role: 'status', 'aria-live': 'assertive' }, rays, plate);

  const counter = countUp(amountEl, fmt, 0);
  let hideTimer = 0;

  const hide = (): void => {
    cls(el, 'is-shown', false);
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
  };

  return {
    el,

    show(info): void {
      const tier = tierOf(info);
      el.dataset.tier = tier;
      cls(el, 'is-hero', info.hero);

      setText(nameEl, info.name);
      // "Two Pair, Nines and Eights" reads best as a headline plus a detail:
      // the category carries the punch, the ranks carry the specifics.
      const comma = info.label.indexOf(',');
      const headline = info.uncontested ? 'TAKES THE POT' : (comma > 0 ? info.label.slice(0, comma) : info.label);
      const detail = info.uncontested || comma < 0 ? '' : info.label.slice(comma + 1).trim();
      setText(catEl, headline.toUpperCase());
      setText(detailEl, detail);
      cls(detailEl, 'is-shown', detail !== '');
      cls(catEl, 'is-long', headline.length > 15);

      cardsEl.replaceChildren();
      if (!info.uncontested && info.cards.length) {
        info.cards.forEach((c, i) => {
          const face = cardFace(c, 'md');
          face.style.setProperty('--i', String(i));
          cardsEl.appendChild(face);
        });
      }
      cls(cardsEl, 'is-shown', !info.uncontested && info.cards.length > 0);

      setText(splitEl, info.splitWith && info.splitWith > 1 ? `SPLIT ${info.splitWith} WAYS` : '');
      cls(splitEl, 'is-shown', !!info.splitWith && info.splitWith > 1);

      counter.set(0);
      cls(el, 'is-shown', true);
      counter.to(info.amount, tier === 'normal' ? 700 : 1150);

      // The bus carries the celebration to the 3D stage and the FX layer.
      if (tier === 'royal') bus.emit('fx:burst', { kind: 'royal', seat: info.seat });
      else if (tier === 'epic') bus.emit('fx:burst', { kind: 'quads', seat: info.seat });
      else bus.emit('fx:burst', { kind: 'chips-win', seat: info.seat });
      if (info.hero && tier !== 'normal') bus.emit('fx:burst', { kind: 'confetti', seat: info.seat });

      if (info.hero) {
        haptic(tier === 'normal' ? 'win' : 'big-win');
        cue(tier === 'normal' ? 'winSmall' : 'winBig', tier === 'royal' ? 1.4 : 1);
      } else {
        cue('potPush', 0.6);
      }
      if (tier === 'royal') cue('fanfareRoyal');

      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, HOLD_MS[tier]);
    },

    hide,

    dispose(): void {
      hide();
      counter.dispose();
      el.remove();
    },
  };
}
