// CS2's light probe volumes, sampled on the CPU: what lights everything that isn't lightmapped (props, players, your
// weapon). Each volume is a box of voxels holding an "ambient cube" (the light arriving from +X, +Y, +Z, -X, -Y, -Z)
// and how much the sun reaches; all of a map's volumes share one atlas (probes.bin, made by cs2/play.cjs bakeProbes).
// Like CS2, a point takes the volumes containing it in priority order (more indoor first, then smaller), each faded
// in from its edges, up to four, and the sky fills in what they leave uncovered. Game units (inches, Z up).
const MAX_BLEND = 4;

export class ProbeField {
  // data: probes.bin; info: { size: [w, h, depth of one block], max, volumes }; fallback: { up, down } linear RGB for
  // places no volume covers.
  constructor(data, info, fallback) {
    this.data = data;
    [this.W, this.H, this.D] = info.size;
    this.shadowBase = this.W * this.H * this.D * 6 * 3;
    this.decode = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const v = i / 255; this.decode[i] = (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * info.max; }
    this.fallback = fallback;
    this.volumes = info.volumes.map((v) => {
      // World to the volume's box: Source angles are pitch (about Y), yaw (about Z), roll (about X).
      const [p, y, r] = v.angles.map((a) => (a * Math.PI) / 180);
      const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y), cr = Math.cos(r), sr = Math.sin(r);
      const fwd = [cp * cy, cp * sy, -sp], left = [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp], up = [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp];
      const size = [0, 1, 2].map((i) => v.max[i] - v.min[i]);
      return {
        origin: v.origin, axes: [fwd, left, up], min: v.min, size,
        invEdge: [0, 1, 2].map((i) => size[i] / Math.max(v.fade?.[i] ?? 0, 0.02)), voxels: v.size, atlas: v.atlas,
      };
    });
    this.blendVol = new Int32Array(MAX_BLEND); this.blendW = new Float32Array(MAX_BLEND); this.blendN = new Float32Array(MAX_BLEND * 3);
  }

  // The volumes at p and their weights (CS2's edge fades, each taking what the ones before it left). Returns coverage.
  blend(p) {
    let n = 0, cover = 0;
    for (let i = 0; i < this.volumes.length && n < MAX_BLEND && cover < 0.99; i++) {
      const v = this.volumes[i];
      const d = [p[0] - v.origin[0], p[1] - v.origin[1], p[2] - v.origin[2]];
      let fade = 1;
      for (let a = 0; a < 3; a++) {
        const local = (d[0] * v.axes[a][0] + d[1] * v.axes[a][1] + d[2] * v.axes[a][2] - v.min[a]) / v.size[a];
        if (local < 0 || local > 1) { fade = 0; break; }
        fade = Math.min(fade, Math.min(local, 1 - local) * v.invEdge[a]);
        this.blendN[n * 3 + a] = local;
      }
      if (fade <= 0) continue;
      fade = Math.min(1, fade);
      const w = fade * fade * (3 - 2 * fade) * (1 - cover);
      if (w <= 0) continue;
      this.blendVol[n] = i; this.blendW[n] = w; n++; cover += w;
    }
    this.blendCount = n;
    return cover;
  }

  // Trilinear sample of block k (a direction, or 6 for the sun) of volume v at normalized box coords (nx, ny, nz):
  // RGB into out[o..o+2] for the light, or the sun's visibility returned.
  sample(v, k, nx, ny, nz, out, o) {
    const W = this.W, H = this.H, D = this.D, d = this.data;
    const fx = Math.min(W - 1, Math.max(0, nx * v.voxels[0] + v.atlas[0] - 0.5));
    const fy = Math.min(H - 1, Math.max(0, ny * v.voxels[1] + v.atlas[1] - 0.5));
    const fz = Math.min(D - 1, Math.max(0, nz * v.voxels[2] + v.atlas[2] - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), z1 = Math.min(D - 1, z0 + 1);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const sun = k === 6;
    let r = 0, g = 0, b = 0;
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? x1 : x0, y = c & 2 ? y1 : y0, z = c & 4 ? z1 : z0;
      const w = (c & 1 ? tx : 1 - tx) * (c & 2 ? ty : 1 - ty) * (c & 4 ? tz : 1 - tz);
      if (w === 0) continue;
      if (sun) { r += d[this.shadowBase + (z * H + y) * W + x] * w; continue; }
      const i = (((k * D + z) * H + y) * W + x) * 3;
      r += this.decode[d[i]] * w; g += this.decode[d[i + 1]] * w; b += this.decode[d[i + 2]] * w;
    }
    if (sun) return r / 255;
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
    return 0;
  }

  // The ambient cube at p: out (18 floats) = linear RGB from +X, +Y, +Z, -X, -Y, -Z (game axes).
  cube(p, out = new Float32Array(18)) {
    out.fill(0);
    const cover = this.blend(p);
    const tmp = this.tmp ||= new Float32Array(3);
    for (let j = 0; j < this.blendCount; j++) {
      const v = this.volumes[this.blendVol[j]], w = this.blendW[j], n = this.blendN;
      for (let k = 0; k < 6; k++) {
        this.sample(v, k, n[j * 3], n[j * 3 + 1], n[j * 3 + 2], tmp, 0);
        for (let c = 0; c < 3; c++) out[k * 3 + c] += tmp[c] * w;
      }
    }
    if (cover < 0.99) {
      const rest = 1 - cover, { up, down } = this.fallback;
      for (let c = 0; c < 3; c++) {
        out[6 + c] += up[c] * rest; out[15 + c] += down[c] * rest;
        for (const k of [0, 1, 3, 4]) out[k * 3 + c] += (up[c] + down[c]) * 0.5 * rest;
      }
    }
    return out;
  }

  // Light arriving at p on a surface facing n (game axes, unit): the ambient cube weighted by n² (CS2's lookup).
  irradiance(p, n, out = new Float32Array(3)) {
    const cube = this.cube(p, this.cubeTmp ||= new Float32Array(18));
    const kx = n[0] >= 0 ? 0 : 3, ky = n[1] >= 0 ? 1 : 4, kz = n[2] >= 0 ? 2 : 5;
    const wx = n[0] * n[0], wy = n[1] * n[1], wz = n[2] * n[2];
    for (let c = 0; c < 3; c++) out[c] = cube[kx * 3 + c] * wx + cube[ky * 3 + c] * wy + cube[kz * 3 + c] * wz;
    return out;
  }

  // How much the sun reaches p (0..1), from the volumes' baked shadows (outside them: all of it).
  sun(p) {
    const cover = this.blend(p);
    let s = 1 - Math.min(1, cover);
    for (let j = 0; j < this.blendCount; j++) {
      const n = this.blendN;
      s += this.sample(this.volumes[this.blendVol[j]], 6, n[j * 3], n[j * 3 + 1], n[j * 3 + 2]) * this.blendW[j];
    }
    return s;
  }
}
