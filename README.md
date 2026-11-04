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
`%APPDATA%/CS2 Case Simulator/cs2cache`. Nothing from the game is bundled with the app. **Settings → Prepare all
CS2 content** exports everything up front instead (every map, weapon model and skin texture, sticker, case, agent,
icon and sound), in the background while you play, with its progress, the cache's size and when it last ran; it can be
stopped and carried on, and stops itself before the drive fills up. The cache survives CS2 updates: every cached file
remembers the CRC of the game file it came from (the VPK listing has one per file), and a cache built from several
(the paint kit index, weapon data, icons) a signature of them, so an update re-exports only what it changed, and a map
whose VPK Steam rewrote with nothing in it changed (most of them, most updates) keeps its export. With "Keep everything
prepared after CS2 updates" on, a CS2 update brings what was prepared up to date at the next start.
`CS2SIM_SMOKE=prepare` times a map load and runs Prepare all for a while. Gloves are shown as CS2's
glove models (just the gloves, posed by CS2's own glove inspect animation), with the skin baked per hand by CS2's
glove compositing shader (csgo_customglove), including the newest gloves' layered materials. Agents still use the
icon-based 3D view. Without CS2 installed, everything falls back to that view.

With CS2 installed the inspect also offers:
- **Backdrops**: the same map scenes CS2 shows behind the menu and item inspect (Dust II, Mirage, Inferno, Ancient,
  Anubis, Nuke, Overpass, Train, Vertigo, Italy, Office...), placed where CS2 shows items and blurred like the game.
- **First person** (V): CS2's own inspect animation for that weapon or knife (now and then, about one in nine and never
  twice running, one of CS2's special inspects, like the Deagle's spin or the Falchion's and Skeleton's tricks), lit
  softly like CS2's viewmodel, on CS2's first-person arms, with your skin
  and stickers (each riding on the part it's on: a sticker on the magazine comes out with it on a reload). Gloves
  equipped in your **loadout** are worn on the hands, like in game. Gloves themselves can be
  seen in first person too: worn, inspecting your equipped knife (or the default knife).
- **Sticker effects**: Holo, Foil, Gold, Glitter, Lenticular and Embroidered stickers use CS2's own sticker materials.
  Souvenir stickers sit in each gun's own souvenir slots, at CS2's size (in 3D and on the icons).
- **StatTrak™ counters**: StatTrak™ guns carry CS2's orange counter module where the game puts it, and StatTrak™ knives
  have the count etched into the blade, showing the item's kills (in the inspect, first person and Play).
- **Charms**: CS2's charm models hook onto the gun where CS2 puts them by default, or anywhere you click on the gun
  (Move charm, in the inspect), and swing as the gun moves (in the inspect, first person and Play), resting against the
  gun's side, never through it; on a pistol's slide they ride back with it.
  They are drawn with CS2's charm materials, and most charms' colours follow their pattern like in game (the icons show
  the middle pattern). A Sticker Slab shows its sticker on the card inside the case, its label in the sticker's rarity colour.

Opening a case also plays CS2's own crate: the case's 3D model drops in, lands and unlocks with the game's "fall" and
"open" animations and sounds before the roulette (weapon cases and recent souvenir packages; containers without a 3D
crate, or without CS2 installed, drop in as their icon). Turn it off under Settings → Case drop animation.

## Play (offline CS2 against bots)
With CS2 installed, **Play** is a match against bots on any bomb defusal map in your install (Dust II, Mirage, Inferno,
Nuke, Ancient, Anubis, Overpass, Train, Vertigo...; each map is prepared the first time you play it), with your equipped
skins, gloves and knife. Two ways in, like CS2's play menu:
- **Matchmaking** (Premier, Competitive, Wingman, Deathmatch, Arms Race): pick the maps you'll play (Premier bans its
  own from the Active Duty pool) and press Go. The search runs with its timer in the top bar while you use the rest of
  the game; meanwhile the match it will find is set up (one of your maps at random, bots of your rank: around your
  skill group, your Wingman rank or your CS Rating, or the hidden rating while you're unranked) and loaded out of
  sight, so when it's found (accept it within 20 seconds) you're straight in. Matchmaking plays CS2's rules: MR12 with a
  draw at 12:12 (Premier: overtime), friendly fire on.
- **Private match**: everything up to you: the map, side, team size, length, overtime, friendly fire, and your
  teammates' and opponents' ranks (a tier or one skill group). It pays a reward but moves no rank.

In a match, Esc opens the menu over it and the match goes on (it never pauses): cases, the market, your inventory and the
item database are all there, and the Play page has Resume, your settings and keys (used at once) and Leave. Leaving a
ranked match (Premier, Competitive, Wingman) you can come back: Reconnect (top bar or Play page) puts you back in, at
once in freeze time, else next round, and the first time your team calls a technical timeout that holds the next
freeze time up to two minutes for you. Abandon it, or don't reconnect within 5 minutes (or close the game during it),
and it counts as a loss with a cooldown from ranked matchmaking: 30 minutes, then 2 hours, a day and a week for each
abandon within a week of the last.

The modes:
- **Competitive**: you and bot teammates against bots (1v1 up to 5v5 in a private match, first to 9 or first to
  13), with CS2's rounds: freeze time and buy time, the 1:55 round clock, the bomb (one terrorist carries it; plant it
  in a bomb site, 40 second fuse, defuse in 10 seconds or 5 with a kit; you can still plant it after the round is over,
  as in CS2, without changing the result; planted, the red LED on its circuit board lights with each beep, faster as it
  runs down, and you can see it from across the site), win by elimination, bomb, defuse or time,
  halftime side swap and overtime (MR3 with $12,500, sides swapping after 3; or ties as draws).
- **Wingman**: 2v2 on one bomb site, 90-second rounds, first to 9.
- **Deathmatch**: free-for-all or teams for 5, 10 or 15 minutes. You respawn after two seconds away from enemies, every
  gun is free from the buy menu anywhere (you respawn with what you picked), points for kills (more for headshots,
  pistols and the knife).
- **Arms Race**: free-for-all, a new weapon every kill down to the knife; a knife kill sets the victim back one weapon,
  and the first knife kill on the last level wins.

What's in a match:
- Grenades: HE (up to 99 damage over 350 units), flashbangs (blind by how directly you look and how close you are, with
  CS2's burned-in afterimage), molotovs and incendiaries (7 seconds of fire spreading along the ground from where it
  breaks, not through walls, at full till its last second: licking flame tongues, embers, dark smoke, a scorch and glow
  on the ground and orange light on the walls and players around it), decoys (fake gunfire), and CS2's
  volumetric smoke: it floods the space it lands in (around corners, through doors, never through walls), bullets punch
  tunnels through it and HE grenades blow holes that refill; sight lines (yours and the bots') go by how much smoke they
  cross. As in CS2 a smoke puts out a fire there and then: one popping in or next to it (a smoke grenade landing in the
  flames pops at once), or flooding over it, and a molotov landing in a smoke goes straight out. Thrown like CS2:
  Mouse1 full throw, Mouse2 underhand, both a medium throw (750 × 0.9 × (0.7 × strength + 0.3) units/s, aimed 10° above
  the crosshair looking level and less looking up or down, from lower for a softer throw), plus 1.25 × your movement;
  they fall at 0.4 × sv_gravity and bounce off the map as CS2's do, keeping 0.45 of their speed each time, along the
  floor too, so one lands and stops a short way on. CS2's limits: four grenades, two flashbangs.
- Weapon modes: the M4A1-S and USP-S silencer screws off and on (Mouse2), the Glock-18 and FAMAS switch to burst fire
  (Mouse2), the R8 Revolver cocks for an accurate shot (hold Mouse1) or fans (Mouse2), shotguns load shell by shell and
  can fire mid-reload, and the Zeus x27 (Gear, $200) recharges 30 seconds after a shot.
- Weapons drop when players die (G drops yours); walk over a gun to pick it up into a free slot, E swaps. A gun keeps
  its skin wherever it goes, as in CS2: yours is your skin on the floor, in the hands of a bot that picks it up (and
  in first person spectating it) and back in yours, stickers, charm and StatTrak™ counter and all; a bot's is the
  default, so picking one up gives you the default finish, not your own skin for it. A kill counts on a StatTrak™ gun
  only in its owner's hands. The skin travels with the gun as plain JSON (the whole item and whose it is: see
  src/js/play/drops.js), so a gun dropped by another player would carry theirs the same way; Play has no matches with
  other players yet. Dead CTs drop their defuse kit. Bullets go through thin walls (wood easily, metal less, concrete
  barely) with less damage.
- Breakables: glass, shop windows, Nuke's, Mirage's and Cache's vent covers and Nuke's vent slats, Nuke's windows,
  Mirage's B window shutter, Train's cabinet doors, bottles and pots: whatever CS2 breaks, by the map's own entities and
  its models' own prop data (their health, what they're made of, the pieces they break into). Bullets, a knife or an HE
  grenade's blast take their health away; they break with their sound, in pieces, leaving what CS2 leaves (the
  shutter's splintered frame), and are whole again each round. Until then a vent cover blocks the vent; a bot going
  through shoots or slashes it open. A bot stuck at the same place again and again goes another way for the rest of
  the round. Doors start every round closed; E opens and closes them (bots open them as they come).
- CS2's economy: $800 start, round rewards, the loss bonus ($1400 rising by $500, dropping by one on a win), kill
  rewards by weapon, planting and defusing bonuses, the $16,000 cap. Buy menu (B) with CS2's prices and team-only guns,
  Kevlar, helmet, defuse kits and the Zeus.
- Ladders: walk into one to climb (CS2's climbing speed; look down to go down, jump to push off). Fall damage at CS2's
  speeds.
- Radio (Z commands, X reports, V responses): your bot teammates follow orders (go A, go B, go go go, follow me, hold
  this position, regroup, fall back, cover me; "enemy spotted" points them where you aim) and answer. Bots talk on the
  radio in their agent's CS2 voice (enemy spotted with the callout, enemy down, planting, flashbang out, enemies left...),
  shown in a chat with where it came from. Optional friendly fire with CS2's damage reductions and team-kill penalty.
- Bots walk the map's own navigation mesh, ladders included, and move with your movement and collision: they slide
  along walls (never into them), walk up an 18-unit step at most, and run up to a box or ledge and jump (or
  crouch-jump, up to 66 units) onto it. A jump they can't make (a crate or overhang in the way) is one every bot goes
  round for the rest of the match. Terrorists pick
  a site (see the team play below), take it and plant; counter-terrorists split up to hold the sites, rotate when they see terrorists, retake and defuse; they flee a bomb
  they can't stop. They hold proper spots (src/js/play/spots.js): somewhere with cover that sees a way the enemy comes
  in, facing where they'd first show (the doorway, the top of the ramp), from CS2's own hiding spots in the map's nav
  mesh and points about the site, worked out as the match loads. A team's bots share them out each round, watching
  different ways in, never on top of each other, and not the spot they held the last two rounds, so they're never in
  the same five places; the terrorists gather, lurk, hold the site and play the planted bomb the same way. On Mirage,
  Dust II and Inferno they play the positions real players take (src/js/play/setups.js): a CT setup per site and mid
  (Mirage's jungle, stairs, ticket booth, firebox, triple, window, connector, short, bench, van, market window; Dust II's
  long, A short, mid doors, B doors, back plat, car; Inferno's pit, library, arch, coffins, new box, dark, banana car),
  the usual ones the most often and the AWPer on an AWP spot, called in the chat ("A jungle and ticket booth, mid
  window, B bench and van"); and the terrorists' default spread for map control (top mid, palace, A ramp, B apps,
  underpass...), the lurker on the far side. Each is a rough spot read off the map's overview and the callouts the
  enemy comes in through: the spot used is the covered one near it that sees them first in those callouts (window
  watching top mid from across the map, the B positions crossing on the apps exit). A CT outnumbered on its site (three
  terrorists seen there, two more than the CTs left) falls back out of their way to retake with the others, and says
  so; a Silver stays. They steer
  round each other as players do (passing on the right of someone coming the other way, round someone standing in a
  doorway) instead of walking into each other. They know where enemies are from what they see and, roughly, from what
  they hear: a gunshot or footsteps give an idea of where (off by more the further it was, more again through a wall),
  and they look for them where they'd come from, the corner or the doorway, not at them through the wall. In fights
  they react after a human-like delay (longer when you're at the edge of their view), then aim like a player's hand
  (src/js/play/aim.js): a flick that lands short, long or to the side (by more at lower ranks), a correction, then
  following you with a lag, so a change of direction throws them off for a moment; higher ranks shoot as a flick lands.
  They stop to shoot, control part of the recoil and fire in bursts. (`CS2SIM_SMOKE=bots`, Mirage and Dust II, Silver
  and Global Elite, before and after: a Global Elite's crosshair on an enemy behind a wall 17% of the time, now 6%, and
  following one through a wall as they moved 71 times in a Mirage match, now 8; held up by another player 6 to 86
  seconds a round, now 2 to 11; holding a spot facing a wall 18-28% of the time, now 4-13%, seeing 420-550 units that
  way, now 720-1,000; the same spot as an earlier round 36-39%, now 10-12%; a Global Elite's first shot 0.2 s after it
  sees you, its aim already within 1.5° of your head after 0.1 s, now 0.45 s and 10-17° off at 0.1 s.) They know their guns' spread like a player at their
  rank: higher ranks counter-strafe to a stop and only fire once the shot will land (moving, the spray's penalty and
  the recoil they can't pull down all count), so they tap at range, burst nearer and spray up close, and scope in with
  the AWP and Scout; Silvers fire anyway, on the run. Players block each other without pushing (you can stand on a
  head), and crouch spam slows the crouch down like CS2's duck speed. Bots crouch through vents and holes in walls
  (and under anything too low to stand), shooting a vent cover open first; they hold their guns in their hands
  however they crouch, run or aim. They smoke off and flash sites before taking them,
  molotov or HE where they last saw you, flash retakes, burn a defuser, get blinded by flashes, step out of fire and pick
  up guns and kits. They hear gunshots and footsteps, buy by their money (eco, force, AWP, grenades...) and are animated
  with CS2's third-person clips: running, walking and crouching in every direction, each gun's hold pose, drawing and
  reloading it, pulling a grenade's pin and throwing it, flinching when hit, covering their eyes when flashed, climbing
  ladders, falling, planting, defusing, deaths. Standing still they aim around with the upper body and only step round
  when the aim swings far off, like CS2's turn in place. A body falls without its gun (that's on the floor), lies there
  10 seconds, then sinks into the floor and is gone (`CS2SIM_SMOKE=corpses` times what bodies cost: nine in view, about
  a quarter of a frame).
- Everyone's picture by the round clock (the bots' real players), dimmed when they die. Grenades stay primed for as
  long as you hold the button and keep the crosshair; tracers come out of the gun's barrel (yours and the bots').
- Radar (CS2's overview of the map; the bomb a C4 badge you can't miss: red once planted, glowing and sending out a
  ring with each beep, amber dropped or on the teammate who carries it for the terrorists, kept upright and, when it's
  off the radar, waiting on its edge the way to it; `CS2SIM_SMOKE=bomb` plants one and screenshots its LED and the
  radar), kill feed (with CS2's marks for headshots, wallbangs, kills through smoke, jumping,
  no-scope and blinded kills), scoreboard (Tab), damage direction, death cam and spectating teammates (first person
  with their gun, like CS2; Jump for third person), CS2's win panel at the end of each round (the side's title in its
  colours, how the round ended, the MVP and what for, in CS2's words, until the next round starts; `CS2SIM_SMOKE=winbanner`
  plays out each way a round ends and screenshots it), CS2's announcer, round music and bomb sounds, and an end screen with
  your K/D/A, ADR, headshots, accuracy, MVPs and multi-kills, then what the match paid (the result, your kills of
  enemies and your assists: see Features) and the XP it gave, with your level's bar, and a level up or a Service Medal
  with CS2's sound; the scoreboard under it. You can inspect your weapon during freeze time. Your viewmodel blends from
  one animation into the next as CS2's does (F again starts the inspect over from where the weapon is, R takes over from
  it), and H (CS2's switchhands, cl_prefer_lefthanded; also in the settings) puts it in your left hand, kept for your
  next matches.
- Sound plays the way CS2 plays it, by each sound event's own settings in your install: its volume by distance (a
  gunshot loud up close and gone by 2500 units as its distant version takes over, footsteps gone by 1100), the events it
  plays along with it (a gunshot's distant layer, a landing's thud), random pitch and volume, how much a wall in
  between muffles it, plain stereo up close, and how many of it one player plays at once (a spray doesn't pile up its
  shots' tails). The round's music and the radio play one at a time.
- The map's soundscapes (CS2's env_soundscape: Dust II has a hundred) set the reverb where you are, one of CS2's own
  reverb presets (its delays, diffusors and rooms rendered as an impulse response): Dust II's tunnels ring, its long A
  echoes off the walls, B site is open. The room comes out as CS2's main mix has it: its lows and highs taken out, and
  turned down while the sounds themselves are loud (CS2's reverb compressor: a spray's echo stays under the spray, a
  footstep's doesn't). They also play the map's ambience: the wind, a distant city where it is in the
  world, sand blowing over a car or rocks falling somewhere near you now and then.
- CS:GO's competitive ranks, one for all maps: Silver I to The Global Elite, with CS2's own emblems; Wingman has its own
  rank with its own emblems. Matchmade matches move a hidden rating (more for a bigger win, and depending on the other
  team's ranks); the rank shows after 10 wins and
  then moves a group at a time, with CS:GO's rank-up (or down) at the end of the match. It's in the lobby, the
  scoreboard (each bot's rank comes from its skill) and your stats, saved with your progress (online too), and
  shows as expired after 30 days without a win.
- Premier: the full MR12 (first to 13, overtime on a tie) with a CS Rating instead of a skill group: unrated until 10
  wins, then up or down by the result, the round difference and the other team's rating, shown in the tier's colour
  (grey under 5,000 up to gold from 30,000). Before each match both teams are listed like a leaderboard (real players
  with their ratings and team averages) and the map is picked by CS2's pick/ban over the Active Duty maps: the first
  team bans two, the second three, the first one more, and the second team picks its side. Ratings show on the
  scoreboard and the result screen.
- The bots are real players: the pros of the game's Major autograph stickers (their autograph as the picture, their
  team), or the players in src/data/bot-players.json when it's there (Liquipedia's data, credited), nobody twice in a
  match. Their skill comes from their rank (matchmaking finds them around yours; a private match's are the ranks you
  pick, each bot its own rank): reaction time, how their flicks land and how closely they follow you, spray control, where the crosshair rests (head height or the floor), how quickly
  they stop to shoot (counter-strafing), how much utility they throw and how well, patience, and how fast they trade.
- They play as teams. Each round the team makes an economy call (save, force or full buy, a rifle dropped to a teammate
  who couldn't afford one) and a plan its best player calls in the chat. Terrorists rush a site, execute one (gathering
  short of it; smokes, then molotovs, then pop flashes; the entry going in as the flash bursts, the rest close enough to
  trade), take mid and split, or play a default for picks and hit late (a rush or a default coming in by any of the
  site's ways in, through mid or from the other site, not always the shortest), with roles: entry, support, lurker, AWPer.
  Counter-terrorists split over the sites (stacking the one that keeps getting hit, at higher ranks), smoke a choke
  early and save the molotov for when the terrorists show there, rotate on information (lower ranks on one sighting,
  higher on two) and retake together, smoking off where the terrorists hold the bomb from and flashing before going
  in. A default's map control utility (Mirage's window smoke) goes out as the round starts. None of it is wasted on
  the other: a molotov waits while the spot it lands on is smoked (its own team's smoke or theirs), a smoke isn't thrown
  onto its own team's fire, and retaking CTs smoke out a molotov burning on the bomb to defuse.
  The utility is real lineups (src/data/lineups.json: Dust II, Mirage, Inferno and Nuke: Mirage's window, top
  connector, jungle, CT, stairs and market smokes, triple and van molotovs; Dust II's xbox, CT, long cross, B doors and
  B window smokes, long corner, back plat and car molotovs; Inferno's arch, CT and coffins smokes, pit, new box and
  banana car molotovs; each side's holds and retakes), found on each map's own geometry by scripts/build-lineups.mjs:
  asked for by callouts ("the part of CT spawn nearest A site") or the spot the real one lands on, searched over throw
  spots, aims, strengths and jump-throws with the game's own grenade physics, the steadiest kept (one that misses by
  more than a few hundred units a tenth of a degree off isn't: the best bots' aim is about that), and checked again on
  each match's collision. A bot stands on the spot, still till it's thrown, aims (off by its rank's error: a Global
  Elite's lined up on the pixel, a Gold Nova's a few tenths of a degree out, Silvers misthrow) and throws.
  `CS2SIM_SMOKE=lineups` throws every lineup of each map in the game itself (a bot on its spot, its aim exact) and logs
  where each went off against where it should.
  `CS2SIM_SMOKE=fire` does the same for fire and smoke: a molotov dropped in front of you burns 7 s (screenshots to its
  last second), a smoke dropped on a burning one puts it out as it pops, and a molotov dropped into a smoke goes out.
  `CS2SIM_SMOKE=bots` watches rounds at chosen ranks and logs the plans (the CT setup called, a default's spread, where
  everyone is 20 s in, the CTs' utility and who fell back) and where every lineup landed, and measures how
  the bots behave (userData/bots-<map>-<tier>.json): how often their crosshair is on an enemy behind a wall and why, how
  long they're held up by another player, where they hold (facing a wall, how far they see, cover, watching a way in,
  the same spot as before), and their fights (reaction, how far off their aim is 0.1 to 1 s in, first shot, first hit);
  `CS2SIM_SMOKE_TIMESCALE` plays it faster. `CS2SIM_SMOKE=drops` drops your skinned AK-47, has a bot pick it up and die
  with it, picks it back up and then a bot's, with screenshots (copy a save.json with skins into the smoke profile
  first; `CS2SIM_SMOKE_USERDATA` runs in another profile, beside a smoke run in the usual one, with `CS2SIM_CACHE` at its
  cs2cache);
  `CS2SIM_SMOKE=premier` plays through the pick/ban and a match; `CS2SIM_SMOKE=mm` goes through matchmaking (search,
  accept, Esc's menu, leave, reconnect, abandon and the cooldown); `CS2SIM_SMOKE=sound` goes through a map's
  soundscapes (`CS2SIM_SMOKE_MAP`, Dust II by default: the reverb and ambience in each), walks you into a bot and lists
  what a match sounds like.
- Finished matches pay into your wallet when you play offline: kills, assists, MVPs, rounds won and the win, more
  against harder bots. The lobby shows your record.
- The lobby shows CS2's own screenshot of each map.
- Kills with your StatTrak™ guns and knives count on them (enemies only), like CS2: the counter on the weapon goes up
  and the item keeps the count (online too).
- Dust II's soccer ball is a physics prop like in CS2: walk into it to kick it along (it stops you against a wall),
  bots bump it too, and bullets, knives and HE grenades knock it; it bounces, rolls to a stop and is back on its spot
  every round.
- CS2's special inspects and draws come up now and then in matches too, as in CS2 (about one in nine, never twice
  running; the console's cl_inspect_rare 1 always, -1 never).
- The developer console (~): CS2's console commands and variables, with completion (Tab), history and find/help.
  sv_cheats 1 unlocks the cheats (god, noclip, give, impulse 101, host_timescale, sv_gravity, sv_infinite_ammo,
  bot_stop, bot_dont_shoot); the rest work anyway (mp_restartgame, mp_roundtime, mp_freezetime, mp_buytime,
  mp_buy_anywhere, mp_startmoney, mp_maxmoney, bot_difficulty, bot_kill, viewmodel_*, cl_crosshair*, sensitivity,
  volume, fps_max, cl_showfps, net_graph, cl_drawhud, r_drawviewmodel, status...), and CS2's binds: bind <key> <command> (bind key alone
  shows it), unbind, unbindall, binddefaults, key_listboundkeys. Any key, mouse button or the mouse wheel; a wheel
  notch on a + command presses and releases it in one tick, so `bind mwheeldown +jump` scroll-jumps (bunny hops) like
  CS2. Binds are saved with your settings.
- CS2's weapon list on the right when you switch weapons, with CS2's icons (also in the buy menu and kill feed).
- Settings in the lobby: your crosshair (classic or static, colour, length, gap, thickness, outline, dot; live preview),
  the viewmodel (field of view, offsets, CS2's presets), every key, music and radio volume, the fps counter and a
  performance graph (net_graph: frame time, simulation and drawing time, draws); video: Low / Medium / High (Low: no
  3D skybox or anti-aliasing), CS2's aspect ratio and resolution (the window's own, Normal 4:3, Widescreen 16:10 or
  16:9, each with CS2's resolutions such as 1280×960 or 1440×1080; a shape other than the window's stretched to fill it,
  as a stretched resolution is, or with black bars), a render scale, the frame rate cap (fps_max; the monitor's refresh
  rate by default) and unlocking it past the monitor's (after a restart). Stretched 4:3 on a 16:9 screen is CS2's: the
  world drawn at 4:3 (90° across, the same height as at 16:9, so less to the sides) and everything, the HUD and radar
  too, a third wider; the mouse turns you the same degrees a count as ever. `CS2SIM_SMOKE=aspect` goes through them in a
  1600×900 window with screenshots.
- The map is exported from your install the first time (a couple of minutes, cached in `cs2cache/play`): CS2's render
  world lit like CS2 lights it: the baked irradiance lightmap plus the sun (its colour and brightness from the map)
  masked by the baked sun shadows on world surfaces; props, players and your weapon lit by CS2's light probe volumes
  (the baked light where they are); and the map's post processing (CS2's filmic tone curve with the map's parameters,
  auto exposure within its range, its colour grading LUT),
  CS2's two-layer surfaces blended like the game does (sand painted over asphalt and tiles, plaster worn down to brick),
  and its newer csgo_environment surfaces (most of Train, Cache, Inferno, Ancient, Fachwerk...) with all their layers:
  up to three textures blended by the vertex paint against their height maps like CS2's shader, each layer's colour
  tint and saturation (Train's blue plaster), the vertex tint, and their lightmap from the right UV set; decals that
  multiply or add like CS2's (grime, Nuke's animated water caustics); glass as CS2's glass shader draws it (its dust
  and grime lit like any surface, what's behind showing through its tint, less of it at a glance); windows with depth
  like CS2's parallax windows (Cache's frosted windows and the buildings round it, Fachwerk's curtained ones: the dirty
  pane, the frames behind it shifting as you move and blurred through the frosted glass, the room or the sky behind
  those, the ones lit from outside glowing); water (waves, sky reflections, the map's water colour); metal that reflects the light around it like
  CS2's cubemaps (Vertigo's lift doors); props with a skeleton (doors, Nuke's vent covers and slats) where their bones
  put them; the map's sky as bright as CS2 draws it (Cache's four times its texture), its
  3D skybox, its collision mesh, nav mesh with ladders, spawns, bomb sites, buy zones and callout areas. Things
  another mode switches on (Wingman's barricades, fences and doors on Vertigo, Nuke, Overpass and Inferno; Retakes'
  blockers) are left out, as in competitive. Doors open with E (CS2's swing and
  sounds; bots open them too), breakable glass and props break when shot (windows, Nuke's vent covers, bottles), every
  surface sounds like CS2's when shot (Inferno's church bells ring), and the map's trigger_hurt volumes hurt the moment
  you touch one (falling off Vertigo kills you as you reach the street).
- Drawn lean: the map's surfaces batched, every texture of a size in one texture array and the materials that share a
  shader drawn as one (their own values in a small table: a few dozen draws for a map, not hundreds) — cut-outs,
  decals, glowing and breakable surfaces and the 3D skybox too, a lone surface joining a batch of bigger textures;
  props tinted differently share a material (each one's colour per vertex); bots share their materials (each its own
  light) and hold baked guns, and aren't drawn out of view; a bot's body parts (and the viewmodel's arms) share one
  skeleton (each had its own copy of the same bones, worked out and sent to the GPU five times a bot a frame); a bot
  far off is posed every other frame, a body that's done falling once, and one out of view is left out of the frame's
  matrix pass (its hitboxes worked out as a shot needs them); hidden viewmodels out of the scene; bullet holes in one
  draw; every texture uploaded and new guns' shaders compiled before they're seen; the radar moved by the page's
  compositor, not redrawn. Bots move with your movement code on a collision test that allocates
  nothing, and their sight lines stop at the first wall. `CS2SIM_SMOKE=perf` measures each map's frame rate with the
  bots playing (`CS2SIM_SMOKE_SHOTS`: a screenshot of each view, three bots stopped in front of you).
- No stutters: everything a match shows is loaded behind the loading screen (every gun bots carry, as it lies on the
  floor and in a bot's hands, your viewmodels and the plain ones you see spectating, the bomb, the effects, the whole
  3D skybox, the flashbang's afterimage), with its shaders compiled and first used, its textures (its shader's own too:
  a skin's pattern and wear) and bone textures on the GPU, and each drawn once by itself (Direct3D, under WebGL,
  finishes a shader the first time it draws with it), so nothing is loaded, compiled or uploaded mid-round. Textures are
  shared between the models that use the same image; your gloves are baked once; skinned meshes take their bind-pose
  bounds; dropped and thrown guns are the bots' baked copies; a molotov lays out its flames over a few ticks; the smoke's
  lighting runs allocation-free; bots and grenades are drawn between ticks (the tick is 64 Hz, the screen faster).
  Collections are rare and short. The game makes little garbage: your and the bots' movement, traces, sight lines and
  smokes work in arrays kept for it; a bot's locomotion clips at weight 0 are stopped (and started again where they
  would have been); its bones' keyframes are worked out in place (`keyframes.js`); three's float uniforms get caches and
  setters of their own (`uniforms.js`) and its draw lists are sorted in place (`drawsort.js`); the HUD makes its text only
  when it changes, net_graph 2's log nothing a frame. V8's memory reducer is off (it took freeze time for a quiet page:
  35-70 ms collections a few seconds into a match, and a young generation collected three times as often), and three's
  check that every model's attributes are on the GPU reads them by name from a list (`scripts/copy-vendor.mjs`): V8
  had thrown that code away and made it again 90 times a second, and the code it threw away filled the heap to a full
  collection every 45 s. (Mirage, 8 minutes with the bots playing: 584 minor collections and 12 full ones, the longest
  35 ms, before; 108 and 3, the longest 12 ms, now, and 29% more frames.)
  `cl_showfps 2` (or `net_graph 1`, or Show fps in the settings) graphs each frame's time: a stutter is a red spike.
  `net_graph 2` also splits the frame (the bots' AI, their bodies, drawing, the HUD) and shows what the match holds
  (bodies shown, guns down, textures, geometries, the heap): what grows when it gets slower. With `net_graph 2` on,
  the match is logged as it's played (`src/js/play/framelog.js`). Each second gets a line: frame times, the game's work
  and its parts, the GPU's drawing time (timer queries), the wait between frames, garbage collections (the heap is
  precise), and what's drawn and held. Each slow frame (over 30 ms and 1.8× the usual) gets its own line: its time split
  into the frame before's work and the wait after it, plus what came with it (shaders compiled and what for, textures added, a
  collection, the browser's long frames and the scripts in them, the game's events just before). The log ends with a
  table per round and a summary. It's saved to `userData/netgraph-logs` as soon as it starts, after every round, when
  the match ends and when you leave (the console and the end screen say where); `net_graph_log` saves it on the spot
  and opens its folder. `net_graph 2` stays on for your next matches. `CS2SIM_SMOKE=rounds`
  plays round after round (`CS2SIM_SMOKE_PLAY=1`: you buy, fire and throw too) and logs each round's frame cost, freeze
  time measured from the same spot every round, next to everything that could pile up, then net_graph 2's log of it.
  `CS2SIM_SMOKE=hitch` plays rounds on Dust II, Inferno and Nuke and logs every frame over 33 ms with what ran in it,
  how often each kind of event (a bot's shot, damage, a kill...) comes before a slow frame against before any, slow
  frames and long waits by the round's phase, and every shader compiled mid-match with what it was for and what in its
  key made it new (`CS2SIM_SMOKE_BUYMENU` buys with the buy menu open, `CS2SIM_SMOKE_BREAK` breaks every breakable;
  `CS2SIM_SMOKE_PROFILE` and `CS2SIM_SMOKE_ALLOC` add a CPU and an allocation profile (with who calls the builtins that
  allocate; `CS2SIM_SMOKE_ALLOC_CALLERS`, a regex, picks others), with the long waits between
  frames on their own; `CS2SIM_SMOKE_LIVE` what the JS heap holds once the map is loaded, against the array buffers
  held outside it, and how long a full collection takes; `CS2SIM_SMOKE_TRACE=<round>` a Chromium trace of that round's
  freeze time, every process, `CS2SIM_SMOKE_TRACE_LIVE=<round>` of all of it, `CS2SIM_SMOKE_GCTRACE` of only V8's
  collections through the run, counted; `CS2SIM_SMOKE_JSFLAGS` passes V8 flags; `CS2SIM_SMOKE_TAB=1` holds Tab through freeze time, `=tap` presses it four times a
  second; `CS2SIM_SMOKE_NOGC` drops the game's own collections). There's no full collection at a round start (it held
  the game up 100 ms to 360 ms every round; V8's own, marking alongside the game, don't), the rank emblems on the
  scoreboard are pictures (CS2's are SVGs of a thousand paths and gradients each: bringing the scoreboard up redrew
  them on the GPU for 85 ms) and so are the weapon icons in the buy menu, the kill feed and the weapon list, a sound in
  the world goes through a voice (its muffling, its share of the room, its HRTF panner) the next sound uses again
  (with a node each per sound, Chromium deleted them all in one go after a full collection, 32 ms between two frames),
  and every reverb the map uses is made as it loads (a convolver works its impulse
  response over as it gets it, 7 ms a second of it: walking into another room was a 25 ms hitch). `CS2SIM_SMOKE=botfire` stops
  the bots and times one thing at a time: bots firing at nothing or at the floor, bots or you taking damage, Tab held
  (`+mute`, `+noradio`, `+noflinch`, `+nohud` on a phase turn one part off). The scoreboard is made again only when
  something on it changes (holding Tab took frames from 7 ms to 54 ms on average; now it doesn't).
- Movement ported from Source's: CS2's acceleration, friction, air strafing, 18-unit steps, jumping (no auto bunny
  hop), crouching, crouch-jumps (66 units: short of a standing player's head, onto a crouching one's), walking and
  ladders, with the weapon's own speed; footsteps by surface. Players are solid to each other: you stop at them (you
  don't climb them).
- Weapons use CS2's data from `scripts/weapons.vdata` (damage, range falloff, armor penetration, fire rate,
  magazine, inaccuracy, spread, recovery, burst and reload timings) with Source's recoil (each gun's recoil seed, aim
  punch and view punch), CS2's viewmodel animations (draw, idle, shoot, reload, inspect, silencer, knife slashes and
  stabs) and CS2's sounds. Scoped rifles zoom with CS2's zoom levels.
- Bots are CS2 agent models with per-bone hitboxes (head, chest, stomach, arms, legs) and armor.
- Keys (rebindable in the settings, or with bind in the console): WASD, Space, Ctrl (or C) crouch, Shift walk, Mouse1/Mouse2, R, F inspect, B buy, E defuse/pick up,
  G drop, 1/2/3 (3 again for the Zeus), 4 (grenades), 5 (the bomb: hold Mouse1 in a site to plant), Q and the mouse
  wheel switch weapons, Z/X/V radio, Tab scores, Esc menu (the match goes on). Mouse sensitivity uses CS2's scale, so your CS2 sensitivity
  feels the same.

## Features
- Money comes from playing matches in Play: a win or a draw pays $250, a loss $100, and every kill $20 and assist $10
  (online too, for a match the server saw start, once, and only what it could have earned). There's no clicker or
  passive income
- Profile levels like CS2's: 5,000 XP a level, from 1 to 40 (a win or draw is 250 XP, a loss 100, each kill 20, each assist
  10 and each round your team wins 50). Past level 40 you earn the next Service Medal and start again at level 1: every
  colour of the 2026 medal first, then 2025's, back to the first ever (2015's), 69 in all. Your level, XP bar and medal
  sit in the top bar (CS2's own level icons and medal art from your install; Steam's pictures without it), and the
  profile shows every medal. Each level up brings a care package like CS2's: four items from its drop pool (the six
  newest weapon cases and the timed-drop collections) to keep two of
- Cases you buy go to your inventory, like CS2's store, and open with their own key (bought apart, $2.49: the Fever Case
  Key for the Fever Case, the CS:GO Case Key for the first ones). Open them on the case's page (it shows how many cases
  and keys you have) or from the inventory; auto open uses yours first, then buys a case and a key for each opening
- Storage Units, like CS2's: a $1.99 tool from the store (Cases, Tools, or the inventory) that can't be traded or sold.
  Label it when you start using it (change the label for free), then move up to 1,000 items in and out, one at a time or
  in bulk. A unit counts as one item in your inventory and shows how much it holds and when it last changed; its window
  searches, sorts and filters by rarity. What's inside can't be traded, sold, staked, equipped, stickered or used in a
  trade-up until it comes out, but still counts toward your net worth and in the Item Database. An empty unit can be
  deleted, for no refund
- NPC players (offline): 2,000 made-up CS2 players with their own inventories and money; 66 of them are active traders.
  Normal players buy on the Market (its stock goes for you too) and trade at about market price. 20 are collectors,
  each chasing one kind of item (Dopplers, blue gems, fades, low floats, serial numbers, Katowice-era stickers,
  Souvenirs, StatTrak™ knives, AWPs, gloves, charms, knives; the most traded kinds have two, who bid against each other)
  and paying well over market for it (a #1 blue gem might fetch 1.5-2x). Beginner traders (10 active, about 400 in all)
  are new to it: they go by an item's plain price for its name and wear (a float, a pattern, stickers or a serial don't
  register, theirs or yours), misjudge some skins, believe most of what you tell them and ask a lot of questions; some
  own a lucky unbox worth far more than they think. When you own something they want, they message you with cash or
  trade offers: accept, decline or haggle, with a price and an argument (the float, the pattern, the stickers, the
  serial, the market price, another buyer; a false claim or a bluff they see through annoys them, and too many counters
  make them walk away), or just type ("would you do $500? it's a 0.01 float"). Items you sell sometimes end up in their
  inventories. Everyone owns part of the world's items: offline, the Item Database shows every copy they own (about
  63,000 of 2,100 items) and yours, with float ranks among all of them; click an owner to visit their profile, add them
  or make an offer. They are also the bots in Play (offline): names, countries and avatars
- Friends & Chat like Steam's (the people icon at the top): friends by status (In-Game, Online, Offline), friend requests,
  chats, and profiles with level, Service Medal, item showcase, comments (+rep after trades) and their whole inventory,
  to make them an offer from. Your own profile: name, avatar (any agent), country, summary, a CS2 map behind it and up
  to six items to show off
- 42 real weapon cases, 150 souvenir packages (each Major's team stickers and gold MVP autographs), packages
  (X-Ray, Anubis, Genesis/Dead Hand Terminals), 229 sticker/autograph capsules and an Agent Locker
- All 94 weapon collections (e.g. Cobblestone with the Dragon Lore), browsable with odds and prices
- Trade Up Contracts with CS2's rules: 10 skins of one rarity, ticket-based odds per collection, normalised output
  floats, StatTrak contracts, and 5-Covert contracts into a knife or gloves
- The Armory: Armory Stars (Armory Pass, or earned by buying cases and keys) spent on drops from featured collections that
  rotate every 10-15 minutes, and on the four charm collections (always available)
- Charms: all 78 of CS2's charms (Missing Link, Missing Link Community, Small Arms and Dr Boom), from the Armory or the
  Market, one per gun (Souvenirs too), hung anywhere on it. Each has a pattern from 1 to 100,000 that sets its colours and how it hangs; low and special ones (#1, the top 10, the
  top 100, #77777...) are worth more. A gun is worth its charm too; taking one off uses a Charm Detachment (a pack of 3
  for $0.99). Sticker Slabs turn any sticker into a charm (the sticker plus $0.44, the cheapest slabs' going rate)
- Gambling (virtual money, no house edge, provably fair with a verify button): case battles (1v1 to 2v2, normal or
  crazy), coinflip and jackpot, against bots or, online, other players
- Online play (optional): accounts on your own server, trading between players, live lobbies; see DEPLOY.md
- Item Database (like CSFloat's): search every skin, knife, glove, sticker, charm and agent in the game; open one to
  see every copy that exists with its owner, float, seed, pattern and stickers (online: everyone on the server;
  offline: you and the NPC players, each owner a link to their profile), its float rank (#1-#3 lowest and highest, StatTrak™ and Souvenir copies ranked apart), the
  guns a sticker is applied to, and a skin's current Market listings. Your own top floats carry the same #1-#3 badge
  in your inventory and the item details (a lone copy has no rank)
- Rare Special Items (knives and gloves) show CS:GO's classic gold "?" medallion in case contents and the roulette
- Serial numbers on everything you unbox (cases, packages, capsules, the Armory, case battles), counted per item in
  unboxing order (offline in your save, online across the whole server). Market buys and trade-ups have none; unboxed
  items are worth 3% more, with bigger premiums for #1, the top 10 and top 100, and special numbers (#69, #420, #777,
  #1337, #111, #1000...)
- Floats (CS2 wear distribution), pattern seeds 0-1000 with rare patterns (blue gems, Fire & Ice, full fades, Doppler phases...)
- StatTrak™, knives and gloves, stickers with free placement, scraping, and craft bonuses
- Loadout (Inventory → Loadout, or Equip on an item): gloves, knife, a T and a CT agent, and one skin per gun
- 3D inspect (drag, zoom, F to inspect, B to flip)
- Market prices blended from Skinport, CSFloat, Buff163 and YouPin (Steam as fallback); refresh in Stats & Settings

## Develop
```
npm install
node node_modules/electron/install.js   # npm 11+ blocks Electron's download step
npm run data      # rebuild src/data/game-data.json (add --refresh via `npm run data:refresh` for fresh downloads)
node scripts/build-extras.mjs   # rebuild src/data/keys.json (which key opens which case) and medals.json (Service Medal pictures)
npm run vendor    # copy three.js into src/vendor (with the patch in scripts/copy-vendor.mjs)
node scripts/build-charm-pics.mjs   # rebake charm pictures from CS2's files (src/img/charms, src/data/charm-looks.json): when charms or their shader change; --check <dir> compares them with the 3D charm
npm start         # run the game
npm run dev       # browser preview at http://localhost:5178
npm run dist      # build dist/CS2-Case-Simulator-Setup.exe, dist/CS2-Case-Simulator.exe and dist/latest.json (a release: see DEPLOY.md)
node scripts/test-engine.mjs            # game rule checks (odds, trade-ups, armory, gambling, NPCs)
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
