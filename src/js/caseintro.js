// The case opening intro before the roulette, like CS2: the container drops in, lands and unlocks. Uses the
// container's real 3D crate and CS2's own animations when available, otherwise its icon does the same in 2D.
import { S } from './state.js';
import { sfx } from './audio.js';
import { loadCrate } from './cs2/crate.js';
import { esc } from './util.js';

const LOAD_WAIT = 2500; // first use exports the crate from CS2; don't keep the player waiting for it

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Plays the intro inside `host`. Returns { done, skip }: `done` resolves when the container is open.
export function playCaseIntro(host, c, img) {
  let skipped = false, scene = null, wake = null;
  const skip = () => { skipped = true; scene?.skip(); wake?.(); };
  const pause = (ms) => (skipped ? Promise.resolve() : new Promise((r) => { wake = r; setTimeout(r, ms); }));
  const speed = S.settings.fast ? 1.8 : 1;

  const done = (async () => {
    scene = await Promise.race([loadCrate(c.id).catch(() => null), wait(LOAD_WAIT).then(() => null)]);
    if (skipped) return;
    if (scene) {
      host.classList.add('crate3d');
      scene.mount(host);
      try {
        sfx.drop();
        await scene.play('fall', speed);
        if (skipped) return;
        sfx.open();
        await scene.play('open', speed);
        await pause(550 / speed); // a moment to see it open
      } finally {
        setTimeout(() => scene.unmount(), 450); // after the stage has faded out
      }
      return;
    }
    // 2D: the icon falls in, bounces, shakes and bursts open.
    host.classList.add('crate2d');
    host.style.setProperty('--speed', speed);
    host.innerHTML = `<div class="burst"></div><img src="${esc(img)}" alt="">`;
    host.classList.add('fall');
    await pause(560 / speed);
    sfx.drop();
    await pause(420 / speed);
    if (skipped) return;
    host.classList.add('open');
    sfx.open();
    await pause(900 / speed);
  })();
  return { done, skip };
}
