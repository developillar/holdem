/**
 * ROYALE — ui/econ/tile.ts
 * ────────────────────────────────────────────────────────────────────────────
 * The store tile. Each one is a small object: a rarity-tinted frame, an inner
 * stage holding the live preview, a specular sheen that sweeps across
 * legendary and mythic items, and a footer that switches between price, OWNED
 * and EQUIPPED without ever changing the tile's height.
 *
 *   ItemTile({ item, onTap: (i) => openItemSheet(i) })
 *   tile.refresh()   // after a purchase or an equip
 */
import type { CosmeticItem } from '../../core/types.ts';
import { h, cx } from '../dom.ts';
import { icon } from '../components/icons.ts';
import { pressFeedback } from '../components/util.ts';
import { fmtInt } from '../components/util.ts';
import { isEquipped, isPremium, owns } from '../../econ/wallet.ts';
import { RARITY_META } from '../../data/catalog.ts';
import { previewNode } from './preview.ts';

export interface ItemTileOpts {
  item: CosmeticItem;
  onTap(item: CosmeticItem): void;
  /** preview edge in px; the tile sizes itself around it */
  size?: number;
  /** the avatar shown inside a frame preview */
  avatarId?: string;
  playerName?: string;
  /** stagger index for the entrance */
  index?: number;
  /**
   * Lead-of-the-rail treatment: names the rarity above the item so a
   * rarity-mixed row cannot read as a flat set of interchangeable slots. The
   * size step that goes with it is the rail's business, not the tile's.
   */
  emphasis?: boolean;
}

export interface ItemTileEl extends HTMLElement {
  refresh(): void;
  item: CosmeticItem;
}

const KIND_LABEL: Record<CosmeticItem['kind'], string> = {
  avatar: 'Avatar',
  frame: 'Frame',
  'table-skin': 'Table',
  'card-back': 'Card back',
  'chip-set': 'Chips',
  emote: 'Emotes',
  title: 'Title',
  felt: 'Felt',
};

export function ItemTile(opts: ItemTileOpts): ItemTileEl {
  const { item } = opts;
  const size = opts.size ?? 92;
  const shiny = item.rarity === 'legendary' || item.rarity === 'mythic';

  const stage = h(
    'span',
    { class: 'ec-tile__stage' },
    previewNode(item, { size, avatarId: opts.avatarId, playerName: opts.playerName }),
    h('span', { class: 'ec-tile__sheen', 'aria-hidden': 'true' }),
    h('span', { class: 'ec-tile__floor', 'aria-hidden': 'true' }),
  );

  const status = h('span', { class: 'ec-tile__status' });

  const el = h(
    'button',
    {
      class: cx('ec-tile', shiny && 'is-shiny', opts.emphasis && 'is-lead'),
      type: 'button',
      dataset: { rarity: item.rarity, kind: item.kind },
      style: { '--tile-i': String(opts.index ?? 0) },
    },
    h('span', { class: 'ec-tile__edge', 'aria-hidden': 'true' }),
    h('span', { class: 'ec-tile__glow', 'aria-hidden': 'true' }),
    stage,
    h(
      'span',
      { class: 'ec-tile__meta' },
      opts.emphasis ? h('span', { class: 'ec-tile__rar' }, RARITY_META[item.rarity].label) : null,
      h('span', { class: 'ec-tile__name' }, item.name),
      status,
    ),
  ) as unknown as ItemTileEl;

  if (item.premiumOnly) {
    el.appendChild(
      h(
        'span',
        { class: 'ec-tile__flag ec-tile__flag--premium', title: 'Premium members only' },
        icon('crown', { size: 11, solid: true }),
      ),
    );
  } else if (item.priceGems === null) {
    el.appendChild(
      h(
        'span',
        { class: 'ec-tile__flag ec-tile__flag--pass', title: `Premium Pass tier ${item.passTier ?? ''}` },
        icon('sparkle', { size: 11, solid: true }),
      ),
    );
  }

  el.item = item;
  el.refresh = () => {
    status.textContent = '';
    const owned = owns(item.id);
    const worn = isEquipped(item.id);
    el.classList.toggle('is-owned', owned);
    el.classList.toggle('is-equipped', worn);
    el.classList.toggle('is-locked', item.premiumOnly && !isPremium());
    if (worn) {
      status.append(icon('check', { size: 12, stroke: 2.6 }), h('span', null, 'Equipped'));
      status.className = 'ec-tile__status is-equipped';
    } else if (owned) {
      status.append(h('span', null, 'Owned'));
      status.className = 'ec-tile__status is-owned';
    } else if (item.priceGems === null) {
      status.append(h('span', null, `Tier ${item.passTier ?? '—'}`));
      status.className = 'ec-tile__status is-pass';
    } else {
      status.append(
        icon('gem', { size: 12 }),
        h('span', { class: 'tnum' }, fmtInt(item.priceGems)),
      );
      status.className = 'ec-tile__status is-price';
    }
    el.setAttribute(
      'aria-label',
      `${item.name}, ${KIND_LABEL[item.kind]}, ${item.rarity}${
        worn ? ', equipped' : owned ? ', owned' : item.priceGems !== null ? `, ${item.priceGems} gems` : ''
      }`,
    );
  };
  el.refresh();

  pressFeedback(el);
  el.addEventListener('click', () => opts.onTap(item));
  return el;
}
