/**
 * ROYALE — the feed screen.
 *
 * A living social surface: seeded on first run, ranked by recency blended with
 * heat, refreshed by a real rubber-band pull, and fed by live arrivals that
 * queue behind a "N new" pill instead of yanking the list out from under you.
 *
 * Everything the screen shows is real: the reactions mutate the store, the
 * comments persist, and every hand snapshot opens a full replay.
 */
import '../styles/feed.css';

import { h, cx, clear, keyedList } from '../dom.ts';
import type { KeyedList } from '../dom.ts';
import { bus } from '../../core/bus.ts';
import type { FeedPost } from '../../core/types.ts';
import { getFeed } from '../../social/feed.ts';
import type { FeedFilter } from '../../social/feed.ts';
import { Segmented } from '../components/segmented.ts';
import { EmptyState } from '../components/empty.ts';
import { Skeleton } from '../components/skeleton.ts';
import { haptic, reduceMotion } from '../components/util.ts';
import { PostCard } from '../feed/postcard.ts';
import type { PostCardEl } from '../feed/postcard.ts';
import { openReplay } from '../feed/replay.ts';
import { attachPullToRefresh } from '../feed/pull.ts';
import { installMomentShareUi, openPostShareSheet } from '../feed/share.ts';
import { spinnerMark } from '../feed/glyphs.ts';
import { compact } from '../feed/util.ts';

const PAGE = 7;

const FILTERS: Array<{ id: FeedFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'friends', label: 'Friends' },
  { id: 'wins', label: 'Big wins' },
  { id: 'beats', label: 'Bad beats' },
];

const EMPTY_COPY: Record<FeedFilter, { title: string; body: string; action: string }> = {
  all: {
    title: 'The room is quiet',
    body: 'Nothing has happened yet tonight. Take a seat and the feed starts writing itself.',
    action: 'Find a table',
  },
  friends: {
    title: 'No friends on the felt',
    body: 'When someone you play with hits quads or gets coolered, it lands right here.',
    action: 'Find a table',
  },
  wins: {
    title: 'No big pots yet',
    body: 'Quads, royals, scooped bomb pots and shipped sit-and-gos all collect here.',
    action: 'Find a table',
  },
  beats: {
    title: 'Nobody has been robbed',
    body: 'Suspicious. Bad beats show up here the moment somebody gets there on the river.',
    action: 'Find a table',
  },
};

/** A skeleton that mirrors the real card metrics so the swap never jumps. */
function skeletonCard(i: number): HTMLElement {
  return h(
    'div',
    { class: 'post post--normal fskel', style: { '--i': String(i) } },
    h('span', { class: 'post__rim', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'post__inner' },
      h(
        'div',
        { class: 'post__head' },
        Skeleton({ w: 40, h: 40, r: '50%', delay: i * 90 }),
        h(
          'div',
          { class: 'post__who' },
          Skeleton({ w: '46%', h: 12, delay: i * 90 + 60 }),
          Skeleton({ w: '32%', h: 9, delay: i * 90 + 120, class: 'fskel__gap' }),
        ),
        Skeleton({ w: 62, h: 22, r: 11, delay: i * 90 + 180 }),
      ),
      Skeleton({ w: '88%', h: 15, delay: i * 90 + 200, class: 'fskel__line' }),
      Skeleton({ w: '58%', h: 15, delay: i * 90 + 240, class: 'fskel__line' }),
      h(
        'div',
        { class: 'fskel__snap' },
        Skeleton({ w: '100%', h: 92, r: 14, delay: i * 90 + 300 }),
      ),
      h(
        'div',
        { class: 'fskel__bar' },
        Skeleton({ w: 58, h: 26, r: 13, delay: i * 90 + 360 }),
        Skeleton({ w: 58, h: 26, r: 13, delay: i * 90 + 400 }),
        Skeleton({ w: 38, h: 26, r: 13, delay: i * 90 + 440, class: 'fskel__push' }),
      ),
    ),
  );
}

export interface FeedScreen {
  unmount(): void;
}

export function mount(container: HTMLElement): FeedScreen {
  const feed = getFeed();
  const cold = !feed.isWarm();
  feed.ready();
  installMomentShareUi();

  let filter: FeedFilter = 'all';
  let cursor = 0;
  let done = false;
  let loading = false;
  let shown: FeedPost[] = [];
  let disposed = false;

  // ── chrome ───────────────────────────────────────────────────────
  const onlineCount = h('span', { class: 'feed__onlinen tnum' }, compact(940 + Math.floor(Math.random() * 700)));
  const online = h(
    'div',
    { class: 'feed__online', title: 'Players in the room right now' },
    h('span', { class: 'feed__pulse', 'aria-hidden': 'true' }),
    onlineCount,
    h('span', { class: 'feed__onlinel' }, 'playing'),
  );

  const seg = Segmented({
    items: FILTERS.map((f) => ({ id: f.id, label: f.label })),
    value: 'all',
    size: 'sm',
    full: true,
    ariaLabel: 'Filter the feed',
    class: 'feed__seg',
    onChange: (id) => setFilter(id as FeedFilter),
  });

  const header = h(
    'div',
    { class: 'feed__hd' },
    h(
      'div',
      { class: 'feed__hdtop' },
      h(
        'div',
        { class: 'feed__titles' },
        h('h1', { class: 'feed__h1' }, 'Feed'),
        h('p', { class: 'feed__h1s' }, 'Everything happening on the felt'),
      ),
      online,
    ),
    seg,
  );

  // ── list ─────────────────────────────────────────────────────────
  const list = h('div', { class: 'feed__list', role: 'feed', 'aria-busy': cold ? 'true' : 'false' });
  const sentinel = h('div', { class: 'feed__sentinel', 'aria-hidden': 'true' });
  const tail = h('div', { class: 'feed__tail' });
  const content = h('div', { class: 'feed__content' }, list, sentinel, tail);
  const spinner = h('div', { class: 'feed__spin', 'aria-hidden': 'true' }, spinnerMark(26));
  const scroller = h('div', { class: 'feed__scroll scroll' }, spinner, content);

  const pill = h(
    'button',
    { class: 'feed__pill', type: 'button', 'aria-live': 'polite' },
    h(
      'svg',
      { class: 'feed__pillc', attrs: { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': 'true' } },
      h('path', { attrs: { d: 'M5 15l7-7 7 7', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }),
    ),
    h('span', { class: 'feed__pillt' }, ''),
  ) as HTMLButtonElement;

  // The tab bar is translucent, so without this the next card's gold money
  // chip and its HOLE/BOARD captions read straight through the Play/Feed/Store
  // labels. The hem fades the list out over the 44px above the bar and holds a
  // near-opaque floor behind it — no seam, nothing legible underneath.
  const hem = h('div', { class: 'feed__hem', 'aria-hidden': 'true' });

  const root = h('div', { class: 'feed' }, header, scroller, hem, pill);
  container.appendChild(root);

  // The pill floats just under the chrome; the header's height changes with
  // the safe area and the short-screen rules, so it is measured, not guessed.
  const measureHeader = (): void => root.style.setProperty('--feed-hd', `${header.offsetHeight}px`);
  const headerRO =
    typeof ResizeObserver === 'function' ? new ResizeObserver(measureHeader) : null;
  headerRO?.observe(header);
  measureHeader();

  const freshIds = new Set<string>();

  const cards: KeyedList<FeedPost> = keyedList(list, {
    key: (p) => p.id,
    create: (p, _k, i) =>
      PostCard(p, {
        index: i,
        fresh: freshIds.has(p.id),
        onReplay: (post) => {
          if (!post.hand) return;
          const seat = post.hand.seats.find((s) => s.name === post.author.name)?.seat;
          openReplay(post.hand, {
            focusSeat: seat,
            title: post.author.name,
            subtitle: `${post.stakeLabel ?? ''} · ${post.hand.variant === 'plo4' ? 'PLO' : "Hold'em"}`,
            onShare: () => openPostShareSheet(post),
          });
        },
        onShare: (post) => openPostShareSheet(post),
      }),
    update: (el) => (el as PostCardEl).refresh(),
    remove: (el) => {
      (el as PostCardEl).dispose();
      el.remove();
    },
  });

  // ── rendering ────────────────────────────────────────────────────
  function renderTail(): void {
    clear(tail);
    if (loading) {
      tail.appendChild(
        h(
          'div',
          { class: 'feed__more' },
          h('span', { class: 'feed__moredot' }),
          h('span', { class: 'feed__moredot' }),
          h('span', { class: 'feed__moredot' }),
        ),
      );
      return;
    }
    if (done && shown.length) {
      tail.appendChild(
        h(
          'div',
          { class: 'feed__end' },
          h('span', { class: 'feed__endline', 'aria-hidden': 'true' }),
          h('span', { class: 'feed__endt caps' }, 'You are all caught up'),
          h('span', { class: 'feed__endline', 'aria-hidden': 'true' }),
        ),
      );
    }
  }

  function renderEmpty(): void {
    clear(tail);
    const copy = EMPTY_COPY[filter];
    tail.appendChild(
      EmptyState({
        art: filter === 'beats' ? 'cards' : filter === 'wins' ? 'trophy' : 'feed',
        title: copy.title,
        body: copy.body,
        actionLabel: copy.action,
        onAction: () => bus.emit('nav:route', { route: 'lobby' }),
        class: 'feed__empty',
      }),
    );
  }

  function paint(): void {
    cards.update(shown);
    list.setAttribute('aria-busy', 'false');
    if (!shown.length) renderEmpty();
    else renderTail();
  }

  function loadMore(): void {
    if (loading || done || disposed) return;
    loading = true;
    renderTail();
    const page = feed.page(filter, cursor, PAGE);
    cursor = page.cursor;
    done = page.done;
    shown = shown.concat(page.posts);
    loading = false;
    paint();
  }

  function resetList(animate: boolean): void {
    cursor = 0;
    done = false;
    shown = [];
    cards.clear();
    if (animate && !reduceMotion()) {
      list.classList.remove('is-swap');
      void list.offsetWidth;
      list.classList.add('is-swap');
    }
    loadMore();
    scroller.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function setFilter(next: FeedFilter): void {
    if (next === filter) return;
    filter = next;
    resetList(true);
  }

  // ── new-post pill ────────────────────────────────────────────────
  function paintPill(): void {
    const n = feed.pendingCount();
    const label = pill.querySelector('.feed__pillt') as HTMLElement | null;
    if (label) label.textContent = n === 1 ? '1 new post' : `${n} new posts`;
    pill.classList.toggle('is-on', n > 0);
    root.classList.toggle('has-pill', n > 0);
    pill.setAttribute('aria-hidden', n > 0 ? 'false' : 'true');
    pill.tabIndex = n > 0 ? 0 : -1;
  }

  pill.addEventListener('click', () => {
    const moved = feed.flushPending();
    for (const p of moved) freshIds.add(p.id);
    haptic('select');
    paintPill();
    resetList(false);
    window.setTimeout(() => freshIds.clear(), 1400);
  });

  // ── data subscriptions ───────────────────────────────────────────
  const offStore = feed.subscribe((change) => {
    if (disposed) return;
    if (change.kind === 'pending') {
      paintPill();
      return;
    }
    if (change.kind === 'insert' || change.kind === 'refresh' || change.kind === 'seed') {
      const keep = shown.length || PAGE;
      cursor = 0;
      done = false;
      const page = feed.page(filter, 0, Math.max(PAGE, keep));
      cursor = page.cursor;
      done = page.done;
      shown = page.posts;
      paint();
      paintPill();
    }
  });

  const offRoute = bus.on('nav:route', ({ route }) => {
    if (route !== 'feed') feed.stopLive();
  });

  // ── infinite scroll ──────────────────────────────────────────────
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) if (e.isIntersecting) loadMore();
          },
          { root: scroller, rootMargin: '520px 0px' },
        )
      : null;
  io?.observe(sentinel);

  // ── pull to refresh ──────────────────────────────────────────────
  const detachPull = attachPullToRefresh({
    scroller,
    content,
    spinner,
    onRefresh: async () => {
      const added = await feed.refresh();
      for (const p of added) freshIds.add(p.id);
      onlineCount.textContent = compact(940 + Math.floor(Math.random() * 700));
      window.setTimeout(() => freshIds.clear(), 1600);
      if (added.length) {
        bus.emit('ui:toast', {
          text: added.length === 1 ? '1 new post' : `${added.length} new posts`,
          tone: 'info',
          ms: 1600,
        });
      }
    },
  });

  // ── boot ─────────────────────────────────────────────────────────
  const stopLive = feed.startLive();
  let skeletonTimer = 0;

  if (cold) {
    for (let i = 0; i < 3; i++) list.appendChild(skeletonCard(i));
    skeletonTimer = window.setTimeout(() => {
      if (disposed) return;
      clear(list);
      loadMore();
      paintPill();
    }, 560) as unknown as number;
  } else {
    loadMore();
    paintPill();
  }

  // ── teardown ─────────────────────────────────────────────────────
  return {
    unmount(): void {
      disposed = true;
      window.clearTimeout(skeletonTimer);
      headerRO?.disconnect();
      io?.disconnect();
      detachPull();
      offStore();
      offRoute();
      stopLive();
      cards.clear();
      root.remove();
    },
  };
}

export default { mount };
