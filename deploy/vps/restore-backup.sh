#!/usr/bin/env bash
# restore-backup.sh: puts a backup back: replaces the server's database with a pg_dump file (a nightly backup, or the
# before-move or neon dump the move from Neon kept), saving the current database first. Run it in your SSH terminal:
#   sudo cs2-restore-backup /var/backups/cs2-server/cs2-20261110-041500.dump
#   sudo cs2-restore-backup            (lists the backups there are)
# Everything players did since that backup is lost, so it asks for a typed "yes" first.
set -Eeuo pipefail
LIB=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=lib.sh
. "$LIB/lib.sh"
trap_errors
need_root
load_kit
cd /
umask 077
if [ -z "${1:-}" ]; then
  say "Backups in $CS2_BACKUPS (newest last):"
  ls -1shtr "$CS2_BACKUPS"/*.dump 2>/dev/null | sed 's/^/      /' || say "  none"
  say "Usage: sudo cs2-restore-backup <file>"
  exit 0
fi
need_terminal
dump=$(readlink -f -- "$1") || dump=$1
[ -f "$dump" ] || die "$1 isn't a file."
take_lock 300 || die "A deploy, backup or Discord change held the lock for 5 minutes: try again in a minute."
load_local_db
STOPPED=0 REPLACING=0
finish() {
  local rc=$?
  [ "$rc" != 0 ] || return 0
  if [ "$REPLACING" = 1 ]; then
    printf '\n    The database was being replaced, so the server stays stopped, even after a reboot (the deploy too), until a\n' >&2
    printf '    restore gets to the end.\n' >&2
    printf '    Run this again, or put back the copy saved first (above).\n' >&2
  elif [ "$STOPPED" = 1 ]; then
    rm -f "$CS2_HOLD"
    server_up start && printf '\n    Nothing was replaced: the server is running again.\n' >&2
  fi
}
trap finish EXIT

step "Checking $dump"
listing=$(dump_listing "$dump") || die "pg_restore -l can't read $dump."
entries=$(printf '%s\n' "$listing" | count_matching '^[0-9]')
say "$(du -h "$dump" | cut -f1), $entries entries, made $(date -u -r "$dump" '+%Y-%m-%d %H:%M UTC')"
say "this server has $(local_players) players now; everything since that backup will be gone"
confirm_yes "Replace the database with this backup?" || die "Stopped: nothing was changed."

step "Stopping the server and saving the current database"
printf 'a restore (restore-backup.sh), started %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')" > "$CS2_HOLD"
STOPPED=1
systemctl stop cs2-server.service
install -d -m 0700 -o root -g root "$CS2_BACKUPS"
saved=$CS2_BACKUPS/before-restore-$(date -u +%Y%m%d-%H%M%S).dump
runuser -u postgres -- "$(pg_bin pg_dump)" -Fc -d "$CS2_DB" > "$saved"
say "saved first: $saved"

step "Restoring"
REPLACING=1
recreate_and_restore "$dump" || die "The restore failed (above)."
local_counts=$(table_counts local_sql)
[ -z "$local_counts" ] || printf '%s\n' "$local_counts" | awk '{ printf "    %-30s %10s rows\n", $1, $2 }'

step "Starting the server"
rm -f "$CS2_HOLD"
REPLACING=0 STOPPED=0
server_up start
head=$(git_cs2 rev-parse HEAD)
if body=$(wait_health "$head" 120); then
  say "/health: $body"
  mark_deployed "$head"
else
  journalctl -u cs2-server.service -n 40 --no-pager -o cat 2>/dev/null | sed 's/^/    | /' >&2 || true
  die "The server didn't answer /health within 2 minutes (its last lines are above)."
fi
say "restored: $(local_players) players"
