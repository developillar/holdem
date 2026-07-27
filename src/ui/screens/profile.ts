/**
 * ROYALE — screens/profile.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Who you are in this game.
 *
 *   nameplate     the avatar at full size with its frame, title and level ring
 *   lifetime      four numbers that summarise every hand you have played
 *   loadout       eight equipped slots, each a live preview, each swappable
 *                 without leaving the screen
 *   trophies      twelve achievements, earned ones lit and dated
 *   friends       who is online, what they are playing
 *
 * The loadout sheet is the important interaction: tapping a slot opens the
 * items you own in that category, so changing your look never costs a trip to
 * the store — and the store is one tap away when you run out of options.
 */
import '../styles/store.css';
import { bus } from '../../core/bus.ts';
import type { CosmeticKind } from '../../core/types.ts';

import { h, clear, cx } from '../dom.ts';
import { Button } from '../components/button.ts';
import { openSheet } from '../components/sheet.ts';
import { RingProgress } from '../components/progress.ts';
import { Pill } from '../components/pill.ts';
import { icon } from '../components/icons.ts';
import { EmptyState } from '../components/empty.ts';
import { fmtInt, haptic, pressFeedback } from '../components/util.ts';
import { CATALOG, KIND_META, KIND_ORDER, itemById } from '../../data/catalog.ts';
import { friendRoster, levelFor, personaById } from '../../data/names.ts';
import {
  collectionProgress, econ, equip, equippedId, equippedItem, isPremium, onWallet, owns, premiumDaysLeft,
} from '../../econ/wallet.ts';
import { passState, positionFor } from '../../econ/pass.ts';
import { statsFor, totalsFor } from '../../econ/analytics.ts';
import { createAvatarElement, getAvatarDataUrl } from '../../econ/avatars.ts';
import { previewNode } from '../econ/preview.ts';
import { ItemTile } from '../econ/tile.ts';
import { openItemSheet } from '../econ/detail.ts';

/** Money for the lifetime tiles — matches the analytics screen's formatting. */
function cash(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
  if (abs >= 10) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

// ─────────────────────────── achievements ───────────────────────────

interface Trophy {
  id: string;
  name: string;
  detail: string;
  glyph: 'trophy' | 'flame' | 'crown' | 'target' | 'chart' | 'spade' | 'gem' | 'shield' | 'bolt' | 'star' | 'cards' | 'users';
  /** 0–1 */
  progress(): number;
}

function trophies(): Trophy[] {
  const t = totalsFor();
  const line = statsFor();
  const coll = collectionProgress();
  const pass = passState();
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  return [
    { id: 'first-hand', name: 'Sat Down', detail: 'Play your first hand', glyph: 'cards', progress: () => clamp01(t.hands / 1) },
    { id: 'volume-1k', name: 'Thousand Club', detail: 'Play 1,000 hands', glyph: 'chart', progress: () => clamp01(t.hands / 1000) },
    { id: 'volume-10k', name: 'Ten Thousand', detail: 'Play 10,000 hands', glyph: 'bolt', progress: () => clamp01(t.hands / 10_000) },
    { id: 'winner', name: 'In The Black', detail: 'Finish 20 winning sessions', glyph: 'trophy', progress: () => clamp01(t.sessions > 0 ? (t.net > 0 ? Math.min(20, t.sessions) : 0) / 20 : 0) },
    { id: 'crusher', name: 'Crusher', detail: 'Hold a 5bb/100 win rate over 5,000 hands', glyph: 'flame', progress: () => clamp01(Math.min(1, t.hands / 5000) * clamp01(line.winrateBb100 / 5)) },
    { id: 'showman', name: 'Showman', detail: 'Win 500 pots at showdown', glyph: 'spade', progress: () => clamp01((line.wsd * line.wtsd * t.hands) / 500) },
    { id: 'collector', name: 'Collector', detail: 'Own 25 cosmetics', glyph: 'gem', progress: () => clamp01(coll.owned / 25) },
    { id: 'curator', name: 'Curator', detail: 'Own half the catalogue', glyph: 'star', progress: () => clamp01(coll.owned / (coll.total / 2)) },
    { id: 'tier-25', name: 'Halfway Up', detail: 'Reach pass tier 25', glyph: 'target', progress: () => clamp01(pass.tier / 25) },
    { id: 'tier-50', name: 'Top of the Track', detail: 'Reach pass tier 50', glyph: 'crown', progress: () => clamp01(pass.tier / 50) },
    { id: 'disciplined', name: 'Disciplined', detail: 'Keep fold-to-3-bet under 55%', glyph: 'shield', progress: () => clamp01(line.hands >= 300 && line.foldToThreeBet > 0 ? (0.55 - line.foldToThreeBet) / 0.1 + 0.5 : 0) },
    { id: 'social', name: 'Regular', detail: 'Play on 30 separate days', glyph: 'users', progress: () => clamp01(t.sessions / 30) },
  ];
}

// ─────────────────────────── loadout sheet ───────────────────────────

function openSlotSheet(kind: CosmeticKind, onChange: () => void): void {
  const meta = KIND_META[kind];
  const ownedItems = CATALOG.filter((i) => i.kind === kind && owns(i.id));
  const avatarId = equippedId('avatar') ?? 'avatar-first-light';

  openSheet({
    class: 'pf-slotsheet',
    eyebrow: 'Change your look',
    title: meta.label,
    subtitle: meta.blurb,
    full: ownedItems.length > 6,
    content: (sheet) => {
      const grid = h('div', { class: cx('pf-slotsheet__grid', (kind === 'table-skin' || kind === 'felt') && 'is-wide') });
      if (!ownedItems.length) {
        return h(
          'div',
          { class: 'pf-slotsheet__body' },
          EmptyState({
            art: 'store',
            title: `No ${meta.noun}s yet`,
            body: 'Everything in this category is still in the store.',
            actionLabel: 'Open the store',
            onAction: () => {
              sheet.close();
              bus.emit('nav:route', { route: 'store' });
            },
          }),
        );
      }
      for (const item of ownedItems) {
        const tile = ItemTile({
          item,
          size: kind === 'table-skin' || kind === 'felt' ? 104 : 88,
          avatarId,
          onTap: (it) => {
            const res = equip(it.id);
            if (!res.ok) {
              bus.emit('ui:toast', { text: res.message ?? 'Could not equip', tone: 'bad', ms: 2200 });
              return;
            }
            haptic('select');
            bus.emit('ui:toast', { text: `${it.name} equipped`, tone: 'good', ms: 1800 });
            onChange();
            for (const t of Array.from(grid.children)) {
              const child = t as HTMLElement & { refresh?(): void };
              child.refresh?.();
            }
          },
        });
        grid.appendChild(tile);
      }
      return h('div', { class: 'pf-slotsheet__body' }, grid);
    },
    footer: (sheet) =>
      Button({
        label: 'Browse the store',
        variant: 'secondary',
        size: 'md',
        full: true,
        iconRight: icon('arrow-up-right', { size: 16 }),
        onTap: () => {
          sheet.close();
          bus.emit('nav:route', { route: 'store' });
        },
      }),
  });
}

// ─────────────────────────── screen ───────────────────────────

export interface ProfileInstance {
  unmount(): void;
}

export function mount(container: HTMLElement): ProfileInstance {
  const root = h('div', { class: 'pf scroll' });
  const aura = h('div', { class: 'pf__aura', 'aria-hidden': 'true' });
  const inner = h('div', { class: 'pf__inner' });
  root.append(aura, inner);
  container.appendChild(root);

  const cleanups: Array<() => void> = [];
  const playerName = 'You';

  // ── nameplate ──────────────────────────────────────────────────────
  const avatarWrap = h('div', { class: 'pf__avwrap' });
  const nameEl = h('h1', { class: 'pf__name' }, playerName);
  const titleEl = h('div', { class: 'pf__titleplate' });
  const levelRing = RingProgress({ value: 0, size: 62, stroke: 4.5, tone: 'gold' });
  const levelNum = h('b', { class: 'pf__lvln tnum' }, '1');
  levelRing.setCenter(h('span', { class: 'pf__lvlwrap' }, h('span', { class: 'pf__lvlcap caps' }, 'lvl'), levelNum));
  const premiumChip = h('div', { class: 'pf__prem' });

  const hero = h(
    'header',
    { class: 'pf__hero pf__sec', style: { '--i': '0' } },
    h('span', { class: 'pf__heroglow', 'aria-hidden': 'true' }),
    avatarWrap,
    h('div', { class: 'pf__ident' }, nameEl, titleEl, premiumChip),
    levelRing,
  );

  // ── lifetime numbers ───────────────────────────────────────────────
  const statGrid = h('div', { class: 'pf__stats' });
  const statSec = h(
    'section',
    { class: 'pf__sec', style: { '--i': '1' } },
    h(
      'div',
      { class: 'pf__sechead' },
      h('h2', { class: 'pf__sectitle' }, 'Lifetime'),
      h(
        'button',
        {
          class: 'pf__seclink',
          type: 'button',
          onclick: () => {
            haptic('tick');
            bus.emit('nav:route', { route: 'stats' });
          },
        },
        h('span', null, 'Full stats'),
        icon('chevron-right', { size: 14, stroke: 2.2 }),
      ),
    ),
    statGrid,
  );

  // ── loadout ────────────────────────────────────────────────────────
  const loadout = h('div', { class: 'pf__loadout' });
  const loadSec = h(
    'section',
    { class: 'pf__sec', style: { '--i': '2' } },
    h(
      'div',
      { class: 'pf__sechead' },
      h('h2', { class: 'pf__sectitle' }, 'Loadout'),
      h('span', { class: 'pf__seccap' }, 'Tap a slot to swap'),
    ),
    loadout,
  );

  // ── trophies ───────────────────────────────────────────────────────
  const trophyGrid = h('div', { class: 'pf__trophies' });
  const trophyCount = h('span', { class: 'pf__seccap tnum' });
  const trophySec = h(
    'section',
    { class: 'pf__sec', style: { '--i': '3' } },
    h('div', { class: 'pf__sechead' }, h('h2', { class: 'pf__sectitle' }, 'Trophy case'), trophyCount),
    trophyGrid,
  );

  // ── friends ────────────────────────────────────────────────────────
  const friendList = h('div', { class: 'pf__friends' });
  const friendSec = h(
    'section',
    { class: 'pf__sec', style: { '--i': '4' } },
    h(
      'div',
      { class: 'pf__sechead' },
      h('h2', { class: 'pf__sectitle' }, 'Friends'),
      h('span', { class: 'pf__seccap tnum' }, ''),
    ),
    friendList,
  );

  const footer = h(
    'footer',
    { class: 'pf__foot pf__sec', style: { '--i': '5' } },
    Button({
      label: 'Settings',
      variant: 'secondary',
      size: 'md',
      full: true,
      icon: icon('gear', { size: 17 }),
      onTap: () => bus.emit('nav:route', { route: 'settings' }),
    }),
  );

  inner.append(hero, statSec, loadSec, trophySec, friendSec, footer);

  // ── painting ───────────────────────────────────────────────────────

  function paintHero(): void {
    clear(avatarWrap);
    const avatarId = equippedId('avatar') ?? 'avatar-first-light';
    const frame = equippedItem('frame');
    const art = createAvatarElement({ id: avatarId, size: 96, alt: 'Your avatar', class: 'pf__av' });
    avatarWrap.appendChild(art);
    if (frame) {
      const ring = previewNode(frame, { size: 118, avatarId });
      ring.classList.add('pf__avframe');
      // The frame preview draws its own avatar; hide it so the animated one shows.
      const innerAv = ring.querySelector('.ec-frame__av');
      if (innerAv) (innerAv as HTMLElement).style.opacity = '0';
      avatarWrap.appendChild(ring);
    }
    const editBtn = h(
      'button',
      { class: 'pf__avedit', type: 'button', 'aria-label': 'Change avatar' },
      icon('sparkle', { size: 14, solid: true }),
    );
    pressFeedback(editBtn);
    editBtn.addEventListener('click', () => {
      haptic('tick');
      openSlotSheet('avatar', repaint);
    });
    avatarWrap.appendChild(editBtn);

    clear(titleEl);
    const title = equippedItem('title');
    if (title) {
      titleEl.appendChild(previewNode(title, { size: 96, playerName }));
      const nameNode = titleEl.querySelector('.ec-title__name');
      if (nameNode) nameNode.remove();
    }

    clear(premiumChip);
    if (isPremium()) {
      premiumChip.appendChild(
        Pill({
          text: `Premium · ${premiumDaysLeft()}d`,
          tone: 'gold',
          size: 'xs',
          caps: true,
          glow: true,
          icon: icon('crown', { size: 11, solid: true }),
        }),
      );
    } else {
      const cta = h('button', { class: 'pf__premcta', type: 'button' }, icon('sparkle', { size: 12, solid: true }), h('span', null, 'Get Premium'));
      pressFeedback(cta);
      cta.addEventListener('click', () => bus.emit('nav:route', { route: 'pass' }));
      premiumChip.appendChild(cta);
    }

    const pass = passState();
    const pos = positionFor(econ().passXp);
    // Account level rises with pass xp — one visible number, not two.
    const level = Math.max(1, Math.floor(econ().passXp / 900) + pass.tier);
    levelNum.textContent = String(level);
    levelRing.set(pos.pct);
  }

  function paintStats(): void {
    clear(statGrid);
    const t = totalsFor();
    const line = statsFor();
    const tiles: Array<[string, string, string]> = [
      ['Hands', fmtInt(t.hands), 'lifetime'],
      ['Net', cash(t.net), t.net >= 0 ? 'up' : 'down'],
      ['Win rate', `${line.winrateBb100.toFixed(1)}`, 'bb/100'],
      ['Sessions', fmtInt(t.sessions), `${t.hoursPlayed.toFixed(0)}h played`],
    ];
    for (const [label, value, sub] of tiles) {
      statGrid.appendChild(
        h(
          'div',
          { class: cx('pf__stat', sub === 'up' && 'is-up', sub === 'down' && 'is-down') },
          h('span', { class: 'pf__statl caps' }, label),
          h('span', { class: 'pf__statv tnum' }, value),
          h('span', { class: 'pf__stats2' }, sub === 'up' ? 'all time' : sub === 'down' ? 'all time' : sub),
        ),
      );
    }
  }

  function paintLoadout(): void {
    clear(loadout);
    for (const kind of KIND_ORDER) {
      const item = equippedItem(kind);
      const meta = KIND_META[kind];
      const slot = h(
        'button',
        { class: 'pf__slot', type: 'button', dataset: { rarity: item?.rarity ?? 'common' }, 'aria-label': `${meta.label}: ${item?.name ?? 'none'}` },
        h('span', { class: 'pf__slotedge', 'aria-hidden': 'true' }),
        h(
          'span',
          { class: 'pf__slotart' },
          item
            ? previewNode(item, {
                size: kind === 'table-skin' || kind === 'felt' ? 54 : 62,
                avatarId: equippedId('avatar') ?? 'avatar-first-light',
                playerName,
              })
            : icon('plus', { size: 20, stroke: 2.2 }),
        ),
        h('span', { class: 'pf__slotk caps' }, meta.label),
        h('span', { class: 'pf__slotn' }, item?.name ?? 'Empty'),
      );
      pressFeedback(slot);
      slot.addEventListener('click', () => {
        haptic('tick');
        openSlotSheet(kind, repaint);
      });
      loadout.appendChild(slot);
    }
  }

  function paintTrophies(): void {
    clear(trophyGrid);
    const list = trophies();
    let earned = 0;
    for (const t of list) {
      const p = t.progress();
      const done = p >= 1;
      if (done) earned += 1;
      const card = h(
        'button',
        { class: cx('pf__trophy', done && 'is-earned'), type: 'button', 'aria-label': `${t.name}: ${t.detail}` },
        h('span', { class: 'pf__trophyedge', 'aria-hidden': 'true' }),
        h('span', { class: 'pf__trophyic' }, icon(t.glyph, { size: 22, solid: done })),
        h('span', { class: 'pf__trophyn' }, t.name),
        done
          ? h('span', { class: 'pf__trophys caps' }, 'Earned')
          : h('span', { class: 'pf__trophybar' }, h('i', { style: { transform: `scaleX(${p.toFixed(3)})` } })),
      );
      pressFeedback(card);
      card.addEventListener('click', () => {
        bus.emit('ui:toast', { text: `${t.name} — ${t.detail}`, tone: done ? 'good' : 'info', ms: 2600 });
      });
      trophyGrid.appendChild(card);
    }
    trophyCount.textContent = `${earned} / ${list.length}`;
  }

  function paintFriends(): void {
    clear(friendList);
    const roster = friendRoster(7, 0x51a2);
    const caption = friendSec.querySelector('.pf__seccap') as HTMLElement;
    const online = roster.filter((_, i) => i % 3 !== 2);
    caption.textContent = `${online.length} online`;
    if (!roster.length) {
      friendList.appendChild(
        EmptyState({ art: 'feed', title: 'No friends yet', body: 'Play a few tables — people you sit with show up here.', compact: true }),
      );
      return;
    }
    roster.forEach((p, i) => {
      const isOnline = i % 3 !== 2;
      const level = levelFor(p.id);
      const row = h(
        'button',
        { class: cx('pf__friend', isOnline && 'is-online'), type: 'button', 'aria-label': `${p.handle}, level ${level}` },
        h('span', { class: 'pf__friendav' },
          h('img', { attrs: { src: getAvatarDataUrl(p.avatarId, 44), alt: '', decoding: 'async' } }),
          isOnline ? h('i', { class: 'pf__dot', 'aria-hidden': 'true' }) : null,
        ),
        h(
          'span',
          { class: 'pf__friendtext' },
          h('span', { class: 'pf__friendn' }, p.handle),
          h('span', { class: 'pf__friends2' }, isOnline ? `Playing ${i % 2 ? "$0.50/$1 Hold'em" : '$0.25/$0.50 PLO'}` : `${personaById(p.id).countryCode} · last seen ${i}h ago`),
        ),
        h('span', { class: 'pf__friendl tnum' }, String(level)),
      );
      pressFeedback(row);
      row.addEventListener('click', () => {
        bus.emit('ui:toast', { text: isOnline ? `Watching ${p.handle}` : `${p.handle} is offline`, tone: 'info', ms: 2000 });
      });
      friendList.appendChild(row);
    });
  }

  function repaint(): void {
    paintHero();
    paintStats();
    paintLoadout();
    paintTrophies();
  }

  repaint();
  paintFriends();
  requestAnimationFrame(() => inner.classList.add('is-in'));

  cleanups.push(onWallet(() => repaint()));

  // Tapping the nameplate opens the equipped avatar's detail sheet.
  nameEl.addEventListener('click', () => {
    const id = equippedId('avatar');
    const item = id ? itemById(id) : undefined;
    if (item) openItemSheet(item, { onChange: repaint });
  });

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      aura.style.transform = `translate3d(0,${(root.scrollTop * -0.2).toFixed(1)}px,0)`;
    });
  };
  root.addEventListener('scroll', onScroll, { passive: true });
  cleanups.push(() => root.removeEventListener('scroll', onScroll));

  return {
    unmount() {
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch (err) {
          console.error('[profile] cleanup failed', err);
        }
      }
      clear(root);
      root.remove();
    },
  };
}
