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

/** Pebbled leather grain height. Two scales of cellular-ish noise. */
float railGrain(vec2 p) {
  float coarse = rValueNoise(p * 1.0);
  float pebble = rRidge(p * 2.6, 3);
  float fine = rValueNoise(p * 9.0);
  return coarse * 0.35 + pebble * 0.45 + fine * 0.20;
}

/**
 * Saddle-stitch height for one row. Returns the bump height and writes the
 * thread mask so the colour pass can tint the cotton.
 */
float railStitchRow(vec2 uv, float rowV, float count, float threadHW, float seamHW, float phase, out float threadMask) {
  float du = uv.x * count + phase;
  float cell = floor(du);
  float t = fract(du);
  float jitter = (rHash11(cell) - 0.5) * 0.10;
  float lean = (t - 0.5) * 0.055 * (1.0 + jitter);
  float v = uv.y - rowV - lean;

  // seam channel: leather pulled down along the whole row
  float seam = exp(-(v * v) / (seamHW * seamHW)) * -1.0;

  // thread: rounded cotton cylinder covering ~66% of each cell
  float along = smoothstep(0.06, 0.20, t) * (1.0 - smoothstep(0.80, 0.94, t));
  float across = exp(-(v * v) / (threadHW * threadHW));
  float thread = along * across;
  // the twist of the cotton
  thread *= 0.86 + 0.14 * sin(du * 26.0);

  threadMask = thread;
  return seam * 0.85 + thread * 1.45;
}

float railStitchHeight(vec2 uv, out float threadMask) {
  float m0 = 0.0;
  float m1 = 0.0;
  float h = railStitchRow(uv, uStitch.x, uStitch.y, uStitch.z, uStitch.w, 0.0, m0);
  h += railStitchRow(uv, 1.0 - uStitch.x, uStitch.y, uStitch.z, uStitch.w, 0.5, m1);
  threadMask = max(m0, m1);
  return h;
}
`;

/** After `<map_fragment>` — owns diffuseColor. */
export const railColorFragment = /* glsl */ `
  vec2 gp = vec2(vRailUv.x * uArcAspect, vRailUv.y) * uGrainScale;
  float grain = railGrain(gp);
  float creases = rRidge(vec2(vRailUv.x * uArcAspect * 0.55, vRailUv.y * 1.8) + 13.0, 3);

  vec3 leather = diffuseColor.rgb;
  leather *= 0.82 + grain * 0.36;
  leather *= 1.0 - creases * uCreaseDepth * 0.30;

  // crest polish: the top of the roll is buffed by ten thousand forearms
  float crest = 1.0 - smoothstep(0.0, 0.34, abs(vRailUv.y - 0.5));
  leather = mix(leather, leather * 1.22 + uCrestTint * 0.06, crest * uPolish);

  // inner lip catches the felt bounce, outer skirt falls into shadow
  leather *= 1.0 + (1.0 - smoothstep(0.0, 0.22, vRailUv.y)) * 0.16;
  leather *= 1.0 - smoothstep(0.74, 1.0, vRailUv.y) * 0.45;

  // wear patches — uneven, low frequency, never symmetrical
  float patch = rFbm(vec2(vRailUv.x * uArcAspect * 0.42, vRailUv.y * 0.9) + 61.0, 4);
  leather *= 1.0 + (patch - 0.5) * uRailWear;

  if (uStitchOn > 0.5) {
    float threadMask;
    float sh = railStitchHeight(vRailUv, threadMask);
    float seamDark = rSat(-sh) * 1.0;
    leather = mix(leather, uSeamColor, seamDark * 0.7);
    leather = mix(leather, uThreadColor * (0.86 + grain * 0.28), rSat(threadMask * 1.25));
  }

  diffuseColor.rgb = max(leather, vec3(0.0));
`;

/** After `<roughnessmap_fragment>`. */
export const railRoughnessFragment = /* glsl */ `
  vec2 gpR = vec2(vRailUv.x * uArcAspect, vRailUv.y) * uGrainScale;
  float grainR = railGrain(gpR);
  float crestR = 1.0 - smoothstep(0.0, 0.34, abs(vRailUv.y - 0.5));
  float r = roughnessFactor * (0.88 + grainR * 0.26);
  r = mix(r, r * 0.66, crestR * uPolish);
  if (uStitchOn > 0.5) {
    float tm;
    railStitchHeight(vRailUv, tm);
    r = mix(r, 0.86, rSat(tm * 1.4));   // cotton is matte
  }
  roughnessFactor = clamp(r, 0.05, 1.0);
`;

/** After `<normal_fragment_maps>` — analytic grain + stitch bump. */
export const railNormalFragment = /* glsl */ `
  {
    vec2 gpN = vec2(vRailUv.x * uArcAspect, vRailUv.y) * uGrainScale;
    float h = railGrain(gpN) * uGrainDepth;
    h -= rRidge(vec2(vRailUv.x * uArcAspect * 0.55, vRailUv.y * 1.8) + 13.0, 3) * uCreaseDepth;
    if (uStitchOn > 0.5) {
      float tm;
      h += railStitchHeight(vRailUv, tm) * 0.9;
    }
    float fade = 1.0 - rSat(length(fwidth(gpN)) * 0.6);
    normal = rPerturbNormal(normal, -vViewPosition, h, 0.010 * fade);
  }
`;
