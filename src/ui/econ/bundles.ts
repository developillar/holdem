/**
 * ROYALE — ui/econ/bundles.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The gem shelf. Five tiers, the standard rising bonus, and a "best value"
 * badge on the one that genuinely is — the gems-per-dollar line is printed on
 * every card so the claim is checkable rather than asserted.
 *
 * This is a demo build: no payment processor is contacted, nothing is charged,
 * and the sheet says so on its face before you can confirm. Confirming credits
 * the gems locally so the rest of the store can be explored.
 */
import { bus } from '../../core/bus.ts';
import { GEM_BUNDLES, bundleRate } from '../../data/catalog.ts';
import type { GemBundle } from '../../data/catalog.ts';
import { h, cx } from '../dom.ts';
import { Button } from '../components/button.ts';
import { openSheet } from '../components/sheet.ts';
import { icon } from '../components/icons.ts';
import { fmtInt, haptic, pressFeedback } from '../components/util.ts';
import { addGems } from '../../econ/wallet.ts';

function gemStack(bundle: GemBundle, size: number): SVGSVGElement {
  // Bigger bundles get more gems in the pile — the size of the art is the
  // clearest signal of how much you are getting.
  const tierIndex = GEM_BUNDLES.findIndex((b) => b.id === bundle.id);
  const count = [3, 4, 6, 8, 11][Math.max(0, Math.min(4, tierIndex))];
  const id = `gb-${bundle.id}`;
  const gems: Node[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + i * 0.9;
    const ring = i < 3 ? 0 : i < 7 ? 1 : 2;
    const x = 32 + Math.cos(a) * (5 + ring * 8) + (i % 3) * 1.4;
    const y = 40 + Math.sin(a) * (3 + ring * 4.4) - ring * 2.4;
    const s = 1 - ring * 0.16;
    gems.push(
      h('g', { attrs: { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s.toFixed(2)})` } },
        h('path', { attrs: { d: 'M-7 -6h14l4.4 7.4L0 14-11.4 1.4 -7 -6z', fill: `url(#${id}-a)` } }),
        h('path', { attrs: { d: 'M-7 -6h14l-3.4 7.4h-7.2L-7 -6z', fill: `url(#${id}-b)`, opacity: 0.9 } }),
        h('path', { attrs: { d: 'M-11.4 1.4h22.8L0 14 -11.4 1.4z', fill: '#000', opacity: 0.18 } }),
      ),
    );
  }
  return h(
    'svg',
    { class: 'ec-bundle__art', attrs: { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true' } },
    h(
      'defs',
      null,
      h('linearGradient', { attrs: { id: `${id}-a`, x1: '0', y1: '0', x2: '0.4', y2: '1' } },
        h('stop', { attrs: { offset: '0', 'stop-color': '#9fe9ff' } }),
        h('stop', { attrs: { offset: '0.5', 'stop-color': '#47a9ff' } }),
        h('stop', { attrs: { offset: '1', 'stop-color': '#2b52c9' } }),
      ),
      h('linearGradient', { attrs: { id: `${id}-b`, x1: '0', y1: '0', x2: '0', y2: '1' } },
        h('stop', { attrs: { offset: '0', 'stop-color': '#e8fbff' } }),
        h('stop', { attrs: { offset: '1', 'stop-color': '#8fd4ff' } }),
      ),
      h('radialGradient', { attrs: { id: `${id}-h`, cx: '0.5', cy: '0.5', r: '0.5' } },
        h('stop', { attrs: { offset: '0', 'stop-color': '#47a9ff', 'stop-opacity': '0.4' } }),
        h('stop', { attrs: { offset: '1', 'stop-color': '#47a9ff', 'stop-opacity': '0' } }),
      ),
    ),
    h('ellipse', { attrs: { cx: 32, cy: 38, rx: 28, ry: 22, fill: `url(#${id}-h)` } }),
    ...gems,
    h('ellipse', { attrs: { cx: 32, cy: 55, rx: 18, ry: 3.6, fill: '#03050a', opacity: 0.5 } }),
  );
}

/** The mock purchase sheet. Labelled, un-skippable, and charges nothing. */
export function openBundleSheet(bundle: GemBundle, onDone?: (gems: number) => void): void {
  const total = bundle.gems + bundle.bonus;
  openSheet({
    class: 'ec-buysheet',
    eyebrow: 'Demo purchase',
    title: `${bundle.label} — ${fmtInt(total)} gems`,
    subtitle: 'No payment is taken and no card is contacted.',
    content: () =>
      h(
        'div',
        { class: 'ec-buysheet__body' },
        h('div', { class: 'ec-buysheet__art' }, gemStack(bundle, 132)),
        h(
          'div',
          { class: 'ec-buysheet__lines' },
          h('div', { class: 'ec-buysheet__line' }, h('span', null, 'Base gems'), h('b', { class: 'tnum' }, fmtInt(bundle.gems))),
          bundle.bonus > 0
            ? h('div', { class: 'ec-buysheet__line is-bonus' }, h('span', null, 'Bonus'), h('b', { class: 'tnum' }, `+${fmtInt(bundle.bonus)}`))
            : null,
          h('div', { class: 'ec-buysheet__rule', 'aria-hidden': 'true' }),
          h('div', { class: 'ec-buysheet__line is-total' }, h('span', null, 'You receive'), h('b', { class: 'tnum' }, fmtInt(total))),
          h('div', { class: 'ec-buysheet__line is-dim' }, h('span', null, 'Listed at'), h('b', { class: 'tnum' }, bundle.price)),
        ),
        h(
          'p',
          { class: 'ec-buysheet__notice' },
          icon('info', { size: 15 }),
          h(
            'span',
            null,
            h('b', null, 'This is a demo build. '),
            'There is no store connection, nothing is charged, and the price above is illustrative only. Confirming credits the gems to this device.',
          ),
        ),
      ),
    footer: (s) =>
      h(
        'div',
        { class: 'ec-buysheet__foot' },
        Button({
          label: 'Confirm — free in demo',
          sub: `${fmtInt(total)} gems`,
          variant: 'primary',
          size: 'lg',
          full: true,
          onTap: () => {
            addGems(total);
            s.close();
            bus.emit('fx:burst', { kind: 'confetti' });
            bus.emit('ui:toast', { text: `${fmtInt(total)} gems added`, tone: 'epic', ms: 2600 });
            onDone?.(total);
          },
        }),
      ),
  });
}

export interface GemShelfOpts {
  onPurchase?(gems: number): void;
  class?: string;
}

/** The horizontally scrolling shelf shown at the bottom of the store. */
export function GemShelf(opts: GemShelfOpts = {}): HTMLElement {
  const rates = GEM_BUNDLES.map(bundleRate);
  const bestRate = Math.max(...rates);

  const cards = GEM_BUNDLES.map((b, i) => {
    const total = b.gems + b.bonus;
    const rate = rates[i];
    const card = h(
      'button',
      {
        class: cx('ec-bundle', b.tag !== 'none' && `is-${b.tag}`),
        type: 'button',
        'aria-label': `${b.label}, ${total} gems, ${b.price}`,
      },
      h('span', { class: 'ec-bundle__edge', 'aria-hidden': 'true' }),
      b.tag !== 'none'
        ? h('span', { class: 'ec-bundle__tag caps' }, b.tag === 'best-value' ? 'Best value' : 'Popular')
        : null,
      gemStack(b, 74),
      h('span', { class: 'ec-bundle__n tnum' }, fmtInt(total)),
      b.bonus > 0 ? h('span', { class: 'ec-bundle__bonus tnum' }, `+${fmtInt(b.bonus)} free`) : h('span', { class: 'ec-bundle__bonus is-empty' }, '—'),
      h('span', { class: 'ec-bundle__label' }, b.label),
      h('span', { class: 'ec-bundle__price tnum' }, b.price),
      h(
        'span',
        { class: cx('ec-bundle__rate tnum', rate >= bestRate - 0.01 && 'is-best') },
        `${Math.round(rate)} gems / $`,
      ),
    );
    pressFeedback(card);
    card.addEventListener('click', () => {
      haptic('select');
      openBundleSheet(b, (n) => opts.onPurchase?.(n));
    });
    return card;
  });

  return h(
    'div',
    { class: cx('ec-shelf', opts.class) },
    h('div', { class: 'ec-shelf__rail scroll' }, ...cards),
    h(
      'p',
      { class: 'ec-shelf__legal' },
      'Demo build — gem bundles are simulated and nothing is charged.',
    ),
  );
}
