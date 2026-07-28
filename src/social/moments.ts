/**
 * ROYALE — social/moments.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Automatic moment capture. It listens to the table on the bus, records every
 * hand as it happens, and when something worth telling people about happens to
 * the *local* player it assembles a finished `FeedPost` — replay attached —
 * and offers it for sharing.
 *
 *   const stop = momentCapture.start();
 *   momentCapture.onOffer((offer) => showShareSheet(offer));
 *   momentCapture.share(offer.id);        // → bus 'feed:post'
 *
 * Nothing is ever posted without the player accepting the offer. This module
 * builds and queues; the UI decides.
 */
import { bus } from '../core/bus.ts';
import { chips as chipsFmt } from '../core/stakes.ts';

/** Poker-room money: two decimals only when they carry information. */
function cash(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 10_000) return `${sign}$${(a / 1000).toFixed(1)}K`;
  if (a >= 1000) return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
  const fixed = a.toFixed(2);
  return `${sign}$${fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed}`;
}
import type {
  Action,
  CardId,
  FeedEventKind,
  FeedPost,
  HandReplay,
  ShowdownResult,
  Street,
  TableState,
} from '../core/types.ts';
import { LOCAL_PERSONA, playerFromPersona } from '../data/names.ts';
import { categoryIndex, evaluate } from './handeval.ts';
import { emptyReactions } from './reactions.ts';

export type MomentReason =
  | 'big-win'
  | 'quads'
  | 'straight-flush'
  | 'royal'
  | 'sng-win'
  | 'bad-beat'
  | 'bomb-pot'
  | 'level-up'
  | 'cosmetic';

export interface MomentOffer {
  id: string;
  reason: MomentReason;
  /** the post that will be published if the player accepts */
  post: FeedPost;
  /** sheet copy */
  title: string;
  subtitle: string;
  createdAt: number;
}

interface Recording {
  handId: number;
  stakeLabel: string;
  variant: TableState['variant'];
  format: TableState['format'];
  bb: number;
  buttonSeat: number;
  heroSeat: number;
  seats: HandReplay['seats'];
  hole: Map<number, CardId[]>;
  board: CardId[];
  actions: Action[];
  results: ShowdownResult[];
  awards: Map<number, number>;
  startedAt: number;
  tournament: TableState['tournament'];
}

const BIG_POT_BB = 55;
const MAX_OFFERS = 6;

function heroTitle(reason: MomentReason): string {
  switch (reason) {
    case 'royal':
      return 'Royal flush';
    case 'straight-flush':
      return 'Straight flush';
    case 'quads':
      return 'Four of a kind';
    case 'sng-win':
      return 'You won the sit-and-go';
    case 'bad-beat':
      return 'That was brutal';
    case 'bomb-pot':
      return 'Bomb pot scooped';
    case 'level-up':
      return 'Level up';
    case 'cosmetic':
      return 'New unlock';
    default:
      return 'Big pot';
  }
}

const HERO_HEADLINES: Record<MomentReason, string[]> = {
  'big-win': [
    'Dragged the biggest pot of the session.',
    'Got it in good and it actually held.',
    'That is the hand the whole night was waiting for.',
  ],
  quads: [
    'Quads. On this app. Right now.',
    'Four of a kind and somebody paid it off.',
  ],
  'straight-flush': [
    'Straight flush. Had to count it twice.',
    'Five in a row, one suit. Still shaking.',
  ],
  royal: [
    'Royal flush. I am never deleting this app.',
    'Broadway, one suit, and it got paid.',
  ],
  'sng-win': [
    'Shipped it. First place.',
    'Last one standing.',
  ],
  'bad-beat': [
    'I do not want to talk about it.',
    'Perfect read, perfect sizing, perfect disaster.',
    'Getting it in good is its own reward, apparently.',
  ],
  'bomb-pot': [
    'Bomb pot, four ways, one winner.',
    'Everybody antes. I scoop.',
  ],
  'level-up': ['Another level down. Onwards.'],
  cosmetic: ['Finally pulled the one I was chasing.'],
};

function tierFor(reason: MomentReason): FeedPost['tier'] {
  switch (reason) {
    case 'royal':
    case 'straight-flush':
      return 'legendary';
    case 'quads':
    case 'sng-win':
      return 'epic';
    case 'big-win':
    case 'bad-beat':
    case 'bomb-pot':
      return 'rare';
    default:
      return 'normal';
  }
}

function kindFor(reason: MomentReason): FeedEventKind {
  switch (reason) {
    case 'royal':
      return 'royal';
    case 'straight-flush':
      return 'straight-flush';
    case 'quads':
      return 'quads';
    case 'sng-win':
      return 'sng-win';
    case 'bad-beat':
      return 'bad-beat';
    case 'bomb-pot':
      return 'bomb-pot';
    case 'level-up':
      return 'level-up';
    case 'cosmetic':
      return 'cosmetic';
    default:
      return 'big-win';
  }
}

export class MomentCapture {
  private offs: Array<() => void> = [];
  private rec: Recording | null = null;
  private state: TableState | null = null;
  private heroSeat = -1;
  private offers: MomentOffer[] = [];
  private listeners = new Set<(o: MomentOffer) => void>();
  private running = false;
  private serial = 0;

  me = playerFromPersona(LOCAL_PERSONA, { level: 42, premium: true, heat: 0.6, frameId: 'frame-brass' });

  /** Subscribes to the bus. Safe to call more than once. */
  start(): () => void {
    if (this.running) return () => this.stop();
    this.running = true;

    this.offs.push(
      bus.on('table:state', ({ state, you }) => {
        this.state = state;
        this.heroSeat = you;
        if (this.rec && this.rec.heroSeat < 0) this.rec.heroSeat = you;
      }),
    );

    this.offs.push(
      bus.on('hand:start', ({ handId, buttonSeat }) => {
        this.rec = this.beginRecording(handId, buttonSeat);
      }),
    );

    this.offs.push(
      bus.on('hand:deal-hole', ({ seat, cards }) => {
        if (!this.rec) this.rec = this.beginRecording(this.state?.handId ?? 0, this.state?.buttonSeat ?? 0);
        // Record ONLY the hero's own cards here. This recording becomes a
        // shareable HandReplay, so anything captured off the deal would
        // publish every opponent's hole cards. Opponents are recorded at
        // showdown, and only for seats that actually tabled their hand.
        if (seat !== this.heroSeat) return;
        if (cards && cards.length) this.rec.hole.set(seat, cards.slice());
      }),
    );

    this.offs.push(
      bus.on('hand:deal-board', ({ cards }) => {
        if (!this.rec) return;
        for (const c of cards) if (!this.rec.board.includes(c)) this.rec.board.push(c);
      }),
    );

    this.offs.push(
      bus.on('hand:action', ({ action, state }) => {
        if (state) this.state = state;
        if (!this.rec) this.rec = this.beginRecording(state?.handId ?? 0, state?.buttonSeat ?? 0);
        this.rec.actions.push(action);
      }),
    );

    this.offs.push(
      bus.on('hand:showdown', ({ results }) => {
        if (!this.rec) return;
        this.rec.results = results.slice();
        // A tabled hand is public — record it now so the replay can show it.
        // A mucked hand never becomes visible, so it is never recorded.
        const seats = this.state?.seats ?? [];
        for (const r of results) {
          if (r.mucked || r.rank === null) continue;
          const cards = seats[r.seat]?.holeCards;
          if (cards && cards.length) this.rec.hole.set(r.seat, cards.slice());
        }
      }),
    );

    this.offs.push(
      bus.on('hand:award', ({ seat, amount }) => {
        if (!this.rec) return;
        this.rec.awards.set(seat, (this.rec.awards.get(seat) ?? 0) + amount);
      }),
    );

    this.offs.push(bus.on('hand:end', () => this.finishHand()));

    this.offs.push(
      bus.on('econ:pass-xp', ({ tier, leveled }) => {
        if (!leveled) return;
        this.pushOffer(this.milestoneOffer('level-up', `Season tier ${tier}`, `Tier ${tier} reached`));
      }),
    );

    this.offs.push(
      bus.on('econ:purchase', ({ item }) => {
        if (item.rarity !== 'legendary' && item.rarity !== 'mythic' && item.rarity !== 'epic') return;
        this.pushOffer(this.milestoneOffer('cosmetic', `${item.name} · ${item.rarity}`, item.name));
      }),
    );

    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.running = false;
    this.rec = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Fires for every new offer; also replays anything already queued. */
  onOffer(fn: (o: MomentOffer) => void): () => void {
    this.listeners.add(fn);
    for (const o of this.offers.slice()) {
      try {
        fn(o);
      } catch (err) {
        console.error('[moments] listener failed', err);
      }
    }
    return () => this.listeners.delete(fn);
  }

  pending(): MomentOffer[] {
    return this.offers.slice();
  }

  /** Publishes the offer. Returns the post that went out. */
  share(offerId: string): FeedPost | null {
    const idx = this.offers.findIndex((o) => o.id === offerId);
    if (idx < 0) return null;
    const [offer] = this.offers.splice(idx, 1);
    bus.emit('feed:post', { post: offer.post });
    bus.emit('ui:toast', { text: 'Shared to your feed', tone: 'good' });
    return offer.post;
  }

  dismiss(offerId: string): void {
    this.offers = this.offers.filter((o) => o.id !== offerId);
  }

  clear(): void {
    this.offers = [];
  }

  // ── recording ──────────────────────────────────────────────────────

  private beginRecording(handId: number, buttonSeat: number): Recording {
    const s = this.state;
    const seats: HandReplay['seats'] = [];
    if (s) {
      for (const seat of s.seats) {
        if (!seat.player) continue;
        seats.push({
          seat: seat.index,
          name: seat.player.name,
          avatarId: seat.player.avatarId,
          startStack: seat.stack,
          holeCards: null,
        });
      }
    }
    return {
      handId,
      stakeLabel: s?.stake.label ?? '',
      variant: s?.variant ?? 'nlhe',
      format: s?.format ?? 'cash',
      bb: s?.stake.bb ?? 1,
      buttonSeat,
      heroSeat: this.heroSeat,
      seats,
      hole: new Map(),
      board: [],
      actions: [],
      results: [],
      awards: new Map(),
      startedAt: Date.now(),
      tournament: s?.tournament ?? null,
    };
  }

  private finishHand(): void {
    const rec = this.rec;
    this.rec = null;
    if (!rec || rec.heroSeat < 0) return;

    const heroCards = rec.hole.get(rec.heroSeat) ?? [];
    const won = rec.awards.get(rec.heroSeat) ?? 0;
    const potTotal = Array.from(rec.awards.values()).reduce((a, b) => a + b, 0);
    const bb = rec.bb || 1;
    const omaha = rec.variant === 'plo4';
    const heroRank = heroCards.length && rec.board.length >= 3 ? evaluate(heroCards, rec.board, omaha) : null;

    const showdownSeats = rec.results.filter((r) => r.rank !== null);
    const heroResult = rec.results.find((r) => r.seat === rec.heroSeat) ?? null;
    // Rank *values* come from whichever evaluator produced them and are not
    // comparable across implementations; category order always is.
    const strength = (r: ShowdownResult | null): number =>
      r?.rank ? categoryIndex(r.rank.category) * 1e6 + Math.min(999_999, r.rank.value % 1e6) : -1;
    const bestOther = showdownSeats
      .filter((r) => r.seat !== rec.heroSeat)
      .reduce<ShowdownResult | null>((best, r) => (!best || strength(r) > strength(best) ? r : best), null);

    let reason: MomentReason | null = null;

    if (rec.format === 'sng' && rec.tournament && rec.tournament.playersLeft <= 1 && won > 0) {
      reason = 'sng-win';
    } else if (heroRank && won > 0 && heroRank.category === 'straight-flush') {
      reason = heroRank.best.length && heroRank.label === 'Royal Flush' ? 'royal' : 'straight-flush';
    } else if (heroRank && won > 0 && heroRank.category === 'quads') {
      reason = 'quads';
    } else if (
      won <= 0 &&
      heroResult &&
      heroRank &&
      bestOther?.rank &&
      categoryIndex(bestOther.rank.category) >= categoryIndex(heroRank.category) &&
      ['full-house', 'quads', 'straight-flush', 'flush', 'straight', 'trips'].includes(heroRank.category)
    ) {
      reason = 'bad-beat';
    } else if (won >= BIG_POT_BB * bb) {
      reason = rec.format === 'bomb' ? 'bomb-pot' : 'big-win';
    }

    if (!reason) return;

    const replay: HandReplay = {
      handId: rec.handId,
      variant: rec.variant,
      stakeLabel: rec.stakeLabel,
      seats: rec.seats.map((row) => ({ ...row, holeCards: rec.hole.get(row.seat) ?? null })),
      buttonSeat: rec.buttonSeat,
      board: rec.board.slice(0, 5),
      actions: rec.actions.slice(),
      results: rec.results.slice(),
      potTotal: potTotal || won,
    };

    const heads = HERO_HEADLINES[reason];
    const headline = heads[Math.floor(Math.random() * heads.length)];
    const amount = reason === 'bad-beat' ? replay.potTotal : won;

    const post: FeedPost = {
      id: `me-${rec.handId}-${(this.serial++).toString(36)}`,
      kind: kindFor(reason),
      author: this.me,
      createdAt: Date.now(),
      headline,
      body: heroRank ? heroRank.label : undefined,
      hand: replay,
      reactions: emptyReactions(),
      comments: [],
      stakeLabel: rec.stakeLabel,
      variant: rec.variant,
      amount,
      tier: tierFor(reason),
    };

    const subtitle =
      reason === 'bad-beat'
        ? `${heroRank?.label ?? 'Your hand'} · ${cash(replay.potTotal)} pot`
        : `${heroRank ? `${heroRank.label} · ` : ''}${cash(won)} won`;

    this.pushOffer({
      id: post.id,
      reason,
      post,
      title: heroTitle(reason),
      subtitle,
      createdAt: Date.now(),
    });
  }

  private milestoneOffer(reason: MomentReason, subtitle: string, detail: string): MomentOffer {
    const heads = HERO_HEADLINES[reason];
    const post: FeedPost = {
      id: `me-${reason}-${Date.now().toString(36)}-${(this.serial++).toString(36)}`,
      kind: kindFor(reason),
      author: this.me,
      createdAt: Date.now(),
      headline: heads[Math.floor(Math.random() * heads.length)],
      body: detail,
      hand: null,
      reactions: emptyReactions(),
      comments: [],
      tier: tierFor(reason),
    };
    return { id: post.id, reason, post, title: heroTitle(reason), subtitle, createdAt: Date.now() };
  }

  private pushOffer(offer: MomentOffer): void {
    this.offers.unshift(offer);
    if (this.offers.length > MAX_OFFERS) this.offers.length = MAX_OFFERS;
    bus.emit('ui:toast', {
      text: `${offer.title} — tap to share this hand`,
      tone: offer.post.tier === 'legendary' ? 'epic' : 'good',
      ms: 4200,
    });
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(offer);
      } catch (err) {
        console.error('[moments] listener failed', err);
      }
    }
  }
}

export const momentCapture = new MomentCapture();

/** Convenience used by the UI when it needs a compact chip readout. */
export function momentAmountText(offer: MomentOffer): string {
  const amount = offer.post.amount ?? 0;
  return amount >= 1000 ? chipsFmt(amount) : cash(amount);
}

/** The streets a replay actually reached — used by the share preview. */
export function replayStreets(replay: HandReplay): Street[] {
  const out: Street[] = ['preflop'];
  if (replay.board.length >= 3) out.push('flop');
  if (replay.board.length >= 4) out.push('turn');
  if (replay.board.length >= 5) out.push('river');
  if (replay.results.some((r) => r.rank !== null)) out.push('showdown');
  return out;
}
