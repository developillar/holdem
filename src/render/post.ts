/**
 * Hand-rolled post chain.
 *
 * Six fullscreen draws, five of them below native resolution:
 *
 *   scene → [bright ½] → [blurH ½] → [blurV ½] ─┐
 *                                    └→ [down ¼] → [blurV ¼] ─┐
 *   scene ────────────────────────────────────────────────────┴→ composite
 *
 * three.js turns its own tone mapping off when a material renders into a
 * render target, so the scene arrives here as linear HDR — which is exactly
 * where bloom, the vignette and the aberration belong. The composite applies
 * ACES and the sRGB transfer at the very end, then lays grain and an ordered
 * dither over the display-referred result.
 *
 * Every pass is disabled wholesale on the `low` tier: we render straight to
 * the default framebuffer and let three tone map, which is bit-comparable.
 */
import * as THREE from 'three';
import { blurFragment, brightPassFragment, downsampleFragment, fullscreenVertex } from '../shaders/bloom.ts';
import { compositeFragment } from '../shaders/composite.ts';
import type { PerfTier } from './renderer.ts';

export interface PostChain {
  readonly enabled: boolean;
  setSize(width: number, height: number, pixelRatio: number): void;
  setQuality(tier: PerfTier): void;
  render(scene: THREE.Scene, camera: THREE.Camera, elapsed: number): void;
  /** Exposure is owned here when post is on, by three when it is off. */
  setExposure(v: number): void;
  dispose(): void;
}

function makeTarget(w: number, h: number, type: THREE.TextureDataType, samples: number, depth: boolean) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
    samples,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

export function createPost(renderer: THREE.WebGLRenderer): PostChain {
  // A single fullscreen triangle beats a quad: no diagonal seam, no
  // duplicated fragment work along it.
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const placeholder = new THREE.MeshBasicMaterial();
  const quad: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(tri, placeholder);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const gl = renderer.getContext();
  const halfFloatOk =
    !!gl.getExtension('EXT_color_buffer_half_float') || !!gl.getExtension('EXT_color_buffer_float');
  const hdrType: THREE.TextureDataType = halfFloatOk ? THREE.HalfFloatType : THREE.UnsignedByteType;

  const brightMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.3 },
      uKnee: { value: 0.5 },
      uWarmBias: { value: 0.45 },
    },
    vertexShader: fullscreenVertex,
    fragmentShader: brightPassFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uDirection: { value: new THREE.Vector2() } },
    vertexShader: fullscreenVertex,
    fragmentShader: blurFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  const downMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: fullscreenVertex,
    fragmentShader: downsampleFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  const compositeMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null },
      tBloomNear: { value: null },
      tBloomWide: { value: null },
      uExposure: { value: 1.12 },
      uBloomNear: { value: 0.5 },
      uBloomWide: { value: 0.38 },
      // in UV units at the frame corner this is ≈1.6 px on a 3x phone —
      // felt at the edges, invisible on the cards in the centre
      uAberration: { value: 0.0055 },
      uVignette: { value: 0.72 },
      uVignetteSoft: { value: 0.34 },
      uGrain: { value: 0.017 },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uVigScale: { value: new THREE.Vector2(1, 1) },
      uLift: { value: new THREE.Color(0.006, 0.008, 0.014) },
      uSaturation: { value: 1.08 },
    },
    vertexShader: fullscreenVertex,
    fragmentShader: compositeFragment,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  let tier: PerfTier = 'high';
  let enabled = true;
  let width = 1;
  let height = 1;
  let dpr = 1;
  let exposure = 1.12;

  let sceneRT: THREE.WebGLRenderTarget | null = null;
  let halfA: THREE.WebGLRenderTarget | null = null;
  let halfB: THREE.WebGLRenderTarget | null = null;
  let quarterA: THREE.WebGLRenderTarget | null = null;
  let quarterB: THREE.WebGLRenderTarget | null = null;

  function releaseTargets(): void {
    sceneRT?.dispose();
    halfA?.dispose();
    halfB?.dispose();
    quarterA?.dispose();
    quarterB?.dispose();
    sceneRT = halfA = halfB = quarterA = quarterB = null;
  }

  function buildTargets(): void {
    releaseTargets();
    if (!enabled) return;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    const samples = tier === 'high' ? 4 : 0;
    sceneRT = makeTarget(w, h, hdrType, samples, true);
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    halfA = makeTarget(hw, hh, hdrType, 0, false);
    halfB = makeTarget(hw, hh, hdrType, 0, false);
    if (tier === 'high') {
      const qw = Math.max(1, w >> 2);
      const qh = Math.max(1, h >> 2);
      quarterA = makeTarget(qw, qh, hdrType, 0, false);
      quarterB = makeTarget(qw, qh, hdrType, 0, false);
    }
    compositeMat.uniforms.uResolution.value.set(w, h);
    const long = Math.max(w, h);
    compositeMat.uniforms.uVigScale.value.set(w / long, h / long);
  }

  function pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCamera);
  }

  return {
    get enabled() {
      return enabled;
    },

    setSize(w, h, pixelRatio) {
      width = w;
      height = h;
      dpr = pixelRatio;
      buildTargets();
    },

    setQuality(next) {
      if (next === tier) return;
      tier = next;
      enabled = next !== 'low';
      // The look holds across tiers; only the expensive halves drop out.
      compositeMat.uniforms.uBloomWide.value = next === 'high' ? 0.38 : 0;
      compositeMat.uniforms.uBloomNear.value = next === 'high' ? 0.5 : 0.44;
      compositeMat.uniforms.uAberration.value = next === 'high' ? 0.0055 : 0.003;
      compositeMat.uniforms.uGrain.value = next === 'high' ? 0.017 : 0.012;
      buildTargets();
    },

    setExposure(v) {
      exposure = v;
      compositeMat.uniforms.uExposure.value = v;
      renderer.toneMappingExposure = v;
    },

    render(scene, camera, elapsed) {
      if (!enabled || !sceneRT || !halfA || !halfB) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }

      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);

      const hw = halfA.width;
      const hh = halfA.height;

      brightMat.uniforms.tScene.value = sceneRT.texture;
      brightMat.uniforms.uTexel.value.set(1 / sceneRT.width, 1 / sceneRT.height);
      pass(brightMat, halfA);

      blurMat.uniforms.tSrc.value = halfA.texture;
      blurMat.uniforms.uDirection.value.set(1 / hw, 0);
      pass(blurMat, halfB);

      blurMat.uniforms.tSrc.value = halfB.texture;
      blurMat.uniforms.uDirection.value.set(0, 1 / hh);
      pass(blurMat, halfA);

      if (quarterA && quarterB) {
        downMat.uniforms.tSrc.value = halfA.texture;
        downMat.uniforms.uTexel.value.set(1.5 / hw, 1.5 / hh);
        pass(downMat, quarterB);

        blurMat.uniforms.tSrc.value = quarterB.texture;
        blurMat.uniforms.uDirection.value.set(0, 1 / quarterB.height);
        pass(blurMat, quarterA);

        compositeMat.uniforms.tBloomWide.value = quarterA.texture;
      } else {
        compositeMat.uniforms.tBloomWide.value = halfA.texture;
      }

      compositeMat.uniforms.tScene.value = sceneRT.texture;
      compositeMat.uniforms.tBloomNear.value = halfA.texture;
      compositeMat.uniforms.uTime.value = elapsed;
      compositeMat.uniforms.uExposure.value = exposure;
      pass(compositeMat, null);
    },

    dispose() {
      releaseTargets();
      tri.dispose();
      brightMat.dispose();
      blurMat.dispose();
      downMat.dispose();
      compositeMat.dispose();
      placeholder.dispose();
    },
  };
}
