/**
 * ROYALE — econ/wallet.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The single source of truth for what the player has and what they are
 * wearing. Everything that changes a balance goes through here, every change
 * is validated before it lands, and every landed change is published on the
 * bus so the top bar, the lobby gate and the 3D table all follow.
 *
 *   import { wallet, purchase, equip, owns, onWallet } from '../econ/wallet.ts';
 *
 *   if (owns(item.id)) equip(item.id);
 *   else {
 *     const res = purchase(item);
 *     if (!res.ok) toast(res.message, 'bad');
 *   }
 *
 * PERSISTENCE
 *   The full state lives under `royale.econ.v1`. A `{ chips, gems }` mirror is
 *   also written to `royale.wallet`, because the top bar and the lobby's
 *   bankroll gate read that key directly as their cold-start fallback. We
 *   listen to `econ:wallet` too, so a credit issued by another module (the
 *   lobby's daily reward, for instance) is folded back in rather than lost.
 *
 * TRANSACTIONS
 *   Every mutator returns a typed result instead of throwing. A refused
 *   purchase is a normal, expected outcome — the UI needs the reason to write
 *   a useful message, not a stack trace.
 */
import { bus } from '../core/bus.ts';
import type { CosmeticItem, CosmeticKind, WalletState } from '../core/types.ts';
import { CATALOG, DEFAULT_EQUIPPED, STARTER_ITEMS, itemById } from '../data/catalog.ts';

const STATE_KEY = 'royale.econ.v1';
const MIRROR_KEY = 'royale.wallet';

/** What a brand-new account starts with. Generous enough to make a choice. */
export const STARTING_CHIPS = 25_000;
export const STARTING_GEMS = 900;

const DAY_MS = 86_400_000;

// ─────────────────────────── state ───────────────────────────

export interface PurchaseRecord {
  itemId: string;
  at: number;
  gems: number;
}

/** WalletState plus the bookkeeping the store and profile need. */
export interface EconState extends WalletState {
  createdAt: number;
  /** midnight-anchored day index of the last claimed daily bonus */
  lastDailyDay: number;
  dailyStreak: number;
  gemsSpent: number;
  gemsEarned: number;
  history: PurchaseRecord[];
}

function freshState(now: number): EconState {
  return {
    chips: STARTING_CHIPS,
    gems: STARTING_GEMS,
    premium: false,
    premiumUntil: null,
    passTier: 1,
    passXp: 0,
    owned: STARTER_ITEMS.slice(),
    equipped: { ...DEFAULT_EQUIPPED },
    createdAt: now,
    lastDailyDay: -1,
    dailyStreak: 0,
    gemsSpent: 0,
    gemsEarned: STARTING_GEMS,
    history: [],
  };
}

function sanitise(raw: unknown, now: number): EconState {
  const base = freshState(now);
  if (!raw || typeof raw !== 'object') return base;
  const p = raw as Partial<EconState>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const owned = Array.isArray(p.owned)
    ? Array.from(new Set(p.owned.filter((id): id is string => typeof id === 'string' && !!itemById(id))))
    : base.owned;
  // Starter items can never be lost — they are the floor the UI assumes.
  for (const id of STARTER_ITEMS) if (!owned.includes(id)) owned.push(id);

  const equipped: Partial<Record<CosmeticKind, string>> = { ...DEFAULT_EQUIPPED };
  if (p.equipped && typeof p.equipped === 'object') {
    for (const [kind, id] of Object.entries(p.equipped)) {
      if (typeof id !== 'string') continue;
      const item = itemById(id);
      if (item && item.kind === kind && owned.includes(id)) {
        equipped[kind as CosmeticKind] = id;
      }
    }
  }

  const premiumUntil =
    typeof p.premiumUntil === 'number' && Number.isFinite(p.premiumUntil) ? p.premiumUntil : null;

  return {
    chips: Math.max(0, num(p.chips, base.chips)),
    gems: Math.max(0, Math.round(num(p.gems, base.gems))),
    premium: premiumUntil !== null ? premiumUntil > now : !!p.premium,
    premiumUntil,
    passTier: Math.max(1, Math.min(50, Math.round(num(p.passTier, 1)))),
    passXp: Math.max(0, Math.round(num(p.passXp, 0))),
    owned,
    equipped,
    createdAt: num(p.createdAt, now),
    lastDailyDay: Math.round(num(p.lastDailyDay, -1)),
    dailyStreak: Math.max(0, Math.round(num(p.dailyStreak, 0))),
    gemsSpent: Math.max(0, Math.round(num(p.gemsSpent, 0))),
    gemsEarned: Math.max(0, Math.round(num(p.gemsEarned, STARTING_GEMS))),
    history: Array.isArray(p.history)
      ? p.history
          .filter((r): r is PurchaseRecord =>
            !!r && typeof r === 'object' && typeof (r as PurchaseRecord).itemId === 'string')
          .slice(-60)
      : [],
  };
}

function load(): { state: EconState; isNew: boolean } {
  const now = Date.now();
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return { state: sanitise(JSON.parse(raw), now), isNew: false };
  } catch {
    /* private mode / corrupt payload — start clean */
  }
  return { state: freshState(now), isNew: true };
}

const boot = load();
let state: EconState = boot.state;
/** True for the very first session on this device — drives the welcome grant. */
export const isFirstRun = boot.isNew;

// ─────────────────────────── persistence ───────────────────────────

let saveTimer = 0;
/** Set while we publish, so our own `econ:wallet` echo is not re-ingested. */
let publishing = false;

function persistNow(): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ chips: state.chips, gems: state.gems }));
  } catch {
    /* memory-only session */
  }
}

function persist(): void {
  if (saveTimer) return;
  saveTimer = (typeof window !== 'undefined' ? window.setTimeout : setTimeout)(() => {
    saveTimer = 0;
    persistNow();
  }, 180) as unknown as number;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persistNow);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow();
  });
}

// ─────────────────────────── change fan-out ───────────────────────────

export type WalletChange =
  | 'init'
  | 'balance'
  | 'purchase'
  | 'grant'
  | 'equip'
  | 'premium'
  | 'pass'
  | 'daily';

const subs = new Set<(s: Readonly<EconState>, why: WalletChange) => void>();

function commit(why: WalletChange): void {
  persist();
  publishing = true;
  bus.emit('econ:wallet', { chips: state.chips, gems: state.gems });
  publishing = false;
  for (const fn of Array.from(subs)) {
    try {
      fn(state, why);
    } catch (err) {
      console.error('[econ] wallet subscriber failed', err);
    }
  }
}

/** Subscribe to every wallet change. Fires immediately with the current state. */
export function onWallet(fn: (s: Readonly<EconState>, why: WalletChange) => void): () => void {
  subs.add(fn);
  fn(state, 'init');
  return () => subs.delete(fn);
}

// Another module credited the balance directly (the lobby's daily reward does
// this). Fold it in rather than drifting apart.
bus.on('econ:wallet', ({ chips, gems }) => {
  if (publishing) return;
  if (chips === state.chips && gems === state.gems) return;
  state.chips = Math.max(0, chips);
  state.gems = Math.max(0, Math.round(gems));
  persist();
  for (const fn of Array.from(subs)) fn(state, 'balance');
});

// ─────────────────────────── reads ───────────────────────────

/** The domain-shaped slice. Treat as immutable. */
export function wallet(): Readonly<WalletState> {
  return state;
}

/** Full state including bookkeeping the store/profile render. */
export function econ(): Readonly<EconState> {
  return state;
}

export function gems(): number {
  return state.gems;
}

export function chips(): number {
  return state.chips;
}

export function owns(id: string): boolean {
  return state.owned.includes(id);
}

export function isEquipped(id: string): boolean {
  const item = itemById(id);
  return !!item && state.equipped[item.kind] === id;
}

export function equippedId(kind: CosmeticKind): string | undefined {
  return state.equipped[kind];
}

export function equippedItem(kind: CosmeticKind): CosmeticItem | undefined {
  const id = state.equipped[kind];
  return id ? itemById(id) : undefined;
}

/** Premium is a live check — the stored flag can be stale by a day. */
export function isPremium(): boolean {
  if (state.premiumUntil !== null && state.premiumUntil <= Date.now()) {
    if (state.premium) {
      state.premium = false;
      persist();
    }
    return false;
  }
  return state.premium;
}

export function premiumDaysLeft(): number {
  if (!isPremium() || state.premiumUntil === null) return 0;
  return Math.max(0, Math.ceil((state.premiumUntil - Date.now()) / DAY_MS));
}

/** How many of a kind the player owns, out of how many exist. */
export function collectionProgress(kind?: CosmeticKind): { owned: number; total: number } {
  const pool = kind ? CATALOG.filter((i) => i.kind === kind) : CATALOG;
  let n = 0;
  for (const i of pool) if (state.owned.includes(i.id)) n += 1;
  return { owned: n, total: pool.length };
}

// ─────────────────────────── transactions ───────────────────────────

export type PurchaseFailure =
  | 'owned'
  | 'not-for-sale'
  | 'premium-required'
  | 'insufficient-gems'
  | 'insufficient-chips'
  | 'unknown-item';

export interface TxResult {
  ok: boolean;
  reason?: PurchaseFailure;
  /** player-facing copy, always present when `ok` is false */
  message?: string;
  /** gems remaining after a successful purchase */
  balance?: number;
}

const FAIL_COPY: Record<PurchaseFailure, string> = {
  owned: 'You already own this.',
  'not-for-sale': 'This one is earned on the Premium Pass, not sold.',
  'premium-required': 'Premium members only — upgrade to unlock it.',
  'insufficient-gems': 'Not enough gems.',
  'insufficient-chips': 'Not enough chips.',
  'unknown-item': 'That item is no longer available.',
};

function fail(reason: PurchaseFailure): TxResult {
  return { ok: false, reason, message: FAIL_COPY[reason] };
}

/** Everything `purchase()` will check, without moving any money. */
export function canPurchase(item: CosmeticItem): TxResult {
  if (!itemById(item.id)) return fail('unknown-item');
  if (owns(item.id)) return fail('owned');
  if (item.priceGems === null) return fail('not-for-sale');
  if (item.premiumOnly && !isPremium()) return fail('premium-required');
  if (state.gems < item.priceGems) return fail('insufficient-gems');
  return { ok: true, balance: state.gems - item.priceGems };
}

/**
 * Buys an item with gems. Validates affordability, ownership and the premium
 * gate, debits, records, and publishes `econ:purchase`.
 */
export function purchase(item: CosmeticItem): TxResult {
  const check = canPurchase(item);
  if (!check.ok) return check;
  const price = item.priceGems ?? 0;
  state.gems -= price;
  state.gemsSpent += price;
  state.owned.push(item.id);
  state.history.push({ itemId: item.id, at: Date.now(), gems: price });
  if (state.history.length > 60) state.history.splice(0, state.history.length - 60);
  commit('purchase');
  bus.emit('econ:purchase', { item });
  return { ok: true, balance: state.gems };
}

/** Awards an item with no cost — pass rewards, milestones, the welcome grant. */
export function grant(id: string, opts: { announce?: boolean } = {}): TxResult {
  const item = itemById(id);
  if (!item) return fail('unknown-item');
  if (owns(id)) return fail('owned');
  state.owned.push(id);
  commit('grant');
  if (opts.announce !== false) bus.emit('econ:purchase', { item });
  return { ok: true };
}

/** Equips an owned item into its slot. Refuses items behind a lapsed premium. */
export function equip(id: string): TxResult {
  const item = itemById(id);
  if (!item) return fail('unknown-item');
  if (!owns(id)) return fail('not-for-sale');
  if (item.premiumOnly && !isPremium()) return fail('premium-required');
  if (state.equipped[item.kind] === id) return { ok: true };
  state.equipped[item.kind] = id;
  commit('equip');
  bus.emit('econ:equip', { item });
  return { ok: true };
}

/** Puts a slot back to its default. Never leaves a slot empty. */
export function unequip(kind: CosmeticKind): void {
  const fallback = DEFAULT_EQUIPPED[kind];
  if (!fallback || state.equipped[kind] === fallback) return;
  state.equipped[kind] = fallback;
  commit('equip');
  const item = itemById(fallback);
  if (item) bus.emit('econ:equip', { item });
}

// ─────────────────────────── currency ───────────────────────────

export function addGems(amount: number): number {
  if (amount <= 0) return state.gems;
  state.gems += Math.round(amount);
  state.gemsEarned += Math.round(amount);
  commit('balance');
  return state.gems;
}

export function spendGems(amount: number): TxResult {
  const n = Math.round(amount);
  if (n <= 0) return { ok: true, balance: state.gems };
  if (state.gems < n) return fail('insufficient-gems');
  state.gems -= n;
  state.gemsSpent += n;
  commit('balance');
  return { ok: true, balance: state.gems };
}

export function addChips(amount: number): number {
  state.chips = Math.max(0, state.chips + amount);
  commit('balance');
  return state.chips;
}

export function spendChips(amount: number): TxResult {
  if (amount <= 0) return { ok: true };
  if (state.chips < amount) return fail('insufficient-chips');
  state.chips -= amount;
  commit('balance');
  return { ok: true };
}

// ─────────────────────────── premium ───────────────────────────

/** Starts or extends premium. Stacking adds to whatever is already banked. */
export function grantPremium(days = 30): void {
  const now = Date.now();
  const from = state.premiumUntil && state.premiumUntil > now ? state.premiumUntil : now;
  state.premiumUntil = from + days * DAY_MS;
  state.premium = true;
  commit('premium');
}

export function revokePremium(): void {
  state.premium = false;
  state.premiumUntil = null;
  // Anything premium-gated that is currently worn falls back to the default.
  for (const kind of Object.keys(state.equipped) as CosmeticKind[]) {
    const id = state.equipped[kind];
    const item = id ? itemById(id) : undefined;
    if (item?.premiumOnly) state.equipped[kind] = DEFAULT_EQUIPPED[kind];
  }
  commit('premium');
}

// ─────────────────────────── pass storage ───────────────────────────

/** pass.ts owns the curve; the wallet only stores the result. */
export function setPassProgress(tier: number, xp: number): void {
  state.passTier = Math.max(1, Math.min(50, Math.round(tier)));
  state.passXp = Math.max(0, Math.round(xp));
  commit('pass');
}

// ─────────────────────────── daily bonus ───────────────────────────

export interface DailyReward {
  day: number;
  chips: number;
  gems: number;
  /** cosmetic granted on the seventh day of a streak */
  itemId?: string;
}

/** Seven-day ladder. Day seven is worth showing up for. */
export const DAILY_LADDER: DailyReward[] = [
  { day: 1, chips: 1500, gems: 20 },
  { day: 2, chips: 2200, gems: 25 },
  { day: 3, chips: 3000, gems: 35 },
  { day: 4, chips: 4200, gems: 45 },
  { day: 5, chips: 5800, gems: 60 },
  { day: 6, chips: 8000, gems: 80 },
  { day: 7, chips: 12_000, gems: 150, itemId: 'emote-tilt' },
];

function dayIndex(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / DAY_MS);
}

export interface DailyStatus {
  claimable: boolean;
  /** the streak position that will be claimed next, 1–7 */
  nextDay: number;
  streak: number;
  reward: DailyReward;
  /** ms until the next claim opens, 0 when claimable */
  msUntil: number;
}

/** ms from `now` until the next local midnight. */
function msToMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return Math.max(0, d.getTime() - now);
}

export function dailyStatus(now = Date.now()): DailyStatus {
  const today = dayIndex(now);
  const last = state.lastDailyDay;
  const claimable = last !== today;
  // A missed day resets the ladder; claiming yesterday continues it.
  const continues = last === today - 1 || last === today;
  const streak = continues ? state.dailyStreak : 0;
  const nextDay = claimable ? (streak % 7) + 1 : ((Math.max(1, streak) - 1) % 7) + 1;
  return {
    claimable,
    nextDay,
    streak,
    reward: DAILY_LADDER[nextDay - 1],
    msUntil: claimable ? 0 : msToMidnight(now),
  };
}

export interface DailyClaim {
  ok: boolean;
  reward?: DailyReward;
  streak?: number;
  grantedItem?: CosmeticItem;
}

/** Claims today's bonus. Idempotent within a calendar day. */
export function claimDaily(now = Date.now()): DailyClaim {
  const status = dailyStatus(now);
  if (!status.claimable) return { ok: false };
  const reward = status.reward;
  state.dailyStreak = status.streak + 1;
  state.lastDailyDay = dayIndex(now);
  state.chips += reward.chips;
  state.gems += reward.gems;
  state.gemsEarned += reward.gems;
  let grantedItem: CosmeticItem | undefined;
  if (reward.itemId && !owns(reward.itemId)) {
    const item = itemById(reward.itemId);
    if (item) {
      state.owned.push(item.id);
      grantedItem = item;
    }
  }
  commit('daily');
  if (grantedItem) bus.emit('econ:purchase', { item: grantedItem });
  return { ok: true, reward, streak: state.dailyStreak, grantedItem };
}

// ─────────────────────────── boot ───────────────────────────

/**
 * Publishes the opening balance so the top bar has real numbers on the first
 * frame, and hands new players their welcome grant. Safe to call more than
 * once — the shell may boot the economy before or after the store mounts.
 */
let announced = false;
export function initWallet(): Readonly<EconState> {
  if (!announced) {
    announced = true;
    persistNow();
    // Publish on the next tick so subscribers registered during module init
    // (the top bar, the bankroll gate) are already listening.
    const publish = () => commit('init');
    if (typeof queueMicrotask === 'function') queueMicrotask(publish);
    else publish();
  }
  return state;
}

initWallet();

/** Test/QA hook — wipes the economy back to a fresh account. */
export function resetWallet(): void {
  state = freshState(Date.now());
  persistNow();
  commit('init');
}
