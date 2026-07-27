/**
 * ROYALE — ui/econ/chart.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The bankroll curve and its small relatives.
 *
 *   BankrollChart({ points, height: 200, format })  → scrubbable SVG chart
 *   Sparkline({ values, tone })                     →
 *   MiniBars({ values })                            → positional bar strip
 *
 * The chart is SVG rather than canvas because a phone's finger needs
 * hit-testing and the labels need to stay real text. The line is smoothed with
 * a monotone cubic (never overshoots into a fake dip the data does not have),
 * the fill is a two-stop gradient that fades to nothing at the axis, and the
 * gridlines are four hairlines with the zero line one step brighter — enough
 * structure to read a number off, not enough to become a cage.
 *
 * Scrubbing follows the finger 1:1 and pins a tooltip that flips sides before
 * it can leave the frame.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { CurvePoint } from '../../econ/analytics.ts';
import { clamp, haptic } from '../components/util.ts';

// ─────────────────────────── path maths ───────────────────────────

/**
 * Monotone cubic interpolation. Unlike Catmull-Rom this cannot invent a local
 * minimum between two rising points — which matters a lot when the line is
 * somebody's money.
 */
function monotonePath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  if (n === 2) return `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}L${pts[1][0].toFixed(2)} ${pts[1][1].toFixed(2)}`;

  const dx: number[] = [];
  const dy: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    slope[i] = dx[i] === 0 ? 0 : dy[i] / dx[i];
  }
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i][0];
    const y0 = pts[i][1];
    const x1 = pts[i + 1][0];
    const y1 = pts[i + 1][1];
    const c = dx[i] / 3;
    d += `C${(x0 + c).toFixed(2)} ${(y0 + m[i] * c).toFixed(2)},${(x1 - c).toFixed(2)} ${(y1 - m[i + 1] * c).toFixed(2)},${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return d;
}

/** Human gridline steps: 1, 2, 2.5, 5 × 10ⁿ. */
function niceStep(range: number, target = 4): number {
  if (range <= 0) return 1;
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

// ─────────────────────────── bankroll chart ───────────────────────────

export interface BankrollChartOpts {
  points: CurvePoint[];
  height?: number;
  /** money formatter for labels and the tooltip */
  format(n: number): string;
  /** draw the all-in adjusted line as a dashed companion */
  showEv?: boolean;
  class?: ClassValue;
  /** fired while scrubbing; null when the finger lifts */
  onScrub?(p: CurvePoint | null): void;
}

export interface BankrollChartEl extends HTMLElement {
  setPoints(points: CurvePoint[]): void;
}

const VW = 340;

export function BankrollChart(opts: BankrollChartOpts): BankrollChartEl {
  const VH = opts.height ?? 190;
  const padT = 12;
  const padB = 20;
  const padR = 8;
  const padL = 40;

  const uid = `bc${Math.random().toString(36).slice(2, 8)}`;

  const gridG = h('g', { class: 'bc__grid' });
  const labelsG = h('g', { class: 'bc__labels' });
  const areaPath = h('path', { class: 'bc__area', attrs: { d: '', fill: `url(#${uid}-fill)` } });
  const linePath = h('path', { class: 'bc__line', attrs: { d: '', fill: 'none' } });
  const evPath = h('path', { class: 'bc__ev', attrs: { d: '', fill: 'none' } });
  const zeroLine = h('line', { class: 'bc__zero', attrs: { x1: padL, x2: VW - padR, y1: 0, y2: 0 } });
  const cursor = h('g', { class: 'bc__cursor', attrs: { opacity: 0 } },
    h('line', { class: 'bc__cursorline', attrs: { x1: 0, x2: 0, y1: padT, y2: VH - padB } }),
    h('circle', { class: 'bc__dotglow', attrs: { r: 9, cx: 0, cy: 0 } }),
    h('circle', { class: 'bc__dot', attrs: { r: 4.2, cx: 0, cy: 0 } }),
  );
  const endDot = h('circle', { class: 'bc__end', attrs: { r: 4, cx: 0, cy: 0, opacity: 0 } });

  const svg = h(
    'svg',
    {
      class: 'bc__svg',
      attrs: { viewBox: `0 0 ${VW} ${VH}`, width: '100%', height: VH, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    },
    h(
      'defs',
      null,
      h('linearGradient', { attrs: { id: `${uid}-fill`, x1: '0', y1: '0', x2: '0', y2: '1' } },
        h('stop', { class: 'bc__fill0', attrs: { offset: '0' } }),
        h('stop', { class: 'bc__fill1', attrs: { offset: '0.62' } }),
        h('stop', { class: 'bc__fill2', attrs: { offset: '1' } }),
      ),
      h('linearGradient', { attrs: { id: `${uid}-stroke`, x1: '0', y1: '0', x2: '1', y2: '0' } },
        h('stop', { class: 'bc__s0', attrs: { offset: '0' } }),
        h('stop', { class: 'bc__s1', attrs: { offset: '1' } }),
      ),
    ),
    gridG,
    zeroLine,
    areaPath,
    evPath,
    linePath,
    endDot,
    cursor,
    labelsG,
  );
  linePath.setAttribute('stroke', `url(#${uid}-stroke)`);

  const tip = h(
    'div',
    { class: 'bc__tip', 'aria-hidden': 'true' },
    h('span', { class: 'bc__tipv tnum' }),
    h('span', { class: 'bc__tipm' }),
  );
  const tipValue = tip.querySelector('.bc__tipv') as HTMLElement;
  const tipMeta = tip.querySelector('.bc__tipm') as HTMLElement;

  const empty = h(
    'div',
    { class: 'bc__empty' },
    h('span', { class: 'bc__emptyt' }, 'No hands in this range'),
    h('span', { class: 'bc__emptyb' }, 'Play a session or widen the filter.'),
  );

  const el = h('div', { class: cx('bc', opts.class) }, svg, tip, empty) as unknown as BankrollChartEl;

  let pts: CurvePoint[] = [];
  let screen: Array<[number, number]> = [];

  const layout = () => {
    gridG.textContent = '';
    labelsG.textContent = '';
    screen = [];
    if (pts.length < 2) {
      el.classList.add('is-empty');
      areaPath.setAttribute('d', '');
      linePath.setAttribute('d', '');
      evPath.setAttribute('d', '');
      endDot.setAttribute('opacity', '0');
      return;
    }
    el.classList.remove('is-empty');

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const vals = opts.showEv ? [p.net, p.ev] : [p.net];
      for (const v of vals) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo > 0) lo = 0;
    if (hi < 0) hi = 0;
    const span = Math.max(1e-6, hi - lo);
    lo -= span * 0.12;
    hi += span * 0.12;

    const x = (i: number) => padL + (i / (pts.length - 1)) * (VW - padL - padR);
    const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (VH - padT - padB);

    // Gridlines — four at most, anchored on a human step through zero.
    const step = niceStep(hi - lo, 3);
    const first = Math.ceil(lo / step) * step;
    for (let v = first; v <= hi; v += step) {
      const gy = y(v);
      if (gy < padT - 1 || gy > VH - padB + 1) continue;
      const isZero = Math.abs(v) < step * 0.001;
      gridG.appendChild(
        h('line', {
          class: cx('bc__gridline', isZero && 'is-zero'),
          attrs: { x1: padL, x2: VW - padR, y1: gy.toFixed(1), y2: gy.toFixed(1) },
        }),
      );
      labelsG.appendChild(
        h('text', {
          class: cx('bc__label', isZero && 'is-zero'),
          attrs: { x: padL - 6, y: (gy + 3.4).toFixed(1), 'text-anchor': 'end' },
        }, opts.format(v)),
      );
    }
    zeroLine.setAttribute('y1', y(0).toFixed(1));
    zeroLine.setAttribute('y2', y(0).toFixed(1));

    for (let i = 0; i < pts.length; i++) screen.push([x(i), y(pts[i].net)]);
    const d = monotonePath(screen);
    linePath.setAttribute('d', d);
    areaPath.setAttribute(
      'd',
      `${d}L${screen[screen.length - 1][0].toFixed(2)} ${(VH - padB).toFixed(2)}L${screen[0][0].toFixed(2)} ${(VH - padB).toFixed(2)}Z`,
    );

    if (opts.showEv) {
      const evPts: Array<[number, number]> = pts.map((p, i) => [x(i), y(p.ev)]);
      evPath.setAttribute('d', monotonePath(evPts));
      evPath.setAttribute('opacity', '1');
    } else {
      evPath.setAttribute('opacity', '0');
    }

    const last = screen[screen.length - 1];
    endDot.setAttribute('cx', last[0].toFixed(2));
    endDot.setAttribute('cy', last[1].toFixed(2));
    endDot.setAttribute('opacity', '1');
    el.classList.toggle('is-down', pts[pts.length - 1].net < 0);
  };

  // ── scrubbing ──────────────────────────────────────────────────────
  const cursorLine = cursor.querySelector('.bc__cursorline') as SVGLineElement;
  const cursorDot = cursor.querySelector('.bc__dot') as SVGCircleElement;
  const cursorGlow = cursor.querySelector('.bc__dotglow') as SVGCircleElement;

  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

  const showAt = (clientX: number) => {
    if (screen.length < 2) return;
    const rect = svg.getBoundingClientRect();
    const t = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const vx = t * VW;
    // nearest by x in view space
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < screen.length; i++) {
      const dd = Math.abs(screen[i][0] - vx);
      if (dd < best) {
        best = dd;
        idx = i;
      }
    }
    const [sx, sy] = screen[idx];
    cursor.setAttribute('opacity', '1');
    cursorLine.setAttribute('x1', sx.toFixed(2));
    cursorLine.setAttribute('x2', sx.toFixed(2));
    cursorDot.setAttribute('cx', sx.toFixed(2));
    cursorDot.setAttribute('cy', sy.toFixed(2));
    cursorGlow.setAttribute('cx', sx.toFixed(2));
    cursorGlow.setAttribute('cy', sy.toFixed(2));

    const p = pts[idx];
    tipValue.textContent = opts.format(p.net);
    tipMeta.textContent = `${dateFmt.format(new Date(p.at))} · hand ${p.hand.toLocaleString('en-US')}`;
    tip.classList.toggle('is-neg', p.net < 0);
    tip.classList.add('is-on');
    // Flip the tooltip before it can run off either edge.
    const frac = sx / VW;
    tip.style.left = `${clamp(frac * 100, 14, 86)}%`;
    tip.style.transform = `translate3d(-50%,0,0)`;
    opts.onScrub?.(p);
  };

  const hide = () => {
    cursor.setAttribute('opacity', '0');
    tip.classList.remove('is-on');
    opts.onScrub?.(null);
  };

  let pid = -1;
  el.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    if (pts.length < 2) return;
    pid = e.pointerId;
    el.setPointerCapture(pid);
    haptic('tick');
    showAt(e.clientX);
  });
  el.addEventListener('pointermove', (ev) => {
    const e = ev as PointerEvent;
    if (e.pointerId !== pid) return;
    showAt(e.clientX);
  });
  const end = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerId !== pid) return;
    pid = -1;
    hide();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);

  el.setPoints = (next) => {
    pts = next;
    layout();
  };
  el.setPoints(opts.points);
  return el;
}

// ─────────────────────────── sparkline ───────────────────────────

export interface SparklineOpts {
  values: number[];
  width?: number;
  height?: number;
  tone?: 'good' | 'bad' | 'gold' | 'neutral';
  /** draw a baseline at zero */
  zero?: boolean;
  class?: ClassValue;
}

export function Sparkline(opts: SparklineOpts): SVGSVGElement {
  const w = opts.width ?? 64;
  const hh = opts.height ?? 22;
  const vals = opts.values.length ? opts.values : [0, 0];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (opts.zero !== false) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (hi - lo < 1e-9) {
    hi += 1;
    lo -= 1;
  }
  const pad = 2;
  const pts: Array<[number, number]> = vals.map((v, i) => [
    pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2),
    pad + (1 - (v - lo) / (hi - lo)) * (hh - pad * 2),
  ]);
  const d = monotonePath(pts);
  const zeroY = pad + (1 - (0 - lo) / (hi - lo)) * (hh - pad * 2);

  return h(
    'svg',
    {
      class: cx('spark', `spark--${opts.tone ?? 'neutral'}`, opts.class),
      attrs: { viewBox: `0 0 ${w} ${hh}`, width: w, height: hh, 'aria-hidden': 'true', focusable: 'false' },
    },
    opts.zero !== false
      ? h('line', { class: 'spark__zero', attrs: { x1: 0, x2: w, y1: zeroY.toFixed(1), y2: zeroY.toFixed(1) } })
      : null,
    h('path', { class: 'spark__area', attrs: { d: `${d}L${pts[pts.length - 1][0].toFixed(1)} ${hh}L${pts[0][0].toFixed(1)} ${hh}Z` } }),
    h('path', { class: 'spark__line', attrs: { d, fill: 'none' } }),
    h('circle', { class: 'spark__dot', attrs: { cx: pts[pts.length - 1][0].toFixed(1), cy: pts[pts.length - 1][1].toFixed(1), r: 1.9 } }),
  );
}

// ─────────────────────────── positional bars ───────────────────────────

export interface MiniBarsOpts {
  /** one entry per bar: label + signed value */
  bars: Array<{ label: string; value: number; sub?: string }>;
  format(n: number): string;
  class?: ClassValue;
}

/**
 * The positional strip: a signed bar per position, growing up or down from a
 * shared baseline so winning and losing seats are separable at a glance.
 */
export function MiniBars(opts: MiniBarsOpts): HTMLElement {
  const max = Math.max(1e-6, ...opts.bars.map((b) => Math.abs(b.value)));
  return h(
    'div',
    { class: cx('mbars', opts.class) },
    ...opts.bars.map((b) => {
      const frac = clamp(Math.abs(b.value) / max, 0.04, 1);
      const up = b.value >= 0;
      return h(
        'div',
        { class: cx('mbars__col', up ? 'is-up' : 'is-down'), title: `${b.label}: ${opts.format(b.value)}` },
        h('div', { class: 'mbars__track' },
          h('div', { class: 'mbars__half is-top' },
            up ? h('i', { class: 'mbars__bar', style: { height: `${(frac * 100).toFixed(1)}%` } }) : null),
          h('div', { class: 'mbars__mid', 'aria-hidden': 'true' }),
          h('div', { class: 'mbars__half is-bot' },
            up ? null : h('i', { class: 'mbars__bar', style: { height: `${(frac * 100).toFixed(1)}%` } })),
        ),
        h('span', { class: 'mbars__v tnum' }, opts.format(b.value)),
        h('span', { class: 'mbars__l' }, b.label),
        b.sub ? h('span', { class: 'mbars__s tnum' }, b.sub) : null,
      );
    }),
  );
}
