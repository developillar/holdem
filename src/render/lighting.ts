/**
 * Cinematic three-point rig for the table.
 *
 *   key   — warm tungsten spot hanging over the felt, the only shadow caster.
 *           Its cone is drawn as a faint additive shaft and its pool is fed
 *           to the felt shader so the falloff reads even at grazing angles.
 *   rim   — cool key-opposite directional that separates the rail from the
 *           black surround. No shadow, no cost.
 *   fill  — hemisphere, plus two low practicals that lift the near rail
 *           (warm, camera side) and the far rail (cool, room side).
 *
 * Everything breathes: intensity and position drift on incommensurate sine
 * periods so the scene never freezes into a still, but the amplitude is far
 * below the threshold where a player would consciously notice it.
 */
import * as THREE from 'three';
import { lightConeFragment, lightConeVertex } from '../shaders/env.ts';
import type { PerfTier } from './renderer.ts';

export interface LightPool {
  x: number;
  z: number;
  inner: number;
  outer: number;
  strength: number;
}

export interface LightRig {
  group: THREE.Group;
  key: THREE.SpotLight;
  rim: THREE.DirectionalLight;
  update(elapsed: number): void;
  setQuality(tier: PerfTier): void;
  /** Tints the key toward a table skin's accent. 0 = neutral tungsten. */
  setAccent(color: THREE.ColorRepresentation, amount: number): void;
  /** Momentary flare — used by the all-in and showdown moments. */
  pulse(amount: number, ms: number): void;
  pool: LightPool;
  dispose(): void;
}

const KEY_BASE = new THREE.Vector3(0.16, 2.14, 0.44);
const KEY_TARGET = new THREE.Vector3(0, 0, -0.05);
const KEY_INTENSITY = 30;
const POOL_RADIUS = 1.32;

export function createLighting(): LightRig {
  const group = new THREE.Group();
  group.name = 'lights';

  // ── key ────────────────────────────────────────────────────────────
  const key = new THREE.SpotLight(0xffd8ab, KEY_INTENSITY);
  key.position.copy(KEY_BASE);
  key.angle = Math.atan(POOL_RADIUS / KEY_BASE.y) * 1.06;
  key.penumbra = 0.72;
  key.decay = 2;
  key.distance = 9;
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1.05;
  key.shadow.camera.far = 4.4;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.022;
  key.shadow.radius = 3;
  key.shadow.focus = 1;
  key.target.position.copy(KEY_TARGET);
  group.add(key);
  group.add(key.target);

  // ── rim ────────────────────────────────────────────────────────────
  const rim = new THREE.DirectionalLight(0x8fb6ff, 0.62);
  rim.position.set(-2.35, 1.55, -2.7);
  rim.target.position.set(0, 0, 0.15);
  rim.castShadow = false;
  group.add(rim);
  group.add(rim.target);

  // ── fill ───────────────────────────────────────────────────────────
  const hemi = new THREE.HemisphereLight(0x1d2a45, 0x06090a, 0.55);
  hemi.position.set(0, 2, 0);
  group.add(hemi);

  // near practical: warm bounce off the player's side of the rail
  const nearGlow = new THREE.PointLight(0xffc98d, 0.4, 3.2, 2);
  nearGlow.position.set(0, 0.4, 1.62);
  group.add(nearGlow);

  // far practical: cool spill from the room behind the table
  const farGlow = new THREE.PointLight(0x7aa6e0, 0.34, 3.0, 2);
  farGlow.position.set(0, 0.36, -1.74);
  group.add(farGlow);

  // ── volumetric shaft ───────────────────────────────────────────────
  const shaftLen = KEY_BASE.distanceTo(KEY_TARGET);
  const coneGeo = new THREE.CylinderGeometry(0.075, POOL_RADIUS * 1.02, shaftLen, 40, 1, true);
  coneGeo.translate(0, shaftLen / 2, 0);
  const coneUniforms = {
    uColor: { value: new THREE.Color(0xffd2a0) },
    uIntensity: { value: 0.085 },
    uHeight: { value: shaftLen },
    uTime: { value: 0 },
  };
  const coneMat = new THREE.ShaderMaterial({
    uniforms: coneUniforms,
    vertexShader: lightConeVertex,
    fragmentShader: lightConeFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.name = 'key-shaft';
  cone.renderOrder = 3;
  cone.frustumCulled = false;
  group.add(cone);

  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  function placeCone(): void {
    cone.position.copy(KEY_TARGET);
    dir.copy(key.position).sub(KEY_TARGET).normalize();
    cone.quaternion.setFromUnitVectors(up, dir);
  }
  placeCone();

  const pool: LightPool = {
    x: KEY_TARGET.x,
    z: KEY_TARGET.z,
    inner: 0.55,
    outer: 1.85,
    strength: 0.3,
  };

  const baseKeyColor = new THREE.Color(0xffd8ab);
  const accentColor = new THREE.Color(0xffd8ab);
  let accentAmount = 0;
  let pulseAmount = 0;
  let pulseDecay = 0;
  let tier: PerfTier = 'high';

  const tmpColor = new THREE.Color();

  return {
    group,
    key,
    rim,
    pool,

    update(elapsed: number) {
      // ── breathing: three incommensurate periods so it never loops audibly
      const breath =
        1 +
        0.024 * Math.sin(elapsed * 0.31) +
        0.013 * Math.sin(elapsed * 0.727 + 1.7) +
        0.007 * Math.sin(elapsed * 1.63 + 0.4);

      if (pulseAmount > 0.0005) {
        pulseAmount *= Math.exp(-pulseDecay * 0.016);
        if (pulseAmount < 0.0005) pulseAmount = 0;
      }

      key.intensity = KEY_INTENSITY * breath * (1 + pulseAmount);
      key.position.set(
        KEY_BASE.x + 0.028 * Math.sin(elapsed * 0.171),
        KEY_BASE.y + 0.018 * Math.sin(elapsed * 0.113 + 2.1),
        KEY_BASE.z + 0.024 * Math.cos(elapsed * 0.137),
      );

      rim.intensity = 0.62 * (1 + 0.05 * Math.sin(elapsed * 0.21 + 3.1));
      nearGlow.intensity = 0.4 * (1 + 0.09 * Math.sin(elapsed * 0.43 + 1.1));

      tmpColor.copy(baseKeyColor).lerp(accentColor, accentAmount);
      key.color.copy(tmpColor);
      coneUniforms.uColor.value.copy(tmpColor);
      coneUniforms.uTime.value = elapsed;
      coneUniforms.uIntensity.value = (tier === 'high' ? 0.085 : 0.05) * (1 + pulseAmount * 1.6);

      if (tier !== 'low') placeCone();

      pool.strength = 0.3 + pulseAmount * 0.25;
    },

    setQuality(next: PerfTier) {
      tier = next;
      const low = next === 'low';
      key.castShadow = !low;
      key.shadow.mapSize.set(next === 'high' ? 1024 : 768, next === 'high' ? 1024 : 768);
      if (key.shadow.map) {
        key.shadow.map.dispose();
        key.shadow.map = null;
      }
      cone.visible = !low;
      rim.visible = true;
      nearGlow.visible = !low;
      farGlow.visible = next === 'high';
      hemi.intensity = low ? 0.78 : 0.55;
    },

    setAccent(color, amount) {
      accentColor.set(color);
      accentAmount = THREE.MathUtils.clamp(amount, 0, 1);
    },

    pulse(amount, ms) {
      pulseAmount = Math.max(pulseAmount, amount);
      pulseDecay = 1000 / Math.max(60, ms);
    },

    dispose() {
      coneGeo.dispose();
      coneMat.dispose();
      key.dispose();
      rim.dispose();
      hemi.dispose();
      nearGlow.dispose();
      farGlow.dispose();
      if (key.shadow.map) key.shadow.map.dispose();
    },
  };
}
