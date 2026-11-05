# Putting the multiplayer server online (Render + Neon, free)

The game works offline on its own. To trade and gamble with friends, run the server somewhere everyone can
reach. This guide uses two free services:

- **Neon** for the database (free Postgres; player accounts, inventories and trades live here)
- **Render** to run the server (a free web service)

On Render's free plan the server **sleeps after 15 minutes without players**. The first person to connect
afterwards waits about a minute while it wakes up (the game shows "Connecting…" and retries on its own).
Nothing is lost while it sleeps: everything is saved in Neon.

You need a GitHub account with this project pushed to a repository. It has to be public: the game and the server read
its releases without logging in to GitHub.

## 1. Create the database (Neon)

1. Sign up at https://neon.tech and create a project (any name; pick a region near you and your friends).
2. On the project dashboard, open **Connect** and copy the connection string. It looks like
   `postgresql://user:password@ep-something.region.aws.neon.tech/neondb?sslmode=require`.
   Keep it private: it is the password to your database.

The server creates its tables by itself on first start.

## 2. Push the project to GitHub

From the project folder:

```bash
git remote add origin https://github.com/<you>/<repo>.git
```

```bash
git push -u origin main
```

(If you are working on another branch, merge it into `main` first, or pick that branch in Render.)

## 3. Create the server (Render)

1. Sign up at https://render.com and connect your GitHub account.
2. Click **New → Blueprint**, pick your repository. Render reads `render.yaml` from the project.
3. When it asks for **DATABASE_URL**, paste the Neon connection string from step 1.
4. Click **Apply**. The first build takes a few minutes. When it is live, open the service: its address looks
   like `https://cs2-case-sim-server.onrender.com`. Opening that address in a browser should show
   "CS2 Case Simulator server ... This server is running".

## 4. Play online

The game always plays on one server: the address is `SERVER` in `src/js/net/online.js`. If yours is at another address,
change it there before building the game.

1. Start the game, click **Offline** at the top right.
2. Enter a username and a password, then **Create account**. Your friends do the same with their own usernames.
3. Online accounts start fresh with $10 and are saved on the server. Your offline save stays on your PC and you
   can switch back any time (click your name → Log out).

## Discord: account linking and the admin panel

The server can run the game's Discord bot. With it, players link their game account to their Discord account, the
Discord server's roles decide who is staff in the game's **Admin** page (More menu), and staff get `/game` commands
in Discord. Without it everything else works the same; see `ADMIN_USERS` below for staff.

1. Use the bot you added to your Discord server with `scripts/discord-setup.mjs` (Developer Portal → your
   application → **Bot** → **Reset Token** if you no longer have its token). The bot needs to be in the server.
2. On Render, open the service → **Environment** and add:
   - `DISCORD_BOT_TOKEN`: the bot's token. Keep it private, like the database password.
   - `DISCORD_GUILD_ID`: your Discord server's id (Discord: Settings → Advanced → Developer Mode, then right-click
     the server → **Copy Server ID**). It can be left out while the bot is in only one server.
3. Save. Render restarts the server, the bot comes online and registers its slash commands in your server.
   `https://<your-server>.onrender.com/health` shows `"discord":{"connected":true}` once it is connected.

Who gets what in the game's admin panel:

- The Discord server's owner: **Owner** (everything).
- A role with the Administrator permission, or the **★ Developer** role: **Admin** (edit accounts and items,
  snapshots and restores, rename, reset, server settings, broadcasts, network and Discord bans).
- The **Moderator** role: **Moderator** (look up players, ban, kick, warn, sign out, notes, save snapshots).
  Other role names: set `DISCORD_ADMIN_ROLES` and `DISCORD_MOD_ROLES` (comma-separated).
- Nobody can act on staff at or above their own level, or ban themselves. Every action is in the audit log, and
  posted to a text channel with `mod-log` in its name (or the channel id in `DISCORD_LOG_CHANNEL`).

Linking: in the game, click your name → **Link Discord**. The game shows a code; in the Discord server type `/link`,
paste the code and press **Link** on the bot's reply. Staff powers come with the link, so staff should only link their
own account. `/unlink` undoes it, `/profile` shows a member's game account, and `/resetpassword` gives a linked
member a one-time code for **Forgot password?** in the game's login.

Good to know:

- The bot only answers while the server is awake. On Render's free plan the server sleeps after 15 minutes without
  players, and slash commands then fail until someone connects (open the server's address in a browser to wake it).
- Only one running server may use the bot's token at a time. If you run a second one with the same token (say, on
  your PC while Render runs), start that one with `DISCORD_GATEWAY=0`: it then answers no slash commands, and its
  players can't link Discord there (staff levels from the roles of accounts linked already still work).
- A server without Discord (your PC, a test server): give staff by game username with `ADMIN_USERS=alice,bob`
  (they are admins). Register those names yourself first, since anyone who registers a listed name gets admin.
  Running it directly also takes `node server/index.mjs --admins alice,bob --discord-token-file <path to a file
  holding the token>`.
- IP addresses are never stored: network bans compare a salted hash of them. How the server finds a player's
  address: see "Players' addresses" below.

## Players' addresses

Network bans and the login and sign-up rate limits go by each player's address. `TRUST_PROXY` tells the server where to
find it:

- **Unset (the default):** the address of the connection itself. Right for a server people connect to directly, such
  as one on your PC that friends reach on port 8787: an `X-Forwarded-For` header is then ignored, since a player could
  put any address in it (to get around a network ban, or to make one hit someone else).
- **A number of proxy hops** (`TRUST_PROXY=1`): the server sits behind that many reverse proxies, each adding the
  address it saw to the end of `X-Forwarded-For`. The server takes the entry that many places from the end; anything
  before it was written by the player and is never used.

On Render, `render.yaml` sets `TRUST_PROXY=1`. Render runs every service behind Cloudflare and its own load balancers,
and the address it hands on is the last entry of `X-Forwarded-For`: its guide to reading the client's address says to
read that header and trust one proxy (`app.set('trust proxy', 1)` in Express), see
https://render.com/articles/how-render-handles-ddos-attacks#reading-the-true-client-ip. If you put another proxy of
your own in front (say, your own Cloudflare proxying a custom domain), count it too. On your PC, set `TRUST_PROXY` only
behind a reverse proxy you run (nginx, Caddy: `TRUST_PROXY=1`). The server's log says which it uses when it starts
(`[server] client addresses: ...`). A count that is too low shows up as every player having the same address: in the
admin panel, every account lists every other one as an alt.

## Releasing a new version

Players get new versions from this repository's GitHub Releases. The game looks at the latest release when it starts and
every four hours and offers it (`shared/updater.cjs`, `src/js/update.js`). Only the latest version may play online
(`server/release.mjs`), so **publishing a release locks out every older version** within about five minutes.

1. Put the new version in `package.json` (`x.y.z`, higher than the last release) and what changed in `RELEASE_NOTES.md`:
   the update window shows it.
2. `npm run dist`. `dist/` then holds the three files of the release: `CS2-Case-Simulator-Setup.exe`,
   `CS2-Case-Simulator.exe` and `latest.json` (the version, the notes, and each exe's size and SHA-256).
3. Push `main` and wait for Render to deploy it. Nobody is locked out by this: the server goes by the published release.
4. On GitHub: **Releases → Draft a new release**, tag `v<version>`, attach those three files, **Publish release**. A draft
   or a prerelease changes nothing: only publishing does, and only with `latest.json` attached.
5. On Discord: `node scripts/discord-setup.mjs update-log --apply` brings the update log up to date, and
   `node scripts/discord-setup.mjs release <the release's link> --apply` posts the link in the releases channel.

What happens then:

- Within five minutes the server reads the release. Players connected on older versions are told at once and taken
  offline five minutes later; a game on an older version is refused from then on. Offline play is never affected.
- The update window comes up at the game's next start or check, or straight away for anyone the server told or refused.
- Exes from before the updater (1.0.0) can't update themselves: the server's refusal tells them where to download.

Good to know:

- **The item database is a lock of its own:** the game and the server must have the same `src/data/game-data.json`
  (its `generatedAt`). If a release regenerates it, every game is refused from the moment Render has the new data
  until players have the new exe, so do steps 3 and 4 back to back.
- The server remembers the required version in its database. If GitHub is down it keeps the last one it read, and with
  no release at all it refuses nobody. `/health` shows it as `requiredVersion`.
- A bad release: delete it (or publish a fixed, higher one). The server follows the newest published release, so the
  version before it is let back in. In an emergency, `RELEASE_FEED=off` on Render lets every version in.
- Reusing a version number does nothing for players who already have it: always go up.
- The lock trusts the version a game sends. It stops everyone playing the normal game, not someone who modifies theirs.
- `node scripts/test-update-e2e.mjs build` and `run` try a real update on two test builds (its own install, never the real
  game's) against a stand-in for GitHub.
- **The in-game Changelog needs nothing by hand.** `npm run dist` makes it from the git log, the same source as Discord's
  update log (`scripts/build-changelog.mjs`), and stops if it can't. A new commit shows as written unless it mentions
  something players shouldn't read: those are held back, and the build lists them. To show one, or to hide or reword
  anything, edit `scripts/data/changelog-notes.json`; `node scripts/build-changelog.mjs --report` lists every decision.
- The build also records where this version's updates end, in `scripts/data/changelog-versions.json`. Commit that file
  with the release.

## Notes

- Market prices: the server refreshes them from the marketplaces once a day; online players see the server's
  prices so item values match what the server pays.
- Everything is virtual money. There are no real-money purchases and nothing can be cashed out.
- Running the server on your own PC instead: `cd server && npm install`, then from the project folder
  `node server/index.mjs` (it uses an embedded database stored in `server/.data` when started with
  `PGLITE_DIR=server/.data`, or Neon if `DATABASE_URL` is set). The version lock is off there unless `RELEASE_FEED`
  is set. The packaged game only plays on the one server; for a local server use the game from `npm run dev` or
  `electron .` and run `(await import('./js/net/online.js')).net.setServerUrl('http://localhost:8787')` in its console.
- Tests: `node scripts/test-engine.mjs` (game rules), `node scripts/test-update.mjs` (the updater), `node server/test.mjs`
  (server, trading, gambling), `node server/test-admin.mjs` (the admin panel and the Discord bot, against a stand-in
  Discord) and `node server/test-release.mjs` (the version lock); `npm test` in `server/` runs the server tests.
