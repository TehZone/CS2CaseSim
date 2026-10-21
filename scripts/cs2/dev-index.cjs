// Dev helper: build the CS2 index into cache/cs2 using the local game install.
//   node scripts/cs2/dev-index.cjs
const path = require('path');
const { CS2, findGameDir } = require('../../cs2/pipeline.cjs');

const ROOT = path.resolve(__dirname, '../..');
const cli = process.env.CS2SIM_CLI || path.join(process.env.LOCALAPPDATA, 'Temp', 'vrfcli', 'Source2Viewer-CLI.exe');
const env = { DOTNET_ROOT: path.join(process.env.LOCALAPPDATA, 'Temp', 'dotnet'), VRF_GLSL_ES: '1' };

(async () => {
  const gameDir = findGameDir();
  console.log('CS2:', gameDir);
  const cs2 = new CS2({ cli, gameDir, cacheDir: path.join(ROOT, 'cache', 'cs2'), env, log: console.log });
  console.time('index');
  const idx = await cs2.buildIndex();
  console.timeEnd('index');
  for (const n of process.argv.slice(2)) console.log(n, JSON.stringify(idx.paints[n], null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
