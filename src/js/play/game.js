// Play mode: an offline match on a CS2 map against bots (Competitive, Wingman, Deathmatch or Arms Race; modes.js).
// Owns the renderer, the
// 64-tick simulation (movement, weapons, bots, the round) and the frame loop. Rendering interpolates between ticks like
// CS2's client; your weapon is drawn in its own pass with CS2's viewmodel field of view.
import * as THREE from 'three';
import { cs2Play } from '../cs2/api.js';
import { equipped } from '../loadout.js';
import { itemDef } from '../items.js';
import { D } from '../data.js';
import { CollisionWorld, FLAG_BULLET, FLAG_PLAYER } from './collision.js';
import { PlayerMovement, HULL_STAND as BOT_HULL } from './movement.js';
import { loadWorld, toGl, fromGl } from './world.js';
import { Input, bindTable } from './input.js';
import { SoundBank } from './sound.js';
import { Soundscapes } from './soundscape.js';
import { FrameLog } from './framelog.js';
import { buildViewmodel } from './viewmodel.js';
import { Arsenal, Gun, basis, refillAmmo, WHEEL } from './weapons.js';
import { BotAssets, Bot, BOT_NAMES, rayCapsule, bindBounds } from './bots.js';
import { Brain, botGun, inaccuracyOf } from './ai.js';
import { teamPlan, teamEconomy } from './strats.js';
import { Effects } from './effects.js';
import { Hud } from './hud.js';
import { NavMesh } from './nav.js';
import { Match, Combatant, RULES, SHORT_RULES, DEFAULT_PISTOL, ITEM_NAMES, slotOf, isGrenade } from './match.js';
import { BuyMenu } from './buymenu.js';
import { DevConsole } from './console.js';
import { iconFor, iconPictures } from './icons.js';
import { Radar } from './radar.js';
import { buildCS2Model, buildGloveScene } from '../cs2/skin.js';
import { Grenades, NADES, NADE_ORDER, NADE_SOUNDS, throwVelocity, aimThrow as aimThrowPitch } from './grenades.js';
import { Drops, gunSkin, LOCAL } from './drops.js';
import { Balls } from './props.js';
import { Doors } from './doors.js';
import { Post } from './post.js';
import { numberUniforms } from './uniforms.js';
import { quietSorting } from './drawsort.js';
import { quietKeyframes } from './keyframes.js';
import { Radio } from './radio.js';
import { MODES, WINGMAN_RULES, Deathmatch, ARMS_RACE, PROTECT } from './modes.js';
import { act } from '../backend.js';
import { matchRewardHtml } from '../profile.js';
import { esc } from '../util.js';
import { S } from '../state.js';
import { rankInfo, SKILL_GROUPS } from '../engine/ranks.js';
import { rankPictures, rankArt, emblemHtml, rankKey, ratingHtml } from '../rank.js';
import { botIdentities, pickIdentities } from './identity.js';
import { tierOf, TO_DIFFICULTY, botSkill, groupOfSkill, ratingOfSkill, skillParams, tierOfGroup, mmrOfSkill } from './skill.js';
import { premierInfo, formatRating } from '../engine/premier.js';
import { loadLineups } from './utility.js';
import { Spots } from './spots.js';
import { screenLayout } from './screen.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export const TICK = 1 / 64;
const TECH_TIMEOUT = 120; // seconds a technical timeout (you left the match) holds the freeze time for you to come back
// A CS2 field of view (horizontal degrees at 4:3) as three.js's vertical FOV; wider screens see more, like CS2.
const vfov = (fov43) => (2 * Math.atan(Math.tan((fov43 * Math.PI) / 360) * 0.75) * 180) / Math.PI;
const FOV = 90;
const VIEWMODEL = { fov: 68, x: 1, y: 1, z: -1 }; // CS2's viewmodel_fov and viewmodel_offset_x/y/z (inches)
const IN = 0.0254;
const BODY_STAY = 10, BODY_SINK = 1.5; // seconds a body lies there, and sinks into the floor for before it's gone
const FAR_BOT = 1200; // game units: a bot further off than this is posed every other frame (see frame)

const SURFACE_STEP = { concrete: 'Concrete', rock: 'Concrete', tile: 'Tile', sand: 'Sand', dirt: 'Dirt', wood: 'Wood', wood_solid: 'Wood_Solid',
  wood_panel: 'Wood', wood_plank: 'Wood', wood_dense: 'Wood', wood_crate: 'Wood', wood_basket: 'Wood_Basket', wood_tree: 'Wood', metal: 'SolidMetal',
  solidmetal: 'SolidMetal', metalpanel: 'SolidMetal', metalvent: 'MetalVent', metalvehicle: 'MetalVehicle', metal_sand_barrel: 'MetalBarrel',
  metal_dumpster: 'SolidMetal', chainlink: 'ChainLink', glass: 'Glass', carpet: 'Default', default: 'Default', ladder: 'Ladder', wood_ladder: 'Wood_Ladder' };
const SURFACE_IMPACT = { concrete: 'Concrete', rock: 'Concrete', tile: 'Tile', sand: 'Sand', dirt: 'Dirt', metal: 'SolidMetal', solidmetal: 'SolidMetal',
  metalpanel: 'SolidMetal', metalvent: 'SolidMetal', metalvehicle: 'MetalVehicle', metal_sand_barrel: 'MetalBarrel', metal_dumpster: 'SolidMetal',
  chainlink: 'ChainLink', glass: 'Glass', carpet: 'Carpet', pottery: 'Pottery', computer: 'Computer' };
const stepName = (s) => SURFACE_STEP[String(s).toLowerCase()] || (/wood/i.test(s) ? 'Wood' : /metal/i.test(s) ? 'SolidMetal' : 'Default');
const impactName = (s) => SURFACE_IMPACT[String(s).toLowerCase()] || (/wood/i.test(s) ? 'Wood' : /metal/i.test(s) ? 'SolidMetal' : 'Default');

const DEFAULT_KNIFE = { T: { wid: 'weapon_knife_t', w: 'Knife', n: 'Knife', cat: 'knife', v: true }, CT: { wid: 'weapon_knife', w: 'Knife', n: 'Knife', cat: 'knife', v: true } };
// Guns players buy most, loaded in the background so buying them is instant.
const PRELOAD = ['weapon_ak47', 'weapon_m4a1', 'weapon_m4a1_silencer', 'weapon_awp', 'weapon_flashbang', 'weapon_smokegrenade', 'weapon_hegrenade', 'weapon_molotov',
  'weapon_incgrenade', 'weapon_deagle', 'weapon_galilar', 'weapon_famas', 'weapon_mp9', 'weapon_mac10', 'weapon_decoy', 'weapon_taser'];
const BOT_GUNS = ['weapon_glock', 'weapon_usp_silencer', 'weapon_ak47', 'weapon_m4a1', 'weapon_m4a1_silencer', 'weapon_awp', 'weapon_deagle', 'weapon_p250',
  'weapon_galilar', 'weapon_famas', 'weapon_mac10', 'weapon_mp9', 'weapon_tec9', 'weapon_fiveseven', 'weapon_knife', 'weapon_knife_t', 'weapon_c4', ...NADE_ORDER];
// How easily bullets go through each surface (CS2's penetration modifiers, roughly): thickness allowed = 32 x weapon
// penetration x this.
const PENETRATION = { wood: 1, wood_panel: 1, wood_plank: 1, wood_crate: 1.2, wood_basket: 1.5, wood_dense: 0.7, wood_solid: 0.6, wood_tree: 0.3,
  glass: 2, chainlink: 3, plastic: 1.5, carpet: 1, computer: 0.8, pottery: 1, metalpanel: 0.6, metal: 0.4, metalvehicle: 0.5, metalvent: 0.7,
  metal_sand_barrel: 0.5, metal_dumpster: 0.4, solidmetal: 0.15, concrete: 0.3, rock: 0.15, tile: 0.35, dirt: 0.3, sand: 0.3, rubbertire: 0.5, default: 0.4 };
const MUSIC = 'valve_cs2_01';

const _frustum = new THREE.Frustum(), _m4 = new THREE.Matrix4(), _sphere = new THREE.Sphere(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _euler = new THREE.Euler();
const PARTS = ['ai', 'bots', 'draw', 'hud']; // (net_graph 2's split of the frame)

const _d3 = [0, 0, 0], _feet = [0, 0, 0], _from = [0, 0, 0], DOWN = [0, 0, -1]; // (plain arrays: see collision.js)
// The planted bomb's LED, on its circuit board between the keypad and the screen (metres from where the C4 model sits),
// lit red for a moment with each beep as in CS2: a solid red point (red over the bright ground too, where only adding
// light washes out), a hot middle and a red glow round it, and a dot that stays a few pixels across however far off
// you are (so it's seen across a site); drawn over the model, as a light added mid-match would recompile every material.
// LED_ON: seconds lit at full, then LED_FADE going out.
// (Its glow stands just over the top of the C4, 9 cm up: lower, the keypad and the screen's board hid it from the side.)
const BOMB_LED = [0.0049, 0.09, -0.0002], LED_ON = 0.12, LED_FADE = 0.1;
function bombLed() {
  // A soft glow, and a dot: solid to half way out, then soft.
  const disc = (shape) => {
    const N = 32, data = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const r = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) / (N / 2);
      data.set([255, 255, 255, Math.round(255 * shape(Math.min(1, r)))], (y * N + x) * 4);
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  };
  const glow = disc((r) => (1 - r) ** 2), dot = disc((r) => Math.min(1, 2 * (1 - r)));
  const led = new THREE.Group();
  // [size (metres, or of the view's height at a metre off), texture, colour, opacity, added light?, same size on screen?]
  for (const [size, map, color, opacity, add, fixed] of [[0.18, glow, 0xff1a0a, 0.6, false, false], [0.03, dot, 0xff1206, 1, false, false],
    [0.014, dot, 0xffc0a0, 1, true, false], [0.009, dot, 0xff1a0a, 1, false, true]]) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, opacity, transparent: true, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false, fog: false, toneMapped: false, sizeAttenuation: !fixed }));
    s.scale.set(size, size, 1);
    s.renderOrder = 6;
    s.userData.opacity = opacity;
    led.add(s);
  }
  led.position.set(0, -1000, 0); // (until a bomb's planted: in the scene from the start, so it compiles with the map)
  return led;
}

export class Game {
  // difficulty: the bots' rank tier (skill.js: silver .. global; the old easy .. expert work too). roster (matchmaking,
  // a private match, Premier's veto): { A: your teammates, B: the other team (everyone in free for all) } as
  // [{ identity?, skill }] (else they're picked here, from the tier). ranked: matchmade Premier, Competitive or Wingman
  // (the result moves your rank). quiet: no sound until it's shown (loading behind the menu while you search).
  constructor(root, { map = 'de_dust2', mode = 'competitive', team = 'CT', teamSize = 5, difficulty = 'gold', length = 'short', overtime = true, friendlyFire = false,
    site = 'A', minutes = 10, ffa = true, sensitivity = 1.25, quality = 'balanced', settings = {}, roster = null, ranked = false, quiet = false, onStatus = () => {} } = {}) {
    Object.assign(this, { root, mapId: map, team, onStatus, ranked: !!ranked, quiet: !!quiet });
    quietKeyframes(); // (the bots' animation: see keyframes.js)
    this.enemyTeam = team === 'T' ? 'CT' : 'T';
    this.mode = MODES[mode] ? mode : 'competitive';
    this.respawnMode = !!MODES[this.mode].respawn;
    this.armsRace = this.mode === 'armsrace';
    this.ffa = this.armsRace || (this.mode === 'deathmatch' && !!ffa);
    this.minutes = minutes;
    this.wingmanSite = site;
    this.teamSize = this.mode === 'wingman' ? 2 : Math.max(1, Math.min(5, teamSize | 0));
    this.botTier = tierOf(difficulty);
    this.difficulty = TO_DIFFICULTY[this.botTier]; // (what match rewards and your rank's opponents go by)
    this.premier = this.mode === 'premier';
    this.roster = roster;
    // Premier is the full MR12 with overtime.
    this.rules = { ...(this.mode === 'wingman' ? WINGMAN_RULES : this.premier || length === 'long' ? RULES : SHORT_RULES), overtime: this.premier || !!overtime };
    this.ff = !!friendlyFire && !this.ffa;
    this.disposed = false;
    this.paused = true;
    this.listeners = new Set();
    this.now = 0;
    // What the game draws (the world, the HUD, the radar, the buy menu, the console) is in a screen of its own: the whole
    // window, or the aspect ratio picked (CS2's 4:3, 16:10...) with black bars or stretched to fill it (see resize).
    this.screen = document.createElement('div');
    this.screen.className = 'play-screen';
    root.appendChild(this.screen);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'play-canvas';
    this.screen.appendChild(this.canvas);
    // No multisampling on the screen itself: only the full-screen post pass draws there (the world is anti-aliased in its
    // own target, see post.js).
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    // (Reading each shader's compile log, the first time it's used, waited for the driver: a stall each new shader. The
    // game's shaders are known to compile; window.__cs2Shaders turns the check back on.)
    this.renderer.debug.checkShaderErrors = !!window.__cs2Shaders;
    // Quality: high renders at the screen's full resolution with soft shadows; balanced (Medium) at 1 CSS pixel; performance
    // (Low) lower, without anti-aliasing or the 3D skybox. The render scale (settings) scales any of them.
    this.quality = quality;
    // Tone mapping and colour grading happen in the post pass (post.js), like CS2's.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : quality === 'performance' ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // the map's shadows are static: rendered once after loading
    this.renderer.autoClear = false;
    // Everything drawn with the same shader together, then by material, then near to far: switching shaders costs three
    // far more than switching materials (hundreds of each a frame on a CS2 map).
    const shaders = new Map(), shaderOf = (m) => {
      if (m.userData.shader === undefined) {
        const k = [m.type, m.customProgramCacheKey?.() ?? '', !!m.map, !!m.normalMap, !!m.roughnessMap, !!m.metalnessMap, !!m.aoMap, !!m.lightMap, !!m.emissiveMap,
          !!m.envMap, m.transparent, m.side, m.alphaTest > 0, m.vertexColors].join();
        if (!shaders.has(k)) shaders.set(k, shaders.size);
        m.userData.shader = shaders.get(k);
      }
      return m.userData.shader;
    };
    this.renderer.setOpaqueSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || shaderOf(a.material) - shaderOf(b.material)
      || a.material.id - b.material.id || a.z - b.z || a.id - b.id);
    this.msaa = quality === 'performance' ? 0 : 4;
    this.anisotropy = quality === 'high' ? 16 : quality === 'performance' ? 4 : 8;
    this.camera = new THREE.PerspectiveCamera(vfov(FOV), 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    this.vmScene = new THREE.Scene();
    // Your settings: viewmodel position, crosshair, binds, volumes, the fps counter.
    this.settings = settings;
    this.vm = { ...VIEWMODEL, ...(settings.viewmodel || {}) };
    this.musicVolume = settings.musicVolume ?? 1;
    this.voiceVolume = settings.voiceVolume ?? 1;
    this.vmCamera = new THREE.PerspectiveCamera(vfov(this.vm.fov), 1, 0.005, 10);
    this.vmCamera.rotation.order = 'YXZ';
    this.vmRoot = new THREE.Group();
    this.vmRoot.rotation.order = 'YXZ';
    this.vmScene.add(this.vmRoot);
    this.input = new Input(this.canvas, { sensitivity, binds: bindTable(settings), onLockChange: (locked) => this.lockChanged(locked) });
    this.input.onKey = (code, down) => this.menuKey(code, down);
    this.input.onCommand = (c) => this.command(c);
    this.baseSensitivity = sensitivity;
    this.hud = new Hud(this.screen);
    this.hud.setCrosshairStyle(settings.crosshair);
    this.buyMenu = new BuyMenu(this.screen, this);
    // The developer console (~) and the console variables the game reads (set there).
    this.cv = { sv_cheats: 0, host_timescale: 1, sv_infinite_ammo: 0, mp_buy_anywhere: 0, bot_stop: 0, bot_dont_shoot: 0, r_drawviewmodel: 1, fps_max: 0, cl_inspect_rare: 0 };
    this.cv.fps_max = settings.fpsMax || 0; // (Play's settings; the console changes it for the match)
    this.god = false; this.noclip = false;
    this.console = new DevConsole(this.screen, this);
    this.vmCache = new Map();
    this.vmRigs = new Set(); // every weapon viewmodel loaded
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
    // CS2's weapon icons for the buy menu and the kill feed, as pictures (they show the names until these arrive, or
    // without CS2).
    cs2Play('icons').then(iconPictures).then((icons) => { if (!this.disposed) this.icons = icons; }).catch(() => {});
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
    if (!map.info.bombsites?.length && !this.respawnMode) throw new Error('This map has no bomb sites');
    // Sites are named from their callouts; if that fails, name them in order (A, B).
    const sites = map.info.bombsites || [];
    if (new Set(sites.map((s) => s.site)).size < sites.length) sites.forEach((s, i) => { s.site = 'ABCD'[i]; });
    // Wingman plays one site.
    if (this.mode === 'wingman') map.info.bombsites = sites.filter((s) => s.site === this.wingmanSite).length ? sites.filter((s) => s.site === this.wingmanSite) : sites.slice(0, 1);
    status('Loading collision…');
    const colBuf = await fetch(map.collision).then((r) => r.arrayBuffer());
    this.collision = new CollisionWorld(colBuf, map.info.collision);
    this.nav = new NavMesh(await fetch(map.nav).then((r) => r.json()));
    this.world = await loadWorld(map, this.renderer, { onProgress: status, anisotropy: this.anisotropy, sky3d: this.quality !== 'performance' });
    if (this.disposed) return;
    this.scene = this.world.scene;
    this.setupViewmodelLighting();
    this.effects = new Effects(this.scene, this.vmScene);
    this.nades = new Grenades(this);
    this.drops = new Drops(this);
    this.balls = new Balls(this, this.world.balls);
    this.doors = new Doors(this, this.world);
    // The bots' utility lineups for this map, checked on its collision (doors and all).
    this.lineups = await loadLineups(this.mapId, this.collision).catch(() => []);
    this.post = new Post(this.renderer, { samples: this.msaa, smoke: this.nades.volume });
    this.post.setLighting(this.world);
    // The map's post processing: its tone curve, auto exposure range and colour grading LUT.
    const lut = map.lut ? await fetch(map.lut).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) : null;
    this.post.setGrading({ tone: map.info.lighting?.tonemap, exposure: map.info.exposure, lut: lut && { data: new Uint8Array(lut), size: map.info.lighting.lut.size } });
    this.resize();
    this.sounds = new SoundBank();
    if (this.quiet) this.setQuiet(true);
    this.soundscapes = new Soundscapes(this, map.info.soundscapes);
    this.stats = await cs2Play('stats');
    this.impacts = await cs2Play('impacts').catch(() => ({}));
    await rankPictures(); // (the emblems as pictures: see rank.js)
    this.midSpot = this.findMid();
    // Where bots hold (spots.js), worked out now rather than as a round starts.
    this.spots = new Spots(this);
    if (!this.respawnMode) { status('Working out where bots hold…'); const t0 = performance.now(); await this.spots.prepare(); this.spotsMs = performance.now() - t0; }

    status('Loading players…');
    this.me = new Combatant({ name: 'You', team: this.team, squad: 'A', bot: false });
    this.botAssets = new BotAssets(this.renderer, this.world.ambient);
    this.botAssets.coverage = this.msaa > 0;
    await this.botAssets.load(['weapon_glock', 'weapon_usp_silencer', 'weapon_ak47', 'weapon_m4a1', 'weapon_m4a1_silencer', 'weapon_awp', 'weapon_knife', 'weapon_c4']);
    if (this.disposed) return;
    // Who the bots are: real players (identity.js), each its own rank: the roster's (matchmaking finds them around yours,
    // Premier's veto shows them), else from the tier.
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    const listed = [...(this.roster?.A || []), ...(this.roster?.B || [])];
    const ids = listed.length && listed.every((r) => r.identity) ? [] : pickIdentities(await botIdentities().catch(() => []), this.teamSize * 2 - 1);
    const slots = { A: 0, B: 0 };
    this.bots = [];
    const addBot = (team, squad) => {
      const r = this.roster?.[squad]?.[slots[squad]++], id = r?.identity || ids[this.bots.length] || null;
      const c = new Combatant({ name: id?.name || 'BOT ' + names[this.bots.length % names.length], team, squad });
      c.identity = id;
      c.skill = r?.skill ?? botSkill(c.name, this.botTier);
      c.rating = ratingOfSkill(c.skill);
      const b = new Bot(this.botAssets, c, this.bots.length);
      b.brain = new Brain(this, b, c.skill);
      this.scene.add(b.root);
      this.bots.push(b);
    };
    if (this.ffa) {
      // Free for all: everyone against everyone (half wear each side's agents).
      for (let i = 0; i < this.teamSize * 2 - 1; i++) addBot(i % 2 ? this.team : this.enemyTeam, 'B');
    } else {
      for (let i = 0; i < this.teamSize - 1; i++) addBot(this.team, 'A');
      for (let i = 0; i < this.teamSize; i++) addBot(this.enemyTeam, 'B');
    }
    this.combatants = [this.me, ...this.bots.map((b) => b.c)];
    this.botByC = new Map(this.bots.map((b) => [b.c, b])); // (botOf: asked thousands of times a second)
    // What the match's reward goes by: the other team's ranks (everyone's in free for all).
    if (this.roster) {
      const them = this.bots.filter((b) => b.c.squad === 'B');
      this.difficulty = TO_DIFFICULTY[tierOfGroup(groupOfSkill(them.reduce((s, b) => s + b.c.skill, 0) / Math.max(1, them.length)))];
    }
    this.radio = new Radio(this);
    // Your own body, seen where you fell while you spectate.
    this.myBody = new Bot(this.botAssets, this.me, 1);
    this.myBody.root.visible = false;
    this.scene.add(this.myBody.root);
    this.pings = [];

    status('Loading weapons and sounds…');
    this.arsenal = new Arsenal(this, {});
    this.player = new PlayerMovement(this.bodyWorld(() => this.me), this.map.info.spawns[this.team][0].origin);
    this.prevEye = this.player.eye();
    await Promise.all([
      this.sounds.load(this.commonSounds()), this.soundscapes.load(),
      this.vmData(this.knifeId(this.team)), this.vmData(DEFAULT_PISTOL.CT), this.vmData(DEFAULT_PISTOL.T), this.vmData('weapon_c4'),
    ]);
    if (this.disposed) return;
    this.bombTemplate = buildCS2Model({ t: 'skin', fl: 0, sd: 0 }, { wid: 'weapon_c4', w: 'C4', n: 'C4', cat: 'equipment', v: true }, this.renderer, { quick: true }).catch(() => null);
    if (map.radar) this.radar = new Radar(this.screen, map.radar);
    this.scene.add((this.bombLed = bombLed()));
    this.match = this.respawnMode ? new Deathmatch(this, { minutes: this.minutes, ffa: this.ffa, armsRace: this.armsRace }) : new Match(this, this.rules);
    if (this.respawnMode) await Promise.all((this.armsRace ? ARMS_RACE : [this.dmWeapon('primary'), this.dmWeapon('secondary')]).slice(0, 2).map((id) => this.vmData(id).catch(() => {})));
    // Every gun the match will show, now rather than in it (each one loaded mid-round stalled the game a tenth of a second
    // or more, and its textures again the first time it was drawn): the bots' guns as they lie on the floor and as they
    // hold them (in their own materials, see Bot.lightOwn: the first bot to hold each one compiled it mid-round), your
    // viewmodels and the plain ones you see spectating a bot, each with its shaders compiled and its textures on the GPU.
    const guns = [...new Set([...BOT_GUNS, ...PRELOAD, ...(this.armsRace ? ARMS_RACE : [])])];
    // (And your skins on those guns as they'll lie on the floor when you drop one, and in a bot's hands if it picks one up.)
    const worldGuns = [...BOT_GUNS.map((id) => [id, null]), ...guns.filter((id) => !/knife|bayonet/.test(id) && this.ownSkin(id)).map((id) => [id, this.ownSkin(id)])];
    const jobs = [
      ...worldGuns.map(([id, item]) => async () => {
        const tpl = await this.botAssets.weapon(id, item);
        if (!tpl) return;
        const { model } = this.botAssets.staticWeapon(tpl), held = model.clone();
        await this.warm(model, this.scene);
        if (this.bots[0]) { this.bots[0].lightOwn(held); await this.warm(held, this.scene); }
      }),
      ...guns.flatMap((id) => [false, true].map((plain) => async () => { const d = await this.vmData(id, { plain }).catch(() => null); if (d) await this.warm(d.vm.rig, this.vmScene); })),
    ];
    // The planted bomb (lit as it will be: lighting it changes its shaders).
    jobs.push(async () => { const m = await this.bombTemplate; if (m) { this.botAssets.light(m.userData.root); await this.warm(m.userData.root, this.scene); } });
    let loaded = 0;
    const next = async () => { while (jobs.length && !this.disposed) { await jobs.shift()(); status(`Loading weapons… ${++loaded} of ${loaded + jobs.length}`); } };
    await Promise.all([next(), next(), next(), next()]);
    if (this.disposed) return;
    status('Compiling shaders…');
    this.effects.warmUp(true); // (the muzzle flash, impacts and tracers: compiled now, not at the first shot)
    // Every bot and your own body too, though out of view (they'd compile when they first came into sight), with their
    // bones' textures made.
    const bodies = [...this.bots, this.myBody];
    for (const b of bodies) { b.view.visible = true; b.root.userData.wasVisible = b.root.visible; b.root.visible = true; }
    // So is the map's own hidden stuff (entities that start switched off, a door's other state...): it compiled the moment
    // it showed.
    const hidden = [];
    this.scene.traverse((o) => { if (!o.visible && !o.isLight) { hidden.push(o); o.visible = true; } });
    // Alpha to coverage: with multisampling, cut-out surfaces (foliage, fences, a model's straps and netting) blend their
    // edges by how much of each pixel they cover, instead of each pixel being all in or all out (sparkling dots along
    // them). Set before they compile here.
    if (this.msaa) for (const sc of [this.scene, this.vmScene]) sc.traverse((o) => { for (const m of [].concat(o.material || [])) if (m.alphaTest > 0) m.alphaToCoverage = true; });
    this.post.compile(this.scene, this.camera, { scene: this.vmScene, camera: this.vmCamera });
    // Then each drawn once: a model's buffers go up the first time it's drawn, and Direct3D (ANGLE, under WebGL) finishes
    // a shader for the model's vertices and the target the first time it draws with it (frames of 30 ms and more with
    // everything compiled: a gun falling, a body coming into view).
    // The 3D skybox too, all of it (its own scene: only what was in view as you spawned was drawn, the rest compiled
    // the first time you turned to it).
    const sky = this.world.sky3d?.scene;
    this.drawOnce([...this.warmed || [], ...bodies.map((b) => [b.root, this.scene]), ...hidden.map((o) => [o, this.scene]),
      ...(this.effects.warm || []).map((o) => [o, this.scene]), [this.effects.flash, this.vmScene], ...(sky ? [[sky, sky]] : [])]);
    this.warmed = null;
    numberUniforms(this.renderer); // (every shader's compiled now: see uniforms.js)
    quietSorting(this.renderer, [this.scene, this.vmScene, sky]); // (see drawsort.js)
    for (const o of hidden) o.visible = false;
    for (const b of bodies) {
      b.root.visible = b.root.userData.wasVisible;
      b.root.traverse((o) => { if (o.isSkinnedMesh && !o.skeleton.boneTexture) { o.skeleton.computeBoneTexture(); this.renderer.initTexture(o.skeleton.boneTexture); } });
    }
    this.effects.warmUp(false);
    // Every texture on the GPU now, not the first time it comes into view (a hitch turning round).
    const textures = new Set(this.world.layerTextures);
    for (const sc of [this.scene, this.world.sky3d?.scene]) sc?.traverse((o) => { if (o.material) for (const v of Object.values(o.material)) if (v?.isTexture) textures.add(v); });
    for (const t of textures) this.renderer.initTexture(t);
    this.renderer.shadowMap.needsUpdate = true;
    this.match.startRound();
    // The match's start as the economy sees it: its run, which its reward is paid against (see payReward; online, the
    // server pays only a match it saw start, and only what it could have earned in the time).
    this.started = act('play.start', { mode: this.mode }).then((r) => r?.run ?? null).catch((e) => { console.warn('match start', e); return null; });
    // One frame drawn now, behind the loading screen: what's made the first time anything is drawn (render targets, the
    // shadow map, the bots and your weapon) isn't in the match's first frame.
    this.acc = 0;
    this.frame(0);
    window.gc?.(); // (what loading left behind, collected now rather than in a stall mid-round: see main.js)
    for (const c of this.combatants) if (c !== this.me) this.hud.chatLine({ system: true, text: `${c.name} has joined the ${this.ffa ? 'game' : c.team === 'CT' ? 'Counter-Terrorists' : 'Terrorists'}` });
    this.emit('loaded');
  }

  // A model ready to be drawn: its shaders compiled and its textures uploaded (and drawn once as Play loads: drawOnce).
  async warm(obj, scene) {
    if (!obj || this.disposed || this.warming?.has(obj)) return;
    (this.warming ||= new Set()).add(obj); // (one viewmodel can be two looks': with no gloves or skin, yours is a bot's)
    await this.precompile(obj, scene);
    (this.warmed ||= []).push([obj, scene]);
    obj.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) if (v?.isTexture) this.renderer.initTexture(v);
        // And the ones only its shader has (a skin's pattern, wear and grunge, a sticker's: they went up the first time it
        // was drawn, two dozen in one frame).
        const props = this.renderer.properties.get(m);
        for (const u of Object.values(props.uniforms || {})) for (const v of [].concat(u?.value ?? [])) if (v?.isTexture) this.renderer.initTexture(v);
        // Its shaders' first use (their uniforms and attributes looked up), done now that they're linked.
        for (const p of props.programs?.values() || []) { p.getUniforms(); p.getAttributes(); }
      }
      // (A skinned mesh's bone matrices go to the GPU as a texture, made the first time it's drawn.)
      if (o.isSkinnedMesh && !o.skeleton.boneTexture) { o.skeleton.computeBoneTexture(); this.renderer.initTexture(o.skeleton.boneTexture); }
    });
  }

  // Draws these ([object, its scene]) once, by themselves (on a layer of their own, the rest left out), into the target
  // their scene is drawn to and lit as it is. One not in its scene is put in for the draw.
  drawOnce(list) {
    const r = this.renderer, L = 31, prev = r.getRenderTarget();
    const sky = this.world.sky3d;
    for (const [scene, camera, rt] of [[this.scene, this.camera, this.post.rt], [this.vmScene, this.vmCamera, this.post.vmRT], ...(sky ? [[sky.scene, sky.camera, this.post.rt]] : [])]) {
      const was = new Map(), holder = new THREE.Group();
      const tag = (o) => { if (!was.has(o)) was.set(o, [o.layers.mask, o.frustumCulled]); o.layers.enable(L); o.frustumCulled = false; };
      for (const [o, sc] of list) {
        if (!o || sc !== scene) continue;
        let top = o;
        while (top.parent) top = top.parent;
        if (!top.isScene) holder.add(top);
        if (top.isScene && top !== scene) continue;
        o.traverse(tag);
      }
      if (!was.size) continue;
      scene.traverse((o) => { if (o.isLight) tag(o); });
      scene.add(holder);
      const mask = camera.layers.mask, bg = scene.background;
      camera.layers.set(L); scene.background = null;
      r.setRenderTarget(rt);
      r.shadowMap.needsUpdate = true; // (a shadow map to sample: without one every lit draw failed)
      r.render(scene, camera);
      camera.layers.mask = mask; scene.background = bg;
      for (const [o, [m, f]] of was) { o.layers.mask = m; o.frustumCulled = f; }
      for (const o of [...holder.children]) holder.remove(o);
      holder.removeFromParent();
    }
    r.setRenderTarget(prev);
    r.shadowMap.needsUpdate = true; // (drawn again in full, from everything: these only cast into it)
  }

  // A model's shaders compiled while the game goes on (the browser links them alongside) before it's first drawn: a gun
  // loaded mid-match (one a bot buys, or yours the first time you switch to it) used to stall the frame it showed up in.
  async precompile(obj, scene) {
    if (!obj || this.disposed) return;
    const r = this.renderer, prev = r.getRenderTarget(), vm = scene === this.vmScene, shown = obj.visible;
    obj.visible = true; // (hidden things aren't compiled)
    r.setRenderTarget(vm ? this.post.vmRT : this.post.rt);
    const done = r.compileAsync(obj, vm ? this.vmCamera : this.camera, scene);
    r.setRenderTarget(prev);
    obj.visible = shown;
    await done.catch(() => {});
  }

  // A surface's bullet impact sound: CS2's own for it (Inferno's church bells ring), else one for its kind.
  impactSound(surface) { return this.impacts?.[String(surface).toLowerCase()] || `${impactName(surface)}.BulletImpact`; }

  commonSounds() {
    const surfaces = this.map.info.collision.surfaces;
    const steps = [...new Set(surfaces.map(stepName))].flatMap((s) => [`CT_${s}.StepLeft`, `CT_${s}.StepRight`, `Land_${s}.StepLeft`]);
    const impacts = [...new Set(surfaces.flatMap((s) => [this.impactSound(s), `${impactName(s)}.BulletImpact`]))];
    const guns = BOT_GUNS.map((id) => this.stats[id]?.shootSound).filter(Boolean);
    return [...steps, ...impacts, ...guns, ...this.doors.sounds(), 'Weapon_M4A1.Silenced', 'Weapon_USP.SilencedShot', 'Default.BulletImpact', 'Flesh.BulletImpact',
      'Default.ClipEmpty_Rifle', 'Default.ClipEmpty_Pistol', 'Weapon_AWP.Zoom', 'Weapon_AWP.ZoomOut', 'Weapon_AK47.Clipout', 'Weapon_M4A1.Clipout',
      'Player.DamageBody.AttackerFeedback', 'Player.DamageBodyArmor.AttackerFeedback', 'Player.DamageHeadShot.AttackerFeedback',
      'Player.DamageHeadShotArmor.AttackerFeedback', 'Player.DeathHeadShot.AttackerFeedback', 'Player.DeathHeadShotArmor.AttackerFeedback',
      'Player.DeathBody.AttackerFeedback', 'Player.DeathBodyArmor.AttackerFeedback', 'Player.DamageBody.Victim', 'Player.DamageBodyArmor.Victim',
      'Player.DamageHeadShot.Victim', 'Player.DamageHeadShotArmor.Victim', 'Player.DeathBody.Victim', 'Player.DeathHeadShot.Victim',
      'Weapon_Knife.Hit', 'Weapon_Knife.HitWall', 'Weapon_Knife.Slash', 'Weapon_Knife.Stab', 'Weapon_Knife.Deploy', 'Weapon_Knife.Swish.Heavy',
      'Default.Land', 'BulletBy.Supersonic.Crack', 'c4.plant', 'c4.initiate', 'c4.disarmstart', 'c4.disarmfinish', 'c4.explode', 'C4.PlantSound',
      'c4.keypressquiet', 'Player.PickupC4', 'Player.PickupWeapon', 'Event.BombPlanted', 'Event.BombDefused', 'Event.CTWin', 'Event.TERWin',
      `Music.StartRound.${MUSIC}`, `Music.BombPlanted.${MUSIC}`, `Music.WonRound.${MUSIC}`, `Music.LostRound.${MUSIC}`, `Music.MatchEnd.${MUSIC}`,
      ...NADE_SOUNDS, 'Molotov.Draw', 'HEGrenade.Draw', 'Player.PickupGrenadeAudible', 'Player.PickupWeaponSilent', 'Player.DeathTaser', 'Player.DamageFall',
      'CT_Ladder.StepLeft', 'CT_Wood_Ladder.StepLeft', 'UI.PlayerPing', 'Ball.ImpactSoft', 'Ball.ImpactHard', 'Ball.BulletImpact',
      'UIPanorama.XP.NewSkillGroup', 'UIPanorama.XP.RankDown', 'UIPanorama.XP.NewRank'];
  }

  setupViewmodelLighting() {
    const w = this.world;
    this.vmSun = new THREE.DirectionalLight(w.sun.color, w.sun.intensity);
    this.vmSun.position.copy(w.sun.position).sub(w.sun.target.position).normalize();
    this.vmScene.add(this.vmSun);
    const amb = w.ambient;
    // Your weapon's indirect light: the light probes where you are (updated each frame), else a sky/ground ambient.
    this.vmHemi = new THREE.HemisphereLight(amb.sky.value.clone().multiplyScalar(2.2), amb.ground.value.clone().multiplyScalar(2.2), 1);
    this.vmScene.add(this.vmHemi);
    this.vmCube = new Float32Array(18);
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
  // The viewmodel for a weapon, built once per match for each look: your equipped skin and gloves; skin: the skin of
  // the gun in your hands (see drops.js gunSkin: one you picked up, a bot's default, null) with your gloves; plain: a
  // bot's hands (no gloves of yours) and its gun's skin (the default, unless that's given), seen spectating it.
  vmData(wid, { plain = false, skin } = {}) {
    const knife = /knife|bayonet/.test(wid);
    if (knife || wid === 'weapon_c4' || NADES[wid]) skin = undefined; // (your own, never dropped)
    const shown = skin === undefined ? (plain ? null : this.ownSkin(wid)) : skin?.item && itemDef(skin.item) ? skin.item : null;
    const gloves = plain ? null : equipped('gloves');
    // (Looks that come out the same share one: a bot's default gun is yours when you have no skin for it or gloves.)
    const key = (gloves ? 'gloves:' : '') + (shown ? 'item:' + (shown.uid || JSON.stringify(shown)) + ':' : '') + wid;
    if (!this.vmCache.has(key)) {
      const job = (async () => {
        const vanilla = Object.values(D.skins).find((s) => s.wid === wid);
        const item = shown;
        let def;
        if (knife) def = item ? itemDef(item) : DEFAULT_KNIFE[wid === 'weapon_knife_t' ? 'T' : 'CT'];
        else if (wid === 'weapon_c4') def = { wid, w: 'C4 Explosive', n: 'C4 Explosive', cat: 'equipment', v: true };
        else if (NADES[wid]) def = { wid, w: NADES[wid].name, n: NADES[wid].name, cat: 'equipment', v: true };
        else {
          const w = vanilla?.w || ITEM_NAMES[wid] || wid;
          def = item ? itemDef(item) : { wid, w, n: w, cat: vanilla?.cat || 'rifle', v: true };
        }
        const data = await cs2Play('weapon', wid);
        // Your gloves are baked once for every weapon's arms.
        if (gloves) this.gloveScene ||= buildGloveScene(gloves, itemDef(gloves), this.renderer);
        const vm = await buildViewmodel(item || { t: 'skin', fl: 0, sd: 0 }, def, data, { gloves, gloveScene: gloves ? this.gloveScene : null, renderer: this.renderer });
        this.sounds.add(data.sounds);
        vm.rig.visible = false;
        bindBounds(vm.rig);
        this.vmRigs.add(vm.rig); // (in the scene only while it shows: see syncRigs)
        const name = wid === 'weapon_c4' ? 'C4 Explosive' : NADES[wid] ? NADES[wid].name : def.v ? def.w : `${def.w} | ${def.n?.split(' | ')[1] || def.n}`;
        return { data, vm, name };
      })();
      this.vmCache.set(key, job);
      job.catch((e) => { console.warn('weapon failed', wid, e); this.vmCache.delete(key); });
    }
    return this.vmCache.get(key);
  }
  // The skin you have equipped for a weapon, if any (see vmData).
  ownSkin(wid) {
    if (/knife|bayonet/.test(wid)) return equipped('knife');
    if (wid === 'weapon_c4' || NADES[wid]) return null;
    const vanilla = Object.values(D.skins).find((s) => s.wid === wid);
    return equipped('w:' + (vanilla?.w || ITEM_NAMES[wid] || wid));
  }
  // A fresh gun (full ammo) for one of your slots: with your skin for it, or skin (one you picked up: see gunSkin).
  async myGun(slot, wid, skin) {
    if (skin === undefined) skin = gunSkin(this.ownSkin(wid));
    const { data, vm, name } = await this.vmData(wid, { skin });
    const gun = new Gun({ slot, id: wid, name, stats: data.stats || this.stats[wid] || {}, sounds: data.sounds, vm });
    gun.skin = skin;
    return gun;
  }
  async giveMe(slot, wid, select = true, skin) {
    const gun = await this.myGun(slot, wid, skin);
    if (this.disposed) return;
    this.arsenal.give(slot, gun, this.now, select);
  }
  owns(id) {
    const g = this.arsenal?.guns;
    if (id === 'defuser') return this.me.defuser;
    if (id === 'vest') return this.me.armor >= 100;
    if (id === 'vesthelm') return this.me.armor >= 100 && this.me.helmet;
    return this.buying?.has(id) || g?.primary?.id === id || g?.secondary?.id === id || g?.taser?.id === id;
  }

  // ---- buying -----------------------------------------------------------------------------------------------------
  inBuyZone(c = this.me) {
    if (this.respawnMode || this.cv.mp_buy_anywhere) return true; // Deathmatch (or mp_buy_anywhere): buy anywhere
    const p = this.positionOf(c);
    return (this.map.info.buyzones || []).some((z) => z.team === c.team && p[0] >= z.min[0] && p[0] <= z.max[0] && p[1] >= z.min[1] && p[1] <= z.max[1] && p[2] >= z.min[2] - 64 && p[2] <= z.max[2] + 64);
  }
  buyTimeLeft() { const m = this.match; if (this.respawnMode) return Infinity; return m.phase === 'freeze' ? m.time + m.rules.buyTime : m.rules.buyTime - (m.rules.roundTime - m.time); }
  async buy(id) {
    const m = this.match, me = this.me;
    if (!this.inBuyZone() || this.owns(id) || !m.canBuy(me, id, this.stats)) return;
    // A gun counts as owned while it loads, so a second click doesn't pay for it twice.
    const gun = id.startsWith('weapon_') && !isGrenade(id);
    if (gun) (this.buying ||= new Set()).add(id);
    m.pay(me, id, this.stats);
    this.sounds.play('Player.PickupWeapon', { volume: 0.6 });
    this.buyMenu.render();
    if (this.respawnMode && slotOf(id) === 'primary') this.dmPrimary = id;
    if (this.respawnMode && slotOf(id) === 'secondary') this.dmSecondary = id;
    if (isGrenade(id)) await this.syncMyNades();
    else if (gun) {
      try { await this.giveMe(slotOf(id), id); } finally { this.buying.delete(id); if (this.buyMenu.isOpen) this.buyMenu.render(); }
    }
  }
  // Your grenade slots follow your grenade counts (select: a grenade id to hold now).
  async syncMyNades(select = null) {
    const me = this.me;
    for (const id of NADE_ORDER) {
      const slot = 'g_' + id, n = me.nades[id] || 0;
      if (n > 0 && !this.arsenal.guns[slot]) await this.giveMe(slot, id, id === select);
      else if (n <= 0 && this.arsenal.guns[slot]) this.arsenal.remove(slot, this.now);
      else if (n > 0 && id === select) this.arsenal.select(slot, this.now);
    }
  }
  // Your grenade leaves your hand.
  throwMyNade(id, strength) {
    const eye = this.player.eye(), { fwd } = basis(this.input.pitch, this.input.yaw);
    const tr = this.collision.traceBox(eye, eye.map((v, i) => v + fwd[i] * 16), [-2, -2, -2], [2, 2, 2], FLAG_PLAYER);
    this.nades.throw(this.me, id, tr.endpos, throwVelocity(this.input.pitch, this.input.yaw, strength, this.player.velocity));
  }
  // After a throw: one fewer; keep holding the same kind if you have more, else back to your gun.
  usedNade(id, t) {
    const me = this.me;
    me.nades[id] = Math.max(0, (me.nades[id] || 0) - 1);
    const slot = 'g_' + id;
    if (me.nades[id] > 0) { const g = this.arsenal.guns[slot]; this.arsenal.current = null; this.arsenal.select(slot, t); g.count = me.nades[id]; return; }
    this.arsenal.remove(slot, t); // back to your best gun
  }
  // A bot throws: aim the arc onto the target (full throw, else medium, else a lob). It takes the grenade out and pulls
  // the pin first (botThrowing finishes the throw).
  botThrow(b, id, target, preferHigh = false) {
    const c = b.c;
    if (!(c.nades[id] > 0) || b.pendingThrow) return false;
    const eye = b.eye();
    const yaw = (Math.atan2(target[1] - eye[1], target[0] - eye[0]) * 180) / Math.PI;
    for (const strength of preferHigh ? [1] : [1, 0.5, 0]) {
      const pitch = aimThrowPitch(eye, target, strength, preferHigh);
      if (pitch == null || pitch < -89 || pitch > 89) continue;
      c.nades[id]--;
      b.yaw = yaw; b.pitch = pitch;
      b.pendingThrow = { id, pitch, yaw, strength, at: this.now + 0.55 };
      b.equip(id, { draw: false });
      b.gesture(this.botAssets.clips.pullpin);
      this.sounds.play(NADES[id].pin, { pos: eye, listener: this, volume: 0.5 });
      return true;
    }
    return false;
  }
  // A lineup's throw (utility.js): from where the bot stands, at exactly its aim (plus the bot's error), with its
  // strength, standing or jump-throwing.
  botThrowAim(b, id, { pitch, yaw, strength, jump = false, lineup = null }) {
    const c = b.c;
    if (!(c.nades[id] > 0) || b.pendingThrow) return false;
    c.nades[id]--;
    b.yaw = yaw; b.pitch = pitch;
    b.pendingThrow = { id, pitch, yaw, strength, jump, lineup, at: this.now + 0.55 };
    b.equip(id, { draw: false });
    b.gesture(this.botAssets.clips.pullpin);
    this.sounds.play(NADES[id].pin, { pos: b.eye(), listener: this, volume: 0.5 });
    return true;
  }
  botThrowing(b) {
    const p = b.pendingThrow;
    if (!p) return;
    b.yaw = p.yaw; b.pitch = p.pitch;
    if (!p.released && this.now >= p.at) {
      p.released = true;
      this.specAnim(b, p.strength >= 0.5 ? 'throw' : 'throwUnder');
      b.gesture(p.strength >= 0.5 ? this.botAssets.clips.throw : this.botAssets.clips.lob);
      const eye = b.eye(), { fwd } = basis(p.pitch, p.yaw);
      const tr = this.collision.traceBox(eye, eye.map((v, i) => v + fwd[i] * 16), [-2, -2, -2], [2, 2, 2], FLAG_PLAYER);
      // (A jump-throw leaves the hand as the jump starts: the jump's speed up, and the bot hops.)
      if (p.jump) { b.vel = [0, 0, 301.993]; b.jumped = true; }
      // (A lineup's standing throw: still, exactly as it was worked out.)
      const n = this.nades.throw(b.c, p.id, tr.endpos, throwVelocity(p.pitch, p.yaw, p.strength, p.jump ? [0, 0, 301.993] : p.lineup ? [0, 0, 0] : b.vel));
      if (n && p.lineup) n.lineup = p.lineup;
      this.radio.chatter(b.c, { flash: 'flash', smoke: 'smoke', fire: 'fire', he: 'he' }[NADES[p.id].kind] || 'he');
      p.done = this.now + 0.45;
    } else if (p.released && this.now >= p.done) {
      b.pendingThrow = null;
      this.botSwitch(b, b.brain.bestSlot(), this.now);
    }
  }
  openBuyMenu() {
    if (!this.match?.buyOpen || !this.inBuyZone() || !this.me.alive) return;
    this.input.menu = true;
    this.buyMenu.open();
    this.input.unlock();
  }
// Text chat (Y all, U team): typing takes your keys (the mouse still looks around); Enter sends, Esc closes.
  openChat(teamOnly) {
    this.input.keys.clear(); this.input.buttons = 0;
    this.chatOpen = true;
    this.hud.chatInput(!!teamOnly && !this.ffa, (text) => {
      this.chatOpen = false;
      this.hud.chatInput(null);
      if (text != null && text.trim()) this.say(this.me, text.trim().slice(0, 127), !!teamOnly && !this.ffa);
    });
  }
  // A chat message from someone: team messages only reach their team, and like CS2's competitive the dead only talk
  // among the dead (you see the living's and, while dead yourself, the dead's).
  say(c, text, teamOnly = false) {
    const me = this.me;
    if (teamOnly && c.team !== me.team) return;
    if (!c.alive && c !== me && me.alive && !this.respawnMode) return;
    this.hud.chatLine({ name: c === me ? c.name || 'You' : c.name, team: c.team, text, teamOnly, dead: !c.alive && !this.respawnMode, place: teamOnly ? this.placeOf?.(c) || '' : '' });
  }

  // The console takes your keys and shows the cursor while it's open; the match keeps running.
  toggleConsole(open = !this.console.isOpen) {
    if (open === this.console.isOpen) return;
    if (open) {
      this.closeBuyMenu();
      this.radio?.close();
      this.input.menu = true;
      this.input.keys.clear(); this.input.buttons = 0;
      this.input.unlock();
      this.console.open();
    } else {
      this.console.close();
      this.input.lock().finally(() => { this.input.menu = false; });
    }
  }
  // give <item> (console): a weapon, grenade, armor or kit. Returns false for an unknown item.
  giveItem(id) {
    const me = this.me;
    id = String(id).toLowerCase();
    if (!me.alive) return true;
    if (id === 'item_kevlar' || id === 'vest') { me.armor = 100; return true; }
    if (id === 'item_assaultsuit' || id === 'item_heavyassaultsuit' || id === 'vesthelm') { me.armor = 100; me.helmet = true; return true; }
    if (id === 'item_defuser' || id === 'item_cutters' || id === 'defuser') { me.defuser = true; return true; }
    if (!id.startsWith('weapon_')) id = 'weapon_' + id;
    if (isGrenade(id)) { me.nades[id] = (me.nades[id] || 0) + 1; this.syncMyNades(id); return true; }
    if (!this.stats[id] && !ITEM_NAMES[id]) return false;
    if (/knife|bayonet/.test(id)) return true; // your equipped knife is the one you hold
    this.giveMe(slotOf(id), id).catch(() => {});
    return true;
  }
  setViewmodelFov(fov) { this.vmCamera.fov = vfov(fov); this.vmCamera.updateProjectionMatrix(); }
  // mp_restartgame: a fresh match (scores, money and stats back to the start; the sides stay as they are).
  restartMatch() {
    const m = this.match;
    this.restartAt = null;
    this.enemyKills = 0;
    this.matchOver = false;
    for (const c of this.combatants) {
      Object.assign(c, { kills: 0, deaths: 0, assists: 0, damage: 0, mvps: 0, score: 0, hsKills: 0, points: 0, level: 0, money: this.rules.startMoney, armor: 0, helmet: false, defuser: false, nades: {}, resetWeapons: true, alive: false });
    }
    if (!this.respawnMode) { m.round = 0; m.score = { A: 0, B: 0 }; m.lossStreak = { T: 0, CT: 0 }; m.history = []; }
    this.hud.message('The match restarted', 2500);
    m.startRound();
  }

  closeBuyMenu() {
    if (!this.buyMenu.isOpen) return;
    this.buyMenu.close();
    this.input.lock().finally(() => { this.input.menu = false; });
  }
  // Your binds changed (the console's bind, unbind...): used at once and saved with your settings.
  setBinds(table) {
    this.input.setBinds(table);
    this.settings.onBinds?.(table);
  }
  // A bound command the game runs itself (see Input): the console, the buy menu, chat, the radio, any console command.
  command(c) {
    if (c === 'console') { this.toggleConsole(); return; }
    if (!this.me || this.console.isOpen) return;
    if (c === 'chatAll' || c === 'chatTeam') { if (!this.buyMenu.isOpen) this.openChat(c === 'chatTeam'); return; }
    if (/^radio\d$/.test(c)) { if (this.radio && this.me.alive && !this.buyMenu.isOpen && !this.ffa) this.radio.open(['KeyZ', 'KeyX', 'KeyV'][c[5] - 1]); return; }
    if (c === 'buy') { if (this.me.alive && this.match) { if (this.buyMenu.isOpen) this.closeBuyMenu(); else this.openBuyMenu(); } return; }
    this.console.run(c);
  }
  menuKey(code, down) {
    if (code === 'Backquote' || this.input.is('console', code)) { if (down) this.toggleConsole(true); return true; }
    if (!down) return false;
    if ((this.input.is('chatAll', code) || this.input.is('chatTeam', code)) && this.me && !this.buyMenu.isOpen) { this.openChat(this.input.is('chatTeam', code)); return true; }
    // Radio: Z commands, X reports, V responses; a number picks a line.
    const radioMenu = ['radio1', 'radio2', 'radio3'].findIndex((a) => this.input.is(a, code));
    if (radioMenu >= 0 && this.radio && this.me?.alive && !this.buyMenu.isOpen && !this.ffa) { this.radio.open(['KeyZ', 'KeyX', 'KeyV'][radioMenu]); return true; }
    if (this.radio?.menu) {
      const n = /^Digit(\d)$/.exec(code)?.[1];
      if (n != null) { if (n === '0') this.radio.close(); else this.radio.choose(Number(n)); return true; }
      if (code === 'Escape') { this.radio.close(); return true; }
    }
    if (this.input.is('buy', code) && this.me?.alive && this.match) { if (this.buyMenu.isOpen) this.closeBuyMenu(); else this.openBuyMenu(); return true; }
    if (this.buyMenu.isOpen) {
      if (code === 'Escape') { this.closeBuyMenu(); return true; }
      return this.buyMenu.key(code);
    }
    return false;
  }

  // Your slots for the HUD's weapon list: 1 primary, 2 pistol, 3 knife and Zeus, 4 grenades, 5 the bomb.
  showWeaponList() {
    const a = this.arsenal, cur = a.gun, rows = new Map();
    const SLOT = { primary: 1, secondary: 2, knife: 3, taser: 3, c4: 5 };
    for (const sl of a.order()) {
      const g = a.guns[sl], n = SLOT[sl] ?? 4;
      if (!rows.has(n)) rows.set(n, []);
      rows.get(n).push({ name: ITEM_NAMES[g.id] || (g.name || '').split(' | ')[0] || g.id, icon: iconFor(this.icons, g.id, { gun: g }), active: g === cur });
    }
    this.hud.weaponList([...rows.entries()].sort((x, y) => x[0] - y[0]).map(([slot, items]) => ({ slot, items })));
  }

  // ---- rounds (called by the match) -------------------------------------------------------------------------------
  onRoundStart(round, { halftime, pistol, overtime, respawn }) {
    numberUniforms(this.renderer); // (a shader new since: see uniforms.js)
    if (!respawn) { this.balls?.reset(); this.doors?.reset(); }
    if (respawn) { this.startRespawnMode(); return; }
    // (No full collection here: one stops everything while it goes through the whole heap, 100 ms to 360 ms a round start
    // and the frames after it slow too, where V8's own, marking alongside the game, never held a frame up for long.)
    this.effects.clear();
    this.nades.clear();
    this.drops.clear();
    for (const p of this.pings) { p.sprite.removeFromParent(); p.sprite.material.dispose(); }
    this.pings = [];
    this.flashUntil = 0;
    this.removeBomb();
    this.planting = null; this.defusing = false;
    this.deathCam = null; this.spectating = null;
    // Spawns: everyone gets a different spot on their side (not you while you've left the match).
    for (const side of ['T', 'CT']) {
      const list = this.combatants.filter((c) => c.team === side && !c.away);
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
    this.radio?.close();
    // Each side's buy (save, force, full), then the plans: who throws which lineup goes by who has which grenade.
    const econ = { T: teamEconomy(this, 'T', pistol), CT: teamEconomy(this, 'CT', pistol) };
    this.spots.roundStart();
    for (const b of this.bots) { b.brain.roundStart(null); b.brain.buy(econ[b.c.team]); }
    this.dropRifles(econ);
    this.plans = { T: teamPlan(this, 'T', econ.T), CT: teamPlan(this, 'CT', econ.CT) };
    for (const b of this.bots) b.brain.plan = this.plans[b.c.team];
    this.liveAt = Infinity;
    this.hud.winPanel(null);
    this.hud.message(overtime ? `Overtime ${overtime} · $12,500 each` : halftime ? 'Switching sides' : round === 1 ? 'Match start · Round 1' : `Round ${round}`, 2500);
    this.sounds.stop('voice', 0.2);
    this.sounds.channel('music', `Music.StartRound.${MUSIC}`, { volume: 0.35 * this.musicVolume }, 0.8);
    this.emit('round', round);
  }
  // ---- Deathmatch / Arms Race: everyone respawns where no enemy is close ------------------------------------------------
  startRespawnMode() {
    this.effects.clear(); this.nades.clear(); this.drops.clear(); this.removeBomb();
    this.flashUntil = 0; this.deathCam = null; this.spectating = null;
    this.plans = { T: {}, CT: {} };
    for (const c of this.combatants) { c.alive = false; c.resetWeapons = true; this.respawn(c); }
    this.hud.message(this.armsRace ? 'Arms Race · a new weapon every kill, the knife last' : `Deathmatch${this.ffa ? ' · free for all' : ''} · ${this.minutes} minutes`, 3500);
    this.sounds.channel('music', `Music.StartRound.${MUSIC}`, { volume: 0.35 * this.musicVolume }, 0.8);
    this.emit('round', 1);
  }
  // A spawn point away from enemies: the map's spawns and random spots on the nav mesh, the one furthest from (and
  // out of sight of) everyone hostile.
  spawnPoint(c) {
    const foes = this.combatants.filter((x) => x.alive && this.hostile(c, x)).map((x) => this.positionOf(x));
    const cands = [...this.map.info.spawns.T, ...this.map.info.spawns.CT].map((s) => ({ origin: s.origin, yaw: s.yaw }));
    for (let i = 0; i < 24; i++) { const r = this.nav.randomPoint(); if (r) cands.push({ origin: r.point, yaw: Math.random() * 360 }); }
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 18; i++) {
      const sp = cands[Math.floor(Math.random() * cands.length)];
      const eye = [sp.origin[0], sp.origin[1], sp.origin[2] + 64];
      let near = Infinity, seen = false;
      for (const p of foes) {
        near = Math.min(near, Math.hypot(p[0] - eye[0], p[1] - eye[1]));
        if (!seen && Math.hypot(p[0] - eye[0], p[1] - eye[1]) < 2500) seen = this.lineOfSight(eye, [p[0], p[1], p[2] + 60]);
      }
      const score = Math.min(near, 2500) - (seen ? 2000 : 0) + Math.random() * 100;
      if (score > bestScore) { bestScore = score; best = sp; }
    }
    // Face the open: the direction with the most room.
    const o = best.origin, eye = [o[0], o[1], o[2] + 64];
    let yaw = best.yaw, room = -1;
    for (let a = 0; a < 360; a += 45) { const d = [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180), 0]; const h = this.collision.raycast(eye, d, 1500, FLAG_BULLET); const t = h ? h.t : 1500; if (t > room) { room = t; yaw = a; } }
    return { origin: o.slice(), yaw };
  }
  // The weapons you respawn with in Deathmatch (the last ones you bought).
  dmWeapon(slot) {
    if (slot === 'primary') return this.dmPrimary || (this.team === 'T' ? 'weapon_ak47' : 'weapon_m4a1_silencer');
    return this.dmSecondary || DEFAULT_PISTOL[this.team];
  }
  respawn(c) {
    const sp = this.spawnPoint(c);
    c.alive = true; c.health = 100; c.armor = 100; c.helmet = true; c.defuser = false; c.nades = {};
    c.protectUntil = this.now + PROTECT;
    if (c === this.me) {
      this.deathCam = null; this.spectating = null;
      this.myBody.root.visible = false;
      this.player.teleport(sp.origin);
      this.input.yaw = sp.yaw; this.input.pitch = 0;
      this.prevEye = this.player.eye();
      this.arsenal.aim = [0, 0]; this.arsenal.aimVel = [0, 0]; this.arsenal.view = [0, 0];
      for (const slot of Object.keys(this.arsenal.guns)) this.arsenal.remove(slot, this.now);
      const jobs = [this.giveMe('knife', this.knifeId(c.team), false)];
      if (this.armsRace) jobs.push(this.giveLevel(c));
      else jobs.push(this.giveMe('primary', this.dmWeapon('primary'), false), this.giveMe('secondary', this.dmWeapon('secondary'), false));
      Promise.all(jobs).then(() => { this.arsenal.current = null; this.arsenal.selectBest(this.now); });
    } else {
      const b = this.botOf(c);
      b.weapons = {};
      const knife = c.team === 'T' ? 'weapon_knife_t' : 'weapon_knife';
      b.weapons.knife = botGun(knife, this.stats[knife] || this.stats.weapon_knife);
      if (this.armsRace) this.giveLevel(c);
      else {
        const r = Math.random();
        const primary = r < 0.12 ? 'weapon_awp' : r < 0.55 ? (c.team === 'T' ? 'weapon_ak47' : Math.random() < 0.5 ? 'weapon_m4a1' : 'weapon_m4a1_silencer')
          : ['weapon_ak47', 'weapon_m4a1_silencer', 'weapon_famas', 'weapon_galilar', 'weapon_aug', 'weapon_sg556', 'weapon_mp9', 'weapon_mac10', 'weapon_p90', 'weapon_ump45'][Math.floor(Math.random() * 10)];
        const pistol = Math.random() < 0.3 ? 'weapon_deagle' : DEFAULT_PISTOL[c.team];
        b.weapons.primary = botGun(primary, this.stats[primary]);
        b.weapons.secondary = botGun(pistol, this.stats[pistol]);
        this.sounds.load([this.stats[primary]?.shootSound].filter(Boolean));
      }
      b.spawn(this.onFloor(sp.origin), sp.yaw);
      b.slot = b.weapons.primary ? 'primary' : b.weapons.secondary ? 'secondary' : 'knife';
      b.equip(b.weapons[b.slot].id, { skin: b.weapons[b.slot].skin });
      b.brain.roundStart({});
      b.brain.startDelay = 0;
    }
  }
  // Arms Race: your weapon for your level (the knife at the end).
  async giveLevel(c) {
    const id = ARMS_RACE[Math.min(c.level || 0, ARMS_RACE.length - 1)];
    const slot = /knife/.test(id) ? 'knife' : slotOf(id);
    if (c === this.me) {
      for (const s of ['primary', 'secondary']) if (s !== slot) this.arsenal.remove(s, this.now);
      if (slot !== 'knife') await this.giveMe(slot, id, true); else this.arsenal.select('knife', this.now);
    } else {
      const b = this.botOf(c);
      delete b.weapons.primary; delete b.weapons.secondary;
      if (slot !== 'knife') { b.weapons[slot] = botGun(id, this.stats[id]); this.sounds.load([this.stats[id]?.shootSound].filter(Boolean)); }
      b.slot = slot; if (c.alive) b.equip(b.weapons[slot].id);
    }
  }
  onLevel(c, delta) {
    if (!c.alive) return;
    this.giveLevel(c);
    if (c === this.me) {
      const id = ARMS_RACE[Math.min(c.level, ARMS_RACE.length - 1)];
      this.hud.message(delta > 0 ? `Level ${c.level + 1} / ${ARMS_RACE.length} · ${/knife/.test(id) ? 'Knife: get a knife kill to win' : ITEM_NAMES[id] || id}` : 'Knifed! Back one weapon', 2000);
      this.sounds.play('Player.PickupWeapon', { volume: 0.6 });
    }
  }

  onLive() {
    this.liveAt = this.now;
    if (this.respawnMode) return;
    // Your team's caller says the plan (the other team's isn't heard), else the usual "let's go".
    const plan = this.plans?.[this.me.team];
    if (plan?.call && plan.igl?.alive) this.radio.say(plan.igl, null, plan.call, { force: true });
    else {
      const mate = this.bots.filter((b) => b.c.alive && !this.hostile(this.me, b.c))[0];
      if (mate && Math.random() < 0.6) this.radio.chatter(mate.c, 'roundStart', { force: true });
    }
  }
  // Drops: after buying, a bot with plenty left buys a rifle for a teammate who couldn't afford one (and says so).
  dropRifles(econ) {
    for (const side of ['T', 'CT']) {
      if (econ[side] !== 'full' && econ[side] !== 'force') continue;
      const team = this.bots.filter((b) => b.c.team === side);
      for (const poor of team.filter((b) => !b.weapons.primary)) {
        const rifle = side === 'T' ? 'weapon_ak47' : 'weapon_m4a1', price = this.stats[rifle]?.price || 3000;
        const rich = team.filter((b) => b !== poor && b.weapons.primary && b.c.money >= price + 500).sort((a, b) => b.c.money - a.c.money)[0];
        if (!rich) break;
        rich.c.money -= price;
        this.giveBot(poor, rifle);
        this.radio?.say(rich.c, null, `Dropping you an ${ITEM_NAMES[rifle]}, ${poor.c.name}`, { force: true });
      }
    }
  }
  onHalftime() { for (const b of this.bots) b.setModel(b.c.team); }

  respawnMe(sp, died) {
    const me = this.me;
    this.myBody.root.visible = false;
    this.player.teleport(sp.origin);
    this.input.yaw = sp.yaw; this.input.pitch = 0;
    this.prevEye = this.player.eye();
    this.arsenal.aim = [0, 0]; this.arsenal.aimVel = [0, 0]; this.arsenal.view = [0, 0];
    const jobs = [];
    if (died) {
      this.arsenal.remove('primary', this.now);
      this.arsenal.remove('taser', this.now);
      jobs.push(this.giveMe('secondary', DEFAULT_PISTOL[me.team], false));
      me.armor = 0; me.helmet = false; me.defuser = false; me.nades = {};
    }
    for (const g of Object.values(this.arsenal.guns)) refillAmmo(g);
    this.arsenal.scheduled = []; // a cut-short reload's sounds
    jobs.push(this.syncMyNades());
    const knife = this.knifeId(me.team);
    if (this.arsenal.guns.knife?.id !== knife) jobs.push(this.giveMe('knife', knife, false));
    if (me.hasC4) jobs.push(this.giveMe('c4', 'weapon_c4', false)); else this.arsenal.remove('c4', this.now);
    Promise.all(jobs).then(() => { this.arsenal.current = null; this.arsenal.selectBest(this.now); });
  }

  // The floor under a point (game units): the collision mesh straight down from a step above it, or null. CS2's
  // spawn points float 24-35 units up, and the nav mesh runs a few units above the real floor, so bots stand on this.
  floorAt(p, below = 200) {
    const from = _from; // (bots ask this every tick as they move)
    from[0] = p[0]; from[1] = p[1]; from[2] = p[2] + 18;
    const hit = this.collision.raycast(from, DOWN, below + 18, FLAG_PLAYER);
    return hit ? p[2] + 18 - hit.t : null;
  }
  onFloor(p) { const z = this.floorAt(p); return z == null ? p.slice() : [p[0], p[1], z]; }

  respawnBot(b, sp, died) {
    const c = b.c;
    if (died) {
      b.weapons = {};
      c.armor = 0; c.helmet = false; c.defuser = false; c.nades = {};
    }
    for (const g of Object.values(b.weapons)) refillAmmo(g);
    b.weapons.secondary ||= botGun(DEFAULT_PISTOL[c.team], this.stats[DEFAULT_PISTOL[c.team]]);
    const knife = c.team === 'T' ? 'weapon_knife_t' : 'weapon_knife';
    b.weapons.knife = botGun(knife, this.stats[knife] || this.stats.weapon_knife);
    if (c.hasC4) b.weapons.c4 = botGun('weapon_c4', this.stats.weapon_c4); else delete b.weapons.c4;
    b.spawn(this.onFloor(sp.origin), sp.yaw);
    b.slot = b.weapons.primary ? 'primary' : 'secondary';
    b.equip(b.weapons[b.slot].id, { skin: b.weapons[b.slot].skin }); // (a gun it picked up keeps its skin)
  }
  giveBot(b, id) {
    if (isGrenade(id)) return; // counted in c.nades; bots throw straight from their hand
    const slot = slotOf(id);
    b.weapons[slot] = botGun(id, this.stats[id]);
    this.sounds.load([this.stats[id]?.shootSound].filter(Boolean));
    if (slot === 'primary' || !b.weapons.primary) { b.slot = slot; b.equip(id); }
  }
  botSwitch(b, slot, t) {
    if (!b.weapons[slot]) return;
    b.pendingThrow = null;
    b.slot = slot;
    b.weapons[slot].nextAttack = Math.max(b.weapons[slot].nextAttack, t + 0.5);
    b.equip(b.weapons[slot].id, { skin: b.weapons[slot].skin });
  }

  onRoundEnd(winner, reason, mvp) {
    const site = this.match.bomb?.site || (this.plans?.T?.site && this.match.bomb?.state !== 'carried' ? this.plans.T.site : null);
    if (site) (this.tSiteHistory ||= []).push(site);
    // CS2's win panel, in its words: the title, how the round ended (its round history's), the MVP and what for. It stays
    // up until the next round starts.
    const why = reason === 'elimination' ? (winner === 'CT' ? 'Terrorists eliminated' : 'CTs eliminated')
      : { bomb: 'Bomb detonated', defuse: 'Bomb defused', time: 'Bombing failed' }[reason];
    const k = mvp?.roundKills || 0;
    const award = reason === 'defuse' ? 'MVP for defusing the bomb' : reason === 'bomb' ? 'MVP for planting the bomb'
      : k >= 5 ? 'MVP for an Ace Round' : k === 4 ? 'MVP for most kills (4k)' : k === 3 ? 'MVP for most kills (3k)' : 'MVP';
    this.hud.hideMessage();
    this.hud.winPanel({ team: winner, title: winner === 'CT' ? 'Counter-Terrorists Win' : 'Terrorists Win', why,
      mvp: mvp && { name: mvp.name, avatar: mvp.identity?.avatar || null, reason: award } });
    this.sounds.play(winner === 'CT' ? 'Event.CTWin' : 'Event.TERWin', { volume: 0.9 });
    this.sounds.channel('music', winner === this.me.team ? `Music.WonRound.${MUSIC}` : `Music.LostRound.${MUSIC}`, { volume: 0.4 * this.musicVolume }, 0.4);
    this.planting = null;
    this.emit('roundEnd', { winner, reason });
  }
  onMatchOver(squad) {
    // A couple of the bots say gg.
    const bots = this.combatants.filter((c) => c !== this.me).sort(() => Math.random() - 0.5).slice(0, 2);
    bots.forEach((c, i) => setTimeout(() => { if (!this.disposed) this.say(c, ['gg', 'gg wp', 'ggwp'][Math.floor(Math.random() * 3)]); }, 1200 + i * 900));
    const won = squad === 'A', draw = squad == null;
    this.sounds.channel('music', `Music.MatchEnd.${MUSIC}`, { volume: 0.4 * this.musicVolume }, 0.8);
    this.matchOver = true;
    const lead = this.match.leader;
    const final = this.ffa ? (won ? 'You win' : `${lead?.name || '?'} wins`) + (this.armsRace ? '' : ` · ${lead?.points || 0} points`) : `${this.match.score.A} : ${this.match.score.B}`;
    const me = this.me, rounds = Math.max(1, this.match.round);
    const hs = me.kills ? Math.round(((me.hsKills || 0) / me.kills) * 100) : 0;
    const multi = [3, 4, 5].map((k) => (me.multi?.[k] ? `${me.multi[k]}× ${k === 5 ? 'ACE' : k + 'K'}` : '')).filter(Boolean).join(' · ');
    const stats = [`${me.kills} / ${me.deaths} / ${me.assists} K/D/A`, this.respawnMode ? `${me.points || 0} points` : `${Math.round(me.damage / rounds)} ADR`, `${hs}% headshots`,
      me.shots ? `${Math.round(((me.hits || 0) / me.shots) * 100)}% accuracy` : '', this.respawnMode ? '' : `${me.mvps} MVPs`, multi].filter(Boolean).join(' · ');
    this.reward = this.payReward(won, draw);
    this.hud.winPanel(null); // (the last round's result: the match's takes its place, as in CS2)
    // (Only matchmaking moves a rank: a private match is practice.)
    const ranked = this.ranked;
    this.hud.endScreen(`<h1 class="${draw ? '' : won ? 'win' : 'loss'}">${draw ? 'Draw' : won ? 'Victory' : 'Defeat'}</h1>
      <div class="final">${final}</div><div class="sub">${stats}</div><div class="reward" data-reward>Adding up your reward…</div>
      ${ranked ? '<div class="rank-result" data-rank></div>' : ''}`);
    // What it paid: the money and its parts, the XP and your level (profile.js), CS2's level-up sound with a level up.
    this.reward.then((r) => {
      const el = this.hud.q('[data-reward]');
      if (!el || this.disposed) return;
      el.innerHTML = r?.error ? `<span class="muted">${esc(r.error)}</span>` : matchRewardHtml(r);
      if (r?.levelUps > 0) this.sounds.play('UIPanorama.XP.NewRank', { volume: 0.8 });
    });
    this.rated = !ranked ? Promise.resolve(null) : this.premier ? this.ratePremier(draw ? 'tie' : won ? 'win' : 'loss') : this.rateMatch(draw ? 'tie' : won ? 'win' : 'loss');
    this.hud.scoreboard(true, this.scoreData());
    this.input.unlock();
    this.emit('over', { won, draw });
  }

  // Another tier for the bots (the console's bot_difficulty): each a new rank in it.
  setBotTier(tier) {
    this.botTier = tierOf(tier);
    this.difficulty = TO_DIFFICULTY[this.botTier];
    for (const b of this.bots) { b.c.skill = botSkill(b.c.name, this.botTier); b.c.rating = ratingOfSkill(b.c.skill); b.brain.d = skillParams(b.c.skill); }
  }

  // A finished Premier match moves your CS Rating: shown under the result with its change (or the wins still needed).
  async ratePremier(result) {
    const m = this.match, them = this.combatants.filter((c) => c.squad === 'B');
    const opponent = Math.round(them.reduce((s, c) => s + (c.rating || 0), 0) / Math.max(1, them.length));
    let r;
    try { r = await act('play.premier', { result, roundsFor: Math.min(60, m.score.A), roundsAgainst: Math.min(60, m.score.B), opponent }); } catch (e) { console.warn('premier', e); return null; }
    const el = this.hud.q('[data-rank]');
    if (!el || this.disposed) return r;
    const info = premierInfo(r.premier);
    const title = r.placed ? 'CS Rating revealed' : info.rated ? 'CS Rating' : 'Premier';
    const line = info.rated ? `${ratingHtml(info.rating, { size: 30 })}${r.placed ? '' : ` <b class="${r.delta >= 0 ? 'green' : 'red'}">${r.delta >= 0 ? '+' : ''}${formatRating(r.delta)}</b>`}`
      : `${info.needWins} more Premier win${info.needWins === 1 ? '' : 's'} to get your CS Rating`;
    el.className = 'rank-result premier ' + (r.placed || r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'same');
    el.innerHTML = `<div class="text"><small>${title}</small><span>${line}</span></div>`;
    if (r.placed) this.sounds.play('UIPanorama.XP.NewSkillGroup', { volume: 0.8 });
    this.hud.scoreboard(true, this.scoreData());
    return r;
  }
  // The other team's average rating (what a result is worth): their CS Rating in Premier, else their hidden rating.
  opponentRating() {
    const them = this.combatants.filter((c) => c.squad === 'B');
    const avg = (f) => Math.round(them.reduce((s, c) => s + f(c), 0) / Math.max(1, them.length));
    return this.premier ? avg((c) => c.rating || 0) : avg((c) => mmrOfSkill(c.skill ?? 0.5));
  }

  // A finished competitive (or wingman) match moves that rank (CS:GO's, one for all maps): shown under the result like
  // CS:GO's end of match, with its rank-up (or down) screen when it changes and the placement once you have 10 wins.
  async rateMatch(result) {
    const m = this.match, wingman = this.mode === 'wingman';
    let r;
    try {
      r = await act('play.rank', { mode: wingman ? 'wingman' : 'competitive', result, roundsFor: Math.min(60, m.score.A), roundsAgainst: Math.min(60, m.score.B),
        difficulty: this.difficulty, opponent: this.opponentRating() });
    } catch (e) { console.warn('rank', e); return null; }
    const el = this.hud.q('[data-rank]');
    if (!el || this.disposed) return r;
    const info = rankInfo(r.rank), art = rankArt();
    const big = emblemHtml(rankKey(info), { size: 64, wingman });
    const title = r.change === 'up' ? 'Rank up!' : r.change === 'down' ? 'Rank down' : r.change === 'placed' ? 'Rank revealed' : info.group ? (wingman ? 'Wingman rank' : 'Competitive rank') : 'Unranked';
    const line = r.change === 'up' ? `You've been promoted to <b>${SKILL_GROUPS[r.after - 1]}</b>`
      : r.change === 'down' ? `You've been demoted to <b>${SKILL_GROUPS[r.after - 1]}</b>`
      : r.change === 'placed' ? `Your skill group: <b>${SKILL_GROUPS[r.after - 1]}</b>`
      : info.group ? `<b>${SKILL_GROUPS[info.group - 1]}</b>` : `${info.needWins} more ${wingman ? 'wingman' : 'competitive'} win${info.needWins === 1 ? '' : 's'} to get your rank`;
    const fancy = r.change === 'up' || r.change === 'placed';
    el.className = 'rank-result ' + (r.change || 'same');
    el.innerHTML = `${fancy && art?.halo ? `<img class="halo" src="${art.halo}" alt="">` : ''}${fancy && art?.flag ? `<img class="flag" src="${art.flag}" alt="">` : ''}
      <div class="emblem">${big}</div><div class="text"><small>${title}</small><span>${line}</span></div>`;
    if (r.change) this.sounds.play(r.change === 'down' ? 'UIPanorama.XP.RankDown' : 'UIPanorama.XP.NewSkillGroup', { volume: 0.8 });
    this.hud.scoreboard(true, this.scoreData());
    return r;
  }

  // A finished match is the only thing that pays (online too): the result (a draw pays as a win), your kills of enemies
  // (a teamkill isn't one) and assists, and XP for those and the rounds your team won (see engine/levels.js). Paid against
  // the match's run (see load); an abandoned match never gets here. { error } when it wasn't paid.
  async payReward(won, draw) {
    const me = this.me, m = this.match;
    try {
      return await act('play.reward', { run: await this.started, mode: this.mode, result: draw ? 'draw' : won ? 'win' : 'loss',
        kills: Math.min(400, this.enemyKills || 0), assists: Math.min(400, Math.max(0, me.assists)),
        roundsWon: this.respawnMode ? 0 : Math.min(60, m.score.A), rounds: this.respawnMode ? 0 : Math.min(60, m.round) });
    } catch (e) { console.warn('match reward', e); return { error: e.message || 'No reward for this match' }; }
  }

  // ---- the bomb ---------------------------------------------------------------------------------------------------
  canAttack() { return this.match?.phase !== 'freeze' && this.me.alive && !this.buyMenu.isOpen && !this.defusing; }
  isDefusing(c) { return c === this.me ? this.defusing : this.botOf(c)?.mode === 'defuse'; }

  // You hold fire with the C4 out in a bomb site: plant (3 seconds, standing still).
  playerPlant(holding, t) {
    const m = this.match, feet = this.player.origin;
    const ok = holding && m.canPlant(this.me, feet) && this.player.onGround;
    if (!ok) {
      if (this.planting) { this.planting = null; const c4 = this.arsenal.guns.c4; if (c4) { c4.animEnd = 0; c4.vm.play('idle', { loop: true }); this.c4Screen(c4.vm.rig, 0); } }
      if (holding && m.phase === 'live' && !m.siteAt(feet) && t - (this.siteWarnAt || -9) > 2) {
        this.siteWarnAt = t;
        this.hud.message('You must be at a bomb site to plant the bomb', 2000);
      }
      return;
    }
    if (!this.planting) {
      this.planting = { start: t };
      // The plant clip (kneel, type the code, set it down) for as long as it takes: nothing puts the idle back meanwhile.
      const c4 = this.arsenal.guns.c4;
      if (c4) { c4.animEnd = Infinity; c4.vm.play(c4.vm.has('plant') ? 'plant' : 'idle', { speed: (c4.vm.length('plant') || m.rules.plantTime) / m.rules.plantTime }); this.c4Screen(c4.vm.rig, 1); }
      this.sounds.play('c4.initiate', { volume: 0.7 });
      this.beepKeys = 0;
    }
    const k = (t - this.planting.start) / m.rules.plantTime;
    if (k * 7 > this.beepKeys + 1) { this.beepKeys++; this.sounds.play('c4.keypressquiet', { volume: 0.6 }); this.c4Screen(this.arsenal.guns.c4?.vm.rig, 1 + this.beepKeys); } // (a digit a key)
    if (k >= 1) {
      this.planting = null;
      this.c4Screen(this.arsenal.guns.c4?.vm.rig, 0); // (the next C4 you carry starts blank)
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
    this.radio.chatter(b.c, 'plant', { force: true });
    b.plantStart = t;
    b.vel = [0, 0, 0];
    this.botSwitch(b, 'c4', t);
    b.setMode('plant');
    this.sounds.play('c4.initiate', { pos: b.eye(), listener: this, volume: 0.6 });
  }
  botDefuse(b) {
    if (b.mode === 'defuse') return;
    if (this.match.startDefuse(b.c)) { b.setMode('defuse'); b.vel = [0, 0, 0]; this.radio.chatter(b.c, 'defuse', { force: true }); }
  }
  botCancelObjective(b) { if (b.mode === 'plant' || b.mode === 'defuse') b.setMode('move'); }

  onPlanted(c, bomb, { late = false } = {}) {
    this.placeBomb(bomb.pos, c === this.me ? this.input.yaw : this.botOf(c)?.yaw || 0);
    this.sounds.play('c4.plant', { pos: bomb.pos, listener: this, volume: 0.8 });
    if (late) { bomb.beepAt = this.now + 1; return; } // (after the round: no announcement, no music)
    this.sounds.play('Event.BombPlanted', { volume: 0.9 });
    this.sounds.channel('music', `Music.BombPlanted.${MUSIC}`, { volume: 0.35 * this.musicVolume }, 0.6);
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
      if (dmg >= 1) this.damage(c, dmg, { attacker: null, group: 'chest', armorRatio: 1, weapon: { id: 'planted_c4', name: 'C4' }, explosion: true });
    }
    this.shake = 1;
  }
  onBombDropped(bomb) { this.placeBomb(bomb.pos, 0, false); }
  onBombPickedUp(c) {
    this.removeBomb();
    if (c === this.me) { this.giveMe('c4', 'weapon_c4', false); this.sounds.play('Player.PickupC4', { volume: 0.7 }); this.hud.message('You picked up the bomb', 2000); }
    else this.botOf(c).weapons.c4 = botGun('weapon_c4', this.stats.weapon_c4);
  }
  async placeBomb(pos, yaw, planted = true) {
    this.removeBomb();
    const token = (this.bombToken = {});
    const tpl = await this.bombTemplate;
    if (!tpl?.userData.root || token !== this.bombToken) return;
    const m = cloneSkinned(tpl.userData.root);
    bindBounds(m);
    m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); m.scale.set(1, 1, 1); // drop the inspect framing
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    this.botAssets.light(m);
    this.c4Screen(m, planted ? 8 : 0); // (the code on a planted bomb's screen)
    const g = new THREE.Group();
    g.add(m);
    // Sit it on the ground (the model is centred on its middle).
    m.updateMatrixWorld(true);
    const box = new THREE.Box3();
    m.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
    if (!box.isEmpty()) m.position.y -= box.min.y;
    toGl([pos[0], pos[1], pos[2] + 0.5], g.position);
    g.rotation.y = (yaw * Math.PI) / 180;
    if (planted && this.bombLed) { g.add(this.bombLed); this.bombLed.position.fromArray(BOMB_LED); this.ledAt = -9; }
    this.scene.add(g);
    this.bombModel = g;
  }
  removeBomb() {
    this.bombToken = null; this.bombModel?.removeFromParent(); this.bombModel = null;
    if (this.bombLed && this.bombLed.parent !== this.scene) { this.scene.add(this.bombLed); this.bombLed.position.set(0, -1000, 0); }
  }
  // The LED as the frame's drawn: lit with the last beep (see tick), out between them.
  updateBombLed() {
    const led = this.bombLed;
    if (!led || led.parent === this.scene) return;
    const since = this.now - (this.ledAt ?? -9), k = since < LED_ON ? 1 : Math.max(0, 1 - (since - LED_ON) / LED_FADE);
    led.visible = k > 0;
    for (const s of led.children) s.material.opacity = s.userData.opacity * k;
  }

  // The C4's screen: a frame of its digits sheet, a row a frame (a sixteenth of the sheet): 0 blank, 1 the seven stars,
  // then the code a digit at a time up to 8, 7355608. Its screen mesh gets its own copy of its (12-vertex) geometry and
  // that's moved down the sheet; the material and texture, shared with every other C4, stay as they are.
  c4Screen(root, frame) {
    let o = null;
    root?.traverse((x) => { if (!o && x.isMesh && /c4_screen/.test(x.name + ' ' + (x.parent?.name || ''))) o = x; });
    if (!o?.geometry.attributes.uv) return;
    if (!o.userData.digitsUv) { o.geometry = o.geometry.clone(); o.userData.digitsUv = o.geometry.attributes.uv.array.slice(); }
    const uv = o.geometry.attributes.uv, base = o.userData.digitsUv;
    for (let i = 1; i < base.length; i += 2) uv.array[i] = base[i] + frame / 16;
    uv.needsUpdate = true;
  }

  // ---- the simulation ---------------------------------------------------------------------------------------------
  start() {
    this.last = performance.now();
    this.acc = 0;
    this.paused = false; // (from now on it never stops: Esc opens the menu over it, like CS2's)
    this.setQuiet(false);
    const frame = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(frame);
      if (this.cv.fps_max > 0 && now - this.last < 1000 / this.cv.fps_max - 1) return; // fps_max
      this.frameMs = now - this.last; // (for the frame-time graph: as it was, a stutter not cut short)
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(frame);
  }

  // The mouse let go (Esc): the menu opens over the match, which goes on (CS2 doesn't pause either); taken again, back
  // in. (The buy menu, the console and chat show the cursor too: not the menu.)
  lockChanged(locked) {
    if (locked && !this.quiet) this.sounds?.ctx.resume().catch(() => {});
    if (this.input.menu || this.matchOver) return;
    this.emit('menu', !locked);
  }
  resume() { this.input.lock(); }
  setSensitivity(v) { this.baseSensitivity = v; this.camera.userData.fov = null; }
  // No sound (a match loading behind the menu, or one you've left), or sound again.
  setQuiet(q) {
    this.quiet = !!q;
    if (this.sounds) this.sounds.hold = this.quiet; // (a sound played meanwhile doesn't wake it)
    if (q) this.sounds?.ctx.suspend().catch(() => {}); else this.sounds?.ctx.resume().catch(() => {});
  }
  // Your settings changed in the menu (see play-settings.js matchSettings): used at once.
  applySettings(s, sensitivity) {
    Object.assign(this.settings, { ...s, onBinds: this.settings.onBinds });
    this.hud.setCrosshairStyle(s.crosshair);
    this.vm = { ...VIEWMODEL, ...(s.viewmodel || {}) };
    this.setViewmodelFov(this.vm.fov);
    this.musicVolume = s.musicVolume ?? 1;
    this.voiceVolume = s.voiceVolume ?? 1;
    if (s.keybinds) this.input.setBinds(s.keybinds);
    this.cv.fps_max = s.fpsMax || 0;
    if (!s.netGraph) { this.hud.netGraph(null); this.renderer.info.autoReset = true; }
    this.resize(); // (the render scale, aspect ratio, scaling or resolution may have changed)
    if (sensitivity) this.setSensitivity(sensitivity);
  }

  // ---- leaving and coming back (matchmaking) ----------------------------------------------------------------------
  // You left the match (you can reconnect, see matchmaking.js). It goes on without you, nothing drawn: you're out of the
  // round (your weapons drop, the bomb too) and don't spawn while you're gone. The first time, your team calls a
  // technical timeout: the next freeze time waits for you (CS2's, once a match).
  disconnect() {
    if (this.away) return;
    this.away = this.me.away = true;
    if (this.buyMenu.isOpen) { this.buyMenu.close(); this.input.menu = false; } // (not closeBuyMenu: that takes the mouse again)
    this.input.unlock();
    this.input.releaseAll();
    const me = this.me;
    if (me.alive && !this.respawnMode) {
      this.planting = null; this.defusing = false;
      if (this.match.bomb?.defuser === me) this.match.bomb.defuser = null;
      this.dropOnDeath(me);
      if (me.hasC4) this.match.dropBomb(me, this.player.origin);
      me.alive = false; me.health = 0;
      me.resetWeapons = true;
      this.myBody.root.visible = false;
    }
    this.hud.chatLine({ system: true, text: 'You left the match' });
    if (!this.timeoutUsed && !this.respawnMode && this.match.phase !== 'over') { this.timeoutUsed = true; this.match.techTimeout(TECH_TIMEOUT); }
    this.setQuiet(true);
  }
  // Back in: in freeze time you spawn at once (with a pistol: what you had dropped), else at the next round. A technical
  // timeout waiting for you ends in a few seconds.
  reconnect() {
    if (!this.away) return;
    this.away = this.me.away = false;
    this.setQuiet(false);
    this.hud.chatLine({ system: true, text: 'You reconnected' });
    const m = this.match;
    if (m.timeout) { if (m.timeout.pending) m.timeout = null; else m.timeout.left = Math.min(m.timeout.left, 3); }
    if (m.phase === 'freeze' && !this.me.alive && !this.respawnMode) {
      const me = this.me, spawns = this.map.info.spawns[me.team];
      const mates = this.combatants.filter((c) => c !== me && c.team === me.team && c.alive).map((c) => this.positionOf(c));
      const sp = spawns.slice().sort((a, b) => Math.min(...mates.map((p) => Math.hypot(p[0] - b.origin[0], p[1] - b.origin[1])), 1e9)
        - Math.min(...mates.map((p) => Math.hypot(p[0] - a.origin[0], p[1] - a.origin[1])), 1e9))[0];
      me.alive = true; me.health = 100;
      this.deathCam = null; this.spectating = null;
      this.respawnMe(sp, true);
      me.resetWeapons = false;
    }
  }

  tick() {
    const inp = this.input, m = this.match, me = this.me;
    this.now += TICK;
    if (this.restartAt != null && this.now >= this.restartAt) this.restartMatch();
    this.prevEye = this.player.eye();
    for (const b of this.bots) b.keepPrev();
    for (const n of this.nades.flying) n.prev = n.pos.slice();
    m.tick(TICK);
    // You
    const frozen = m.phase === 'freeze' || !me.alive || this.planting || this.defusing || m.phase === 'over';
    const cmd = (this.cmd ||= {}); // (one, filled in each tick)
    if (frozen) {
      cmd.forward = 0; cmd.side = 0; cmd.yaw = inp.yaw; cmd.pitch = inp.pitch; cmd.jump = false; cmd.jumpPress = false; cmd.duck = inp.held('duck') && me.alive; cmd.walk = false;
      cmd.maxSpeed = this.arsenal.maxSpeed();
    } else {
      cmd.forward = (inp.held('forward') ? 1 : 0) - (inp.held('back') ? 1 : 0);
      cmd.side = (inp.held('right') ? 1 : 0) - (inp.held('left') ? 1 : 0);
      cmd.yaw = inp.yaw; cmd.pitch = inp.pitch; cmd.jump = inp.held('jump'); cmd.jumpPress = inp.notched('jump'); cmd.duck = inp.held('duck'); cmd.walk = inp.held('walk');
      cmd.maxSpeed = this.arsenal.maxSpeed();
    }
    if (me.alive) {
      const wasGround = this.player.onGround;
      if (this.noclip) this.flyNoclip(cmd); else this.player.tick(TICK, cmd);
      if (!this.noclip) this.pushOutOfBalls();
      if (this.player.origin[2] < -3000) this.kill(me, null, { name: 'World' }, false);
      this.fallDamage();
      this.footsteps(wasGround);
      this.arsenal.tick(TICK, this.now, inp);
      // sv_infinite_ammo: 1 keeps the magazine full, 2 the reserve.
      const held = this.arsenal.gun;
      if (this.cv.sv_infinite_ammo && held && !held.melee && !held.nade && held.stats?.clip) {
        if (this.cv.sv_infinite_ammo === 1) held.clip = held.stats.clip; else held.reserve = held.stats.reserve ?? held.reserve;
      }
      if (inp.takePing()) this.ping();
      if (this.arsenal.pressed?.has('drop')) this.dropMine();
      this.useKey();
      const b = m.bomb;
      if (b?.state === 'dropped' && me.team === 'T' && Math.hypot(this.player.origin[0] - b.pos[0], this.player.origin[1] - b.pos[1], this.player.origin[2] - b.pos[2]) < 60) m.pickupBomb(me);
    } else {
      const pressed = inp.takePressed(); inp.takeWheel();
      this.spectateInput(pressed);
    }
    // Bots
    for (const b of this.bots) {
      if (!b.c.alive) continue;
      if (this.cv.bot_stop) { b.vel = [0, 0, 0]; continue; }
      if (this.settings.netGraph === 2) { const ta = performance.now(); b.brain.tick(TICK, this.now); this.parts.ai += performance.now() - ta; } else b.brain.tick(TICK, this.now);
      this.balls.touch(b.pos, b.vel, BOT_HULL.mins, BOT_HULL.maxs);
      this.botThrowing(b);
      const bomb = m.bomb;
      if (bomb?.state === 'dropped' && b.c.team === 'T' && Math.hypot(b.pos[0] - bomb.pos[0], b.pos[1] - bomb.pos[1]) < 50) m.pickupBomb(b.c);
      this.botFootsteps(b);
    }
    this.hurtZones();
    this.nades.tick(TICK);
    this.drops.tick(TICK);
    this.balls.tick(TICK);
    this.doors.tick(TICK, this.now);
    this.input.endTick(); // a mouse wheel notch's +jump (or other + command) lets go
    this.pickups();
    // The planted bomb beeps faster as it gets closer to going off.
    if ((m.phase === 'planted' || (m.phase === 'end' && m.bomb?.state === 'planted')) && this.now >= m.bomb.beepAt) {
      const left = m.rules.bombTime - (this.now - m.bomb.plantedAt);
      this.sounds.play('C4.PlantSound', { pos: m.bomb.pos, listener: this, volume: 0.7 });
      this.ledAt = this.now; // (its light, and the radar's bomb, flash with it)
      this.radar?.beep();
      m.bomb.beepAt = this.now + Math.max(0.1, 0.15 + 0.85 * Math.pow(Math.max(0, left) / m.rules.bombTime, 1.4));
    }
    // Is the sun on you? (lights your weapon)
    if ((this.tickCount = (this.tickCount || 0) + 1) % 8 === 0) {
      this.sunTarget = this.collision.raycast(this.camEye || this.player.eye(), this.world.sunDir, 16000, FLAG_BULLET) ? 0 : 1;
      if (me.alive) this.spotFromMe();
    }
    this.sunVis += ((this.sunTarget ?? 1) - this.sunVis) * 0.2;
    const ear = basis(inp.pitch, inp.yaw);
    this.sounds.setListener(this.camEye || this.player.eye(), ear.fwd);
    this.soundscapes.update(TICK);
  }

  // Walking over a gun picks it up when its slot is free (you and bots).
  pickups() {
    if (!this.drops.list.length) return;
    for (const c of this.combatants) {
      if (!c.alive) continue;
      for (const it of this.drops.near(this.positionOf(c), 40)) {
        if (it.by === c && this.now - it.at < 1.5) continue;
        if (it.id === 'defuser') { if (c.team === 'CT' && !c.defuser && this.drops.take(it)) { c.defuser = true; if (c === this.me) this.sounds.play('Player.PickupWeapon', { volume: 0.6 }); } continue; }
        const slot = slotOf(it.id);
        if (c === this.me ? this.arsenal.guns[slot] : this.botOf(c).weapons[slot]) continue;
        this.pickUp(c, it);
      }
    }
  }
  pickUp(c, it) {
    if (!this.drops.take(it)) return;
    const slot = slotOf(it.id);
    // The gun as it was: its ammo, and its skin (yours, someone else's, or a bot's default: see drops.js).
    if (c === this.me) {
      this.sounds.play('Player.PickupWeapon', { volume: 0.6 });
      this.giveMe(slot, it.id, false, it.skin || null).then(() => { const gun = this.arsenal.guns[slot]; if (gun) { gun.clip = it.clip; gun.reserve = it.reserve; } });
    } else {
      const b = this.botOf(c);
      const gun = botGun(it.id, this.stats[it.id]);
      gun.clip = it.clip; gun.reserve = it.reserve; gun.skin = it.skin || null;
      b.weapons[slot] = gun;
      if (slot === 'primary') { b.slot = 'primary'; b.equip(it.id, { skin: gun.skin }); }
    }
  }
  // G: drop the gun in your hand (or the bomb).
  dropMine() {
    const gun = this.arsenal.gun;
    if (!gun || gun.melee || gun.nade || gun.taser) return;
    const eye = this.player.eye(), { fwd } = basis(this.input.pitch, this.input.yaw);
    const vel = [fwd[0] * 250 + this.player.velocity[0], fwd[1] * 250 + this.player.velocity[1], fwd[2] * 250 + 60];
    if (gun.id === 'weapon_c4') {
      this.match.dropBomb(this.me, this.player.origin);
      this.arsenal.remove('c4', this.now);
      return;
    }
    this.drops.drop(gun, [eye[0], eye[1], eye[2] - 10], vel, this.me);
    this.arsenal.remove(gun.slot, this.now);
  }
  // A dying player drops their best gun (and their defuse kit).
  dropOnDeath(c) {
    if (c.defuser) {
      const p = this.positionOf(c);
      this.drops.drop({ id: 'defuser', clip: 0, reserve: 0 }, [p[0], p[1], p[2] + 30], [(Math.random() - 0.5) * 80, (Math.random() - 0.5) * 80, 60], c);
      c.defuser = false;
    }
    const gun = c === this.me ? this.arsenal.guns.primary || this.arsenal.guns.secondary : this.botOf(c).weapons.primary || this.botOf(c).weapons.secondary;
    if (!gun) return;
    const p = this.positionOf(c);
    this.drops.drop(gun, [p[0], p[1], p[2] + 40], [(Math.random() - 0.5) * 120, (Math.random() - 0.5) * 120, 80], c);
    if (c !== this.me) delete this.botOf(c).weapons[gun.slot === 'secondary' ? 'secondary' : 'primary'];
  }

  // E: defuse the bomb when you're at it and looking at it, or swap for the gun you look at.
  useKey() {
    if (this.input.pressed && this.arsenal.pressed?.has('use') && this.match.phase !== 'planted') {
      const it = this.drops.lookedAt(this.player.eye(), basis(this.input.pitch, this.input.yaw).fwd);
      if (it && it.id !== 'defuser') {
        const slot = slotOf(it.id), cur = this.arsenal.guns[slot];
        if (cur) { const eye = this.player.eye(); this.drops.drop(cur, [eye[0], eye[1], eye[2] - 10], [0, 0, 0], this.me); this.arsenal.remove(slot, this.now); }
        this.pickUp(this.me, it);
        return;
      }
      if (this.doors.use(this.player.eye(), basis(this.input.pitch, this.input.yaw).fwd)) return; // a door you're looking at
    }
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

  // Middle mouse: CS2's ping. A marker where you aim (seen through walls and on the radar) for a few seconds; your
  // bots look there.
  ping() {
    if (this.now - (this.lastPing ?? -9) < 0.8) return;
    this.lastPing = this.now;
    const eye = this.player.eye(), dir = basis(this.input.pitch, this.input.yaw).fwd;
    const hit = this.collision.raycast(eye, dir, 6000, FLAG_BULLET);
    const pos = [0, 1, 2].map((k) => eye[k] + dir[k] * (hit ? hit.t - 4 : 2000));
    if (!this.pingTex) {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d');
      x.beginPath(); x.moveTo(32, 4); x.lineTo(60, 32); x.lineTo(32, 60); x.lineTo(4, 32); x.closePath();
      x.fillStyle = '#ffd23c'; x.fill(); x.lineWidth = 5; x.strokeStyle = 'rgba(0,0,0,.75)'; x.stroke();
      this.pingTex = new THREE.CanvasTexture(c); this.pingTex.colorSpace = THREE.SRGBColorSpace;
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.pingTex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }));
    sprite.scale.setScalar(0.035);
    sprite.renderOrder = 999;
    toGl([pos[0], pos[1], pos[2] + 6], sprite.position);
    this.scene.add(sprite);
    this.pings.push({ pos, until: this.now + 4, sprite });
    if (this.pings.length > 3) { const old = this.pings.shift(); old.sprite.removeFromParent(); old.sprite.material.dispose(); }
    this.sounds.play('UI.PlayerPing', { volume: 0.5 });
    const place = this.placeAt(pos);
    this.hud.chat('You', this.place(), place ? `Pinged ${place.replace(/([a-z])([A-Z])/g, '$1 $2')}` : 'Pinged a spot', this.me.team);
    for (const b of this.bots) if (b.c.alive && !this.hostile(this.me, b.c)) b.brain.obey('spotted', { pos, target: pos, t: this.now });
  }
  updatePings() {
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      if (this.now < p.until) continue;
      p.sprite.removeFromParent(); p.sprite.material.dispose();
      this.pings.splice(i, 1);
    }
  }

  // Your view of enemies for the radar (anyone in front of you with a clear line).
  spotFromMe() {
    const eye = this.player.eye();
    const { fwd } = basis(this.input.pitch, this.input.yaw);
    for (const e of this.enemiesOf(this.me)) {
      const p = this.bodyOf(e).chest;
      const d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
      if ((fwd[0] * (p[0] - eye[0]) + fwd[1] * (p[1] - eye[1]) + fwd[2] * (p[2] - eye[2])) / d > 0.5 && this.canSee(eye, p)) this.spot(e, this.me);
    }
  }

  // Bots are solid: you can't walk through them.
  // Players block each other like CS2's, without pushing: a movement trace (FLAG_PLAYER) also stops at the other living
  // players' hulls (sliding along them, standing on a head), but not at one it already overlaps (it can walk out of it).
  // A trace for some surfaces only (only: ladders) never stops at a player: walking into one isn't a ladder to climb.
  traceBodies(start, end, mins, maxs, flags, self, only) {
    const tr = this.collision.traceBox(start, end, mins, maxs, flags, only);
    if (!(flags & FLAG_PLAYER) || only || !this.combatants || (self === this.me && this.noclip)) return tr;
    const d = _d3;
    for (let k = 0; k < 3; k++) d[k] = end[k] - start[k];
    let best = tr.normal ? tr.fraction : 1, axis = -1, sign = 0;
    for (const c of this.combatants) {
      if (c === self || !c.alive) continue;
      const bot = c === this.me ? null : this.botOf(c), p = bot ? bot.pos : c === this.me ? this.player.origin : null;
      if (!p) continue;
      const top = (bot ? bot.ducked : this.player.ducked) ? 54 : 72;
      // (Their box, the hull's size added, an axis at a time: bots trace through everyone many times a tick.)
      let t0 = -Infinity, t1 = Infinity, ax = -1, sg = 0;
      for (let k = 0; k < 3 && t0 <= t1; k++) {
        const lo = p[k] - maxs[k] - (k < 2 ? 16 : 0), hi = p[k] - mins[k] + (k < 2 ? 16 : top);
        if (Math.abs(d[k]) < 1e-9) { if (start[k] <= lo || start[k] >= hi) t0 = Infinity; continue; }
        let a = (lo - start[k]) / d[k], b = (hi - start[k]) / d[k], s = -1;
        if (a > b) { const x = a; a = b; b = x; s = 1; }
        if (a > t0) { t0 = a; ax = k; sg = s; }
        if (b < t1) t1 = b;
      }
      if (t0 > t1 || t0 < 0 || t0 >= best || ax < 0) continue; // missed, already inside it, or the world is nearer
      best = t0; axis = ax; sign = sg;
    }
    if (axis < 0) return tr;
    const len = Math.hypot(d[0], d[1], d[2]), f = len > 0 ? Math.max(0, best - 0.03125 / len) : 0, normal = [0, 0, 0];
    normal[axis] = sign;
    return { fraction: f, normal, startsolid: false, tri: null, endpos: [start[0] + d[0] * f, start[1] + d[1] * f, start[2] + d[2] * f] };
  }
  // The collision world as one player moves in it (see traceBodies). who: () => the combatant moving.
  bodyWorld(who) {
    const w = Object.create(this.collision);
    w.of = this.collision;
    w.traceBox = (s, e, mins, maxs, flags, only) => this.traceBodies(s, e, mins, maxs, flags, who(), only);
    return w;
  }

  // Walking into the soccer ball kicks it along; where it can't get out of the way (against a wall) it stops you.
  pushOutOfBalls() {
    const pl = this.player, back = this.balls.touch(pl.origin, pl.velocity, pl.hull.mins, pl.hull.maxs);
    if (!back) return;
    const o = pl.origin, l = Math.hypot(...back);
    pl.origin = this.collision.traceBox(o, o.map((p, k) => p + back[k]), pl.hull.mins, pl.hull.maxs, FLAG_PLAYER).endpos;
    const into = (pl.velocity[0] * back[0] + pl.velocity[1] * back[1] + pl.velocity[2] * back[2]) / l;
    if (into < 0) for (let k = 0; k < 3; k++) pl.velocity[k] -= (back[k] / l) * into;
  }

  // The map's trigger_hurt volumes (the drop off Vertigo's building, a pit, an elevator shaft): like CS2's, they hurt
  // the moment you touch one, then every half second, half their damage a second each time. Tested every tick along
  // the way since the last (a fall crosses the thin kill volume under Vertigo in a tick or two).
  hurtZones() {
    const zones = this.map?.info.hurts;
    if (!zones?.length) return;
    for (const c of this.combatants) {
      const p = this.positionOf(c), f = c.hurtFrom;
      const q = f && Math.hypot(p[0] - f[0], p[1] - f[1], p[2] - f[2]) < 200 ? f : p; // not across a respawn
      c.hurtFrom = p;
      if (!c.alive || this.now < (c.hurtAt || 0)) continue;
      const lo = p.map((v, k) => Math.min(v, q[k])), hi = p.map((v, k) => Math.max(v, q[k]));
      const z = zones.find((v) => hi[0] + 16 > v.min[0] && lo[0] - 16 < v.max[0] && hi[1] + 16 > v.min[1] && lo[1] - 16 < v.max[1] && hi[2] + 72 > v.min[2] && lo[2] < v.max[2]);
      if (!z) continue;
      c.hurtAt = this.now + 0.5;
      this.damage(c, z.damage * 0.5, { group: 'leg', explosion: true, weapon: { name: 'World' } }); // like a fall: armor doesn't help
    }
  }

  // CS2's fall damage: landing faster than 580 units/s hurts (armor doesn't help), 1024+ is about 125 damage.
  fallDamage() {
    const v = this.player.landed;
    if (v <= 580 || !this.me.alive) return;
    this.sounds.play('Player.DamageFall', { volume: 0.8 });
    this.damage(this.me, ((v - 580) * 100 / (1024 - 580)) * 1.25, { group: 'leg', explosion: true, weapon: { name: 'World' } });
  }

  footsteps(wasGround) {
    const pl = this.player;
    if (pl.onLadder) {
      // Climbing: a rung every 0.4 seconds while moving.
      if (Math.hypot(...pl.velocity) < 30) return;
      this.stepT = (this.stepT || 0) + TICK;
      if (this.stepT < 0.4) return;
      this.stepT = 0;
      const tr = this.collision.traceBox(pl.origin, pl.origin.map((o, i) => o - pl.ladderNormal[i] * 4), pl.hull.mins, pl.hull.maxs, FLAG_PLAYER);
      const surf = tr.tri >= 0 ? this.collision.surfaces[this.collision.surface[tr.tri]] : 'ladder';
      this.sounds.play(`CT_${/wood/i.test(surf) ? 'Wood_Ladder' : 'Ladder'}.StepLeft`, { volume: 0.6 });
      this.noise(pl.origin, 700, this.me);
      return;
    }
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
  botOf(c) {
    if (this.botByC) return this.botByC.get(c) || null;
    for (const b of this.bots) if (b.c === c) return b;
    return null;
  }
  // Enemies: the other team, or everyone else in free-for-all.
  hostile(a, b) { return !!a && !!b && a !== b && (this.ffa || a.team !== b.team); }
  enemiesOf(c) { return this.combatants.filter((x) => x.alive && this.hostile(c, x)); }
  positionOf(c) { return c === this.me ? this.player.origin.slice() : this.botOf(c).pos.slice(); }
  // Where a combatant's head, chest and feet are (game units).
  bodyOf(c) {
    if (c === this.me) {
      const o = this.player.origin, eye = this.player.eye();
      return { feet: o, eye, head: [eye[0], eye[1], eye[2] + 1], chest: this.chestInto(c, [0, 0, 0]) };
    }
    const b = this.botOf(c);
    const eye = b.eye();
    return { feet: b.pos, eye, head: b.bonePos('head_0') || [eye[0], eye[1], eye[2] + 1], chest: this.chestInto(c, [0, 0, 0]) };
  }
  // Just the chest, into out (a bot looking about for enemies: most are out of range or out of view).
  chestInto(c, out) {
    const b = c === this.me ? null : this.botOf(c), p = b ? b.pos : this.player.origin;
    out[0] = p[0]; out[1] = p[1]; out[2] = p[2] + (b ? (b.ducked ? 36 : 50) : 50 * (this.player.ducked ? 0.75 : 1));
    return out;
  }
  bodies() { return this.combatants.map((c) => ({ c, feet: this.positionOf(c) })); }
  // Seeing someone: a clear line that doesn't pass through a smoke.
  canSee(a, b) { return this.lineOfSight(a, b) && !this.nades.smokeBlocks(a, b); }
  viewDir(c) { return c === this.me ? basis(this.input.pitch, this.input.yaw).fwd : basis(this.botOf(c).pitch, this.botOf(c).yaw).fwd; }
  // Flashbanged: you see white (and hear the ringing); a bot can't see for a while.
  flash(c, secs, by) {
    if (c === this.me) {
      if (secs > (this.flashUntil || 0) - this.now) { this.flashUntil = this.now + secs; this.flashSecs = secs; this.flashCapture = true; }
      this.sounds.play(secs > 3 ? 'Flashbang.Ring.Long' : secs > 1.5 ? 'Flashbang.Ring.Medium' : 'Flashbang.Ring.Short', { volume: 0.5 });
    } else { this.botOf(c)?.brain.flashed(this.now + secs * 0.85); if (secs > 1) this.botOf(c)?.flashed(secs * 0.85); }
  }
  lineOfSight(a, b) { return !this.collision.occluded(a, b, FLAG_BULLET, 2); }
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
  // Would a bot's shot at this target go through a teammate first? (With friendly fire on, bots hold their fire.)
  teammateInLine(b, to) {
    if (!this.ff) return false;
    const eye = b.eye(), d = [to[0] - eye[0], to[1] - eye[1], to[2] - eye[2]], l = Math.hypot(...d);
    const dir = d.map((v) => v / l);
    return this.combatants.some((c) => c.alive && c !== b.c && c.team === b.c.team && this.hitTest(c, eye, dir, l));
  }

  // Gunshots and footsteps alert enemy bots in range.
  noise(pos, loud, source) {
    for (const b of this.bots) if (b.c.alive && (!source || this.hostile(b.c, source))) b.brain.hear(pos, loud, this.now);
  }
  botSound(b, event, volume = 1) { this.sounds.play(event, { pos: b.eye(), listener: this, volume, source: b }); }
  // Where you hear from (your eye, or the camera while dead), and whether a wall is between you and a sound.
  earPos() { return this.camEye || this.player.eye(); }
  soundBlocked(ear, pos) {
    const d = _d3;
    d[0] = pos[0] - ear[0]; d[1] = pos[1] - ear[1]; d[2] = pos[2] + 8 - ear[2];
    const l = Math.hypot(d[0], d[1], d[2]);
    if (l <= 1) return false;
    d[0] /= l; d[1] /= l; d[2] /= l;
    return !!this.collision.raycast(ear, d, l - 16, FLAG_BULLET);
  }

  // A bot fires its gun: CS2's inaccuracy and spread, and recoil it partly controls.
  botShoot(b, gun, t, control) {
    const st = gun.stats;
    b.c.protectUntil = 0;
    gun.clip--;
    gun.nextAttack = t + (st.cycle?.[0] || 0.1);
    gun.lastShot = t;
    const m = gun.zoom > 0 ? 1 : 0;
    const inacc = inaccuracyOf(st, m, { ducked: b.ducked, speed: Math.hypot(b.vel[0], b.vel[1]), airborne: b.airborne, penalty: gun.penalty });
    const pitch = b.pitch + gun.punch[0] * 2 * (1 - control), yaw = b.yaw + gun.punch[1] * 2 * (1 - control);
    const { fwd, right, up } = basis(pitch, yaw);
    const eye = b.eye();
    const r0 = Math.random(), t0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < (st.bullets || 1); i++) {
      const r1 = Math.random(), t1 = Math.random() * Math.PI * 2;
      const x = Math.cos(t0) * r0 * inacc + Math.cos(t1) * r1 * (st.spread?.[m] || 0);
      const y = Math.sin(t0) * r0 * inacc + Math.sin(t1) * r1 * (st.spread?.[m] || 0);
      const d = [fwd[0] + right[0] * x + up[0] * y, fwd[1] + right[1] * x + up[1] * y, fwd[2] + right[2] * x + up[2] * y];
      const l = Math.hypot(...d);
      this.fireBullet(b.c, eye, d.map((v) => v / l), gun, { tracer: i === 0 && Math.random() < 0.5, muzzle: b.muzzle() });
    }
    // Recoil: Source's recoil table drives the punch.
    const tbl = gun.tables[m] || gun.tables[0], k = Math.min(Math.floor(gun.recoilIndex), 63);
    const ang = (tbl[k].angle * Math.PI) / 180;
    gun.punchVel[0] -= Math.cos(ang) * tbl[k].mag * 0.9;
    gun.punchVel[1] -= Math.sin(ang) * tbl[k].mag * 0.9;
    gun.penalty += st.inaccFire?.[m] || 0;
    gun.recoilIndex++;
    if (st.unzoomsAfterShot) gun.zoom = 0; // (the AWP and the Scout: scoped again for the next shot)
    const ev = gun.silenced ? (gun.id === 'weapon_usp_silencer' ? 'Weapon_USP.SilencedShot' : 'Weapon_M4A1.Silenced') : st.shootSound;
    this.sounds.play(ev, { pos: eye, listener: this, volume: 1, source: b });
    this.specAnim(b, 'shoot');
    this.effects.worldFlash(b.muzzle());
    this.noise(eye, gun.silenced ? 900 : 2600, b.c);
  }

  // A bot's knife slash (a backstab from behind).
  botKnife(b, target, gun) {
    this.specAnim(b, 'lightHit');
    const tp = this.positionOf(target), yaw = target === this.me ? this.input.yaw : this.botOf(target).yaw;
    const to = [tp[0] - b.pos[0], tp[1] - b.pos[1]], l = Math.hypot(...to) || 1;
    const backstab = (Math.cos((yaw * Math.PI) / 180) * to[0] + Math.sin((yaw * Math.PI) / 180) * to[1]) / l > 0.5;
    this.sounds.play('Weapon_Knife.Hit', { pos: b.eye(), listener: this, volume: 0.8 });
    this.damage(target, backstab ? 90 : 40, { attacker: b.c, group: 'chest', armorRatio: 1.7, weapon: gun, point: this.bodyOf(target).chest, dir: [to[0] / l, to[1] / l, 0] });
  }

  // One bullet: the nearest enemy hitbox before the wall it hits (friendly fire is off). Bullets go on through walls
  // thin enough for the gun's penetration and the surface (wood easily, metal less, concrete barely), losing damage.
  fireBullet(shooter, origin, dir, gun, { tracer = false, muzzle = null } = {}) {
    const st = gun.stats;
    const range = st.range || 8192;
    let o = origin, travelled = 0, scale = 1, power = gun.taser ? 0 : st.penetration || 1, hit = null, lastT = range;
    // For the kill feed: through a wall, through smoke, a sniper rifle fired without its scope.
    const how = (wallNo, p) => ({
      wallbang: wallNo > 0, smoke: this.nades.volume.active && this.nades.volume.thickness(origin, p) > 6,
      noscope: shooter === this.me && st.zoomLevels > 0 && !gun.zoom,
    });
    if (shooter === this.me) { this.me.shots = (this.me.shots || 0) + 1; this.me.protectUntil = 0; }
    for (let wallNo = 0; wallNo < 4; wallNo++) {
      const wall = this.collision.raycast(o, dir, range - travelled, FLAG_BULLET);
      const maxT = wall ? wall.t : range - travelled;
      for (const c of this.combatants) {
        if (!c.alive || c === shooter || (!this.hostile(shooter, c) && !this.ff)) continue;
        const h = this.hitTest(c, o, dir, hit ? hit.t : maxT);
        if (h) hit = { ...h, c };
      }
      this.balls.shot(o, dir, hit ? hit.t : maxT, Math.min(520, st.damage * scale * 9));
      if (hit) {
        if (shooter === this.me) this.me.hits = (this.me.hits || 0) + 1;
        const p = [0, 1, 2].map((i) => o[i] + dir[i] * hit.t);
        const dmg = st.damage * Math.pow(st.rangeModifier, (travelled + hit.t) / 500) * scale;
        this.damage(hit.c, dmg, { attacker: shooter, group: hit.group, armorRatio: st.armorRatio, headshotMult: st.headshot, point: p, dir, weapon: gun, how: how(wallNo, p) });
        lastT = travelled + hit.t;
        break;
      }
      if (!wall) { lastT = range; break; }
      const p = [0, 1, 2].map((i) => o[i] + dir[i] * wall.t);
      this.effects.impact(p, wall.normal, wall.surface);
      if (this.doors.shot(wall, p, dir)) { travelled += wall.t + 0.5; o = p.map((v, i) => v + dir[i] * 0.5); continue; } // breakable glass: broken, on it goes
      if (wallNo === 0) {
        const ev = [this.impactSound(wall.surface), `${impactName(wall.surface)}.BulletImpact`].find((e) => this.sounds.has(e)) || 'Default.BulletImpact';
        this.sounds.play(ev, { pos: p, listener: this, volume: 0.6 });
        lastT = travelled + wall.t;
      }
      // Through the wall? Find where the bullet comes out by tracing back from the far side.
      const maxThick = 32 * power * (PENETRATION[String(wall.surface).toLowerCase()] ?? PENETRATION.default);
      if (maxThick < 2) break;
      const far = [0, 1, 2].map((i) => p[i] + dir[i] * maxThick);
      const back = this.collision.raycast(far, dir.map((v) => -v), maxThick - 0.5, FLAG_BULLET);
      if (!back) break; // solid all the way
      const thick = maxThick - back.t;
      if (thick >= maxThick) break;
      const exit = [0, 1, 2].map((i) => far[i] - dir[i] * back.t);
      this.effects.impact(exit, back.normal, wall.surface);
      const k = 1 - thick / maxThick;
      scale *= 0.25 + 0.6 * k;
      power *= 0.5 + 0.4 * k;
      travelled += wall.t + thick + 0.5;
      o = exit.map((v, i) => v + dir[i] * 0.5);
    }
    if (this.nades.volume.active) this.nades.volume.carve(origin, dir, Math.min(lastT, range));
    const end = (t) => [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    // Bullets flying past your head crack.
    if (shooter !== this.me && this.me.alive && hit?.c !== this.me) {
      const e = this.player.eye(), w = [e[0] - origin[0], e[1] - origin[1], e[2] - origin[2]];
      const along = w[0] * dir[0] + w[1] * dir[1] + w[2] * dir[2];
      if (along > 0 && along < lastT && Math.hypot(w[0] - dir[0] * along, w[1] - dir[1] * along, w[2] - dir[2] * along) < 60 && Math.random() < 0.5) {
        this.sounds.play('BulletBy.Supersonic.Crack', { volume: 0.5 });
      }
    }
    if (tracer) this.effects.tracer(muzzle || (shooter === this.me && this.myMuzzle(gun)) || [origin[0] + dir[0] * 40, origin[1] + dir[1] * 40, origin[2] + dir[2] * 40 - 4], end(Math.min(lastT, range)));
    if (shooter === this.me) {
      if (gun.vm.muzzle) this.effects.muzzleFlash(gun.vm.muzzle.getWorldPosition(new THREE.Vector3()));
      else this.effects.muzzleFlash(new THREE.Vector3(0.09, -0.06, -0.55).applyQuaternion(this.camera.quaternion));
    }
  }

  // Where your gun's muzzle shows on screen, as a point in the world a little in front of you (the viewmodel is drawn in
  // a scene of its own, with its own field of view): your tracers come out of the barrel there.
  myMuzzle(gun) {
    const m = gun?.vm?.muzzle;
    if (!m) return null;
    m.updateWorldMatrix(true, false);
    const ndc = m.getWorldPosition(_v3).project(this.vmCamera);
    const cam = this.camera.position, dir = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(cam).normalize();
    return fromGl(cam.clone().addScaledVector(dir, 24 * IN));
  }

  // Knife reach: the nearest enemy in front within range (a backstab if hitting from behind), else a wall.
  meleeTrace(range) {
    const eye = this.player.eye();
    const { fwd, right, up } = basis(this.input.pitch, this.input.yaw);
    let best = null;
    for (const c of this.ff ? this.combatants.filter((x) => x.alive && x !== this.me) : this.enemiesOf(this.me)) {
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
    if (this.balls.shot(eye, fwd, wall ? wall.t : range + 8, 380)) return { ball: true };
    if (wall) {
      const p = [0, 1, 2].map((i) => eye[i] + fwd[i] * wall.t);
      if (this.doors.shot(wall, p, fwd)) return { wall, broke: true }; // a breakable: the knife breaks it too
      this.effects.impact(p, wall.normal, wall.surface);
      return { wall };
    }
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
  // how: what the kill feed shows about a bullet that kills ({ wallbang, smoke, noscope }).
  damage(c, dmg, { attacker = null, group = 'chest', armorRatio = 1, headshotMult = 4, point = null, dir = null, weapon = null, explosion = false, how = {} } = {}) {
    if (!c.alive) return;
    // Teammates: no damage without friendly fire; with it, CS2's reductions (bullets a third, grenades 85%, fire 40%).
    if (c.protectUntil > this.now && attacker && attacker !== c) return; // just respawned
    if (c === this.me && this.god) return;
    if (attacker && attacker !== c && !this.hostile(attacker, c)) {
      if (!this.ff) return;
      dmg *= /molotov|incgrenade/.test(weapon?.id || '') ? 0.4 : explosion ? 0.85 : 0.33;
    }
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
      if (c.health > 0) { this.botOf(c)?.flinch(group); if (attacker && attacker.team !== c.team && Math.random() < 0.3) this.radio.chatter(c, 'hurt'); }
      if (attacker === this.me && c.health > 0) this.sounds.play(head ? (armored ? 'Player.DamageHeadShotArmor.AttackerFeedback' : 'Player.DamageHeadShot.AttackerFeedback') : armored ? 'Player.DamageBodyArmor.AttackerFeedback' : 'Player.DamageBody.AttackerFeedback', { volume: 0.7 });
    }
    if (c.health <= 0) {
      if (weapon?.taser) this.sounds.play('Player.DeathTaser', { pos: this.bodyOf(c).chest, listener: this, volume: 0.8 });
      if (attacker === this.me) this.sounds.play(head ? (armored ? 'Player.DeathHeadShotArmor.AttackerFeedback' : 'Player.DeathHeadShot.AttackerFeedback') : armored ? 'Player.DeathBodyArmor.AttackerFeedback' : 'Player.DeathBody.AttackerFeedback', { volume: 0.8 });
      this.kill(c, attacker, weapon, head, how);
    }
  }

  // Whether someone is off the ground (jumping or falling) or blinded by a flashbang, for the kill feed.
  inAir(c) { return c === this.me ? !this.player.onGround && !this.player.onLadder : !!this.botOf(c)?.airborne; }
  isBlind(c) { return c === this.me ? (this.flashUntil || 0) - this.now > 0.5 : (this.botOf(c)?.brain.blindUntil || 0) > this.now; }

  kill(c, attacker, weapon, headshot, how = {}) {
    if (!c.alive) return;
    if (!this.respawnMode) this.dropOnDeath(c);
    c.alive = false;
    c.health = 0;
    this.match.onKill(c, attacker, weapon?.stats || weapon, { headshot });
    if (attacker === this.me && c !== this.me && (this.ffa || c.team !== this.me.team)) { this.enemyKills = (this.enemyKills || 0) + 1; this.countStatTrak(weapon); }
    if (!this.ffa) this.killChatter(c, attacker);
    if (!this.respawnMode && attacker && attacker !== c && attacker.team !== c.team) {
      const at = this.positionOf(c);
      for (const b of this.bots) if (b.c.alive && b.c !== c && b.c.team === c.team && Math.hypot(b.pos[0] - at[0], b.pos[1] - at[1]) < 1000) b.brain.traded(attacker, at, this.now);
      if (attacker.team === 'T' && this.plans?.T) this.plans.T.pick = true;
    }
    const wname = weapon?.id ? (ITEM_NAMES[weapon.id] || (weapon.name || '').split(' | ')[0]) : weapon?.name || 'World';
    const by = attacker && attacker !== c;
    this.hud.kill({
      killer: attacker?.name || '', victim: c.name, weapon: wname, icon: iconFor(this.icons, weapon?.id, { gun: weapon, kill: true }), mine: attacker === this.me || c === this.me, killerTeam: attacker?.team, victimTeam: c.team,
      headshot, ...how, air: by && this.inAir(attacker), blind: by && this.isBlind(attacker),
    });
    if (c === this.me) {
      this.planting = null; this.defusing = false;
      this.closeBuyMenu();
      this.sounds.play(headshot ? 'Player.DeathHeadShot.Victim' : 'Player.DeathBody.Victim', { volume: 0.8 });
      // Your body falls where you stood (your gun on the floor by it); the death cam pulls up and back from it to watch
      // your killer.
      const body = this.myBody;
      body.spawn(this.player.origin, this.input.yaw);
      body.setMode('dead', { headshot });
      body.deadAt = this.now;
      const eye = this.player.eye(), { fwd } = basis(0, this.input.yaw), back = [-fwd[0] * 0.8, -fwd[1] * 0.8, 0.6], bl = Math.hypot(...back);
      const hit = this.collision.raycast(eye, back.map((v) => v / bl), 48, FLAG_BULLET);
      const from = [0, 1, 2].map((k) => eye[k] + (back[k] / bl) * (hit ? Math.max(0, hit.t - 6) : 48));
      this.deathCam = { until: this.now + (this.respawnMode ? 60 : 2.5), killer: attacker, from };
    } else {
      const b = this.botOf(c);
      b.setMode('dead', { headshot });
      b.deadAt = this.now;
      b.vel = [0, 0, 0];
    }
  }

  // A kill with your own StatTrak™ gun or knife counts on its counter: saved on the item and shown on the weapon. With
  // a gun of someone else's (picked up), it doesn't, as in CS2; nor does a bot's kill with yours.
  async countStatTrak(gun) {
    if (!gun?.id || NADES[gun.id] || gun.skin?.owner !== LOCAL) return;
    const item = S.inv.find((i) => i.uid === gun.skin.item.uid);
    if (!item?.stt) return;
    try {
      const { kills } = await act('play.stattrak', { uid: item.uid });
      gun.skin.item.kills = kills;
      gun.vm?.model.userData.statTrak?.set(kills);
    } catch (e) { console.warn('StatTrak count', e); }
  }

  // Your teammates call out kills and how many enemies are left.
  killChatter(c, attacker) {
    const mates = this.bots.filter((b) => b.c.alive && b.c.team === this.me.team);
    if (!mates.length || this.match.phase === 'end') return;
    if (attacker?.bot && attacker.team === this.me.team && attacker.team !== c.team) this.radio.chatter(attacker, 'kill');
    else if (attacker === this.me && c.team !== this.me.team && Math.random() < 0.3) this.radio.chatter(mates[0].c, 'niceShot');
    const left = this.combatants.filter((x) => x.alive && x.team !== this.me.team).length;
    if (c.team !== this.me.team && (left === 1 || left === 2)) setTimeout(() => !this.disposed && this.radio.chatter(mates[mates.length - 1].c, left === 1 ? 'oneLeft' : 'twoLeft', { force: true }), 900);
  }
  // A combatant's callout area.
  placeOf(c) { return this.placeAt(this.positionOf(c)); }

  // ---- spectating ---------------------------------------------------------------------------------------------------
  spectateInput(pressed) {
    if (this.input.takeClicked() & 1 || !this.spectating?.c.alive) this.nextSpectate();
    if (pressed?.has('jump')) this.specThird = !this.specThird;
  }
  // First-person spectating: the bot's own body is hidden and its gun shows as a viewmodel (the default look, or the skin
  // of a gun it picked up), drawing, shooting, reloading and throwing with it.
  updateSpecView(dt) {
    const s = !this.me.alive && !this.specThird && !(this.deathCam && this.now < this.deathCam.until) && this.spectating?.c.alive ? this.spectating : null;
    const show = (b, on) => { b.model.visible = on; if (b.weaponModel) b.weaponModel.visible = on; };
    if (this.specHidden && this.specHidden !== s) { show(this.specHidden, true); this.specHidden = null; }
    if (s) { show(s, false); this.specHidden = s; }
    const wid = s?.holding, skin = s?.holdingSkin || null; // (its gun's skin: one it picked up, else the default)
    if (this.specVm && (this.specVm.bot !== s || this.specVm.wid !== wid || this.specVm.skin !== skin)) {
      if (this.specVm.vm !== this.arsenal.gun?.vm) this.specVm.vm.rig.visible = false; // (it may be your own gun's: see vmData)
      this.specVm = null;
    }
    const key = s && wid ? s.c.name + '|' + wid + '|' + (skin?.item.uid || '') : null;
    if (key && !this.specVm && this.specLoading !== key) {
      this.specLoading = key;
      this.vmData(wid, { plain: true, skin }).then(({ vm }) => {
        if (this.specLoading !== key) return;
        this.specLoading = null;
        if (this.spectating !== s || s.holding !== wid || (s.holdingSkin || null) !== skin || this.disposed) return;
        const draw = vm.has('draw') ? vm.play('draw') : (vm.play('idle', { loop: true }), 0);
        this.specVm = { bot: s, wid, skin, vm, animEnd: this.now + draw };
      }).catch(() => { if (this.specLoading === key) this.specLoading = null; });
    }
    const v = this.specVm;
    if (!v) return;
    v.vm.rig.visible = true;
    if (v.vm.role !== 'idle' && this.now >= v.animEnd && v.vm.has('idle')) v.vm.play('idle', { loop: true, fade: 0.12 });
    v.vm.update(this.paused ? 0 : dt);
    v.vm.rig.position.set(this.vm.x * IN, this.vm.z * IN, -this.vm.y * IN);
  }
  // The spectated bot's gun animating: a shot, a reload (over secs), a throw, a knife swing.
  specAnim(b, role, secs = 0) {
    const v = this.specVm;
    if (!v || v.bot !== b || !v.vm.has(role)) return;
    v.animEnd = this.now + v.vm.play(role, { fade: 0.03, speed: secs ? v.vm.length(role) / secs : 1 });
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
    dt *= this.cv.host_timescale || 1;
    const t0 = performance.now();
    const log = this.settings.netGraph === 2 ? this.startLog() : null;
    log?.begin(t0);
    const parts = (this.parts ||= { ai: 0, draw: 0, bots: 0, hud: 0 }); // (where the frame goes: net_graph 2; the HUD's is last frame's)
    parts.ai = 0; parts.draw = 0; parts.bots = 0;
    let steps = 0;
    if (!this.paused) {
      this.acc += dt;
      while (this.acc >= TICK && steps < 8) { this.tick(); this.acc -= TICK; steps++; }
      if (steps === 8) this.acc = 0;
    }
    const t1 = performance.now();
    const me = this.me, gun = this.arsenal.gun;
    // How far the frame is between the last tick and the next: what moves at the tick rate is drawn that far along.
    const a = this.paused ? 1 : this.acc / TICK;
    // Camera: your eyes (interpolated, with recoil punch), the death cam, or a teammate you spectate.
    let camEye;
    if (me.alive) {
      const eye = this.player.eye();
      const p = this.prevEye;
      camEye = [p[0] + (eye[0] - p[0]) * a, p[1] + (eye[1] - p[1]) * a, p[2] + (eye[2] - p[2]) * a];
      const [pitch, yaw] = this.arsenal.viewAngles(this.input.pitch, this.input.yaw);
      this.camera.rotation.set((-pitch * Math.PI) / 180, (yaw * Math.PI) / 180 + Math.PI, 0);
    } else if (this.deathCam && this.now < this.deathCam.until) {
      camEye = this.deathCam.from;
      const k = this.deathCam.killer;
      if (k?.alive) this.lookAt(camEye, this.bodyOf(k).head, 4 * dt);
    } else {
      if (!this.spectating?.c.alive) this.nextSpectate();
      const s = this.spectating;
      if (s && !this.specThird) {
        // First person (CS2's default): from the bot's eyes, turning with its aim (smoothed a little).
        const [eye, pitch, yaw] = s.eyeAt(a);
        camEye = eye;
        const q = _q.setFromEuler(_euler.set((-pitch * Math.PI) / 180, (yaw * Math.PI) / 180 + Math.PI, 0, 'YXZ'));
        this.camera.quaternion.slerp(q, Math.min(1, 20 * dt));
      } else if (s) {
        const [eye] = s.eyeAt(a), { fwd } = basis(Math.max(-20, Math.min(40, s.pitch)), s.yaw);
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
    for (const slot in this.arsenal.guns) { const g = this.arsenal.guns[slot]; g.vm.rig.visible = me.alive && g === gun && !(gun.zoom && gun.stats.hideViewmodelZoomed) && !this.defusing; }
    if (gun && me.alive) {
      gun.vm.update(this.paused ? 0 : dt);
      const sp = this.player.onGround ? Math.min(1, this.player.speed2d() / 250) : 0;
      this.bob = (this.bob || 0) + dt * (6 + 4 * sp) * (sp > 0.05 ? 1 : 0);
      gun.vm.rig.position.set((this.vm.x + Math.cos(this.bob) * 0.25 * sp) * IN, (this.vm.z - Math.abs(Math.sin(this.bob)) * 0.35 * sp) * IN, -this.vm.y * IN);
    }
    this.updateSpecView(dt);
    this.syncRigs();
    this.vmRoot.quaternion.copy(this.camera.quaternion);
    this.vmCamera.quaternion.copy(this.camera.quaternion);
    this.frameNo = (this.frameNo || 0) + 1;
    const probes = this.world.probes;
    // A bot out of view isn't drawn and animates a third as often (its hitboxes stay current enough: a bullet syncs it).
    this.camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m4.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const tb = performance.now();
    for (let i = 0; i <= this.bots.length; i++) {
      const b = i < this.bots.length ? this.bots[i] : this.myBody; // (the bots, then your own body)
      // A body lies there a while, then sinks into the floor and is gone (nine in view cost a quarter of a frame).
      const gone = b.deadAt != null ? (this.now - b.deadAt - BODY_STAY) / BODY_SINK : -1;
      if (gone >= 1) b.root.visible = false;
      if (!b.root.visible) { b.frozen = true; continue; } // (a hidden body skips the matrix pass too)
      b.sync(a);
      if (gone > 0) b.root.position.y -= gone * 40 * IN;
      _feet[0] = b.pos[0]; _feet[1] = b.pos[1]; _feet[2] = b.pos[2] + 36;
      const seen = _frustum.intersectsSphere(_sphere.set(toGl(_feet, _v3), 60 * IN));
      // Posed this frame (animated, its bones worked out and sent to the GPU): in view, and a body that's done falling
      // only once (it lies still until it sinks), a bot far off every other frame (a frame behind there is a fraction of
      // a pixel). Out of view its ~100 bones skip the frame's matrix pass (see Bot): a shot, its muzzle or a head bone
      // works them out when needed.
      const resting = b.deadAt != null && b.time > b.deathEnd + 0.3 && gone <= 0;
      if (!resting) b.posedAtRest = false;
      const far = Math.hypot(b.pos[0] - camEye[0], b.pos[1] - camEye[1], b.pos[2] - camEye[2]) > FAR_BOT;
      const pose = seen && !(resting && b.posedAtRest) && (!far || !b.wasSeen || (this.frameNo + b.index) % 2 === 0);
      if (pose && resting) b.posedAtRest = true;
      b.wasSeen = seen;
      b.view.visible = seen;
      b.frozen = !pose; // (left out of the matrix pass, its skeleton not worked out: see Bot)
      b.animDt = (b.animDt || 0) + (this.paused ? 0 : dt);
      if (pose || (!seen && (this.frameNo + b.index) % 3 === 0)) { b.animate(b.animDt); b.animDt = 0; }
      // Lit by the probes where it stands (a few times a second is plenty).
      if (probes && (this.frameNo + b.index) % 6 === 0) { _feet[0] = b.pos[0]; _feet[1] = b.pos[1]; _feet[2] = b.pos[2] + 36; b.amb.set(probes, _feet); }
    }
    this.parts.bots = performance.now() - tb;
    if (probes && this.frameNo % 3 === 0) {
      const c = probes.cube(camEye, this.vmCube), PI = Math.PI;
      this.vmHemi.color.setRGB(c[6] * PI, c[7] * PI, c[8] * PI);
      this.vmHemi.groundColor.setRGB(c[15] * PI, c[16] * PI, c[17] * PI);
      // The sky's reflections dim indoors with the light. Metal (a blade, the Molotov's lighter) only shows what it
      // reflects, so they're strong enough for it to read as metal, not black.
      const lum = (c[6] + c[7] + c[8]) / 3;
      this.vmScene.environmentIntensity = 0.5 * Math.min(1, Math.max(0.15, lum / 0.45));
    }
    this.balls.update(this.paused ? 1 : this.acc / TICK, probes);
    this.updatePings();
    this.effects.update(dt);
    this.nades.update(dt, a);
    this.updateBombLed();
    this.vmSun.intensity = this.world.sun.intensity * this.sunVis;
    if (this.away) { this.emit('frame', dt); return; } // (left the match: it goes on, nothing drawn)

    // The world (with the smokes and the flashbang's afterimage), then your weapon on top.
    const flashLeft = (this.flashUntil || 0) - this.now;
    this.renderer.clear();
    // The 3D skybox's camera: looking the same way, from where you are scaled down into the skybox.
    const s3 = this.world.sky3d;
    if (s3) {
      const c = s3.camera;
      c.fov = this.camera.fov; c.aspect = this.camera.aspect; c.near = 0.01; c.far = 4000;
      this.camera.getWorldQuaternion(c.quaternion);
      this.camera.getWorldPosition(c.position).sub(s3.offset).divideScalar(s3.scale).add(s3.origin);
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
    }
    const td = performance.now();
    log?.gpuBegin();
    Bot.drawing = true;
    try {
      // (Its options in one object, filled in each frame.)
      const o = (this.drawOpts ||= { overlayOf: { scene: this.vmScene, camera: this.vmCamera } });
      o.camPos = camEye; o.captureFlash = this.flashCapture; o.dt = this.paused ? 0 : dt; o.sky3d = s3;
      o.flashImage = me.alive && flashLeft > 0 ? Math.min(1, flashLeft / Math.max(0.6, this.flashSecs * 0.85)) * 0.9 : 0;
      o.overlay = (me.alive || this.specVm) && this.cv.r_drawviewmodel ? o.overlayOf : null;
      this.post.render(this.scene, this.camera, o);
    } finally { Bot.drawing = false; }
    log?.gpuEnd();
    this.flashCapture = false;
    this.parts.draw += performance.now() - td;

    this.fps = this.fps ? this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 60;
    if (this.settings.netGraph) this.graphFrame(dt, t0, t1);
    this.hud.frameGraph(this.settings.netGraph || this.settings.showFps === 2 ? this.frameMs ?? dt * 1000 : null);
    const th = performance.now();
    this.updateHud(dt);
    this.parts.hud = performance.now() - th; // (net_graph 2 shows it next frame)
    log?.frame(t0, t1, steps);
    this.emit('frame', dt);
  }

  // net_graph 2's log of the match (framelog.js), from the first frame it's on.
  startLog() { return (this.log ||= new FrameLog(this)); }

  // Only the viewmodels that show are in the scene: three updates every bone of everything in it each frame, hidden or
  // not, and the twenty or so loaded weapons' arms and guns cost a third of a frame.
  syncRigs() {
    for (const r of this.vmRigs) {
      const inScene = r.parent === this.vmRoot;
      if (r.visible && !inScene) this.vmRoot.add(r);
      else if (!r.visible && inScene) this.vmRoot.remove(r);
    }
  }

  // net_graph: the frame rate and frame time, how much of a frame the simulation and the drawing took (averaged), and
  // what was drawn. (Draws are counted over the whole frame: three counts each render call on its own.) net_graph 2
  // also splits the frame (the bots' AI, the bodies' animation and drawing, the scene's drawing, the HUD) and shows what
  // the match holds (bodies shown, guns on the floor, textures, geometries, the JS heap): what grows when it slows.
  graphFrame(dt, t0, t1) {
    const t2 = performance.now(), info = this.renderer.info, k = 0.05, gr = this.graph || (this.graph = { ms: 16, sim: 0, cpu: 0, calls: 0, tris: 0, ai: 0, bots: 0, draw: 0, hud: 0 });
    gr.ms += (dt * 1000 - gr.ms) * k; gr.sim += (t1 - t0 - gr.sim) * k; gr.cpu += (t2 - t0 - gr.cpu) * k;
    for (const p of PARTS) gr[p] += (this.parts[p] - gr[p]) * k;
    gr.calls = info.render.calls; gr.tris = info.render.triangles;
    info.autoReset = false; info.reset();
    if ((this.graphAt = (this.graphAt || 0) - dt) > 0) return;
    this.graphAt = 0.25;
    let text = `${Math.round(1000 / gr.ms)} fps · ${gr.ms.toFixed(1)} ms · cpu ${gr.cpu.toFixed(1)} ms (sim ${gr.sim.toFixed(1)}) · ${gr.calls} draws · ${(gr.tris / 1e6).toFixed(1)}M tris`;
    if (this.settings.netGraph === 2) {
      const bodies = this.bots.filter((b) => b.root.visible).length, heap = performance.memory ? ` · heap ${Math.round(performance.memory.usedJSHeapSize / 1e6)} MB` : '';
      text += `\nai ${gr.ai.toFixed(1)} · bodies ${gr.bots.toFixed(1)} · draw ${gr.draw.toFixed(1)} · hud ${gr.hud.toFixed(1)} ms · round ${this.match.round}`
        + `\n${bodies} bodies shown · ${this.drops.list.length} guns down · ${info.memory.textures} tex · ${info.memory.geometries} geo${heap}`;
    }
    this.hud.netGraph(text);
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
    // (Every frame: the teams counted in one go, and what's built for the HUD built only when it changed.)
    let ctSquad, tSquad, aliveCT = 0, aliveT = 0, totalCT = 0, totalT = 0;
    for (const c of this.combatants) {
      if (c.team === 'CT') { if (ctSquad === undefined) ctSquad = c.squad; totalCT++; if (c.alive) aliveCT++; }
      else if (c.team === 'T') { if (tSquad === undefined) tSquad = c.squad; totalT++; if (c.alive) aliveT++; }
    }
    if (this.respawnMode) {
      // Deathmatch / Arms Race: your points (or level) against the leader's.
      const lead = this.combatants.slice().sort((a, b) => m.rank(b) - m.rank(a))[0];
      const val = (c) => (this.armsRace ? `level ${Math.min(c.level, ARMS_RACE.length - 1) + 1}/${ARMS_RACE.length}` : `${c.points || 0} pts`);
      hud.mode(this.ffa ? `You ${val(me)} · Leader: ${lead === me ? 'you' : lead.name} ${val(lead)}` : `${MODES[this.mode].name} · kills per team`);
    } else if (m.timeout && m.phase === 'freeze') hud.mode(`Technical timeout · ${this.away ? 'waiting for you to reconnect' : 'resuming'}`);
    else hud.mode(this.mode === 'wingman' ? 'Wingman' : '');
    // (Everyone's picture by the clock: the list made again only when someone lives or dies, joins or changes sides.)
    let rosterKey = this.combatants.length;
    for (const c of this.combatants) rosterKey = (rosterKey * 4 + (c.alive ? 2 : 0) + (c.team === 'CT' ? 1 : 0)) % 2147483647;
    if (!this.ffa && rosterKey !== this.rosterKey) {
      this.rosterKey = rosterKey;
      this.roster = this.combatants.map((c) => ({ team: c.team, alive: c.alive, avatar: c.identity?.avatar || null, name: c.name, me: c === me }));
    }
    const top = (this.topData ||= {});
    top.ffa = this.ffa; top.ct = m.score[ctSquad] ?? 0; top.t = m.score[tSquad] ?? 0;
    top.aliveCT = aliveCT; top.aliveT = aliveT; top.totalCT = totalCT; top.totalT = totalT;
    top.clock = m.phase === 'end' ? 0 : m.timeout && m.phase === 'freeze' ? m.timeout.left : m.time; top.planted = m.phase === 'planted'; top.phase = m.phase;
    top.roster = this.ffa ? null : this.roster; top.rosterKey = rosterKey;
    hud.top(top);
    const s = this.spectating && !me.alive ? this.spectating.c : me;
    hud.vitals(s.health, s.armor, s.helmet);
    const mo = (this.moneyOpts ||= {});
    mo.buyzone = me.alive && m.buyOpen && this.inBuyZone() && !this.armsRace; mo.c4 = me.hasC4; mo.kit = me.defuser;
    hud.money(this.respawnMode ? null : me.money, mo);
    hud.spectate(!me.alive && this.spectating && !(this.deathCam && this.now < this.deathCam.until) ? this.spectating.c.name : null, !this.specThird);
    hud.crosshair(me.alive ? !this.buyMenu.isOpen : !!this.specVm);
    const left = (this.flashUntil || 0) - this.now;
    hud.flashed(left > 0 ? Math.min(1, left / Math.max(0.5, this.flashSecs * 0.6)) : 0);
    // Your grenades (a count a kind, and the one in hand, as a number: the list made again only when it changes).
    let nadeKey = me.alive ? 1 : 0;
    if (me.alive) for (const id of NADE_ORDER) nadeKey = nadeKey * 8 + Math.min(7, Math.max(0, me.nades[id] | 0));
    nadeKey = nadeKey * 16 + (gun?.nade ? NADE_ORDER.indexOf(gun.id) + 1 : 0);
    if (nadeKey !== this.nadeKey) {
      this.nadeKey = nadeKey;
      hud.nades(me.alive ? NADE_ORDER.filter((id) => me.nades[id] > 0).map((id) => [id, NADES[id].short, me.nades[id]]) : [], gun?.nade ? gun.id : null);
    }
    if (me.alive && gun && !gun.melee) hud.setCrosshair(gun.nade ? 0 : this.arsenal.inaccuracy(gun)); // (a grenade: the crosshair at rest)
    // The weapon list on the right whenever what you hold or carry changes (slot by slot: no key made every frame).
    const live = !!(me.alive && gun), seen = (this.listSeen ||= {});
    let changed = live !== this.listLive;
    if (live) {
      if (gun.slot !== seen.slot || !!this.icons !== seen.icons) { seen.slot = gun.slot; seen.icons = !!this.icons; changed = true; }
      for (const sl of WHEEL) { const id = this.arsenal.guns[sl]?.id; if (seen[sl] !== id) { seen[sl] = id; changed = true; } }
    }
    if (changed) { if (live && this.listLive !== undefined) this.showWeaponList(); this.listLive = live; }
    const sg = !me.alive && this.specVm ? this.specVm.bot.weapons[this.specVm.bot.slot] : null;
    const shown = me.alive ? gun : sg && { id: sg.id, name: ITEM_NAMES[sg.id] || sg.id, clip: sg.clip, reserve: sg.reserve, melee: sg.melee, nade: isGrenade(sg.id) };
    const am = (this.ammoSeen ||= {});
    if ((shown?.name ?? null) !== am.name || shown?.clip !== am.clip || shown?.reserve !== am.reserve) { am.name = shown?.name ?? null; am.clip = shown?.clip; am.reserve = shown?.reserve; hud.ammo(shown || null); }
    // Planting / defusing progress.
    if (this.respawnMode && !me.alive && me.respawnAt != null) hud.progress('Respawning', Math.min(1, 1 - (me.respawnAt - this.now) / 2));
    else if (this.planting) hud.progress('Planting the bomb', Math.min(1, (this.now - this.planting.start) / m.rules.plantTime));
    else if (m.bomb?.defuser === me) { const tot = me.defuser ? m.rules.defuseKitTime : m.rules.defuseTime; hud.progress(me.defuser ? 'Defusing (kit)' : 'Defusing', 1 - (m.bomb.defuseEnd - this.now) / tot); }
    else hud.progress(null);
    this.hudTimer = (this.hudTimer || 0) - dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      hud.fps(this.settings.showFps === false ? null : this.fps);
      hud.place(me.alive ? this.place() : null);
      if (this.buyMenu.isOpen) { if (!m.buyOpen || !this.inBuyZone()) this.closeBuyMenu(); else this.buyMenu.render(); }
      if (!this.matchOver) { const tab = this.input.held('scores'); hud.scoreboard(tab, tab ? this.scoreData() : null); }
      this.radar?.draw(this.radarData());
    }
  }

  scoreData() {
    const side = (s) => this.match.score[this.combatants.find((c) => c.team === s)?.squad] ?? 0;
    return {
      myTeam: this.me.team, round: this.match.round, scores: { CT: side('CT'), T: side('T') }, ffa: this.ffa, respawn: this.respawnMode,
      players: this.combatants.map((c) => ({ name: c.name, team: c.team, money: this.respawnMode ? null : c.money, points: c.points || 0, level: c.level || 0, kills: c.kills, deaths: c.deaths, assists: c.assists, damage: c.damage, mvps: c.mvps, score: c.score, alive: c.alive, me: c === this.me,
        // Competitive and Wingman: everyone's skill group (yours, and the bots' from their skill); Premier: their CS Rating.
        rank: this.mode !== 'competitive' && this.mode !== 'wingman' ? undefined : c === this.me ? rankKey(rankInfo(this.mode === 'wingman' ? S.wingman : S.rank)) : groupOfSkill(c.skill),
        wingman: this.mode === 'wingman',
        rating: !this.premier ? undefined : c === this.me ? premierInfo(S.premier).rating : c.rating,
        avatar: c.identity?.avatar || null, org: c.identity?.team || null, country: c.identity?.country || null })),
    };
  }
  radarData() {
    const m = this.match, me = this.me;
    const view = !me.alive && this.spectating ? { pos: this.spectating.pos, yaw: this.spectating.yaw } : { pos: this.player.origin, yaw: this.input.yaw };
    const b = m.bomb;
    // The bomb: planted (everyone), dropped (the terrorists), or on a teammate who carries it (the terrorists, as in CS2).
    const carried = b?.state === 'carried' && me.team === 'T' && b.carrier?.alive && b.carrier !== me;
    const bomb = !b ? null : b.state === 'planted' || (b.state === 'dropped' && me.team === 'T') ? { pos: b.pos, planted: b.state === 'planted' }
      : carried ? { pos: this.positionOf(b.carrier), carried: true } : null;
    return {
      center: view.pos, yaw: view.yaw, myTeam: me.team, bomb, pings: this.pings,
      mates: this.combatants.filter((c) => c !== me && !this.hostile(me, c)).map((c) => ({ pos: this.positionOf(c), alive: c.alive })),
      enemies: this.combatants.filter((c) => this.hostile(me, c) && c.alive && c.spottedBy === me.squad && this.now - (c.spottedAt ?? -9) < 1.5).map((c) => ({ pos: this.positionOf(c) })),
    };
  }

  // The callout area the player is in (env_cs_place boxes).
  place() { return this.placeAt(this.player.origin); }
  placeAt(o) {
    let best = null, vol = Infinity;
    for (const p of this.map.info.places) {
      if (o[0] < p.min[0] || o[0] > p.max[0] || o[1] < p.min[1] || o[1] > p.max[1] || o[2] < p.min[2] - 64 || o[2] > p.max[2]) continue;
      const v = (p.max[0] - p.min[0]) * (p.max[1] - p.min[1]);
      if (v < vol) { vol = v; best = p.name; }
    }
    return best;
  }

  // The screen as your video settings have it (see screenLayout): its size and place in the window, the resolution it's
  // drawn at, and the cameras' aspect (the field of view is CS2's: 90° across at 4:3, the same height at any aspect, so
  // 4:3 sees less to the sides, and stretched it's all wider).
  resize() {
    const rw = this.root.clientWidth || window.innerWidth, rh = this.root.clientHeight || window.innerHeight, s = this.settings;
    const L = screenLayout(rw, rh, s);
    const st = this.screen.style;
    st.width = L.w + 'px'; st.height = L.h + 'px'; st.left = L.x + 'px'; st.top = L.y + 'px';
    st.transform = L.scaleX !== 1 ? `scaleX(${L.scaleX})` : '';
    const q = this.quality, pr = L.res ? L.res[1] / L.h : (q === 'high' ? Math.min(window.devicePixelRatio, 2) : q === 'performance' ? 0.75 : 1) * (s.renderScale || 1);
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 1e-6) this.renderer.setPixelRatio(pr);
    this.renderer.setSize(L.w, L.h, false);
    this.post?.setSize(Math.round(L.w * pr), Math.round(L.h * pr));
    for (const c of [this.camera, this.vmCamera]) { c.aspect = L.w / L.h; c.updateProjectionMatrix(); }
  }

  // noclip: fly where you look (Jump up, Crouch down, Walk slow), through everything.
  flyNoclip(cmd) {
    const p = this.player, { fwd, right } = basis(cmd.pitch, cmd.yaw), speed = cmd.walk ? 250 : 1000;
    const up = (this.input.held('jump') ? 1 : 0) - (this.input.held('duck') ? 1 : 0);
    for (let i = 0; i < 3; i++) p.origin[i] += (fwd[i] * cmd.forward + right[i] * cmd.side + (i === 2 ? up : 0)) * speed * TICK;
    p.velocity = [0, 0, 0];
    p.onGround = false;
  }

  dispose() {
    this.disposed = true;
    if (this.log) { this.log.save().catch(() => {}); this.log.stop(); } // (leaving: net_graph 2's log so far)
    this.console?.dispose();
    cancelAnimationFrame(this.raf);
    this.resizer.disconnect();
    this.input.dispose();
    for (const job of this.vmCache.values()) job.then((x) => x.vm.dispose()).catch(() => {});
    this.gloveScene?.then(({ root }) => root.traverse((o) => { for (const m of o.isMesh ? [].concat(o.material || []) : []) { m.userData.dispose?.(); m.dispose(); } })).catch(() => {});
    for (const b of this.bots || []) b.dispose();
    this.myBody?.dispose();
    this.effects?.dispose();
    this.nades?.dispose();
    this.drops?.dispose();
    this.post?.dispose();
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
