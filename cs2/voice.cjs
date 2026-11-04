// Your own agent's radio voice in Play. The bots speak four voices that service.playVoices sorts out by their event names;
// the other agents' voices name theirs every way there is (swat.radiobotreponsepositive01, balkan_epic.affirmation_01,
// seal_diver_01.am1_affirmation_01), so these come from CS2's own table of what a voice says for each radio call, its
// talker script (scripts/talker/<voice>.vrr). Worked out once per voice and kept in play/voices/.
const fs = require('node:fs');
const path = require('node:path');
const { parseKV1 } = require('./kv.cjs');
const play = require('./play.cjs');

const VOICE_VERSION = 1;
// The radio menu's lines (radio.js RADIO) and what CS2's talker scripts call each.
const CONCEPTS = {
  letsgo: 'Radio.GoGoGo', followme: 'Radio.FollowMe', radiobothold: 'Radio.HoldPosition', radiobotregroup: 'Radio.Regroup',
  radiobotfallback: 'Radio.TeamFallBack', coverme: 'Radio.CoverMe', enemyspotted: 'Radio.EnemySpotted', needbackup: 'Radio.NeedBackup',
  takingfire: 'Radio.TakingFire', clearedarea: 'Radio.SectorClear', inposition: 'Radio.InPosition', spottedloosebomb: 'SpottedLooseBomb',
  affirmative: 'Radio.Affirmitive', negative: 'Radio.Negative', thanks: 'Radio.Thanks', niceshot: 'Radio.Compliment', enemydown: 'Radio.EnemyDown',
};
// The model names CS2's shared.vrr gives a voice of another name; any other name is its own voice.
const MODEL_VOICES = { tm_balkan: 'balkan', ctm_gsg9: 'gsg9', tm_leet: 'leet', tm_phoenix: 'phoenix', tm_professional: 'professional', ctm_sas: 'sas', ctm_st6: 'seal', ctm_swat: 'swat' };

// The voice an agent (its items_game entry) speaks with, by CS2's rule: its vo_prefix, else its model's file name, up to
// any _var. FBI agents without a voice of their own speak as SWAT.
function voiceOf(item) {
  let name = String(item?.vo_prefix || path.posix.basename(String(item?.model_player || ''), '.vmdl')).toLowerCase();
  const cut = name.indexOf('_var');
  if (cut >= 0) name = name.slice(0, cut);
  if (name === 'ctm_fbi') name = 'ctm_swat';
  return MODEL_VOICES[name] || name;
}

// What a voice says for each radio line: { line: [events] }. talker, shared: its talker script and shared.vrr, parsed;
// have: the events its sound file really has (talker scripts also name some it hasn't).
function voiceLines(talker, shared, have) {
  const concepts = {};
  for (const r of [...(shared?.m_Requirements || []), ...(talker?.m_Requirements || [])]) if (/^concept$/i.test(r.m_matchKey)) concepts[r.m_name] = String(r.m_matchExpr).toLowerCase();
  const groups = new Map((talker?.m_ResponseGroups || []).map((g) => [g.m_name, g]));
  const said = (name, depth = 0) => (depth > 4 ? [] : (groups.get(name)?.m_responses || [])
    .flatMap((r) => (r.m_type === 'SPEAK' ? [r.m_value] : r.m_type === 'RESPONSE' ? said(r.m_value, depth + 1) : [])));
  const named = {};
  for (const g of talker?.m_ResponseGroups || []) {
    for (const q of g.m_pEmbeddedRule?.m_Requirements || []) {
      if (!concepts[q]) continue;
      const set = (named[concepts[q]] ||= new Set());
      for (const e of said(g.m_name)) set.add(e);
    }
  }
  const lines = {};
  for (const [line, concept] of Object.entries(CONCEPTS)) {
    const events = [...(named[concept.toLowerCase()] || [])];
    let own = events.filter((e) => have.has(e));
    // (Some name events a little differently from the sound file: radio_request_move_01 for request_move_01, at_position
    // for in_position.)
    if (!own.length) own = events.map((e) => e.replace('radio_', '').replace('at_position', 'in_position')).filter((e) => have.has(e));
    lines[line] = [...new Set(own)];
  }
  return lines;
}

// Lines with only what can be heard: sounds: { event: [urls] }. A voice's sound file names some events whose audio isn't
// in the install (gendarmerie_male's in_position 03-06). null when none can: no sound came out, and the default voice speaks.
function heardLines(lines, sounds) {
  const heard = Object.fromEntries(Object.entries(lines).map(([line, events]) => [line, events.filter((e) => sounds[e]?.length)]));
  return Object.values(heard).some((l) => l.length) ? heard : null;
}

const agentItems = new WeakMap(); // service -> { def index: items_game entry } of the agents
function agentItem(service, defIndex) {
  if (!agentItems.has(service)) {
    const items = parseKV1(fs.readFileSync(path.join(service.cacheDir, 'items_game.txt'), 'utf8')).items_game;
    const out = {};
    for (const group of [].concat(items.items || [])) for (const [id, it] of Object.entries(group)) if (/^agents\//.test(it?.model_player || '')) out[id] = it;
    agentItems.set(service, out);
  }
  return agentItems.get(service)[String(defIndex)] || null;
}

// An agent's voice for the radio menu: { voice, lines: { line: [events] }, sounds: { event: [urls] }, info: { event: how
// CS2 plays it } }, or null for what isn't an agent.
async function agentVoice(service, defIndex) {
  await service.ensureIndex();
  const item = agentItem(service, defIndex);
  const voice = item && voiceOf(item);
  if (!voice || !/^[a-z0-9_]+$/.test(voice)) return null; // (a name goes into a file filter: an empty one exports the whole VPK)
  return service.playJob('voice:' + voice, async () => {
    const cs2 = service.ensureCS2();
    const file = path.join(service.cacheDir, 'play', 'voices', voice + '.json');
    const talker = `scripts/talker/${voice}.vrr_c`, shared = 'scripts/talker/shared.vrr_c', events = `soundevents/vo/agents/game_sounds_${voice}.vsndevts_c`;
    const inputs = [talker, shared, events];
    let data = await cs2.cached(file, inputs, (d) => d.version === VOICE_VERSION);
    if (!data) {
      const tmp = path.join(service.cacheDir, 'play', 'tmp-voice-' + voice);
      try {
        await cs2.run(['-i', cs2.vpk, '-f', inputs.join(','), '-d', '-o', tmp]);
        const read = (f) => play.parseKV3(fs.readFileSync(path.join(tmp, f.replace(/_c$/, '')), 'utf8'));
        const root = read(events), files = play.soundEventFiles(root);
        const lines = voiceLines(read(talker), read(shared), new Set(Object.keys(files)));
        const sounds = Object.fromEntries([...new Set(Object.values(lines).flat())].map((e) => [e, files[e]]));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        data = await cs2.save(file, { version: VOICE_VERSION, voice, lines, sounds, info: play.soundEventInfo(root, sounds) }, inputs);
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    const got = await cs2.extract(Object.values(data.sounds).flat());
    const sounds = Object.fromEntries(Object.entries(data.sounds).map(([e, list]) => [e, list.map((f) => got[f + '_c']).filter(Boolean).map((f) => service.url(f))]));
    const lines = heardLines(data.lines, sounds);
    if (!lines) throw new Error('No sounds for the voice ' + voice);
    return { voice, lines, sounds, info: data.info };
  });
}

module.exports = { voiceOf, voiceLines, heardLines, agentVoice };
