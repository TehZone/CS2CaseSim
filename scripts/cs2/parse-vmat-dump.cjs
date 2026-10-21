// Parses `Source2Viewer-CLI -b DATA` output of many .vmat_c files into JSON.
const fs = require('fs');
function parseDump(text) {
  const out = {};
  const parts = text.split(/^\[\d+\/\d+\] /m).slice(1);
  for (const part of parts) {
    const path = part.slice(0, part.indexOf('\n')).trim();
    if (!path.endsWith('.vmat_c')) continue;
    const m = { shader: '', ints: {}, floats: {}, vectors: {}, textures: {}, dyn: {} };
    m.shader = (part.match(/m_shaderName = "([^"]+)"/) || [])[1] || '';
    const block = (name) => {
      const i = part.indexOf(name + ' = ');
      if (i < 0) return '';
      let depth = 0, j = part.indexOf('[', i);
      for (let k = j; k < part.length; k++) {
        if (part[k] === '[') depth++;
        else if (part[k] === ']' && --depth === 0) return part.slice(j, k + 1);
      }
      return '';
    };
    for (const [, n, v] of block('m_intParams').matchAll(/m_name = "([^"]+)"\s+m_nValue = (-?\d+)/g)) m.ints[n] = +v;
    for (const [, n, v] of block('m_floatParams').matchAll(/m_name = "([^"]+)"\s+m_flValue = ([-\d.e+]+)/g)) m.floats[n] = +v;
    for (const [, n, v] of block('m_vectorParams').matchAll(/m_name = "([^"]+)"\s+m_value = \[ ([^\]]+) \]/g)) m.vectors[n] = v.split(',').map(Number);
    for (const [, n, v] of block('m_textureParams').matchAll(/m_name = "([^"]+)"\s+m_pValue = resource:"([^"]+)"/g)) m.textures[n] = v;
    out[path.replace(/_c$/, '')] = m;
  }
  return out;
}
module.exports = { parseDump };
if (require.main === module) {
  const [inp, outp] = process.argv.slice(2);
  const res = parseDump(fs.readFileSync(inp, 'utf8'));
  fs.writeFileSync(outp, JSON.stringify(res, null, 1));
  console.log(Object.keys(res).length, 'materials');
}
