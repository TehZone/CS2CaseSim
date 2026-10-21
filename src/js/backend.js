// Runs game actions: offline on the local save, online on the server (see net/online.js). Pages call act()
// instead of changing the state themselves, so the same rules apply in both modes.
import { S, save, applyDelta } from './state.js';
import { makeCtx, runAction, delta, GameError } from './engine/actions.js';

let remote = null;
export function setRemote(r) { remote = r; }
export const online = () => !!remote;

export async function act(name, args = {}) {
  if (remote) return remote.act(name, args);
  const ctx = makeCtx(S);
  const r = runAction(ctx, name, args);
  applyDelta(delta(ctx), { local: true });
  save();
  return r;
}

export { GameError };
