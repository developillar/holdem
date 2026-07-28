const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./dealing-86T9wBRa.js","./index-PPRFSJyQ.js","./index-B-PYgG9v.css","./three-CjvAtPut.js"])))=>i.map(i=>d[i]);
import{b as le,_ as uo}from"./index-PPRFSJyQ.js";import{C as ho,S as Zt,N as Yt,R as Et,a as Xe,b as fo,L as lt,c as mo,V as k,G as bt,d as D,M as tt,e as re,f as ht,g as q,h as ge,P as Ie,i as ke,B as ut,j as me,k as po,l as fe,F as zt,m as Mt,O as vo,W as go,n as wo,H as xo,U as bo,o as Mo,D as yo,p as So,q as Dt,r as Ao,s as qe,A as Ro,t as _o,u as It,v as To,w as Qt,x as Co,y as Fo,z as Po,E as Lo}from"./three-CjvAtPut.js";const We=`
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
`,Ze=`
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
`,Ye=`
float rSat(float x) { return clamp(x, 0.0, 1.0); }
vec3 rSat3(vec3 x) { return clamp(x, 0.0, 1.0); }

/** Antialiased step using screen-space derivatives. */
float rAAStep(float edge, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(edge - w, edge + w, x);
}

/** Antialiased band of half width hw, centred on the given value. */
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
`,Eo=`
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
`,Jt=`${We}
${Ze}
${Ye}
${Eo}`,zo=`
varying vec2 vFeltPos;
`,Do=`
  vFeltPos = transformed.xz;
`,Io=`
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

${Jt}

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
`,ko=`
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
`,Oo=`
  float feltR = roughnessFactor * (0.95 + feltW * 0.1);
  feltR = mix(feltR, feltR * 0.6, feltLogoA);
  feltR = mix(feltR, feltR * 0.55, rSat(feltBet) * uBetStrength);
  roughnessFactor = clamp(feltR, 0.08, 1.0);
`,Bo=`
  {
    float h = feltW * 0.8 + feltLogoA * 0.5 - rSat(feltBet) * 0.9 * uBetStrength;
    normal = rPerturbNormal(normal, -vViewPosition, h, 0.0022 * feltLod);
  }
`,Wo=`
varying vec2 vRailUv;
varying float vRailArc;
`,Uo=`
  vRailUv = uv;
  vRailArc = uv.x;
`,Ho=`
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

${Jt}

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
`,No=`
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
`,Go=`
  float railCrestR = 1.0 - smoothstep(0.0, 0.34, abs(vRailUv.y - 0.5));
  float railR = roughnessFactor * (0.9 + grain * 0.22);
  railR = mix(railR, railR * 0.52, railCrestR * uPolish);
  railR = mix(railR, 0.88, rSat(railThread * 1.4));   // cotton is matte
  roughnessFactor = clamp(railR, 0.05, 1.0);
`,Vo=`
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
`,$o=`
varying vec3 vDir;
varying vec2 vScreen;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position.xy / max(gl_Position.w, 1e-4);
}
`,jo=`
precision highp float;
varying vec3 vDir;
varying vec2 vScreen;

uniform vec3  uTop;
uniform vec3  uHorizon;
uniform vec3  uBottom;
uniform vec3  uGlow;
uniform float uGlowStrength;
uniform float uTime;

${We}
${Ze}
${Ye}

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
`,qo=`
precision highp float;
varying vec2 vUv;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform float uFalloff;

${We}
${Ze}
${Ye}

void main() {
  vec2 p = vUv - 0.5;
  float d = length(p * vec2(1.0, 1.35)) * 2.0;
  float f = pow(rSat(1.0 - d), uFalloff);
  vec3 c = mix(uColorB, uColorA, f);
  c *= 0.55 + 0.45 * rFbm(vUv * 3.0, 3);
  gl_FragColor = vec4(c * f, 1.0);
}
`,Ko=`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,Xo=`
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
`,Zo=`
precision highp float;
varying vec3 vLocal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

uniform vec3  uColor;
uniform float uIntensity;
uniform float uHeight;
uniform float uTime;

${We}
${Ze}
${Ye}

void main() {
  // 0 at the top of the band, 1 where it meets the felt
  float t = rSat((uHeight - vLocal.y) / max(uHeight, 1e-4));

  // A short haze band hugging the table rather than a full shaft: a whole
  // cone from the fixture down draws a hard triangular silhouette against a
  // dark surround, which reads as a modelling mistake rather than as light.
  // Fading to zero at both ends leaves only the glow, never the geometry.
  float shaft = smoothstep(0.0, 0.62, t) * (1.0 - smoothstep(0.78, 1.0, t));

  // grazing faces are thicker: fake the extra path length through the cone
  float graze = 1.0 - abs(dot(normalize(vWorldNormal), vViewDir));
  shaft *= pow(rSat(graze), 1.6);

  // slow dust drift
  float dust = rFbm(vec2(atan(vLocal.z, vLocal.x) * 1.6, vLocal.y * 2.2 - uTime * 0.045), 3);
  shaft *= 0.68 + dust * 0.64;

  gl_FragColor = vec4(uColor * shaft * uIntensity, 1.0);
}
`,Yo=`
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;

uniform vec3  uNear;
uniform vec3  uFar;
uniform vec2  uTableRadii;
uniform float uShadow;

${We}
${Ze}
${Ye}

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
`,Qo=`
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;function de(r,e,t){let o=Math.imul(r|0,374761393)+Math.imul(e|0,668265263)+Math.imul(t|0,2246822519);return o=(o^o>>>13)>>>0,o=Math.imul(o,1274126177)>>>0,((o^o>>>16)>>>0)/4294967296}function Oe(r,e){return(r%e+e)%e}function ne(r,e,t,o){const a=Math.floor(r),n=Math.floor(e),l=r-a,s=e-n,u=l*l*(3-2*l),h=s*s*(3-2*s),i=Oe(a,t),d=Oe(n,t),f=Oe(a+1,t),c=Oe(n+1,t),v=de(i,d,o),p=de(f,d,o),g=de(i,c,o),b=de(f,c,o);return(v+(p-v)*u)*(1-h)+(g+(b-g)*u)*h}function _e(r,e,t,o,a,n=.5){let l=0,s=.5,u=0,h=1;for(let i=0;i<o;i++)l+=s*ne(r*h,e*h,t*h,a+i*1013),u+=s,s*=n,h*=2;return l/u}function ft(r,e,t,o,a){let n=0,l=.5,s=0,u=1;for(let h=0;h<o;h++){const i=1-Math.abs(ne(r*u,e*u,t*u,a+h*733)*2-1);n+=l*i*i,s+=l,l*=.52,u*=2}return n/s}function ve(r,e){const t=document.createElement("canvas");t.width=r,t.height=e;const o=t.getContext("2d",{willReadFrequently:!1});if(!o)throw new Error("[textures] 2D context unavailable");return{canvas:t,ctx:o,w:r,h:e}}function Te(r,e,t,o){const a=ve(e,t),n=a.ctx.createImageData(e,t),l=n.data;for(let s=0;s<t;s++){const u=(s-1+t)%t*e,h=(s+1)%t*e,i=s*e;for(let d=0;d<e;d++){const f=(d-1+e)%e,c=(d+1)%e,v=(r[i+c]-r[i+f])*o,p=(r[h+d]-r[u+d])*o;let g=-v,b=-p;const _=1,R=1/Math.sqrt(g*g+b*b+_*_);g*=R,b*=R;const y=(i+d)*4;l[y]=(g*.5+.5)*255,l[y+1]=(b*.5+.5)*255,l[y+2]=_*R*255,l[y+3]=255}}return a.ctx.putImageData(n,0,0),a}function Ce(r,e,t){const o=ve(e,t),a=o.ctx.createImageData(e,t),n=a.data;for(let l=0;l<e*t;l++){const s=Math.max(0,Math.min(255,Math.round(r[l]*255))),u=l*4;n[u]=s,n[u+1]=s,n[u+2]=s,n[u+3]=255}return o.ctx.putImageData(a,0,0),o}class eo{cache=new Map;opts;constructor(e){this.opts=e}size(e){const t=Math.max(64,Math.round(e*this.opts.scale/64)*64);return Math.min(e,t)}finish(e,t={}){const o=new ho(e.canvas);return o.colorSpace=t.srgb?Zt:Yt,t.repeat!==!1?(o.wrapS=Et,o.wrapT=Et):(o.wrapS=Xe,o.wrapT=Xe),o.magFilter=t.nearest?fo:lt,o.minFilter=t.mips===!1?lt:mo,o.generateMipmaps=t.mips!==!1,o.anisotropy=Math.min(t.aniso??4,this.opts.maxAnisotropy),o.needsUpdate=!0,o}get(e){const t=this.cache.get(e);if(t)return t;const o=this.build(e);return this.cache.set(e,o),o}warm(e){for(const t of e)this.get(t)}build(e){if(e.startsWith("logo:"))return this.buildLogo(e.slice(5));switch(e){case"felt-normal":return this.buildFeltNormal();case"felt-rough":return this.buildFeltRough();case"leather-normal":return this.buildLeatherNormal();case"leather-rough":return this.buildLeatherRough();case"suede-normal":return this.buildSuedeNormal();case"carbon-normal":return this.buildCarbonNormal();case"wood-color":return this.buildWoodColor();case"wood-normal":return this.buildWoodNormal();case"wood-rough":return this.buildWoodRough();case"metal-rough":return this.buildMetalRough();case"metal-normal":return this.buildMetalNormal();case"metal-aniso":return this.buildMetalAniso();case"card-varnish":return this.buildCardVarnish();case"blue-noise":return this.buildBlueNoise();case"noise-rgba":return this.buildNoiseRGBA();case"radial-shadow":return this.buildRadialShadow();case"rail-ao":return this.buildRailAO();default:return this.buildNoiseRGBA()}}feltHeight(e){const t=new Float32Array(e*e),o=32;for(let a=0;a<e;a++)for(let n=0;n<e;n++){const l=n/e*o,s=a/e*o,u=_e(l*.16,s*.16,o,3,505),h=.5+.5*Math.sin(l*Math.PI*2),i=.5+.5*Math.sin(s*Math.PI*2),d=h*i*.55+(1-h)*(1-i)*.28,f=_e(l*2.4,s*2.4,o*2,4,91),c=ne(l*8,s*8,o*8,17);t[a*e+n]=u*.62+d*.16+f*.16+c*.06}return t}buildFeltNormal(){const e=this.size(512);return this.finish(Te(this.feltHeight(e),e,e,2.4),{aniso:8})}buildFeltRough(){const e=this.size(512),t=this.feltHeight(e),o=new Float32Array(e*e);for(let a=0;a<o.length;a++)o[a]=.78+t[a]*.2;return this.finish(Ce(o,e,e),{aniso:4})}leatherHeight(e){const t=new Float32Array(e*e),o=24;for(let a=0;a<e;a++)for(let n=0;n<e;n++){const l=n/e*o,s=a/e*o,u=ft(l*1.9,s*1.9,o*2,4,311),h=1-_e(l*3.6,s*3.6,o*4,3,907),i=Math.pow(ft(l*.8,s*.8,o,3,55),2.4),d=ne(l*11,s*11,o*11,71);t[a*e+n]=u*.44+h*.22+d*.12-i*.3+.3}return t}buildLeatherNormal(){const e=this.size(512);return this.finish(Te(this.leatherHeight(e),e,e,3.6),{aniso:8})}buildLeatherRough(){const e=this.size(512),t=this.leatherHeight(e),o=new Float32Array(e*e);for(let a=0;a<o.length;a++)o[a]=.42+(1-t[a])*.34;return this.finish(Ce(o,e,e),{aniso:4})}buildSuedeNormal(){const e=this.size(512),t=new Float32Array(e*e),o=40;for(let a=0;a<e;a++)for(let n=0;n<e;n++){const l=n/e*o,s=a/e*o;t[a*e+n]=_e(l*5,s*5,o*5,3,401)*.6+ne(l*14,s*14,o*14,402)*.4}return this.finish(Te(t,e,e,1.5),{aniso:8})}buildCarbonNormal(){const e=this.size(512),t=new Float32Array(e*e),o=8;for(let a=0;a<e;a++)for(let n=0;n<e;n++){const l=n/e*o,s=a/e*o,u=Math.floor(l)+Math.floor(s)&1,h=l-Math.floor(l),i=s-Math.floor(s),f=.5+.5*Math.cos((u===0?i:h)*Math.PI*2*4),c=Math.sin(Math.PI*(u===0?h:i)),v=ne(n/e*96,a/e*96,96,88)*.12;t[a*e+n]=f*.45*c+c*.4+v}return this.finish(Te(t,e,e,2.2),{aniso:8})}woodField(e,t){const o=new Float32Array(e*t);for(let a=0;a<t;a++)for(let n=0;n<e;n++){const l=n/e*26,s=a/t*5,u=_e(l*.5,s*.5,16,4,5)*2.6,h=Math.sin((s*5.5+u)*Math.PI*2),i=ft(l*4.5,s*.9,64,3,991),d=ne(l*22,s*3,256,6);o[a*e+n]=.5+h*.22+i*.3+d*.1-.14}return o}buildWoodColor(){const e=this.size(1024),t=this.size(256),o=this.woodField(e,t),a=ve(e,t),n=a.ctx.createImageData(e,t),l=n.data,s=[36,20,11],u=[122,72,31],h=[176,120,60];for(let i=0;i<e*t;i++){const d=Math.max(0,Math.min(1,o[i]));let f,c,v;if(d<.55){const g=d/.55;f=s[0]+(u[0]-s[0])*g,c=s[1]+(u[1]-s[1])*g,v=s[2]+(u[2]-s[2])*g}else{const g=(d-.55)/.45;f=u[0]+(h[0]-u[0])*g,c=u[1]+(h[1]-u[1])*g,v=u[2]+(h[2]-u[2])*g}const p=i*4;l[p]=f,l[p+1]=c,l[p+2]=v,l[p+3]=255}return a.ctx.putImageData(n,0,0),this.finish(a,{srgb:!0,aniso:8})}buildWoodNormal(){const e=this.size(1024),t=this.size(256);return this.finish(Te(this.woodField(e,t),e,t,1.6),{aniso:8})}buildWoodRough(){const e=this.size(1024),t=this.size(256),o=this.woodField(e,t),a=new Float32Array(e*t);for(let n=0;n<a.length;n++)a[n]=.1+(1-o[n])*.16;return this.finish(Ce(a,e,t),{aniso:8})}metalField(e,t){const o=new Float32Array(e*t);for(let a=0;a<t;a++)for(let n=0;n<e;n++){const l=n/e*512,s=a/t*8,u=ne(l*1,s*.12,512,21)*.5+ne(l*4,s*.25,2048,22)*.3+ne(l*16,s*.5,8192,23)*.2,h=Math.pow(ne(l*.25,s*2.5,128,24),6)*.5;o[a*e+n]=u*.85+h}return o}buildMetalRough(){const e=this.size(1024),t=this.size(128),o=this.metalField(e,t),a=new Float32Array(e*t);for(let n=0;n<a.length;n++)a[n]=.14+o[n]*.3;return this.finish(Ce(a,e,t),{aniso:16})}buildMetalNormal(){const e=this.size(1024),t=this.size(128);return this.finish(Te(this.metalField(e,t),e,t,.9),{aniso:16})}buildMetalAniso(){const e=this.size(512),t=this.size(64),o=ve(e,t),a=o.ctx.createImageData(e,t),n=a.data,l=this.metalField(e,t);for(let s=0;s<e*t;s++){const u=(l[s]-.5)*.16,h=Math.cos(u),i=Math.sin(u),d=s*4;n[d]=(h*.5+.5)*255,n[d+1]=(i*.5+.5)*255,n[d+2]=(.7+l[s]*.3)*255,n[d+3]=255}return o.ctx.putImageData(a,0,0),this.finish(o,{aniso:8})}buildCardVarnish(){const e=this.size(512),t=new Float32Array(e*e);for(let o=0;o<e;o++)for(let a=0;a<e;a++){const n=a/e*64,l=o/e*64,s=(.5+.5*Math.sin(n*Math.PI*2))*.5+(.5+.5*Math.sin(l*Math.PI*2))*.5,u=_e(n*.4,l*.4,32,4,313);t[o*e+a]=.16+s*.1+u*.22}return this.finish(Ce(t,e,e),{aniso:8})}buildBlueNoise(){let o=new Float32Array(4096);for(let i=0;i<4096;i++)o[i]=de(i%64,i/64|0,4242);const a=new Float32Array(4096),n=new Float32Array(4096),l=[.06136,.24477,.38774,.24477,.06136],s=new Int32Array(4096);for(let i=0;i<4;i++){for(let v=0;v<64;v++)for(let p=0;p<64;p++){let g=0;for(let b=-2;b<=2;b++)g+=o[v*64+Oe(p+b,64)]*l[b+2];a[v*64+p]=g}for(let v=0;v<64;v++)for(let p=0;p<64;p++){let g=0;for(let b=-2;b<=2;b++)g+=a[Oe(v+b,64)*64+p]*l[b+2];n[v*64+p]=g}for(let v=0;v<4096;v++)o[v]=o[v]-n[v];for(let v=0;v<4096;v++)s[v]=v;const d=o,f=Array.from(s).sort((v,p)=>d[v]-d[p]),c=new Float32Array(4096);for(let v=0;v<4096;v++)c[f[v]]=v/4095;o=c}const u=ve(64,64),h=u.ctx.createImageData(64,64);for(let i=0;i<4096;i++){const d=Math.round(o[i]*255),f=i*4;h.data[f]=d,h.data[f+1]=d,h.data[f+2]=d,h.data[f+3]=255}return u.ctx.putImageData(h,0,0),this.finish(u,{nearest:!0,mips:!1,aniso:1})}buildNoiseRGBA(){const t=ve(256,256),o=t.ctx.createImageData(256,256);for(let a=0;a<256*256;a++){const n=a*4;o.data[n]=de(a,1,7)*255,o.data[n+1]=de(a,2,7)*255,o.data[n+2]=de(a,3,7)*255,o.data[n+3]=de(a,4,7)*255}return t.ctx.putImageData(o,0,0),this.finish(t,{nearest:!0,mips:!1,aniso:1})}buildRadialShadow(){const e=this.size(256),t=ve(e,e),o=t.ctx.createImageData(e,e);for(let a=0;a<e;a++)for(let n=0;n<e;n++){const l=n/e*2-1,s=a/e*2-1,u=Math.sqrt(l*l+s*s),h=Math.max(0,1-u/.62),i=Math.max(0,1-u),d=Math.pow(h,1.7)*.72+Math.pow(i,3.2)*.4,f=(a*e+n)*4;o.data[f]=0,o.data[f+1]=0,o.data[f+2]=0,o.data[f+3]=Math.min(255,d*255)}return t.ctx.putImageData(o,0,0),this.finish(t,{repeat:!1,aniso:4})}buildRailAO(){const t=this.size(256),o=new Float32Array(8*t);for(let a=0;a<t;a++){const n=a/(t-1),l=1-Math.exp(-Math.pow(n/.16,2))*.55,s=1-Math.exp(-Math.pow((1-n)/.14,2))*.6,u=1-Math.pow(Math.max(0,1-Math.abs(n-.5)/.45),3)*.1;for(let h=0;h<8;h++)o[a*8+h]=Math.max(0,l*s*u)}return this.finish(Ce(o,8,t),{aniso:2})}buildLogo(e){const t=this.size(512),o=ve(t,t),{ctx:a}=o,n=t/512;a.clearRect(0,0,t,t),a.save(),a.translate(t/2,t/2);const l=(s,u,h)=>{a.beginPath(),a.ellipse(0,0,s*n,s*n,0,0,Math.PI*2),a.lineWidth=u*n,a.strokeStyle=`rgba(255,255,255,${h})`,a.stroke()};if(e==="royale-classic"||e==="default"||e===""){l(228,3,.85),l(214,1.2,.5),a.save(),a.translate(0,-34*n),a.scale(1.55*n,1.55*n),a.translate(-50,-50);const s=new Path2D("M50 12 L74 36 Q88 50 74 64 Q62 76 50 64 Q38 76 26 64 Q12 50 26 36 Z"),u=new Path2D("M46 62 h8 l4 22 h-16 z");a.fillStyle="rgba(255,255,255,0.92)",a.fill(s),a.fill(u),a.restore(),this.wordmark(a,"ROYALE",0,118*n,44*n,15*n,.9),this.wordmark(a,"TEXAS HOLD’EM",0,166*n,15*n,9*n,.45)}else if(e==="obsidian")l(232,1.6,.55),a.save(),a.rotate(Math.PI/4),a.strokeStyle="rgba(255,255,255,0.8)",a.lineWidth=4*n,a.strokeRect(-118*n,-118*n,236*n,236*n),a.restore(),this.wordmark(a,"ROYALE",0,16*n,56*n,20*n,.9);else if(e==="crown"){l(230,2.4,.7),a.save(),a.translate(0,-28*n),a.scale(n,n);const s=new Path2D("M-96 34 L-110 -46 L-52 -6 L0 -66 L52 -6 L110 -46 L96 34 Z M-96 46 L96 46 L96 66 L-96 66 Z");a.fillStyle="rgba(255,255,255,0.9)",a.fill(s),a.restore(),this.wordmark(a,"ROYALE",0,130*n,46*n,16*n,.88)}else l(226,2.2,.7),this.wordmark(a,e.toUpperCase().slice(0,10),0,18*n,52*n,18*n,.9);return a.restore(),this.finish(o,{srgb:!0,repeat:!1,aniso:8})}wordmark(e,t,o,a,n,l,s){e.save(),e.font=`600 ${n}px "SF Pro Display", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`,e.textBaseline="middle",e.textAlign="left",e.fillStyle=`rgba(255,255,255,${s})`;const u=Array.from(t);let h=0;for(const d of u)h+=e.measureText(d).width+l;h-=l;let i=o-h/2;for(const d of u)e.fillText(d,i,a),i+=e.measureText(d).width+l;e.restore()}dispose(){for(const e of this.cache.values())e.dispose();this.cache.clear()}}let Be=null;function Jo(r){return Be?.dispose(),Be=new eo(r),Be}function dt(){return Be||(Be=new eo({maxAnisotropy:4,scale:1})),Be}const oe=.8,ae=1.5,be=.152,ct=.088,Qe=oe+be/2,Je=ae+be/2,ze=oe+be,De=ae+be,te=0,to=.0035,st=.002,kt=.07,Ot=.006,yt=.6,St=1.06,oo=0,ao=.34,no=.226,ea=-.1,vt=.21,gt=.292,Ke=-.88,Ne=192,ta=.795,oa=.862,aa=.216,na=47*Math.PI/180,ra=.43,sa=.25,ia=20*Math.PI/180,la=16*Math.PI/180,ca=.84,ua=-28*Math.PI/180,Bt=.22,Wt=.93,ha=40*Math.PI/180,Ut=.18,fa=.955,da=.07,ma=.975,pa=.94;function va(r,e){const t=((r-e)/(r+e))**2;return Math.PI*(r+e)*(1+3*t/(10+Math.sqrt(4-3*t)))}const ro=va(Qe,Je),wt={1:[90],2:[90,270],3:[90,210,330],4:[90,165,270,15],5:[90,153,221,319,27],6:[90,145,215,270,325,35],7:[90,128,165,226,314,15,52],8:[90,128,165,212,270,328,15,52],9:[90,126,160,204,246,294,336,20,54]},At=6;function Ht(r,e,t,o){return new k(r*Math.cos(t),o,e*Math.sin(t))}function mt(r,e){const t=oe-e,o=ae-e,a=Math.hypot(r.x/t,r.z/o);return a>1&&(r.x/=a,r.z/=a),r}function ga(r,e,t,o,a){const n=oe-Ot,l=ae-Ot,s=r*r/(n*n)+e*e/(l*l);if(s<=1e-9)return 1;let u=1;for(let h=0;h<it.length;h++)for(let i=0;i<4;i++){const d=t*it[h]*a+(i&1?vt:-vt)/2,f=o*it[h]*a+(i&2?gt:-gt)/2,c=2*(r*d/(n*n)+e*f/(l*l)),v=d*d/(n*n)+f*f/(l*l)-1,p=c*c-4*s*v;if(p<=0)continue;const g=(-c+Math.sqrt(p))/(2*s);g<u&&(u=g>0?g:0)}return u}const it=[.5,-.5,1.5,-1.5];function wa(r){return(wt[r]??wt[At]).map((t,o)=>{const a=t*Math.PI/180,n=Math.cos(a),l=Math.sin(a),s=new k(oe*n,te,ae*l),u=new k(-s.x,0,-s.z).normalize(),h=new k(-u.z,0,u.x),i=o===0,d=1-Math.abs(l),f=-Math.sign(n)||1,c=i?ta:oa-aa*d,v=i||l>=0?0:na*d*f,p=a+v,g=i?.068:.054,b=oe*Math.cos(p)*c,_=ae*Math.sin(p)*c,R=ga(b,_,h.x,h.z,g),y=new k(b*R,te+to,_*R),L=[];for(let B=0;B<4;B++){const V=it[B]*g;L.push(new k(y.x+h.x*V,y.y+B*6e-4,y.z+h.z*V))}const P=Math.sign(l*h.z)||1,F=i?ca:ra+sa*Math.abs(n),x=i?ua:Math.abs(n)*(ia+la*l)*f,E=a+x,T=mt(new k(oe*Math.cos(E)*F,te+st,ae*Math.sin(E)*F),kt),S=Ht(yt,St,a,te+st);if(S.x+=h.x*.11*P,S.z+=h.z*.11*P,i){const B=a+ha;S.x=oe*Math.cos(B)*Wt,S.z=ae*Math.sin(B)*Wt}else if(l>0){const B=oo-T.x,V=ao-T.z,Z=Math.hypot(B,V)||1;S.x=T.x+B/Z*Bt,S.z=T.z+V/Z*Bt}S.y=te+st,mt(S,kt);const O=mt(new k(oe*Math.cos(E)*(F+Ut),te+.004,ae*Math.sin(E)*(F+Ut)),.05);return{slot:o,angle:a,plate:Ht(Qe*(fa-da*n**6),Je*(i?pa:ma),a,ct*1.02),cards:L,bet:S,stack:T,button:O,inward:u,facing:Math.atan2(u.x,u.z)}})}const Nt=new Map;function xt(r){const e=Math.max(1,Math.min(9,Math.round(r)));let t=Nt.get(e);return t||(t=wa(e),Nt.set(e,t)),t}const Gt=[0,1,2,3,4].map(r=>new k((r-2)*no,te+to,ea)),so={};for(const r of[1,2,3,4,5,6,7,8,9])so[r]=xt(r).map(e=>e.plate.clone());const ce={FELT_RX:oe,FELT_RZ:ae,FELT_Y:te,RAIL_W:be,RAIL_H:ct,RAIL_CX:Qe,RAIL_CZ:Je,RAIL_OUT_X:ze,RAIL_OUT_Z:De,RAIL_PERIMETER:ro,FLOOR_Y:Ke,BET_RX:yt,BET_RZ:St,SEAT_POSITIONS:so,SEAT_ANGLES_DEG:wt,BOARD_SLOTS:Gt,POT_CENTER:new k(oo,te+st,ao),DEALER_POS:new k(0,te+.03,-1.39),MUCK_POS:new k(.44,te+.02,-1.2),CARD_SIZE:{w:vt,h:gt,t:.006},CHIP_SIZE:{r:.061,h:.0115},BOARD_PITCH:no,DEFAULT_SIZE:At,sizes:[2,3,4,5,6,7,8,9],seats:xt,seat(r,e){const t=xt(r);return t[(e%t.length+t.length)%t.length]},slotFor(r,e,t){return((r-e)%t+t)%t},boardSlot(r){return Gt[Math.max(0,Math.min(4,r))]}},xa={feltColor:"#14432d",feltAccent:"#1c5a3c",feltEdge:"#06180f",feltSheen:"#2c7350",railMaterial:"leather",railColor:"#2f2118",stitchColor:"#c08d21",seamColor:"#090604",logoId:"royale-classic",logoTint:"#dfe4ee",logoOpacity:.3,trimMetal:"gold",betLineColor:"#edc96b",betLineStrength:.38},Ge={gold:{color:"#a8791d",roughness:.76,aniso:.34},platinum:{color:"#9aa4b2",roughness:.72,aniso:.34},copper:{color:"#8a552e",roughness:.78,aniso:.32},gunmetal:{color:"#3f454f",roughness:.82,aniso:.28}};function Ve(r,e,t,o){const a=t.length,n=(o+1)*a,l=new Float32Array(n*3),s=new Float32Array(n*3),u=new Float32Array(n*2),h=new Float32Array(a);let i=0;for(let p=1;p<a;p++){const g=t[p].w-t[p-1].w,b=t[p].h-t[p-1].h;i+=Math.hypot(g,b),h[p]=i}for(let p=0;p<a;p++)h[p]=i>0?h[p]/i:p/Math.max(1,a-1);const d=new Float32Array(a*2);for(let p=0;p<a;p++){const g=t[Math.max(0,p-1)],b=t[Math.min(a-1,p+1)];let _=b.w-g.w,R=b.h-g.h;const y=Math.hypot(_,R)||1;_/=y,R/=y,d[p*2]=-R,d[p*2+1]=_}let f=0;for(let p=0;p<=o;p++){const g=p/o*Math.PI*2,b=Math.cos(g),_=Math.sin(g);let R=b/r,y=_/e;const L=Math.hypot(R,y)||1;R/=L,y/=L;const P=r*b,F=e*_;for(let x=0;x<a;x++){const E=t[x],T=f*3;l[T]=P+R*E.w,l[T+1]=E.h,l[T+2]=F+y*E.w;const S=d[x*2],O=d[x*2+1];s[T]=R*S,s[T+1]=O,s[T+2]=y*S,u[f*2]=p/o,u[f*2+1]=h[x],f++}}const c=[];for(let p=0;p<o;p++)for(let g=0;g<a-1;g++){const b=p*a+g,_=(p+1)*a+g;c.push(b,_,b+1,_,_+1,b+1)}const v=new ut;return v.setAttribute("position",new me(l,3)),v.setAttribute("normal",new me(s,3)),v.setAttribute("uv",new me(u,2)),v.setIndex(c),Rt(v),v.computeBoundingSphere(),v}function Rt(r){const e=r.getIndex(),t=r.getAttribute("position"),o=r.getAttribute("normal");if(!e||e.count<3)return;const a=e.getX(0),n=e.getX(1),l=e.getX(2),s=new k().fromBufferAttribute(t,a),u=new k().fromBufferAttribute(t,n),h=new k().fromBufferAttribute(t,l),i=u.sub(s).cross(h.sub(s)),d=new k().fromBufferAttribute(o,a);if(i.dot(d)<0){const f=e.array;for(let c=0;c<f.length;c+=3){const v=f[c+1];f[c+1]=f[c+2],f[c+2]=v}e.needsUpdate=!0}}function ba(r,e){const t=Qe,o=Je,a=be/2-.014,n=(e+1)*(r+1),l=new Float32Array(n*3),s=new Float32Array(n*3),u=new Float32Array(n*2);let h=0;for(let c=0;c<=e;c++){const v=c/e*Math.PI*2,p=Math.cos(v),g=Math.sin(v);let b=p/t,_=g/o;const R=Math.hypot(b,_)||1;b/=R,_/=R;const y=t*p-b*a,L=o*g-_*a;for(let P=0;P<=r;P++){const F=Math.pow(P/r,.85),x=h*3;l[x]=y*F,l[x+1]=te,l[x+2]=L*F,s[x]=0,s[x+1]=1,s[x+2]=0,u[h*2]=y*F,u[h*2+1]=L*F,h++}}const i=[],d=r+1;for(let c=0;c<e;c++)for(let v=0;v<r;v++){const p=c*d+v,g=(c+1)*d+v;i.push(p,g,p+1,g,g+1,p+1)}const f=new ut;return f.setAttribute("position",new me(l,3)),f.setAttribute("normal",new me(s,3)),f.setAttribute("uv",new me(u,2)),f.setIndex(i),Rt(f),f.computeBoundingSphere(),f}function Vt(r,e,t,o,a){const n=new Float32Array((o+2)*3),l=new Float32Array((o+2)*3),s=new Float32Array((o+2)*2);n[1]=t,l[1]=a?1:-1,s[0]=.5,s[1]=.5;for(let i=0;i<=o;i++){const d=i/o*Math.PI*2,f=(i+1)*3;n[f]=r*Math.cos(d),n[f+1]=t,n[f+2]=e*Math.sin(d),l[f+1]=a?1:-1,s[(i+1)*2]=Math.cos(d)*.5+.5,s[(i+1)*2+1]=Math.sin(d)*.5+.5}const u=[];for(let i=1;i<=o;i++)u.push(0,i,i+1);const h=new ut;return h.setAttribute("position",new me(n,3)),h.setAttribute("normal",new me(l,3)),h.setAttribute("uv",new me(s,2)),h.setIndex(u),Rt(h),h.computeBoundingSphere(),h}function Ma(r){const e=dt(),t=new bt;t.name="table";const o={...xa},a=.3,n=.4,l=-.63,s={uFeltRadii:{value:new re(oe,ae)},uFeltEdge:{value:new D(o.feltEdge)},uFeltAccent:{value:new D(o.feltAccent)},uFiberScale:{value:84},uNapStrength:{value:.07},uWear:{value:.17},uLogoMap:{value:e.get(`logo:${o.logoId}`)},uLogoRect:{value:new ht(0,l,a,n)},uLogoTint:{value:new D(o.logoTint)},uLogoOpacity:{value:o.logoOpacity},uBetRadii:{value:new re(yt,St)},uBetColor:{value:new D(o.betLineColor)},uBetStrength:{value:o.betLineStrength},uPool:{value:new ht(0,-.12,.44,1.62)},uPoolStrength:{value:.42},uPoolTint:{value:new D("#4a3316")}},u=new tt({color:new D(o.feltColor),roughness:.95,metalness:0,sheen:.85,sheenColor:new D(o.feltSheen),sheenRoughness:.6,normalMap:e.get("felt-normal"),normalScale:new re(.66,.66),roughnessMap:e.get("felt-rough"),envMapIntensity:.07,dithering:!0});u.normalMap.repeat.set(5,5),u.roughnessMap.repeat.set(10,10),u.onBeforeCompile=C=>{Object.assign(C.uniforms,s),C.vertexShader=C.vertexShader.replace("#include <common>",`#include <common>
${zo}`).replace("#include <begin_vertex>",`#include <begin_vertex>
${Do}`),C.fragmentShader=C.fragmentShader.replace("#include <common>",`#include <common>
${Io}`).replace("#include <map_fragment>",`#include <map_fragment>
${ko}`).replace("#include <roughnessmap_fragment>",`#include <roughnessmap_fragment>
${Oo}`).replace("#include <normal_fragment_maps>",`#include <normal_fragment_maps>
${Bo}`)},u.customProgramCacheKey=()=>"royale-felt-v2";const h=new q(ba(18,Ne),u);h.name="felt",h.receiveShadow=!0,h.renderOrder=0,t.add(h);const i=be/2,d=[{w:-i-.008,h:.002},{w:-i+.002,h:.01},{w:-i+.008,h:.024},{w:-i+.018,h:.045},{w:-i+.034,h:.068},{w:-i+.052,h:.082},{w:-.014,h:ct},{w:.018,h:ct-.0015},{w:i-.05,h:.08},{w:i-.03,h:.062},{w:i-.014,h:.036},{w:i-.003,h:.014},{w:i,h:-.004},{w:i-.004,h:-.02},{w:i-.016,h:-.036}],f={uGrainScale:{value:34},uGrainDepth:{value:.2},uCreaseDepth:{value:.22},uSeamColor:{value:new D(o.seamColor)},uThreadColor:{value:new D(o.stitchColor)},uCrestTint:{value:new D("#c9a878")},uStitch:{value:new ht(.185,172,.013,.024)},uStitchOn:{value:1},uPolish:{value:.85},uRailWear:{value:.13},uArcAspect:{value:ro}},c=new tt({color:new D(o.railColor),roughness:.62,metalness:0,clearcoat:.46,clearcoatRoughness:.34,normalMap:e.get("leather-normal"),normalScale:new re(.55,.55),roughnessMap:e.get("leather-rough"),aoMap:e.get("rail-ao"),aoMapIntensity:.95,envMapIntensity:.7,dithering:!0});c.normalMap.repeat.set(22,3),c.roughnessMap.repeat.set(22,3),c.aoMap.repeat.set(1,1),c.aoMap.wrapS=Xe,c.onBeforeCompile=C=>{Object.assign(C.uniforms,f),C.vertexShader=C.vertexShader.replace("#include <common>",`#include <common>
${Wo}`).replace("#include <begin_vertex>",`#include <begin_vertex>
${Uo}`),C.fragmentShader=C.fragmentShader.replace("#include <common>",`#include <common>
${Ho}`).replace("#include <map_fragment>",`#include <map_fragment>
${No}`).replace("#include <roughnessmap_fragment>",`#include <roughnessmap_fragment>
${Go}`).replace("#include <normal_fragment_maps>",`#include <normal_fragment_maps>
${Vo}`)},c.customProgramCacheKey=()=>"royale-rail-v2";const v=new q(Ve(Qe,Je,d,Ne),c);v.name="rail",v.castShadow=!0,v.receiveShadow=!0,t.add(v);const p=Ge[o.trimMetal],g=new tt({color:new D(p.color),metalness:1,roughness:p.roughness,roughnessMap:e.get("metal-rough"),normalMap:e.get("metal-normal"),normalScale:new re(.18,.18),anisotropy:p.aniso,anisotropyRotation:0,envMapIntensity:.14,dithering:!0});g.roughnessMap.repeat.set(6,1),g.normalMap.repeat.set(6,1);const b=.0105,_=[];for(let C=0;C<=12;C++){const z=Math.PI*(1-C/12);_.push({w:Math.cos(z)*b,h:.0035+Math.sin(z)*b})}const R=oe+.004,y=ae+.004,L=new q(Ve(R,y,_,Ne),g);L.name="trim",L.castShadow=!1,L.receiveShadow=!0,t.add(L);const P=[{w:0,h:-.03},{w:.004,h:-.036},{w:.005,h:-.054},{w:.001,h:-.072},{w:-.004,h:-.08}],F=new q(Ve(ze-.014,De-.014,P,Ne),g);F.name="trim-band",t.add(F);const x=new tt({color:new D("#0b0d12"),roughness:.44,metalness:.25,clearcoat:.3,clearcoatRoughness:.5,envMapIntensity:.5,dithering:!0}),E=[{w:-.012,h:-.074},{w:-.026,h:-.112},{w:-.05,h:-.172},{w:-.086,h:-.227},{w:-.13,h:-.258}],T=new q(Ve(ze-.014,De-.014,E,Ne),x);T.name="skirt",T.castShadow=!0,t.add(T);const S=new q(Vt(ze-.144,De-.144,-.258,64,!1),x);t.add(S);const O=[{w:0,h:-.258},{w:-.02,h:-.34},{w:-.03,h:-.58},{w:-.014,h:-.78},{w:.06,h:-.85},{w:.09,h:Ke+.005}],B=new q(Ve(.3,.44,O,72),x);B.name="pedestal",B.castShadow=!0,t.add(B);const V=new q(Vt(.39,.53,Ke+.005,64,!0),x);t.add(V);const Z={uNear:{value:new D("#0b0d13")},uFar:{value:new D("#04050a")},uTableRadii:{value:new re(ze,De)},uShadow:{value:.66}},Q=new ge({uniforms:Z,vertexShader:Qo,fragmentShader:Yo,transparent:!0,depthWrite:!1,toneMapped:!1}),K=new q(new Ie(11,11,1,1),Q);K.rotation.x=-Math.PI/2,K.position.y=Ke,K.name="floor",K.renderOrder=-2,t.add(K);const J=new ke({map:e.get("radial-shadow"),transparent:!0,opacity:.85,depthWrite:!1,toneMapped:!1,color:0}),ee=new q(new Ie(1,1,1,1),J);ee.scale.set(ze*2.7,De*2.1,1),ee.rotation.x=-Math.PI/2,ee.position.y=Ke+.004,ee.renderOrder=-1,ee.name="contact-shadow",t.add(ee);const ue=[u,c,g,x];function Me(C){const z=dt();switch(C){case"leather":c.map=null,c.normalMap=z.get("leather-normal"),c.roughnessMap=z.get("leather-rough"),c.normalScale.set(.55,.55),c.roughness=.62,c.metalness=0,c.clearcoat=.46,c.clearcoatRoughness=.34,c.sheen=0,f.uStitchOn.value=1,f.uGrainScale.value=34,f.uPolish.value=.72,c.normalMap.repeat.set(22,3),c.roughnessMap.repeat.set(22,3);break;case"suede":c.map=null,c.normalMap=z.get("suede-normal"),c.roughnessMap=null,c.normalScale.set(.5,.5),c.roughness=.95,c.metalness=0,c.clearcoat=0,c.sheen=1,c.sheenRoughness=.6,c.sheenColor.set("#6a5a4a"),f.uStitchOn.value=1,f.uGrainScale.value=46,f.uPolish.value=.25,c.normalMap.repeat.set(26,4);break;case"carbon":c.map=null,c.normalMap=z.get("carbon-normal"),c.roughnessMap=null,c.normalScale.set(.7,.7),c.roughness=.3,c.metalness=.2,c.clearcoat=.85,c.clearcoatRoughness=.14,c.sheen=0,f.uStitchOn.value=0,f.uGrainScale.value=20,f.uPolish.value=.4,c.normalMap.repeat.set(30,4);break;case"wood":c.map=z.get("wood-color"),c.normalMap=z.get("wood-normal"),c.roughnessMap=z.get("wood-rough"),c.normalScale.set(.55,.55),c.roughness=.2,c.metalness=0,c.clearcoat=.95,c.clearcoatRoughness=.08,c.sheen=0,f.uStitchOn.value=0,f.uGrainScale.value=14,f.uPolish.value=.5,c.map.repeat.set(6,1),c.normalMap.repeat.set(6,1),c.roughnessMap.repeat.set(6,1);break}c.needsUpdate=!0}function ye(C){Object.assign(o,C),u.color.set(o.feltColor),u.sheenColor.set(o.feltSheen),s.uFeltAccent.value.set(o.feltAccent),s.uFeltEdge.value.set(o.feltEdge),s.uBetColor.value.set(o.betLineColor),s.uBetStrength.value=o.betLineStrength,s.uLogoTint.value.set(o.logoTint),s.uLogoOpacity.value=o.logoOpacity,s.uLogoMap.value=dt().get(`logo:${o.logoId}`),c.color.set(o.railMaterial==="wood"?"#ffffff":o.railColor),f.uThreadColor.value.set(o.stitchColor),f.uSeamColor.value.set(o.seamColor),(C.railMaterial!==void 0||!c.userData.railApplied)&&(Me(o.railMaterial),c.userData.railApplied=!0);const z=Ge[o.trimMetal]??Ge.gold;g.color.set(z.color),g.roughness=z.roughness,g.anisotropy=z.aniso,g.needsUpdate=!0}return ye({}),{group:t,felt:h,rail:v,trim:L,skin:o,setSkin:ye,setLightPool(C,z,N,we,w){s.uPool.value.set(C,z,N,we),s.uPoolStrength.value=w},setQuality(C){const z=C==="low";u.sheen=z?0:.85,u.sheenRoughness=.6,c.clearcoat=z?0:o.railMaterial==="wood"?.95:.46,g.anisotropy=z?0:(Ge[o.trimMetal]??Ge.gold).aniso,ee.visible=C!=="low",s.uWear.value=z?.08:.17,s.uFiberScale.value=z?54:84,u.needsUpdate=!0,c.needsUpdate=!0,g.needsUpdate=!0},update(){},dispose(){t.traverse(C=>{const z=C;z.geometry&&z.geometry.dispose()});for(const C of ue)C.dispose();Q.dispose(),J.dispose()}}}const io=Math.PI/180;class pe{value;target;vel=0;omega;zeta;constructor(e,t,o){this.value=e,this.target=e,this.omega=t,this.zeta=o}set(e){this.value=e,this.target=e,this.vel=0}step(e){const t=this.omega*this.omega*(this.target-this.value)-2*this.zeta*this.omega*this.vel;this.vel+=t*e,this.value+=this.vel*e}get settled(){return Math.abs(this.vel)<1e-4&&Math.abs(this.target-this.value)<1e-4}}function ya(r){if(r.t<r.attack){const t=r.t/r.attack;return 1-Math.pow(1-t,3)}const e=r.dur-r.release;if(r.t>e){const t=Math.min(1,(r.dur-r.t)/r.release);return t*t*(3-2*t)}return 1}const ot=49*io,Fe=47,Sa=1.84,Aa=1.26,Ra=.07;function _a(){const r=new po(Fe,1,.12,42);r.name="stage-camera";const e=new k(0,.02,-.06),t=e.clone();let o=5.2;const a=new pe(0,5,.86),n=new pe(ot,5,.9),l=new pe(o,4.4,.92),s=new pe(e.x,5.6,.95),u=new pe(e.y,5.6,.95),h=new pe(e.z,5.6,.95),i=new pe(Fe,4.6,.95),d=new pe(0,6.2,.8);let f=At,c=0,v=null,p=0;const g=[];let b=0,_=0,R=0,y=0,L=0,P=0,F=0,x=null,E=!1;const T=[];{const{RAIL_OUT_X:w,RAIL_OUT_Z:A,RAIL_H:I}=ce,H=28;for(let G=0;G<H;G++){const Y=G/H*Math.PI*2,U=w*Math.cos(Y),j=A*Math.sin(Y);T.push(new k(U,I,j)),j>0&&T.push(new k(U,-.03,j))}}const S=new k,O=new k;function B(w,A,I,H){const G=Math.cos(I);r.position.set(H.x+w*Math.sin(A)*G,H.y+w*Math.sin(I),H.z+w*Math.cos(A)*G),r.up.set(0,1,0),r.lookAt(H)}function V(w){r.aspect=w,r.fov=Fe;let A=o;const I=t.clone();for(let H=0;H<6;H++){B(A,0,ot,I),r.updateMatrixWorld(!0),r.updateProjectionMatrix();let G=1/0,Y=-1/0,U=1/0,j=-1/0;for(const xe of T)S.copy(xe).project(r),G=Math.min(G,S.x),Y=Math.max(Y,S.x),U=Math.min(U,S.y),j=Math.max(j,S.y);const $=Math.max((Y-G)/Sa,(j-U)/Aa);A*=1+($-1)*.92,A=fe.clamp(A,2.4,14);const X=(U+j)*.5,se=2*A*Math.tan(r.fov*io/2);O.set(0,1,0).applyQuaternion(r.quaternion),I.addScaledVector(O,(X-Ra)*se/2),I.x=t.x}o=A,t.copy(I),l.target=A,s.target=I.x,u.target=I.y,h.target=I.z}function Z(){if(v===null)return null;const w=ce.seat(f,v);return{x:w.cards[1].x,z:w.cards[1].z}}function Q(){let w=0,A=ot,I=o,H=Fe;const G=t.x;let Y=t.y,U=t.z;const j=Z();if(j){const $=fe.clamp(p,0,1);U+=(j.z-t.z)*.26*$,Y+=.02*$,w+=fe.clamp(j.x*.09,-.07,.07)*$,I*=1-.075*$,A-=.035*$}for(const $ of g){const X=ya($);if($.kind==="allin")I*=1-.17*X,A-=.1*X,H-=3.2*X,Y+=.03*X;else{const se=fe.clamp($.t/$.dur,0,1),xe=se*se*(3-2*se);w+=(xe-.5)*.2*X,A+=Math.sin(se*Math.PI)*.05*X,I*=1-.06*X}}a.target=w,n.target=A,l.target=I,i.target=H,s.target=G,u.target=Y,h.target=U}function K(w){if(w.beta===null||w.gamma===null)return;x||(x={beta:w.beta,gamma:w.gamma});const A=fe.clamp((w.gamma-x.gamma)/22,-1,1),I=fe.clamp((w.beta-x.beta)/22,-1,1);y=A*.046,L=-I*.028,x.beta+=(w.beta-x.beta)*.004,x.gamma+=(w.gamma-x.gamma)*.004}async function J(){if(E)return!0;if(typeof DeviceOrientationEvent>"u")return!1;const w=DeviceOrientationEvent;try{if(typeof w.requestPermission=="function"&&await w.requestPermission()!=="granted")return!1}catch{return!1}return window.addEventListener("deviceorientation",K,{passive:!0}),E=!0,!0}const ee=le.on("cam:focus",({seat:w,intensity:A})=>{w===null?(v=null,p=0):(v=ce.slotFor(w,c,f),p=A)}),ue=le.on("cam:shake",({amount:w,ms:A})=>{b=Math.min(.03,Math.max(b,.004+w*.02)),R=Math.max(.08,A/1e3),_=0}),Me=le.on("fx:burst",({kind:w})=>{(w==="allin"||w==="bomb")&&C("allin")}),ye=le.on("hand:showdown",()=>C("showdown"));function C(w){for(let A=g.length-1;A>=0;A--)g[A].kind===w&&g.splice(A,1);g.push(w==="allin"?{kind:w,t:0,dur:1.95,attack:.26,release:.8}:{kind:w,t:0,dur:2.9,attack:.55,release:.95})}const z=new k,N=new k,we=new k;return{camera:r,resize(w,A){const I=Math.max(.3,w/Math.max(1,A));V(I),a.set(0),n.set(ot),l.set(o),s.set(t.x),u.set(t.y),h.set(t.z),i.set(Fe),r.aspect=I,r.fov=Fe,r.updateProjectionMatrix()},update(w,A){for(let U=g.length-1;U>=0;U--)g[U].t+=w,g[U].t>=g[U].dur&&g.splice(U,1);Q(),a.step(w),n.step(w),l.step(w),s.step(w),u.step(w),h.step(w),i.step(w),d.step(w);const I=.0105*Math.sin(A*.113)+.0052*Math.sin(A*.291+1.3),H=.0068*Math.sin(A*.083+2.2),G=Math.min(1,w*3.2);if(P+=(y-P)*G,F+=(L-F)*G,e.set(s.value,u.value,h.value),B(l.value,a.value+I+P,fe.clamp(n.value+H+F,.28,1.36),e),b>2e-4){_+=w;const U=Math.min(1,_/R),j=(1-U)*(1-U),$=A*47,X=Math.sin($)*.6+Math.sin($*2.37+1.1)*.4,se=Math.sin($*1.71+2.4)*.6+Math.sin($*3.11)*.4;N.setFromMatrixColumn(r.matrixWorld,0),we.setFromMatrixColumn(r.matrixWorld,1),z.copy(N).multiplyScalar(X*b*j).addScaledVector(we,se*b*j*.8),r.position.add(z),d.target=X*.006*j,U>=1&&(b=0,d.target=0)}Math.abs(d.value)>1e-5&&r.rotateZ(d.value);const Y=i.value;Math.abs(r.fov-Y)>.001&&(r.fov=Y,r.updateProjectionMatrix()),r.updateMatrixWorld()},focus(w,A){if(w===null){v=null,p=0;return}v=ce.slotFor(w,c,f),p=A},shake(w,A){b=Math.min(.03,Math.max(b,.004+w*.02)),R=Math.max(.08,A/1e3),_=0},allIn(){C("allin")},showdown(){C("showdown")},setTableSize(w){f=Math.max(2,Math.min(9,Math.round(w)))},setHeroSeat(w){c=w},enableTilt:J,settled(){return g.length===0&&b<=2e-4&&a.settled&&n.settled&&l.settled&&s.settled&&u.settled&&h.settled&&i.settled},dispose(){ee(),ue(),Me(),ye(),E&&window.removeEventListener("deviceorientation",K)}}}const at=`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`,Ta=`
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
`,Ca=`
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
`,Fa=`
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
`,Pa=`
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
uniform vec2  uVigScale;      // normalises the vignette to the long screen axis
uniform vec3  uLift;          // lifted-black tint, keeps OLED shadows from crushing
uniform float uSaturation;

${We}

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

  // ── vignette in linear light: an optical falloff, not a black overlay.
  //    Measured against the long screen axis so a 19.5:9 phone darkens at
  //    the top and bottom, where the chrome lives, and not down the sides.
  float vigR = length(fromCenter * uVigScale) * 2.0;
  float vig = 1.0 - uVignette * smoothstep(uVignetteSoft, 1.12, vigR);
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
`;function $e(r,e,t,o,a){const n=new go(Math.max(1,r),Math.max(1,e),{type:t,format:wo,minFilter:lt,magFilter:lt,depthBuffer:a,stencilBuffer:!1,generateMipmaps:!1,samples:o});return n.texture.colorSpace=Yt,n.texture.wrapS=Xe,n.texture.wrapT=Xe,n}function La(r){const e=new ut;e.setAttribute("position",new zt([-1,-1,0,3,-1,0,-1,3,0],3)),e.setAttribute("uv",new zt([0,0,2,0,0,2],2));const t=new Mt,o=new vo(-1,1,1,-1,0,1),a=new ke,n=new q(e,a);n.frustumCulled=!1,t.add(n);const l=r.getContext(),u=!!l.getExtension("EXT_color_buffer_half_float")||!!l.getExtension("EXT_color_buffer_float")?xo:bo,h=new ge({uniforms:{tScene:{value:null},uTexel:{value:new re},uThreshold:{value:1.3},uKnee:{value:.5},uWarmBias:{value:.45}},vertexShader:at,fragmentShader:Ta,depthTest:!1,depthWrite:!1,toneMapped:!1}),i=new ge({uniforms:{tSrc:{value:null},uDirection:{value:new re}},vertexShader:at,fragmentShader:Ca,depthTest:!1,depthWrite:!1,toneMapped:!1}),d=new ge({uniforms:{tSrc:{value:null},uTexel:{value:new re}},vertexShader:at,fragmentShader:Fa,depthTest:!1,depthWrite:!1,toneMapped:!1}),f=new ge({uniforms:{tScene:{value:null},tBloomNear:{value:null},tBloomWide:{value:null},uExposure:{value:1.12},uBloomNear:{value:.5},uBloomWide:{value:.38},uAberration:{value:.0055},uVignette:{value:.72},uVignetteSoft:{value:.34},uGrain:{value:.017},uTime:{value:0},uResolution:{value:new re(1,1)},uVigScale:{value:new re(1,1)},uLift:{value:new D(.006,.008,.014)},uSaturation:{value:1.08}},vertexShader:at,fragmentShader:Pa,depthTest:!1,depthWrite:!1,toneMapped:!1});let c="high",v=!0,p=1,g=1,b=1,_=1.12,R=null,y=null,L=null,P=null,F=null;function x(){R?.dispose(),y?.dispose(),L?.dispose(),P?.dispose(),F?.dispose(),R=y=L=P=F=null}function E(){if(x(),!v)return;const S=Math.max(1,Math.round(p*b)),O=Math.max(1,Math.round(g*b));R=$e(S,O,u,c==="high"?4:0,!0);const V=Math.max(1,S>>1),Z=Math.max(1,O>>1);if(y=$e(V,Z,u,0,!1),L=$e(V,Z,u,0,!1),c==="high"){const K=Math.max(1,S>>2),J=Math.max(1,O>>2);P=$e(K,J,u,0,!1),F=$e(K,J,u,0,!1)}f.uniforms.uResolution.value.set(S,O);const Q=Math.max(S,O);f.uniforms.uVigScale.value.set(S/Q,O/Q)}function T(S,O){n.material=S,r.setRenderTarget(O),r.render(t,o)}return{get enabled(){return v},setSize(S,O,B){p=S,g=O,b=B,E()},setQuality(S){S!==c&&(c=S,v=S!=="low",f.uniforms.uBloomWide.value=S==="high"?.38:0,f.uniforms.uBloomNear.value=S==="high"?.5:.44,f.uniforms.uAberration.value=S==="high"?.0055:.003,f.uniforms.uGrain.value=S==="high"?.017:.012,E())},setExposure(S){_=S,f.uniforms.uExposure.value=S,r.toneMappingExposure=S},render(S,O,B){if(!v||!R||!y||!L){r.setRenderTarget(null),r.render(S,O);return}r.setRenderTarget(R),r.clear(),r.render(S,O);const V=y.width,Z=y.height;h.uniforms.tScene.value=R.texture,h.uniforms.uTexel.value.set(1/R.width,1/R.height),T(h,y),i.uniforms.tSrc.value=y.texture,i.uniforms.uDirection.value.set(1/V,0),T(i,L),i.uniforms.tSrc.value=L.texture,i.uniforms.uDirection.value.set(0,1/Z),T(i,y),P&&F?(d.uniforms.tSrc.value=y.texture,d.uniforms.uTexel.value.set(1.5/V,1.5/Z),T(d,F),i.uniforms.tSrc.value=F.texture,i.uniforms.uDirection.value.set(0,1/F.height),T(i,P),f.uniforms.tBloomWide.value=P.texture):f.uniforms.tBloomWide.value=y.texture,f.uniforms.tScene.value=R.texture,f.uniforms.tBloomNear.value=y.texture,f.uniforms.uTime.value=B,f.uniforms.uExposure.value=_,T(f,null)},dispose(){x(),e.dispose(),h.dispose(),i.dispose(),d.dispose(),f.dispose(),a.dispose()}}}const Pe=new k(.12,2.3,.34),Le=new k(0,0,-.14),$t=30,Ea=2.2,pt=1.34,jt=.34;function za(){const r=new bt;r.name="lights";const e=new Mo(16767147,$t);e.position.copy(Pe),e.angle=Math.atan(Ea/Pe.y)*1.04,e.penumbra=.86,e.decay=2,e.distance=8.5,e.castShadow=!0,e.shadow.mapSize.set(1024,1024),e.shadow.camera.near=1.05,e.shadow.camera.far=4.2,e.shadow.bias=-6e-4,e.shadow.normalBias=.022,e.shadow.radius=3,e.shadow.focus=1,e.target.position.copy(Le),r.add(e),r.add(e.target);const t=new yo(10338559,.66);t.position.set(-1.7,1.45,-3.25),t.target.position.set(.05,0,.1),t.castShadow=!1,r.add(t),r.add(t.target);const o=new So(1911365,662548,.26);o.position.set(0,2,0),r.add(o);const a=new Dt(16763277,.9,4.2,2);a.position.set(0,.55,2.2),r.add(a);const n=new Dt(8038112,.46,3.4,2);n.position.set(0,.44,-2.25),r.add(n);const l=Pe.distanceTo(Le),s=.7,u=pt+(.075-pt)*(s/l),h=new Ao(u,pt*1.05,s,44,1,!0);h.translate(0,s/2,0);const i={uColor:{value:new D(16765600)},uIntensity:{value:.055},uHeight:{value:s},uTime:{value:0}},d=new ge({uniforms:i,vertexShader:Xo,fragmentShader:Zo,transparent:!0,depthWrite:!1,blending:Ro,side:qe,toneMapped:!1}),f=new q(h,d);f.name="key-shaft",f.renderOrder=3,f.frustumCulled=!1,r.add(f);const c=new k(0,1,0),v=new k;function p(){f.position.copy(Le),v.copy(e.position).sub(Le).normalize(),f.quaternion.setFromUnitVectors(c,v)}p();const g={x:Le.x,z:Le.z,inner:.52,outer:1.78,strength:jt},b=new D(16767147),_=new D(16767147);let R=0,y=0,L=0,P="high";const F=new D;return{group:r,key:e,rim:t,pool:g,update(x){const E=1+.024*Math.sin(x*.31)+.013*Math.sin(x*.727+1.7)+.007*Math.sin(x*1.63+.4);y>5e-4&&(y*=Math.exp(-L*.016),y<5e-4&&(y=0)),e.intensity=$t*E*(1+y),e.position.set(Pe.x+.028*Math.sin(x*.171),Pe.y+.018*Math.sin(x*.113+2.1),Pe.z+.024*Math.cos(x*.137)),t.intensity=.66*(1+.05*Math.sin(x*.21+3.1)),a.intensity=.9*(1+.09*Math.sin(x*.43+1.1)),F.copy(b).lerp(_,R),e.color.copy(F),i.uColor.value.copy(F),i.uTime.value=x,i.uIntensity.value=(P==="high"?.055:.032)*(1+y*1.6),P!=="low"&&p(),g.strength=jt+y*.18},setQuality(x){P=x;const E=x==="low";e.castShadow=!E,e.shadow.mapSize.set(x==="high"?1024:768,x==="high"?1024:768),e.shadow.map&&(e.shadow.map.dispose(),e.shadow.map=null),f.visible=!E,t.visible=!0,a.visible=!E,n.visible=x==="high",o.intensity=E?.46:.28},setAccent(x,E){_.set(x),R=fe.clamp(E,0,1)},pulse(x,E){y=Math.max(y,x),L=1e3/Math.max(60,E)},dispose(){h.dispose(),d.dispose(),e.dispose(),t.dispose(),o.dispose(),a.dispose(),n.dispose(),e.shadow.map&&e.shadow.map.dispose()}}}function Da(){const r=new Mt,e=[],t=new Co(9,5.4,9),o=new ke({color:new D("#0a0e16"),side:Qt,toneMapped:!1});r.add(new q(t,o)),e.push(t,o);const a=new Ie(2.6,3.8),n=new ge({uniforms:{uColorA:{value:new D("#fff0d6").multiplyScalar(3)},uColorB:{value:new D("#c9873c").multiplyScalar(.9)},uFalloff:{value:1.5}},vertexShader:Ko,fragmentShader:qo,side:qe,toneMapped:!1}),l=new q(a,n);l.position.set(0,2.45,-.1),l.rotation.x=Math.PI/2,r.add(l),e.push(a,n);const s=new Ie(6.4,3.2),u=new ke({color:new D("#2b3d63").multiplyScalar(.55),side:qe,toneMapped:!1});for(const p of[-1,1]){const g=new q(s,u);g.position.set(p*3.1,.9,0),g.rotation.y=p*-Math.PI*.5,r.add(g)}e.push(s,u);const h=new Ie(7.4,1.9),i=new ke({color:new D("#7a4a1c").multiplyScalar(.6),side:qe,toneMapped:!1}),d=new q(h,i);d.position.set(0,.2,-3.4),r.add(d),e.push(h,i);const f=new Ie(9,9),c=new ke({color:new D("#05070c"),side:qe,toneMapped:!1}),v=new q(f,c);return v.position.y=-1.6,v.rotation.x=-Math.PI/2,r.add(v),e.push(f,c),{scene:r,dispose(){for(const p of e)p.dispose()}}}function Ia(r){const e=new Mt;e.name="royale-stage";const t=new _o(r);t.compileEquirectangularShader();const o=Da(),a=t.fromScene(o.scene,.035,.1,30),n=a.texture;o.dispose(),t.dispose(),e.environment=n,e.environmentIntensity=.9,e.background=null,e.fog=new It(395537,.05);const l={uTop:{value:new D("#0a0f1c")},uHorizon:{value:new D("#05070e")},uBottom:{value:new D("#020307")},uGlow:{value:new D("#1d2843")},uGlowStrength:{value:.3},uTime:{value:0}},s=new To(19,40,24),u=new ge({uniforms:l,vertexShader:$o,fragmentShader:jo,side:Qt,depthWrite:!1,depthTest:!1,toneMapped:!1,fog:!1}),h=new q(s,u);h.name="backdrop",h.frustumCulled=!1,h.renderOrder=-1e3,e.add(h);const i=Ma();e.add(i.group);const d=za();e.add(d.group),i.setLightPool(d.pool.x,d.pool.z,d.pool.inner,d.pool.outer,d.pool.strength);const f=new bt;return f.name="play",e.add(f),{scene:e,root:f,table:i,lights:d,envMap:n,update(c){d.update(c),i.setLightPool(d.key.position.x*.35,d.key.position.z*.35-.05,d.pool.inner,d.pool.outer,d.pool.strength),i.update(c),l.uTime.value=c},setQuality(c){d.setQuality(c),i.setQuality(c),e.environmentIntensity=c==="low"?.7:.9,e.fog instanceof It&&(e.fog.density=c==="low"?.042:.05)},setSkin(c){i.setSkin(c),c.betLineColor&&d.setAccent(c.betLineColor,.16)},dispose(){i.dispose(),d.dispose(),s.dispose(),u.dispose(),a.dispose(),e.clear()}}}const ie=1/60,qt=5,ka=900,Oa=50,Ee=12,Ba=90,Wa=24,Ua=2200,Kt=3,Ha=2e3,Na=4e3,Ga=420,nt={mid:{fps:42,p90:34},high:{fps:56,p90:22}},rt={mid:{fps:32,p90:46},high:{fps:46,p90:30}},Xt={low:1.5,mid:2,high:2.5},Va=["table:state","hand:start","hand:deal-hole","hand:deal-board","hand:action","hand:turn","hand:pot-update","hand:collect","hand:showdown","hand:award","hand:end","hand:muck","cam:focus","cam:shake","fx:burst","fx:flash","social:reaction","econ:equip","nav:route"];function je(){return{x:0,y:0,visible:!1,depth:1,scale:1}}function $a(){const e=navigator.deviceMemory??4,t=navigator.hardwareConcurrency??4;return e<=2||t<=2?"low":e<=4||t<=4?"mid":"high"}async function ja(r){const e=$a(),t=new Fo({canvas:r,antialias:e!=="mid",alpha:!1,depth:!0,stencil:!1,powerPreference:"high-performance",preserveDrawingBuffer:!1,failIfMajorPerformanceCaveat:!1});t.outputColorSpace=Zt,t.toneMapping=Po,t.toneMappingExposure=1.12,t.shadowMap.enabled=!0,t.shadowMap.type=Lo,t.shadowMap.autoUpdate=!0,t.autoClear=!0,t.setClearColor(263434,1),t.info.autoReset=!1,Jo({maxAnisotropy:t.capabilities.getMaxAnisotropy(),scale:e==="low"?.5:1});const o=Ia(t),a=_a(),n=La(t),l={seats:Array.from({length:9},je),board:Array.from({length:5},je),pot:je(),dealer:je(),muck:je(),width:1,height:1,version:0};let s=e,u=9,h=0,i=!1,d=0,f=0,c=0,v=0,p=1,g=1,b=!0,_=0,R=performance.now(),y=0,L=!1,P=0,F=!1;const x=[];let E=0,T=Ee,S=Number.NEGATIVE_INFINITY,O=!1,B=!1;const V=new Set,Z=new Set,Q=new k;function K(){const m=r.clientWidth||window.innerWidth||1,M=r.clientHeight||window.innerHeight||1;if(m===p&&M===g)return;p=m,g=M;const W=Math.min(window.devicePixelRatio||1,Xt[s]);t.setPixelRatio(W),t.setSize(m,M,!1),a.resize(m,M),n.setSize(m,M,W),l.width=m,l.height=M,b=!0}function J(m,M){Q.copy(m).project(a.camera);const W=Q.z>1;M.x=(Q.x*.5+.5)*p,M.y=(-Q.y*.5+.5)*g,M.depth=fe.clamp(Q.z*.5+.5,0,1),M.visible=!W&&M.x>-140&&M.x<p+140&&M.y>-140&&M.y<g+140;const Re=a.camera.position.distanceTo(m),he=Math.tan(a.camera.fov*Math.PI/360)*Re;M.scale=he>1e-5?g/(2*he):1}function ee(){const m=ce.seats(u);for(let M=0;M<l.seats.length;M++){if(M>=u){l.seats[M].visible=!1;continue}const W=ce.slotFor(M,h,u);J(m[W].plate,l.seats[M])}for(let M=0;M<5;M++)J(ce.BOARD_SLOTS[M],l.board[M]);J(ce.POT_CENTER,l.pot),J(ce.DEALER_POS,l.dealer),J(ce.MUCK_POS,l.muck),l.version++}function ue(m){s=m,o.setQuality(m),n.setQuality(m);const M=Math.min(window.devicePixelRatio||1,Xt[m]);t.setPixelRatio(M),t.setSize(p,g,!1),n.setSize(p,g,M),t.shadowMap.enabled=m!=="low",b=!0,x.length=0,T=Ee}function Me(m){O=!0;try{le.emit("perf:tier",{tier:s,fps:Math.round(m)})}finally{O=!1}}function ye(m,M){return s==="high"?m<rt.high.fps||M>rt.high.p90?"mid":"high":s==="mid"?m<rt.mid.fps||M>rt.mid.p90?"low":m>=nt.high.fps&&M<=nt.high.p90?"high":"mid":m>=nt.mid.fps&&M<=nt.mid.p90?"mid":"low"}function C(m){const M=x.slice().sort((He,co)=>He-co);x.length=0,T=Ee;const W=M[M.length>>1]||16.7,Re=M[Math.min(M.length-1,Math.floor(M.length*.9))]||W,he=1e3/W,et=ye(he,Re);et!==s&&(ue(et),S=m,Me(he))}function z(m,M){if(B||!L)return;if(T>0){T--,E=m;return}if(M>Ha){T=Kt;return}x.length===0&&(E=m),x.push(M);const W=x.length>=Ba,Re=x.length>=Wa&&m-E>=Ua;if(!(!W&&!Re)){if(m-S<Na){x.length=0;return}C(m)}}function N(){R=performance.now(),b=!0}function we(m){if(d=requestAnimationFrame(we),!i)return;const M=m-f;let W=M/1e3;if(f=m,(!Number.isFinite(W)||W<0)&&(W=ie),W>.25&&(W=ie),_===0&&a.settled()&&m-R>ka){if(T=Math.max(T,Kt),!b){if(m-y<Oa)return;y=m}}else z(m,Number.isFinite(M)&&M>0?M:ie*1e3);b=!1,t.info.reset(),v+=W,c+=W;let he=0;for(;c>=ie&&he<qt;){a.update(ie,v-c+ie);for(const He of V)He(ie,v);c-=ie,he++}he===qt&&(c=0);const et=c/ie;o.update(v);for(const He of Z)He(et,W,v);a.camera.updateMatrixWorld(),ee(),n.render(o.scene,a.camera,v)}function w(){i||F||(i=!0,f=performance.now(),R=f,c=0,b=!0,T=Math.max(T,Ee),d||(d=requestAnimationFrame(we)))}function A(){i=!1,x.length=0,d&&(cancelAnimationFrame(d),d=0)}let I=null,H=null,G=!1,Y=!1;function U(){if(I)for(let m=0;m<9;m++)I.avatars.setVisible(m,Y)}function j(m){Y=m,U(),N()}function $(){G||H||F||(G=!0,uo(()=>import("./dealing-86T9wBRa.js"),__vite__mapDeps([0,1,2,3]),import.meta.url).then(m=>{G=!1,!(F||H)&&(I=m.initDealing({tier:s}),H=()=>{m.disposeDealing(),I=null},U(),N())}).catch(m=>{G=!1,console.error("[stage] play systems failed to load",m)}))}function X(m){L=m,r.classList.toggle("is-hidden",!m),P&&(clearTimeout(P),P=0),m?($(),w(),x.length=0,T=Ee,S=performance.now(),K(),a.camera.updateMatrixWorld(),ee(),N()):i&&(P=window.setTimeout(()=>{P=0,L||A()},Ga))}let se=0,xe=0;function lo(){const m=++se;return xe=m,X(!0),()=>{xe===m&&(xe=0,X(!1))}}const Se=[];for(const m of Va)Se.push(le.on(m,N));Se.push(le.on("table:state",({state:m,you:M})=>{const W=m.seats.length;W>=2&&W<=9&&(u=W,a.setTableSize(W)),M>=0&&(h=M,a.setHeroSeat(M)),N()})),Se.push(le.on("econ:equip",({item:m})=>{if(m.kind!=="table-skin"&&m.kind!=="felt")return;const M=m.params;o.setSkin(M),N()})),Se.push(le.on("fx:burst",({kind:m})=>{(m==="allin"||m==="royal"||m==="quads")&&o.lights.pulse(.5,700),(m==="chips-win"||m==="level-up")&&o.lights.pulse(.22,480)})),Se.push(le.on("perf:tier",({tier:m})=>{O||m===s||(B=!0,ue(m),N())}));const Ue=()=>K();window.addEventListener("resize",Ue,{passive:!0}),window.visualViewport?.addEventListener("resize",Ue,{passive:!0});const _t=typeof ResizeObserver<"u"?new ResizeObserver(Ue):null;_t?.observe(r);const Tt=()=>{f=performance.now(),x.length=0,T=Ee,document.hidden||N()};document.addEventListener("visibilitychange",Tt);const Ae=()=>{a.enableTilt(),window.removeEventListener("pointerdown",Ae),window.removeEventListener("touchstart",Ae)};window.addEventListener("pointerdown",Ae,{passive:!0,once:!1}),window.addEventListener("touchstart",Ae,{passive:!0,once:!1});const Ct=m=>{m.preventDefault(),i=!1},Ft=()=>{K(),ue(s),f=performance.now(),i=!0,N()};r.addEventListener("webglcontextlost",Ct),r.addEventListener("webglcontextrestored",Ft),K(),ue(e),a.update(ie,0),o.update(0);try{await t.compileAsync(o.scene,a.camera)}catch{t.compile(o.scene,a.camera)}n.render(o.scene,a.camera,0),ee();const Pt={scene:o.scene,camera:a.camera,root:o.root,renderer:t,stage:o,rig:a,anchors:l,get tier(){return s},get running(){return i},get visible(){return L},start:w,stop:A,setVisible:X,claimStage:lo,setSeatMedallions:j,getAnchor(m){const M=l.seats[Math.max(0,Math.min(l.seats.length-1,m))];return{x:M.x,y:M.y}},setQuality:ue,setTableSize(m){u=Math.max(2,Math.min(9,Math.round(m))),a.setTableSize(u),N()},setHeroSeat(m){h=m,a.setHeroSeat(m),N()},setSkin(m){o.setSkin(m),N()},setExposure(m){n.setExposure(m),N()},onFixedUpdate(m){return V.add(m),()=>V.delete(m)},onFrame(m){return Z.add(m),()=>Z.delete(m)},requestRender(){N()},setContinuous(m){_=Math.max(0,_+(m?1:-1)),m&&N()},resize(){p=-1,K()},dispose(){F=!0,A(),P&&(clearTimeout(P),P=0),H?.(),H=null;for(const m of Se)m();window.removeEventListener("resize",Ue),window.visualViewport?.removeEventListener("resize",Ue),_t?.disconnect(),document.removeEventListener("visibilitychange",Tt),window.removeEventListener("pointerdown",Ae),window.removeEventListener("touchstart",Ae),r.removeEventListener("webglcontextlost",Ct),r.removeEventListener("webglcontextrestored",Ft),a.dispose(),n.dispose(),o.dispose(),t.dispose()}},Lt=window;return Lt.__royale=Object.assign(Lt.__royale??{},{renderer:Pt}),X(!1),Me(60),Pt}function qa(){return window.__royale?.renderer??null}const Za=Object.freeze(Object.defineProperty({__proto__:null,getStageHandle:qa,initRenderer:ja},Symbol.toStringTag,{value:"Module"}));export{qa as g,ce as l,Za as r,dt as t};
