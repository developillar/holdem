/**
 * ROYALE — screens/settings.ts
 * ────────────────────────────────────────────────────────────────────────────
 * A settings screen that behaves like a native one: grouped sections with
 * small-caps headers, 56px rows with inset hairlines, switches that snap,
 * sliders that show their value while you drag, and a footer caption under
 * any group that needs a sentence of explanation.
 *
 * Nothing here is decorative — every control writes through `lobby/prefs.ts`,
 * which persists to localStorage and republishes on the bus, so audio, the
 * renderer and the table all react live.
 *
 * Sections: Audio · Haptics · Graphics · Gameplay · Account · Privacy ·
 *           Responsible Play · Legal
 */
import '../styles/lobby.css';
import { bus } from '../../core/bus.ts';
import { h } from '../dom.ts';
import { Button } from '../components/button.ts';
import { Toggle } from '../components/toggle.ts';
import { Slider } from '../components/slider.ts';
import { Segmented } from '../components/segmented.ts';
import { Avatar } from '../components/avatar.ts';
import { openSheet } from '../components/sheet.ts';
import { confirmModal } from '../components/modal.ts';
import { icon } from '../components/icons.ts';
import type { IconName } from '../components/icons.ts';
import { haptic, pressFeedback } from '../components/util.ts';

import {
  prefs,
  setPref,
  setPrefs,
  resetPrefs,
  sessionElapsedMs,
  onBreak,
} from '../lobby/prefs.ts';
import type { HapticStrength, QualityTier, SessionLimit, TableSkin } from '../lobby/prefs.ts';
import { bankroll } from '../lobby/bankroll.ts';
import { cash, clockMs } from '../lobby/data.ts';

// ── row primitives ───────────────────────────────────────────────────

interface RowOpts {
  icon?: IconName;
  tint?: string;
  title: string;
  sub?: string;
  value?: string;
  trailing?: Node;
  chevron?: boolean;
  danger?: boolean;
  onTap?: () => void;
}

function Row(o: RowOpts): HTMLElement {
  const interactive = !!o.onTap;
  const el = h(
    interactive ? 'button' : 'div',
    {
      class: `st__row${o.danger ? ' is-danger' : ''}${interactive ? ' is-tap' : ''}`,
      type: interactive ? 'button' : null,
    },
    o.icon
      ? h(
          'span',
          { class: 'st__ic', style: o.tint ? { '--tint': o.tint } : undefined, 'aria-hidden': 'true' },
          icon(o.icon, { size: 15.5, stroke: 1.9 }),
        )
      : null,
    h(
      'span',
      { class: 'st__main' },
      h('span', { class: 'st__title' }, o.title),
      o.sub ? h('span', { class: 'st__sub' }, o.sub) : null,
    ),
    o.value !== undefined ? h('span', { class: 'st__val tnum' }, o.value) : null,
    o.trailing ? h('span', { class: 'st__trail' }, o.trailing) : null,
    o.chevron ? h('span', { class: 'st__chev', 'aria-hidden': 'true' }, icon('chevron-right', { size: 16, stroke: 2.1 })) : null,
  );
  if (interactive) {
    pressFeedback(el);
    el.addEventListener('click', () => {
      haptic('tick');
      o.onTap?.();
    });
  }
  return el;
}

interface SliderRowOpts {
  icon?: IconName;
  tint?: string;
  title: string;
  value: number;
  disabled?: boolean;
  onChange(v: number): void;
}

function SliderRow(o: SliderRowOpts): HTMLDivElement & { setDisabled(on: boolean): void } {
  const readout = h('span', { class: 'st__pct tnum' }, `${Math.round(o.value * 100)}`);
  const sld = Slider({
    min: 0,
    max: 1,
    step: 0.01,
    value: o.value,
    ariaLabel: o.title,
    disabled: o.disabled,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      readout.textContent = String(Math.round(v * 100));
      o.onChange(v);
    },
  });
  const el = h(
    'div',
    { class: 'st__row st__row--slider' },
    o.icon
      ? h('span', { class: 'st__ic', style: o.tint ? { '--tint': o.tint } : undefined, 'aria-hidden': 'true' }, icon(o.icon, { size: 15.5, stroke: 1.9 }))
      : null,
    h(
      'span',
      { class: 'st__sldmain' },
      h('span', { class: 'st__sldhead' }, h('span', { class: 'st__title' }, o.title), readout),
      sld,
    ),
  ) as HTMLDivElement & { setDisabled(on: boolean): void };
  el.setDisabled = (on) => {
    sld.setDisabled(on);
    el.classList.toggle('is-off', on);
  };
  return el;
}

function Group(title: string, rows: Node[], footer?: string): HTMLElement {
  return h(
    'section',
    { class: 'st__group' },
    h('h2', { class: 'st__gh caps' }, title),
    h('div', { class: 'st__card' }, ...rows),
    footer ? h('p', { class: 'st__gf' }, footer) : null,
  );
}

function SegRow(
  glyph: IconName,
  tint: string,
  title: string,
  items: Array<{ id: string; label: string }>,
  value: string,
  onChange: (id: string) => void,
  sub?: string,
): HTMLElement {
  return h(
    'div',
    { class: 'st__row st__row--seg' },
    h('span', { class: 'st__ic', style: { '--tint': tint }, 'aria-hidden': 'true' }, icon(glyph, { size: 15.5, stroke: 1.9 })),
    h(
      'span',
      { class: 'st__segmain' },
      h('span', { class: 'st__seghead' }, h('span', { class: 'st__title' }, title), sub ? h('span', { class: 'st__sub' }, sub) : null),
      Segmented({ items, value, size: 'sm', full: true, ariaLabel: title, onChange: (id) => onChange(id) }),
    ),
  );
}

// ── legal copy ───────────────────────────────────────────────────────

const LEGAL: Record<string, { title: string; body: string[] }> = {
  terms: {
    title: 'Terms of Play',
    body: [
      'Royale is a play-money poker app. Chips and gems have no cash value, cannot be exchanged for money or transferred between accounts, and are licensed to you for entertainment only.',
      'You agree not to use automation, solvers or real-time assistance while seated at a table. Hand histories are analysed for collusion and chip dumping; accounts found doing either lose their balance and their seat.',
      'We may adjust stake ladders, reward schedules and season content at any time. Where a change removes something you have bought with gems, an equivalent item is granted automatically.',
      'The app is provided as-is. Nothing here is gambling advice, and nothing here is an invitation to gamble with money.',
    ],
  },
  privacy: {
    title: 'Privacy',
    body: [
      'Everything this build stores lives on your device: preferences, your streak, your session clock and your local hand history. There is no account server in single player, so none of it leaves the phone.',
      'When you connect to a multiplayer room, the server receives only what the table needs — your display name, avatar id, equipped cosmetics and your actions. It never receives your contacts, your location or your device identifiers.',
      'Clearing local data from Settings removes every stored preference and the whole hand archive immediately, with no server-side copy to chase.',
    ],
  },
  licenses: {
    title: 'Open source',
    body: [
      'Three.js — MIT License. Copyright © 2010–2026 three.js authors. Used for the WebGL table, cards, chips and lighting.',
      'ws — MIT License. Copyright © 2011 Einar Otto Stangvik. Used by the multiplayer server for the socket transport.',
      'Everything else — the card and chip meshes, the felt and metal shaders, the icon set, the sound design and the type scale — is generated at runtime by this app. No fonts, textures, audio files or images are downloaded.',
    ],
  },
  fairness: {
    title: 'Shuffle & fairness',
    body: [
      'Deals use a xoshiro128** generator seeded from the platform CSPRNG at the start of every hand. The shuffle is a Fisher–Yates pass over the full 52-card deck, so every ordering is equally likely.',
      'Bots do not see your hole cards. They act on the same public information you do, plus a per-personality read on betting patterns.',
      'Every hand is recorded with its seed, so any hand in your history can be replayed exactly as it was dealt.',
    ],
  },
};

function openLegal(key: keyof typeof LEGAL): void {
  const doc = LEGAL[key];
  openSheet({
    eyebrow: 'Royale',
    title: doc.title,
    class: 'sheet--legal',
    content: h('div', { class: 'st__legal' }, ...doc.body.map((p) => h('p', null, p))),
  });
}

// ── screen ───────────────────────────────────────────────────────────

export interface SettingsInstance {
  unmount(): void;
}

export function mount(container: HTMLElement): SettingsInstance {
  const p0 = prefs();
  const root = h('div', { class: 'st scroll' });
  const inner = h('div', { class: 'st__inner' });
  root.appendChild(inner);
  container.appendChild(root);

  const cleanups: Array<() => void> = [];
  let i = 0;
  const stagger = (el: HTMLElement) => {
    el.classList.add('st__sec');
    el.style.setProperty('--i', String(i++));
    return el;
  };

  // ── header ───────────────────────────────────────────────────────
  const header = h(
    'header',
    { class: 'st__hero' },
    h('span', { class: 'st__eyebrow caps' }, 'Royale'),
    h('h1', { class: 'st__h1' }, 'Settings'),
  );
  inner.appendChild(stagger(header));

  // ── AUDIO ────────────────────────────────────────────────────────
  const master = SliderRow({
    icon: 'bolt',
    tint: '#edc96b',
    title: 'Master',
    value: p0.masterVolume,
    disabled: p0.muted,
    onChange: (v) => setPref('masterVolume', v),
  });
  const music = SliderRow({
    icon: 'sparkle',
    tint: '#a78bfa',
    title: 'Music',
    value: p0.musicVolume,
    disabled: p0.muted,
    onChange: (v) => setPref('musicVolume', v),
  });
  const sfx = SliderRow({
    icon: 'chip',
    tint: '#34d399',
    title: 'Table sounds',
    value: p0.sfxVolume,
    disabled: p0.muted,
    onChange: (v) => setPref('sfxVolume', v),
  });
  const ui = SliderRow({
    icon: 'sliders',
    tint: '#60a5fa',
    title: 'Interface',
    value: p0.uiVolume,
    disabled: p0.muted,
    onChange: (v) => setPref('uiVolume', v),
  });

  const muteRow = Row({
    icon: 'bell',
    tint: '#f6534f',
    title: 'Mute everything',
    sub: 'Silences music, table and interface',
    trailing: Toggle({
      on: p0.muted,
      tone: 'gold',
      ariaLabel: 'Mute everything',
      onChange: (on) => {
        setPref('muted', on);
        for (const r of [master, music, sfx, ui]) r.setDisabled(on);
        bus.emit('audio:duck', { amount: on ? 1 : 0, ms: 180 });
      },
    }),
  });

  inner.appendChild(stagger(Group('Audio', [muteRow, master, music, sfx, ui])));

  // ── HAPTICS ──────────────────────────────────────────────────────
  const hapticStrengthRow = SegRow(
    'sliders',
    '#fbbf24',
    'Strength',
    [
      { id: 'light', label: 'Light' },
      { id: 'medium', label: 'Medium' },
      { id: 'strong', label: 'Strong' },
    ],
    p0.hapticStrength,
    (id) => {
      setPref('hapticStrength', id as HapticStrength);
      bus.emit('ui:haptic', { pattern: 'select' });
    },
  );
  inner.appendChild(
    stagger(
      Group(
        'Haptics',
        [
          Row({
            icon: 'bolt',
            tint: '#fbbf24',
            title: 'Haptic feedback',
            sub: 'Chips, folds, wins and the bet slider',
            trailing: Toggle({
              on: p0.haptics,
              ariaLabel: 'Haptic feedback',
              onChange: (on) => {
                setPref('haptics', on);
                hapticStrengthRow.classList.toggle('is-off', !on);
              },
            }),
          }),
          hapticStrengthRow,
          Row({
            icon: 'target',
            tint: '#60a5fa',
            title: 'Test it',
            sub: 'Fires the win pattern',
            chevron: true,
            onTap: () => bus.emit('ui:haptic', { pattern: 'big-win' }),
          }),
        ],
        'Haptics follow your phone’s system setting first — if vibration is off at the OS level, nothing here can override it.',
      ),
    ),
  );
  hapticStrengthRow.classList.toggle('is-off', !p0.haptics);

  // ── GRAPHICS ─────────────────────────────────────────────────────
  const qualityNote = h('p', { class: 'st__gf' }, '');
  const QUALITY_COPY: Record<QualityTier, string> = {
    auto: 'Auto watches your frame rate for 90 frames and picks the tier that holds 60fps.',
    low: 'Low drops post-processing and halves particle counts. Best for older phones and long sessions.',
    mid: 'Mid keeps contact shadows and the full chip physics, without bloom.',
    high: 'High enables bloom, contact shadows and the full particle budget.',
  };
  qualityNote.textContent = QUALITY_COPY[p0.quality];

  const fpsRow = Row({
    icon: 'chart',
    tint: '#34d399',
    title: 'Show frame rate',
    sub: 'Small counter in the top corner',
    trailing: Toggle({
      on: p0.showFps,
      ariaLabel: 'Show frame rate',
      onChange: (on) => setPref('showFps', on),
    }),
  });

  const gfx = Group('Graphics', [
    SegRow(
      'sparkle',
      '#a78bfa',
      'Quality',
      [
        { id: 'auto', label: 'Auto' },
        { id: 'low', label: 'Low' },
        { id: 'mid', label: 'Mid' },
        { id: 'high', label: 'High' },
      ],
      p0.quality,
      (id) => {
        setPref('quality', id as QualityTier);
        qualityNote.textContent = QUALITY_COPY[id as QualityTier];
      },
    ),
    fpsRow,
    Row({
      icon: 'eye',
      tint: '#a78bfa',
      title: 'Reduce motion',
      sub: 'Cuts card flight, camera drift and confetti',
      trailing: Toggle({
        on: p0.reduceMotion,
        ariaLabel: 'Reduce motion',
        onChange: (on) => setPref('reduceMotion', on),
      }),
    }),
  ]);
  gfx.appendChild(qualityNote);
  inner.appendChild(stagger(gfx));

  // ── GAMEPLAY ─────────────────────────────────────────────────────
  const SKINS: Array<{ id: TableSkin; label: string }> = [
    { id: 'emerald', label: 'Emerald' },
    { id: 'obsidian', label: 'Obsidian' },
    { id: 'bordeaux', label: 'Bordeaux' },
    { id: 'cobalt', label: 'Cobalt' },
  ];
  const skinRow = h('div', { class: 'st__row st__row--skins' });
  const skinSwatches = new Map<TableSkin, HTMLElement>();
  const skinHead = h(
    'span',
    { class: 'st__seghead' },
    h('span', { class: 'st__title' }, 'Table skin'),
    h('span', { class: 'st__sub' }, SKINS.find((s) => s.id === p0.tableSkin)?.label ?? ''),
  );
  const swatchRow = h('span', { class: 'st__swatches', role: 'radiogroup', 'aria-label': 'Table skin' });
  for (const s of SKINS) {
    const b = h('button', {
      class: `st__swatch st__swatch--${s.id}`,
      type: 'button',
      role: 'radio',
      'aria-checked': s.id === p0.tableSkin ? 'true' : 'false',
      'aria-label': s.label,
    });
    pressFeedback(b);
    b.addEventListener('click', () => {
      haptic('select');
      setPref('tableSkin', s.id);
      for (const [id, node] of skinSwatches) {
        node.classList.toggle('is-on', id === s.id);
        node.setAttribute('aria-checked', id === s.id ? 'true' : 'false');
      }
      (skinHead.lastChild as HTMLElement).textContent = s.label;
    });
    b.classList.toggle('is-on', s.id === p0.tableSkin);
    skinSwatches.set(s.id, b);
    swatchRow.appendChild(b);
  }
  skinRow.append(
    h('span', { class: 'st__ic', style: { '--tint': '#34d399' }, 'aria-hidden': 'true' }, icon('sparkle', { size: 15.5, stroke: 1.9 })),
    h('span', { class: 'st__segmain' }, skinHead, swatchRow),
  );

  inner.appendChild(
    stagger(
      Group(
        'Gameplay',
        [
          Row({
            icon: 'cards',
            tint: '#3d8bfd',
            title: 'Four-colour deck',
            sub: 'Clubs green, diamonds blue — far faster to read',
            trailing: Toggle({ on: p0.fourColor, ariaLabel: 'Four-colour deck', onChange: (on) => setPref('fourColor', on) }),
          }),
          Row({
            icon: 'target',
            tint: '#34d399',
            title: 'Hand strength readout',
            sub: 'Names your hand and its rank while you act',
            trailing: Toggle({ on: p0.handStrength, ariaLabel: 'Hand strength readout', onChange: (on) => setPref('handStrength', on) }),
          }),
          Row({
            icon: 'exit',
            tint: '#8891a5',
            title: 'Auto-muck losing hands',
            sub: 'Never shows a beaten hand at showdown',
            trailing: Toggle({ on: p0.autoMuck, ariaLabel: 'Auto-muck', onChange: (on) => setPref('autoMuck', on) }),
          }),
          Row({
            icon: 'bolt',
            tint: '#fbbf24',
            title: 'Pre-action buttons',
            sub: 'Check / fold ahead of your turn',
            trailing: Toggle({ on: p0.preAction, ariaLabel: 'Pre-action buttons', onChange: (on) => setPref('preAction', on) }),
          }),
          Row({
            icon: 'shield',
            tint: '#f6534f',
            title: 'Confirm all-in',
            sub: 'One extra tap before your stack goes in',
            trailing: Toggle({ on: p0.confirmAllIn, ariaLabel: 'Confirm all-in', onChange: (on) => setPref('confirmAllIn', on) }),
          }),
          skinRow,
        ],
      ),
    ),
  );

  // ── ACCOUNT ──────────────────────────────────────────────────────
  const nameRow = Row({
    icon: 'person',
    tint: '#60a5fa',
    title: 'Display name',
    sub: 'Shown on your nameplate at every table',
    value: p0.displayName,
    chevron: true,
    onTap: () => openNameSheet(),
  });

  function openNameSheet(): void {
    const input = h('input', {
      class: 'st__input',
      attrs: { type: 'text', maxlength: '16', autocomplete: 'off', spellcheck: 'false', placeholder: 'Your name' },
      value: prefs().displayName,
    }) as HTMLInputElement;
    const hint = h('p', { class: 'st__inputhint' }, '2–16 characters. Letters, numbers and spaces.');
    const save = Button({
      label: 'Save name',
      variant: 'primary',
      size: 'lg',
      full: true,
      onTap: () => {
        const v = input.value.trim().replace(/\s+/g, ' ');
        if (v.length < 2) {
          hint.textContent = 'That is a little short — two characters minimum.';
          hint.classList.add('is-bad');
          haptic('error');
          return;
        }
        setPref('displayName', v);
        const val = nameRow.querySelector('.st__val');
        if (val) val.textContent = v;
        avatarNode.replaceWith((avatarNode = Avatar({ name: v, size: 44, level: 12, premium: true })));
        bus.emit('ui:toast', { text: `You are now ${v}`, tone: 'good', ms: 1800 });
        sheet.close();
      },
    });
    const sheet = openSheet({
      title: 'Display name',
      subtitle: 'Everyone at the table sees this',
      content: h('div', { class: 'st__namebox' }, input, hint),
      footer: save,
    });
    input.addEventListener('input', () => {
      hint.classList.remove('is-bad');
      hint.textContent = `${input.value.trim().length}/16`;
    });
  }

  let avatarNode: HTMLElement = Avatar({ name: p0.displayName, size: 44, level: 12, premium: true });
  const idRow = Row({
    icon: 'copy',
    tint: '#8891a5',
    title: 'Player ID',
    sub: 'Quote this when reporting a hand',
    value: 'RYL-8F42-19C',
    chevron: true,
    onTap: () => {
      const copy = navigator.clipboard?.writeText('RYL-8F42-19C');
      if (copy) {
        void copy.then(
          () => bus.emit('ui:toast', { text: 'Player ID copied', tone: 'good', ms: 1500 }),
          () => bus.emit('ui:toast', { text: 'Could not copy — RYL-8F42-19C', tone: 'info', ms: 2600 }),
        );
      } else {
        bus.emit('ui:toast', { text: 'Your ID is RYL-8F42-19C', tone: 'info', ms: 2600 });
      }
    },
  });

  inner.appendChild(
    stagger(
      Group('Account', [
        h(
          'div',
          { class: 'st__row st__row--me' },
          h('span', { class: 'st__meav' }, avatarNode),
          h(
            'span',
            { class: 'st__main' },
            h('span', { class: 'st__title' }, p0.displayName),
            h('span', { class: 'st__sub tnum' }, `${cash(bankroll())} balance · Level 12`),
          ),
          h('span', { class: 'st__mepro caps' }, 'Premium'),
        ),
        nameRow,
        idRow,
        Row({
          icon: 'refresh',
          tint: '#a78bfa',
          title: 'Restore purchases',
          sub: 'Re-checks the store for anything you own',
          chevron: true,
          onTap: () =>
            bus.emit('ui:toast', { text: 'Nothing new to restore', tone: 'info', ms: 1800 }),
        }),
        Row({
          icon: 'warning',
          tint: '#f6534f',
          title: 'Clear local data',
          sub: 'Preferences, streak and stored hands',
          danger: true,
          chevron: true,
          onTap: async () => {
            const ok = await confirmModal({
              title: 'Clear everything stored here?',
              body: 'Your preferences, daily streak and local hand history are removed from this device. This cannot be undone.',
              confirmLabel: 'Clear data',
              destructive: true,
            });
            if (!ok) return;
            try {
              for (const k of ['royale.prefs', 'royale.daily', 'royale.lobby-mode', 'royale.auto-rebuy', 'royale.session-start']) {
                localStorage.removeItem(k);
              }
            } catch {
              /* nothing stored to clear */
            }
            resetPrefs();
            bus.emit('ui:toast', { text: 'Local data cleared', tone: 'good', ms: 2000 });
            bus.emit('nav:route', { route: 'lobby' });
          },
        }),
      ]),
    ),
  );

  // ── PRIVACY ──────────────────────────────────────────────────────
  inner.appendChild(
    stagger(
      Group(
        'Privacy',
        [
          Row({
            icon: 'chart',
            tint: '#60a5fa',
            title: 'Public statistics',
            sub: 'Others can see your VPIP, hands and winrate',
            trailing: Toggle({ on: p0.publicStats, ariaLabel: 'Public statistics', onChange: (on) => setPref('publicStats', on) }),
          }),
          Row({
            icon: 'users',
            tint: '#34d399',
            title: 'Allow friend requests',
            trailing: Toggle({ on: p0.friendRequests, ariaLabel: 'Allow friend requests', onChange: (on) => setPref('friendRequests', on) }),
          }),
          Row({
            icon: 'trophy',
            tint: '#edc96b',
            title: 'Appear on leaderboards',
            trailing: Toggle({ on: p0.leaderboards, ariaLabel: 'Appear on leaderboards', onChange: (on) => setPref('leaderboards', on) }),
          }),
          Row({
            icon: 'share',
            tint: '#a78bfa',
            title: 'Auto-share big hands',
            sub: 'Posts quads and better to the feed for you',
            trailing: Toggle({ on: p0.shareHands, ariaLabel: 'Auto-share big hands', onChange: (on) => setPref('shareHands', on) }),
          }),
        ],
        'Turning everything off here still lets you play — you simply become invisible outside the table you are sitting at.',
      ),
    ),
  );

  // ── RESPONSIBLE PLAY ─────────────────────────────────────────────
  const sessionClock = h('span', { class: 'rp__clock tnum' }, '0:00:00');
  const sessionBar = h('i', { class: 'rp__barfill' });
  const sessionCaption = h('span', { class: 'rp__cap' }, 'No limit set');

  const lossReadout = h('span', { class: 'st__pct tnum' }, p0.lossLimit ? cash(p0.lossLimit) : 'Off');
  const lossSlider = Slider({
    min: 0,
    max: 500,
    step: 10,
    value: p0.lossLimit,
    tone: 'bad',
    ariaLabel: 'Session loss limit',
    format: (v) => (v <= 0 ? 'Off' : cash(v)),
    onInput: (v) => {
      lossReadout.textContent = v <= 0 ? 'Off' : cash(v);
    },
    onChange: (v) => {
      setPref('lossLimit', v);
      bus.emit('ui:toast', {
        text: v <= 0 ? 'Loss limit removed' : `We will stop you at ${cash(v)} down`,
        tone: v <= 0 ? 'info' : 'good',
        ms: 2000,
      });
    },
  });

  const breakRow = Row({
    icon: 'clock',
    tint: '#f6534f',
    title: 'Take a break',
    sub: onBreak() ? 'A break is running' : 'Locks the tables for a set time',
    chevron: true,
    onTap: () => openBreakSheet(),
  });

  function openBreakSheet(): void {
    const options: Array<{ label: string; hours: number }> = [
      { label: '24 hours', hours: 24 },
      { label: '7 days', hours: 24 * 7 },
      { label: '30 days', hours: 24 * 30 },
    ];
    const sheet = openSheet({
      eyebrow: 'Responsible play',
      title: 'Take a break',
      subtitle: 'Tables stay locked until it ends. It cannot be undone early.',
      content: h(
        'div',
        { class: 'rp__breaks' },
        ...options.map((o) =>
          Button({
            label: o.label,
            variant: 'secondary',
            size: 'lg',
            full: true,
            onTap: async () => {
              const ok = await confirmModal({
                title: `Lock the tables for ${o.label}?`,
                body: 'You can still browse the lobby, your stats and the store. Sitting down is disabled until the break ends.',
                confirmLabel: `Start ${o.label}`,
                destructive: true,
              });
              if (!ok) return;
              setPref('breakUntil', Date.now() + o.hours * 3600_000);
              bus.emit('ui:toast', { text: `Break started — ${o.label}`, tone: 'good', ms: 2400 });
              sheet.close();
              tickSession();
            },
          }),
        ),
        h(
          'p',
          { class: 'rp__note' },
          'If gambling stops being fun, step away. This app is play money, and a break here costs you nothing.',
        ),
      ),
    });
  }

  inner.appendChild(
    stagger(
      Group(
        'Responsible play',
        [
          h(
            'div',
            { class: 'st__row rp__session' },
            h('span', { class: 'st__ic', style: { '--tint': '#34d399' }, 'aria-hidden': 'true' }, icon('clock', { size: 15.5, stroke: 1.9 })),
            h(
              'span',
              { class: 'st__main' },
              h('span', { class: 'st__title' }, 'This session'),
              sessionCaption,
            ),
            sessionClock,
            h('span', { class: 'rp__bar' }, sessionBar),
          ),
          SegRow(
            'clock',
            '#60a5fa',
            'Session reminder',
            [
              { id: '0', label: 'Off' },
              { id: '30', label: '30m' },
              { id: '60', label: '60m' },
              { id: '120', label: '2h' },
            ],
            String(p0.sessionLimitMin),
            (id) => {
              setPref('sessionLimitMin', Number(id) as SessionLimit);
              tickSession();
            },
            'Nudges you when you hit it',
          ),
          h(
            'div',
            { class: 'st__row st__row--slider' },
            h('span', { class: 'st__ic', style: { '--tint': '#f6534f' }, 'aria-hidden': 'true' }, icon('shield', { size: 15.5, stroke: 1.9 })),
            h(
              'span',
              { class: 'st__sldmain' },
              h('span', { class: 'st__sldhead' }, h('span', { class: 'st__title' }, 'Session loss limit'), lossReadout),
              lossSlider,
            ),
          ),
          Row({
            icon: 'bell',
            tint: '#fbbf24',
            title: 'Reality checks',
            sub: 'A quiet reminder every 30 minutes at the table',
            trailing: Toggle({ on: p0.realityChecks, ariaLabel: 'Reality checks', onChange: (on) => setPref('realityChecks', on) }),
          }),
          breakRow,
        ],
        'These limits live on this device and apply immediately. Nothing you set here can be shortened, only extended.',
      ),
    ),
  );

  // ── LEGAL ────────────────────────────────────────────────────────
  inner.appendChild(
    stagger(
      Group('About', [
        Row({ icon: 'cards', tint: '#34d399', title: 'Shuffle & fairness', chevron: true, onTap: () => openLegal('fairness') }),
        Row({ icon: 'shield', tint: '#8891a5', title: 'Terms of play', chevron: true, onTap: () => openLegal('terms') }),
        Row({ icon: 'eye', tint: '#8891a5', title: 'Privacy', chevron: true, onTap: () => openLegal('privacy') }),
        Row({ icon: 'copy', tint: '#8891a5', title: 'Open source licences', chevron: true, onTap: () => openLegal('licenses') }),
        Row({ icon: 'info', tint: '#8891a5', title: 'Version', value: '1.0.0 (2026.07)' }),
      ]),
    ),
  );

  const resetBtn = Button({
    label: 'Restore default settings',
    variant: 'ghost',
    size: 'md',
    full: true,
    onTap: async () => {
      const ok = await confirmModal({
        title: 'Restore defaults?',
        body: 'Audio, graphics, gameplay and privacy switches all go back to how they shipped. Your break and limits stay in place.',
        confirmLabel: 'Restore',
      });
      if (!ok) return;
      const keep = { breakUntil: prefs().breakUntil, lossLimit: prefs().lossLimit, sessionLimitMin: prefs().sessionLimitMin };
      resetPrefs();
      setPrefs(keep);
      bus.emit('ui:toast', { text: 'Settings restored — reopen to see them', tone: 'good', ms: 2400 });
    },
  });
  inner.appendChild(stagger(h('div', { class: 'st__reset' }, resetBtn)));
  inner.appendChild(h('div', { class: 'st__tail' }, h('p', null, 'Royale · built for portrait, plays anywhere')));

  // ── session clock ────────────────────────────────────────────────
  let warned = false;
  function tickSession(): void {
    const ms = sessionElapsedMs();
    sessionClock.textContent = clockMs(ms);
    const limit = prefs().sessionLimitMin;
    if (limit > 0) {
      const frac = Math.min(1, ms / (limit * 60_000));
      sessionBar.style.transform = `scaleX(${frac.toFixed(4)})`;
      sessionBar.classList.toggle('is-over', frac >= 1);
      sessionCaption.textContent =
        frac >= 1 ? `Past your ${limit}-minute reminder` : `${limit}-minute reminder set`;
      if (frac >= 1 && !warned) {
        warned = true;
        bus.emit('ui:toast', { text: `You have been playing ${limit} minutes`, tone: 'info', ms: 3200 });
      }
    } else {
      sessionBar.style.transform = 'scaleX(0)';
      sessionCaption.textContent = 'No reminder set';
    }
    const br = prefs().breakUntil;
    breakRow.classList.toggle('is-active', onBreak());
    const sub = breakRow.querySelector('.st__sub');
    if (sub) {
      sub.textContent = onBreak() && br
        ? `Tables locked for ${clockMs(br - Date.now())}`
        : 'Locks the tables for a set time';
    }
  }
  tickSession();
  const clockTimer = window.setInterval(tickSession, 1000);
  cleanups.push(() => clearInterval(clockTimer));

  requestAnimationFrame(() => inner.classList.add('is-in'));

  return {
    unmount() {
      for (const fn of cleanups.splice(0)) fn();
      root.remove();
    },
  };
}
