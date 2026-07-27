/**
 * Scripted fallback table.
 *
 * The screen must never be empty. If `src/engine/table.ts` cannot be loaded or
 * throws, this driver takes over: a genuine (if simple) no-limit hold'em loop
 * with blinds, four betting rounds, side pots, a showdown and payouts, playing
 * against six bots with real (if modest) judgement.
 *
 * It emits exactly the same bus events as the engine, so the renderer, audio
 * and the rest of the HUD cannot tell the difference.
 */

import { bus } from '../../core/bus.ts';
import type { LegalAction } from '../../core/bus.ts';
import { Rng } from '../../core/rng.ts';
import { STAKES } from '../../core/stakes.ts';
import type {
  Action,
  ActionKind,
  CardId,
  PlayerRef,
  Pot,
  SeatState,
  SeatStatus,
  Stake,
  StakeId,
  Street,
  TableState,
} from '../../core/types.ts';
import { analyze, evalBest } from './handstrength.ts';

const NAMES = [
  'Marisol', 'Dax', 'Nkechi', 'Yuki', 'Ferran', 'Petra',
  'Oleg', 'Amara', 'Bao', 'Rune', 'Sable', 'Tomas',
];

interface DSeat {
  index: number;
  player: PlayerRef | null;
  stack: number;
  committed: number;
  totalCommitted: number;
  hole: CardId[];
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  inHand: boolean;
  sitOut: boolean;
  sitOutNext: boolean;
  revealed: boolean;
  wonLast: boolean;
  status: SeatStatus;
  lastAction: Action | null;
  timeBankMs: number;
  isHero: boolean;
}

export interface DemoTableOptions {
  stakeId?: StakeId;
  seatCount?: number;
  heroSeat?: number;
  heroName?: string;
  buyIn?: number;
  seed?: number;
}

const HERO_CLOCK = 25_000;

export class DemoTable {
  readonly stake: Stake;
  readonly heroSeat: number;
  private seats: DSeat[] = [];
  private rng: Rng;
  private deck: number[] = [];
  private deckPos = 0;
  private board: CardId[] = [];
  private pots: Pot[] = [];
  private street: Street = 'preflop';
  private handId = 0;
  private buttonSeat = 0;
  private actingSeat = -1;
  private currentBet = 0;
  private lastRaise = 0;
  private minRaiseTo = 0;
  private seq = 0;
  private tick = 0;
  private timers = new Set<number>();
  private running = false;
  private heroDeadline = 0;
  private clockHandle = 0;

  constructor(opts: DemoTableOptions = {}) {
    this.stake = STAKES[opts.stakeId ?? 'nl10'];
    this.heroSeat = opts.heroSeat ?? 0;
    this.rng = new Rng(opts.seed ?? 0x9a3c17);
    const count = Math.max(2, Math.min(9, opts.seatCount ?? 6));
    const buyIn = opts.buyIn ?? this.stake.bb * 100;
    const pool = this.rng.shuffle(NAMES.slice());
    for (let i = 0; i < count; i++) {
      const isHero = i === this.heroSeat;
      const name = isHero ? (opts.heroName ?? 'You') : pool[i % pool.length];
      this.seats.push({
        index: i,
        player: {
          id: isHero ? 'you' : `bot-${i}`,
          name,
          avatarId: `av-${i}`,
          frameId: null,
          titleId: null,
          emoteSetId: 'emote-core',
          level: isHero ? 12 : 3 + this.rng.int(48),
          premium: false,
          heat: this.rng.next() * 0.8,
        },
        stack: isHero ? buyIn : this.q(this.stake.bb * this.rng.range(64, 168)),
        committed: 0,
        totalCommitted: 0,
        hole: [],
        folded: false,
        allIn: false,
        acted: false,
        inHand: false,
        sitOut: false,
        sitOutNext: false,
        revealed: isHero,
        wonLast: false,
        status: 'waiting',
        lastAction: null,
        timeBankMs: 0,
        isHero,
      });
    }
    this.buttonSeat = this.rng.int(count);
  }

  // ── public driver surface (mirrors LocalTable) ────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emitState();
    this.after(700, () => this.beginHand());
    this.clockHandle = window.setInterval(() => this.pumpClock(), 100);
  }

  destroy(): void {
    this.running = false;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    if (this.clockHandle) clearInterval(this.clockHandle);
    this.clockHandle = 0;
  }

  state(): TableState {
    return this.build();
  }

  legalActions(): LegalAction[] {
    const seat = this.seats[this.actingSeat];
    if (!seat || !seat.isHero) return [];
    return this.legalFor(seat);
  }

  act(kind: ActionKind, amount = 0): boolean {
    const seat = this.seats[this.actingSeat];
    if (!seat || !seat.isHero) return false;
    const legal = this.legalFor(seat);
    const entry = legal.find((l) => l.kind === kind);
    if (!entry) return false;
    const target = kind === 'bet' || kind === 'raise' ? this.clamp(amount, entry.min, entry.max) : entry.max;
    this.heroDeadline = 0;
    this.apply(seat, kind, target);
    return true;
  }

  sitOut(on: boolean): void {
    const hero = this.seats[this.heroSeat];
    if (!hero) return;
    hero.sitOutNext = on;
    if (!hero.inHand) {
      hero.sitOut = on;
      hero.status = on ? 'sitting-out' : 'waiting';
    }
    this.emitState();
  }

  rebuy(amount: number): boolean {
    const hero = this.seats[this.heroSeat];
    if (!hero || amount <= 0) return false;
    hero.stack = this.q(hero.stack + amount);
    if (hero.status === 'busted') hero.status = 'waiting';
    hero.sitOut = false;
    hero.sitOutNext = false;
    this.emitState();
    return true;
  }

  // ── hand lifecycle ────────────────────────────────────────────────

  private beginHand(): void {
    if (!this.running) return;
    for (const s of this.seats) {
      if (s.sitOutNext !== s.sitOut) {
        s.sitOut = s.sitOutNext;
        s.status = s.sitOut ? 'sitting-out' : 'waiting';
      }
      if (!s.isHero && s.stack < this.stake.bb * 2) s.stack = this.q(this.stake.bb * this.rng.range(80, 160));
    }
    const live = this.seats.filter((s) => !s.sitOut && s.stack > 0);
    if (live.length < 2) {
      this.emitState();
      this.after(1400, () => this.beginHand());
      return;
    }

    this.handId++;
    this.street = 'preflop';
    this.board = [];
    this.pots = [];
    this.seq = 0;
    this.currentBet = 0;
    this.shuffle();

    for (const s of this.seats) {
      s.committed = 0;
      s.totalCommitted = 0;
      s.hole = [];
      s.folded = false;
      s.allIn = false;
      s.acted = false;
      s.lastAction = null;
      s.revealed = s.isHero;
      s.wonLast = false;
      s.timeBankMs = 0;
      s.inHand = !s.sitOut && s.stack > 0;
      s.status = s.inHand ? 'active' : s.sitOut ? 'sitting-out' : 'waiting';
    }

    this.buttonSeat = this.nextIn(this.buttonSeat);
    bus.emit('hand:start', { handId: this.handId, buttonSeat: this.buttonSeat });
    bus.emit('cam:focus', { seat: null, intensity: 0.2 });

    const order = this.orbit();
    const sb = order.length === 2 ? this.seats[this.buttonSeat] : order[0];
    const bb = order.length === 2 ? (order[0] === sb ? order[1] : order[0]) : order[1];
    this.commit(sb, Math.min(this.stake.sb, sb.stack));
    this.commit(bb, Math.min(this.stake.bb, bb.stack));
    this.currentBet = this.stake.bb;
    this.lastRaise = this.stake.bb;
    this.minRaiseTo = this.q(this.stake.bb * 2);

    let delay = 0;
    let order2 = 0;
    for (let round = 0; round < 2; round++) {
      for (const s of order) {
        const card = this.draw();
        s.hole.push(card);
        const seat = s.index;
        const faceUp = s.isHero;
        const idx = order2++;
        this.after(delay, () => bus.emit('hand:deal-hole', { seat, cards: [card], faceUp, order: idx }));
        delay += 80;
      }
    }
    this.after(delay + 380, () => {
      this.emitState();
      this.beginStreet('preflop');
    });
  }

  private beginStreet(street: Street): void {
    this.street = street;
    if (street !== 'preflop') {
      this.currentBet = 0;
      this.lastRaise = this.stake.bb;
      this.minRaiseTo = this.stake.bb;
      for (const s of this.seats) {
        s.committed = 0;
        s.acted = false;
      }
    }
    const contenders = this.seats.filter((s) => s.inHand && !s.folded);
    if (contenders.length <= 1) {
      this.finish();
      return;
    }
    if (contenders.filter((s) => !s.allIn && s.stack > 0).length <= 1 && street !== 'preflop') {
      this.runOut();
      return;
    }
    this.emitState();
    const order = this.orbit().filter((s) => s.inHand && !s.folded);
    const first = street === 'preflop' ? (order[2] ?? order[0]) : order[0];
    this.advance(first.index);
  }

  private advance(from: number): void {
    if (!this.running) return;
    const seat = this.nextToAct(from);
    if (!seat) {
      this.closeStreet();
      return;
    }
    this.actingSeat = seat.index;
    const clock = seat.isHero ? HERO_CLOCK : 0;
    seat.timeBankMs = clock;
    this.heroDeadline = seat.isHero ? performance.now() + clock : 0;
    bus.emit('hand:turn', { seat: seat.index, timeMs: clock, legal: this.legalFor(seat) });
    bus.emit('cam:focus', { seat: seat.index, intensity: seat.isHero ? 0.35 : 0.6 });
    this.emitState();
    if (seat.isHero) return;
    this.after(520 + this.rng.int(1100), () => {
      if (this.actingSeat !== seat.index) return;
      const d = this.decide(seat);
      this.apply(seat, d.kind, d.amount);
    });
  }

  private apply(seat: DSeat, kind: ActionKind, amount: number): void {
    const toCall = this.q(Math.min(this.currentBet - seat.committed, seat.stack));
    let recorded = seat.committed;

    if (kind === 'fold') {
      seat.folded = true;
      seat.status = 'folded';
      recorded = 0;
    } else if (kind === 'call') {
      this.commit(seat, toCall);
      recorded = seat.committed;
    } else if (kind === 'bet' || kind === 'raise' || kind === 'allin') {
      const cap = this.q(seat.committed + seat.stack);
      const target = kind === 'allin' ? cap : this.clamp(amount, this.minRaiseTo, cap);
      this.commit(seat, this.q(Math.min(target - seat.committed, seat.stack)));
      recorded = seat.committed;
      if (seat.committed > this.currentBet + 1e-9) {
        const size = this.q(seat.committed - this.currentBet);
        const full = size >= this.lastRaise - 1e-9;
        if (full) {
          this.lastRaise = size;
          for (const o of this.seats) if (o !== seat && o.inHand && !o.folded && !o.allIn) o.acted = false;
        }
        this.currentBet = seat.committed;
        this.minRaiseTo = this.q(this.currentBet + this.lastRaise);
      }
    }

    seat.acted = true;
    if (seat.stack <= 1e-9 && !seat.folded) {
      seat.allIn = true;
      seat.status = 'allin';
      bus.emit('fx:burst', { kind: 'allin', seat: seat.index });
      bus.emit('cam:shake', { amount: 0.3, ms: 240 });
    }

    const action: Action = {
      kind: seat.allIn && kind !== 'fold' && kind !== 'check' ? 'allin' : kind,
      amount: this.q(recorded),
      seat: seat.index,
      seq: this.seq++,
      street: this.street,
    };
    seat.lastAction = action;
    this.actingSeat = -1;
    this.heroDeadline = 0;
    bus.emit('hand:action', { action, state: this.build() });
    this.recomputePots();

    const live = this.seats.filter((s) => s.inHand && !s.folded);
    if (live.length <= 1) {
      this.after(340, () => this.finish());
      return;
    }
    this.after(200, () => this.advance((seat.index + 1) % this.seats.length));
  }

  private closeStreet(): void {
    const moved = this.seats.filter((s) => s.inHand && s.committed > 0).map((s) => s.index);
    const total = this.q(this.seats.reduce((a, s) => a + s.committed, 0));
    if (total > 0) bus.emit('hand:collect', { seats: moved, total });
    for (const s of this.seats) s.committed = 0;
    this.currentBet = 0;
    this.recomputePots();

    const live = this.seats.filter((s) => s.inHand && !s.folded);
    if (live.length <= 1) {
      this.after(480, () => this.finish());
      return;
    }
    if (live.filter((s) => !s.allIn && s.stack > 0).length <= 1) {
      this.after(480, () => this.runOut());
      return;
    }
    const next = this.nextStreet(this.street);
    if (!next) {
      this.after(480, () => this.finish());
      return;
    }
    this.after(520, () => this.dealBoard(next, () => this.beginStreet(next)));
  }

  private dealBoard(street: Street, done: () => void): void {
    const count = street === 'flop' ? 3 : 1;
    const cards: CardId[] = [];
    for (let i = 0; i < count; i++) cards.push(this.draw());
    this.board.push(...cards);
    this.street = street;
    bus.emit('hand:deal-board', { street, cards, boardIndex: 0 });
    bus.emit('ui:haptic', { pattern: 'deal' });
    this.after(240 * count + 420, () => {
      this.emitState();
      done();
    });
  }

  private runOut(): void {
    this.actingSeat = -1;
    this.emitState();
    const step = (): void => {
      const next = this.nextStreet(this.street);
      if (!next) {
        this.after(760, () => this.finish());
        return;
      }
      this.dealBoard(next, () => this.after(760, step));
    };
    this.after(720, step);
  }

  private finish(): void {
    this.actingSeat = -1;
    const pots = this.buildPots();
    const live = this.seats.filter((s) => s.inHand && !s.folded);
    const contested = live.length > 1;
    const ranks = new Map<number, number>();
    const results: Array<{ seat: number; rank: ReturnType<typeof evalBest> | null; won: number; mucked: boolean }> = [];

    if (contested && this.board.length >= 3) {
      for (const s of live) ranks.set(s.index, evalBest(s.hole.concat(this.board)).value);
    }

    const awards = new Map<number, number>();
    for (const pot of pots) {
      const eligible = pot.eligible.filter((i) => live.some((s) => s.index === i));
      if (eligible.length === 0) continue;
      let best = -1;
      let winners: number[] = [];
      for (const seatIndex of eligible) {
        const v = contested ? (ranks.get(seatIndex) ?? -1) : 1;
        if (v > best) {
          best = v;
          winners = [seatIndex];
        } else if (v === best) winners.push(seatIndex);
      }
      const share = this.q(pot.amount / winners.length);
      for (const w of winners) awards.set(w, this.q((awards.get(w) ?? 0) + share));
    }

    let delay = 0;
    if (contested) {
      for (const s of live) {
        const seatIndex = s.index;
        this.after(delay, () => {
          this.seats[seatIndex].revealed = true;
          this.emitState();
        });
        delay += 340;
      }
    }

    for (const s of live) {
      const rank = contested && this.board.length >= 3 ? evalBest(s.hole.concat(this.board)) : null;
      results.push({ seat: s.index, rank, won: awards.get(s.index) ?? 0, mucked: false });
    }

    this.after(delay, () => {
      if (contested) {
        bus.emit('hand:showdown', {
          results: results.map((r) => ({ seat: r.seat, rank: r.rank, won: r.won, mucked: r.mucked })),
          pots: pots.map((p) => ({ ...p })),
        });
      }
      let payDelay = 0;
      for (const [seat, amount] of awards) {
        this.after(payDelay, () => {
          this.seats[seat].stack = this.q(this.seats[seat].stack + amount);
          this.seats[seat].wonLast = true;
          bus.emit('hand:award', { seat, amount, potIndex: 0 });
          bus.emit('fx:burst', { kind: 'chips-win', seat });
          this.emitState();
        });
        payDelay += 180;
      }
      this.after(payDelay + 900, () => {
        for (const s of this.seats) {
          if (s.stack <= 0 && !s.isHero) s.status = 'busted';
          s.inHand = false;
        }
        bus.emit('hand:end', { handId: this.handId });
        bus.emit('cam:focus', { seat: null, intensity: 0.15 });
        this.pots = [];
        this.emitState();
        this.after(1500, () => this.beginHand());
      });
    });
  }

  // ── bots ──────────────────────────────────────────────────────────

  private decide(seat: DSeat): { kind: ActionKind; amount: number } {
    const toCall = this.q(Math.max(0, Math.min(this.currentBet - seat.committed, seat.stack)));
    const pot = this.q(this.seats.reduce((a, s) => a + s.totalCommitted, 0));
    const insight = analyze(seat.hole, this.board);
    const strength = Math.min(0.98, insight.strength + insight.equity * 0.35);
    const aggression = 0.18 + this.rng.next() * 0.3;
    const cap = this.q(seat.committed + seat.stack);

    if (toCall <= 1e-9) {
      if (strength > 0.55 || this.rng.next() < aggression * 0.5) {
        const size = this.clamp(this.q(seat.committed + pot * (0.4 + this.rng.next() * 0.5)), this.minRaiseTo, cap);
        return { kind: this.currentBet > 0 ? 'raise' : 'bet', amount: size };
      }
      return { kind: 'check', amount: seat.committed };
    }

    const odds = toCall / Math.max(1e-6, pot + toCall);
    if (strength > 0.72 && this.rng.next() < 0.55 && cap > this.minRaiseTo) {
      const size = this.clamp(this.q(this.currentBet * (2.2 + this.rng.next() * 1.4)), this.minRaiseTo, cap);
      return { kind: 'raise', amount: size };
    }
    if (strength + 0.1 > odds || (this.rng.next() < 0.14 && toCall < seat.stack * 0.2)) {
      return { kind: 'call', amount: toCall };
    }
    return { kind: 'fold', amount: 0 };
  }

  private pumpClock(): void {
    if (!this.heroDeadline) return;
    const left = this.heroDeadline - performance.now();
    const hero = this.seats[this.heroSeat];
    if (hero) hero.timeBankMs = Math.max(0, left);
    if (left <= 0) {
      this.heroDeadline = 0;
      const seat = this.seats[this.actingSeat];
      if (seat && seat.isHero) {
        const toCall = this.currentBet - seat.committed;
        this.apply(seat, toCall <= 1e-9 ? 'check' : 'fold', seat.committed);
        bus.emit('ui:toast', { text: 'Time expired', tone: 'bad', ms: 1400 });
      }
    }
  }

  // ── plumbing ──────────────────────────────────────────────────────

  private legalFor(seat: DSeat): LegalAction[] {
    const out: LegalAction[] = [];
    const pot = this.q(this.seats.reduce((a, s) => a + s.totalCommitted, 0));
    const toCall = this.q(Math.max(0, Math.min(this.currentBet - seat.committed, seat.stack)));
    const cap = this.q(seat.committed + seat.stack);

    if (toCall > 1e-9) {
      out.push({ kind: 'fold', min: 0, max: 0 });
      out.push({ kind: 'call', min: this.q(seat.committed + toCall), max: this.q(seat.committed + toCall) });
    } else {
      out.push({ kind: 'check', min: seat.committed, max: seat.committed });
    }

    if (seat.stack > toCall + 1e-9) {
      const minTo = Math.min(this.q(Math.max(this.currentBet + this.lastRaise, this.stake.bb)), cap);
      const kind: ActionKind = this.currentBet > 1e-9 ? 'raise' : 'bet';
      const after = this.q(pot + toCall);
      const presets: Array<{ label: string; amount: number }> = [];
      const add = (label: string, amount: number): void => {
        const a = this.clamp(amount, minTo, cap);
        if (!presets.some((p) => Math.abs(p.amount - a) < 0.005)) presets.push({ label, amount: a });
      };
      if (this.street === 'preflop' && this.currentBet > 1e-9) {
        add('2.5x', this.q(this.currentBet * 2.5));
        add('3x', this.q(this.currentBet * 3));
        add('4x', this.q(this.currentBet * 4));
      } else {
        add('⅓', this.q(seat.committed + toCall + after * 0.33));
        add('½', this.q(seat.committed + toCall + after * 0.5));
        add('¾', this.q(seat.committed + toCall + after * 0.75));
        add('Pot', this.q(seat.committed + toCall + after));
      }
      add('All in', cap);
      out.push({ kind, min: minTo, max: cap, presets });
      out.push({ kind: 'allin', min: cap, max: cap });
    }
    return out;
  }

  private recomputePots(): void {
    this.pots = this.buildPots();
    const total = this.q(this.pots.reduce((a, p) => a + p.amount, 0));
    bus.emit('hand:pot-update', { pots: this.pots.map((p) => ({ ...p })), total });
  }

  private buildPots(): Pot[] {
    const totals = this.seats.map((s) => (s.inHand ? this.q(s.totalCommitted) : 0));
    const dead = this.seats.map((s) => !s.inHand || s.folded);
    const levels = Array.from(new Set(totals.filter((t) => t > 0))).sort((a, b) => a - b);
    const pots: Pot[] = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0;
      const eligible: number[] = [];
      for (let i = 0; i < totals.length; i++) {
        if (totals[i] <= prev) continue;
        amount += Math.min(totals[i], lvl) - prev;
        if (!dead[i] && totals[i] >= lvl - 1e-9) eligible.push(i);
      }
      amount = this.q(amount);
      if (amount <= 0) continue;
      const last = pots[pots.length - 1];
      if (last && (eligible.length === 0 || same(last.eligible, eligible))) last.amount = this.q(last.amount + amount);
      else pots.push({ amount, eligible, index: pots.length });
      prev = lvl;
    }
    return pots.map((p, i) => ({ ...p, index: i }));
  }

  private nextToAct(from: number): DSeat | null {
    const order = this.orbit();
    const start = order.findIndex((s) => s.index === from);
    const base = start < 0 ? 0 : start;
    for (let i = 0; i < order.length; i++) {
      const s = order[(base + i) % order.length];
      if (!s.inHand || s.folded || s.allIn || s.stack <= 0) continue;
      if (!s.acted || s.committed < this.currentBet - 1e-9) return s;
    }
    return null;
  }

  private orbit(): DSeat[] {
    const out: DSeat[] = [];
    for (let i = 1; i <= this.seats.length; i++) {
      const s = this.seats[(this.buttonSeat + i) % this.seats.length];
      if (s.inHand) out.push(s);
    }
    if (out.length === 0) {
      for (let i = 1; i <= this.seats.length; i++) {
        const s = this.seats[(this.buttonSeat + i) % this.seats.length];
        if (!s.sitOut && s.stack > 0) out.push(s);
      }
    }
    return out;
  }

  private nextIn(from: number): number {
    for (let i = 1; i <= this.seats.length; i++) {
      const idx = (from + i) % this.seats.length;
      const s = this.seats[idx];
      if (!s.sitOut && s.stack > 0) return idx;
    }
    return from;
  }

  private nextStreet(s: Street): Street | null {
    return s === 'preflop' ? 'flop' : s === 'flop' ? 'turn' : s === 'turn' ? 'river' : null;
  }

  private commit(seat: DSeat, amount: number): void {
    const add = this.q(Math.max(0, Math.min(amount, seat.stack)));
    if (add <= 0) return;
    seat.stack = this.q(seat.stack - add);
    seat.committed = this.q(seat.committed + add);
    seat.totalCommitted = this.q(seat.totalCommitted + add);
    if (seat.stack <= 1e-9) {
      seat.allIn = true;
      if (!seat.folded) seat.status = 'allin';
    }
  }

  private shuffle(): void {
    this.deck = [];
    for (let c = 0; c < 52; c++) this.deck.push(c);
    this.rng.shuffle(this.deck);
    this.deckPos = 0;
  }

  private draw(): CardId {
    if (this.deckPos >= this.deck.length) this.shuffle();
    return this.deck[this.deckPos++];
  }

  private clamp(v: number, lo: number, hi: number): number {
    const q = this.q(v);
    return q <= lo ? lo : q >= hi ? hi : q;
  }

  private q(v: number): number {
    return Math.round(v * 100) / 100;
  }

  private after(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (this.running) fn();
    }, ms);
    this.timers.add(id);
  }

  private build(): TableState {
    const seats: SeatState[] = this.seats.map((s) => ({
      index: s.index,
      status: s.status,
      player: s.player,
      stack: s.stack,
      committed: s.committed,
      totalCommitted: s.totalCommitted,
      holeCards: s.revealed ? s.hole.slice() : [],
      revealed: s.revealed,
      isButton: s.index === this.buttonSeat,
      isTurn: s.index === this.actingSeat,
      timeBankMs: s.timeBankMs,
      lastAction: s.lastAction,
      wonLast: s.wonLast,
      sitOutNextHand: s.sitOutNext,
    }));
    return {
      id: 'demo',
      variant: 'nlhe',
      format: 'cash',
      stake: this.stake,
      seats,
      board: this.board.slice(),
      pots: this.pots.map((p) => ({ ...p })),
      street: this.street,
      handId: this.handId,
      buttonSeat: this.buttonSeat,
      actingSeat: this.actingSeat,
      currentBet: this.currentBet,
      lastRaiseSize: this.lastRaise,
      minRaiseTo: this.minRaiseTo,
      bombPot: null,
      tournament: null,
      rake: 0,
      tick: this.tick++,
    };
  }

  private emitState(): void {
    bus.emit('table:state', { state: this.build(), you: this.heroSeat });
  }
}

function same(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
