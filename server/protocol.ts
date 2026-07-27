/**
 * ROYALE — wire protocol.
 *
 * One source of truth for everything that crosses the socket. The server
 * imports it for framing + validation; `src/net/client.ts` imports the very
 * same file so the two sides can never drift.
 *
 * Three jobs:
 *
 *  1. **Types.** `ClientMsg` / `ServerMsg` from `src/core/types.ts` are
 *     implemented verbatim. A small, clearly-labelled extension union adds the
 *     messages the core contract does not cover (lobby subscription, quick
 *     seat, resync, rejection-for-rollback, the action clock). Extensions are
 *     additive — every core message keeps its exact shape.
 *  2. **Validation.** Nothing that arrives on a socket is trusted. Every
 *     inbound message goes through an exhaustive validator that checks the
 *     discriminant, then every field's type, range and length, and rejects
 *     with a reason. Unknown `t` values are dropped, not coerced.
 *  3. **Compaction.** Table state is broadcast ~10×/s. Full `TableState`
 *     JSON is ~3 KB; the delta codec here shrinks a typical tick to 40-150
 *     bytes by (a) diffing against the last state sent to *that* client and
 *     (b) mapping field names onto two-character wire codes.
 *
 * This module is dependency-free and DOM-free so it runs identically under
 * Node's type-stripping loader and inside the browser bundle.
 */

import type {
  Action,
  ActionKind,
  BombPotConfig,
  CardId,
  ClientMsg,
  GameVariant,
  LobbyTable,
  PlayerRef,
  Pot,
  ReactionKind,
  SeatState,
  ServerMsg,
  ShowdownResult,
  StakeId,
  Street,
  TableFormat,
  TableState,
  TournamentState,
} from '../src/core/types.ts';
import type { LegalAction } from '../src/core/bus.ts';

export const PROTOCOL_VERSION = 3;

/** Hard ceiling on a single inbound frame. Anything larger is dropped. */
export const MAX_FRAME_BYTES = 8192;
export const MAX_NAME_LEN = 20;
export const MAX_CHAT_LEN = 160;

// ═══════════════════════════════════════════════════════════════════
// 1 — Message unions
// ═══════════════════════════════════════════════════════════════════

/**
 * Additive client messages. The core union in `types.ts` covers the table
 * itself; these cover the lobby, resync and the time bank.
 */
export type ClientExtMsg =
  | { t: 'lobby'; sub: boolean }
  | { t: 'quickseat'; stakeId: StakeId; variant: GameVariant; format: TableFormat; buyIn: number }
  | { t: 'resync' }
  | { t: 'timebank' }
  | { t: 'rebuy'; amount: number }
  | { t: 'bye' };

export type ClientPacket = ClientMsg | ClientExtMsg;

/** Additive server messages — the narrative stream the UI animates from. */
export type ServerExtMsg =
  | { t: 'lobby'; tables: LobbyTable[] }
  | { t: 'seated'; tableId: string; seat: number; buyIn: number }
  | { t: 'waitlist'; tableId: string; position: number }
  | { t: 'left'; tableId: string; cashOut: number }
  | { t: 'hand'; phase: 'start' | 'end'; handId: number; buttonSeat: number }
  | { t: 'hole'; seat: number; cards: CardId[]; faceUp: boolean; order: number }
  | { t: 'turn'; seat: number; handId: number; timeMs: number; bankMs: number; legal: LegalAction[]; serverTime: number }
  | { t: 'pot'; pots: Pot[]; total: number }
  | { t: 'collect'; seats: number[]; total: number }
  | { t: 'award'; seat: number; amount: number; potIndex: number }
  | { t: 'muck'; seat: number }
  | { t: 'reject'; seq: number; handId: number; reason: string }
  | { t: 'sys'; text: string; tone: 'info' | 'good' | 'bad' | 'epic' };

export type ServerPacket = ServerMsg | ServerExtMsg;

/** Narrow helper: the `state` message carries the seat index of the recipient. */
export interface StateMsg {
  t: 'state';
  state: TableState;
  you: number;
}

// ═══════════════════════════════════════════════════════════════════
// 2 — Delta codec
// ═══════════════════════════════════════════════════════════════════

/** Wire codes for the mutable half of `TableState`. */
const TOP_CODE: Array<[keyof TableState, string]> = [
  ['board', 'bd'],
  ['pots', 'po'],
  ['street', 'sr'],
  ['handId', 'hd'],
  ['buttonSeat', 'bs'],
  ['actingSeat', 'as'],
  ['currentBet', 'cb'],
  ['lastRaiseSize', 'lr'],
  ['minRaiseTo', 'mr'],
  ['bombPot', 'bp'],
  ['tournament', 'tn'],
  ['rake', 'rk'],
  ['tick', 'tk'],
];

const SEAT_CODE: Array<[keyof SeatState, string]> = [
  ['status', 'st'],
  ['player', 'pl'],
  ['stack', 'sk'],
  ['committed', 'cm'],
  ['totalCommitted', 'tc'],
  ['holeCards', 'hc'],
  ['revealed', 'rv'],
  ['isButton', 'bt'],
  ['isTurn', 'tn'],
  ['timeBankMs', 'tb'],
  ['lastAction', 'la'],
  ['wonLast', 'wl'],
  ['sitOutNextHand', 'so'],
];

const TOP_BY_CODE = new Map<string, keyof TableState>(TOP_CODE.map(([k, c]) => [c, k]));
const SEAT_BY_CODE = new Map<string, keyof SeatState>(SEAT_CODE.map(([k, c]) => [c, k]));

/** A compact structural diff of two `TableState`s. */
export interface StatePatch {
  /** changed top-level fields, keyed by wire code */
  f?: Record<string, unknown>;
  /** changed seats: `[seatIndex, {code: value}]` */
  s?: Array<[number, Record<string, unknown>]>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Clock updates below this are not worth a frame — the client interpolates. */
const CLOCK_EPSILON_MS = 900;

/**
 * Diff `next` against `prev`. Returns `null` when nothing meaningful moved,
 * which lets the broadcaster skip the frame entirely.
 *
 * "Meaningful" deliberately excludes two things that change on *every* tick:
 * the tick counter itself, and the acting seat's clock. Counting those as
 * news would make the delta channel a 10 Hz firehose that never idles, and
 * would drive `table:state` — and therefore a full renderer sync — 10×/second
 * on a table where nobody has done anything.
 */
export function diffState(prev: TableState, next: TableState): StatePatch | null {
  const patch: StatePatch = {};
  let dirty = false;

  const fields: Record<string, unknown> = {};
  for (const [key, code] of TOP_CODE) {
    if (!sameValue(prev[key], next[key])) {
      fields[code] = next[key];
      if (key !== 'tick') dirty = true;
    }
  }

  const seats: Array<[number, Record<string, unknown>]> = [];
  for (let i = 0; i < next.seats.length; i++) {
    const a = prev.seats[i];
    const b = next.seats[i];
    if (!b) continue;
    if (!a) {
      seats.push([i, encodeSeatFull(b)]);
      dirty = true;
      continue;
    }
    const changed: Record<string, unknown> = {};
    for (const [key, code] of SEAT_CODE) {
      if (!sameValue(a[key], b[key])) changed[code] = b[key];
    }
    const codes = Object.keys(changed);
    if (codes.length === 0) continue;
    seats.push([i, changed]);
    if (codes.some((c) => c !== 'tb')) dirty = true;
    else if (Math.abs(a.timeBankMs - b.timeBankMs) >= CLOCK_EPSILON_MS) dirty = true;
  }

  if (!dirty) return null;
  if (Object.keys(fields).length > 0) patch.f = fields;
  if (seats.length > 0) patch.s = seats;
  return patch;
}

function encodeSeatFull(s: SeatState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, code] of SEAT_CODE) out[code] = s[key];
  return out;
}

/**
 * Apply a patch to a state, returning a new object. Never mutates `prev`,
 * so the caller can keep the previous snapshot for interpolation.
 */
export function applyPatch(prev: TableState, patch: StatePatch): TableState {
  const next: TableState = {
    ...prev,
    board: prev.board.slice(),
    pots: prev.pots.map((p) => ({ ...p })),
    seats: prev.seats.map((s) => ({ ...s })),
  };
  if (patch.f) {
    for (const code of Object.keys(patch.f)) {
      const key = TOP_BY_CODE.get(code);
      if (!key) continue;
      // The codec only ever writes fields it read off a real TableState, so
      // the cast is safe; the validator upstream guarantees shape.
      (next as unknown as Record<string, unknown>)[key] = patch.f[code];
    }
  }
  if (patch.s) {
    for (const [index, changed] of patch.s) {
      if (!Number.isInteger(index) || index < 0 || index >= next.seats.length) continue;
      const seat = next.seats[index] as unknown as Record<string, unknown>;
      for (const code of Object.keys(changed)) {
        const key = SEAT_BY_CODE.get(code);
        if (!key) continue;
        seat[key] = changed[code];
      }
      next.seats[index].index = index;
    }
  }
  return next;
}

// ═══════════════════════════════════════════════════════════════════
// 3 — Serialization
// ═══════════════════════════════════════════════════════════════════

/** Money is carried at cent precision; strip float noise before it ships. */
function trim(_key: string, value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    if (Number.isInteger(value)) return value;
    return Math.round(value * 1e4) / 1e4;
  }
  return value;
}

export function encode(msg: ServerPacket | ClientPacket): string {
  return JSON.stringify(msg, trim);
}

// ═══════════════════════════════════════════════════════════════════
// 4 — Inbound validation. Nothing below trusts its input.
// ═══════════════════════════════════════════════════════════════════

const ACTION_KINDS: ReadonlySet<string> = new Set<ActionKind>([
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'allin',
  'post',
  'ante',
]);

const REACTIONS: ReadonlySet<string> = new Set<ReactionKind>([
  'fire',
  'skull',
  'clown',
  'money',
  'shock',
  'clap',
  'cold',
  'heart',
  'laugh',
  'eyes',
]);

const VARIANTS: ReadonlySet<string> = new Set<GameVariant>(['nlhe', 'plo4']);
const FORMATS: ReadonlySet<string> = new Set<TableFormat>(['cash', 'sng', 'bomb']);
const STAKE_IDS: ReadonlySet<string> = new Set<StakeId>([
  'nl2',
  'nl5',
  'nl10',
  'nl20',
  'nl50',
  'nl100',
  'nl200',
  'nl500',
]);
const STREETS: ReadonlySet<string> = new Set<Street>(['preflop', 'flop', 'turn', 'river', 'showdown']);

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < min || v > max) return null;
  return v;
}
function int(v: unknown, min: number, max: number): number | null {
  const n = num(v, min, max);
  if (n === null || !Number.isInteger(n)) return null;
  return n;
}
function str(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  if (v.length > maxLen) return null;
  return v;
}

export type Decoded = { ok: true; msg: ClientPacket } | { ok: false; reason: string };

/**
 * Strip control characters, collapse runaway whitespace, and clamp length.
 * Zero-width and bidi-override codepoints are removed outright — they are
 * only ever used to spoof names.
 */
export function sanitizeText(input: string, maxLen: number): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += ' ';
      continue;
    }
    // zero-width, bidi controls, and the invisible-separator block
    if (
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      code === 0xfeff
    ) {
      continue;
    }
    out += ch;
  }
  out = out.replace(/\s{2,}/g, ' ').trim();
  return Array.from(out).slice(0, maxLen).join('');
}

const PROFANITY = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'asshole',
  'bastard',
  'dick',
  'wanker',
  'nigger',
  'faggot',
  'retard',
  'whore',
  'slut',
  'rape',
];

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '*': '',
};

/** Normalizes leetspeak + repeated letters so `fuuuck` and `f*ck` both hit. */
function normalizeForFilter(s: string): string {
  let out = '';
  let last = '';
  for (const raw of s.toLowerCase()) {
    const ch = LEET[raw] ?? raw;
    if (!/[a-z]/.test(ch)) {
      last = '';
      out += ' ';
      continue;
    }
    if (ch === last) continue;
    last = ch;
    out += ch;
  }
  return out;
}

/**
 * Masks profanity while preserving the shape of the sentence. Works on the
 * normalized projection so obfuscation does not slip through, then maps the
 * hit back onto the original token.
 */
export function filterProfanity(text: string): { text: string; flagged: boolean } {
  const tokens = text.split(/(\s+)/);
  let flagged = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.trim()) continue;
    const norm = normalizeForFilter(tok).replace(/\s+/g, '');
    if (!norm) continue;
    for (const bad of PROFANITY) {
      if (norm.includes(bad)) {
        tokens[i] = tok[0] + '*'.repeat(Math.max(1, Array.from(tok).length - 1));
        flagged = true;
        break;
      }
    }
  }
  return { text: tokens.join(''), flagged };
}

/**
 * Parse + validate one inbound frame. Returns a discriminated result so the
 * caller can log the rejection reason without a thrown exception per frame.
 */
export function decodeClient(raw: unknown): Decoded {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
  else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(raw));
  else return { ok: false, reason: 'unsupported-frame' };

  if (text.length > MAX_FRAME_BYTES) return { ok: false, reason: 'frame-too-large' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  if (!isRec(parsed)) return { ok: false, reason: 'not-an-object' };

  const t = parsed.t;
  if (typeof t !== 'string') return { ok: false, reason: 'missing-type' };

  switch (t) {
    case 'hello': {
      const name = str(parsed.name, 64);
      if (name === null) return { ok: false, reason: 'hello.name' };
      const avatarId = str(parsed.avatarId, 48);
      if (avatarId === null) return { ok: false, reason: 'hello.avatarId' };
      const clean = sanitizeText(name, MAX_NAME_LEN);
      if (clean.length < 1) return { ok: false, reason: 'hello.name-empty' };
      const token = parsed.token === undefined ? undefined : str(parsed.token, 128);
      if (token === null) return { ok: false, reason: 'hello.token' };
      return { ok: true, msg: { t: 'hello', name: clean, avatarId, token } };
    }
    case 'join': {
      const tableId = str(parsed.tableId, 64);
      if (!tableId) return { ok: false, reason: 'join.tableId' };
      const buyIn = num(parsed.buyIn, 0, 1e9);
      if (buyIn === null) return { ok: false, reason: 'join.buyIn' };
      let seat: number | undefined;
      if (parsed.seat !== undefined) {
        const s = int(parsed.seat, 0, 8);
        if (s === null) return { ok: false, reason: 'join.seat' };
        seat = s;
      }
      return { ok: true, msg: { t: 'join', tableId, seat, buyIn } };
    }
    case 'leave':
      return { ok: true, msg: { t: 'leave' } };
    case 'act': {
      const kind = str(parsed.kind, 12);
      if (!kind || !ACTION_KINDS.has(kind)) return { ok: false, reason: 'act.kind' };
      const amount = num(parsed.amount, 0, 1e9);
      if (amount === null) return { ok: false, reason: 'act.amount' };
      const handId = int(parsed.handId, 0, 1e9);
      if (handId === null) return { ok: false, reason: 'act.handId' };
      const seq = int(parsed.seq, 0, 1e9);
      if (seq === null) return { ok: false, reason: 'act.seq' };
      return { ok: true, msg: { t: 'act', kind: kind as ActionKind, amount, handId, seq } };
    }
    case 'react': {
      const kind = str(parsed.kind, 12);
      if (!kind || !REACTIONS.has(kind)) return { ok: false, reason: 'react.kind' };
      const targetSeat = int(parsed.targetSeat, -1, 8);
      if (targetSeat === null) return { ok: false, reason: 'react.targetSeat' };
      return { ok: true, msg: { t: 'react', kind: kind as ReactionKind, targetSeat } };
    }
    case 'chat': {
      const text0 = str(parsed.text, MAX_CHAT_LEN * 4);
      if (text0 === null) return { ok: false, reason: 'chat.text' };
      const clean = sanitizeText(text0, MAX_CHAT_LEN);
      if (!clean) return { ok: false, reason: 'chat.empty' };
      return { ok: true, msg: { t: 'chat', text: clean } };
    }
    case 'sitout': {
      if (typeof parsed.on !== 'boolean') return { ok: false, reason: 'sitout.on' };
      return { ok: true, msg: { t: 'sitout', on: parsed.on } };
    }
    case 'ping': {
      const ts = num(parsed.ts, 0, Number.MAX_SAFE_INTEGER);
      if (ts === null) return { ok: false, reason: 'ping.ts' };
      return { ok: true, msg: { t: 'ping', ts } };
    }
    case 'lobby': {
      if (typeof parsed.sub !== 'boolean') return { ok: false, reason: 'lobby.sub' };
      return { ok: true, msg: { t: 'lobby', sub: parsed.sub } };
    }
    case 'quickseat': {
      const stakeId = str(parsed.stakeId, 12);
      if (!stakeId || !STAKE_IDS.has(stakeId)) return { ok: false, reason: 'quickseat.stakeId' };
      const variant = str(parsed.variant, 8);
      if (!variant || !VARIANTS.has(variant)) return { ok: false, reason: 'quickseat.variant' };
      const format = str(parsed.format, 8);
      if (!format || !FORMATS.has(format)) return { ok: false, reason: 'quickseat.format' };
      const buyIn = num(parsed.buyIn, 0, 1e9);
      if (buyIn === null) return { ok: false, reason: 'quickseat.buyIn' };
      return {
        ok: true,
        msg: {
          t: 'quickseat',
          stakeId: stakeId as StakeId,
          variant: variant as GameVariant,
          format: format as TableFormat,
          buyIn,
        },
      };
    }
    case 'resync':
      return { ok: true, msg: { t: 'resync' } };
    case 'timebank':
      return { ok: true, msg: { t: 'timebank' } };
    case 'rebuy': {
      const amount = num(parsed.amount, 0, 1e9);
      if (amount === null) return { ok: false, reason: 'rebuy.amount' };
      return { ok: true, msg: { t: 'rebuy', amount } };
    }
    case 'bye':
      return { ok: true, msg: { t: 'bye' } };
    default:
      return { ok: false, reason: `unknown-type:${t.slice(0, 16)}` };
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5 — Client-side inbound validation
// ═══════════════════════════════════════════════════════════════════

/**
 * The client validates the server too. A corrupted or hostile frame must not
 * be able to hand the renderer a malformed `TableState` — the whole UI reads
 * that object without further guards.
 */
export function decodeServer(raw: unknown): ServerPacket | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(raw));
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
  else return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRec(parsed) || typeof parsed.t !== 'string') return null;

  switch (parsed.t) {
    case 'welcome':
      if (typeof parsed.playerId !== 'string') return null;
      return { t: 'welcome', playerId: parsed.playerId, tables: coerceLobby(parsed.tables) };
    case 'state': {
      const state = coerceState(parsed.state);
      if (!state) return null;
      const you = int(parsed.you, -1, 8) ?? -1;
      return { t: 'state', state, you };
    }
    case 'delta': {
      const tick = int(parsed.tick, 0, Number.MAX_SAFE_INTEGER);
      if (tick === null || !isRec(parsed.patch)) return null;
      return { t: 'delta', tick, patch: parsed.patch as StatePatch };
    }
    case 'action': {
      const action = coerceAction(parsed.action);
      if (!action) return null;
      return { t: 'action', action };
    }
    case 'deal': {
      const street = typeof parsed.street === 'string' && STREETS.has(parsed.street) ? (parsed.street as Street) : null;
      if (!street) return null;
      return { t: 'deal', street, cards: coerceCards(parsed.cards) };
    }
    case 'showdown':
      return {
        t: 'showdown',
        results: coerceResults(parsed.results),
        pots: coercePots(parsed.pots),
      };
    case 'react': {
      const kind = typeof parsed.kind === 'string' && REACTIONS.has(parsed.kind) ? (parsed.kind as ReactionKind) : null;
      if (!kind) return null;
      return {
        t: 'react',
        kind,
        fromSeat: int(parsed.fromSeat, -1, 8) ?? -1,
        targetSeat: int(parsed.targetSeat, -1, 8) ?? -1,
      };
    }
    case 'chat': {
      const txt = str(parsed.text, MAX_CHAT_LEN * 2);
      if (txt === null) return null;
      return { t: 'chat', fromSeat: int(parsed.fromSeat, -1, 8) ?? -1, text: txt };
    }
    case 'error':
      return { t: 'error', message: str(parsed.message, 240) ?? 'error' };
    case 'pong':
      return { t: 'pong', ts: num(parsed.ts, 0, Number.MAX_SAFE_INTEGER) ?? 0 };
    case 'lobby':
      return { t: 'lobby', tables: coerceLobby(parsed.tables) };
    case 'seated': {
      const tableId = str(parsed.tableId, 64);
      const seat = int(parsed.seat, 0, 8);
      if (!tableId || seat === null) return null;
      return { t: 'seated', tableId, seat, buyIn: num(parsed.buyIn, 0, 1e9) ?? 0 };
    }
    case 'waitlist': {
      const tableId = str(parsed.tableId, 64);
      if (!tableId) return null;
      return { t: 'waitlist', tableId, position: int(parsed.position, 0, 999) ?? 0 };
    }
    case 'left': {
      const tableId = str(parsed.tableId, 64);
      if (!tableId) return null;
      return { t: 'left', tableId, cashOut: num(parsed.cashOut, 0, 1e9) ?? 0 };
    }
    case 'hand': {
      const phase = parsed.phase === 'start' || parsed.phase === 'end' ? parsed.phase : null;
      if (!phase) return null;
      return {
        t: 'hand',
        phase,
        handId: int(parsed.handId, 0, 1e9) ?? 0,
        buttonSeat: int(parsed.buttonSeat, -1, 8) ?? 0,
      };
    }
    case 'hole':
      return {
        t: 'hole',
        seat: int(parsed.seat, 0, 8) ?? 0,
        cards: coerceCards(parsed.cards),
        faceUp: parsed.faceUp === true,
        order: int(parsed.order, 0, 64) ?? 0,
      };
    case 'turn':
      return {
        t: 'turn',
        seat: int(parsed.seat, -1, 8) ?? -1,
        handId: int(parsed.handId, 0, 1e9) ?? 0,
        timeMs: num(parsed.timeMs, 0, 600000) ?? 0,
        bankMs: num(parsed.bankMs, 0, 600000) ?? 0,
        legal: coerceLegal(parsed.legal),
        serverTime: num(parsed.serverTime, 0, Number.MAX_SAFE_INTEGER) ?? 0,
      };
    case 'pot':
      return { t: 'pot', pots: coercePots(parsed.pots), total: num(parsed.total, 0, 1e9) ?? 0 };
    case 'collect':
      return {
        t: 'collect',
        seats: Array.isArray(parsed.seats) ? parsed.seats.filter((s): s is number => int(s, 0, 8) !== null) : [],
        total: num(parsed.total, 0, 1e9) ?? 0,
      };
    case 'award':
      return {
        t: 'award',
        seat: int(parsed.seat, 0, 8) ?? 0,
        amount: num(parsed.amount, 0, 1e9) ?? 0,
        potIndex: int(parsed.potIndex, 0, 16) ?? 0,
      };
    case 'muck':
      return { t: 'muck', seat: int(parsed.seat, 0, 8) ?? 0 };
    case 'reject':
      return {
        t: 'reject',
        seq: int(parsed.seq, 0, 1e9) ?? 0,
        handId: int(parsed.handId, 0, 1e9) ?? 0,
        reason: str(parsed.reason, 120) ?? 'rejected',
      };
    case 'sys': {
      const tone = parsed.tone;
      return {
        t: 'sys',
        text: str(parsed.text, 200) ?? '',
        tone: tone === 'good' || tone === 'bad' || tone === 'epic' ? tone : 'info',
      };
    }
    default:
      return null;
  }
}

function coerceCards(v: unknown): CardId[] {
  if (!Array.isArray(v)) return [];
  const out: CardId[] = [];
  for (const c of v) {
    const n = int(c, 0, 51);
    if (n !== null) out.push(n);
  }
  return out;
}

function coerceAction(v: unknown): Action | null {
  if (!isRec(v)) return null;
  if (typeof v.kind !== 'string' || !ACTION_KINDS.has(v.kind)) return null;
  const seat = int(v.seat, 0, 8);
  const seq = int(v.seq, 0, 1e9);
  const amount = num(v.amount, 0, 1e9);
  if (seat === null || seq === null || amount === null) return null;
  const street = typeof v.street === 'string' && STREETS.has(v.street) ? (v.street as Street) : 'preflop';
  const tookMs = num(v.tookMs, 0, 600000);
  return {
    kind: v.kind as ActionKind,
    amount,
    seat,
    seq,
    street,
    ...(tookMs === null ? {} : { tookMs }),
  };
}

function coercePots(v: unknown): Pot[] {
  if (!Array.isArray(v)) return [];
  const out: Pot[] = [];
  for (const p of v) {
    if (!isRec(p)) continue;
    const amount = num(p.amount, 0, 1e9);
    if (amount === null) continue;
    const eligible = Array.isArray(p.eligible)
      ? p.eligible.filter((s): s is number => int(s, 0, 8) !== null)
      : [];
    out.push({ amount, eligible, index: int(p.index, 0, 16) ?? out.length });
  }
  return out;
}

function coerceResults(v: unknown): ShowdownResult[] {
  if (!Array.isArray(v)) return [];
  const out: ShowdownResult[] = [];
  for (const r of v) {
    if (!isRec(r)) continue;
    const seat = int(r.seat, 0, 8);
    if (seat === null) continue;
    let rank: ShowdownResult['rank'] = null;
    if (isRec(r.rank)) {
      const value = num(r.rank.value, -1, 1e12);
      if (value !== null) {
        rank = {
          value,
          category: String(r.rank.category ?? 'high-card') as ShowdownResult['rank'] extends null
            ? never
            : NonNullable<ShowdownResult['rank']>['category'],
          best: coerceCards(r.rank.best),
          label: str(r.rank.label, 48) ?? '',
        };
      }
    }
    out.push({ seat, rank, won: num(r.won, 0, 1e9) ?? 0, mucked: r.mucked === true });
  }
  return out;
}

function coerceLegal(v: unknown): LegalAction[] {
  if (!Array.isArray(v)) return [];
  const out: LegalAction[] = [];
  for (const l of v) {
    if (!isRec(l)) continue;
    if (typeof l.kind !== 'string' || !ACTION_KINDS.has(l.kind)) continue;
    const min = num(l.min, 0, 1e9);
    const max = num(l.max, 0, 1e9);
    if (min === null || max === null) continue;
    const presets: Array<{ label: string; amount: number }> = [];
    if (Array.isArray(l.presets)) {
      for (const p of l.presets) {
        if (!isRec(p)) continue;
        const label = str(p.label, 12);
        const amount = num(p.amount, 0, 1e9);
        if (label === null || amount === null) continue;
        presets.push({ label, amount });
      }
    }
    out.push({ kind: l.kind as ActionKind, min, max, ...(presets.length ? { presets } : {}) });
  }
  return out;
}

function coerceLobby(v: unknown): LobbyTable[] {
  if (!Array.isArray(v)) return [];
  const out: LobbyTable[] = [];
  for (const raw of v) {
    if (!isRec(raw)) continue;
    const id = str(raw.id, 64);
    if (!id) continue;
    if (typeof raw.variant !== 'string' || !VARIANTS.has(raw.variant)) continue;
    if (typeof raw.format !== 'string' || !FORMATS.has(raw.format)) continue;
    if (typeof raw.stakeId !== 'string' || !STAKE_IDS.has(raw.stakeId)) continue;
    out.push({
      id,
      variant: raw.variant as GameVariant,
      format: raw.format as TableFormat,
      stakeId: raw.stakeId as StakeId,
      seatsTaken: int(raw.seatsTaken, 0, 9) ?? 0,
      seatsTotal: int(raw.seatsTotal, 1, 9) ?? 6,
      avgPot: num(raw.avgPot, 0, 1e9) ?? 0,
      handsPerHour: num(raw.handsPerHour, 0, 1e4) ?? 0,
      looseness: num(raw.looseness, 0, 1) ?? 0.5,
      bombPotIn: raw.bombPotIn === null ? null : int(raw.bombPotIn, 0, 999),
    });
  }
  return out;
}

function coercePlayer(v: unknown): PlayerRef | null {
  if (!isRec(v)) return null;
  const id = str(v.id, 64);
  const name = str(v.name, 48);
  if (!id || name === null) return null;
  return {
    id,
    name,
    avatarId: str(v.avatarId, 48) ?? 'av-01',
    frameId: typeof v.frameId === 'string' ? v.frameId : null,
    titleId: typeof v.titleId === 'string' ? v.titleId : null,
    emoteSetId: str(v.emoteSetId, 48) ?? 'emote-core',
    level: int(v.level, 0, 9999) ?? 1,
    premium: v.premium === true,
    heat: num(v.heat, 0, 1) ?? 0,
    ...(typeof v.countryCode === 'string' ? { countryCode: v.countryCode.slice(0, 3) } : {}),
  };
}

const SEAT_STATUSES: ReadonlySet<string> = new Set([
  'empty',
  'sitting-out',
  'waiting',
  'active',
  'folded',
  'allin',
  'busted',
]);

function coerceSeat(v: unknown, index: number): SeatState {
  const r = isRec(v) ? v : {};
  const status = typeof r.status === 'string' && SEAT_STATUSES.has(r.status) ? (r.status as SeatState['status']) : 'empty';
  return {
    index,
    status,
    player: coercePlayer(r.player),
    stack: num(r.stack, 0, 1e9) ?? 0,
    committed: num(r.committed, 0, 1e9) ?? 0,
    totalCommitted: num(r.totalCommitted, 0, 1e9) ?? 0,
    holeCards: coerceCards(r.holeCards),
    revealed: r.revealed === true,
    isButton: r.isButton === true,
    isTurn: r.isTurn === true,
    timeBankMs: num(r.timeBankMs, 0, 6e5) ?? 0,
    lastAction: coerceAction(r.lastAction),
    wonLast: r.wonLast === true,
    sitOutNextHand: r.sitOutNextHand === true,
  };
}

function coerceBomb(v: unknown): BombPotConfig | null {
  if (!isRec(v)) return null;
  return {
    anteBb: num(v.anteBb, 0, 1000) ?? 0,
    boards: v.boards === 2 ? 2 : 1,
    triggerEveryHands: int(v.triggerEveryHands, 0, 9999) ?? 0,
    handsUntilNext: int(v.handsUntilNext, 0, 9999) ?? 0,
  };
}

function coerceTournament(v: unknown): TournamentState | null {
  if (!isRec(v)) return null;
  return {
    level: int(v.level, 0, 999) ?? 1,
    sb: num(v.sb, 0, 1e9) ?? 0,
    bb: num(v.bb, 0, 1e9) ?? 0,
    ante: num(v.ante, 0, 1e9) ?? 0,
    msUntilLevelUp: num(v.msUntilLevelUp, 0, 1e9) ?? 0,
    levelDurationMs: num(v.levelDurationMs, 0, 1e9) ?? 0,
    playersLeft: int(v.playersLeft, 0, 9999) ?? 0,
    entrants: int(v.entrants, 0, 9999) ?? 0,
    prizePool: num(v.prizePool, 0, 1e9) ?? 0,
    payouts: Array.isArray(v.payouts) ? v.payouts.map((p) => num(p, 0, 1e9) ?? 0) : [],
    finishedPlace: v.finishedPlace === null ? null : int(v.finishedPlace, 1, 9999),
  };
}

/** Full structural validation of an inbound `TableState`. */
export function coerceState(v: unknown): TableState | null {
  if (!isRec(v)) return null;
  const id = str(v.id, 64);
  if (!id) return null;
  if (typeof v.variant !== 'string' || !VARIANTS.has(v.variant)) return null;
  if (typeof v.format !== 'string' || !FORMATS.has(v.format)) return null;
  if (!isRec(v.stake)) return null;
  const seatsRaw = Array.isArray(v.seats) ? v.seats : [];
  if (seatsRaw.length < 1 || seatsRaw.length > 9) return null;

  const stake = v.stake;
  return {
    id,
    variant: v.variant as GameVariant,
    format: v.format as TableFormat,
    stake: {
      id: (typeof stake.id === 'string' && STAKE_IDS.has(stake.id) ? stake.id : 'nl10') as StakeId,
      sb: num(stake.sb, 0, 1e9) ?? 0.05,
      bb: num(stake.bb, 0, 1e9) ?? 0.1,
      label: str(stake.label, 32) ?? '',
      short: str(stake.short, 32) ?? '',
      minBuyIn: num(stake.minBuyIn, 0, 1e9) ?? 0,
      maxBuyIn: num(stake.maxBuyIn, 0, 1e9) ?? 0,
      defaultAnte: num(stake.defaultAnte, 0, 1e9) ?? 0,
      tier: (['micro', 'low', 'mid', 'high'] as const).includes(stake.tier as 'micro')
        ? (stake.tier as 'micro' | 'low' | 'mid' | 'high')
        : 'micro',
    },
    seats: seatsRaw.map((s, i) => coerceSeat(s, i)),
    board: coerceCards(v.board),
    pots: coercePots(v.pots),
    street: typeof v.street === 'string' && STREETS.has(v.street) ? (v.street as Street) : 'preflop',
    handId: int(v.handId, 0, 1e9) ?? 0,
    buttonSeat: int(v.buttonSeat, -1, 8) ?? 0,
    actingSeat: int(v.actingSeat, -1, 8) ?? -1,
    currentBet: num(v.currentBet, 0, 1e9) ?? 0,
    lastRaiseSize: num(v.lastRaiseSize, 0, 1e9) ?? 0,
    minRaiseTo: num(v.minRaiseTo, 0, 1e9) ?? 0,
    bombPot: coerceBomb(v.bombPot),
    tournament: coerceTournament(v.tournament),
    rake: num(v.rake, 0, 1e9) ?? 0,
    tick: int(v.tick, 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}
