/**
 * ROYALE — latency hiding.
 *
 * Three independent pieces, each solving one visible symptom of a 120 ms link:
 *
 *  1. `ServerClock` — an NTP-style offset estimator. Round trips are noisy;
 *     the *minimum* observed RTT is the one least polluted by queueing, so we
 *     estimate the offset from the cleanest sample rather than the average.
 *     Without this, a 15-second action clock starts a quarter-second late and
 *     the last tick lies.
 *
 *  2. `Predictor` — the hero's own action lands instantly. We apply it to the
 *     local state, keep the pre-action snapshot, and reconcile when the server
 *     speaks. If the server rejects it, we roll back and re-emit the truth.
 *     Only the hero's action is predicted: everything else is another
 *     player's business and guessing it would produce visible rubber-banding.
 *
 *  3. `ValueSmoother` — pots and stacks arrive as steps at the tick rate. A
 *     critically-damped spring turns them into motion. This is a *pull* API on
 *     purpose: emitting eased values on the bus at 60 Hz would make the
 *     renderer rebuild chip racks every frame, so the UI samples it instead.
 */

import type { Action, ActionKind, CardId, Pot, SeatState, TableState } from '../core/types.ts';
import type { LegalAction } from '../core/bus.ts';

// ═══════════════════════════════════════════════════════════════════
// 1 — Server clock
// ═══════════════════════════════════════════════════════════════════

interface Sample {
  rtt: number;
  offset: number;
  at: number;
}

export class ServerClock {
  private samples: Sample[] = [];
  private best: Sample | null = null;
  private smoothedRtt = 0;
  private jitterMs = 0;

  /**
   * Called when a `pong` returns. `sentAt` is our own timestamp echoed back,
   * so the round trip is exact without any clock agreement.
   */
  notePong(sentAt: number, receivedAt = Date.now()): number {
    const rtt = Math.max(0, receivedAt - sentAt);
    this.smoothedRtt = this.smoothedRtt === 0 ? rtt : this.smoothedRtt * 0.8 + rtt * 0.2;
    this.jitterMs = this.jitterMs * 0.85 + Math.abs(rtt - this.smoothedRtt) * 0.15;
    return rtt;
  }

  /**
   * Called when a message carrying the server's own wall clock arrives.
   * `offset = serverTime + oneWay - localArrival`, so `local + offset` is
   * server time.
   */
  noteServerTime(serverTime: number, receivedAt = Date.now(), rttHint = this.smoothedRtt): void {
    if (!Number.isFinite(serverTime) || serverTime <= 0) return;
    const rtt = rttHint > 0 ? rttHint : 0;
    const sample: Sample = { rtt, offset: serverTime + rtt / 2 - receivedAt, at: receivedAt };
    this.samples.push(sample);
    if (this.samples.length > 24) this.samples.shift();

    // Keep the lowest-RTT sample from the last minute — it is the least
    // distorted by queueing on either side.
    const fresh = this.samples.filter((s) => receivedAt - s.at < 60_000);
    let best = fresh[0] ?? sample;
    for (const s of fresh) if (s.rtt < best.rtt) best = s;
    if (!this.best) this.best = best;
    else this.best = { ...best, offset: this.best.offset * 0.7 + best.offset * 0.3 };
  }

  /** Round-trip time in ms, exponentially smoothed. */
  get rtt(): number {
    return Math.round(this.smoothedRtt);
  }

  /** Variation in RTT — the UI shows a warning above ~80 ms. */
  get jitter(): number {
    return Math.round(this.jitterMs);
  }

  get offset(): number {
    return this.best ? this.best.offset : 0;
  }

  get synced(): boolean {
    return this.best !== null;
  }

  /** Best estimate of the server's wall clock right now. */
  now(): number {
    return Date.now() + this.offset;
  }

  /**
   * How much of an action clock is genuinely left, given the server said
   * `timeMs` remained at its local time `serverTime`.
   */
  remaining(serverTime: number, timeMs: number): number {
    if (!this.synced) return Math.max(0, timeMs - this.smoothedRtt / 2);
    return Math.max(0, serverTime + timeMs - this.now());
  }

  reset(): void {
    this.samples.length = 0;
    this.best = null;
    this.smoothedRtt = 0;
    this.jitterMs = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 2 — Optimistic action prediction
// ═══════════════════════════════════════════════════════════════════

export interface PendingAction {
  seq: number;
  handId: number;
  seat: number;
  kind: ActionKind;
  /** total street commitment the client believes it made */
  to: number;
  sentAt: number;
  /** the authoritative state as it stood before we guessed */
  before: TableState;
}

export interface PredictionEvents {
  /** the locally-predicted state, ready to render */
  onState(state: TableState): void;
  /** predicted action, for the same animation the server's echo would drive */
  onAction(action: Action, state: TableState): void;
  /** the server said no — this is the corrected state */
  onRollback(state: TableState, reason: string): void;
}

/** How long a prediction may stand before we assume it was lost. */
const PREDICTION_TTL_MS = 4000;

function cloneState(s: TableState): TableState {
  return {
    ...s,
    board: s.board.slice(),
    pots: s.pots.map((p) => ({ ...p })),
    seats: s.seats.map((seat) => ({
      ...seat,
      holeCards: seat.holeCards.slice(),
      lastAction: seat.lastAction ? { ...seat.lastAction } : null,
    })),
  };
}

export class Predictor {
  private pending: PendingAction | null = null;
  private events: PredictionEvents;
  private step = 0.01;

  constructor(events: PredictionEvents) {
    this.events = events;
  }

  setChipStep(step: number): void {
    this.step = step > 0 ? step : 0.01;
  }

  get inFlight(): PendingAction | null {
    return this.pending;
  }

  /**
   * Apply the hero's action locally, right now. Returns the predicted state,
   * or `null` if the action is not in the legal set (in which case nothing
   * should be sent to the server either).
   */
  predict(
    state: TableState,
    seat: number,
    kind: ActionKind,
    amount: number,
    legal: readonly LegalAction[],
    seq: number,
  ): TableState | null {
    const entry = legal.find((l) => l.kind === kind);
    if (!entry) return null;
    const target =
      kind === 'bet' || kind === 'raise'
        ? Math.min(Math.max(this.q(amount), entry.min), entry.max)
        : entry.max;

    const before = cloneState(state);
    const next = cloneState(state);
    const s = next.seats[seat];
    if (!s) return null;

    const seqIndex = (s.lastAction?.seq ?? -1) + 1;
    if (kind === 'fold') {
      s.status = 'folded';
    } else {
      const delta = this.q(Math.max(0, target - s.committed));
      const paid = Math.min(delta, s.stack);
      s.stack = this.q(s.stack - paid);
      s.committed = this.q(s.committed + paid);
      s.totalCommitted = this.q(s.totalCommitted + paid);
      if (s.stack <= this.step / 2) s.status = 'allin';
      if (s.committed > next.currentBet) {
        next.lastRaiseSize = this.q(s.committed - next.currentBet);
        next.currentBet = s.committed;
        next.minRaiseTo = this.q(next.currentBet + next.lastRaiseSize);
      }
      // The pot total the HUD reads must move with the bet, not a tick later.
      const total = next.seats.reduce((a, x) => a + x.totalCommitted, 0);
      if (next.pots.length === 0) next.pots = [{ amount: this.q(total), eligible: [], index: 0 }];
      else next.pots[0] = { ...next.pots[0], amount: this.q(next.pots[0].amount + paid) };
    }

    const action: Action = {
      kind,
      amount: kind === 'fold' ? 0 : s.committed,
      seat,
      seq: seqIndex,
      street: next.street,
    };
    s.lastAction = action;
    s.isTurn = false;
    next.actingSeat = -1;

    this.pending = {
      seq,
      handId: state.handId,
      seat,
      kind,
      to: target,
      sentAt: Date.now(),
      before,
    };

    this.events.onState(next);
    this.events.onAction(action, next);
    return next;
  }

  /**
   * Fold an authoritative update into whatever we predicted. Returns the state
   * the UI should show: the server's, with our un-acknowledged action still
   * applied on top so the hero's chips do not jump backwards.
   */
  reconcile(authoritative: TableState, now = Date.now()): TableState {
    const p = this.pending;
    if (!p) return authoritative;

    if (authoritative.handId !== p.handId) {
      this.pending = null;
      return authoritative;
    }
    const seat = authoritative.seats[p.seat];
    if (!seat) {
      this.pending = null;
      return authoritative;
    }

    // The server has seen it if our seat's commitment caught up, or the hand
    // moved past the street we acted on, or we are shown as folded.
    const settled =
      (p.kind === 'fold' && seat.status === 'folded') ||
      (p.kind !== 'fold' && seat.committed >= p.to - this.step / 2) ||
      authoritative.street !== p.before.street;

    if (settled) {
      this.pending = null;
      return authoritative;
    }
    if (now - p.sentAt > PREDICTION_TTL_MS) {
      this.pending = null;
      this.events.onRollback(authoritative, 'timed-out');
      return authoritative;
    }

    // Still in flight: keep the optimistic overlay.
    const merged = cloneState(authoritative);
    const m = merged.seats[p.seat];
    if (p.kind === 'fold') {
      m.status = 'folded';
    } else {
      const delta = this.q(Math.max(0, p.to - m.committed));
      const paid = Math.min(delta, m.stack);
      m.stack = this.q(m.stack - paid);
      m.committed = this.q(m.committed + paid);
      m.totalCommitted = this.q(m.totalCommitted + paid);
      if (m.committed > merged.currentBet) merged.currentBet = m.committed;
    }
    m.isTurn = false;
    if (merged.actingSeat === p.seat) merged.actingSeat = -1;
    return merged;
  }

  /** The server refused the action. Snap back to the last known truth. */
  reject(seq: number, reason: string, authoritative: TableState | null): void {
    const p = this.pending;
    if (!p || p.seq !== seq) return;
    this.pending = null;
    const restored = authoritative ?? p.before;
    this.events.onRollback(restored, reason);
  }

  clear(): void {
    this.pending = null;
  }

  private q(x: number): number {
    return Math.round(x / this.step) * this.step === 0
      ? 0
      : Math.round((Math.round(x / this.step) * this.step + Number.EPSILON) * 1e6) / 1e6;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3 — Value smoothing
// ═══════════════════════════════════════════════════════════════════

interface Track {
  value: number;
  velocity: number;
  target: number;
}

/**
 * Critically-damped spring per tracked number. `set()` on every authoritative
 * update, `sample()` once per animation frame. Values converge without
 * overshoot, which is what you want for money — a pot that springs past its
 * value and settles back reads as a bug.
 */
export class ValueSmoother {
  private tracks = new Map<string, Track>();
  private lastAt = 0;
  /** higher = snappier. 14 lands in ~250 ms with no overshoot. */
  private stiffness: number;

  constructor(stiffness = 14) {
    this.stiffness = stiffness;
  }

  set(key: string, target: number, snap = false): void {
    const t = this.tracks.get(key);
    if (!t) {
      this.tracks.set(key, { value: target, velocity: 0, target });
      return;
    }
    t.target = target;
    if (snap) {
      t.value = target;
      t.velocity = 0;
    }
  }

  /** Advance every track. Call once per frame with the frame timestamp. */
  step(now = performance.now()): void {
    const dt = this.lastAt === 0 ? 1 / 60 : Math.min(0.05, (now - this.lastAt) / 1000);
    this.lastAt = now;
    const k = this.stiffness;
    const c = 2 * Math.sqrt(k);
    for (const t of this.tracks.values()) {
      if (Math.abs(t.target - t.value) < 1e-4 && Math.abs(t.velocity) < 1e-4) {
        t.value = t.target;
        t.velocity = 0;
        continue;
      }
      const accel = k * (t.target - t.value) - c * t.velocity;
      t.velocity += accel * dt;
      t.value += t.velocity * dt;
    }
  }

  get(key: string, fallback = 0): number {
    return this.tracks.get(key)?.value ?? fallback;
  }

  /** True while anything is still moving — lets the UI stop its frame loop. */
  get settling(): boolean {
    for (const t of this.tracks.values()) {
      if (Math.abs(t.target - t.value) > 1e-4) return true;
    }
    return false;
  }

  reset(): void {
    this.tracks.clear();
    this.lastAt = 0;
  }
}

/**
 * Convenience wrapper: feeds a `TableState` into a smoother using stable keys,
 * and reads the eased values back out.
 */
export class TableSmoother {
  private smoother = new ValueSmoother(15);
  private known = false;

  ingest(state: TableState): void {
    const snap = !this.known;
    this.known = true;
    let pot = 0;
    for (const p of state.pots) pot += p.amount;
    if (pot === 0) for (const s of state.seats) pot += s.totalCommitted;
    this.smoother.set('pot', pot, snap);
    for (const s of state.seats) {
      this.smoother.set(`stack:${s.index}`, s.stack, snap || s.status === 'empty');
      this.smoother.set(`bet:${s.index}`, s.committed, snap);
    }
  }

  step(now?: number): void {
    this.smoother.step(now);
  }

  pot(): number {
    return this.smoother.get('pot');
  }
  stack(seat: number): number {
    return this.smoother.get(`stack:${seat}`);
  }
  bet(seat: number): number {
    return this.smoother.get(`bet:${seat}`);
  }
  get settling(): boolean {
    return this.smoother.settling;
  }
  reset(): void {
    this.smoother.reset();
    this.known = false;
  }
}

/** Shape helpers shared with the client — kept here so both agree. */
export type { Pot, SeatState, CardId };
