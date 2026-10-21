// Dev helper: node scripts/cs2/dev-prepare.cjs weapon_ak47 aq_oiled
const path = require('path');
const { CS2Service } = require('../../cs2/service.cjs');
const ROOT = path.resolve(__dirname, '../..');
const svc = new CS2Service({
  cacheDir: path.join(ROOT, 'cache', 'cs2'),
  cliPath: process.env.CS2SIM_CLI || path.join(process.env.LOCALAPPDATA, 'Temp', 'vrfcli', 'Source2Viewer-CLI.exe'),
  cliEnv: { DOTNET_ROOT: path.join(process.env.LOCALAPPDATA, 'Temp', 'dotnet') },
  log: console.log,
});
(async () => {
  console.time('prepare');
  const r = await svc.prepare({ weapon: process.argv[2], paint: process.argv[3] });
  console.timeEnd('prepare');
  console.log(JSON.stringify({ ...r, kit: r.kit && { legacy: r.kit.legacy, shader: r.kit.shader }, shader: r.shader && { combo: r.shader.combo, len: r.shader.source.length } }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
