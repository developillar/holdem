/**
 * Stage host: context, loop, quality tiers and the DOM↔3D anchor bridge.
 *
 * Three responsibilities live here and nowhere else.
 *
 * 1. Colour. Linear working space, ACES filmic, sRGB out. When post is on the
 *    tone map happens in the composite pass (three disables its own for
 *    render-target draws); when post is off three does it. Same curve either
 *    way, so switching tiers mid-session is invisible.
 *
 * 2. Time. A fixed 60 Hz accumulator drives every simulation subscriber, and
 *    the render callbacks get the interpolation alpha, so card and chip
 *    physics stay deterministic no matter what the display refresh is. When
 *    the table is idle the loop drops to 20 Hz — the only thing still moving
 *    is the light breathing, which is imperceptible at that rate and saves
 *    roughly two thirds of the GPU time during a long fold-fest.
 *
 * 3. Space. Every frame the world positions of every seat, board slot, the
 *    pot, the dealer and the muck are projected into CSS pixels and published
 *    on `handle.anchors`. Text stays in the DOM where it is razor sharp, and
 *    still tracks the 3D camera exactly.
 *
 * 4. Presence. The stage belongs to the table and to nothing else, so this
 *    module — and only this module — owns whether the canvas is on screen.
 *    `setVisible()` writes the `is-hidden` class, starts the loop on the way
 *    in and stops it once the cross-fade has landed on the way out. It is
 *    idempotent and self-healing: it rewrites the class every call, so a
 *    screen that hides the felt behind our back cannot leave the stage dark
 *    on the route that needs it.
 */
import * as THREE from 'three';
import { bus } from '../core/bus.ts';
import { createCameraRig, type CameraRig } from './camera.ts';
import { createPost, type PostChain } from './post.ts';
import { createScene, type StageScene } from './scene.ts';
import { layout, type TableSkin } from './table.ts';
import { initTextures } from './textures.ts';
import type { DealingSystem } from './dealing.ts';

export type PerfTier = 'low' | 'mid' | 'high';

export interface Anchor {
  /** CSS pixels from the left of the canvas */
  x: number;
  /** CSS pixels from the top of the canvas */
  y: number;
  /** false when behind the camera or off-screen by more than a nameplate */
  visible: boolean;
  /** NDC depth, 0 near → 1 far. Useful for z-ordering DOM chrome. */
  depth: number;
  /** CSS pixels per world unit at this point — size nameplates with it */
  scale: number;
}

export interface StageAnchors {
  /** indexed by *engine* seat number */
  seats: Anchor[];
  board: Anchor[];
  pot: Anchor;
  dealer: Anchor;
  muck: Anchor;
  /** canvas size in CSS pixels */
  width: number;
  height: number;
  /** bumps every time the anchors are recomputed */
  version: number;
}

export type FixedUpdateFn = (dt: number, elapsed: number) => void;
export type FrameFn = (alpha: number, dt: number, elapsed: number) => void;

export interface RendererHandle {
  start(): void;
  stop(): void;
  dispose(): void;

  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Attach cards, chips and props here — it is cleared on table teardown. */
  root: THREE.Group;
  renderer: THREE.WebGLRenderer;
  stage: StageScene;
  rig: CameraRig;

  readonly tier: PerfTier;
  readonly anchors: StageAnchors;
  readonly running: boolean;
  /** true while the canvas is on screen (the table route) */
  readonly visible: boolean;

  /**
   * Shows or hides the stage. The single owner of the canvas' visibility.
   * `src/main.ts` drives it off the router's settled route; anything else that
   * calls it is asserting the same thing, and repeat calls are free.
   */
  setVisible(on: boolean): void;

  /**
   * Shows the stage for the lifetime of a screen, and returns its release.
   *
   * Prefer this to `setVisible` from a screen. Route transitions overlap — the
   * outgoing screen is unmounted a few hundred ms *after* the incoming one has
   * mounted — so a screen that hid the stage in its own teardown would pull
   * the felt out from under its replacement on a fast table → lobby → table.
   * A release only fires when the claim is still the newest one, which makes
   * mount/unmount wiring correct no matter how the transitions interleave.
   */
  claimStage(): () => void;

  /**
   * The 3D seat medallions — a glass plate, portrait and rarity frame floating
   * above each seat, drawn by `render/avatars3d.ts`.
   *
   * Off by default, and the default is the architecture: `getAnchor(seat)`
   * exists so the DOM nameplate layer can pin a *crisp* seat plate to the same
   * world point, and two plates on one anchor is a doubled, blurred seat. The
   * felt keeps what only it can do — the dealer button, the chips, the cards.
   * Turn these on only if the DOM layer stops drawing a seat plate.
   */
  setSeatMedallions(on: boolean): void;

  getAnchor(seat: number): { x: number; y: number };
  setQuality(tier: PerfTier): void;
  setTableSize(size: number): void;
  setHeroSeat(seat: number): void;
  setSkin(skin: Partial<TableSkin>): void;
  setExposure(v: number): void;

  /** Deterministic 60 Hz simulation step. Returns an unsubscribe. */
  onFixedUpdate(fn: FixedUpdateFn): () => void;
  /** Per rendered frame, with the interpolation alpha. Returns unsubscribe. */
  onFrame(fn: FrameFn): () => void;

  /** Wakes the loop from idle for one frame. */
  requestRender(): void;
  /** Pins the loop to full rate — use while an animation is in flight. */
  setContinuous(on: boolean): void;
  resize(): void;
}

const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;
const IDLE_AFTER_MS = 900;
const IDLE_INTERVAL_MS = 50;

/**
 * Quality is measured continuously, never once.
 *
 * A single 90-frame probe at boot samples the worst 1.5 seconds the app will
 * ever have — shader compilation, texture uploads, the first layout — and on
 * a phone that is also the moment the OS is still winding the GPU clock up.
 * Pinning quality on that reading strands good hardware on `low` for the rest
 * of the session. So instead: a rolling window that re-reads while the stage
 * is actually on screen, moves at most one tier at a time, and uses separate
 * enter/leave thresholds so a device sitting on a boundary cannot oscillate.
 */
const SAMPLE_WARMUP = 12;
const SAMPLE_WINDOW = 90;
/**
 * A window also closes on time, not only on count. 90 frames is a second and a
 * half on a phone that is coping and a minute and a half on one that is not —
 * and the one that is not is precisely the one that needs the verdict fastest.
 */
const SAMPLE_MIN = 24;
const WINDOW_MS = 2200;
/** frames discarded after the loop resumes from the idle throttle */
const RESUME_WARMUP = 3;
/**
 * Above this a frame is a stall — a long GC, a synchronous screen mount — not
 * a frame rate. Deliberately generous: the window is judged on its median and
 * 90th percentile, both of which shrug off a handful of spikes, and a cutoff
 * tight enough to catch every hitch also hides genuinely struggling hardware
 * from itself, which is the failure mode that matters. (A backgrounded tab
 * produces gaps far larger than this and is thrown out by `visibilitychange`
 * before it can reach the window at all.)
 */
const STALL_MS = 2000;
/** no two tier changes closer together than this */
const TIER_HOLD_MS = 4000;
/** matches the `#stage` fade in base.css — keep drawing until it lands */
const HIDE_LINGER_MS = 420;

interface TierBand {
  /** median frames per second */
  fps: number;
  /** 90th-percentile frame time in ms — the stutter the median hides */
  p90: number;
}

/** Comfortably clear of the band below before we ask for more. */
const TIER_UP: Record<'mid' | 'high', TierBand> = {
  mid: { fps: 42, p90: 34 },
  high: { fps: 56, p90: 22 },
};

/** Genuinely struggling before we take anything away. */
const TIER_DOWN: Record<'mid' | 'high', TierBand> = {
  mid: { fps: 32, p90: 46 },
  high: { fps: 46, p90: 30 },
};

const DPR_CAP: Record<PerfTier, number> = { low: 1.5, mid: 2.0, high: 2.5 };

/** Anything on this list means the table is doing something worth 60 Hz. */
const WAKE_EVENTS = [
  'table:state',
  'hand:start',
  'hand:deal-hole',
  'hand:deal-board',
  'hand:action',
  'hand:turn',
  'hand:pot-update',
  'hand:collect',
  'hand:showdown',
  'hand:award',
  'hand:end',
  'hand:muck',
  'cam:focus',
  'cam:shake',
  'fx:burst',
  'fx:flash',
  'social:reaction',
  'econ:equip',
  'nav:route',
] as const;

function emptyAnchor(): Anchor {
  return { x: 0, y: 0, visible: false, depth: 1, scale: 1 };
}

/** Pre-probe guess so the first frames are not rendered at the wrong cost. */
function heuristicTier(): PerfTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (mem <= 2 || cores <= 2) return 'low';
  if (mem <= 4 || cores <= 4) return 'mid';
  return 'high';
}

export async function initRenderer(canvas: HTMLCanvasElement): Promise<RendererHandle> {
  const guess = heuristicTier();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: guess !== 'mid',
    alpha: false,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  });

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  // r185 folded PCFSoft into PCFShadowMap: it is a poisson-disk percentage
  // closer filter driven by `light.shadow.radius`, so this *is* the soft path.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.autoClear = true;
  renderer.setClearColor(0x04050a, 1);
  // we render several times per frame; reset once at the top of the frame so
  // `renderer.info` reports real per-frame totals to the perf overlay
  renderer.info.autoReset = false;

  initTextures({
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    scale: guess === 'low' ? 0.5 : 1,
  });

  const stage = createScene(renderer);
  const rig = createCameraRig();
  const post = createPost(renderer);

  const anchors: StageAnchors = {
    seats: Array.from({ length: 9 }, emptyAnchor),
    board: Array.from({ length: 5 }, emptyAnchor),
    pot: emptyAnchor(),
    dealer: emptyAnchor(),
    muck: emptyAnchor(),
    width: 1,
    height: 1,
    version: 0,
  };

  let tier: PerfTier = guess;
  let tableSize = 9;
  let heroSeat = 0;

  let running = false;
  let rafId = 0;
  let lastTime = 0;
  let accumulator = 0;
  let elapsed = 0;
  let cssW = 1;
  let cssH = 1;

  let dirty = true;
  let continuous = 0;
  let lastActivity = performance.now();
  let lastIdleRender = 0;

  let visible = false;
  let hideTimer = 0;
  let disposed = false;

  const samples: number[] = [];
  let windowStart = 0;
  let warmup = SAMPLE_WARMUP;
  let lastTierChange = Number.NEGATIVE_INFINITY;
  /** set while we are the source of a `perf:tier` emit, so we ignore our own */
  let emittingTier = false;
  /** a settings override switches the rolling window off for the session */
  let tierPinned = false;

  const fixedSubs = new Set<FixedUpdateFn>();
  const frameSubs = new Set<FrameFn>();

  const projected = new THREE.Vector3();

  // ─────────────────────── sizing ───────────────────────
  function applySize(): void {
    const w = canvas.clientWidth || window.innerWidth || 1;
    const h = canvas.clientHeight || window.innerHeight || 1;
    if (w === cssW && h === cssH) return;
    cssW = w;
    cssH = h;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[tier]);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    rig.resize(w, h);
    post.setSize(w, h, dpr);
    anchors.width = w;
    anchors.height = h;
    dirty = true;
  }

  // ─────────────────────── anchors ───────────────────────
  function project(v: THREE.Vector3, out: Anchor): void {
    projected.copy(v).project(rig.camera);
    const behind = projected.z > 1;
    out.x = (projected.x * 0.5 + 0.5) * cssW;
    out.y = (-projected.y * 0.5 + 0.5) * cssH;
    out.depth = THREE.MathUtils.clamp(projected.z * 0.5 + 0.5, 0, 1);
    out.visible =
      !behind && out.x > -140 && out.x < cssW + 140 && out.y > -140 && out.y < cssH + 140;
    const dist = rig.camera.position.distanceTo(v);
    const halfH = Math.tan((rig.camera.fov * Math.PI) / 360) * dist;
    out.scale = halfH > 1e-5 ? cssH / (2 * halfH) : 1;
  }

  function updateAnchors(): void {
    const seats = layout.seats(tableSize);
    for (let seat = 0; seat < anchors.seats.length; seat++) {
      if (seat >= tableSize) {
        anchors.seats[seat].visible = false;
        continue;
      }
      const slot = layout.slotFor(seat, heroSeat, tableSize);
      project(seats[slot].plate, anchors.seats[seat]);
    }
    for (let i = 0; i < 5; i++) project(layout.BOARD_SLOTS[i], anchors.board[i]);
    project(layout.POT_CENTER, anchors.pot);
    project(layout.DEALER_POS, anchors.dealer);
    project(layout.MUCK_POS, anchors.muck);
    anchors.version++;
  }

  // ─────────────────────── quality ───────────────────────
  function setQuality(next: PerfTier): void {
    tier = next;
    stage.setQuality(next);
    post.setQuality(next);
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP[next]);
    renderer.setPixelRatio(dpr);
    renderer.setSize(cssW, cssH, false);
    post.setSize(cssW, cssH, dpr);
    renderer.shadowMap.enabled = next !== 'low';
    dirty = true;
    // every measurement taken at the old cost is now meaningless
    samples.length = 0;
    warmup = SAMPLE_WARMUP;
  }

  function announceTier(fps: number): void {
    emittingTier = true;
    try {
      bus.emit('perf:tier', { tier, fps: Math.round(fps) });
    } finally {
      emittingTier = false;
    }
  }

  // ─────────────────────── rolling perf window ───────────────────────
  /** One tier step, chosen from the window that just closed. */
  function tierFor(fps: number, p90: number): PerfTier {
    if (tier === 'high') return fps < TIER_DOWN.high.fps || p90 > TIER_DOWN.high.p90 ? 'mid' : 'high';
    if (tier === 'mid') {
      if (fps < TIER_DOWN.mid.fps || p90 > TIER_DOWN.mid.p90) return 'low';
      if (fps >= TIER_UP.high.fps && p90 <= TIER_UP.high.p90) return 'high';
      return 'mid';
    }
    return fps >= TIER_UP.mid.fps && p90 <= TIER_UP.mid.p90 ? 'mid' : 'low';
  }

  function closeWindow(now: number): void {
    const sorted = samples.slice().sort((a, b) => a - b);
    samples.length = 0;
    warmup = SAMPLE_WARMUP;

    const median = sorted[sorted.length >> 1] || 16.7;
    // the slow tail matters more than the average on phones — a 90th
    // percentile of 30 ms means visible stutter even if the median is fine
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] || median;
    const fps = 1000 / median;

    const next = tierFor(fps, p90);
    if (next === tier) return;
    setQuality(next);
    lastTierChange = now;
    announceTier(fps);
  }

  function sample(now: number, dtMs: number): void {
    if (tierPinned || !visible) return;
    if (warmup > 0) {
      warmup--;
      windowStart = now;
      return;
    }
    if (dtMs > STALL_MS) {
      warmup = RESUME_WARMUP;
      return;
    }
    if (samples.length === 0) windowStart = now;
    samples.push(dtMs);

    const full = samples.length >= SAMPLE_WINDOW;
    const timedOut = samples.length >= SAMPLE_MIN && now - windowStart >= WINDOW_MS;
    if (!full && !timedOut) return;
    if (now - lastTierChange < TIER_HOLD_MS) {
      samples.length = 0;
      return;
    }
    closeWindow(now);
  }

  // ─────────────────────── the loop ───────────────────────
  function wake(): void {
    lastActivity = performance.now();
    dirty = true;
  }

  function frame(now: number): void {
    rafId = requestAnimationFrame(frame);
    if (!running) return;

    const rawMs = now - lastTime;
    let dt = rawMs / 1000;
    lastTime = now;
    if (!Number.isFinite(dt) || dt < 0) dt = FIXED_DT;
    // a tab regaining focus must not fast-forward the simulation
    if (dt > 0.25) dt = FIXED_DT;

    const idle = continuous === 0 && rig.settled() && now - lastActivity > IDLE_AFTER_MS;
    if (idle) {
      // The throttled cadence is not a frame rate. Measuring it would read as
      // a 20fps device and drag a perfectly good phone down to `low`, so the
      // window stays shut through the idle stretch and for a few frames after
      // it, while the loop spins back up to full rate.
      warmup = Math.max(warmup, RESUME_WARMUP);
      if (!dirty) {
        if (now - lastIdleRender < IDLE_INTERVAL_MS) return;
        lastIdleRender = now;
      }
    } else {
      sample(now, Number.isFinite(rawMs) && rawMs > 0 ? rawMs : FIXED_DT * 1000);
    }
    dirty = false;
    renderer.info.reset();

    elapsed += dt;
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      rig.update(FIXED_DT, elapsed - accumulator + FIXED_DT);
      for (const fn of fixedSubs) fn(FIXED_DT, elapsed);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;

    const alpha = accumulator / FIXED_DT;
    stage.update(elapsed);
    for (const fn of frameSubs) fn(alpha, dt, elapsed);

    rig.camera.updateMatrixWorld();
    updateAnchors();
    post.render(stage.scene, rig.camera, elapsed);
  }

  function startLoop(): void {
    if (running || disposed) return;
    running = true;
    lastTime = performance.now();
    lastActivity = lastTime;
    accumulator = 0;
    dirty = true;
    warmup = Math.max(warmup, SAMPLE_WARMUP);
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function stopLoop(): void {
    running = false;
    samples.length = 0;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  // ─────────────────────── play systems ───────────────────────
  /**
   * Cards, chips, seat avatars and felt particles. They listen to the bus on
   * their own, so nothing outside the render layer has to hand them events —
   * but somebody has to build them, and that somebody is the stage host.
   * Deferred to the first time the table is actually opened: it is several
   * megabytes of geometry and canvas atlases that a player browsing the store
   * should never pay for, and by the time the buy-in sheet is answered they
   * have been resident for a while.
   */
  let play: DealingSystem | null = null;
  let releasePlay: (() => void) | null = null;
  let playPending = false;
  let seatMedallions = false;

  function applyMedallions(): void {
    if (!play) return;
    for (let seat = 0; seat < 9; seat++) play.avatars.setVisible(seat, seatMedallions);
  }

  function setSeatMedallions(on: boolean): void {
    seatMedallions = on;
    applyMedallions();
    wake();
  }

  function ensurePlaySystems(): void {
    if (playPending || releasePlay || disposed) return;
    playPending = true;
    void import('./dealing.ts')
      .then((mod) => {
        playPending = false;
        if (disposed || releasePlay) return;
        play = mod.initDealing({ tier });
        releasePlay = () => {
          mod.disposeDealing();
          play = null;
        };
        applyMedallions();
        wake();
      })
      .catch((err) => {
        playPending = false;
        console.error('[stage] play systems failed to load', err);
      });
  }

  // ─────────────────────── presence ───────────────────────
  function setVisible(on: boolean): void {
    visible = on;
    // Written every call rather than on change. Screens hide the felt before
    // their own first paint by adding this class directly, and the renderer is
    // the authority on the route that needs it — re-asserting here is what
    // makes "navigate to the table" end with a visible stage no matter which
    // screen mounted last or how the route transitions interleaved.
    canvas.classList.toggle('is-hidden', !on);
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    if (on) {
      ensurePlaySystems();
      startLoop();
      // A screen is mounting on top of us right now — its chunk, its CSS and
      // its first layout all land in the next few hundred ms. Give the window
      // a grace period so the tier is judged on the table as it plays, not on
      // the cost of arriving at it.
      samples.length = 0;
      warmup = SAMPLE_WARMUP;
      lastTierChange = performance.now();
      // The DOM nameplate layer reads `getAnchor()` on its very first frame,
      // which can beat our first rAF. Project once, now, so it never lands a
      // plate at the origin and springs it into place a frame later.
      applySize();
      rig.camera.updateMatrixWorld();
      updateAnchors();
      wake();
    } else if (running) {
      // Keep drawing through the cross-fade, then hand the GPU back.
      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        if (!visible) stopLoop();
      }, HIDE_LINGER_MS);
    }
  }

  let claimSeq = 0;
  let activeClaim = 0;

  function claimStage(): () => void {
    const id = ++claimSeq;
    activeClaim = id;
    setVisible(true);
    return () => {
      if (activeClaim !== id) return;
      activeClaim = 0;
      setVisible(false);
    };
  }

  // ─────────────────────── events ───────────────────────
  const offs: Array<() => void> = [];
  for (const key of WAKE_EVENTS) offs.push(bus.on(key, wake));

  offs.push(
    bus.on('table:state', ({ state, you }) => {
      const size = state.seats.length;
      if (size >= 2 && size <= 9) {
        tableSize = size;
        rig.setTableSize(size);
      }
      if (you >= 0) {
        heroSeat = you;
        rig.setHeroSeat(you);
      }
      wake();
    }),
  );

  offs.push(
    bus.on('econ:equip', ({ item }) => {
      if (item.kind !== 'table-skin' && item.kind !== 'felt') return;
      const p = item.params as Partial<TableSkin>;
      stage.setSkin(p);
      wake();
    }),
  );

  offs.push(
    bus.on('fx:burst', ({ kind }) => {
      if (kind === 'allin' || kind === 'royal' || kind === 'quads') stage.lights.pulse(0.5, 700);
      if (kind === 'chips-win' || kind === 'level-up') stage.lights.pulse(0.22, 480);
    }),
  );

  // Settings publishes an explicit quality choice on the same event we use to
  // announce our own reading. Honour it — and stop second-guessing the player
  // for the rest of the session, since auto is exactly what they turned off.
  offs.push(
    bus.on('perf:tier', ({ tier: wanted }) => {
      if (emittingTier || wanted === tier) return;
      tierPinned = true;
      setQuality(wanted);
      wake();
    }),
  );

  const onResize = () => applySize();
  window.addEventListener('resize', onResize, { passive: true });
  window.visualViewport?.addEventListener('resize', onResize, { passive: true });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(canvas);

  const onVisibility = () => {
    lastTime = performance.now();
    // Frames either side of a backgrounded tab are worthless as a measurement.
    samples.length = 0;
    warmup = SAMPLE_WARMUP;
    if (!document.hidden) wake();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // DeviceOrientation needs a gesture on iOS — take the first one we see.
  const onFirstGesture = () => {
    void rig.enableTilt();
    window.removeEventListener('pointerdown', onFirstGesture);
    window.removeEventListener('touchstart', onFirstGesture);
  };
  window.addEventListener('pointerdown', onFirstGesture, { passive: true, once: false });
  window.addEventListener('touchstart', onFirstGesture, { passive: true, once: false });

  const onContextLost = (e: Event) => {
    e.preventDefault();
    running = false;
  };
  const onContextRestored = () => {
    applySize();
    setQuality(tier);
    lastTime = performance.now();
    running = true;
    wake();
  };
  canvas.addEventListener('webglcontextlost', onContextLost as EventListener);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  // ─────────────────────── warm up ───────────────────────
  applySize();
  setQuality(guess);
  rig.update(FIXED_DT, 0);
  stage.update(0);
  try {
    await renderer.compileAsync(stage.scene, rig.camera);
  } catch {
    renderer.compile(stage.scene, rig.camera);
  }
  // one full trip through the post chain so its six programs are resident
  // before the boot curtain lifts, instead of hitching on the first hand
  post.render(stage.scene, rig.camera, 0);
  updateAnchors();

  const handle: RendererHandle = {
    scene: stage.scene,
    camera: rig.camera,
    root: stage.root,
    renderer,
    stage,
    rig,
    anchors,

    get tier() {
      return tier;
    },
    get running() {
      return running;
    },
    get visible() {
      return visible;
    },

    start: startLoop,
    stop: stopLoop,
    setVisible,
    claimStage,
    setSeatMedallions,

    getAnchor(seat: number) {
      const a = anchors.seats[Math.max(0, Math.min(anchors.seats.length - 1, seat))];
      return { x: a.x, y: a.y };
    },

    setQuality,

    setTableSize(size: number) {
      tableSize = Math.max(2, Math.min(9, Math.round(size)));
      rig.setTableSize(tableSize);
      wake();
    },

    setHeroSeat(seat: number) {
      heroSeat = seat;
      rig.setHeroSeat(seat);
      wake();
    },

    setSkin(skin: Partial<TableSkin>) {
      stage.setSkin(skin);
      wake();
    },

    setExposure(v: number) {
      post.setExposure(v);
      wake();
    },

    onFixedUpdate(fn) {
      fixedSubs.add(fn);
      return () => fixedSubs.delete(fn);
    },

    onFrame(fn) {
      frameSubs.add(fn);
      return () => frameSubs.delete(fn);
    },

    requestRender() {
      wake();
    },

    setContinuous(on: boolean) {
      continuous = Math.max(0, continuous + (on ? 1 : -1));
      if (on) wake();
    },

    resize() {
      cssW = -1;
      applySize();
    },

    dispose() {
      disposed = true;
      stopLoop();
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = 0;
      }
      releasePlay?.();
      releasePlay = null;
      for (const off of offs) off();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('touchstart', onFirstGesture);
      canvas.removeEventListener('webglcontextlost', onContextLost as EventListener);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      rig.dispose();
      post.dispose();
      stage.dispose();
      renderer.dispose();
    },
  };

  // QA harness hook. `nav` is filled in by the UI shell once it mounts; we
  // merge rather than overwrite so boot order between us never matters.
  const w = window as unknown as Record<string, Record<string, unknown>>;
  w.__royale = Object.assign(w.__royale ?? {}, { renderer: handle });

  // The stage belongs to the table and starts off it, hidden and stopped, so
  // the lobby never has felt bleeding through it and never pays for a loop it
  // cannot see. Owning this from the very first frame is also what lets the
  // class be written from exactly one place for the rest of the session.
  setVisible(false);

  // Subsystems gate their budgets on `perf:tier` and must not wait for the
  // first table to open to hear a number. This is the pre-probe guess; the
  // rolling window replaces it with a measurement once the stage is on screen.
  announceTier(60);

  return handle;
}

/** Convenience accessor for sibling render modules (cards, chips, fx). */
export function getStageHandle(): RendererHandle | null {
  const w = window as unknown as Record<string, Record<string, unknown> | undefined>;
  return (w.__royale?.renderer as RendererHandle | undefined) ?? null;
}
