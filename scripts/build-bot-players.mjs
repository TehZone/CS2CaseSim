// Real Counter-Strike players for the bots' names and pictures, from Liquipedia (liquipedia.net/counterstrike, content
// under CC-BY-SA 3.0; credited in the game). Active players only, with their gamer tag (never the real name), country,
// team and Liquipedia photo when there is one. Follows Liquipedia's API rules: an identifying User-Agent, gzip, at most
// one request every two seconds (this waits five), 50 pages per request, backing off when asked to slow down.
// Responses are kept in cache/raw/liquipedia so a rerun resumes. Writes src/data/bot-players.json.
//   node scripts/build-bot-players.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'data', 'bot-players.json');
const API = 'https://liquipedia.net/counterstrike/api.php';
const HEADERS = { 'User-Agent': 'CS2CaseSimulator-dev/1.0 (personal project; contact iamverx@gmail.com)', 'Accept-Encoding': 'gzip' };
const GAP = 5000; // ms between requests
const CACHE = path.join(ROOT, 'cache', 'raw', 'liquipedia');
fs.mkdirSync(CACHE, { recursive: true });

let last = 0;
async function api(params) {
  const key = path.join(CACHE, createHash('sha1').update(JSON.stringify(params)).digest('hex') + '.json');
  if (fs.existsSync(key)) return JSON.parse(fs.readFileSync(key, 'utf8'));
  const wait = last + GAP - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let attempt = 0; ; attempt++) {
    let res = null, err = null;
    try {
      res = await fetch(url, { headers: HEADERS });
      if (res.ok) { const j = await res.json(); fs.writeFileSync(key, JSON.stringify(j)); return j; }
    } catch (e) { err = e; } // dropped connections too
    if (attempt >= 8 || (res && ![429, 500, 502, 503, 504].includes(res.status))) throw err || new Error(`${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, 60000 * (attempt + 1))); // back off (a minute more each time)
    last = Date.now();
  }
}

// 1. Every player page.
const titles = [];
let cont = {};
do {
  const j = await api({ action: 'query', list: 'categorymembers', cmtitle: 'Category:Players', cmnamespace: '0', cmlimit: '500', ...cont });
  titles.push(...j.query.categorymembers.map((m) => m.title));
  cont = j.continue || null;
} while (cont);
console.log(titles.length, 'player pages');

// 2. Their infoboxes: gamer tag, country, team, photo, status.
const field = (box, k) => (box.match(new RegExp(`^\\|${k}\\s*=([^\\n]*)`, 'm'))?.[1] || '').replace(/<[^>]*>|\[\[|\]\]|\{\{[^}]*\}\}/g, '').trim();
const players = [];
for (let i = 0; i < titles.length; i += 50) {
  const j = await api({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.slice(i, i + 50).join('|') });
  for (const p of j.query.pages) {
    const text = p.revisions?.[0]?.slots?.main?.content || '';
    const box = text.match(/\{\{Infobox player[\s\S]*?\n\}\}/)?.[0];
    if (!box) continue;
    const id = field(box, 'id'), status = field(box, 'status').toLowerCase();
    if (!id || status !== 'active') continue;
    players.push({ id, country: field(box, 'country'), team: field(box, 'team'), image: field(box, 'image') });
  }
  process.stdout.write(`\r${Math.min(i + 50, titles.length)}/${titles.length} pages, ${players.length} active players`);
}
console.log();

// 3. Photo thumbnails (square-ish crops are done in the game).
const files = [...new Set(players.map((p) => p.image).filter(Boolean))];
const thumbs = {};
for (let i = 0; i < files.length; i += 50) {
  const j = await api({ action: 'query', prop: 'imageinfo', iiprop: 'url', iiurlwidth: '184', titles: files.slice(i, i + 50).map((f) => 'File:' + f).join('|') });
  const norm = Object.fromEntries((j.query.normalized || []).map((n) => [n.to, n.from]));
  for (const p of j.query.pages) {
    const url = p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url;
    if (url) thumbs[(norm[p.title] || p.title).replace(/^File:/, '')] = url;
  }
}

const out = {
  source: 'Liquipedia (liquipedia.net/counterstrike), CC-BY-SA 3.0',
  fetchedAt: new Date().toISOString(),
  players: players.map((p) => ({ id: p.id, country: p.country, team: p.team || null, img: thumbs[p.image] || null })),
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT}: ${out.players.length} players, ${out.players.filter((p) => p.img).length} with photos`);
