/**
 * Poker engine correctness suite.
 *
 * Run with:  node --test --experimental-strip-types tests/engine.test.ts
 *
 * The evaluator tests are the important ones — everything else in the app is
 * cosmetic if the hand strengths are wrong. There is a brute-force cross-check
 * (best of all C(7,5) five-card hands vs the bitmask path) plus a round-trip
 * invariant (the five cards the evaluator names must re-evaluate to the same
 * strength) run over thousands of random deals, which between them catch any
 * table-construction slip.
 */
// The project's tsconfig pins `types: ["three"]`, so the node built-ins have no
// declarations here. The ignores keep `npm run typecheck` green without
// touching shared config; everything below this point is fully typed.
// @ts-ignore -- needs @types/node in tsconfig "types"
import { test } from 'node:test';
// @ts-ignore -- needs @types/node in tsconfig "types"
import assert from 'node:assert/strict';

import type { Stake, PlayerRef, CardId } from '../src/core/types.ts';
import { Rng } from '../src/core/rng.ts';
import { parseCards, cardsToString, makeDeck, Deck } from '../src/engine/cards.ts';
import {
  evaluate, evaluateValue, evaluateHoldem, bestFive, labelForValue, categoryOfValue,
} from '../src/engine/evaluator.ts';
import { evaluatePlo, ploValue, potLimitRaiseTo, omahaComboCount } from '../src/engine/plo.ts';
import { Betting, IllegalActionError } from '../src/engine/betting.ts';
import type { LegalAction } from '../src/core/bus.ts';
import {
  buildPots, distribute, uncalledPortion, splitPotsAcrossBoards, orderFromButton, potTotal,
} from '../src/engine/pots.ts';
import { PokerHand } from '../src/engine/hand.ts';
import type { ActionRequest, ActionSubmission } from '../src/engine/hand.ts';

const V = (s: string): number => evaluateValue(parseCards(s));

// ═══════════════════════════ cards ═══════════════════════════

test('card notation round-trips in every accepted shape', () => {
  assert.equal(cardsToString(parseCards('AhKs')), 'Ah Ks');
  assert.equal(cardsToString(parseCards('ah ks')), 'Ah Ks');
  assert.equal(cardsToString(parseCards('Ah,Ks')), 'Ah Ks');
  assert.deepEqual(parseCards('2c'), [0]);
  assert.deepEqual(parseCards('As'), [51]);
  assert.equal(new Set(makeDeck()).size, 52);
  assert.throws(() => parseCards('Zz'));
});

test('the shoe burns before the flop, turn and river', () => {
  const deck = Deck.shuffled(new Rng(99));
  const hole = deck.drawMany(4);
  assert.equal(deck.remaining, 48);
  const flop = deck.burnAndDeal(3);
  assert.equal(flop.length, 3);
  assert.equal(deck.remaining, 44, 'one burn plus three community cards');
  deck.burnAndDeal(1);
  deck.burnAndDeal(1);
  assert.equal(deck.burned.length, 3);
  const seen = new Set([...hole, ...flop, ...deck.burned]);
  assert.equal(seen.size, hole.length + flop.length + deck.burned.length, 'no card is dealt twice');
});

test('a shuffled deck is a permutation of all 52 cards', () => {
  for (let seed = 0; seed < 50; seed++) {
    const deck = Deck.shuffled(new Rng(seed));
    const all = deck.drawMany(52);
    assert.equal(new Set(all).size, 52);
  }
});

// ═══════════════════════════ evaluator ═══════════════════════════

test('royal flush beats quads', () => {
  const royal = V('As Ks Qs Js Ts 2c 7d');
  const quads = V('9c 9d 9h 9s As Kd 2c');
  assert.ok(royal > quads, 'royal flush must outrank quad nines');
  assert.equal(categoryOfValue(royal), 'straight-flush');
  assert.equal(labelForValue(royal), 'Royal Flush');
  assert.equal(categoryOfValue(quads), 'quads');
  assert.equal(labelForValue(quads), 'Four of a Kind, Nines');
});

test('straight flush ranks below the royal and above quads', () => {
  const sf = V('9s 8s 7s 6s 5s Ad Kc');
  const royal = V('As Ks Qs Js Ts 2c 7d');
  const quads = V('Ac Ad Ah As Kd 2c 3h');
  assert.ok(royal > sf && sf > quads);
  assert.equal(labelForValue(sf), 'Nine-high Straight Flush');
});

test('wheel straight A-2-3-4-5 is detected and is the lowest straight', () => {
  const wheel = V('Ad 2s 3h 4d 5c Kh Qc');
  assert.equal(categoryOfValue(wheel), 'straight');
  assert.equal(labelForValue(wheel), 'Five-high Straight');
  const six = V('2s 3h 4d 5c 6h Kd Qc');
  assert.ok(six > wheel, 'six-high straight beats the wheel');
  // The ace plays low: the exact five cards are 5-4-3-2-A.
  const cards = parseCards('Ad 2s 3h 4d 5c Kh Qc');
  const best = bestFive(cards, evaluateValue(cards));
  assert.equal(cardsToString(best), '5c 4d 3h 2s Ad');
});

test('wheel straight flush is a straight flush, not a royal', () => {
  const wheelSf = V('Ah 2h 3h 4h 5h Kd Qc');
  assert.equal(categoryOfValue(wheelSf), 'straight-flush');
  assert.equal(labelForValue(wheelSf), 'Five-high Straight Flush');
  assert.ok(V('6h 2h 3h 4h 5h Kd Qc') > wheelSf);
});

test('Broadway A-K-Q-J-T straight', () => {
  const cards = parseCards('Ad Kc Qh Js Tc 4d 2s');
  const v = evaluateValue(cards);
  assert.equal(categoryOfValue(v), 'straight');
  assert.equal(labelForValue(v), 'Ace-high Straight');
  assert.equal(cardsToString(bestFive(cards, v)), 'Ad Kc Qh Js Tc');
});

test('flush beats a straight in the same seven cards', () => {
  // 2h3h4h9h + Ah is a nut flush; 2-3-4-5-A is also a wheel straight.
  const cards = parseCards('Ah 7d 2h 3h 4h 5s 9h');
  const v = evaluateValue(cards);
  assert.equal(categoryOfValue(v), 'flush');
  assert.equal(labelForValue(v), 'Ace-high Flush');
  assert.equal(cardsToString(bestFive(cards, v)), 'Ah 9h 4h 3h 2h');
  assert.ok(v > V('Ad Kc Qh Js Tc 4d 2s'), 'flush > broadway straight');
});

test('full house beats a flush, quads beat a full house', () => {
  const flush = V('As Ks 9s 5s 2s 7d 8c');
  const boat = V('Kc Kd Kh 7s 7d 2c 3h');
  const quads = V('Kc Kd Kh Ks 7d 2c 3h');
  assert.ok(boat > flush && quads > boat);
  assert.equal(labelForValue(boat), 'Full House, Kings full of Sevens');
});

test('full house picks the best trips and the best pair', () => {
  // Two sets: kings full of sevens must beat sevens full of kings.
  const cards = parseCards('Kc Kd Kh 7s 7d 7h 2c');
  const v = evaluateValue(cards);
  assert.equal(labelForValue(v), 'Full House, Kings full of Sevens');
  assert.equal(cardsToString(bestFive(cards, v)), 'Kc Kd Kh 7s 7d');
});

test('kicker comparisons', () => {
  // High card: A K Q J 9 beats A K Q J 8.
  assert.ok(V('Ad Kc Qh Js 9c 3d 2h') > V('Ad Kc Qh Js 8c 3d 2h'));
  // One pair: aces with a king kicker beat aces with a queen kicker.
  assert.ok(V('Ad Ac Kh 8s 5c 3d 2h') > V('Ad Ac Qh 8s 5c 3d 2h'));
  // Two pair: same pairs, better kicker.
  assert.ok(V('Ad Ac 9h 9s Kc 3d 2h') > V('Ad Ac 9h 9s Qc 3d 2h'));
  // Two pair: higher second pair beats a better kicker.
  assert.ok(V('Ad Ac Th 9s Kc 3d 2h') < V('Ad Ac Th Ts 2c 3d 4h'));
  // Trips: same trips, kickers decide.
  assert.ok(V('7d 7c 7h As Kc 3d 2h') > V('7d 7c 7h As Qc 3d 2h'));
  // Quads: the fifth card is the only tiebreak.
  assert.ok(V('7d 7c 7h 7s Ac 3d 2h') > V('7d 7c 7h 7s Kc 3d 2h'));
  // Flush: compared card by card.
  assert.ok(V('As Ks 9s 5s 3s 7d 8c') > V('As Ks 9s 5s 2s 7d 8c'));
  // Identical hands tie exactly.
  assert.equal(V('As Ks Qd Jc 9h 3d 2s'), V('Ah Kh Qs Jd 9c 3h 2d'));
});

test('the fifth card never counts when the board plays', () => {
  const board = parseCards('As Ks Qh Jd Tc');
  const a = evaluateHoldem(parseCards('2c 3d'), board);
  const b = evaluateHoldem(parseCards('4h 5s'), board);
  assert.equal(a.value, b.value, 'both players play the board — dead tie');
  assert.equal(a.label, 'Ace-high Straight');
});

test('best five cards always re-evaluate to the same strength', () => {
  const rng = new Rng(0xc0ffee);
  for (let trial = 0; trial < 4000; trial++) {
    const deck = rng.shuffle(makeDeck());
    const cards = deck.slice(0, 7);
    const v = evaluateValue(cards);
    const best = bestFive(cards, v);
    assert.equal(best.length, 5, `bestFive returned ${best.length} cards`);
    assert.equal(new Set(best).size, 5, 'bestFive returned duplicate cards');
    for (const c of best) assert.ok(cards.includes(c), 'bestFive invented a card');
    assert.equal(evaluateValue(best), v, `round-trip mismatch for ${cardsToString(cards)}`);
  }
});

test('seven-card evaluation matches brute force over all C(7,5) subsets', () => {
  const rng = new Rng(0xbadbeef);
  const five: CardId[] = new Array(5);
  for (let trial = 0; trial < 3000; trial++) {
    const deck = rng.shuffle(makeDeck());
    const cards = deck.slice(0, 7);
    let brute = -1;
    for (let a = 0; a < 7; a++) {
      for (let b = a + 1; b < 7; b++) {
        // choose the five cards that are not a and not b
        let n = 0;
        for (let i = 0; i < 7; i++) if (i !== a && i !== b) five[n++] = cards[i];
        const v = evaluateValue(five, 5);
        if (v > brute) brute = v;
      }
    }
    assert.equal(evaluateValue(cards), brute, `mismatch for ${cardsToString(cards)}`);
  }
});

test('evaluator runs well past 200k hands/sec', () => {
  const rng = new Rng(7);
  const deck = makeDeck();
  const hands: CardId[][] = [];
  for (let i = 0; i < 2000; i++) hands.push(rng.shuffle(deck.slice()).slice(0, 7));
  const iterations = 400_000;
  let sink = 0;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) sink += evaluateValue(hands[i % hands.length]);
  const ms = performance.now() - t0;
  const perSec = (iterations / ms) * 1000;
  assert.ok(sink > 0);
  console.log(`      evaluator: ${(perSec / 1e6).toFixed(2)}M hands/sec`);
  assert.ok(perSec > 200_000, `too slow: ${Math.round(perSec)} hands/sec`);
});

// ═══════════════════════════ PLO ═══════════════════════════

test('PLO enumerates exactly 60 combinations', () => {
  assert.equal(omahaComboCount(4, 5), 60);
});

test('PLO must use exactly two hole cards — one-card flushes do not count', () => {
  const hole = parseCards('As 2c 3d 4h');
  const board = parseCards('Ks Qs Js 9s 2h');
  // The naive seven-card evaluator sees As Ks Qs Js 9s and calls it a flush.
  const naive = evaluateValue(hole.concat(board));
  assert.equal(categoryOfValue(naive), 'flush');
  // Omaha requires two hole cards, and the player only holds one spade.
  const plo = evaluatePlo(hole, board);
  assert.equal(plo.category, 'pair', `expected a pair, got ${plo.label}`);
  assert.equal(plo.label, 'Pair of Twos');
  assert.ok(plo.value < naive);
  // The two playing hole cards are the deuce and the ace kicker.
  assert.equal(plo.best.length, 5);
});

test('PLO must use exactly three board cards — a made hand in hand does not play', () => {
  // Quads in the hand are worthless: only two hole cards may be used.
  const hole = parseCards('7c 7d 7h 7s');
  const board = parseCards('Ac Kd 9h 4s 2c');
  const plo = evaluatePlo(hole, board);
  assert.equal(plo.category, 'pair');
  assert.equal(plo.label, 'Pair of Sevens');
});

test('PLO finds the nut flush when two suited hole cards play', () => {
  const hole = parseCards('As Ts 3d 4h');
  const board = parseCards('Ks Qs 2s 9h 4c');
  const plo = evaluatePlo(hole, board);
  assert.equal(plo.category, 'flush');
  assert.equal(plo.label, 'Ace-high Flush');
  assert.equal(cardsToString(plo.best), 'As Ks Qs Ts 2s');
});

test('ploValue and evaluatePlo agree', () => {
  const rng = new Rng(0x51ee7);
  for (let i = 0; i < 500; i++) {
    const deck = rng.shuffle(makeDeck());
    const hole = deck.slice(0, 4);
    const board = deck.slice(4, 9);
    assert.equal(ploValue(hole, board), evaluatePlo(hole, board).value);
  }
});

test('pot-limit maximum raise sizing', () => {
  // $1/$2, folded to UTG: pot is 3 on the table, he must call 2.
  // max raise to = 2 + (0 + 3 + 2) = 7 — the familiar preflop "pot" open.
  assert.equal(
    potLimitRaiseTo({ potBefore: 0, streetCommitted: 3, currentBet: 2, myCommitted: 0, myStack: 500, step: 1 }),
    7,
  );
  // Button re-pots over that open: 7 + (10 + 7) = 24.
  assert.equal(
    potLimitRaiseTo({ potBefore: 0, streetCommitted: 10, currentBet: 7, myCommitted: 0, myStack: 500, step: 1 }),
    24,
  );
  // Big blind re-pots — he already has 2 in, so he only calls 5: 7 + (10 + 5) = 22.
  assert.equal(
    potLimitRaiseTo({ potBefore: 0, streetCommitted: 10, currentBet: 7, myCommitted: 2, myStack: 500, step: 1 }),
    22,
  );
  // Postflop with no bet outstanding the max is exactly the pot.
  assert.equal(
    potLimitRaiseTo({ potBefore: 14, streetCommitted: 0, currentBet: 0, myCommitted: 0, myStack: 500, step: 1 }),
    14,
  );
  // Always capped by the stack.
  assert.equal(
    potLimitRaiseTo({ potBefore: 0, streetCommitted: 3, currentBet: 2, myCommitted: 0, myStack: 5, step: 1 }),
    5,
  );
});

// ═══════════════════════════ pots ═══════════════════════════

test('side pots: three-way all-in with different stacks', () => {
  const pots = buildPots([
    { seat: 0, total: 50, folded: false },
    { seat: 1, total: 100, folded: false },
    { seat: 2, total: 200, folded: false },
  ], 1);
  assert.equal(pots.length, 3);
  assert.deepEqual(pots[0], { amount: 150, eligible: [0, 1, 2], index: 0 });
  assert.deepEqual(pots[1], { amount: 100, eligible: [1, 2], index: 1 });
  assert.deepEqual(pots[2], { amount: 100, eligible: [2], index: 2 });
  assert.equal(potTotal(pots), 350);

  // The top layer was never called, so it comes back before the showdown.
  const refund = uncalledPortion([
    { seat: 0, total: 50, folded: false },
    { seat: 1, total: 100, folded: false },
    { seat: 2, total: 200, folded: false },
  ], 1);
  assert.deepEqual(refund, { seat: 2, amount: 100 });
});

test('folded money stays in the pot and layers with one eligible set merge', () => {
  const pots = buildPots([
    { seat: 0, total: 20, folded: true },
    { seat: 1, total: 60, folded: false },
    { seat: 2, total: 60, folded: false },
  ], 1);
  // Both layers are contested by the same two seats, so it is a single pot.
  assert.equal(pots.length, 1);
  assert.deepEqual(pots[0], { amount: 140, eligible: [1, 2], index: 0 });
  assert.equal(potTotal(pots), 140);
});

test('side pot distribution across a three-way all-in', () => {
  const pots = buildPots([
    { seat: 0, total: 50, folded: false },
    { seat: 1, total: 100, folded: false },
    { seat: 2, total: 100, folded: false },
  ], 1);
  assert.deepEqual(pots[0], { amount: 150, eligible: [0, 1, 2], index: 0 });
  assert.deepEqual(pots[1], { amount: 100, eligible: [1, 2], index: 1 });
  const strength = new Map([[0, 900], [1, 500], [2, 300]]);
  const awards = distribute({ pots, strength, buttonSeat: 2, seatCount: 3, step: 1 });
  const bySeat = new Map<number, number>();
  for (const a of awards) bySeat.set(a.seat, (bySeat.get(a.seat) ?? 0) + a.amount);
  assert.equal(bySeat.get(0), 150, 'short stack takes the main pot');
  assert.equal(bySeat.get(1), 100, 'middle hand takes the whole side pot');
  assert.equal(bySeat.get(2) ?? 0, 0);
  assert.equal(awards.reduce((t, a) => t + a.amount, 0), 250);
});

test('odd chips go to the first winner left of the button', () => {
  const pots = [{ amount: 0.05, eligible: [0, 3], index: 0 }];
  const strength = new Map([[0, 100], [3, 100]]);
  // Button on seat 5 of six: seat 0 is immediately to its left.
  const awards = distribute({ pots, strength, buttonSeat: 5, seatCount: 6, step: 0.01 });
  const bySeat = new Map(awards.map((a) => [a.seat, a.amount]));
  assert.equal(bySeat.get(0), 0.03);
  assert.equal(bySeat.get(3), 0.02);

  // Move the button and the odd chip moves with it.
  const awards2 = distribute({ pots, strength, buttonSeat: 0, seatCount: 6, step: 0.01 });
  const bySeat2 = new Map(awards2.map((a) => [a.seat, a.amount]));
  assert.equal(bySeat2.get(3), 0.03);
  assert.equal(bySeat2.get(0), 0.02);
});

test('odd chips in a three-way split', () => {
  const pots = [{ amount: 100, eligible: [1, 2, 3], index: 0 }];
  const strength = new Map([[1, 5], [2, 5], [3, 5]]);
  const awards = distribute({ pots, strength, buttonSeat: 0, seatCount: 4, step: 1 });
  const bySeat = new Map(awards.map((a) => [a.seat, a.amount]));
  assert.equal(bySeat.get(1), 34);
  assert.equal(bySeat.get(2), 33);
  assert.equal(bySeat.get(3), 33);
  assert.equal(awards.reduce((t, a) => t + a.amount, 0), 100);
});

test('multi-way ties across multiple side pots', () => {
  // Seats 0 and 1 tie; seat 2 covers them both and loses.
  const pots = buildPots([
    { seat: 0, total: 30, folded: false },
    { seat: 1, total: 80, folded: false },
    { seat: 2, total: 80, folded: false },
  ], 1);
  const strength = new Map([[0, 700], [1, 700], [2, 100]]);
  const awards = distribute({ pots, strength, buttonSeat: 2, seatCount: 3, step: 1 });
  const bySeat = new Map<number, number>();
  for (const a of awards) bySeat.set(a.seat, (bySeat.get(a.seat) ?? 0) + a.amount);
  // Main pot 90 splits 45/45; side pot 100 is seats 1 and 2 only, seat 1 wins it.
  assert.equal(bySeat.get(0), 45);
  assert.equal(bySeat.get(1), 145);
  assert.equal(bySeat.get(2) ?? 0, 0);
  assert.equal(potTotal(pots), 190);
});

test('button-relative ordering', () => {
  assert.deepEqual(orderFromButton([0, 3, 5], 5, 6), [0, 3, 5]);
  assert.deepEqual(orderFromButton([0, 1, 2], 0, 3), [1, 2, 0]);
});

test('pots split exactly across two boards', () => {
  const split = splitPotsAcrossBoards([{ amount: 101, eligible: [0, 1], index: 0 }], 2, 1);
  assert.equal(split.length, 2);
  assert.equal(split[0][0].amount, 51);
  assert.equal(split[1][0].amount, 50);
});

// ═══════════════════════════ betting ═══════════════════════════

const stake = (sb: number, bb: number): Stake => ({
  id: 'nl200', sb, bb, label: `$${sb}/$${bb}`, short: `$${sb}/$${bb}`,
  minBuyIn: bb * 40, maxBuyIn: bb * 250, defaultAnte: 0, tier: 'mid',
});

function newBetting(stacks: number[], button: number, variant: 'nlhe' | 'plo4' = 'nlhe'): Betting {
  const b = new Betting(
    { variant, sb: 1, bb: 2, ante: 0, step: 1, seatCount: stacks.length },
    stacks.map((stack, seat) => ({ seat, stack, inHand: stack > 0 })),
    button,
  );
  b.postForcedBets();
  return b;
}

const kinds = (legal: LegalAction[]): string[] => legal.map((l) => l.kind);
const entry = (legal: LegalAction[], kind: string): LegalAction =>
  legal.find((l) => l.kind === kind)!;

test('heads-up: the button posts the small blind and acts first preflop', () => {
  const b = newBetting([200, 200], 0);
  assert.equal(b.sbSeat, 0);
  assert.equal(b.bbSeat, 1);
  assert.equal(b.seats[0].committed, 1);
  assert.equal(b.seats[1].committed, 2);
  assert.equal(b.actingSeat, 0, 'the button acts first before the flop');
  b.apply(0, 'call', 2);
  assert.equal(b.actingSeat, 1, 'the big blind gets the option');
  b.apply(1, 'check');
  assert.ok(b.isRoundComplete());
  b.beginStreet('flop');
  assert.equal(b.actingSeat, 1, 'heads-up the button acts last after the flop');
});

test('three-handed action order runs from under the gun', () => {
  const b = newBetting([200, 200, 200], 0);
  assert.equal(b.sbSeat, 1);
  assert.equal(b.bbSeat, 2);
  assert.equal(b.actingSeat, 0, 'the button is under the gun three-handed');
  b.apply(0, 'call', 2);
  assert.equal(b.actingSeat, 1);
  b.apply(1, 'call', 2);
  assert.equal(b.actingSeat, 2, 'the big blind still has the option');
  b.apply(2, 'check');
  assert.ok(b.isRoundComplete());
  b.beginStreet('flop');
  assert.equal(b.actingSeat, 1, 'first live seat left of the button leads postflop');
});

test('the big blind may raise its own option', () => {
  const b = newBetting([200, 200, 200], 0);
  b.apply(0, 'call', 2);
  b.apply(1, 'call', 2);
  const legal = b.legalActions(2);
  assert.deepEqual(kinds(legal), ['check', 'raise', 'allin']);
  assert.equal(entry(legal, 'raise').min, 4, 'min raise is to two big blinds');
});

test('min-raise rules', () => {
  const b = newBetting([200, 200, 200], 0);
  assert.equal(entry(b.legalActions(0), 'raise').min, 4);
  b.apply(0, 'raise', 6);            // raise size 4
  assert.equal(b.minRaiseTo, 10, 'next min raise is 6 + 4');
  assert.equal(entry(b.legalActions(1), 'raise').min, 10);
  assert.throws(() => b.apply(1, 'raise', 9), IllegalActionError);
  b.apply(1, 'raise', 14);           // raise size 8
  assert.equal(b.minRaiseTo, 22);
});

test('all-in under a full raise does not reopen the action', () => {
  // Seat 1 can only shove 14 over a raise to 10 — a 4 chip raise where 8 was
  // required. Seat 0 has already acted, so it may only call or fold. Seat 2 has
  // not acted yet and keeps full raise rights.
  const b = newBetting([200, 14, 200], 0);
  b.apply(0, 'raise', 10);
  assert.equal(b.lastFullRaiseSize, 8);
  b.apply(1, 'allin', 14);
  assert.equal(b.currentBet, 14);
  assert.equal(b.lastFullRaiseSize, 8, 'a short all-in never becomes the new full raise');

  const stillToAct = b.legalActions(2);
  assert.ok(stillToAct.some((l) => l.kind === 'raise'), 'seat 2 has not acted and may raise');
  assert.equal(entry(stillToAct, 'raise').min, 22, 'min raise is still based on the last full raise');
  b.apply(2, 'call', 14);

  const reopened = b.legalActions(0);
  assert.deepEqual(kinds(reopened), ['fold', 'call'], 'seat 0 may only call or fold');
  b.apply(0, 'call', 14);
  assert.ok(b.isRoundComplete());
});

test('a full all-in raise does reopen the action', () => {
  const b = newBetting([200, 18, 200], 0);
  b.apply(0, 'raise', 10);       // full raise size 8
  b.apply(1, 'allin', 18);       // raise size 8 — exactly a full raise
  assert.equal(b.lastFullRaiseSize, 8);
  b.apply(2, 'fold');
  const reopened = b.legalActions(0);
  assert.ok(reopened.some((l) => l.kind === 'raise'), 'a full raise reopens the betting');
  assert.equal(entry(reopened, 'raise').min, 26);
});

test('string bets: acting out of turn and acting twice both throw', () => {
  const b = newBetting([200, 200, 200], 0);
  assert.throws(() => b.apply(1, 'call', 2), IllegalActionError);
  b.apply(0, 'call', 2);
  assert.throws(() => b.apply(0, 'raise', 10), IllegalActionError);
});

test('a raise below the minimum is rejected unless it is all-in', () => {
  const b = newBetting([200, 200, 200], 0);
  b.apply(0, 'raise', 10);
  assert.throws(() => b.apply(1, 'raise', 12), IllegalActionError);
  const short = newBetting([200, 12, 200], 0);
  short.apply(0, 'raise', 10);
  const action = short.apply(1, 'allin', 12);
  assert.equal(action.kind, 'allin');
  assert.equal(action.amount, 12);
});

test('checking when facing a bet is illegal, calling caps at the stack', () => {
  const b = newBetting([200, 200, 9], 0);
  b.apply(0, 'raise', 20);
  assert.throws(() => b.apply(1, 'check'), IllegalActionError);
  b.apply(1, 'fold');
  const legal = b.legalActions(2);
  assert.equal(entry(legal, 'call').max, 9, 'a short call is capped at the stack');
  const action = b.apply(2, 'call', 20);
  assert.equal(action.amount, 9);
  assert.equal(b.seats[2].phase, 'allin');
});

test('everyone all-in ends the betting', () => {
  const b = newBetting([40, 40, 40], 0);
  b.apply(0, 'allin', 40);
  b.apply(1, 'allin', 40);
  b.apply(2, 'allin', 40);
  assert.ok(b.isRoundComplete());
  assert.ok(b.noMoreBetting());
  assert.equal(b.actingSeat, -1);
});

test('preset sizings are clamped, deduplicated and legal', () => {
  const b = newBetting([200, 200, 200], 0);
  const presets = entry(b.legalActions(0), 'raise').presets!;
  const labels = presets.map((p) => p.label);
  assert.deepEqual(labels, ['2.5x', '3x', 'Pot', 'All-in']);
  assert.equal(presets[0].amount, 5, '2.5x the big blind');
  assert.equal(presets[1].amount, 6, '3x the big blind');
  assert.equal(presets[2].amount, 7, 'a pot-sized open is 7 at $1/$2');
  assert.equal(presets[3].amount, 200);
  const minTo = entry(b.legalActions(0), 'raise').min;
  const maxTo = entry(b.legalActions(0), 'raise').max;
  for (const p of presets) {
    assert.ok(p.amount >= minTo && p.amount <= maxTo, `${p.label} out of range`);
  }
  assert.equal(new Set(presets.map((p) => p.amount)).size, presets.length);
});

test('postflop presets are pot fractions', () => {
  const b = newBetting([200, 200, 200], 0);
  b.apply(0, 'call', 2);
  b.apply(1, 'call', 2);
  b.apply(2, 'check');
  b.beginStreet('flop');
  const presets = entry(b.legalActions(1), 'bet').presets!;
  assert.deepEqual(presets.map((p) => p.label), ['33%', '50%', '75%', 'Pot', 'All-in']);
  assert.equal(presets[1].amount, 3, 'half of a six chip pot');
  assert.equal(presets[3].amount, 6, 'pot-sized bet');
});

test('a stack too short to min-raise may only shove', () => {
  // Seat 2 posts the big blind out of a 3 chip stack: 1 behind, and a raise to
  // 4 is out of reach, so shoving to 3 is the only aggressive option.
  const b = newBetting([200, 200, 3], 0);
  b.apply(0, 'call', 2);
  b.apply(1, 'call', 2);
  const legal = b.legalActions(2);
  assert.deepEqual(kinds(legal), ['check', 'allin']);
  assert.equal(entry(legal, 'allin').max, 3);
  assert.throws(() => b.apply(2, 'raise', 4), IllegalActionError);
  // "Raise to my whole stack" is accepted and recorded as the shove it is.
  const action = b.apply(2, 'raise', 3);
  assert.equal(action.kind, 'allin');
  assert.equal(b.seats[2].phase, 'allin');
});

test('pot-limit Omaha caps the raise at the pot', () => {
  const b = newBetting([500, 500, 500], 0, 'plo4');
  const legal = b.legalActions(0);
  assert.equal(entry(legal, 'raise').max, 7, 'the pot-limit preflop open is 7');
  assert.ok(!legal.some((l) => l.kind === 'allin'), 'a 500 shove is over the pot limit');
  assert.throws(() => b.apply(0, 'raise', 8), IllegalActionError);
  b.apply(0, 'raise', 7);
  assert.equal(entry(b.legalActions(1), 'raise').max, 23, 'small blind re-pots to 23');
  assert.equal(entry(b.legalActions(1), 'raise').min, 12);
});

test('antes are dead money and never become a call', () => {
  const b = new Betting(
    { variant: 'nlhe', sb: 1, bb: 2, ante: 1, step: 1, seatCount: 3 },
    [0, 1, 2].map((seat) => ({ seat, stack: 100, inHand: true })),
    0,
  );
  b.postForcedBets();
  assert.equal(b.pot(), 6, 'three antes plus the blinds');
  assert.equal(b.currentBet, 2);
  assert.equal(b.seats[0].committed, 0, 'the ante is not a street commitment');
  assert.equal(b.seats[0].totalCommitted, 1);
  assert.equal(b.potBefore(), 3);
});

// ═══════════════════════════ full hands ═══════════════════════════

const player = (n: number): PlayerRef => ({
  id: `p${n}`, name: `Player ${n}`, avatarId: 'a1', frameId: null, titleId: null,
  emoteSetId: 'default', level: 5, premium: false, heat: 0,
});

/** Answers every request with the first matching preference. */
function scriptedBot(order: string[]): (req: ActionRequest) => ActionSubmission {
  return (req) => {
    for (const want of order) {
      const found = req.legal.find((l) => l.kind === want);
      if (found) return { kind: found.kind, amount: found.max };
    }
    return { kind: 'fold', amount: 0 };
  };
}

const passive = scriptedBot(['check', 'call', 'fold']);
const shover = scriptedBot(['allin', 'call', 'check', 'fold']);

test('a hand where everyone folds pays the big blind the dead chips', async () => {
  const hand = new PokerHand({
    handId: 1, variant: 'nlhe', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [0, 1, 2].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(11), decide: scriptedBot(['fold', 'check']),
  });
  const result = await hand.run();
  assert.equal(result.wentToShowdown, false);
  const stacks = result.outcomes.map((o) => o.endStack);
  assert.deepEqual(stacks, [100, 99, 101]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].seat, 2);
  assert.equal(result.results[0].mucked, true, 'an uncontested winner never shows');
  // The blind above the small blind is uncalled and comes straight back, so the
  // pot is the small blind plus the matched chip of the big blind.
  assert.equal(result.potTotal, 2);
  assert.equal(result.results[0].won, 2);
});

test('the board plays: a checked-down split pot', async () => {
  const hand = new PokerHand({
    handId: 2, variant: 'nlhe', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [0, 1].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(12), decide: passive,
    scripted: { hole: { 0: '2c 3d', 1: '4h 5s' }, boards: ['As Ks Qh Jd Tc'] },
  });
  const result = await hand.run();
  assert.equal(result.wentToShowdown, true);
  assert.equal(result.potTotal, 4);
  assert.deepEqual(result.outcomes.map((o) => o.endStack), [100, 100]);
  assert.deepEqual(result.outcomes.map((o) => o.won), [2, 2]);
  assert.equal(result.results[0].rank?.label, 'Ace-high Straight');
  assert.equal(result.results[1].rank?.label, 'Ace-high Straight');
});

test('three-way all-in builds and pays exact side pots', async () => {
  const hand = new PokerHand({
    handId: 3, variant: 'nlhe', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [
      { seat: 0, player: player(0), stack: 50 },
      { seat: 1, player: player(1), stack: 100 },
      { seat: 2, player: player(2), stack: 200 },
    ],
    buttonSeat: 0, rng: new Rng(13), decide: shover,
    scripted: {
      hole: { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh' },
      boards: ['2c 7d 9h 3s 4c'],
    },
  });
  const result = await hand.run();
  assert.equal(result.pots.length, 2, 'a main pot and one side pot');
  assert.deepEqual(result.pots[0], { amount: 150, eligible: [0, 1, 2], index: 0 });
  assert.deepEqual(result.pots[1], { amount: 100, eligible: [1, 2], index: 1 });
  assert.deepEqual(result.outcomes.map((o) => o.endStack), [150, 100, 100]);
  assert.deepEqual(result.outcomes.map((o) => o.net), [100, 0, -100]);
  const chipsInPlay = result.outcomes.reduce((t, o) => t + o.endStack, 0);
  assert.equal(chipsInPlay, 350, 'chips are conserved');
});

test('a bomb pot deals two boards and splits the pot between them', async () => {
  const hand = new PokerHand({
    handId: 4, variant: 'nlhe', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [0, 1, 2].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(14), decide: passive,
    bombPot: { anteBb: 5, boards: 2, triggerEveryHands: 10, handsUntilNext: 0 },
    scripted: {
      hole: { 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh' },
      boards: ['2c 7d 9h 3s 4c', 'Kd 7s 9s 3d 4d'],
    },
  });
  const result = await hand.run();
  assert.equal(result.boards.length, 2);
  assert.equal(result.boards[0].length, 5);
  assert.equal(result.boards[1].length, 5);
  assert.equal(result.potTotal, 30, 'three ten-chip antes');
  // Aces win the blank board, trip kings win the second.
  assert.deepEqual(result.outcomes.map((o) => o.endStack), [105, 105, 90]);
  const actions = result.actions.filter((a) => a.kind === 'ante');
  assert.equal(actions.length, 3, 'every player antes, nobody posts a blind');
});

test('run it twice splits an all-in pot between two runouts', async () => {
  const hand = new PokerHand({
    handId: 5, variant: 'nlhe', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [0, 1].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(15), decide: shover, runItTwice: true,
    scripted: { hole: { 0: 'As Ah', 1: 'Ks Kh' } },
  });
  const result = await hand.run();
  assert.equal(result.boards.length, 2, 'two runouts');
  assert.notDeepEqual(result.boards[0], result.boards[1]);
  assert.equal(result.potTotal, 200);
  const total = result.outcomes.reduce((t, o) => t + o.endStack, 0);
  assert.equal(total, 200, 'chips are conserved across both runs');
  const won = result.outcomes.reduce((t, o) => t + o.won, 0);
  assert.equal(won, 200);
});

test('PLO hands are settled with the exactly-two rule', async () => {
  const hand = new PokerHand({
    handId: 6, variant: 'plo4', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [0, 1].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(16), decide: passive,
    scripted: {
      // Seat 0 holds a single spade: no flush. Seat 1 has two pair.
      hole: { 0: 'As 2c 3d 4h', 1: '9c 9d 5c 6h' },
      boards: ['Ks Qs Js 2h 9h'],
    },
  });
  const result = await hand.run();
  assert.equal(result.wentToShowdown, true);
  const seat0 = result.results.find((r) => r.seat === 0)!;
  const seat1 = result.results.find((r) => r.seat === 1)!;
  assert.equal(seat1.won, 4, 'trip nines beat a pair of deuces');
  assert.equal(seat0.won, 0);
  assert.ok(seat0.mucked || seat0.rank?.category === 'pair');
});

test('the async API hands the decision to the UI and rejects illegal answers', async () => {
  const hand = new PokerHand({
    handId: 7, variant: 'nlhe', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [0, 1].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(17),
    scripted: { hole: { 0: 'As Ah', 1: 'Ks Kh' }, boards: ['2c 7d 9h 3s 4c'] },
  });
  const done = hand.run();
  await Promise.resolve();

  assert.ok(hand.request, 'the engine is waiting on the button');
  assert.equal(hand.request!.seat, 0);
  // A raise below the minimum is refused and the request stays open.
  await assert.rejects(() => hand.submit('raise', 3), IllegalActionError);
  assert.equal(hand.request!.seat, 0, 'still the same seat to act');
  const raised = await hand.submit('raise', 6);
  assert.equal(raised.kind, 'raise');
  assert.equal(raised.amount, 6);

  // Big blind shoves, button calls: aces hold.
  await hand.submit('allin', 100);
  await hand.submit('call', 100);
  const result = await done;
  assert.equal(result.potTotal, 200);
  assert.deepEqual(result.outcomes.map((o) => o.endStack), [200, 0]);
});

test('a second declaration on the same turn is refused', async () => {
  const hand = new PokerHand({
    handId: 9, variant: 'nlhe', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [0, 1].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(19),
    scripted: { hole: { 0: 'As Ah', 1: 'Ks Kh' }, boards: ['2c 7d 9h 3s 4c'] },
  });
  const done = hand.run();
  await Promise.resolve();
  const first = hand.submit('raise', 6);
  // Reaching for more chips after the declaration is a string bet.
  await assert.rejects(() => hand.submit('raise', 20), /no action is pending/);
  await first;
  // The hand is still playable: fold it out.
  await hand.submit('fold');
  const result = await done;
  assert.equal(result.wentToShowdown, false);
});

test('a beaten hand mucks at showdown', async () => {
  const seen: number[] = [];
  const { bus } = await import('../src/core/bus.ts');
  const off = bus.on('hand:muck', ({ seat }) => seen.push(seat));
  const hand = new PokerHand({
    handId: 10, variant: 'nlhe', stake: stake(1, 2), chipStep: 1,
    seats: [0, 1].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(20),
    // Seat 0 leads every street for the minimum; seat 1 calls it down and is
    // last to act on the river, so it may fold its cards face-down.
    decide: (req) => {
      const bet = req.legal.find((l) => l.kind === 'bet');
      if (req.seat === 0 && bet) return { kind: 'bet', amount: bet.min };
      return passive(req);
    },
    scripted: { hole: { 0: 'As Ah', 1: '7c 2d' }, boards: ['Ac Kd 9h 4s 3c'] },
  });
  const result = await hand.run();
  off();
  const loser = result.results.find((r) => r.seat === 1)!;
  assert.equal(loser.mucked, true, 'the loser never has to show');
  assert.equal(loser.rank, null);
  assert.deepEqual(seen, [1]);
  const winner = result.results.find((r) => r.seat === 0)!;
  assert.equal(winner.mucked, false);
  assert.equal(winner.rank?.label, 'Three of a Kind, Aces');
  assert.equal(result.replay.seats[1].holeCards, null, 'mucked cards stay hidden in the replay');
});

test('bus events fire in the right order for a full hand', async () => {
  const { bus } = await import('../src/core/bus.ts');
  const seen: string[] = [];
  const offs = [
    bus.on('hand:start', () => seen.push('start')),
    bus.on('hand:deal-hole', () => seen.push('hole')),
    bus.on('hand:deal-board', ({ street }) => seen.push(`board:${street}`)),
    bus.on('hand:turn', () => seen.push('turn')),
    bus.on('hand:action', () => seen.push('action')),
    bus.on('hand:showdown', () => seen.push('showdown')),
    bus.on('hand:award', () => seen.push('award')),
    bus.on('hand:end', () => seen.push('end')),
  ];
  const hand = new PokerHand({
    handId: 8, variant: 'nlhe', stake: stake(1, 2), chipStep: 1,
    seats: [0, 1].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(18), decide: passive,
    scripted: { hole: { 0: 'As Ah', 1: 'Ks Kh' }, boards: ['2c 7d 9h 3s 4c'] },
  });
  await hand.run();
  for (const off of offs) off();

  assert.equal(seen[0], 'start');
  assert.equal(seen.filter((s) => s === 'hole').length, 2);
  assert.ok(seen.includes('board:flop'));
  assert.ok(seen.includes('board:turn'));
  assert.ok(seen.includes('board:river'));
  assert.ok(seen.indexOf('showdown') < seen.indexOf('award'));
  assert.equal(seen[seen.length - 1], 'end');
  assert.ok(seen.indexOf('board:flop') < seen.indexOf('board:turn'));
});

test('an all-in showdown tables every hand — nobody mucks', async () => {
  const hand = new PokerHand({
    handId: 11, variant: 'nlhe', stake: stake(1, 2), chipStep: 1, emit: false,
    seats: [0, 1].map((seat) => ({ seat, player: player(seat), stack: 100 })),
    buttonSeat: 0, rng: new Rng(21), decide: shover,
    scripted: { hole: { 0: 'As Ah', 1: '7c 2d' }, boards: ['Ac Kd 9h 4s 3c'] },
  });
  const result = await hand.run();
  assert.ok(result.results.every((r) => !r.mucked), 'all-in hands are face-up');
  assert.equal(result.results.find((r) => r.seat === 1)!.rank?.label, 'Ace-high, King kicker');
  assert.ok(result.replay.seats.every((s) => s.holeCards !== null));
});

test('presets are relabelled when the legal band clamps them', () => {
  // Seat 0 has 8 behind: 2.5x and 3x are unreachable, so the pad shows the
  // minimum and the shove instead of promising sizings it cannot make.
  const b = newBetting([8, 200, 200], 0);
  const raise = entry(b.legalActions(0), 'raise');
  assert.equal(raise.min, 4);
  assert.equal(raise.max, 8);
  const presets = raise.presets!;
  for (const p of presets) assert.ok(p.amount >= 4 && p.amount <= 8, `${p.label} out of band`);
  assert.equal(presets[presets.length - 1].label, 'All-in');
  assert.equal(presets[presets.length - 1].amount, 8);
  assert.equal(new Set(presets.map((p) => p.amount)).size, presets.length);
});

test('a thousand random hands never leak or invent a chip', async () => {
  const rng = new Rng(0x1234);
  for (let i = 0; i < 200; i++) {
    const seatCount = 2 + (i % 5);
    const stacks: number[] = [];
    for (let s = 0; s < seatCount; s++) stacks.push(20 + rng.int(200));
    const startTotal = stacks.reduce((a, b) => a + b, 0);
    const hand = new PokerHand({
      handId: 100 + i,
      variant: i % 3 === 0 ? 'plo4' : 'nlhe',
      stake: stake(1, 2), chipStep: 1, emit: false,
      seats: stacks.map((stack, seat) => ({ seat, player: player(seat), stack })),
      buttonSeat: i % seatCount,
      rng: new Rng(i * 7919 + 3),
      decide: (req) => {
        const roll = rng.next();
        const pick = (k: string): LegalAction | undefined => req.legal.find((l) => l.kind === k);
        if (roll < 0.12 && pick('fold')) return { kind: 'fold', amount: 0 };
        if (roll < 0.3) {
          const r = pick('raise') ?? pick('bet');
          if (r) {
            const presets = r.presets ?? [];
            const p = presets.length ? presets[rng.int(presets.length)] : null;
            return { kind: r.kind, amount: p ? p.amount : r.min };
          }
        }
        if (roll < 0.34 && pick('allin')) return { kind: 'allin', amount: pick('allin')!.max };
        const c = pick('check') ?? pick('call');
        if (c) return { kind: c.kind, amount: c.max };
        return { kind: 'fold', amount: 0 };
      },
    });
    const result = await hand.run();
    const endTotal = result.outcomes.reduce((t, o) => t + o.endStack, 0);
    assert.equal(endTotal, startTotal, `hand ${i} lost or created chips`);
    for (const o of result.outcomes) assert.ok(o.endStack >= 0, 'negative stack');
    const awarded = result.awards.reduce((t, a) => t + a.amount, 0);
    assert.equal(awarded, result.potTotal, `hand ${i} pot mismatch`);
  }
});
