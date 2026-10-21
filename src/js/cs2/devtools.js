// Developer helpers for checking CS2 skin rendering against Steam's official icons (not used by the game).
import * as THREE from 'three';
import * as ui from '../ui.js';
import * as I from '../items.js';
import { D } from '../data.js';
import { imgUrl } from '../util.js';
import { inspectView } from '../inspect.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens the 3D inspect for a skin at a fixed side view, with the Steam icon overlaid for comparison.
export async function show(name, seed, fl = 0, opts = {}) {
  document.querySelector('.inspect [data-a=close]')?.click();
  globalThis.__cs2Debug = opts;
  const sk = Object.values(D.skins).find((s) => s.n === name && (!opts.phase || s.ph === opts.phase));
  if (!sk) throw new Error('no skin ' + name);
  ui.openInspect(I.makeSkinItem(sk, { stt: false, fl, sd: seed }));
  for (let i = 0; i < 120 && document.querySelector('.inspect .loading'); i++) await sleep(250);
  const st = inspectView.state;
  st.anim = null; st.yaw = opts.yaw ?? 0; st.pitch = 0; st.vy = st.vp = 0; st.lastInput = performance.now() + 1e9;
  const ov = document.querySelector('.inspect');
  ov.querySelector('.hud').style.display = 'none';
  const im = document.createElement('img');
  im.src = imgUrl(sk.img, 'm');
  im.style.cssText = `position:absolute;left:8px;top:60px;width:${opts.iconW || 380}px;background:#0006;border:1px solid #fff4`;
  ov.appendChild(im);
  const lab = document.createElement('div');
  lab.textContent = `${name}${opts.phase ? ' ' + opts.phase : ''} · seed ${seed} · float ${fl} · ${inspectView.source} ${JSON.stringify(opts)}`;
  lab.style.cssText = 'position:absolute;left:320px;bottom:12px;color:#fff;font-size:14px';
  ov.appendChild(lab);
  await sleep(800);
  return { fid: sk.fid, source: inspectView.source };
}

// Shows the last baked colour / roughness-metalness textures in an overlay.
export function bakeOverlay(which = 'color', size = 512) {
  const b = globalThis.__cs2LastBake;
  if (!b) return 'no bake';
  const rt = which === 'color' ? b.colorRT : b.rmRT;
  const W = rt.width, H = rt.height;
  const px = new Uint8Array(W * H * 4);
  b.renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(W, H);
  id.data.set(px);
  ctx.putImageData(id, 0, 0);
  document.getElementById('cs2-bake-overlay')?.remove();
  c.id = 'cs2-bake-overlay';
  c.style.cssText = `position:fixed;right:8px;top:60px;width:${size}px;height:${size}px;z-index:200;border:1px solid #fff6;background:#000`;
  document.body.appendChild(c);
  return { W, H, params: b.params, rolled: b.rolled };
}

export { THREE };

// Fraction of blue vs gold metal pixels in the current inspect frame (Case Hardened blue-gem check).
export function blueScore(yaw = 0) {
  const st = inspectView.state;
  st.anim = null; st.yaw = yaw; st.pitch = 0; st.zoom = 1;
  inspectView.frame();
  const gl = inspectView.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let blue = 0, gold = 0;
  for (let i = 0; i < px.length; i += 16) {
    const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
    if (a < 200) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 25 || mx < 50) continue;
    if (b > r + 15 && b >= g) blue++;
    else if (r >= b + 15 && g >= b + 10 && Math.abs(r - g) < 70) gold++;
  }
  return blue / Math.max(1, blue + gold);
}

// Mean playside blue score for a list of seeds under the current debug options.
export async function seedScan(seeds, opts = {}, fl = 0.05) {
  const out = {};
  for (const s of seeds) {
    await show('AK-47 | Case Hardened', s, fl, opts);
    out[s] = +blueScore(opts.yaw ?? 0).toFixed(3);
  }
  return out;
}

// Side view of a skin with its Steam icon in the bottom-right corner.
export async function compare(name, seed = 0, fl = 0.01, opts = {}) {
  const r = await show(name, seed, fl, opts);
  const st = inspectView.state;
  st.yaw = opts.yaw ?? 0; st.pitch = opts.pitch ?? 0.12; st.zoom = opts.zoom ?? 0.9;
  const im = document.querySelector('.inspect img');
  im.style.cssText = 'position:absolute;right:8px;bottom:30px;width:330px;background:#0008;border:1px solid #fff4';
  await sleep(400);
  return r;
}
