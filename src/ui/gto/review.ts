/**
 * ROYALE — ui/gto/review.ts
 * ────────────────────────────────────────────────────────────────────────────
 * "Review my play" — takes a real `HandReplay` and scores every postflop
 * decision the hero made, street by street, using exactly the same solver the
 * drills use. Preflop is skipped because a replay does not carry the ranges
 * the seats were actually playing.
 *
 * The converter walks the replay's action list, rebuilding the pot and the bet
 * facing the hero at each of their turns, then maps the recorded action onto
 * the closest sizing the model offers. When no replay is supplied the screen
 * builds a seeded sample hand and runs it through the same converter, so the
 * mode is never an empty state and the conversion path is always exercised.
 */

import { h, cx, clear } from '../dom.ts';
import { icon } from '../components/icons.ts';
import { Button } from '../components/button.ts';
import { EmptyState } from '../components/empty.ts';
import type { Action, CardId, HandReplay, PositionName, Street } from '../../core/types.ts';
import { Rng } from '../../core/rng.ts';
import { reviewHand } from '../../gto/drills.ts';
import { sizesFor } from '../../gto/solver.ts';
import type { ReviewDecision, ReviewInput } from '../../gto/drills.ts';
import { seatsFor } from '../../gto/ranges.ts';
import { BoardRow, CardRow, cardText } from './cards.ts';
import { FreqBars } from './freqbar.ts';

// ─────────────────────── replay → review input ───────────────────────

function bbFromLabel(label: string): number {
  const nums = label.match(/[\d.]+/g);
  if (!nums || !nums.length) return 1;
  const bb = Number(nums[nums.length - 1]);
  return Number.isFinite(bb) && bb > 0 ? bb : 1;
}

function positionOf(seat: number, buttonSeat: number, count: number): PositionName {
  const seats = seatsFor(count >= 8 ? 9 : 6);
  // The button is the second-to-last name in the list; walk backwards from it.
  const btnIndex = seats.indexOf('BTN');
  const offset = (seat - buttonSeat + count) % count;
  return seats[(btnIndex + offset) % seats.length];
}

/**
 * Maps a recorded action onto an action id the model actually offers on that
 * street. Sizing menus differ street to street, so a river ¾-pot bet and a
 * flop ¾-pot bet are not the same id — mapping to an id the node does not
 * contain would score the decision against nothing.
 */
function actionId(action: Action, street: Street, potBb: number, facingBb: number): string {
  switch (action.kind) {
    case 'fold':
      return 'fold';
    case 'check':
      return 'check';
    case 'call':
      return 'call';
    case 'allin':
    case 'raise':
      return facingBb > 0 ? 'raise' : sizeId(action.amount, potBb, street);
    case 'bet':
      return sizeId(action.amount, potBb, street);
    default:
      return 'check';
  }
}

function sizeId(amountBb: number, potBb: number, street: Street): string {
  const frac = potBb > 0 ? amountBb / potBb : 0.5;
  const options = sizesFor(street).map((s) => ({ id: s.id, f: s.fraction }));
  let best = options[0];
  for (const o of options) if (Math.abs(o.f - frac) < Math.abs(best.f - frac)) best = o;
  return best.id;
}

export function replayToReview(replay: HandReplay, heroSeat: number): ReviewInput | null {
  const heroEntry = replay.seats.find((s) => s.seat === heroSeat);
  if (!heroEntry?.holeCards?.length) return null;
  const bb = bbFromLabel(replay.stakeLabel);
  const count = replay.seats.length;
  const heroPos = positionOf(heroSeat, replay.buttonSeat, count);

  const committed = new Map<number, number>();
  let street: Street = 'preflop';
  let pot = 0;
  const steps: ReviewInput['steps'] = [];

  const boardFor = (s: Street): CardId[] =>
    s === 'flop' ? replay.board.slice(0, 3) : s === 'turn' ? replay.board.slice(0, 4) : replay.board.slice(0, 5);

  for (const action of replay.actions) {
    if (action.street !== street) {
      street = action.street;
      committed.clear();
    }
    const mine = committed.get(action.seat) ?? 0;
    const top = Math.max(0, ...Array.from(committed.values()));
    const facing = Math.max(0, top - mine);

    if (action.seat === heroSeat && street !== 'preflop' && street !== 'showdown') {
      steps.push({
        street,
        board: boardFor(street),
        potBb: pot / bb,
        facingBb: facing / bb,
        chosen: actionId(action, street, pot / bb, facing / bb),
      });
    }
    committed.set(action.seat, mine + action.amount);
    pot += action.amount;
  }

  if (!steps.length) return null;
  const villain = replay.seats.find((s) => s.seat !== heroSeat);
  return {
    variant: replay.variant,
    tableSize: count >= 8 ? 9 : 6,
    heroPos,
    hero: heroEntry.holeCards,
    villainPos: villain ? positionOf(villain.seat, replay.buttonSeat, count) : 'BB',
    bbSize: bb,
    steps,
  };
}

// ─────────────────────── sample hand ───────────────────────

/**
 * A seeded hand that exercises all three postflop streets. Real replays plug
 * into the same converter; this exists so the screen has content on day one.
 */
export function sampleReplay(seed = 0xc0ffee): HandReplay {
  const rng = new Rng(seed);
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  rng.shuffle(deck);
  const hero = [deck[0], deck[1]];
  const villain = [deck[2], deck[3]];
  const board = deck.slice(4, 9);

  const mk = (kind: Action['kind'], amount: number, seat: number, seq: number, street: Street): Action =>
    ({ kind, amount, seat, seq, street });

  return {
    handId: 1,
    variant: 'nlhe',
    stakeLabel: '$0.50/$1',
    seats: [
      { seat: 0, name: 'You', avatarId: 'a1', startStack: 100, holeCards: hero },
      { seat: 1, name: 'Villain', avatarId: 'a2', startStack: 100, holeCards: villain },
    ],
    buttonSeat: 0,
    board,
    actions: [
      mk('post', 0.5, 0, 0, 'preflop'),
      mk('post', 1, 1, 1, 'preflop'),
      mk('raise', 2.5, 0, 2, 'preflop'),
      mk('call', 1.5, 1, 3, 'preflop'),
      mk('check', 0, 1, 4, 'flop'),
      mk('bet', 1.8, 0, 5, 'flop'),
      mk('call', 1.8, 1, 6, 'flop'),
      mk('check', 0, 1, 7, 'turn'),
      mk('bet', 6.2, 0, 8, 'turn'),
      mk('call', 6.2, 1, 9, 'turn'),
      mk('check', 0, 1, 10, 'river'),
      mk('bet', 14, 0, 11, 'river'),
      mk('fold', 0, 1, 12, 'river'),
    ],
    results: [],
    potTotal: 22,
  };
}

// ─────────────────────── the panel ───────────────────────

export interface ReviewPanelOpts {
  replay?: HandReplay | null;
  heroSeat?: number;
  onBack(): void;
}

export function ReviewPanel(opts: ReviewPanelOpts): HTMLElement {
  const el = h('section', { class: 'tr-review', 'aria-label': 'Hand review' });
  let usingSample = false;

  let replay = opts.replay ?? null;
  let heroSeat = opts.heroSeat ?? 0;
  if (!replay) {
    replay = sampleReplay((Math.random() * 0xffffff) >>> 0);
    heroSeat = 0;
    usingSample = true;
  }

  const input = replayToReview(replay, heroSeat);
  if (!input) {
    el.appendChild(
      EmptyState({
        art: 'cards',
        title: 'Nothing to review yet',
        body: 'Play a hand and it will show up here with every decision scored against the solution.',
        actionLabel: 'Back to drills',
        onAction: opts.onBack,
      }),
    );
    return el;
  }

  const decisions = reviewHand(input, 0x51de);
  const totalLoss = decisions.reduce((a, d) => a + d.verdict.evLossBb, 0);
  const good = decisions.filter((d) => d.verdict.correct).length;

  const head = h(
    'header',
    { class: 'tr-review__head' },
    h(
      'div',
      { class: 'tr-review__headtop' },
      h('div', null,
        h('span', { class: 'tr-review__eyebrow caps' }, usingSample ? 'Sample hand' : 'Your hand'),
        h('h2', { class: 'tr-review__title' }, 'Line review')),
      h('div', { class: cx('tr-review__score', totalLoss < 0.25 ? 'is-good' : totalLoss < 1.2 ? 'is-ok' : 'is-bad') },
        h('span', { class: 'tr-review__scorev tnum' }, `−${totalLoss.toFixed(2)}`),
        h('span', { class: 'tr-review__scorel caps' }, 'bb lost')),
    ),
    h('div', { class: 'tr-review__hand' },
      CardRow(input.hero, { size: 'md' }),
      h('span', { class: 'tr-review__vs' }, 'on'),
      BoardRow(replay.board, { size: 'xs' })),
    h('div', { class: 'tr-review__meta' },
      `${good}/${decisions.length} decisions matched the solution · ${input.heroPos} · ${replay.stakeLabel}`),
  );
  el.appendChild(head);

  const list = h('div', { class: 'tr-review__list' });
  decisions.forEach((d, i) => list.appendChild(decisionRow(d, i, input.hero)));
  el.appendChild(list);

  el.appendChild(
    h('div', { class: 'tr-review__actions' },
      Button({ label: 'Review another hand', variant: 'secondary', full: true, onTap: () => {
        clear(el);
        el.appendChild(ReviewPanel({ onBack: opts.onBack }));
      } }),
      Button({ label: 'Back to drills', variant: 'ghost', full: true, onTap: opts.onBack })),
  );

  return el;
}

function decisionRow(d: ReviewDecision, index: number, hero: CardId[]): HTMLElement {
  const v = d.verdict;
  const bars = FreqBars({ node: v.strategy, chosen: v.chosen, showEv: true });
  const body = h('div', { class: 'tr-dec__body' },
    h('div', { class: 'tr-dec__board' }, BoardRow(d.board, { size: 'xs' })),
    bars,
    h('p', { class: 'tr-dec__why' }, v.explanation));

  let open = false;
  const chevron = icon('chevron-down', { size: 18 });
  const row = h(
    'div',
    { class: cx('tr-dec', v.correct ? 'is-good' : v.evLossBb > 0.6 ? 'is-bad' : 'is-ok'), style: { '--i': String(index) } },
    h(
      'button',
      {
        class: 'tr-dec__head',
        type: 'button',
        'aria-expanded': 'false',
        onclick: (ev: Event) => {
          open = !open;
          row.classList.toggle('is-open', open);
          (ev.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open));
          if (open) bars.reveal();
        },
      },
      h('span', { class: 'tr-dec__street caps' }, d.street),
      h('span', { class: 'tr-dec__line' },
        h('em', null, v.strategy.labels[v.chosen] ?? v.chosen),
        v.correct ? '' : ' → ',
        v.correct ? null : h('strong', null, v.strategy.labels[v.optimal] ?? v.optimal)),
      h('span', { class: cx('tr-dec__cost tnum', v.evLossBb < 0.01 && 'is-zero') },
        v.evLossBb < 0.01 ? 'ok' : `−${v.evLossBb.toFixed(2)}`),
      h('span', { class: 'tr-dec__chev', 'aria-hidden': 'true' }, chevron),
    ),
    body,
  );
  void hero;
  void cardText;
  return row;
}
