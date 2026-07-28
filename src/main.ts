/**
 * Boot spine. Sequences: capability probe → renderer → audio → UI shell
 * → initial route. Every subsystem is lazy so first paint stays fast.
 *
 * After that it owns exactly two pieces of wiring, both of which hang off the
 * router's *settled* route rather than off a navigation request:
 *
 *   • the 3D stage is shown on the table and hidden (and stopped) everywhere
 *     else, via `renderer.setVisible()`;
 *   • the settled route is echoed back onto the bus for the subsystems that
 *     have no other way to hear about it.
 *
 * The distinction matters. `nav:route` fires when a navigation is *asked for*;
 * the router queues a request made while another transition is in flight, so a
 * tap during boot lands a frame or a second later — or not at all, if the
 * request is superseded. Keying the felt off the request therefore shows it on
 * the lobby and hides it on the table exactly when the app is busiest. The
 * router's `onChange` fires once the entry is on the stack, in order, on
 * queued navigations and on Back, which is the only signal that is true.
 */
import { bus } from './core/bus.ts';
import type { RouteName } from './core/bus.ts';

const bootEl = document.getElementById('boot')!;
const barEl = bootEl.querySelector<HTMLElement>('.boot__bar i')!;
const labelEl = bootEl.querySelector<HTMLElement>('.boot__label')!;

/** Longer than the slowest route transition (zoom, 420ms). */
const ROUTE_SETTLE_MS = 480;
/** How long a requested-but-not-yet-landed route may hold the echo back. */
const PENDING_TTL_MS = 4000;

function progress(pct: number, label?: string) {
  barEl.style.width = `${Math.max(6, Math.min(100, pct))}%`;
  if (label) labelEl.textContent = label;
}

async function boot() {
  try {
    progress(12, 'Shuffling up…');

    const { initRenderer } = await import('./render/renderer.ts');
    const { initAudio } = await import('./audio/audio.ts');
    const { mountShell, getShell } = await import('./ui/shell.ts');
    progress(34, 'Cutting the deck…');

    const canvas = document.getElementById('stage') as HTMLCanvasElement;
    const renderer = await initRenderer(canvas);
    progress(62, 'Racking chips…');

    await initAudio();
    progress(80, 'Taking a seat…');

    await mountShell(document.getElementById('ui-root')!);
    progress(96, 'Ready');

    const router = getShell()?.router ?? null;

    if (router) {
      // ── the stage follows the settled route ────────────────────────
      // The renderer owns the canvas' visibility outright: it writes the class
      // on every call, so a screen that hid the felt before its own first
      // paint cannot leave the table dark, and it stops the loop once the
      // cross-fade lands so no route but this one costs a GPU frame.
      const applyRoute = (route: RouteName) => renderer.setVisible(route === 'table');

      // ── echo the settled route back onto the bus ───────────────────
      // Audio (music beds), FX (celebration teardown) and the renderer's wake
      // heuristic all listen on `nav:route`, but only navigations that started
      // on the bus ever reach it: a tab press calls the router directly and
      // Back never announces itself at all. The echo is trailing-edge — by the
      // time it fires the router is idle, so the shell's own listener turns it
      // into a no-op instead of queueing a navigation behind an in-flight one.
      let announced: RouteName | null = null;
      let pending: RouteName | null = null;
      let pendingAt = 0;
      let settleTimer = 0;

      bus.on('nav:route', ({ route }) => {
        if (route === 'boot') return;
        announced = route;
        pending = router.current()?.name === route ? null : route;
        pendingAt = performance.now();
      });

      const scheduleEcho = (route: RouteName) => {
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          // A request superseded before it could land (two navigations racing
          // for the router's single queue slot) never reports back, so it is
          // given a deadline rather than allowed to mute the echo for good.
          if (pending && performance.now() - pendingAt < PENDING_TTL_MS) return;
          pending = null;
          if (route !== router.current()?.name) return;
          if (route === announced) return;
          announced = route;
          bus.emit('nav:route', { route });
        }, ROUTE_SETTLE_MS);
      };

      router.onChange(({ entry }) => {
        if (pending === entry.name) pending = null;
        applyRoute(entry.name);
        scheduleEcho(entry.name);
      });

      // The shell navigated to the initial route (hash deep link, or the
      // lobby) before this listener existed, so seed both from the stack as it
      // stands. Never force one: a deep link, or a tap taken while the boot
      // curtain was still up, has to win over the default.
      const initial = router.current()?.name ?? 'lobby';
      applyRoute(initial);
      scheduleEcho(initial);
    }

    await new Promise((r) => setTimeout(r, 220));
    progress(100);
    bootEl.classList.add('is-done');
    setTimeout(() => bootEl.remove(), 700);
  } catch (err) {
    console.error('[boot] failed', err);
    labelEl.textContent = 'Something went wrong — pull to retry';
    labelEl.style.color = 'var(--c-bad)';
  }
}

// Lock to portrait where the platform allows it.
const so = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
so?.lock?.('portrait').catch(() => void 0);

// Kill iOS double-tap zoom + rubber-band without killing scrollable regions.
document.addEventListener(
  'touchmove',
  (e) => {
    if (!(e.target as HTMLElement)?.closest?.('.scroll')) e.preventDefault();
  },
  { passive: false },
);

boot();
