/**
 * ROYALE — lobby/buyin.ts
 * ────────────────────────────────────────────────────────────────────────────
 * One decision, made to feel expensive: how much do you sit down with.
 *
 *   openBuyIn({ stake, mode, bankroll, onConfirm: (amount, autoRebuy) => … });
 *
 * Everything is inside a thumb's reach from the bottom edge: the readout is
 * big and dual-unit ($ and bb, because a poker player thinks in both), the
 * slider is the library's 48px one with real snap magnets at 40 / 100 / 250bb,
 * the three presets are 44px pills, auto-rebuy is a switch with a one-line
 * consequence, and CONFIRM is a 56px gold slab that states the amount.
 *
 * Guard rails, not nags: the stack bar shows how your chosen stack compares to
 * the table's average, and a short line tells you what the buy-in costs as a
 * share of your roll — which turns a number into a decision.
 */
import { h } from '../dom.ts';
import { Button } from '../components/button.ts';
import { Slider } from '../components/slider.ts';
import { Toggle } from '../components/toggle.ts';
import { openSheet } from '../components/sheet.ts';
import type { SheetHandle } from '../components/sheet.ts';
import { icon } from '../components/icons.ts';
import { haptic, pressFeedback } from '../components/util.ts';
import { cash } from './data.ts';
import type { Stake } from '../../core/types.ts';
import type { LobbyMode } from './modecard.ts';
import { modeLabel } from './modecard.ts';

const REBUY_KEY = 'royale.auto-rebuy';

export interface BuyInOpts {
  stake: Stake;
  mode: LobbyMode;
  /** spendable balance; caps the top of the slider */
  bankroll: number;
  /** table average stack in dollars, for the comparison bar */
  avgStack?: number;
  /** seats open at the level, shown in the sheet subtitle */
  seatsOpen?: number;
  onConfirm(amount: number, autoRebuy: boolean): void;
}

function readRebuy(): boolean {
  try {
    return localStorage.getItem(REBUY_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRebuy(on: boolean): void {
  try {
    localStorage.setItem(REBUY_KEY, on ? '1' : '0');
  } catch {
    /* memory only */
  }
}

/** Round to a sane chip increment so the readout never shows $37.4213. */
function quantise(v: number, bb: number): number {
  const step = bb < 0.2 ? 0.05 : bb < 1 ? 0.25 : bb < 5 ? 1 : 5;
  return Math.round(v / step) * step;
}

export function openBuyIn(opts: BuyInOpts): SheetHandle {
  const { stake } = opts;
  const min = stake.minBuyIn;
  const ceiling = Math.min(stake.maxBuyIn, Math.max(min, opts.bankroll));
  const max = Math.max(min, ceiling);
  const rec = Math.min(max, Math.max(min, stake.bb * 100));
  const step = stake.bb < 0.2 ? 0.05 : stake.bb < 1 ? 0.25 : stake.bb < 5 ? 1 : 5;

  let amount = rec;
  let autoRebuy = readRebuy();

  const amountEl = h('span', { class: 'bi__amt tnum' }, cash(amount));
  const bbEl = h('span', { class: 'bi__bb tnum' }, `${Math.round(amount / stake.bb)}bb`);
  const noteEl = h('span', { class: 'bi__note' });
  const barFill = h('i', { class: 'bi__barfill' });
  const barAvg = h('i', { class: 'bi__baravg' });
  const barLabel = h('span', { class: 'bi__barlabel tnum' });

  const avgStack = opts.avgStack ?? stake.bb * 88;

  const presets: Array<{ id: string; label: string; sub: string; value: number }> = [
    { id: 'min', label: 'Short', sub: `${Math.round(min / stake.bb)}bb`, value: min },
    { id: 'rec', label: 'Standard', sub: '100bb', value: rec },
    { id: 'max', label: 'Deep', sub: `${Math.round(max / stake.bb)}bb`, value: max },
  ];
  const presetEls = new Map<string, HTMLButtonElement>();

  const slider = Slider({
    min,
    max,
    value: amount,
    step,
    snaps: [min, rec, max, quantise(stake.bb * 150, stake.bb)].filter((v) => v >= min && v <= max),
    format: (v) => `${Math.round(v / stake.bb)}bb`,
    ariaLabel: 'Buy-in amount',
    onInput: (v) => setAmount(v, false),
    onChange: (v) => setAmount(v, true),
  });

  function setAmount(v: number, commit: boolean): void {
    amount = Math.min(max, Math.max(min, quantise(v, stake.bb)));
    amountEl.textContent = cash(amount);
    const bb = amount / stake.bb;
    bbEl.textContent = `${bb >= 100 ? Math.round(bb) : bb.toFixed(bb < 10 ? 1 : 0)}bb`;

    // stack-vs-table bar
    const scale = Math.max(max, avgStack * 1.15);
    barFill.style.transform = `scaleX(${(amount / scale).toFixed(4)})`;
    barAvg.style.left = `${((avgStack / scale) * 100).toFixed(2)}%`;
    const ratio = amount / avgStack;
    barLabel.textContent =
      ratio > 1.12
        ? `${ratio.toFixed(1)}× the table average — you cover everyone`
        : ratio < 0.86
          ? `${Math.round(ratio * 100)}% of the table average — short-stack play`
          : 'Right on the table average';

    const share = opts.bankroll > 0 ? amount / opts.bankroll : 1;
    const buyIns = Math.floor(opts.bankroll / Math.max(amount, 1e-6));
    noteEl.textContent =
      share >= 0.2
        ? `${Math.round(share * 100)}% of your roll`
        : `${buyIns > 99 ? '99+' : buyIns} buy-ins deep`;
    noteEl.classList.toggle('is-warn', share >= 0.2);

    for (const [id, b] of presetEls) {
      const p = presets.find((x) => x.id === id)!;
      b.classList.toggle('is-on', Math.abs(p.value - amount) < step / 2);
    }
    cta.setLabel(`Sit down · ${cash(amount)}`);
    if (commit) haptic('tick');
  }

  const presetRow = h('div', { class: 'bi__presets' });
  for (const p of presets) {
    const b = h(
      'button',
      { class: 'bi__preset', type: 'button', 'aria-label': `${p.label}, ${p.sub}` },
      h('span', { class: 'bi__presetl' }, p.label),
      h('span', { class: 'bi__presets2 tnum' }, p.sub),
    );
    pressFeedback(b);
    b.addEventListener('click', () => {
      haptic('select');
      slider.setValue(p.value);
      setAmount(p.value, false);
    });
    presetEls.set(p.id, b);
    presetRow.appendChild(b);
  }

  const rebuyToggle = Toggle({
    on: autoRebuy,
    ariaLabel: 'Auto rebuy',
    onChange: (on) => {
      autoRebuy = on;
      writeRebuy(on);
      rebuyNote.textContent = on
        ? `Tops you back to ${cash(amount)} whenever you drop below ${cash(stake.bb * 40)}.`
        : 'You will be asked before any top-up.';
    },
  });
  const rebuyNote = h(
    'span',
    { class: 'bi__rowsub' },
    autoRebuy
      ? `Tops you back to ${cash(amount)} whenever you drop below ${cash(stake.bb * 40)}.`
      : 'You will be asked before any top-up.',
  );

  const cta = Button({
    label: `Sit down · ${cash(amount)}`,
    variant: 'primary',
    size: 'lg',
    full: true,
    haptic: 'bet',
  });

  const body = h(
    'div',
    { class: 'bi' },
    h(
      'div',
      { class: 'bi__readout' },
      h('div', { class: 'bi__amtwrap' }, amountEl, bbEl),
      h(
        'div',
        { class: 'bi__blindbox' },
        h('span', { class: 'caps' }, 'Blinds'),
        h('b', { class: 'tnum' }, stake.label),
      ),
    ),
    h('div', { class: 'bi__bar' }, barFill, barAvg, h('i', { class: 'bi__baravgl' })),
    h('div', { class: 'bi__barrow' }, barLabel),
    h(
      'div',
      { class: 'bi__sliderwrap' },
      slider,
      h(
        'div',
        { class: 'bi__ticks' },
        ...[40, 100, 250]
          .filter((bb) => stake.bb * bb >= min && stake.bb * bb <= max)
          .map((bb) => {
            const v = stake.bb * bb;
            const f = (v - min) / Math.max(1e-6, max - min);
            return h(
              'span',
              { class: 'bi__tick tnum', style: { left: `${(f * 100).toFixed(2)}%` } },
              `${bb}bb`,
            );
          }),
      ),
    ),
    presetRow,
    h(
      'div',
      { class: 'bi__rows' },
      h(
        'div',
        { class: 'bi__row' },
        h('span', { class: 'bi__rowic' }, icon('refresh', { size: 17, stroke: 1.9 })),
        h('span', { class: 'bi__rowmain' }, h('span', { class: 'bi__rowt' }, 'Auto rebuy'), rebuyNote),
        rebuyToggle,
      ),
      h(
        'div',
        { class: 'bi__row bi__row--static' },
        h('span', { class: 'bi__rowic' }, icon('shield', { size: 17, stroke: 1.9 })),
        h(
          'span',
          { class: 'bi__rowmain' },
          h('span', { class: 'bi__rowt' }, 'Your balance'),
          h('span', { class: 'bi__rowsub tnum' }, `${cash(opts.bankroll)} available`),
        ),
        noteEl,
      ),
    ),
  );

  const sheet = openSheet({
    eyebrow: modeLabel(opts.mode),
    title: 'Buy in',
    subtitle:
      opts.seatsOpen && opts.seatsOpen > 0
        ? `${stake.label} · ${opts.seatsOpen} seats open right now`
        : `${stake.label} · 6-max`,
    class: 'sheet--buyin',
    content: body,
    footer: cta,
  });

  cta.addEventListener('click', () => {
    if (sheet.closed()) return;
    opts.onConfirm(amount, autoRebuy);
    sheet.close();
  });

  setAmount(amount, false);
  return sheet;
}

/**
 * The locked-level explainer. Same sheet furniture, but it teaches the rule
 * and offers the rail instead of dead-ending.
 */
export interface LockedOpts {
  stake: Stake;
  required: number;
  remaining: number;
  progress: number;
  onWatch(): void;
  onPickLower(): void;
}

export function openLockedStake(opts: LockedOpts): SheetHandle {
  const { stake } = opts;
  const fill = h('i', { class: 'bl__fill', style: { transform: `scaleX(${opts.progress.toFixed(4)})` } });

  const body = h(
    'div',
    { class: 'bl' },
    h(
      'div',
      { class: 'bl__art', 'aria-hidden': 'true' },
      h('span', { class: 'bl__ring' }),
      h('span', { class: 'bl__lock' }, icon('lock', { size: 30, stroke: 1.7 })),
    ),
    h('p', { class: 'bl__body' },
      'Move up when the roll can absorb a downswing — ',
      h('b', null, '30 full buy-ins'),
      ` is the cushion we suggest for ${stake.label}. Nothing is stopping you from railing the games and watching how they play in the meantime.`,
    ),
    h(
      'div',
      { class: 'bl__meterwrap' },
      h('div', { class: 'bl__meter' }, fill),
      h(
        'div',
        { class: 'bl__meterrow' },
        h('span', { class: 'tnum' }, `${Math.round(opts.progress * 100)}%`),
        h('span', { class: 'tnum' }, `${cash(opts.remaining)} more · ${cash(opts.required)} total`),
      ),
    ),
    h(
      'div',
      { class: 'bl__actions' },
      Button({
        label: 'Watch from the rail',
        variant: 'secondary',
        size: 'md',
        full: true,
        icon: icon('eye', { size: 17, stroke: 1.9 }),
        onTap: () => {
          opts.onWatch();
          handle.close();
        },
      }),
      Button({
        label: 'Play the level below',
        variant: 'primary',
        size: 'md',
        full: true,
        onTap: () => {
          opts.onPickLower();
          handle.close();
        },
      }),
    ),
  );

  const handle = openSheet({
    eyebrow: 'Bankroll cushion',
    title: `${stake.label} is not open yet`,
    class: 'sheet--locked',
    content: body,
  });
  return handle;
}
