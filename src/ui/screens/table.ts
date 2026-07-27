/**
 * ROYALE — the table screen.
 *
 * Assembles the whole in-game HUD: status bar, seat nameplates anchored to the
 * 3D stage, the pot, the hero's hand-strength strip, the action bar, emotes,
 * the winner banner, the in-game menu, hand history and the buy-in flow.
 *
 * It drives `src/engine/table.ts` when that module is available and silently
 * falls back to a self-contained scripted table otherwise, so this screen is
 * never blank and never broken.
 */

// Vite compiles this import; the project has no ambient CSS module declaration
// yet, so the checker is told to stand down on this one line.
// @ts-ignore -- CSS side-effect import handled by the bundler
import '../styles/table.css';

import { bus } from '../../core/bus.ts';
import type { LegalAction } from '../../core/bus.ts';
import { chips as chipFmt, STAKES } from '../../core/stakes.ts';
import type {
  ActionKind,
  CardId,
  HandCategory,
  Pot,
  ShowdownResult,
  StakeId,
  TableState,
} from '../../core/types.ts';

import { createActionBar } from '../table/actionbar.ts';
import type { ActionBar } from '../table/actionbar.ts';
import { createBuyInSheet } from '../table/buyin.ts';
import { DemoTable } from '../table/demo.ts';
import { cls, delay, h, onFrame, press, readSetting, setText, writeSetting } from '../table/dom.ts';
import { createEmoteFlight, createEmoteWheel, createSeatMenu } from '../table/emotes.ts';
import { createHandStrength, evalBest, handStrengthEnabled } from '../table/handstrength.ts';
import { createHistoryPanel, HandRecorder } from '../table/history.ts';
import { icon } from '../table/icons.ts';
import { createPlateLayer } from '../table/nameplate.ts';
import type { PlateBounds, PlateContext } from '../table/nameplate.ts';
import { createPotDisplay } from '../table/potdisplay.ts';
import { createStatusBar } from '../table/statusbar.ts';
import { createToolbar } from '../table/toolbar.ts';
import type { SkinId } from '../table/toolbar.ts';
import { createWinnerBanner } from '../table/winner.ts';

// ─────────────────────── stage bridge ───────────────────────

interface StageAnchorLike {
  x: number;
  y: number;
  visible: boolean;
}

interface StageBridge {
  getAnchor?(seat: number): { x: number; y: number };
  anchors?: {
    seats: StageAnchorLike[];
    pot: StageAnchorLike;
    width: number;
    height: number;
  };
  setSkin?(skin: Record<string, unknown>): void;
  setHeroSeat?(seat: number): void;
  setTableSize?(size: number): void;
}

/**
 * Money the way a poker room prints it: two decimals, trailing zeroes dropped
 * on round amounts, compacted only once the numbers get long. `core/stakes.ts`
 * `money()` is tuned for dense lobby chrome and renders $11.10 as "$11.1",
 * which reads as a typo on a stack.
 */
function cashText(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 100_000) return `${sign}$${Math.round(a / 1000)}K`;
  if (a >= 10_000) return `${sign}$${(a / 1000).toFixed(1)}K`;
  const fixed = (Math.round(a * 100) / 100).toFixed(2);
  return `${sign}$${fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed}`;
}

function stage(): StageBridge | null {
  const w = window as unknown as { __royale?: { renderer?: StageBridge } };
  return w.__royale?.renderer ?? null;
}

const SKIN_PARAMS: Record<SkinId, Record<string, unknown>> = {
  emerald: { feltHue: 0.42, feltColor: '#14432d', railColor: '#2b1d10' },
  midnight: { feltHue: 0.6, feltColor: '#132a44', railColor: '#161a26' },
  crimson: { feltHue: 0.02, feltColor: '#4a1420', railColor: '#2a1410' },
  sand: { feltHue: 0.12, feltColor: '#4a3a1c', railColor: '#33240f' },
};

// ─────────────────────── driver contract ───────────────────────

interface TableDriver {
  start(): void;
  destroy(): void;
  act(kind: ActionKind, amount?: number): boolean;
  sitOut(on: boolean): void;
  rebuy(amount: number): boolean;
  state(): TableState;
  legalActions(): LegalAction[];
}

interface DriverConfig {
  stakeId: StakeId;
  seatCount: number;
  heroSeat: number;
  buyIn: number;
  autoRebuy: boolean;
}

async function createDriver(cfg: DriverConfig): Promise<{ driver: TableDriver; engine: boolean }> {
  try {
    const mod = (await import('../../engine/table.ts')) as unknown as {
      LocalTable?: new (o: Record<string, unknown>) => TableDriver;
    };
    if (mod && typeof mod.LocalTable === 'function') {
      const driver = new mod.LocalTable({
        stakeId: cfg.stakeId,
        seatCount: cfg.seatCount,
        heroSeat: cfg.heroSeat,
        heroBuyIn: cfg.buyIn,
        autoRebuy: cfg.autoRebuy,
        continuous: true,
      });
      if (typeof driver.state === 'function' && typeof driver.act === 'function') {
        return { driver, engine: true };
      }
    }
  } catch (err) {
    console.warn('[table] local engine unavailable, running the scripted table', err);
  }
  return {
    driver: new DemoTable({
      stakeId: cfg.stakeId,
      seatCount: cfg.seatCount,
      heroSeat: cfg.heroSeat,
      buyIn: cfg.buyIn,
    }),
    engine: false,
  };
}

// ─────────────────────── screen ───────────────────────

export interface TableScreen {
  (): void;
  destroy(): void;
  unmount(): void;
  el: HTMLElement;
}

export interface TableScreenParams {
  stake?: string;
  seats?: string;
  /** '1' skips the buy-in sheet and sits with the default stack */
  quick?: string;
}

export function mount(container: HTMLElement, params: TableScreenParams = {}): TableScreen {
  const stakeId: StakeId = (params.stake && params.stake in STAKES ? params.stake : 'nl10') as StakeId;
  const stake = STAKES[stakeId];
  const seatCount = Math.max(2, Math.min(9, Number(params.seats ?? 6) || 6));
  const heroSeat = 0;

  let format: TableState['format'] = 'cash';
  const fmt = (v: number): string => (format === 'sng' ? chipFmt(v) : cashText(v));

  // ── state
  let state: TableState | null = null;
  let driver: TableDriver | null = null;
  let usingEngine = false;
  let seated = false;
  let myTurn = false;
  let bannerShown = false;
  let handsPlayed = 0;
  let heroStackAtHandStart = 0;
  const offs: Array<() => void> = [];
  const recorder = new HandRecorder();

  const settings = {
    autoRebuy: readSetting('autoRebuy', true),
    sound: readSetting('sound', true),
    skin: readSetting<SkinId>('skin', 'emerald'),
    handStrength: handStrengthEnabled(),
    sitOut: false,
  };

  // ── chrome
  const root = h('div', { class: 'table-screen' });

  const statusBar = createStatusBar({
    tableName: 'Royale Room',
    onMenu: () => toolbar.open(),
  });

  const plates = createPlateLayer({
    seatCount,
    heroSeat,
    getAnchor: (seat) => {
      const st = stage();
      const a = st?.anchors?.seats?.[seat];
      if (a) return { x: a.x, y: a.y, visible: a.visible !== false };
      const g = st?.getAnchor?.(seat);
      return g ? { x: g.x, y: g.y, visible: true } : null;
    },
    bounds: (): PlateBounds => {
      const top = plateTop();
      return { top, bottom: bottomLimit, left: 8, right: window.innerWidth - 8 };
    },
    // Nothing may sit on top of the pot readout.
    reserved: () => (potRect.w > 0 ? potRect : null),
    onLongPress: (seat, el) => {
      const st = state?.seats[seat];
      if (!st?.player) return;
      const r = el.getBoundingClientRect();
      if (seat === heroSeat) {
        wheel.open(r.left + r.width / 2, r.top, heroSeat, true);
        return;
      }
      seatMenu.open(seat, st.player.name, r.left + r.width / 2, r.bottom, plates.isMuted(seat));
    },
  });

  const pot = createPotDisplay(fmt);
  const winner = createWinnerBanner(fmt);
  const handStrength = createHandStrength();
  handStrength.setEnabled(settings.handStrength);

  const actionBar: ActionBar = createActionBar({
    fmt,
    step: 0.01,
    onAct: (kind, amount) => {
      myTurn = false;
      try {
        driver?.act(kind, amount);
      } catch (err) {
        console.error('[table] action rejected', err);
        bus.emit('ui:toast', { text: 'That action is no longer legal', tone: 'bad' });
      }
    },
  });

  const wheel = createEmoteWheel({
    heroSeat: () => heroSeat,
  });
  const flight = createEmoteFlight();

  const seatMenu = createSeatMenu({
    onMute: (seat, on) => {
      plates.setMuted(seat, on);
      bus.emit('ui:toast', {
        text: on ? `${state?.seats[seat]?.player?.name ?? 'Player'} muted` : 'Unmuted',
        tone: 'info',
        ms: 1400,
      });
    },
    onReact: (seat, x, y) => wheel.open(x, y - 40, seat, false),
  });

  const history = createHistoryPanel({ recorder, fmt, heroSeat: () => heroSeat });

  const buyIn = createBuyInSheet({
    fmt,
    onConfirm: (amount) => {
      if (!seated) void sitDown(amount);
      else {
        driver?.rebuy(amount);
        bus.emit('ui:toast', { text: `Added ${fmt(amount)}`, tone: 'good', ms: 1600 });
      }
    },
  });

  const toolbar = createToolbar({
    tableName: 'Royale Room',
    stakeLabel: stake.label,
    formatLabel: `${seatCount}-max · No Limit`,
    fmt,
    initial: {
      sitOut: settings.sitOut,
      autoRebuy: settings.autoRebuy,
      sound: settings.sound,
      handStrength: settings.handStrength,
      skin: settings.skin,
    },
    onLeave: () => leave(),
    onSitOut: (on) => {
      settings.sitOut = on;
      driver?.sitOut(on);
      bus.emit('ui:toast', { text: on ? 'Sitting out next hand' : 'Back in next hand', tone: 'info', ms: 1600 });
    },
    onAutoRebuy: (on) => {
      settings.autoRebuy = on;
      writeSetting('autoRebuy', on);
    },
    onSound: (on) => {
      settings.sound = on;
      writeSetting('sound', on);
      void import('../../audio/audio.ts')
        .then((m) => m.setMuted?.(!on))
        .catch(() => void 0);
    },
    onHandStrength: (on) => {
      settings.handStrength = on;
      handStrength.setEnabled(on);
    },
    onSkin: (skin) => {
      settings.skin = skin;
      writeSetting('skin', skin);
      try {
        stage()?.setSkin?.(SKIN_PARAMS[skin]);
      } catch {
        /* the stage may not be up yet */
      }
      root.dataset.skin = skin;
    },
    onHistory: () => history.openLog(),
    onLastHand: () => history.openLastHand(),
    onRebuy: () => openRebuy(),
  });

  // ── emote key
  const emoteBtn = h(
    'button',
    { class: 'emote-key', type: 'button', 'aria-label': 'Send a reaction' },
    icon('emote', 22),
  );
  press(emoteBtn, {
    longMs: 220,
    exclusiveLong: true,
    haptic: 'select',
    onLongPress: () => {
      const r = emoteBtn.getBoundingClientRect();
      wheel.open(r.left + r.width / 2, r.top - 10, heroSeat, true);
    },
    onPress: () => {
      const r = emoteBtn.getBoundingClientRect();
      wheel.open(r.left + r.width / 2, r.top - 10, heroSeat, false);
    },
  });

  // ── centre states
  const joinBtn = h('button', { class: 'ov__go', type: 'button' }, h('i', { class: 'ov__go-sheen' }), 'Take a seat');
  const joinPanel = h(
    'div',
    { class: 'ov ov--join' },
    h('i', { class: 'ov__glow' }),
    h('div', { class: 'ov__kicker' }, 'NO LIMIT HOLD’EM'),
    h('div', { class: 'ov__title' }, stake.label),
    h('div', { class: 'ov__body' }, `Buy in from ${fmt(stake.minBuyIn)} to ${fmt(stake.maxBuyIn)}. ${seatCount} seats, blinds every hand.`),
    joinBtn,
  );
  press(joinBtn, { haptic: 'select', sfx: 'tapPrimary', onPress: () => openBuyIn() });

  const waitCount = h('div', { class: 'ov__body' }, 'Waiting for players');
  const waitPanel = h(
    'div',
    { class: 'ov ov--wait' },
    h('div', { class: 'ov__dealer' }, h('i', { class: 'ov__chip' }), h('i', { class: 'ov__chip' }), h('i', { class: 'ov__chip' })),
    h('div', { class: 'ov__title ov__title--sm' }, 'Table filling up'),
    waitCount,
  );

  const centre = h('div', { class: 'table-centre' }, joinPanel, waitPanel);

  const heroZone = h(
    'div',
    { class: 'hero-zone' },
    handStrength.el,
    h('div', { class: 'hero-zone__side' }, emoteBtn),
    actionBar.el,
  );

  root.append(
    statusBar.el,
    plates.el,
    centre,
    winner.el,
    pot.el,
    heroZone,
    flight.el,
    wheel.el,
    seatMenu.el,
    toolbar.el,
    history.el,
    buyIn.el,
  );
  root.dataset.skin = settings.skin;
  container.appendChild(root);

  // ── layout helpers. Measured on a cadence, never per frame: the plate loop
  // writes transforms only, and a layout read every frame would undo that.
  let topLimit = 62;
  let bottomLimit = window.innerHeight - 190;
  let measureAcc = 1e4;
  const potRect = { x: 0, y: 0, w: 0, h: 0 };

  function remeasure(): void {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--safe-t').trim();
    const safe = css.endsWith('px') ? parseFloat(css) : 0;
    topLimit = (Number.isFinite(safe) ? safe : 0) + 62;
    const zone = heroZone.getBoundingClientRect();
    bottomLimit = zone.height > 0 ? zone.top - 6 : window.innerHeight - 190;
    const pr = pot.el.getBoundingClientRect();
    potRect.w = pr.width;
    potRect.h = pr.height;
  }

  function plateTop(): number {
    return topLimit;
  }

  // ── pot anchor tracking
  const stopFrame = onFrame((dt) => {
    measureAcc += dt;
    if (measureAcc > 260) {
      measureAcc = 0;
      remeasure();
    }
    const st = stage();
    const a = st?.anchors?.pot;
    const w = window.innerWidth;
    if (a && a.visible !== false && a.x > 0) {
      potRect.x = Math.max(70, Math.min(w - 70, a.x));
      potRect.y = Math.max(topLimit + 40, Math.min(bottomLimit - 30, a.y));
    } else {
      potRect.x = w / 2;
      potRect.y = Math.min(bottomLimit - 40, window.innerHeight * 0.42);
    }
    pot.place(potRect.x, potRect.y);
  });

  // ─────────────────────── context helpers ───────────────────────

  function heroState() {
    return state?.seats[heroSeat] ?? null;
  }

  function bigBlind(): number {
    return state?.tournament?.bb ?? stake.bb;
  }

  /**
   * Pots already carry every chip committed this hand, so the felt total is
   * the larger of the two views — which also covers the beat before the first
   * action, when the pot list is still empty but the blinds are down.
   */
  function potTotal(): number {
    if (!state) return 0;
    const inPots = state.pots.reduce((a, p) => a + p.amount, 0);
    const committed = state.seats.reduce((a, s) => a + s.totalCommitted, 0);
    return Math.round(Math.max(inPots, committed) * 100) / 100;
  }

  function barContext() {
    const hero = heroState();
    const bb = bigBlind();
    const toCall = hero ? Math.max(0, Math.min((state?.currentBet ?? 0) - hero.committed, hero.stack)) : 0;
    return {
      toCall: Math.round(toCall * 100) / 100,
      pot: potTotal(),
      stack: hero?.stack ?? 0,
      bb,
      street: state?.street ?? ('preflop' as TableState['street']),
    };
  }

  function plateContext(): PlateContext {
    return { bb: bigBlind(), fmt, muted: false, showBb: format !== 'sng' };
  }

  function refreshCentre(): void {
    const occupied = state ? state.seats.filter((s) => s.player).length : 0;
    const showJoin = !seated;
    const showWait = seated && (!state || state.handId === 0 || occupied < 2);
    cls(joinPanel, 'is-shown', showJoin);
    cls(waitPanel, 'is-shown', showWait);
    cls(centre, 'is-shown', showJoin || showWait);
    if (showWait) setText(waitCount, occupied < 2 ? 'Waiting for players' : 'Shuffling up…');
  }

  // ─────────────────────── lifecycle ───────────────────────

  function openBuyIn(): void {
    buyIn.open({
      min: stake.minBuyIn,
      max: stake.maxBuyIn,
      value: Math.min(stake.maxBuyIn, stake.bb * 100),
      bb: stake.bb,
      title: 'Buy in',
      confirmLabel: 'Sit down',
      context: `${stake.label} · ${seatCount}-max · No Limit Hold’em`,
    });
  }

  function openRebuy(): void {
    const hero = heroState();
    const room = Math.max(0, stake.maxBuyIn - (hero?.stack ?? 0));
    if (room <= 0) {
      bus.emit('ui:toast', { text: 'You are already at the table maximum', tone: 'info', ms: 1800 });
      return;
    }
    buyIn.open({
      min: Math.min(stake.bb * 10, room),
      max: room,
      value: Math.min(room, Math.max(stake.bb * 20, stake.bb * 100 - (hero?.stack ?? 0))),
      bb: stake.bb,
      title: 'Add chips',
      confirmLabel: 'Add chips',
      context: `Stack ${fmt(hero?.stack ?? 0)} · max ${fmt(stake.maxBuyIn)}`,
    });
  }

  async function sitDown(amount: number): Promise<void> {
    if (seated) return;
    seated = true;
    refreshCentre();
    try {
      stage()?.setTableSize?.(seatCount);
      stage()?.setHeroSeat?.(heroSeat);
      stage()?.setSkin?.(SKIN_PARAMS[settings.skin]);
    } catch {
      /* the stage stays optional */
    }

    const made = await createDriver({
      stakeId,
      seatCount,
      heroSeat,
      buyIn: amount,
      autoRebuy: settings.autoRebuy,
    });
    driver = made.driver;
    usingEngine = made.engine;

    try {
      driver.start();
    } catch (err) {
      console.warn('[table] engine failed to start, falling back', err);
      try {
        driver.destroy();
      } catch {
        /* already dead */
      }
      driver = new DemoTable({ stakeId, seatCount, heroSeat, buyIn: amount });
      usingEngine = false;
      driver.start();
    }

    statusBar.setConnection('live');
    root.dataset.driver = usingEngine ? 'engine' : 'scripted';
    actionBar.setIdleMessage(null);
    bus.emit('ui:toast', { text: `Seated with ${fmt(amount)}`, tone: 'good', ms: 1600 });
  }

  function leave(): void {
    const net = recorder.net();
    try {
      driver?.destroy();
    } catch {
      /* nothing to clean */
    }
    driver = null;
    seated = false;
    bus.emit('ui:toast', {
      text: handsPlayed > 0 ? `Left the table · ${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}` : 'Left the table',
      tone: net >= 0 ? 'good' : 'info',
      ms: 2200,
    });
    bus.emit('nav:route', { route: 'lobby' });
  }

  // ─────────────────────── bus wiring ───────────────────────

  offs.push(
    bus.on('table:state', ({ state: next, you }) => {
      state = next;
      format = next.format;
      recorder.observe(next);
      statusBar.update(next);
      plates.sync(next, plateContext());
      const anyAllIn = next.seats.some((s) => s.status === 'allin');
      pot.setPots(next.pots, potTotal(), anyAllIn);
      pot.setAllIn(anyAllIn);

      const hero = next.seats[you] ?? next.seats[heroSeat];
      if (hero) {
        handStrength.update(hero.holeCards, next.board, next.street);
        handStrength.setVisible(hero.holeCards.length > 0 && next.street !== 'showdown');
      }
      actionBar.setContext(barContext());
      toolbar.setCanRebuy(next.format === 'cash' && (hero?.stack ?? 0) < stake.maxBuyIn);
      refreshCentre();
    }),

    bus.on('hand:start', () => {
      if (!state) return;
      bannerShown = false;
      handsPlayed++;
      recorder.begin(state, heroSeat);
      pot.reset();
      winner.hide();
      actionBar.clearPreAction();
      heroStackAtHandStart = state.seats[heroSeat]?.stack ?? 0;
      refreshCentre();
    }),

    bus.on('hand:deal-board', ({ cards }) => {
      recorder.board(cards.slice());
    }),

    bus.on('hand:turn', ({ seat, timeMs, legal }) => {
      if (seat !== heroSeat) {
        if (myTurn) {
          myTurn = false;
          actionBar.endTurn();
        }
        actionBar.setIdleMessage(null);
        return;
      }
      myTurn = true;
      actionBar.setTurn(legal, timeMs || 25_000, barContext());
    }),

    bus.on('hand:action', ({ action }) => {
      recorder.action(action);
      if (action.seat === heroSeat && myTurn) {
        myTurn = false;
        actionBar.endTurn();
      }
    }),

    bus.on('hand:pot-update', ({ pots, total }) => {
      pot.setPots(pots, total, !!state?.seats.some((s) => s.status === 'allin'));
    }),

    bus.on('hand:collect', ({ total }) => {
      pot.collect(total);
    }),

    bus.on('hand:showdown', ({ results, pots }) => {
      recorder.showdown(results);
      showWinner(results, pots);
    }),

    bus.on('hand:award', ({ seat, amount }) => {
      recorder.award(seat, amount);
      plates.showDelta(seat, amount, fmt);
      if (!bannerShown) {
        const name = state?.seats[seat]?.player?.name ?? 'Winner';
        winner.show({
          seat,
          name,
          amount,
          category: null,
          label: '',
          cards: [],
          hero: seat === heroSeat,
          uncontested: true,
        });
        bannerShown = true;
      }
    }),

    bus.on('hand:end', () => {
      if (!state) return;
      const entry = recorder.end(state);
      if (entry) {
        history.refresh();
        toolbar.setStats(recorder.entries().length, recorder.net());
      }
      myTurn = false;
      actionBar.endTurn();
      handStrength.setVisible(false);
      // Wins float up from the award event; a loss is only worth stating for
      // the hero, and only once the chips have finished moving.
      const heroNow = state.seats[heroSeat]?.stack ?? 0;
      const heroDelta = Math.round((heroNow - heroStackAtHandStart) * 100) / 100;
      if (heroDelta < -1e-6) plates.showDelta(heroSeat, heroDelta, fmt);
    }),

    bus.on('social:reaction', ({ kind, fromSeat, targetSeat }) => {
      if (plates.isMuted(fromSeat)) return;
      const from = plates.positionOf(fromSeat);
      const to = plates.positionOf(targetSeat);
      flight.fly(kind, from, { x: to.x, y: to.y - 34 }, () => plates.emote(targetSeat, kind));
    }),

    bus.on('social:chat', ({ fromSeat, text }) => {
      if (plates.isMuted(fromSeat)) return;
      plates.chat(fromSeat, text);
    }),
  );

  function showWinner(results: readonly ShowdownResult[], pots: readonly Pot[]): void {
    if (bannerShown) return;
    const winners = results.filter((r) => r.won > 0);
    if (winners.length === 0) return;
    const best = winners.reduce((a, r) => (r.won > a.won ? r : a), winners[0]);
    const seatState = state?.seats[best.seat];
    // The engine and the HUD each name hands; the HUD's phrasing wins so the
    // banner and the hand-strength strip always agree.
    let label = '';
    let cards: CardId[] = [];
    let category: HandCategory | null = best.rank?.category ?? null;
    const engineBest = best.rank?.best;
    if (engineBest && engineBest.length === 5) {
      const named = evalBest(engineBest);
      label = named.label;
      cards = named.best;
      category = named.category;
    } else if (seatState && seatState.holeCards.length >= 2 && state && state.board.length >= 3) {
      const computed = evalBest(seatState.holeCards.concat(state.board));
      label = computed.label;
      cards = computed.best;
      category = computed.category;
    } else {
      label = best.rank?.label ?? '';
      cards = best.rank?.best?.slice() ?? [];
    }
    const total = winners.reduce((a, r) => a + r.won, 0);
    winner.show({
      seat: best.seat,
      name: seatState?.player?.name ?? `Seat ${best.seat + 1}`,
      amount: winners.length > 1 ? best.won : total || pots.reduce((a, p) => a + p.amount, 0),
      category,
      label,
      cards,
      hero: best.seat === heroSeat,
      uncontested: !label,
      splitWith: winners.length,
    });
    bannerShown = true;
  }

  // ── open the buy-in as soon as the screen settles
  const cancelAuto = delay(params.quick === '1' ? 30 : 420, () => {
    if (seated) return;
    if (params.quick === '1') void sitDown(Math.min(stake.maxBuyIn, stake.bb * 100));
    else openBuyIn();
  });

  remeasure();
  refreshCentre();
  actionBar.setIdleMessage('Take a seat to join the action');
  toolbar.setStats(0, 0);
  statusBar.setConnection('live');

  // ─────────────────────── teardown ───────────────────────

  const destroy = (): void => {
    cancelAuto();
    stopFrame();
    for (const off of offs) off();
    offs.length = 0;
    try {
      driver?.destroy();
    } catch {
      /* already gone */
    }
    driver = null;
    plates.dispose();
    pot.dispose();
    winner.dispose();
    handStrength.dispose();
    actionBar.dispose();
    wheel.dispose();
    flight.dispose();
    seatMenu.dispose();
    history.dispose();
    buyIn.dispose();
    toolbar.dispose();
    statusBar.dispose();
    root.remove();
  };

  // A callable handle: shells that expect `view()`, `view.destroy()` or
  // `view.unmount()` all work without a contract negotiation.
  const handle = (() => destroy()) as TableScreen;
  handle.destroy = destroy;
  handle.unmount = destroy;
  handle.el = root;
  return handle;
}

export default { mount };
