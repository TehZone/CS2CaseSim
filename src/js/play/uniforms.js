// Uniforms without the garbage. three keeps each uniform's last value, so it isn't sent again unchanged, in a plain
// array that its setters compare and copy into. Those arrays are all made in one place, and the same few lines of three
// compare and copy every kind of uniform's (bools, texture units, floats, matrices): V8 makes them generic arrays, and
// each fractional number stored in one, or read out to compare, is a new object. With the camera moving that's every
// matrix and vector uniform, every program, every frame (in a scene like Play's, 38 KB a frame; 9 KB with these).
// So once the shaders are compiled, each float uniform gets an array made here and setters of its own (the same as
// three's), which only ever see arrays of numbers. Arrays of them (a bot's light, the shadows' matrices) get setters of
// their own too: three's tells an array of numbers from one of vectors or matrices by comparing its first item with 0,
// which for a matrix makes a string to make a number of, every call. Pure JS: three's WebGLUniforms, as its programs
// have them.
const SIZE = { 0x1406: 1, 0x8b50: 2, 0x8b51: 3, 0x8b52: 4, 0x8b5a: 4, 0x8b5b: 9, 0x8b5c: 16 }; // FLOAT, VEC2-4, MAT2-4
const SETTER = { 0x1406: setV1f, 0x8b50: setV2f, 0x8b51: setV3f, 0x8b52: setV4f, 0x8b5a: setM2, 0x8b5b: setM3, 0x8b5c: setM4 };
const ARRAY_SETTER = { 0x8b50: setV2fArray, 0x8b51: setV3fArray, 0x8b52: setV4fArray, 0x8b5a: setM2Array, 0x8b5b: setM3Array, 0x8b5c: setM4Array };
const NUMBERS = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]; // (an array of numbers to copy)

// Every program's float uniforms on these (those already done are left as they are). Again after a new shader.
export function numberUniforms(renderer) {
  for (const p of renderer.info.programs || []) visit(p.getUniforms().seq);
}
function visit(seq) {
  for (const u of seq) {
    if (u.seq) { visit(u.seq); continue; } // (a struct's members)
    if (u.size !== undefined) { if (ARRAY_SETTER[u.type]) u.setValue = ARRAY_SETTER[u.type]; continue; } // (an array of them: no cache)
    const n = SIZE[u.type];
    if (!n || u.setValue === SETTER[u.type]) continue;
    const cache = NUMBERS.slice(0, n), old = u.cache;
    // What it last sent stays (a value it holds that isn't a number, or none: never equal, so the next is sent).
    for (let i = 0; i < n; i++) cache[i] = typeof old[i] === 'number' ? old[i] : NaN;
    u.cache = cache;
    u.setValue = SETTER[u.type];
  }
}

// three's (r186) setters, as they are, but for the compare and the copy, which are these arrays' own.
function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0, l = a.length; i < l; i++) if (a[i] !== b[i]) return false;
  return true;
}
function copy(a, b) { for (let i = 0, l = b.length; i < l; i++) a[i] = b[i]; }
const mat2 = new Float32Array(4), mat3 = new Float32Array(9), mat4 = new Float32Array(16);

function setV1f(gl, v) {
  const cache = this.cache;
  if (cache[0] === v) return;
  gl.uniform1f(this.addr, v);
  cache[0] = v;
}
function setV2f(gl, v) {
  const cache = this.cache;
  if (v.x !== undefined) {
    if (cache[0] !== v.x || cache[1] !== v.y) { gl.uniform2f(this.addr, v.x, v.y); cache[0] = v.x; cache[1] = v.y; }
  } else {
    if (equal(cache, v)) return;
    gl.uniform2fv(this.addr, v);
    copy(cache, v);
  }
}
function setV3f(gl, v) {
  const cache = this.cache;
  // (A Vector3 and a Color each their own way: one read of v.x for both, and arrays, and V8 boxed the number.)
  if (v.isVector3 === true) {
    const x = v.x, y = v.y, z = v.z;
    if (cache[0] !== x || cache[1] !== y || cache[2] !== z) { gl.uniform3f(this.addr, x, y, z); cache[0] = x; cache[1] = y; cache[2] = z; }
  } else if (v.isColor === true) {
    const r = v.r, g = v.g, b = v.b;
    if (cache[0] !== r || cache[1] !== g || cache[2] !== b) { gl.uniform3f(this.addr, r, g, b); cache[0] = r; cache[1] = g; cache[2] = b; }
  } else if (v.x !== undefined) {
    if (cache[0] !== v.x || cache[1] !== v.y || cache[2] !== v.z) { gl.uniform3f(this.addr, v.x, v.y, v.z); cache[0] = v.x; cache[1] = v.y; cache[2] = v.z; }
  } else if (v.r !== undefined) {
    if (cache[0] !== v.r || cache[1] !== v.g || cache[2] !== v.b) { gl.uniform3f(this.addr, v.r, v.g, v.b); cache[0] = v.r; cache[1] = v.g; cache[2] = v.b; }
  } else {
    if (equal(cache, v)) return;
    gl.uniform3fv(this.addr, v);
    copy(cache, v);
  }
}
function setV4f(gl, v) {
  const cache = this.cache;
  if (v.x !== undefined) {
    if (cache[0] !== v.x || cache[1] !== v.y || cache[2] !== v.z || cache[3] !== v.w) {
      gl.uniform4f(this.addr, v.x, v.y, v.z, v.w); cache[0] = v.x; cache[1] = v.y; cache[2] = v.z; cache[3] = v.w;
    }
  } else {
    if (equal(cache, v)) return;
    gl.uniform4fv(this.addr, v);
    copy(cache, v);
  }
}
function setM2(gl, v) {
  const cache = this.cache, elements = v.elements;
  if (elements === undefined) {
    if (equal(cache, v)) return;
    gl.uniformMatrix2fv(this.addr, false, v);
    copy(cache, v);
  } else {
    if (equal(cache, elements)) return;
    mat2.set(elements);
    gl.uniformMatrix2fv(this.addr, false, mat2);
    copy(cache, elements);
  }
}
function setM3(gl, v) {
  const cache = this.cache, elements = v.elements;
  if (elements === undefined) {
    if (equal(cache, v)) return;
    gl.uniformMatrix3fv(this.addr, false, v);
    copy(cache, v);
  } else {
    if (equal(cache, elements)) return;
    mat3.set(elements);
    gl.uniformMatrix3fv(this.addr, false, mat3);
    copy(cache, elements);
  }
}
function setM4(gl, v) {
  const cache = this.cache, elements = v.elements;
  if (elements === undefined) {
    if (equal(cache, v)) return;
    gl.uniformMatrix4fv(this.addr, false, v);
    copy(cache, v);
  } else {
    if (equal(cache, elements)) return;
    mat4.set(elements);
    gl.uniformMatrix4fv(this.addr, false, mat4);
    copy(cache, elements);
  }
}

// Arrays: three's (r186), with its flatten's test for an array of numbers a typeof.
const flats = [];
function flat(v, n, size) {
  const first = v[0];
  if (typeof first === 'number') return v;
  const k = n * size;
  let r = flats[k];
  if (r === undefined) flats[k] = r = new Float32Array(k);
  if (n !== 0) {
    first.toArray(r, 0);
    for (let i = 1, o = 0; i !== n; ++i) { o += size; v[i].toArray(r, o); }
  }
  return r;
}
function setV2fArray(gl, v) { gl.uniform2fv(this.addr, flat(v, this.size, 2)); }
function setV3fArray(gl, v) { gl.uniform3fv(this.addr, flat(v, this.size, 3)); }
function setV4fArray(gl, v) { gl.uniform4fv(this.addr, flat(v, this.size, 4)); }
function setM2Array(gl, v) { gl.uniformMatrix2fv(this.addr, false, flat(v, this.size, 4)); }
function setM3Array(gl, v) { gl.uniformMatrix3fv(this.addr, false, flat(v, this.size, 9)); }
function setM4Array(gl, v) { gl.uniformMatrix4fv(this.addr, false, flat(v, this.size, 16)); }
