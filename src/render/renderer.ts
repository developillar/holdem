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
 */
import * as THREE from 'three';
import { bus } from '../core/bus.ts';
import { createCameraRig, type CameraRig } from './camera.ts';
import { createPost, type PostChain } from './post.ts';
import { createScene, type StageScene } from './scene.ts';
import { layout, type TableSkin } from './table.ts';
import { initTextures } from './textures.ts';

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
const PROBE_WARMUP = 10;
const PROBE_FRAMES = 90;

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

  let probing = true;
  let probeCount = 0;
  const probeSamples: number[] = [];

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
  }

  // ─────────────────────── perf probe ───────────────────────
  function finishProbe(): void {
    probing = false;
    probeSamples.sort((a, b) => a - b);
    const median = probeSamples[probeSamples.length >> 1] || 16.7;
    // the slow tail matters more than the average on phones — a 90th
    // percentile of 30 ms means visible stutter even if the median is fine
    const p90 = probeSamples[Math.min(probeSamples.length - 1, Math.floor(probeSamples.length * 0.9))] || median;
    const fps = 1000 / median;
    let next: PerfTier;
    if (fps >= 52 && p90 < 26 && guess !== 'low') next = 'high';
    else if (fps >= 34 && p90 < 42) next = 'mid';
    else next = 'low';
    if (next !== tier) setQuality(next);
    bus.emit('perf:tier', { tier: next, fps: Math.round(fps) });
  }

  // ─────────────────────── the loop ───────────────────────
  function wake(): void {
    lastActivity = performance.now();
    dirty = true;
  }

  function frame(now: number): void {
    rafId = requestAnimationFrame(frame);
    if (!running) return;

    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (!Number.isFinite(dt) || dt < 0) dt = FIXED_DT;
    // a tab regaining focus must not fast-forward the simulation
    if (dt > 0.25) dt = FIXED_DT;

    if (probing) {
      probeCount++;
      if (probeCount > PROBE_WARMUP) probeSamples.push(dt * 1000);
      if (probeSamples.length >= PROBE_FRAMES) finishProbe();
    }

    const idle = !probing && continuous === 0 && rig.settled() && now - lastActivity > IDLE_AFTER_MS;
    if (idle && !dirty) {
      if (now - lastIdleRender < IDLE_INTERVAL_MS) return;
      lastIdleRender = now;
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

  const onResize = () => applySize();
  window.addEventListener('resize', onResize, { passive: true });
  window.visualViewport?.addEventListener('resize', onResize, { passive: true });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(canvas);

  const onVisibility = () => {
    if (document.hidden) {
      lastTime = performance.now();
    } else {
      lastTime = performance.now();
      wake();
    }
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

    start() {
      if (running) return;
      running = true;
      lastTime = performance.now();
      lastActivity = lastTime;
      accumulator = 0;
      dirty = true;
      if (!rafId) rafId = requestAnimationFrame(frame);
    },

    stop() {
      running = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    },

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
      handle.stop();
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

  return handle;
}

/** Convenience accessor for sibling render modules (cards, chips, fx). */
export function getStageHandle(): RendererHandle | null {
  const w = window as unknown as Record<string, Record<string, unknown> | undefined>;
  return (w.__royale?.renderer as RendererHandle | undefined) ?? null;
}
