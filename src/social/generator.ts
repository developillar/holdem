/**
 * ROYALE — social/generator.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The seeded feed author. Every post it produces is backed by a real, legal
 * hand: a deck that never deals the same card twice, a betting line that
 * follows the same "amount is a total street commitment" convention the engine
 * uses, and a showdown resolved by `handeval.ts`.
 *
 * The important rule here is that **the cards decide the story, not the other
 * way round.** A recipe biases the deal toward a shape (quads, a cooler, a bad
 * beat), the hand is then evaluated, and only then are the author and the
 * headline chosen from what actually happened. That is why a "bad beat" post
 * in this feed always genuinely shows a losing better hand — it cannot drift,
 * because the narrative is derived rather than asserted.
 *
 *   generateFeed({ seed: 0x0FF5U1T, count: 40, now: Date.now() })  → FeedPost[]
 *   generateLivePost(seed, Date.now())                             → FeedPost
 */
import { Rng } from '../core/rng.ts';
import { STAKES } from '../core/stakes.ts';
import type {
  Action,
  ActionKind,
  CardId,
  FeedComment,
  FeedEventKind,
  FeedPost,
  GameVariant,
  HandRank,
  HandReplay,
  Rank,
  Reaction,
  ReactionKind,
  ShowdownResult,
  Stake,
  StakeId,
  Street,
  Suit,
  TableFormat,
} from '../core/types.ts';
import { cardRank, cardSuit } from '../core/types.ts';
import { isFriend, personaAt, playerFromPersona, PERSONA_POOL_SIZE } from '../data/names.ts';
import type { NamePersona } from '../data/names.ts';
import { evaluate } from './handeval.ts';
import { defaultReactionFor, emptyReactions, REACTION_KINDS } from './reactions.ts';

const EPS = 1e-6;
const r2 = (v: number): number => Math.round(v * 100) / 100;

// ───────────────────────────── deck ─────────────────────────────

/**
 * A deck that can be asked for cards by shape ("any free heart that is not a
 * ten") and can never return a duplicate. Constraints that cannot be met
 * degrade to "any free card", so a recipe always ends up with a legal board
 * even if it asks for something the remaining deck no longer holds.
 */
class Deck {
  private free: boolean[] = new Array(52).fill(true);
  private rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  private pickFrom(pool: CardId[]): CardId {
    if (!pool.length) return this.anyFree();
    const c = pool[this.rng.int(pool.length)];
    this.free[c] = false;
    return c;
  }

  private anyFree(): CardId {
    const pool: CardId[] = [];
    for (let c = 0; c < 52; c++) if (this.free[c]) pool.push(c);
    if (!pool.length) return 0;
    const c = pool[this.rng.int(pool.length)];
    this.free[c] = false;
    return c;
  }

  /** Exactly this card if it is still available, else any card of that rank. */
  exact(rank: Rank, suit: Suit): CardId {
    const c = (rank - 2) * 4 + suit;
    if (this.free[c]) {
      this.free[c] = false;
      return c;
    }
    return this.ofRank(rank);
  }

  ofRank(rank: Rank, avoidSuits: Suit[] = []): CardId {
    const pool: CardId[] = [];
    for (let s = 0; s < 4; s++) {
      const c = (rank - 2) * 4 + s;
      if (this.free[c] && !avoidSuits.includes(s as Suit)) pool.push(c);
    }
    return this.pickFrom(pool);
  }

  ofSuit(suit: Suit, avoidRanks: number[] = []): CardId {
    const pool: CardId[] = [];
    for (let r = 2; r <= 14; r++) {
      if (avoidRanks.includes(r)) continue;
      const c = (r - 2) * 4 + suit;
      if (this.free[c]) pool.push(c);
    }
    return this.pickFrom(pool);
  }

  any(avoidRanks: number[] = [], avoidSuits: Suit[] = []): CardId {
    const pool: CardId[] = [];
    for (let c = 0; c < 52; c++) {
      if (!this.free[c]) continue;
      if (avoidRanks.includes(cardRank(c))) continue;
      if (avoidSuits.includes(cardSuit(c))) continue;
      pool.push(c);
    }
    return this.pickFrom(pool);
  }
}

// ───────────────────────────── betting builder ─────────────────────────────

type Phase = 'in' | 'folded' | 'allin';

/**
 * Writes a legal action sequence. Amounts follow the engine's convention:
 * every bet / raise / call / all-in amount is the actor's TOTAL commitment on
 * the current street, a fold carries 0, and a check carries whatever the actor
 * already had in front of them.
 */
class HandBuilder {
  readonly stacks: number[];
  readonly committed: number[];
  readonly totals: number[];
  readonly phase: Phase[];
  readonly actions: Action[] = [];
  street: Street = 'preflop';
  currentBet = 0;
  private seq = 0;
  private acted = new Set<number>();
  private order: number[] = [];
  private cursor = 0;
  private raisesThisStreet = 0;
  readonly n: number;
  readonly step: number;
  private rng: Rng;

  constructor(n: number, startStacks: number[], step: number, rng: Rng) {
    this.n = n;
    this.step = step;
    this.rng = rng;
    this.stacks = startStacks.slice();
    this.committed = new Array(n).fill(0);
    this.totals = new Array(n).fill(0);
    this.phase = new Array(n).fill('in');
  }

  pot(): number {
    let p = 0;
    for (const t of this.totals) p += t;
    return r2(p);
  }

  alive(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.phase[i] !== 'folded') out.push(i);
    return out;
  }

  canAct(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.phase[i] === 'in') out.push(i);
    return out;
  }

  private snap(v: number): number {
    return r2(Math.max(0, Math.round(v / this.step) * this.step));
  }

  private commit(seat: number, kind: ActionKind, to: number): void {
    const ceiling = r2(this.committed[seat] + this.stacks[seat]);
    const target = Math.min(this.snap(to), ceiling);
    const delta = r2(Math.max(0, target - this.committed[seat]));
    this.stacks[seat] = r2(this.stacks[seat] - delta);
    this.committed[seat] = r2(this.committed[seat] + delta);
    this.totals[seat] = r2(this.totals[seat] + delta);
    let out: ActionKind = kind;
    if (this.stacks[seat] <= EPS && kind !== 'post' && kind !== 'ante') {
      this.phase[seat] = 'allin';
      if (kind === 'bet' || kind === 'raise') out = 'allin';
    }
    if (this.committed[seat] > this.currentBet + EPS) this.currentBet = this.committed[seat];
    this.record(out, seat, this.committed[seat]);
  }

  private record(kind: ActionKind, seat: number, amount: number): void {
    this.actions.push({
      kind,
      amount: r2(amount),
      seat,
      seq: this.seq++,
      street: this.street,
      tookMs: 700 + this.rng.int(3200),
    });
    if (kind !== 'post' && kind !== 'ante') this.acted.add(seat);
  }

  post(seat: number, amount: number): void {
    this.commit(seat, 'post', amount);
  }

  ante(seat: number, amount: number): void {
    this.commit(seat, 'ante', amount);
  }

  /** Antes do not create a bet to call — clear the line once they are in. */
  clearBet(): void {
    this.currentBet = 0;
    for (let i = 0; i < this.n; i++) this.committed[i] = 0;
  }

  beginStreet(street: Street, firstSeat: number): void {
    this.street = street;
    this.acted.clear();
    this.raisesThisStreet = 0;
    if (street !== 'preflop') {
      this.currentBet = 0;
      for (let i = 0; i < this.n; i++) this.committed[i] = 0;
    }
    this.order = [];
    for (let k = 0; k < this.n; k++) this.order.push((firstSeat + k) % this.n);
    this.cursor = 0;
  }

  /** Whose turn it is, or null when the round is closed. */
  nextActor(): number | null {
    for (let k = 0; k < this.n; k++) {
      const idx = (this.cursor + k) % this.n;
      const seat = this.order[idx];
      if (this.phase[seat] !== 'in') continue;
      const owed = this.currentBet - this.committed[seat];
      if (!this.acted.has(seat) || owed > EPS) {
        this.cursor = (idx + 1) % this.n;
        return seat;
      }
    }
    return null;
  }

  owed(seat: number): number {
    return r2(Math.max(0, this.currentBet - this.committed[seat]));
  }

  fold(seat: number): void {
    this.phase[seat] = 'folded';
    this.record('fold', seat, 0);
  }

  check(seat: number): void {
    this.record('check', seat, this.committed[seat]);
  }

  call(seat: number): void {
    if (this.owed(seat) <= EPS) {
      this.check(seat);
      return;
    }
    this.commit(seat, 'call', this.currentBet);
  }

  /** Bet or raise to a total street commitment, respecting the min-raise. */
  raiseTo(seat: number, to: number): void {
    const isRaise = this.currentBet > EPS;
    const minTo = isRaise ? this.currentBet * 2 : this.step * 2;
    this.raisesThisStreet++;
    this.commit(seat, isRaise ? 'raise' : 'bet', Math.max(to, minTo));
  }

  allIn(seat: number): void {
    const to = r2(this.committed[seat] + this.stacks[seat]);
    if (to <= this.currentBet + EPS) {
      this.commit(seat, 'call', to);
      this.phase[seat] = 'allin';
      return;
    }
    this.raisesThisStreet++;
    this.commit(seat, this.currentBet > EPS ? 'raise' : 'bet', to);
  }

  raises(): number {
    return this.raisesThisStreet;
  }
}

// ───────────────────────────── street policy ─────────────────────────────

interface StreetPolicy {
  /** chance a kept seat opens the betting when it is checked to */
  betChance: number;
  /** bet size as a fraction of the pot */
  betPct: number;
  /** chance a kept seat raises rather than calls */
  raiseChance: number;
  raiseMult: number;
  /** the aggressor jams instead of sizing */
  jam: boolean;
  /** only this seat may open the betting (null = anyone) */
  opener: number | null;
  /** this seat folds the moment it faces a bet */
  folder: number | null;
}

function playStreet(b: HandBuilder, rng: Rng, keep: number[], p: StreetPolicy): void {
  let opened = false;
  for (let guard = 0; guard < 18; guard++) {
    const seat = b.nextActor();
    if (seat === null) return;
    const owed = b.owed(seat);
    const kept = keep.includes(seat);

    if (!kept) {
      if (owed > EPS) b.fold(seat);
      else b.check(seat);
      continue;
    }
    if (p.folder === seat && owed > EPS) {
      b.fold(seat);
      continue;
    }
    if (owed > EPS) {
      if (b.raises() < 2 && rng.next() < p.raiseChance) {
        if (p.jam) b.allIn(seat);
        else b.raiseTo(seat, b.currentBet * p.raiseMult);
      } else {
        b.call(seat);
      }
      continue;
    }
    const mayOpen = p.opener === null || p.opener === seat;
    if (!opened && mayOpen && rng.next() < p.betChance) {
      opened = true;
      if (p.jam) b.allIn(seat);
      else b.raiseTo(seat, b.pot() * p.betPct);
    } else {
      b.check(seat);
    }
  }
}

// ───────────────────────────── deal recipes ─────────────────────────────

interface Deal {
  /** the shape we aimed for; the final kind is re-derived after evaluation */
  want: FeedEventKind;
  variant: GameVariant;
  format: TableFormat;
  /** number of seats dealt in */
  seats: number;
  /** hole cards keyed by seat for everyone who reaches a showdown */
  hole: Map<number, CardId[]>;
  board: CardId[];
  /** the seat this recipe considers the protagonist */
  focus: number;
  /** the hand ends with the opponent folding to `focus` */
  foldWin: boolean;
  /** push the line toward a big pot */
  big: boolean;
}

const ALL_RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const HIGH_RANKS: Rank[] = [8, 9, 10, 11, 12, 13, 14];

function pickRank(rng: Rng, pool: readonly Rank[], exclude: number[] = []): Rank {
  const avail = pool.filter((r) => !exclude.includes(r));
  return avail.length ? avail[rng.int(avail.length)] : pool[rng.int(pool.length)];
}

/** Hero flops quads; villain holds the full house that pays them off. */
function dealQuads(deck: Deck, rng: Rng, hero: number, villain: number): Deal {
  const q = pickRank(rng, ALL_RANKS.filter((r) => r >= 5) as Rank[]);
  const trip = pickRank(rng, ALL_RANKS, [q]);
  const heroHole = [deck.ofRank(q), deck.ofRank(q)];
  const board = [deck.ofRank(q), deck.ofRank(q), deck.ofRank(trip)];
  const villHole = [deck.ofRank(trip), deck.ofRank(trip)];
  board.push(deck.any([q, trip]));
  board.push(deck.any([q, trip, cardRank(board[3])]));
  const hole = new Map<number, CardId[]>([[hero, heroHole], [villain, villHole]]);
  return { want: 'quads', variant: 'nlhe', format: 'cash', seats: 6, hole, board, focus: hero, foldWin: false, big: true };
}

/** Hero completes a straight flush; villain gets there with a plain flush. */
function dealStraightFlush(deck: Deck, rng: Rng, hero: number, villain: number, royal: boolean): Deal {
  const suit = rng.int(4) as Suit;
  const low = royal ? 10 : 5 + rng.int(5);
  const straight = [low, low + 1, low + 2, low + 3, low + 4];
  const heroHole = [deck.exact((low + 4) as Rank, suit), deck.exact((low + 3) as Rank, suit)];
  const board = [
    deck.exact(low as Rank, suit),
    deck.exact((low + 1) as Rank, suit),
    deck.exact((low + 2) as Rank, suit),
  ];
  const villHole = [deck.ofSuit(suit, straight), deck.ofSuit(suit, straight)];
  board.push(deck.any(straight, [suit]));
  board.push(deck.any(straight.concat([cardRank(board[3])]), [suit]));
  const hole = new Map<number, CardId[]>([[hero, heroHole], [villain, villHole]]);
  return {
    want: royal ? 'royal' : 'straight-flush',
    variant: 'nlhe', format: 'cash', seats: 6, hole, board,
    focus: hero, foldWin: false, big: true,
  };
}

/** Aces full, beaten by quads. The oldest heartbreak in the game. */
function dealBadBeatQuads(deck: Deck, rng: Rng, hero: number, villain: number): Deal {
  const hi = pickRank(rng, [13, 14] as Rank[]);
  const lo = pickRank(rng, HIGH_RANKS, [hi]);
  const heroHole = [deck.ofRank(hi), deck.ofRank(hi)];
  const board = [deck.ofRank(hi), deck.ofRank(lo), deck.ofRank(lo)];
  const villHole = [deck.ofRank(lo), deck.ofRank(lo)];
  board.push(deck.any([hi, lo]));
  board.push(deck.any([hi, lo, cardRank(board[3])]));
  const hole = new Map<number, CardId[]>([[hero, heroHole], [villain, villHole]]);
  return { want: 'bad-beat', variant: 'nlhe', format: 'cash', seats: 6, hole, board, focus: hero, foldWin: false, big: true };
}

/** The nut flush, run down by a boat when the board pairs. */
function dealBadBeatFlushVsBoat(deck: Deck, rng: Rng, hero: number, villain: number): Deal {
  const suit = rng.int(4) as Suit;
  const tripRank = pickRank(rng, ALL_RANKS.filter((r) => r <= 12) as Rank[]);
  const pairRank = pickRank(rng, ALL_RANKS, [tripRank, 14]);
  const heroKicker = deck.ofSuit(suit, [14, tripRank, pairRank]);
  const heroHole = [deck.exact(14, suit), heroKicker];
  const b1 = deck.exact(tripRank, suit);
  const b2 = deck.ofSuit(suit, [14, tripRank, pairRank, cardRank(heroKicker)]);
  const b3 = deck.ofSuit(suit, [14, tripRank, pairRank, cardRank(heroKicker), cardRank(b2)]);
  const board = [b1, b2, b3, deck.ofRank(pairRank, [suit]), deck.ofRank(pairRank, [suit])];
  const villHole = [deck.ofRank(tripRank, [suit]), deck.ofRank(tripRank, [suit])];
  const hole = new Map<number, CardId[]>([[hero, heroHole], [villain, villHole]]);
  return { want: 'bad-beat', variant: 'nlhe', format: 'cash', seats: 6, hole, board, focus: hero, foldWin: false, big: true };
}

/** Hero holds the idiot end of the straight. */
function dealBadBeatStraight(deck: Deck, rng: Rng, hero: number, villain: number): Deal {
  const low = 4 + rng.int(5); // the run is low..low+4; the villain owns the top
  const board = [
    deck.ofRank((low + 2) as Rank),
    deck.ofRank((low + 3) as Rank),
    deck.ofRank((low + 4) as Rank),
  ];
  const heroHole = [deck.ofRank(low as Rank), deck.ofRank((low + 1) as Rank)];
  const villHole = [deck.ofRank((low + 5) as Rank), deck.ofRank((low + 6) as Rank)];
  const used = [low, low + 1, low + 2, low + 3, low + 4, low + 5, low + 6];
  board.push(deck.any(used));
  board.push(deck.any(used.concat([cardRank(board[3])])));
  const hole = new Map<number, CardId[]>([[hero, heroHole], [villain, villHole]]);
  return { want: 'bad-beat', variant: 'nlhe', format: 'cash', seats: 6, hole, board, focus: hero, foldWin: false, big: false };
}

/** Set under set — the cooler that funds the whole industry. */
function dealSetOverSet(deck: Deck, rng: Rng, hero: number, villain: number): Deal {
  const hi = pickRank(rng, HIGH_RANKS);
  const lo = pickRank(rng, ALL_RANKS.filter((r) => r < hi) as Rank[]);
  const heroHole = [deck.ofRank(hi), deck.ofRank(hi)];
  const villHole = [deck.ofRank(lo), deck.ofRank(lo)];
  const board = [deck.ofRank(hi), deck.ofRank(lo), deck.any([hi, lo])];
  board.push(deck.any([hi, lo, cardRank(board[2])]));
  board.push(deck.any([hi, lo, cardRank(board[2]), cardRank(board[3])]));
  const hole = new Map<number, CardId[]>([[hero, heroHole], [villain, villHole]]);
  return { want: 'big-win', variant: 'nlhe', format: 'cash', seats: 6, hole, board, focus: hero, foldWin: false, big: true };
}

/** Hero fires three streets with nothing and takes it down. */
function dealBluff(deck: Deck, rng: Rng, hero: number, villain: number): Deal {
  // A board that looks like it hit everything — a broadway card and a
  // completed flush draw — so the story of the bluff reads off the cards.
  const suit = rng.int(4) as Suit;
  const board = [
    deck.exact(pickRank(rng, [11, 12, 13, 14] as Rank[]), suit),
    deck.ofSuit(suit),
    deck.any([], [suit]),
    deck.any([], [suit]),
    deck.ofSuit(suit),
  ];
  const boardRanks = board.map(cardRank);
  const lowPool = ALL_RANKS.filter((r) => r <= 8 && !boardRanks.includes(r));
  const r1 = (lowPool.length ? lowPool[rng.int(lowPool.length)] : 4) as Rank;
  const secondPool = lowPool.filter((r) => Math.abs(r - r1) > 2);
  const r2Rank = (secondPool.length ? secondPool[rng.int(secondPool.length)] : ((r1 === 2 ? 7 : 2) as Rank)) as Rank;
  const c1 = deck.ofRank(r1, [suit]);
  const c2 = deck.ofRank(r2Rank, [suit, cardSuit(c1)]);
  const hole = new Map<number, CardId[]>([
    [hero, [c1, c2]],
    [villain, [deck.any([], [suit]), deck.any([], [suit])]],
  ]);
  return { want: 'bluff', variant: 'nlhe', format: 'cash', seats: 6, hole, board, focus: hero, foldWin: true, big: true };
}

/** Four-handed bomb pot: everybody antes, flop straight to the felt. */
function dealBombPot(deck: Deck, rng: Rng, seatsIn: number[]): Deal {
  const omaha = rng.bool(0.35);
  const hole = new Map<number, CardId[]>();
  for (const s of seatsIn) {
    const cards: CardId[] = [];
    for (let i = 0; i < (omaha ? 4 : 2); i++) cards.push(deck.any());
    hole.set(s, cards);
  }
  const board: CardId[] = [];
  for (let i = 0; i < 5; i++) board.push(deck.any());
  return {
    want: 'bomb-pot', variant: omaha ? 'plo4' : 'nlhe', format: 'bomb', seats: 6,
    hole, board, focus: seatsIn[0], foldWin: false, big: true,
  };
}

/** Heads-up for the title: the last hand of a sit-and-go. */
function dealSngFinal(deck: Deck, rng: Rng): Deal {
  const hi = pickRank(rng, [10, 11, 12, 13, 14] as Rank[]);
  const lo = pickRank(rng, HIGH_RANKS, [hi]);
  const hole = new Map<number, CardId[]>([
    [0, [deck.ofRank(hi), deck.ofRank(hi)]],
    [1, [deck.ofRank(lo), deck.ofRank(lo)]],
  ]);
  const board: CardId[] = [];
  for (let i = 0; i < 5; i++) board.push(deck.any([lo]));
  return { want: 'sng-win', variant: 'nlhe', format: 'sng', seats: 2, hole, board, focus: 0, foldWin: false, big: true };
}

/** Pot-limit Omaha: the nut flush against four live cards. */
function dealOmahaCooler(deck: Deck, rng: Rng, hero: number, villain: number): Deal {
  const suit = rng.int(4) as Suit;
  const hole = new Map<number, CardId[]>([
    [hero, [deck.exact(14, suit), deck.ofSuit(suit, [14]), deck.any([], [suit]), deck.any([], [suit])]],
    [villain, [deck.any([], [suit]), deck.any(), deck.any(), deck.any()]],
  ]);
  const board = [
    deck.ofSuit(suit),
    deck.ofSuit(suit),
    deck.ofSuit(suit),
    deck.any([], [suit]),
    deck.any([], [suit]),
  ];
  return { want: 'big-win', variant: 'plo4', format: 'cash', seats: 6, hole, board, focus: hero, foldWin: false, big: true };
}

// ───────────────────────────── replay assembly ─────────────────────────────

interface BuiltHand {
  replay: HandReplay;
  ranks: Map<number, HandRank>;
  winners: number[];
  pot: number;
  survivors: number[];
}

const STAKE_LADDER: StakeId[] = ['nl10', 'nl20', 'nl50', 'nl100', 'nl200', 'nl500'];

function firstAliveAfter(b: HandBuilder, button: number, n: number): number {
  for (let k = 1; k <= n; k++) {
    const s = (button + k) % n;
    if (b.phase[s] === 'in') return s;
  }
  return (button + 1) % n;
}

function runPreflop(b: HandBuilder, rng: Rng, participants: number[], bb: number, big: boolean): void {
  const openTo = r2(bb * (2.2 + rng.next() * 1.2));
  const threeBet = rng.bool(big ? 0.55 : 0.32);
  const threeTo = r2(openTo * (2.9 + rng.next() * 1.1));
  const fourBet = threeBet && big && rng.bool(0.22);
  const fourTo = r2(threeTo * (2.2 + rng.next() * 0.6));
  let opener = -1;
  let raiser = -1;

  for (let guard = 0; guard < 24; guard++) {
    const seat = b.nextActor();
    if (seat === null) return;
    if (!participants.includes(seat)) {
      if (b.owed(seat) > EPS) b.fold(seat);
      else b.check(seat);
      continue;
    }
    if (opener < 0) {
      opener = seat;
      b.raiseTo(seat, openTo);
      continue;
    }
    if (raiser < 0 && seat !== opener) {
      if (threeBet) {
        raiser = seat;
        b.raiseTo(seat, threeTo);
      } else {
        b.call(seat);
      }
      continue;
    }
    if (fourBet && seat === opener && b.raises() === 2) {
      b.raiseTo(seat, fourTo);
      continue;
    }
    if (b.owed(seat) > EPS) b.call(seat);
    else b.check(seat);
  }
}

function buildHand(deal: Deal, rng: Rng, stake: Stake, cast: NamePersona[], handId: number): BuiltHand {
  const n = deal.seats;
  const bb = stake.bb;
  const step = stake.sb;
  const participants = Array.from(deal.hole.keys());

  const startStacks: number[] = [];
  for (let i = 0; i < n; i++) {
    const bbs = deal.big ? 140 + rng.int(200) : 70 + rng.int(150);
    startStacks.push(r2(Math.round(bbs) * bb));
  }
  for (const s of participants) startStacks[s] = r2(Math.max(startStacks[s], 180 * bb));

  const b = new HandBuilder(n, startStacks, step, rng);
  const button = n === 2 ? 0 : rng.int(n);
  const sbSeat = n === 2 ? button : (button + 1) % n;
  const bbSeat = n === 2 ? (button + 1) % n : (button + 2) % n;

  b.beginStreet('preflop', n === 2 ? sbSeat : (bbSeat + 1) % n);

  if (deal.format === 'bomb') {
    const ante = r2(Math.max(step, Math.round((bb * 3) / step) * step));
    for (let i = 0; i < n; i++) {
      if (participants.includes(i)) b.ante(i, ante);
      else b.phase[i] = 'folded';
    }
    b.clearBet();
  } else {
    b.post(sbSeat, r2(stake.sb));
    b.post(bbSeat, r2(stake.bb));
    runPreflop(b, rng, participants, bb, deal.big);
  }

  const board: CardId[] = [];
  const streets: Street[] = ['flop', 'turn', 'river'];

  for (const street of streets) {
    if (b.alive().length <= 1) break;
    if (street === 'flop') board.push(deal.board[0], deal.board[1], deal.board[2]);
    else if (street === 'turn') board.push(deal.board[3]);
    else board.push(deal.board[4]);

    // Everyone already all-in: the rest of the board still runs out.
    if (b.canAct().length < 2) continue;

    b.beginStreet(street, firstAliveAfter(b, button, n));
    const isRiver = street === 'river';
    const folder = deal.foldWin && isRiver ? participants.find((p) => p !== deal.focus) ?? null : null;
    const chasingFold = deal.foldWin;
    playStreet(b, rng, participants, {
      betChance: folder !== null ? 1 : deal.big ? 0.86 : 0.6,
      betPct: 0.42 + rng.next() * (deal.big ? 0.62 : 0.34),
      raiseChance: chasingFold ? 0.06 : isRiver && deal.big ? 0.5 : 0.22,
      raiseMult: 2.4 + rng.next() * 0.9,
      jam: !chasingFold && isRiver && deal.big && rng.bool(0.45),
      opener: folder !== null ? deal.focus : null,
      folder,
    });
  }

  const pot = b.pot();
  const survivors = b.alive();
  const omaha = deal.variant === 'plo4';
  const ranks = new Map<number, HandRank>();
  let winners: number[] = [];

  if (survivors.length <= 1 || board.length < 5) {
    winners = survivors.slice(0, 1);
  } else {
    let best = -1;
    for (const s of survivors) {
      const cards = deal.hole.get(s);
      if (!cards) continue;
      const rank = evaluate(cards, board, omaha);
      ranks.set(s, rank);
      if (rank.value > best + EPS) {
        best = rank.value;
        winners = [s];
      } else if (Math.abs(rank.value - best) < EPS) {
        winners.push(s);
      }
    }
  }
  if (!winners.length) winners = survivors.slice(0, 1);

  // House rake: 4.5% capped at 3bb, never taken from a tiny pot.
  const rake = deal.format === 'cash' && pot > bb * 5 ? r2(Math.min(pot * 0.045, bb * 3)) : 0;
  const share = r2((pot - rake) / winners.length);

  const results: ShowdownResult[] = [];
  for (const s of survivors) {
    results.push({
      seat: s,
      rank: ranks.get(s) ?? null,
      won: r2(winners.includes(s) ? share : 0),
      mucked: false,
    });
  }

  // Only cards that were actually turned over are in the replay. When the pot
  // is won without a showdown, the winner is the one choosing to show.
  const revealed = new Set<number>(survivors);

  const seatRows: HandReplay['seats'] = [];
  for (let i = 0; i < n; i++) {
    const p = cast[i % cast.length];
    seatRows.push({
      seat: i,
      name: p.handle,
      avatarId: p.avatarId,
      startStack: startStacks[i],
      holeCards: revealed.has(i) ? deal.hole.get(i) ?? null : null,
    });
  }

  const replay: HandReplay = {
    handId,
    variant: deal.variant,
    stakeLabel: deal.format === 'sng' ? `SNG · ${stake.label}` : stake.label,
    seats: seatRows,
    buttonSeat: button,
    board,
    actions: b.actions,
    results,
    potTotal: pot,
  };

  return { replay, ranks, winners, pot, survivors };
}

// ───────────────────────────── copy ─────────────────────────────

interface Copy {
  headline: string[];
  body?: string[];
}

const COPY: Record<FeedEventKind, Copy> = {
  'bad-beat': {
    headline: [
      'Two outs. He had two outs and he found one of them.',
      'I have never been more certain of a hand in my life.',
      'Flopped the world. Got sent home by the river.',
      'Sat down at nine. Was a different person by four minutes past.',
      'Ran it once. In hindsight I should have run it never.',
      'The river dealer owes me an apology and a drink.',
      'Everything went exactly to plan right up until it didn’t.',
      'I want the hand history framed. I want it burned. Both.',
      'Called the card out loud before it came. Still hurt.',
      'This is the one I will be describing to strangers for years.',
      'Somebody check the deck. Actually don’t, I know what it says.',
      'Perfect read, perfect sizing, perfect disaster.',
      'Twelve percent. Twelve.',
      'Getting it in good is apparently its own reward.',
      'He asked how much I had behind. He should not have been allowed to ask.',
    ],
    body: [
      'Bad beat jackpot when.',
      'Screenshot saved for the therapist.',
      'Logged off. Made tea. Logged back on.',
      'Tell me where I went wrong. Actually, don’t.',
      'Still think I play it identically every single time.',
    ],
  },
  'big-win': {
    headline: [
      'Biggest pot I have ever dragged and my hands are still going.',
      'Waited four hours for exactly this spot.',
      'Got there. Finally, actually got there.',
      'He was never folding and I was never checking.',
      'Cooler for him, groceries for me.',
      'Every street was a decision and every one of them landed.',
      'Stack rebuilt in a single hand. Feels illegal.',
      'This is the one that pays for the whole month.',
      'Sometimes the deck just says yes.',
      'I would like to thank the flop, the turn, and especially the river.',
      'Ran it once, on purpose, and I would do it again tomorrow.',
    ],
    body: [
      'Table went completely quiet.',
      'Rail was watching. Rail approved.',
      'Straight into the bankroll spreadsheet.',
      'Colour me up, I am done for the night.',
    ],
  },
  bluff: {
    headline: [
      'He had it. He folded it. That is all I am going to say.',
      'Told a story across three streets and he believed every word.',
      'Nine high. Say it with me: nine high.',
      'Turned the worst hand at the table into the only one that mattered.',
      'Barrelled into the scariest board I have seen all week.',
      'Sold it so hard I nearly talked myself into folding.',
      'Zero equity, full commitment.',
      'That river card was not for me. He did not need to know that.',
      'Showed it. Obviously I showed it.',
      'This is what a table image is actually for.',
      'He tanked for ninety seconds. I aged ninety years.',
    ],
    body: [
      'Showed one card. The wrong one. On purpose.',
      'Please do not try this at 2NL.',
      'The tank lasted longer than the hand did.',
      'He typed “wow”. That is the entire trophy.',
    ],
  },
  quads: {
    headline: [
      'Quads on a Tuesday. Feels like a clerical error.',
      'Slowplayed it so hard I nearly forgot to bet the river.',
      'Four of a kind, and somebody actually paid it off.',
      'Turned the case card and had to sit very, very still.',
      'Eleven years in. This never gets old.',
      'The only thing better than quads is quads against a full house.',
      'Deck check please. Actually, no — leave it exactly as it is.',
      'Flopped it, bet it, got raised. Best day.',
    ],
    body: [
      'One in four thousand and change.',
      'Straight onto the highlight reel.',
      'He said “nice hand”. He did not mean it.',
    ],
  },
  'straight-flush': {
    headline: [
      'Straight flush. I had to count it three separate times.',
      'The turn completed something I did not think I was allowed to have.',
      'Once in a thousand sessions, and it landed tonight.',
      'He had the flush. He had the very, very good flush.',
      'I have never bet a river this slowly in my life.',
      'Five in a row, all the same colour. Still processing it.',
    ],
    body: [
      'The chat lost it.',
      'Framed, printed, laminated.',
      'This screenshot lives on my phone forever now.',
    ],
  },
  royal: {
    headline: [
      'Royal flush. Nine years of poker and there it finally is.',
      'The card came and the whole room heard about it.',
      'Did not breathe once between the turn and the river.',
      'Broadway, all in one suit, and somebody called.',
      'This is the one you tell people about at weddings.',
    ],
    body: [
      'One in six hundred and forty-nine thousand.',
      'I am never deleting this app.',
      'Called the floor over just to look at it.',
    ],
  },
  bounty: {
    headline: [
      'Knocked out the biggest bounty at the table.',
      'Collected the head and the chips in one motion.',
      'Been hunting that bounty for two solid hours.',
      'He wore the target all night. I finally got there.',
    ],
    body: ['Bounty straight back into the next buy-in.'],
  },
  'level-up': {
    headline: [
      'New level, same terrible calls.',
      'Levelled up mid-session and did not even notice.',
      'The grind pays in tiny increments and I am fine with that.',
      'Another level down. Onwards.',
      'Turns out playing every single day does something.',
    ],
    body: [
      'Unlocked a table skin with it.',
      'Only forty more to the next frame.',
      'Small numbers, big feelings.',
    ],
  },
  'sng-win': {
    headline: [
      'Shipped the sit-and-go. Nine in, one of us left.',
      'Came back from two big blinds. Two.',
      'Heads-up lasted forty minutes and I loved every second of it.',
      'First place. Finally. First place.',
      'Won the bubble, won the deal, won the whole thing.',
      'Chip and a chair, the entire cliché, start to finish.',
    ],
    body: [
      'Straight into the next one.',
      'Third final table this week.',
      'Trophy shelf is no longer empty.',
    ],
  },
  'bomb-pot': {
    headline: [
      'Bomb pot flop and I was the only one who wanted to see a turn.',
      'Everybody antes, everybody prays, one of us scoops.',
      'Scooped the bomb pot with the last card off the deck.',
      'Four ways to the flop and it got loud very quickly.',
      'The bomb pot is the best rule this game has ever added.',
    ],
    body: [
      'No preflop, no problem.',
      'Table asked for another one immediately.',
    ],
  },
  streak: {
    headline: [
      'Six pots in a row. The deck has decided I am the main character.',
      'Cannot lose right now and I refuse to examine why.',
      'Heater confirmed. Do not speak to me.',
      'Running so pure I feel like I owe somebody money.',
      'Fifth straight winning session. Somebody stop me.',
    ],
    body: ['Sample size of one week, confidence of a lifetime.'],
  },
  'friend-joined': {
    headline: [
      'just sat down at your table.',
      'is on the felt for the first time.',
      'joined Royale. Be gentle.',
      'is here. Somebody warn the tables.',
    ],
  },
  cosmetic: {
    headline: [
      'Finally pulled the frame I have been chasing all season.',
      'New card back. Same bad calls, better looking.',
      'Unlocked something I intend to wear for a very long time.',
      'The felt matches my avatar now. This is what winning looks like.',
      'Season pass paid for itself in a single drop.',
    ],
  },
};

const COMMENT_POOL: string[] = [
  'this is genuinely upsetting',
  'sicko',
  'no notes, perfect hand',
  'the turn sizing is filthy',
  'I would have folded flop and gone to bed',
  'how do you even continue after that',
  'insane',
  'gg',
  'you owe the river absolutely nothing',
  'brutal. sorry man',
  'called it before I finished scrolling',
  'this is why I stay at micro',
  'send me the hand history, I want to study it',
  'the tank must have been unbearable',
  'absolute scenes',
  'felt this one in my chest',
  'unreal spot',
  'nicely played, seriously',
  'wait he called with WHAT',
  'the variance tax collector visits us all',
  'you played it perfectly and that is the worst part',
  'framing this',
  'condolences to the bankroll',
  'top tier sizing honestly',
  'I need to see that turn card again',
  'chat went crazy for this one',
  'been there. still recovering',
  'the read here is elite',
  'ok but the fold equity was clearly there',
  'best hand I have seen on here all week',
  'genuinely do not know how you get away from it',
  'take the screenshot and log off',
  'this is not a post, this is evidence',
  'run it back',
  'congrats, thoroughly deserved',
  'you are on an actual heater',
];

const REPLY_POOL: string[] = [
  'right? still thinking about it',
  'exactly what I said out loud',
  'ha, thank you',
  'I wish I could tell you I planned it',
  'the worst part is he tanked first',
  'appreciate it',
  'we move',
  'next one is on me',
  'you have no idea',
];

// ───────────────────────────── post assembly ─────────────────────────────

function pickCopy(rng: Rng, kind: FeedEventKind): { headline: string; body?: string } {
  const c = COPY[kind];
  const headline = c.headline[rng.int(c.headline.length)];
  const body = c.body && rng.bool(0.42) ? c.body[rng.int(c.body.length)] : undefined;
  return { headline, body };
}

function tierFor(kind: FeedEventKind, potBb: number): FeedPost['tier'] {
  if (kind === 'royal' || kind === 'straight-flush') return 'legendary';
  if (kind === 'quads') return potBb > 220 ? 'legendary' : 'epic';
  if (kind === 'bad-beat') return potBb > 260 ? 'epic' : 'rare';
  if (kind === 'sng-win') return 'epic';
  if (kind === 'big-win') return potBb > 300 ? 'epic' : 'rare';
  if (kind === 'bluff') return potBb > 200 ? 'epic' : 'rare';
  if (kind === 'bomb-pot') return potBb > 350 ? 'epic' : 'rare';
  if (kind === 'streak' || kind === 'bounty') return 'rare';
  return 'normal';
}

const TIER_REACTIONS: Record<FeedPost['tier'], [number, number]> = {
  normal: [2, 34],
  rare: [14, 130],
  epic: [64, 380],
  legendary: [190, 940],
};

function seedReactions(rng: Rng, kind: FeedEventKind, tier: FeedPost['tier']): Reaction[] {
  const list = emptyReactions();
  const [lo, hi] = TIER_REACTIONS[tier];
  const total = lo + Math.floor(Math.pow(rng.next(), 1.6) * (hi - lo));
  const primary = defaultReactionFor(kind);
  const others = rng.shuffle(REACTION_KINDS.filter((k) => k !== primary));
  const spread = 2 + rng.int(4);

  const give = (k: ReactionKind, n: number): void => {
    const slot = list.find((r) => r.kind === k);
    if (slot) slot.count += Math.max(0, n);
  };

  const primaryShare = Math.round(total * (0.38 + rng.next() * 0.22));
  give(primary, primaryShare);
  let left = total - primaryShare;
  for (let i = 0; i < spread && left > 0; i++) {
    const take = i === spread - 1 ? left : Math.round(left * (0.3 + rng.next() * 0.4));
    give(others[i], take);
    left -= take;
  }
  if (rng.bool(0.16)) {
    const mine = rng.bool(0.6) ? primary : others[rng.int(others.length)];
    const slot = list.find((r) => r.kind === mine);
    if (slot) {
      slot.mine = true;
      slot.count += 1;
    }
  }
  return list;
}

function seedComments(rng: Rng, postId: string, createdAt: number, now: number, count: number): FeedComment[] {
  const out: FeedComment[] = [];
  // Comments land between the post and "now", never in the future — a feed
  // whose every reply reads "now" is the tell of a fake list.
  const span = Math.max(90_000, now - createdAt);
  const at = (f: number): number => Math.min(now - 4000, createdAt + span * f);
  let f = 0.06 + rng.next() * 0.1;
  let t = at(f);
  for (let i = 0; i < count; i++) {
    const author = playerFromPersona(personaAt(rng.int(PERSONA_POOL_SIZE)));
    const root: FeedComment = {
      id: `${postId}-c${i}`,
      author,
      text: COMMENT_POOL[rng.int(COMMENT_POOL.length)],
      createdAt: t,
    };
    out.push(root);
    f = Math.min(0.96, f + 0.05 + rng.next() * 0.16);
    t = at(f);
    if (rng.bool(0.3)) {
      out.push({
        id: `${root.id}-r0`,
        author: playerFromPersona(personaAt(rng.int(PERSONA_POOL_SIZE))),
        text: `@${root.author.name} ${REPLY_POOL[rng.int(REPLY_POOL.length)]}`,
        createdAt: t,
      });
      f = Math.min(0.98, f + 0.03 + rng.next() * 0.1);
      t = at(f);
    }
  }
  return out;
}

/** Turns an evaluated hand into the event kind the feed files it under. */
function deriveKind(want: FeedEventKind, winner: HandRank | null): FeedEventKind {
  if (want === 'bad-beat') return 'bad-beat';
  if (winner?.category === 'straight-flush') return winner.label === 'Royal Flush' ? 'royal' : 'straight-flush';
  if (winner?.category === 'quads') return 'quads';
  if (want === 'royal' || want === 'straight-flush') return 'big-win';
  return want;
}

type RecipeName =
  | 'quads' | 'royal' | 'straight-flush' | 'bad-beat-quads' | 'bad-beat-boat'
  | 'bad-beat-straight' | 'set-over-set' | 'bluff' | 'bomb' | 'sng' | 'omaha';

const RECIPE_WEIGHTS: Array<[RecipeName, number]> = [
  ['bad-beat-quads', 9],
  ['bad-beat-boat', 9],
  ['bad-beat-straight', 7],
  ['set-over-set', 11],
  ['bluff', 12],
  ['quads', 8],
  ['straight-flush', 4],
  ['royal', 2],
  ['bomb', 8],
  ['sng', 7],
  ['omaha', 6],
];

function weightedRecipe(rng: Rng): RecipeName {
  let total = 0;
  for (const [, w] of RECIPE_WEIGHTS) total += w;
  let t = rng.next() * total;
  for (const [name, w] of RECIPE_WEIGHTS) {
    t -= w;
    if (t <= 0) return name;
  }
  return 'set-over-set';
}

/** A post with a real hand attached. */
function makeHandPost(rng: Rng, createdAt: number, now: number, index: number): FeedPost {
  const deck = new Deck(rng);
  const recipe = weightedRecipe(rng);
  // Marquee hands are worth showing at stakes where the money reads.
  const floor = recipe === 'royal' || recipe === 'straight-flush' || recipe === 'quads' || recipe === 'sng' ? 2 : 0;
  const ladderIdx = Math.max(
    floor,
    Math.min(STAKE_LADDER.length - 1, Math.floor(Math.pow(rng.next(), 1.15) * STAKE_LADDER.length)),
  );
  const stake = STAKES[STAKE_LADDER[ladderIdx]];

  let hero = rng.int(6);
  let villain = (hero + 1 + rng.int(5)) % 6;
  let deal: Deal;
  switch (recipe) {
    case 'quads':
      deal = dealQuads(deck, rng, hero, villain);
      break;
    case 'royal':
      deal = dealStraightFlush(deck, rng, hero, villain, true);
      break;
    case 'straight-flush':
      deal = dealStraightFlush(deck, rng, hero, villain, false);
      break;
    case 'bad-beat-quads':
      deal = dealBadBeatQuads(deck, rng, hero, villain);
      break;
    case 'bad-beat-boat':
      deal = dealBadBeatFlushVsBoat(deck, rng, hero, villain);
      break;
    case 'bad-beat-straight':
      deal = dealBadBeatStraight(deck, rng, hero, villain);
      break;
    case 'bluff':
      deal = dealBluff(deck, rng, hero, villain);
      break;
    case 'bomb': {
      const seatsIn: number[] = [];
      for (const s of [hero, villain, (villain + 2) % 6, (villain + 4) % 6]) {
        if (!seatsIn.includes(s)) seatsIn.push(s);
      }
      deal = dealBombPot(deck, rng, seatsIn);
      break;
    }
    case 'sng':
      hero = 0;
      villain = 1;
      deal = dealSngFinal(deck, rng);
      break;
    default:
      deal = dealOmahaCooler(deck, rng, hero, villain);
      break;
  }

  const cast: NamePersona[] = [];
  for (let i = 0; i < deal.seats; i++) cast.push(personaAt(rng.int(PERSONA_POOL_SIZE)));

  const handId = 4_100_000 + index * 977 + rng.int(400);
  const { replay, ranks, winners, pot, survivors } = buildHand(deal, rng, stake, cast, handId);

  const wentToShowdown = ranks.size >= 2;
  const winner = winners[0] ?? deal.focus;
  const loser = Array.from(ranks.keys()).find((s) => !winners.includes(s)) ?? -1;

  // A bluff that got called is no longer a bluff; the story follows the cards.
  let want = deal.want;
  if (deal.foldWin && wentToShowdown) want = 'big-win';
  if (!deal.foldWin && survivors.length <= 1) want = 'big-win';

  const wantsBeat = want === 'bad-beat' && loser >= 0;
  const authorSeat = wantsBeat ? loser : winner;
  const kind = deriveKind(want, ranks.get(winner) ?? null);

  const author = playerFromPersona(cast[authorSeat % cast.length]);
  const potBb = pot / stake.bb;
  const tier = tierFor(kind, potBb);
  const copy = pickCopy(rng, kind);
  const id = `fp-${handId.toString(36)}-${index.toString(36)}`;
  const commentCount = tier === 'legendary' ? 3 + rng.int(5) : tier === 'epic' ? 1 + rng.int(4) : rng.int(3);

  return {
    id,
    kind,
    author,
    createdAt,
    headline: copy.headline,
    body: copy.body,
    hand: replay,
    reactions: seedReactions(rng, kind, tier),
    comments: seedComments(rng, id, createdAt, now, commentCount),
    stakeLabel: stake.label,
    variant: deal.variant,
    amount: r2(pot),
    tier,
  };
}

const COSMETIC_DROPS: Array<{ name: string; rarity: string }> = [
  { name: 'Laurel Frame', rarity: 'legendary' },
  { name: 'Obsidian Card Back', rarity: 'epic' },
  { name: 'Midnight Felt', rarity: 'epic' },
  { name: 'Brass Chip Set', rarity: 'rare' },
  { name: 'Ember Frame', rarity: 'legendary' },
  { name: 'Glacier Table Skin', rarity: 'epic' },
  { name: 'Ivory Deck', rarity: 'rare' },
  { name: '“Nit Wizard” Title', rarity: 'rare' },
  { name: 'Royale Crown Frame', rarity: 'legendary' },
];

const LEVEL_TITLES = ['Grinder', 'Regular', 'Shark', 'Veteran', 'Pro'];

/** A post with no hand: milestones, unlocks, arrivals. */
function makeSocialPost(rng: Rng, createdAt: number, now: number, index: number): FeedPost {
  const roll = rng.next();
  const kind: FeedEventKind =
    roll < 0.34 ? 'level-up' : roll < 0.68 ? 'cosmetic' : roll < 0.86 ? 'friend-joined' : 'streak';
  const author = playerFromPersona(personaAt(rng.int(PERSONA_POOL_SIZE)));
  const copy = pickCopy(rng, kind);
  const id = `fp-s${index.toString(36)}-${rng.int(0x7fffffff).toString(36)}`;

  let headline = copy.headline;
  let body = copy.body;
  let tier: FeedPost['tier'] = 'normal';
  let amount: number | undefined;

  if (kind === 'friend-joined') {
    headline = `${author.name} ${copy.headline}`;
  } else if (kind === 'level-up') {
    body = `Level ${author.level} · ${LEVEL_TITLES[Math.min(4, Math.floor(author.level / 24))]}`;
    tier = author.level % 25 === 0 ? 'rare' : 'normal';
  } else if (kind === 'cosmetic') {
    const drop = COSMETIC_DROPS[rng.int(COSMETIC_DROPS.length)];
    body = `${drop.name} · ${drop.rarity}`;
    tier = drop.rarity === 'legendary' ? 'epic' : 'rare';
  } else {
    tier = 'rare';
    amount = r2(20 + rng.int(900));
  }

  return {
    id,
    kind,
    author,
    createdAt,
    headline,
    body,
    hand: null,
    reactions: seedReactions(rng, kind, tier),
    comments: seedComments(rng, id, createdAt, now, rng.int(3)),
    amount,
    tier,
  };
}

/**
 * Ages posts realistically: dense over the last few hours, thinning out across
 * the previous days, and never two on the same millisecond.
 */
function ageFor(rng: Rng, i: number, count: number, span: number): number {
  const t = (i + rng.next() * 0.85) / count;
  return Math.round(Math.pow(t, 1.85) * span) + rng.int(90_000);
}

export interface FeedGenOptions {
  seed: number;
  count: number;
  now: number;
  /** oldest post age in ms; default 4.2 days */
  span?: number;
}

/** The seeded feed. Deterministic for a given seed. */
export function generateFeed(opts: FeedGenOptions): FeedPost[] {
  const rng = new Rng(opts.seed >>> 0);
  const span = opts.span ?? 4.2 * 24 * 3600 * 1000;
  const posts: FeedPost[] = [];
  for (let i = 0; i < opts.count; i++) {
    const createdAt = opts.now - ageFor(rng, i, opts.count, span);
    // Roughly one post in five is a milestone rather than a hand: enough to
    // break the rhythm of snapshots without diluting the feed.
    posts.push(rng.bool(0.2) ? makeSocialPost(rng, createdAt, opts.now, i) : makeHandPost(rng, createdAt, opts.now, i));
  }
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return posts;
}

/** One fresh post, for the live "N new" ticker. */
export function generateLivePost(seed: number, now: number): FeedPost {
  const rng = new Rng(seed >>> 0);
  const index = 900 + (Math.abs(seed) % 9000);
  const post = rng.bool(0.16) ? makeSocialPost(rng, now, now, index) : makeHandPost(rng, now, now, index);
  post.createdAt = now;
  // Brand-new posts have not had time to gather a crowd.
  for (const r of post.reactions) {
    r.count = Math.min(r.count, rng.int(6));
    r.mine = false;
  }
  post.comments = post.comments.slice(0, rng.int(2));
  return post;
}

/** Friends-only slice, used by the Friends filter. */
export function isFriendPost(post: FeedPost): boolean {
  return isFriend(post.author.id);
}

/** Label for an arbitrary holding — the replay viewer's showdown row. */
export function describeHand(hole: CardId[], board: CardId[], variant: GameVariant): string {
  return evaluate(hole, board, variant === 'plo4').label;
}
