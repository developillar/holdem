/**
 * Felt surface shader.
 *
 * Injected into three's MeshPhysicalMaterial via onBeforeCompile so we keep
 * real PBR, IBL and shadow receiving (cards and chips must cast onto this)
 * while owning the entire look of the cloth: woven fibre, directional nap,
 * the printed centre logo, the betting line, chip wear and the key light's
 * pool falloff.
 *
 * The surface is parameterised by object-space XZ (`vFeltPos`), which is
 * resolution independent — the betting line stays a crisp hairline whether
 * the camera is framing the whole table or pushed in on the pot.
 */
import { noiseLib } from './noise.ts';

export const feltParsVertex = /* glsl */ `
varying vec2 vFeltPos;
`;

export const feltVertex = /* glsl */ `
  vFeltPos = transformed.xz;
`;

export const feltParsFragment = /* glsl */ `
varying vec2 vFeltPos;

uniform vec2  uFeltRadii;
uniform vec3  uFeltEdge;
uniform vec3  uFeltAccent;
uniform float uFiberScale;
uniform float uNapStrength;
uniform float uWear;

uniform sampler2D uLogoMap;
uniform vec4  uLogoRect;      // cx, cz, halfW, halfH
uniform vec3  uLogoTint;
uniform float uLogoOpacity;

uniform vec2  uBetRadii;
uniform vec3  uBetColor;
uniform float uBetStrength;

uniform vec4  uPool;          // cx, cz, fullBrightRadius, falloffRadius
uniform float uPoolStrength;
uniform vec3  uPoolTint;

${noiseLib}

/**
 * Cloth weave height. The lod argument is a screen-space fade: once a cell is
 * smaller than a pixel the pattern must vanish or it turns into shimmering
 * noise the moment the camera drifts. This is the single most important
 * line in the shader on a 3x phone display.
 */
float feltWeave(vec2 p, float lod) {
  float warp = sin(p.x * 3.14159) * 0.5 + 0.5;
  float weft = sin(p.y * 3.14159) * 0.5 + 0.5;
  float weave = warp * weft;
  float fuzz = rValueNoise(p * 2.1);
  return 0.5 + (mix(weave, fuzz, 0.55) - 0.5) * lod;
}
`;

/**
 * Runs immediately after `<map_fragment>` — owns diffuseColor. It also
 * declares the locals that the roughness and normal chunks below reuse,
 * since all three run inside the same main().
 */
export const feltColorFragment = /* glsl */ `
  vec2 fp = vFeltPos;
  vec2 nrm = fp / uFeltRadii;
  float rad = length(nrm);

  vec2 fibUv = fp * uFiberScale;
  float feltLod = 1.0 - rSat(length(fwidth(fibUv)) * 0.42);

  // ── woven fibre plus a directional nap that runs radially outward, the
  //    way a croupier brushes speed cloth between hands.
  float feltW = feltWeave(fibUv, feltLod);
  vec2 napDir = rad > 1e-4 ? nrm / rad : vec2(0.0, 1.0);
  float nap = rValueNoise(fp * (uFiberScale * 0.14) + napDir * 4.0);
  float fiber = (feltW - 0.5) * 0.11 + (nap - 0.5) * uNapStrength;

  // ── large scale variation: no bolt of cloth is ever uniform. The mid
  //    octave is the one that actually reads on a phone — its features land
  //    at 20-30 screen pixels, which is where the eye looks for material.
  float bolt = rFbm(fp * 1.15, 3);
  float mottle = rFbm(fp * 6.0 + 4.0, 3) * 0.62 + rFbm(fp * 17.0 + 9.0, 2) * 0.38;
  float wearRing = smoothstep(0.16, 0.6, rad) * (1.0 - smoothstep(0.7, 1.0, rad));
  float wear = (rFbm(fp * 2.4 + 21.0, 3) - 0.5) * wearRing * uWear;

  vec3 cloth = diffuseColor.rgb;
  cloth = mix(cloth, uFeltAccent, rSat((bolt - 0.45) * 1.3) * 0.16);
  cloth *= 1.0 + fiber + wear * 0.8 + (mottle - 0.5) * 0.14;

  // ── rail contact darkening: the felt falls into shadow under the leather
  float edgeAO = smoothstep(0.74, 1.005, rad);
  cloth = mix(cloth, uFeltEdge, edgeAO * 0.92);

  // ── sparse nylon glints, gated by the weave so they land on raised
  //    fibres. Tiny amplitude: this is albedo, not emission.
  float fleckCell = rHash21(floor(fibUv * 1.7));
  float fleck = rSat((fleckCell - 0.988) * 70.0) * rSat(feltW * 2.0 - 0.6) * feltLod;
  cloth += fleck * 0.02;

  // ── printed centre logo. V is negated because world +Z runs *down* the
  //    screen while texture V runs up it.
  vec2 logoUv = vec2(
    (fp.x - uLogoRect.x) / (uLogoRect.z * 2.0) + 0.5,
    0.5 - (fp.y - uLogoRect.y) / (uLogoRect.w * 2.0)
  );
  float inLogo = step(0.0, logoUv.x) * step(logoUv.x, 1.0) * step(0.0, logoUv.y) * step(logoUv.y, 1.0);
  vec4 logoTex = texture2D(uLogoMap, clamp(logoUv, 0.0, 1.0));
  float feltLogoA = logoTex.a * inLogo * uLogoOpacity;
  // screen-printed ink sits *in* the weave: tint rather than paint over
  vec3 ink = uLogoTint * logoTex.rgb;
  cloth = mix(cloth, mix(cloth, ink * 0.5 + cloth * 0.5, 0.9) * (0.94 + fiber * 0.6), feltLogoA);

  // ── betting line: analytic hairline ellipse with a faint inner bloom
  //    A hairline plus a whisper-thin companion rule just outside it: the
  //    double line is what makes printed table graphics read as engraved.
  float betD = length(fp / uBetRadii);
  float feltBet = rAABand(betD, 1.0, 0.0013) + rAABand(betD, 1.012, 0.0005) * 0.45;
  float betGlow = exp(-abs(betD - 1.0) * 190.0) * 0.22;
  cloth = mix(cloth, uBetColor, rSat(feltBet * 0.9 + betGlow * 0.2) * uBetStrength);

  // ── key light pool baked into albedo so the cone still reads at the
  //    grazing angles where punctual falloff alone is invisible
  float poolD = length(fp - uPool.xy);
  float pool = pow(rSat(1.0 - smoothstep(uPool.z, uPool.w, poolD)), 1.5);
  cloth *= mix(1.0 - uPoolStrength, 1.0 + uPoolStrength * 0.3, pool);
  cloth += uPoolTint * pool * uPoolStrength * 0.05;

  diffuseColor.rgb = max(cloth, vec3(0.0));
`;

/** Runs after `<roughnessmap_fragment>` — owns roughnessFactor. */
export const feltRoughnessFragment = /* glsl */ `
  float feltR = roughnessFactor * (0.95 + feltW * 0.1);
  feltR = mix(feltR, feltR * 0.6, feltLogoA);
  feltR = mix(feltR, feltR * 0.55, rSat(feltBet) * uBetStrength);
  roughnessFactor = clamp(feltR, 0.08, 1.0);
`;

/** Runs after `<normal_fragment_maps>` — adds the analytic weave bump. */
export const feltNormalFragment = /* glsl */ `
  {
    float h = feltW * 0.8 + feltLogoA * 0.5 - rSat(feltBet) * 0.9 * uBetStrength;
    normal = rPerturbNormal(normal, -vViewPosition, h, 0.0022 * feltLod);
  }
`;
