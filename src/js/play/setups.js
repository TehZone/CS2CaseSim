// Where players stand, map by map, as in real matches: the counter-terrorists' positions on each site and in mid
// (Mirage's jungle, stairs and ticket booth; Dust II's long, short and back plat...), and the terrorists' default spread
// for map control. Each position is a rough spot (game units, read off the map's overview: spots.js finds the covered
// place within r of it that sees the way in), the callouts the enemy comes in through (CS2's own place names: the way in
// is their path from their spawn through them), and its name as players call it. The first positions on a site are the
// usual ones; awp: an AWPer's. Maps not here are played from spots.js's own spots.
export const SETUPS = {
  de_mirage: {
    CT: {
      A: [
        { id: 'jungle', name: 'jungle', at: [-1030, -1412, -168], watch: ['BombsiteA'] },
        { id: 'stairs', name: 'stairs', at: [-460, -1472, -168], watch: ['PalaceInterior'] },
        { id: 'ticket', name: 'ticket booth', at: [-880, -2312, -260], watch: ['PalaceInterior'], awp: true },
        { id: 'firebox', name: 'firebox', at: [-80, -2087, -200], watch: ['TRamp'] },
        { id: 'triple', name: 'triple', at: [-130, -1687, -200], watch: ['PalaceInterior'] },
      ],
      mid: [
        { id: 'window', name: 'window', at: [-1165, -700, -164], r: 120, watch: ['TopofMid'], awp: true },
        { id: 'connector', name: 'connector', at: [-680, -1087, -264], watch: ['Middle'] },
        { id: 'short', name: 'short', at: [-880, -137, -184], watch: ['Underpass'] },
      ],
      B: [
        { id: 'bench', name: 'bench', at: [-2080, 213, -176], watch: ['Apartments'] },
        { id: 'market', name: 'market window', at: [-1730, -437, -168], watch: ['Apartments'], awp: true },
        { id: 'van', name: 'van', at: [-1680, 13, -176], watch: ['Apartments'] },
        { id: 'backsite', name: 'back of B', at: [-2480, 463, -176], watch: ['Apartments'] },
      ],
    },
    T: [
      { id: 'topmid', name: 'top mid', at: [270, -637, -224], watch: ['Middle'], site: 'mid' },
      { id: 'palace', name: 'palace', at: [720, -1787, -168], watch: ['BombsiteA'], site: 'A' },
      { id: 'ramp', name: 'A ramp', at: [370, -1537, -264], watch: ['BombsiteA'], site: 'A' },
      { id: 'apps', name: 'B apps', at: [-1580, 638, -88], watch: ['BombsiteB'], site: 'B' },
      { id: 'underpass', name: 'underpass', at: [-880, 63, -368], watch: ['Catwalk'], site: 'B' },
    ],
  },
  de_dust2: {
    CT: {
      A: [
        { id: 'long', name: 'long', at: [1462, 2227, 96], watch: ['LongDoors'], awp: true },
        { id: 'short', name: 'A short', at: [1000, 2447, 96], watch: ['Catwalk'] },
        { id: 'ctA', name: 'A site', at: [604, 2447, 96], watch: ['ShortStairs'] },
      ],
      mid: [
        { id: 'middoors', name: 'mid doors', at: [-410, 1900, -120], r: 120, watch: ['TopofMid'], awp: true },
        { id: 'bdoors', name: 'B doors', at: [-1024, 2315, 0], watch: ['UpperTunnel'] },
      ],
      B: [
        { id: 'backplat', name: 'back plat', at: [-1640, 2931, 32], watch: ['UpperTunnel'] },
        { id: 'car', name: 'B car', at: [-1816, 2139, -8], watch: ['UpperTunnel'] },
        { id: 'bsite', name: 'B site', at: [-1530, 2579, 32], watch: ['UpperTunnel'] },
      ],
    },
    T: [
      { id: 'long', name: 'long doors', at: [670, 599, 0], watch: ['LongA'], site: 'A' },
      { id: 'short', name: 'short', at: [-100, 1391, 0], watch: ['ShortStairs'], site: 'A' },
      { id: 'xbox', name: 'mid', at: [-408, 423, 0], watch: ['Middle'], site: 'mid' },
      { id: 'tunnels', name: 'upper tunnels', at: [-1728, 1259, 24], watch: ['BombsiteB'], site: 'B' },
      { id: 'lower', name: 'lower tunnels', at: [-848, 1413, -112], watch: ['MidDoors'], site: 'B' },
    ],
  },
  de_inferno: {
    CT: {
      A: [
        { id: 'pit', name: 'pit', at: [2348, -295, 89], watch: ['Apartments'], awp: true },
        { id: 'site', name: 'A site', at: [2029, 440, 121], watch: ['Apartments'] },
        { id: 'library', name: 'library', at: [2470, 1469, 169], watch: ['TopofMid'] },
      ],
      mid: [
        { id: 'arch', name: 'arch', at: [1833, 1126, 169], watch: ['SecondMid'] },
      ],
      B: [
        { id: 'coffins', name: 'coffins', at: [216, 3478, 121], watch: ['Banana'] },
        { id: 'newbox', name: 'new box', at: [461, 2743, 121], watch: ['Banana'] },
        { id: 'dark', name: 'dark', at: [93, 2645, 121], watch: ['Banana'] },
        { id: 'car', name: 'banana car', at: [461, 2033, 73], watch: ['Banana'], awp: true },
      ],
    },
    T: [
      { id: 'banana', name: 'banana', at: [216, 1322, 73], watch: ['BombsiteB'], site: 'B' },
      { id: 'mid', name: 'mid', at: [657, 538, 89], watch: ['TopofMid'], site: 'mid' },
      { id: 'apps', name: 'apartments', at: [1100, -60, 260], watch: ['BombsiteA'], site: 'A' },
      { id: 'second', name: 'second mid', at: [804, 244, 6], watch: ['Arch'], site: 'A' },
    ],
  },
};

// A match's positions: its map's, in Wingman only those on what's left of the map (Inferno's B and banana are closed off).
export function setupOf(game) {
  const s = SETUPS[game.map.info.id];
  if (!s || game.mode !== 'wingman') return s;
  const open = ({ at }) => game.nav.reaches([at[0] - 64, at[1] - 64, at[2] - 64], [at[0] + 64, at[1] + 64, at[2] + 64]);
  return { CT: Object.fromEntries(Object.entries(s.CT).map(([k, list]) => [k, list.filter(open)])), T: s.T.filter(open) };
}

// A map's position by side and id ('CT:jungle'), or null.
export function setupPosition(mapId, key) {
  const s = SETUPS[mapId];
  if (!s) return null;
  const [side, id] = key.split(':');
  const list = side === 'CT' ? Object.values(s.CT).flat() : s.T;
  return list.find((p) => p.id === id) || null;
}
