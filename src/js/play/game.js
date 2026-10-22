// Play mode: an offline competitive match on a CS2 map, you and bot teammates against bots. Owns the renderer, the
// 64-tick simulation (movement, weapons, bots, the round) and the frame loop. Rendering interpolates between ticks like
// CS2's client; your weapon is drawn in its own pass with CS2's viewmodel field of view.
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
import { BotAssets, Bot, BOT_NAMES, rayCapsule } from './bots.js';
import { Brain, botGun, teamPlan } from './ai.js';
import { Effects } from './effects.js';
import { Hud } from './hud.js';
import { NavMesh } from './nav.js';
import { Match, Combatant, RULES, SHORT_RULES, DEFAULT_PISTOL, ITEM_NAMES, slotOf } from './match.js';
import { BuyMenu } from './buymenu.js';
import { Radar } from './radar.js';
import { buildCS2Model } from '../cs2/skin.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export const TICK = 1 / 64;
// A CS2 field of view (horizontal degrees at 4:3) as three.js's vertical FOV; wider screens see more, like CS2.
const vfov = (fov43) => (2 * Math.atan(Math.tan((fov43 * Math.PI) / 360) * 0.75) * 180) / Math.PI;
const FOV = 90, VIEWMODEL_FOV = 68;
const VIEWMODEL_OFFSET = [1, 1, -1]; // CS2 viewmodel_offset_x/y/z (inches)
const IN = 0.0254;

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
// Guns players buy most, loaded in the background so buying them is instant.
const PRELOAD = ['weapon_ak47', 'weapon_m4a1', 'weapon_m4a1_silencer', 'weapon_awp', 'weapon_deagle', 'weapon_galilar', 'weapon_famas', 'weapon_mp9', 'weapon_mac10'];
const BOT_GUNS = ['weapon_glock', 'weapon_usp_silencer', 'weapon_ak47', 'weapon_m4a1', 'weapon_m4a1_silencer', 'weapon_awp', 'weapon_deagle', 'weapon_p250',
  'weapon_galilar', 'weapon_famas', 'weapon_mac10', 'weapon_mp9', 'weapon_tec9', 'weapon_fiveseven', 'weapon_knife', 'weapon_knife_t', 'weapon_c4'];
const MUSIC = 'valve_cs2_01';

export class Game {
  constructor(root, { map = 'de_dust2', team = 'CT', teamSize = 5, difficulty = 'normal', length = 'short', sensitivity = 1.25, quality = 'balanced', onStatus = () => {} } = {}) {
    Object.assign(this, { root, mapId: map, team, onStatus });
    this.enemyTeam = team === 'T' ? 'CT' : 'T';
    this.teamSize = Math.max(1, Math.min(5, teamSize | 0));
    this.difficulty = difficulty;
    this.rules = length === 'long' ? RULES : SHORT_RULES;
    this.disposed = false;
    this.paused = true;
    this.listeners = new Set();
    this.now = 0;
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
    this.input.onKey = (code, down) => this.menuKey(code, down);
    this.baseSensitivity = sensitivity;
    this.hud = new Hud(root);
    this.buyMenu = new BuyMenu(root, this);
    this.vmCache = new Map();
    this.resize = this.resize.bind(this);
    this.resizer = new ResizeObserver(this.resize);
    this.resizer.observe(root);
    this.resize();
  }

  emit(type, data) { for (const fn of this.listeners) fn(type, data); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---- loading ----------------------------------------------------------------------------------------------------
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
    if (!map.nav) throw new Error('This map has no navigation mesh for bots');
    status('Loading collision…');
    const colBuf = await fetch(map.collision).then((r) => r.arrayBuffer());
    this.collision = new CollisionWorld(colBuf, map.info.collision);
    this.nav = new NavMesh(await fetch(map.nav).then((r) => r.json()));
    this.world = await loadWorld(map, this.renderer, { onProgress: status });
    if (this.disposed) return;
    this.scene = this.world.scene;
    this.setupViewmodelLighting();
    this.effects = new Effects(this.scene, this.vmScene);
    this.sounds = new SoundBank();
    this.stats = await cs2Play('stats');
    this.midSpot = this.findMid();

    status('Loading players…');
    this.me = new Combatant({ name: 'You', team: this.team, squad: 'A', bot: false });
    this.botAssets = new BotAssets(this.renderer, this.world.ambient);
    await this.botAssets.load(['weapon_glock', 'weapon_usp_silencer', 'weapon_ak47', 'weapon_m4a1', 'weapon_m4a1_silencer', 'weapon_awp', 'weapon_knife', 'weapon_c4']);
    if (this.disposed) return;
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    this.bots = [];
    const addBot = (team, squad) => {
      const c = new Combatant({ name: 'BOT ' + names[this.bots.length % names.length], team, squad });
      const b = new Bot(this.botAssets, c, this.bots.length);
      b.brain = new Brain(this, b, this.difficulty);
      this.scene.add(b.root);
      this.bots.push(b);
    };
    for (let i = 0; i < this.teamSize - 1; i++) addBot(this.team, 'A');
    for (let i = 0; i < this.teamSize; i++) addBot(this.enemyTeam, 'B');
    this.combatants = [this.me, ...this.bots.map((b) => b.c)];

    status('Loading weapons and sounds…');
    this.arsenal = new Arsenal(this, {});
    this.player = new PlayerMovement(this.collision, this.map.info.spawns[this.team][0].origin);
    this.prevEye = this.player.eye();
    await Promise.all([
      this.sounds.load(this.commonSounds()),
      this.vmData(this.knifeId(this.team)), this.vmData(DEFAULT_PISTOL.CT), this.vmData(DEFAULT_PISTOL.T), this.vmData('weapon_c4'),
    ]);
    if (this.disposed) return;
    this.bombTemplate = buildCS2Model({ t: 'skin', fl: 0, sd: 0 }, { wid: 'weapon_c4', w: 'C4', n: 'C4', cat: 'equipment', v: true }, this.renderer).catch(() => null);
    if (map.radar) this.radar = new Radar(this.root, map.radar);
    this.match = new Match(this, this.rules);
    status('Compiling shaders…');
    this.renderer.compile(this.scene, this.camera);
    this.renderer.compile(this.vmScene, this.vmCamera);
    this.renderer.shadowMap.needsUpdate = true;
    this.match.startRound();
    this.emit('loaded');
    // Background: the guns people buy, and the bots' gun models.
    (async () => { for (const id of PRELOAD) { if (this.disposed) return; await this.vmData(id).catch(() => {}); } })();
    for (const id of BOT_GUNS) this.botAssets.weapon(id);
  }

  commonSounds() {
    const surfaces = this.map.info.collision.surfaces;
    const steps = [...new Set(surfaces.map(stepName))].flatMap((s) => [`CT_${s}.StepLeft`, `CT_${s}.StepRight`, `Land_${s}.StepLeft`]);
    const impacts = [...new Set(surfaces.map(impactName))].map((s) => `${s}.BulletImpact`);
    const guns = BOT_GUNS.map((id) => this.stats[id]?.shootSound).filter(Boolean);
    return [...steps, ...impacts, ...guns, 'Weapon_M4A1.Silenced', 'Weapon_USP.SilencedShot', 'Default.BulletImpact', 'Flesh.BulletImpact',
      'Default.ClipEmpty_Rifle', 'Default.ClipEmpty_Pistol', 'Weapon_AWP.Zoom', 'Weapon_AWP.ZoomOut', 'Weapon_AK47.Clipout', 'Weapon_M4A1.Clipout',
      'Player.DamageBody.AttackerFeedback', 'Player.DamageBodyArmor.AttackerFeedback', 'Player.DamageHeadShot.AttackerFeedback',
      'Player.DamageHeadShotArmor.AttackerFeedback', 'Player.DeathHeadShot.AttackerFeedback', 'Player.DeathHeadShotArmor.AttackerFeedback',
      'Player.DeathBody.AttackerFeedback', 'Player.DeathBodyArmor.AttackerFeedback', 'Player.DamageBody.Victim', 'Player.DamageBodyArmor.Victim',
      'Player.DamageHeadShot.Victim', 'Player.DamageHeadShotArmor.Victim', 'Player.DeathBody.Victim', 'Player.DeathHeadShot.Victim',
      'Weapon_Knife.Hit', 'Weapon_Knife.HitWall', 'Weapon_Knife.Slash', 'Weapon_Knife.Stab', 'Weapon_Knife.Deploy', 'Weapon_Knife.Swish.Heavy',
      'Default.Land', 'BulletBy.Supersonic.Crack', 'c4.plant', 'c4.initiate', 'c4.disarmstart', 'c4.disarmfinish', 'c4.explode', 'C4.PlantSound',
      'c4.keypressquiet', 'Player.PickupC4', 'Player.PickupWeapon', 'Event.BombPlanted', 'Event.BombDefused', 'Event.CTWin', 'Event.TERWin',
      `Music.StartRound.${MUSIC}`, `Music.BombPlanted.${MUSIC}`, `Music.WonRound.${MUSIC}`, `Music.LostRound.${MUSIC}`, `Music.MatchEnd.${MUSIC}`];
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

  // Middle of the map (for a CT holding mid): somewhere in the "Middle" callout.
  findMid() {
    const p = this.map.info.places.find((x) => /^Middle$/i.test(x.name)) || this.map.info.places.find((x) => /mid/i.test(x.name));
    if (!p) return null;
    return this.nav.randomPointIn(p.min, p.max)?.point || null;
  }

  // ---- your weapons -----------------------------------------------------------------------------------------------
  knifeId(team) {
    const knife = equipped('knife');
    const kdef = knife ? itemDef(knife) : DEFAULT_KNIFE[team];
    return kdef.wid?.startsWith('weapon_') ? kdef.wid : Object.values(D.skins).find((s) => s.w === kdef.w && s.wid.startsWith('weapon_'))?.wid || 'weapon_knife';
  }
  // The viewmodel (with your equipped skin and gloves) for a weapon, built once per match.
  vmData(wid) {
    if (!this.vmCache.has(wid)) {
      const job = (async () => {
        const vanilla = Object.values(D.skins).find((s) => s.wid === wid);
        let item = null, def;
        if (/knife|bayonet/.test(wid)) {
          item = equipped('knife');
          def = item ? itemDef(item) : DEFAULT_KNIFE[wid === 'weapon_knife_t' ? 'T' : 'CT'];
        } else if (wid === 'weapon_c4') def = { wid, w: 'C4 Explosive', n: 'C4 Explosive', cat: 'equipment', v: true };
        else {
          const w = vanilla?.w || ITEM_NAMES[wid] || wid;
          item = equipped('w:' + w);
          def = item ? itemDef(item) : { wid, w, n: w, cat: vanilla?.cat || 'rifle', v: true };
        }
        const data = await cs2Play('weapon', wid);
        const vm = await buildViewmodel(item || { t: 'skin', fl: 0, sd: 0 }, def, data, { gloves: equipped('gloves'), renderer: this.renderer });
        this.sounds.add(data.sounds);
        vm.rig.visible = false;
        this.vmRoot.add(vm.rig);
        const name = wid === 'weapon_c4' ? 'C4 Explosive' : def.v ? def.w : `${def.w} | ${def.n?.split(' | ')[1] || def.n}`;
        return { data, vm, name };
      })();
      this.vmCache.set(wid, job);
      job.catch((e) => { console.warn('weapon failed', wid, e); this.vmCache.delete(wid); });
    }
    return this.vmCache.get(wid);
  }
  // A fresh gun (full ammo) for one of your slots.
  async myGun(slot, wid) {
    const { data, vm, name } = await this.vmData(wid);
    return new Gun({ slot, id: wid, name, stats: data.stats || this.stats[wid] || {}, sounds: data.sounds, vm });
  }
  async giveMe(slot, wid, select = true) {
    const gun = await this.myGun(slot, wid);
    if (this.disposed) return;
    this.arsenal.give(slot, gun, this.now, select);
  }
  owns(id) {
    const g = this.arsenal?.guns;
    if (id === 'defuser') return this.me.defuser;
    if (id === 'vest') return this.me.armor >= 100;
    if (id === 'vesthelm') return this.me.armor >= 100 && this.me.helmet;
    return g?.primary?.id === id || g?.secondary?.id === id;
  }

  // ---- buying -----------------------------------------------------------------------------------------------------
  inBuyZone(c = this.me) {
    const p = this.positionOf(c);
    return (this.map.info.buyzones || []).some((z) => z.team === c.team && p[0] >= z.min[0] && p[0] <= z.max[0] && p[1] >= z.min[1] && p[1] <= z.max[1] && p[2] >= z.min[2] - 64 && p[2] <= z.max[2] + 64);
  }
  buyTimeLeft() { const m = this.match; return m.phase === 'freeze' ? m.time + m.rules.buyTime : m.rules.buyTime - (m.rules.roundTime - m.time); }
  async buy(id) {
    const m = this.match, me = this.me;
    if (!this.inBuyZone() || this.owns(id) || !m.canBuy(me, id, this.stats)) return;
    m.pay(me, id, this.stats);
    this.sounds.play('Player.PickupWeapon', { volume: 0.6 });
    this.buyMenu.render();
    if (id.startsWith('weapon_')) await this.giveMe(slotOf(id), id);
  }
  openBuyMenu() {
    if (!this.match?.buyOpen || !this.inBuyZone() || !this.me.alive) return;
    this.input.menu = true;
    this.buyMenu.open();
    this.input.unlock();
  }
  closeBuyMenu() {
    if (!this.buyMenu.isOpen) return;
    this.buyMenu.close();
    this.input.lock().finally(() => { this.input.menu = false; });
  }
  menuKey(code, down) {
    if (!down) return false;
    if (code === 'KeyB' && this.me?.alive && this.match) { if (this.buyMenu.isOpen) this.closeBuyMenu(); else this.openBuyMenu(); return true; }
    if (this.buyMenu.isOpen) {
      if (code === 'Escape') { this.closeBuyMenu(); return true; }
      return this.buyMenu.key(code);
    }
    return false;
  }

  // ---- rounds (called by the match) -------------------------------------------------------------------------------
  onRoundStart(round, { halftime, pistol }) {
    this.effects.clear();
    this.removeBomb();
    this.planting = null; this.defusing = false;
    this.deathCam = null; this.spectating = null;
    // Spawns: everyone gets a different spot on their side.
    for (const side of ['T', 'CT']) {
      const list = this.combatants.filter((c) => c.team === side);
      const top = Math.max(...this.map.info.spawns[side].map((s) => s.priority));
      const spawns = this.map.info.spawns[side].slice().sort((a, b) => (b.priority === top) - (a.priority === top) || Math.random() - 0.5);
      list.forEach((c, i) => {
        const sp = spawns[i % spawns.length];
        const died = !c.alive || c.resetWeapons;
        c.alive = true; c.health = 100;
        if (c === this.me) this.respawnMe(sp, died);
        else this.respawnBot(this.botOf(c), sp, died);
        c.resetWeapons = false;
      });
    }
    this.plans = { T: teamPlan(this, 'T'), CT: teamPlan(this, 'CT') };
    for (const b of this.bots) { b.brain.roundStart(this.plans[b.c.team]); b.brain.buy(pistol); }
    this.liveAt = Infinity;
    this.hud.message(halftime ? 'Switching sides' : round === 1 ? 'Match start · Round 1' : `Round ${round}`, 2500);
    this.sounds.play(`Music.StartRound.${MUSIC}`, { volume: 0.35 });
    this.emit('round', round);
  }
  onLive() { this.liveAt = this.now; }
  onHalftime() { for (const b of this.bots) b.setModel(b.c.team); }

  respawnMe(sp, died) {
    const me = this.me;
    this.player.teleport(sp.origin);
    this.input.yaw = sp.yaw; this.input.pitch = 0;
    this.prevEye = this.player.eye();
    this.arsenal.aim = [0, 0]; this.arsenal.aimVel = [0, 0]; this.arsenal.view = [0, 0];
    const jobs = [];
    if (died) {
      this.arsenal.remove('primary', this.now);
      jobs.push(this.giveMe('secondary', DEFAULT_PISTOL[me.team], false));
      me.armor = 0; me.helmet = false; me.defuser = false;
    }
    const knife = this.knifeId(me.team);
    if (this.arsenal.guns.knife?.id !== knife) jobs.push(this.giveMe('knife', knife, false));
    if (me.hasC4) jobs.push(this.giveMe('c4', 'weapon_c4', false)); else this.arsenal.remove('c4', this.now);
    Promise.all(jobs).then(() => { this.arsenal.current = null; this.arsenal.selectBest(this.now); });
  }

  respawnBot(b, sp, died) {
    const c = b.c;
    if (died) {
      b.weapons = {};
      c.armor = 0; c.helmet = false; c.defuser = false;
    }
    b.weapons.secondary ||= botGun(DEFAULT_PISTOL[c.team], this.stats[DEFAULT_PISTOL[c.team]]);
    const knife = c.team === 'T' ? 'weapon_knife_t' : 'weapon_knife';
    b.weapons.knife = botGun(knife, this.stats[knife] || this.stats.weapon_knife);
    if (c.hasC4) b.weapons.c4 = botGun('weapon_c4', this.stats.weapon_c4); else delete b.weapons.c4;
    b.spawn(sp.origin, sp.yaw);
    b.slot = b.weapons.primary ? 'primary' : 'secondary';
    b.equip(b.weapons[b.slot].id);
  }
  giveBot(b, id) {
    const slot = slotOf(id);
    b.weapons[slot] = botGun(id, this.stats[id]);
    this.sounds.load([this.stats[id]?.shootSound].filter(Boolean));
    if (slot === 'primary' || !b.weapons.primary) { b.slot = slot; b.equip(id); }
  }
  botSwitch(b, slot, t) {
    if (!b.weapons[slot]) return;
    b.slot = slot;
    b.weapons[slot].nextAttack = Math.max(b.weapons[slot].nextAttack, t + 0.5);
    b.equip(b.weapons[slot].id);
  }

  onRoundEnd(winner, reason, mvp) {
    const sideName = winner === 'CT' ? 'Counter-Terrorists' : 'Terrorists';
    const why = { elimination: '', bomb: 'The bomb has exploded', defuse: 'The bomb has been defused', time: 'Time ran out' }[reason];
    this.hud.message(`<b class="${winner === 'CT' ? 'ct' : 't'}">${sideName} win</b>${why ? `<small>${why}</small>` : ''}${mvp ? `<small>MVP: ${mvp.name}</small>` : ''}`, 6500, 'banner');
    this.sounds.play(winner === 'CT' ? 'Event.CTWin' : 'Event.TERWin', { volume: 0.9 });
    this.sounds.play(winner === this.me.team ? `Music.WonRound.${MUSIC}` : `Music.LostRound.${MUSIC}`, { volume: 0.4 });
    this.planting = null;
    this.emit('roundEnd', { winner, reason });
  }
  onMatchOver(squad) {
    const won = squad === 'A', draw = squad == null;
    this.sounds.play(`Music.MatchEnd.${MUSIC}`, { volume: 0.4 });
    this.matchOver = true;
    this.hud.endScreen(`<h1 class="${draw ? '' : won ? 'win' : 'loss'}">${draw ? 'Draw' : won ? 'Victory' : 'Defeat'}</h1>
      <div class="final">${this.match.score.A} : ${this.match.score.B}</div>
      <div class="sub">You: ${this.me.kills} kills, ${this.me.deaths} deaths, ${this.me.assists} assists, ${this.me.mvps} MVPs</div>`);
    this.hud.scoreboard(true, this.scoreData());
    this.input.unlock();
    this.emit('over', { won, draw });
  }

  // ---- the bomb ---------------------------------------------------------------------------------------------------
  canAttack() { return this.match?.phase !== 'freeze' && this.me.alive && !this.buyMenu.isOpen && !this.defusing; }
  isDefusing(c) { return c === this.me ? this.defusing : this.botOf(c)?.mode === 'defuse'; }

  // You hold fire with the C4 out in a bomb site: plant (3 seconds, standing still).
  playerPlant(holding, t) {
    const m = this.match, feet = this.player.origin;
    const ok = holding && m.canPlant(this.me, feet) && this.player.onGround;
    if (!ok) {
      if (this.planting) { this.planting = null; this.arsenal.guns.c4?.vm.play('idle', { loop: true }); }
      if (holding && m.phase === 'live' && !m.siteAt(feet) && t - (this.siteWarnAt || -9) > 2) {
        this.siteWarnAt = t;
        this.hud.message('You must be at a bomb site to plant the bomb', 2000);
      }
      return;
    }
    if (!this.planting) {
      this.planting = { start: t };
      this.arsenal.guns.c4?.vm.play('plant');
      this.sounds.play('c4.initiate', { volume: 0.7 });
      this.beepKeys = 0;
    }
    const k = (t - this.planting.start) / m.rules.plantTime;
    if (k * 7 > this.beepKeys + 1) { this.beepKeys++; this.sounds.play('c4.keypressquiet', { volume: 0.6 }); }
    if (k >= 1) {
      this.planting = null;
      m.planted(this.me, this.player.origin);
      this.arsenal.remove('c4', t);
    }
  }
  botPlant(b, t) {
    if (b.mode === 'plant') {
      if (t - b.plantStart >= this.match.rules.plantTime) {
        b.setMode('move');
        this.match.planted(b.c, b.pos);
        delete b.weapons.c4;
        this.botSwitch(b, b.weapons.primary ? 'primary' : 'secondary', t);
      }
      return;
    }
    if (!this.match.canPlant(b.c, b.pos)) return;
    b.plantStart = t;
    b.vel = [0, 0, 0];
    this.botSwitch(b, 'c4', t);
    b.setMode('plant');
    this.sounds.play('c4.initiate', { pos: b.eye(), listener: this, volume: 0.6 });
  }
  botDefuse(b) {
    if (b.mode === 'defuse') return;
    if (this.match.startDefuse(b.c)) { b.setMode('defuse'); b.vel = [0, 0, 0]; }
  }
  botCancelObjective(b) { if (b.mode === 'plant' || b.mode === 'defuse') b.setMode('move'); }

  onPlanted(c, bomb) {
    this.placeBomb(bomb.pos, c === this.me ? this.input.yaw : this.botOf(c)?.yaw || 0);
    this.sounds.play('c4.plant', { pos: bomb.pos, listener: this, volume: 0.8 });
    this.sounds.play('Event.BombPlanted', { volume: 0.9 });
    this.sounds.play(`Music.BombPlanted.${MUSIC}`, { volume: 0.35 });
    this.hud.message('The bomb has been planted', 3000, 'bomb');
    bomb.beepAt = this.now + 1;
    for (const b of this.bots) b.brain.nextThink = this.now; // everyone knows where the bomb is
  }
  onDefuseStart() { this.sounds.play('c4.disarmstart', { pos: this.match.bomb.pos, listener: this, volume: 0.6 }); }
  onDefuseAbort() {}
  onDefused(c) {
    this.sounds.play('c4.disarmfinish', { pos: this.match.bomb.pos, listener: this });
    this.sounds.play('Event.BombDefused', { volume: 0.9 });
    this.botOf(c)?.setMode('move');
    this.defusing = false;
  }
  onExploded(bomb) {
    this.sounds.play('c4.explode', { volume: 1 });
    this.effects.explosion(bomb.pos);
    this.removeBomb();
    // CS2's bomb damage: falls off with distance (bomb radius x 3.5), armor helps.
    const dmgMax = this.map.info.bombRadius || 500, radius = dmgMax * 3.5, sigma = radius / 3;
    for (const c of this.combatants.slice()) {
      if (!c.alive) continue;
      const p = this.bodyOf(c).chest;
      const d = Math.hypot(p[0] - bomb.pos[0], p[1] - bomb.pos[1], p[2] - bomb.pos[2]);
      const dmg = dmgMax * Math.exp(-(d * d) / (2 * sigma * sigma));
      if (dmg >= 1) this.damage(c, dmg, { attacker: null, group: 'chest', armorRatio: 1, weapon: { name: 'C4' }, explosion: true });
    }
    this.shake = 1;
  }
  onBombDropped(bomb) { this.placeBomb(bomb.pos, 0); }
  onBombPickedUp(c) {
    this.removeBomb();
    if (c === this.me) { this.giveMe('c4', 'weapon_c4', false); this.sounds.play('Player.PickupC4', { volume: 0.7 }); this.hud.message('You picked up the bomb', 2000); }
    else this.botOf(c).weapons.c4 = botGun('weapon_c4', this.stats.weapon_c4);
  }
  async placeBomb(pos, yaw) {
    this.removeBomb();
    const token = (this.bombToken = {});
    const tpl = await this.bombTemplate;
    if (!tpl?.userData.root || token !== this.bombToken) return;
    const m = cloneSkinned(tpl.userData.root);
    m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); m.scale.set(1, 1, 1); // drop the inspect framing
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    this.botAssets.light(m);
    const g = new THREE.Group();
    g.add(m);
    // Sit it on the ground (the model is centred on its middle).
    m.updateMatrixWorld(true);
    const box = new THREE.Box3();
    m.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
    if (!box.isEmpty()) m.position.y -= box.min.y;
    toGl([pos[0], pos[1], pos[2] + 0.5], g.position);
    g.rotation.y = (yaw * Math.PI) / 180;
    this.scene.add(g);
    this.bombModel = g;
  }
  removeBomb() { this.bombToken = null; this.bombModel?.removeFromParent(); this.bombModel = null; }

  // ---- the simulation ---------------------------------------------------------------------------------------------
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
    if (this.input.menu || this.matchOver) return; // the buy menu shows the cursor; that's not a pause
    this.paused = !locked;
    if (locked) this.sounds?.ctx.resume().catch(() => {});
    this.emit('pause', !locked);
  }
  resume() { this.input.lock(); }
  setSensitivity(v) { this.baseSensitivity = v; this.camera.userData.fov = null; }

  tick() {
    const inp = this.input, m = this.match, me = this.me;
    this.now += TICK;
    this.prevEye = this.player.eye();
    m.tick(TICK);
    // You
    const frozen = m.phase === 'freeze' || !me.alive || this.planting || this.defusing || m.phase === 'over';
    const cmd = frozen ? { forward: 0, side: 0, yaw: inp.yaw, jump: false, duck: inp.held('duck') && me.alive, walk: false, maxSpeed: this.arsenal.maxSpeed() } : {
      forward: (inp.held('forward') ? 1 : 0) - (inp.held('back') ? 1 : 0),
      side: (inp.held('right') ? 1 : 0) - (inp.held('left') ? 1 : 0),
      yaw: inp.yaw, jump: inp.held('jump'), duck: inp.held('duck'), walk: inp.held('walk'),
      maxSpeed: this.arsenal.maxSpeed(),
    };
    if (me.alive) {
      const wasGround = this.player.onGround;
      this.player.tick(TICK, cmd);
      this.pushOutOfBots();
      if (this.player.origin[2] < -3000) this.kill(me, null, { name: 'World' }, false);
      this.footsteps(wasGround);
      this.arsenal.tick(TICK, this.now, inp);
      this.useKey();
      const b = m.bomb;
      if (b?.state === 'dropped' && me.team === 'T' && Math.hypot(this.player.origin[0] - b.pos[0], this.player.origin[1] - b.pos[1], this.player.origin[2] - b.pos[2]) < 60) m.pickupBomb(me);
    } else {
      inp.takePressed(); inp.takeWheel();
      this.spectateInput();
    }
    // Bots
    for (const b of this.bots) {
      if (!b.c.alive) continue;
      b.brain.tick(TICK, this.now);
      const bomb = m.bomb;
      if (bomb?.state === 'dropped' && b.c.team === 'T' && Math.hypot(b.pos[0] - bomb.pos[0], b.pos[1] - bomb.pos[1]) < 50) m.pickupBomb(b.c);
      this.botFootsteps(b);
    }
    // The planted bomb beeps faster as it gets closer to going off.
    if (m.phase === 'planted' && this.now >= m.bomb.beepAt) {
      const left = m.rules.bombTime - (this.now - m.bomb.plantedAt);
      this.sounds.play('C4.PlantSound', { pos: m.bomb.pos, listener: this, volume: 0.7 });
      m.bomb.beepAt = this.now + Math.max(0.1, 0.15 + 0.85 * Math.pow(Math.max(0, left) / m.rules.bombTime, 1.4));
    }
    // Is the sun on you? (lights your weapon)
    if ((this.tickCount = (this.tickCount || 0) + 1) % 8 === 0) {
      this.sunTarget = this.collision.raycast(this.player.eye(), this.world.sunDir, 16000, FLAG_BULLET) ? 0 : 1;
      if (me.alive) this.spotFromMe();
    }
    this.sunVis += ((this.sunTarget ?? 1) - this.sunVis) * 0.2;
    const ear = basis(inp.pitch, inp.yaw);
    this.sounds.setListener(this.camEye || this.player.eye(), ear.fwd);
  }

  // E: defuse the bomb when you're at it and looking at it.
  useKey() {
    const m = this.match, me = this.me;
    let near = false;
    if (this.input.held('use') && m.phase === 'planted' && me.team === 'CT') {
      const eye = this.player.eye(), b = m.bomb.pos;
      const d = Math.hypot(b[0] - eye[0], b[1] - eye[1], b[2] - eye[2]);
      const { fwd } = basis(this.input.pitch, this.input.yaw);
      near = d < 90 && (fwd[0] * (b[0] - eye[0]) + fwd[1] * (b[1] - eye[1]) + fwd[2] * (b[2] - eye[2])) / d > 0.75;
    }
    if (near && !this.defusing) {
      if (m.bomb.defuser && m.bomb.defuser !== me) return;
      if (m.startDefuse(me)) this.defusing = true;
    } else if (!near && this.defusing) this.defusing = false;
  }

  // Your view of enemies for the radar (anyone in front of you with a clear line).
  spotFromMe() {
    const eye = this.player.eye();
    const { fwd } = basis(this.input.pitch, this.input.yaw);
    for (const e of this.enemiesOf(this.me)) {
      const p = this.bodyOf(e).chest;
      const d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
      if ((fwd[0] * (p[0] - eye[0]) + fwd[1] * (p[1] - eye[1]) + fwd[2] * (p[2] - eye[2])) / d > 0.5 && this.lineOfSight(eye, p)) this.spot(e, this.me);
    }
  }

  // Bots are solid: you can't walk through them.
  pushOutOfBots() {
    const o = this.player.origin;
    for (const b of this.bots) {
      if (!b.c.alive) continue;
      const dx = o[0] - b.pos[0], dy = o[1] - b.pos[1], d = Math.hypot(dx, dy);
      if (d < 32 && d > 0.01 && Math.abs(o[2] - b.pos[2]) < 70) {
        const push = 32 - d;
        const to = [o[0] + (dx / d) * push, o[1] + (dy / d) * push, o[2]];
        this.player.origin = this.collision.traceBox(o, to, this.player.hull.mins, this.player.hull.maxs, FLAG_PLAYER).endpos;
      }
    }
  }

  footsteps(wasGround) {
    const pl = this.player;
    const surface = pl.groundTri != null ? this.collision.surfaces[this.collision.surface[pl.groundTri]] : 'default';
    if (pl.landed > 200) this.sounds.play(`Land_${stepName(surface)}.StepLeft`, { volume: 0.7 });
    pl.landed = 0;
    if (!pl.onGround || !wasGround) return;
    const speed = pl.speed2d();
    if (speed < 135 || pl.ducked) { this.stepT = 0; return; }
    this.stepT = (this.stepT || 0) + TICK;
    if (this.stepT >= 0.32) {
      this.stepT = 0;
      this.stepLeft = !this.stepLeft;
      this.sounds.play(`CT_${stepName(surface)}.${this.stepLeft ? 'StepLeft' : 'StepRight'}`, { volume: 0.55 });
      this.noise(pl.origin, 900, this.me);
    }
  }
  botFootsteps(b) {
    const speed = Math.hypot(b.vel[0], b.vel[1]);
    if (speed < 140 || b.ducked) { b.stepT = 0; return; }
    b.stepT = (b.stepT || 0) + TICK;
    if (b.stepT < 0.34) return;
    b.stepT = 0;
    b.stepLeft = !b.stepLeft;
    this.noise(b.pos, 900, b.c);
    if (Math.hypot(b.pos[0] - this.player.origin[0], b.pos[1] - this.player.origin[1]) > 2200) return;
    const hit = this.collision.raycast([b.pos[0], b.pos[1], b.pos[2] + 8], [0, 0, -1], 40, FLAG_PLAYER);
    this.sounds.play(`CT_${stepName(hit?.surface || 'concrete')}.${b.stepLeft ? 'StepLeft' : 'StepRight'}`, { pos: b.pos, listener: this, volume: 0.75 });
  }

  // ---- combat ---------------------------------------------------------------------------------------------------------
  botOf(c) { return this.bots.find((b) => b.c === c) || null; }
  enemiesOf(c) { return this.combatants.filter((x) => x.alive && x.team !== c.team); }
  positionOf(c) { return c === this.me ? this.player.origin.slice() : this.botOf(c).pos.slice(); }
  // Where a combatant's head, chest and feet are (game units).
  bodyOf(c) {
    if (c === this.me) {
      const o = this.player.origin, eye = this.player.eye(), s = this.player.ducked ? 0.75 : 1;
      return { feet: o, eye, head: [eye[0], eye[1], eye[2] + 1], chest: [o[0], o[1], o[2] + 50 * s] };
    }
    const b = this.botOf(c);
    const eye = b.eye();
    return { feet: b.pos, eye, head: b.bonePos('head_0') || [eye[0], eye[1], eye[2] + 1], chest: [b.pos[0], b.pos[1], b.pos[2] + (b.ducked ? 36 : 50)] };
  }
  bodies() { return this.combatants.map((c) => ({ c, feet: this.positionOf(c) })); }
  lineOfSight(a, b) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d);
    return !this.collision.raycast(a, d.map((x) => x / l), l - 2, FLAG_BULLET);
  }
  nearestTo(pos, side) {
    let best = null, bd = Infinity;
    for (const c of this.combatants) {
      if (!c.alive || c.team !== side || !c.bot) continue;
      const p = this.positionOf(c), d = Math.hypot(p[0] - pos[0], p[1] - pos[1]);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  enemySpawnCenter(team) {
    const sp = this.map.info.spawns[team === 'T' ? 'CT' : 'T'];
    return [0, 1, 2].map((i) => sp.reduce((s, x) => s + x.origin[i], 0) / sp.length);
  }
  spot(enemy, by) { enemy.spottedAt = this.now; enemy.spottedBy = by.squad; }
  // A CT that sees a terrorist near a bomb site calls it: the others rotate there.
  callout(c, enemy) {
    if (c.team !== 'CT' || this.match.phase !== 'live') return;
    const p = this.positionOf(enemy);
    const site = (this.map.info.bombsites || []).find((s) => Math.hypot(p[0] - (s.min[0] + s.max[0]) / 2, p[1] - (s.min[1] + s.max[1]) / 2) < 1300);
    const plan = this.plans?.CT;
    if (site && plan && !plan.rotate) plan.rotate = site.site;
  }
  // Gunshots and footsteps alert enemy bots in range.
  noise(pos, loud, source) {
    for (const b of this.bots) if (b.c.alive && b.c.team !== source?.team) b.brain.hear(pos, loud, this.now);
  }
  botSound(b, event, volume = 1) { this.sounds.play(event, { pos: b.eye(), listener: this, volume }); }

  // A bot fires its gun: CS2's inaccuracy and spread, and recoil it partly controls.
  botShoot(b, gun, t, control) {
    const st = gun.stats;
    gun.clip--;
    gun.nextAttack = t + (st.cycle?.[0] || 0.1);
    gun.lastShot = t;
    const speed = Math.hypot(b.vel[0], b.vel[1]), max = st.maxSpeed?.[0] || 250;
    const move = Math.max(0, Math.min(1, (speed - max * 0.34) / (max * 0.61)));
    const inacc = (b.ducked ? st.inaccCrouch?.[0] : st.inaccStand?.[0]) + gun.penalty + (st.inaccMove?.[0] || 0) * move;
    const pitch = b.pitch + gun.punch[0] * 2 * (1 - control), yaw = b.yaw + gun.punch[1] * 2 * (1 - control);
    const { fwd, right, up } = basis(pitch, yaw);
    const eye = b.eye();
    const r0 = Math.random(), t0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < (st.bullets || 1); i++) {
      const r1 = Math.random(), t1 = Math.random() * Math.PI * 2;
      const x = Math.cos(t0) * r0 * inacc + Math.cos(t1) * r1 * (st.spread?.[0] || 0);
      const y = Math.sin(t0) * r0 * inacc + Math.sin(t1) * r1 * (st.spread?.[0] || 0);
      const d = [fwd[0] + right[0] * x + up[0] * y, fwd[1] + right[1] * x + up[1] * y, fwd[2] + right[2] * x + up[2] * y];
      const l = Math.hypot(...d);
      this.fireBullet(b.c, eye, d.map((v) => v / l), gun, { tracer: i === 0 && Math.random() < 0.5, muzzle: b.muzzle() });
    }
    // Recoil: Source's recoil table drives the punch.
    const tbl = gun.tables[0], k = Math.min(Math.floor(gun.recoilIndex), 63);
    const ang = (tbl[k].angle * Math.PI) / 180;
    gun.punchVel[0] -= Math.cos(ang) * tbl[k].mag * 0.9;
    gun.punchVel[1] -= Math.sin(ang) * tbl[k].mag * 0.9;
    gun.penalty += st.inaccFire?.[0] || 0;
    gun.recoilIndex++;
    const ev = gun.silenced ? (gun.id === 'weapon_usp_silencer' ? 'Weapon_USP.SilencedShot' : 'Weapon_M4A1.Silenced') : st.shootSound;
    this.sounds.play(ev, { pos: eye, listener: this, volume: 1 });
    this.effects.worldFlash(b.muzzle());
    this.noise(eye, gun.silenced ? 900 : 2600, b.c);
  }

  // A bot's knife slash (a backstab from behind).
  botKnife(b, target, gun) {
    const tp = this.positionOf(target), yaw = target === this.me ? this.input.yaw : this.botOf(target).yaw;
    const to = [tp[0] - b.pos[0], tp[1] - b.pos[1]], l = Math.hypot(...to) || 1;
    const backstab = (Math.cos((yaw * Math.PI) / 180) * to[0] + Math.sin((yaw * Math.PI) / 180) * to[1]) / l > 0.5;
    this.sounds.play('Weapon_Knife.Hit', { pos: b.eye(), listener: this, volume: 0.8 });
    this.damage(target, backstab ? 90 : 40, { attacker: b.c, group: 'chest', armorRatio: 1.7, weapon: gun, point: this.bodyOf(target).chest, dir: [to[0] / l, to[1] / l, 0] });
  }

  // One bullet: the nearest enemy hitbox before the wall it hits (friendly fire is off).
  fireBullet(shooter, origin, dir, gun, { tracer = false, muzzle = null } = {}) {
    const st = gun.stats;
    const range = st.range || 8192;
    const wall = this.collision.raycast(origin, dir, range, FLAG_BULLET);
    const maxT = wall ? wall.t : range;
    let hit = null;
    for (const c of this.combatants) {
      if (!c.alive || c === shooter || c.team === shooter.team) continue;
      const h = this.hitTest(c, origin, dir, hit ? hit.t : maxT);
      if (h) hit = { ...h, c };
    }
    const end = (t) => [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    if (shooter === this.me) this.me.shots = (this.me.shots || 0) + 1;
    if (hit) {
      if (shooter === this.me) this.me.hits = (this.me.hits || 0) + 1;
      const dmg = st.damage * Math.pow(st.rangeModifier, hit.t / 500);
      this.damage(hit.c, dmg, { attacker: shooter, group: hit.group, armorRatio: st.armorRatio, headshotMult: st.headshot, point: end(hit.t), dir, weapon: gun });
    } else if (wall) {
      const p = end(wall.t);
      this.effects.impact(p, wall.normal, wall.surface);
      const ev = `${impactName(wall.surface)}.BulletImpact`;
      this.sounds.play(this.sounds.has(ev) ? ev : 'Default.BulletImpact', { pos: p, listener: this, volume: 0.6 });
    }
    // Bullets flying past your head crack.
    if (shooter !== this.me && this.me.alive && hit?.c !== this.me) {
      const e = this.player.eye(), w = [e[0] - origin[0], e[1] - origin[1], e[2] - origin[2]];
      const along = w[0] * dir[0] + w[1] * dir[1] + w[2] * dir[2];
      if (along > 0 && along < maxT && Math.hypot(w[0] - dir[0] * along, w[1] - dir[1] * along, w[2] - dir[2] * along) < 60 && Math.random() < 0.5) {
        this.sounds.play('BulletBy.Supersonic.Crack', { volume: 0.5 });
      }
    }
    if (tracer) this.effects.tracer(muzzle || [origin[0] + dir[0] * 40, origin[1] + dir[1] * 40, origin[2] + dir[2] * 40 - 4], end(hit ? hit.t : maxT));
    if (shooter === this.me) {
      if (gun.vm.muzzle) this.effects.muzzleFlash(gun.vm.muzzle.getWorldPosition(new THREE.Vector3()));
      else this.effects.muzzleFlash(new THREE.Vector3(0.09, -0.06, -0.55).applyQuaternion(this.camera.quaternion));
    }
  }

  // Knife reach: the nearest enemy in front within range (a backstab if hitting from behind), else a wall.
  meleeTrace(range) {
    const eye = this.player.eye();
    const { fwd, right, up } = basis(this.input.pitch, this.input.yaw);
    let best = null;
    for (const c of this.enemiesOf(this.me)) {
      for (const off of [[0, 0], [0.12, 0], [-0.12, 0], [0, 0.1], [0, -0.1]]) {
        const d = [0, 1, 2].map((i) => fwd[i] + right[i] * off[0] + up[i] * off[1]);
        const l = Math.hypot(...d);
        const dir = d.map((x) => x / l);
        const h = this.hitTest(c, eye, dir, range + 16);
        if (h && (!best || h.t < best.t)) {
          const b = this.botOf(c), yaw = b ? b.yaw : 0;
          const facing = [Math.cos((yaw * Math.PI) / 180), Math.sin((yaw * Math.PI) / 180)];
          best = { t: h.t, bot: b, c, backstab: facing[0] * fwd[0] + facing[1] * fwd[1] > 0.5, point: [0, 1, 2].map((i) => eye[i] + dir[i] * h.t), dir: fwd };
        }
      }
    }
    if (best) return best;
    const wall = this.collision.raycast(eye, fwd, range, FLAG_BULLET);
    if (wall) { this.effects.impact([0, 1, 2].map((i) => eye[i] + fwd[i] * wall.t), wall.normal, wall.surface); return { wall }; }
    return null;
  }

  // A ray against someone's hitboxes: you have a simple capsule body, bots have bone hitboxes.
  hitTest(c, o, d, maxT) {
    if (c !== this.me) return this.botOf(c).raycast(o, d, maxT);
    const p = this.player.origin, eye = this.player.eye(), s = this.player.ducked ? 0.75 : 1;
    const yr = (this.input.yaw * Math.PI) / 180, side = [Math.sin(yr) * 4.5, -Math.cos(yr) * 4.5];
    const boxes = [
      { a: [eye[0], eye[1], eye[2] - 3], b: [eye[0], eye[1], eye[2] + 3], r: 4.8, group: 'head' },
      { a: [p[0], p[1], p[2] + 43 * s], b: [p[0], p[1], p[2] + 57 * s], r: 8.5, group: 'chest' },
      { a: [p[0], p[1], p[2] + 31 * s], b: [p[0], p[1], p[2] + 43 * s], r: 8, group: 'stomach' },
      { a: [p[0] + side[0], p[1] + side[1], p[2] + 3], b: [p[0] + side[0], p[1] + side[1], p[2] + 31 * s], r: 5, group: 'leg' },
      { a: [p[0] - side[0], p[1] - side[1], p[2] + 3], b: [p[0] - side[0], p[1] - side[1], p[2] + 31 * s], r: 5, group: 'leg' },
    ];
    let best = null;
    for (const h of boxes) {
      const t = rayCapsule(o, d, h.a, h.b, h.r);
      if (t !== null && t >= 0 && t < maxT && (!best || t < best.t)) best = { t, group: h.group };
    }
    return best;
  }

  // CS2 damage: hit group multiplier, then armor (kevlar for the body, the helmet for the head).
  damage(c, dmg, { attacker = null, group = 'chest', armorRatio = 1, headshotMult = 4, point = null, dir = null, weapon = null, explosion = false } = {}) {
    if (!c.alive) return;
    const mult = explosion ? 1 : { head: headshotMult, chest: 1, stomach: 1.25, arm: 1, leg: 0.75 }[group] ?? 1;
    dmg *= mult;
    const armored = group === 'head' ? c.helmet && c.armor > 0 : group !== 'leg' && c.armor > 0;
    if (armored) {
      let health = dmg * armorRatio * 0.5;
      let armor = (dmg - health) * 0.5;
      if (armor > c.armor) { health = dmg - c.armor * 2; armor = c.armor; }
      c.armor = Math.max(0, c.armor - armor);
      dmg = health;
    }
    dmg = Math.max(0, Math.floor(dmg));
    this.match.onDamage(c, attacker, Math.min(dmg, c.health));
    c.health -= dmg;
    const head = group === 'head';
    if (point) { this.effects.blood(point, dir || [0, 0, 1]); this.sounds.play('Flesh.BulletImpact', { pos: point, listener: this, volume: 0.5 }); }
    if (c === this.me) {
      // Getting hit: a red flash, an arrow towards the shooter, and you slow down (CS2's tagging).
      let ang = null;
      if (attacker) {
        const ap = this.positionOf(attacker), mp = this.player.origin;
        const a = (Math.atan2(ap[1] - mp[1], ap[0] - mp[0]) * 180) / Math.PI;
        ang = -(((a - this.input.yaw + 540) % 360) - 180);
      }
      this.hud.hurt(ang, dmg);
      this.player.velocity[0] *= 0.45; this.player.velocity[1] *= 0.45;
      if (c.health > 0) this.sounds.play(head ? (armored ? 'Player.DamageHeadShotArmor.Victim' : 'Player.DamageHeadShot.Victim') : armored ? 'Player.DamageBodyArmor.Victim' : 'Player.DamageBody.Victim', { volume: 0.7 });
    } else {
      this.botOf(c)?.brain.hurt(attacker, this.now);
      if (attacker === this.me && c.health > 0) this.sounds.play(head ? (armored ? 'Player.DamageHeadShotArmor.AttackerFeedback' : 'Player.DamageHeadShot.AttackerFeedback') : armored ? 'Player.DamageBodyArmor.AttackerFeedback' : 'Player.DamageBody.AttackerFeedback', { volume: 0.7 });
    }
    if (c.health <= 0) {
      if (attacker === this.me) this.sounds.play(head ? (armored ? 'Player.DeathHeadShotArmor.AttackerFeedback' : 'Player.DeathHeadShot.AttackerFeedback') : armored ? 'Player.DeathBodyArmor.AttackerFeedback' : 'Player.DeathBody.AttackerFeedback', { volume: 0.8 });
      this.kill(c, attacker, weapon, head);
    }
  }

  kill(c, attacker, weapon, headshot) {
    if (!c.alive) return;
    c.alive = false;
    c.health = 0;
    this.match.onKill(c, attacker, weapon?.stats || weapon);
    const wname = weapon?.id ? (ITEM_NAMES[weapon.id] || (weapon.name || '').split(' | ')[0]) : weapon?.name || 'World';
    this.hud.kill({ killer: attacker?.name || '', victim: c.name, weapon: wname, headshot, mine: attacker === this.me || c === this.me, killerTeam: attacker?.team, victimTeam: c.team });
    if (c === this.me) {
      this.planting = null; this.defusing = false;
      this.closeBuyMenu();
      this.sounds.play(headshot ? 'Player.DeathHeadShot.Victim' : 'Player.DeathBody.Victim', { volume: 0.8 });
      this.deathCam = { until: this.now + 2.5, killer: attacker, from: this.player.eye() };
    } else {
      const b = this.botOf(c);
      b.setMode('dead', { headshot });
      b.vel = [0, 0, 0];
    }
  }

  // ---- spectating ---------------------------------------------------------------------------------------------------
  spectateInput() {
    if (this.input.takeClicked() & 1 || !this.spectating?.c.alive) this.nextSpectate();
  }
  nextSpectate() {
    if (this.deathCam && this.now < this.deathCam.until) return;
    const mates = this.bots.filter((b) => b.c.alive && b.c.team === this.me.team);
    if (!mates.length) { this.spectating = null; return; }
    this.spectating = mates[(mates.indexOf(this.spectating) + 1) % mates.length];
  }

  // ---- the frame ------------------------------------------------------------------------------------------------------
  frame(dt) {
    if (!this.scene) return;
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= TICK && steps < 8) { this.tick(); this.acc -= TICK; steps++; }
      if (steps === 8) this.acc = 0;
    }
    const me = this.me, gun = this.arsenal.gun;
    // Camera: your eyes (interpolated, with recoil punch), the death cam, or a teammate you spectate.
    let camEye;
    if (me.alive) {
      const a = this.paused ? 1 : this.acc / TICK;
      const eye = this.player.eye();
      camEye = [0, 1, 2].map((i) => this.prevEye[i] + (eye[i] - this.prevEye[i]) * a);
      const [pitch, yaw] = this.arsenal.viewAngles(this.input.pitch, this.input.yaw);
      this.camera.rotation.set((-pitch * Math.PI) / 180, (yaw * Math.PI) / 180 + Math.PI, 0);
    } else if (this.deathCam && this.now < this.deathCam.until) {
      camEye = this.deathCam.from;
      const k = this.deathCam.killer;
      if (k?.alive) this.lookAt(camEye, this.bodyOf(k).head, 4 * dt);
    } else {
      if (!this.spectating?.c.alive) this.nextSpectate();
      const s = this.spectating;
      if (s) {
        const eye = s.eye(), { fwd } = basis(Math.max(-20, Math.min(40, s.pitch)), s.yaw);
        const back = [-fwd[0], -fwd[1], -fwd[2] * 0.3 + 0.35];
        const bl = Math.hypot(...back);
        const hit = this.collision.raycast(eye, back.map((v) => v / bl), 110, FLAG_BULLET);
        const dist = hit ? Math.max(10, hit.t - 8) : 110;
        camEye = [eye[0] + (back[0] / bl) * dist, eye[1] + (back[1] / bl) * dist, eye[2] + (back[2] / bl) * dist];
        this.lookAt(camEye, [eye[0] + fwd[0] * 200, eye[1] + fwd[1] * 200, eye[2] + fwd[2] * 200], 1);
      } else camEye = this.deathCam?.from || this.player.eye();
    }
    this.camEye = camEye;
    toGl(camEye, this.camera.position);
    if (this.shake > 0) { this.shake = Math.max(0, this.shake - dt); this.camera.rotation.x += (Math.random() - 0.5) * 0.03 * this.shake; this.camera.rotation.y += (Math.random() - 0.5) * 0.03 * this.shake; }
    const zoomFov = me.alive && gun?.zoom ? gun.stats.zoomFov[gun.zoom - 1] : FOV;
    if (this.camera.userData.fov !== zoomFov) {
      this.camera.userData.fov = zoomFov;
      this.camera.fov = vfov(zoomFov);
      this.camera.updateProjectionMatrix();
      this.input.sensitivity = this.baseSensitivity * (zoomFov / FOV);
      this.hud.scoped(me.alive && gun?.zoom && /SNIPER/.test(gun.stats.type));
    }
    // Viewmodel follows the view, with a little bob while running.
    for (const g of Object.values(this.arsenal.guns)) g.vm.rig.visible = me.alive && g === gun && !(gun.zoom && gun.stats.hideViewmodelZoomed) && !this.defusing;
    if (gun && me.alive) {
      gun.vm.update(this.paused ? 0 : dt);
      const sp = this.player.onGround ? Math.min(1, this.player.speed2d() / 250) : 0;
      this.bob = (this.bob || 0) + dt * (6 + 4 * sp) * (sp > 0.05 ? 1 : 0);
      gun.vm.rig.position.set((VIEWMODEL_OFFSET[0] + Math.cos(this.bob) * 0.25 * sp) * IN, (VIEWMODEL_OFFSET[2] - Math.abs(Math.sin(this.bob)) * 0.35 * sp) * IN, -VIEWMODEL_OFFSET[1] * IN);
    }
    this.vmRoot.quaternion.copy(this.camera.quaternion);
    this.vmCamera.quaternion.copy(this.camera.quaternion);
    for (const b of this.bots) {
      if (!b.root.visible) continue;
      b.sync();
      b.animate(this.paused ? 0 : dt);
    }
    this.effects.update(dt);
    this.vmSun.intensity = this.world.sun.intensity * this.sunVis;

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    if (me.alive) this.renderer.render(this.vmScene, this.vmCamera);

    this.fps = this.fps ? this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 60;
    this.updateHud(dt);
    this.emit('frame', dt);
  }

  lookAt(from, to, rate) {
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const pitch = Math.atan2(d[2], Math.hypot(d[0], d[1]));
    const yaw = Math.atan2(d[1], d[0]);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw + Math.PI, 0, 'YXZ'));
    this.camera.quaternion.slerp(q, Math.min(1, rate));
  }

  updateHud(dt) {
    const m = this.match, me = this.me, gun = this.arsenal.gun, hud = this.hud;
    if (!m) return;
    const sideScore = (side) => m.score[this.combatants.find((c) => c.team === side)?.squad] ?? 0;
    hud.top({
      ct: sideScore('CT'), t: sideScore('T'),
      aliveCT: m.alive('CT').length, aliveT: m.alive('T').length,
      totalCT: this.combatants.filter((c) => c.team === 'CT').length, totalT: this.combatants.filter((c) => c.team === 'T').length,
      clock: m.phase === 'end' ? 0 : m.time, planted: m.phase === 'planted', phase: m.phase,
    });
    const s = this.spectating && !me.alive ? this.spectating.c : me;
    hud.vitals(s.health, s.armor, s.helmet);
    hud.money(me.money, { buyzone: me.alive && m.buyOpen && this.inBuyZone(), c4: me.hasC4, kit: me.defuser });
    hud.spectate(!me.alive && this.spectating && !(this.deathCam && this.now < this.deathCam.until) ? this.spectating.c.name : null);
    hud.crosshair(me.alive && !this.buyMenu.isOpen);
    if (me.alive && gun && !gun.melee) hud.setCrosshair(this.arsenal.inaccuracy(gun));
    const ammoKey = me.alive && gun ? `${gun.name}|${gun.clip}|${gun.reserve}` : '';
    if (ammoKey !== this.ammoKey) { this.ammoKey = ammoKey; hud.ammo(me.alive ? gun : null); }
    // Planting / defusing progress.
    if (this.planting) hud.progress('Planting the bomb', Math.min(1, (this.now - this.planting.start) / m.rules.plantTime));
    else if (m.bomb?.defuser === me) { const tot = me.defuser ? m.rules.defuseKitTime : m.rules.defuseTime; hud.progress(me.defuser ? 'Defusing (kit)' : 'Defusing', 1 - (m.bomb.defuseEnd - this.now) / tot); }
    else hud.progress(null);
    this.hudTimer = (this.hudTimer || 0) - dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      hud.fps(this.fps);
      hud.place(me.alive ? this.place() : null);
      if (this.buyMenu.isOpen) { if (!m.buyOpen || !this.inBuyZone()) this.closeBuyMenu(); else this.buyMenu.render(); }
      if (!this.matchOver) hud.scoreboard(this.input.held('scores'), this.scoreData());
      this.radar?.draw(this.radarData());
    }
  }

  scoreData() {
    const side = (s) => this.match.score[this.combatants.find((c) => c.team === s)?.squad] ?? 0;
    return {
      myTeam: this.me.team, round: this.match.round, scores: { CT: side('CT'), T: side('T') },
      players: this.combatants.map((c) => ({ name: c.name, team: c.team, money: c.money, kills: c.kills, deaths: c.deaths, assists: c.assists, damage: c.damage, mvps: c.mvps, score: c.score, alive: c.alive, me: c === this.me })),
    };
  }
  radarData() {
    const m = this.match, me = this.me;
    const view = !me.alive && this.spectating ? { pos: this.spectating.pos, yaw: this.spectating.yaw } : { pos: this.player.origin, yaw: this.input.yaw };
    const b = m.bomb;
    const bomb = b && (b.state === 'planted' || (b.state === 'dropped' && me.team === 'T')) ? { pos: b.pos, planted: b.state === 'planted' } : null;
    return {
      center: view.pos, yaw: view.yaw, myTeam: me.team, bomb,
      mates: this.combatants.filter((c) => c.team === me.team && c !== me).map((c) => ({ pos: this.positionOf(c), alive: c.alive })),
      enemies: this.combatants.filter((c) => c.team !== me.team && c.alive && c.spottedBy === me.squad && this.now - (c.spottedAt ?? -9) < 1.5).map((c) => ({ pos: this.positionOf(c) })),
    };
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
    for (const job of this.vmCache.values()) job.then((x) => x.vm.dispose()).catch(() => {});
    for (const b of this.bots || []) b.dispose();
    this.effects?.dispose();
    this.world?.dispose();
    this.vmEnv?.dispose();
    this.sounds?.dispose();
    this.radar?.dispose();
    this.hud.dispose();
    this.buyMenu.el.remove();
    this.renderer.dispose();
    this.canvas.remove();
    this.listeners.clear();
  }
}
