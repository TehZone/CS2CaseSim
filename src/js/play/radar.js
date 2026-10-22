// The radar: CS2's overview image of the map (resource/overviews placement), rotating with your view and centred on
// you, with your teammates, enemies your team has spotted, the bomb and pings.
export class Radar {
  constructor(root, info) {
    this.info = info;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'play-radar';
    this.size = 230;
    this.canvas.width = this.canvas.height = this.size * 2; // sharp on high-DPI screens
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.img = new Image();
    this.img.src = info.image;
  }

  // Game position -> overview image pixels (1024 px image).
  toImg(p) { return [(p[0] - this.info.x) / this.info.scale, (this.info.y - p[1]) / this.info.scale]; }

  draw({ center, yaw, mates = [], enemies = [], bomb = null, pings = [], myTeam }) {
    const ctx = this.ctx, S = this.canvas.width, zoom = 0.9;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'rgba(10,14,20,0.75)';
    ctx.fillRect(0, 0, S, S);
    ctx.translate(S / 2, S / 2);
    ctx.rotate(((yaw - 90) * Math.PI) / 180);
    ctx.scale(zoom, zoom);
    const [cx, cy] = this.toImg(center);
    ctx.translate(-cx, -cy);
    if (this.img.complete && this.img.naturalWidth) { ctx.globalAlpha = 0.9; ctx.drawImage(this.img, 0, 0, 1024, 1024); ctx.globalAlpha = 1; }
    const dot = (p, color, r = 9) => { const [x, y] = this.toImg(p); ctx.beginPath(); ctx.arc(x, y, r / zoom, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2 / zoom; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke(); };
    const mine = myTeam === 'CT' ? '#5aa9ff' : '#f2c14e';
    for (const m of mates) if (m.alive) dot(m.pos, mine);
    for (const e of enemies) dot(e.pos, '#ff4040');
    for (const p of pings) {
      const [x, y] = this.toImg(p.pos), r = 11 / zoom;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      ctx.fillStyle = '#ffd23c'; ctx.fill(); ctx.lineWidth = 2 / zoom; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke();
    }
    if (bomb) { const [x, y] = this.toImg(bomb.pos); ctx.fillStyle = bomb.planted ? '#ff3030' : '#ffb000'; ctx.font = `bold ${22 / zoom}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('C4', x, y + 8 / zoom); }
    ctx.restore();
    // You: an arrow in the middle pointing up.
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(9, 10); ctx.lineTo(0, 5); ctx.lineTo(-9, 10); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.stroke();
  }

  dispose() { this.canvas.remove(); }
}
