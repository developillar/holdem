/**
 * ROYALE — the single coupling point between `src/net/*` and `src/engine/*`.
 *
 * `src/engine/table.ts` is owned by another module and is still moving. Rather
 * than binding to it at import time — which would take the whole network layer
 * down if a signature drifts — everything goes through here:
 *
 *   · one dynamic `import()`, wrapped in try/catch, resolved once
 *   · every method probed for existence before it is called
 *   · a null result is a supported outcome, not an error
 *
 * If the engine is unavailable, `src/net/offline.ts` degrades to an
 * observer-only local session rather than crashing the app. If it *is*
 * available (the normal case) the offline session is the full local table,
 * bots and all, emitting the same bus events as the live server.
 */

import type {
  ActionKind,
  GameVariant,
  PlayerRef,
  StakeId,
  TableFormat,
  TableState,
} from '../core/types.ts';
import type { LegalAction } from '../core/bus.ts';

/** Options we pass through to `createLocalTable`. Keys the engine does not
 *  know about are harmless — it destructures what it recognises. */
export interface LocalTableOptions {
  id?: string;
  variant?: GameVariant;
  format?: TableFormat;
  stakeId?: StakeId;
  seatCount?: number;
  heroSeat?: number;
  heroBuyIn?: number;
  hero?: Partial<PlayerRef>;
  seed?: number;
  pace?: number;
  looseness?: number;
  autoRebuy?: boolean;
  continuous?: boolean;
}

/** The subset of `LocalTable` the network layer relies on. */
export interface LocalTableHandle {
  readonly id: string;
  readonly heroSeat: number;
  start(): void;
  stop(): void;
  destroy(): void;
  state(): TableState;
  legalActions(): LegalAction[];
  act(kind: ActionKind, amount?: number): boolean;
  sitOut(on: boolean): void;
  rebuy(amount: number): boolean;
  setPace(p: number): void;
}

interface EngineModule {
  createLocalTable?: (opts: LocalTableOptions) => unknown;
  LocalTable?: new (opts: LocalTableOptions) => unknown;
}

let modulePromise: Promise<EngineModule | null> | null = null;
let lastError: string | null = null;

/** Resolves the engine module exactly once per page load. */
export function loadEngine(): Promise<EngineModule | null> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    try {
      const mod = (await import('../engine/table.ts')) as unknown as EngineModule;
      if (typeof mod.createLocalTable !== 'function' && typeof mod.LocalTable !== 'function') {
        lastError = 'engine/table.ts exports neither createLocalTable nor LocalTable';
        return null;
      }
      return mod;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  })();
  return modulePromise;
}

/** Why the engine could not be used, for the diagnostics overlay. */
export function engineError(): string | null {
  return lastError;
}

function hasMethod(o: unknown, name: string): boolean {
  return typeof (o as Record<string, unknown>)?.[name] === 'function';
}

/**
 * Build a local table. Returns `null` when the engine is missing or its shape
 * is not what we expect — callers must handle that, never assume.
 */
export async function createLocalTable(opts: LocalTableOptions): Promise<LocalTableHandle | null> {
  const mod = await loadEngine();
  if (!mod) return null;

  let raw: unknown = null;
  try {
    raw = mod.createLocalTable ? mod.createLocalTable(opts) : mod.LocalTable ? new mod.LocalTable(opts) : null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
  if (!raw) return null;

  const required = ['start', 'stop', 'state', 'act'];
  for (const name of required) {
    if (!hasMethod(raw, name)) {
      lastError = `engine table is missing ${name}()`;
      return null;
    }
  }

  const t = raw as Record<string, (...args: unknown[]) => unknown> & { id?: string; heroSeat?: number };

  return {
    get id(): string {
      return typeof t.id === 'string' ? t.id : opts.id ?? 'local';
    },
    get heroSeat(): number {
      return typeof t.heroSeat === 'number' ? t.heroSeat : (opts.heroSeat ?? 0);
    },
    start: () => {
      t.start();
    },
    stop: () => {
      t.stop();
    },
    destroy: () => {
      if (hasMethod(raw, 'destroy')) t.destroy();
      else t.stop();
    },
    state: () => t.state() as TableState,
    legalActions: () => (hasMethod(raw, 'legalActions') ? (t.legalActions() as LegalAction[]) : []),
    act: (kind: ActionKind, amount = 0) => t.act(kind, amount) === true,
    sitOut: (on: boolean) => {
      if (hasMethod(raw, 'sitOut')) t.sitOut(on);
    },
    rebuy: (amount: number) => (hasMethod(raw, 'rebuy') ? t.rebuy(amount) === true : false),
    setPace: (p: number) => {
      if (hasMethod(raw, 'setPace')) t.setPace(p);
    },
  };
}
