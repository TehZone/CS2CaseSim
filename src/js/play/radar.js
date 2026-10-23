// The radar: CS2's overview image of the map (resource/overviews placement), rotating with your view and centred on
// you, with your teammates, enemies your team has spotted, the bomb and pings. Made of elements the page's compositor
// moves (the overview turned and shifted with a transform, the marks inside it) rather than a 2D canvas: a canvas over
// the game's cost a third of the frame rate.
const ZOOM = 0.9, SIZE = 230; // overview pixels to radar pixels (the overview is 1024 px; the radar 230 px across)

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
    const mine = myTeam === 'CT' ? 'ct' : 't', list = [];
    for (const m of mates) if (m.alive) list.push(['dot ' + mine, m.pos]);
    for (const e of enemies) list.push(['dot enemy', e.pos]);
    for (const p of pings) list.push(['ping', p.pos]);
    if (bomb) list.push([bomb.planted ? 'c4 planted' : 'c4', bomb.pos]);
    while (this.marks.length < list.length) { const i = document.createElement('i'); this.map.appendChild(i); this.marks.push(i); }
    this.marks.forEach((el, k) => {
      const it = list[k];
      if (!it) { if (el.className !== 'off') el.className = 'off'; return; }
      if (el.className !== it[0]) { el.className = it[0]; el.textContent = it[0].startsWith('c4') ? 'C4' : ''; }
      const [x, y] = this.toImg(it[1]);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    });
  }

  dispose() { this.el.remove(); }
}
