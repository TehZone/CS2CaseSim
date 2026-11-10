#!/usr/bin/env bash
# deploy.sh: the auto-deploy, as Render did on every push to main. cs2-deploy.timer runs it about every minute. When
# origin/main has moved, it checks the new commit out in /opt/cs2-server, runs npm ci in server/ when server/package.json
# or package-lock.json changed, restarts cs2-server and waits for /health to report the new commit. If any of that fails
# it goes back to the commit before and restarts that, so players are never left on a broken server, and it doesn't try
# the failed commit again until main moves on. It goes by the commit last seen answering /health, not by what's checked
# out, so a run cut short on the way (a reboot, an npm ci the timeout ended) is finished by the next one. It prints
# nothing when there's nothing to do; the timer's runs log to the journal (journalctl -u cs2-deploy).
#   sudo systemctl start cs2-deploy     (a run now, logged like the timer's)
#   sudo cs2-deploy --force             (in the terminal: also retries a commit that failed)
# Pulling main runs whatever is on main: the same trust as Render's autoDeploy.
set -Eeuo pipefail
LIB=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=lib.sh
. "$LIB/lib.sh"
trap_errors
need_root
load_kit
cd /
umask 022
force=0
if [ "${1:-}" = --force ]; then force=1; fi

take_lock 0 || exit 0   # setup, a backup, the move from Neon, a restore or a Discord change is running: next minute
if [ -e "$CS2_HOLD" ]; then
  [ "$force" = 0 ] || say "on hold ($(cat "$CS2_HOLD")): nothing deployed"
  exit 0
fi

CS2_STEP='fetching main'
head=$(git_cs2 rev-parse HEAD)
# The commit to go back to: the one last seen answering /health (written by setup.sh and below).
prev=$(cat "$CS2_DEPLOYED" 2>/dev/null) || prev=''
[[ $prev =~ ^[0-9a-f]{40}$ ]] || prev=$head   # (none recorded yet: what's checked out)
fetched=1
# (GitHub down: a deploy cut short is still finished, going by the main fetched last time.)
git_cs2 fetch --quiet origin "+refs/heads/$CS2_BRANCH:refs/remotes/origin/$CS2_BRANCH" ||
  { fetched=0; warn "couldn't fetch $CS2_BRANCH from GitHub: going by the one fetched last time"; }
new=$(git_cs2 rev-parse "refs/remotes/origin/$CS2_BRANCH")
failed=$(cat "$CS2_STATE/failed" 2>/dev/null) || failed=''
# A run cut short between the checkout and /health leaves the checkout, the commit the server is told (commit.env) or
# the one it reports somewhere other than prev: that run is finished now.
running=$(health_commit)
unfinished=0
if [ "$head" != "$prev" ] || [ "$(env_get "$CS2_COMMIT_ENV" SERVER_COMMIT)" != "$prev" ] ||
  { [ -n "$running" ] && [ "$running" != "$prev" ]; }; then
  unfinished=1
fi
# What should run: main, unless main is the commit that failed (then the one before stays).
target=$new
if [ "$new" = "$failed" ] && [ "$force" = 0 ]; then target=$prev; fi

if [ "$unfinished" = 0 ] && [ "$target" = "$prev" ]; then
  # Nothing to deploy (a failed commit was said when it failed; cs2-status shows it). An install that stopped halfway is
  # redone here: the running server has its modules loaded already, so it needs no restart.
  if npm_needed; then
    CS2_STEP='reinstalling the dependencies of the commit running'
    npm_if_changed || die "npm ci failed (above): the server keeps running, the next run tries again."
  fi
  # A server systemd gave up on is started again. One stopped on purpose (systemctl stop) is inactive, not failed: left be.
  if systemctl is-failed --quiet cs2-server.service; then
    CS2_STEP='starting the server again'
    say "cs2-server had failed and systemd wasn't restarting it: starting $(commit_line "$prev") again"
    server_up start
  fi
  [ "$force" = 0 ] || say "main is at $(commit_line "$new"); deployed: $(commit_line "$prev")"
  [ "$fetched" = 1 ] || exit 1   # (the run shows as failed while GitHub can't be reached)
  exit 0
fi

RESTARTED=0
# Checks out $1, installs the server's dependencies when they changed, restarts and waits for /health with $1.
switch_to() {
  local sha=$1
  git_cs2 reset --quiet --hard "$sha" || return 1
  npm_if_changed || return 1
  write_commit_env "$sha" || return 1
  RESTARTED=1
  server_up restart || return 1
  wait_health "$sha" 120 >/dev/null || { say "/health didn't report ${sha:0:7} within 2 minutes"; return 1; }
  mark_deployed "$sha"
}
record() {
  printf 'at=%s\nresult=%s\ncommit=%s\nprevious=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$prev" > "$CS2_STATE/last.tmp" &&
    mv -f "$CS2_STATE/last.tmp" "$CS2_STATE/last"
}
down() {
  record "FAILED, and going back failed too" "$prev"
  if [ "$RESTARTED" = 1 ]; then
    say "GOING BACK FAILED TOO: the server is down. Look at journalctl -u cs2-server -n 100, and sudo cs2-status."
  else
    say "GOING BACK FAILED TOO, before any restart (above): the next run tries again. sudo cs2-status"
  fi
  exit 2
}

if [ "$unfinished" = 1 ]; then
  r=${running:-nothing}
  say "a deploy didn't finish (checked out ${head:0:7}, /health reports ${r:0:7}, last seen working ${prev:0:7}): finishing it"
fi
if [ "$target" = "$prev" ]; then
  # (A run cut short, and main is the commit that failed: everything back on the commit before.)
  CS2_STEP="going back to ${prev:0:7}"
  if switch_to "$prev"; then
    record "back on the commit before (a deploy had stopped halfway)" "$prev"
    say "back on $(commit_line "$prev"): /health answers"
    exit 0
  fi
  down
fi

CS2_STEP="deploying ${new:0:7}"
say "main moved: $(commit_line "$prev")  ->  $(commit_line "$new")"
if switch_to "$new"; then
  rm -f "$CS2_STATE/failed"
  record deployed "$new"
  say "deployed $(commit_line "$new"): /health answers"
  exit 0
fi

printf '%s\n' "$new" > "$CS2_STATE/failed"
CS2_STEP="going back to ${prev:0:7}"
if [ "$RESTARTED" = 0 ] && [ "$unfinished" = 0 ]; then
  # It stopped before the restart (git or npm): the server still runs the commit before. Put the checkout back under it.
  say "DEPLOY FAILED for $(commit_line "$new") before the restart: the server kept running $(commit_line "$prev")"
  git_cs2 reset --quiet --hard "$prev" || true
  npm_if_changed || say "WARNING: reinstalling the dependencies of ${prev:0:7} failed; the next run tries again"
  write_commit_env "$prev" || true
  record "failed before the restart, still on the commit before" "$prev"
  exit 1
fi
if [ "$RESTARTED" = 1 ]; then
  say "DEPLOY FAILED for $(commit_line "$new"). The server's last lines:"
  journalctl -u cs2-server.service -n 30 --no-pager -o cat 2>/dev/null | sed 's/^/    | /' || true
else
  say "DEPLOY FAILED for $(commit_line "$new") (above), after a deploy that hadn't finished: restarting the commit before"
fi
say "going back to $(commit_line "$prev")"
if switch_to "$prev"; then
  record "failed, back on the commit before" "$prev"
  say "back on $(commit_line "$prev"). ${new:0:7} isn't tried again until main moves on (or: sudo cs2-deploy --force)."
  exit 1
fi
down
