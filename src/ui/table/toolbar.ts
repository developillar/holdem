/**
 * In-game menu sheet.
 *
 * Everything a seated player needs without leaving the felt: leave, sit out
 * next hand, auto-rebuy, a table-skin quick swap, sound, the hand-strength
 * toggle for purists, the session hand history and a one-tap replay of the
 * last hand.
 */

import { chips } from '../../core/stakes.ts';
import { cls, h, setText } from './dom.ts';
import { icon } from './icons.ts';
import { actionRow, createSheet, segmented, toggleRow } from './sheet.ts';
import type { Segmented, Sheet, ToggleRow } from './sheet.ts';

export type SkinId = 'emerald' | 'midnight' | 'crimson' | 'sand';

export const SKIN_LABEL: Record<SkinId, string> = {
  emerald: 'Emerald',
  midnight: 'Midnight',
  crimson: 'Crimson',
  sand: 'Sand',
};

export interface TableToolbarState {
  sitOut: boolean;
  autoRebuy: boolean;
  sound: boolean;
  handStrength: boolean;
  skin: SkinId;
}

export interface TableToolbarOptions {
  tableName: string;
  stakeLabel: string;
  formatLabel: string;
  initial: TableToolbarState;
  fmt: (v: number) => string;
  onLeave: () => void;
  onSitOut: (on: boolean) => void;
  onAutoRebuy: (on: boolean) => void;
  onSound: (on: boolean) => void;
  onHandStrength: (on: boolean) => void;
  onSkin: (skin: SkinId) => void;
  onHistory: () => void;
  onLastHand: () => void;
  onRebuy: () => void;
}

export interface TableToolbar {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  setStats(hands: number, net: number): void;
  setSitOut(on: boolean): void;
  setCanRebuy(on: boolean): void;
  dispose(): void;
}

export function createToolbar(opts: TableToolbarOptions): TableToolbar {
  const sheet: Sheet = createSheet({ title: opts.tableName, className: 'sheet--menu', id: 'table-menu' });

  const handsEl = h('span', { class: 'tm__stat-v tnum' }, '0');
  const netEl = h('span', { class: 'tm__stat-v tnum' }, opts.fmt(0));
  const head = h(
    'div',
    { class: 'tm__head' },
    h(
      'div',
      { class: 'tm__badge' },
      h('span', { class: 'tm__stake' }, opts.stakeLabel),
      h('span', { class: 'tm__fmt' }, opts.formatLabel),
    ),
    h(
      'div',
      { class: 'tm__stats' },
      h('div', { class: 'tm__stat' }, h('span', { class: 'tm__stat-l' }, 'HANDS'), handsEl),
      h('div', { class: 'tm__stat' }, h('span', { class: 'tm__stat-l' }, 'NET'), netEl),
    ),
  );

  const sitOutToggle: ToggleRow = toggleRow(
    'Sit out next hand',
    'Keep your seat, skip the deal',
    opts.initial.sitOut,
    opts.onSitOut,
    icon('chair', 18),
  );
  const rebuyToggle: ToggleRow = toggleRow(
    'Auto rebuy',
    'Top back up to 100bb automatically',
    opts.initial.autoRebuy,
    opts.onAutoRebuy,
    icon('coins', 18),
  );
  const soundToggle: ToggleRow = toggleRow(
    'Sound',
    'Table ambience, chips and cards',
    opts.initial.sound,
    opts.onSound,
    icon('sound-on', 18),
  );
  const hsToggle: ToggleRow = toggleRow(
    'Show hand strength',
    'Names your made hand and live outs',
    opts.initial.handStrength,
    opts.onHandStrength,
    icon('spark', 18),
  );

  const skinSeg: Segmented<SkinId> = segmented<SkinId>({
    items: (Object.keys(SKIN_LABEL) as SkinId[]).map((id) => ({ id, label: SKIN_LABEL[id] })),
    value: opts.initial.skin,
    onChange: opts.onSkin,
  });
  const skinBlock = h(
    'div',
    { class: 'tm__block' },
    h('div', { class: 'tm__block-h' }, h('i', { class: 'row__ic' }, icon('skin', 18)), h('span', null, 'Table felt')),
    skinSeg.el,
  );

  const rebuyRow = actionRow({
    label: 'Add chips',
    sub: 'Top up your stack between hands',
    leading: icon('coins', 18),
    tone: 'gold',
    onPress: () => {
      sheet.close();
      opts.onRebuy();
    },
  });

  const historyRow = actionRow({
    label: 'Hand history',
    sub: 'Every hand from this session',
    leading: icon('history', 18),
    onPress: () => {
      sheet.close();
      opts.onHistory();
    },
  });

  const lastHandRow = actionRow({
    label: 'Replay last hand',
    sub: 'Step through the action',
    leading: icon('replay', 18),
    onPress: () => {
      sheet.close();
      opts.onLastHand();
    },
  });

  const leaveRow = actionRow({
    label: 'Leave table',
    sub: 'Cash out and return to the lobby',
    leading: icon('leave', 18),
    tone: 'danger',
    trailing: h('i', { class: 'row__chev' }),
    onPress: () => {
      sheet.close();
      opts.onLeave();
    },
  });

  sheet.body.append(
    head,
    h('div', { class: 'tm__group' }, sitOutToggle.el, rebuyToggle.el, rebuyRow),
    h('div', { class: 'tm__group' }, skinBlock, soundToggle.el, hsToggle.el),
    h('div', { class: 'tm__group' }, historyRow, lastHandRow),
    h('div', { class: 'tm__group tm__group--danger' }, leaveRow),
  );

  return {
    el: sheet.el,
    open: () => sheet.open(),
    close: () => sheet.close(),
    get isOpen(): boolean {
      return sheet.isOpen;
    },
    setStats(hands: number, net: number): void {
      setText(handsEl, String(hands));
      setText(netEl, `${net > 0 ? '+' : net < 0 ? '−' : ''}${opts.fmt(Math.abs(net))}`);
      cls(netEl, 'is-up', net > 0);
      cls(netEl, 'is-down', net < 0);
    },
    setSitOut(on: boolean): void {
      sitOutToggle.set(on);
    },
    setCanRebuy(on: boolean): void {
      cls(rebuyRow, 'is-disabled', !on);
    },
    dispose(): void {
      sheet.dispose();
    },
  };
}

export { chips };
