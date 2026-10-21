// Copies the three.js files the renderer imports into src/vendor (served offline, no CDN).
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
for (const [from, to] of files) {
  const dst = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(THREE, from), dst);
  console.log('copied', to);
}
