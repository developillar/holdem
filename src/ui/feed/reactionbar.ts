/**
 * ROYALE — ui/feed/reactionbar.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The reaction row: aggregate chips, a facepile of who reacted, and the
 * add-reaction control.
 *
 *   tap        applies the post's natural reaction (a bad beat gets a skull,
 *              a royal gets the shocked face) with a spring and a particle pop
 *   long-press opens the full ten-reaction picker
 *   tap a chip toggles that specific reaction
 *
 * All motion is transform/opacity only, particles are recycled through
 * `animationend`, and every control clears the 44px touch floor.
 */
import { h, cx, clear } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { FeedPost, ReactionKind } from '../../core/types.ts';
import { REACTION_META, REACTION_KINDS, defaultReactionFor, topReactions, totalReactions } from '../../social/reactions.ts';
import { getFeed } from '../../social/feed.ts';
import { haptic, reduceMotion } from '../components/util.ts';
import { personaAt, PERSONA_POOL_SIZE, hashString } from '../../data/names.ts';
import { reactionGlyph, commentMark, shareMark } from './glyphs.ts';

export interface ReactionBarOpts {
  onComments?: () => void;
  onShare?: () => void;
  class?: ClassValue;
}

export interface ReactionBarEl extends HTMLDivElement {
  refresh(): void;
}

const PARTICLES = 11;

/** Deterministic "who reacted" list — same faces every time you see the post. */
function reactorFaces(post: FeedPost, n: number): Array<{ name: string; avatarId: string }> {
  const seed = hashString(post.id);
  const out: Array<{ name: string; avatarId: string }> = [];
  for (let i = 0; i < n; i++) {
    const mixed = (Math.imul(seed ^ (i + 1), 0x9e3779b1) >>> 0) % PERSONA_POOL_SIZE;
    const p = personaAt(mixed);
    out.push({ name: p.handle, avatarId: p.avatarId });
  }
  return out;
}

/**
 * A facepile disc. Deliberately not the full `Avatar`: at 19px, overlapped by
 * its neighbour, two-letter initials get sliced in half and read as noise.
 * One letter, one gradient, one ring — legible at any density.
 */
function faceDisc(name: string, avatarId: string, px: number): HTMLElement {
  const hv = hashString(avatarId || name);
  const hue = hv % 360;
  const hue2 = (hue + 30 + ((hv >> 9) % 40)) % 360;
  const sat = 46 + ((hv >> 5) % 22);
  const light = 30 + ((hv >> 13) % 12);
  const letter = (name.replace(/[^A-Za-z]/g, '')[0] ?? name[0] ?? '?').toUpperCase();
  return h(
    'span',
    {
      class: 'rbar__disc',
      style: {
        '--d': `${px}px`,
        '--d1': `hsl(${hue} ${sat}% ${light + 12}%)`,
        '--d2': `hsl(${hue2} ${sat - 8}% ${light - 8}%)`,
      },
      role: 'img',
      'aria-label': name,
    },
    h('span', { class: 'rbar__discl' }, letter),
  );
}

function burst(anchor: HTMLElement, kind: ReactionKind): void {
  if (reduceMotion()) return;
  const meta = REACTION_META[kind];
  const layer = h('span', { class: 'rfx', 'aria-hidden': 'true' });
  for (let i = 0; i < PARTICLES; i++) {
    const angle = -90 + (i / (PARTICLES - 1) - 0.5) * 128 + (Math.random() - 0.5) * 14;
    const dist = 26 + Math.random() * 44;
    const rad = (angle * Math.PI) / 180;
    const p = h('i', {
      class: 'rfx__p',
      style: {
        '--px': `${(Math.cos(rad) * dist).toFixed(1)}px`,
        '--py': `${(Math.sin(rad) * dist).toFixed(1)}px`,
        '--pd': `${(i * 14 + Math.random() * 40).toFixed(0)}ms`,
        '--pc': i % 3 === 0 ? meta.tint2 : meta.tint,
        '--ps': `${(3 + Math.random() * 4).toFixed(1)}px`,
        '--pr': `${(Math.random() * 240 - 120).toFixed(0)}deg`,
      },
    });
    layer.appendChild(p);
  }
  const ring = h('i', { class: 'rfx__ring', style: { '--pc': meta.tint } });
  layer.appendChild(ring);
  anchor.appendChild(layer);
  window.setTimeout(() => layer.remove(), 900);
}

function popIn(el: HTMLElement): void {
  if (reduceMotion()) return;
  el.classList.remove('is-pop');
  void el.offsetWidth;
  el.classList.add('is-pop');
}

export function ReactionBar(post: FeedPost, opts: ReactionBarOpts = {}): ReactionBarEl {
  const feed = getFeed();
  const chips = h('div', { class: 'rbar__chips' });
  const faces = h('div', { class: 'rbar__faces' });
  const addBtn = h(
    'button',
    {
      class: 'rbar__add',
      type: 'button',
      'aria-label': `React to this post — ${REACTION_META[defaultReactionFor(post.kind)].label}`,
      'aria-haspopup': 'true',
    },
    h('span', { class: 'rbar__addg' }, reactionGlyph(defaultReactionFor(post.kind), 21)),
    h('span', { class: 'rbar__addplus', 'aria-hidden': 'true' }),
  ) as HTMLButtonElement;

  const commentCount = h('span', { class: 'rbar__n tnum' }, String(post.comments.length));
  const commentBtn = h(
    'button',
    { class: 'rbar__act', type: 'button', 'aria-label': `${post.comments.length} comments` },
    commentMark(17),
    commentCount,
  ) as HTMLButtonElement;

  const shareBtn = h(
    'button',
    { class: 'rbar__act rbar__act--share', type: 'button', 'aria-label': 'Share this hand' },
    shareMark(17),
  ) as HTMLButtonElement;

  const picker = h('div', { class: 'rpick', role: 'menu', 'aria-label': 'Choose a reaction' });
  let pickerOpen = false;

  const el = h(
    'div',
    { class: cx('rbar', opts.class) },
    h('div', { class: 'rbar__left' }, chips, faces),
    h('div', { class: 'rbar__right' }, commentBtn, shareBtn, h('div', { class: 'rbar__addwrap' }, addBtn, picker)),
  ) as ReactionBarEl;

  // ── chips ────────────────────────────────────────────────────────
  const paintChips = (): void => {
    clear(chips);
    const list = topReactions(post, 2);
    for (const r of list) {
      const meta = REACTION_META[r.kind];
      const chip = h(
        'button',
        {
          class: cx('rchip', r.mine && 'is-mine'),
          type: 'button',
          style: { '--rc': meta.tint },
          'aria-pressed': r.mine ? 'true' : 'false',
          'aria-label': `${meta.label}, ${r.count}`,
        },
        h('span', { class: 'rchip__g' }, reactionGlyph(r.kind, 16)),
        h('span', { class: 'rchip__n tnum' }, String(Math.max(0, r.count))),
      ) as HTMLButtonElement;
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        apply(r.kind, chip);
      });
      chips.appendChild(chip);
    }
    if (!list.length) {
      chips.appendChild(h('span', { class: 'rbar__hint' }, 'Be the first to react'));
    }
  };

  const paintFaces = (): void => {
    clear(faces);
    const total = totalReactions(post);
    if (total <= 0) return;
    const show = Math.min(3, total);
    const people = reactorFaces(post, show);
    const stack = h('span', { class: 'rbar__stack' });
    people.forEach((p, i) => {
      stack.appendChild(
        h('span', { class: 'rbar__face', style: { zIndex: String(9 - i) } }, faceDisc(p.name, p.avatarId, 19)),
      );
    });
    faces.appendChild(stack);
    faces.appendChild(h('span', { class: 'rbar__total tnum' }, total > 999 ? `${(total / 1000).toFixed(1)}K` : String(total)));
  };

  const apply = (kind: ReactionKind, anchor: HTMLElement): void => {
    const on = feed.react(post.id, kind);
    haptic(on ? 'select' : 'tick');
    if (on) burst(anchor, kind);
    popIn(anchor);
    paintChips();
    paintFaces();
    closePicker();
  };

  // ── picker ───────────────────────────────────────────────────────
  const buildPicker = (): void => {
    clear(picker);
    REACTION_KINDS.forEach((kind, i) => {
      const meta = REACTION_META[kind];
      const mine = post.reactions.find((r) => r.kind === kind)?.mine ?? false;
      const b = h(
        'button',
        {
          class: cx('rpick__b', mine && 'is-mine'),
          type: 'button',
          role: 'menuitem',
          style: { '--i': String(i), '--rc': meta.tint },
          'aria-label': meta.label,
        },
        reactionGlyph(kind, 26),
        h('span', { class: 'rpick__l' }, meta.label),
      ) as HTMLButtonElement;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        apply(kind, addBtn);
      });
      picker.appendChild(b);
    });
  };

  const openPicker = (): void => {
    if (pickerOpen) return;
    pickerOpen = true;
    buildPicker();
    picker.classList.add('is-open');
    addBtn.setAttribute('aria-expanded', 'true');
    haptic('select');
    window.setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  };

  const closePicker = (): void => {
    if (!pickerOpen) return;
    pickerOpen = false;
    picker.classList.remove('is-open');
    addBtn.removeAttribute('aria-expanded');
    document.removeEventListener('pointerdown', onOutside, true);
  };

  const onOutside = (ev: Event): void => {
    if (picker.contains(ev.target as Node) || addBtn.contains(ev.target as Node)) return;
    closePicker();
  };

  // ── long press ───────────────────────────────────────────────────
  let holdTimer = 0;
  let held = false;
  let sx = 0;
  let sy = 0;

  addBtn.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    held = false;
    sx = e.clientX;
    sy = e.clientY;
    addBtn.classList.add('is-press');
    holdTimer = window.setTimeout(() => {
      held = true;
      openPicker();
    }, 340);
  });
  const endHold = (): void => {
    window.clearTimeout(holdTimer);
    addBtn.classList.remove('is-press');
  };
  addBtn.addEventListener('pointermove', (ev) => {
    const e = ev as PointerEvent;
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) endHold();
  });
  addBtn.addEventListener('pointerup', endHold);
  addBtn.addEventListener('pointercancel', endHold);
  addBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (held) {
      held = false;
      return;
    }
    if (pickerOpen) {
      closePicker();
      return;
    }
    apply(defaultReactionFor(post.kind), addBtn);
  });
  addBtn.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openPicker();
  });

  commentBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    opts.onComments?.();
  });
  shareBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    opts.onShare?.();
  });

  el.refresh = () => {
    paintChips();
    paintFaces();
    commentCount.textContent = String(post.comments.length);
    commentBtn.setAttribute('aria-label', `${post.comments.length} comments`);
  };

  paintChips();
  paintFaces();
  return el;
}
