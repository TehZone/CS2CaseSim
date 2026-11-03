# Putting the multiplayer server online (Render + Neon, free)

The game works offline on its own. To trade and gamble with friends, run the server somewhere everyone can
reach. This guide uses two free services:

- **Neon** for the database (free Postgres; player accounts, inventories and trades live here)
- **Render** to run the server (a free web service)

On Render's free plan the server **sleeps after 15 minutes without players**. The first person to connect
afterwards waits about a minute while it wakes up (the game shows "Connecting…" and retries on its own).
Nothing is lost while it sleeps: everything is saved in Neon.

You need a GitHub account with this project pushed to a repository (private is fine).

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

1. Start the game, click **Offline** at the top right.
2. Enter the server address from step 3 (for example `cs2-case-sim-server.onrender.com`), a username and a
   password, then **Create account**. Your friends do the same with their own usernames.
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

## Updating

The game and the server must come from the same version of the project (same item database). After you change
the project, push to GitHub (Render redeploys automatically) and rebuild the game with `npm run dist`, then give
your friends the new `.exe`. If versions differ, the game says so when connecting.

## Notes

- Market prices: the server refreshes them from the marketplaces once a day; online players see the server's
  prices so item values match what the server pays.
- Everything is virtual money. There are no real-money purchases and nothing can be cashed out.
- Running the server on your own PC instead: `cd server && npm install`, then from the project folder
  `node server/index.mjs` (it uses an embedded database stored in `server/.data` when started with
  `PGLITE_DIR=server/.data`, or Neon if `DATABASE_URL` is set). Friends connect to your PC's address on port
  8787 (needs port forwarding or something like Tailscale).
- Tests: `node scripts/test-engine.mjs` (game rules), `node server/test.mjs` (server, trading, gambling) and
  `node server/test-admin.mjs` (the admin panel and the Discord bot, against a stand-in Discord; `npm test` in
  `server/` runs both server tests).
