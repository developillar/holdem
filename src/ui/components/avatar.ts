/**
 * ROYALE — components/avatar.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Player portrait with the full status stack: rarity frame ring, premium
 * crown, level chip, online dot and an optional heat (hot-streak) flame ring.
 *
 *   Avatar({ name: 'Nadia Okafor', size: 'md', level: 34, premium: true })
 *   Avatar({ player: seat.player, size: 44, rarity: 'legendary', online: true })
 *   Avatar({ name: 'Kai', imgSrc: dataUrl, size: 'xl' })
 *
 * With no `imgSrc` the portrait is generated: a deterministic two-stop
 * gradient hashed from `avatarId ?? name`, an angled light sweep, and the
 * player's initials in tight display type. That is intentionally the *good*
 * fallback — it never looks like a missing image.
 */
import { h, cx } from '../dom.ts';
import type { ClassValue } from '../dom.ts';
import type { PlayerRef, Rarity } from '../../core/types.ts';
import { icon } from './icons.ts';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<AvatarSize, number> = { xs: 26, sm: 34, md: 44, lg: 60, xl: 92 };

export interface AvatarOpts {
  /** shortcut: fills name / avatarId / level / premium / heat from a PlayerRef */
  player?: PlayerRef | null;
  name?: string;
  avatarId?: string;
  imgSrc?: string;
  size?: AvatarSize | number;
  rarity?: Rarity | null;
  level?: number | null;
  premium?: boolean;
  online?: boolean;
  /** 0–1 hot streak; ≥0.5 lights the flame ring */
  heat?: number;
  class?: ClassValue;
  ariaLabel?: string;
}

/** FNV-1a — stable across reloads so a player keeps their colours. */
function hash(str: string): number {
  let hv = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hv ^= str.charCodeAt(i);
    hv = Math.imul(hv, 0x01000193) >>> 0;
  }
  return hv >>> 0;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s_·-]+/).filter(Boolean);
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar(opts: AvatarOpts = {}): HTMLElement {
  const p = opts.player ?? null;
  const name = opts.name ?? p?.name ?? 'Player';
  const seedSrc = opts.avatarId ?? p?.avatarId ?? name;
  const px = typeof opts.size === 'number' ? opts.size : SIZES[opts.size ?? 'md'];
  const level = opts.level ?? p?.level ?? null;
  const premium = opts.premium ?? p?.premium ?? false;
  const heat = opts.heat ?? p?.heat ?? 0;

  const seed = hash(seedSrc);
  const hue = seed % 360;
  const hue2 = (hue + 28 + ((seed >> 9) % 40)) % 360;
  const sat = 46 + ((seed >> 5) % 22);
  const light = 26 + ((seed >> 13) % 14);

  const face = opts.imgSrc
    ? h('img', { class: 'r-av__img', attrs: { src: opts.imgSrc, alt: '', decoding: 'async' } })
    : h(
        'span',
        {
          class: 'r-av__gen',
          style: {
            '--a1': `hsl(${hue} ${sat}% ${light + 12}%)`,
            '--a2': `hsl(${hue2} ${sat - 8}% ${light - 8}%)`,
          },
        },
        h('span', { class: 'r-av__mono' }, initials(name)),
      );

  const el = h(
    'span',
    {
      class: cx(
        'r-av',
        opts.rarity && `r-av--rar-${opts.rarity}`,
        premium && 'is-premium',
        heat >= 0.5 && 'is-hot',
        opts.class,
      ),
      style: { '--av': `${px}px` },
      role: 'img',
      'aria-label': opts.ariaLabel ?? `${name}${level ? `, level ${level}` : ''}`,
    },
    h('span', { class: 'r-av__ring', 'aria-hidden': 'true' }),
    h('span', { class: 'r-av__disc' }, face, h('span', { class: 'r-av__gloss', 'aria-hidden': 'true' })),
    premium && px >= 40
      ? h('span', { class: 'r-av__crown', 'aria-hidden': 'true' }, icon('crown', { size: Math.round(px * 0.3), solid: true }))
      : null,
    level !== null && px >= 34 ? h('span', { class: 'r-av__lvl tnum' }, String(level)) : null,
    opts.online ? h('span', { class: 'r-av__dot', 'aria-hidden': 'true' }) : null,
  );
  return el;
}

/** Overlapping avatar stack for "12 watching" / friend rows. */
export function AvatarStack(
  people: Array<{ name: string; avatarId?: string }>,
  opts: { size?: number; max?: number; class?: ClassValue } = {},
): HTMLElement {
  const px = opts.size ?? 26;
  const max = opts.max ?? 4;
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return h(
    'span',
    { class: cx('r-avstack', opts.class), style: { '--av': `${px}px` } },
    ...shown.map((p, i) =>
      h(
        'span',
        { class: 'r-avstack__i', style: { zIndex: String(max - i) } },
        Avatar({ name: p.name, avatarId: p.avatarId, size: px, level: null }),
      ),
    ),
    rest > 0 ? h('span', { class: 'r-avstack__more tnum' }, `+${rest}`) : null,
  );
}
