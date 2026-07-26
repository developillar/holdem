/**
 * Shared domain contracts. Every subsystem imports from here.
 * This file is the single source of truth for cross-module types —
 * treat it as append-only unless coordinating a breaking change.
 */

// ─────────────────────────── Cards ───────────────────────────

/** 0=clubs 1=diamonds 2=hearts 3=spades */
export type Suit = 0 | 1 | 2 | 3;
/** 2..14 where 14 = Ace */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

/** A card is encoded as a single integer: (rank - 2) * 4 + suit  → 0..51 */
export type CardId = number;

export const SUITS = ['c', 'd', 'h', 's'] as const;
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

export function makeCard(rank: Rank, suit: Suit): CardId {
  return (rank - 2) * 4 + suit;
}
export function cardRank(c: CardId): Rank {
  return ((c >> 2) + 2) as Rank;
}
export function cardSuit(c: CardId): Suit {
  return (c & 3) as Suit;
}
export function cardName(c: CardId): string {
  return RANKS[(c >> 2) as number] + SUITS[(c & 3) as number];
}
export function parseCard(s: string): CardId {
  const r = RANKS.indexOf(s[0].toUpperCase() as (typeof RANKS)[number]);
  const u = SUITS.indexOf(s[1].toLowerCase() as (typeof SUITS)[number]);
  if (r < 0 || u < 0) throw new Error(`bad card: ${s}`);
  return r * 4 + u;
}

// ─────────────────────────── Game modes ───────────────────────────

export type GameVariant = 'nlhe' | 'plo4';
export type TableFormat = 'cash' | 'sng' | 'bomb';

export interface Stake {
  id: StakeId;
  sb: number;
  bb: number;
  /** display label, e.g. "$0.05/$0.10" */
  label: string;
  /** short label for dense UI, e.g. "5¢/10¢" */
  short: string;
  minBuyIn: number;
  maxBuyIn: number;
  /** ante used in bomb-pot / turbo formats */
  defaultAnte: number;
  tier: 'micro' | 'low' | 'mid' | 'high';
}

export type StakeId = 'nl2' | 'nl5' | 'nl10' | 'nl20' | 'nl50' | 'nl100' | 'nl200' | 'nl500';

// ─────────────────────────── Table state ───────────────────────────

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin' | 'post' | 'ante';

export interface Action {
  kind: ActionKind;
  /** total chips moved to the pot by this action (not the delta of a raise) */
  amount: number;
  seat: number;
  /** monotonic index within the hand, for replay + analytics */
  seq: number;
  street: Street;
  /** wall-clock ms the actor took to decide */
  tookMs?: number;
}

export type SeatStatus =
  | 'empty'
  | 'sitting-out'
  | 'waiting'
  | 'active'
  | 'folded'
  | 'allin'
  | 'busted';

export interface SeatState {
  index: number;
  status: SeatStatus;
  player: PlayerRef | null;
  stack: number;
  /** chips committed on the current street */
  committed: number;
  /** chips committed across the whole hand */
  totalCommitted: number;
  holeCards: CardId[];
  /** true when this client is allowed to see holeCards face-up */
  revealed: boolean;
  isButton: boolean;
  isTurn: boolean;
  /** ms remaining on the action clock, server-authoritative */
  timeBankMs: number;
  lastAction: Action | null;
  /** seat won the previous showdown — drives the crown/glow VFX */
  wonLast: boolean;
  sitOutNextHand: boolean;
}

export interface PlayerRef {
  id: string;
  name: string;
  avatarId: string;
  /** equipped cosmetics */
  frameId: string | null;
  titleId: string | null;
  emoteSetId: string;
  level: number;
  premium: boolean;
  /** 0-1, drives the "hot streak" flame ring */
  heat: number;
  countryCode?: string;
}

export interface Pot {
  amount: number;
  /** seats eligible to win this pot */
  eligible: number[];
  /** side pots are indexed above 0 */
  index: number;
}

export interface TableState {
  id: string;
  variant: GameVariant;
  format: TableFormat;
  stake: Stake;
  seats: SeatState[];
  board: CardId[];
  pots: Pot[];
  street: Street;
  handId: number;
  buttonSeat: number;
  /** seat whose turn it is, or -1 */
  actingSeat: number;
  /** the largest total commitment on the current street */
  currentBet: number;
  /** size of the last legal raise, for min-raise computation */
  lastRaiseSize: number;
  minRaiseTo: number;
  /** bomb-pot: every player is all-in-ish preflop with a forced ante */
  bombPot: BombPotConfig | null;
  /** SNG-only */
  tournament: TournamentState | null;
  /** rake taken so far this hand (display only) */
  rake: number;
  /** server tick this snapshot was produced at */
  tick: number;
}

export interface BombPotConfig {
  anteBb: number;
  /** 'double' deals two boards and splits the pot */
  boards: 1 | 2;
  /** run it twice on all-in */
  triggerEveryHands: number;
  handsUntilNext: number;
}

export interface TournamentState {
  level: number;
  sb: number;
  bb: number;
  ante: number;
  msUntilLevelUp: number;
  levelDurationMs: number;
  playersLeft: number;
  entrants: number;
  prizePool: number;
  payouts: number[];
  /** finishing place if the local player busted */
  finishedPlace: number | null;
}

// ─────────────────────────── Hand evaluation ───────────────────────────

export type HandCategory =
  | 'high-card'
  | 'pair'
  | 'two-pair'
  | 'trips'
  | 'straight'
  | 'flush'
  | 'full-house'
  | 'quads'
  | 'straight-flush';

export interface HandRank {
  /** higher is better; total order across all hands */
  value: number;
  category: HandCategory;
  /** the exact 5 cards that make the hand, best-first */
  best: CardId[];
  label: string;
}

export interface ShowdownResult {
  seat: number;
  rank: HandRank | null;
  /** amount won across all pots */
  won: number;
  mucked: boolean;
}

// ─────────────────────────── Social ───────────────────────────

export type ReactionKind =
  | 'fire'
  | 'skull'
  | 'clown'
  | 'money'
  | 'shock'
  | 'clap'
  | 'cold'
  | 'heart'
  | 'laugh'
  | 'eyes';

export interface Reaction {
  kind: ReactionKind;
  count: number;
  /** did the local user react */
  mine: boolean;
}

export type FeedEventKind =
  | 'bad-beat'
  | 'big-win'
  | 'bluff'
  | 'quads'
  | 'straight-flush'
  | 'royal'
  | 'bounty'
  | 'level-up'
  | 'sng-win'
  | 'bomb-pot'
  | 'streak'
  | 'friend-joined'
  | 'cosmetic';

export interface FeedPost {
  id: string;
  kind: FeedEventKind;
  author: PlayerRef;
  createdAt: number;
  headline: string;
  body?: string;
  /** replayable hand, if any */
  hand: HandReplay | null;
  reactions: Reaction[];
  comments: FeedComment[];
  /** stake context for the badge */
  stakeLabel?: string;
  variant?: GameVariant;
  /** amounts for the money chip */
  amount?: number;
  /** highlight tier drives the card treatment */
  tier: 'normal' | 'rare' | 'epic' | 'legendary';
}

export interface FeedComment {
  id: string;
  author: PlayerRef;
  text: string;
  createdAt: number;
}

export interface HandReplay {
  handId: number;
  variant: GameVariant;
  stakeLabel: string;
  seats: Array<{
    seat: number;
    name: string;
    avatarId: string;
    startStack: number;
    holeCards: CardId[] | null;
  }>;
  buttonSeat: number;
  board: CardId[];
  actions: Action[];
  results: ShowdownResult[];
  potTotal: number;
}

// ─────────────────────────── Economy ───────────────────────────

export type CurrencyKind = 'chips' | 'gems' | 'pass-xp';

export type CosmeticKind = 'avatar' | 'frame' | 'table-skin' | 'card-back' | 'emote' | 'title' | 'chip-set' | 'felt';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';

export interface CosmeticItem {
  id: string;
  kind: CosmeticKind;
  name: string;
  description: string;
  rarity: Rarity;
  /** null = not directly purchasable (pass/earned only) */
  priceGems: number | null;
  premiumOnly: boolean;
  /** free-form params consumed by the renderer (colors, shader ids, …) */
  params: Record<string, string | number | boolean>;
  /** pass tier that grants it, if any */
  passTier?: number;
}

export interface WalletState {
  chips: number;
  gems: number;
  premium: boolean;
  premiumUntil: number | null;
  passTier: number;
  passXp: number;
  /** ids of owned cosmetics */
  owned: string[];
  equipped: Partial<Record<CosmeticKind, string>>;
}

export interface PassTier {
  tier: number;
  xpRequired: number;
  freeReward: PassReward | null;
  premiumReward: PassReward;
}

export interface PassReward {
  kind: 'cosmetic' | 'gems' | 'chips' | 'ticket';
  itemId?: string;
  amount?: number;
  label: string;
  rarity: Rarity;
}

// ─────────────────────────── GTO trainer ───────────────────────────

export type PositionName = 'UTG' | 'UTG1' | 'MP' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';

export interface RangeGrid {
  /** 169 entries, index = row*13+col over A..2 descending; suited above diagonal */
  weights: Float32Array;
}

export interface StrategyNode {
  /** action -> frequency, sums to 1 */
  freq: Record<string, number>;
  /** action -> EV in bb */
  ev: Record<string, number>;
}

export interface TrainerVerdict {
  chosen: string;
  optimal: string;
  /** 0..1, 1 = perfect */
  score: number;
  evLossBb: number;
  explanation: string;
  strategy: StrategyNode;
}

export interface TrainerSession {
  id: string;
  drill: string;
  handsPlayed: number;
  totalScore: number;
  evLostBb: number;
  streak: number;
  bestStreak: number;
  mistakes: TrainerVerdict[];
}

// ─────────────────────────── Analytics ───────────────────────────

export interface StatLine {
  hands: number;
  vpip: number;
  pfr: number;
  threeBet: number;
  foldToThreeBet: number;
  af: number;
  wtsd: number;
  wsd: number;
  cbetFlop: number;
  winrateBb100: number;
  netChips: number;
  /** all-in adjusted */
  evBb100: number;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  variant: GameVariant;
  stakeId: StakeId;
  hands: number;
  net: number;
  evNet: number;
  /** per-hand net for the sparkline */
  curve: number[];
}

// ─────────────────────────── Networking ───────────────────────────

export type ClientMsg =
  | { t: 'hello'; name: string; avatarId: string; token?: string }
  | { t: 'join'; tableId: string; seat?: number; buyIn: number }
  | { t: 'leave' }
  | { t: 'act'; kind: ActionKind; amount: number; handId: number; seq: number }
  | { t: 'react'; kind: ReactionKind; targetSeat: number }
  | { t: 'chat'; text: string }
  | { t: 'sitout'; on: boolean }
  | { t: 'ping'; ts: number };

export type ServerMsg =
  | { t: 'welcome'; playerId: string; tables: LobbyTable[] }
  | { t: 'state'; state: TableState; you: number }
  | { t: 'delta'; tick: number; patch: unknown }
  | { t: 'action'; action: Action }
  | { t: 'deal'; street: Street; cards: CardId[] }
  | { t: 'showdown'; results: ShowdownResult[]; pots: Pot[] }
  | { t: 'react'; kind: ReactionKind; fromSeat: number; targetSeat: number }
  | { t: 'chat'; fromSeat: number; text: string }
  | { t: 'error'; message: string }
  | { t: 'pong'; ts: number };

export interface LobbyTable {
  id: string;
  variant: GameVariant;
  format: TableFormat;
  stakeId: StakeId;
  seatsTaken: number;
  seatsTotal: number;
  avgPot: number;
  handsPerHour: number;
  /** 0-1 how loose the table plays, drives the "juicy" flame badge */
  looseness: number;
  bombPotIn: number | null;
}
