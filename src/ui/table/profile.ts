/**
 * Player profile — the sheet behind every seat, and the session observer that
 * gives it something true to say.
 *
 * Two responsibilities live here because they share one vocabulary:
 *
 *   1. `createSeatObserver()` watches the bus for the life of a table and
 *      accumulates what this client has actually *seen* each player do —
 *      hands dealt in, hands played voluntarily, hands raised preflop, the
 *      biggest pot they dragged, and the chips that moved between them and
 *      you. Nothing here is invented: a stat with too small a sample renders
 *      as "Not enough hands" rather than a number nobody earned.
 *
 *   2. `openPlayerProfile()` presents it — a real bottom sheet with the
 *      portrait at full size in its frame metal, the title and level, the
 *      read on how they play, and the three actions a player actually wants
 *      (mute their emotes, report them, add them).
 *
 * Frame metal is also resolved here (`frameLook`) because the nameplate ring
 * and the sheet portrait must agree on the same alloy — rarity is expressed
 * as a metal, gunmetal → steel → copper → gold → rose gold, never as a hue.
 */

import { bus } from '../../core/bus.ts';
import type { PlayerRef, Rarity, TableState } from '../../core/types.ts';
import { itemById } from '../../data/catalog.ts';
import { getAvatarDataUrl } from '../../econ/avatars.ts';
import { econ, equippedId } from '../../econ/wallet.ts';
import { PERSONALITY_META, profileById } from '../../engine/profiles.ts';
import { icon } from '../components/icons.ts';
import { openSheet } from '../components/sheet.ts';
import type { SheetHandle } from '../components/sheet.ts';
import { prefs } from '../lobby/prefs.ts';
import { cls, h, press, setText } from './dom.ts';

// ═══════════════════════════ frame metal ═══════════════════════════

/** The alloy a portrait ring is struck from. A ladder, not a palette. */
export type Metal = 'gunmetal' | 'steel' | 'brass' | 'copper' | 'gold' | 'rose';

export interface FrameLook {
  metal: Metal;
  rarity: Rarity;
  /** the equipped frame's display name, when it resolves to a real item */
  frameName: string | null;
}

const RARITY_METAL: Record<Rarity, Metal> = {
  common: 'gunmetal',
  rare: 'steel',
  epic: 'copper',
  legendary: 'gold',
  mythic: 'rose',
};

/** Catalog frames carry a `metal` param — the authored answer wins. */
const PARAM_METAL: Record<string, Metal> = {
  steel: 'steel',
  chrome: 'steel',
  brass: 'brass',
  copper: 'copper',
  gold: 'gold',
  gunmetal: 'gunmetal',
};

/** The five ids the bot roster equips are not all in the catalog yet. */
const BOT_FRAMES: Record<string, [Metal, Rarity]> = {
  'frame-brass': ['brass', 'common'],
  'frame-onyx': ['gunmetal', 'rare'],
  'frame-royal': ['gold', 'legendary'],
  'frame-aurora': ['steel', 'epic'],
  'frame-champion': ['copper', 'epic'],
};

/** No frame equipped? Earn the alloy with account level instead. */
function rarityForLevel(level: number): Rarity {
  if (level >= 60) return 'mythic';
  if (level >= 38) return 'legendary';
  if (level >= 22) return 'epic';
  if (level >= 9) return 'rare';
  return 'common';
}

export function frameLook(frameId: string | null, level: number): FrameLook {
  if (frameId) {
    const item = itemById(frameId);
    if (item && item.kind === 'frame') {
      const param = String(item.params.metal ?? '');
      return {
        metal: PARAM_METAL[param] ?? RARITY_METAL[item.rarity],
        rarity: item.rarity,
        frameName: item.name,
      };
    }
    const known = BOT_FRAMES[frameId];
    if (known) return { metal: known[0], rarity: known[1], frameName: titleCase(frameId.replace(/^frame-/, '')) };
  }
  const rarity = rarityForLevel(level);
  return { metal: RARITY_METAL[rarity], rarity, frameName: null };
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ═══════════════════════════ identity ═══════════════════════════

/**
 * The hero's plate must say what the lobby says. Everything else on the table
 * is a `PlayerRef` from the engine, but the local player's display name,
 * portrait and frame live in prefs + the wallet, so they are resolved here
 * and nowhere else.
 */
export function heroIdentity(fallback: PlayerRef | null): PlayerRef {
  const name = prefs().displayName.trim();
  const e = econ();
  return {
    id: fallback?.id ?? 'you',
    name: name || fallback?.name || 'Player',
    avatarId: equippedId('avatar') ?? fallback?.avatarId ?? 'av-you',
    frameId: equippedId('frame') ?? fallback?.frameId ?? null,
    titleId: equippedId('title') ?? fallback?.titleId ?? null,
    emoteSetId: fallback?.emoteSetId ?? 'emote-core',
    level: Math.max(1, Math.floor(e.passXp / 900) + e.passTier),
    premium: e.premium,
    heat: fallback?.heat ?? 0,
    countryCode: fallback?.countryCode,
  };
}

/**
 * A name that fits a 34px-tall plate. Two-part names collapse to
 * "Ingrid H."; single handles are left alone and let the plate size its own
 * type down instead of chopping a word in half.
 */
export function shortName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 12) return trimmed;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const initial = parts[parts.length - 1].charAt(0).toUpperCase();
    const short = /[A-Z0-9]/i.test(initial) ? `${parts[0]} ${initial}.` : parts[0];
    if (short.length < trimmed.length) return short;
  }
  return trimmed;
}

/** The title a player wears, resolved to real words. */
export function titleText(titleId: string | null): string | null {
  if (!titleId) return null;
  const item = itemById(titleId);
  if (item) {
    const text = item.params.text;
    return typeof text === 'string' ? text : item.name;
  }
  return titleCase(titleId.replace(/^title-/, ''));
}

const COUNTRIES: Record<string, string> = {
  AR: 'Argentina', AU: 'Australia', BR: 'Brazil', CA: 'Canada', CL: 'Chile',
  CO: 'Colombia', CZ: 'Czechia', DE: 'Germany', DK: 'Denmark', EG: 'Egypt',
  ES: 'Spain', FI: 'Finland', FR: 'France', GB: 'United Kingdom', GR: 'Greece',
  HK: 'Hong Kong', IE: 'Ireland', IN: 'India', IT: 'Italy', JP: 'Japan',
  KR: 'South Korea', MA: 'Morocco', MX: 'Mexico', NG: 'Nigeria',
  NL: 'Netherlands', NO: 'Norway', PK: 'Pakistan', PL: 'Poland',
  PT: 'Portugal', RO: 'Romania', RU: 'Russia', SE: 'Sweden', SG: 'Singapore',
  SK: 'Slovakia', TR: 'Türkiye', UA: 'Ukraine', US: 'United States',
  VN: 'Vietnam', ZA: 'South Africa',
};

export function countryName(code: string | undefined): string | null {
  if (!code) return null;
  return COUNTRIES[code.toUpperCase()] ?? code.toUpperCase();
}

// ═══════════════════════════ session observer ═══════════════════════════

export interface ObservedStats {
  /** hands this client watched them be dealt into */
  hands: number;
  /** hands they voluntarily put chips in preflop */
  vpipHands: number;
  /** hands they raised or bet preflop */
  pfrHands: number;
  /** largest pot they dragged, in chips */
  biggestPot: number;
  potsWon: number;
  /** hands where you and they both put chips in */
  sharedHands: number;
  /** your attributed net against them, in chips (+ you are up) */
  netVsHero: number;
  /** their own net across every hand observed */
  net: number;
}

export interface SeatObserver {
  /** everything seen for a player id so far */
  statsFor(playerId: string): ObservedStats;
  /** hands the table has completed since this observer started */
  handsSeen(): number;
  dispose(): void;
}

/** Sample floors. Below these the sheet says so instead of printing noise. */
const MIN_HANDS_FOR_STYLE = 6;
const MIN_HANDS_FOR_NET = 3;

function blankStats(): ObservedStats {
  return {
    hands: 0,
    vpipHands: 0,
    pfrHands: 0,
    biggestPot: 0,
    potsWon: 0,
    sharedHands: 0,
    netVsHero: 0,
    net: 0,
  };
}

/**
 * Watches the bus and remembers what each seat actually did. Everything is
 * keyed by player id, not seat index, so a seat changing hands never merges
 * two players' numbers.
 */
export function createSeatObserver(heroSeat: number): SeatObserver {
  const byPlayer = new Map<string, ObservedStats>();
  let tableId = '';
  let handsSeen = 0;

  // ── per-hand accumulators, all keyed by seat
  let seatPlayer = new Map<number, string>();
  let committed = new Map<number, number>();
  let awarded = new Map<number, number>();
  let acted = new Set<number>();
  let voluntary = new Set<number>();
  let raised = new Set<number>();
  let inHand = false;

  const get = (id: string): ObservedStats => {
    let hit = byPlayer.get(id);
    if (!hit) {
      hit = blankStats();
      byPlayer.set(id, hit);
    }
    return hit;
  };

  const resetHand = (): void => {
    seatPlayer = new Map();
    committed = new Map();
    awarded = new Map();
    acted = new Set();
    voluntary = new Set();
    raised = new Set();
  };

  const noteSeats = (state: TableState): void => {
    for (const st of state.seats) {
      if (st.player) seatPlayer.set(st.index, st.player.id);
      // `totalCommitted` only ever grows inside a hand, so the running max is
      // immune to the order state pushes and hand:end arrive in.
      const prev = committed.get(st.index) ?? 0;
      if (st.totalCommitted > prev) committed.set(st.index, st.totalCommitted);
    }
  };

  const offs: Array<() => void> = [
    bus.on('table:state', ({ state }) => {
      if (state.id !== tableId) {
        tableId = state.id;
        byPlayer.clear();
        handsSeen = 0;
        resetHand();
        inHand = false;
      }
      noteSeats(state);
    }),

    bus.on('hand:start', () => {
      resetHand();
      inHand = true;
    }),

    bus.on('hand:action', ({ action, state }) => {
      noteSeats(state);
      acted.add(action.seat);
      if (action.street !== 'preflop') return;
      const k = action.kind;
      if (k === 'call' || k === 'bet' || k === 'raise' || k === 'allin') voluntary.add(action.seat);
      if (k === 'bet' || k === 'raise' || k === 'allin') raised.add(action.seat);
    }),

    bus.on('hand:award', ({ seat, amount }) => {
      awarded.set(seat, (awarded.get(seat) ?? 0) + amount);
    }),

    bus.on('hand:end', () => {
      if (!inHand) return;
      inHand = false;
      handsSeen++;

      // Net per seat is exact: what the pot paid them, less what they paid in.
      const nets = new Map<number, number>();
      const dealt: number[] = [];
      for (const [seat, id] of seatPlayer) {
        const paid = committed.get(seat) ?? 0;
        const won = awarded.get(seat) ?? 0;
        if (paid <= 0 && !acted.has(seat)) continue;
        dealt.push(seat);
        nets.set(seat, Math.round((won - paid) * 100) / 100);
        const s = get(id);
        s.hands++;
        if (voluntary.has(seat)) s.vpipHands++;
        if (raised.has(seat)) s.pfrHands++;
        if (won > 0) {
          s.potsWon++;
          if (won > s.biggestPot) s.biggestPot = won;
        }
        s.net = Math.round((s.net + (won - paid)) * 100) / 100;
      }

      // Chips only ever move from the hand's losers to its winners, so a
      // loser's damage can be attributed across the winners in proportion to
      // what each of them took. With one winner — the common case — this is
      // exact; with a split it is the only honest apportionment available.
      const heroNet = nets.get(heroSeat);
      if (heroNet === undefined || Math.abs(heroNet) < 1e-9) return;
      let winPool = 0;
      let lossPool = 0;
      for (const [seat, n] of nets) {
        if (seat === heroSeat) continue;
        if (n > 0) winPool += n;
        else lossPool += -n;
      }
      const heroPaid = committed.get(heroSeat) ?? 0;
      for (const seat of dealt) {
        if (seat === heroSeat) continue;
        const id = seatPlayer.get(seat);
        if (!id) continue;
        const n = nets.get(seat) ?? 0;
        const paid = committed.get(seat) ?? 0;
        if (heroPaid <= 0 || paid <= 0) continue;
        const s = get(id);
        s.sharedHands++;
        let transfer = 0;
        if (heroNet < 0 && n > 0 && winPool > 0) transfer = heroNet * (n / winPool);
        else if (heroNet > 0 && n < 0 && lossPool > 0) transfer = heroNet * (-n / lossPool);
        s.netVsHero = Math.round((s.netVsHero + transfer) * 100) / 100;
      }
    }),
  ];

  return {
    statsFor: (playerId: string) => byPlayer.get(playerId) ?? blankStats(),
    handsSeen: () => handsSeen,
    dispose(): void {
      for (const off of offs) off();
      offs.length = 0;
      byPlayer.clear();
    },
  };
}

// ═══════════════════════════ the sheet ═══════════════════════════

export interface ProfileTarget {
  seat: number;
  hero: boolean;
  player: PlayerRef;
  stack: number;
  /** big blind in chips, for the bb readout */
  bb: number;
  fmt: (v: number) => string;
}

export interface ProfileHost {
  observer: SeatObserver;
  heroSeat: number;
  isMuted(seat: number): boolean;
  setMuted(seat: number, on: boolean): void;
}

let openHandle: SheetHandle | null = null;

function statTile(label: string, value: string, opts: { tone?: 'up' | 'down'; soft?: boolean } = {}): HTMLElement {
  const v = h('div', { class: opts.soft ? 'pp__tv pp__tv--soft' : 'pp__tv tnum' }, value);
  if (opts.tone) v.dataset.tone = opts.tone;
  return h('div', { class: 'pp__tile' }, h('div', { class: 'pp__tl caps' }, label), v);
}

function actionTile(label: string, glyph: Node, onTap: () => void): HTMLElement {
  const labelEl = h('span', { class: 'pp__al' }, label);
  const el = h(
    'button',
    { class: 'pp__act', type: 'button' },
    h('span', { class: 'pp__ai' }, glyph),
    labelEl,
  );
  press(el, { haptic: 'select', sfx: 'tapSecondary', onPress: onTap });
  return el;
}

function pct(n: number, d: number): string {
  return `${Math.round((n / d) * 100)}%`;
}

/**
 * Opens the seat's profile. Tapping your own plate opens your own card
 * instead — same shape, your numbers, your actions.
 */
export function openPlayerProfile(target: ProfileTarget, host: ProfileHost): SheetHandle {
  openHandle?.close();

  const p = target.hero ? heroIdentity(target.player) : target.player;
  const look = frameLook(p.frameId, p.level);
  const title = titleText(p.titleId);
  const country = countryName(p.countryCode);
  const bot = target.hero ? null : profileById(p.id);
  const stats = host.observer.statsFor(target.player.id);
  const stackBb = target.bb > 0 ? `${(target.stack / target.bb).toFixed(target.stack / target.bb >= 100 ? 0 : 1)}bb` : '';

  // ── identity
  const portrait = h('img', {
    class: 'pp__img',
    alt: '',
    decoding: 'async',
    src: getAvatarDataUrl(p.avatarId, 96),
  });
  const idBlock = h(
    'div',
    { class: 'pp__id', 'data-metal': look.metal },
    h(
      'div',
      { class: 'pp__port' },
      h('i', { class: 'pp__ring' }),
      portrait,
      h('span', { class: 'pp__lvl tnum' }, String(p.level)),
    ),
    h(
      'div',
      { class: 'pp__who' },
      h('h2', { class: 'pp__name' }, p.name),
      title ? h('div', { class: 'pp__title' }, title) : null,
      h(
        'div',
        { class: 'pp__meta' },
        h('span', null, country ?? `Level ${p.level}`),
        country && look.frameName ? h('i', { class: 'pp__dot' }) : null,
        country && look.frameName ? h('span', null, `${look.frameName} frame`) : null,
      ),
      h(
        'div',
        { class: 'pp__stack' },
        h('span', { class: 'pp__sv tnum' }, target.fmt(target.stack)),
        stackBb ? h('span', { class: 'pp__sb tnum' }, stackBb) : null,
        h('span', { class: 'pp__sl caps' }, 'at this table'),
      ),
    ),
  );

  // ── the read
  const meta = bot ? PERSONALITY_META[bot.personality] : null;
  const read = meta
    ? h(
        'div',
        { class: 'pp__read', 'data-tone': meta.tone },
        h('div', { class: 'pp__rl caps' }, meta.label),
        h('p', { class: 'pp__rb' }, meta.blurb),
        bot && bot.tagline ? h('p', { class: 'pp__rt' }, `“${bot.tagline}”`) : null,
      )
    : null;

  // ── observed numbers
  const enoughStyle = stats.hands >= MIN_HANDS_FOR_STYLE;
  const enoughNet = stats.sharedHands >= MIN_HANDS_FOR_NET;
  const netValue = target.hero ? stats.net : stats.netVsHero;
  const netLabel = target.hero ? 'Net this session' : 'You vs them';
  const netReady = target.hero ? stats.hands > 0 : enoughNet;

  /** Copy that tells the truth about *why* a number is missing. */
  const thin = stats.hands === 0 ? 'No hands yet' : 'Not enough hands';

  const tiles = h(
    'div',
    { class: 'pp__tiles' },
    statTile('Hands seen', String(stats.hands)),
    enoughStyle
      ? statTile('VPIP / PFR', `${pct(stats.vpipHands, stats.hands)} · ${pct(stats.pfrHands, stats.hands)}`)
      : statTile('VPIP / PFR', thin, { soft: true }),
    stats.potsWon > 0
      ? statTile('Biggest pot', target.fmt(stats.biggestPot))
      : statTile('Biggest pot', stats.hands === 0 ? 'No hands yet' : 'No pots won yet', { soft: true }),
    netReady
      ? statTile(netLabel, `${netValue >= 0 ? '+' : '−'}${target.fmt(Math.abs(netValue))}`, {
          tone: netValue >= 0 ? 'up' : 'down',
        })
      : statTile(netLabel, thin, { soft: true }),
  );

  const note = h(
    'p',
    { class: 'pp__note' },
    target.hero
      ? 'Counted from the hands this session has dealt you — nothing carried over.'
      : enoughNet
        ? `Across ${stats.sharedHands} pot${stats.sharedHands === 1 ? '' : 's'} you both put chips into.`
        : 'Numbers appear as the session watches more hands.',
  );

  // ── actions
  let muted = host.isMuted(target.seat);
  const muteLabel = h('span', { class: 'pp__al' }, muted ? 'Unmute' : 'Mute emotes');
  const actions = h('div', { class: 'pp__acts' });

  if (target.hero) {
    actions.append(
      actionTile('Full stats', icon('chart', { size: 19, stroke: 1.9 }), () => {
        sheet.close();
        bus.emit('nav:route', { route: 'stats' });
      }),
      actionTile('My profile', icon('person', { size: 19, stroke: 1.9 }), () => {
        sheet.close();
        bus.emit('nav:route', { route: 'profile' });
      }),
    );
  } else {
    const muteBtn = h(
      'button',
      { class: 'pp__act', type: 'button' },
      h('span', { class: 'pp__ai' }, icon('comment', { size: 19, stroke: 1.9 })),
      muteLabel,
    );
    cls(muteBtn, 'is-on', muted);
    press(muteBtn, {
      haptic: 'select',
      sfx: 'tapSecondary',
      onPress: () => {
        muted = !muted;
        host.setMuted(target.seat, muted);
        setText(muteLabel, muted ? 'Unmute' : 'Mute emotes');
        cls(muteBtn, 'is-on', muted);
        bus.emit('ui:toast', {
          text: muted ? `${p.name}'s emotes muted` : `${p.name} unmuted`,
          tone: 'info',
          ms: 1500,
        });
      },
    });

    actions.append(
      muteBtn,
      actionTile('Report', icon('warning', { size: 19, stroke: 1.9 }), () => {
        bus.emit('ui:toast', { text: `Report sent for ${p.name}`, tone: 'info', ms: 1800 });
      }),
      actionTile('Add friend', icon('users', { size: 19, stroke: 1.9 }), () => {
        bus.emit('ui:toast', { text: `Friend request sent to ${p.name}`, tone: 'good', ms: 1800 });
      }),
    );
  }

  const body = h(
    'div',
    { class: 'pp' },
    idBlock,
    read,
    h('div', { class: 'pp__head caps' }, target.hero ? 'Your session' : 'Seen at this table'),
    tiles,
    note,
    actions,
  );

  const offs: Array<() => void> = [];

  const sheet = openSheet({
    class: 'pp-sheet',
    content: body,
    onClose: () => {
      for (const off of offs) off();
      offs.length = 0;
      if (openHandle === sheet) openHandle = null;
    },
  });
  openHandle = sheet;

  // The sheet must never be the reason you missed an action: the moment it is
  // your turn it gets out of the way, so it can never cover the action bar.
  offs.push(
    bus.on('hand:turn', ({ seat }) => {
      if (seat === host.heroSeat) sheet.close();
    }),
    bus.on('nav:route', () => sheet.close()),
  );

  return sheet;
}

/** Closes any open profile — used when the table screen tears down. */
export function closePlayerProfile(): void {
  openHandle?.close();
  openHandle = null;
}
