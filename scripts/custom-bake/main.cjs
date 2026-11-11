// The Electron side of scripts/bake-custom-icons.mjs: a hidden window on the dev server running bake.js against the game's
// real 3D code. Each step's pictures come back as data URLs and are written where the job says.
//   electron scripts/custom-bake/main.cjs <dev server port> <job json file>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [port, jobFile] = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('main.cjs') && a !== '.');
// (A profile of its own: in the baker's scratch folder, which goes when it's done.)
app.setPath('userData', process.env.CUSTOM_BAKE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'custom-bake-')));
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning' || /^bake:/.test(e.message)) console.log('[page]', e.message); });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const write = (file, url) => {
    if (!file || !url) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  };
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
    for (const step of job.steps) {
      const r = await js(`window.bake.${step.fn}(${JSON.stringify(step.arg)})`);
      write(step.out, r?.icon);
      write(step.shot, r?.shot || r?.icon);
      console.log(`bake: ${step.fn} ${step.arg.id}${r?.note ? ' — ' + r.note : ''}`);
    }
    app.exit(0);
  } catch (e) {
    console.error('bake failed:', e.stack || e);
    app.exit(1);
  }
});
