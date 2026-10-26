// Bots' animation without the garbage. Every frame, for each clip a bot plays, three works out each bone's rotation and
// position at the clip's time (Interpolant.evaluate): it reads the keyframe times either side, which may be past the
// end of the list (undefined) for all V8 can tell, so it keeps them as objects, new ones every bone. Nearly always the
// time is still between the two keyframes it used last; then this works it out right there (as three's linear and
// quaternion interpolants do, its quaternion slerp copied in so the fraction isn't handed to another function as an
// object: the same numbers), and anything else goes on to three's own. (With this and the clips at weight 0 stopped, see
// bots.js, the bots' animation went from 350 MB of garbage in four minutes of Mirage to 125 MB.) Pure JS: three's
// Interpolant, which every AnimationMixer uses.
import * as THREE from 'three';

export function quietKeyframes() {
  const P = THREE.Interpolant.prototype;
  if (P.cs2Quiet) return;
  const evaluate = P.evaluate, LINEAR = THREE.LinearInterpolant.prototype.interpolate_, QUATERNION = THREE.QuaternionLinearInterpolant.prototype.interpolate_;
  P.evaluate = function (t) {
    const pp = this.parameterPositions, i1 = this._cachedIndex;
    if (i1 > 0 && i1 < pp.length) {
      const t0 = pp[i1 - 1], t1 = pp[i1];
      if (t < t1 && t >= t0) { // (three's: the interval is valid)
        const f = this.interpolate_, result = this.resultBuffer, values = this.sampleValues, stride = this.valueSize;
        if (f === QUATERNION) {
          const alpha = (t - t0) / (t1 - t0);
          let offset = i1 * stride;
          for (let end = offset + stride; offset !== end; offset += 4) {
            // three's Quaternion.slerpFlat (r186), of the two keyframes' rotations into result.
            const o0 = offset - stride;
            let t = alpha, x0 = values[o0], y0 = values[o0 + 1], z0 = values[o0 + 2], w0 = values[o0 + 3];
            let x1 = values[offset], y1 = values[offset + 1], z1 = values[offset + 2], w1 = values[offset + 3];
            if (w0 !== w1 || x0 !== x1 || y0 !== y1 || z0 !== z1) {
              let dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
              if (dot < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; dot = -dot; }
              let s = 1 - t;
              if (dot < 0.9995) {
                const theta = Math.acos(dot), sin = Math.sin(theta);
                s = Math.sin(s * theta) / sin;
                t = Math.sin(t * theta) / sin;
                x0 = x0 * s + x1 * t; y0 = y0 * s + y1 * t; z0 = z0 * s + z1 * t; w0 = w0 * s + w1 * t;
              } else {
                x0 = x0 * s + x1 * t; y0 = y0 * s + y1 * t; z0 = z0 * s + z1 * t; w0 = w0 * s + w1 * t;
                const f = 1 / Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
                x0 *= f; y0 *= f; z0 *= f; w0 *= f;
              }
            }
            result[0] = x0; result[1] = y0; result[2] = z0; result[3] = w0;
          }
          return result;
        }
        if (f === LINEAR) {
          const offset1 = i1 * stride, offset0 = offset1 - stride, weight1 = (t - t0) / (t1 - t0), weight0 = 1 - weight1;
          for (let i = 0; i !== stride; ++i) result[i] = values[offset0 + i] * weight0 + values[offset1 + i] * weight1;
          return result;
        }
        return f.call(this, i1, t0, t, t1);
      }
    }
    return evaluate.call(this, t);
  };
  P.cs2Quiet = true;
}
