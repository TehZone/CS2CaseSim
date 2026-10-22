// First-person inspect: CS2's viewmodel inspect animations ("lookat" clips) and the first-person arms.
// Each clip is exported to glTF by Source 2 Viewer with the viewmodel skeleton (arms + the weapon's own bones).

// Inspect clips live in animation/anims/viewmodel/<class>/<folder>/lookat01_<name>.vnmclip. Folders that don't
// follow the weapon id:
const FOLDER = {
  weapon_ak47: 'rifle/rifle_ak', weapon_m4a1: 'rifle/rifle_m4a4', weapon_glock: 'pistol/pistol_glock18',
  weapon_usp_silencer: 'pistol/pistol_hkp2000', weapon_bayonet: 'knife/knife_bayonet', weapon_knife_m9_bayonet: 'knife/knife_m9',
  weapon_knife_survival_bowie: 'knife/knife_bowie', weapon_knife_gypsy_jackknife: 'knife/knife_navaja',
  weapon_knife_widowmaker: 'knife/knife_talon', weapon_knife_falchion: 'knife/knife_falchion', weapon_knife_css: 'knife/knife_css',
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

module.exports = { pickClip };
