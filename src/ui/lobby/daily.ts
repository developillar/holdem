/**
 * ROYALE — lobby/daily.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The streak strip. Seven day tiles that read at a glance: claimed ones are
 * stamped and quiet, today is a lifted gold slab that breathes, the rest are
 * dim but legible so you can see what you are playing toward. Day 7 is a
 * double-width jackpot tile — the payoff needs to look like one.
 *
 * State is real and persisted: a claim is stamped against the local calendar
 * day, a missed day resets the run, and the countdown to the next reward ticks
 * live. Claiming credits the balance through `econ:wallet`, fires confetti and
 * pops a toast, so the reward has weight.
 */
import { h } from '../dom.ts';
import { bus } from '../../core/bus.ts';
import { icon } from '../components/icons.ts';
import { haptic, pressFeedback } from '../components/util.ts';
import { fmtInt } from '../components/util.ts';
import { creditBankroll } from './bankroll.ts';

const KEY = 'royale.daily';

interface DailyState {
  /** day index 1..7 of the current run */
  day: number;
  /** local YYYYMMDD of the last claim, 0 when never claimed */
  lastClaim: number;
  /** total consecutive days, shown as the headline streak */
  streak: number;
  best: number;
}

export interface DailyEl extends HTMLElement {
  tick(): void;
  dispose(): void;
}

interface Reward {
  kind: 'chips' | 'gems' | 'ticket';
  amount: number;
  /**
   * The unit, shown in micro-caps under the value. Without it `12` and `500`
   * read as comparable magnitudes when one is gems and the other chips.
   */
  unit: string;
}

/**
 * One numeric convention across all seven tiles: grouped integers, no
 * abbreviation. The old row mixed `500`/`900`/`12`/`25` with `1.8K`/`3.5K`,
 * which made `900` optically outrank `1.8K` — it told the player the wrong
 * thing about which day pays more.
 */
const REWARDS: Reward[] = [
  { kind: 'chips', amount: 500, unit: 'chips' },
  { kind: 'chips', amount: 900, unit: 'chips' },
  { kind: 'gems', amount: 12, unit: 'gems' },
  { kind: 'chips', amount: 1800, unit: 'chips' },
  { kind: 'gems', amount: 25, unit: 'gems' },
  { kind: 'chips', amount: 3500, unit: 'chips' },
  { kind: 'ticket', amount: 1, unit: 'SNG ticket' },
];

/** "500 chips" / "1,800 chips" / "1 SNG ticket" — same formatter everywhere. */
function rewardText(r: Reward): string {
  return `${fmtInt(r.amount)} ${r.unit}`;
}

function localDayIndex(d = new Date()): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function load(): DailyState {
  const base: DailyState = { day: 1, lastClaim: 0, streak: 0, best: 0 };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<DailyState>;
    const out: DailyState = {
      day: typeof p.day === 'number' ? Math.min(7, Math.max(1, p.day)) : 1,
      lastClaim: typeof p.lastClaim === 'number' ? p.lastClaim : 0,
      streak: typeof p.streak === 'number' ? p.streak : 0,
      best: typeof p.best === 'number' ? p.best : 0,
    };
    // Missing a whole day breaks the run — restart at day one.
    const today = localDayIndex();
    const yesterday = localDayIndex(new Date(Date.now() - 86400_000));
    if (out.lastClaim && out.lastClaim !== today && out.lastClaim !== yesterday) {
      out.day = 1;
      out.streak = 0;
    }
    return out;
  } catch {
    return base;
  }
}

function save(s: DailyState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* memory only */
  }
}

function msUntilMidnight(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
  return next.getTime() - now.getTime();
}

function rewardGlyph(r: Reward, size: number): SVGSVGElement {
  if (r.kind === 'gems') return icon('gem', { size });
  if (r.kind === 'ticket') return icon('trophy', { size });
  return icon('chip', { size });
}

export function DailyStrip(): DailyEl {
  let state = load();

  const claimed = () => state.lastClaim === localDayIndex();

  const streakN = h('b', { class: 'tnum' }, String(state.streak));
  const streakWord = h('span', null, '-day streak');
  const countdown = h('span', { class: 'dl__count tnum' }, '');
  const tiles: HTMLElement[] = [];
  const track = h('div', { class: 'dl__track', role: 'list', 'aria-label': 'Seven-day reward run' });

  const cta = h(
    'button',
    { class: 'dl__cta', type: 'button' },
    h('span', { class: 'dl__ctagrain', 'aria-hidden': 'true' }),
    h('span', { class: 'dl__ctasheen', 'aria-hidden': 'true' }),
    h('span', { class: 'dl__ctat' }, 'Claim'),
  );
  pressFeedback(cta);

  const el = h(
    'section',
    { class: 'dl', 'aria-label': 'Daily reward' },
    h(
      'div',
      { class: 'dl__head' },
      h(
        'div',
        { class: 'dl__headl' },
        h('span', { class: 'dl__flame', 'aria-hidden': 'true' }, icon('flame', { size: 15, solid: true })),
        h('span', { class: 'dl__title' }, streakN, streakWord),
      ),
      countdown,
    ),
    track,
    cta,
  ) as DailyEl;

  for (let i = 0; i < 7; i++) {
    const r = REWARDS[i];
    const tile = h(
      'div',
      {
        class: `dl__tile${i === 6 ? ' dl__tile--jackpot' : ''}`,
        style: { '--i': String(i) },
        // Without a role the label is dropped by most AT; with it the tile
        // announces the pair rather than a bare "500".
        role: 'listitem',
        'aria-label': `Day ${i + 1} — ${rewardText(r)}`,
      },
      h('span', { class: 'dl__day caps' }, `Day ${i + 1}`),
      h('span', { class: 'dl__ic', 'aria-hidden': 'true' }, rewardGlyph(r, i === 6 ? 24 : 19)),
      h('span', { class: 'dl__amt tnum' }, fmtInt(r.amount)),
      h('span', { class: 'dl__unit' }, r.unit),
      h('span', { class: 'dl__stamp', 'aria-hidden': 'true' }, icon('check', { size: 14, stroke: 3.2 })),
    );
    tiles.push(tile);
    track.appendChild(tile);
  }

  // Which edge of the strip is still holding content back. The mask follows,
  // so the run never fades out at an edge you have already reached.
  let edgeQueued = false;
  const syncEdges = (): void => {
    if (edgeQueued) return;
    edgeQueued = true;
    requestAnimationFrame(() => {
      edgeQueued = false;
      const max = track.scrollWidth - track.clientWidth;
      if (max <= 1) {
        track.dataset.edge = 'end';
        return;
      }
      track.dataset.edge =
        track.scrollLeft <= 1 ? 'start' : track.scrollLeft >= max - 1 ? 'end' : 'mid';
    });
  };
  track.addEventListener('scroll', syncEdges, { passive: true });

  function paint(): void {
    const isClaimed = claimed();
    const activeIdx = state.day - 1;
    tiles.forEach((t, i) => {
      // `activeIdx` has already advanced past today's claim, so anything below
      // it is collected and the tile *at* it is tomorrow's — never both.
      t.classList.toggle('is-done', i < activeIdx);
      t.classList.toggle('is-today', i === activeIdx && !isClaimed);
      t.classList.toggle('is-next', i === activeIdx && isClaimed);
      t.classList.toggle('is-locked', i > activeIdx);
    });
    // A brand-new player has no streak to boast about — lead with the reward.
    if (state.streak > 0) {
      streakN.textContent = String(state.streak);
      streakN.hidden = false;
      streakWord.textContent = '-day streak';
    } else {
      streakN.hidden = true;
      streakWord.textContent = 'Daily reward';
    }
    el.classList.toggle('is-claimed', isClaimed);
    cta.classList.toggle('is-done', isClaimed);
    const r = REWARDS[Math.min(6, activeIdx)];
    cta.querySelector('.dl__ctat')!.textContent = isClaimed
      ? 'Claimed today'
      : `Claim day ${state.day} · ${rewardText(r)}`;
    cta.disabled = isClaimed;
    // Bring the active tile into view without yanking the page.
    const target = tiles[Math.min(6, activeIdx)];
    if (target) {
      const left = target.offsetLeft - track.clientWidth / 2 + target.offsetWidth / 2;
      track.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
    }
    syncEdges();
  }

  cta.addEventListener('click', () => {
    if (claimed()) return;
    const idx = Math.min(6, state.day - 1);
    const r = REWARDS[idx];
    haptic('big-win');

    state = {
      day: state.day >= 7 ? 1 : state.day + 1,
      lastClaim: localDayIndex(),
      streak: state.streak + 1,
      best: Math.max(state.best, state.streak + 1),
    };
    save(state);

    const tile = tiles[idx];
    tile.classList.remove('is-pop');
    void tile.offsetWidth;
    tile.classList.add('is-pop');

    if (r.kind === 'chips') creditBankroll(r.amount);
    bus.emit('fx:burst', { kind: 'confetti' });
    bus.emit('ui:toast', {
      text: `Day ${idx + 1} claimed — ${rewardText(r)}`,
      tone: 'epic',
      ms: 2600,
    });
    paint();
  });

  el.tick = () => {
    const ms = msUntilMidnight();
    const hrs = Math.floor(ms / 3600_000);
    const mins = Math.floor((ms % 3600_000) / 60_000);
    countdown.textContent = claimed()
      ? `Next in ${hrs}h ${mins.toString().padStart(2, '0')}m`
      : `Resets in ${hrs}h ${mins.toString().padStart(2, '0')}m`;
  };

  el.dispose = () => {
    track.removeEventListener('scroll', syncEdges);
  };

  paint();
  el.tick();
  // The track has no width until it is in the document; re-read the edges once
  // layout exists so the strip does not start life masked at both ends.
  requestAnimationFrame(syncEdges);
  return el;
}
