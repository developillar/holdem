/**
 * ROYALE — ui/feed/share.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Two sheets and one bridge.
 *
 *   openMomentSheet(offer)   the "share this hand" offer raised by moment
 *                            capture right after you win / lose something big
 *   openPostShareSheet(post) the share affordance on an existing post
 *   installMomentShareUi()   starts moment capture and wires its offers to the
 *                            sheet. Call once at boot; safe to call repeatedly.
 *
 * Everything here works offline: sharing writes to the local feed store via
 * the bus, and "copy" writes a plain-text hand history to the clipboard.
 */
import { h } from '../dom.ts';
import { bus } from '../../core/bus.ts';
import type { FeedPost, HandReplay, Street } from '../../core/types.ts';
import { cardName } from '../../core/types.ts';
import { cash } from './util.ts';
import { openSheet } from '../components/sheet.ts';
import { Button } from '../components/button.ts';
import { haptic } from '../components/util.ts';
import { momentCapture } from '../../social/moments.ts';
import type { MomentOffer } from '../../social/moments.ts';
import { getFeed } from '../../social/feed.ts';
import { HandSnapshot } from './minicards.ts';
import { kindEmblem, KIND_LABEL } from './glyphs.ts';

const STREET_TITLE: Record<Street, string> = {
  preflop: 'PREFLOP',
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
  showdown: 'SHOWDOWN',
};

/** A plain-text hand history — the thing people actually paste into Discord. */
export function handHistoryText(replay: HandReplay): string {
  const lines: string[] = [];
  lines.push(`ROYALE hand #${replay.handId} · ${replay.stakeLabel} · ${replay.variant === 'plo4' ? 'PLO' : "Hold'em"}`);
  for (const s of replay.seats) {
    const cards = s.holeCards?.length ? ` [${s.holeCards.map(cardName).join(' ')}]` : '';
    const btn = s.seat === replay.buttonSeat ? ' (BTN)' : '';
    lines.push(`Seat ${s.seat + 1}: ${s.name}${btn} — ${cash(s.startStack)}${cards}`);
  }
  let street: Street | null = null;
  const boardAt: Record<string, string> = {
    flop: replay.board.slice(0, 3).map(cardName).join(' '),
    turn: replay.board.slice(3, 4).map(cardName).join(' '),
    river: replay.board.slice(4, 5).map(cardName).join(' '),
  };
  for (const a of replay.actions) {
    if (a.street !== street) {
      street = a.street;
      const b = boardAt[street];
      lines.push(`--- ${STREET_TITLE[street]}${b ? ` [${b}]` : ''} ---`);
    }
    const name = replay.seats.find((s) => s.seat === a.seat)?.name ?? `Seat ${a.seat + 1}`;
    const amt = a.kind === 'fold' || a.kind === 'check' ? '' : ` ${cash(a.amount)}`;
    lines.push(`${name}: ${a.kind}${amt}`);
  }
  if (replay.board.length >= 5 && street !== 'river') {
    lines.push(`--- BOARD [${replay.board.map(cardName).join(' ')}] ---`);
  }
  lines.push('--- SHOWDOWN ---');
  for (const r of replay.results) {
    const name = replay.seats.find((s) => s.seat === r.seat)?.name ?? `Seat ${r.seat + 1}`;
    if (r.won > 0) lines.push(`${name} wins ${cash(r.won)}${r.rank ? ` with ${r.rank.label}` : ''}`);
    else if (r.rank) lines.push(`${name} shows ${r.rank.label}`);
  }
  lines.push(`Total pot ${cash(replay.potTotal)}`);
  return lines.join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the manual path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function offerHeader(offer: MomentOffer): HTMLElement {
  return h(
    'div',
    { class: 'shr__hero' },
    h('span', { class: `shr__emb shr__emb--${offer.post.tier}` }, kindEmblem(offer.post.kind, 26)),
    h(
      'div',
      { class: 'shr__herocol' },
      h('div', { class: 'shr__herot' }, offer.title),
      h('div', { class: 'shr__heros' }, offer.subtitle),
    ),
  );
}

/** The post-hand "share this?" sheet. */
export function openMomentSheet(offer: MomentOffer): void {
  const feed = getFeed();
  const note = h('input', {
    class: 'shr__note',
    type: 'text',
    value: offer.post.headline,
    attrs: { maxlength: '140', 'aria-label': 'Say something about this hand', placeholder: 'Say something…' },
  }) as HTMLInputElement;

  openSheet({
    eyebrow: KIND_LABEL[offer.post.kind],
    title: 'Share this hand',
    subtitle: 'It goes to your feed with the full replay attached.',
    class: 'shr',
    content: () =>
      h(
        'div',
        { class: 'shr__body' },
        offerHeader(offer),
        offer.post.hand ? h('div', { class: 'shr__snap' }, HandSnapshot(offer.post.hand, { dense: true })) : null,
        h('label', { class: 'shr__label caps' }, 'Caption'),
        note,
      ),
    footer: (sheet) =>
      h(
        'div',
        { class: 'shr__foot' },
        Button({
          label: 'Not now',
          variant: 'ghost',
          onTap: () => {
            momentCapture.dismiss(offer.id);
            sheet.close();
          },
        }),
        Button({
          label: 'Share to feed',
          variant: 'primary',
          full: true,
          onTap: () => {
            offer.post.headline = note.value.trim() || offer.post.headline;
            momentCapture.share(offer.id);
            feed.ready();
            sheet.close();
          },
        }),
      ),
  });
}

/** The share affordance on an existing post. */
export function openPostShareSheet(post: FeedPost): void {
  const feed = getFeed();
  openSheet({
    eyebrow: KIND_LABEL[post.kind],
    title: 'Share',
    subtitle: `${post.author.name} · ${post.stakeLabel ?? 'Royale'}`,
    class: 'shr',
    content: () =>
      h(
        'div',
        { class: 'shr__body' },
        post.hand ? h('div', { class: 'shr__snap' }, HandSnapshot(post.hand, { dense: true })) : null,
        h('p', { class: 'shr__quote' }, post.headline),
      ),
    footer: (sheet) =>
      h(
        'div',
        { class: 'shr__footcol' },
        post.hand
          ? Button({
              label: 'Copy hand history',
              variant: 'secondary',
              full: true,
              onTap: async () => {
                const ok = await copyText(handHistoryText(post.hand!));
                bus.emit('ui:toast', {
                  text: ok ? 'Hand history copied' : 'Could not reach the clipboard',
                  tone: ok ? 'good' : 'bad',
                });
              },
            })
          : null,
        Button({
          label: 'Repost to your feed',
          variant: 'primary',
          full: true,
          onTap: () => {
            const repost: FeedPost = {
              ...post,
              id: `re-${post.id}-${Date.now().toString(36)}`,
              author: feed.me,
              createdAt: Date.now(),
              headline: `Look what ${post.author.name} just did.`,
              body: post.headline,
              reactions: post.reactions.map((r) => ({ kind: r.kind, count: 0, mine: false })),
              comments: [],
            };
            bus.emit('feed:post', { post: repost });
            haptic('win');
            bus.emit('ui:toast', { text: 'Reposted to your feed', tone: 'good' });
            sheet.close();
          },
        }),
      ),
  });
}

// ───────────────────────────── bridge ─────────────────────────────

let installed = false;

/**
 * Starts moment capture and turns its offers into sheets. The toast that
 * capture emits is the passive notification; this is the interactive half.
 * Offers raised before this ran are replayed by `onOffer`, so nothing that
 * happened at the table before the feed was ever opened gets lost.
 */
export function installMomentShareUi(): () => void {
  if (installed) return () => {};
  installed = true;
  momentCapture.start();
  let last = 0;
  const off = momentCapture.onOffer((offer) => {
    // Never stack sheets on a fast run of hands; the newest offer wins.
    const now = Date.now();
    if (now - last < 900) return;
    last = now;
    if (document.querySelector('.r-sheet-root')) return;
    openMomentSheet(offer);
  });
  return () => {
    off();
    installed = false;
  };
}
