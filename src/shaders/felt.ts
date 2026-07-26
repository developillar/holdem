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

/** Height field for the cloth weave — reused for colour and for the bump. */
float feltWeave(vec2 p) {
  float warp = sin(p.x * 3.14159) * 0.5 + 0.5;
  float weft = sin(p.y * 3.14159) * 0.5 + 0.5;
  float weave = warp * weft;
  float fuzz = rValueNoise(p * 2.7) * 0.55 + rValueNoise(p * 7.1) * 0.45;
  return mix(weave, fuzz, 0.62);
}
`;

/** Runs immediately after `<map_fragment>` — owns diffuseColor. */
export const feltColorFragment = /* glsl */ `
  vec2 fp = vFeltPos;
  vec2 nrm = fp / uFeltRadii;
  float rad = length(nrm);

  // ── woven fibre: two octaves of fine grain plus a directional nap that
  //    runs radially outward, the way a croupier brushes speed cloth.
  vec2 fibUv = fp * uFiberScale;
  float weave = feltWeave(fibUv);
  vec2 napDir = rad > 1e-4 ? nrm / rad : vec2(0.0, 1.0);
  float nap = rValueNoise(fp * (uFiberScale * 0.22) + napDir * 6.0);
  float streak = rValueNoise(vec2(dot(fp, vec2(-napDir.y, napDir.x)) * uFiberScale * 0.5, rad * 18.0));

  float fiber = (weave - 0.5) * 0.14 + (nap - 0.5) * 0.10 + (streak - 0.5) * uNapStrength;

  // ── large scale cloth variation: bolts of cloth are never uniform
  float bolt = rFbm(fp * 1.35, 4);
  float wearRing = smoothstep(0.18, 0.62, rad) * (1.0 - smoothstep(0.72, 1.0, rad));
  float wear = (rFbm(fp * 3.1 + 21.0, 3) - 0.5) * wearRing * uWear;

  vec3 cloth = diffuseColor.rgb;
  cloth = mix(cloth, uFeltAccent, rSat((bolt - 0.42) * 1.25) * 0.28);
  cloth *= 1.0 + fiber + wear * 0.9;

  // ── rail contact darkening + outer edge falloff (baked contact AO)
  float edgeAO = smoothstep(0.80, 1.005, rad);
  cloth = mix(cloth, uFeltEdge, edgeAO * 0.85);
  cloth *= 1.0 - smoothstep(0.86, 1.002, rad) * 0.34;

  // ── sparse bright flecks: the tiny nylon glints in real speed cloth
  float fleckCell = rHash21(floor(fp * (uFiberScale * 0.32)));
  float fleck = rSat((fleckCell - 0.976) * 42.0) * rSat(weave * 1.6 - 0.35);
  cloth += fleck * 0.16;

  // ── printed centre logo (screen-printed ink, sits *in* the weave)
  vec2 logoUv = (fp - uLogoRect.xy) / (uLogoRect.zw * 2.0) + 0.5;
  float inLogo = step(0.0, logoUv.x) * step(logoUv.x, 1.0) * step(0.0, logoUv.y) * step(logoUv.y, 1.0);
  vec4 logoTex = texture2D(uLogoMap, clamp(logoUv, 0.0, 1.0));
  float logoA = logoTex.a * inLogo * uLogoOpacity;
  vec3 ink = uLogoTint * logoTex.rgb;
  // ink soaks into the cloth: multiply-then-mix keeps the weave reading through
  cloth = mix(cloth, mix(cloth * 0.55, ink, 0.82) * (0.9 + fiber * 0.6), logoA);

  // ── betting line: analytic hairline ellipse, gold, with a soft inner glow
  float betD = length(fp / uBetRadii);
  float betLine = rAABand(betD, 1.0, 0.0026);
  float betGlow = exp(-abs(betD - 1.0) * 120.0) * 0.35;
  cloth = mix(cloth, uBetColor, rSat(betLine * 0.85 + betGlow * 0.25) * uBetStrength);

  // ── key light pool baked into albedo so the cone reads even at grazing
  //    angles where real punctual falloff is too subtle to see.
  float poolD = length(fp - uPool.xy);
  float pool = 1.0 - smoothstep(uPool.z, uPool.w, poolD);
  pool = pow(rSat(pool), 1.35);
  cloth *= mix(1.0 - uPoolStrength, 1.0 + uPoolStrength * 0.42, pool);
  cloth += uPoolTint * pool * uPoolStrength * 0.18;

  diffuseColor.rgb = max(cloth, vec3(0.0));
`;

/** Runs after `<roughnessmap_fragment>` — owns roughnessFactor. */
export const feltRoughnessFragment = /* glsl */ `
  float feltR = roughnessFactor;
  vec2 fpR = vFeltPos;
  float weaveR = feltWeave(fpR * uFiberScale);
  feltR *= 0.94 + weaveR * 0.12;
  vec2 logoUvR = (fpR - uLogoRect.xy) / (uLogoRect.zw * 2.0) + 0.5;
  float inLogoR = step(0.0, logoUvR.x) * step(logoUvR.x, 1.0) * step(0.0, logoUvR.y) * step(logoUvR.y, 1.0);
  float logoAR = texture2D(uLogoMap, clamp(logoUvR, 0.0, 1.0)).a * inLogoR * uLogoOpacity;
  // printed ink is smoother than the cloth around it
  feltR = mix(feltR, feltR * 0.62, logoAR);
  float betDR = length(fpR / uBetRadii);
  feltR = mix(feltR, feltR * 0.7, rAABand(betDR, 1.0, 0.0030) * uBetStrength);
  roughnessFactor = clamp(feltR, 0.06, 1.0);
`;

/** Runs after `<normal_fragment_maps>` — adds the analytic weave bump. */
export const feltNormalFragment = /* glsl */ `
  {
    float h = feltWeave(vFeltPos * uFiberScale);
    vec2 lu = (vFeltPos - uLogoRect.xy) / (uLogoRect.zw * 2.0) + 0.5;
    float inL = step(0.0, lu.x) * step(lu.x, 1.0) * step(0.0, lu.y) * step(lu.y, 1.0);
    h += texture2D(uLogoMap, clamp(lu, 0.0, 1.0)).a * inL * uLogoOpacity * 0.55;
    float bd = length(vFeltPos / uBetRadii);
    h -= rAABand(bd, 1.0, 0.0032) * 0.9 * uBetStrength;
    // fade the analytic bump out as texels get large on screen, or it aliases
    float fade = 1.0 - rSat(length(fwidth(vFeltPos * uFiberScale)) * 0.55);
    normal = rPerturbNormal(normal, -vViewPosition, h, 0.0016 * fade);
  }
`;
