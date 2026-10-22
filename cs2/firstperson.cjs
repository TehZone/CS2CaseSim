// First-person inspect: CS2's viewmodel inspect animations ("lookat" clips) and the first-person arms.
// Each clip is exported to glTF by Source 2 Viewer with the viewmodel skeleton (arms + the weapon's own bones).

// Inspect clips live in animation/anims/viewmodel/<class>/<folder>/lookat01_<name>.vnmclip. Folders that don't
// follow the weapon id:
const FOLDER = {
  weapon_ak47: 'rifle/rifle_ak', weapon_m4a1: 'rifle/rifle_m4a4', weapon_glock: 'pistol/pistol_glock18',
  weapon_usp_silencer: 'pistol/pistol_hkp2000', weapon_bayonet: 'knife/knife_bayonet', weapon_knife_m9_bayonet: 'knife/knife_m9',
  weapon_knife_survival_bowie: 'knife/knife_bowie', weapon_knife_gypsy_jackknife: 'knife/knife_navaja',
  weapon_knife_widowmaker: 'knife/knife_talon', weapon_knife_falchion: 'knife/knife_falchion', weapon_knife_css: 'knife/knife_css',
  weapon_c4: 'equipment/c4', weapon_m4a1_silencer: 'rifle/rifle_m4a4',
};
const DEFAULT = { knife: 'knife/_default_knife', pistol: 'pistol/_default_pistol', rifle: 'rifle/_default_rifle' };
const PISTOLS = /^weapon_(cz75a|deagle|elite|fiveseven|glock|hkp2000|p250|revolver|tec9|usp_silencer|taser)$/;

// Picks the inspect clip for a weapon id from the list of viewmodel clip paths in the game.
function pickClip(weapon, clips) {
  const kind = /knife|bayonet/.test(weapon) ? 'knife' : PISTOLS.test(weapon) ? 'pistol' : 'rifle';
  const short = weapon.replace(/^weapon_/, '');
  const folders = [FOLDER[weapon], `${kind}/${kind}_${short}`, `${kind}/${short}`, DEFAULT[kind]].filter(Boolean);
  for (const f of folders) {
    const inFolder = clips.filter((c) => c.startsWith(`animation/anims/viewmodel/${f}/`) && /\/lookat0\d_[^/]*\.vnmclip_c$/.test(c)
      && !/draw|transfix|_lgcy/.test(c)).sort();
    if (inFolder.length) return inFolder[0];
  }
  return null;
}

// Every viewmodel clip Play mode uses for a weapon, by role: { draw, idle, shoot: [], reload, ... } (paths).
// The weapon's own folder wins over its class's default folder (knives share the default attacks, for example).
const ROLES = [
  ['draw', /^draw_/], ['idle', /^idle_(?!slide|empty)/], ['idleEmpty', /^idle_(slide_back|empty)/], ['shootEmpty', /^shoot_empty/],
  ['shoot', /^shoot\d*_/, true], ['reloadEmpty', /^reload_empty/], ['reload', /^reload_(?!empty|start|loop|end)/],
  ['reloadStart', /^reload_start/], ['reloadLoop', /^reload_loop/], ['reloadEnd', /^reload_end/], ['inspect', /^lookat01_(?!draw|transfix)/],
  ['lightMiss', /^light_miss\d/, true], ['lightHit', /^light_hit\d/, true], ['heavyMiss', /^heavy_miss\d/, true], ['heavyHit', /^heavy_hit\d/, true],
  ['lightBackstab', /^light_backstab/, true], ['heavyBackstab', /^heavy_backstab/, true], ['plant', /^plant_/],
];
function playClips(weapon, clips) {
  const kind = /knife|bayonet/.test(weapon) ? 'knife' : PISTOLS.test(weapon) ? 'pistol' : 'rifle';
  const short = weapon.replace(/^weapon_/, '');
  // Equipment (the C4) has its own clips only.
  const folders = FOLDER[weapon]?.startsWith('equipment/') ? [FOLDER[weapon]] : [DEFAULT[kind], `${kind}/${short}`, `${kind}/${kind}_${short}`, FOLDER[weapon]].filter(Boolean);
  const out = {};
  for (const f of folders) {
    const inFolder = clips.filter((c) => c.startsWith(`animation/anims/viewmodel/${f}/`) && c.split('/').length === 6).sort();
    const own = {};
    for (const c of inFolder) {
      const file = c.split('/').pop();
      if (/_lgcy|transfix/.test(file)) continue;
      const role = ROLES.find(([, re]) => re.test(file));
      if (!role) continue;
      if (role[2]) (own[role[0]] ||= []).push(c);
      else own[role[0]] ||= c;
    }
    Object.assign(out, own);
  }
  return out;
}

module.exports = { pickClip, playClips };
