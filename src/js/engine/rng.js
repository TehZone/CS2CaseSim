// Valve's CUniformRandomStream (vstdlib), for the engine: the same generator as src/js/cs2/rng.js, which the 3D uses to roll
// a paint seed's pattern placement. The engine reads it where a value goes by that placement (patterns.js: a custom Fade's
// percentage is the rotation the seed turns the pattern to). Kept here so the engine (and the server, which runs it) needs
// nothing from the renderer's folder; scripts/test-custom.mjs checks the two give the same numbers.
const NTAB = 32, IA = 16807, IM = 2147483647, IQ = 127773, IR = 2836;
const NDIV = 1 + Math.floor((IM - 1) / NTAB);
const AM = Math.fround(1 / IM), RNMX = Math.fround(1 - 1.2e-7);

export class UniformRandomStream {
  constructor(seed = 0) { this.setSeed(seed); }

  setSeed(seed) {
    this.idum = seed < 0 ? seed : -seed;
    this.iy = 0;
    this.iv = new Int32Array(NTAB);
  }

  next() {
    let j, k;
    if (this.idum <= 0 || !this.iy) {
      this.idum = -this.idum < 1 ? 1 : -this.idum;
      for (j = NTAB + 7; j >= 0; j--) {
        k = Math.trunc(this.idum / IQ);
        this.idum = IA * (this.idum - k * IQ) - IR * k;
        if (this.idum < 0) this.idum += IM;
        if (j < NTAB) this.iv[j] = this.idum;
      }
      this.iy = this.iv[0];
    }
    k = Math.trunc(this.idum / IQ);
    this.idum = IA * (this.idum - k * IQ) - IR * k;
    if (this.idum < 0) this.idum += IM;
    j = Math.trunc(this.iy / NDIV);
    if (j >= NTAB || j < 0) j = (j % NTAB) & 0x7fffffff;
    this.iy = this.iv[j];
    this.iv[j] = this.idum;
    return this.iy;
  }

  randomFloat(lo, hi) {
    let fl = Math.fround(AM * this.next());
    if (fl > RNMX) fl = RNMX;
    return Math.fround(Math.fround(fl * Math.fround(hi - lo)) + lo);
  }
}

// Where in its rotation range a paint seed turns the pattern, 0 (the range's first angle) to 1 (its second): CS2 rolls the
// pattern's offset (two draws) and then its rotation, so it's the third draw. (Checked against CS2's own Fades: the CS.MONEY
// Wiki's fade percentage of every seed of the Karambit's is exactly 80 + 20 times this.)
export function rotationRoll(seed) {
  const r = new UniformRandomStream(seed);
  r.randomFloat(0, 1); r.randomFloat(0, 1);
  return r.randomFloat(0, 1);
}
