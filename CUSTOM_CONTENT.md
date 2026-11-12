# Custom content: your own skins, knives, gloves and cases

You can add skins, knives, gloves and cases of your own to the game. They ship to every player with an update and work
everywhere real ones do, offline and online: opening, the case's 3D crate, the inventory, inspect (the knife's and the
gloves' own 3D views, first person), loadout and equip, Play mode's viewmodels, trading, selling, the Market, NPC traders,
trade-ups, the Index, the Item Database, auto-sell, case battles, the admin panel and the Discord drop posts.

What ships is pictures and textures you made, plus a little data. Nothing of CS2's ships. As for every skin today, 3D
inspect is drawn from the player's own CS2 install: the weapon model and CS2's own finish template come from there, and your
textures go on top. Without CS2, players still see your 2D pictures everywhere.

**Contents**

1. [How it fits together](#1-how-it-fits-together)
2. [Try the example pack](#2-try-the-example-pack)
3. [Making a custom skin (guns)](#3-making-a-custom-skin-guns)
4. [Knives](#4-knives)
5. [Gloves](#5-gloves)
6. [Making a custom case](#6-making-a-custom-case)
7. [Prices](#7-prices)
8. [Building, testing locally and releasing](#8-building-testing-locally-and-releasing)
9. [Renaming and removing items](#9-renaming-and-removing-items)
10. [Steam Workshop finishes](#10-steam-workshop-finishes)
11. [What isn't done yet](#11-what-isnt-done-yet)
12. [Reference: skin.json and case.json](#12-reference-skinjson-and-casejson)

---

## 1. How it fits together

```
custom/                                   your packs: the sources (not shipped)
  skins/AK-47 - Nebula/                   one folder per item, named after it
    skin.json                             what it is: rarity, float range, prices, finish
    color.png                             its texture(s)
    icon.png                              its picture in the game
  skins/Karambit - Aurora/ ...
  skins/Sport Gloves - Circuit/ ...
  cases/My Case/
    case.json                             what's in it, its price, its key
    case.png                              its picture
    crate.png                             its 3D crate's emblem (optional)
  ids.json                                written by the build: every item it has made (keep it)
custom-staging/                           Workshop finishes the importer made, waiting (not built, not in git: section 10)

npm run custom                            checks everything and builds it into the game:
  src/data/custom.json                    the definitions (client and server read the same file)
  src/custom/<item id>/*.png              textures and pictures (shipped)
```

- Windows can't put `|` in a folder name, so a folder is named with ` - ` where the item has ` | `:
  `AK-47 - Nebula` is `AK-47 | Nebula`. A `"name"` in skin.json always wins over the folder's.
- Knives and gloves get their `★ ` by themselves.
- Every item gets a fixed id made from its name (`skin-cx-…`, `crate-cx-…`). Rebuilding never moves anyone's items. Real
  ids never contain `cx`, so a custom id can't be a real one, and the build refuses any custom name that a real item has.

**The data lock.** The game and the server refuse each other unless their game data matches. That match is `D.lock`:

- **With no custom content, the lock is exactly the game data's own `generatedAt`** (`2026-10-25T01:46:47.726Z` today).
  So 1.1.3, which sends that, keeps connecting.
- With custom content, the lock is `<generatedAt>+cx.<hash>`. Both the game and the server work the hash out from what
  defines the custom items: ids, names, weapons, rarities, float ranges, StatTrak™, phases, the Fade rule, collections and
  case contents. `D.generatedAt` itself never changes.
- Prices, pictures and textures aren't part of the lock. New prices reach games through the server's price patch, and a
  new texture doesn't change what an item is.
- So pushing this code changed nothing for players. The example pack lives in `docs/custom-example/`, not in `custom/`.
  `scripts/test-custom.mjs` checks this.
- **Pushing custom content doesn't lock anyone out either.** The build stamps the game version the content ships in, and
  the live server runs content with a new lock only once that version's release is published. Until then it runs what
  the published release has (section 8).
- **Badges** (CS2's collectibles and the Collectible Pins Capsules, `src/data/badges.json`, built by
  `node scripts/build-badges.mjs --app <version>`) are part of the lock the same way: `+bd.<hash>` after the rest, made from
  what defines them (src/js/engine/badgedata.js), and released the same way. The file says the version it ships in (`app`,
  1.1.6 for the first badges), and the live server runs badges with a new lock only once that release is published
  (`badgeGate` in server/index.mjs; `/health` shows `badgesWait` and `badgesLock` meanwhile). So the release that ships
  them must be that version or newer. What ships with the first badges waits with them: until that release is out the
  server keeps 1.1.5's rules, 20 Storage Units at most and $100 a minute of passive income whatever the prestiges
  (`HELD_RULES` in server/index.mjs).

## 2. Try the example pack

`docs/custom-example/` holds one of each:

- AK-47 | Example Nebula: Custom Paint Job
- M4A1-S | Example Circuit: Hydrographic
- ★ Karambit | Example Aurora: Anodized Airbrushed, with the Fade pattern rule
- ★ Sport Gloves | Example Circuit: `"mode": "color"`, a picture over the whole pair. The picture is a plain diagonal stripe,
  so it shows how a picture goes on. It isn't painted to the gloves' UV layout, so its stripes run across the seams and
  fingers. Section 5 says how to paint one that follows the layout.
- Example Case: two custom guns, four real Mil-Specs and two real Restricteds. Its gold slot holds the custom knife, the
  custom gloves and the real ★ Karambit | Doppler (all its phases). Its crate is the Kilowatt Case's, with its own emblem.
  Its `case.png` is a simple flat box, so it doesn't look like that orange crate. For a case of your own, draw `case.png`
  after the crate you pick (section 6).

Its textures are drawn by `docs/custom-example/make-textures.mjs` from noise and shapes. The item pictures were rendered
from the 3D with `scripts/bake-custom-icons.mjs`.

To see it in the game without touching the real build (the same commands in cmd and PowerShell):

```
node scripts/build-custom.mjs --src docs/custom-example --try
```

`--try` builds into a try-out folder of its own (`cs2sim-custom-try` in your temp folder) and prints the commands to use it,
with that folder's full path:

- `npm start -- --custom "<folder>"`: the game with it. A try-out plays on a save of its own (`CS2 Case Simulator-custom`
  beside the usual one), never the installed game's. `--custom` (or `CS2SIM_CUSTOM`) is read only by a development copy,
  never by a packaged game. The Example Case is in Weapon Cases.
- `npm run dev -- --custom "<folder>"`: the browser preview.
- `node server/index.mjs --custom "<folder>"`: a local server with it, to try it online. Then point the development copy
  at it: press F12 for its DevTools and, in the Console, run
  `(await import('/js/net/online.js')).net.setServerUrl('http://localhost:8787')`. The try-out's save keeps that. Against
  the real server a development copy with the example has a different lock, so it's refused, as it should be.

Nothing of this touches `src/`.

To make it real, copy the folders from `docs/custom-example/skins` and `docs/custom-example/cases` into `custom/` and build
(section 8).

## 3. Making a custom skin (guns)

### 3.1 Pick a style

Each style is CS2's own: the game takes CS2's Workshop template for it from the player's install
(`workshop/paintkits/templates/`, the same files CS2's Workshop tools build finishes on), puts your textures and values
into it, and runs CS2's own finish shader at the item's float and seed.

| `"style"` | What your `color.png` is | Colours | The seed moves it | Checked in 3D |
|---|---|---|---|---|
| `Custom Paint Job` | The finished picture, painted on the gun's UV layout | none (the picture is the colour) | no (it can) | yes |
| `Patina` | A picture on the UV layout that CS2 ages and tints like metal | 4: base metal, patina tint, patina wear, grime | no (it can) | yes |
| `Gunsmith` | A picture on the UV layout, mixed with bare metal by the mask | 4: base metal, patina tint, patina wear, grime | no (it can) | yes |
| `Hydrographic` | A tiling mask: black = colour 1, red = 2, green = 3, blue = 4 | 4 | offset (and rotation if you allow it) | yes |
| `Spray-Paint` | A tiling mask as Hydrographic, sprayed from three sides | 4 | as Hydrographic | yes |
| `Anodized Multicolored` | A mask as Hydrographic, on anodized metal (Doppler, Gamma Doppler) | 4 | as Hydrographic | yes |
| `Anodized Airbrushed` | A smooth mask, airbrushed from three sides (Fade, Amber Fade) | 4 | as Hydrographic | yes |
| `Solid Color` | none: the gun's own parts take the colours | 4 (by the gun's masks) | — | yes |
| `Anodized` | none | 1 | — | yes |

"Checked in 3D" means a pack in that style was rendered on its CS2 model through the game's own 3D code and looked right.
Patterns repeat across the gun. "Painted on the UV layout" means the picture is laid onto the model's own UV layout, like a
Custom Paint Job.

### 3.2 The files

Put them in the skin's folder. PNG (8 or 16 bit, RGB or RGBA, not interlaced) or TGA (24 or 32 bit, or 8-bit greyscale,
as Workshop authors use). Use square powers of two, 1024 or 2048. Anything bigger ships at 2048. A Workshop finish's own file names work too
(`<name>_color.tga`, `_normal`, `_rough`, `_pearl`, `_ao`, `_masks`).

| File | What it does | Channels |
|---|---|---|
| `color.png` | The style's main texture (table above). Required, except for Solid Color and Anodized | RGB as the style says, alpha below |
| `normal.png` | Replaces the gun's own normal map | A tangent-space normal map, green up (OpenGL style, which is how the game's 3D reads it). If the bumps look pushed in rather than out in the inspect, it's DirectX style: add `"flipNormalGreen": true` |
| `roughness.png` | The paint's roughness | grey: black is glossy, white is matte |
| `pearlescence.png` | Where pearlescence shows (with `"pearlescence"`) | grey: white is pearlescent |
| `ao.png` | Replaces the gun's ambient occlusion | grey |
| `masks.png` | Replaces the gun's own paint-by-number masks | Hydrographic, Spray-Paint, Solid Color: green and blue mark where colours 3 and 4 go as flat areas. Anodized: red. Gunsmith: white is patina metal, black is your paint. Patina: the patina mask |
| `icon.png` | Its picture (section 3.6) | RGBA, transparent background |

`normal.png` and `ao.png` replace the gun's own maps whole. Start them from the gun's, which
`node scripts/custom-reference.mjs <gun>` exports (3.4), and paint your changes on top.

**The alpha of `color.png`** is how the paint wears. This was read from CS2's own shader:

- **255 (opaque)**: the paint wears as usual with the float.
- **0 to 127**: tougher. The lower, the tougher, and 0 never wears. In Gunsmith and Anodized Multicolored, alpha under 128
  also sets the paint's roughness: 0 is matte, 127 glossy.
- **153 to 230 (60 to 90%)**: no paint there at all. The gun's own material shows, at any float. This is what Valve's
  docs mean by "wears off quickly".
- 128 to 152 and 231 to 254 blend between those.
- Patina ignores alpha.

Leave alpha at 255 unless you want one of those effects.

### 3.3 Colours and placement

In `"finish"`:

- `"colors"`: up to 4 colours (`"#1b1b2f"` style), in the order of the table above.
- `"scale"`: how big the pattern is (1 is the template's size; 2 is twice as many repeats).
- `"rotation": [from, to]`: in degrees, either way round (CS2's own kits have both). Each item's seed picks a rotation in
  that range. `[0, 0]` fixes it.
- `"offset": [[minX, minY], [maxX, maxY]]`: -1 to 1. Each seed picks an offset in that box. That is what makes every
  pattern seed (0 to 1000) of a Hydrographic look different.
  - Defaults: a Custom Paint Job, Patina or Gunsmith is fixed (`[0, 0]` and `[[0,0],[0,0]]`), which is what a UV-painted
    picture needs. Pattern styles get a random offset over the whole tile (`[[0,0],[1,1]]`) and no rotation.
- `"ignoreWeaponSize": true/false`: pattern styles are scaled by the gun's size so a tile is the same size on a pistol and a
  rifle. `true` turns that off.
- `"roughness"`: the paint's roughness, 0 to 1, when there's no roughness.png.
- `"pearlescence"`: how much the colour shifts at grazing angles (Doppler phases use about 0.2).
- `"model"`: `"hd"` paints CS2's model (the default) and `"legacy"` paints the CS:GO one. They have different UV layouts, so
  paint on the one you pick.
- `"params"`: anything else the template exposes, by its CS2 name, for example
  `{ "exposed_params.g_vSprayBlend": [0.5, 1], "exposed_params.g_flPaintRoughness": 0.3 }`. The names are in CS2's
  `resource/toolhelp_cs2_item_editor_english.txt` and in the Workshop tools.

### 3.4 Where to paint: the UV layout

A Custom Paint Job, Patina or Gunsmith is painted on the model's UV layout. Two ways to get it:

- **Valve's meshes.** Valve publishes the CS2 weapon models as .obj files for the Workshop at
  counter-strike.net/workshop/workshopresources. Import one into Blender or Substance Painter and paint on it in 3D. Those
  are CS2's own models (`"model": "hd"`). The UVs follow the usual .obj convention (v up), which is what the game expects:
  a picture exported from your painting program goes in as it is.
- **From your own CS2 install:** `node scripts/custom-reference.mjs AK-47` writes into `custom-reference/AK-47/`:
  - the UV wireframe of both models (`AK-47_hd_uv.png`, `AK-47_legacy_uv.png`, 2048 px, islands shaded)
  - each model's own maps in its layout, named for it: `AK-47_hd_normal.png` and `AK-47_legacy_normal.png` (what a
    `normal.png` starts from), and `_hd_ao`, `_legacy_ao` (ambient occlusion in the red channel), `_legacy_color`
  - the CS2 model's composite inputs, as CS2's finish shader reads them: `AK-47_hd_color`, `_hd_ambientocclusion` (what
    an `ao.png` replaces), `_hd_masks` (what a `masks.png` replaces), `_hd_metalness`, `_hd_surface`
  - the model itself (`.gltf` with its `.bin` and textures under CS2's own file names), to open in Blender or Substance
  These are CS2's files for your reference: keep them out of your pack (`custom-reference/` is ignored by git).

Paint at 2048×2048 with the wireframe as a layer and leave it out of your export. Pixels outside the islands don't
matter. The layout fills the whole square: (0,0) is the top left of the picture.

### 3.5 Rarity, wear and StatTrak™

- `"rarity"`: Consumer, Industrial, Mil-Spec, Restricted, Classified or Covert. A case holds Mil-Spec to Covert.
- `"float": [min, max]`: the item's float range, like CS2's (an AK-47 | Redline is `[0.1, 0.7]`). Floats are rolled like
  CS2's. A range of `[0, 0.08]` only ever drops Factory New and Minimal Wear.
- `"stattrak"`: `true` (the default for guns and knives) lets case drops be StatTrak™ (10%, like CS2).

### 3.6 Its picture

`icon.png` is how the item shows everywhere in 2D: inventory, cases, Market, trades. Any size, with a transparent
background like Steam's. It's fitted to 512×384 and 1024×768. Draw it yourself, or let the game draw it from the 3D:

```
node scripts/bake-custom-icons.mjs
```

That renders every item that has no `icon.png` on its real CS2 model (side on, like Steam's pictures) and writes the
`icon.png` into its folder. You keep that file, or paint over it. It needs your CS2 install. Players don't need one: the
picture ships with the game. Use `--force` to draw them all again, and `--shots <dir>` to also save pictures of each
custom case's 3D crate for checking. `"iconSeed"` and `"iconFloat"` in skin.json pick the seed and float it's drawn at.

### 3.7 A complete skin.json

```json
{
  "name": "AK-47 | Nebula",
  "rarity": "Classified",
  "float": [0, 0.7],
  "stattrak": true,
  "prices": { "FN": 42.5, "MW": 24, "FT": 15.75, "WW": 13.2, "BS": 11.4 },
  "finish": { "style": "Custom Paint Job", "model": "hd", "roughness": 0.45 }
}
```

## 4. Knives

A custom knife is a finish on a knife's model, built the same way as a gun's (section 3), with the same styles and files.

- Its name is the knife's name: `Karambit - Aurora` → `★ Karambit | Aurora`. Any of CS2's knives works (Karambit, Butterfly
  Knife, M9 Bayonet, Bayonet, Talon Knife, Skeleton Knife, Kukri Knife...). It's always ★ Covert, with StatTrak™ unless
  you say `"stattrak": false`. A StatTrak™ knife has its counter etched on the blade, as in CS2.
- **Where to paint:** a knife has one model with one UV layout (no hd/legacy choice):
  `node scripts/custom-reference.mjs Karambit` writes `Karambit_uv.png`, the knife's own `Karambit_normal.png` and
  `Karambit_ao.png`, and its composite inputs (`Karambit_color`, `_ambientocclusion`, `_masks`...), with no hd or legacy in
  their names. Valve's Workshop downloads cover the guns. If yours has no
  knives, use this tool.
- **How CS2's knife finishes are made**, as recipes:
  - **Fade:** `Anodized Airbrushed`. `color.png` is a smooth gradient: the red, green and blue layers fade into each other
    along the blade. A `"rotation"` range such as `[-65, -55]`, a fixed `"offset"` (`[[0.1, 0.2], [0.1, 0.2]]`: CS2's own
    Fades fix it too), the 4 colours of the fade, and `"patternRule": "Fade"` so each seed gets a fade percentage, and the
    labels and value that go with it (99.5% and up is a Full Fade, worth 1.5×; from 98% 1.2×, from 95% 1.07×, under 85%
    0.92×).
    - **The percentage is the rotation the seed turns the pattern to**, the same roll the 3D makes: 80% at the range's
      first angle, 100% at its second. That's how CS2's own Fades work: the CS.MONEY Wiki's percentage for every seed of
      the real Karambit | Fade is exactly that (`scripts/test-custom.mjs` checks it). So seeds that look alike get the same
      percentage.
    - Look at a few seeds in inspect. If the fullest-looking blade is at the first angle, swap the two (`[-55, -65]`).
    - The build refuses a Fade whose offset moves with the seed (the blade would change without its percentage) or whose
      rotation is fixed.
  - **Doppler and its phases:** `Anodized Multicolored`. `color.png` is a cloudy mask (CS2's is a smoke texture),
    `"scale": 1.6`, `"rotation": [-70, -50]`, `"pearlescence": 0.2`. Each phase is its own folder with the same `"name"`
    and its own `"phase"` (`"Phase 1"` … `"Ruby"`), colours and prices. All the phases share one gold slot in a case and
    drop by `"phaseWeight"` (default: CS2's Doppler shares, Phase 1 to 4 at 22% each, Ruby and Sapphire 4.5%, Black Pearl
    3%). Phases are for knives and gloves only: in a case's pool every phase of a gun would drop as often as a skin of its
    own, so the build refuses `"phase"` on a gun. Make each look its own skin instead.
  - **Marble Fade:** `Anodized Multicolored` with a marbled mask and `"offset": [[0,0],[0,0]]`, with only the rotation left
    to the seed.
  - **Tiger Tooth:** `Anodized Multicolored` with a striped mask.
  - **Case Hardened:** not as such yet (section 11). The nearest is `Patina` with blue and gold colours.
  - **Lore-style artwork:** `Custom Paint Job` painted on the knife's UV layout.
- A custom knife never gets the real finishes' named patterns (Blue Gem, Fire & Ice, Max Pearl...), whatever it's called:
  those belong to CS2's own patterns. The only rule it can have is `"patternRule": "Fade"`. NPC collectors go by that too:
  the Doppler collector and the blue gem hunter never take a custom finish for theirs, and the Fade collector takes one
  only with the Fade rule.

## 5. Gloves

Gloves can be made properly, and look like CS2's. A custom pair is a CS2 glove kit of that type (its leather, fabric,
stitching, normal map, damage and grime) with your picture on it, through CS2's own glove shader, on both hands.

- **Types:** Sport Gloves, Driver Gloves, Hand Wraps, Moto Gloves, Specialist Gloves, Hydra Gloves, Bloodhound Gloves, Broken
  Fang Gloves. The folder is `Sport Gloves - Circuit`, which makes `★ Sport Gloves | Circuit`.
- Always ★ Extraordinary, never StatTrak™ (as in CS2). Like CS2's gloves they have no finish style ("None" in their
  details) and no Fade rule.
- **The file:** `pattern.png` (or `color.png`), up to 2048, RGB.
- **Where to paint:** each type has its own UV layout, and **both hands share it** (the left glove is the right one
  mirrored). The example pack's gloves don't follow one (their stripes are a plain tile, section 2): a picture made for a
  pair follows its layout. `node scripts/custom-reference.mjs "Sport Gloves"` writes `Sport_Gloves_uv.png`, the right
  glove's layout:
  back of the hand, palm and fingers as separate islands. It also writes the type's own textures in that layout:
  - `_layermask`: which of the glove's 4 materials is where. Red, green, blue and alpha are layers 1 to 4.
  - `_normal`: the stitching and seams.
  - `_surface`: the ambient occlusion.
  Paint over those and the picture lines up with the seams. Gloves aren't in Valve's Workshop downloads, so this tool is
  the way to get the layout.
- **How the picture goes on** (`"mode"` in `"finish"`):

| `"mode"` | What it does |
|---|---|
| `"color"` (default) | Your picture is the gloves' colour, all over. The leather and fabric keep their own feel, shading and wear. |
| `"color-layer"` | Your picture only on one material layer (`"layer": 1` to `4`, by the layer mask). The rest keeps the base kit's look. |
| `"mask"` | Like CS2's patterned gloves: red, green and blue of your picture pick tints (`"tints"`: up to 8 colours, `"palette"`: which 4 of them). |
| `"mask-layer"` | The same on one layer only. |

- `"scale"`, `"rotation": [min, max]` and `"offset"` repeat and place the picture the way a pattern is placed. For a picture
  painted on the UV layout, keep the defaults (1, `[0,0]`, `[[0,0],[0,0]]`). CS2's own patterned gloves use a scale of 4 to
  10 and a random offset.
- `"base"`: which CS2 kit of that type to start from (its leather, colours and stitching show through). Defaults:

  | Type | Default base |
  |---|---|
  | Sport | `sporty_light_blue` |
  | Driver | `slick_military` |
  | Hand Wraps | `handwrap_red_slaughter` |
  | Moto | `motorcycle_basic_black` |
  | Specialist | `specialist_ddpat_green_camo` |
  | Hydra | `bloodhound_hydra_snakeskin_brass` |
  | Bloodhound | `bloodhound_guerrilla` |
  | Broken Fang | `operation10_snakeskin_black` |

  Any of CS2's classic kits of the same type works. The newest kits (`glove_sport_*`, `glove_driver_*`,
  `glove_specialist_*`) are built differently and can't be a base.
- `layermask.png` (optional) replaces the type's layer mask, so you can move the materials around.
- `"mirror": true` mirrors the picture on the left hand, as CS2 does for its own patterns. By default both hands show it as
  you painted it.
- Limits: the glove's shape, stitching and normal map stay the type's own. A custom normal map isn't supported.

## 6. Making a custom case

```json
{
  "name": "My Case",
  "price": 2.95,
  "key": true,
  "date": "2026-11-11",
  "collection": "The My Collection",
  "items": {
    "Mil-Spec": ["Dual Berettas | Hideout", "MAC-10 | Light Box"],
    "Restricted": ["M4A1-S | Circuit", "Glock-18 | Block-18"],
    "Classified": ["AK-47 | Nebula"],
    "Covert": ["AWP | My Dragon"]
  },
  "rare": ["★ Karambit | Aurora", "★ Sport Gloves | Circuit", "★ Karambit | Doppler", { "from": "Kilowatt Case" }],
  "crate": { "base": "Kilowatt Case" }
}
```

- **Its name:** any name that isn't a real case's or collection's, or one the game already uses for where an item came
  from (Agent Locker, Market, Trade, Trade Up Contract, Level-up reward, Collection, Unboxed, Admin, Store, Armory, and
  anything starting with "Armory" or "Trade with"). A case of one of those names would pass for it: Discord would post its
  knives as traded up, and the Index would count Market items as unboxed.
- **Contents:** any mix of your skins and real ones, by name, under their rarity (the build checks each one's real rarity).
  A plain list works too and is sorted by rarity for you.
- **The gold slot** (`"rare"`): knives and gloves, custom or real.
  - A real finish's name brings all its phases as one slot (`"★ Karambit | Doppler"`).
  - `{ "from": "<a real case>" }` adds that case's whole list.
- **Odds:** CS2's own. Mil-Spec 79.92%, Restricted 15.98%, Classified 3.2%, Covert 0.64%, gold 0.26%, shared out over the
  rarities the case has. Within a rarity, every item is equally likely. Within a gold slot, phases go by their weights.
- **Price:** `"price"` is the case's own. A case with `"key": true` takes its own key ("My Case Key", at the key price,
  $2.49, pictured like the CS:GO case key). `"key": false` opens without one. The build warns when opening is worth far
  more or far less than about 80% of what it costs, which is roughly where real cases sit.
- **Collection** (`"collection"`): its custom skins join it, so they can be traded up (section 7). Real skins keep their own
  collection, so real trade-ups never change.
- **Level-up drops:** custom cases stay out of the level-up rewards' drop pool unless `"levelDrops": true`, so a new
  custom case never pushes out one of the six real ones.
- **The Index:** a custom case is a set of its own, and its rewards are for what only it has.
  - Its gold-slot bonus is any one of its own custom knives and gloves. A real knife it also holds doesn't pay it, since
    players may have found one in a real case long ago.
  - A gold slot of real knives only shares the bonus of the real case whose list it is exactly (`{ "from": … }`), and has
    none if it's a mix.
  - The same goes for finishing it: a case of real skins only shares a real set's goal when it's exactly that set, and has
    no goal of its own otherwise.
  - A real skin opened from your case counts toward every set it's in, as it does from any case. So a custom case that
    holds real skins also moves their real cases' Index on, at the price you set for it.
- **Its picture: `case.png`**, required. A transparent PNG like Steam's case pictures: the case alone, three-quarter front
  view, no background, filling most of a 4:3 frame. 1024×768 is ideal. It's fitted to 512×384 and 1024×768.
- **Its 3D crate:** `"crate": { "base": "<a real case>" }` uses that case's crate model and its CS2 animations (falling in,
  unlocking).
  - With **`crate.png`** in the folder, your emblem replaces the real one. CS2-era crates carry their logo as a separate
    square decal on the crate's side: Kilowatt, Gallery, Fever, Revolution and the other recent cases.
  - **The layout:** a square picture, 512 or 1024, with the emblem filling it and transparent around it. Alpha under 50% is
    cut out. `node scripts/custom-reference.mjs crate "Kilowatt Case"` exports the real one to compare.
  - Without `crate.png` the crate keeps the base case's art. Without `"crate"` the case drops in 2D, as cases with no crate
    do.
  - Older crates paint their art on the body instead, and the build can't put an emblem on those well, so use a CS2-era
    base.

## 7. Prices

There's no market for custom items, so their prices are yours:

- `"prices": { "FN": …, "MW": …, "FT": …, "WW": …, "BS": … }` in dollars, for each wear the float range covers. A wear
  you leave out is filled from the nearest one with the game's usual ratios (FN 2.1×, MW 1.35×, FT 1×, WW 0.9×, BS 0.8×).
- `"pricesStatTrak"` is the same for StatTrak™. Without it, StatTrak™ is 1.7× (★: 1.15×).
- What a copy is worth then goes as for real items: float (low floats are worth more), the Fade rule if it has one, its
  serial number, and stickers.
- The daily price refresh and the server's price patch (`/api/prices`) keep these. They never drop or zero them. A price
  saved on the server before a deploy never overrides the pack's.
- A new price goes out to everyone online with the next deploy, without a release and without changing the lock. The
  server sees the custom prices differ from the ones its saved price patch was made with, and gives the patch a new date,
  so games that kept the old patch download the new one. The daily refresh keeps going by when the marketplaces were last
  read. Offline games use the price they shipped with.
- Watch the economy: a mispriced item reaches the Market, NPC traders, case battles and trade-ups.

**Trade-ups:** a custom skin can be traded up only if its case names a `"collection"`.

- Ten of one rarity give one of the next rarity from that collection: only its custom skins, as CS2 does per collection.
- Five Coverts give a knife or gloves from that case's gold slot, real ones included. A StatTrak™ contract only gives
  knives.
- A custom skin with no collection says "Not part of a collection", like CS2's.
- **The build checks what a contract is worth.** Your prices are your own, so nothing else stops five $18 Coverts from
  trading up into a $1,700 knife (the Market sells the inputs at your prices). For each rarity and wear, StatTrak™ too, it
  sets ten of the cheapest custom skin (five for Coverts) against the average of what they trade up into, phases by their
  weights. Over 100% is a warning; over 200% is an error, with the figures. To ship one anyway, `"allowTradeupProfit": true`
  in case.json.

## 8. Building, testing locally and releasing

1. **Paint and write** the folders in `custom/`.
2. **Pictures:** `node scripts/bake-custom-icons.mjs` for every item without an `icon.png`.
3. **Check:** `npm run custom -- --check` checks every pack, says exactly what's wrong and where, and writes nothing. It
   checks any folder: `--src <folder> --check`.
4. **Set the version** in `package.json` to the release this content ships in (1.1.4, say), if it changes the lock. The
   build stamps it into `custom.json`, and the server waits for that release (step 8). The build refuses a version that's
   out already (its git tag `v<version>` exists) when the lock changes. A build whose lock is the earlier build's (new
   prices or textures) keeps that build's version and needs no new one.
5. **Build:** `npm run custom` writes `src/data/custom.json` and `src/custom/`, updates `custom/ids.json`, and prints the
   new data lock in full, as `/health` shows it. Commit all of them, `custom/` included. Only `custom/` builds into the
   game: any other folder is refused there (it would replace every custom item), and tried with `--try` (section 2).
6. **Look at it:** `npm start -- --custom src`. That's the game with this build, on a save of its own (the installed game
   has no such items yet). Open the case, inspect the items (3D and first person), equip them, and play a match with the
   knife and gloves.
7. **Test:** run every suite. `node scripts/test-custom.mjs` and `node server/test-custom.mjs` check custom content itself,
   and `node scripts/test-workshop-import.mjs` the Workshop importer. **Online, locally:** `node server/index.mjs` reads
   the same `src/data/custom.json`, so a dev game and a local server agree. Point the game at it as in section 2.
8. **Release.** Pushing first is safe:
   - **Push** whenever it's ready. The server deploys within a minute, sees custom content for a version that isn't out
     yet, and keeps running what the published release has. Its lock stays the same, so every game out there (1.1.3
     included) keeps playing. `/health` shows `customWaits: "<version>"` and the lock it will have (`customLock`).
   - Build the exes, upload the release as a **draft**, then **publish** it.
   - Within five minutes the server reads the release and warns older versions to update. Once their five minutes are up
     it starts again (offline for a few seconds) with the new content. An updated game that connects first is told the
     server is switching, and makes the server look for the release at once.
   - The server keeps the custom content it ran in its database. So the next release's content waits the same way while
     this one keeps running.
   - **Once it's out, a release that changed the lock can't be taken back by deleting it.** The server keeps running its
     content, and games of the version before can't play with that ("Your game data is a different version"), with no
     release to update to. Fix a bad one forward: publish a fixed, higher version. (DEPLOY.md, "Good to know".)

To remove all custom content, empty `custom/` and build again. `src/data/custom.json` and `src/custom/` go away, and the
lock is the game data's own again. That's a lock change with no version to wait for, so the server takes it at once: push
it when the release without custom content is published, not before.

## 9. Renaming and removing items

- **Renaming a skin:** a new name makes a new id, and players' copies of the old one would become "Unknown item". Keep the
  old name as `"key"`: `"name": "AK-47 | Galaxy", "key": "AK-47 | Nebula"`. The id stays, and every copy is renamed.
  - A key is read as a name is: `"Karambit - Aurora"` or `"Karambit | Aurora"`, with or without the ★, is the knife's old
    name.
  - Change the name in `case.json` too. A case that still says the old name builds, with a warning, and means the renamed
    item.
  - Two items can't end up with one id: a key that's another item's name (or key) is refused, and so is a copied folder
    that kept its key.
  - A name is part of the lock, so a rename is released like new content (section 8).
- **Renaming a case:** keep its old name as `"oldName"` (in case.json `"key"` is whether it takes a key), and its
  collection's as `"oldCollection"`. Players' unopened cases, their keys and the Index's goals stay theirs.
- **Removing:** `custom/ids.json` remembers every item ever built, the cases' keys included, and the build refuses to lose
  one. That includes a case that took a key and now doesn't (`"key": false`), since its keys would go. To stop an item
  dropping, take it out of its case: the skin stays in the game for those who have it. To really delete it, build with
  `--allow-removed`: copies players own then show as "Unknown item" worth $0.
- **Valve adds an item with your item's name:** the build then refuses it. Rename it and keep the old name as `"key"`. A
  case that names that name then has to say which it means: the build refuses it until it gives the custom one's new name.

## 10. Steam Workshop finishes

**In short:** a Workshop finish can't be imported from Steam, because Steam never hands one out. It can be imported from
its creator's own files, with their permission. `scripts/import-workshop.mjs` does that, and the game credits the creator.

### 10.1 Why not from Steam

- **Subscribing doesn't download a finish.** On CS2's Workshop only maps are "ready to use" items ("Subscribe to
  download"). Weapon finishes are in the section where you vote for your favourites. A finish's page has a vote button
  and no Subscribe button.
- **Steam's API has no file for one.** Its public item details (GetPublishedFileDetails) give a download handle only for
  items you can subscribe to. For finishes, CS2-era and CS:GO-era alike, there is none. Every finish checked showed 0
  subscriptions, even ones with thousands of favourites.
- **Your Steam folder agrees.** `steamapps/workshop/content/730` holds only the one item you subscribed to, a map
  (3744399267, aim_redline, packed as a VPK). No finish has ever landed there.
- A finish reaches players only when Valve accepts it, and then it's a real CS2 item, already in the game.

`node scripts/import-workshop.mjs <Workshop id or link>` with nothing else checks your Steam folder and says what's there
(a map) or why nothing is.

### 10.2 What works: the creator's files

A CS2 Workshop finish is one of CS2's own Workshop templates plus the creator's settings and textures. Valve ships
accepted finishes the same way. That's exactly what a custom skin is here (section 3), so the creator's files map straight
onto a skin folder. The importer reads what CS2's Workshop tools save:

| What the creator sends you | What's in it |
|---|---|
| Their CS2 addon folder, or a zip of it | `content/csgo_addons/<addon>/`: the finish's `.econitem` (`items/assets/paintkits/workshop/<name>.econitem`: its style, settings and weapon) and the `.tga` textures it names (`weapons/paints/workshop/<name>/<name>_color.tga`, `_normal`, `_rough`, `_pearl`, `_ao`, `_masks`) |
| The finish's `.vcompmat` | The finish in the form Valve ships accepted ones, with its `.tga` sources. A compiled `.vcompmat_c` with `.vtex_c` textures, from the addon's `game/` folder, works too (read through `tools/s2v`) |
| A CS:GO-era upload | `myweaponfinishes/<name>.zip`: the workbench `.txt`, the `.tga` picture and normal map. The `.vtf` isn't needed |

### 10.3 Importing one

One line, the same in cmd and PowerShell:

```
node scripts/import-workshop.mjs "D:\From the creator\their_addon.zip" --workshop 1234567890 --permission "D:\From the creator\permission.txt" --rarity Classified --prices FN=42.5,MW=24,FT=15.75,WW=13.2,BS=11.4
```

1. It reads the item's public details from Steam: its title, its creator and their profile name, its tags and when it was
   last updated. That's metadata only, never a file. Use `--details <saved answer>` or `--offline --creator-name <name>`
   to work without Steam.
2. It finds the finish in the files, maps it onto a `skin.json` (10.4), and turns the textures it uses into PNGs (alpha
   kept, 2048 at most, as the game ships them). Paths written on the creator's own PC are found in their addon.
3. It checks the result with the build itself, then writes `custom-staging/skins/<Weapon> - <Finish>/`: `skin.json`, the
   textures, `permission.txt` and `import-notes.txt` (what was carried over and what wasn't). `custom-staging/` isn't
   built and isn't in git, so nothing reaches players from there.
4. Then make its picture: `node scripts/bake-custom-icons.mjs --src custom-staging` (or pass `--icon <png>`).
5. Try it with `node scripts/build-custom.mjs --src custom-staging --try`, and the commands it prints (section 2). Only
   `custom/` builds into the game itself: the build refuses `custom-staging/` there.
6. Move the folder into `custom/skins/`, put the skin in a case, and build and release it (section 8). `--live` writes
   straight into `custom/` instead, and needs `--permission`.

Other options: `--name "AK-47 | Nebula"` and `--weapon` when the title or files don't say, `--float 0,0.7`,
`--prices-stattrak`, `--no-stattrak`, `--model hd|legacy`, `--item <name>` when the files hold several finishes, `--force`
to replace a folder, and `--keep-size`. The top of `scripts/import-workshop.mjs` lists them all.

### 10.4 What carries over, and what's yours

| From the creator's files | Becomes |
|---|---|
| The style: an `.econitem`'s `PaintKit_<style>`, a `.vcompmat`'s template, CS:GO's `"style"` 1 to 9 | `finish.style`. An *Extended* style becomes its base style (10.5) |
| The weapon: `preview_weapon` (CS:GO: a `weapon_…` in the `.txt`), else the title, else the Workshop tag | Its weapon, and so its name: `<Weapon> \| <Finish>` |
| The wear range: `econ_instance.g_flWearAmount` as `[min, value, max]` | `"float": [min, max]`, and the wear it was shown at as `"iconFloat"` |
| Rotation and offset, `[min, value, max]` | `"rotation"`, `"offset"`: the ranges each item's seed picks from |
| Scale, roughness, pearlescence, ignore weapon size, colours 0 to 3 | The same fields in `"finish"` (colours only for styles that have them) |
| Each texture whose switch is on (`g_bUseNormalMap`...) | `color.png`, `normal.png`, `roughness.png`, `pearlescence.png`, `ao.png`, `masks.png`. A texture whose switch is off is left out, as in the creator's finish |
| The template's other settings (roughness by colour, spray blend...) | `"params"` |
| A CS:GO-era finish | `"model": "legacy"` (CS:GO's UV layout) and `"flipNormalGreen": true` (Source 1 normal maps) |
| The Workshop item: id, link, title, creator, their name, tags, last update | `"workshop"` in skin.json, shown in the game (10.6) |

**Yours, because Valve sets them only when it accepts a finish:** its rarity (the creator's file says `common` as a
placeholder), its prices per wear (and StatTrak™), whether it drops StatTrak™, and which case it's in. The importer stops
and asks for them: `--rarity`, `--prices`. Knives are ★ Covert and need no rarity.

### 10.5 What can't be imported, and what to check

- **Gloves can't be imported.** There are no Workshop gloves: the Workshop has no glove category, CS2's item editor has no
  glove style, and items called "gloves" there are gun finishes. Gloves are drawn by another shader on their own UV layout.
  Make them as in section 5.
- **Knives:** knife finishes are posted under a gun's tag ("Karambit | ..." tagged AK-47). The importer takes the knife
  from the creator's `preview_weapon` or the title, and asks with `--weapon` when they disagree. A finish painted on the
  UV layout (Custom Paint Job, Patina, Gunsmith) only fits the model it was painted on, so it's never moved to another
  weapon. A pattern style (Hydrographic, Spray-Paint, Anodized...) can be.
- **Extended styles:** an overlay texture, a metalness texture, glitter, iridescence, its own wear or grunge textures, or an
  aged-patina ramp aren't offered yet (section 11). A finish that uses none of them imports as its base style with nothing
  lost. One that uses them is refused, saying which. `--allow-loss` imports it without them, and then it won't look
  exactly like the creator's.
- **Case Hardening and Spray-Paint Halftone** styles are refused: custom skins don't have them yet.
- **CS:GO workbench files:** their layout was never published, and CS2's files no longer have one. The importer reads the
  paint kit keys CS:GO used (`style`, `color0` to `color3`, `pattern_scale`, `pattern_offset_*`, `pattern_rotate_*`,
  `wear_remap_*`). A file without them is refused, with its keys listed; give `--style` (and `--colors`, `--float`) and the
  upload's `.tga` is used. CS:GO's shine settings (`phong…`) have no CS2 equivalent. CS:GO read the picture's alpha
  differently, so the importer points out alpha that CS2 shows as bare metal (153 to 230).
- **Check in inspect:**
  - The `.econitem` layout matches CS2's item editor's own setting names, but it was checked against files from a
    third-party tool, not against one saved by Valve's own (CS2's Workshop Tools aren't installed here).
  - A CS2-era normal map is taken as it is, and a CS:GO-era one is flipped. If its bumps look pushed in, change
    `"flipNormalGreen"`.

### 10.6 Rights: ask the creator first

- A Workshop finish belongs to its creator. Posting it on the Workshop doesn't let anyone else use it. As we read Steam's
  Workshop terms (check them yourself), the creator gives Valve the right to use it, for a share of sales if Valve accepts
  it. Other developers get no such right. Shipping it in an update gives it to every player, and the game trades and
  sells it.
- So get the creator's **written permission** before it ships: that it's in the game for every player, traded and sold
  for the game's money, and for how long. `--permission <file>` copies it into the skin's folder as `permission.txt` and
  records it in skin.json.
  - **The game's build (`npm run custom`) refuses a Workshop skin without it.**
  - A try-out build (`--out` somewhere else) or the icon baker only warns.
- `custom/` is committed with the game's sources, and the repository is public (the server deploys from it, and the
  Discord posts' pictures come from it). So the creator's textures are published on GitHub as well as in the game: in
  the skin's folder, and as the build ships them in `src/custom/`. Their permission must cover that. Keep the permission
  file to who agreed, when, and where (for example a link to their reply). Leave their e-mail address and other private
  details out of it. `import-notes.txt` names the file the finish came from, not the folder it was in on your PC.
- Fan art inside a finish (a character, a logo) can carry someone else's rights that the creator can't give you. Ask
  about it.
- A finish Valve accepted is a real CS2 item. It's in the game already, and the importer refuses its name.
- **The game credits the creator** wherever the item's details show: the item details window, a case's contents and the
  Item Database. It reads "Made by `<name>` · Steam Workshop", linking to their Steam profile and to the Workshop item.
  The credit ships with the game but isn't part of the data lock, so correcting it goes out with any update without
  locking older games out.

This isn't legal advice. When in doubt, ask the creator, and keep their answer.

## 11. What isn't done yet

- The `_extended` templates (overlay, metalness and glitter textures), Spray-Paint Halftone and the Case Hardening
  templates (blue-gem colour ramps). The nine styles above work. Some of the extended ones' settings can be reached through
  `"params"`, but none is checked.
- Custom normal maps for gloves, and the newest layered glove kits as a base.
- Each case's own key picture: custom keys use the CS:GO case key picture.
- Repainting a crate's body (only its emblem), and crates for older-style bases.
- Workshop finishes straight from Steam: Steam doesn't hand them out (section 10). The importer takes the creator's files
  instead. Finishes that use the extended styles' features import only without them (`--allow-loss`).
- Guns in phases (a Gamma Doppler Glock): a case's pool can't weigh them, so phases are for knives and gloves.
- A Fade's percentage goes by its rotation alone, as CS2's own do, so its offset must be fixed.
- Removing all custom content isn't held back by the server (there's no version to wait for): push it once the release
  without it is published.

## 12. Reference: skin.json and case.json

**skin.json**

| Field | | |
|---|---|---|
| `name` | optional | `"AK-47 \| Nebula"` (default: from the folder) |
| `key` | optional | an old name to keep the id after a rename (written as a name or a folder name; a knife's ★ is optional). It can't be another item's name or key |
| `weapon` | optional | CS2's name or id when the name doesn't say it: `AK-47`, `weapon_ak47`, `Karambit`, `sporty_gloves` |
| `rarity` | guns | Consumer, Industrial, Mil-Spec, Restricted, Classified, Covert (knives and gloves are always ★ Covert) |
| `float` | | `[min, max]`, default `[0, 1]` |
| `stattrak` | | default true (gloves: never) |
| `prices` | required | `{ "FN": 1.5, ... }` for the wears in the float range |
| `pricesStatTrak` | optional | the same for StatTrak™ |
| `finish` | | guns and knives: `style`, `model`, `colors`, `scale`, `rotation`, `offset`, `ignoreWeaponSize`, `roughness`, `pearlescence`, `flipNormalGreen`, `params`. Gloves: `mode`, `layer`, `base`, `scale`, `rotation`, `offset`, `tints`, `palette`, `mirror` |
| `phase`, `phaseWeight` | optional | for a knife's or gloves' finish in phases (section 4) |
| `patternRule` | optional | `"Fade"`: a fade percentage from the seed's rotation (knives and guns; needs a `rotation` range and a fixed `offset`, section 4) |
| `iconSeed`, `iconFloat` | optional | what the icon baker draws |
| `credit` | optional | who made it, shown in the game as "Made by" |
| `workshop` | optional | a Steam Workshop finish's details, written by `scripts/import-workshop.mjs` (section 10): `id`, `url`, `title`, `creator` (their Steam id), `creatorName` (credited in the game, with links), `updated`, `tags`, `format`, and `permission`, a file in the folder with the creator's written permission. The game's build refuses the skin without `permission` |

**case.json**

| Field | | |
|---|---|---|
| `name` | optional | default: the folder's name. Not a real case's or collection's, nor a name the game gives where items come from (section 6) |
| `oldName` | optional | its old name, to keep its id after a rename (section 9) |
| `price` | required | the case's own price |
| `key` | | default true: it takes its own key |
| `date` | optional | `YYYY-MM-DD`, for sorting |
| `items` | required | `{ "Mil-Spec": [...], "Restricted": [...], "Classified": [...], "Covert": [...] }` or a list |
| `rare` | optional | knives and gloves by name, or `{ "from": "<a real case>" }` |
| `collection` | optional | its collection's name (enables trade-ups) |
| `oldCollection` | optional | its collection's old name, to keep its id after a rename |
| `crate` | optional | `{ "base": "<a real case>" }`, with `crate.png` for its emblem |
| `levelDrops` | optional | true: also offered as a level-up reward |
| `allowTradeupProfit` | optional | true: ships trade-ups worth more than twice their inputs (section 7), as a warning instead of an error |
| `credit` | optional | who made it |
