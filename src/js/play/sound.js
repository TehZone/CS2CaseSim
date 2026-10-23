// Play mode sounds: CS2's sound events (each a set of variations) played through Web Audio. Sounds from the world
// (bots' guns, impacts) are positioned in 3D; your own weapon plays straight. Music and radio voices play on channels
// that hold one sound at a time: a new track fades out the last (CS2 cuts the round's music when the next part starts).
import { cs2Play } from '../cs2/api.js';
import { S } from '../state.js';

// How far world sounds carry (game units), like CS2's sound levels: gunshots and explosions over much of the map,
// footsteps about 1100 units, small sounds less. Past that a sound isn't played at all; it fades out towards the edge,
// and comes through muffled from behind a wall.
const RANGES = [
  [/Silenced|SilencedShot/i, 1300],
  [/Explode|Detonate|BaseGrenade|c4\.explode/i, 5000],
  [/^Weapon_.*\.(Single|Fire|Shot)/i, 4200],
  [/Inferno|Molotov\.Start|IncGrenade\.Start|BaseSmokeEffect/i, 1600],
  [/C4\.PlantSound/i, 1900],
  [/Step(Left|Right)|^Land_/i, 1100],
  [/Bounce/i, 1100],
  [/BulletImpact|Knife|Flesh|DeathTaser/i, 950],
];
const DEFAULT_RANGE = 900;
export const soundRange = (event) => RANGES.find(([re]) => re.test(event))?.[1] ?? DEFAULT_RANGE;

export class SoundBank {
  constructor() {
    this.ctx = new AudioContext();
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.events = {}; // event -> [urls]
    this.buffers = new Map(); // url -> Promise<AudioBuffer>
    this.last = new Map();
    this.channels = new Map(); // name -> { src, gain, token }
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

  // Plays a random variation of an event. opts: { volume, pos (game units), listener (Game: its ear and walls), rate,
  // range (how far it carries; by event otherwise), startIf (checked once the sound has loaded) }. Resolves to its
  // source node.
  async play(event, { volume = 1, pos = null, listener = null, rate = 1, range = null, startIf = null } = {}) {
    const urls = this.events[event];
    if (!urls?.length) return;
    // Proximity: too far away to hear, or fading out with distance (muffled through walls).
    let muffled = false;
    if (pos && listener) {
      const ear = listener.earPos(), r = range ?? soundRange(event);
      const d = Math.hypot(pos[0] - ear[0], pos[1] - ear[1], pos[2] - ear[2]);
      if (d > r) return;
      const near = Math.min(150, r * 0.15);
      if (d > near) volume *= Math.pow(1 - (d - near) / (r - near), 2);
      if (volume < 0.01) return;
      if (d > 120 && listener.soundBlocked(ear, pos)) { muffled = true; volume *= 0.6; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    let i = Math.floor(Math.random() * urls.length);
    if (urls.length > 1 && i === this.last.get(event)) i = (i + 1) % urls.length;
    this.last.set(event, i);
    const buf = await this.buffer(urls[i]);
    if (!buf || (startIf && !startIf())) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    if (pos && listener) {
      // The panner only gives the direction; distance is in the volume above.
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'linear';
      p.refDistance = 1; p.maxDistance = 100000; p.rolloffFactor = 0;
      // game units straight in: x/y horizontal, z up -> Web Audio's y up
      p.positionX.value = pos[0]; p.positionY.value = pos[2]; p.positionZ.value = -pos[1];
      let last = g;
      if (muffled) {
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 900;
        g.connect(lp); last = lp;
      }
      last.connect(p);
      p.connect(this.out);
    } else g.connect(this.out);
    src.start();
    src.gainNode = g;
    return src;
  }

  // Plays an event on a channel (one sound at a time), fading out whatever it was playing.
  async channel(name, event, opts = {}, fade = 0.5) {
    this.stop(name, fade);
    const ch = this.channels.get(name);
    const src = await this.play(event, { ...opts, startIf: () => this.channels.get(name) === ch && !ch.src });
    if (src) { ch.src = src; src.onended = () => { if (ch.src === src) ch.src = null; }; }
    return src;
  }
  // Fades out a channel's sound (and drops one still loading).
  stop(name, fade = 0.5) {
    const old = this.channels.get(name);
    this.channels.set(name, { src: null });
    const src = old?.src;
    if (!src) return;
    const now = this.ctx.currentTime;
    src.gainNode.gain.cancelScheduledValues(now);
    src.gainNode.gain.setValueAtTime(src.gainNode.gain.value, now);
    src.gainNode.gain.linearRampToValueAtTime(0, now + fade);
    try { src.stop(now + fade + 0.02); } catch {}
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
