/**
 * Typed application event bus. The spine every subsystem plugs into:
 * the engine emits, the renderer/audio/UI listen. Nothing calls across
 * subsystems directly — this keeps the fan-out modules decoupled.
 */
import type {
  Action,
  CardId,
  Pot,
  ReactionKind,
  ShowdownResult,
  Street,
  TableState,
  FeedPost,
  CosmeticItem,
  TrainerVerdict,
} from './types.ts';

export interface AppEvents {
  // ── table lifecycle
  'table:state': { state: TableState; you: number };
  'hand:start': { handId: number; buttonSeat: number };
  'hand:deal-hole': { seat: number; cards: CardId[]; faceUp: boolean; order: number };
  'hand:deal-board': { street: Street; cards: CardId[]; boardIndex: number };
  'hand:action': { action: Action; state: TableState };
  'hand:turn': { seat: number; timeMs: number; legal: LegalAction[] };
  'hand:pot-update': { pots: Pot[]; total: number };
  'hand:collect': { seats: number[]; total: number };
  'hand:showdown': { results: ShowdownResult[]; pots: Pot[] };
  'hand:award': { seat: number; amount: number; potIndex: number };
  'hand:end': { handId: number };
  'hand:muck': { seat: number };

  // ── camera / presentation
  'cam:focus': { seat: number | null; intensity: number };
  'cam:shake': { amount: number; ms: number };
  'fx:burst': { kind: FxBurstKind; seat?: number; at?: [number, number, number] };
  'fx:flash': { color: string; ms: number };

  // ── social
  'social:reaction': { kind: ReactionKind; fromSeat: number; targetSeat: number };
  'social:chat': { fromSeat: number; text: string };
  'feed:post': { post: FeedPost };
  'feed:react': { postId: string; kind: ReactionKind; on: boolean };

  // ── economy
  'econ:purchase': { item: CosmeticItem };
  'econ:equip': { item: CosmeticItem };
  'econ:pass-xp': { amount: number; tier: number; leveled: boolean };
  'econ:wallet': { chips: number; gems: number };

  // ── trainer
  'gto:verdict': { verdict: TrainerVerdict };
  'gto:drill-complete': { score: number; hands: number };

  // ── shell
  'nav:route': { route: RouteName; params?: Record<string, string> };
  'ui:toast': { text: string; tone: 'info' | 'good' | 'bad' | 'epic'; ms?: number };
  'ui:haptic': { pattern: HapticPattern };
  'ui:modal': { id: string | null; props?: Record<string, unknown> };
  'audio:duck': { amount: number; ms: number };
  'perf:tier': { tier: 'low' | 'mid' | 'high'; fps: number };
}

export type FxBurstKind =
  | 'chips-win'
  | 'chips-push'
  | 'card-flip'
  | 'allin'
  | 'bomb'
  | 'royal'
  | 'quads'
  | 'confetti'
  | 'level-up'
  | 'unlock';

export type HapticPattern =
  | 'tick'
  | 'select'
  | 'bet'
  | 'fold'
  | 'win'
  | 'big-win'
  | 'error'
  | 'deal';

export type RouteName =
  | 'boot'
  | 'lobby'
  | 'table'
  | 'feed'
  | 'store'
  | 'pass'
  | 'trainer'
  | 'stats'
  | 'profile'
  | 'settings';

export interface LegalAction {
  kind: Action['kind'];
  min: number;
  max: number;
  /** preset sizings for the bet slider chips, in absolute chips */
  presets?: Array<{ label: string; amount: number }>;
}

type Handler<K extends keyof AppEvents> = (payload: AppEvents[K]) => void;

class Bus {
  private map = new Map<string, Set<Handler<never>>>();

  on<K extends keyof AppEvents>(key: K, fn: Handler<K>): () => void {
    let set = this.map.get(key as string);
    if (!set) {
      set = new Set();
      this.map.set(key as string, set);
    }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  once<K extends keyof AppEvents>(key: K, fn: Handler<K>): () => void {
    const off = this.on(key, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof AppEvents>(key: K, payload: AppEvents[K]): void {
    const set = this.map.get(key as string);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as Handler<K>)(payload);
      } catch (err) {
        console.error(`[bus] handler failed for ${String(key)}`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const bus = new Bus();
