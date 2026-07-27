/**
 * ROYALE — components/sheet.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Bottom sheet with a real gesture. The card tracks your finger 1:1 downward,
 * rubber-bands with rising resistance upward, and on release a spring decides
 * — by distance *and* velocity — whether to snap home or fly out. The scrim
 * behind it is a saturating blur whose opacity is driven by the same value,
 * so the background blurs *progressively* as the sheet rises.
 *
 *   const sheet = openSheet({
 *     title: 'Buy in',
 *     subtitle: "$0.50/$1 · 6-max",
 *     content: (s) => buyInForm(s),
 *     footer: (s) => Button({ label: 'Sit down', variant: 'primary', full: true,
 *                             onTap: () => { join(); s.close(); } }),
 *   });
 *   sheet.close();
 *
 * The shell installs the host with `setSheetHost(el)`; anything else falls
 * back to `document.body`.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import { IconButton } from './button.ts';
import { icon } from './icons.ts';
import { clamp, haptic, reduceMotion, spring, trapFocus } from './util.ts';

export interface SheetHandle {
  /** the sheet card itself */
  el: HTMLElement;
  /** scrollable content region — append here after open if you need to */
  body: HTMLElement;
  close(): void;
  /** true once `close()` has run */
  closed(): boolean;
}

export interface SheetOpts {
  title?: string;
  subtitle?: string;
  /** uppercase micro line above the title */
  eyebrow?: string;
  content?: Node | ((sheet: SheetHandle) => Node);
  footer?: Node | ((sheet: SheetHandle) => Node);
  /** drag-down / scrim tap / Escape can close it. Default true. */
  dismissible?: boolean;
  /** show the round close button. Default true when dismissible. */
  showClose?: boolean;
  /** take 92% of the viewport instead of hugging the content */
  full?: boolean;
  class?: ClassValue;
  onClose?: () => void;
}

let sheetHost: HTMLElement | null = null;

export function setSheetHost(el: HTMLElement): void {
  sheetHost = el;
}

export function openSheet(opts: SheetOpts): SheetHandle {
  const host = sheetHost ?? document.body;
  const dismissible = opts.dismissible !== false;

  const scrim = h('div', { class: 'r-sheet__scrim', 'aria-hidden': 'true' });
  const body = h('div', { class: 'r-sheet__body scroll' });
  const grab = h('div', { class: 'r-sheet__grab', 'aria-hidden': 'true' }, h('i'));
  const foot = h('div', { class: 'r-sheet__foot' });

  const card = h(
    'div',
    {
      class: cx('r-sheet', opts.full && 'is-full', opts.class),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': opts.title ?? 'Sheet',
    },
    grab,
  );

  const root = h('div', { class: 'r-sheet-root' }, scrim, card);

  let closed = false;
  let onKey: ((ev: KeyboardEvent) => void) | null = null;
  const handle: SheetHandle = {
    el: card,
    body,
    close: () => doClose(),
    closed: () => closed,
  };

  if (opts.title || opts.subtitle || opts.eyebrow || (opts.showClose ?? dismissible)) {
    card.appendChild(
      h(
        'header',
        { class: 'r-sheet__head' },
        h(
          'div',
          { class: 'r-sheet__titles' },
          opts.eyebrow ? h('div', { class: 'r-sheet__eyebrow caps' }, opts.eyebrow) : null,
          opts.title ? h('h2', { class: 'r-sheet__title' }, opts.title) : null,
          opts.subtitle ? h('p', { class: 'r-sheet__sub' }, opts.subtitle) : null,
        ),
        (opts.showClose ?? dismissible)
          ? IconButton({
              icon: icon('close', { size: 17, stroke: 2.2 }),
              ariaLabel: 'Close',
              variant: 'ghost',
              size: 34,
              class: 'r-sheet__x',
              onTap: () => doClose(),
            })
          : null,
      ),
    );
  }

  card.appendChild(body);
  const content = typeof opts.content === 'function' ? opts.content(handle) : opts.content;
  if (content) body.appendChild(content);
  const footNode = typeof opts.footer === 'function' ? opts.footer(handle) : opts.footer;
  if (footNode) {
    foot.appendChild(footNode);
    card.appendChild(foot);
  }

  host.appendChild(root);
  host.classList.add('has-sheet');

  const height = Math.max(120, card.offsetHeight);
  let releaseFocus: (() => void) | null = null;

  const paint = (y: number) => {
    card.style.transform = `translate3d(0,${y.toFixed(2)}px,0)`;
    const t = clamp(1 - y / height, 0, 1);
    scrim.style.opacity = t.toFixed(3);
  };

  const motion = spring(height, paint, { stiffness: 260, damping: 30 });
  motion.jump(height);
  root.classList.add('is-mounted');
  requestAnimationFrame(() => motion.set(0));
  haptic('select');
  releaseFocus = trapFocus(card);

  function doClose(): void {
    if (closed) return;
    closed = true;
    if (onKey) document.removeEventListener('keydown', onKey);
    releaseFocus?.();
    releaseFocus = null;
    root.classList.add('is-closing');
    const finish = () => {
      root.remove();
      if (!host.querySelector('.r-sheet-root')) host.classList.remove('has-sheet');
      opts.onClose?.();
    };
    if (reduceMotion()) {
      finish();
      return;
    }
    motion.stop();
    const from = motion.value();
    const t0 = performance.now();
    const dur = 260;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      paint(from + (height + 40 - from) * e);
      if (t < 1) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
  }

  // ── drag gesture ────────────────────────────────────────────────────
  let pid = -1;
  let y0 = 0;
  let x0 = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;
  let mode: 'none' | 'maybe' | 'drag' = 'none';

  const rubber = (over: number) => -Math.pow(Math.abs(over), 0.72) * 0.55;

  card.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    if (!dismissible || pid !== -1) return;
    if ((e.target as HTMLElement).closest('button,input,[role="slider"],a')) return;
    pid = e.pointerId;
    y0 = lastY = e.clientY;
    x0 = e.clientX;
    lastT = performance.now();
    vel = 0;
    motion.stop();
    const fromHandle = grab.contains(e.target as Node) || !!(e.target as HTMLElement).closest('.r-sheet__head');
    mode = fromHandle ? 'drag' : 'maybe';
    if (mode === 'drag') card.setPointerCapture(pid);
  });

  card.addEventListener(
    'pointermove',
    (ev) => {
      const e = ev as PointerEvent;
      if (e.pointerId !== pid) return;
      const dy = e.clientY - y0;
      if (mode === 'maybe') {
        const dx = e.clientX - x0;
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        // Only steal the gesture from the scroller when it is already at the top.
        if (dy > 0 && Math.abs(dy) > Math.abs(dx) && body.scrollTop <= 0) {
          mode = 'drag';
          y0 = e.clientY;
          card.setPointerCapture(pid);
        } else {
          mode = 'none';
          pid = -1;
          return;
        }
      }
      if (mode !== 'drag') return;
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      vel = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = now;
      const raw = e.clientY - y0;
      paint(raw >= 0 ? raw : rubber(raw));
    },
    { passive: true },
  );

  const endDrag = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerId !== pid) return;
    const wasDrag = mode === 'drag';
    pid = -1;
    mode = 'none';
    if (!wasDrag) return;
    const y = e.clientY - y0;
    if (y > height * 0.26 || vel > 0.55) {
      haptic('tick');
      doClose();
    } else {
      motion.jump(Math.max(0, y));
      motion.set(0);
    }
  };
  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);

  if (dismissible) {
    scrim.addEventListener('click', () => doClose());
    onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || closed) return;
      ev.stopPropagation();
      doClose();
    };
    document.addEventListener('keydown', onKey);
  }

  return handle;
}
