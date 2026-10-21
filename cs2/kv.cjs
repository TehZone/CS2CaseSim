// Parsers for Valve text formats: KeyValues1 (items_game.txt) and KV3 text (resource DATA dumps).

// ---- KeyValues1 ---------------------------------------------------------------------------
// Duplicate keys at the same level are merged (objects) or kept as the last value (strings).
function parseKV1(text) {
  let i = 0;
  const n = text.length;
  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      break;
    }
  };
  const str = () => {
    if (text[i] === '"') {
      let s = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) { const c = text[i + 1]; s += c === 'n' ? '\n' : c === 't' ? '\t' : c; i += 2; continue; }
        s += text[i++];
      }
      i++;
      return s;
    }
    const st = i;
    while (i < n && !/[\s{}"]/.test(text[i])) i++;
    return text.slice(st, i);
  };
  const obj = () => {
    const o = {};
    for (;;) {
      skip();
      if (i >= n || text[i] === '}') { i++; return o; }
      const k = str();
      skip();
      if (text[i] === '[') { while (i < n && text[i] !== ']') i++; i++; skip(); } // conditional like [$WIN32]
      if (text[i] === '{') {
        i++;
        const v = obj();
        o[k] = o[k] && typeof o[k] === 'object' ? Object.assign(o[k], v) : v;
      } else {
        o[k] = str();
      }
    }
  };
  const root = {};
  for (;;) {
    skip();
    if (i >= n) break;
    const k = str();
    skip();
    if (text[i] === '{') { i++; root[k] = obj(); } else root[k] = str();
  }
  return root;
}

// ---- KV3 text -----------------------------------------------------------------------------
function parseKV3(text) {
  let i = text.indexOf('{', text.indexOf('-->') >= 0 ? text.indexOf('-->') : 0);
  const n = text.length;
  const skip = () => {
    for (;;) {
      while (i < n && /[\s,]/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      if (text[i] === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i) + 2; continue; }
      break;
    }
  };
  const value = () => {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const o = {};
      for (;;) {
        skip();
        if (text[i] === '}') { i++; return o; }
        const st = i;
        while (i < n && !/[\s=]/.test(text[i])) i++;
        const k = text.slice(st, i).replace(/^"|"$/g, '');
        skip();
        if (text[i] === '=') i++;
        o[k] = value();
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      for (;;) {
        skip();
        if (text[i] === ']') { i++; return a; }
        a.push(value());
      }
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) { const e = text.indexOf('"""', i + 3); const s = text.slice(i + 3, e); i = e + 3; return s; }
      let s = '';
      i++;
      while (i < n && text[i] !== '"') { if (text[i] === '\\') { s += text[i + 1]; i += 2; continue; } s += text[i++]; }
      i++;
      return s;
    }
    if (c === '#' && text[i + 1] === '[') { const e = text.indexOf(']', i); i = e + 1; return null; }
    // flagged strings like resource:"..." / resource_name:"..." / soundevent:"..."
    const st = i;
    while (i < n && !/[\s,\]}=]/.test(text[i]) && text[i] !== '"') i++;
    const word = text.slice(st, i);
    if (text[i] === '"' && word.endsWith(':')) return value();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    const num = Number(word);
    return Number.isNaN(num) ? word : num;
  };
  return value();
}

// Splits `Source2Viewer-CLI -b DATA` output of many files into { path: kv3object }.
function splitDataDump(text) {
  const out = {};
  const parts = text.split(/^\[\d+\/\d+\] /m).slice(1);
  for (const part of parts) {
    const path = part.slice(0, part.indexOf('\n')).trim().replace(/\\/g, '/');
    const i = part.indexOf('--- Data for block "DATA" ---');
    if (i < 0) continue;
    let body = part.slice(i);
    const next = body.indexOf('--- Data for block', 10);
    if (next > 0) body = body.slice(0, next);
    if (!body.includes('{')) continue;
    try { out[path.replace(/_c$/, '')] = parseKV3(body); } catch { /* not KV3 (e.g. textures) */ }
  }
  return out;
}

module.exports = { parseKV1, parseKV3, splitDataDump };
