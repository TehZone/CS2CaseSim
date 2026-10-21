import * as THREE from 'three';
import { money, debounce } from '../util.js';
import { D } from '../data.js';
import { S, on, coopChickens, chickenRate, coopSlotCost } from '../state.js';
import { sfx } from '../audio.js';
import { itemCard, showItemDetail, toast, tryAct } from '../ui.js';
import { buildChicken } from '../chicken3d.js';
import { chickenIncome } from '../chickens.js';
import { openCaseView } from './cases.js';

let root, offs = [], scene3d = null;

export function render(r) {
  root = r;
  offs.push(on('inv', debounce(() => root && draw(), 150)));
  offs.push(on('money', debounce(() => root && updateAfford(), 100)));
  draw();
}

export function destroy() {
  offs.forEach((o) => o());
  offs = [];
  scene3d?.dispose();
  scene3d = null;
  root = null;
}

function draw() {
  const chickens = S.inv.filter((i) => i.t === 'chicken').sort((a, b) => chickenIncome(b) - chickenIncome(a));
  const inCoop = new Set(coopChickens().map((c) => c.uid));
  const crate = D.caseById['custom-chickens'];
  root.innerHTML = `<div class="page">
    <div class="page-head"><h1>Chicken Coop</h1><span class="sub">Chickens in your coop lay eggs: passive income while you play (and half rate while you're away).</span></div>
    <div class="coop-hero">
      <div class="coop-scene"></div>
      <div class="coop-panel">
        <div class="muted" style="text-transform:uppercase;letter-spacing:1px;font-size:12px">Egg income</div>
        <div class="big">${money(chickenRate())}/s</div>
        <div class="muted">Coop slots: <b style="color:var(--text)">${inCoop.size} / ${S.coopSlots}</b> used · your best earners are placed automatically.</div>
        <button class="btn primary" data-a="slot">Build another nest (${money(coopSlotCost())})</button>
        <button class="btn gold" data-a="crate">Open Chicken Coop Crate (${money(crate.price)})</button>
        <div class="muted" style="font-size:12px;line-height:1.5">Breeds range from Farm Chickens to the ★ Diamond and ★ Dragon Lore chickens. Hats multiply value and egg income; a low feather float is worth more.</div>
      </div>
    </div>
    <div class="section-title">Your chickens (${chickens.length})</div>
    ${chickens.length ? `<div class="grid">${chickens.map((c) => itemCard(c, { extra: inCoop.has(c.uid) ? 'in-coop' : '' })).join('')}</div>` : '<div class="empty">No chickens yet. Open a Chicken Coop Crate to get your first one.</div>'}
  </div>`;
  root.querySelector('[data-a=slot]').addEventListener('click', async () => {
    if (await tryAct('coop.slot')) sfx.buy();
  });
  root.querySelector('[data-a=crate]').addEventListener('click', () => {
    document.querySelector('#nav [data-page=cases]').click();
    openCaseView('custom-chickens');
  });
  root.querySelectorAll('.card[data-uid]').forEach((el) => el.addEventListener('click', () => {
    const it = S.inv.find((i) => i.uid === el.dataset.uid);
    if (it) showItemDetail(it);
  }));
  scene3d?.dispose();
  scene3d = new CoopScene(root.querySelector('.coop-scene'), coopChickens());
  updateAfford();
}

function updateAfford() {
  const b = root?.querySelector('[data-a=slot]');
  if (b) b.disabled = S.money < coopSlotCost();
}

// ---- little 3D farm ------------------------------------------------------------------------
class CoopScene {
  constructor(el, chickens) {
    this.el = el;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.shadowMap.enabled = true;
    el.appendChild(r.domElement);
    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.Fog(0x8fb5d6, 30, 70);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera.position.set(0, 9, 20);
    this.camera.lookAt(0, 0.5, 0);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(8, 14, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16 });
    scene.add(sun, new THREE.HemisphereLight(0xcfe6ff, 0x4f7d3a, 1.1));

    const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ color: 0x5b8c3c, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const dirt = new THREE.Mesh(new THREE.CircleGeometry(9, 40), new THREE.MeshStandardMaterial({ color: 0x9b7a4c, roughness: 1 }));
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = 0.01;
    dirt.receiveShadow = true;
    scene.add(dirt);
    // fence
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.9 });
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.4, 0.25), wood);
      post.position.set(Math.cos(a) * 10, 0.7, Math.sin(a) * 10);
      post.castShadow = true;
      scene.add(post);
    }
    for (const y of [0.55, 1.1]) {
      const rail = new THREE.Mesh(new THREE.TorusGeometry(10, 0.07, 6, 64), wood);
      rail.rotation.x = Math.PI / 2;
      rail.position.y = y;
      scene.add(rail);
    }
    // coop house
    const house = new THREE.Group();
    const walls = new THREE.Mesh(new THREE.BoxGeometry(4, 2.6, 3), new THREE.MeshStandardMaterial({ color: 0xb33a2a, roughness: 0.85 }));
    walls.position.y = 1.3;
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 3, 1.6, 4, 1), new THREE.MeshStandardMaterial({ color: 0x3d3d45, roughness: 0.7 }));
    roof.position.y = 3.4;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.05, 1, 0.8);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1, 1.3, 0.05), new THREE.MeshStandardMaterial({ color: 0x241510 }));
    door.position.set(0, 0.66, 1.52);
    house.add(walls, roof, door);
    house.position.set(-5.5, 0, -5);
    house.rotation.y = 0.5;
    house.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(house);

    this.birds = chickens.map((c, i) => {
      const g = buildChicken(c);
      g.scale.setScalar(0.42);
      const a = (i / Math.max(1, chickens.length)) * Math.PI * 2;
      g.position.set(Math.cos(a) * 4, 0, Math.sin(a) * 4);
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      scene.add(g);
      return { g, target: new THREE.Vector3(), wait: Math.random() * 2, peck: 0, speed: 1.2 + Math.random() * 0.8 };
    });
    this.eggs = [];
    this.clock = new THREE.Timer();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    const loop = () => { if (!this.alive) return; this.tick(); this.raf = requestAnimationFrame(loop); };
    this.alive = true;
    loop();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick() {
    this.clock.update();
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.getElapsed();
    for (const b of this.birds) {
      const p = b.g.position;
      if (b.wait > 0) {
        b.wait -= dt;
        b.peck += dt * 8;
        b.g.children[0] && (b.g.rotation.x = Math.max(0, Math.sin(b.peck)) * 0.35);
        if (b.wait <= 0) {
          const a = Math.random() * Math.PI * 2, rr = 1 + Math.random() * 7.5;
          b.target.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
          b.g.rotation.x = 0;
          if (Math.random() < 0.15) this.layEgg(p);
        }
      } else {
        const d = b.target.clone().sub(p);
        const dist = d.length();
        if (dist < 0.2) b.wait = 0.8 + Math.random() * 2.5;
        else {
          d.normalize();
          p.addScaledVector(d, Math.min(dist, b.speed * dt));
          const ang = Math.atan2(d.x, d.z);
          b.g.rotation.y += ((ang - b.g.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 8);
          p.y = Math.abs(Math.sin(t * 14 + b.speed * 10)) * 0.12;
        }
      }
    }
    for (const e of this.eggs) { e.life -= dt; e.m.position.y = 0.18 + Math.max(0, e.life - 3.5) * 0.4; if (e.life < 1) e.m.scale.setScalar(Math.max(0.01, e.life) * 0.2); }
    this.eggs = this.eggs.filter((e) => (e.life > 0 ? true : (this.scene.remove(e.m), false)));
    const ang = t * 0.05;
    this.camera.position.set(Math.sin(ang) * 20, 9, Math.cos(ang) * 20);
    this.camera.lookAt(0, 0.5, 0);
    this.renderer.render(this.scene, this.camera);
  }

  layEgg(pos) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial({ color: 0xfff4e0, roughness: 0.5 }));
    m.scale.set(0.2, 0.26, 0.2);
    m.position.set(pos.x, 0.18, pos.z);
    this.scene.add(m);
    this.eggs.push({ m, life: 4 });
  }

  dispose() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.scene.traverse((o) => { o.geometry?.dispose(); for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); } });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
