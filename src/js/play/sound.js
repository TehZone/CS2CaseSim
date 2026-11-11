// Play mode sounds: CS2's sound events (each a set of variations) played through Web Audio the way CS2 plays them, by
// each event's own settings from the install (cs2/play.cjs soundEventInfo): its volume by distance (a gunshot is loud up
// close and dies away by 2500 units while its distant layer, a child event, takes over from 800), random pitch and
// volume, how much a wall in between muffles it, how much of the room it gets (the reverb of the soundscape you're in:
// see soundscape.js and reverb.js), and how many of it one source plays at once (a spray doesn't pile up its shots'
// tails). Sounds from the world are positioned in 3D (up close, plain stereo, as CS2's; see spatial); yours play
// straight. Music and radio voices play on channels that hold one sound at a time: a new track fades out the last (CS2
// cuts the round's music when the next part starts). Everything goes out at the volume setting through CS2's final
// limiter (FinalMixGlue in its __main__.vmix: see ducker.worklet.js).
import { cs2Play } from '../cs2/api.js';
import { S, on } from '../state.js';
import { renderReverb, ROOM_EQ } from './reverb.js';

// ---- the mix ----------------------------------------------------------------------------------------------------------
// CS2's mix (scripts/soundmixers.txt, its Default_Mix): each mixgroup's volume. The game plays its gunshots at their
// own volume (CS2 at 0.6 of it, its Weapons group), so every group here is against that: footsteps 4/3 as loud as
// they'd be next to a gunshot without it (a bot's step 300 units ahead was 13 dB under a gunshot there, now 8 dB).
const CS2_MIX = { Weapons: 0.6, Footsteps: 0.8, Ambient: 0.45 };
const FOOTSTEP = /^(CT_|T_|Land_)|\.Step(Left|Right)$/i; // (CS2's Footsteps group: every step, ladder rung and landing)
// The maps' ambience is in a group of its own under Ambient, by map (Dust II's at 0.4 of Ambient's 0.45, Nuke's 0.15):
// the whole of it, by the first part of its soundscapes' event names (de_eldorado's are aztec.*). Others: Ambient's.
const MAP_AMBIENCE = { dust2: 0.4, inferno: 0.402, nuke: 0.15, overpass: 0.728, de_overpass: 0.728, vertigo: 0.272, aztec: 0.22, ancient: 0.22,
  mirage: 1, train: 0.5, office: 0.35, italy: 0.686, cache: 1, cbble: 0.918, militia: 0.53, bank: 1, canals: 0.554 };
const ANUBIS = 0.522; // (Anubis's group isn't under Ambient)
// The round's music, quieter than it was (CS2 sets it by its own volume settings, not a mixgroup): the round-start
// track was 5 dB over a bot's footstep 300 units ahead, now 6 dB under it.
const MUSIC_LEVEL = 0.5;

// How loud an event is in the mix, against a gunshot (1).
export function mixLevel(event) {
  if (FOOTSTEP.test(event)) return CS2_MIX.Footsteps / CS2_MIX.Weapons;
  if (/^Music\./i.test(event)) return MUSIC_LEVEL;
  return 1;
}
// How loud a map's ambience (its soundscapes' sounds) is in the mix, against a gunshot.
export function ambientLevel(event) {
  const map = String(event).split('.')[0].toLowerCase();
  return (map === 'anubis' ? ANUBIS : CS2_MIX.Ambient * (MAP_AMBIENCE[map] ?? 1)) / CS2_MIX.Weapons;
}

// ---- where a sound is heard from --------------------------------------------------------------------------------------
// A sound in the world plays through CS2's two halves (csgo_voice_main.vmix): plain stereo up close (its own curve, a
// gunshot until 300 units, a step until 60) and the rest through an HRTF (CS2's is Steam Audio's; here the browser's,
// which fades a panner in from where it last pointed over its first 43 ms: see pickVoice). On top of the
// HRTF, so a direction is easy to tell: the ear away from it quieter (the HRTF alone gave a footstep at 90 degrees 3 dB
// between the ears, most of its sound being low, where heads don't shadow), the treble down behind you (muffled) and
// below (with more bass: through the floor), up above (thinner), and CS2's distance EQ (its EQ82, mixed in from 300 to
// 1800 units: bass 16 dB and treble 9 dB down, far away). The HRTF's own elevation is kept within 45 degrees: the
// browser's has nothing under -45 and gets duller all the way up (overhead sounded like behind).
const FAR_EAR_DB = 8; // the far ear, a sound straight to your side (less as it's more ahead or behind)
const BEHIND_DB = -7; // treble straight behind (above 4.2 kHz, CS2's distance EQ's shelf)
const ABOVE_DB = 3, ABOVE_BASS_DB = -2; // straight above
const BELOW_DB = -4, BELOW_BASS_DB = 3; // straight below
const MAX_ELEVATION = Math.PI / 4;
export const SHELVES = { bass: 145.54, treble: 4203.16 }; // Hz (CS2's EQ82)
const DISTANCE_EQ = [[300.54, 0], [1334.53, 0.53], [1806.8, 1]], DISTANCE_BASS = -15.85, DISTANCE_TREBLE = -9.03;
const dbGain = (db) => Math.pow(10, db / 20);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Your ears' frame (game units: x/y horizontal, z up) from where you look: { f ahead, r right, u up }, into out.
export function listenerBasis(forward, up = null, out = { f: [1, 0, 0], r: [0, -1, 0], u: [0, 0, 1] }) {
  const fl = Math.hypot(forward[0], forward[1], forward[2]) || 1, f = out.f, r = out.r, u = out.u;
  f[0] = forward[0] / fl; f[1] = forward[1] / fl; f[2] = forward[2] / fl;
  const w = up || [0, 0, 1];
  // right = ahead x up (Source's: yaw 0 looks along +x, its right is -y), then up again square to both
  r[0] = f[1] * w[2] - f[2] * w[1]; r[1] = f[2] * w[0] - f[0] * w[2]; r[2] = f[0] * w[1] - f[1] * w[0];
  const rl = Math.hypot(r[0], r[1], r[2]);
  if (rl < 1e-6) { r[0] = 0; r[1] = -1; r[2] = 0; } else { r[0] /= rl; r[1] /= rl; r[2] /= rl; }
  u[0] = r[1] * f[2] - r[2] * f[1]; u[1] = r[2] * f[0] - r[0] * f[2]; u[2] = r[0] * f[1] - r[1] * f[0];
  return out;
}
// Where pos is from your ear, in your frame: [right, up, ahead], a unit vector (ahead when it's right at your ear).
export function direction(pos, ear, b, out = [0, 0, 1]) {
  const x = pos[0] - ear[0], y = pos[1] - ear[1], z = pos[2] - ear[2], d = Math.hypot(x, y, z);
  if (d < 1e-3) { out[0] = 0; out[1] = 0; out[2] = 1; return out; }
  out[0] = (x * b.r[0] + y * b.r[1] + z * b.r[2]) / d;
  out[1] = (x * b.u[0] + y * b.u[1] + z * b.u[2]) / d;
  out[2] = (x * b.f[0] + y * b.f[1] + z * b.f[2]) / d;
  return out;
}
// How a sound d units away in a direction (direction's) is heard: { near (its plain stereo share), far (its HRTF
// share), pan (where the HRTF puts it: Web Audio's frame, the listener at the origin looking down -z), left, right
// (each ear's volume), bass, treble (dB, the two shelves) }. A sound CS2 never positions (a soundscape's distant city,
// plain stereo at every distance) keeps both ears and its tone.
export function spatial(info, d, dir) {
  const near = info?.s ? clamp(curveAt(info.s, d), 0, 1) : 0;
  const flat = !!info?.s && info.s.every((p) => p[1] >= 1);
  const [x, y, z] = dir;
  // the HRTF's direction, its elevation within MAX_ELEVATION
  let px = x, py = y, pz = z;
  const el = Math.asin(clamp(y, -1, 1));
  if (Math.abs(el) > MAX_ELEVATION) {
    const h = Math.hypot(x, z), c = Math.cos(MAX_ELEVATION);
    py = Math.sign(y) * Math.sin(MAX_ELEVATION);
    if (h > 1e-6) { px = (x / h) * c; pz = (z / h) * c; } else { px = 0; pz = c; }
  }
  const m = curveAt(DISTANCE_EQ, d);
  let bass = 20 * Math.log10(1 - m + m * dbGain(DISTANCE_BASS)), treble = 20 * Math.log10(1 - m + m * dbGain(DISTANCE_TREBLE));
  let left = 1, right = 1;
  if (!flat) {
    const far = dbGain(-FAR_EAR_DB * Math.abs(x));
    if (x > 0) left = far; else right = far;
    treble += BEHIND_DB * Math.max(0, -z) + (y > 0 ? ABOVE_DB * y : -BELOW_DB * y);
    bass += y > 0 ? ABOVE_BASS_DB * y : -BELOW_BASS_DB * y;
  }
  return { near, far: 1 - near, pan: [px, py, -pz], left, right, bass, treble };
}
// Which free voice a sound in a direction gets (index into free, each { dir }), or -1 for a new one: the one last
// pointed nearest it, if that's within MATCH (the browser's HRTF fades from where a voice last pointed to where it's
// told over its first 43 ms: a step on your left on the voice of one on your right was heard on the right), or once
// there are max voices, the nearest anyway (a new HRTF panner for it if that's further off: see SoundBank.voice).
const MATCH = Math.cos((15 * Math.PI) / 180);
export const MAX_VOICES = 96;
// A playing sound is pointed again once you've turned (or it's moved) this far from it: the browser's HRTF has a
// direction every 1.5 degrees, and fades over 43 ms (two HRTFs at once) every time it's moved.
const REAIM = Math.cos((1.5 * Math.PI) / 180);
export function pickVoice(free, dir, count, max = MAX_VOICES) {
  let k = -1, best = -2;
  for (let i = 0; i < free.length; i++) {
    const v = free[i].dir, c = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
    if (c > best) { best = c; k = i; }
  }
  return k >= 0 && (best >= MATCH || count >= max) ? k : -1;
}

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
// How loud the room comes back, after CS2's EQ and compressor (see roomOut). (CS2's at full; this a little under, where
// a footstep's room is a touch quieter than it was before those, and a gunshot's a lot.)
const REVERB_RETURN = 0.6;
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
    this.out = this.ctx.createGain(); // everything, at the volume setting, then the final limiter (see roomOut)
    this.out.connect(this.ctx.destination);
    // Every sound but the music and the radio (CS2's AllVoices): what the room is ducked under (see roomOut).
    this.dry = this.ctx.createGain();
    this.dry.connect(this.out);
    // (The browser loads its HRTF the first time a panner asks for it, and pans to silence until then: now.)
    this.warm = this.ctx.createPanner();
    this.warm.panningModel = 'HRTF';
    this.events = {}; // event -> [urls]
    this.info = {}; // event -> how CS2 plays it
    this.buffers = new Map(); // url -> Promise<AudioBuffer>
    this.last = new Map();
    this.channels = new Map(); // name -> { src, gain, token }
    this.playing = new Map(); // event|source -> [{ src, gain, fo }] (instance limits)
    this.lastStart = new Map(); // event|source -> when it last started (blocks)
    this.voices = new Map(); // where a sound in the world goes -> its free voices (see voice)
    this.voiceCount = 0;
    this.active = new Set(); // the voices playing (turned with you: see setListener)
    this.ear = [0, 0, 0]; // where you hear from and which way you face (setListener)
    this.basis = listenerBasis([1, 0, 0]);
    // The room: every sound sends some of itself here, and the reverb of the soundscape you're in plays it back.
    this.verbIn = this.ctx.createGain();
    this.verbOut = this.ctx.createGain(); // the room's reverb, on its way out
    this.verbs = new Map(); // preset -> AudioBuffer | null
    this.rooms = new Map(); // preset -> { name, conv, gain, wired, off } (see roomFor)
    this.room = null; // the one you're in
    this.roomOut();
    this.setVolume();
    this.offVolume = on('volume', () => this.setVolume()); // (changed in the settings, with a match running)
  }

  // The room comes out through CS2's reverb compressor (ducker.worklet.js), turned down while the sounds themselves are
  // loud, as CS2's main mix has it, and everything through its final limiter (loud moments held under clipping);
  // straight out until they have loaded (or without them).
  roomOut() {
    const ctx = this.ctx;
    this.verbOut.connect(this.out);
    ctx.audioWorklet?.addModule(new URL('./ducker.worklet.js', import.meta.url)).then(() => {
      if (ctx.state === 'closed') return;
      const limit = new AudioWorkletNode(ctx, 'cs2-final-limiter', { numberOfInputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      this.out.disconnect();
      this.out.connect(limit);
      limit.connect(ctx.destination);
      this.limiter = limit;
      const duck = new AudioWorkletNode(ctx, 'cs2-room-ducker', { numberOfInputs: 2, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      this.verbOut.disconnect();
      this.verbOut.connect(duck, 0, 0);
      this.dry.connect(duck, 0, 1);
      duck.connect(this.out);
      this.ducker = duck;
    }).catch(() => {});
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
  // alone (not the events it plays along with it), bypass (not one the room ducks under: music, the radio) }. Resolves to
  // its source node (src.gainNode: its volume).
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
    // In the world, its own volume by distance (yours keep the volume they're played at); and its place in the mix.
    let volume = self * (1 + (pos ? 0 : rnd(info?.vr))) * mixLevel(event);
    if (ear) volume *= Math.max(0, (info?.v ?? 1) + rnd(info?.vr)) * distanceGain(event, info, d);
    if (volume < 0.003) return;
    const who = source && typeof source === 'object' ? 'bot' + source.index : source; // (a bot: by its number, not "[object Object]" for all of them)
    const key = event + '|' + (who ?? (pos ? 'world' : 'you')), now = this.ctx.currentTime;
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
    const ctx = this.ctx, t = ctx.currentTime + (info?.dl || 0), dest = opts.bypass ? this.out : this.dry;
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
    // Some of it to the room.
    const wet = info ? info.r ?? 0 : pos ? 0.3 : 0;
    if (ear) {
      // In the world: through a voice, muffled by the walls in between, some to the room, and heard from where it is
      // (see spatial: the panner only gives the direction, distance is in the volume above), turned with you as it plays.
      const dir = direction(pos, ear, this.basis), v = this.voice(dest, dir);
      v.at[0] = pos[0]; v.at[1] = pos[1]; v.at[2] = pos[2];
      v.info = info;
      v.lp.frequency.value = muffled ? 700 + 4000 * (1 - muffled) : ctx.sampleRate / 2; // (at half the rate it passes everything)
      v.wet.gain.value = wet;
      this.aim(v, dir, d);
      g.connect(v.lp);
      this.active.add(v);
      src.addEventListener('ended', () => { g.disconnect(); this.active.delete(v); this.voices.get(dest).push(v); });
    } else {
      if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s); s.connect(this.verbIn); }
      g.connect(dest);
    }
    src.start(t, loop && opts.offset ? opts.offset * buf.duration : 0);
    src.gainNode = g;
    if (info?.n) {
      const v = { src, gain: g };
      this.playing.get(key).push(v);
      src.addEventListener('ended', () => { v.ended = true; });
    }
    return src;
  }

  // A free voice for a sound in the world in a direction from you (direction's) going to dest (the room ducks under it,
  // or not): its muffling (a lowpass), its share to the room, its tone (CS2's two shelves), its stereo and positioned
  // (HRTF panner) halves and each ear's volume, wired together once and used again by the next sound when its sound
  // ends. (Each sound had its own: Chromium deletes the insides of the nodes a garbage collection frees on the main
  // thread, all at once after a full one: 32 ms between two frames in one round.) The free one last pointed that way, or
  // a new one (see pickVoice).
  voice(dest, dir) {
    if (!this.voices.has(dest)) this.voices.set(dest, []);
    const free = this.voices.get(dest), k = pickVoice(free, dir, this.voiceCount);
    if (k >= 0) {
      const v = free[k];
      free[k] = free[free.length - 1];
      free.pop();
      // All MAX_VOICES made and none free pointed near this way (a 5v5 got there in under a minute, then 43% of sounds
      // were): a new panner for it, the rest of the voice kept (the browser's HRTF would fade its first 43 ms in from
      // where the old one last pointed: a step on your right was heard on your left).
      if (v.dir[0] * dir[0] + v.dir[1] * dir[1] + v.dir[2] * dir[2] < MATCH) {
        v.far.disconnect(); v.pan.disconnect();
        v.pan = this.panner();
        v.far.connect(v.pan); v.pan.connect(v.split);
      }
      return v;
    }
    this.voiceCount++;
    const ctx = this.ctx;
    const v = { lp: ctx.createBiquadFilter(), bass: ctx.createBiquadFilter(), treble: ctx.createBiquadFilter(), wet: ctx.createGain(), near: ctx.createGain(), far: ctx.createGain(),
      pan: this.panner(), split: ctx.createChannelSplitter(2), left: ctx.createGain(), right: ctx.createGain(), merge: ctx.createChannelMerger(2), at: [0, 0, 0], dir: [dir[0], dir[1], dir[2]], d: 0, info: null };
    v.lp.type = 'lowpass';
    v.bass.type = 'lowshelf'; v.bass.frequency.value = SHELVES.bass;
    v.treble.type = 'highshelf'; v.treble.frequency.value = SHELVES.treble;
    v.near.channelCount = 2; v.near.channelCountMode = 'explicit'; v.near.channelInterpretation = 'speakers'; // (a mono sound to both ears)
    const p = v.pan;
    // (Moved once a block, not sample by sample: Chromium works out the panner's direction and the shelves' filters
    // again for every sample of a block while they're moving: a firefight you turn in took 40% longer to render.)
    for (const a of [v.bass.gain, v.treble.gain]) try { a.automationRate = 'k-rate'; } catch {}
    v.lp.connect(v.wet); v.wet.connect(this.verbIn);
    v.lp.connect(v.bass); v.bass.connect(v.treble);
    v.treble.connect(v.near); v.near.connect(v.split);
    v.treble.connect(v.far); v.far.connect(p); p.connect(v.split);
    v.split.connect(v.left, 0); v.split.connect(v.right, 1);
    v.left.connect(v.merge, 0, 0); v.right.connect(v.merge, 0, 1);
    v.merge.connect(dest);
    return v;
  }
  // A voice's positioned half: the browser's HRTF, told only the direction (distance is in the volume: see play).
  panner() {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.refDistance = 1; p.maxDistance = 100000; p.rolloffFactor = 0;
    for (const a of [p.positionX, p.positionY, p.positionZ]) try { a.automationRate = 'k-rate'; } catch {} // (see voice)
    return p;
  }
  // Points a voice d units away in a direction (direction's, kept as where it last pointed): its HRTF, ears and tone
  // (see spatial), straight away for a sound starting (now null), else easing there (it's playing, you turned).
  aim(v, dir, d, now = null) {
    const s = spatial(v.info, d, dir);
    v.dir[0] = dir[0]; v.dir[1] = dir[1]; v.dir[2] = dir[2];
    v.d = d;
    v.pan.positionX.value = s.pan[0]; v.pan.positionY.value = s.pan[1]; v.pan.positionZ.value = s.pan[2];
    this.param(v.near.gain, s.near, now); this.param(v.far.gain, s.far, now);
    this.param(v.left.gain, s.left, now); this.param(v.right.gain, s.right, now);
    this.param(v.bass.gain, s.bass, now); this.param(v.treble.gain, s.treble, now);
  }
  param(p, x, now) {
    if (now == null) { p.cancelScheduledValues(0); p.value = x; } else p.setTargetAtTime(x, now, 0.015);
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
    const src = await this.play(event, { ...opts, alone: true, bypass: true, startIf: () => this.channels.get(name) === ch && !ch.src });
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
  // room's fades out as this one fades in, and is cut off from the sounds once it's quiet. presets: { name: processors }
  // (cs2Play('reverbs')).
  setRoom(name, presets) {
    if (this.room?.name === name) return;
    const old = this.room, now = this.ctx.currentTime;
    if (old?.gain) {
      old.gain.gain.setTargetAtTime(0, now, ROOM_FADE / 3);
      clearTimeout(old.off);
      old.off = setTimeout(() => { if (this.room !== old) this.wire(old, false); }, ROOM_FADE * 2000);
    }
    const room = this.roomFor(name, presets);
    this.room = room;
    if (!room.conv) return;
    clearTimeout(room.off);
    this.wire(room, true);
    room.gain.gain.setTargetAtTime(REVERB_RETURN, now, ROOM_FADE / 3);
  }
  // A preset's reverb, made once: a convolver works its impulse response over on the main thread as it's given it (7 ms
  // a second of it: a hitch of 20 ms and more every time you walked into another room). See Soundscapes.load.
  roomFor(name, presets) {
    let room = this.rooms.get(name);
    if (!room) {
      room = { name, conv: null, gain: null, wired: false, off: 0 };
      const ir = this.reverb(name, presets);
      if (ir) {
        room.conv = this.ctx.createConvolver(); room.gain = this.ctx.createGain();
        room.conv.normalize = false;
        room.conv.buffer = ir;
        room.gain.gain.value = 0;
        room.conv.connect(room.gain);
      }
      this.rooms.set(name, room);
    }
    return room;
  }
  wire(room, on) {
    if (!room.conv || room.wired === on) return;
    room.wired = on;
    if (on) { this.verbIn.connect(room.conv); room.gain.connect(this.verbOut); } else { try { this.verbIn.disconnect(room.conv); room.gain.disconnect(this.verbOut); } catch {} }
  }
  // A preset's impulse response, with CS2's EQ on the room after it (made once).
  reverb(name, presets) {
    if (!this.verbs.has(name)) {
      const chain = presets?.[name];
      const r = renderReverb(chain?.length ? [...chain, ...ROOM_EQ] : null, this.ctx.sampleRate);
      let buf = null;
      if (r) { buf = this.ctx.createBuffer(2, r.left.length, this.ctx.sampleRate); buf.copyToChannel(r.left, 0); buf.copyToChannel(r.right, 1); }
      this.verbs.set(name, buf);
    }
    return this.verbs.get(name);
  }

  // Ears at the player's eye, facing their view (game units; up: the view's, else square to it from straight up), and
  // the sounds playing in the world turned to match (Web Audio's own listener stays put: each voice is told where its
  // sound is from you, see spatial). Every tick.
  setListener(eye, forward, up = null) {
    this.ear[0] = eye[0]; this.ear[1] = eye[1]; this.ear[2] = eye[2];
    listenerBasis(forward, up, this.basis);
    if (!this.active.size) return;
    const now = this.ctx.currentTime, dir = (this.dirTmp ||= [0, 0, 1]);
    this.active.forEach((v) => {
      direction(v.at, this.ear, this.basis, dir);
      const d = Math.hypot(v.at[0] - this.ear[0], v.at[1] - this.ear[1], v.at[2] - this.ear[2]);
      if (dir[0] * v.dir[0] + dir[1] * v.dir[1] + dir[2] * v.dir[2] > REAIM && Math.abs(d - v.d) < 1 + 0.02 * d) return;
      this.aim(v, dir, d, now);
    });
  }

  dispose() { this.offVolume(); this.ctx.close().catch(() => {}); }
}
