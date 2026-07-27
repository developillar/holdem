/**
 * ROYALE — screens/pass.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The Premium Pass. Two lanes, fifty tiers, one horizontally scrolling track
 * that opens centred on where you actually are.
 *
 *   season header      name, tagline, and a countdown that is a real deadline
 *   tier card          the current tier, the xp bar to the next one, claim-all
 *   track              free lane on top, premium lane below, marker between
 *   upsell             only when you do not have it, and it states the numbers
 *   challenges         daily and weekly, with progress rings and one-tap claim
 *
 * Order matters: the reward track sits ABOVE the upsell so the first screenful
 * is the art you are playing for, not a pricing panel. A pass screen that opens
 * on a paywall is a store; one that opens on the rewards is a pass.
 *
 * The upsell is deliberately not predatory: it itemises exactly what the
 * premium lane contains rather than quoting an invented "value", says plainly
 * that upgrading back-pays every tier already passed, and never blocks the
 * free lane behind a modal. It states each fact exactly once — the tally owns
 * the quantities, the two ticks own the terms, the footer owns the legal line.
 */
import '../styles/store.css';
import { bus } from '../../core/bus.ts';
import type { PassReward } from '../../core/types.ts';
import { h, clear, cx } from '../dom.ts';
import { Button } from '../components/button.ts';
import { Segmented } from '../components/segmented.ts';
import { RingProgress } from '../components/progress.ts';
import { Pill } from '../components/pill.ts';
import { icon } from '../components/icons.ts';
import { fmtInt, haptic, pressFeedback, reduceMotion } from '../components/util.ts';
import { itemById } from '../../data/catalog.ts';
import { onWallet } from '../../econ/wallet.ts';
import {
  MAX_TIER, PASS_OFFERS, TIERS, buyPass, challenges, claimAll, claimAllChallenges,
  claimChallenge, claimTier, countdown, isClaimed, onPass, passState, trackContents,
  seasonProgress, seedPassIfEmpty, wirePassToPlay,
} from '../../econ/pass.ts';
import type { ChallengeView, PassOffer, PassSnapshot } from '../../econ/pass.ts';
import { previewNode } from '../econ/preview.ts';
import { openItemSheet } from '../econ/detail.ts';

// ─────────────────────────── reward chips ───────────────────────────

function rewardArt(reward: PassReward, size: number): Node {
  if (reward.kind === 'cosmetic' && reward.itemId) {
    const item = itemById(reward.itemId);
    if (item) {
      return previewNode(item, {
        size: item.kind === 'table-skin' || item.kind === 'felt' ? size * 0.86 : size,
      });
    }
  }
  const glyph =
    reward.kind === 'gems' ? icon('gem', { size: size * 0.46 })
      : reward.kind === 'ticket' ? icon('trophy', { size: size * 0.46 })
        : icon('chip', { size: size * 0.46 });
  return h(
    'span',
    { class: cx('ps__cur', `is-${reward.kind}`) },
    glyph,
    h('b', { class: 'tnum' }, reward.kind === 'ticket' ? '×1' : fmtInt(reward.amount ?? 0)),
  );
}

function rewardLabel(reward: PassReward): string {
  return reward.label;
}

// ─────────────────────────── screen ───────────────────────────

export interface PassInstance {
  unmount(): void;
}

export function mount(container: HTMLElement): PassInstance {
  seedPassIfEmpty();
  const cleanups: Array<() => void> = [wirePassToPlay()];

  const root = h('div', { class: 'ps scroll' });
  const aura = h('div', { class: 'ps__aura', 'aria-hidden': 'true' });
  const inner = h('div', { class: 'ps__inner' });
  root.append(aura, inner);
  container.appendChild(root);

  let snap: PassSnapshot = passState();

  // ── count-up ───────────────────────────────────────────────────────
  /**
   * Every numeral on this screen already carries `.tnum`, so the advance width
   * is locked and a rolling number cannot reflow. That infrastructure was built
   * and unused: the arrival of the numbers is now the reward moment, in place
   * of the idle pulses that used to run whether or not anyone was looking.
   *
   * Each ramp starts behind its own section's 38ms `ecIn` stagger so the digits
   * settle just after the card they live in has landed.
   */
  const timers = new Set<number>();
  const frames = new Set<number>();

  function rampTo(from: number, to: number, delayMs: number, render: (v: number) => void): void {
    if (reduceMotion() || from === to) {
      render(to);
      return;
    }
    render(from);
    const begin = (): void => {
      const t0 = performance.now();
      let handle = 0;
      const tick = (now: number): void => {
        frames.delete(handle);
        const t = Math.min(1, (now - t0) / 600);
        // the tail of --ease-out: fast out of the gate, glides into the value
        render(from + (to - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) {
          handle = requestAnimationFrame(tick);
          frames.add(handle);
        }
      };
      handle = requestAnimationFrame(tick);
      frames.add(handle);
    };
    if (delayMs <= 0) {
      begin();
      return;
    }
    const id = window.setTimeout(() => {
      timers.delete(id);
      begin();
    }, delayMs);
    timers.add(id);
  }

  cleanups.push(() => {
    for (const id of timers) clearTimeout(id);
    for (const f of frames) cancelAnimationFrame(f);
    timers.clear();
    frames.clear();
  });

  // ── season header ──────────────────────────────────────────────────
  const timeEl = h('b', { class: 'tnum' }, countdown(snap.season.endsAt).label);
  const seasonBar = h('i', { class: 'ps__seasonfill' });

  const header = h(
    'header',
    { class: 'ps__head ps__sec', style: { '--i': '0' } },
    h(
      'div',
      { class: 'ps__headtop' },
      h('span', { class: 'ps__eyebrow caps' }, `Season ${snap.season.number}`),
      h('span', { class: 'ps__clock' }, icon('clock', { size: 13 }), timeEl, h('span', null, 'left')),
    ),
    h('h1', { class: 'ps__title' }, snap.season.name),
    h('p', { class: 'ps__tagline' }, snap.season.tagline),
    h('div', { class: 'ps__seasontrack' }, seasonBar),
  );

  // ── tier card ──────────────────────────────────────────────────────
  const tierNum = h('b', { class: 'ps__tiern tnum' }, String(snap.tier));
  const tierRing = RingProgress({ value: snap.pct, size: 76, stroke: 5, tone: 'gold', center: tierNum });
  const xpFill = h('i', { class: 'ps__xpfill' });
  const xpCaption = h('span', { class: 'ps__xpcap tnum' });
  let xpShown = 0;
  const renderXp = (v: number): void => {
    xpCaption.textContent = snap.maxed
      ? `${fmtInt(Math.round(v))} XP earned this season`
      : `${fmtInt(Math.round(v))} / ${fmtInt(snap.need)} XP`;
  };
  const claimAllBtn = Button({
    label: 'Claim all',
    variant: 'primary',
    // Full-bleed inside an --r-lg card: 'lg' nests its 20px radius concentrically
    // with the card's and scales the label to the width it is given.
    size: 'lg',
    // The biggest reward action on the screen was inheriting the default
    // 'select' tick while claimTier/claimChallenge both fire 'win'.
    haptic: 'win',
    class: 'ps__claimall',
    onTap: () => {
      const got = claimAll();
      if (!got.length) return;
      bus.emit('ui:toast', { text: `Collected ${got.length} reward${got.length === 1 ? '' : 's'}`, tone: 'epic', ms: 2600 });
      bus.emit('fx:burst', { kind: 'confetti' });
    },
  });

  const tierCard = h(
    'section',
    { class: 'ps__tiercard ps__sec', style: { '--i': '1' } },
    h('span', { class: 'ps__cardedge', 'aria-hidden': 'true' }),
    h('span', { class: 'ps__cardshine', 'aria-hidden': 'true' }),
    tierRing,
    h(
      'div',
      { class: 'ps__tiertext' },
      h('span', { class: 'ps__tierlabel caps' }, 'Current tier'),
      h('span', { class: 'ps__tiernext' }),
      h('div', { class: 'ps__xptrack' }, xpFill),
      xpCaption,
    ),
    claimAllBtn,
  );
  const tierNext = tierCard.querySelector('.ps__tiernext') as HTMLElement;

  // ── upsell ─────────────────────────────────────────────────────────
  const upsell = h('section', { class: 'ps__upsell ps__sec', style: { '--i': '3' } });
  let talliedOnce = false;

  function buildUpsell(): void {
    clear(upsell);
    if (snap.premium) {
      upsell.classList.add('is-active');
      upsell.append(
        h('span', { class: 'ps__upedge', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'ps__activerow' },
          h('span', { class: 'ps__activeic' }, icon('crown', { size: 20, solid: true })),
          h(
            'div',
            { class: 'ps__activetext' },
            h('span', { class: 'ps__activetitle' }, 'Premium Pass active'),
            h('span', { class: 'ps__activesub' }, 'Both lanes unlock as you climb. Every tier you pass is yours.'),
          ),
        ),
      );
      return;
    }
    upsell.classList.remove('is-active');
    const got = trackContents('premium');
    /**
     * Both cards carry the ribbon element — the plain one just hides it — so the
     * two names and the two prices sit on one shared baseline. Two prices shown
     * for comparison that do not align is the loudest craft error a pricing
     * block can make.
     */
    const offerCard = (offer: PassOffer) =>
      h(
        'button',
        { class: cx('ps__offer', offer.tiers > 0 && 'is-bundle'), type: 'button' },
        h(
          'span',
          { class: 'ps__offertag caps', 'aria-hidden': offer.tiers > 0 ? null : 'true' },
          offer.tiers > 0 ? 'Head start' : '',
        ),
        h('span', { class: 'ps__offername' }, offer.label),
        h('span', { class: 'ps__offerprice' }, icon('gem', { size: 15 }), h('b', { class: 'tnum' }, fmtInt(offer.gems))),
        h(
          'span',
          { class: 'ps__offerblurb' },
          offer.tiers > 0
            ? `Same pass, plus ${offer.tiers} tiers the moment you buy.`
            : 'The second lane for the rest of the season.',
        ),
      );

    const cards = PASS_OFFERS.map((offer) => {
      const card = offerCard(offer);
      pressFeedback(card);
      card.addEventListener('click', () => {
        haptic('select');
        const res = buyPass(offer);
        if (!res.ok) {
          bus.emit('ui:toast', { text: res.message ?? 'Could not upgrade', tone: 'bad', ms: 2600 });
          return;
        }
        repaint();
      });
      return card;
    });

    /**
     * The tally owns the quantities, so the bullet that restated "8 cosmetics
     * that never appear in the store" is gone and the body no longer repeats
     * the back-pay promise the tick below states. Every claim appears once.
     */
    const tally: Array<{ to: number; fmt: (v: number) => string; label: string }> = [
      { to: got.cosmetics, fmt: (v) => fmtInt(Math.round(v)), label: 'cosmetics' },
      { to: got.exclusives, fmt: (v) => fmtInt(Math.round(v)), label: 'never sold' },
      { to: got.gems, fmt: (v) => fmtInt(Math.round(v)), label: 'gems' },
      { to: got.chips, fmt: (v) => `${Math.round(v / 1000)}k`, label: 'chips' },
    ];
    const tallyRow = h('div', { class: 'ps__uptally' });
    tally.forEach((t, i) => {
      const num = h('b', { class: 'tnum' }, t.fmt(t.to));
      tallyRow.appendChild(h('span', { class: 'ps__uptallyi' }, num, h('span', { class: 'caps' }, t.label)));
      if (!talliedOnce) {
        // 114ms of ecIn stagger for --i:3, then the digits land left to right
        rampTo(0, t.to, 230 + i * 55, (v) => {
          num.textContent = t.fmt(v);
        });
      }
    });
    talliedOnce = true;

    upsell.append(
      h('span', { class: 'ps__upedge', 'aria-hidden': 'true' }),
      h('span', { class: 'ps__upglow', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'ps__uphead' },
        h('span', { class: 'ps__upeyebrow caps' }, 'Unlock the second lane'),
        h('h2', { class: 'ps__uptitle' }, 'Premium Pass'),
        h('p', { class: 'ps__upbody' }, 'A second reward on all fifty tiers. Upgrade whenever you like.'),
      ),
      tallyRow,
      h('div', { class: 'ps__offers' }, ...cards),
      h(
        'ul',
        { class: 'ps__uplist' },
        ...[
          'Back-pays every tier you already passed',
          'Unlocks the advanced stats screen',
        ].map((t) => h('li', null, icon('check', { size: 13, stroke: 2.6 }), h('span', null, t))),
      ),
    );
  }

  // ── tier track ─────────────────────────────────────────────────────
  const trackRail = h('div', { class: 'ps__rail scroll' });
  const trackSec = h(
    'section',
    { class: 'ps__tracksec ps__sec', style: { '--i': '2' } },
    h(
      'div',
      { class: 'ps__sechead' },
      h('h2', { class: 'ps__sectitle' }, 'Reward track'),
      h('span', { class: 'ps__seccap tnum' }, `${MAX_TIER} tiers`),
    ),
    h(
      'div',
      { class: 'ps__trackwrap' },
      h(
        'div',
        { class: 'ps__lanetags' },
        h('span', { class: 'ps__lanetag is-free caps' }, 'Free'),
        h('span', { class: 'ps__lanetag is-prem caps' }, 'Premium'),
      ),
      trackRail,
    ),
  );

  const columns: HTMLElement[] = [];

  function cell(tier: number, track: 'free' | 'premium'): HTMLElement {
    const def = TIERS[tier - 1];
    const reward = track === 'free' ? def.freeReward : def.premiumReward;
    if (!reward) {
      return h('span', { class: 'ps__cell is-blank', 'aria-hidden': 'true' }, h('i'));
    }
    const rarity = reward.rarity;
    const el = h(
      'button',
      {
        class: cx('ps__cell', `is-${track}`),
        type: 'button',
        dataset: { rarity },
        'aria-label': `Tier ${tier} ${track} reward: ${rewardLabel(reward)}`,
      },
      h('span', { class: 'ps__celledge', 'aria-hidden': 'true' }),
      h('span', { class: 'ps__cellart' }, rewardArt(reward, 46)),
      h('span', { class: 'ps__celllabel' }, rewardLabel(reward)),
      h('span', { class: 'ps__cellstate', 'aria-hidden': 'true' }),
    );
    pressFeedback(el);
    el.addEventListener('click', () => {
      const claimed = isClaimed(tier, track);
      const reached = tier <= snap.tier;
      const entitled = track === 'free' || snap.premium;
      if (!claimed && reached && entitled) {
        const res = claimTier(tier, track);
        if (res.ok && res.reward) {
          haptic('win');
          bus.emit('ui:toast', { text: `Claimed ${rewardLabel(res.reward)}`, tone: 'epic', ms: 2400 });
        }
        return;
      }
      if (reward.kind === 'cosmetic' && reward.itemId) {
        const item = itemById(reward.itemId);
        if (item) {
          openItemSheet(item, { onChange: () => repaint() });
          return;
        }
      }
      if (!entitled) {
        bus.emit('ui:toast', { text: 'The premium lane needs an active Pass', tone: 'info', ms: 2400 });
        upsell.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
      } else if (!reached) {
        bus.emit('ui:toast', { text: `Reach tier ${tier} to claim this`, tone: 'info', ms: 2200 });
      }
    });
    return el;
  }

  function buildTrack(): void {
    clear(trackRail);
    columns.length = 0;
    for (let tier = 1; tier <= MAX_TIER; tier++) {
      const col = h(
        'div',
        { class: 'ps__col', dataset: { tier: String(tier) } },
        cell(tier, 'free'),
        h(
          'div',
          { class: 'ps__marker' },
          h('span', { class: 'ps__markerline', 'aria-hidden': 'true' }),
          h('span', { class: 'ps__markern tnum' }, String(tier)),
        ),
        cell(tier, 'premium'),
      );
      columns.push(col);
      trackRail.appendChild(col);
    }
  }

  function paintTrack(): void {
    for (let i = 0; i < columns.length; i++) {
      const tier = i + 1;
      const col = columns[i];
      const reached = tier <= snap.tier;
      col.classList.toggle('is-reached', reached);
      col.classList.toggle('is-current', tier === snap.tier);
      const cells = col.querySelectorAll<HTMLElement>('.ps__cell');
      cells.forEach((c) => {
        const track: 'free' | 'premium' = c.classList.contains('is-premium') ? 'premium' : 'free';
        if (c.classList.contains('is-blank')) return;
        const claimed = isClaimed(tier, track);
        const entitled = track === 'free' || snap.premium;
        const claimable = reached && entitled && !claimed;
        c.classList.toggle('is-claimed', claimed);
        c.classList.toggle('is-claimable', claimable);
        c.classList.toggle('is-locked', !reached || !entitled);
        c.classList.toggle('is-premlocked', track === 'premium' && !snap.premium);
      });
    }
  }

  // ── challenges ─────────────────────────────────────────────────────
  const challengeList = h('div', { class: 'ps__chlist' });
  let scope: 'daily' | 'weekly' = 'daily';
  const scopeSeg = Segmented({
    items: [{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }],
    value: 'daily',
    size: 'sm',
    onChange: (id) => {
      scope = id as 'daily' | 'weekly';
      paintChallenges();
    },
  });
  const chClaimAll = Button({
    label: 'Collect XP',
    variant: 'secondary',
    size: 'sm',
    class: 'ps__chclaim',
    onTap: () => {
      const xp = claimAllChallenges();
      if (xp > 0) {
        bus.emit('ui:toast', { text: `+${fmtInt(xp)} pass XP`, tone: 'epic', ms: 2400 });
      }
    },
  });

  const chSec = h(
    'section',
    { class: 'ps__chsec ps__sec', style: { '--i': '4' } },
    h(
      'div',
      { class: 'ps__sechead' },
      h('h2', { class: 'ps__sectitle' }, 'Challenges'),
      chClaimAll,
    ),
    scopeSeg,
    challengeList,
    h(
      'p',
      { class: 'ps__chnote' },
      icon('info', { size: 12.5 }),
      h('span', null, 'Dailies reset at midnight, weeklies on Monday. Progress is tracked from real hands.'),
    ),
  );

  function challengeRow(c: ChallengeView): HTMLElement {
    const ring = RingProgress({
      value: c.pct,
      size: 46,
      stroke: 4,
      tone: c.complete ? 'good' : 'gold',
      center: c.complete
        ? icon('check', { size: 17, stroke: 2.8 })
        : h('span', { class: 'ps__chpct tnum' }, `${Math.round(c.pct * 100)}%`),
    });
    const row = h(
      'div',
      { class: cx('ps__ch', c.complete && 'is-done', c.claimed && 'is-claimed') },
      ring,
      h(
        'div',
        { class: 'ps__chtext' },
        h('span', { class: 'ps__chtitle' }, c.title),
        h('span', { class: 'ps__chdetail' }, c.detail),
        h('span', { class: 'ps__chprog tnum' }, `${fmtInt(c.progress)} / ${fmtInt(c.goal)}`),
      ),
      c.claimed
        ? Pill({ text: 'Claimed', tone: 'dim', size: 'xs', caps: true })
        : c.complete
          ? Button({
              label: `+${fmtInt(c.xp)}`,
              variant: 'primary',
              size: 'sm',
              class: 'ps__chbtn',
              onTap: () => {
                const res = claimChallenge(c.id);
                if (res.ok) {
                  haptic('win');
                  bus.emit('ui:toast', { text: `+${fmtInt(c.xp)} pass XP`, tone: 'epic', ms: 2200 });
                }
              },
            })
          : Pill({ text: `${fmtInt(c.xp)} XP`, tone: 'gold', size: 'xs', numeric: true, outline: true }),
    );
    return row;
  }

  function paintChallenges(): void {
    clear(challengeList);
    const list = challenges().filter((c) => c.scope === scope);
    for (const c of list) challengeList.appendChild(challengeRow(c));
    const pending = challenges().some((c) => c.complete && !c.claimed);
    chClaimAll.setDisabled(!pending);
    chClaimAll.classList.toggle('is-hot', pending);
  }

  const footer = h(
    'footer',
    { class: 'ps__foot ps__sec', style: { '--i': '5' } },
    h(
      'p',
      { class: 'ps__legal' },
      'The Premium Pass grants cosmetics and in-app currency only. It never affects the cards, the shuffle, or the odds.',
    ),
  );

  // Track before upsell: reward art in the first screenful, the offer after it.
  inner.append(header, tierCard, trackSec, upsell, chSec, footer);

  // ── paint ──────────────────────────────────────────────────────────

  function repaint(): void {
    snap = passState();
    timeEl.textContent = countdown(snap.season.endsAt).label;
    seasonBar.style.transform = `scaleX(${seasonProgress().toFixed(4)})`;
    tierNum.textContent = String(snap.tier);
    tierRing.set(snap.pct);
    tierNext.textContent = snap.maxed ? 'Track complete' : `${fmtInt(snap.need - snap.into)} XP to tier ${snap.tier + 1}`;
    xpFill.style.transform = `scaleX(${snap.pct.toFixed(4)})`;
    // Rolls from 0 on arrival, and from wherever it stood on every claim after
    // that, so the caption travels with the bar instead of snapping past it.
    const xpTarget = snap.maxed ? snap.xp : snap.into;
    rampTo(xpShown, xpTarget, xpShown === 0 ? 190 : 0, renderXp);
    xpShown = xpTarget;
    const pending = snap.claimableFree.length + snap.claimablePremium.length;
    claimAllBtn.setDisabled(pending === 0);
    claimAllBtn.setLabel(pending > 0 ? `Claim ${pending}` : 'Nothing to claim');
    root.classList.toggle('is-premium', snap.premium);
    buildUpsell();
    paintTrack();
    paintChallenges();
  }

  buildTrack();
  repaint();
  requestAnimationFrame(() => inner.classList.add('is-in'));

  // Open centred on the current tier — the whole point of a horizontal track.
  // Measured off rects, not offsetLeft: the rail's offsetParent is the wrapper
  // that carries the 58px lane-tag gutter, so offset maths landed a column and
  // a half to the left of true centre.
  requestAnimationFrame(() => {
    const target = columns[Math.max(0, snap.tier - 1)];
    if (!target) return;
    const rail = trackRail.getBoundingClientRect();
    const col = target.getBoundingClientRect();
    const delta = col.left - rail.left - (rail.width - col.width) / 2;
    trackRail.scrollLeft = Math.max(0, trackRail.scrollLeft + delta);
  });

  cleanups.push(onPass(() => repaint()));
  cleanups.push(onWallet((_, why) => {
    if (why === 'premium' || why === 'pass') repaint();
  }));

  const clockId = window.setInterval(() => {
    timeEl.textContent = countdown(passState().season.endsAt).label;
  }, 30_000);
  cleanups.push(() => clearInterval(clockId));

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
          console.error('[pass] cleanup failed', err);
        }
      }
      clear(root);
      root.remove();
    },
  };
}
