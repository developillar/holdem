/**
 * ROYALE — social/handeval.ts
 * ────────────────────────────────────────────────────────────────────────────
 * A self-contained 5-from-7 (and 2-from-4 + 3-from-5 for Omaha) evaluator.
 *
 * The engine has its own optimised evaluator, but the social layer must never
 * import across subsystems — and it needs exactly one thing the engine's fast
 * path does not expose to us: a *human* label for an arbitrary set of cards so
 * a generated post can be described by what its cards actually are. This is
 * the small, honest version: it enumerates combinations (21 for hold'em, 60
 * for Omaha), which is far below any budget that matters for ~40 seeded posts.
 *
 * The score packs category and five kickers into a single integer, so
 * `a.value > b.value` is a total order over every hand.
 */
import type { CardId, HandCategory, HandRank, Rank } from '../core/types.ts';
import { cardRank, cardSuit } from '../core/types.ts';

const CAT_INDEX: Record<HandCategory, number> = {
  'high-card': 0,
  pair: 1,
  'two-pair': 2,
  trips: 3,
  straight: 4,
  flush: 5,
  'full-house': 6,
  quads: 7,
  'straight-flush': 8,
};

const CATS: HandCategory[] = [
  'high-card', 'pair', 'two-pair', 'trips', 'straight',
  'flush', 'full-house', 'quads', 'straight-flush',
];

const B = 15;
const P5 = B * B * B * B * B;

export const RANK_WORD: Record<number, string> = {
  2: 'Deuce', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven',
  8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};

export const RANK_PLURAL: Record<number, string> = {
  2: 'Deuces', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens',
  8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces',
};

/** Score exactly five cards. Returns the packed value and its category. */
function score5(cards: CardId[]): { value: number; category: HandCategory; ordered: CardId[] } {
  const ranks = cards.map(cardRank);
  const suits = cards.map(cardSuit);
  const flush = suits[0] === suits[1] && suits[1] === suits[2] && suits[2] === suits[3] && suits[3] === suits[4];

  // rank -> count
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);

  // Sort groups by (count desc, rank desc) — that is exactly kicker order.
  const groups = Array.from(counts.entries()).sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));

  const distinct = groups.map((g) => g[0]).sort((a, b) => b - a);
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (distinct[0] - distinct[4] === 4) straightHigh = distinct[0];
    else if (distinct[0] === 14 && distinct[1] === 5 && distinct[4] === 2) straightHigh = 5; // the wheel
  }

  let category: HandCategory;
  let kickers: number[];

  if (straightHigh && flush) {
    category = 'straight-flush';
    kickers = [straightHigh, 0, 0, 0, 0];
  } else if (groups[0][1] === 4) {
    category = 'quads';
    kickers = [groups[0][0], groups[1][0], 0, 0, 0];
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = 'full-house';
    kickers = [groups[0][0], groups[1][0], 0, 0, 0];
  } else if (flush) {
    category = 'flush';
    kickers = distinct.concat([0, 0, 0, 0, 0]).slice(0, 5);
  } else if (straightHigh) {
    category = 'straight';
    kickers = [straightHigh, 0, 0, 0, 0];
  } else if (groups[0][1] === 3) {
    category = 'trips';
    kickers = [groups[0][0], groups[1][0], groups[2][0], 0, 0];
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = 'two-pair';
    kickers = [groups[0][0], groups[1][0], groups[2][0], 0, 0];
  } else if (groups[0][1] === 2) {
    category = 'pair';
    kickers = [groups[0][0], groups[1][0], groups[2][0], groups[3][0], 0];
  } else {
    category = 'high-card';
    kickers = distinct.slice(0, 5);
  }

  let value = CAT_INDEX[category] * P5;
  for (let i = 0; i < 5; i++) value += (kickers[i] ?? 0) * Math.pow(B, 4 - i);

  // Best-first ordering of the physical cards: group members first, then
  // kickers, so the "winning five" reads correctly in a replay.
  const order: CardId[] = [];
  if (category === 'straight' || category === 'straight-flush') {
    const wheel = straightHigh === 5;
    const want = wheel ? [5, 4, 3, 2, 14] : [straightHigh, straightHigh - 1, straightHigh - 2, straightHigh - 3, straightHigh - 4];
    for (const w of want) {
      const c = cards.find((cc) => cardRank(cc) === w && !order.includes(cc));
      if (c !== undefined) order.push(c);
    }
  } else {
    for (const [r] of groups) {
      for (const c of cards) if (cardRank(c) === r && !order.includes(c)) order.push(c);
    }
  }
  while (order.length < 5) {
    const c = cards.find((cc) => !order.includes(cc));
    if (c === undefined) break;
    order.push(c);
  }

  return { value, category, ordered: order };
}

function* combinations(n: number, k: number): Generator<number[]> {
  const idx: number[] = [];
  for (let i = 0; i < k; i++) idx.push(i);
  while (true) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

const COMBO_CACHE = new Map<string, number[][]>();
function combos(n: number, k: number): number[][] {
  const key = `${n}:${k}`;
  let out = COMBO_CACHE.get(key);
  if (!out) {
    out = Array.from(combinations(n, k));
    COMBO_CACHE.set(key, out);
  }
  return out;
}

/** Best five-card hand from any pile of ≥5 cards (Texas rules). */
export function bestOf(cards: CardId[]): HandRank {
  if (cards.length < 5) {
    // Not a real hand yet — describe what is there so the UI still reads.
    const ranks = cards.map(cardRank).sort((a, b) => b - a);
    return {
      value: 0,
      category: 'high-card',
      best: cards.slice(),
      label: ranks.length ? `${RANK_WORD[ranks[0]]} high` : 'No cards',
    };
  }
  let bestValue = -1;
  let bestCat: HandCategory = 'high-card';
  let bestCards: CardId[] = [];
  for (const c of combos(cards.length, 5)) {
    const pick = [cards[c[0]], cards[c[1]], cards[c[2]], cards[c[3]], cards[c[4]]];
    const s = score5(pick);
    if (s.value > bestValue) {
      bestValue = s.value;
      bestCat = s.category;
      bestCards = s.ordered;
    }
  }
  return { value: bestValue, category: bestCat, best: bestCards, label: labelFor(bestCat, bestCards) };
}

/** Omaha: exactly two hole cards and exactly three board cards. */
export function bestOmaha(hole: CardId[], board: CardId[]): HandRank {
  if (board.length < 3 || hole.length < 2) return bestOf(hole.concat(board));
  let bestValue = -1;
  let bestCat: HandCategory = 'high-card';
  let bestCards: CardId[] = [];
  for (const hc of combos(hole.length, 2)) {
    for (const bc of combos(board.length, 3)) {
      const pick = [hole[hc[0]], hole[hc[1]], board[bc[0]], board[bc[1]], board[bc[2]]];
      const s = score5(pick);
      if (s.value > bestValue) {
        bestValue = s.value;
        bestCat = s.category;
        bestCards = s.ordered;
      }
    }
  }
  return { value: bestValue, category: bestCat, best: bestCards, label: labelFor(bestCat, bestCards) };
}

/** Dispatch on variant. */
export function evaluate(hole: CardId[], board: CardId[], omaha: boolean): HandRank {
  return omaha ? bestOmaha(hole, board) : bestOf(hole.concat(board));
}

/**
 * The human label. This is what appears under a hand snapshot in the feed and
 * in the replay's showdown row, so it is written the way a commentator says
 * it — "Aces full of Fours", not "FULL_HOUSE".
 */
export function labelFor(category: HandCategory, best: CardId[]): string {
  const r = best.map(cardRank);
  switch (category) {
    case 'straight-flush':
      return r[0] === 14 ? 'Royal Flush' : `${RANK_WORD[r[0]]}-high Straight Flush`;
    case 'quads':
      return `Quad ${RANK_PLURAL[r[0]]}`;
    case 'full-house':
      return `${RANK_PLURAL[r[0]]} full of ${RANK_PLURAL[r[3]]}`;
    case 'flush':
      return `${RANK_WORD[r[0]]}-high Flush`;
    case 'straight':
      if (r[0] === 14) return 'Broadway';
      if (r[0] === 5) return 'The Wheel';
      return `${RANK_WORD[r[0]]}-high Straight`;
    case 'trips':
      return `Trip ${RANK_PLURAL[r[0]]}`;
    case 'two-pair':
      return `${RANK_PLURAL[r[0]]} and ${RANK_PLURAL[r[2]]}`;
    case 'pair':
      return `Pair of ${RANK_PLURAL[r[0]]}`;
    default:
      return `${RANK_WORD[r[0]]} high`;
  }
}

/** Rank strength ordering used to decide whether an upset counts as a beat. */
export function categoryIndex(category: HandCategory): number {
  return CAT_INDEX[category];
}

export function categoryAt(index: number): HandCategory {
  return CATS[Math.max(0, Math.min(CATS.length - 1, index))];
}

/** Short two-character notation, e.g. "AKs" / "77" — used in headlines. */
export function holeNotation(hole: CardId[]): string {
  if (hole.length < 2) return '';
  const sorted = hole.slice(0, 2).sort((a, b) => cardRank(b) - cardRank(a));
  const [a, b] = sorted;
  const ra = cardRank(a);
  const rb = cardRank(b);
  const sym = (x: Rank) => (x === 10 ? 'T' : x >= 11 ? ['J', 'Q', 'K', 'A'][x - 11] : String(x));
  if (ra === rb) return `${sym(ra)}${sym(rb)}`;
  return `${sym(ra)}${sym(rb)}${cardSuit(a) === cardSuit(b) ? 's' : 'o'}`;
}
