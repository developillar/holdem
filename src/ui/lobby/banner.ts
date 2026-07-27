/**
 * ROYALE — lobby/banner.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The hero carousel. Three promos, each with its own hand-built artwork made
 * only of gradients and SVG shapes — no images ship with this app.
 *
 * What makes it feel native rather than "a slider":
 *   • the deck tracks your finger 1:1 and rubber-bands at both ends
 *   • release is decided by velocity *and* distance, then springs home
 *   • every artwork layer carries a `--depth`, and the deck writes one CSS
 *     variable per frame — so the crown floats ahead of the rays, which float
 *     ahead of the wash. Real parallax, one property write per frame.
 *   • the page indicator is a progress bar for the auto-advance timer, so you
 *     always know when the next slide is coming
 *   • auto-advance pauses on touch, on hover, and whenever the tab is hidden
 *
 *   const deck = BannerCarousel({ onAction: (id) => …});
 *   deck.update(snapshot);   // live countdowns / seat counts
 *   deck.dispose();
 */
import { h, on } from '../dom.ts';
import { icon } from '../components/icons.ts';
import { haptic, reduceMotion, spring } from '../components/util.ts';
import { STAKES } from '../../core/stakes.ts';
import type { LobbySnapshot } from './data.ts';
import { cash, clockMs, coarseMs } from './data.ts';

export type BannerAction = 'pass' | 'bomb' | 'sng';

export interface BannerOpts {
  onAction(id: BannerAction): void;
}

export interface BannerEl extends HTMLElement {
  update(s: LobbySnapshot): void;
  dispose(): void;
}

const AUTO_MS = 6200;

// ── artwork ──────────────────────────────────────────────────────────

function layer(depth: number, ...kids: Node[]): HTMLElement {
  return h('div', { class: 'bn__layer', style: { '--depth': String(depth) } }, ...kids);
}

/** Radiating light spokes — the "something valuable is behind this" cue. */
function rays(count: number, color: string, opacity: number): SVGSVGElement {
  const svg = h('svg', {
    class: 'bn__rays',
    attrs: { viewBox: '0 0 200 200', 'aria-hidden': 'true', focusable: 'false' },
  });
  for (let i = 0; i < count; i++) {
    const a = (i / count) * 360;
    const w = i % 2 === 0 ? 7.5 : 3.4;
    svg.appendChild(
      h('path', {
        attrs: {
          d: `M100 100 L${100 + Math.cos(((a - w) * Math.PI) / 180) * 150} ${
            100 + Math.sin(((a - w) * Math.PI) / 180) * 150
          } L${100 + Math.cos(((a + w) * Math.PI) / 180) * 150} ${
            100 + Math.sin(((a + w) * Math.PI) / 180) * 150
          } Z`,
          fill: color,
          opacity: (i % 2 === 0 ? opacity : opacity * 0.5).toFixed(3),
        },
      }),
    );
  }
  return svg;
}

function chipStack(tint: string, edge: string): SVGSVGElement {
  const svg = h('svg', {
    class: 'bn__chips',
    attrs: { viewBox: '0 0 120 92', 'aria-hidden': 'true', focusable: 'false' },
  });
  for (let i = 0; i < 6; i++) {
    const y = 66 - i * 8.4;
    svg.appendChild(
      h('ellipse', { attrs: { cx: 60, cy: y + 4.4, rx: 34, ry: 12, fill: '#04060c', opacity: 0.55 } }),
    );
    svg.appendChild(
      h('ellipse', {
        attrs: {
          cx: 60, cy: y, rx: 34, ry: 12,
          fill: i === 5 ? tint : `rgba(20,26,40,${0.92 - i * 0.04})`,
          stroke: edge, 'stroke-width': 1,
        },
      }),
    );
    if (i === 5) {
      svg.appendChild(
        h('ellipse', { attrs: { cx: 60, cy: y, rx: 19, ry: 6.6, fill: 'none', stroke: 'rgba(6,9,16,0.5)', 'stroke-width': 2.2 } }),
      );
      svg.appendChild(
        h('ellipse', { attrs: { cx: 60, cy: y - 1.6, rx: 34, ry: 12, fill: 'none', stroke: 'rgba(255,255,255,0.4)', 'stroke-width': 0.9 } }),
      );
    }
  }
  return svg;
}

function crownMark(): SVGSVGElement {
  return h(
    'svg',
    { class: 'bn__crown', attrs: { viewBox: '0 0 64 52', 'aria-hidden': 'true', focusable: 'false' } },
    h(
      'defs',
      null,
      h('linearGradient', { attrs: { id: 'bn-cg', x1: '0', y1: '0', x2: '0.4', y2: '1' } },
        h('stop', { attrs: { offset: '0', 'stop-color': '#fdf3d0' } }),
        h('stop', { attrs: { offset: '0.44', 'stop-color': '#edc96b' } }),
        h('stop', { attrs: { offset: '0.72', 'stop-color': '#c08d21' } }),
        h('stop', { attrs: { offset: '1', 'stop-color': '#f6e0a0' } }),
      ),
    ),
    h('path', {
      attrs: {
        d: 'M4 16.5l12.6 8.8L32 7.8l15.4 17.5L60 16.5l-5.4 27.8H9.4L4 16.5z',
        fill: 'url(#bn-cg)', stroke: 'rgba(99,70,10,0.55)', 'stroke-width': 1.1, 'stroke-linejoin': 'round',
      },
    }),
    h('path', { attrs: { d: 'M11 47.6h42', stroke: 'url(#bn-cg)', 'stroke-width': 3.4, 'stroke-linecap': 'round' } }),
    h('circle', { attrs: { cx: 32, cy: 20.4, r: 3.4, fill: '#fdf3d0' } }),
    h('circle', { attrs: { cx: 4.6, cy: 15.4, r: 2.6, fill: '#f6e0a0' } }),
    h('circle', { attrs: { cx: 59.4, cy: 15.4, r: 2.6, fill: '#f6e0a0' } }),
  );
}

/** Concentric shock rings for the bomb-pot slide. */
function shockRings(): SVGSVGElement {
  const svg = h('svg', {
    class: 'bn__rings',
    attrs: { viewBox: '0 0 200 200', 'aria-hidden': 'true', focusable: 'false' },
  });
  for (let i = 0; i < 5; i++) {
    svg.appendChild(
      h('circle', {
        attrs: {
          cx: 100, cy: 100, r: 24 + i * 17,
          fill: 'none', stroke: '#ff8a3d',
          'stroke-width': 2.2 - i * 0.3,
          opacity: (0.5 - i * 0.088).toFixed(3),
          'stroke-dasharray': i % 2 ? '5 9' : 'none',
        },
      }),
    );
  }
  return svg;
}

function sparkField(count: number, seedBase: number): HTMLElement {
  const box = h('div', { class: 'bn__sparks', 'aria-hidden': 'true' });
  for (let i = 0; i < count; i++) {
    const a = ((seedBase * (i + 3) * 2654435761) >>> 0) / 4294967296;
    const b = ((seedBase * (i + 11) * 40503) >>> 0) / 4294967296;
    box.appendChild(
      h('i', {
        style: {
          left: `${6 + a * 88}%`,
          top: `${10 + b * 76}%`,
          '--sz': `${(2 + a * 3).toFixed(1)}px`,
          '--dly': `${(a * 3.4).toFixed(2)}s`,
          '--dur': `${(2.6 + b * 2.2).toFixed(2)}s`,
        },
      }),
    );
  }
  return box;
}

/** Nine seat dots for the SNG slide; `fill()` lights the claimed ones. */
function seatRing(): { el: HTMLElement; fill(n: number): void } {
  const dots: SVGCircleElement[] = [];
  const svg = h('svg', {
    class: 'bn__seatring',
    attrs: { viewBox: '0 0 120 120', 'aria-hidden': 'true', focusable: 'false' },
  });
  svg.appendChild(
    h('ellipse', { attrs: { cx: 60, cy: 60, rx: 40, ry: 40, fill: 'rgba(10,36,24,0.85)', stroke: 'rgba(52,211,153,0.34)', 'stroke-width': 1.4 } }),
  );
  svg.appendChild(
    h('ellipse', { attrs: { cx: 60, cy: 60, rx: 31, ry: 31, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 } }),
  );
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 - Math.PI / 2;
    const c = h('circle', {
      attrs: {
        cx: (60 + Math.cos(a) * 47).toFixed(2),
        cy: (60 + Math.sin(a) * 47).toFixed(2),
        r: 6.2,
        fill: 'rgba(24,31,45,0.95)',
        stroke: 'rgba(255,255,255,0.16)',
        'stroke-width': 1.2,
      },
    });
    dots.push(c);
    svg.appendChild(c);
  }
  const wrap = h('div', { class: 'bn__ringwrap' }, svg);
  return {
    el: wrap,
    fill(n) {
      dots.forEach((d, i) => {
        const on = i < n;
        d.setAttribute('fill', on ? '#34d399' : 'rgba(24,31,45,0.95)');
        d.setAttribute('stroke', on ? 'rgba(215,255,238,0.8)' : 'rgba(255,255,255,0.16)');
      });
    },
  };
}

// ── slides ───────────────────────────────────────────────────────────

interface SlideRefs {
  el: HTMLElement;
  countdown?: HTMLElement;
  seats?: { el: HTMLElement; fill(n: number): void };
  seatText?: HTMLElement;
  meta?: HTMLElement;
  bombStake?: HTMLElement;
  season?: HTMLElement;
}

function slideShell(
  kind: string,
  eyebrow: string,
  title: Node,
  sub: string,
  cta: string,
  art: HTMLElement[],
  extra: Node | null,
  onTap: () => void,
): HTMLElement {
  return h(
    'button',
    { class: `bn__slide bn__slide--${kind}`, type: 'button', onclick: onTap },
    h('span', { class: 'bn__art', 'aria-hidden': 'true' }, ...art),
    h('span', { class: 'bn__scrim', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'bn__copy' },
      h('span', { class: 'bn__eyebrow caps' }, eyebrow),
      h('span', { class: 'bn__title' }, title),
      h('span', { class: 'bn__sub' }, sub),
      extra,
      h('span', { class: 'bn__cta' }, cta, icon('chevron-right', { size: 15, stroke: 2.4 })),
    ),
    h('span', { class: 'bn__edge', 'aria-hidden': 'true' }),
  );
}

function passSlide(onTap: () => void): SlideRefs {
  const season = h('b', { class: 'tnum' }, '—');
  const el = slideShell(
    'pass',
    'Season IV · Royale Pass',
    h('span', null, 'Every hand, ', h('em', null, 'more'), ' back'),
    '60 tiers of gold, exclusive felts and a 2× XP curve.',
    'See the pass',
    [
      layer(0.18, h('span', { class: 'bn__wash bn__wash--gold' })),
      layer(0.42, rays(18, '#edc96b', 0.16)),
      layer(0.6, sparkField(12, 0x9e37)),
      layer(1.0, chipStack('#d9a93a', 'rgba(253,243,208,0.55)')),
      layer(1.35, crownMark()),
    ],
    h(
      'span',
      { class: 'bn__chiprow' },
      h('span', { class: 'bn__tag' }, icon('sparkle', { size: 12, solid: true }), '2× XP'),
      h('span', { class: 'bn__tag' }, icon('clock', { size: 12 }), 'Ends in ', season),
    ),
    onTap,
  );
  return { el, season };
}

function bombSlide(onTap: () => void): SlideRefs {
  const countdown = h('span', { class: 'bn__clock tnum' }, '00:00');
  const bombStake = h('b', null, '—');
  const el = slideShell(
    'bomb',
    'Starting soon',
    h('span', null, 'Bomb pot'),
    'No preflop betting. Everyone antes, everyone sees a flop.',
    'Join the queue',
    [
      layer(0.18, h('span', { class: 'bn__wash bn__wash--ember' })),
      layer(0.45, shockRings()),
      layer(0.66, sparkField(16, 0xbeef)),
      layer(1.18, h('span', { class: 'bn__blast' })),
      layer(1.5, h('span', { class: 'bn__fuse' }, icon('flame', { size: 60, solid: true }))),
    ],
    h(
      'span',
      { class: 'bn__chiprow' },
      h('span', { class: 'bn__tag bn__tag--hot' }, icon('clock', { size: 12 }), countdown),
      h('span', { class: 'bn__tag' }, '2bb ante · ', bombStake),
    ),
    onTap,
  );
  return { el, countdown, bombStake };
}

function sngSlide(onTap: () => void): SlideRefs {
  const ring = seatRing();
  ring.el.appendChild(
    h('span', { class: 'bn__prize' }, icon('trophy', { size: 22 }), h('b', { class: 'tnum' }, cash(45))),
  );
  const seatText = h('b', { class: 'tnum' }, '0/9');
  const el = slideShell(
    'sng',
    'Featured · Sit & Go',
    h('span', null, 'Midnight ', h('em', null, 'Turbo')),
    '9 seats, 5-minute levels, top three paid.',
    'Reserve a seat',
    [
      layer(0.18, h('span', { class: 'bn__wash bn__wash--felt' })),
      layer(0.4, rays(12, '#34d399', 0.1)),
      layer(0.72, sparkField(9, 0x5eed)),
      layer(1.3, ring.el),
    ],
    h(
      'span',
      { class: 'bn__chiprow' },
      h('span', { class: 'bn__tag bn__tag--good' }, icon('users', { size: 12 }), seatText, ' seated'),
      h('span', { class: 'bn__tag' }, cash(5), ' buy-in'),
    ),
    onTap,
  );
  return { el, seats: ring, seatText };
}

// ── carousel ─────────────────────────────────────────────────────────

export function BannerCarousel(opts: BannerOpts): BannerEl {
  const slides: SlideRefs[] = [
    passSlide(() => opts.onAction('pass')),
    bombSlide(() => opts.onAction('bomb')),
    sngSlide(() => opts.onAction('sng')),
  ];
  const n = slides.length;

  const deck = h('div', { class: 'bn__deck' }, ...slides.map((s) => s.el));
  const dots: HTMLElement[] = [];
  const nav = h('div', { class: 'bn__nav', role: 'tablist', 'aria-label': 'Featured' });
  for (let i = 0; i < n; i++) {
    const bar = h('i', { class: 'bn__dotfill' });
    const b = h(
      'button',
      {
        class: 'bn__dot',
        type: 'button',
        role: 'tab',
        'aria-label': `Slide ${i + 1} of ${n}`,
        'aria-selected': i === 0 ? 'true' : 'false',
      },
      bar,
    );
    b.addEventListener('click', () => {
      haptic('tick');
      goTo(i, true);
    });
    dots.push(b);
    nav.appendChild(b);
  }

  const el = h(
    'section',
    { class: 'bn', 'aria-label': 'Featured' },
    h('div', { class: 'bn__view' }, deck),
    nav,
  ) as BannerEl;

  let index = 0;
  let width = 0;
  let dragging = -1;
  let paused = false;
  let autoAt = performance.now() + AUTO_MS;
  let autoSpan = AUTO_MS;
  let raf = 0;

  const measure = () => {
    width = el.clientWidth || 360;
  };

  const paint = (v: number) => {
    // `v` is a float slide index; the deck slides and every art layer takes a
    // fraction of that travel back, which is the parallax.
    deck.style.transform = `translate3d(${(-v * width).toFixed(2)}px,0,0)`;
    for (let i = 0; i < n; i++) {
      const d = v - i;
      const s = slides[i].el;
      s.style.setProperty('--px', d.toFixed(4));
      const near = Math.min(1, Math.abs(d));
      s.style.setProperty('--dim', (1 - near * 0.55).toFixed(3));
      s.classList.toggle('is-active', near < 0.5);
    }
  };

  const motion = spring(0, paint, { stiffness: 260, damping: 30 });

  function goTo(i: number, user: boolean): void {
    index = ((i % n) + n) % n;
    motion.set(index);
    // A manual swipe buys the slide extra dwell time; the indicator has to
    // fill across that longer span or it sits empty and looks broken.
    autoSpan = user ? AUTO_MS * 1.7 : AUTO_MS;
    autoAt = performance.now() + autoSpan;
    dots.forEach((d, k) => {
      d.setAttribute('aria-selected', k === index ? 'true' : 'false');
      d.classList.toggle('is-on', k === index);
    });
  }

  // A carousel nobody is looking at has no business rotating. Two things go
  // wrong without this: the dwell on slide one is spent while the screen is
  // still assembling — so the first thing the player sees is a slide already
  // sliding away — and the deck keeps advancing after it has scrolled out of
  // view, so coming back up the lobby lands you on an arbitrary slide.
  let visible = false;

  // ── auto-advance + indicator progress on one rAF ───────────────────
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const active = dots[index];
    if (paused || !visible || dragging !== -1 || document.hidden) {
      autoAt = Math.max(autoAt, now + 900);
      active.style.setProperty('--p', '0');
      return;
    }
    const left = autoAt - now;
    active.style.setProperty('--p', String(Math.max(0, Math.min(1, 1 - left / autoSpan))));
    if (left <= 0) goTo(index + 1, false);
  };

  // ── gesture ────────────────────────────────────────────────────────
  let x0 = 0;
  let y0 = 0;
  let lastX = 0;
  let lastT = 0;
  let vel = 0;
  let axis: 'x' | 'y' | null = null;

  const rubber = (over: number) => Math.sign(over) * Math.pow(Math.abs(over), 0.78) * 0.42;

  const offDown = on(deck, 'pointerdown', (ev) => {
    const e = ev as PointerEvent;
    if (dragging !== -1) return;
    dragging = e.pointerId;
    x0 = lastX = e.clientX;
    y0 = e.clientY;
    lastT = performance.now();
    vel = 0;
    axis = null;
    motion.stop();
  });

  const offMove = on(
    deck,
    'pointermove',
    (ev) => {
      const e = ev as PointerEvent;
      if (e.pointerId !== dragging) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (!axis) {
        if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
        axis = Math.abs(dx) > Math.abs(dy) * 1.1 ? 'x' : 'y';
        if (axis === 'x') deck.setPointerCapture(e.pointerId);
        else {
          dragging = -1;
          return;
        }
      }
      const now = performance.now();
      vel = (e.clientX - lastX) / Math.max(1, now - lastT);
      lastX = e.clientX;
      lastT = now;
      let v = index - dx / Math.max(1, width);
      if (v < 0) v = rubber(v);
      else if (v > n - 1) v = n - 1 + rubber(v - (n - 1));
      paint(v);
      motion.jump(v);
    },
    { passive: true },
  );

  const endDrag = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerId !== dragging) return;
    const wasX = axis === 'x';
    dragging = -1;
    axis = null;
    if (!wasX) return;
    const travelled = (e.clientX - x0) / Math.max(1, width);
    let target = index;
    if (travelled < -0.22 || vel < -0.45) target = index + 1;
    else if (travelled > 0.22 || vel > 0.45) target = index - 1;
    if (target !== index) haptic('tick');
    goTo(Math.max(0, Math.min(n - 1, target)), true);
  };
  const offUp = on(deck, 'pointerup', endDrag);
  const offCancel = on(deck, 'pointercancel', endDrag);

  // A drag must never fire the slide's click.
  const offClick = on(
    deck,
    'click',
    (ev) => {
      if (Math.abs(lastX - x0) > 9) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
    { capture: true },
  );

  const offEnter = on(el, 'pointerenter', () => {
    paused = true;
  });
  const offLeave = on(el, 'pointerleave', () => {
    paused = false;
  });

  const ro = new ResizeObserver(() => {
    measure();
    paint(motion.value());
  });
  ro.observe(el);

  // The dwell clock restarts the moment the deck comes into view, so every
  // slide gets its full read whether it arrived by entrance or by scroll.
  const io = new IntersectionObserver(
    (entries) => {
      const now = entries[entries.length - 1].isIntersecting;
      if (now === visible) return;
      visible = now;
      if (visible) autoAt = performance.now() + autoSpan;
    },
    { threshold: 0.4 },
  );
  io.observe(el);

  measure();
  motion.jump(0);
  paint(0);
  dots[0].classList.add('is-on');
  if (!reduceMotion()) raf = requestAnimationFrame(frame);

  el.update = (s) => {
    const bomb = slides[1];
    if (bomb.countdown) bomb.countdown.textContent = clockMs(s.bombPotInMs);
    if (bomb.bombStake) bomb.bombStake.textContent = STAKES[s.bombPotStake].label;
    const sng = slides[2];
    sng.seats?.fill(s.sngSeats);
    if (sng.seatText) sng.seatText.textContent = `${s.sngSeats}/${s.sngTotal}`;
    const pass = slides[0];
    if (pass.season) pass.season.textContent = coarseMs(s.seasonEndsInMs);
  };

  el.dispose = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    motion.stop();
    ro.disconnect();
    io.disconnect();
    offDown();
    offMove();
    offUp();
    offCancel();
    offClick();
    offEnter();
    offLeave();
  };

  return el;
}
