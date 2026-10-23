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

// Inspect backdrops (CS2's menu/inspect "vanity" scenes) in the player's install: [{ id, name }].
let vanityList = null;
export function cs2VanityMaps() {
  if (!vanityList) {
    vanityList = (window.native?.cs2VanityMaps ? window.native.cs2VanityMaps() : fetch('api/cs2/vanity-maps').then((r) => (r.ok ? r.json() : [])))
      .catch(() => []);
  }
  return vanityList;
}
// One backdrop, exported on first use: { glb, info }.
const vanities = new Map();
export function cs2Vanity(id) {
  if (!vanities.has(id)) {
    const p = window.native?.cs2Vanity ? window.native.cs2Vanity(id)
      : fetch(`api/cs2/vanity?id=${encodeURIComponent(id)}`).then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    vanities.set(id, p);
    p.catch(() => vanities.delete(id));
  }
  return vanities.get(id);
}

// CS2's glove inspect animation: { clip } glTF URL.
let gloveClip = null;
export function cs2GloveClip() {
  if (!gloveClip) {
    gloveClip = window.native?.cs2GloveClip ? window.native.cs2GloveClip()
      : fetch('api/cs2/glove-clip').then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    gloveClip.catch(() => { gloveClip = null; });
  }
  return gloveClip;
}

// First-person inspect for a weapon id: { clip, arms } glTF URLs (CS2's inspect animation and arms).
const firstPersons = new Map();
export function cs2FirstPerson(weapon) {
  if (!firstPersons.has(weapon)) {
    const p = window.native?.cs2FirstPerson ? window.native.cs2FirstPerson(weapon)
      : fetch(`api/cs2/first-person?weapon=${encodeURIComponent(weapon)}`).then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    firstPersons.set(weapon, p);
    p.catch(() => firstPersons.delete(weapon));
  }
  return firstPersons.get(weapon);
}

// A container's 3D crate model (CS2's "fall" and "open" animations included), or null: { model, name }.
const crates = new Map();
export function cs2Crate(id) {
  if (!crates.has(id)) {
    const p = window.native?.cs2Crate ? window.native.cs2Crate(id)
      : fetch(`api/cs2/crate?id=${encodeURIComponent(id)}`).then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); });
    crates.set(id, p);
    p.catch(() => crates.delete(id));
  }
  return crates.get(id);
}

// Play mode: fn is one of maps, map, progress, weapon, agent, anims, sounds, agentModel, stats, voices, icons (see CS2Service).
// Results of everything but progress are cached per argument.
const playCache = new Map();
export function cs2Play(fn, arg = null) {
  const call = () => (window.native?.cs2Play ? window.native.cs2Play(fn, arg)
    : fetch(`api/cs2/play?fn=${fn}&arg=${encodeURIComponent(JSON.stringify(arg))}`).then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); }));
  if (fn === 'progress') return call();
  const key = fn + '|' + JSON.stringify(arg);
  if (!playCache.has(key)) {
    const p = call();
    playCache.set(key, p);
    p.catch(() => playCache.delete(key));
  }
  return playCache.get(key);
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
