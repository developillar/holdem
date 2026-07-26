/**
 * Shared GLSL chunks: hashing, value/simplex noise, fbm, and the
 * derivative-based bump helper every surface shader in Royale uses.
 *
 * Exported as plain template strings so the bundler inlines them with
 * zero runtime cost. Written in GLSL ES 1.00 dialect — three.js adds the
 * `#version 300 es` prefix plus the `texture2D`/`varying` compatibility
 * macros, so this compiles unchanged on WebGL2.
 */

/** Cheap integer-free hashes. Stable across mobile GPUs (no huge constants). */
export const hashChunk = /* glsl */ `
float rHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float rHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 rHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 rHash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
`;

/** Gradient-ish value noise + 2D simplex. Simplex is used where the
 *  characteristic 60° lattice of value noise would read as a grid. */
export const noiseChunk = /* glsl */ `
float rValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = rHash21(i);
  float b = rHash21(i + vec2(1.0, 0.0));
  float c = rHash21(i + vec2(0.0, 1.0));
  float d = rHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float rSimplex(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  vec3 p;
  // permutation without the 289 texture lookup — hash based, plenty for surfaces
  p.x = rHash21(i);
  p.y = rHash21(i + i1);
  p.z = rHash21(i + vec2(1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 ang = p * 6.2831853;
  vec2 g0 = vec2(cos(ang.x), sin(ang.x));
  vec2 g1 = vec2(cos(ang.y), sin(ang.y));
  vec2 g2 = vec2(cos(ang.z), sin(ang.z));
  vec3 gv = vec3(dot(g0, x0), dot(g1, x12.xy), dot(g2, x12.zw));
  return 0.5 + 65.0 * dot(m, gv) * 0.5;
}

float rFbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * rValueNoise(p);
    norm += amp;
    amp *= 0.5;
    p = p * 2.03 + vec2(17.13, 9.71);
  }
  return sum / max(norm, 1e-4);
}

float rRidge(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(rValueNoise(p) * 2.0 - 1.0);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.52;
    p = p * 2.11 + vec2(5.2, 31.7);
  }
  return sum / max(norm, 1e-4);
}
`;

/** Utility maths used across the surface shaders. */
export const utilChunk = /* glsl */ `
float rSat(float x) { return clamp(x, 0.0, 1.0); }
vec3 rSat3(vec3 x) { return clamp(x, 0.0, 1.0); }

/** Antialiased step using screen-space derivatives. */
float rAAStep(float edge, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(edge - w, edge + w, x);
}

/** Antialiased band around `center` of half width `hw`. */
float rAABand(float x, float center, float hw) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(center - hw - w, center - hw + w, x) *
         (1.0 - smoothstep(center + hw - w, center + hw + w, x));
}

/** Signed distance from the unit circle in an anisotropically scaled space. */
float rEllipseSDF(vec2 p, vec2 r) {
  float k1 = length(p / r);
  float k2 = length(p / (r * r));
  return k1 * (k1 - 1.0) / max(k2, 1e-5);
}

vec2 rRot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
`;

/**
 * Perturbs a shading normal from an analytically evaluated height field.
 * Same construction three.js uses for bump maps, but driven by a value we
 * compute in-shader — so stitching and fibres stay crisp at any zoom
 * without ever paying for a high resolution normal map.
 */
export const bumpChunk = /* glsl */ `
vec3 rPerturbNormal(vec3 n, vec3 viewPos, float height, float scale) {
  vec3 dpdx = dFdx(viewPos);
  vec3 dpdy = dFdy(viewPos);
  float dhdx = dFdx(height) * scale;
  float dhdy = dFdy(height) * scale;
  vec3 r1 = cross(dpdy, n);
  vec3 r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * n - grad);
}
`;

/** Everything, in dependency order. Include once per shader. */
export const noiseLib = `${hashChunk}\n${noiseChunk}\n${utilChunk}\n${bumpChunk}`;
