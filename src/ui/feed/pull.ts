/**
 * ROYALE — ui/feed/pull.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Pull-to-refresh with a real rubber band. The content follows the finger with
 * rising resistance, the spinner scales and rotates in proportion to the pull
 * (so it feels connected rather than triggered), and release either springs
 * home or locks at the threshold while the refresh runs.
 *
 *   const detach = attachPullToRefresh({ scroller, content, spinner, onRefresh });
 *
 * Only `transform` and `opacity` are touched, and `touchmove` is intercepted
 * only while an actual pull is in progress — normal scrolling is untouched.
 */
import { reduceMotion } from '../components/util.ts';
import { haptic } from '../components/util.ts';

export interface PullOpts {
  /** the scrolling element */
  scroller: HTMLElement;
  /** the element that translates with the pull */
  content: HTMLElement;
  /** the spinner shell (its `--p` custom property gets the 0–1 progress) */
  spinner: HTMLElement;
  /** resolve when the refresh is done */
  onRefresh: () => Promise<unknown>;
  /** px of true travel that arms the refresh. Default 68. */
  threshold?: number;
}

const MAX_PULL = 150;

/** Rubber band: linear at first, asymptotic after that. */
function band(dy: number, max: number): number {
  const t = Math.max(0, dy);
  return max * (1 - Math.exp(-t / (max * 0.72)));
}

export function attachPullToRefresh(opts: PullOpts): () => void {
  const threshold = opts.threshold ?? 68;
  const { scroller, content, spinner } = opts;

  let startY = 0;
  let pulling = false;
  let armed = false;
  let busy = false;
  let travel = 0;
  let raf = 0;

  const write = (px: number, snap: boolean): void => {
    const p = Math.min(1, px / threshold);
    content.style.transform = px > 0.2 ? `translate3d(0,${px.toFixed(1)}px,0)` : '';
    content.style.transition = snap ? 'transform var(--d-base) var(--ease-spring)' : 'none';
    spinner.style.setProperty('--p', p.toFixed(3));
    spinner.style.setProperty('--y', `${Math.min(px, MAX_PULL).toFixed(1)}px`);
    spinner.classList.toggle('is-armed', p >= 1);
  };

  const schedule = (px: number): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      write(px, false);
    });
  };

  const settle = (): void => {
    travel = 0;
    write(0, true);
    spinner.classList.remove('is-busy', 'is-armed');
    window.setTimeout(() => {
      content.style.transition = '';
    }, 300);
  };

  const runRefresh = async (): Promise<void> => {
    busy = true;
    spinner.classList.add('is-busy');
    write(threshold, true);
    haptic('select');
    try {
      await opts.onRefresh();
    } catch {
      /* a failed refresh still has to release the band */
    }
    // Hold the spinner just long enough to be read, never long enough to annoy.
    window.setTimeout(() => {
      busy = false;
      settle();
    }, 260);
  };

  const onStart = (ev: TouchEvent | PointerEvent): void => {
    if (busy) return;
    const y = 'touches' in ev ? ev.touches[0]?.clientY ?? 0 : ev.clientY;
    startY = y;
    pulling = scroller.scrollTop <= 0;
    armed = false;
    travel = 0;
  };

  const onMove = (ev: TouchEvent): void => {
    if (!pulling || busy) return;
    const y = ev.touches[0]?.clientY ?? 0;
    const dy = y - startY;
    if (dy <= 0) {
      if (travel > 0) {
        travel = 0;
        write(0, false);
      }
      pulling = scroller.scrollTop <= 0;
      startY = y;
      return;
    }
    if (scroller.scrollTop > 0) {
      pulling = false;
      return;
    }
    if (ev.cancelable) ev.preventDefault();
    travel = band(dy, MAX_PULL);
    if (!armed && travel >= threshold) {
      armed = true;
      haptic('tick');
    } else if (armed && travel < threshold) {
      armed = false;
    }
    schedule(travel);
  };

  const onEnd = (): void => {
    if (!pulling || busy) return;
    pulling = false;
    if (travel >= threshold) void runRefresh();
    else settle();
  };

  // Pointer path keeps the gesture usable with a mouse in dev; touch path is
  // the one that needs `passive: false` so the pull can cancel the scroll.
  let pointerDown = false;
  const onPointerDown = (ev: PointerEvent): void => {
    if (ev.pointerType === 'touch') return;
    pointerDown = true;
    onStart(ev);
  };
  const onPointerMove = (ev: PointerEvent): void => {
    if (!pointerDown || ev.pointerType === 'touch' || !pulling || busy) return;
    const dy = ev.clientY - startY;
    if (dy <= 0 || scroller.scrollTop > 0) return;
    travel = band(dy, MAX_PULL);
    armed = travel >= threshold;
    schedule(travel);
  };
  const onPointerUp = (): void => {
    if (!pointerDown) return;
    pointerDown = false;
    onEnd();
  };

  scroller.addEventListener('touchstart', onStart as EventListener, { passive: true });
  scroller.addEventListener('touchmove', onMove as EventListener, { passive: false });
  scroller.addEventListener('touchend', onEnd);
  scroller.addEventListener('touchcancel', onEnd);
  scroller.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  if (reduceMotion()) spinner.classList.add('is-static');

  return () => {
    if (raf) cancelAnimationFrame(raf);
    scroller.removeEventListener('touchstart', onStart as EventListener);
    scroller.removeEventListener('touchmove', onMove as EventListener);
    scroller.removeEventListener('touchend', onEnd);
    scroller.removeEventListener('touchcancel', onEnd);
    scroller.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    content.style.transform = '';
    content.style.transition = '';
  };
}
