#!/usr/bin/env bash
# website-sync.sh: keeps the game's website (website/ in the repo) up to date with main on GitHub. cs2-website.timer
# runs it about every minute as the cs2web user; setup.sh installs both when it's given the website's domain. It has a
# clone of its own in /opt/cs2-website, sparse and blobless: only website/ (and the few files at the top of the repo) is
# checked out, and GitHub sends only what that needs. Caddy serves /opt/cs2-website/website straight from it, so a push
# to main shows on the site within a minute or so. It never touches the game server: not its clone, its lock, its
# deploys or cs2-server itself, and it restarts nothing. (deploy.sh, for its part, leaves a main that changed only
# website/ alone, so a push of the website alone never restarts the server.)
# It prints nothing when main hasn't moved; the timer's runs log to the journal (journalctl -u cs2-website).
#   sudo systemctl start cs2-website    (a run now, logged like the timer's)
#   sudo cs2-website-sync               (the same, in the terminal)
set -Eeuo pipefail
LIB=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=lib.sh
. "$LIB/lib.sh"
trap_errors
cd /
umask 022   # (what it checks out stays readable by Caddy)

# Run by hand with sudo: as cs2web, like the timer, so the clone stays cs2web's.
if [ "$(id -u)" = 0 ]; then
  id "$CS2_WEB_USER" >/dev/null 2>&1 || die "There's no $CS2_WEB_USER user: run setup.sh with the website's domain first."
  exec runuser -u "$CS2_WEB_USER" -- env -C / HOME="$CS2_WEB_HOME" PATH="$CS2_PATH" bash "$LIB/website-sync.sh" "$@"
fi
[ "$(id -un)" = "$CS2_WEB_USER" ] || die "Run it with sudo (sudo cs2-website-sync) or as $CS2_WEB_USER."
[ -d "$CS2_WEB" ] && [ -w "$CS2_WEB" ] || die "$CS2_WEB is missing or isn't $CS2_WEB_USER's: run setup.sh with the website's domain."

# One run at a time (a run by hand while the timer's is on). Its own lock: the server's jobs never wait for this one.
exec 8>>"$CS2_WEB_HOME/sync.lock"
if ! flock -n 8; then
  [ ! -t 1 ] || say "another run is going on (the timer's, most likely): try again in a moment"
  exit 0
fi

if [ ! -d "$CS2_WEB/.git" ]; then
  CS2_STEP='cloning the website'
  [ -z "$(ls -A "$CS2_WEB")" ] || die "$CS2_WEB isn't empty and isn't a git clone: move it away, and the next run clones it."
  git_web clone --quiet --filter=blob:none --no-checkout --branch "$CS2_BRANCH" "$CS2_REPO_URL" .
  git_web sparse-checkout set --cone website
  git_web checkout --quiet "$CS2_BRANCH"
  say "cloned $CS2_BRANCH, only website/ checked out: $(git_web log -1 --format='%h %s')"
  [ -f "$CS2_WEB/website/index.html" ] || warn "$CS2_BRANCH has no website/index.html: the site answers 404 until it has."
  exit 0
fi

CS2_STEP='fetching main'
origin=$(git_web remote get-url origin 2>/dev/null) || origin=''
[ "$origin" = "$CS2_REPO_URL" ] || die "$CS2_WEB is a clone of ${origin:-nothing}, not $CS2_REPO_URL."
# (A first run cut short between the clone and its sparse checkout: finished here, so only website/ is checked out.)
[ "$(git_web config --get core.sparseCheckout 2>/dev/null)" = true ] || git_web sparse-checkout set --cone website
git_web fetch --quiet origin "+refs/heads/$CS2_BRANCH:refs/remotes/origin/$CS2_BRANCH" ||
  die "couldn't fetch $CS2_BRANCH from GitHub: the site stays as it is, and the next run tries again"
head=$(git_web rev-parse HEAD)
new=$(git_web rev-parse "refs/remotes/origin/$CS2_BRANCH")
# Nothing to do: main hasn't moved and nothing checked out was changed by hand.
if [ "$new" = "$head" ] && [ -z "$(git_web status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  [ ! -t 1 ] || say "up to date: $(git_web log -1 --format='%h %s')"   # (in a terminal; the timer's runs stay quiet)
  exit 0
fi

CS2_STEP="checking out ${new:0:7}"
git_web reset --quiet --hard "$new"
# (Trees only, never file contents: in this clone a diff of contents would fetch them.)
if [ "$new" = "$head" ]; then
  say "put back what was changed by hand in $CS2_WEB: $(git_web log -1 --format='%h %s')"
elif git_web diff-tree --quiet "$head" "$new" -- website; then
  :   # (main moved without touching website/: the site is as it was)
else
  say "website/ updated: ${head:0:7} -> $(git_web log -1 --format='%h %s')"
fi
[ -f "$CS2_WEB/website/index.html" ] || warn "$CS2_BRANCH has no website/index.html: the site answers 404 until it has."
exit 0
