/**
 * ROYALE — social/reactions.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The reaction model. Ten kinds, aggregate counts per post, one "mine" flag
 * per kind, and an optimistic toggle that mutates the post immediately and
 * announces it on the bus so the rest of the app (audio, haptics, the net
 * layer) can follow along.
 *
 *   toggleReaction(post, 'fire')      → Reaction  (already applied)
 *   topReactions(post, 3)             → the chips to render, hottest first
 *   totalReactions(post)              → the facepile count
 *
 * This module renders nothing. `src/ui/feed/glyphs.ts` owns what a 'skull'
 * looks like; here it is only ever a string plus a count.
 */
import { bus } from '../core/bus.ts';
import type { FeedPost, Reaction, ReactionKind } from '../core/types.ts';

/** Canonical order — this is picker order, left to right. */
export const REACTION_KINDS: readonly ReactionKind[] = [
  'fire', 'skull', 'money', 'shock', 'clap', 'laugh', 'clown', 'cold', 'heart', 'eyes',
];

export interface ReactionMeta {
  kind: ReactionKind;
  /** spoken name, used for aria-labels and the picker tooltip */
  label: string;
  /** short verb for "N people found this X" copy */
  verb: string;
  /** CSS colour used for the chip tint and the particle burst */
  tint: string;
  /** secondary colour for the burst so particles are not monochrome */
  tint2: string;
}

export const REACTION_META: Record<ReactionKind, ReactionMeta> = {
  fire: { kind: 'fire', label: 'Fire', verb: 'heater', tint: '#ff8a3d', tint2: '#ffd166' },
  skull: { kind: 'skull', label: 'Brutal', verb: 'brutal', tint: '#cfd6e6', tint2: '#8891a5' },
  money: { kind: 'money', label: 'Ship it', verb: 'ship it', tint: '#3ddc97', tint2: '#c9f2df' },
  shock: { kind: 'shock', label: 'No way', verb: 'no way', tint: '#ffd166', tint2: '#ff9a3d' },
  clap: { kind: 'clap', label: 'Respect', verb: 'respect', tint: '#f2c17a', tint2: '#ffe6bd' },
  laugh: { kind: 'laugh', label: 'Comedy', verb: 'comedy', tint: '#ffd75e', tint2: '#ffb02e' },
  clown: { kind: 'clown', label: 'Clown', verb: 'clownery', tint: '#ff6d9e', tint2: '#7dd3fc' },
  cold: { kind: 'cold', label: 'Ice cold', verb: 'ice cold', tint: '#7fd7ff', tint2: '#d6f2ff' },
  heart: { kind: 'heart', label: 'Love it', verb: 'love', tint: '#ff5d73', tint2: '#ffb3bd' },
  eyes: { kind: 'eyes', label: 'Watching', verb: 'watching', tint: '#b8c4dc', tint2: '#6ea8ff' },
};

/** Every post carries the full ten-slot vector so counts never go missing. */
export function emptyReactions(): Reaction[] {
  return REACTION_KINDS.map((kind) => ({ kind, count: 0, mine: false }));
}

/** Repairs a post loaded from storage or from the network. */
export function normalizeReactions(input: Reaction[] | undefined): Reaction[] {
  const byKind = new Map<ReactionKind, Reaction>();
  for (const r of input ?? []) {
    if (!REACTION_META[r.kind]) continue;
    byKind.set(r.kind, { kind: r.kind, count: Math.max(0, Math.round(r.count)), mine: !!r.mine });
  }
  return REACTION_KINDS.map((kind) => byKind.get(kind) ?? { kind, count: 0, mine: false });
}

export function reactionOf(post: FeedPost, kind: ReactionKind): Reaction {
  let r = post.reactions.find((x) => x.kind === kind);
  if (!r) {
    r = { kind, count: 0, mine: false };
    post.reactions.push(r);
  }
  return r;
}

/**
 * Optimistic toggle. The post is mutated before this returns — callers paint
 * from the returned `Reaction` straight away and never wait on a round trip.
 * A player holds at most one reaction of each kind but may stack kinds, which
 * is what makes the chip row feel expressive instead of binary.
 */
export function toggleReaction(post: FeedPost, kind: ReactionKind): Reaction {
  const r = reactionOf(post, kind);
  const on = !r.mine;
  r.mine = on;
  r.count = Math.max(0, r.count + (on ? 1 : -1));
  bus.emit('feed:react', { postId: post.id, kind, on });
  return r;
}

/** Force a state (used when replaying a persisted set or a server echo). */
export function setReaction(post: FeedPost, kind: ReactionKind, on: boolean): Reaction {
  const r = reactionOf(post, kind);
  if (r.mine === on) return r;
  r.mine = on;
  r.count = Math.max(0, r.count + (on ? 1 : -1));
  return r;
}

export function totalReactions(post: FeedPost): number {
  let n = 0;
  for (const r of post.reactions) n += r.count;
  return n;
}

export function myReactions(post: FeedPost): ReactionKind[] {
  return post.reactions.filter((r) => r.mine).map((r) => r.kind);
}

/**
 * The chips actually shown on a card: non-zero counts, hottest first, but
 * anything the local player picked is pinned to the front so their own choice
 * never disappears under a wall of other people's fire emoji.
 */
export function topReactions(post: FeedPost, limit = 3): Reaction[] {
  const live = post.reactions.filter((r) => r.count > 0 || r.mine);
  live.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    if (b.count !== a.count) return b.count - a.count;
    return REACTION_KINDS.indexOf(a.kind) - REACTION_KINDS.indexOf(b.kind);
  });
  return live.slice(0, limit);
}

/**
 * Heat contribution from reactions. Rarer, more emphatic reactions are worth
 * more than a drive-by "eyes", which stops a post farming attention with the
 * cheapest possible tap.
 */
const WEIGHT: Record<ReactionKind, number> = {
  fire: 1.15, skull: 1.3, money: 1.1, shock: 1.25, clap: 1,
  laugh: 0.95, clown: 0.9, cold: 1, heart: 1.05, eyes: 0.6,
};

export function reactionHeat(post: FeedPost): number {
  let n = 0;
  for (const r of post.reactions) n += r.count * WEIGHT[r.kind];
  return n;
}

/** The default reaction a plain tap applies, tuned to the kind of post. */
export function defaultReactionFor(kind: FeedPost['kind']): ReactionKind {
  switch (kind) {
    case 'bad-beat':
      return 'skull';
    case 'bluff':
      return 'eyes';
    case 'quads':
    case 'straight-flush':
    case 'royal':
      return 'shock';
    case 'big-win':
    case 'sng-win':
    case 'bomb-pot':
    case 'bounty':
      return 'money';
    case 'level-up':
    case 'cosmetic':
    case 'streak':
      return 'fire';
    case 'friend-joined':
      return 'clap';
    default:
      return 'fire';
  }
}
