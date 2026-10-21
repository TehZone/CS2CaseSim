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
`%APPDATA%/cs2-case-sim/cs2cache`. Nothing from the game is bundled with the app. Gloves (a different CS2
shader) and agents still use the icon-based 3D view. Without CS2 installed, everything falls back to that view.

## Features
- 42 real weapon cases, 229 sticker/autograph capsules, an Agent Locker and a Chicken Coop Crate, with Valve's published odds
- Floats (CS2 wear distribution), pattern seeds 0-1000 with rare patterns (blue gems, Fire & Ice, full fades, Doppler phases...)
- StatTrak™, knives and gloves, stickers with free placement, scraping, and craft bonuses
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
node scripts/cs2/dev-index.cjs           # build the CS2 index from your install (dev)
node scripts/cs2/dev-prepare.cjs weapon_ak47 aq_oiled   # extract one skin's assets (dev)
```
`tools/s2v` holds the patched Source 2 Viewer CLI (adds GLSL ES output with combined samplers so CS2's
shaders run in WebGL); rebuild it from the ValveResourceFormat sources with the `VRF_GLSL_ES` patch if needed.
