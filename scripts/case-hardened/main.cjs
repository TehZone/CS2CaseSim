// The Electron side of scripts/build-case-hardened.mjs: a hidden window on the dev server, running measure.js with its
// own user data folder. Each skin's result is written to the job's folder as it finishes.
//   electron scripts/case-hardened/main.cjs <dev server port> <job json file>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [port, jobFile] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('main.cjs') && a !== '.');
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
app.setPath('userData', job.userData);
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || /^measure:/.test(e.message)) console.log(e.message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  try {
    // Any page of the dev server gives the measuring its origin; the game's own import map and base go on it by hand.
    await win.loadURL(`http://localhost:${port}/css/fonts.css`);
    const src = fs.readFileSync(path.join(__dirname, 'measure.js'), 'utf8');
    await js(`(async () => {
      const base = document.createElement('base'); base.href = location.origin + '/'; document.head.append(base);
      const map = document.createElement('script'); map.type = 'importmap';
      map.textContent = JSON.stringify({ imports: { three: location.origin + '/vendor/three.module.js', 'three/addons/': location.origin + '/vendor/addons/' } });
      document.head.append(map);
      window.measure = await import(URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: 'text/javascript' })));
    })()`);
    for (const skin of job.skins) {
      const result = await js(`window.measure.measureSkin(${JSON.stringify(skin)})`);
      fs.writeFileSync(path.join(job.dir, `${skin.wid}.${skin.fid}.json`), JSON.stringify(result));
    }
    app.exit(0);
  } catch (e) {
    console.error('measuring failed:', e.stack || e);
    app.exit(1);
  }
});
