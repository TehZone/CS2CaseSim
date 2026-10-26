// Copies the three.js files the renderer imports into src/vendor (served offline, no CDN), with the patches below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREE = path.join(ROOT, 'node_modules', 'three');
const OUT = path.join(ROOT, 'src', 'vendor');

const files = [
  ['build/three.module.js', 'three.module.js'],
  ['build/three.core.js', 'three.core.js'],
  ['examples/jsm/environments/RoomEnvironment.js', 'addons/environments/RoomEnvironment.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'addons/utils/BufferGeometryUtils.js'],
  ['examples/jsm/utils/SkeletonUtils.js', 'addons/utils/SkeletonUtils.js'],
  ['examples/jsm/loaders/GLTFLoader.js', 'addons/loaders/GLTFLoader.js'],
  ['examples/jsm/loaders/EXRLoader.js', 'addons/loaders/EXRLoader.js'],
  ['examples/jsm/libs/fflate.module.js', 'addons/libs/fflate.module.js'],
  ['examples/jsm/geometries/DecalGeometry.js', 'addons/geometries/DecalGeometry.js'],
  ['LICENSE', 'THREE-LICENSE.txt'],
];

// Changes to three (as of 0.186) applied as it's copied: [file, what it's for, the code, what it becomes]. Each must still
// be there: a three that's changed it stops the copy, to be looked at again, rather than quietly going without.
const PATCHES = [
  // Each frame three checks every model's attributes are on the GPU with for (name in geometry.attributes) and reads
  // geometry.attributes[name]. The models have all kinds of attributes (the map's batches, bots, guns, effects), and V8
  // made that read for the kinds it had seen, met another, threw the code away and made it again: 10,000 times in two
  // minutes of a match, and the code made and thrown away filled the heap to a full collection every 45 s. Read with
  // Reflect.get it's an ordinary lookup, made once (three full collections in 8 minutes; Object.keys did as well, but
  // made an array of names for every model every frame).
  ['three.module.js', 'attributes the GPU has', `		for ( const name in geometryAttributes ) {

			attributes.update( geometryAttributes[ name ], gl.ARRAY_BUFFER );

		}`, `		for ( const name in geometryAttributes ) {

			attributes.update( Reflect.get( geometryAttributes, name ), gl.ARRAY_BUFFER ); // (CS2 Case Simulator: see scripts/copy-vendor.mjs)

		}`],
];

for (const [from, to] of files) {
  const dst = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(THREE, from), dst);
  console.log('copied', to);
}
for (const [to, what, code, patched] of PATCHES) {
  const dst = path.join(OUT, to), text = fs.readFileSync(dst, 'utf8');
  if (text.split(code).length !== 2) throw new Error(`${to}: the code patched for ${what} isn't there once (a new three?): see PATCHES in scripts/copy-vendor.mjs`);
  fs.writeFileSync(dst, text.replace(code, patched));
  console.log('patched', to + ':', what);
}
