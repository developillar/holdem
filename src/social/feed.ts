/**
 * ROYALE — social/feed.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The feed model: an in-memory store of `FeedPost` with pagination, ranking,
 * optimistic reactions, threaded comments and localStorage persistence.
 *
 *   const feed = getFeed();
 *   feed.ready();                          // seeds on first run, restores after
 *   feed.page('all', 0, 8);                // { posts, cursor, done }
 *   feed.react(id, 'fire');                // optimistic, emits feed:react
 *   feed.comment(id, 'sicko', parentId?);  // optimistic, threaded
 *   feed.subscribe(fn);                    // any mutation
 *
 * RANKING — the feed is not strictly reverse-chronological. A post's position
 * is recency blended with heat, where heat is a log-compressed mix of weighted
 * reactions, comments and the post's tier. The blend is deliberately recency-
 * dominant (0.62 / 0.38) so the feed still feels *live*: a legendary royal
 * flush from this morning can outrank a level-up from ten minutes ago, but
 * yesterday's heat never buries today's news.
 *
 * THREADING — `FeedComment` has no parent field, so replies encode their
 * parent in their id (`<parent>-r<n>`). That keeps the shared type untouched
 * and still yields a real two-level thread.
 */
import { bus } from '../core/bus.ts';
import type { FeedComment, FeedPost, PlayerRef, ReactionKind } from '../core/types.ts';
import { LOCAL_PERSONA, playerFromPersona } from '../data/names.ts';
import { generateFeed, generateLivePost, isFriendPost } from './generator.ts';
import { normalizeReactions, reactionHeat, toggleReaction } from './reactions.ts';

export type FeedFilter = 'all' | 'friends' | 'wins' | 'beats';

export interface FeedPage {
  posts: FeedPost[];
  /** pass back on the next call */
  cursor: number;
  /** no more posts behind this cursor */
  done: boolean;
  /** total matching the filter */
  total: number;
}

export interface FeedChange {
  kind: 'seed' | 'react' | 'comment' | 'insert' | 'refresh' | 'pending';
  postId?: string;
}

const STORAGE_KEY = 'royale.feed.v1';
const SEED_COUNT = 40;
const MAX_STORED = 140;
const FEED_SEED = 0x0f5ea11e;

const TIER_HEAT: Record<FeedPost['tier'], number> = {
  normal: 0,
  rare: 0.08,
  epic: 0.2,
  legendary: 0.34,
};

interface Persisted {
  v: 1;
  savedAt: number;
  posts: FeedPost[];
}

function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    const probe = '__royale_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** Matches the filter segments in the feed header. */
export function matchesFilter(post: FeedPost, filter: FeedFilter): boolean {
  switch (filter) {
    case 'friends':
      return isFriendPost(post) || post.author.id === LOCAL_PERSONA.id;
    case 'wins':
      return (
        post.kind === 'big-win' ||
        post.kind === 'quads' ||
        post.kind === 'royal' ||
        post.kind === 'straight-flush' ||
        post.kind === 'sng-win' ||
        post.kind === 'bomb-pot' ||
        post.kind === 'bounty'
      );
    case 'beats':
      return post.kind === 'bad-beat';
    default:
      return true;
  }
}

export class FeedStore {
  private posts: FeedPost[] = [];
  private byId = new Map<string, FeedPost>();
  /** live arrivals waiting behind the "N new" pill */
  private queued: FeedPost[] = [];
  private subs = new Set<(c: FeedChange) => void>();
  private seeded = false;
  private liveTimer = 0;
  private liveSeed = FEED_SEED ^ 0x51a7;
  private saveTimer = 0;
  private store = safeStorage();

  /** The local player, used as the author of comments you write. */
  me: PlayerRef = playerFromPersona(LOCAL_PERSONA, { level: 42, premium: true, heat: 0.6, frameId: 'frame-brass' });

  // ── lifecycle ──────────────────────────────────────────────────────

  /**
   * True when the store already has content — the screen uses this to decide
   * between a skeleton (cold start) and an instant paint (warm start).
   */
  isWarm(): boolean {
    return this.seeded && this.posts.length > 0;
  }

  /** Loads from storage, or seeds a fresh feed. Idempotent and synchronous. */
  ready(now = Date.now()): void {
    if (this.seeded) return;
    this.seeded = true;
    const restored = this.load();
    if (restored) {
      this.emit({ kind: 'seed' });
      return;
    }
    this.posts = generateFeed({ seed: FEED_SEED, count: SEED_COUNT, now });
    this.reindex();
    this.save();
    this.emit({ kind: 'seed' });
  }

  private load(): boolean {
    if (!this.store) return false;
    try {
      const raw = this.store.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw) as Persisted;
      if (!data || data.v !== 1 || !Array.isArray(data.posts) || !data.posts.length) return false;
      this.posts = data.posts.map(hydrate);
      this.reindex();
      return true;
    } catch {
      return false;
    }
  }

  private save(): void {
    if (!this.store) return;
    if (this.saveTimer) return;
    // Batch writes: a burst of reactions must not hit localStorage per tap.
    this.saveTimer = globalThis.setTimeout(() => {
      this.saveTimer = 0;
      if (!this.store) return;
      const payload: Persisted = {
        v: 1,
        savedAt: Date.now(),
        posts: this.posts.slice(0, MAX_STORED),
      };
      try {
        this.store.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Quota, private mode, or a wiped origin: the feed still works in
        // memory for this session, which is the only thing that matters.
        try {
          this.store.removeItem(STORAGE_KEY);
        } catch {
          /* nothing further to do */
        }
      }
    }, 400) as unknown as number;
  }

  private reindex(): void {
    this.byId.clear();
    for (const p of this.posts) this.byId.set(p.id, p);
  }

  // ── reading ────────────────────────────────────────────────────────

  get(id: string): FeedPost | undefined {
    return this.byId.get(id);
  }

  count(filter: FeedFilter = 'all'): number {
    return this.ranked(filter).length;
  }

  /**
   * Heat score in [0, ~1.4]. Log-compressed so the difference between 4 and
   * 40 reactions matters far more than between 400 and 440 — otherwise one
   * viral post would pin itself to the top forever.
   */
  heat(post: FeedPost): number {
    const engagement = reactionHeat(post) + post.comments.length * 3;
    return Math.log1p(engagement) / Math.log1p(260) + TIER_HEAT[post.tier];
  }

  /** Recency in [0,1], halving roughly every six hours. */
  private recency(post: FeedPost, now: number): number {
    const hours = Math.max(0, (now - post.createdAt) / 3_600_000);
    return 1 / (1 + hours / 6);
  }

  score(post: FeedPost, now = Date.now()): number {
    return this.recency(post, now) * 0.62 + Math.min(1, this.heat(post)) * 0.38;
  }

  /** The filtered, ranked list. */
  ranked(filter: FeedFilter = 'all', now = Date.now()): FeedPost[] {
    const list = this.posts.filter((p) => matchesFilter(p, filter));
    const cache = new Map<string, number>();
    for (const p of list) cache.set(p.id, this.score(p, now));
    list.sort((a, b) => {
      const d = (cache.get(b.id) ?? 0) - (cache.get(a.id) ?? 0);
      return d !== 0 ? d : b.createdAt - a.createdAt;
    });
    return list;
  }

  /** One page of the ranked list. `cursor` is an index, not an opaque token. */
  page(filter: FeedFilter, cursor: number, limit: number, now = Date.now()): FeedPage {
    const list = this.ranked(filter, now);
    const slice = list.slice(cursor, cursor + limit);
    return {
      posts: slice,
      cursor: cursor + slice.length,
      done: cursor + slice.length >= list.length,
      total: list.length,
    };
  }

  // ── mutating ───────────────────────────────────────────────────────

  /** Optimistic reaction toggle. Returns the new "mine" state. */
  react(postId: string, kind: ReactionKind): boolean {
    const post = this.byId.get(postId);
    if (!post) return false;
    const r = toggleReaction(post, kind);
    this.save();
    this.emit({ kind: 'react', postId });
    return r.mine;
  }

  /**
   * Optimistic comment. A reply passes the parent's id and is stored with a
   * derived id so the thread survives a reload.
   */
  comment(postId: string, text: string, parentId?: string): FeedComment | null {
    const post = this.byId.get(postId);
    const body = text.trim();
    if (!post || !body) return null;
    const parent = parentId ? post.comments.find((c) => c.id === parentId) : undefined;
    const id = parent
      ? `${parent.id}-r${post.comments.filter((c) => c.id.startsWith(`${parent.id}-r`)).length}`
      : `${post.id}-c${Date.now().toString(36)}`;
    const mention = parent ? `@${parent.author.name} ` : '';
    const comment: FeedComment = {
      id,
      author: this.me,
      text: body.startsWith('@') || !mention ? body : mention + body,
      createdAt: Date.now(),
    };
    if (parent) {
      // Keep replies immediately beneath the last sibling of their parent.
      let insertAt = post.comments.indexOf(parent) + 1;
      while (insertAt < post.comments.length && post.comments[insertAt].id.startsWith(`${parent.id}-r`)) insertAt++;
      post.comments.splice(insertAt, 0, comment);
    } else {
      post.comments.push(comment);
    }
    this.save();
    this.emit({ kind: 'comment', postId });
    return comment;
  }

  /** Removes a comment you wrote (long-press → delete). */
  removeComment(postId: string, commentId: string): boolean {
    const post = this.byId.get(postId);
    if (!post) return false;
    const before = post.comments.length;
    post.comments = post.comments.filter((c) => c.id !== commentId && !c.id.startsWith(`${commentId}-r`));
    if (post.comments.length === before) return false;
    this.save();
    this.emit({ kind: 'comment', postId });
    return true;
  }

  /** Threaded view: root comments each with their replies. */
  thread(post: FeedPost): Array<{ root: FeedComment; replies: FeedComment[] }> {
    const roots: Array<{ root: FeedComment; replies: FeedComment[] }> = [];
    const index = new Map<string, { root: FeedComment; replies: FeedComment[] }>();
    for (const c of post.comments) {
      const cut = c.id.lastIndexOf('-r');
      const parentId = cut > 0 ? c.id.slice(0, cut) : null;
      const parent = parentId ? index.get(parentId) : null;
      if (parent) parent.replies.push(c);
      else {
        const node = { root: c, replies: [] as FeedComment[] };
        index.set(c.id, node);
        roots.push(node);
      }
    }
    return roots;
  }

  /** Inserts a post at the top (used by moment capture and by refresh). */
  insert(post: FeedPost): void {
    if (this.byId.has(post.id)) return;
    this.posts.unshift(post);
    this.byId.set(post.id, post);
    if (this.posts.length > MAX_STORED * 2) {
      const dropped = this.posts.splice(MAX_STORED * 2);
      for (const d of dropped) this.byId.delete(d.id);
    }
    this.save();
    this.emit({ kind: 'insert', postId: post.id });
  }

  // ── live arrivals ──────────────────────────────────────────────────

  /** Posts that have arrived but are still behind the "N new" pill. */
  pending(): FeedPost[] {
    return this.queued;
  }

  pendingCount(): number {
    return this.queued.length;
  }

  /** Moves queued arrivals into the feed proper. */
  flushPending(): FeedPost[] {
    if (!this.queued.length) return [];
    const moved = this.queued;
    this.queued = [];
    for (const p of moved) {
      if (this.byId.has(p.id)) continue;
      this.posts.unshift(p);
      this.byId.set(p.id, p);
    }
    this.save();
    this.emit({ kind: 'refresh' });
    return moved;
  }

  /** Queues a post behind the pill without disturbing the scroll position. */
  queue(post: FeedPost): void {
    if (this.byId.has(post.id) || this.queued.some((p) => p.id === post.id)) return;
    this.queued.unshift(post);
    this.emit({ kind: 'pending', postId: post.id });
  }

  /**
   * Starts the live ticker. Arrivals are spaced 14–42s apart, which reads as
   * a busy-but-not-frantic room and never fights the user's scroll.
   */
  startLive(): () => void {
    if (this.liveTimer) return () => this.stopLive();
    const tick = (): void => {
      this.liveSeed = (this.liveSeed * 1664525 + 1013904223) >>> 0;
      this.queue(generateLivePost(this.liveSeed, Date.now()));
      schedule();
    };
    const schedule = (): void => {
      const wait = 14_000 + Math.floor(Math.random() * 28_000);
      this.liveTimer = globalThis.setTimeout(tick, wait) as unknown as number;
    };
    schedule();
    return () => this.stopLive();
  }

  stopLive(): void {
    if (this.liveTimer) globalThis.clearTimeout(this.liveTimer);
    this.liveTimer = 0;
  }

  /**
   * Pull-to-refresh. Produces 1–3 genuinely new posts and puts them straight
   * into the feed (the user asked for them, so they do not go behind a pill).
   */
  refresh(): Promise<FeedPost[]> {
    return new Promise((resolve) => {
      globalThis.setTimeout(() => {
        const flushed = this.flushPending();
        const extra: FeedPost[] = [];
        const wanted = flushed.length ? 0 : 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < wanted; i++) {
          this.liveSeed = (this.liveSeed * 1664525 + 1013904223) >>> 0;
          const p = generateLivePost(this.liveSeed, Date.now() - i * 90_000);
          if (this.byId.has(p.id)) continue;
          this.posts.unshift(p);
          this.byId.set(p.id, p);
          extra.push(p);
        }
        this.save();
        this.emit({ kind: 'refresh' });
        resolve(flushed.concat(extra));
      }, 620);
    });
  }

  // ── subscriptions ──────────────────────────────────────────────────

  subscribe(fn: (c: FeedChange) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(change: FeedChange): void {
    for (const fn of Array.from(this.subs)) {
      try {
        fn(change);
      } catch (err) {
        console.error('[feed] subscriber failed', err);
      }
    }
  }

  /** Wipes persistence and reseeds — used by Settings › Reset. */
  reset(now = Date.now()): void {
    try {
      this.store?.removeItem(STORAGE_KEY);
    } catch {
      /* storage already unavailable */
    }
    this.queued = [];
    this.posts = generateFeed({ seed: FEED_SEED, count: SEED_COUNT, now });
    this.reindex();
    this.save();
    this.emit({ kind: 'seed' });
  }
}

/** Repairs a post that came back from JSON. */
function hydrate(raw: FeedPost): FeedPost {
  return {
    ...raw,
    reactions: normalizeReactions(raw.reactions),
    comments: Array.isArray(raw.comments) ? raw.comments : [],
    hand: raw.hand ?? null,
  };
}

let singleton: FeedStore | null = null;

/** The app-wide feed store. */
export function getFeed(): FeedStore {
  if (!singleton) {
    singleton = new FeedStore();
    // Anything else in the app that posts to the feed (moment capture, the
    // net layer) does it through the bus rather than importing the store.
    bus.on('feed:post', ({ post }) => singleton?.insert(post));
  }
  return singleton;
}
