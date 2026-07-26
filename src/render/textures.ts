/**
 * Procedural texture factory.
 *
 * Royale ships zero image assets: every map in the scene is synthesised here
 * with canvas2D + tileable value noise at boot, cached by key, and reused by
 * the table, the cards and the chips. Sizes are mobile-sane (512 by default,
 * 1024 only where the eye lands), and the whole set generates in a handful of
 * milliseconds because the noise is integer-hashed rather than sorted.
 */
import * as THREE from 'three';

// ─────────────────────────── tileable noise ───────────────────────────

function ihash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function wrap(v: number, n: number): number {
  return ((v % n) + n) % n;
}

/** Tileable value noise with period `period` in both axes. */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = wrap(ix, period);
  const y0 = wrap(iy, period);
  const x1 = wrap(ix + 1, period);
  const y1 = wrap(iy + 1, period);
  const a = ihash(x0, y0, seed);
  const b = ihash(x1, y0, seed);
  const c = ihash(x0, y1, seed);
  const d = ihash(x1, y1, seed);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

/** Tileable fBm. `x`,`y` are expressed in lattice units of `period`. */
function fbm(x: number, y: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * f, y * f, period * f, seed + i * 1013);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged fBm — the sharp creases in leather and the fibre in wood. */
function ridged(x: number, y: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vnoise(x * f, y * f, period * f, seed + i * 733) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.52;
    f *= 2;
  }
  return sum / norm;
}

// ─────────────────────────── canvas helpers ───────────────────────────

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

function surface(w: number, h: number): Surface {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('[textures] 2D context unavailable');
  return { canvas, ctx, w, h };
}

/** Rasterises a height field into a tangent-space normal map. */
function heightToNormal(height: Float32Array, w: number, h: number, strength: number): Surface {
  const s = surface(w, h);
  const img = s.ctx.createImageData(w, h);
  const px = img.data;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const yp = ((y + 1) % h) * w;
    const yc = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const dx = (height[yc + xp] - height[yc + xm]) * strength;
      const dy = (height[yp + x] - height[ym + x]) * strength;
      let nx = -dx;
      let ny = -dy;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      const i = (yc + x) * 4;
      px[i] = (nx * 0.5 + 0.5) * 255;
      px[i + 1] = (ny * 0.5 + 0.5) * 255;
      px[i + 2] = nz * inv * 255;
      px[i + 3] = 255;
    }
  }
  s.ctx.putImageData(img, 0, 0);
  return s;
}

/** Writes a single-channel field as a greyscale image (roughness / masks). */
function fieldToGrey(field: Float32Array, w: number, h: number): Surface {
  const s = surface(w, h);
  const img = s.ctx.createImageData(w, h);
  const px = img.data;
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(field[i] * 255)));
    const o = i * 4;
    px[o] = v;
    px[o + 1] = v;
    px[o + 2] = v;
    px[o + 3] = 255;
  }
  s.ctx.putImageData(img, 0, 0);
  return s;
}

// ─────────────────────────── factory ───────────────────────────

export interface TextureOptions {
  /** renderer.capabilities.getMaxAnisotropy() */
  maxAnisotropy: number;
  /** 1 = full size, 0.5 = half (low tier) */
  scale: number;
}

export type TextureKey =
  | 'felt-normal'
  | 'felt-rough'
  | 'leather-normal'
  | 'leather-rough'
  | 'suede-normal'
  | 'carbon-normal'
  | 'wood-color'
  | 'wood-normal'
  | 'wood-rough'
  | 'metal-rough'
  | 'metal-normal'
  | 'metal-aniso'
  | 'card-varnish'
  | 'blue-noise'
  | 'noise-rgba'
  | 'radial-shadow'
  | 'rail-ao'
  | `logo:${string}`;

export class TextureFactory {
  private cache = new Map<string, THREE.Texture>();
  private opts: TextureOptions;

  constructor(opts: TextureOptions) {
    this.opts = opts;
  }

  private size(base: number): number {
    const s = Math.max(64, Math.round((base * this.opts.scale) / 64) * 64);
    return Math.min(base, s);
  }

  private finish(
    s: Surface,
    o: {
      srgb?: boolean;
      repeat?: boolean;
      aniso?: number;
      nearest?: boolean;
      mips?: boolean;
    } = {},
  ): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(s.canvas);
    t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (o.repeat !== false) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
    } else {
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
    }
    t.magFilter = o.nearest ? THREE.NearestFilter : THREE.LinearFilter;
    t.minFilter = o.mips === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = o.mips !== false;
    t.anisotropy = Math.min(o.aniso ?? 4, this.opts.maxAnisotropy);
    t.needsUpdate = true;
    return t;
  }

  get(key: TextureKey): THREE.Texture {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const made = this.build(key);
    this.cache.set(key, made);
    return made;
  }

  /** Warms the cache so nothing hitches on the first frame of a hand. */
  warm(keys: TextureKey[]): void {
    for (const k of keys) this.get(k);
  }

  private build(key: TextureKey): THREE.Texture {
    if (key.startsWith('logo:')) return this.buildLogo(key.slice(5));
    switch (key) {
      case 'felt-normal':
        return this.buildFeltNormal();
      case 'felt-rough':
        return this.buildFeltRough();
      case 'leather-normal':
        return this.buildLeatherNormal();
      case 'leather-rough':
        return this.buildLeatherRough();
      case 'suede-normal':
        return this.buildSuedeNormal();
      case 'carbon-normal':
        return this.buildCarbonNormal();
      case 'wood-color':
        return this.buildWoodColor();
      case 'wood-normal':
        return this.buildWoodNormal();
      case 'wood-rough':
        return this.buildWoodRough();
      case 'metal-rough':
        return this.buildMetalRough();
      case 'metal-normal':
        return this.buildMetalNormal();
      case 'metal-aniso':
        return this.buildMetalAniso();
      case 'card-varnish':
        return this.buildCardVarnish();
      case 'blue-noise':
        return this.buildBlueNoise();
      case 'noise-rgba':
        return this.buildNoiseRGBA();
      case 'radial-shadow':
        return this.buildRadialShadow();
      case 'rail-ao':
        return this.buildRailAO();
      default:
        return this.buildNoiseRGBA();
    }
  }

  // ── felt ──────────────────────────────────────────────────────────

  private feltHeight(n: number): Float32Array {
    const field = new Float32Array(n * n);
    const period = 32;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x / n) * period;
        const v = (y / n) * period;
        // interlocking warp/weft plus a fuzzy nap on top
        const warp = 0.5 + 0.5 * Math.sin(u * Math.PI * 2);
        const weft = 0.5 + 0.5 * Math.sin(v * Math.PI * 2);
        const weave = warp * weft * 0.55 + (1 - warp) * (1 - weft) * 0.28;
        const nap = fbm(u * 2.4, v * 2.4, period * 2, 4, 91);
        const fine = vnoise(u * 8, v * 8, period * 8, 17);
        field[y * n + x] = weave * 0.42 + nap * 0.4 + fine * 0.18;
      }
    }
    return field;
  }

  private buildFeltNormal(): THREE.Texture {
    const n = this.size(512);
    return this.finish(heightToNormal(this.feltHeight(n), n, n, 2.4), { aniso: 8 });
  }

  private buildFeltRough(): THREE.Texture {
    const n = this.size(512);
    const src = this.feltHeight(n);
    const out = new Float32Array(n * n);
    for (let i = 0; i < out.length; i++) out[i] = 0.78 + src[i] * 0.2;
    return this.finish(fieldToGrey(out, n, n), { aniso: 4 });
  }

  // ── leather ───────────────────────────────────────────────────────

  private leatherHeight(n: number): Float32Array {
    const field = new Float32Array(n * n);
    const period = 24;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x / n) * period;
        const v = (y / n) * period;
        const pebble = ridged(u * 1.9, v * 1.9, period * 2, 4, 311);
        const cells = 1 - fbm(u * 3.6, v * 3.6, period * 4, 3, 907);
        const crease = Math.pow(ridged(u * 0.8, v * 0.8, period, 3, 55), 2.4);
        const pores = vnoise(u * 11, v * 11, period * 11, 71);
        field[y * n + x] =
          pebble * 0.44 + cells * 0.22 + pores * 0.12 - crease * 0.3 + 0.3;
      }
    }
    return field;
  }

  private buildLeatherNormal(): THREE.Texture {
    const n = this.size(512);
    return this.finish(heightToNormal(this.leatherHeight(n), n, n, 3.6), { aniso: 8 });
  }

  private buildLeatherRough(): THREE.Texture {
    const n = this.size(512);
    const src = this.leatherHeight(n);
    const out = new Float32Array(n * n);
    for (let i = 0; i < out.length; i++) out[i] = 0.42 + (1 - src[i]) * 0.34;
    return this.finish(fieldToGrey(out, n, n), { aniso: 4 });
  }

  private buildSuedeNormal(): THREE.Texture {
    const n = this.size(512);
    const field = new Float32Array(n * n);
    const period = 40;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x / n) * period;
        const v = (y / n) * period;
        field[y * n + x] =
          fbm(u * 5, v * 5, period * 5, 3, 401) * 0.6 + vnoise(u * 14, v * 14, period * 14, 402) * 0.4;
      }
    }
    return this.finish(heightToNormal(field, n, n, 1.5), { aniso: 8 });
  }

  private buildCarbonNormal(): THREE.Texture {
    const n = this.size(512);
    const field = new Float32Array(n * n);
    const tiles = 8;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const tx = (x / n) * tiles;
        const ty = (y / n) * tiles;
        const cell = (Math.floor(tx) + Math.floor(ty)) & 1;
        const fx = tx - Math.floor(tx);
        const fy = ty - Math.floor(ty);
        // 2x2 twill: alternating tows running with the U or the V axis
        const along = cell === 0 ? fy : fx;
        const strands = 0.5 + 0.5 * Math.cos(along * Math.PI * 2 * 4);
        const dome = Math.sin(Math.PI * (cell === 0 ? fx : fy));
        const fine = vnoise((x / n) * 96, (y / n) * 96, 96, 88) * 0.12;
        field[y * n + x] = strands * 0.45 * dome + dome * 0.4 + fine;
      }
    }
    return this.finish(heightToNormal(field, n, n, 2.2), { aniso: 8 });
  }

  // ── wood ──────────────────────────────────────────────────────────

  private woodField(w: number, h: number): Float32Array {
    const field = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x / w) * 26;
        const v = (y / h) * 5;
        // rings stretched hard along U, warped by low-frequency noise
        const warp = fbm(u * 0.5, v * 0.5, 16, 4, 5) * 2.6;
        const rings = Math.sin((v * 5.5 + warp) * Math.PI * 2);
        const grain = ridged(u * 4.5, v * 0.9, 64, 3, 991);
        const pores = vnoise(u * 22, v * 3, 256, 6);
        field[y * w + x] = 0.5 + rings * 0.22 + grain * 0.3 + pores * 0.1 - 0.14;
      }
    }
    return field;
  }

  private buildWoodColor(): THREE.Texture {
    const w = this.size(1024);
    const h = this.size(256);
    const f = this.woodField(w, h);
    const s = surface(w, h);
    const img = s.ctx.createImageData(w, h);
    const px = img.data;
    // burled walnut: deep umber into a warm amber highlight
    const c0 = [0x24, 0x14, 0x0b];
    const c1 = [0x7a, 0x48, 0x1f];
    const c2 = [0xb0, 0x78, 0x3c];
    for (let i = 0; i < w * h; i++) {
      const t = Math.max(0, Math.min(1, f[i]));
      let r: number;
      let g: number;
      let b: number;
      if (t < 0.55) {
        const k = t / 0.55;
        r = c0[0] + (c1[0] - c0[0]) * k;
        g = c0[1] + (c1[1] - c0[1]) * k;
        b = c0[2] + (c1[2] - c0[2]) * k;
      } else {
        const k = (t - 0.55) / 0.45;
        r = c1[0] + (c2[0] - c1[0]) * k;
        g = c1[1] + (c2[1] - c1[1]) * k;
        b = c1[2] + (c2[2] - c1[2]) * k;
      }
      const o = i * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
    s.ctx.putImageData(img, 0, 0);
    return this.finish(s, { srgb: true, aniso: 8 });
  }

  private buildWoodNormal(): THREE.Texture {
    const w = this.size(1024);
    const h = this.size(256);
    return this.finish(heightToNormal(this.woodField(w, h), w, h, 1.6), { aniso: 8 });
  }

  private buildWoodRough(): THREE.Texture {
    const w = this.size(1024);
    const h = this.size(256);
    const f = this.woodField(w, h);
    const out = new Float32Array(w * h);
    // high-gloss lacquer, slightly broken over the open pores
    for (let i = 0; i < out.length; i++) out[i] = 0.1 + (1 - f[i]) * 0.16;
    return this.finish(fieldToGrey(out, w, h), { aniso: 8 });
  }

  // ── metal ─────────────────────────────────────────────────────────

  private metalField(w: number, h: number): Float32Array {
    const field = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x / w) * 512;
        const v = (y / h) * 8;
        // brush strokes run along U: high frequency there, near-flat across
        const streak =
          vnoise(u * 1.0, v * 0.12, 512, 21) * 0.5 +
          vnoise(u * 4.0, v * 0.25, 2048, 22) * 0.3 +
          vnoise(u * 16.0, v * 0.5, 8192, 23) * 0.2;
        const scratch = Math.pow(vnoise(u * 0.25, v * 2.5, 128, 24), 6) * 0.5;
        field[y * w + x] = streak * 0.85 + scratch;
      }
    }
    return field;
  }

  private buildMetalRough(): THREE.Texture {
    const w = this.size(1024);
    const h = this.size(128);
    const f = this.metalField(w, h);
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = 0.14 + f[i] * 0.3;
    return this.finish(fieldToGrey(out, w, h), { aniso: 16 });
  }

  private buildMetalNormal(): THREE.Texture {
    const w = this.size(1024);
    const h = this.size(128);
    return this.finish(heightToNormal(this.metalField(w, h), w, h, 0.9), { aniso: 16 });
  }

  /** RG = anisotropy direction, B = strength. Tangential brushing. */
  private buildMetalAniso(): THREE.Texture {
    const w = this.size(512);
    const h = this.size(64);
    const s = surface(w, h);
    const img = s.ctx.createImageData(w, h);
    const px = img.data;
    const f = this.metalField(w, h);
    for (let i = 0; i < w * h; i++) {
      const jitter = (f[i] - 0.5) * 0.16;
      const dirX = Math.cos(jitter);
      const dirY = Math.sin(jitter);
      const o = i * 4;
      px[o] = (dirX * 0.5 + 0.5) * 255;
      px[o + 1] = (dirY * 0.5 + 0.5) * 255;
      px[o + 2] = (0.7 + f[i] * 0.3) * 255;
      px[o + 3] = 255;
    }
    s.ctx.putImageData(img, 0, 0);
    return this.finish(s, { aniso: 8 });
  }

  // ── misc ──────────────────────────────────────────────────────────

  /** Roughness for card stock: linen press + a glossier varnish on top. */
  private buildCardVarnish(): THREE.Texture {
    const n = this.size(512);
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x / n) * 64;
        const v = (y / n) * 64;
        const linen =
          (0.5 + 0.5 * Math.sin(u * Math.PI * 2)) * 0.5 + (0.5 + 0.5 * Math.sin(v * Math.PI * 2)) * 0.5;
        const wear = fbm(u * 0.4, v * 0.4, 32, 4, 313);
        out[y * n + x] = 0.16 + linen * 0.1 + wear * 0.22;
      }
    }
    return this.finish(fieldToGrey(out, n, n), { aniso: 8 });
  }

  /**
   * Blue noise via iterative high-pass + rank normalisation. Four passes is
   * enough to move the energy off the low frequencies, which is all we need
   * for dithering and stochastic sampling.
   */
  private buildBlueNoise(): THREE.Texture {
    const n = 64;
    const total = n * n;
    let v = new Float32Array(total);
    for (let i = 0; i < total; i++) v[i] = ihash(i % n, (i / n) | 0, 4242);
    const tmp = new Float32Array(total);
    const low = new Float32Array(total);
    const kernel = [0.06136, 0.24477, 0.38774, 0.24477, 0.06136];
    const order = new Int32Array(total);
    for (let pass = 0; pass < 4; pass++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let acc = 0;
          for (let k = -2; k <= 2; k++) acc += v[y * n + wrap(x + k, n)] * kernel[k + 2];
          tmp[y * n + x] = acc;
        }
      }
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let acc = 0;
          for (let k = -2; k <= 2; k++) acc += tmp[wrap(y + k, n) * n + x] * kernel[k + 2];
          low[y * n + x] = acc;
        }
      }
      for (let i = 0; i < total; i++) v[i] = v[i] - low[i];
      for (let i = 0; i < total; i++) order[i] = i;
      const arr = v;
      const sorted = Array.from(order).sort((a, b) => arr[a] - arr[b]);
      const next = new Float32Array(total);
      for (let r = 0; r < total; r++) next[sorted[r]] = r / (total - 1);
      v = next;
    }
    const s = surface(n, n);
    const img = s.ctx.createImageData(n, n);
    for (let i = 0; i < total; i++) {
      const q = Math.round(v[i] * 255);
      const o = i * 4;
      img.data[o] = q;
      img.data[o + 1] = q;
      img.data[o + 2] = q;
      img.data[o + 3] = 255;
    }
    s.ctx.putImageData(img, 0, 0);
    return this.finish(s, { nearest: true, mips: false, aniso: 1 });
  }

  private buildNoiseRGBA(): THREE.Texture {
    const n = 256;
    const s = surface(n, n);
    const img = s.ctx.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const o = i * 4;
      img.data[o] = ihash(i, 1, 7) * 255;
      img.data[o + 1] = ihash(i, 2, 7) * 255;
      img.data[o + 2] = ihash(i, 3, 7) * 255;
      img.data[o + 3] = ihash(i, 4, 7) * 255;
    }
    s.ctx.putImageData(img, 0, 0);
    return this.finish(s, { nearest: true, mips: false, aniso: 1 });
  }

  /** Soft elliptical contact shadow, alpha only. */
  private buildRadialShadow(): THREE.Texture {
    const n = this.size(256);
    const s = surface(n, n);
    const img = s.ctx.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x / n) * 2 - 1;
        const dy = (y / n) * 2 - 1;
        const d = Math.sqrt(dx * dx + dy * dy);
        // two-lobe falloff: a dense core with a long, very soft skirt
        const core = Math.max(0, 1 - d / 0.62);
        const skirt = Math.max(0, 1 - d);
        const a = Math.pow(core, 1.7) * 0.72 + Math.pow(skirt, 3.2) * 0.4;
        const o = (y * n + x) * 4;
        img.data[o] = 0;
        img.data[o + 1] = 0;
        img.data[o + 2] = 0;
        img.data[o + 3] = Math.min(255, a * 255);
      }
    }
    s.ctx.putImageData(img, 0, 0);
    return this.finish(s, { repeat: false, aniso: 4 });
  }

  /** Ambient occlusion gradient across the rail profile (v axis). */
  private buildRailAO(): THREE.Texture {
    const w = 8;
    const h = this.size(256);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const v = y / (h - 1);
      // dark where the rail meets the felt and where it tucks under
      const inner = 1 - Math.exp(-Math.pow(v / 0.16, 2)) * 0.55;
      const outer = 1 - Math.exp(-Math.pow((1 - v) / 0.14, 2)) * 0.6;
      const crest = 1 - Math.pow(Math.max(0, 1 - Math.abs(v - 0.5) / 0.45), 3) * 0.1;
      for (let x = 0; x < w; x++) out[y * w + x] = Math.max(0, inner * outer * crest);
    }
    return this.finish(fieldToGrey(out, w, h), { aniso: 2 });
  }

  // ── logos ─────────────────────────────────────────────────────────

  /**
   * The felt inlay. Drawn as vector paths so it stays on-brand with the boot
   * mark: a spade shield inside a double hairline ring, wordmark below.
   */
  private buildLogo(id: string): THREE.Texture {
    const n = this.size(512);
    const s = surface(n, n);
    const { ctx } = s;
    const k = n / 512;
    ctx.clearRect(0, 0, n, n);
    ctx.save();
    ctx.translate(n / 2, n / 2);

    const ring = (radius: number, width: number, alpha: number) => {
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * k, radius * k, 0, 0, Math.PI * 2);
      ctx.lineWidth = width * k;
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.stroke();
    };

    if (id === 'royale-classic' || id === 'default' || id === '') {
      ring(228, 3.0, 0.85);
      ring(214, 1.2, 0.5);

      // spade shield, reusing the launch mark's silhouette
      ctx.save();
      ctx.translate(0, -34 * k);
      ctx.scale(1.55 * k, 1.55 * k);
      ctx.translate(-50, -50);
      const spade = new Path2D(
        'M50 12 L74 36 Q88 50 74 64 Q62 76 50 64 Q38 76 26 64 Q12 50 26 36 Z',
      );
      const stem = new Path2D('M46 62 h8 l4 22 h-16 z');
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill(spade);
      ctx.fill(stem);
      ctx.restore();

      this.wordmark(ctx, 'ROYALE', 0, 118 * k, 44 * k, 15 * k, 0.9);
      this.wordmark(ctx, 'TEXAS HOLD’EM', 0, 166 * k, 15 * k, 9 * k, 0.45);
    } else if (id === 'obsidian') {
      ring(232, 1.6, 0.55);
      ctx.save();
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 4 * k;
      ctx.strokeRect(-118 * k, -118 * k, 236 * k, 236 * k);
      ctx.restore();
      this.wordmark(ctx, 'ROYALE', 0, 16 * k, 56 * k, 20 * k, 0.9);
    } else if (id === 'crown') {
      ring(230, 2.4, 0.7);
      ctx.save();
      ctx.translate(0, -28 * k);
      ctx.scale(k, k);
      const crown = new Path2D(
        'M-96 34 L-110 -46 L-52 -6 L0 -66 L52 -6 L110 -46 L96 34 Z M-96 46 L96 46 L96 66 L-96 66 Z',
      );
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill(crown);
      ctx.restore();
      this.wordmark(ctx, 'ROYALE', 0, 130 * k, 46 * k, 16 * k, 0.88);
    } else {
      ring(226, 2.2, 0.7);
      this.wordmark(ctx, id.toUpperCase().slice(0, 10), 0, 18 * k, 52 * k, 18 * k, 0.9);
    }

    ctx.restore();
    return this.finish(s, { srgb: true, repeat: false, aniso: 8 });
  }

  /** Manual letter-spacing — `ctx.letterSpacing` is not universal yet. */
  private wordmark(
    ctx: CanvasRenderingContext2D,
    text: string,
    cx: number,
    cy: number,
    size: number,
    tracking: number,
    alpha: number,
  ): void {
    ctx.save();
    ctx.font = `600 ${size}px "SF Pro Display", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    const chars = Array.from(text);
    let total = 0;
    for (const ch of chars) total += ctx.measureText(ch).width + tracking;
    total -= tracking;
    let x = cx - total / 2;
    for (const ch of chars) {
      ctx.fillText(ch, x, cy);
      x += ctx.measureText(ch).width + tracking;
    }
    ctx.restore();
  }

  dispose(): void {
    for (const t of this.cache.values()) t.dispose();
    this.cache.clear();
  }
}

let singleton: TextureFactory | null = null;

export function initTextures(opts: TextureOptions): TextureFactory {
  singleton?.dispose();
  singleton = new TextureFactory(opts);
  return singleton;
}

/** Shared factory. Cards and chips pull `card-varnish` / `blue-noise` here. */
export function textures(): TextureFactory {
  if (!singleton) singleton = new TextureFactory({ maxAnisotropy: 4, scale: 1 });
  return singleton;
}

export function disposeTextures(): void {
  singleton?.dispose();
  singleton = null;
}
