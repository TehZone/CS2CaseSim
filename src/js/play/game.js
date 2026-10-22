// Play mode: one offline match on a CS2 map. Owns the renderer, the 64-tick simulation (player movement, weapons,
// bots) and the frame loop. Rendering interpolates between ticks like CS2's client does; your weapon is drawn in its
// own pass with CS2's viewmodel field of view.
import * as THREE from 'three';
import { cs2Play } from '../cs2/api.js';
import { equipped } from '../loadout.js';
import { itemDef } from '../items.js';
import { D } from '../data.js';
import { CollisionWorld, FLAG_BULLET, FLAG_PLAYER } from './collision.js';
import { PlayerMovement } from './movement.js';
import { loadWorld, toGl } from './world.js';
import { Input } from './input.js';
import { SoundBank } from './sound.js';
import { buildViewmodel } from './viewmodel.js';
import { Arsenal, Gun, basis } from './weapons.js';
import { loadBotAssets, Bot } from './bots.js';
import { Effects } from './effects.js';
import { Hud } from './hud.js';
import { NavMesh } from './nav.js';

export const TICK = 1 / 64;
// A CS2 field of view (horizontal degrees at 4:3) as three.js's vertical FOV; wider screens see more, like CS2.
const vfov = (fov43) => (2 * Math.atan(Math.tan((fov43 * Math.PI) / 360) * 0.75) * 180) / Math.PI;
const FOV = 90, VIEWMODEL_FOV = 68;
const VIEWMODEL_OFFSET = [1, 1, -1]; // CS2 viewmodel_offset_x/y/z (inches)

const SURFACE_STEP = { concrete: 'Concrete', rock: 'Concrete', tile: 'Tile', sand: 'Sand', dirt: 'Dirt', wood: 'Wood', wood_solid: 'Wood_Solid',
  wood_panel: 'Wood', wood_plank: 'Wood', wood_dense: 'Wood', wood_crate: 'Wood', wood_basket: 'Wood_Basket', wood_tree: 'Wood', metal: 'SolidMetal',
  solidmetal: 'SolidMetal', metalpanel: 'SolidMetal', metalvent: 'MetalVent', metalvehicle: 'MetalVehicle', metal_sand_barrel: 'MetalBarrel',
  metal_dumpster: 'SolidMetal', chainlink: 'ChainLink', glass: 'Glass', carpet: 'Default', default: 'Default' };
const SURFACE_IMPACT = { concrete: 'Concrete', rock: 'Concrete', tile: 'Tile', sand: 'Sand', dirt: 'Dirt', metal: 'SolidMetal', solidmetal: 'SolidMetal',
  metalpanel: 'SolidMetal', metalvent: 'SolidMetal', metalvehicle: 'MetalVehicle', metal_sand_barrel: 'MetalBarrel', metal_dumpster: 'SolidMetal',
  chainlink: 'ChainLink', glass: 'Glass', carpet: 'Carpet', pottery: 'Pottery', computer: 'Computer' };
const stepName = (s) => SURFACE_STEP[String(s).toLowerCase()] || (/wood/i.test(s) ? 'Wood' : /metal/i.test(s) ? 'SolidMetal' : 'Default');
const impactName = (s) => SURFACE_IMPACT[String(s).toLowerCase()] || (/wood/i.test(s) ? 'Wood' : /metal/i.test(s) ? 'SolidMetal' : 'Default');

const DEFAULT_KNIFE = { T: { wid: 'weapon_knife_t', w: 'Knife', n: 'Knife', cat: 'knife', v: true }, CT: { wid: 'weapon_knife', w: 'Knife', n: 'Knife', cat: 'knife', v: true } };

export class Game {
  constructor(root, { map = 'de_dust2', team = 'CT', primary = 'weapon_ak47', secondary = 'weapon_usp_silencer', bots = 8, sensitivity = 1.25, quality = 'balanced', onStatus = () => {} } = {}) {
    Object.assign(this, { root, mapId: map, team, primaryId: primary, secondaryId: secondary, botCount: Math.max(1, Math.min(20, bots | 0)), onStatus });
    this.disposed = false;
    this.paused = true;
    this.listeners = new Set();
    this.now = 0;
    this.stats = { kills: 0, headshots: 0, shots: 0, hits: 0 };
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'play-canvas';
    root.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    // Quality: high renders at the screen's full resolution with soft shadows; balanced at 1 CSS pixel; performance lower.
    this.renderer.setPixelRatio(quality === 'high' ? Math.min(window.devicePixelRatio, 2) : quality === 'performance' ? 0.75 : 1);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.75;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // the map's shadows are static: rendered once after loading
    this.renderer.autoClear = false;
    this.camera = new THREE.PerspectiveCamera(vfov(FOV), 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(vfov(VIEWMODEL_FOV), 1, 0.005, 10);
    this.vmCamera.rotation.order = 'YXZ';
    this.vmRoot = new THREE.Group();
    this.vmRoot.rotation.order = 'YXZ';
    this.vmScene.add(this.vmRoot);
    this.input = new Input(this.canvas, { sensitivity, onLockChange: (locked) => this.lockChanged(locked) });
    this.baseSensitivity = sensitivity;
    this.hud = new Hud(root);
    this.resize = this.resize.bind(this);
    this.resizer = new ResizeObserver(this.resize);
    this.resizer.observe(root);
    this.resize();
  }

  emit(type, data) { for (const fn of this.listeners) fn(type, data); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async load() {
    const status = (m) => { if (!this.disposed) this.onStatus(m); };
    status('Preparing the map from your CS2 install (the first time takes a couple of minutes)…');
    let done = false;
    (async () => {
      while (!done && !this.disposed) {
        const p = await cs2Play('progress', 'map:' + this.mapId).catch(() => null);
        if (p && !done) status(p);
        await new Promise((r) => setTimeout(r, 700));
      }
    })();
    const map = await cs2Play('map', this.mapId).finally(() => { done = true; });
    if (this.disposed) return;
    this.map = map;
    status('Loading collision…');
    const colBuf = await fetch(map.collision).then((r) => r.arrayBuffer());
    this.collision = new CollisionWorld(colBuf, map.info.collision);
    if (map.nav) this.nav = new NavMesh(await fetch(map.nav).then((r) => r.json()));
    this.world = await loadWorld(map, this.renderer, { onProgress: status });
    if (this.disposed) return;
    this.scene = this.world.scene;
    this.setupViewmodelLighting();
    this.effects = new Effects(this.scene, this.vmScene);

    status('Loading your weapons…');
    this.sounds = new SoundBank();
    const enemy = this.team === 'CT' ? 'T' : 'CT';
    const [guns] = await Promise.all([this.loadWeapons(), this.sounds.load(this.commonSounds())]);
    if (this.disposed) return;
    this.arsenal = new Arsenal(this, guns);

    status('Loading bots…');
    this.botAssets = await loadBotAssets(this.renderer, this.world.ambient, { teams: [enemy] });
    if (this.disposed) return;
    this.spawnPlayer(this.team);
    this.bots = [];
    for (let i = 0; i < this.botCount; i++) {
      const b = new Bot(this.botAssets, enemy, i);
      this.scene.add(b.root);
      this.bots.push(b);
      this.placeBot(b);
    }
    status('Compiling shaders…');
    this.renderer.compile(this.scene, this.camera);
    this.renderer.compile(this.vmScene, this.vmCamera);
    this.renderer.shadowMap.needsUpdate = true;
    this.arsenal.select(guns.primary ? 'primary' : 'secondary', this.now);
    this.hud.vitals(100, 100);
    this.emit('loaded');
  }

  // Primary, pistol and knife, each with your equipped skin (and your equipped gloves on the hands).
  async loadWeapons() {
    const gloves = equipped('gloves');
    const vanilla = (wid) => {
      const any = Object.values(D.skins).find((s) => s.wid === wid);
      return { wid, w: any?.w || wid, n: any?.w || wid, cat: any?.cat || 'rifle', v: true };
    };
    const slots = [['primary', this.primaryId], ['secondary', this.secondaryId]];
    const out = {};
    const make = async (slot, wid, item, def) => {
      try {
        const data = await cs2Play('weapon', wid);
        const vm = await buildViewmodel(item, def, data, { gloves, renderer: this.renderer });
        this.sounds.add(data.sounds);
        this.vmRoot.add(vm.rig);
        vm.rig.visible = false;
        out[slot] = new Gun({ slot, id: wid, name: def.v ? def.w : `${def.w} | ${def.n?.split(' | ')[1] || def.n}`, stats: data.stats || {}, sounds: data.sounds, vm });
      } catch (e) { console.warn('weapon failed', wid, e); }
    };
    const jobs = slots.filter(([, wid]) => wid).map(([slot, wid]) => {
      const def0 = vanilla(wid);
      const item = equipped('w:' + def0.w);
      const def = item ? itemDef(item) : def0;
      return make(slot, wid, item || { t: 'skin', fl: 0, sd: 0 }, def);
    });
    const knife = equipped('knife');
    const kdef = knife ? itemDef(knife) : DEFAULT_KNIFE[this.team];
    const kwid = kdef.wid?.startsWith('weapon_') ? kdef.wid : Object.values(D.skins).find((s) => s.w === kdef.w && s.wid.startsWith('weapon_'))?.wid || 'weapon_knife';
    jobs.push(make('knife', kwid, knife || { t: 'skin', fl: 0, sd: 0 }, kdef));
    await Promise.all(jobs);
    if (!Object.keys(out).length) throw new Error('Could not load any weapon models');
    return out;
  }

  commonSounds() {
    const surfaces = this.map.info.collision.surfaces;
    const steps = [...new Set(surfaces.map(stepName))].flatMap((s) => [`CT_${s}.StepLeft`, `CT_${s}.StepRight`, `Land_${s}.StepLeft`]);
    const impacts = [...new Set(surfaces.map(impactName))].map((s) => `${s}.BulletImpact`);
    return [...steps, ...impacts, 'Default.BulletImpact', 'Flesh.BulletImpact', 'Default.ClipEmpty_Rifle', 'Default.ClipEmpty_Pistol',
      'Weapon_AWP.Zoom', 'Weapon_AWP.ZoomOut', 'Player.DamageBody.AttackerFeedback', 'Player.DamageBodyArmor.AttackerFeedback',
      'Player.DamageHeadShot.AttackerFeedback', 'Player.DamageHeadShotArmor.AttackerFeedback', 'Player.DeathHeadShot.AttackerFeedback',
      'Player.DeathHeadShotArmor.AttackerFeedback', 'Player.DeathBody.AttackerFeedback', 'Player.DeathBodyArmor.AttackerFeedback',
      'Weapon_Knife.Hit', 'Weapon_Knife.HitWall', 'Weapon_Knife.Slash', 'Weapon_Knife.Stab', 'Weapon_Knife.Deploy', 'Weapon_Knife.Swish.Heavy',
      'Default.Land', 'BulletBy.Supersonic.Crack'];
  }

  setupViewmodelLighting() {
    const w = this.world;
    this.vmSun = new THREE.DirectionalLight(w.sun.color, w.sun.intensity);
    this.vmSun.position.copy(w.sun.position).sub(w.sun.target.position).normalize();
    this.vmScene.add(this.vmSun);
    const amb = w.ambient;
    this.vmScene.add(new THREE.HemisphereLight(amb.sky.value.clone().multiplyScalar(2.2), amb.ground.value.clone().multiplyScalar(2.2), 1));
    if (w.sky) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.vmEnv = pm.fromEquirectangular(w.sky).texture;
      pm.dispose();
      this.vmScene.environment = this.vmEnv;
      this.vmScene.environmentIntensity = 0.45;
    }
    this.sunVis = 1;
  }

  spawnPlayer(team) {
    const spawns = this.map.info.spawns[team] || this.map.info.spawns.T;
    const top = Math.max(...spawns.map((x) => x.priority));
    const best = spawns.filter((s) => s.priority === top);
    const sp = best[Math.floor(Math.random() * best.length)];
    this.player = new PlayerMovement(this.collision, sp.origin);
    this.input.yaw = sp.yaw;
    this.input.pitch = 0;
    this.prevEye = this.player.eye();
    this.spawnPoint = sp.origin;
  }

  // A random standing spot for a bot on the nav mesh, where a player fits, away from you and the other bots.
  placeBot(bot) {
    const me = this.player.origin;
    const fits = (o) => { const tr = this.collision.traceBox(o, o, [-16, -16, 0], [16, 16, 72], FLAG_PLAYER); return !tr.startsolid && !tr.normal; };
    const spot = this.nav?.randomPoint((area, p) => {
      p[2] += 1;
      return Math.hypot(p[0] - me[0], p[1] - me[1]) > 700 && fits(p)
        && !this.bots.some((b) => b !== bot && b.alive && Math.hypot(b.pos[0] - p[0], b.pos[1] - p[1]) < 80);
    }, 200);
    if (spot) { bot.place(spot.point, Math.random() * 360); return true; }
    const places = this.map.info.places;
    for (let tries = 0; tries < 80; tries++) {
      const p = places[Math.floor(Math.random() * places.length)];
      const x = (p.min[0] + p.max[0]) / 2 + (Math.random() - 0.5) * Math.min(400, p.max[0] - p.min[0]);
      const y = (p.min[1] + p.max[1]) / 2 + (Math.random() - 0.5) * Math.min(400, p.max[1] - p.min[1]);
      const hit = this.collision.raycast([x, y, p.max[2] + 40], [0, 0, -1], p.max[2] - p.min[2] + 300, FLAG_PLAYER);
      if (!hit || hit.normal[2] < 0.8) continue;
      const origin = [x, y, p.max[2] + 40 - hit.t + 1];
      const tr = this.collision.traceBox(origin, origin, [-16, -16, 0], [16, 16, 72], FLAG_PLAYER);
      if (tr.startsolid || tr.normal) continue;
      if (Math.hypot(origin[0] - me[0], origin[1] - me[1]) < 700) continue;
      if (this.bots.some((b) => b !== bot && b.alive && Math.hypot(b.pos[0] - origin[0], b.pos[1] - origin[1]) < 80)) continue;
      bot.place(origin, Math.random() * 360);
      return true;
    }
    bot.place(this.map.info.spawns[bot.team][0].origin, 0);
    return false;
  }

  start() {
    this.last = performance.now();
    this.acc = 0;
    const frame = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(frame);
  }

  lockChanged(locked) {
    this.paused = !locked;
    if (locked) this.sounds?.ctx.resume().catch(() => {});
    this.emit('pause', !locked);
  }
  resume() { this.input.lock(); }
  setSensitivity(v) { this.baseSensitivity = v; this.camera.userData.fov = null; }

  frame(dt) {
    if (!this.scene) return;
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= TICK && steps < 8) { this.tick(); this.acc -= TICK; steps++; }
      if (steps === 8) this.acc = 0;
    }
    const gun = this.arsenal.gun;
    // Camera: interpolated eye plus recoil punch.
    const a = this.paused ? 1 : this.acc / TICK;
    const eye = this.player.eye();
    const p = [0, 1, 2].map((i) => this.prevEye[i] + (eye[i] - this.prevEye[i]) * a);
    toGl(p, this.camera.position);
    const [pitch, yaw] = this.arsenal.viewAngles(this.input.pitch, this.input.yaw);
    this.camera.rotation.set((-pitch * Math.PI) / 180, (yaw * Math.PI) / 180 + Math.PI, 0);
    const zoomFov = gun?.zoom ? gun.stats.zoomFov[gun.zoom - 1] : FOV;
    if (this.camera.userData.fov !== zoomFov) {
      this.camera.userData.fov = zoomFov;
      this.camera.fov = vfov(zoomFov);
      this.camera.updateProjectionMatrix();
      this.input.sensitivity = this.baseSensitivity * (zoomFov / FOV);
      this.hud.scoped(gun?.zoom && /SNIPER/.test(gun.stats.type));
    }
    // Viewmodel follows the view, with a little bob while running.
    for (const g of Object.values(this.arsenal.guns)) g.vm.rig.visible = g === gun && !(gun.zoom && gun.stats.hideViewmodelZoomed);
    if (gun) {
      gun.vm.update(this.paused ? 0 : dt);
      const sp = this.player.onGround ? Math.min(1, this.player.speed2d() / 250) : 0;
      this.bob = (this.bob || 0) + dt * (6 + 4 * sp) * (sp > 0.05 ? 1 : 0);
      const IN = 0.0254;
      gun.vm.rig.position.set((VIEWMODEL_OFFSET[0] + Math.cos(this.bob) * 0.25 * sp) * IN, (VIEWMODEL_OFFSET[2] - Math.abs(Math.sin(this.bob)) * 0.35 * sp) * IN, -VIEWMODEL_OFFSET[1] * IN);
    }
    this.vmRoot.quaternion.copy(this.camera.quaternion);
    this.vmCamera.quaternion.copy(this.camera.quaternion);
    for (const b of this.bots) b.update(this.paused ? 0 : dt);
    this.effects.update(dt);
    this.vmSun.intensity = this.world.sun.intensity * this.sunVis;

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.vmScene, this.vmCamera);

    this.fps = this.fps ? this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 60;
    this.hudTimer = (this.hudTimer || 0) - dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.2;
      this.hud.fps(this.fps);
      this.hud.place(this.place());
    }
    if (gun && !gun.melee) this.hud.setCrosshair(this.arsenal.inaccuracy(gun));
    const ammoKey = gun ? `${gun.name}|${gun.clip}|${gun.reserve}` : '';
    if (ammoKey !== this.ammoKey) { this.ammoKey = ammoKey; this.hud.ammo(gun); }
    this.emit('frame', dt);
  }

  tick() {
    const inp = this.input;
    this.now += TICK;
    this.prevEye = this.player.eye();
    const cmd = {
      forward: (inp.held('forward') ? 1 : 0) - (inp.held('back') ? 1 : 0),
      side: (inp.held('right') ? 1 : 0) - (inp.held('left') ? 1 : 0),
      yaw: inp.yaw, jump: inp.held('jump') || inp.takeWheel() > 0, duck: inp.held('duck'), walk: inp.held('walk'),
      maxSpeed: this.arsenal.maxSpeed(),
    };
    const wasGround = this.player.onGround;
    this.player.tick(TICK, cmd);
    if (this.player.origin[2] < -3000) this.spawnPlayer(this.team);
    this.footsteps(wasGround);
    this.arsenal.tick(TICK, this.now, inp);
    // Bots come back a few seconds after dying.
    for (const b of this.bots) if (!b.alive && this.now >= b.respawnAt) this.placeBot(b);
    // Is the sun on you? (lights your weapon)
    if ((this.tickCount = (this.tickCount || 0) + 1) % 8 === 0) {
      const lit = !this.collision.raycast(this.player.eye(), this.world.sunDir, 16000, FLAG_BULLET);
      this.sunTarget = lit ? 1 : 0;
    }
    this.sunVis += ((this.sunTarget ?? 1) - this.sunVis) * 0.2;
    const ear = basis(inp.pitch, inp.yaw);
    this.sounds.setListener(this.player.eye(), ear.fwd);
  }

  footsteps(wasGround) {
    const pl = this.player;
    const surface = pl.groundTri != null ? this.collision.surfaces[this.collision.surface[pl.groundTri]] : 'default';
    if (pl.landed > 200) { this.sounds.play(`Land_${stepName(surface)}.StepLeft`, { volume: 0.7 }); pl.landed = 0; }
    pl.landed = 0;
    if (!pl.onGround || !wasGround) return;
    const speed = pl.speed2d();
    if (speed < 135 || pl.ducked) { this.stepT = 0; return; }
    this.stepT = (this.stepT || 0) + TICK;
    if (this.stepT >= 0.32) {
      this.stepT = 0;
      this.stepLeft = !this.stepLeft;
      this.sounds.play(`CT_${stepName(surface)}.${this.stepLeft ? 'StepLeft' : 'StepRight'}`, { volume: 0.55 });
    }
  }

  // One bullet from your gun: bots' hitboxes first (if nearer than the wall), else the wall.
  fireBullet(origin, dir, gun, { tracer = false } = {}) {
    const st = gun.stats;
    const range = st.range || 8192;
    this.stats.shots++;
    const wall = this.collision.raycast(origin, dir, range, FLAG_BULLET);
    const maxT = wall ? wall.t : range;
    let hit = null;
    for (const b of this.bots) {
      const h = b.raycast(origin, dir, hit ? hit.t : maxT);
      if (h) hit = { ...h, bot: b };
    }
    const end = (t) => [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    if (hit) {
      this.stats.hits++;
      let dmg = st.damage * Math.pow(st.rangeModifier, hit.t / 500);
      this.damageBot(hit.bot, dmg, { group: hit.group, armorRatio: st.armorRatio, headshotMult: st.headshot, point: end(hit.t), dir, weapon: gun });
    } else if (wall) {
      const p = end(wall.t);
      this.effects.impact(p, wall.normal, wall.surface);
      const ev = `${impactName(wall.surface)}.BulletImpact`;
      this.sounds.play(this.sounds.has(ev) ? ev : 'Default.BulletImpact', { pos: p, listener: this, volume: 0.6 });
    }
    if (tracer) {
      const from = [origin[0] + dir[0] * 40, origin[1] + dir[1] * 40, origin[2] + dir[2] * 40 - 4];
      this.effects.tracer(from, end(hit ? hit.t : maxT));
    }
    if (gun.vm.muzzle) this.effects.muzzleFlash(gun.vm.muzzle.getWorldPosition(new THREE.Vector3()));
    else this.effects.muzzleFlash(new THREE.Vector3(0.09, -0.06, -0.55).applyQuaternion(this.camera.quaternion));
  }

  // CS2 damage: hit group multiplier, then armor (kevlar for the body, the helmet for the head).
  damageBot(bot, dmg, { group = 'chest', armorRatio = 1, headshotMult = 4, point = null, dir = [0, 0, 1], weapon = null, knife = false } = {}) {
    if (!bot.alive) return;
    const mult = { head: headshotMult, chest: 1, stomach: 1.25, arm: 1, leg: 0.75 }[group] ?? 1;
    dmg *= mult;
    const armored = group === 'head' ? bot.helmet && bot.armor > 0 : group !== 'leg' && bot.armor > 0;
    if (armored) {
      let health = dmg * armorRatio * 0.5;
      let armor = (dmg - health) * 0.5;
      if (armor > bot.armor) { health = dmg - bot.armor * 2; armor = bot.armor; }
      bot.armor -= armor;
      dmg = health;
    }
    dmg = Math.floor(dmg);
    bot.health -= dmg;
    if (point) this.effects.blood(point, dir);
    if (point) this.sounds.play('Flesh.BulletImpact', { pos: point, listener: this, volume: 0.5 });
    const head = group === 'head';
    if (bot.health <= 0) {
      bot.die(head);
      bot.respawnAt = this.now + 3;
      this.stats.kills++;
      if (head) this.stats.headshots++;
      this.sounds.play(head ? (armored ? 'Player.DeathHeadShotArmor.AttackerFeedback' : 'Player.DeathHeadShot.AttackerFeedback') : armored ? 'Player.DeathBodyArmor.AttackerFeedback' : 'Player.DeathBody.AttackerFeedback', { volume: 0.8 });
      this.hud.kill({ killer: 'You', victim: bot.name, weapon: weapon?.name || '', headshot: head, mine: true, killerTeam: this.team, victimTeam: bot.team });
      this.emit('kill', { bot, headshot: head });
    } else {
      this.sounds.play(head ? (armored ? 'Player.DamageHeadShotArmor.AttackerFeedback' : 'Player.DamageHeadShot.AttackerFeedback') : armored ? 'Player.DamageBodyArmor.AttackerFeedback' : 'Player.DamageBody.AttackerFeedback', { volume: 0.7 });
    }
  }

  // Knife reach: the nearest bot in front within range (backstab if hitting from behind), else a wall.
  meleeTrace(range) {
    const eye = this.player.eye();
    const { fwd } = basis(this.input.pitch, this.input.yaw);
    let best = null;
    for (const b of this.bots) {
      for (const off of [[0, 0], [0.12, 0], [-0.12, 0], [0, 0.1], [0, -0.1]]) {
        const { fwd: f, right: r, up: u } = basis(this.input.pitch, this.input.yaw);
        const d = [f[0] + r[0] * off[0] + u[0] * off[1], f[1] + r[1] * off[0] + u[1] * off[1], f[2] + r[2] * off[0] + u[2] * off[1]];
        const l = Math.hypot(...d);
        const h = b.raycast(eye, d.map((x) => x / l), range + 16);
        if (h && (!best || h.t < best.t)) {
          const facing = [Math.cos((b.yaw * Math.PI) / 180), Math.sin((b.yaw * Math.PI) / 180)];
          const backstab = facing[0] * fwd[0] + facing[1] * fwd[1] > 0.5;
          best = { t: h.t, bot: b, backstab, point: [eye[0] + d[0] / l * h.t, eye[1] + d[1] / l * h.t, eye[2] + d[2] / l * h.t], dir: fwd };
        }
      }
    }
    if (best) return best;
    const wall = this.collision.raycast(eye, fwd, range, FLAG_BULLET);
    if (wall) { this.effects.impact([eye[0] + fwd[0] * wall.t, eye[1] + fwd[1] * wall.t, eye[2] + fwd[2] * wall.t], wall.normal, wall.surface); return { wall }; }
    return null;
  }

  // The callout area the player is in (env_cs_place boxes).
  place() {
    const o = this.player.origin;
    let best = null, vol = Infinity;
    for (const p of this.map.info.places) {
      if (o[0] < p.min[0] || o[0] > p.max[0] || o[1] < p.min[1] || o[1] > p.max[1] || o[2] < p.min[2] - 64 || o[2] > p.max[2]) continue;
      const v = (p.max[0] - p.min[0]) * (p.max[1] - p.min[1]);
      if (v < vol) { vol = v; best = p.name; }
    }
    return best;
  }

  resize() {
    const w = this.root.clientWidth || window.innerWidth, h = this.root.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    for (const c of [this.camera, this.vmCamera]) { c.aspect = w / h; c.updateProjectionMatrix(); }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizer.disconnect();
    this.input.dispose();
    for (const g of Object.values(this.arsenal?.guns || {})) g.vm.dispose();
    for (const b of this.bots || []) b.dispose();
    this.effects?.dispose();
    this.world?.dispose();
    this.vmEnv?.dispose();
    this.sounds?.dispose();
    this.hud.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.listeners.clear();
  }
}
