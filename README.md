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
`%APPDATA%/cs2-case-sim/cs2cache`. Nothing from the game is bundled with the app. Gloves are shown on CS2's
glove model, both hands on CS2's own glove inspect pose, with the skin baked per hand by CS2's glove compositing
shader (csgo_customglove). Agents still use the icon-based 3D view. Without CS2 installed, everything falls back to
that view.

With CS2 installed the inspect also offers:
- **Backdrops**: the same map scenes CS2 shows behind the menu and item inspect (Dust II, Mirage, Inferno, Ancient,
  Anubis, Nuke, Overpass, Train, Vertigo, Italy, Office...), placed where CS2 shows items and blurred like the game.
- **First person** (V): CS2's own inspect animation for that weapon or knife, on CS2's first-person arms, with your skin
  and stickers. Gloves equipped in your **loadout** are worn on the hands, like in game.
- **Sticker effects**: Holo, Foil, Gold, Glitter, Lenticular and Embroidered stickers use CS2's own sticker materials.

Opening a case also plays CS2's own crate: the case's 3D model drops in, lands and unlocks with the game's "fall" and
"open" animations and sounds before the roulette (weapon cases and recent souvenir packages; containers without a 3D
crate, or without CS2 installed, drop in as their icon). Turn it off under Settings → Case drop animation.

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
cd server && npm install && cd ..       # multiplayer server dependencies
PGLITE_DIR=server/.data node server/index.mjs   # run the server locally (port 8787)
node server/test.mjs                    # server checks (accounts, trading, live gambling, restarts)
node scripts/cs2/dev-index.cjs           # build the CS2 index from your install (dev)
node scripts/cs2/dev-prepare.cjs weapon_ak47 aq_oiled   # extract one skin's assets (dev)
```
Game rules live in `src/js/engine` and are shared by the game and the server (`server/`), so offline and online
play follow the same code. `tools/s2v` holds the patched Source 2 Viewer CLI (adds GLSL ES output with combined samplers so CS2's
shaders run in WebGL); rebuild it from the ValveResourceFormat sources with `tools/vrf-glsl-es.patch` applied (the exe is not in git).
