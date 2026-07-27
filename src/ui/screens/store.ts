/**
 * ROYALE — screens/store.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Read top to bottom the store answers: what is new today, what can I afford,
 * what is in this category, how much of it do I own, and how do I get more
 * gems — in that order, because that is the order a player asks.
 *
 *   hero            one featured item, rendered live and animated
 *   spotlight       six hand-picked pieces, rarity-mixed
 *   pass promo      the honest version — states the gem value it returns
 *   categories      eight tabs, each with its own collection meter
 *   grid            live-rendered tiles; table skins take a double-wide cell
 *   gem shelf       five bundles, gems-per-dollar printed on every card
 *
 * Everything is one scroller with a single scroll listener that parallaxes the
 * ambient wash. Tiles are rebuilt only when the category changes; a purchase
 * refreshes them in place.
 */
import '../styles/store.css';
import { bus } from '../../core/bus.ts';
import type { CosmeticItem, CosmeticKind } from '../../core/types.ts';
import { h, clear } from '../dom.ts';
import { Tabs } from '../components/tabs.ts';
import type { TabsEl } from '../components/tabs.ts';
import { Button } from '../components/button.ts';
import { RarityTag } from '../components/pill.ts';
import { icon } from '../components/icons.ts';
import { EmptyState } from '../components/empty.ts';
import { fmtInt, haptic, pressFeedback, reduceMotion } from '../components/util.ts';
import {
  CATALOG, KIND_META, KIND_ORDER, RARITY_META, featuredToday, spotlightToday,
} from '../../data/catalog.ts';
import { collectionProgress, equippedId, gems, isPremium, onWallet, owns } from '../../econ/wallet.ts';
import { countdown, passState, trackContents } from '../../econ/pass.ts';
import { previewNode } from '../econ/preview.ts';
import { ItemTile } from '../econ/tile.ts';
import type { ItemTileEl } from '../econ/tile.ts';
import { GemBalance, openItemSheet } from '../econ/detail.ts';
import { GemShelf } from '../econ/bundles.ts';

const TAB_KEY = 'royale.store-tab';
const RARITY_RANK: Record<string, number> = { mythic: 0, legendary: 1, epic: 2, rare: 3, common: 4 };

function readTab(): CosmeticKind {
  try {
    const v = localStorage.getItem(TAB_KEY) as CosmeticKind | null;
    if (v && KIND_ORDER.includes(v)) return v;
  } catch {
    /* default below */
  }
  return 'avatar';
}

function midnight(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export interface StoreInstance {
  unmount(): void;
}

export function mount(container: HTMLElement): StoreInstance {
  const root = h('div', { class: 'st scroll' });
  const aura = h('div', { class: 'st__aura', 'aria-hidden': 'true' });
  const inner = h('div', { class: 'st__inner' });
  root.append(aura, inner);
  container.appendChild(root);

  const cleanups: Array<() => void> = [];
  let kind: CosmeticKind = readTab();
  const tiles: ItemTileEl[] = [];

  const go = (route: 'pass' | 'profile') => bus.emit('nav:route', { route });
  const myAvatar = () => equippedId('avatar') ?? 'avatar-first-light';

  const openItem = (item: CosmeticItem) => {
    openItemSheet(item, {
      avatarId: myAvatar(),
      playerName: 'You',
      onChange: () => refreshAll(),
      onNeedGems: () => {
        shelfSec.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
        bus.emit('ui:toast', { text: 'Top up below — gems are simulated in this build', tone: 'info', ms: 2600 });
      },
      onNeedPremium: () => go('pass'),
    });
  };

  // ── header ─────────────────────────────────────────────────────────
  const balance = GemBalance({
    onTap: () => shelfSec.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' }),
  });

  const collectionMeter = h('span', { class: 'st__coll tnum' });

  const header = h(
    'header',
    { class: 'st__head st__sec', style: { '--i': '0' } },
    h(
      'div',
      { class: 'st__headtext' },
      h('span', { class: 'st__eyebrow caps' }, 'Royale store'),
      h('h1', { class: 'st__title' }, 'Collection'),
      collectionMeter,
    ),
    balance,
  );

  // ── featured hero ──────────────────────────────────────────────────
  const hero = featuredToday();
  const heroTimer = h('span', { class: 'st__herotime tnum' });

  const heroCta = Button({
    label: owns(hero.id) ? 'View' : 'Get it',
    sub: hero.priceGems !== null && !owns(hero.id) ? `${fmtInt(hero.priceGems)} gems` : undefined,
    variant: 'primary',
    size: 'md',
    icon: owns(hero.id) ? undefined : icon('gem', { size: 17 }),
    onTap: () => openItem(hero),
  });

  const heroCard = h(
    'button',
    {
      class: 'st__hero st__sec',
      type: 'button',
      style: { '--i': '1', '--rar': RARITY_META[hero.rarity].color },
      dataset: { rarity: hero.rarity },
      'aria-label': `Featured: ${hero.name}`,
    },
    h('span', { class: 'st__heroglow', 'aria-hidden': 'true' }),
    h('span', { class: 'st__herobeam', 'aria-hidden': 'true' }),
    h('span', { class: 'st__heroedge', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'st__herostage' },
      previewNode(hero, {
        size: hero.kind === 'table-skin' || hero.kind === 'felt' ? 152 : 168,
        hero: hero.kind === 'table-skin' || hero.kind === 'felt',
        avatarId: myAvatar(),
        animate: true,
      }),
    ),
    h(
      'span',
      { class: 'st__heroinfo' },
      h(
        'span',
        { class: 'st__herotop' },
        h('span', { class: 'st__herotag caps' }, 'Featured today'),
        heroTimer,
      ),
      h('span', { class: 'st__heroname' }, hero.name),
      h('span', { class: 'st__herodesc' }, hero.description),
      h('span', { class: 'st__herofoot' }, RarityTag(hero.rarity, { size: 'xs' }), heroCta),
    ),
  );
  pressFeedback(heroCard);
  heroCard.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('button.r-btn')) return;
    openItem(hero);
  });

  // ── spotlight rail ─────────────────────────────────────────────────
  const spotlight = spotlightToday();
  const spotRail = h(
    'div',
    { class: 'st__spotrail scroll' },
    ...spotlight.map((item, i) => {
      const tile = ItemTile({ item, size: 84, index: i, avatarId: myAvatar(), onTap: openItem });
      tile.classList.add('st__spot');
      tiles.push(tile);
      return tile;
    }),
  );
  const spotSec = h(
    'section',
    { class: 'st__sec', style: { '--i': '2' } },
    h(
      'div',
      { class: 'st__sechead' },
      h('h2', { class: 'st__sectitle' }, 'Picked for tonight'),
      h('span', { class: 'st__seccap' }, 'Rotates at midnight'),
    ),
    spotRail,
  );

  // ── premium pass promo ─────────────────────────────────────────────
  const passSnap = passState();
  const passGot = trackContents('premium');
  const promo = h(
    'button',
    {
      class: 'st__promo st__sec',
      type: 'button',
      style: { '--i': '3' },
      'aria-label': 'Open the Premium Pass',
    },
    h('span', { class: 'st__promoglow', 'aria-hidden': 'true' }),
    h('span', { class: 'st__promoedge', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'st__promomark', 'aria-hidden': 'true' },
      icon('sparkle', { size: 26, solid: true }),
    ),
    h(
      'span',
      { class: 'st__promotext' },
      h('span', { class: 'st__promoeyebrow caps' }, `Season ${passSnap.season.number} · ${passSnap.season.name}`),
      h('span', { class: 'st__promotitle' }, isPremium() ? 'Premium Pass active' : 'Premium Pass'),
      h(
        'span',
        { class: 'st__promosub' },
        isPremium()
          ? `Tier ${passSnap.tier} of 50 · ${passSnap.claimablePremium.length + passSnap.claimableFree.length} rewards waiting`
          : `50 tiers · ${passGot.cosmetics} cosmetics · ${fmtInt(passGot.gems)} gems`,
      ),
    ),
    icon('chevron-right', { size: 18, stroke: 2.2, class: 'st__promochev' }),
  );
  pressFeedback(promo);
  promo.addEventListener('click', () => {
    haptic('select');
    go('pass');
  });

  // ── category tabs + grid ───────────────────────────────────────────
  const tabs: TabsEl = Tabs({
    items: KIND_ORDER.map((k) => ({ id: k, label: KIND_META[k].label })),
    value: kind,
    ariaLabel: 'Store categories',
    onChange: (id) => setKind(id as CosmeticKind),
  });
  tabs.classList.add('st__tabs');

  const blurb = h('p', { class: 'st__blurb' });
  const meterFill = h('i', { class: 'st__meterfill' });
  const meterText = h('span', { class: 'st__metert tnum' });
  const meter = h(
    'div',
    { class: 'st__meter' },
    h('div', { class: 'st__metertrack' }, meterFill),
    meterText,
  );
  const grid = h('div', { class: 'st__grid' });

  const gridSec = h(
    'section',
    { class: 'st__sec st__gridsec', style: { '--i': '4' } },
    h('div', { class: 'st__tabwrap' }, tabs),
    h('div', { class: 'st__gridhead' }, blurb, meter),
    grid,
  );

  // ── gem shelf ──────────────────────────────────────────────────────
  const shelfSec = h(
    'section',
    { class: 'st__sec st__shelfsec', style: { '--i': '5' } },
    h(
      'div',
      { class: 'st__sechead' },
      h('h2', { class: 'st__sectitle' }, 'Gems'),
      h('span', { class: 'st__seccap' }, 'Demo — nothing is charged'),
    ),
    GemShelf({ onPurchase: () => refreshAll() }),
  );

  const footer = h(
    'footer',
    { class: 'st__foot st__sec', style: { '--i': '6' } },
    h(
      'p',
      { class: 'st__legal' },
      'Cosmetics change how the game looks, never how it plays. Every item is drawn at runtime — nothing here is downloaded.',
    ),
  );

  inner.append(header, heroCard, spotSec, promo, gridSec, shelfSec, footer);
  requestAnimationFrame(() => inner.classList.add('is-in'));

  // ── behaviour ──────────────────────────────────────────────────────

  function buildGrid(): void {
    clear(grid);
    for (let i = tiles.length - 1; i >= 0; i--) {
      if (!tiles[i].isConnected) tiles.splice(i, 1);
    }
    const items = CATALOG.filter((i) => i.kind === kind).sort((a, b) => {
      const r = RARITY_RANK[a.rarity] - RARITY_RANK[b.rarity];
      if (r !== 0) return r;
      return (b.priceGems ?? 9999) - (a.priceGems ?? 9999);
    });
    if (!items.length) {
      grid.appendChild(
        EmptyState({ art: 'store', title: 'Nothing here yet', body: 'This category opens later in the season.' }),
      );
      return;
    }
    const wide = kind === 'table-skin' || kind === 'felt';
    grid.classList.toggle('is-wide', wide);
    items.forEach((item, i) => {
      const tile = ItemTile({
        item,
        size: wide ? 108 : 92,
        index: i,
        avatarId: myAvatar(),
        onTap: openItem,
      });
      tiles.push(tile);
      grid.appendChild(tile);
    });
    const meta = KIND_META[kind];
    blurb.textContent = meta.blurb;
    paintMeter();
  }

  function paintMeter(): void {
    const { owned, total } = collectionProgress(kind);
    const pct = total > 0 ? owned / total : 0;
    meterFill.style.transform = `scaleX(${pct.toFixed(4)})`;
    meterText.textContent = `${owned}/${total}`;
    const all = collectionProgress();
    collectionMeter.textContent = `${all.owned} of ${all.total} items owned`;
  }

  function setKind(next: CosmeticKind): void {
    if (next === kind) return;
    kind = next;
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* not persisted in private mode */
    }
    grid.classList.remove('is-in');
    buildGrid();
    requestAnimationFrame(() => grid.classList.add('is-in'));
  }

  function refreshAll(): void {
    for (const t of tiles) t.refresh();
    balance.setValue(gems());
    paintMeter();
    const ownedHero = owns(hero.id);
    heroCta.setLabel(ownedHero ? 'View' : 'Get it');
    heroCta.setSub(ownedHero || hero.priceGems === null ? '' : `${fmtInt(hero.priceGems)} gems`);
    heroCard.classList.toggle('is-owned', ownedHero);
  }

  buildGrid();
  requestAnimationFrame(() => grid.classList.add('is-in'));
  refreshAll();

  cleanups.push(onWallet(() => refreshAll()));

  // Hero rotation countdown, updated once a minute — no rAF needed.
  const paintTimer = () => {
    heroTimer.textContent = `New in ${countdown(midnight()).label}`;
  };
  paintTimer();
  const timerId = window.setInterval(paintTimer, 30_000);
  cleanups.push(() => clearInterval(timerId));

  // Parallax the wash against the scroll — transform only.
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
          console.error('[store] cleanup failed', err);
        }
      }
      clear(root);
      root.remove();
    },
  };
}
