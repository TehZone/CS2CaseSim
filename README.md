# CS2 Case Simulator

Fan-made CS2 case opening game (Electron). Not affiliated with Valve.

**Play:** run `dist/CS2-Case-Simulator-Setup.exe` (installs for your user, no admin, starts fast) or the
portable `dist/CS2-Case-Simulator.exe` (no install, slower to start). Windows SmartScreen may warn because
the exe is unsigned: choose *More info → Run anyway*. Item images download on first view and are cached,
so you need internet the first time you see an item. Saves go to `%APPDATA%/cs2-case-sim/save.json`.

## Real CS2 models
If Counter-Strike 2 is installed, guns and knives are inspected on their real CS2 models. The game reads
your own install with a bundled, patched build of [Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat)
(`tools/s2v`), then runs CS2's own skin compositing shader (decompiled from your game files) in WebGL to
bake each skin for the item's exact float and pattern seed (so blue gems, fades and Doppler phases match the
game). Models/textures are extracted the first time you inspect each weapon and cached in
`%APPDATA%/cs2-case-sim/cs2cache`. Nothing from the game is bundled with the app. Gloves are shown as CS2's
glove models (just the gloves, posed by CS2's own glove inspect animation), with the skin baked per hand by CS2's
glove compositing shader (csgo_customglove), including the newest gloves' layered materials. Agents still use the
icon-based 3D view. Without CS2 installed, everything falls back to that view.

With CS2 installed the inspect also offers:
- **Backdrops**: the same map scenes CS2 shows behind the menu and item inspect (Dust II, Mirage, Inferno, Ancient,
  Anubis, Nuke, Overpass, Train, Vertigo, Italy, Office...), placed where CS2 shows items and blurred like the game.
- **First person** (V): CS2's own inspect animation for that weapon or knife (now and then one of CS2's special inspects,
  like the Deagle's spin or the Falchion's and Skeleton's tricks; F again during an inspect plays one), on CS2's first-person arms, with your skin
  and stickers (each riding on the part it's on: a sticker on the magazine comes out with it on a reload). Gloves
  equipped in your **loadout** are worn on the hands, like in game. Gloves themselves can be
  seen in first person too: worn, inspecting your equipped knife (or the default knife).
- **Sticker effects**: Holo, Foil, Gold, Glitter, Lenticular and Embroidered stickers use CS2's own sticker materials.
- **StatTrak™ counters**: StatTrak™ guns carry CS2's orange counter module where the game puts it, and StatTrak™ knives
  have the count etched into the blade, showing the item's kills (in the inspect, first person and Play).

Opening a case also plays CS2's own crate: the case's 3D model drops in, lands and unlocks with the game's "fall" and
"open" animations and sounds before the roulette (weapon cases and recent souvenir packages; containers without a 3D
crate, or without CS2 installed, drop in as their icon). Turn it off under Settings → Case drop animation.

## Play (offline CS2 against bots)
With CS2 installed, **Play** is a match against bots on any bomb defusal map in your install (Dust II, Mirage, Inferno,
Nuke, Ancient, Anubis, Overpass, Train, Vertigo...; each map is prepared the first time you play it), with your equipped
skins, gloves and knife. Four modes:
- **Competitive**: you and bot teammates against bots (1v1 up to 5v5, four bot difficulties, first to 9 or first to
  13), with CS2's rounds: freeze time and buy time, the 1:55 round clock, the bomb (one terrorist carries it; plant it
  in a bomb site, 40 second fuse, defuse in 10 seconds or 5 with a kit), win by elimination, bomb, defuse or time,
  halftime side swap and overtime (MR3 with $12,500, sides swapping after 3; or ties as draws).
- **Wingman**: 2v2 on one bomb site, 90-second rounds, first to 9.
- **Deathmatch**: free-for-all or teams for 5, 10 or 15 minutes. You respawn after two seconds away from enemies, every
  gun is free from the buy menu anywhere (you respawn with what you picked), points for kills (more for headshots,
  pistols and the knife).
- **Arms Race**: free-for-all, a new weapon every kill down to the knife; a knife kill sets the victim back one weapon,
  and the first knife kill on the last level wins.

What's in a match:
- Grenades: HE (up to 99 damage over 350 units), flashbangs (blind by how directly you look and how close you are, with
  CS2's burned-in afterimage), molotovs and incendiaries (7 seconds of fire), decoys (fake gunfire), and CS2's
  volumetric smoke: it floods the space it lands in (around corners, through doors, never through walls), bullets punch
  tunnels through it and HE grenades blow holes that refill; sight lines (yours and the bots') go by how much smoke they
  cross, and a smoke puts out fires. Thrown like CS2: Mouse1 full throw, Mouse2 underhand, both a medium throw, plus
  your movement; they bounce off the map. CS2's limits: four grenades, two flashbangs.
- Weapon modes: the M4A1-S and USP-S silencer screws off and on (Mouse2), the Glock-18 and FAMAS switch to burst fire
  (Mouse2), the R8 Revolver cocks for an accurate shot (hold Mouse1) or fans (Mouse2), shotguns load shell by shell and
  can fire mid-reload, and the Zeus x27 (Gear, $200) recharges 30 seconds after a shot.
- Weapons drop when players die (G drops yours); walk over a gun to pick it up into a free slot, E swaps. Dead CTs drop
  their defuse kit. Bullets go through thin walls (wood easily, metal less, concrete barely) with less damage.
- CS2's economy: $800 start, round rewards, the loss bonus ($1400 rising by $500, dropping by one on a win), kill
  rewards by weapon, planting and defusing bonuses, the $16,000 cap. Buy menu (B) with CS2's prices and team-only guns,
  Kevlar, helmet, defuse kits and the Zeus.
- Ladders: walk into one to climb (CS2's climbing speed; look down to go down, jump to push off). Fall damage at CS2's
  speeds.
- Radio (Z commands, X reports, V responses): your bot teammates follow orders (go A, go B, go go go, follow me, hold
  this position, regroup, fall back, cover me; "enemy spotted" points them where you aim) and answer. Bots talk on the
  radio in their agent's CS2 voice (enemy spotted with the callout, enemy down, planting, flashbang out, enemies left...),
  shown in a chat with where it came from. Optional friendly fire with CS2's damage reductions and team-kill penalty.
- Bots walk the map's own navigation mesh, ladders included, and climb like players: up an 18-unit step at most,
  jumping (or crouch-jumping, up to 66 units) onto boxes and ledges, and never onto anything higher. Terrorists pick
  a site, take it and plant; counter-terrorists split up to hold the sites, rotate when they see terrorists, retake and defuse; they flee a bomb
  they can't stop. In fights they react after a human-like delay, aim with an error that shrinks as they track you,
  stop to shoot, control part of the recoil and fire in bursts. They smoke off and flash sites before taking them,
  molotov or HE where they last saw you, flash retakes, burn a defuser, get blinded by flashes, step out of fire and pick
  up guns and kits. They hear gunshots and footsteps, buy by their money (eco, force, AWP, grenades...) and are animated
  with CS2's third-person clips: running, walking and crouching in every direction, each gun's hold pose, drawing and
  reloading it, pulling a grenade's pin and throwing it, flinching when hit, covering their eyes when flashed, climbing
  ladders, falling, planting, defusing, deaths. Standing still they aim around with the upper body and only step round
  when the aim swings far off, like CS2's turn in place.
- Radar (CS2's overview of the map), kill feed (with CS2's marks for headshots, wallbangs, kills through smoke, jumping,
  no-scope and blinded kills), scoreboard (Tab), damage direction, death cam and spectating teammates (first person
  with their gun, like CS2; Jump for third person), CS2's announcer, round music and bomb sounds, and an end screen with
  your K/D/A, ADR, headshots, accuracy, MVPs and multi-kills. You can inspect your weapon during freeze time.
- Sound carries like CS2's: gunshots over much of the map, footsteps about 1100 units, smaller sounds less, fading with
  distance and muffled through walls; the round's music and the radio play one at a time.
- CS:GO's competitive ranks, one for all maps: Silver I to The Global Elite, with CS2's own emblems. Competitive matches
  move a hidden rating (more for a bigger win, and depending on the bots' difficulty); the rank shows after 10 wins and
  then moves a group at a time, with CS:GO's rank-up (or down) at the end of the match. It's in the lobby, the
  scoreboard (the bots are ranked by their difficulty) and your stats, saved with your progress (online too), and
  shows as expired after 30 days without a win.
- Finished matches pay into your wallet when you play offline: kills, assists, MVPs, rounds won and the win, more
  against harder bots. The lobby shows your record.
- The lobby shows CS2's own screenshot of each map.
- Kills with your StatTrak™ guns and knives count on them (enemies only), like CS2: the counter on the weapon goes up
  and the item keeps the count (online too).
- Dust II's soccer ball is a physics prop like in CS2: walk into it to kick it along (it stops you against a wall),
  bots bump it too, and bullets, knives and HE grenades knock it; it bounces, rolls to a stop and is back on its spot
  every round.
- CS2's special inspects and draws come up now and then in matches too (F again during an inspect for one; the console's
  cl_inspect_rare 1 always, -1 never).
- The developer console (~): CS2's console commands and variables, with completion (Tab), history and find/help.
  sv_cheats 1 unlocks the cheats (god, noclip, give, impulse 101, host_timescale, sv_gravity, sv_infinite_ammo,
  bot_stop, bot_dont_shoot); the rest work anyway (mp_restartgame, mp_roundtime, mp_freezetime, mp_buytime,
  mp_buy_anywhere, mp_startmoney, mp_maxmoney, bot_difficulty, bot_kill, viewmodel_*, cl_crosshair*, sensitivity,
  volume, fps_max, cl_drawhud, r_drawviewmodel, status...).
- CS2's weapon list on the right when you switch weapons, with CS2's icons (also in the buy menu and kill feed).
- Settings in the lobby: your crosshair (classic or static, colour, length, gap, thickness, outline, dot; live preview),
  the viewmodel (field of view, offsets, CS2's presets), every key, music and radio volume, the fps counter.
- The map is exported from your install the first time (a couple of minutes, cached in `cs2cache/play`): CS2's render
  world lit like CS2 lights it: the baked irradiance lightmap plus the sun (its colour and brightness from the map)
  masked by the baked sun shadows on world surfaces; props, players and your weapon lit by CS2's light probe volumes
  (the baked light where they are); and the map's post processing (CS2's filmic tone curve with the map's parameters,
  auto exposure within its range, its colour grading LUT),
  CS2's two-layer surfaces blended like the game does (sand painted over asphalt and tiles, plaster worn down to brick),
  the map's sky, its collision mesh (brushes that only switch on in other modes, like Retakes' blockers, left out), nav
  mesh with ladders, spawns, bomb sites, buy zones and callout areas.
- Movement ported from Source's: CS2's acceleration, friction, air strafing, 18-unit steps, jumping (no auto bunny
  hop), crouching, crouch-jumps, walking and ladders, with the weapon's own speed; footsteps by surface.
- Weapons use CS2's data from `scripts/weapons.vdata` (damage, range falloff, armor penetration, fire rate,
  magazine, inaccuracy, spread, recovery, burst and reload timings) with Source's recoil (each gun's recoil seed, aim
  punch and view punch), CS2's viewmodel animations (draw, idle, shoot, reload, inspect, silencer, knife slashes and
  stabs) and CS2's sounds. Scoped rifles zoom with CS2's zoom levels.
- Bots are CS2 agent models with per-bone hitboxes (head, chest, stomach, arms, legs) and armor.
- Keys (rebindable): WASD, Space, Ctrl (or C) crouch, Shift walk, Mouse1/Mouse2, R, F inspect, B buy, E defuse/pick up,
  G drop, 1/2/3 (3 again for the Zeus), 4 (grenades), 5 (the bomb: hold Mouse1 in a site to plant), Q and the mouse
  wheel switch weapons, Z/X/V radio, Tab scores, Esc pause. Mouse sensitivity uses CS2's scale, so your CS2 sensitivity
  feels the same.

## Features
- 42 real weapon cases, 150 souvenir packages (each Major's team stickers and gold MVP autographs), packages
  (X-Ray, Anubis, Genesis/Dead Hand Terminals), 229 sticker/autograph capsules, an Agent Locker and a Chicken Coop Crate
- All 94 weapon collections (e.g. Cobblestone with the Dragon Lore), browsable with odds and prices
- Trade Up Contracts with CS2's rules: 10 skins of one rarity, ticket-based odds per collection, normalised output
  floats, StatTrak contracts, and 5-Covert contracts into a knife or gloves
- The Armory: Armory Stars (Armory Pass, or earned by opening cases) spent on drops from featured collections that
  rotate every 10-15 minutes
- Gambling (virtual money, no house edge, provably fair with a verify button): case battles (1v1 to 2v2, normal or
  crazy), coinflip and jackpot, against bots or, online, other players
- Team manager: 2,570 pro player cards (one per player per Major, rated from real Major results), packs, a
  five-role lineup with chemistry, round-by-round match simulation, cups, LANs and Majors against real rosters
- Online play (optional): accounts on your own server, trading between players, live lobbies; see DEPLOY.md
- Rare Special Items (knives and gloves) show CS:GO's classic gold "?" medallion in case contents and the roulette
- Floats (CS2 wear distribution), pattern seeds 0-1000 with rare patterns (blue gems, Fire & Ice, full fades, Doppler phases...)
- StatTrak™, knives and gloves, stickers with free placement, scraping, and craft bonuses
- Loadout (Inventory → Loadout, or Equip on an item): gloves, knife, a T and a CT agent, and one skin per gun
- 3D inspect (drag, zoom, F to inspect, B to flip), clicker with upgrades and ranks, passive income, offline earnings
- Market prices blended from Skinport, CSFloat, Buff163 and YouPin (Steam as fallback); refresh in Stats & Settings

## Develop
```
npm install
node node_modules/electron/install.js   # npm 11+ blocks Electron's download step
npm run data      # rebuild src/data/game-data.json (add --refresh via `npm run data:refresh` for fresh downloads)
npm run vendor    # copy three.js into src/vendor
npm start         # run the game
npm run dev       # browser preview at http://localhost:5178
npm run dist      # build dist/CS2-Case-Simulator-Setup.exe and dist/CS2-Case-Simulator.exe
node scripts/test-engine.mjs            # game rule checks (odds, trade-ups, armory, gambling, team manager)
node scripts/test-play.mjs              # Play mode checks (traces, movement, ladders, rules, overtime, smoke, modes)
cd server && npm install && cd ..       # multiplayer server dependencies
PGLITE_DIR=server/.data node server/index.mjs   # run the server locally (port 8787)
node server/test.mjs                    # server checks (accounts, trading, live gambling, restarts)
node scripts/cs2/dev-index.cjs           # build the CS2 index from your install (dev)
node scripts/cs2/dev-prepare.cjs weapon_ak47 aq_oiled   # extract one skin's assets (dev)
```
Game rules live in `src/js/engine` and are shared by the game and the server (`server/`), so offline and online
play follow the same code. `tools/s2v` holds the patched Source 2 Viewer CLI (adds GLSL ES output with combined samplers so CS2's
shaders run in WebGL); rebuild it from the ValveResourceFormat sources with `tools/vrf-glsl-es.patch` applied (the exe is not in git).
