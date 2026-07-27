/**
 * ROYALE — router.ts
 * ────────────────────────────────────────────────────────────────────────────
 * A route *stack* with real transitions, not a URL matcher. Routes are the
 * `RouteName` union from core/bus.ts; each one registers a lazy loader so the
 * initial bundle only contains the shell.
 *
 *   router.register({ name: 'lobby', level: 'tab', title: 'Play',
 *                     loader: () => import('./screens/lobby.ts') });
 *   router.go('store');                       // cross-fades (tab → tab)
 *   router.go('stats', { params: { id } });   // slides in from the right
 *   router.back();                            // reverses whatever came in
 *
 * Transition is derived from the target's `level`:
 *   tab        replaces the root of the stack   → cross-fade + scale
 *   stack      pushes                           → slide from the right
 *   sheet      pushes                           → slide up over a scrim
 *   immersive  pushes, hides all chrome         → zoom-through
 *
 * Guarantees
 *   • never animates the very first screen (no 200ms blank frame on boot)
 *   • navigations are token-guarded, so spamming tabs cannot interleave
 *   • a screen whose module fails to load renders a real fallback, never a
 *     white screen
 *   • hardware/browser Back pops the stack; Back at the root is a no-op
 *   • honours prefers-reduced-motion by skipping the animation entirely
 */
import type { RouteName } from '../core/bus.ts';
import { h } from './dom.ts';
import { reduceMotion } from './components/util.ts';

export type RouteLevel = 'tab' | 'stack' | 'sheet' | 'immersive';
export type TransitionKind = 'none' | 'fade' | 'push' | 'sheet' | 'zoom';

export interface ScreenInstance {
  unmount(): void;
}

export interface ScreenModule {
  mount(container: HTMLElement, params?: Record<string, string>): ScreenInstance | void;
}

export type ScreenLoader = () => Promise<ScreenModule>;

export interface RouteDef {
  name: RouteName;
  loader: ScreenLoader;
  level: RouteLevel;
  /** used by the shell for the back-button label and analytics */
  title: string;
  /** chrome visibility; defaults follow `level` */
  topbar?: boolean;
  tabbar?: boolean;
}

export interface RouteEntry {
  name: RouteName;
  def: RouteDef;
  params: Record<string, string>;
  el: HTMLElement;
  instance: ScreenInstance | null;
}

export interface NavOptions {
  params?: Record<string, string>;
  /** replace the top of the stack instead of pushing */
  replace?: boolean;
  /** override the transition the level would pick */
  transition?: TransitionKind;
  /** do not touch browser history (used when reacting to popstate) */
  silent?: boolean;
}

export interface RouteChange {
  entry: RouteEntry;
  depth: number;
  /** true when this change came from a back/pop */
  back: boolean;
}

const DURATION: Record<TransitionKind, number> = {
  none: 0,
  fade: 260,
  push: 360,
  sheet: 380,
  zoom: 420,
};

export class Router {
  readonly host: HTMLElement;
  private routes = new Map<RouteName, RouteDef>();
  private modules = new Map<RouteName, Promise<ScreenModule>>();
  private stack: RouteEntry[] = [];
  private listeners = new Set<(c: RouteChange) => void>();
  private token = 0;
  private busy = false;
  private queued: { name: RouteName; opts: NavOptions } | null = null;
  private veil: HTMLElement | null = null;
  private veilTimer = 0;
  private historyOk = true;

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.classList.add('rt-stack');
    window.addEventListener('popstate', this.onPopState);
  }

  register(def: RouteDef): void {
    this.routes.set(def.name, def);
  }

  has(name: string): name is RouteName {
    return this.routes.has(name as RouteName);
  }

  current(): RouteEntry | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  depth(): number {
    return this.stack.length;
  }

  /** True when `back()` will do something. */
  canBack(): boolean {
    return this.stack.length > 1;
  }

  onChange(fn: (c: RouteChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Warms a route's module without navigating (call on tab press-down). */
  prefetch(name: RouteName): void {
    const def = this.routes.get(name);
    if (!def || this.modules.has(name)) return;
    this.modules.set(name, this.loadModule(def));
  }

  async go(name: RouteName, opts: NavOptions = {}): Promise<void> {
    const def = this.routes.get(name);
    if (!def) {
      console.warn(`[router] unknown route "${name}"`);
      return;
    }
    if (this.busy) {
      this.queued = { name, opts };
      return;
    }
    const currentEntry = this.current();
    if (currentEntry && currentEntry.name === name && !opts.replace) {
      // Re-tapping the active tab scrolls it back to the top, the iOS way.
      const scroller = currentEntry.el.querySelector<HTMLElement>('.scroll');
      scroller?.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
      return;
    }

    const myToken = ++this.token;
    this.busy = true;
    const mod = await this.resolve(def);
    if (myToken !== this.token) {
      this.busy = false;
      this.drainQueue();
      return;
    }

    const first = this.stack.length === 0;
    const transition: TransitionKind =
      opts.transition ?? (first || reduceMotion() ? 'none' : transitionFor(def, currentEntry));

    // Which of the existing entries survive?
    const outgoing: RouteEntry[] = [];
    if (def.level === 'tab') {
      outgoing.push(...this.stack.splice(0, this.stack.length));
    } else if (opts.replace && this.stack.length) {
      outgoing.push(this.stack.pop()!);
    } else if (currentEntry) {
      // pushed on top — keep the previous entry mounted underneath
    }

    const el = h('section', {
      class: 'rt-screen',
      dataset: { route: name, level: def.level },
      'aria-label': def.title,
    });
    if (def.level === 'immersive') el.dataset.immersive = '1';
    const entry: RouteEntry = { name, def, params: opts.params ?? {}, el, instance: null };

    this.host.appendChild(el);
    entry.instance = mountScreen(mod, el, entry.params, def);
    this.stack.push(entry);

    if (!opts.silent) this.writeHistory(name, opts.replace || def.level === 'tab');
    this.emit({ entry, depth: this.stack.length, back: false });

    await this.transition(entry, outgoing, transition, false);
    // Entries kept underneath a push are hidden once the animation lands.
    this.settleUnderlays();
    this.busy = false;
    this.drainQueue();
  }

  /** Pops one level. Returns false when already at the root. */
  back(): boolean {
    if (!this.canBack()) return false;
    if (this.historyOk) history.back();
    else void this.pop();
    return true;
  }

  /** Removes everything and detaches listeners. */
  destroy(): void {
    window.removeEventListener('popstate', this.onPopState);
    for (const e of this.stack) safeUnmount(e);
    this.stack = [];
    this.listeners.clear();
  }

  // ── internals ───────────────────────────────────────────────────────

  private drainQueue(): void {
    const q = this.queued;
    this.queued = null;
    if (q) void this.go(q.name, q.opts);
  }

  private onPopState = (ev: PopStateEvent): void => {
    const state = ev.state as { r?: RouteName; d?: number } | null;
    const wantDepth = state?.d ?? 1;
    if (wantDepth < this.stack.length && this.stack.length > 1) {
      void this.pop();
      return;
    }
    if (state?.r && this.routes.has(state.r) && state.r !== this.current()?.name) {
      void this.go(state.r, { silent: true });
    }
  };

  private async pop(): Promise<void> {
    if (this.stack.length < 2 || this.busy) return;
    this.busy = true;
    const leaving = this.stack.pop()!;
    const entry = this.stack[this.stack.length - 1];
    entry.el.removeAttribute('aria-hidden');
    entry.el.classList.remove('is-under');
    const transition: TransitionKind = reduceMotion()
      ? 'none'
      : transitionFor(leaving.def, entry);
    this.emit({ entry, depth: this.stack.length, back: true });
    await this.transition(entry, [leaving], transition, true);
    this.settleUnderlays();
    this.busy = false;
    this.drainQueue();
  }

  private writeHistory(name: RouteName, replace: boolean): void {
    const state = { r: name, d: this.stack.length };
    const url = `#${name}`;
    try {
      const firstEver = !history.state;
      const sameRoute = !!history.state && (history.state as { r?: string }).r === name;
      if (firstEver || (replace && sameRoute)) history.replaceState(state, '', url);
      else history.pushState(state, '', url);
      this.historyOk = true;
    } catch {
      // Some embedded webviews forbid history writes. Navigation still works;
      // Back is served straight from our own stack instead.
      this.historyOk = false;
    }
  }

  private emit(change: RouteChange): void {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(change);
      } catch (err) {
        console.error('[router] listener failed', err);
      }
    }
  }

  private settleUnderlays(): void {
    for (let i = 0; i < this.stack.length - 1; i++) {
      const e = this.stack[i];
      e.el.classList.add('is-under');
      e.el.setAttribute('aria-hidden', 'true');
    }
    const top = this.current();
    if (top) {
      top.el.classList.remove('is-under');
      top.el.removeAttribute('aria-hidden');
    }
  }

  private transition(
    incoming: RouteEntry,
    outgoing: RouteEntry[],
    kind: TransitionKind,
    back: boolean,
  ): Promise<void> {
    const dir = back ? 'back' : 'fwd';
    if (kind === 'none') {
      for (const o of outgoing) this.retire(o);
      return Promise.resolve();
    }
    incoming.el.classList.add('rt-anim', `rt-in--${kind}`, `rt-${dir}`);
    for (const o of outgoing) o.el.classList.add('rt-anim', `rt-out--${kind}`, `rt-${dir}`);
    return new Promise<void>((resolve) => {
      window.setTimeout(() => {
        incoming.el.classList.remove('rt-anim', `rt-in--${kind}`, `rt-${dir}`);
        for (const o of outgoing) this.retire(o);
        resolve();
      }, DURATION[kind]);
    });
  }

  private retire(entry: RouteEntry): void {
    safeUnmount(entry);
    entry.el.remove();
  }

  private resolve(def: RouteDef): Promise<ScreenModule> {
    let p = this.modules.get(def.name);
    if (!p) {
      p = this.loadModule(def);
      this.modules.set(def.name, p);
    }
    // Only show the veil if the chunk is genuinely slow; otherwise it flickers.
    this.veilTimer = window.setTimeout(() => this.showVeil(), 160);
    return p.finally(() => {
      clearTimeout(this.veilTimer);
      this.hideVeil();
    });
  }

  private loadModule(def: RouteDef): Promise<ScreenModule> {
    return def
      .loader()
      .then((m) => {
        if (m && typeof (m as ScreenModule).mount === 'function') return m;
        throw new Error(`screen "${def.name}" has no mount() export`);
      })
      .catch((err): ScreenModule => {
        console.warn(`[router] screen "${def.name}" unavailable`, err);
        return fallbackModule(def);
      });
  }

  private showVeil(): void {
    if (this.veil) return;
    this.veil = h(
      'div',
      { class: 'rt-veil', 'aria-hidden': 'true' },
      h('span', { class: 'rt-veil__spin' }),
    );
    this.host.appendChild(this.veil);
    requestAnimationFrame(() => this.veil?.classList.add('is-in'));
  }

  private hideVeil(): void {
    const v = this.veil;
    if (!v) return;
    this.veil = null;
    v.classList.remove('is-in');
    setTimeout(() => v.remove(), 200);
  }
}

function transitionFor(def: RouteDef, _from: RouteEntry | null): TransitionKind {
  if (def.level === 'immersive') return 'zoom';
  if (def.level === 'sheet') return 'sheet';
  if (def.level === 'stack') return 'push';
  return 'fade';
}

function mountScreen(
  mod: ScreenModule,
  el: HTMLElement,
  params: Record<string, string>,
  def: RouteDef,
): ScreenInstance | null {
  try {
    const inst = mod.mount(el, params);
    return inst && typeof inst.unmount === 'function' ? inst : null;
  } catch (err) {
    console.error(`[router] screen "${def.name}" threw during mount`, err);
    el.textContent = '';
    try {
      return fallbackModule(def).mount(el) ?? null;
    } catch {
      return null;
    }
  }
}

function safeUnmount(entry: RouteEntry): void {
  try {
    entry.instance?.unmount();
  } catch (err) {
    console.error(`[router] screen "${entry.name}" threw during unmount`, err);
  }
  entry.instance = null;
}

/**
 * What renders when a screen module is missing or broken. Deliberately a
 * finished-looking panel: the app must always boot, even mid-build.
 */
function fallbackModule(def: RouteDef): ScreenModule {
  return {
    mount(container: HTMLElement) {
      const node = h(
        'div',
        { class: 'rt-fallback' },
        h(
          'div',
          { class: 'rt-fallback__card' },
          h(
            'svg',
            { class: 'rt-fallback__mark', attrs: { viewBox: '0 0 48 48', width: 48, height: 48, 'aria-hidden': 'true' } },
            h('path', {
              attrs: {
                d: 'M24 6.8c6.3 6.8 13.8 11.2 13.8 18.2a7.4 7.4 0 01-12.3 5.5c.4 4 1.6 6.8 3.4 8.4H19.1c1.8-1.6 3-4.4 3.4-8.4A7.4 7.4 0 0110.2 25c0-7 7.5-11.4 13.8-18.2z',
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': 2,
                'stroke-linejoin': 'round',
              },
            }),
          ),
          h('h2', { class: 'rt-fallback__title' }, `${def.title} is not in this build`),
          h(
            'p',
            { class: 'rt-fallback__body' },
            'This room has not been dealt in yet. Everything else in the app still works — head back to the lobby and take a seat.',
          ),
        ),
      );
      container.appendChild(node);
      return {
        unmount() {
          node.remove();
        },
      };
    },
  };
}
