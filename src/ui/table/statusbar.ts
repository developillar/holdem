/**
 * The slim status bar at the top of the table.
 *
 * Table identity, stakes and hand number on a cash game; blind level with a
 * live countdown and a draining progress hairline on a sit-and-go. Clears the
 * notch, never covers the felt, and keeps a 44px menu target at the left edge.
 */

import type { TableState } from '../../core/types.ts';
import { cls, h, press, setText, onFrame } from './dom.ts';
import { icon } from './icons.ts';

export interface StatusBar {
  el: HTMLElement;
  update(state: TableState): void;
  setConnection(status: 'live' | 'slow' | 'offline'): void;
  dispose(): void;
}

export interface StatusBarOptions {
  tableName: string;
  onMenu: () => void;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

export function createStatusBar(opts: StatusBarOptions): StatusBar {
  const menuBtn = h('button', { class: 'sb__menu', type: 'button', 'aria-label': 'Table menu' }, icon('menu', 20));
  const nameEl = h('div', { class: 'sb__name' }, opts.tableName);
  const stakeEl = h('div', { class: 'sb__stake tnum' }, '');
  const centre = h('div', { class: 'sb__centre' }, nameEl, stakeEl);

  const levelLabel = h('span', { class: 'sb__lvl-l' }, 'HAND');
  const levelValue = h('span', { class: 'sb__lvl-v tnum' }, '—');
  const levelSub = h('span', { class: 'sb__lvl-s tnum' }, '');
  const levelBarFill = h('i', { class: 'sb__lvl-fill' });
  const levelBar = h('i', { class: 'sb__lvl-bar' }, levelBarFill);
  const right = h('div', { class: 'sb__right' }, h('div', { class: 'sb__lvl' }, levelLabel, levelValue, levelSub), levelBar);

  const dot = h('i', { class: 'sb__dot' });
  const el = h('header', { class: 'sb' }, h('i', { class: 'sb__veil' }), menuBtn, centre, right, dot);

  press(menuBtn, { haptic: 'select', sfx: 'tapSecondary', onPress: opts.onMenu });

  let levelMs = 0;
  let levelDuration = 0;
  let tournament = false;
  let acc = 0;

  const stopFrame = onFrame((dt) => {
    if (!tournament || levelDuration <= 0) return;
    levelMs = Math.max(0, levelMs - dt);
    acc += dt;
    if (acc < 250) return;
    acc = 0;
    setText(levelSub, mmss(levelMs));
    levelBarFill.style.transform = `scaleX(${(levelMs / levelDuration).toFixed(4)})`;
    cls(el, 'is-urgent', levelMs < 30_000);
  });

  return {
    el,

    update(state: TableState): void {
      setText(stakeEl, state.tournament ? `${state.tournament.sb}/${state.tournament.bb}` : state.stake.label);
      const t = state.tournament;
      if (t) {
        tournament = true;
        levelMs = t.msUntilLevelUp;
        levelDuration = Math.max(1, t.levelDurationMs);
        setText(levelLabel, 'LEVEL');
        setText(levelValue, String(t.level));
        setText(levelSub, mmss(levelMs));
        setText(nameEl, `${t.playersLeft} left · ${t.entrants} entered`);
        cls(el, 'is-sng', true);
        levelBarFill.style.transform = `scaleX(${(levelMs / levelDuration).toFixed(4)})`;
      } else {
        tournament = false;
        setText(levelLabel, 'HAND');
        setText(levelValue, state.handId > 0 ? `#${state.handId}` : '—');
        setText(levelSub, '');
        setText(nameEl, opts.tableName);
        cls(el, 'is-sng', false);
      }
    },

    setConnection(status): void {
      el.dataset.conn = status;
      dot.title = status === 'live' ? 'Connected' : status === 'slow' ? 'Unstable connection' : 'Offline';
    },

    dispose(): void {
      stopFrame();
      el.remove();
    },
  };
}
