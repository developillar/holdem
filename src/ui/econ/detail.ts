/**
 * ROYALE — ui/econ/detail.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Everything that happens after a tile is tapped: the detail sheet, the
 * confirm step, the spend animation, and the unlock celebration.
 *
 *   openItemSheet(item, { onChange })
 *
 * The purchase path is deliberately three beats long — review, confirm, and
 * then a reveal you would screenshot. A one-tap buy feels cheap and produces
 * regret; a five-tap buy feels like a form. Three is the shape that makes the
 * gems feel spent on something.
 *
 * Gems are the only currency here. There is no payment processor anywhere in
 * this file — the gem shelf's mock sheet lives in `bundles.ts` and is labelled
 * as a demo on its face.
 */
import { bus } from '../../core/bus.ts';
import type { CosmeticItem } from '../../core/types.ts';
import { h, cx } from '../dom.ts';
import { Button } from '../components/button.ts';
import { openSheet } from '../components/sheet.ts';
import type { SheetHandle } from '../components/sheet.ts';
import { openModal } from '../components/modal.ts';
import { Pill, RarityTag } from '../components/pill.ts';
import { icon } from '../components/icons.ts';
import { CountUp } from '../components/countup.ts';
import { fmtInt, haptic, pressFeedback, reduceMotion } from '../components/util.ts';
import { RARITY_META } from '../../data/catalog.ts';
import { canPurchase, econ, equip, gems, isEquipped, isPremium, owns, purchase } from '../../econ/wallet.ts';
import { previewNode } from './preview.ts';

const KIND_LABEL: Record<CosmeticItem['kind'], string> = {
  avatar: 'Avatar',
  frame: 'Avatar frame',
  'table-skin': 'Table skin',
  'card-back': 'Card back',
  'chip-set': 'Chip set',
  emote: 'Emote set',
  title: 'Title',
  felt: 'Felt',
};

const KIND_EFFECT: Record<CosmeticItem['kind'], string> = {
  avatar: 'Shown at every table, in the feed, and on your profile.',
  frame: 'Rings your portrait everywhere your name appears.',
  'table-skin': 'Replaces the felt, rail and trim on every table you sit at.',
  'card-back': 'The back of every card dealt to you and to the board.',
  'chip-set': 'Your stack, your bets, and every pot you push.',
  emote: 'The six reactions on your emote wheel at the table.',
  title: 'The line under your name on your nameplate.',
  felt: 'Cloth only — keeps whichever rail your table skin uses.',
};

// ─────────────────────────── spend animation ───────────────────────────

/**
 * Flings gem motes from the price toward the wallet pill. Pure transform, no
 * layout, self-cleaning — and skipped entirely under reduced motion.
 */
function spendBurst(from: HTMLElement, count = 10): void {
  if (reduceMotion() || typeof document === 'undefined') return;
  const rect = from.getBoundingClientRect();
  const host = document.getElementById('fx-root') ?? document.body;
  const tx = window.innerWidth - 88;
  const ty = 40;
  for (let i = 0; i < count; i++) {
    const dot = h('span', {
      class: 'ec-spend',
      style: {
        left: `${rect.left + rect.width / 2}px`,
        top: `${rect.top + rect.height / 2}px`,
        '--sx': `${tx - rect.left - rect.width / 2}px`,
        '--sy': `${ty - rect.top - rect.height / 2}px`,
        '--jx': `${(i % 2 ? 1 : -1) * (12 + (i % 5) * 11)}px`,
        '--sd': `${(i * 34).toFixed(0)}ms`,
      },
    });
    host.appendChild(dot);
    window.setTimeout(() => dot.remove(), 900 + i * 34);
  }
}

// ─────────────────────────── unlock celebration ───────────────────────────

/**
 * The reveal. A rarity-tinted burst behind the item, the preview springing in
 * over it, and a single line of copy. Dismisses on tap or after four seconds
 * — long enough to enjoy, short enough not to be in the way.
 */
export function celebrateUnlock(item: CosmeticItem, opts: { equipped?: boolean } = {}): void {
  bus.emit('fx:burst', { kind: 'unlock' });
  bus.emit('ui:haptic', { pattern: item.rarity === 'mythic' || item.rarity === 'legendary' ? 'big-win' : 'win' });

  // Body-hosted: the shell's modal layer is pointer-events:none until a real
  // modal is open, and the reveal has to be tappable to dismiss.
  const host = document.body;
  const rays = h('span', { class: 'ec-reveal__rays', 'aria-hidden': 'true' });
  for (let i = 0; i < 12; i++) {
    rays.appendChild(h('i', { style: { '--r': `${(i * 30).toFixed(0)}deg`, '--rd': `${i * 26}ms` } }));
  }

  const root = h(
    'div',
    {
      class: cx('ec-reveal'),
      dataset: { rarity: item.rarity },
      role: 'status',
      'aria-label': `Unlocked ${item.name}`,
    },
    h('span', { class: 'ec-reveal__scrim', 'aria-hidden': 'true' }),
    rays,
    h(
      'div',
      { class: 'ec-reveal__card' },
      h('div', { class: 'ec-reveal__eyebrow caps' }, opts.equipped ? 'Unlocked & equipped' : 'Unlocked'),
      h('div', { class: 'ec-reveal__stage' }, previewNode(item, { size: 168, hero: item.kind === 'table-skin' || item.kind === 'felt', animate: true })),
      h('div', { class: 'ec-reveal__name' }, item.name),
      h('div', { class: 'ec-reveal__rar' }, RarityTag(item.rarity, { size: 'sm' })),
      h('p', { class: 'ec-reveal__flavour' }, RARITY_META[item.rarity].flavour),
    ),
  );

  host.appendChild(root);
  requestAnimationFrame(() => root.classList.add('is-in'));

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    root.classList.remove('is-in');
    root.classList.add('is-out');
    window.setTimeout(() => root.remove(), 320);
  };
  root.addEventListener('click', close);
  window.setTimeout(close, reduceMotion() ? 1200 : 4200);
}

// ─────────────────────────── confirm step ───────────────────────────

function confirmPurchase(item: CosmeticItem, anchor: HTMLElement, onDone: () => void): void {
  const price = item.priceGems ?? 0;
  const before = gems();
  const after = before - price;

  const balanceRow = h(
    'div',
    { class: 'ec-confirm__bal' },
    h(
      'div',
      { class: 'ec-confirm__balrow' },
      h('span', null, 'Balance'),
      h('b', { class: 'tnum' }, fmtInt(before)),
    ),
    h(
      'div',
      { class: 'ec-confirm__balrow is-cost' },
      h('span', null, item.name),
      h('b', { class: 'tnum' }, `−${fmtInt(price)}`),
    ),
    h('div', { class: 'ec-confirm__rule', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'ec-confirm__balrow is-total' },
      h('span', null, 'Remaining'),
      h('b', { class: 'tnum' }, fmtInt(after)),
    ),
  );

  openModal({
    title: `Buy ${item.name}?`,
    tone: 'gold',
    class: 'ec-confirm',
    body: h(
      'div',
      { class: 'ec-confirm__body' },
      h('div', { class: 'ec-confirm__prev' }, previewNode(item, { size: 76 })),
      balanceRow,
    ),
    actions: [
      { label: 'Not yet', variant: 'ghost' },
      {
        label: `Buy for ${fmtInt(price)}`,
        variant: 'primary',
        onTap: () => {
          const res = purchase(item);
          if (!res.ok) {
            bus.emit('ui:toast', { text: res.message ?? 'Purchase failed', tone: 'bad', ms: 2400 });
            return;
          }
          spendBurst(anchor, item.rarity === 'mythic' ? 16 : 10);
          const autoEquip = equip(item.id).ok;
          window.setTimeout(() => celebrateUnlock(item, { equipped: autoEquip }), 220);
          bus.emit('ui:toast', {
            text: `${item.name} unlocked${autoEquip ? ' and equipped' : ''}`,
            tone: 'epic',
            ms: 2800,
          });
          onDone();
        },
      },
    ],
  });
}

// ─────────────────────────── detail sheet ───────────────────────────

export interface ItemSheetOpts {
  /** fired after any change to ownership or equipped state */
  onChange?(): void;
  /** the avatar shown inside frame previews */
  avatarId?: string;
  playerName?: string;
  /** route the "get gems" and "get premium" CTAs */
  onNeedGems?(): void;
  onNeedPremium?(): void;
}

export function openItemSheet(item: CosmeticItem, opts: ItemSheetOpts = {}): SheetHandle {
  const rarity = RARITY_META[item.rarity];

  const specRow = (label: string, value: Node | string) =>
    h('div', { class: 'ec-detail__row' }, h('span', { class: 'ec-detail__k caps' }, label), h('span', { class: 'ec-detail__v' }, value));

  const source =
    item.priceGems === null
      ? `Premium Pass · tier ${item.passTier ?? '—'}`
      : item.premiumOnly
        ? 'Store · Premium members'
        : 'Store';

  let footerHost: HTMLElement | null = null;
  let handle: SheetHandle | null = null;

  const buildFooter = (): Node => {
    const owned = owns(item.id);
    const worn = isEquipped(item.id);
    const locked = item.premiumOnly && !isPremium();

    if (worn) {
      return h(
        'div',
        { class: 'ec-detail__foot' },
        Button({ label: 'Equipped', variant: 'secondary', size: 'lg', full: true, disabled: true, icon: icon('check', { size: 18, stroke: 2.4 }) }),
      );
    }
    if (owned) {
      return h(
        'div',
        { class: 'ec-detail__foot' },
        Button({
          label: `Equip ${KIND_LABEL[item.kind].toLowerCase()}`,
          variant: 'primary',
          size: 'lg',
          full: true,
          haptic: 'select',
          onTap: () => {
            const res = equip(item.id);
            if (!res.ok) {
              bus.emit('ui:toast', { text: res.message ?? 'Could not equip', tone: 'bad', ms: 2400 });
              return;
            }
            bus.emit('ui:toast', { text: `${item.name} equipped`, tone: 'good', ms: 2000 });
            opts.onChange?.();
            refreshFooter();
          },
        }),
      );
    }
    if (item.priceGems === null) {
      return h(
        'div',
        { class: 'ec-detail__foot' },
        h(
          'p',
          { class: 'ec-detail__note' },
          icon('sparkle', { size: 13 }),
          h('span', null, `Earned at tier ${item.passTier ?? '—'} of the Premium Pass. It is never sold.`),
        ),
        Button({
          label: 'Open the Pass',
          variant: 'primary',
          size: 'lg',
          full: true,
          onTap: () => {
            handle?.close();
            bus.emit('nav:route', { route: 'pass' });
          },
        }),
      );
    }
    if (locked) {
      return h(
        'div',
        { class: 'ec-detail__foot' },
        h(
          'p',
          { class: 'ec-detail__note' },
          icon('crown', { size: 13 }),
          h('span', null, 'Reserved for Premium Pass members for the whole season.'),
        ),
        Button({
          label: 'See Premium',
          variant: 'primary',
          size: 'lg',
          full: true,
          onTap: () => {
            handle?.close();
            if (opts.onNeedPremium) opts.onNeedPremium();
            else bus.emit('nav:route', { route: 'pass' });
          },
        }),
      );
    }

    const check = canPurchase(item);
    const short = check.reason === 'insufficient-gems';
    const priceBtn = Button({
      label: short ? 'Get more gems' : 'Buy',
      sub: short ? `${fmtInt((item.priceGems ?? 0) - gems())} more needed` : `${fmtInt(item.priceGems ?? 0)} gems`,
      variant: 'primary',
      size: 'lg',
      full: true,
      icon: icon('gem', { size: 18 }),
      haptic: 'select',
      onTap: () => {
        if (short) {
          handle?.close();
          opts.onNeedGems?.();
          return;
        }
        confirmPurchase(item, priceBtn, () => {
          opts.onChange?.();
          refreshFooter();
        });
      },
    });
    return h('div', { class: 'ec-detail__foot' }, priceBtn);
  };

  const refreshFooter = () => {
    if (!footerHost) return;
    footerHost.textContent = '';
    footerHost.appendChild(buildFooter());
  };

  handle = openSheet({
    class: cx('ec-detail', `ec-detail--${item.rarity}`),
    eyebrow: KIND_LABEL[item.kind],
    title: item.name,
    content: () =>
      h(
        'div',
        { class: 'ec-detail__body' },
        h(
          'div',
          { class: 'ec-detail__hero', dataset: { rarity: item.rarity } },
          h('span', { class: 'ec-detail__halo', 'aria-hidden': 'true' }),
          previewNode(item, {
            size: item.kind === 'table-skin' || item.kind === 'felt' ? 150 : 168,
            hero: item.kind === 'table-skin' || item.kind === 'felt',
            avatarId: opts.avatarId,
            playerName: opts.playerName,
            animate: true,
          }),
        ),
        h(
          'div',
          { class: 'ec-detail__tags' },
          RarityTag(item.rarity, { size: 'sm' }),
          item.premiumOnly ? Pill({ text: 'Premium', tone: 'gold', size: 'xs', caps: true, icon: icon('crown', { size: 11, solid: true }) }) : null,
          owns(item.id) ? Pill({ text: 'Owned', tone: 'good', size: 'xs', caps: true }) : null,
        ),
        h('p', { class: 'ec-detail__desc' }, item.description),
        h(
          'div',
          { class: 'ec-detail__specs' },
          specRow('Category', KIND_LABEL[item.kind]),
          specRow('Rarity', h('span', { style: { color: rarity.color } }, rarity.label)),
          specRow('Source', source),
          specRow(
            'Price',
            item.priceGems === null
              ? 'Not sold'
              : h('span', { class: 'ec-detail__price' }, icon('gem', { size: 13 }), h('b', { class: 'tnum' }, fmtInt(item.priceGems))),
          ),
        ),
        h('p', { class: 'ec-detail__effect' }, KIND_EFFECT[item.kind]),
      ),
    footer: () => {
      footerHost = h('div', { class: 'ec-detail__foothost' }, buildFooter());
      return footerHost;
    },
  });
  haptic('select');
  return handle;
}

export interface GemBalanceEl extends HTMLButtonElement {
  setValue(n: number): void;
}

/**
 * A tappable gem readout for surfaces that do **not** already sit under the
 * shell's top bar — sheets and modals. Screens keep a single gem number on
 * screen at a time, so the store header deliberately does not use this.
 *
 * Press state goes through `pressFeedback` like every other control: bare
 * `:active` is unreliable in WebKit without a touchstart binding, which left
 * this the one control whose `haptic('tick')` fired with no matching visual.
 * The 40px pill also carries a `::after` hit expander (see `.ec-bal` in
 * store.css) so the real target is 48px.
 */
export function GemBalance(opts: { onTap?(): void } = {}): GemBalanceEl {
  const count = CountUp({ value: econ().gems, format: fmtInt, class: 'ec-bal__n' });
  const el = h(
    'button',
    { class: 'ec-bal', type: 'button', 'aria-label': 'Gem balance — add more' },
    h('span', { class: 'ec-bal__ic' }, icon('gem', { size: 15 })),
    count,
    h('span', { class: 'ec-bal__plus' }, icon('plus', { size: 14, stroke: 2.6 })),
  ) as unknown as GemBalanceEl;
  pressFeedback(el);
  el.addEventListener('click', () => {
    haptic('tick');
    opts.onTap?.();
  });
  el.setValue = (n: number) => count.set(n);
  return el;
}
