/**
 * Bloom passes for the hand-rolled post chain.
 *
 * Deliberately not three's EffectComposer: this is three draws at half and
 * quarter resolution with five bilinear taps each, which is roughly a third
 * of the fill cost of the stock UnrealBloomPass and looks better on gold
 * because the bright pass is hue weighted — warm metal blooms, blue felt
 * shadow never does.
 */

/** Shared fullscreen-triangle vertex shader. No matrices, no overdraw. */
export const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const brightPassFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform vec2  uTexel;       // 1 / source resolution
uniform float uThreshold;
uniform float uKnee;
uniform float uWarmBias;    // extra weight for gold / warm highlights

vec3 sampleBox(vec2 uv) {
  vec2 o = uTexel;
  vec3 s = texture2D(tScene, uv + vec2(-o.x, -o.y)).rgb;
  s += texture2D(tScene, uv + vec2( o.x, -o.y)).rgb;
  s += texture2D(tScene, uv + vec2(-o.x,  o.y)).rgb;
  s += texture2D(tScene, uv + vec2( o.x,  o.y)).rgb;
  return s * 0.25;
}

void main() {
  vec3 c = sampleBox(vUv);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));

  // warm bias: how much more red than blue this pixel is, 0..1
  float warmth = clamp((c.r - c.b) * 1.6, 0.0, 1.0);
  float weight = 1.0 + warmth * uWarmBias;

  // soft-knee threshold (Karis) so highlights ramp in instead of popping
  float knee = max(uKnee, 1e-4);
  float soft = clamp(luma - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, luma - uThreshold) / max(luma, 1e-4);

  gl_FragColor = vec4(c * contrib * weight, 1.0);
}
`;

/** Separable gaussian, 5 taps via linear sampling (≈9 texel footprint). */
export const blurFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDirection;    // texel-scaled blur axis

void main() {
  vec2 d1 = uDirection * 1.3846153846;
  vec2 d2 = uDirection * 3.2307692308;
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += texture2D(tSrc, vUv + d1).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv - d1).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + d2).rgb * 0.0702702703;
  c += texture2D(tSrc, vUv - d2).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

/** Downsample + blur in one pass, used to build the wide bloom tier. */
export const downsampleFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;

void main() {
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv).rgb * 0.36;
  c += texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb * 0.16;
  c += texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb * 0.16;
  c += texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb * 0.16;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb * 0.16;
  gl_FragColor = vec4(c, 1.0);
}
`;
