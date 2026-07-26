/**
 * Deterministic RNG. Seeded xoshiro128** — fast, good distribution, and
 * reproducible, which matters for replays, hand histories and tests.
 * The live server uses crypto entropy to seed; clients use it for cosmetic
 * randomness (particles, idle animations) where determinism aids debugging.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed = 0x9e3779b9) {
    // splitmix32 to expand the seed into four words
    let z = seed >>> 0;
    const next = () => {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  /** uint32 */
  nextU32(): number {
    const r = (Math.imul(this.s1 * 5, 1) << 7) | 0;
    const result = (Math.imul((r << 7) | (r >>> 25), 9) >>> 0) as number;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return result >>> 0;
  }

  /** [0,1) */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** [0,n) integer */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** [min,max) float */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** Fisher-Yates, in place */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Standard normal via Box-Muller, for natural-feeling jitter. */
  normal(mean = 0, sd = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

/** Shared cosmetic RNG — never use for gameplay. */
export const fxRng = new Rng(0x5eed1e);

/** A fresh, crypto-seeded generator for real deals. */
export function secureRng(): Rng {
  const buf = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else buf[0] = (Math.random() * 0xffffffff) >>> 0;
  return new Rng(buf[0]);
}
