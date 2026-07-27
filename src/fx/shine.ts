/**
 * ROYALE — fx/shine.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The specular sweep on gold buttons, legendary tiles and the pass banner.
 *
 * The whole effect is ONE absolutely-positioned overlay whose `::after` is the
 * highlight band. The band runs a single infinite CSS animation whose keyframes
 * spend ~78% of the cycle parked offscreen at zero opacity — so the "interval"
 * is the animation duration and there is no timer, no rAF subscription and no
 * per-sweep JavaScript at all. The overlay clips to the host's own radius via
 * `border-radius: inherit`, so it fits pills, cards and circles without being
 * told which it is.
 *
 * An IntersectionObserver parks the animation while the host is offscreen,
 * which matters on the store and pass screens where a dozen legendary tiles
 * would otherwise all be sweeping inside a scroll container you cannot see.
 */
import { engine, reduceMotion, token } from './engine.ts';

export interface ShineOpts {
  /** full cycle in ms — the visible sweep is ~22% of it. 0 = manual only. */
  intervalMs?: number;
  /** delay before the first cycle, ms */
  delayMs?: number;
  /** tilt of the highlight band, degrees */
  angle?: number;
  /** band width as a fraction of the host's width */
  width?: number;
  /** highlight colour; defaults to the gold-100 token */
  color?: string;
  /** peak opacity, 0..1 */
  strength?: number;
  /** sweep exactly once, then remove the overlay */
  once?: boolean;
}

export interface ShineHandle {
  /** trigger an extra sweep right now */
  sweep(): void;
  /** detach the overlay and all observers */
  stop(): void;
  el: HTMLElement;
}

const ATTACHED = new WeakMap<HTMLElement, ShineHandle>();
const NOOP: ShineHandle = { sweep: () => void 0, stop: () => void 0, el: null as unknown as HTMLElement };

let io: IntersectionObserver | null = null;

function observer(): IntersectionObserver | null {
  if (io) return io;
  if (typeof IntersectionObserver === 'undefined') return null;
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        (e.target as HTMLElement).classList.toggle('is-idle', !e.isIntersecting);
      }
    },
    { rootMargin: '32px' },
  );
  return io;
}

/**
 * Attach a repeating sweep. Idempotent — calling twice on the same element
 * updates the existing overlay rather than stacking a second one.
 */
export function shine(host: HTMLElement | null | undefined, opts: ShineOpts = {}): ShineHandle {
  if (!host || !host.isConnected) return NOOP;
  if (reduceMotion()) return NOOP;

  const existing = ATTACHED.get(host);
  const overlay = existing ? existing.el : document.createElement('i');

  if (!existing) {
    overlay.className = 'fx-shine';
    overlay.setAttribute('aria-hidden', 'true');
    // Gold buttons are usually already positioned; only pay for the read once,
    // and only promote to `relative` when the host truly is static.
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(overlay);
  }

  const interval = opts.intervalMs ?? 4200;
  const s = overlay.style;
  s.setProperty('--shine-int', `${Math.max(600, interval)}ms`);
  s.setProperty('--shine-delay', `${opts.delayMs ?? 0}ms`);
  s.setProperty('--shine-a', `${opts.angle ?? 18}deg`);
  s.setProperty('--shine-w', `${((opts.width ?? 0.26) * 100).toFixed(1)}%`);
  s.setProperty('--shine-c', opts.color ?? token('--c-gold-100', '#fdf3d0'));
  s.setProperty('--shine-o', String(opts.strength ?? 0.72));

  const io2 = observer();
  if (!existing && io2) io2.observe(overlay);

  const handle: ShineHandle = {
    el: overlay,
    sweep(): void {
      overlay.classList.remove('is-once');
      for (const anim of overlay.getAnimations?.({ subtree: true }) ?? []) {
        const name = (anim as { animationName?: string }).animationName;
        if (name === 'fxShineOnce') anim.cancel();
      }
      overlay.classList.add('is-once');
      engine.after(1000, () => overlay.classList.remove('is-once'));
    },
    stop(): void {
      io2?.unobserve(overlay);
      overlay.remove();
      ATTACHED.delete(host);
    },
  };
  ATTACHED.set(host, handle);

  if (opts.once) {
    overlay.classList.add('is-manual');
    handle.sweep();
    engine.after(1100, handle.stop);
  } else {
    overlay.classList.remove('is-manual');
  }
  return handle;
}

/** One sweep, then clean up. For "just unlocked" / "just equipped" moments. */
export function shineOnce(host: HTMLElement | null | undefined, opts: ShineOpts = {}): void {
  const existing = host ? ATTACHED.get(host) : undefined;
  if (existing) {
    existing.sweep();
    return;
  }
  shine(host, { ...opts, once: true });
}

/** Remove a sweep previously attached to `host`. */
export function unshine(host: HTMLElement | null | undefined): void {
  if (!host) return;
  ATTACHED.get(host)?.stop();
}

const PRESETS: Record<string, ShineOpts> = {
  '': { intervalMs: 4200 },
  gold: { intervalMs: 4200, strength: 0.78, width: 0.28 },
  slow: { intervalMs: 7200, strength: 0.55, width: 0.34 },
  fast: { intervalMs: 2400, strength: 0.6, width: 0.2 },
  legendary: { intervalMs: 3200, strength: 0.9, width: 0.34, angle: 22 },
  banner: { intervalMs: 5200, strength: 0.5, width: 0.46, angle: 12 },
};

/**
 * Declarative mode: any element in `root` carrying `data-shine` gets a sweep,
 * including ones added later. The attribute value picks a preset
 * (`data-shine="legendary"`) or gives a raw interval in ms
 * (`data-shine="3000"`). Returns a disposer that detaches everything.
 */
export function autoShine(root: ParentNode = document): () => void {
  if (reduceMotion()) return () => void 0;
  const hosts = new Set<HTMLElement>();

  const attach = (el: HTMLElement): void => {
    if (hosts.has(el)) return;
    const raw = el.getAttribute('data-shine') ?? '';
    const numeric = Number(raw);
    const opts: ShineOpts = Number.isFinite(numeric) && raw !== '' ? { intervalMs: numeric } : (PRESETS[raw] ?? PRESETS['']);
    shine(el, opts);
    hosts.add(el);
  };

  const scan = (node: ParentNode): void => {
    if (node instanceof HTMLElement && node.hasAttribute('data-shine')) attach(node);
    node.querySelectorAll?.<HTMLElement>('[data-shine]').forEach(attach);
  };
  scan(root);

  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        if (n.nodeType === 1) scan(n as HTMLElement);
      }
      for (const n of Array.from(r.removedNodes)) {
        if (n.nodeType !== 1) continue;
        const el = n as HTMLElement;
        if (hosts.has(el)) {
          unshine(el);
          hosts.delete(el);
        }
        el.querySelectorAll?.<HTMLElement>('[data-shine]').forEach((c) => {
          unshine(c);
          hosts.delete(c);
        });
      }
    }
  });
  mo.observe(root === document ? document.body : (root as Element), { childList: true, subtree: true });

  return () => {
    mo.disconnect();
    for (const el of hosts) unshine(el);
    hosts.clear();
  };
}
