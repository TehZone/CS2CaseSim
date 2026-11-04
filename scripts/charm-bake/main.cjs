// The Electron side of scripts/build-charm-pics.mjs: a hidden window on the dev server, running bake.js against the game's
// real 3D inspect. Results come back over executeJavaScript and are written here.
//   electron scripts/charm-bake/main.cjs <dev server port> <job json file>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [port, jobFile] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('main.cjs') && a !== '.');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'charm-bake-')));
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { backgroundThrottling: false, offscreen: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning' || /^bake:/.test(e.message)) console.log('[page]', e.message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  try {
    // Any page of the dev server gives the bake its origin; the game's own import map and base go on it by hand.
    await win.loadURL(`http://localhost:${port}/css/fonts.css`);
    const src = fs.readFileSync(path.join(__dirname, 'bake.js'), 'utf8');
    await js(`(async () => {
      const base = document.createElement('base'); base.href = location.origin + '/'; document.head.append(base);
      const map = document.createElement('script'); map.type = 'importmap';
      map.textContent = JSON.stringify({ imports: { three: location.origin + '/vendor/three.module.js', 'three/addons/': location.origin + '/vendor/addons/' } });
      document.head.append(map);
      window.bake = await import(URL.createObjectURL(new Blob([${JSON.stringify(src)}], { type: 'text/javascript' })));
      await window.bake.ready();
    })()`);
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    const write = (dir, files) => {
      for (const [name, url] of Object.entries(files || {})) {
        const f = path.join(dir, name);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      }
    };
    const looks = {};
    for (const step of job.steps) {
      const r = await js(`window.bake.${step.fn}(${JSON.stringify(step.arg)})`);
      write(job.out, r?.files);
      if (r?.look) looks[step.key] = r.look;
      if (r?.log) console.log(r.log);
    }
    if (job.looks) fs.writeFileSync(job.looks, JSON.stringify(looks));
    app.exit(0);
  } catch (e) {
    console.error('bake failed:', e.stack || e);
    app.exit(1);
  }
});
