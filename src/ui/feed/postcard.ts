/**
 * ROYALE — ui/feed/postcard.ts
 * ────────────────────────────────────────────────────────────────────────────
 * One post. The card is the product: an author row with the full status stack,
 * a headline set in confident display type, a stake badge, and the hand
 * snapshot as the centrepiece.
 *
 * Tier treatment
 *   legendary  24k foil rim with a slow sheen sweeping around it
 *   epic       violet edge glow
 *   rare       cool hairline lift
 *   normal     the standard glass surface
 *
 * The foil is a 1px gradient *padding* on an outer element with the inner card
 * painted on top, so the animated sheen only ever shows on the rim. That keeps
 * it to one transform per frame with no filters anywhere.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { FeedPost } from '../../core/types.ts';

import { frameRarity, isFriend } from '../../data/names.ts';
import { Avatar } from '../components/avatar.ts';
import { haptic } from '../components/util.ts';
import { HandSnapshot } from './minicards.ts';
import { ReactionBar } from './reactionbar.ts';
import type { ReactionBarEl } from './reactionbar.ts';
import { CommentThread } from './comments.ts';
import type { CommentThreadEl } from './comments.ts';
import { KIND_LABEL, kindEmblem, chevron } from './glyphs.ts';
import { cash, fullTime, relTime } from './util.ts';

export interface PostCardOpts {
  onReplay?: (post: FeedPost) => void;
  onShare?: (post: FeedPost) => void;
  /** entrance stagger index */
  index?: number;
  /** mark as a freshly arrived post */
  fresh?: boolean;
  class?: ClassValue;
}

export interface PostCardEl extends HTMLElement {
  post: FeedPost;
  refresh(): void;
  dispose(): void;
}

const VARIANT_LABEL: Record<string, string> = { nlhe: "Hold'em", plo4: 'PLO' };

function crown(): SVGSVGElement {
  return h(
    'svg',
    { class: 'post__crown', attrs: { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': 'true' } },
    h('path', {
      attrs: {
        d: 'M3.3 8.1l3.9 2.7L12 5.2l4.8 5.6 3.9-2.7-1.7 9.1H5L3.3 8.1z',
        fill: 'currentColor',
      },
    }),
  );
}

/** The block a post shows when it has no hand attached. */
function MilestoneBlock(post: FeedPost): HTMLElement {
  const detail = post.body ?? '';
  const [name, rarity] = detail.split(' · ');
  return h(
    'div',
    { class: cx('mstone', rarity && `mstone--${rarity}`) },
    h('span', { class: 'mstone__halo', 'aria-hidden': 'true' }),
    h('span', { class: 'mstone__ic' }, kindEmblem(post.kind, 26)),
    h(
      'div',
      { class: 'mstone__col' },
      h('div', { class: 'mstone__t' }, name || KIND_LABEL[post.kind]),
      rarity ? h('div', { class: 'mstone__r caps' }, rarity) : null,
    ),
    post.amount ? h('div', { class: 'mstone__amt tnum' }, cash(post.amount)) : null,
  );
}

export function PostCard(post: FeedPost, opts: PostCardOpts = {}): PostCardEl {
  const friend = isFriend(post.author.id);
  const hasHand = !!post.hand;

  const badge = h(
    'div',
    { class: cx('post__badge', `post__badge--${post.kind}`) },
    h('span', { class: 'post__badgeic' }, kindEmblem(post.kind, 14)),
    h('span', { class: 'post__badget' }, KIND_LABEL[post.kind]),
  );

  const head = h(
    'header',
    { class: 'post__head' },
    h(
      'span',
      { class: 'post__av' },
      Avatar({
        player: post.author,
        size: 40,
        rarity: frameRarity(post.author.frameId),
        online: friend,
      }),
    ),
    h(
      'div',
      { class: 'post__who' },
      h(
        'div',
        { class: 'post__nameline' },
        h('span', { class: 'post__name' }, post.author.name),
        post.author.premium ? crown() : null,
        friend ? h('span', { class: 'post__friend caps' }, 'Friend') : null,
      ),
      h(
        'div',
        { class: 'post__meta' },
        h('span', { class: 'post__lvl tnum' }, `LV ${post.author.level}`),
        h('span', { class: 'post__dot', 'aria-hidden': 'true' }),
        h('time', { class: 'post__time tnum', title: fullTime(post.createdAt) }, relTime(post.createdAt)),
        post.stakeLabel
          ? [
              h('span', { class: 'post__dot', 'aria-hidden': 'true' }),
              h('span', { class: 'post__stake tnum' }, post.stakeLabel),
            ]
          : null,
      ),
    ),
    badge,
  );

  const headline = h('h3', { class: cx('post__headline', post.headline.length > 74 && 'is-long') }, post.headline);
  const body = post.body && hasHand ? h('p', { class: 'post__body' }, post.body) : null;

  let snapshot: HTMLElement | null = null;
  if (post.hand) {
    const authorSeat = post.hand.seats.find((s) => s.name === post.author.name)?.seat;
    const snap = HandSnapshot(post.hand, { seat: authorSeat });
    snapshot = h(
      'button',
      {
        class: 'post__snap',
        type: 'button',
        'aria-label': 'Open the full replay of this hand',
      },
      snap,
      h(
        'span',
        { class: 'post__watch' },
        h('span', { class: 'post__watcht' }, 'Watch replay'),
        h('span', { class: 'post__watchc', 'aria-hidden': 'true' }, chevron('right', 12)),
      ),
    );
    snapshot.addEventListener('click', () => {
      haptic('select');
      opts.onReplay?.(post);
    });
  } else {
    snapshot = MilestoneBlock(post);
  }

  const tags = h(
    'div',
    { class: 'post__tags' },
    post.variant ? h('span', { class: 'ptag' }, VARIANT_LABEL[post.variant] ?? post.variant) : null,
    post.amount !== undefined && hasHand
      ? h('span', { class: 'ptag ptag--money tnum' }, cash(post.amount))
      : null,
  );

  let comments: CommentThreadEl | null = null;
  let bar: ReactionBarEl | null = null;

  bar = ReactionBar(post, {
    onComments: () => comments?.toggle(),
    onShare: () => opts.onShare?.(post),
  });
  comments = CommentThread(post, { onChange: () => bar?.refresh() });

  const inner = h(
    'div',
    { class: 'post__inner' },
    head,
    headline,
    body,
    tags.childElementCount ? tags : null,
    snapshot,
    bar,
    comments,
  );

  const el = h(
    'article',
    {
      class: cx('post', `post--${post.tier}`, opts.fresh && 'is-fresh', opts.class),
      dataset: { kind: post.kind, tier: post.tier },
      style: opts.index !== undefined ? { '--i': String(Math.min(9, opts.index)) } : undefined,
    },
    h('span', { class: 'post__rim', 'aria-hidden': 'true' }, h('span', { class: 'post__sheen' })),
    inner,
  ) as PostCardEl;

  el.post = post;
  el.refresh = () => bar?.refresh();
  el.dispose = () => comments?.dispose();
  return el;
}
