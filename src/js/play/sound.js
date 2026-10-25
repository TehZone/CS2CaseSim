// Play mode sounds: CS2's sound events (each a set of variations) played through Web Audio the way CS2 plays them, by
// each event's own settings from the install (cs2/play.cjs soundEventInfo): its volume by distance (a gunshot is loud up
// close and dies away by 2500 units while its distant layer, a child event, takes over from 800), random pitch and
// volume, how much a wall in between muffles it, how much of the room it gets (the reverb of the soundscape you're in:
// see soundscape.js and reverb.js), and how many of it one source plays at once (a spray doesn't pile up its shots'
// tails). Sounds from the world are positioned in 3D (up close, plain stereo, as CS2's); yours play straight. Music and
// radio voices play on channels that hold one sound at a time: a new track fades out the last (CS2 cuts the round's
// music when the next part starts).
import { cs2Play } from '../cs2/api.js';
import { S } from '../state.js';
import { renderReverb } from './reverb.js';

// How far the events CS2 has no distance curve for carry (game units), like CS2's sound levels: past that a sound
// isn't played at all; it fades out towards the edge.
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
const MAX_HEAR = 8000; // nothing further away is heard (a gunshot's distant layer is, across most of a map)
const REVERB_RETURN = 0.4; // how loud the room comes back
const ROOM_FADE = 1; // seconds the reverb takes to change to another room's

// A curve's value at x: straight lines between its points, flat before the first and after the last.
export function curveAt(c, x) {
  if (!c?.length) return 1;
  if (x <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    const [x1, y1] = c[i];
    if (x <= x1) { const [x0, y0] = c[i - 1]; return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1; }
  }
  return c[c.length - 1][1];
}
const rnd = (r) => (r ? r[0] + Math.random() * (r[1] - r[0]) : 0);

// How loud an event is at a distance (game units) from you (before its own volume): its curve, or how far it carries.
export function distanceGain(event, info, d) {
  if (d > MAX_HEAR) return 0;
  if (info?.d) return curveAt(info.d, d);
  const r = soundRange(event);
  if (d > r) return 0;
  const near = Math.min(150, r * 0.15);
  return d > near ? Math.pow(1 - (d - near) / (r - near), 2) : 1;
}

// How loud one of your sounds (no position) and the events it plays along with it are, played at vol: its loudest
// layer at vol, the others as CS2 has them next to it right where they are (a gunshot's distant layer: not at all).
// infos: event -> info. { self, layers: [[event, volume]] }. (Against the event's own volume, one that's silent itself
// made its layers hundreds of times too loud: a headshot kill through a helmet, a dink and a thud under a silent event.)
export function layerVolumes(info, infos, vol) {
  const here = (i) => (i?.v ?? 1) * (i?.d ? curveAt(i.d, 0) : 1);
  const kids = (info?.c || []).filter((k) => infos[k]);
  const loudest = Math.max(here(info), ...kids.map((k) => here(infos[k])));
  if (!(loudest > 0)) return { self: 0, layers: [] };
  return { self: (vol * here(info)) / loudest, layers: kids.map((k) => [k, (vol * here(infos[k])) / loudest]).filter(([, v]) => v > vol * 0.01) };
}

export class SoundBank {
  constructor() {
    this.ctx = new AudioContext();
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.events = {}; // event -> [urls]
    this.info = {}; // event -> how CS2 plays it
    this.buffers = new Map(); // url -> Promise<AudioBuffer>
    this.last = new Map();
    this.channels = new Map(); // name -> { src, gain, token }
    this.playing = new Map(); // event|source -> [{ src, gain, fo }] (instance limits)
    this.lastStart = new Map(); // event|source -> when it last started (blocks)
    // The room: every sound sends some of itself here, and the reverb of the soundscape you're in plays it back.
    this.verbIn = this.ctx.createGain();
    this.verbs = new Map(); // preset -> AudioBuffer | null
    this.room = null; // { name, conv, gain }
    this.setVolume();
  }

  setVolume() { this.out.gain.value = S.settings?.volume ?? 0.6; }

  // Loads (extracting from the install as needed) a list of sound events, with how CS2 plays them and the events they
  // play along with them.
  async load(events, depth = 0) {
    const want = [...new Set(events)].filter((e) => !this.events[e]);
    if (!want.length) return;
    const [files, info] = await Promise.all([cs2Play('sounds', want).catch(() => ({})), cs2Play('soundInfo', want).catch(() => ({}))]);
    Object.assign(this.events, files);
    Object.assign(this.info, info);
    const kids = depth < 3 ? want.flatMap((e) => this.info[e]?.c || []).filter((e) => !this.events[e]) : [];
    await Promise.all([...want.flatMap((e) => (this.events[e] || []).map((u) => this.buffer(u))), kids.length ? this.load(kids, depth + 1) : null]);
  }
  add(map) {
    Object.assign(this.events, map);
    for (const urls of Object.values(map)) urls.forEach((u) => this.buffer(u));
    const names = Object.keys(map).filter((e) => !this.info[e]);
    if (names.length) cs2Play('soundInfo', names).then((i) => { Object.assign(this.info, i); this.load(names.flatMap((e) => i[e]?.c || [])); }).catch(() => {});
  }

  buffer(url) {
    if (!this.buffers.has(url)) {
      const p = fetch(url).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b)).catch(() => null);
      this.buffers.set(url, p);
    }
    return this.buffers.get(url);
  }

  has(event) { return !!this.events[event]?.length; }

  // Plays a random variation of an event, and the events it plays along with it. opts: { volume, pos (game units),
  // listener (Game: its ear and walls), rate, source (who's playing it: its own instances and blocks; by default yours
  // or the world's), startIf (checked once the sound has loaded), loop, fadeIn (seconds), occlude (false: never muffled),
  // alone (not the events it plays along with it) }. Resolves to its source node (src.gainNode: its volume).
  async play(event, opts = {}) {
    const { volume: vol = 1, pos = null, listener = null, rate = 1, source = null, startIf = null, loop = false, fadeIn = 0, occlude = true } = opts;
    const info = this.info[event], urls = this.events[event];
    const ear = pos && listener ? listener.earPos() : null;
    const d = ear ? Math.hypot(pos[0] - ear[0], pos[1] - ear[1], pos[2] - ear[2]) : 0;
    // A gunshot's distant layer, an explosion's debris...: each by its own settings (yours: see layerVolumes).
    let self = vol;
    if (info?.c && !opts.alone && (opts.depth || 0) < 2) {
      const sub = { ...opts, depth: (opts.depth || 0) + 1, startIf: null };
      if (pos) for (const k of info.c) this.play(k, sub);
      else {
        const mix = layerVolumes(info, this.info, vol);
        self = mix.self;
        for (const [k, v] of mix.layers) this.play(k, { ...sub, volume: v });
      }
    }
    if (!urls?.length) return;
    // In the world, its own volume by distance (yours keep the volume they're played at).
    let volume = self * (1 + (pos ? 0 : rnd(info?.vr)));
    if (ear) volume *= Math.max(0, (info?.v ?? 1) + rnd(info?.vr)) * distanceGain(event, info, d);
    if (volume < 0.003) return;
    const key = event + '|' + (source ?? (pos ? 'world' : 'you')), now = this.ctx.currentTime;
    if (info?.bl && now - (this.lastStart.get(key) ?? -1e9) < info.bl) return;
    let muffled = 0;
    if (ear && occlude && d > 120 && (info?.o ?? 0.6) > 0 && listener.soundBlocked(ear, pos)) {
      muffled = info?.o ?? 0.6;
      volume *= 1 - 0.5 * muffled;
    }
    if (this.ctx.state === 'suspended' && !this.hold) this.ctx.resume().catch(() => {});
    let i = Math.floor(Math.random() * urls.length);
    if (urls.length > 1 && i === this.last.get(event)) i = (i + 1) % urls.length;
    this.last.set(event, i);
    const buf = await this.buffer(urls[i]);
    if (!buf || (startIf && !startIf())) return;
    const ctx = this.ctx, t = ctx.currentTime + (info?.dl || 0);
    this.lastStart.set(key, t);
    // One source plays so many of an event at once: a new one fades out the oldest.
    if (info?.n) {
      const list = (this.playing.get(key) || []).filter((v) => !v.ended);
      while (list.length >= info.n) this.fadeOut(list.shift(), info.fo ?? 0.05);
      this.playing.set(key, list);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate * ((info?.p ?? 1) + rnd(info?.pr));
    const g = ctx.createGain();
    if (fadeIn > 0) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(volume, t + fadeIn); } else g.gain.value = volume;
    src.connect(g);
    let last = g;
    if (muffled) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 700 + 4000 * (1 - muffled);
      g.connect(lp); last = lp;
    }
    // Some of it to the room.
    const wet = info ? info.r ?? 0 : pos ? 0.3 : 0;
    if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; last.connect(s); s.connect(this.verbIn); }
    if (ear) {
      // Up close a sound is plain stereo, further away positioned; the panner only gives the direction, distance is in
      // the volume above.
      const stereo = info?.s ? Math.max(0, Math.min(1, curveAt(info.s, d))) : 0;
      if (stereo > 0) { const s = ctx.createGain(); s.gain.value = stereo; last.connect(s); s.connect(this.out); }
      if (stereo < 1) {
        const p = ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'linear';
        p.refDistance = 1; p.maxDistance = 100000; p.rolloffFactor = 0;
        // game units straight in: x/y horizontal, z up -> Web Audio's y up
        p.positionX.value = pos[0]; p.positionY.value = pos[2]; p.positionZ.value = -pos[1];
        const s = ctx.createGain();
        s.gain.value = 1 - stereo;
        last.connect(s); s.connect(p); p.connect(this.out);
      }
    } else last.connect(this.out);
    src.start(t, loop && opts.offset ? opts.offset * buf.duration : 0);
    src.gainNode = g;
    if (info?.n) {
      const v = { src, gain: g };
      this.playing.get(key).push(v);
      src.addEventListener('ended', () => { v.ended = true; });
    }
    return src;
  }

  // Fades a playing sound out ({ src, gain }) and stops it.
  fadeOut(v, secs) {
    const now = this.ctx.currentTime, gain = v.gain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + secs);
    try { v.src.stop(now + secs + 0.02); } catch {}
    v.ended = true;
  }

  // Plays an event on a channel (one sound at a time: without the events it plays along with it), fading out whatever
  // it was playing.
  async channel(name, event, opts = {}, fade = 0.5) {
    this.stop(name, fade);
    const ch = this.channels.get(name);
    const src = await this.play(event, { ...opts, alone: true, startIf: () => this.channels.get(name) === ch && !ch.src });
    if (src) { ch.src = src; src.onended = () => { if (ch.src === src) ch.src = null; }; }
    return src;
  }
  // Fades out a channel's sound (and drops one still loading).
  stop(name, fade = 0.5) {
    const old = this.channels.get(name);
    this.channels.set(name, { src: null });
    if (old?.src) this.fadeOut({ src: old.src, gain: old.src.gainNode }, fade);
  }

  // The room you're in: one of CS2's reverb presets (by name), what every sound's reverb plays through. The last
  // room's fades out as this one fades in. presets: { name: processors } (cs2Play('reverbs')).
  setRoom(name, presets) {
    if (this.room?.name === name) return;
    const old = this.room, now = this.ctx.currentTime;
    if (old?.gain) { old.gain.gain.setTargetAtTime(0, now, ROOM_FADE / 3); setTimeout(() => { try { this.verbIn.disconnect(old.conv); } catch {} old.gain.disconnect(); }, ROOM_FADE * 2000); }
    this.room = { name };
    const ir = this.reverb(name, presets);
    if (!ir) return;
    const conv = this.ctx.createConvolver(), gain = this.ctx.createGain();
    conv.normalize = false;
    conv.buffer = ir;
    gain.gain.setValueAtTime(0, now);
    gain.gain.setTargetAtTime(REVERB_RETURN, now, ROOM_FADE / 3);
    this.verbIn.connect(conv); conv.connect(gain); gain.connect(this.out);
    Object.assign(this.room, { conv, gain });
  }
  // A preset's impulse response (made once).
  reverb(name, presets) {
    if (!this.verbs.has(name)) {
      const r = renderReverb(presets?.[name], this.ctx.sampleRate);
      let buf = null;
      if (r) { buf = this.ctx.createBuffer(2, r.left.length, this.ctx.sampleRate); buf.copyToChannel(r.left, 0); buf.copyToChannel(r.right, 1); }
      this.verbs.set(name, buf);
    }
    return this.verbs.get(name);
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
