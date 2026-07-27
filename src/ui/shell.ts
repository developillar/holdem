/**
 * ROYALE — shell.ts
 * ────────────────────────────────────────────────────────────────────────────
 * `mountShell(root)` builds the persistent chrome once and hands the middle of
 * the screen to the router. Everything above it (top bar), below it (tab bar)
 * and over it (sheets, modals, toasts) lives here and never re-mounts, so a
 * route change only ever swaps the content layer.
 *
 * Layout contract for screen authors
 * ──────────────────────────────────
 *   • Your `mount(container)` receives a `<section class="rt-screen">` that is
 *     absolutely positioned over the full app area. Own your own scrolling by
 *     putting `class="scroll"` on the scrolling element (this also opts you
 *     out of the global touchmove lock in main.ts).
 *   • Two variables are set on the shell for you and update live as the chrome
 *     shows/hides:
 *         --chrome-t   safe-area top + top bar height   (0 at the table)
 *         --chrome-b   safe-area bottom + tab bar height
 *     Pad with them: `padding: var(--chrome-t) 0 var(--chrome-b);`
 *   • Immersive routes (`table`) get `pointer-events: none` on the section so
 *     the 3D stage below stays draggable — put `pointer-events: auto` on your
 *     own panels (`.rt-screen[data-immersive] > *` already does this).
 *   • `document.documentElement.dataset.route` mirrors the active route.
 *
 * Screens are registered with `import.meta.glob`, so a screen module that does
 * not exist yet simply falls back to a finished-looking placeholder panel
 * instead of breaking the build or the boot.
 */
import './styles/components.css';
import './styles/nav.css';
import { bus } from '../core/bus.ts';
import type { RouteName } from '../core/bus.ts';
import { h } from './dom.ts';
import { Router } from './router.ts';
import type { RouteDef, ScreenLoader, ScreenModule } from './router.ts';
import { TabBar, TopBar } from './nav.ts';
import type { TabBarEl, TopBarEl } from './nav.ts';
import { mountToastHost } from './components/toast.ts';
import { setSheetHost } from './components/sheet.ts';
import { setModalHost, openNamedModal, closeTopModal } from './components/modal.ts';

/**
 * Vite resolves this at build time against the files that actually exist.
 * Screens are owned by other modules and are loaded lazily, one chunk each.
 */
const SCREEN_MODULES = import.meta.glob('./screens/*.ts');

function loaderFor(name: RouteName): ScreenLoader {
  const key = `./screens/${name}.ts`;
  return async () => {
    const load = SCREEN_MODULES[key];
    if (!load) throw new Error(`no screen module at ${key}`);
    return (await load()) as ScreenModule;
  };
}

type ShellRouteDef = Omit<RouteDef, 'loader'>;

const ROUTES: ShellRouteDef[] = [
  { name: 'lobby', level: 'tab', title: 'Play' },
  { name: 'feed', level: 'tab', title: 'Feed' },
  { name: 'store', level: 'tab', title: 'Store' },
  { name: 'trainer', level: 'tab', title: 'Trainer' },
  { name: 'profile', level: 'tab', title: 'Me' },
  { name: 'table', level: 'immersive', title: 'Table', topbar: false, tabbar: false },
  { name: 'pass', level: 'stack', title: 'Season Pass' },
  { name: 'stats', level: 'stack', title: 'Statistics' },
  { name: 'settings', level: 'stack', title: 'Settings' },
];

export interface Shell {
  router: Router;
  tabs: TabBarEl;
  top: TopBarEl;
  destroy(): void;
}

let instance: Shell | null = null;

/** The live shell, once `mountShell` has resolved. */
export function getShell(): Shell | null {
  return instance;
}

export async function mountShell(root: HTMLElement): Promise<void> {
  if (instance) return;

  const stackHost = h('main', { class: 'shell__stack', id: 'route-host' });
  const toastHost = h('div', { class: 'shell__toasts', 'aria-live': 'polite' });
  const sheetHost = h('div', { class: 'shell__sheets' });
  const modalHost = h('div', { class: 'shell__modals' });

  const router = new Router(stackHost);

  const tabs = TabBar({
    active: 'lobby',
    onSelect: (route) => void router.go(route),
    onPrefetch: (route) => router.prefetch(route),
  });

  const top = TopBar({
    onStore: () => void router.go('store'),
    onBack: () => {
      if (!router.back()) void router.go('lobby');
    },
  });

  const shellEl = h('div', { class: 'shell' }, stackHost, top, tabs, sheetHost, modalHost, toastHost);
  root.appendChild(shellEl);

  setSheetHost(sheetHost);
  setModalHost(modalHost);
  const offToast = mountToastHost(toastHost);

  for (const def of ROUTES) router.register({ ...def, loader: loaderFor(def.name) });

  // ── chrome reacts to the route ─────────────────────────────────────
  const unseen = { feed: 0, store: 0 };

  const offRoute = router.onChange(({ entry, depth }) => {
    const def = entry.def;
    const showTop = def.topbar ?? def.level !== 'immersive';
    const showTabs = def.tabbar ?? def.level !== 'immersive';
    top.setVisible(showTop);
    tabs.setVisible(showTabs);
    tabs.setActive(entry.name);
    top.setBack(depth > 1);
    shellEl.classList.toggle('no-top', !showTop);
    shellEl.classList.toggle('no-tabs', !showTabs);
    shellEl.dataset.route = entry.name;
    shellEl.dataset.level = def.level;
    document.documentElement.dataset.route = entry.name;

    if (entry.name === 'feed') {
      unseen.feed = 0;
      tabs.setBadge('feed', 0);
    }
    if (entry.name === 'store' || entry.name === 'pass') {
      unseen.store = 0;
      tabs.setBadge('store', 0);
    }
  });

  // ── bus wiring ─────────────────────────────────────────────────────
  const offNav = bus.on('nav:route', ({ route, params }) => {
    if (route === 'boot') return;
    void router.go(route, { params });
  });

  const offModal = bus.on('ui:modal', ({ id, props }) => {
    if (id) openNamedModal(id, props);
    else closeTopModal();
  });

  const offFeed = bus.on('feed:post', () => {
    if (router.current()?.name === 'feed') return;
    unseen.feed += 1;
    tabs.setBadge('feed', unseen.feed);
  });

  const offPass = bus.on('econ:pass-xp', ({ leveled }) => {
    if (!leveled) return;
    const here = router.current()?.name;
    if (here === 'store' || here === 'pass') return;
    unseen.store += 1;
    tabs.setBadge('store', true);
  });

  // ── QA / debug surface ─────────────────────────────────────────────
  const royale = {
    nav(route: string, params?: Record<string, string>) {
      if (!router.has(route)) {
        console.warn(`[royale] unknown route "${route}"`);
        return;
      }
      void router.go(route, { params });
    },
    back: () => router.back(),
    route: () => router.current()?.name ?? null,
    depth: () => router.depth(),
    toast(text: string, tone: 'info' | 'good' | 'bad' | 'epic' = 'info', ms?: number) {
      bus.emit('ui:toast', { text, tone, ms });
    },
    router,
    ready: true,
  };
  (window as unknown as { __royale?: typeof royale }).__royale = royale;

  // ── first paint ────────────────────────────────────────────────────
  const hash = location.hash.replace(/^#/, '');
  const initial: RouteName = router.has(hash) ? hash : 'lobby';
  await router.go(initial, { transition: 'none' });

  instance = {
    router,
    tabs,
    top,
    destroy() {
      offToast();
      offRoute();
      offNav();
      offModal();
      offFeed();
      offPass();
      router.destroy();
      shellEl.remove();
      delete (window as unknown as { __royale?: unknown }).__royale;
      instance = null;
    },
  };
}
