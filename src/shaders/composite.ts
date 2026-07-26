/**
 * Final composite: the only pass that writes to the default framebuffer.
 *
 * Order matters and is physically motivated — everything up to the tone map
 * happens in linear HDR (bloom add, vignette, aberration), then ACES maps to
 * display range, then grain and the ordered dither are applied in display
 * space where they belong. Getting this order wrong is what makes web 3D
 * look like web 3D.
 *
 * Note three.js disables its own tone mapping when rendering into a render
 * target, so the ACES fit here is the *only* tone map in the post path and
 * is bit-matched to three's ACESFilmicToneMapping for the low-tier fallback.
 */
import { hashChunk } from './noise.ts';

export const compositeFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tBloomNear;
uniform sampler2D tBloomWide;

uniform float uExposure;
uniform float uBloomNear;
uniform float uBloomWide;
uniform float uAberration;
uniform float uVignette;
uniform float uVignetteSoft;
uniform float uGrain;
uniform float uTime;
uniform vec2  uResolution;
uniform vec3  uLift;          // lifted-black tint, keeps OLED shadows from crushing
uniform float uSaturation;

${hashChunk}

const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  color *= uExposure / 0.6;
  color = ACES_IN * color;
  color = rrtOdtFit(color);
  color = ACES_OUT * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(0.41666667)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  vec2 fromCenter = uv - 0.5;
  float r2 = dot(fromCenter, fromCenter);

  // ── chromatic aberration: transverse only, quadratic in radius, so the
  //    centre of the screen (where the cards are) stays perfectly sharp.
  vec3 scene;
  if (uAberration > 0.0001) {
    vec2 off = fromCenter * r2 * uAberration;
    scene.r = texture2D(tScene, uv + off).r;
    scene.g = texture2D(tScene, uv).g;
    scene.b = texture2D(tScene, uv - off).b;
  } else {
    scene = texture2D(tScene, uv).rgb;
  }

  vec3 bloom = texture2D(tBloomNear, uv).rgb * uBloomNear
             + texture2D(tBloomWide, uv).rgb * uBloomWide;
  vec3 color = scene + bloom;

  // ── vignette in linear light: an optical falloff, not a black overlay
  float vig = 1.0 - uVignette * smoothstep(uVignetteSoft, 0.72, length(fromCenter * vec2(1.0, 0.82)));
  color *= vig;

  color = acesFilmic(color);

  // ── grade: gentle saturation lift plus a lifted black with a cool tint
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(lum), color, uSaturation);
  color += uLift * (1.0 - smoothstep(0.0, 0.35, lum));

  color = linearToSrgb(clamp(color, 0.0, 1.0));

  // ── film grain: barely there, stronger in shadow where sensors are noisy
  float g = rHash21(uv * uResolution + vec2(uTime * 61.7, uTime * 43.1));
  float shadowW = 1.0 - smoothstep(0.05, 0.65, lum);
  color += (g - 0.5) * uGrain * (0.35 + shadowW * 0.85);

  // ── ordered dither: kills the banding a dark radial backdrop always shows
  vec2 ip = floor(mod(uv * uResolution, 4.0));
  float bayer = fract(dot(ip, vec2(0.0625, 0.25)) + rHash21(ip) * 0.0);
  bayer = (bayer - 0.5) / 255.0;
  color += bayer;

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

/** Straight blit used when post is disabled but we still own the swap. */
export const copyFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
void main() {
  gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0);
}
`;
