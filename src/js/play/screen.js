// Play's screen: CS2's video settings for the shape of it. Aspect ratio: the window's own, or 4:3 (Normal), 16:10 or
// 16:9 (Widescreen), each with CS2's resolutions; a shape other than the window's either with black bars round it or
// stretched to fill the window, as a stretched resolution is (4:3 on a 16:9 screen: everything a third wider, the HUD
// too). Used by the match (Game.resize) and the settings (play-settings.js).
// CS2's aspect ratios, and the resolutions it offers for each.
export const ASPECTS = { '4:3': 4 / 3, '16:10': 16 / 10, '16:9': 16 / 9 };
export const RESOLUTIONS = {
  '4:3': [[1024, 768], [1152, 864], [1280, 960], [1440, 1080], [1600, 1200], [1920, 1440]],
  '16:10': [[1280, 800], [1440, 900], [1680, 1050], [1920, 1200], [2560, 1600]],
  '16:9': [[1280, 720], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]],
};
// Where the screen goes in a window rw x rh (CSS pixels) for settings { aspect, scaling, resolution }: the window's own
// aspect ('native'); or CS2's 4:3, 16:10 or 16:9 with black bars (the largest box of that shape, centred) or stretched to
// fill the window (laid out at the window's height and that shape, then stretched sideways: the HUD too, as CS2's is at
// a stretched resolution). { x, y, w, h, scaleX, res: [w, h] when a resolution was picked }.
export function screenLayout(rw, rh, { aspect = 'native', scaling = 'stretched', resolution = 'native' } = {}) {
  const a = ASPECTS[aspect];
  const m = /^(\d+)x(\d+)$/.exec(resolution || '');
  const res = a && m && RESOLUTIONS[aspect].some(([w, h]) => w === +m[1] && h === +m[2]) ? [+m[1], +m[2]] : null;
  if (!a) return { x: 0, y: 0, w: rw, h: rh, scaleX: 1, res: null };
  if (scaling === 'bars') {
    const w = Math.min(rw, rh * a), h = w / a;
    return { x: Math.round((rw - w) / 2), y: Math.round((rh - h) / 2), w: Math.round(w), h: Math.round(h), scaleX: 1, res };
  }
  const w = Math.round(rh * a);
  return { x: 0, y: 0, w, h: rh, scaleX: rw / w, res };
}
