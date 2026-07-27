/**
 * ROYALE — lobby/bankroll.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The player's roll, and the one rule the lobby uses to decide which stakes
 * are open to them.
 *
 * The gate is *bankroll management*, not a paywall: a level opens once the
 * roll covers **30 full buy-ins** at that stake, which is the cushion that
 * keeps normal downswings from ending a session. A locked level still shows
 * every live number and still offers a rail seat to watch, so it reads as
 * guidance rather than a velvet rope.
 *
 * Balance comes from the same place the top bar reads it: the `econ:wallet`
 * event, falling back to `localStorage['royale.wallet']`.
 */
import { bus } from '../../core/bus.ts';
import type { Stake } from '../../core/types.ts';

const WALLET_KEY = 'royale.wallet';
const FALLBACK = { chips: 24850, gems: 320 };

/** Buy-ins of cushion required before a level unlocks. */
export const BUYIN_CUSHION = 30;

interface Wallet {
  chips: number;
  gems: number;
}

function read(): Wallet {
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Wallet>;
      if (typeof p.chips === 'number' && typeof p.gems === 'number') {
        return { chips: p.chips, gems: p.gems };
      }
    }
  } catch {
    /* private mode — use the constant */
  }
  return { ...FALLBACK };
}

let wallet = read();
const subs = new Set<(w: Wallet) => void>();

bus.on('econ:wallet', ({ chips, gems }) => {
  wallet = { chips, gems };
  for (const fn of Array.from(subs)) fn(wallet);
});

/** Spendable balance, in dollars. */
export function bankroll(): number {
  return wallet.chips;
}

export function gems(): number {
  return wallet.gems;
}

export function onBankroll(fn: (w: Wallet) => void): () => void {
  subs.add(fn);
  fn(wallet);
  return () => subs.delete(fn);
}

/**
 * Adds to the balance and publishes it, so the top bar rolls up and any
 * economy module that is listening stays in sync. Used by the daily reward.
 */
export function creditBankroll(amount: number): number {
  const next = Math.max(0, wallet.chips + amount);
  bus.emit('econ:wallet', { chips: next, gems: wallet.gems });
  try {
    localStorage.setItem(WALLET_KEY, JSON.stringify({ chips: next, gems: wallet.gems }));
  } catch {
    /* memory only */
  }
  return next;
}

export interface StakeGate {
  /** true when the recommended cushion is not there yet */
  locked: boolean;
  /** true when the roll cannot even cover a minimum buy-in */
  short: boolean;
  /** bankroll needed to open the level */
  required: number;
  /** 0–1 progress toward `required` */
  progress: number;
  /** what is still missing */
  remaining: number;
}

export function gateFor(stake: Stake, roll = wallet.chips): StakeGate {
  const required = Math.round(stake.maxBuyIn * BUYIN_CUSHION);
  const progress = Math.max(0, Math.min(1, roll / required));
  return {
    locked: roll < required,
    short: roll < stake.minBuyIn,
    required,
    progress,
    remaining: Math.max(0, required - roll),
  };
}

/** The highest stake the roll comfortably covers — used to seed Quick Seat. */
export function bestOpenStake<T extends Stake>(list: readonly T[], roll = wallet.chips): T {
  let best = list[0];
  for (const s of list) if (!gateFor(s, roll).locked) best = s;
  return best;
}
