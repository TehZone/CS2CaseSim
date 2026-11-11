// Runs in a hidden window on the dev server (see main.cjs): draws custom items on their real CS2 models through the game's own
// 3D code, as pictures like Steam's (1024x768, transparent, the item side on), and custom cases' 3D crates for checking.
const origin = location.origin;
const THREE = await import('three');
const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
const { loadData, D } = await import(origin + '/js/data.js');
const { renderSideView } = await import(origin + '/js/cs2/skin.js');
const { loadCrate } = await import(origin + '/js/cs2/crate.js');

const W = 1024, H = 768;
let renderer, env;

export async function ready() {
  await loadData();
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

// The item side on, fitted to 1024x768 with a margin (as Steam's pictures are), as a PNG data URL.
export async function icon({ id, fl, sd }) {
  const def = D.skins[id];
  if (!def) throw new Error('No custom item ' + id);
  const item = { t: 'skin', id, fl, sd, stt: false, stk: [] };
  const side = await renderSideView(item, def, renderer, env, 2048);
  if (!side) throw new Error('Nothing drawn for ' + def.n);
  // Cropped to what was drawn (a model's bounds can take in parts it doesn't show: the gloves' arm), then fitted.
  const src = side.canvas, sp = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
  let x0 = src.width, y0 = src.height, x1 = -1, y1 = -1;
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) if (sp[(y * src.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) throw new Error(`${def.n} came out empty`);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const k = Math.min((W * 0.92) / cw, (H * 0.86) / ch), w = cw * k, h = ch * k;
  g.drawImage(src, x0, y0, cw, ch, (W - w) / 2, (H - h) / 2, w, h);
  // (A picture with nothing in it would be a bug: say so rather than write it.)
  const px = g.getImageData(0, 0, W, H).data;
  let seen = 0;
  for (let i = 3; i < px.length; i += 16) if (px[i] > 20) seen++;
  if (seen < 500) throw new Error(`${def.n} came out empty`);
  return { icon: c.toDataURL('image/png'), note: `${def.n} at ${fl}, seed ${sd}` };
}

// A custom case's 3D crate, part way through its fall (for checking its emblem).
export async function crate({ id }) {
  const scene = await loadCrate(id);
  if (!scene) return { note: 'no 3D crate (no CS2 install, or its base has none)' };
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px`;
  document.body.append(host);
  try {
    scene.mount(host);
    scene.play('fall');
    // (Straight to its landing: a hidden window draws few frames.)
    scene.mixer.update(scene.clips.fall.duration);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const canvas = host.querySelector('canvas');
    if (!canvas) return { note: 'crate did not mount' };
    // (Read in the frame the crate's own loop has just drawn: a WebGL canvas keeps no picture between frames.)
    const shot = await new Promise((res) => requestAnimationFrame(() => res(canvas.toDataURL('image/png'))));
    return { shot, note: 'crate' };
  } finally {
    scene.unmount();
    host.remove();
  }
}
