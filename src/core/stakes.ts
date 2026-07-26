import type { Stake, StakeId } from './types.ts';

/**
 * The six advertised stake levels plus two shoulder levels used by SNG
 * blind ladders. Buy-ins follow the standard 100bb default / 40bb min /
 * 250bb max shape used by modern cash apps.
 */
function mk(
  id: StakeId,
  sb: number,
  bb: number,
  tier: Stake['tier'],
): Stake {
  const money = (n: number) =>
    n < 1 ? `${Math.round(n * 100)}¢` : `$${n % 1 === 0 ? n : n.toFixed(2)}`;
  return {
    id,
    sb,
    bb,
    label: `$${sb < 1 ? sb.toFixed(2) : sb}/$${bb < 1 ? bb.toFixed(2) : bb}`,
    short: `${money(sb)}/${money(bb)}`,
    minBuyIn: Math.round(bb * 40 * 100) / 100,
    maxBuyIn: Math.round(bb * 250 * 100) / 100,
    defaultAnte: Math.round(bb * 0.12 * 100) / 100,
    tier,
  };
}

export const STAKES: Record<StakeId, Stake> = {
  nl2: mk('nl2', 0.01, 0.02, 'micro'),
  nl5: mk('nl5', 0.02, 0.05, 'micro'),
  nl10: mk('nl10', 0.05, 0.1, 'micro'),
  nl20: mk('nl20', 0.1, 0.2, 'micro'),
  nl50: mk('nl50', 0.25, 0.5, 'low'),
  nl100: mk('nl100', 0.5, 1, 'low'),
  nl200: mk('nl200', 1, 2, 'mid'),
  nl500: mk('nl500', 2.5, 5, 'high'),
};

/** The stakes surfaced in the lobby, in ladder order. */
export const LOBBY_STAKES: StakeId[] = ['nl10', 'nl20', 'nl50', 'nl100', 'nl200', 'nl500'];

export const STAKE_LIST: Stake[] = LOBBY_STAKES.map((id) => STAKES[id]);

export function stakeOf(id: StakeId): Stake {
  return STAKES[id];
}

/** Formats chips as money using the stake's natural precision. */
export function money(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 10000) return `$${(amount / 1000).toFixed(abs >= 100000 ? 0 : 1)}K`;
  if (abs >= 100) return `$${amount.toFixed(0)}`;
  if (abs >= 10) return `$${amount.toFixed(1)}`;
  return `$${amount.toFixed(2)}`;
}

/** Compact chip count for stack pills: 1.2K, 340, 12.5K */
export function chips(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(amount / 1000)}K`;
  if (abs >= 1000) return `${(amount / 1000).toFixed(1)}K`;
  if (abs >= 100) return amount.toFixed(0);
  return amount.toFixed(2).replace(/\.00$/, '');
}

export function bbCount(amount: number, bb: number): string {
  return `${(amount / bb).toFixed(amount / bb >= 100 ? 0 : 1)}bb`;
}
