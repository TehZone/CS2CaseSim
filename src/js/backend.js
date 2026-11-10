// Runs game actions: offline on the local save, online on the server (see net/online.js). Pages call act()
// instead of changing the state themselves, so the same rules apply in both modes.
import { S, save, applyDelta } from './state.js';
import { makeCtx, runAction, delta, GameError } from './engine/actions.js';

let remote = null;
export function setRemote(r) { remote = r; }
export const online = () => !!remote;
// Whether the actions can do something an older server's can't (offline they're this game's own: always). 'buyOpen':
// case.open's buy, which buys the cases and keys it's short of in the same request.
export const can = (what) => (remote ? !!remote.can?.(what) : true);

export async function act(name, args = {}) {
  if (remote) return remote.act(name, args);
  const ctx = makeCtx(S);
  const r = runAction(ctx, name, args);
  applyDelta(delta(ctx), { local: true });
  save();
  return r;
}

export { GameError };
