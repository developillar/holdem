/**
 * ROYALE — screens/stats.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The tracker, as a screen. It answers three questions in order: how am I
 * doing, why, and what should I fix.
 *
 *   summary      net, win rate, and the all-in adjusted line beside it
 *   chart        scrubbable bankroll curve with the EV line underneath
 *   overview     eight stat tiles, each with a healthy band and a leak hint
 *   positions    signed bars per seat plus the full table
 *   sessions     every session, newest first, with its own shape
 *   advanced     premium-gated depth, with an upsell that shows the goods
 *
 * The filters (variant, stake, range) apply to every tab at once, which is the
 * only behaviour that makes sense once you have more than one game type.
 */
import '../styles/stats.css';
import { bus } from '../../core/bus.ts';
import { STAKES } from '../../core/stakes.ts';
import type { GameVariant, StakeId, StatLine } from '../../core/types.ts';
import { h, clear, cx } from '../dom.ts';
import { Tabs } from '../components/tabs.ts';
import { Segmented } from '../components/segmented.ts';
import { Button } from '../components/button.ts';
import { Pill } from '../components/pill.ts';
import { icon } from '../components/icons.ts';
import { EmptyState } from '../components/empty.ts';
import { clamp, fmtInt, haptic, pressFeedback } from '../components/util.ts';
import {
  curveFor, dailyNet, leaksFor, onAnalytics, positionalFor, sessionsFor, stakesPlayed,
  statsFor, totalsFor, variantsPlayed, wireAnalytics,
} from '../../econ/analytics.ts';
import type { Leak, RangeKey, StatsFilter } from '../../econ/analytics.ts';
import { isPremium, onWallet } from '../../econ/wallet.ts';
import { BankrollChart, MiniBars, Sparkline } from '../econ/chart.ts';
import type { BankrollChartEl } from '../econ/chart.ts';

// ─────────────────────────── formatting ───────────────────────────

function cash(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  if (abs >= 1000) return `${sign}$${abs.toFixed(0)}`;
  if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function signedCash(n: number): string {
  return `${n >= 0 ? '+' : ''}${cash(n)}`.replace('+−', '−');
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

// ─────────────────────────── stat tile spec ───────────────────────────

interface TileSpec {
  key: keyof StatLine;
  label: string;
  format(s: StatLine): string;
  /** healthy band as [lo, hi] in the stat's own units */
  band: [number, number];
  /** axis for the band indicator */
  scale: [number, number];
  hint: string;
}

const TILE_SPECS: TileSpec[] = [
  { key: 'vpip', label: 'VPIP', format: (s) => pct(s.vpip), band: [0.2, 0.3], scale: [0, 0.5], hint: 'Hands you put money in with, preflop.' },
  { key: 'pfr', label: 'PFR', format: (s) => pct(s.pfr), band: [0.16, 0.24], scale: [0, 0.4], hint: 'Hands you raised first in with.' },
  { key: 'threeBet', label: '3-Bet', format: (s) => pct(s.threeBet), band: [0.06, 0.11], scale: [0, 0.2], hint: 'How often you re-raise an open.' },
  { key: 'foldToThreeBet', label: 'Fold to 3-bet', format: (s) => pct(s.foldToThreeBet), band: [0.4, 0.58], scale: [0.2, 0.9], hint: 'How often you give up to a re-raise.' },
  { key: 'af', label: 'Aggression', format: (s) => s.af.toFixed(2), band: [1.8, 3.2], scale: [0, 5], hint: 'Bets and raises for every call you make.' },
  { key: 'cbetFlop', label: 'C-Bet flop', format: (s) => pct(s.cbetFlop), band: [0.5, 0.72], scale: [0.2, 1], hint: 'Continuation bets after raising preflop.' },
  { key: 'wtsd', label: 'WTSD', format: (s) => pct(s.wtsd), band: [0.24, 0.31], scale: [0.1, 0.45], hint: 'How often you see a showdown after the flop.' },
  { key: 'wsd', label: 'W$SD', format: (s) => pct(s.wsd), band: [0.5, 0.58], scale: [0.3, 0.75], hint: 'How often you win when you get there.' },
];

// ─────────────────────────── screen ───────────────────────────

export interface StatsInstance {
  unmount(): void;
}

export function mount(container: HTMLElement): StatsInstance {
  const cleanups: Array<() => void> = [wireAnalytics()];

  const root = h('div', { class: 'sx scroll' });
  const aura = h('div', { class: 'sx__aura', 'aria-hidden': 'true' });
  const inner = h('div', { class: 'sx__inner' });
  root.append(aura, inner);
  container.appendChild(root);

  const filter: StatsFilter = { variant: 'all', stakeId: 'all', range: '90d' };
  let tab = 'overview';

  // ── header + summary ───────────────────────────────────────────────
  const netBig = h('div', { class: 'sx__net tnum' });
  const netSub = h('div', { class: 'sx__netsub' });
  const netSpark = h('div', { class: 'sx__netspark' });

  const header = h(
    'header',
    { class: 'sx__head sx__sec', style: { '--i': '0' } },
    h(
      'div',
      { class: 'sx__headrow' },
      h(
        'div',
        { class: 'sx__headtext' },
        h('span', { class: 'sx__eyebrow caps' }, 'Your results'),
        netBig,
        netSub,
      ),
      netSpark,
    ),
  );

  // ── filters ────────────────────────────────────────────────────────
  const variants = variantsPlayed();
  const variantSeg = Segmented({
    items: [
      { id: 'all', label: 'All' },
      ...variants.map((v) => ({ id: v, label: v === 'nlhe' ? 'NLHE' : 'PLO' })),
    ],
    value: 'all',
    size: 'sm',
    full: true,
    onChange: (id) => {
      filter.variant = id as GameVariant | 'all';
      repaint();
    },
  });

  const rangeSeg = Segmented({
    items: [
      { id: '7d', label: '7d' },
      { id: '30d', label: '30d' },
      { id: '90d', label: '90d' },
      { id: 'all', label: 'All' },
    ],
    value: '90d',
    size: 'sm',
    full: true,
    onChange: (id) => {
      filter.range = id as RangeKey;
      repaint();
    },
  });

  const stakeRail = h('div', { class: 'sx__stakes scroll' });
  const stakeChips = new Map<string, HTMLElement>();
  const buildStakes = () => {
    clear(stakeRail);
    stakeChips.clear();
    const ids: Array<StakeId | 'all'> = ['all', ...stakesPlayed()];
    for (const id of ids) {
      const chip = h(
        'button',
        { class: cx('sx__chip', id === filter.stakeId && 'is-on'), type: 'button' },
        id === 'all' ? 'All stakes' : STAKES[id].label,
      );
      pressFeedback(chip);
      chip.addEventListener('click', () => {
        filter.stakeId = id;
        haptic('tick');
        for (const [k, el] of stakeChips) el.classList.toggle('is-on', k === String(id));
        repaint();
      });
      stakeChips.set(String(id), chip);
      stakeRail.appendChild(chip);
    }
  };
  buildStakes();

  const filterSec = h(
    'section',
    { class: 'sx__filters sx__sec', style: { '--i': '1' } },
    h('div', { class: 'sx__filterrow' }, variantSeg, rangeSeg),
    stakeRail,
  );

  // ── chart ──────────────────────────────────────────────────────────
  let showEv = true;
  const chart: BankrollChartEl = BankrollChart({
    points: [],
    height: 196,
    format: (n) => cash(n),
    showEv: true,
    onScrub: (p) => {
      chartCaption.classList.toggle('is-scrub', !!p);
      if (p) {
        chartCaption.textContent = `Hand ${fmtInt(p.hand)} · ${signedCash(p.net)} · EV ${signedCash(p.ev)}`;
      } else {
        paintChartCaption();
      }
    },
  });
  const chartCaption = h('div', { class: 'sx__chartcap tnum' });

  const evToggle = h(
    'button',
    { class: 'sx__legend is-ev is-on', type: 'button', 'aria-pressed': 'true' },
    h('i', { class: 'sx__swatch', 'aria-hidden': 'true' }),
    h('span', null, 'All-in adjusted'),
  );
  evToggle.addEventListener('click', () => {
    showEv = !showEv;
    evToggle.classList.toggle('is-on', showEv);
    evToggle.setAttribute('aria-pressed', showEv ? 'true' : 'false');
    haptic('tick');
    rebuildChart();
  });

  const chartCard = h(
    'section',
    { class: 'sx__chartcard sx__sec', style: { '--i': '2' } },
    h('span', { class: 'sx__cardedge', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'sx__charthead' },
      h('span', { class: 'sx__cardtitle' }, 'Bankroll'),
      h(
        'div',
        { class: 'sx__legends' },
        h('span', { class: 'sx__legend is-net' }, h('i', { class: 'sx__swatch', 'aria-hidden': 'true' }), h('span', null, 'Actual')),
        evToggle,
      ),
    ),
    chart,
    chartCaption,
  );

  // ── tabs + panes ───────────────────────────────────────────────────
  const tabs = Tabs({
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'positions', label: 'Positions' },
      { id: 'sessions', label: 'Sessions' },
      { id: 'advanced', label: 'Advanced' },
    ],
    value: 'overview',
    ariaLabel: 'Statistics sections',
    onChange: (id) => {
      tab = id;
      paintPane();
    },
  });
  tabs.classList.add('sx__tabs');

  const pane = h('div', { class: 'sx__pane' });
  const paneSec = h('section', { class: 'sx__sec', style: { '--i': '3' } }, h('div', { class: 'sx__tabwrap' }, tabs), pane);

  inner.append(header, filterSec, chartCard, paneSec);
  requestAnimationFrame(() => inner.classList.add('is-in'));

  // ── painting ───────────────────────────────────────────────────────

  let chartRef: BankrollChartEl = chart;

  /**
   * The EV series is baked into the chart's layout, so toggling it swaps the
   * whole node rather than threading a second update path through it.
   */
  function rebuildChart(): void {
    const next = BankrollChart({
      points: curveFor(filter, 240),
      height: 196,
      format: (n) => cash(n),
      showEv,
      onScrub: (p) => {
        chartCaption.classList.toggle('is-scrub', !!p);
        if (p) chartCaption.textContent = `Hand ${fmtInt(p.hand)} · ${signedCash(p.net)} · EV ${signedCash(p.ev)}`;
        else paintChartCaption();
      },
    });
    chartRef.replaceWith(next);
    chartRef = next;
  }

  function paintChartCaption(): void {
    const t = totalsFor(filter);
    chartCaption.classList.remove('is-scrub');
    chartCaption.textContent = t.hands
      ? `${fmtInt(t.hands)} hands · ${fmtInt(t.sessions)} sessions · drag to scrub`
      : 'No hands in this range';
  }

  function paintSummary(): void {
    const line = statsFor(filter);
    const t = totalsFor(filter);
    netBig.textContent = signedCash(t.net);
    netBig.classList.toggle('is-up', t.net >= 0);
    netBig.classList.toggle('is-down', t.net < 0);
    clear(netSub);
    netSub.append(
      h('b', { class: 'tnum' }, `${line.winrateBb100 >= 0 ? '+' : '−'}${Math.abs(line.winrateBb100).toFixed(1)}`),
      h('span', null, ' bb/100'),
      h('i', { class: 'sx__dot', 'aria-hidden': 'true' }),
      h('span', { class: 'tnum' }, `${fmtInt(line.hands)} hands`),
    );
    clear(netSpark);
    const days = filter.range === '7d' ? 7 : filter.range === 'all' || filter.range === '90d' ? 30 : 14;
    const series = dailyNet(filter, days);
    let run = 0;
    const cum = series.map((v) => (run += v));
    netSpark.appendChild(
      Sparkline({ values: cum, width: 96, height: 40, tone: t.net >= 0 ? 'good' : 'bad' }),
    );
  }

  function bandTile(spec: TileSpec, line: StatLine, leak: Leak | null): HTMLElement {
    const raw = line[spec.key] as number;
    const [lo, hi] = spec.scale;
    const at = clamp((raw - lo) / Math.max(1e-6, hi - lo), 0, 1);
    const bandLo = clamp((spec.band[0] - lo) / Math.max(1e-6, hi - lo), 0, 1);
    const bandHi = clamp((spec.band[1] - lo) / Math.max(1e-6, hi - lo), 0, 1);
    const inBand = raw >= spec.band[0] && raw <= spec.band[1];
    return h(
      'div',
      { class: cx('sx__tile', inBand ? 'is-ok' : 'is-off', leak && `is-leak-${leak.severity}`) },
      h('span', { class: 'sx__tileedge', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'sx__tiletop' },
        h('span', { class: 'sx__tilel caps' }, spec.label),
        leak ? h('span', { class: 'sx__tileflag', title: leak.title }, icon('warning', { size: 12 })) : null,
      ),
      h('span', { class: 'sx__tilev tnum' }, spec.format(line)),
      h(
        'div',
        { class: 'sx__band' },
        h('i', { class: 'sx__bandzone', style: { left: `${(bandLo * 100).toFixed(1)}%`, width: `${((bandHi - bandLo) * 100).toFixed(1)}%` } }),
        h('i', { class: 'sx__bandmark', style: { left: `${(at * 100).toFixed(1)}%` } }),
      ),
      h('span', { class: 'sx__tilehint' }, leak ? leak.title : spec.hint),
    );
  }

  function paintOverview(): void {
    const line = statsFor(filter);
    if (!line.hands) {
      pane.appendChild(
        EmptyState({
          art: 'stats',
          title: 'Nothing in this range',
          body: 'Widen the filter, or take a seat and play an orbit — the tracker fills in from real hands.',
          actionLabel: 'Find a table',
          onAction: () => bus.emit('nav:route', { route: 'lobby' }),
        }),
      );
      return;
    }
    const leaks = leaksFor(line);
    const byStat = new Map<string, Leak>();
    for (const l of leaks) if (!byStat.has(l.stat)) byStat.set(l.stat, l);

    const grid = h('div', { class: 'sx__tiles' });
    for (const spec of TILE_SPECS) grid.appendChild(bandTile(spec, line, byStat.get(spec.key) ?? null));
    pane.appendChild(grid);

    if (leaks.length) {
      const leakSec = h(
        'div',
        { class: 'sx__leaks' },
        h(
          'div',
          { class: 'sx__sechead' },
          h('h3', { class: 'sx__sectitle' }, 'What to fix first'),
          Pill({ text: `${leaks.length}`, tone: 'bad', size: 'xs', numeric: true }),
        ),
        ...leaks.map((l) =>
          h(
            'div',
            { class: cx('sx__leak', `is-${l.severity}`) },
            h('span', { class: 'sx__leakedge', 'aria-hidden': 'true' }),
            h('span', { class: 'sx__leakic' }, icon(l.severity === 'high' ? 'warning' : 'info', { size: 16 })),
            h(
              'div',
              { class: 'sx__leaktext' },
              h('span', { class: 'sx__leakt' }, l.title),
              h('p', { class: 'sx__leakb' }, l.body),
            ),
          ),
        ),
        h(
          'button',
          {
            class: 'sx__leakcta',
            type: 'button',
            onclick: () => {
              haptic('tick');
              bus.emit('nav:route', { route: 'trainer' });
            },
          },
          icon('target', { size: 15 }),
          h('span', null, 'Drill these spots in the Trainer'),
          icon('chevron-right', { size: 14, stroke: 2.2 }),
        ),
      );
      pane.appendChild(leakSec);
    } else {
      pane.appendChild(
        h(
          'div',
          { class: 'sx__clean' },
          icon('shield', { size: 20 }),
          h('div', null,
            h('b', null, 'No obvious leaks.'),
            h('span', null, ' Every headline stat is inside its healthy band over this sample.'),
          ),
        ),
      );
    }
  }

  function paintPositions(): void {
    const rows = positionalFor(filter);
    const played = rows.filter((r) => r.hands > 0);
    if (!played.length) {
      pane.appendChild(EmptyState({ art: 'stats', title: 'No positional data yet', body: 'Positions fill in once you have played a few orbits.' }));
      return;
    }
    pane.appendChild(
      h(
        'div',
        { class: 'sx__poscard' },
        h('span', { class: 'sx__cardedge', 'aria-hidden': 'true' }),
        h('div', { class: 'sx__sechead' }, h('h3', { class: 'sx__sectitle' }, 'Win rate by seat'), h('span', { class: 'sx__seccap' }, 'bb/100')),
        MiniBars({
          bars: played.map((r) => ({ label: r.position, value: r.bb100 })),
          format: (n) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)),
        }),
      ),
    );

    const table = h(
      'div',
      { class: 'sx__table' },
      h(
        'div',
        { class: 'sx__trow is-head' },
        h('span', null, 'Seat'),
        h('span', { class: 'tnum' }, 'Hands'),
        h('span', { class: 'tnum' }, 'VPIP'),
        h('span', { class: 'tnum' }, 'PFR'),
        h('span', { class: 'tnum' }, 'bb/100'),
      ),
      ...played.map((r) =>
        h(
          'div',
          { class: 'sx__trow' },
          h('span', { class: 'sx__pos' }, r.position),
          h('span', { class: 'tnum' }, fmtInt(r.hands)),
          h('span', { class: 'tnum' }, pct(r.vpip)),
          h('span', { class: 'tnum' }, pct(r.pfr)),
          h('span', { class: cx('tnum', r.bb100 >= 0 ? 'is-up' : 'is-down') }, `${r.bb100 >= 0 ? '+' : '−'}${Math.abs(r.bb100).toFixed(1)}`),
        ),
      ),
    );
    pane.appendChild(table);
    pane.appendChild(
      h(
        'p',
        { class: 'sx__note' },
        icon('info', { size: 12.5 }),
        h('span', null, 'The blinds lose money by design — they post before they see a card. Judge them against each other, not against the button.'),
      ),
    );
  }

  function paintSessions(): void {
    const list = sessionsFor(filter).slice(0, 40);
    if (!list.length) {
      pane.appendChild(EmptyState({ art: 'cards', title: 'No sessions in range', body: 'Sessions appear here the moment you sit down.' }));
      return;
    }
    const dateFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
    const wrap = h('div', { class: 'sx__sessions' });
    for (const s of list) {
      let run = 0;
      const cum = s.curve.map((v) => (run += v));
      const row = h(
        'div',
        { class: cx('sx__session', s.net >= 0 ? 'is-up' : 'is-down') },
        h('span', { class: 'sx__sessedge', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'sx__sesstext' },
          h('span', { class: 'sx__sessd' }, dateFmt.format(new Date(s.startedAt))),
          h(
            'span',
            { class: 'sx__sessm' },
            `${STAKES[s.stakeId].label} · ${s.variant === 'plo4' ? 'PLO' : "Hold'em"}`,
          ),
          h('span', { class: 'sx__sesst tnum' }, `${timeFmt.format(new Date(s.startedAt))} · ${fmtInt(s.hands)} hands`),
        ),
        Sparkline({ values: cum.length > 1 ? cum : [0, 0], width: 72, height: 30, tone: s.net >= 0 ? 'good' : 'bad' }),
        h(
          'div',
          { class: 'sx__sessnet' },
          h('span', { class: 'sx__sessv tnum' }, signedCash(s.net)),
          h('span', { class: 'sx__sessbb tnum' }, `${((s.net / STAKES[s.stakeId].bb / Math.max(1, s.hands)) * 100).toFixed(1)} bb/100`),
        ),
      );
      wrap.appendChild(row);
    }
    pane.appendChild(wrap);
  }

  function paintAdvanced(): void {
    const line = statsFor(filter);
    const t = totalsFor(filter);
    if (!isPremium()) {
      const teaser = h(
        'div',
        { class: 'sx__gate' },
        h(
          'div',
          { class: 'sx__gatepreview', 'aria-hidden': 'true' },
          ...['All-in EV gap', 'Street-by-street aggression', 'Stake-by-stake comparison', 'Hourly rate & variance cone'].map((label, i) =>
            h(
              'div',
              { class: 'sx__gaterow', style: { '--i': String(i) } },
              h('span', null, label),
              h('span', { class: 'sx__gatebar' }, h('i', { style: { width: `${52 + i * 12}%` } })),
            ),
          ),
        ),
        h(
          'div',
          { class: 'sx__gatecard' },
          h('span', { class: 'sx__gateedge', 'aria-hidden': 'true' }),
          h('span', { class: 'sx__gateic' }, icon('lock', { size: 20 })),
          h('h3', { class: 'sx__gatet' }, 'Advanced analysis'),
          h(
            'p',
            { class: 'sx__gateb' },
            'Four deeper views: how far your results sit from all-in expectation, aggression split by street, a stake-by-stake comparison, and an hourly rate with a variance cone. Included with the Premium Pass.',
          ),
          Button({
            label: 'See Premium',
            variant: 'primary',
            size: 'md',
            full: true,
            icon: icon('crown', { size: 17, solid: true }),
            onTap: () => bus.emit('nav:route', { route: 'pass' }),
          }),
          h('span', { class: 'sx__gatenote' }, 'Cosmetics and analysis only — never a gameplay advantage.'),
        ),
      );
      pane.appendChild(teaser);
      return;
    }

    const gap = line.winrateBb100 - line.evBb100;
    const rows: Array<[string, string, string]> = [
      ['All-in adjusted', `${line.evBb100.toFixed(2)} bb/100`, gap >= 0 ? `Running ${Math.abs(gap).toFixed(2)} above` : `Running ${Math.abs(gap).toFixed(2)} below`],
      ['Realised', `${line.winrateBb100.toFixed(2)} bb/100`, `${fmtInt(line.hands)} hands`],
      ['Hourly', `${(t.hoursPlayed > 0 ? t.net / t.hoursPlayed : 0).toFixed(2)} / hr`, `${t.hoursPlayed.toFixed(1)} hours`],
      ['Best session', t.bestSession ? signedCash(t.bestSession.net) : '—', t.bestSession ? `${fmtInt(t.bestSession.hands)} hands` : ''],
      ['Worst session', t.worstSession ? signedCash(t.worstSession.net) : '—', t.worstSession ? `${fmtInt(t.worstSession.hands)} hands` : ''],
    ];
    pane.appendChild(
      h(
        'div',
        { class: 'sx__advcard' },
        h('span', { class: 'sx__cardedge', 'aria-hidden': 'true' }),
        h('div', { class: 'sx__sechead' }, h('h3', { class: 'sx__sectitle' }, 'Expectation'), Pill({ text: 'Premium', tone: 'gold', size: 'xs', caps: true })),
        ...rows.map(([k, v, s]) =>
          h('div', { class: 'sx__advrow' },
            h('span', { class: 'sx__advk' }, k),
            h('span', { class: 'sx__advv tnum' }, v),
            h('span', { class: 'sx__advs' }, s),
          ),
        ),
      ),
    );

    // Aggression by street, derived from the same counters the tiles use.
    const streets: Array<[string, number]> = [
      ['Preflop', line.pfr],
      ['Flop', line.cbetFlop],
      ['Turn', clamp(line.af / 6, 0, 1)],
      ['River', clamp(line.wtsd, 0, 1)],
    ];
    pane.appendChild(
      h(
        'div',
        { class: 'sx__advcard' },
        h('span', { class: 'sx__cardedge', 'aria-hidden': 'true' }),
        h('div', { class: 'sx__sechead' }, h('h3', { class: 'sx__sectitle' }, 'Aggression by street')),
        ...streets.map(([name, v]) =>
          h('div', { class: 'sx__streetrow' },
            h('span', { class: 'sx__streetl' }, name),
            h('span', { class: 'sx__streettrack' }, h('i', { style: { transform: `scaleX(${clamp(v, 0, 1).toFixed(3)})` } })),
            h('span', { class: 'sx__streetv tnum' }, pct(clamp(v, 0, 1))),
          ),
        ),
      ),
    );
  }

  function paintPane(): void {
    clear(pane);
    pane.classList.remove('is-in');
    if (tab === 'overview') paintOverview();
    else if (tab === 'positions') paintPositions();
    else if (tab === 'sessions') paintSessions();
    else paintAdvanced();
    requestAnimationFrame(() => pane.classList.add('is-in'));
  }

  function repaint(): void {
    paintSummary();
    chartRef.setPoints(curveFor(filter, 240));
    paintChartCaption();
    paintPane();
  }

  repaint();

  cleanups.push(onAnalytics(() => repaint()));
  cleanups.push(onWallet((_, why) => {
    if (why === 'premium' && tab === 'advanced') paintPane();
  }));

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      aura.style.transform = `translate3d(0,${(root.scrollTop * -0.18).toFixed(1)}px,0)`;
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
          console.error('[stats] cleanup failed', err);
        }
      }
      clear(root);
      root.remove();
    },
  };
}
