/**
 * ROYALE — screens/trainer.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The GTO trainer.
 *
 *   DRILLS    twelve trainable nodes, each with a mastery ring and a spaced
 *             repetition queue that brings back what you got wrong
 *   DRILL     a focused mini-table, your hand, and the action buttons; commit
 *             and the verdict animates in over the frequency board
 *   RANGES    the 13×13 viewer over every stored preflop solution
 *   REVIEW    a hand replay scored decision by decision
 *
 * Everything numeric on this screen — every frequency, every EV, every range
 * percentage — is produced by `src/gto/*`. Nothing is computed in the view.
 */

import '../styles/trainer.css';
import { bus } from '../../core/bus.ts';
import { h, cx, clear, on } from '../dom.ts';
import { Button, IconButton } from '../components/button.ts';
import { Segmented } from '../components/segmented.ts';
import { Tabs } from '../components/tabs.ts';
import { icon } from '../components/icons.ts';
import { RingProgress } from '../components/progress.ts';
import { Toggle } from '../components/toggle.ts';
import { haptic, reduceMotion } from '../components/util.ts';
import { DRILLS, TIERS, TIER_LABEL, drillById, grade, handLabelOf, spotRangeLayers } from '../../gto/drills.ts';
import type { DrillDef, DrillId, RangeLayer, Spot, Tier, Verdict } from '../../gto/drills.ts';
import {
  loadProfile, masteryOf, onProfile, recommendation, repeatCount, startSession, statsFor, totalHands,
} from '../../gto/session.ts';
import type { Session, SessionSummary } from '../../gto/session.ts';
import { handIndex, rangeCatalog } from '../../gto/ranges.ts';
import type { NamedRange } from '../../gto/ranges.ts';
import { CardRow } from '../gto/cards.ts';
import { ActionLog, MiniTable } from '../gto/minitable.ts';
import { DrillCard } from '../gto/drillcard.ts';
import { VerdictPanel } from '../gto/verdict.ts';
import { RangeView } from '../gto/rangegrid.ts';
import { SummaryPanel } from '../gto/summary.ts';
import { ReviewPanel } from '../gto/review.ts';

type View = 'home' | 'drill' | 'summary' | 'ranges' | 'review';
type HomeTab = 'drills' | 'ranges' | 'review';

const TIMER_KEY = 'royale.trainer.timer';
const TIMER_MS = 22000;

export interface TrainerInstance {
  unmount(): void;
}

export function mount(container: HTMLElement): TrainerInstance {
  return mountScreen(container);
}

function mountScreen(container: HTMLElement): TrainerInstance {
  const cleanups: Array<() => void> = [];
  const root = h('div', { class: 'tr scroll' });
  const aura = h('div', { class: 'tr__aura', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'tr__stage' });
  root.append(aura, stage);
  container.appendChild(root);

  let view: View = 'home';
  let homeTab: HomeTab = 'drills';
  let tier: Tier = 'core';
  let session: Session | null = null;
  let spot: Spot | null = null;
  let lastVerdict: Verdict | null = null;
  let timerOn = readTimerPref();
  let timerRaf = 0;
  let timerStart = 0;
  let answered = false;

  cleanups.push(onProfile(() => {
    if (view === 'home') renderHome();
  }, false));

  // ═══════════════════ shell helpers ═══════════════════

  function swap(node: Node): void {
    clear(stage);
    stage.appendChild(node);
    root.scrollTop = 0;
    if (!reduceMotion()) {
      (node as HTMLElement).classList?.add('tr-enter');
      window.setTimeout(() => (node as HTMLElement).classList?.remove('tr-enter'), 380);
    }
  }

  function topBar(title: string, sub: string, onBack: () => void, right?: Node): HTMLElement {
    return h(
      'header',
      { class: 'tr-top' },
      IconButton({
        icon: icon('chevron-left', { size: 20, stroke: 2 }),
        ariaLabel: 'Back',
        onTap: onBack,
        size: 40,
      }),
      h('div', { class: 'tr-top__text' },
        h('span', { class: 'tr-top__sub caps' }, sub),
        h('h1', { class: 'tr-top__title' }, title)),
      right ? h('div', { class: 'tr-top__right' }, right) : h('span', { class: 'tr-top__spacer' }),
    );
  }

  // ═══════════════════ home ═══════════════════

  function renderHome(): void {
    view = 'home';
    stopTimer();
    const profile = loadProfile();
    const hands = totalHands();
    const due = repeatCount();
    const rec = recommendation();
    const recDef = drillById(rec.drill);

    const overallMastery = DRILLS.reduce((a, d) => a + masteryOf(d.id), 0) / DRILLS.length;

    const hero = h(
      'header',
      { class: 'tr-hero' },
      h('div', { class: 'tr-hero__ring' }, RingProgress({
        value: overallMastery,
        size: 76,
        stroke: 6,
        tone: overallMastery >= 0.7 ? 'good' : 'gold',
        center: h('div', { class: 'tr-hero__ringc' },
          h('span', { class: 'tr-hero__ringn tnum' }, `${Math.round(overallMastery * 100)}`),
          h('span', { class: 'tr-hero__ringl caps' }, 'mastery')),
      })),
      h('div', { class: 'tr-hero__text' },
        h('span', { class: 'tr-hero__eyebrow caps' }, 'GTO Trainer'),
        h('h1', { class: 'tr-hero__title' }, 'Fix one leak at a time'),
        h('div', { class: 'tr-hero__stats' },
          heroStat(`${hands}`, 'spots'),
          heroStat(`${profile.bestStreak}`, 'best streak'),
          heroStat(`${profile.totalEvLostBb.toFixed(1)}`, 'bb lost'))),
    );

    const recBanner = h(
      'button',
      {
        class: 'tr-rec',
        type: 'button',
        onclick: () => startDrill(rec.drill),
      },
      h('span', { class: 'tr-rec__sheen', 'aria-hidden': 'true' }),
      h('span', { class: 'tr-rec__ic' }, icon(due > 0 ? 'refresh' : 'target', { size: 20 })),
      h('div', { class: 'tr-rec__body' },
        h('span', { class: 'tr-rec__k caps' }, due > 0 ? `${due} spots to review` : 'Play next'),
        h('span', { class: 'tr-rec__t' }, recDef?.name ?? 'Preflop RFI'),
        h('span', { class: 'tr-rec__d' }, rec.reason)),
      h('span', { class: 'tr-rec__go' }, icon('chevron-right', { size: 18 })),
    );

    const tabs = Tabs({
      items: [
        { id: 'drills', label: 'Drills' },
        { id: 'ranges', label: 'Ranges' },
        { id: 'review', label: 'Review' },
      ],
      value: homeTab,
      variant: 'pill',
      onChange: (id) => {
        homeTab = id as HomeTab;
        renderHomeBody();
      },
    });

    const body = h('div', { class: 'tr-home__body' });
    const page = h('div', { class: 'tr-home' }, hero, recBanner, tabs, body);
    swap(page);

    function renderHomeBody(): void {
      clear(body);
      if (homeTab === 'drills') body.appendChild(drillList());
      else if (homeTab === 'ranges') body.appendChild(rangeBrowser());
      else body.appendChild(reviewIntro());
    }
    renderHomeBody();
  }

  function heroStat(value: string, label: string): HTMLElement {
    return h('div', { class: 'tr-hero__stat' },
      h('span', { class: 'tr-hero__statv tnum' }, value),
      h('span', { class: 'tr-hero__statl caps' }, label));
  }

  function drillList(): HTMLElement {
    const wrap = h('div', { class: 'tr-drills' });
    const groups: Array<DrillDef['category']> = ['Preflop', 'Postflop', 'Tournament'];
    for (const group of groups) {
      const items = DRILLS.filter((d) => d.category === group);
      if (!items.length) continue;
      wrap.appendChild(h('h2', { class: 'tr-grouph caps' }, group));
      const list = h('div', { class: 'tr-drills__list' });
      for (const def of items) {
        list.appendChild(
          DrillCard({
            def,
            stats: statsFor(def.id),
            mastery: masteryOf(def.id),
            due: repeatCount(def.id),
            onTap: () => startDrill(def.id),
          }),
        );
      }
      wrap.appendChild(list);
    }
    return wrap;
  }

  // ═══════════════════ range browser ═══════════════════

  let catalog: NamedRange[] | null = null;

  function rangeBrowser(): HTMLElement {
    if (!catalog) catalog = rangeCatalog();
    const groups = Array.from(new Set(catalog.map((r) => r.group)));
    let activeGroup = groups[0];
    let active = catalog.find((r) => r.group === activeGroup)!;

    const chips = h('div', { class: 'tr-chips scroll-x' });
    const listEl = h('div', { class: 'tr-rangelist' });
    const viewEl = h('div', { class: 'tr-rangeview' });

    const paintList = (): void => {
      clear(listEl);
      for (const r of catalog!.filter((x) => x.group === activeGroup)) {
        const btn = h(
          'button',
          {
            class: cx('tr-rangeitem', r.id === active.id && 'is-on'),
            type: 'button',
            onclick: () => {
              active = r;
              paintList();
              paintView();
              haptic('tick');
            },
          },
          h('span', { class: 'tr-rangeitem__l' }, r.label),
          h('span', { class: 'tr-rangeitem__d' }, r.detail),
        );
        listEl.appendChild(btn);
      }
    };

    const paintView = (): void => {
      clear(viewEl);
      const layers: RangeLayer[] = [{ action: 'main', label: active.label, grid: active.build(), tone: 'aggro' }];
      viewEl.appendChild(
        h('div', { class: 'tr-rangeview__head' },
          h('h3', { class: 'tr-rangeview__t' }, active.label),
          h('span', { class: 'tr-rangeview__d' }, active.detail)),
      );
      viewEl.appendChild(RangeView({ layers }));
    };

    for (const g of groups) {
      chips.appendChild(
        h(
          'button',
          {
            class: cx('tr-chip', g === activeGroup && 'is-on'),
            type: 'button',
            onclick: (ev: Event) => {
              activeGroup = g;
              active = catalog!.find((r) => r.group === g)!;
              for (const c of Array.from(chips.children)) c.classList.remove('is-on');
              (ev.currentTarget as HTMLElement).classList.add('is-on');
              paintList();
              paintView();
            },
          },
          g,
        ),
      );
    }

    paintList();
    paintView();
    return h('div', { class: 'tr-browser' }, chips, listEl, viewEl);
  }

  function reviewIntro(): HTMLElement {
    return h(
      'div',
      { class: 'tr-reviewintro' },
      h('div', { class: 'tr-reviewintro__art', 'aria-hidden': 'true' },
        icon('eye', { size: 30, stroke: 1.5 })),
      h('h2', { class: 'tr-reviewintro__t' }, 'Review my play'),
      h('p', { class: 'tr-reviewintro__d' },
        'Take a hand apart street by street. Every decision is re-solved against the range your opponent actually got to that point with, and scored the same way the drills are.'),
      Button({
        label: 'Review a hand',
        variant: 'primary',
        full: true,
        icon: icon('cards', { size: 18 }),
        onTap: () => renderReview(),
      }),
    );
  }

  function renderReview(): void {
    view = 'review';
    const page = h('div', { class: 'tr-page' },
      topBar('Line review', 'Hand history', () => renderHome()),
      ReviewPanel({ onBack: () => renderHome() }));
    swap(page);
  }

  // ═══════════════════ drill ═══════════════════

  function startDrill(id: DrillId): void {
    const def = drillById(id);
    if (!def) return;
    tier = def.tier;
    session = startSession(id, tier);
    nextSpot();
  }

  function nextSpot(): void {
    if (!session) return;
    spot = session.next();
    lastVerdict = null;
    answered = false;
    renderDrill();
  }

  function renderDrill(): void {
    if (!session || !spot) return;
    view = 'drill';
    const s = spot;
    const def = drillById(session.drill)!;
    const state = session.state();

    const timerRing = RingProgress({ value: 1, size: 34, stroke: 3, tone: 'gold' });
    const head = h(
      'header',
      { class: 'tr-dhead' },
      IconButton({
        icon: icon('chevron-left', { size: 20, stroke: 2 }),
        ariaLabel: 'End drill',
        onTap: () => endSession(),
        size: 40,
      }),
      h('div', { class: 'tr-dhead__text' },
        h('span', { class: 'tr-dhead__sub caps' }, `${TIER_LABEL[tier]} · spot ${state.handsPlayed + 1}`),
        h('h1', { class: 'tr-dhead__title' }, def.name)),
      h('div', { class: 'tr-dhead__right' },
        state.streak > 0
          ? h('div', { class: 'tr-streak' },
              icon('flame', { size: 14, solid: true }),
              h('span', { class: 'tnum' }, String(state.streak)))
          : null,
        timerOn ? timerRing : null),
    );

    const tierSeg = Segmented({
      items: TIERS.map((t) => ({ id: t, label: TIER_LABEL[t] })),
      value: tier,
      size: 'sm',
      full: true,
      onChange: (id) => {
        tier = id as Tier;
        if (session) session = startSession(session.drill, tier);
        nextSpot();
      },
    });

    const table = MiniTable(s);
    const prompt = h('div', { class: 'tr-prompt' },
      h('div', { class: 'tr-prompt__t' }, s.prompt),
      h('div', { class: 'tr-prompt__d' }, s.subPrompt));

    const hand = h('div', { class: 'tr-hand' },
      h('span', { class: 'tr-hand__label caps' }, 'Your hand'),
      CardRow(s.hero, { size: s.hero.length > 2 ? 'md' : 'lg' }),
      h('span', { class: 'tr-hand__name' }, handLabelOf(s)));

    const bar = h('div', { class: cx('tr-bar', s.actions.length > 3 && 'is-grid') });
    let seenBet = false;
    for (const action of s.actions) {
      const big = (action.kind === 'bet' || action.kind === 'raise') && seenBet;
      if (action.kind === 'bet' || action.kind === 'raise') seenBet = true;
      bar.appendChild(
        h(
          'button',
          {
            class: cx('tr-act', `is-${action.kind}`, big && 'is-big'),
            type: 'button',
            onclick: () => commit(action.id),
          },
          h('span', { class: 'tr-act__sheen', 'aria-hidden': 'true' }),
          h('span', { class: 'tr-act__l' }, action.label),
          action.sub ? h('span', { class: 'tr-act__s tnum' }, action.sub) : null,
        ),
      );
    }

    const solving = h('div', { class: 'tr-solving' },
      h('span', { class: 'tr-solving__spin', 'aria-hidden': 'true' }),
      h('span', null, 'Solving…'));

    const settings = h('div', { class: 'tr-dsettings' },
      h('span', { class: 'tr-dsettings__l' }, 'Decision timer'),
      Toggle({
        on: timerOn,
        ariaLabel: 'Decision timer',
        onChange: (v) => {
          timerOn = v;
          writeTimerPref(v);
          renderDrill();
        },
      }));

    const slot = h('div', { class: 'tr-slot' }, bar, settings);
    const page = h('div', { class: 'tr-page tr-drill' },
      head, tierSeg, prompt, table, ActionLog(s), hand, slot);
    swap(page);

    if (timerOn) startTimer(timerRing, () => commit(s.actions[0].id, true));

    function commit(actionId: string, timedOut = false): void {
      if (answered || !session || !spot) return;
      answered = true;
      stopTimer();
      haptic('bet');
      clear(slot);
      slot.appendChild(solving);
      // Give the press animation a frame, then solve. Postflop nodes run a
      // Monte Carlo, so this is real work — 40–150ms — not a fake delay.
      window.setTimeout(() => {
        const current = spot!;
        const verdict = grade(current, actionId);
        lastVerdict = verdict;
        session!.record(current, verdict);
        renderVerdict(verdict, timedOut);
      }, 24);
    }
  }

  function renderVerdict(verdict: Verdict, timedOut: boolean): void {
    if (!session || !spot) return;
    const s = spot;
    const state = session.state();
    const def = drillById(session.drill)!;

    const head = h(
      'header',
      { class: 'tr-dhead' },
      IconButton({
        icon: icon('chevron-left', { size: 20, stroke: 2 }),
        ariaLabel: 'End drill',
        onTap: () => endSession(),
        size: 40,
      }),
      h('div', { class: 'tr-dhead__text' },
        h('span', { class: 'tr-dhead__sub caps' }, `${state.handsPlayed} played · ${Math.round((state.handsPlayed ? state.totalScore / state.handsPlayed : 0) * 100)}% score`),
        h('h1', { class: 'tr-dhead__title' }, def.name)),
      h('div', { class: 'tr-dhead__right' },
        Button({ label: 'Finish', variant: 'ghost', size: 'sm', onTap: () => endSession() })),
    );

    const panel = VerdictPanel({
      spot: s,
      verdict,
      streak: state.streak,
      repeat: session.wasRepeat(),
      onNext: () => nextSpot(),
      onRanges: verdict.detail.layers.length ? () => renderSpotRanges(s) : undefined,
    });

    const page = h('div', { class: 'tr-page tr-drill is-verdict' },
      head,
      timedOut ? h('div', { class: 'tr-timeout' }, icon('clock', { size: 15 }), 'Time expired — folded for you') : null,
      panel);
    swap(page);
    requestAnimationFrame(() => panel.reveal());
  }

  function renderSpotRanges(s: Spot): void {
    view = 'ranges';
    const layers = spotRangeLayers(s);
    const mark = s.hero.length === 2 ? handIndex(s.hero[0], s.hero[1]) : -1;
    const page = h(
      'div',
      { class: 'tr-page' },
      topBar(drillById(s.drill)?.name ?? 'Range', 'Solution', () => {
        if (lastVerdict) renderVerdict(lastVerdict, false);
        else renderHome();
      }),
      h('div', { class: 'tr-rangeview__head' },
        h('h3', { class: 'tr-rangeview__t' }, s.prompt),
        h('span', { class: 'tr-rangeview__d' }, s.subPrompt)),
      RangeView({ layers, highlight: mark, selected: mark }),
    );
    swap(page);
  }

  function endSession(): void {
    if (!session) {
      renderHome();
      return;
    }
    const state = session.state();
    if (state.handsPlayed === 0) {
      session = null;
      renderHome();
      return;
    }
    const summary = session.end();
    renderSummary(summary);
  }

  function renderSummary(summary: SessionSummary): void {
    view = 'summary';
    stopTimer();
    const drill = summary.drill;
    const page = h(
      'div',
      { class: 'tr-page' },
      topBar('Session', drillById(drill)?.name ?? 'Trainer', () => {
        session = null;
        renderHome();
      }),
      SummaryPanel({
        summary,
        onAgain: () => {
          session = startSession(drill, summary.tier);
          nextSpot();
        },
        onDone: () => {
          session = null;
          renderHome();
        },
      }),
    );
    swap(page);
    if (summary.grade >= 88) bus.emit('fx:burst', { kind: 'confetti' });
  }

  // ═══════════════════ timer ═══════════════════

  function startTimer(ring: ReturnType<typeof RingProgress>, onExpire: () => void): void {
    stopTimer();
    timerStart = performance.now();
    const step = (now: number) => {
      const left = 1 - (now - timerStart) / TIMER_MS;
      if (left <= 0) {
        ring.set(0, 'bad');
        timerRaf = 0;
        onExpire();
        return;
      }
      ring.set(left, left < 0.25 ? 'bad' : left < 0.5 ? 'gold' : 'good');
      timerRaf = requestAnimationFrame(step);
    };
    timerRaf = requestAnimationFrame(step);
  }

  function stopTimer(): void {
    if (timerRaf) cancelAnimationFrame(timerRaf);
    timerRaf = 0;
  }

  // ═══════════════════ boot ═══════════════════

  renderHome();

  const offVisibility = on(document, 'visibilitychange', () => {
    if (document.hidden) stopTimer();
  });
  cleanups.push(offVisibility);

  return {
    unmount() {
      stopTimer();
      for (const fn of cleanups) fn();
      root.remove();
    },
  };
}

function readTimerPref(): boolean {
  try {
    return localStorage.getItem(TIMER_KEY) === '1';
  } catch {
    return false;
  }
}

function writeTimerPref(on: boolean): void {
  try {
    localStorage.setItem(TIMER_KEY, on ? '1' : '0');
  } catch {
    // Private mode: the preference simply does not persist.
  }
}
