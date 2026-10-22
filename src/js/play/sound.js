// Play mode sounds: CS2's sound events (each a set of variations) played through Web Audio. Sounds from the world
// (bots' guns, impacts) are positioned in 3D; your own weapon plays straight.
import { cs2Play } from '../cs2/api.js';
import { S } from '../state.js';

export class SoundBank {
  constructor() {
    this.ctx = new AudioContext();
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.events = {}; // event -> [urls]
    this.buffers = new Map(); // url -> Promise<AudioBuffer>
    this.last = new Map();
    this.setVolume();
  }

  setVolume() { this.out.gain.value = S.settings?.volume ?? 0.6; }

  // Loads (extracting from the install as needed) a list of sound events.
  async load(events) {
    const want = events.filter((e) => !this.events[e]);
    if (!want.length) return;
    Object.assign(this.events, await cs2Play('sounds', want).catch(() => ({})));
    await Promise.all(want.flatMap((e) => (this.events[e] || []).map((u) => this.buffer(u))));
  }
  add(map) { Object.assign(this.events, map); for (const urls of Object.values(map)) urls.forEach((u) => this.buffer(u)); }

  buffer(url) {
    if (!this.buffers.has(url)) {
      const p = fetch(url).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b)).catch(() => null);
      this.buffers.set(url, p);
    }
    return this.buffers.get(url);
  }

  has(event) { return !!this.events[event]?.length; }

  // Plays a random variation of an event. opts: { volume, pos (game units), listener (Game), rate }.
  async play(event, { volume = 1, pos = null, listener = null, rate = 1 } = {}) {
    const urls = this.events[event];
    if (!urls?.length) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    let i = Math.floor(Math.random() * urls.length);
    if (urls.length > 1 && i === this.last.get(event)) i = (i + 1) % urls.length;
    this.last.set(event, i);
    const buf = await this.buffer(urls[i]);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    if (pos && listener) {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 120; p.rolloffFactor = 1.1; p.maxDistance = 6000;
      // game units straight in: x/y horizontal, z up -> Web Audio's y up
      p.positionX.value = pos[0]; p.positionY.value = pos[2]; p.positionZ.value = -pos[1];
      g.connect(p);
      p.connect(this.out);
    } else g.connect(this.out);
    src.start();
    return src;
  }

  // Ears at the player's eye, facing their view (game units).
  setListener(eye, forward) {
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = eye[0]; l.positionY.value = eye[2]; l.positionZ.value = -eye[1];
      l.forwardX.value = forward[0]; l.forwardY.value = forward[2]; l.forwardZ.value = -forward[1];
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
  }

  dispose() { this.ctx.close().catch(() => {}); }
}
