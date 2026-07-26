/**
 * Environment shaders: the backdrop dome, the procedural "room" that feeds
 * the PMREM environment map, and the volumetric cone under the key light.
 *
 * There are no HDRIs in this project. The room below is what gives the gold
 * trim, the chip edges and the card varnish something real to reflect —
 * a warm overhead softbox, two cool side walls and a dark floor.
 */
import { hashChunk, noiseChunk, utilChunk } from './noise.ts';

export const backdropVertex = /* glsl */ `
varying vec3 vDir;
varying vec2 vScreen;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position.xy / max(gl_Position.w, 1e-4);
}
`;

export const backdropFragment = /* glsl */ `
precision highp float;
varying vec3 vDir;
varying vec2 vScreen;

uniform vec3  uTop;
uniform vec3  uHorizon;
uniform vec3  uBottom;
uniform vec3  uGlow;
uniform float uGlowStrength;
uniform float uTime;

${hashChunk}
${noiseChunk}
${utilChunk}

void main() {
  float h = vDir.y * 0.5 + 0.5;
  vec3 c = mix(uBottom, uHorizon, smoothstep(0.02, 0.52, h));
  c = mix(c, uTop, smoothstep(0.48, 0.98, h));

  // a soft elliptical bloom behind and above the table — the "room light"
  float d = length(vec2(vDir.x * 1.35, (vDir.y - 0.34) * 2.1));
  c += uGlow * uGlowStrength * pow(rSat(1.0 - d), 2.6);

  // faint architectural falloff toward the screen corners
  float corner = length(vScreen * vec2(0.72, 0.5));
  c *= 1.0 - rSat(corner - 0.55) * 0.55;

  // low amplitude drifting grain: stops the gradient from banding and gives
  // the dark surround the feel of film rather than of a solid fill
  float n = rValueNoise(vDir.xy * 220.0 + uTime * 0.02);
  c += (n - 0.5) * 0.006;
  c += (rHash21(vScreen * 512.0) - 0.5) * (1.5 / 255.0);

  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}
`;

/** Emissive panel used inside the PMREM room. Soft, non-uniform, warm. */
export const roomPanelFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform float uFalloff;

${hashChunk}
${noiseChunk}
${utilChunk}

void main() {
  vec2 p = vUv - 0.5;
  float d = length(p * vec2(1.0, 1.35)) * 2.0;
  float f = pow(rSat(1.0 - d), uFalloff);
  vec3 c = mix(uColorB, uColorA, f);
  c *= 0.55 + 0.45 * rFbm(vUv * 3.0, 3);
  gl_FragColor = vec4(c * f, 1.0);
}
`;

export const roomPanelVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Volumetric key-light cone. Additive, depth-read only, tiny amplitude. */
export const lightConeVertex = /* glsl */ `
varying vec3 vLocal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;
void main() {
  vLocal = position;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vViewDir = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const lightConeFragment = /* glsl */ `
precision highp float;
varying vec3 vLocal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

uniform vec3  uColor;
uniform float uIntensity;
uniform float uHeight;
uniform float uTime;

${hashChunk}
${noiseChunk}
${utilChunk}

void main() {
  // 0 at the emitter, 1 at the felt
  float t = rSat((uHeight - vLocal.y) / max(uHeight, 1e-4));

  // the shaft is brightest at the source and dies before it lands, so it
  // never draws a hard rim where it meets the table
  float shaft = pow(1.0 - t, 1.6) * smoothstep(0.0, 0.14, t);
  shaft *= 1.0 - smoothstep(0.72, 1.0, t);

  // grazing faces are thicker: fake the extra path length through the cone
  float graze = 1.0 - abs(dot(normalize(vWorldNormal), vViewDir));
  shaft *= pow(rSat(graze), 1.35);

  // slow dust drift
  float dust = rFbm(vec2(atan(vLocal.z, vLocal.x) * 1.6, vLocal.y * 2.2 - uTime * 0.045), 3);
  shaft *= 0.72 + dust * 0.56;

  gl_FragColor = vec4(uColor * shaft * uIntensity, 1.0);
}
`;

/** Soft contact-shadow / floor gradient used under the table skirt. */
export const floorFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;

uniform vec3  uNear;
uniform vec3  uFar;
uniform vec2  uTableRadii;
uniform float uShadow;

${hashChunk}
${noiseChunk}
${utilChunk}

void main() {
  vec2 p = vWorld.xz;
  float d = length(p / uTableRadii);

  vec3 c = mix(uNear, uFar, rSat(smoothstep(0.9, 3.4, d)));

  // carpet weave, extremely low contrast — only visible as a texture break
  float weave = rFbm(p * 26.0, 3);
  c *= 0.9 + weave * 0.2;

  // contact shadow: dense right under the skirt, feathering out fast
  float ao = 1.0 - uShadow * (1.0 - smoothstep(0.98, 2.05, d));
  c *= ao;

  float alpha = 1.0 - rSat(smoothstep(2.6, 5.2, d));
  c += (rHash21(p * 640.0) - 0.5) * (1.5 / 255.0);
  gl_FragColor = vec4(max(c, vec3(0.0)), alpha);
}
`;

export const floorVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;
