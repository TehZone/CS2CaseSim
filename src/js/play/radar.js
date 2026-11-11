// The radar: CS2's overview image of the map (resource/overviews placement), rotating with your view and centred on
// you, with your teammates, enemies your team has spotted, the bomb and pings. The bomb is a C4 badge that stays upright
// and is never off the radar (further off, it waits on the radar's edge, the way to it), and a planted one pulses with
// its beeps (see beep).
//
// Drawn every frame, into the game's own canvas right after the world (game.js frame), where the 3D view draws things:
// you and the bots between their last two ticks, the map turning as your view does. (It used to be drawn ten times a
// second from the tick positions, so it moved in steps: turning at ~130 fps, the map stood still on 12 frames of 13
// and then jumped up to 14 px, and a teammate's dot was up to 40 px from where the 3D view had them.) A frame of it
// is ~0.12 ms of script and no frame rate seen: a dozen quads in the game's WebGL, the overview, then the marks from a
// sheet of sprites drawn once. The page element (.play-radar) only holds what never moves: the rim and your arrow. (So
// it's drawn at the game's resolution: at a render scale under 1, or Low quality, it's as soft as the world.)
//
// Not anything else drawn every frame: on Dust II (a Ryzen 7 2700X, ~130 fps, the GPU process's main thread, which runs
// the game's WebGL, busy most of each frame), each of these cost 7-9% of the frame rate where this costs nothing seen:
// - page elements moved every frame (style transforms): Chromium lays the whole page's layers out again each time
//   (0.55 ms of the page's main thread) and the GPU process takes 0.7 ms more;
// - a canvas of its own, even WebGL: 0.7 ms of the GPU process a frame to present it;
// - a 2D canvas (as it first was): 2.5 ms a frame of the GPU process rasterizing it, a quarter of the frame rate (a third
//   when the game was held up there, before the map's surfaces were batched);
// - compositor animations of the elements, their times set every frame: ~3 ms of the GPU process restarting them.
import * as THREE from 'three';

const ZOOM = 0.9, SIZE = 230, HALF = SIZE / 2; // the radar is 230 px across
const LEFT = 14, TOP = 14; // where it is on the screen (CSS px: as play.css places .play-radar)
export const RADAR_SCALE = (ZOOM * SIZE) / 460; // overview pixels to radar pixels (the overview is 1024 px)
const EDGE = 98; // radar pixels from the middle the bomb is held within (the radar's 115 px round, less half the badge)
const RAD = Math.PI / 180;

// The overview's placement for a view centred on `center` (game units) turned by `yaw` (your view's, degrees): overview
// pixels to radar pixels (from its top left), [a, b, c, d, e, f] for x' = a x + c y + e, y' = b x + d y + f. The spot is
// in the middle and the way you face is up.
export function mapMatrix(info, center, yaw, out = new Float64Array(6)) {
  const cx = (center[0] - info.x) / info.scale, cy = (info.y - center[1]) / info.scale;
  const c = Math.cos((yaw - 90) * RAD) * RADAR_SCALE, s = Math.sin((yaw - 90) * RAD) * RADAR_SCALE;
  out[0] = c; out[1] = s; out[2] = -s; out[3] = c; out[4] = HALF - c * cx + s * cy; out[5] = HALF - s * cx - c * cy;
  return out;
}

// Where a game position is on the radar (radar pixels from its top left) in that view: the same as mapMatrix on its
// overview pixels.
export function radarPoint(info, center, yaw, p, out = [0, 0]) {
  const dx = (p[0] - center[0]) / info.scale, dy = (center[1] - p[1]) / info.scale; // overview pixels from the middle
  const c = Math.cos((yaw - 90) * RAD), s = Math.sin((yaw - 90) * RAD);
  out[0] = HALF + (c * dx - s * dy) * RADAR_SCALE;
  out[1] = HALF + (s * dx + c * dy) * RADAR_SCALE;
  return out;
}

// A frame's marks, in drawing order (the bomb last, on top): { kind, x, y, edge } in radar pixels, into `out` (its
// objects reused). Teammates alive, the enemies given (those your team has seen), pings, the bomb held on the radar's
// edge when it's further off.
export function radarMarks(info, { center, yaw, mates = [], enemies = [], bomb = null, pings = [], myTeam }, out = []) {
  let n = 0;
  const add = (kind, pos) => {
    const m = (out[n++] ||= { kind: '', x: 0, y: 0, edge: false, at: [0, 0] });
    radarPoint(info, center, yaw, pos, m.at);
    m.kind = kind; m.x = m.at[0]; m.y = m.at[1]; m.edge = false;
    return m;
  };
  const mine = myTeam === 'CT' ? 'dot ct' : 'dot t';
  for (const m of mates) if (m.alive) add(mine, m.pos);
  for (const e of enemies) add('dot enemy', e.pos);
  for (const p of pings) add('ping', p.pos);
  if (bomb) {
    const m = add(bomb.planted ? 'c4 planted' : bomb.carried ? 'c4 carried' : 'c4', bomb.pos);
    const dx = m.x - HALF, dy = m.y - HALF, d = Math.hypot(dx, dy);
    if (d > EDGE) { m.x = HALF + (dx / d) * EDGE; m.y = HALF + (dy / d) * EDGE; m.edge = true; }
  }
  out.length = n;
  return out;
}

// The marks' looks (as the radar's CSS had them, in radar pixels): width and height, a margin for what's drawn outside
// them, and how to draw one (2D canvas, centred, scaled to the sheet's pixels) into the sprite sheet.
const rrect = (x, w, h, r) => { x.beginPath(); x.roundRect(-w / 2, -h / 2, w, h, r); };
const SPRITES = {
  dot: [9, 9, 1.2, (x) => { x.fillStyle = 'rgba(0,0,0,.7)'; x.beginPath(); x.arc(0, 0, 5.5, 0, 7); x.fill(); x.fillStyle = '#fff'; x.beginPath(); x.arc(0, 0, 4.5, 0, 7); x.fill(); }],
  ping: [13.6, 13.6, 0.4, (x) => { x.rotate(Math.PI / 4); x.fillStyle = 'rgba(0,0,0,.7)'; x.fillRect(-4.8, -4.8, 9.6, 9.6); x.fillStyle = '#ffd23c'; x.fillRect(-3.83, -3.83, 7.65, 7.65); }],
  c4: [28.8, 17.1, 9.5, (x) => badge(x, 28.8, 17.1, 3.6, '#f2a516', '#160c00', 12.15, 'rgba(0,0,0,.35)', 7.2, 1.8)],
  'c4 carried': [20.7, 12.6, 9.5, (x) => badge(x, 20.7, 12.6, 2.7, '#f2a516', '#160c00', 9, 'rgba(0,0,0,.35)', 7.2, 1.8)],
  'c4 planted': [28.8, 17.1, 16, (x) => badge(x, 28.8, 17.1, 3.6, '#e3241b', '#fff', 12.15, 'rgba(255,40,30,.7)', 11.7, 3.6)],
  ring: [34.2, 22.5, 0.6, (x) => { x.strokeStyle = '#ff3a2a'; x.lineWidth = 2.25; rrect(x, 34.2 - 2.25, 22.5 - 2.25, 5.4 - 1.1); x.stroke(); }],
};
function badge(x, w, h, r, bg, fg, font, glow, blur, spread) {
  // Its glow (a shadow cast from a copy drawn out of the way), its dark outline, the badge and "C4".
  const k = x.getTransform().a; // (a shadow's blur and offset are in the canvas's pixels, not scaled with what's drawn)
  x.save(); x.shadowColor = glow; x.shadowBlur = blur * k; x.shadowOffsetX = 1000 * k; x.fillStyle = '#000';
  x.translate(-1000, 0); rrect(x, w + 2 * spread, h + 2 * spread, r + spread); x.fill(); x.restore();
  x.fillStyle = 'rgba(0,0,0,.8)'; rrect(x, w + 3.6, h + 3.6, r + 1.8); x.fill();
  x.fillStyle = bg; rrect(x, w, h, r); x.fill();
  x.fillStyle = fg; x.font = `900 ${font}px sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.letterSpacing = '0.45px';
  x.fillText('C4', 0.2, font * 0.06);
}
// The marks' colours: a dot's sprite is white, tinted its team's.
const TINT = { 'dot ct': [0x5a / 255, 0xa9 / 255, 1], 'dot t': [0xf2 / 255, 0xc1 / 255, 0x4e / 255], 'dot enemy': [1, 0x40 / 255, 0x40 / 255] };
const WHITE = [1, 1, 1];

// CSS's ease-out (cubic-bezier(0, 0, 0.58, 1)) at x in 0-1.
function easeOut(x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 18; i++) { t = (lo + hi) / 2; const bx = 1.74 * (1 - t) * t * t + t * t * t; if (bx < x) lo = t; else hi = t; }
  return 3 * t * t - 2 * t * t * t;
}

// One quad: its corners (0-1) placed in radar pixels by xa / xb (x' = dot(xa, (u, v, 1)), y' likewise), its part of
// the texture, its tint (rgb times, then all times a). Premultiplied, clipped to the radar's round with a soft edge, the
// texture's sRGB values as they are (the post pass already wrote the screen's).
const VS = `precision highp float;
in vec3 position;
uniform vec3 xa, xb;
uniform vec4 uvRect;
out vec2 vUv;
out vec2 vR;
void main() {
  vec3 q = vec3(position.xy, 1.0);
  vR = vec2(dot(xa, q), dot(xb, q));
  vUv = mix(uvRect.xy, uvRect.zw, position.xy);
  gl_Position = vec4(vR.x / ${HALF.toFixed(1)} - 1.0, 1.0 - vR.y / ${HALF.toFixed(1)}, 0.0, 1.0);
}`;
const FS = `precision highp float;
uniform sampler2D tex;
uniform vec4 tint;
uniform float plain;
in vec2 vUv;
in vec2 vR;
out vec4 color;
void main() {
  float r = length(vR - ${HALF.toFixed(1)}), w = max(fwidth(r), 1e-3);
  float edge = clamp((${HALF.toFixed(1)} - r) / w + 0.5, 0.0, 1.0);
  if (edge <= 0.0) discard;
  vec4 t = plain > 0.5 ? vec4(1.0) : texture(tex, vUv);
  color = vec4(min(t.rgb * tint.rgb, vec3(t.a)), t.a) * (tint.a * edge);
}`;

export class Radar {
  // renderer: the game's (THREE.WebGLRenderer): the radar is drawn into its canvas.
  constructor(root, info, renderer) {
    this.info = info;
    this.renderer = renderer;
    this.el = document.createElement('div');
    this.el.className = 'play-radar';
    this.el.innerHTML = `<b class="me"></b>`;
    root.appendChild(this.el);
    this.marks = []; // this frame's marks (radarMarks)
    this.view = new Float64Array(6);
    this.beepAt = -1e9;
    this.vp = new THREE.Vector4();
    this.size = new THREE.Vector2();
    // The badge as the page element it once was would describe it, for checks from outside (the bomb smoke run): its
    // class ('c4 planted edge'), where it is on the page, and its beep's flash and ring while they run.
    const self = this;
    this.badge = {
      className: '', x: 0, y: 0, w: 0, h: 0,
      getBoundingClientRect() { const r = self.el.getBoundingClientRect(), k = r.width / SIZE; return new DOMRect(r.left + (this.x - this.w / 2) * k, r.top + (this.y - this.h / 2) * k, this.w * k, this.h * k); },
      getAnimations() { const t = performance.now() - self.beepAt; return t < 260 ? ['flash', 'ring'] : t < 650 ? ['ring'] : []; },
    };
    this.bombMark = null;
    if (!renderer) return;
    // The scene: a quad (two triangles over 0-1) drawn as the background, the overview and each mark.
    const geo = (this.geo = new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera(); // (not used: the shader places the quads)
    this.sheet = this.makeSheet();
    this.mapTex = new THREE.Texture();
    this.setup(this.mapTex);
    this.quads = [];
    this.bg = this.quad(); // the radar's dark round
    this.map = this.quad(this.mapTex);
    for (let i = 0; i < 14; i++) this.quad(this.sheet.tex);
    // Its shader made now, while the match loads, and the textures sent to the GPU (see load).
    renderer.compile(this.scene, this.camera);
    renderer.initTexture(this.sheet.tex);
    for (const q of this.quads) q.visible = false;
    const img = new Image();
    img.src = info.image;
    img.decode().then(() => {
      if (this.disposed) return;
      this.mapTex.image = img; this.mapTex.needsUpdate = true;
      renderer.initTexture(this.mapTex);
      this.mapReady = true;
    }, () => {});
  }

  setup(t) {
    t.flipY = false; t.premultiplyAlpha = true; t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
    return t;
  }
  quad(tex = null) {
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS,
      uniforms: { xa: { value: new THREE.Vector3() }, xb: { value: new THREE.Vector3() }, uvRect: { value: new THREE.Vector4(0, 0, 1, 1) }, tex: { value: tex || this.sheet.tex }, tint: { value: new THREE.Vector4(1, 1, 1, 1) }, plain: { value: tex ? 0 : 1 } },
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const q = new THREE.Mesh(this.geo, m);
    q.frustumCulled = false; q.matrixAutoUpdate = false; q.renderOrder = this.quads.length;
    this.scene.add(q);
    this.quads.push(q);
    return q;
  }
  // Places a quad: w x h radar pixels at (x, y) (its top left), or by the overview's matrix (v).
  place(q, x, y, w, h) { const u = q.material.uniforms; u.xa.value.set(w, 0, x); u.xb.value.set(0, h, y); }

  // The marks' sprites side by side in one texture, drawn at twice the screen's pixels: { kind: [w, h, u0, v0, u1, v1] }.
  makeSheet() {
    const k = 2 * Math.max(1, window.devicePixelRatio || 1), cells = [];
    let x = 1, hMax = 0;
    for (const [kind, [w, h, m, draw]] of Object.entries(SPRITES)) {
      const cw = Math.ceil((w + 2 * m) * k), ch = Math.ceil((h + 2 * m) * k);
      cells.push({ kind, cx: x, cw, ch, draw });
      x += cw + 2; hMax = Math.max(hMax, ch);
    }
    const c = document.createElement('canvas');
    c.width = x + 1; c.height = hMax + 2;
    const g = c.getContext('2d');
    const out = {};
    for (const s of cells) {
      g.save(); g.beginPath(); g.rect(s.cx, 1, s.cw, s.ch); g.clip(); // (a glow kept to its own cell)
      g.translate(s.cx + s.cw / 2, 1 + s.ch / 2); g.scale(k, k); s.draw(g); g.restore();
      out[s.kind] = [s.cw / k, s.ch / k, s.cx / c.width, 1 / c.height, (s.cx + s.cw) / c.width, (1 + s.ch) / c.height];
    }
    out.tex = this.setup(new THREE.Texture(c));
    out.tex.needsUpdate = true;
    return out;
  }

  // Game position -> overview image pixels (1024 px image).
  toImg(p) { return [(p[0] - this.info.x) / this.info.scale, (this.info.y - p[1]) / this.info.scale]; }

  // A frame's radar (game.js: right after the world is drawn, into the same frame). Hidden with its page element when
  // the menu's over the match.
  draw(d) {
    const marks = radarMarks(this.info, d, this.marks);
    // The bomb's badge: its class and place for anything that asks (see badge).
    const last = marks[marks.length - 1], bm = last && last.kind.charCodeAt(0) === 99 ? last : null; // ('c4')
    if (bm) { const b = this.badge, sp = SPRITES[bm.kind]; b.className = bm.kind + (bm.edge ? ' edge' : ''); b.x = bm.x; b.y = bm.y; b.w = sp[0]; b.h = sp[1]; }
    this.bombMark = bm ? this.badge : null;
    const r = this.renderer;
    if (!r || this.disposed || document.body.classList.contains('match-menu')) return;
    const qs = this.quads, sheet = this.sheet;
    let n = 0;
    const next = () => { const q = qs[n++] || this.quad(); q.visible = true; return q; };
    const sprite = (s, x, y, scale, rgb, a, bright = 1) => {
      const q = next(), u = q.material.uniforms, w = s[0] * scale, h = s[1] * scale;
      this.place(q, x - w / 2, y - h / 2, w, h);
      u.uvRect.value.set(s[2], s[3], s[4], s[5]);
      u.tint.value.set(rgb[0] * bright, rgb[1] * bright, rgb[2] * bright, a);
    };
    // The dark round, the overview (its 1024 px square placed by the view, 0.9 opaque), the marks over it, upright.
    const bg = next();
    this.place(bg, 0, 0, SIZE, SIZE);
    bg.material.uniforms.tint.value.set(10 / 255, 14 / 255, 20 / 255, 0.75);
    const map = next(), v = mapMatrix(this.info, d.center, d.yaw, this.view), mu = map.material.uniforms;
    mu.xa.value.set(v[0] * 1024, v[2] * 1024, v[4]);
    mu.xb.value.set(v[1] * 1024, v[3] * 1024, v[5]);
    mu.tint.value.set(1, 1, 1, 0.9);
    map.visible = !!this.mapReady;
    const t = performance.now() - this.beepAt, beeping = !!bm && bm.kind === 'c4 planted' && t < 650;
    for (const m of marks) {
      if (m.kind.charCodeAt(0) === 100) sprite(sheet.dot, m.x, m.y, 1, TINT[m.kind], 1); // ('dot ...')
      else if (m.kind === 'ping') sprite(sheet.ping, m.x, m.y, 1, WHITE, 1);
      else {
        // The bomb: on the edge a little see-through; a planted one's beep flashes it and sends a ring out.
        const a = m.edge ? 0.9 : 1, b = beeping && t < 260 ? 1.9 - 0.9 * easeOut(t / 260) : 1;
        sprite(sheet[m.kind], m.x, m.y, 1, WHITE, a, b);
        if (beeping) { const e = easeOut(t / 650); sprite(sheet.ring, m.x, m.y, 1 + 1.6 * e, WHITE, a * 0.95 * (1 - e), b); }
      }
    }
    for (let i = n; i < qs.length; i++) qs[i].visible = false;
    // Into the game's canvas, where the page element is (the canvas fills the screen; its y is from the bottom).
    r.getViewport(this.vp);
    r.getSize(this.size);
    r.setViewport(LEFT, this.size.y - TOP - SIZE, SIZE, SIZE);
    r.render(this.scene, this.camera);
    r.setViewport(this.vp);
  }

  // A planted bomb's beep: its badge flashes and sends out a ring (with the beeps, faster as it runs down).
  beep() {
    if (this.bombMark?.className.startsWith('c4 planted')) this.beepAt = performance.now();
  }

  dispose() {
    this.disposed = true;
    for (const q of this.quads || []) q.material.dispose();
    this.geo?.dispose();
    this.sheet?.tex.dispose();
    this.mapTex?.dispose();
    this.el.remove();
  }
}
