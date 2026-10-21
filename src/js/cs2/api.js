// Bridge to the CS2 asset service (Electron main process, or the dev server's HTTP endpoints).
let statusPromise = null;

export function cs2Status() {
  if (!statusPromise) {
    statusPromise = (window.native?.cs2Status
      ? window.native.cs2Status()
      : fetch('api/cs2/status').then((r) => (r.ok ? r.json() : { available: false })))
      .catch(() => ({ available: false }));
  }
  return statusPromise;
}

let soundsPromise = null;
export function cs2Sounds() {
  if (!soundsPromise) {
    soundsPromise = (window.native?.cs2Sounds
      ? window.native.cs2Sounds()
      : fetch('api/cs2/sounds').then((r) => (r.ok ? r.json() : {})))
      .catch(() => ({}));
  }
  return soundsPromise;
}

// A sticker's CS2 material (parameters + texture URLs), by its sticker kit's `sticker_material`.
const stickers = new Map();
export function cs2Sticker(material) {
  if (!stickers.has(material)) {
    const p = window.native?.cs2Sticker
      ? window.native.cs2Sticker(material)
      : fetch(`api/cs2/sticker?material=${encodeURIComponent(material)}`)
        .then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    stickers.set(material, p);
    p.catch(() => stickers.delete(material));
  }
  return stickers.get(material);
}

const prepared = new Map();
export function cs2Prepare(weapon, paint) {
  const key = weapon + '|' + (paint || '');
  if (!prepared.has(key)) {
    const p = window.native?.cs2Prepare
      ? window.native.cs2Prepare({ weapon, paint })
      : fetch(`api/cs2/prepare?weapon=${encodeURIComponent(weapon)}&paint=${encodeURIComponent(paint || '')}`)
        .then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    prepared.set(key, p);
    p.catch(() => prepared.delete(key));
  }
  return prepared.get(key);
}
