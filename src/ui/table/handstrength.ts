/**
 * Live hand-strength readout.
 *
 * Two things live here: a self-contained 5-of-7 evaluator (the table screen
 * must be able to name the hero's hand even when the engine module is
 * unavailable), and the DOM strip that sits above the action bar showing
 * "Two Pair, Aces and Nines" with a quiet draw/outs/equity chip beside it.
 *
 * Purists can switch the whole thing off; the preference persists.
 */

import { cardRank, cardSuit, RANKS } from '../../core/types.ts';
import type { CardId, HandCategory, HandRank, Street } from '../../core/types.ts';
import { h, readSetting, setText, writeSetting, cls } from './dom.ts';

// ═══════════════════════════ evaluator ═══════════════════════════

const RANK_WORD = [
  'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace',
];
const RANK_PLURAL = [
  'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
];

const CATEGORIES: HandCategory[] = [
  'high-card', 'pair', 'two-pair', 'trips', 'straight',
  'flush', 'full-house', 'quads', 'straight-flush',
];

/** Every 5-card subset of 7 cards, precomputed once. */
const COMBOS_7: number[][] = (() => {
  const out: number[][] = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();

function encode(cat: number, kickers: number[]): number {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 15 + (kickers[i] ?? 0);
  return v;
}

/** Scores exactly five cards. Higher is strictly better. */
function score5(cards: readonly CardId[]): number {
  const ranks: number[] = [];
  let suitMask = 0;
  for (let i = 0; i < 5; i++) {
    ranks.push(cardRank(cards[i]));
    suitMask |= 1 << cardSuit(cards[i]);
  }
  ranks.sort((a, b) => b - a);
  const flush = suitMask === 1 || suitMask === 2 || suitMask === 4 || suitMask === 8;

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = Array.from(counts.entries()).sort((x, y) => y[1] - x[1] || y[0] - x[0]);

  let straightHigh = 0;
  if (counts.size === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) straightHigh = 5;
  }

  if (flush && straightHigh) return encode(8, [straightHigh]);
  if (groups[0][1] === 4) return encode(7, [groups[0][0], groups[1][0]]);
  if (groups[0][1] === 3 && groups[1][1] >= 2) return encode(6, [groups[0][0], groups[1][0]]);
  if (flush) return encode(5, ranks);
  if (straightHigh) return encode(4, [straightHigh]);
  if (groups[0][1] === 3) return encode(3, [groups[0][0], groups[1][0], groups[2][0]]);
  if (groups[0][1] === 2 && groups[1][1] === 2) return encode(2, [groups[0][0], groups[1][0], groups[2][0]]);
  if (groups[0][1] === 2) return encode(1, [groups[0][0], groups[1][0], groups[2][0], groups[3][0]]);
  return encode(0, ranks);
}

function categoryOf(value: number): HandCategory {
  return CATEGORIES[Math.min(8, Math.floor(value / 759375))];
}

/** Best five-card hand from five to seven cards. */
export function evalBest(cards: readonly CardId[]): HandRank {
  if (cards.length < 5) {
    return { value: -1, category: 'high-card', best: cards.slice(), label: '' };
  }
  let bestValue = -1;
  let bestCards: CardId[] = [];
  if (cards.length === 5) {
    bestValue = score5(cards);
    bestCards = cards.slice();
  } else if (cards.length === 7) {
    const pick: CardId[] = [0, 0, 0, 0, 0];
    for (let i = 0; i < COMBOS_7.length; i++) {
      const combo = COMBOS_7[i];
      for (let j = 0; j < 5; j++) pick[j] = cards[combo[j]];
      const v = score5(pick);
      if (v > bestValue) {
        bestValue = v;
        bestCards = pick.slice();
      }
    }
  } else {
    // 6 cards (or PLO subsets) — walk every 5-subset generically.
    const n = cards.length;
    const idx = [0, 1, 2, 3, 4];
    const pick: CardId[] = [0, 0, 0, 0, 0];
    for (;;) {
      for (let j = 0; j < 5; j++) pick[j] = cards[idx[j]];
      const v = score5(pick);
      if (v > bestValue) {
        bestValue = v;
        bestCards = pick.slice();
      }
      let k = 4;
      while (k >= 0 && idx[k] === n - 5 + k) k--;
      if (k < 0) break;
      idx[k]++;
      for (let j = k + 1; j < 5; j++) idx[j] = idx[j - 1] + 1;
    }
  }
  const category = categoryOf(bestValue);
  return {
    value: bestValue,
    category,
    best: bestCards.slice().sort((a, b) => cardRank(b) - cardRank(a)),
    label: labelFor(bestValue, bestCards),
  };
}

/** "Two Pair, Aces and Nines" — the phrasing a dealer would use. */
export function labelFor(value: number, cards: readonly CardId[]): string {
  const cat = categoryOf(value);
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = Array.from(counts.entries()).sort((x, y) => y[1] - x[1] || y[0] - x[0]);
  const word = (r: number): string => RANK_WORD[r - 2];
  const plural = (r: number): string => RANK_PLURAL[r - 2];

  switch (cat) {
    case 'straight-flush':
      return ranks[0] === 14 && ranks[4] === 10 ? 'Royal Flush' : `Straight Flush, ${word(straightTop(ranks))} High`;
    case 'quads':
      return `Four of a Kind, ${plural(groups[0][0])}`;
    case 'full-house':
      return `Full House, ${plural(groups[0][0])} over ${plural(groups[1][0])}`;
    case 'flush':
      return `Flush, ${word(ranks[0])} High`;
    case 'straight':
      return `Straight, ${word(straightTop(ranks))} High`;
    case 'trips':
      return `Three of a Kind, ${plural(groups[0][0])}`;
    case 'two-pair':
      return `Two Pair, ${plural(groups[0][0])} and ${plural(groups[1][0])}`;
    case 'pair':
      return `Pair of ${plural(groups[0][0])}`;
    default:
      return `${word(ranks[0])} High`;
  }
}

function straightTop(ranks: number[]): number {
  return ranks[0] === 14 && ranks[1] === 5 ? 5 : ranks[0];
}

/** Compact form for dense chrome: "Two Pair", "Flush". */
export function shortLabel(cat: HandCategory): string {
  switch (cat) {
    case 'straight-flush': return 'Straight Flush';
    case 'quads': return 'Quads';
    case 'full-house': return 'Full House';
    case 'two-pair': return 'Two Pair';
    case 'trips': return 'Trips';
    case 'high-card': return 'High Card';
    default: return cat.charAt(0).toUpperCase() + cat.slice(1);
  }
}

// ═══════════════════════════ insight ═══════════════════════════

export interface HandInsight {
  /** null before the flop */
  rank: HandRank | null;
  label: string;
  /** 0..1 — drives the strength meter */
  strength: number;
  /** cards that make the hand, for board highlighting */
  best: CardId[];
  outs: number;
  /** 0..1 rough equity for the draw, rule-of-2/4 */
  equity: number;
  draw: string | null;
  nuts: boolean;
}

const PREFLOP_LABEL = (hole: readonly CardId[]): string => {
  if (hole.length < 2) return 'Waiting for cards';
  const a = cardRank(hole[0]);
  const b = cardRank(hole[1]);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi === lo) return `Pocket ${RANK_PLURAL[hi - 2]}`;
  const suited = cardSuit(hole[0]) === cardSuit(hole[1]);
  return `${RANK_WORD[hi - 2]}-${RANK_WORD[lo - 2]} ${suited ? 'Suited' : 'Offsuit'}`;
};

/** Chen-style preflop score, normalised — good enough for a strength meter. */
function preflopStrength(hole: readonly CardId[]): number {
  if (hole.length < 2) return 0;
  const a = cardRank(hole[0]);
  const b = cardRank(hole[1]);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const pts = (r: number): number => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let score = pts(hi);
  if (hi === lo) score = Math.max(5, score * 2);
  if (cardSuit(hole[0]) === cardSuit(hole[1])) score += 2;
  const gap = hi - lo - 1;
  if (hi !== lo) {
    score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && hi < 12) score += 1;
  }
  return Math.max(0, Math.min(1, (Math.ceil(score) + 1) / 21));
}

const CATEGORY_STRENGTH: Record<HandCategory, number> = {
  'high-card': 0.1,
  pair: 0.3,
  'two-pair': 0.5,
  trips: 0.64,
  straight: 0.75,
  flush: 0.84,
  'full-house': 0.91,
  quads: 0.97,
  'straight-flush': 1,
};

/**
 * Full read on the hero's holding. Outs are counted honestly: an unseen card
 * counts only if it lifts the hand to a strictly better category *and* clears
 * one pair, which is what a player means when they say "nine outs".
 */
export function analyze(hole: readonly CardId[], board: readonly CardId[]): HandInsight {
  if (hole.length < 2) {
    return { rank: null, label: 'Waiting for cards', strength: 0, best: [], outs: 0, equity: 0, draw: null, nuts: false };
  }
  if (board.length < 3) {
    return {
      rank: null,
      label: PREFLOP_LABEL(hole),
      strength: preflopStrength(hole),
      best: hole.slice(),
      outs: 0,
      equity: 0,
      draw: null,
      nuts: cardRank(hole[0]) === 14 && cardRank(hole[1]) === 14,
    };
  }

  const all = hole.concat(board);
  const rank = evalBest(all);
  const madeCat = CATEGORIES.indexOf(rank.category);

  // ── outs on the unseen deck
  const seen = new Set<number>(all);
  const toCome = board.length >= 5 ? 0 : board.length === 4 ? 1 : 2;
  let outs = 0;
  const suitOuts = new Set<number>();
  const rankOuts = new Set<number>();

  if (toCome > 0) {
    for (let c = 0; c < 52; c++) {
      if (seen.has(c)) continue;
      const next = evalBest(all.concat(c));
      const cat = CATEGORIES.indexOf(next.category);
      if (cat > madeCat && cat >= 2) {
        outs++;
        suitOuts.add(cardSuit(c));
        rankOuts.add(cardRank(c));
      }
    }
  }

  let draw: string | null = null;
  if (outs > 0) {
    const flushish = suitOuts.size === 1 && outs >= 7;
    if (outs >= 12) draw = 'Monster draw';
    else if (flushish) draw = 'Flush draw';
    else if (rankOuts.size >= 2 && outs >= 6) draw = 'Open-ended';
    else if (outs <= 4 && rankOuts.size <= 2) draw = madeCat >= 1 ? 'Improving' : 'Gutshot';
    else draw = 'Draw';
  }

  // Rule of 4 and 2 — the arithmetic players actually run at the table.
  const equity = Math.min(0.95, (outs * (toCome === 2 ? 4 : 2)) / 100);

  let strength = CATEGORY_STRENGTH[rank.category];
  if (rank.category === 'pair') {
    // A pair is only worth something relative to the board.
    const boardHigh = Math.max(...board.map(cardRank));
    const pairRank = pairRankOf(rank.best);
    strength = pairRank >= boardHigh ? 0.38 : 0.22;
  }
  strength = Math.min(1, strength + equity * 0.22);

  return {
    rank,
    label: rank.label,
    strength,
    best: rank.best,
    outs,
    equity,
    draw,
    nuts: isNuts(rank, board),
  };
}

function pairRankOf(best: readonly CardId[]): number {
  const counts = new Map<number, number>();
  for (const c of best) {
    const r = cardRank(c);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let top = 0;
  for (const [r, n] of counts) if (n >= 2 && r > top) top = r;
  return top;
}

/** True when no unseen two-card combination beats this hand. */
function isNuts(rank: HandRank, board: readonly CardId[]): boolean {
  if (board.length < 5) return false;
  // Only worth the exhaustive check once the hand is plausibly unbeatable —
  // this keeps the river update well inside a frame.
  if (CATEGORIES.indexOf(rank.category) < 4) return false;
  const seen = new Set<number>(board.concat(rank.best));
  const free: number[] = [];
  for (let c = 0; c < 52; c++) if (!seen.has(c)) free.push(c);
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      if (evalBest(board.concat(free[i], free[j])).value > rank.value) return false;
    }
  }
  return true;
}

// ═══════════════════════════ view ═══════════════════════════

export interface HandStrengthView {
  el: HTMLElement;
  /** Feed the current hero holding; pass an empty board preflop. */
  update(hole: readonly CardId[], board: readonly CardId[], street: Street): void;
  setVisible(on: boolean): void;
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** Latest insight — the winner banner and board highlighting reuse it. */
  insight(): HandInsight | null;
  dispose(): void;
}

const SETTING_KEY = 'handStrength';

export function handStrengthEnabled(): boolean {
  return readSetting<boolean>(SETTING_KEY, true);
}

export function createHandStrength(): HandStrengthView {
  const meterFill = h('i', { class: 'hs__fill' });
  const meter = h('div', { class: 'hs__meter', 'aria-hidden': 'true' }, meterFill);
  const label = h('div', { class: 'hs__label' }, 'Waiting for cards');
  const outsEl = h('div', { class: 'hs__outs tnum' });
  const drawEl = h('div', { class: 'hs__draw' });
  const rightEl = h('div', { class: 'hs__right' }, drawEl, outsEl);
  const el = h('div', { class: 'hs', role: 'status', 'aria-live': 'polite' }, meter, label, rightEl);

  let on = handStrengthEnabled();
  let visible = false;
  let last: HandInsight | null = null;
  let lastKey = '';
  cls(el, 'is-off', !on);

  const paint = (ins: HandInsight): void => {
    meterFill.style.transform = `scaleX(${Math.max(0.02, ins.strength).toFixed(3)})`;
    meterFill.dataset.tier =
      ins.strength >= 0.82 ? 'nuts' : ins.strength >= 0.55 ? 'strong' : ins.strength >= 0.32 ? 'mid' : 'weak';
    setText(label, ins.nuts ? `${ins.label} · NUTS` : ins.label);
    cls(el, 'is-nuts', ins.nuts);
    if (ins.draw && ins.outs > 0) {
      setText(drawEl, ins.draw);
      setText(outsEl, `${ins.outs} out${ins.outs === 1 ? '' : 's'} · ${Math.round(ins.equity * 100)}%`);
      cls(rightEl, 'is-shown', true);
    } else {
      cls(rightEl, 'is-shown', false);
    }
  };

  return {
    el,
    update(hole, board): void {
      const key = `${hole.join(',')}|${board.join(',')}`;
      if (key === lastKey) return;
      lastKey = key;
      if (hole.length < 2) {
        last = null;
        cls(el, 'is-shown', false);
        return;
      }
      last = analyze(hole, board);
      cls(el, 'is-shown', visible && on);
      paint(last);
    },
    setVisible(v: boolean): void {
      visible = v;
      cls(el, 'is-shown', v && on && !!last);
    },
    setEnabled(v: boolean): void {
      on = v;
      writeSetting(SETTING_KEY, v);
      cls(el, 'is-off', !v);
      cls(el, 'is-shown', visible && v && !!last);
    },
    enabled: () => on,
    insight: () => last,
    dispose(): void {
      el.remove();
    },
  };
}
