/**
 * Scene assembly: backdrop, environment map, table, lights.
 *
 * The environment is built at boot from a tiny procedural "room" — a dark
 * shell, a warm overhead softbox and two cool side walls — pushed through
 * PMREMGenerator. That single cube map is what makes the gold trim, the
 * chip edges and the card varnish look like objects in a place rather than
 * like shaded triangles. No HDRI is downloaded, and the whole thing costs
 * about 3 ms once.
 */
import * as THREE from 'three';
import { backdropFragment, backdropVertex, roomPanelFragment, roomPanelVertex } from '../shaders/env.ts';
import { createLighting, type LightRig } from './lighting.ts';
import { createTable, type TableHandle, type TableSkin } from './table.ts';
import type { PerfTier } from './renderer.ts';

export interface StageScene {
  scene: THREE.Scene;
  /** Cards, chips and any gameplay props attach here. */
  root: THREE.Group;
  table: TableHandle;
  lights: LightRig;
  envMap: THREE.Texture;
  update(elapsed: number): void;
  setQuality(tier: PerfTier): void;
  setSkin(skin: Partial<TableSkin>): void;
  dispose(): void;
}

/**
 * The reflection room. Values above 1.0 are intentional: PMREM renders into
 * a half-float target, so these behave as real HDR emitters and give metals
 * a highlight with a shoulder instead of a flat white blob.
 */
function buildRoom(): { scene: THREE.Scene; dispose(): void } {
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose(): void }> = [];

  const shellGeo = new THREE.BoxGeometry(9, 5.4, 9);
  const shellMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#0a0e16'),
    side: THREE.BackSide,
    toneMapped: false,
  });
  scene.add(new THREE.Mesh(shellGeo, shellMat));
  disposables.push(shellGeo, shellMat);

  // warm overhead softbox, directly above the table
  const panelGeo = new THREE.PlaneGeometry(2.6, 3.8);
  const panelMat = new THREE.ShaderMaterial({
    uniforms: {
      uColorA: { value: new THREE.Color('#fff0d6').multiplyScalar(3.0) },
      uColorB: { value: new THREE.Color('#c9873c').multiplyScalar(0.9) },
      uFalloff: { value: 1.5 },
    },
    vertexShader: roomPanelVertex,
    fragmentShader: roomPanelFragment,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const panel = new THREE.Mesh(panelGeo, panelMat);
  panel.position.set(0, 2.45, -0.1);
  panel.rotation.x = Math.PI / 2;
  scene.add(panel);
  disposables.push(panelGeo, panelMat);

  // cool side walls: the rim light's reflected source
  const wallGeo = new THREE.PlaneGeometry(6.4, 3.2);
  const wallMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#2b3d63').multiplyScalar(0.55),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(sx * 3.1, 0.9, 0);
    wall.rotation.y = sx * -Math.PI * 0.5;
    scene.add(wall);
  }
  disposables.push(wallGeo, wallMat);

  // a low amber wash behind the far rail — the "room beyond the table"
  const washGeo = new THREE.PlaneGeometry(7.4, 1.9);
  const washMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#7a4a1c').multiplyScalar(0.6),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const wash = new THREE.Mesh(washGeo, washMat);
  wash.position.set(0, 0.2, -3.4);
  scene.add(wash);
  disposables.push(washGeo, washMat);

  const floorGeo = new THREE.PlaneGeometry(9, 9);
  const floorMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#05070c'),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.y = -1.6;
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  disposables.push(floorGeo, floorMat);

  return {
    scene,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

export function createScene(renderer: THREE.WebGLRenderer): StageScene {
  const scene = new THREE.Scene();
  scene.name = 'royale-stage';

  // ── environment ────────────────────────────────────────────────────
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const room = buildRoom();
  const envRT = pmrem.fromScene(room.scene, 0.035, 0.1, 30);
  const envMap = envRT.texture;
  room.dispose();
  pmrem.dispose();

  scene.environment = envMap;
  scene.environmentIntensity = 0.9;
  scene.background = null;

  // Exponential fog does the depth separation the vignette cannot: the far
  // rail sits back, the near rail comes forward, with no visible plane.
  scene.fog = new THREE.FogExp2(0x060911, 0.05);

  // ── backdrop dome ──────────────────────────────────────────────────
  const backdropUniforms = {
    uTop: { value: new THREE.Color('#0a0f1c') },
    uHorizon: { value: new THREE.Color('#05070e') },
    uBottom: { value: new THREE.Color('#020307') },
    uGlow: { value: new THREE.Color('#1d2843') },
    uGlowStrength: { value: 0.3 },
    uTime: { value: 0 },
  };
  const backdropGeo = new THREE.SphereGeometry(19, 40, 24);
  const backdropMat = new THREE.ShaderMaterial({
    uniforms: backdropUniforms,
    vertexShader: backdropVertex,
    fragmentShader: backdropFragment,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    fog: false,
  });
  const backdrop = new THREE.Mesh(backdropGeo, backdropMat);
  backdrop.name = 'backdrop';
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1000;
  scene.add(backdrop);

  // ── table + lights ─────────────────────────────────────────────────
  const table = createTable(null);
  scene.add(table.group);

  const lights = createLighting();
  scene.add(lights.group);
  table.setLightPool(lights.pool.x, lights.pool.z, lights.pool.inner, lights.pool.outer, lights.pool.strength);

  const root = new THREE.Group();
  root.name = 'play';
  scene.add(root);

  return {
    scene,
    root,
    table,
    lights,
    envMap,

    update(elapsed: number) {
      lights.update(elapsed);
      table.setLightPool(
        lights.key.position.x * 0.35,
        lights.key.position.z * 0.35 - 0.05,
        lights.pool.inner,
        lights.pool.outer,
        lights.pool.strength,
      );
      table.update(elapsed);
      backdropUniforms.uTime.value = elapsed;
    },

    setQuality(tier: PerfTier) {
      lights.setQuality(tier);
      table.setQuality(tier);
      scene.environmentIntensity = tier === 'low' ? 0.7 : 0.9;
      if (scene.fog instanceof THREE.FogExp2) scene.fog.density = tier === 'low' ? 0.042 : 0.05;
    },

    setSkin(skin: Partial<TableSkin>) {
      table.setSkin(skin);
      if (skin.betLineColor) lights.setAccent(skin.betLineColor, 0.16);
    },

    dispose() {
      table.dispose();
      lights.dispose();
      backdropGeo.dispose();
      backdropMat.dispose();
      envRT.dispose();
      scene.clear();
    },
  };
}
