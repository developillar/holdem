/**
 * Portrait camera rig.
 *
 * A spherical rig (azimuth / elevation / distance around a pivot) driven
 * entirely by critically-ish damped springs, so every move has weight and
 * nothing ever cuts. The base pose is *solved* rather than hard-coded: on
 * every resize we iterate distance and pivot until the table's silhouette
 * lands in the same place on a 360×640 as on a 430×932.
 *
 * Motion budget is deliberately tiny. Idle drift peaks at 0.9° of azimuth,
 * device tilt at 2.6°, and shake at 3 cm of translation. A poker session is
 * forty minutes long; anything larger becomes nausea.
 */
import * as THREE from 'three';
import { bus } from '../core/bus.ts';
import { layout } from './table.ts';

const DEG = Math.PI / 180;

/** Semi-implicit damped spring. Stable at the 60 Hz fixed step we run at. */
class Spring {
  value: number;
  target: number;
  vel = 0;
  private omega: number;
  private zeta: number;

  constructor(value: number, omega: number, zeta: number) {
    this.value = value;
    this.target = value;
    this.omega = omega;
    this.zeta = zeta;
  }

  set(v: number): void {
    this.value = v;
    this.target = v;
    this.vel = 0;
  }

  step(dt: number): void {
    const a = this.omega * this.omega * (this.target - this.value) - 2 * this.zeta * this.omega * this.vel;
    this.vel += a * dt;
    this.value += this.vel * dt;
  }

  get settled(): boolean {
    return Math.abs(this.vel) < 1e-4 && Math.abs(this.target - this.value) < 1e-4;
  }
}

type MoveKind = 'allin' | 'showdown';

interface Move {
  kind: MoveKind;
  t: number;
  dur: number;
  attack: number;
  release: number;
}

function envelope(m: Move): number {
  if (m.t < m.attack) {
    const p = m.t / m.attack;
    return 1 - Math.pow(1 - p, 3);
  }
  const tail = m.dur - m.release;
  if (m.t > tail) {
    const p = Math.min(1, (m.dur - m.t) / m.release);
    return p * p * (3 - 2 * p);
  }
  return 1;
}

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  resize(width: number, height: number): void;
  update(dt: number, elapsed: number): void;
  /** `seat` is an engine seat index; null returns to the neutral pose. */
  focus(seat: number | null, intensity: number): void;
  shake(amount: number, ms: number): void;
  allIn(): void;
  showdown(): void;
  setTableSize(size: number): void;
  setHeroSeat(seat: number): void;
  /** Requests DeviceOrientation permission. Must run inside a user gesture. */
  enableTilt(): Promise<boolean>;
  /** True when nothing but the imperceptible idle drift is moving. */
  settled(): boolean;
  dispose(): void;
}

const BASE_ELEVATION = 55 * DEG;
const BASE_FOV = 50;
const FIT_W = 1.94;
const FIT_H = 1.62;
const FIT_CENTER_Y = 0.06;

export function createCameraRig(): CameraRig {
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.12, 42);
  camera.name = 'stage-camera';

  const pivot = new THREE.Vector3(0, 0.02, -0.04);
  const basePivot = pivot.clone();
  let baseDistance = 4.8;

  const sAzimuth = new Spring(0, 5.0, 0.86);
  const sElevation = new Spring(BASE_ELEVATION, 5.0, 0.9);
  const sDistance = new Spring(baseDistance, 4.4, 0.92);
  const sPivotX = new Spring(pivot.x, 5.6, 0.95);
  const sPivotY = new Spring(pivot.y, 5.6, 0.95);
  const sPivotZ = new Spring(pivot.z, 5.6, 0.95);
  const sFov = new Spring(BASE_FOV, 4.6, 0.95);
  const sRoll = new Spring(0, 6.2, 0.8);

  let tableSize = 9;
  let heroSeat = 0;
  let focusSlot: number | null = null;
  let focusIntensity = 0;

  const moves: Move[] = [];

  let shakeAmp = 0;
  let shakeT = 0;
  let shakeDur = 0;

  let tiltTargetAz = 0;
  let tiltTargetEl = 0;
  let tiltAz = 0;
  let tiltEl = 0;
  let tiltBase: { beta: number; gamma: number } | null = null;
  let tiltBound = false;

  const framePoints: THREE.Vector3[] = [];
  {
    const { RAIL_OUT_X: rx, RAIL_OUT_Z: rz, RAIL_H: rh } = layout;
    framePoints.push(new THREE.Vector3(0, 0, rz));
    framePoints.push(new THREE.Vector3(0, rh, -rz));
    framePoints.push(new THREE.Vector3(rx, rh, 0));
    framePoints.push(new THREE.Vector3(-rx, rh, 0));
    framePoints.push(new THREE.Vector3(rx * 0.72, rh, rz * 0.72));
    framePoints.push(new THREE.Vector3(-rx * 0.72, rh, rz * 0.72));
    framePoints.push(new THREE.Vector3(rx * 0.72, rh, -rz * 0.72));
    framePoints.push(new THREE.Vector3(-rx * 0.72, rh, -rz * 0.72));
  }

  const tmpV = new THREE.Vector3();
  const camUp = new THREE.Vector3();

  function placeCamera(dist: number, az: number, el: number, target: THREE.Vector3): void {
    const ce = Math.cos(el);
    camera.position.set(
      target.x + dist * Math.sin(az) * ce,
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(az) * ce,
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
  }

  /**
   * Solves distance and pivot height so the table silhouette occupies the
   * same fraction of every phone. Six fixed-point iterations converge to
   * well under a pixel — cheaper and far more predictable than a bounding
   * sphere fit, which would frame the invisible pedestal too.
   */
  function solveFraming(aspect: number): void {
    camera.aspect = aspect;
    camera.fov = BASE_FOV;
    let dist = baseDistance;
    const target = basePivot.clone();
    for (let iter = 0; iter < 6; iter++) {
      placeCamera(dist, 0, BASE_ELEVATION, target);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of framePoints) {
        tmpV.copy(p).project(camera);
        minX = Math.min(minX, tmpV.x);
        maxX = Math.max(maxX, tmpV.x);
        minY = Math.min(minY, tmpV.y);
        maxY = Math.max(maxY, tmpV.y);
      }
      const need = Math.max((maxX - minX) / FIT_W, (maxY - minY) / FIT_H);
      dist *= 1 + (need - 1) * 0.92;
      dist = THREE.MathUtils.clamp(dist, 2.4, 14);

      // recentre vertically by sliding the pivot along the camera's own up
      const centerY = (minY + maxY) * 0.5;
      const frustumH = 2 * dist * Math.tan((camera.fov * DEG) / 2);
      camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      target.addScaledVector(camUp, ((centerY - FIT_CENTER_Y) * frustumH) / 2);
      target.x = basePivot.x;
    }
    baseDistance = dist;
    basePivot.copy(target);
    sDistance.target = dist;
    sPivotX.target = target.x;
    sPivotY.target = target.y;
    sPivotZ.target = target.z;
  }

  function focusTarget(): { x: number; z: number } | null {
    if (focusSlot === null) return null;
    const seat = layout.seat(tableSize, focusSlot);
    return { x: seat.cards[1].x, z: seat.cards[1].z };
  }

  function applyTargets(): void {
    let az = 0;
    let el = BASE_ELEVATION;
    let dist = baseDistance;
    let fov = BASE_FOV;
    const px = basePivot.x;
    let py = basePivot.y;
    let pz = basePivot.z;

    const ft = focusTarget();
    if (ft) {
      const k = THREE.MathUtils.clamp(focusIntensity, 0, 1);
      pz += (ft.z - basePivot.z) * 0.26 * k;
      py += 0.02 * k;
      az += THREE.MathUtils.clamp(ft.x * 0.09, -0.07, 0.07) * k;
      dist *= 1 - 0.075 * k;
      el -= 0.035 * k;
    }

    for (const m of moves) {
      const w = envelope(m);
      if (m.kind === 'allin') {
        dist *= 1 - 0.17 * w;
        el -= 0.1 * w;
        fov -= 3.2 * w;
        py += 0.03 * w;
      } else {
        const p = THREE.MathUtils.clamp(m.t / m.dur, 0, 1);
        const s = p * p * (3 - 2 * p);
        az += (s - 0.5) * 0.2 * w;
        el += Math.sin(p * Math.PI) * 0.05 * w;
        dist *= 1 - 0.06 * w;
      }
    }

    sAzimuth.target = az;
    sElevation.target = el;
    sDistance.target = dist;
    sFov.target = fov;
    sPivotX.target = px;
    sPivotY.target = py;
    sPivotZ.target = pz;
  }

  // ── device tilt ─────────────────────────────────────────────────────
  function onOrientation(e: DeviceOrientationEvent): void {
    if (e.beta === null || e.gamma === null) return;
    if (!tiltBase) tiltBase = { beta: e.beta, gamma: e.gamma };
    const dg = THREE.MathUtils.clamp((e.gamma - tiltBase.gamma) / 22, -1, 1);
    const db = THREE.MathUtils.clamp((e.beta - tiltBase.beta) / 22, -1, 1);
    tiltTargetAz = dg * 0.046;
    tiltTargetEl = -db * 0.028;
    // slow drift of the neutral pose, so putting the phone down re-centres
    tiltBase.beta += (e.beta - tiltBase.beta) * 0.004;
    tiltBase.gamma += (e.gamma - tiltBase.gamma) * 0.004;
  }

  async function enableTilt(): Promise<boolean> {
    if (tiltBound) return true;
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    const ctor = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    try {
      if (typeof ctor.requestPermission === 'function') {
        const res = await ctor.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch {
      return false;
    }
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    tiltBound = true;
    return true;
  }

  // ── bus wiring ──────────────────────────────────────────────────────
  const offFocus = bus.on('cam:focus', ({ seat, intensity }) => {
    if (seat === null) {
      focusSlot = null;
      focusIntensity = 0;
    } else {
      focusSlot = layout.slotFor(seat, heroSeat, tableSize);
      focusIntensity = intensity;
    }
  });
  const offShake = bus.on('cam:shake', ({ amount, ms }) => {
    shakeAmp = Math.min(0.03, Math.max(shakeAmp, 0.004 + amount * 0.02));
    shakeDur = Math.max(0.08, ms / 1000);
    shakeT = 0;
  });
  const offBurst = bus.on('fx:burst', ({ kind }) => {
    if (kind === 'allin' || kind === 'bomb') pushMove('allin');
  });
  const offShowdown = bus.on('hand:showdown', () => pushMove('showdown'));

  function pushMove(kind: MoveKind): void {
    for (let i = moves.length - 1; i >= 0; i--) if (moves[i].kind === kind) moves.splice(i, 1);
    moves.push(
      kind === 'allin'
        ? { kind, t: 0, dur: 1.95, attack: 0.26, release: 0.8 }
        : { kind, t: 0, dur: 2.9, attack: 0.55, release: 0.95 },
    );
  }

  const shakeOffset = new THREE.Vector3();
  const right = new THREE.Vector3();
  const upVec = new THREE.Vector3();

  return {
    camera,

    resize(width: number, height: number) {
      const aspect = Math.max(0.3, width / Math.max(1, height));
      solveFraming(aspect);
      sAzimuth.set(0);
      sElevation.set(BASE_ELEVATION);
      sDistance.set(baseDistance);
      sPivotX.set(basePivot.x);
      sPivotY.set(basePivot.y);
      sPivotZ.set(basePivot.z);
      sFov.set(BASE_FOV);
      camera.aspect = aspect;
      camera.fov = BASE_FOV;
      camera.updateProjectionMatrix();
    },

    update(dt: number, elapsed: number) {
      for (let i = moves.length - 1; i >= 0; i--) {
        moves[i].t += dt;
        if (moves[i].t >= moves[i].dur) moves.splice(i, 1);
      }
      applyTargets();

      sAzimuth.step(dt);
      sElevation.step(dt);
      sDistance.step(dt);
      sPivotX.step(dt);
      sPivotY.step(dt);
      sPivotZ.step(dt);
      sFov.step(dt);
      sRoll.step(dt);

      // idle parallax: two incommensurate sines, under a degree of travel
      const driftAz = 0.0105 * Math.sin(elapsed * 0.113) + 0.0052 * Math.sin(elapsed * 0.291 + 1.3);
      const driftEl = 0.0068 * Math.sin(elapsed * 0.083 + 2.2);

      const k = Math.min(1, dt * 3.2);
      tiltAz += (tiltTargetAz - tiltAz) * k;
      tiltEl += (tiltTargetEl - tiltEl) * k;

      pivot.set(sPivotX.value, sPivotY.value, sPivotZ.value);
      placeCamera(
        sDistance.value,
        sAzimuth.value + driftAz + tiltAz,
        THREE.MathUtils.clamp(sElevation.value + driftEl + tiltEl, 0.28, 1.36),
        pivot,
      );

      if (shakeAmp > 0.0002) {
        shakeT += dt;
        const p = Math.min(1, shakeT / shakeDur);
        const decay = (1 - p) * (1 - p);
        const f = elapsed * 47;
        const nx = Math.sin(f) * 0.6 + Math.sin(f * 2.37 + 1.1) * 0.4;
        const ny = Math.sin(f * 1.71 + 2.4) * 0.6 + Math.sin(f * 3.11) * 0.4;
        right.setFromMatrixColumn(camera.matrixWorld, 0);
        upVec.setFromMatrixColumn(camera.matrixWorld, 1);
        shakeOffset
          .copy(right)
          .multiplyScalar(nx * shakeAmp * decay)
          .addScaledVector(upVec, ny * shakeAmp * decay * 0.8);
        camera.position.add(shakeOffset);
        sRoll.target = nx * 0.006 * decay;
        if (p >= 1) {
          shakeAmp = 0;
          sRoll.target = 0;
        }
      }

      if (Math.abs(sRoll.value) > 1e-5) camera.rotateZ(sRoll.value);

      const fov = sFov.value;
      if (Math.abs(camera.fov - fov) > 1e-3) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.updateMatrixWorld();
    },

    focus(seat, intensity) {
      if (seat === null) {
        focusSlot = null;
        focusIntensity = 0;
        return;
      }
      focusSlot = layout.slotFor(seat, heroSeat, tableSize);
      focusIntensity = intensity;
    },

    shake(amount, ms) {
      shakeAmp = Math.min(0.03, Math.max(shakeAmp, 0.004 + amount * 0.02));
      shakeDur = Math.max(0.08, ms / 1000);
      shakeT = 0;
    },

    allIn() {
      pushMove('allin');
    },

    showdown() {
      pushMove('showdown');
    },

    setTableSize(size) {
      tableSize = Math.max(2, Math.min(9, Math.round(size)));
    },

    setHeroSeat(seat) {
      heroSeat = seat;
    },

    enableTilt,

    settled() {
      return (
        moves.length === 0 &&
        shakeAmp <= 0.0002 &&
        sAzimuth.settled &&
        sElevation.settled &&
        sDistance.settled &&
        sPivotX.settled &&
        sPivotY.settled &&
        sPivotZ.settled &&
        sFov.settled
      );
    },

    dispose() {
      offFocus();
      offShake();
      offBurst();
      offShowdown();
      if (tiltBound) window.removeEventListener('deviceorientation', onOrientation);
    },
  };
}
