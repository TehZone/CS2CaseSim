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
- Tests: `node scripts/test-engine.mjs` (game rules) and `node server/test.mjs` (server, trading, gambling).
