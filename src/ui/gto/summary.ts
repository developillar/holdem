/**
 * ROYALE — ui/gto/summary.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The end-of-session screen and its shareable result card.
 *
 * The card is deliberately over-built: a milled gold grade ring, a hairline
 * frame, and a foil sweep — this is the artefact a player screenshots, so it
 * has to survive being seen out of context. Everything on it is real: the
 * grade comes from `session.ts`, the leaks from the attempt log.
 */

import { h, cx } from '../dom.ts';
import { icon } from '../components/icons.ts';
import { Button } from '../components/button.ts';
import { RingProgress } from '../components/progress.ts';
import { toast } from '../components/toast.ts';
import { drillById } from '../../gto/drills.ts';
import type { SessionSummary } from '../../gto/session.ts';
import { shareText } from '../../gto/session.ts';

export interface SummaryOpts {
  summary: SessionSummary;
  onAgain(): void;
  onDone(): void;
}

export function SummaryPanel(opts: SummaryOpts): HTMLElement {
  const s = opts.summary;
  const def = drillById(s.drill);
  const minutes = Math.max(1, Math.round((s.endedAt - s.startedAt) / 60000));

  const ring = RingProgress({
    value: s.grade / 100,
    size: 132,
    stroke: 9,
    tone: s.grade >= 88 ? 'good' : s.grade >= 66 ? 'gold' : 'bad',
    center: h(
      'div',
      { class: 'ts-ring__c' },
      h('span', { class: 'ts-ring__n tnum' }, String(s.grade)),
      h('span', { class: 'ts-ring__l caps' }, s.gradeLabel),
    ),
  });

  const card = h(
    'div',
    { class: 'ts-card' },
    h('span', { class: 'ts-card__foil', 'aria-hidden': 'true' }),
    h('span', { class: 'ts-card__frame', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'ts-card__head' },
      h('span', { class: 'ts-card__brand caps' }, 'Royale Trainer'),
      h('h2', { class: 'ts-card__title' }, def?.name ?? s.drill),
      h('span', { class: 'ts-card__tier caps' }, s.tier),
    ),
    h('div', { class: 'ts-card__ring' }, ring),
    h(
      'div',
      { class: 'ts-card__stats' },
      bigStat(`${s.correct}/${s.hands}`, 'correct'),
      bigStat(`${Math.round(s.accuracy * 100)}%`, 'accuracy'),
      bigStat(`${s.evLostBb.toFixed(2)}`, 'bb lost'),
      bigStat(`${s.bestStreak}`, 'best streak'),
    ),
    h('div', { class: 'ts-card__foot' }, `${s.hands} spots · ${minutes} min`),
  );

  const leaks = h('div', { class: 'ts-leaks' });
  if (s.leaks.length) {
    leaks.appendChild(h('h3', { class: 'ts-h caps' }, 'Biggest leaks'));
    for (const leak of s.leaks) {
      leaks.appendChild(
        h(
          'div',
          { class: 'ts-leak' },
          h('span', { class: 'ts-leak__bar', style: { '--sev': String(Math.min(1, leak.severity)) } }),
          h(
            'div',
            { class: 'ts-leak__body' },
            h('div', { class: 'ts-leak__title' }, leak.title),
            h('div', { class: 'ts-leak__detail' }, leak.detail),
          ),
          h('div', { class: 'ts-leak__cost tnum' }, `−${leak.evLostBb.toFixed(2)}bb`),
        ),
      );
    }
  } else if (s.hands >= 4) {
    leaks.appendChild(
      h(
        'div',
        { class: 'ts-clean' },
        icon('shield', { size: 22 }),
        h('div', null,
          h('div', { class: 'ts-clean__t' }, 'No leak big enough to name'),
          h('div', { class: 'ts-clean__d' }, 'Nothing in this session repeated often enough to be a pattern. Play a longer set to find the small ones.')),
      ),
    );
  }

  const mistakes = h('div', { class: 'ts-mistakes' });
  if (s.mistakes.length) {
    mistakes.appendChild(h('h3', { class: 'ts-h caps' }, 'Hands to revisit'));
    for (const m of s.mistakes) {
      mistakes.appendChild(
        h(
          'div',
          { class: 'ts-mistake' },
          h('span', { class: 'ts-mistake__hand' }, m.detail.handLabel),
          h(
            'div',
            { class: 'ts-mistake__body' },
            h('span', { class: 'ts-mistake__line' },
              h('em', null, m.strategy.labels[m.chosen] ?? m.chosen),
              ' → ',
              h('strong', null, m.strategy.labels[m.optimal] ?? m.optimal)),
            h('span', { class: 'ts-mistake__cost tnum' }, `−${m.evLossBb.toFixed(2)}bb`),
          ),
        ),
      );
    }
  }

  return h(
    'section',
    { class: 'ts', 'aria-label': 'Session summary' },
    card,
    h(
      'div',
      { class: 'ts-share' },
      Button({
        label: 'Copy result',
        variant: 'secondary',
        icon: icon('copy', { size: 18 }),
        onTap: async () => {
          const text = shareText(s);
          try {
            const nav = navigator as Navigator & { share?: (d: { text: string }) => Promise<void> };
            if (nav.share) await nav.share({ text });
            else await navigator.clipboard.writeText(text);
            toast('Result copied', 'good');
          } catch {
            toast('Could not copy — long-press the card instead', 'info');
          }
        },
      }),
    ),
    leaks.childNodes.length ? leaks : null,
    mistakes.childNodes.length ? mistakes : null,
    h(
      'div',
      { class: 'ts-actions' },
      Button({ label: 'Run it again', variant: 'primary', full: true, onTap: opts.onAgain }),
      Button({ label: 'Back to drills', variant: 'ghost', full: true, onTap: opts.onDone }),
    ),
  );
}

function bigStat(value: string, label: string): HTMLElement {
  return h(
    'div',
    { class: cx('ts-stat') },
    h('span', { class: 'ts-stat__v tnum' }, value),
    h('span', { class: 'ts-stat__l caps' }, label),
  );
}
