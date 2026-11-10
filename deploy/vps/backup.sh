#!/usr/bin/env bash
# backup.sh: a backup of the server's database: pg_dump -Fc into /var/backups/cs2-server (root only), checked with
# pg_restore -l, keeping the newest 14. cs2-backup.timer runs it every night (OVH also backs up the whole disk daily);
# while a replace of the database is unfinished (the hold), it makes none, so the good ones aren't pushed out.
#   sudo systemctl start cs2-backup     (a backup now, logged: journalctl -u cs2-backup)
#   sudo cs2-backup                     (the same, in the terminal)
# A backup goes back in with: sudo cs2-restore-backup /var/backups/cs2-server/cs2-<date>.dump
set -Eeuo pipefail
LIB=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=lib.sh
. "$LIB/lib.sh"
trap_errors
need_root
load_kit
cd /
umask 077
KEEP=14

CS2_STEP='waiting for the lock'
take_lock 3600 || die "Another job (a deploy, the move from Neon, a restore) held the lock for an hour: no backup."
if [ -e "$CS2_HOLD" ]; then
  # (A replace that didn't finish: the database may be half there. The backups already made are what's worth keeping,
  # and 14 nights of this would push them all out.)
  say "on hold ($(cat "$CS2_HOLD")): no backup tonight, the ones there are kept"
  exit 0
fi
install -d -m 0700 -o root -g root "$CS2_BACKUPS"
file=$CS2_BACKUPS/cs2-$(date -u +%Y%m%d-%H%M%S).dump
tmp=$file.partial
trap 'rm -f "$tmp"' EXIT

CS2_STEP='pg_dump'
runuser -u postgres -- "$(pg_bin pg_dump)" -Fc -d "$CS2_DB" > "$tmp"
CS2_STEP='checking it with pg_restore -l'
listing=$(dump_listing "$tmp") || die "pg_restore -l can't read the new backup: it was deleted."
entries=$(printf '%s\n' "$listing" | count_matching '^[0-9]')
tables=$(printf '%s\n' "$listing" | count_matching ' TABLE DATA ')
mv -f "$tmp" "$file"

CS2_STEP='keeping the newest 14'
mapfile -t old < <(ls -1 "$CS2_BACKUPS"/cs2-*.dump | LC_ALL=C sort | head -n -"$KEEP")
[ "${#old[@]}" = 0 ] || rm -f -- "${old[@]}"
kept=$(ls -1 "$CS2_BACKUPS"/cs2-*.dump | wc -l)
say "backup: $file ($(du -h "$file" | cut -f1), $entries entries, $tables tables with data); $kept kept, ${#old[@]} older deleted"
