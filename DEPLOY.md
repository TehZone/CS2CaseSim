# Putting the multiplayer server online

The game works offline on its own. To trade and gamble with friends, it plays on one server everyone can reach. That
server now runs on a VPS of your own (OVH, with unlimited traffic), with its database on the same machine. It used to run
on Render and Neon's free plans, which cap transfer at 5 GB a month each; how that was set up is kept at the end, under
"Previous setup (Render + Neon)".

You need a GitHub account with this project pushed to a repository. It has to be public: the game and the server read
its releases without logging in to GitHub, and the VPS clones it the same way.

## Your own server (OVH VPS)

`deploy/vps/` sets up everything on the VPS:

- the server (`node server/index.mjs`, Node.js 22) as the systemd service `cs2-server`, listening on 127.0.0.1:8787 only
- PostgreSQL 18 from apt.postgresql.org, on localhost only (role and database `cs2`)
- Caddy: HTTPS for your domain, with a certificate it gets and renews by itself, passing everything on to the server
  (the game's WebSocket too)
- the auto-deploy, as Render did: about every minute it looks at `main` on GitHub and deploys a new commit, and goes back
  to the commit before if the new one doesn't come up
- a backup of the database every night (14 kept), on top of OVH's daily backup of the whole disk
- a firewall (SSH, HTTP and HTTPS only), keys-only SSH, 2 GB of swap, and updates by themselves: Ubuntu's security
  updates, Caddy's and PostgreSQL's (Node.js updates when setup runs again)

Unlike Render's free plan, the server never sleeps.

### 1. The domain and its DNS record

1. Buy a domain at any registrar. The server answers at a subdomain of it you choose, for example `server.example.com`.
2. Once you have the VPS's IP address (step 2), add a DNS record at the registrar (or wherever its DNS is): type **A**,
   name the subdomain (`server` for `server.example.com`), value the VPS's IPv4 address. If the DNS host offers a proxy
   (Cloudflare's orange cloud, for example), turn it off: **DNS only**. Caddy needs the name to point straight at the VPS
   to get its certificate, and the server counts exactly one proxy in front of it (see "Players' addresses").
3. Don't add an AAAA record for it: keep the name IPv4-only. Network bans and the login and sign-up rate limits go by
   each player's whole address, and over IPv6 a player has a whole block of addresses to pick from (Windows even
   changes its own by itself), which would get around both. Setup warns about any AAAA record.

Add the record before running setup: a new record can take a few minutes (sometimes an hour) to be seen everywhere.
Setup checks it and says when it doesn't point at the VPS.

### 2. Order the VPS

1. On OVHcloud, order a VPS: **VPS-1** (2 vCores, 4 GB RAM, 40 GB NVMe, unlimited traffic at 500 Mbps), location
   **US East (Vint Hill)**, image **Ubuntu 24.04 LTS** (the plain one, no application pre-installed).
2. SSH key: make one on your PC first. In PowerShell: `New-Item -ItemType Directory -Force $HOME\.ssh`, then
   `ssh-keygen -t ed25519 -f $HOME\.ssh\cs2-server` (a passphrase is a good idea). Paste the contents of `cs2-server.pub` into the order's SSH key field. The other file, `cs2-server`
   without `.pub`, is the key to the server: keep it private, and keep a copy somewhere safe. Without it you can only get
   back in through OVH's rescue console.
3. When the VPS is delivered, OVH sends its IP address. Log in with `ssh -i ~/.ssh/cs2-server ubuntu@<ip>` (the first
   time, ssh asks whether to trust the server: yes). The user is `ubuntu`, with sudo.

### 3. Copy the kit up and run setup

From the project folder on your PC:

```bash
scp -i ~/.ssh/cs2-server -r deploy/vps ubuntu@<ip>:~/
```

(Once `deploy/vps` is on GitHub you can instead run `git clone https://github.com/TehZone/CS2CaseSim.git` on the VPS and
use `CS2CaseSim/deploy/vps`.) Then on the VPS:

```bash
sudo bash ~/vps/setup.sh <domain>
```

It takes a few minutes. Every step says what it's doing, and if one fails the message names it. It ends with a status
report, where `https://<domain>/health` should answer. Setup is safe to run again (to change the domain, or with a newer
copy of the kit): it keeps the database, its password and your settings. The `deploy/vps` files have LF line endings
(`.gitattributes`); setup stops and says how to fix them if they arrive with Windows ones.

Setup runs the server from `main` on GitHub as it is. Until `main` has the server change that comes with this kit
(`HOST` and `/health`'s `commit`, in `server/index.mjs`), the server there listens on every interface (the firewall
keeps port 8787 closed, so only Caddy reaches it) and `/health` shows no commit. Setup says so and carries on; the first
deploy after you push `main` (step 4 of the move below) brings both. Pushing that change earlier does no harm on
Render: `HOST` isn't set there, and Render's own `RENDER_GIT_COMMIT` fills in `commit`.

SSH: setup turns off passwords and root logins only after checking that the user who ran it has a key in
`~/.ssh/authorized_keys` and logged in with a key, so you can't be locked out. Otherwise it leaves SSH as it is and says
why.

### 4. The move from Render and Neon

In this order:

1. **The VPS is ready:** `https://<domain>/health` answers. The server runs there on an empty database for now, and
   nothing connects to it yet.
2. **A game release with the new address, uploaded as a draft.** Set `SERVER` in `src/js/net/online.js` to
   `https://<domain>`, and the address that `scripts/test-update-e2e.mjs` and `scripts/test-changelog.mjs` check for.
   Then steps 1, 2 and 4 of "Releasing a new version", but leave the release a draft: don't publish it yet.
3. **Suspend the Render service** in its dashboard. That stops writes to Neon and the old Discord bot. Games already out
   there just see the server as unreachable: their updater reads the release from GitHub, not from the server, so they
   still get the update.
4. **Push `main`.** The VPS deploys it within a minute; `https://<domain>/health` then shows its commit.
5. **Copy the database:** on the VPS, in your own SSH terminal, `sudo cs2-migrate-from-neon`. It asks for Neon's
   connection string (Neon, **Connect**; nothing shows while you paste it), shows Neon's tables and row counts, stops the
   server, dumps Neon, restores the dump here, compares every table's row count on both sides and starts the server on
   the copy. It stops loudly on any difference. Neon is only read, never changed, and its dump stays in
   `/var/backups/cs2-server`.
6. **The Discord bot:** `sudo cs2-set-discord`. Copy the values from Render's Environment page (the bot token is asked
   for without showing it). It restarts the server and waits for the bot to connect.
7. **Publish the release**, then post it to Discord as step 5 of "Releasing a new version" says.
8. **Keep Neon and the suspended Render service for two weeks** before deleting them, in case something turns up.

Neon's connection string and the bot token are typed only into your own SSH terminal: the scripts read them without
showing them, and they never land on a command line, in a log or in the shell's history.

### Day to day

- `sudo cs2-status`: the services, `/health` (on the VPS and over HTTPS), the last deploy and its commit, the last
  backup, disk and memory, the certificate's expiry, and whether a reboot is due.
- Logs: `journalctl -u cs2-server -f` (the server), `journalctl -u cs2-deploy` (deploys), `journalctl -u caddy`.
- **Deploys:** push `main`. A commit that doesn't come up (it crashes, or `/health` doesn't report it within two
  minutes) isn't left running: the deploy goes back to the commit before, and doesn't try the failed one again until
  `main` moves on (`sudo cs2-deploy --force` retries it). A deploy cut short (a reboot in the middle of one, say) is
  finished, or gone back from, by the next run a minute later. Pausing the auto-deploy:
  `sudo systemctl stop cs2-deploy.timer` (`start` resumes it). Like Render's auto-deploy, it runs whatever is on `main`.
- **A hold:** if the move from Neon or a restore stops halfway, it leaves `/var/lib/cs2-deploy/hold`. While it's there
  the server doesn't start, not even after a reboot, and the deploy and the nightly backup do nothing, because the
  database may be half replaced. Running the same script again to the end removes it; `sudo cs2-status` shows it.
- **Settings:** `/etc/cs2-server/env` (`sudoedit /etc/cs2-server/env`, then `sudo systemctl restart cs2-server`). The
  Discord settings: `sudo cs2-set-discord`.
- **Backups:** every night in `/var/backups/cs2-server` (root only, 14 kept); `sudo systemctl start cs2-backup` makes one
  now. `sudo cs2-restore-backup <file>` puts one back (it saves the current database first, and asks).
- **Updates:** Ubuntu's security updates, and every update from Caddy's and PostgreSQL's own repositories, install
  themselves overnight (Caddy and PostgreSQL restart for a moment; players reconnect by themselves). `sudo cs2-status`
  says when a reboot is due, then `sudo reboot` (about a minute). Now and then, `sudo apt update && sudo apt upgrade`
  for Ubuntu's other updates. Node.js: `sudo cs2-status` says when a newer 22.x is out, and running setup again
  installs it. Node.js 22 is supported until April 2027; moving to 24 is `NODE_MAJOR` in `setup.sh`.
- **The kit itself:** once `deploy/vps` is on GitHub, the server's own clone has it, and
  `sudo bash /opt/cs2-server/deploy/vps/setup.sh <domain>` installs a newer one. The deploy never changes the kit.

Where everything is:

| What | Where |
| --- | --- |
| The server's code (a clone of `main`, owned by the `cs2` user) | `/opt/cs2-server` |
| Settings and secrets (`DATABASE_URL`, `HOST`, `TRUST_PROXY`, Discord, `ADMIN_USERS`, `RELEASE_FEED`) | `/etc/cs2-server/env` |
| The Discord bot's token (`DISCORD_TOKEN_FILE` points at it) | `/etc/cs2-server/discord-token` |
| The commit the last deploy started (`SERVER_COMMIT`, `/health` reports it) | `/etc/cs2-server/commit.env` |
| The kit's scripts (the `cs2-*` commands) | `/usr/local/lib/cs2-server` |
| The last deploy, the commit last seen working, a failed commit, a hold | `/var/lib/cs2-deploy` |
| Backups and the dump of Neon | `/var/backups/cs2-server` |
| Caddy's settings | `/etc/caddy/Caddyfile` |

## Play online

The game always plays on one server: the address is `SERVER` in `src/js/net/online.js`, and players never see or
choose it (only the admin panel shows it). If yours is at another address, change it there before building the game.

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
2. On the VPS, `sudo cs2-set-discord` asks for:
   - the bot's token (hidden). It goes into `/etc/cs2-server/discord-token`, which `DISCORD_TOKEN_FILE` points at. Keep
     it private, like the database password.
   - `DISCORD_GUILD_ID`: your Discord server's id (Discord: Settings → Advanced → Developer Mode, then right-click
     the server → **Copy Server ID**). It can be left out while the bot is in only one server.
   - the other settings below (role names, channel ids, `ADMIN_USERS`). Enter keeps a value, `-` removes it.
3. It restarts the server; the bot comes online and registers its slash commands in your server.
   `https://<domain>/health` shows `"discord":{"connected":true}` once it is connected.

Who gets what in the game's admin panel:

- The Discord server's owner: **Owner** (everything).
- A role with the Administrator permission, or the **★ Developer** role: **Admin** (edit accounts and items,
  snapshots and restores, rename, reset, server settings, broadcasts, network and Discord bans).
- The **Moderator** role: **Moderator** (look up players, ban, kick, warn, sign out, notes, save snapshots, read and
  close player reports, clear a reported summary).
  Other role names: set `DISCORD_ADMIN_ROLES` and `DISCORD_MOD_ROLES` (comma-separated).
- Offline (not logged in), every player has the panel for their own offline save only. It never works online and never
  touches an account on the server: online, these levels decide who has it.
- Nobody can act on staff at or above their own level, or ban themselves. Every action is in the audit log, and
  posted to a text channel with `mod-log` in its name (or the channel id in `DISCORD_LOG_CHANNEL`).
- Rare drops online (knives, gloves, Dopplers and Blue Gems, opened or traded up to, see `server/drops.mjs`) go to a text channel with `rare-drops`
  in its name (or the channel id in `DISCORD_DROPS_CHANNEL`). With no such channel they just aren't posted.

Linking: in the game, click your name → **Link Discord**. The game shows a code; in the Discord server type `/link`,
paste the code and press **Link** on the bot's reply. Staff powers come with the link, so staff should only link their
own account. `/unlink` undoes it, `/profile` shows a member's game account, and `/resetpassword` gives a linked
member a one-time code for **Forgot password?** in the game's login.

Good to know:

- The VPS never sleeps, so the bot always answers. (On Render's free plan the server slept after 15 minutes without
  players, and slash commands failed until someone connected.)
- Only one running server may use the bot's token at a time. If you run a second one with the same token (say, on
  your PC while the VPS runs), start that one with `DISCORD_GATEWAY=0`: it then answers no slash commands, and its
  players can't link Discord there (staff levels from the roles of accounts linked already still work). That's also
  why the Render service is suspended before the VPS gets the token.
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

On the VPS, `/etc/cs2-server/env` sets `TRUST_PROXY=1` and `HOST=127.0.0.1`. Caddy is the one proxy: by default it
ignores any `X-Forwarded-For` a player sends and puts only the address it saw there (it would keep the incoming header
only from addresses listed in its `trusted_proxies` option, and none are). So the header holds exactly one entry, the
player's, and the server listens on 127.0.0.1 only, so nothing reaches it without going through Caddy. If you ever put
another proxy in front of Caddy (Cloudflare's proxy on the DNS record, say), Caddy then needs `trusted_proxies` for it
and `TRUST_PROXY` goes up by one.

On Render (the previous setup), `render.yaml` sets `TRUST_PROXY=1`. Render runs every service behind Cloudflare and its
own load balancers, and the address it hands on is the last entry of `X-Forwarded-For`: its guide to reading the client's
address says to read that header and trust one proxy (`app.set('trust proxy', 1)` in Express), see
https://render.com/articles/how-render-handles-ddos-attacks#reading-the-true-client-ip. On your PC, set `TRUST_PROXY`
only behind a reverse proxy you run (nginx, Caddy: `TRUST_PROXY=1`). The server's log says which it uses when it starts
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
3. Push `main` and wait until `https://<domain>/health` reports the pushed commit: its `commit` is what
   `git rev-parse HEAD` prints. The VPS deploys within about a minute. If it doesn't show up after a few minutes,
   `sudo cs2-status` on the VPS says why (a commit that doesn't come up is rolled back, and `journalctl -u cs2-deploy`
   has its log). Nobody is locked out by this: the server goes by the published release.
4. On GitHub: **Releases → Draft a new release**, tag `v<version>`, attach those three files, **Publish release**. A draft
   or a prerelease changes nothing: only publishing does, and only with `latest.json` attached.
5. On Discord: `node scripts/discord-setup.mjs update-log --apply` brings the update log up to date, and
   `node scripts/discord-setup.mjs release <the release's link> --apply` posts `RELEASE_NOTES.md` and the link in the releases
   channel and pings the Release Pings role.

What happens then:

- Within five minutes the server reads the release. Players connected on older versions are told at once and taken
  offline five minutes later; a game on an older version is refused from then on. Offline play is never affected.
- A release that brings what waited for it (badges, custom content, and the rules that ship with them: see
  `CUSTOM_CONTENT.md`, section 8) makes the server start again with it once those five minutes are up (offline for a few
  seconds). An updated game that connects before then is told the server is switching, and tries again.
- The update window comes up at the game's next start or check, or straight away for anyone the server told or refused.
- Exes from before the updater (1.0.0) can't update themselves: the server's refusal tells them where to download.

Good to know:

- **The item database is a lock of its own:** the game and the server must have the same `src/data/game-data.json`
  (its `generatedAt`). If a release regenerates it, every game is refused from the moment the server has the new data
  until players have the new exe, so do steps 3 and 4 back to back.
- The server remembers the required version in its database. If GitHub is down it keeps the last one it read, and with
  no release at all it refuses nobody. `/health` shows it as `requiredVersion`.
- A bad release: delete it (or publish a fixed, higher one). The server follows the newest published release, so the
  version before it is let back in, **unless the bad release changed the data lock** (new badges or custom content: `/health`
  showed `badgesWait` or `customWaits` before it was published). Once the server runs a release's new data, a game of the
  version before can't play with it ("Your game data is a different version"), and deleting the release doesn't take the
  data back off the server. Fix such a release forward: publish a fixed, higher version.
- In an emergency, `RELEASE_FEED=off` lets every version in that has the server's data: on the VPS, add that line to
  `/etc/cs2-server/env` (`sudoedit /etc/cs2-server/env`) and `sudo systemctl restart cs2-server`; remove it again
  afterwards. In production the server then keeps running what the published release has: badges or custom content that
  wait for a release keep waiting (they would lock out every game that's out), and none is let in by it.
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
  `PGLITE_DIR=server/.data`, or any Postgres in `DATABASE_URL`). The version lock is off there unless `RELEASE_FEED`
  is set. The packaged game only plays on the one server; for a local server use the game from `npm run dev` or
  `electron .` and run `(await import('./js/net/online.js')).net.setServerUrl('http://localhost:8787')` in its console.
- `/health` also reports `commit`: `SERVER_COMMIT` (the VPS's deploy sets it) or `RENDER_GIT_COMMIT` (Render sets it),
  `null` without either. `HOST` makes the server listen on that one address (every interface when it's unset).
- `/health`'s `ws` is the open game connections and how many of them are compressed (WebSocket permessage-deflate, which
  the game's browser and the server agree on by themselves, through Caddy): with players online, `deflate` equal to
  `connections` means compression is getting through.
- Tests: `node scripts/test-engine.mjs` (game rules), `node scripts/test-update.mjs` (the updater), `node server/test.mjs`
  (server, trading, gambling), `node server/test-admin.mjs` (the admin panel and the Discord bot, against a stand-in
  Discord), `node server/test-release.mjs` (the version lock) and `node server/test-market.mjs` (the players' Market: its
  table, `p2p_listings`, is made by the server's start like the rest); `npm test` in `server/` runs the server tests.

## Previous setup (Render + Neon)

Before the VPS, the server ran on two free services: **Neon** for the database (free Postgres) and **Render** to run
the server (a free web service, from `render.yaml`). Both free plans cap transfer at 5 GB a month, and on Render's free
plan the server **sleeps after 15 minutes without players**: the first person to connect afterwards waits about a minute
while it wakes up. Kept here until both are deleted (two weeks after the move); `render.yaml` stays for now.

### 1. Create the database (Neon)

1. Sign up at https://neon.tech and create a project (any name; pick a region near you and your friends).
2. On the project dashboard, open **Connect** and copy the connection string. It looks like
   `postgresql://user:password@ep-something.region.aws.neon.tech/neondb?sslmode=require`.
   Keep it private: it is the password to your database.

The server creates its tables by itself on first start.

### 2. Push the project to GitHub

From the project folder:

```bash
git remote add origin https://github.com/<you>/<repo>.git
```

```bash
git push -u origin main
```

(If you are working on another branch, merge it into `main` first, or pick that branch in Render.)

### 3. Create the server (Render)

1. Sign up at https://render.com and connect your GitHub account.
2. Click **New → Blueprint**, pick your repository. Render reads `render.yaml` from the project.
3. When it asks for **DATABASE_URL**, paste the Neon connection string from step 1.
4. Click **Apply**. The first build takes a few minutes. When it is live, open the service: its address looks
   like `https://cs2-case-sim-server.onrender.com`. Opening that address in a browser should show
   "CS2 Case Simulator server ... This server is running".
5. The Discord bot there: the service → **Environment**, `DISCORD_BOT_TOKEN` and the other `DISCORD_*` settings. Render
   restarts the server when they're saved. Pushing `main` deployed it (`autoDeploy`), and Render's deployment status on
   GitHub said when the new server was live.
