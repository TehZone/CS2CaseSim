// CS2's soundscapes: the map's env_soundscape entities (each where it's heard from, how far, and a soundscape event)
// pick the one you're in as Source does (the nearest whose radius you're inside and that can see you; you keep the last
// one until another takes over). It sets the room's reverb (its dsp_preset: Dust II's tunnels ring, its long A echoes
// off the walls) and plays the map's ambience: loops (the wind; a distant city, a buzzing light, where they are in the
// world) and one-shots now and then (sand blowing over a car, rocks falling somewhere near you), each by its own
// settings, fading in as you get there and out as you leave (a sound in both soundscapes carries on).
import { cs2Play } from '../cs2/api.js';
import { distanceGain } from './sound.js';

const CHECK = 0.5; // seconds between looks for the soundscape you're in
const DEPTH = 3; // soundscapes in soundscapes, this deep

export class Soundscapes {
  constructor(game, list = []) {
    this.game = game;
    this.bank = game.sounds;
    this.list = list.filter((s) => !s.off && s.e);
    this.active = null; // the env_soundscape you're in
    this.voices = new Map(); // event -> { info, src, pending, next (one-shots: when it plays again) }
    this.wait = 0;
    this.presets = {};
  }

  // Loads every soundscape's sounds and CS2's reverb presets, and makes the reverbs the map uses ahead (one at a time:
  // a big hall takes a moment).
  async load() {
    const events = [...new Set(this.list.map((s) => s.e))];
    if (!events.length) return;
    await this.bank.load(events);
    this.presets = await cs2Play('reverbs').catch(() => ({}));
    for (const name of new Set(events.map((e) => this.room(e)).filter(Boolean))) {
      if (this.game.disposed) return;
      this.bank.reverb(name, this.presets);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // A soundscape's sounds: its children, theirs, and so on (each played on its own: a soundscape in a soundscape has
  // a silent file, CS2's null.vsnd, and its children), Map event -> info.
  sounds(event, out = new Map(), depth = 0) {
    const info = this.bank.info[event];
    if (!info || depth > DEPTH) return out;
    if (depth > 0 && this.bank.has(event) && !this.bank.events[event].every((u) => /\/null\.\w+$/i.test(u))) out.set(event, info);
    for (const k of info.c || []) if (!out.has(k)) this.sounds(k, out, depth + 1);
    return out;
  }
  // Its reverb preset: its own, else one a soundscape in it has.
  room(event, depth = 0) {
    const info = this.bank.info[event];
    if (!info || depth > DEPTH) return null;
    if (info.dsp && info.ov !== false) return info.dsp;
    for (const k of info.c || []) { const r = this.room(k, depth + 1); if (r) return r; }
    return info.dsp || null;
  }

  update(dt) {
    if (!this.list.length) return;
    const g = this.game, ear = g.earPos();
    if ((this.wait -= dt) <= 0) {
      this.wait = CHECK;
      let best = null, bd = Infinity;
      for (const s of this.list) {
        const d = Math.hypot(s.o[0] - ear[0], s.o[1] - ear[1], s.o[2] - ear[2]);
        if ((s.r > 0 && d > s.r) || d >= bd || g.soundBlocked(ear, s.o)) continue;
        best = s; bd = d;
      }
      if (best && best.e !== this.active?.e) this.enter(best);
    }
    const now = g.sounds.ctx.currentTime;
    for (const [event, v] of this.voices) {
      if (v.info.rt) { if (now >= v.next) { this.oneShot(event, v.info, ear); v.next = now + rand(v.info.rt); } continue; }
      if (v.info.wp) this.follow(event, v, ear, now);
    }
  }

  // Into another soundscape: its reverb, and its sounds (the last one's fading out, unless this one has them too).
  enter(s) {
    this.active = s;
    this.bank.setRoom(this.room(s.e), this.presets);
    const want = this.sounds(s.e), now = this.bank.ctx.currentTime;
    for (const [event, v] of this.voices) {
      if (want.has(event)) continue;
      if (v.src) this.bank.fadeOut({ src: v.src, gain: v.src.gainNode }, v.info.fo ?? 2);
      this.voices.delete(event);
    }
    for (const [event, info] of want) {
      if (this.voices.has(event)) continue;
      const v = { info, src: null, next: now + rand(info.rt || [0, 0]) };
      this.voices.set(event, v);
      if (!info.rt && !info.wp) this.start(event, v, {}); // (where it is in the world: once you're near enough, see follow)
    }
  }

  start(event, v, opts) {
    v.pending = true;
    const info = v.info;
    this.bank.play(event, { volume: opts.pos ? 1 : info.v ?? 1, loop: true, offset: info.rs ? Math.random() : 0, fadeIn: info.fi ?? 0.4, occlude: false, alone: true, ...opts })
      .then((src) => { v.pending = false; if (!src) return; if (this.voices.get(event) === v) v.src = src; else src.stop(); });
  }

  // A loop somewhere in the world: louder as you get near (its distance curve), started once it's in earshot.
  follow(event, v, ear, now) {
    const p = v.info.wp, d = Math.hypot(p[0] - ear[0], p[1] - ear[1], p[2] - ear[2]);
    const level = (v.info.v ?? 1) * distanceGain(event, v.info, d);
    if (!v.src) { if (!v.pending && level > 0.003) this.start(event, v, { pos: p, listener: this.game }); return; }
    if (now > (v.since ??= now) + (v.info.fi ?? 0.4)) v.src.gainNode.gain.setTargetAtTime(level, now, 0.25);
  }

  // A one-shot: where it is in the world, or somewhere around you (rr: how far), or right with you.
  oneShot(event, info, ear) {
    let pos = info.wp || null;
    if (!pos && info.rr) {
      const a = Math.random() * 2 * Math.PI, r = rand(info.rr);
      pos = [ear[0] + Math.cos(a) * r, ear[1] + Math.sin(a) * r, ear[2] + (Math.random() - 0.3) * r * 0.3];
    }
    this.bank.play(event, pos ? { pos, listener: this.game, occlude: false, alone: true } : { volume: info.v ?? 1, alone: true });
  }

  dispose() {
    for (const v of this.voices.values()) if (v.src) this.bank.fadeOut({ src: v.src, gain: v.src.gainNode }, 0.2);
    this.voices.clear();
  }
}

const rand = ([lo, hi]) => lo + Math.random() * (hi - lo);
