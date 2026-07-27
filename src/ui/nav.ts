/**
 * ROYALE — nav.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The two pieces of persistent chrome: the bottom tab bar and the top wallet
 * bar. Both are built here so their materials stay in lockstep — the same
 * frosted glass, the same top/bottom hairline, the same safe-area maths.
 *
 * TAB BAR
 *   const tabs = TabBar({ onSelect: (route) => router.go(route) });
 *   tabs.setActive('store');
 *   tabs.setBadge('feed', 3);      // count
 *   tabs.setBadge('store', true);  // unread dot
 *   tabs.setVisible(false);        // hidden at the table
 *
 * Every icon is drawn here as inline SVG on a 28px grid and morphs on
 * selection — the cards fan wider, the target's rings pop out in sequence,
 * the bag's handle springs, the avatar's head lifts. A gold beam and a warm
 * halo ride a spring between tabs, so a fast double-switch curves rather than
 * teleports.
 *
 * TOP BAR
 *   const top = TopBar({ onStore: () => router.go('store'), onBack: () => router.back() });
 *   top.setBack(true);             // shows the back chevron when drilled in
 *   top.setVisible(false);
 *
 * Balances listen to `econ:wallet` on the bus and roll with a CountUp. Until
 * the economy module publishes its first snapshot the pills show a shimmer,
 * then fall back to the last value persisted in localStorage.
 */
import './styles/nav.css';
import { h, cx } from './dom.ts';
import { bus } from '../core/bus.ts';
import type { RouteName } from '../core/bus.ts';
import { Badge } from './components/badge.ts';
import type { BadgeEl } from './components/badge.ts';
import { CountUp } from './components/countup.ts';
import { icon } from './components/icons.ts';
import { haptic, pressFeedback, spring, fmtInt } from './components/util.ts';

export type TabId = 'lobby' | 'feed' | 'store' | 'trainer' | 'profile';

interface TabDef {
  id: TabId;
  route: RouteName;
  label: string;
  glyph: () => SVGSVGElement;
}

// ── glyphs ───────────────────────────────────────────────────────────
// 28×28 grid. Each returns <svg> with a `.nv-ic__fill` silhouette that inks
// in behind the outline on selection, plus named parts the stylesheet moves.

function svgBox(...kids: SVGElement[]): SVGSVGElement {
  return h(
    'svg',
    {
      class: 'nv-ic',
      attrs: {
        viewBox: '0 0 28 28', width: 26, height: 26, fill: 'none',
        stroke: 'currentColor', 'stroke-width': 1.9,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': 'true', focusable: 'false',
      },
    },
    ...kids,
  );
}

const SPADE_28 = 'M14 8.4c2.2 2.4 4.8 3.9 4.8 6.3a2.6 2.6 0 01-4.3 1.9c.14 1.4.56 2.4 1.2 2.95h-3.4c.64-.56 1.06-1.55 1.2-2.95a2.6 2.6 0 01-4.3-1.9c0-2.4 2.6-3.9 4.8-6.3z';

function glyphPlay(): SVGSVGElement {
  return svgBox(
    h('g', { attrs: { transform: 'rotate(-14 10 22)' } },
      h('rect', { class: 'nv-card nv-card--b', attrs: { x: 4.6, y: 7.2, width: 10.6, height: 15, rx: 2.6, fill: 'none' } }),
    ),
    h('g', { attrs: { transform: 'rotate(10 18 21)' } },
      h('rect', { class: 'nv-card nv-card--f nv-ic__fill', attrs: { x: 12.6, y: 5.6, width: 10.8, height: 15.4, rx: 2.7 } }),
      h('rect', { class: 'nv-card nv-card--f', attrs: { x: 12.6, y: 5.6, width: 10.8, height: 15.4, rx: 2.7, fill: 'none' } }),
      h('path', { class: 'nv-pip', attrs: { d: SPADE_28, transform: 'translate(4 -0.6) scale(0.92)', fill: 'currentColor', stroke: 'none' } }),
    ),
  );
}

function glyphFeed(): SVGSVGElement {
  return svgBox(
    h('rect', { class: 'nv-ic__fill', attrs: { x: 3.4, y: 5.2, width: 21.2, height: 18.4, rx: 4.6 } }),
    h('rect', { attrs: { x: 3.4, y: 5.2, width: 21.2, height: 18.4, rx: 4.6, fill: 'none' } }),
    h('circle', { class: 'nv-dot', attrs: { cx: 9.4, cy: 11.4, r: 2.5 } }),
    h('path', { class: 'nv-line nv-line--1', attrs: { d: 'M14.3 11.4h6.3' } }),
    h('path', { class: 'nv-line nv-line--2', attrs: { d: 'M7.2 17.4h13.4' } }),
    h('path', { class: 'nv-line nv-line--3', attrs: { d: 'M7.2 20.6h7.8' } }),
  );
}

function glyphStore(): SVGSVGElement {
  return svgBox(
    h('path', { class: 'nv-ic__fill', attrs: { d: 'M6.6 9.2h14.8l1.25 12.6a1.9 1.9 0 01-1.9 2.1H7.25a1.9 1.9 0 01-1.9-2.1L6.6 9.2z' } }),
    h('path', { attrs: { d: 'M6.6 9.2h14.8l1.25 12.6a1.9 1.9 0 01-1.9 2.1H7.25a1.9 1.9 0 01-1.9-2.1L6.6 9.2z', fill: 'none' } }),
    h('path', { class: 'nv-handle', attrs: { d: 'M10.3 11.6V7.8a3.7 3.7 0 017.4 0v3.8', fill: 'none' } }),
  );
}

function glyphTrainer(): SVGSVGElement {
  return svgBox(
    h('circle', { class: 'nv-ic__fill', attrs: { cx: 14, cy: 14, r: 10.4 } }),
    h('circle', { class: 'nv-ring nv-ring--1', attrs: { cx: 14, cy: 14, r: 10.4, fill: 'none' } }),
    h('circle', { class: 'nv-ring nv-ring--2', attrs: { cx: 14, cy: 14, r: 5.8, fill: 'none' } }),
    h('circle', { class: 'nv-bull', attrs: { cx: 14, cy: 14, r: 1.9, fill: 'currentColor', stroke: 'none' } }),
  );
}

function glyphMe(): SVGSVGElement {
  return svgBox(
    h('path', { class: 'nv-ic__fill', attrs: { d: 'M14 4.6a4.9 4.9 0 110 9.8 4.9 4.9 0 010-9.8zM5.4 24a8.6 8.6 0 0117.2 0z' } }),
    h('circle', { class: 'nv-head', attrs: { cx: 14, cy: 9.5, r: 4.9, fill: 'none' } }),
    h('path', { class: 'nv-body', attrs: { d: 'M5.4 24a8.6 8.6 0 0117.2 0', fill: 'none' } }),
  );
}

const TABS: TabDef[] = [
  { id: 'lobby', route: 'lobby', label: 'Play', glyph: glyphPlay },
  { id: 'feed', route: 'feed', label: 'Feed', glyph: glyphFeed },
  { id: 'store', route: 'store', label: 'Store', glyph: glyphStore },
  { id: 'trainer', route: 'trainer', label: 'Trainer', glyph: glyphTrainer },
  { id: 'profile', route: 'profile', label: 'Me', glyph: glyphMe },
];

// ── tab bar ──────────────────────────────────────────────────────────

export interface TabBarOpts {
  onSelect(route: RouteName, id: TabId): void;
  /** fired on press-down so the router can warm the chunk before the tap lands */
  onPrefetch?(route: RouteName): void;
  active?: TabId;
}

export interface TabBarEl extends HTMLElement {
  setActive(route: RouteName): void;
  setBadge(id: TabId, value: number | boolean): void;
  setVisible(on: boolean): void;
  /** the tab id currently lit, or null when the route is not a tab */
  activeId(): TabId | null;
}

export function TabBar(opts: TabBarOpts): TabBarEl {
  const beam = h('span', { class: 'nav__beam', 'aria-hidden': 'true' }, h('i'));
  const halo = h('span', { class: 'nav__halo', 'aria-hidden': 'true' });
  const el = h('nav', {
    class: 'nav',
    role: 'tablist',
    'aria-label': 'Main',
    style: { '--nav-n': String(TABS.length) },
  }) as TabBarEl;

  el.appendChild(h('span', { class: 'nav__mat', 'aria-hidden': 'true' }));
  el.appendChild(halo);
  el.appendChild(beam);

  const buttons = new Map<TabId, HTMLButtonElement>();
  const badges = new Map<TabId, BadgeEl>();
  let active: TabId | null = null;

  const move = spring(0, (v) => {
    const t = `translate3d(${(v * 100).toFixed(3)}%,0,0)`;
    beam.style.transform = t;
    halo.style.transform = t;
  }, { stiffness: 260, damping: 24 });

  TABS.forEach((tab, i) => {
    const badge = Badge({ tone: tab.id === 'store' ? 'gold' : 'bad', class: 'nav__badge' });
    badge.set(0);
    badges.set(tab.id, badge);

    const b = h(
      'button',
      {
        class: 'nav__tab',
        type: 'button',
        role: 'tab',
        'aria-selected': 'false',
        'aria-label': tab.label,
        dataset: { tab: tab.id },
      },
      h('span', { class: 'nav__icwrap' }, tab.glyph(), badge),
      h('span', { class: 'nav__label' }, tab.label),
    );
    pressFeedback(b);
    b.addEventListener('pointerdown', () => opts.onPrefetch?.(tab.route), { passive: true });
    b.addEventListener('click', () => {
      haptic(tab.id === active ? 'tick' : 'select');
      opts.onSelect(tab.route, tab.id);
    });
    buttons.set(tab.id, b);
    el.appendChild(b);
    if (opts.active === tab.id) move.jump(i);
  });

  const routeToTab = (route: RouteName): TabId | null => {
    const found = TABS.find((t) => t.route === route);
    return found ? found.id : null;
  };

  el.setActive = (route) => {
    const id = routeToTab(route);
    if (id === active) return;
    active = id;
    let index = -1;
    TABS.forEach((t, i) => {
      const on = t.id === id;
      const b = buttons.get(t.id)!;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) index = i;
    });
    el.classList.toggle('has-active', index >= 0);
    if (index >= 0) move.set(index);
  };

  el.setBadge = (id, value) => {
    badges.get(id)?.set(value);
    buttons.get(id)?.classList.toggle('has-badge', !!value);
  };

  el.setVisible = (on) => {
    el.classList.toggle('is-hidden', !on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
    for (const b of buttons.values()) b.tabIndex = on ? 0 : -1;
  };

  el.activeId = () => active;

  if (opts.active) el.setActive(TABS.find((t) => t.id === opts.active)!.route);
  return el;
}

// ── top bar ──────────────────────────────────────────────────────────

const WALLET_KEY = 'royale.wallet';
/** Used only if neither the bus nor localStorage has published a balance. */
const WALLET_FALLBACK = { chips: 24850, gems: 320 };

export interface TopBarOpts {
  /** tapping a balance pill or the + affordance */
  onStore(): void;
  onBack?(): void;
}

export interface TopBarEl extends HTMLElement {
  setBack(on: boolean, label?: string): void;
  setVisible(on: boolean): void;
  setWallet(chips: number, gems: number): void;
}

function walletPill(
  kind: 'chips' | 'gems',
  label: string,
  glyph: SVGSVGElement,
  onTap: () => void,
): { el: HTMLButtonElement; count: ReturnType<typeof CountUp> } {
  const count = CountUp({ value: 0, format: fmtInt, class: 'wal__n' });
  const el = h(
    'button',
    { class: `wal wal--${kind}`, type: 'button', 'aria-label': label },
    h('span', { class: 'wal__ic' }, glyph),
    count,
    h('span', { class: 'wal__sheen', 'aria-hidden': 'true' }),
  );
  pressFeedback(el);
  el.addEventListener('click', () => {
    haptic('tick');
    onTap();
  });
  return { el, count };
}

export function TopBar(opts: TopBarOpts): TopBarEl {
  const back = h(
    'button',
    { class: 'topbar__back', type: 'button', 'aria-label': 'Back', tabIndex: -1 },
    icon('chevron-left', { size: 22, stroke: 2.2 }),
  );
  pressFeedback(back);
  back.addEventListener('click', () => {
    haptic('tick');
    opts.onBack?.();
  });

  const chips = walletPill('chips', 'Chip balance — open the cashier', icon('chip', { size: 15 }), opts.onStore);
  const gems = walletPill('gems', 'Gem balance — open the store', icon('gem', { size: 14 }), opts.onStore);

  const add = h(
    'button',
    { class: 'topbar__add', type: 'button', 'aria-label': 'Add chips and gems' },
    h('span', { class: 'topbar__add-glow', 'aria-hidden': 'true' }),
    icon('plus', { size: 18, stroke: 2.6 }),
  );
  pressFeedback(add);
  add.addEventListener('click', () => {
    haptic('select');
    opts.onStore();
  });

  const el = h(
    'header',
    { class: 'topbar', role: 'banner' },
    h('span', { class: 'topbar__mat', 'aria-hidden': 'true' }),
    back,
    h('div', { class: 'topbar__wallet' }, chips.el, gems.el),
    h('div', { class: 'topbar__spacer' }),
    add,
  ) as TopBarEl;

  el.classList.add('is-loading');

  let seeded = false;
  const apply = (c: number, g: number, silent: boolean) => {
    seeded = true;
    el.classList.remove('is-loading');
    chips.count.set(c, { silent });
    gems.count.set(g, { silent });
  };

  el.setWallet = (c, g) => apply(c, g, !seeded);

  bus.on('econ:wallet', ({ chips: c, gems: g }) => {
    apply(c, g, !seeded);
    try {
      localStorage.setItem(WALLET_KEY, JSON.stringify({ chips: c, gems: g }));
    } catch {
      /* private mode — the balance simply is not cached */
    }
  });

  // If the economy module has not published within a beat, show the last
  // known balance rather than an empty bar.
  window.setTimeout(() => {
    if (seeded) return;
    let seed = WALLET_FALLBACK;
    try {
      const raw = localStorage.getItem(WALLET_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { chips?: number; gems?: number };
        if (typeof parsed.chips === 'number' && typeof parsed.gems === 'number') {
          seed = { chips: parsed.chips, gems: parsed.gems };
        }
      }
    } catch {
      /* fall through to the constant */
    }
    apply(seed.chips, seed.gems, true);
  }, 1200);

  el.setBack = (on, label) => {
    el.classList.toggle('has-back', on);
    back.tabIndex = on ? 0 : -1;
    back.setAttribute('aria-label', label ? `Back to ${label}` : 'Back');
  };

  el.setVisible = (on) => {
    el.classList.toggle('is-hidden', !on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
  };

  return el;
}
