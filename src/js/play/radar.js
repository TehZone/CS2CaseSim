// The radar: CS2's overview image of the map (resource/overviews placement), rotating with your view and centred on
// you, with your teammates, enemies your team has spotted, the bomb and pings. The bomb is a C4 badge that stays upright
// and is never off the radar (further off, it waits on the radar's edge, the way to it), and a planted one pulses with
// its beeps (see beep). Made of elements the page's compositor
// moves (the overview turned and shifted with a transform, the marks inside it) rather than a 2D canvas: a canvas over
// the game's cost a third of the frame rate.
const ZOOM = 0.9, SIZE = 230; // overview pixels to radar pixels (the overview is 1024 px; the radar 230 px across)
const EDGE = 98; // radar pixels from the middle the bomb is held within (the radar's 115 px round, less half the badge)

export class Radar {
  constructor(root, info) {
    this.info = info;
    this.el = document.createElement('div');
    this.el.className = 'play-radar';
    this.el.innerHTML = `<div class="map"><img src="${info.image}" alt="" draggable="false"></div><b class="me"></b>`;
    root.appendChild(this.el);
    this.map = this.el.querySelector('.map');
    this.marks = []; // reused elements, one per mark shown
    this.last = '';
  }

  // Game position -> overview image pixels (1024 px image).
  toImg(p) { return [(p[0] - this.info.x) / this.info.scale, (this.info.y - p[1]) / this.info.scale]; }

  draw({ center, yaw, mates = [], enemies = [], bomb = null, pings = [], myTeam }) {
    const [cx, cy] = this.toImg(center), s = (ZOOM * SIZE) / 460;
    this.map.style.transform = `translate(${SIZE / 2}px, ${SIZE / 2}px) rotate(${(yaw - 90).toFixed(2)}deg) scale(${s.toFixed(4)}) translate(${(-cx).toFixed(1)}px, ${(-cy).toFixed(1)}px)`;
    const upright = ` rotate(${(90 - yaw).toFixed(2)}deg)`; // (turned back against the radar's turning)
    const mine = myTeam === 'CT' ? 'ct' : 't', list = [];
    for (const m of mates) if (m.alive) list.push(['dot ' + mine, m.pos]);
    for (const e of enemies) list.push(['dot enemy', e.pos]);
    for (const p of pings) list.push(['ping', p.pos]);
    if (bomb) list.push([bomb.planted ? 'c4 planted' : bomb.carried ? 'c4 carried' : 'c4', bomb.pos]); // (last: on top)
    while (this.marks.length < list.length) { const i = document.createElement('i'); this.map.appendChild(i); this.marks.push(i); }
    this.bombMark = null;
    this.marks.forEach((el, k) => {
      const it = list[k];
      if (!it) { if (el.dataset.k !== 'off') { el.dataset.k = 'off'; el.className = 'off'; } return; }
      const c4 = it[0].startsWith('c4');
      if (el.dataset.k !== it[0]) { el.dataset.k = el.className = it[0]; el.textContent = c4 ? 'C4' : ''; }
      let [x, y] = this.toImg(it[1]);
      if (c4) {
        // Never off the radar: held on its edge, the way to it.
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy), max = EDGE / s;
        if (d > max) { x = cx + (dx / d) * max; y = cy + (dy / d) * max; }
        el.classList.toggle('edge', d > max);
        this.bombMark = el;
      }
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` + (c4 ? upright : '');
    });
  }

  // A planted bomb's beep: its badge flashes and sends out a ring (with the beeps, faster as it runs down).
  beep() {
    const el = this.bombMark;
    if (!el?.classList.contains('planted')) return;
    el.animate([{ filter: 'brightness(1.9)' }, { filter: 'brightness(1)' }], { duration: 260, easing: 'ease-out' });
    el.animate([{ transform: 'scale(1)', opacity: 0.95 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 650, easing: 'ease-out', pseudoElement: '::after' });
  }

  dispose() { this.el.remove(); }
}
