/**
 * ROYALE — ui/feed/comments.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The comment thread. Collapsed it shows the two liveliest replies; expanded
 * it becomes a two-level thread with a compose row that lifts above the
 * on-screen keyboard and posts optimistically.
 *
 *   const thread = CommentThread(post, { onChange });
 *   thread.expand();          // opens and focuses the composer
 */
import { h, cx, clear } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { FeedComment, FeedPost } from '../../core/types.ts';
import { getFeed } from '../../social/feed.ts';
import { Avatar } from '../components/avatar.ts';
import { haptic } from '../components/util.ts';
import { chevron } from './glyphs.ts';
import { fullTime, relTime, splitMention, watchKeyboard } from './util.ts';

export interface CommentThreadOpts {
  onChange?: () => void;
  class?: ClassValue;
}

export interface CommentThreadEl extends HTMLDivElement {
  expand(focus?: boolean): void;
  collapse(): void;
  toggle(): void;
  isOpen(): boolean;
  dispose(): void;
}

function commentRow(
  post: FeedPost,
  c: FeedComment,
  isReply: boolean,
  onReply: (c: FeedComment) => void,
  onDelete: (c: FeedComment) => void,
  mine: boolean,
): HTMLElement {
  const { mention, rest } = splitMention(c.text);
  const body = h('span', { class: 'cmt__body' });
  if (mention) body.appendChild(h('b', { class: 'cmt__mention' }, `@${mention}`));
  body.appendChild(document.createTextNode(mention ? ` ${rest}` : rest));

  const row = h(
    'li',
    { class: cx('cmt', isReply && 'is-reply', mine && 'is-mine') },
    h('span', { class: 'cmt__av' }, Avatar({ player: c.author, size: isReply ? 24 : 28, level: null })),
    h(
      'div',
      { class: 'cmt__col' },
      h(
        'div',
        { class: 'cmt__head' },
        h('span', { class: 'cmt__name' }, c.author.name),
        c.author.premium ? h('span', { class: 'cmt__prem', 'aria-hidden': 'true' }) : null,
        h('span', { class: 'cmt__time tnum', title: fullTime(c.createdAt) }, relTime(c.createdAt)),
      ),
      body,
      h(
        'div',
        { class: 'cmt__acts' },
        h('button', { class: 'cmt__act', type: 'button', onclick: () => onReply(c) }, 'Reply'),
        mine ? h('button', { class: 'cmt__act cmt__act--del', type: 'button', onclick: () => onDelete(c) }, 'Delete') : null,
      ),
    ),
  );
  return row;
}

export function CommentThread(post: FeedPost, opts: CommentThreadOpts = {}): CommentThreadEl {
  const feed = getFeed();
  let open = false;
  let replyTo: FeedComment | null = null;
  let unwatch: (() => void) | null = null;

  const preview = h('div', { class: 'cthread__preview' });
  const list = h('ul', { class: 'cthread__list', role: 'list' });
  const toggleBtn = h(
    'button',
    { class: 'cthread__toggle', type: 'button', 'aria-expanded': 'false' },
    h('span', { class: 'cthread__togglet' }, ''),
    h('span', { class: 'cthread__chev', 'aria-hidden': 'true' }, chevron('down', 13)),
  ) as HTMLButtonElement;

  const input = h('input', {
    class: 'ccompose__input',
    type: 'text',
    attrs: {
      placeholder: 'Add a comment…',
      maxlength: '240',
      enterkeyhint: 'send',
      autocomplete: 'off',
      autocapitalize: 'sentences',
      'aria-label': 'Add a comment',
    },
  }) as HTMLInputElement;

  const sendBtn = h(
    'button',
    { class: 'ccompose__send', type: 'button', disabled: true, 'aria-label': 'Post comment' },
    h(
      'svg',
      { attrs: { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' } },
      h('path', {
        attrs: {
          d: 'M3.6 11.2l16-7.2-7.2 16-2-6.4-6.8-2.4z',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.8,
          'stroke-linejoin': 'round',
        },
      }),
    ),
  ) as HTMLButtonElement;

  const replyChip = h('div', { class: 'ccompose__reply' });

  const compose = h(
    'div',
    { class: 'ccompose' },
    replyChip,
    h(
      'div',
      { class: 'ccompose__row' },
      h('span', { class: 'ccompose__av' }, Avatar({ player: feed.me, size: 28, level: null })),
      h('div', { class: 'ccompose__field' }, input),
      sendBtn,
    ),
  );

  const body = h('div', { class: 'cthread__body' }, h('div', { class: 'cthread__inner' }, list, compose));

  const el = h('div', { class: cx('cthread', opts.class) }, preview, toggleBtn, body) as CommentThreadEl;

  // ── painting ─────────────────────────────────────────────────────
  const paintPreview = (): void => {
    clear(preview);
    if (open || !post.comments.length) return;
    const top = post.comments.slice(0, 2);
    for (const c of top) {
      const { mention, rest } = splitMention(c.text);
      preview.appendChild(
        h(
          'div',
          { class: 'cprev' },
          h('span', { class: 'cprev__name' }, c.author.name),
          h('span', { class: 'cprev__t' }, mention ? `@${mention} ${rest}` : rest),
        ),
      );
    }
  };

  const paintToggle = (): void => {
    const n = post.comments.length;
    const label = toggleBtn.firstElementChild as HTMLElement;
    label.textContent = open
      ? 'Hide comments'
      : n === 0
        ? 'Add the first comment'
        : n === 1
          ? 'View 1 comment'
          : `View all ${n} comments`;
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggleBtn.classList.toggle('is-open', open);
  };

  const doReply = (c: FeedComment): void => {
    replyTo = c;
    clear(replyChip);
    replyChip.appendChild(
      h(
        'span',
        { class: 'ccompose__replyc' },
        h('span', null, 'Replying to '),
        h('b', null, `@${c.author.name}`),
        h(
          'button',
          {
            class: 'ccompose__replyx',
            type: 'button',
            'aria-label': 'Cancel reply',
            onclick: () => {
              replyTo = null;
              clear(replyChip);
            },
          },
          '×',
        ),
      ),
    );
    if (!open) expand(false);
    input.focus();
  };

  const doDelete = (c: FeedComment): void => {
    feed.removeComment(post.id, c.id);
    haptic('tick');
    paintList();
    paintPreview();
    paintToggle();
    opts.onChange?.();
  };

  const paintList = (): void => {
    clear(list);
    if (!post.comments.length) {
      list.appendChild(
        h(
          'li',
          { class: 'cthread__empty' },
          h('span', { class: 'cthread__emptyt' }, 'No comments yet.'),
          h('span', { class: 'cthread__emptys' }, 'Say something worth reading.'),
        ),
      );
      return;
    }
    for (const node of feed.thread(post)) {
      list.appendChild(commentRow(post, node.root, false, doReply, doDelete, node.root.author.id === feed.me.id));
      for (const r of node.replies) {
        list.appendChild(commentRow(post, r, true, doReply, doDelete, r.author.id === feed.me.id));
      }
    }
  };

  // ── posting ──────────────────────────────────────────────────────
  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    const created = feed.comment(post.id, text, replyTo?.id);
    input.value = '';
    sendBtn.disabled = true;
    replyTo = null;
    clear(replyChip);
    paintList();
    paintToggle();
    opts.onChange?.();
    haptic('select');
    if (created) {
      // Optimistic: the row is already in the DOM. Flash it so the post
      // registers as "landed" rather than silently appearing.
      const rows = list.querySelectorAll<HTMLElement>('.cmt');
      for (const r of Array.from(rows)) {
        if (r.querySelector('.cmt__body')?.textContent?.includes(created.text.slice(0, 24))) {
          r.classList.add('is-new');
          window.setTimeout(() => r.classList.remove('is-new'), 900);
        }
      }
      list.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });
  sendBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    submit();
  });
  input.addEventListener('focus', () => {
    el.classList.add('is-focused');
    window.setTimeout(() => compose.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 260);
  });
  input.addEventListener('blur', () => el.classList.remove('is-focused'));

  // ── open / close ─────────────────────────────────────────────────
  function expand(focus = true): void {
    if (open) return;
    open = true;
    paintList();
    el.classList.add('is-open');
    paintPreview();
    paintToggle();
    unwatch = watchKeyboard((inset) => el.style.setProperty('--kb', `${inset}px`));
    if (focus) window.setTimeout(() => input.focus(), 220);
  }

  function collapse(): void {
    if (!open) return;
    open = false;
    el.classList.remove('is-open');
    unwatch?.();
    unwatch = null;
    paintPreview();
    paintToggle();
    input.blur();
  }

  toggleBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    haptic('tick');
    if (open) collapse();
    else expand(false);
  });

  el.expand = expand;
  el.collapse = collapse;
  el.toggle = () => (open ? collapse() : expand(false));
  el.isOpen = () => open;
  el.dispose = () => {
    unwatch?.();
    unwatch = null;
  };

  paintPreview();
  paintToggle();
  return el;
}
