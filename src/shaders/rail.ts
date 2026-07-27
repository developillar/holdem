/**
 * Padded rail shader.
 *
 * The rail is the single closest object to the camera in the portrait crop,
 * so every detail here is analytic rather than baked: the saddle stitching,
 * the seam channel it sits in, the pebbled grain, and the polished crest
 * where forearms have worn the leather smooth. Injected into
 * MeshPhysicalMaterial (clearcoat on) so it keeps IBL and shadows.
 *
 * UV convention supplied by table.ts:
 *   uv.x — 0..1 once around the oval (times `uGrainRepeat` for the grain)
 *   uv.y — 0 at the inner lip, 1 at the outer skirt, 0.5 at the crest
 */
import { noiseLib } from './noise.ts';

export const railParsVertex = /* glsl */ `
varying vec2 vRailUv;
varying float vRailArc;
`;

export const railVertex = /* glsl */ `
  vRailUv = uv;
  vRailArc = uv.x;
`;

export const railParsFragment = /* glsl */ `
varying vec2 vRailUv;
varying float vRailArc;

uniform float uGrainScale;
uniform float uGrainDepth;
uniform float uCreaseDepth;
uniform vec3  uSeamColor;
uniform vec3  uThreadColor;
uniform vec3  uCrestTint;
uniform vec4  uStitch;        // rowV, stitchesAround, threadHalfWidth, seamHalfWidth
uniform float uStitchOn;
uniform float uPolish;
uniform float uRailWear;
uniform float uArcAspect;     // world units of perimeter per uv.x unit

${noiseLib}

/**
 * Macro leather grain — the swells and hollows, not the pores. Pores come
 * from the tiled normal map, which gets mipmapped for free; anything this
 * shader evaluates analytically must stay well above one cycle per pixel.
 */
float railGrain(vec2 p) {
  float coarse = rValueNoise(p);
  float pebble = rRidge(p * 2.1, 2);
  return coarse * 0.55 + pebble * 0.45;
}

/**
 * Saddle-stitch height for one row. Returns the bump height and writes the
 * thread mask so the colour pass can tint the cotton.
 */
float railStitchRow(vec2 uv, float rowV, float count, float threadHW, float seamHW, float phase, float lod, out float threadMask) {
  float du = uv.x * count + phase;
  float cell = floor(du);
  float t = fract(du);
  float jitter = (rHash11(cell) - 0.5) * 0.10;
  float lean = (t - 0.5) * 0.05 * (1.0 + jitter);
  float v = uv.y - rowV - lean;

  // seam channel: leather pulled down along the whole row
  float seam = -exp(-(v * v) / (seamHW * seamHW));

  // thread: a rounded cotton cylinder covering ~70% of each cell. As the
  // cells shrink below a pixel the dashes dissolve into a continuous cord
  // rather than into noise.
  float along = mix(1.0, smoothstep(0.05, 0.22, t) * (1.0 - smoothstep(0.78, 0.95, t)), lod);
  float across = exp(-(v * v) / (threadHW * threadHW));
  float thread = along * across;

  threadMask = thread;
  return seam * 0.85 + thread * 1.35;
}

float railStitchHeight(vec2 uv, float lod, out float threadMask) {
  float m0 = 0.0;
  float m1 = 0.0;
  float h = railStitchRow(uv, uStitch.x, uStitch.y, uStitch.z, uStitch.w, 0.0, lod, m0);
  h += railStitchRow(uv, 1.0 - uStitch.x, uStitch.y, uStitch.z, uStitch.w, 0.5, lod, m1);
  threadMask = max(m0, m1);
  return h;
}
`;

/** After `<map_fragment>` — owns diffuseColor. */
export const railColorFragment = /* glsl */ `
  vec2 railGP = vec2(vRailUv.x * uArcAspect, vRailUv.y) * uGrainScale;
  float railLod = 1.0 - rSat(length(fwidth(railGP)) * 0.5);
  float railStitchLod = 1.0 - rSat(fwidth(vRailUv.x) * uStitch.y * 4.5);
  float grain = 0.5 + (railGrain(railGP) - 0.5) * railLod;
  float creases = rRidge(vec2(vRailUv.x * uArcAspect * 0.32, vRailUv.y * 1.2) + 13.0, 2) * railLod;

  vec3 leather = diffuseColor.rgb;
  leather *= 0.84 + grain * 0.32;
  leather *= 1.0 - creases * uCreaseDepth * 0.3;

  // crest polish: the top of the roll is buffed by ten thousand forearms
  float crest = 1.0 - smoothstep(0.0, 0.34, abs(vRailUv.y - 0.5));
  leather = mix(leather, leather * 1.45 + uCrestTint * 0.055, crest * uPolish);

  // inner lip catches the felt bounce, outer skirt falls into shadow
  leather *= 1.0 + (1.0 - smoothstep(0.0, 0.2, vRailUv.y)) * 0.22;
  leather *= 1.0 - smoothstep(0.72, 1.0, vRailUv.y) * 0.5;

  // wear patches — uneven, low frequency, never symmetrical
  float wearPatch = rFbm(vec2(vRailUv.x * uArcAspect * 0.22, vRailUv.y * 0.7) + 61.0, 3);
  leather *= 1.0 + (wearPatch - 0.5) * uRailWear;

  float railThread = 0.0;
  if (uStitchOn > 0.5) {
    float sh = railStitchHeight(vRailUv, railStitchLod, railThread);
    leather = mix(leather, uSeamColor, rSat(-sh) * 0.65);
    leather = mix(leather, uThreadColor * (0.9 + grain * 0.2), rSat(railThread * 1.1) * 0.9);
  }

  diffuseColor.rgb = max(leather, vec3(0.0));
`;

/** After `<roughnessmap_fragment>`. */
export const railRoughnessFragment = /* glsl */ `
  float railCrestR = 1.0 - smoothstep(0.0, 0.34, abs(vRailUv.y - 0.5));
  float railR = roughnessFactor * (0.9 + grain * 0.22);
  railR = mix(railR, railR * 0.52, railCrestR * uPolish);
  railR = mix(railR, 0.88, rSat(railThread * 1.4));   // cotton is matte
  roughnessFactor = clamp(railR, 0.05, 1.0);
`;

/** After `<normal_fragment_maps>` — analytic grain + stitch bump. */
export const railNormalFragment = /* glsl */ `
  {
    float h = grain * uGrainDepth - creases * uCreaseDepth;
    if (uStitchOn > 0.5) {
      float tm;
      // the stitch bump has to fade on its *own* screen density, not the
      // grain's, or the thread turns into crawling speckle at table framing
      h += railStitchHeight(vRailUv, railStitchLod, tm) * 0.3 * railStitchLod;
    }
    normal = rPerturbNormal(normal, -vViewPosition, h, 0.007 * railLod);
  }
`;
