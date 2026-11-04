// CS2's dynamic material expressions, and the attributes a charm's are evaluated with. On its own, without three.js: the
// 3D charm (cs2/charm.js) and the charm pictures on item cards (charmpics.js) both read them.
import { CHARM_PATTERNS } from '../engine/items.js';

// CS2's $KeychainSeed: the pattern from 0 to 1.
export const keychainSeed = (pat) => Math.max(0, Math.min(1, (pat || 0) / CHARM_PATTERNS));
// What a charm's expressions read as it hangs still: the 8 Ball reads $ent_weapon_shake, [seconds since it was shaken (from
// 3: settled, its answer showing), when], and has never been shaken.
export const SHAKE_SETTLE = 3;
export const charmAttrs = (pat) => ({ $KeychainSeed: keychainSeed(pat), $ent_weapon_shake: [SHAKE_SETTLE, 0] });

// ---------------------------------------------------------------------------------------------
// CS2's dynamic material expressions, as the decompiler writes them ("v0 = …;" lines, then "return …;"), evaluated with
// the charm's attributes ({ $KeychainSeed: 0..1, ... }). Values are numbers or vectors (arrays); attributes it doesn't
// have read as 0. Returns null if it can't read one.
// ---------------------------------------------------------------------------------------------
const SWIZZLE = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
// Component by component, numbers standing for every component (as HLSL widens them).
const zipN = (args, f) => {
  const vecs = args.filter(Array.isArray);
  if (!vecs.length) return f(...args);
  const n = Math.max(...vecs.map((v) => v.length));
  return Array.from({ length: n }, (_, i) => f(...args.map((a) => (Array.isArray(a) ? a[i] ?? 0 : a))));
};
const zip = (a, b, f) => zipN([a, b], f);
const each = (a, f) => (Array.isArray(a) ? a.map(f) : f(a));
const truthy = (v) => (Array.isArray(v) ? v.some(Boolean) : !!v);
const FUNCS = {
  lerp: (a, b, t) => zipN([a, b, t], (x, y, k) => x + (y - x) * k),
  pow: (a, b) => zip(a, b, Math.pow), min: (a, b) => zip(a, b, Math.min), max: (a, b) => zip(a, b, Math.max),
  step: (e, x) => zip(e, x, (p, q) => (q >= p ? 1 : 0)),
  clamp: (x, lo, hi) => zip(zip(x, lo, Math.max), hi, Math.min),
  saturate: (x) => each(x, (v) => Math.min(1, Math.max(0, v))),
  frac: (x) => each(x, (v) => v - Math.floor(v)), floor: (x) => each(x, Math.floor), ceil: (x) => each(x, Math.ceil),
  abs: (x) => each(x, Math.abs), sign: (x) => each(x, Math.sign), sqrt: (x) => each(x, Math.sqrt), sqr: (x) => each(x, (v) => v * v),
  sin: (x) => each(x, Math.sin), cos: (x) => each(x, Math.cos), tan: (x) => each(x, Math.tan),
  radians: (x) => each(x, (v) => (v * Math.PI) / 180), degrees: (x) => each(x, (v) => (v * 180) / Math.PI),
  float2: (...a) => a.flat().slice(0, 2), float3: (...a) => a.flat().slice(0, 3), float4: (...a) => a.flat().slice(0, 4),
  length: (x) => Math.hypot(...[].concat(x)), normalize: (x) => { const l = Math.hypot(...[].concat(x)) || 1; return each(x, (v) => v / l); },
};
const tokens = new Map(); // (some run every frame)
export function evalExpression(src, attrs = {}) {
  let toks = tokens.get(src);
  if (!toks) tokens.set(src, toks = String(src).match(/\$[\w$]+|[A-Za-z_]\w*|\d*\.\d+|\d+|<=|>=|==|!=|&&|\|\||[-+*/%(),?:<>!.;=]/g) || []);
  let i = 0;
  const locals = {};
  const peek = () => toks[i];
  const take = (t) => { if (toks[i] !== t) throw new Error(`expected ${t}`); i++; };
  const primary = () => {
    const t = toks[i++];
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') { const v = ternary(); take(')'); return v; }
    if (t === '-') return each(postfix(primary()), (v) => -v);
    if (t === '!') return truthy(postfix(primary())) ? 0 : 1;
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t.startsWith('$')) return attrs[t] ?? 0;
    if (peek() === '(') {
      i++;
      if (t === 'exists') { const name = toks[i++]; take(')'); return name in attrs ? 1 : 0; }
      const args = [];
      while (peek() !== ')') { args.push(ternary()); if (peek() === ',') i++; }
      take(')');
      if (!FUNCS[t]) throw new Error('unknown function ' + t);
      return FUNCS[t](...args);
    }
    if (t in locals) return locals[t];
    throw new Error('unknown name ' + t);
  };
  const postfix = (v) => {
    while (peek() === '.') {
      i++;
      const sw = [...toks[i++]].map((c) => (Array.isArray(v) ? v[SWIZZLE[c]] ?? 0 : v));
      v = sw.length === 1 ? sw[0] : sw;
    }
    return v;
  };
  const unary = () => postfix(primary());
  const binary = (next, ops) => () => {
    let v = next();
    while (ops[peek()]) { const f = ops[toks[i++]]; v = f(v, next()); }
    return v;
  };
  const mul = binary(unary, { '*': (a, b) => zip(a, b, (x, y) => x * y), '/': (a, b) => zip(a, b, (x, y) => x / y), '%': (a, b) => zip(a, b, (x, y) => x % y) });
  const add = binary(mul, { '+': (a, b) => zip(a, b, (x, y) => x + y), '-': (a, b) => zip(a, b, (x, y) => x - y) });
  const cmp = binary(add, { '<': (a, b) => zip(a, b, (x, y) => +(x < y)), '<=': (a, b) => zip(a, b, (x, y) => +(x <= y)), '>': (a, b) => zip(a, b, (x, y) => +(x > y)), '>=': (a, b) => zip(a, b, (x, y) => +(x >= y)) });
  const eq = binary(cmp, { '==': (a, b) => zip(a, b, (x, y) => +(x === y)), '!=': (a, b) => zip(a, b, (x, y) => +(x !== y)) });
  const and = binary(eq, { '&&': (a, b) => +(truthy(a) && truthy(b)) });
  const or = binary(and, { '||': (a, b) => +(truthy(a) || truthy(b)) });
  function ternary() {
    const c = or();
    if (peek() !== '?') return c;
    i++;
    const a = ternary();
    take(':');
    const b = ternary();
    return truthy(c) ? a : b;
  }
  try {
    while (i < toks.length) {
      if (toks[i] === 'return') { i++; return ternary(); }
      const name = toks[i++];
      take('=');
      locals[name] = ternary();
      if (peek() === ';') i++;
    }
  } catch (e) { console.warn('charm material expression', src, e.message); }
  return null;
}
