#!/usr/bin/env bash
# migrate-from-neon.sh: the move from Neon, once. It copies the Neon database into this server's PostgreSQL, checks
# every table's row count against Neon, and starts the server on the copy. Run it in your own SSH terminal after
# suspending the Render service (DEPLOY.md, "The move from Render and Neon"):
#   sudo cs2-migrate-from-neon        (the same as sudo bash ~/vps/migrate-from-neon.sh)
# It asks for Neon's connection string without showing it. The string becomes PGHOST/PGUSER/PGPASSWORD/... for psql
# and pg_dump only, so it never appears on a command line (ps), in a log or in the shell's history. Safe to run again:
# each run replaces this server's database with a fresh copy (asking first when it already has players), and it works
# just the same when this server, or Neon, has never had any data.
set -Eeuo pipefail
LIB=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=lib.sh
. "$LIB/lib.sh"
trap_errors
need_root
need_terminal
load_kit
cd /
umask 077
unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE PGOPTIONS PGCHANNELBINDING PGSERVICE PGSERVICEFILE \
  PGPASSFILE PGSSLROOTCERT PGAPPNAME PGCONNECT_TIMEOUT PGTARGETSESSIONATTRS
take_lock 300 || die "A deploy, backup or Discord change held the lock for 5 minutes: try again in a minute."
load_local_db
tmpd=$(mktemp -d)
STOPPED=0 REPLACING=0
finish() {
  local rc=$?
  stty echo 2>/dev/null || true
  rm -rf "$tmpd"
  [ "$rc" != 0 ] || return 0
  if [ "$REPLACING" = 1 ]; then
    printf '\n    This server'\''s database was being replaced, so the server stays stopped, even after a reboot (and the\n' >&2
    printf '    deploy leaves it alone), until a run of this script gets to the end. Neon is unchanged: run it again.\n' >&2
  elif [ "$STOPPED" = 1 ]; then
    rm -f "$CS2_HOLD"
    server_up start &&
      printf '\n    This server'\''s database wasn'\''t touched: the server is running again, as before.\n' >&2
  fi
}
trap finish EXIT

cat <<EOF

The move from Neon: Neon's database is copied into this server's PostgreSQL $PG_MAJOR, each table's rows are counted
on both sides, and the server starts on the copy.

The Render service must be suspended first (Render dashboard, the service, Suspend): then nothing writes to Neon and
the old Discord bot is off. Neon itself is only read, never changed.
EOF
confirm_yes "Is the Render service suspended?" || die "Suspend it first, then run this again. Nothing was changed."

# ---------------------------------------------------------------------------------------------------------------------
step "1/8  Neon's connection string"
say "Paste it from Neon (Connect: postgresql://...). Nothing shows while you paste; press Enter after it."
IFS= read -r -s -p "    Neon connection string: " NEON_URL
echo
[ -n "$NEON_URL" ] || die "Nothing was entered."
# Taken apart by node, which reads it on its standard input (percent-escapes in the password are decoded).
mapfile -t F < <(printf '%s' "$NEON_URL" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  try {
    const u = new URL(s.trim());
    if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("it should start with postgresql://");
    const dec = decodeURIComponent, q = u.searchParams;
    const out = [dec(u.hostname), u.port || "5432", dec(u.username), dec(u.password), dec(u.pathname.replace(/^\//, "")) || "neondb",
      q.get("sslmode") || "", q.get("channel_binding") || "", q.get("options") || ""];
    if (!out[0] || !out[2] || !out[3]) throw new Error("it needs a host, a user and a password");
    if (out.some((v) => /[\r\n\0]/.test(v))) throw new Error("it holds a line break");
    process.stdout.write("ok\n" + out.join("\n") + "\n");
  } catch (e) {
    process.stdout.write("error\n" + (e instanceof TypeError ? "that isn'\''t a connection string (postgresql://user:password@host/database)" : e.message) + "\n");
  }
});')
unset NEON_URL
[ "${F[0]:-}" = ok ] && [ "${#F[@]}" -ge 9 ] || die "Neon's connection string: ${F[1]:-it could not be read}."
N_HOST=${F[1]} N_PORT=${F[2]} N_USER=${F[3]} N_PASS=${F[4]} N_DB=${F[5]} N_CB=${F[7]:-prefer} N_OPTS=${F[8]}
case ${F[6]} in verify-full | verify-ca) N_SSLMODE=${F[6]} ;; *) N_SSLMODE=require ;; esac
[ "$N_SSLMODE" = require ] || export PGSSLROOTCERT=system
unset F
if [[ $N_HOST == *-pooler.* ]]; then
  N_HOST=${N_HOST/-pooler./.}
  say "that's Neon's pooled address: using the direct one, $N_HOST (pg_dump needs a direct connection)"
fi
say "Neon: user $N_USER, database $N_DB at $N_HOST (sslmode=$N_SSLMODE)"
neon() {
  PGHOST=$N_HOST PGPORT=$N_PORT PGUSER=$N_USER PGPASSWORD=$N_PASS PGDATABASE=$N_DB PGSSLMODE=$N_SSLMODE \
    PGCHANNELBINDING=$N_CB PGOPTIONS=$N_OPTS PGCONNECT_TIMEOUT=30 PGAPPNAME=cs2-migrate "$@"
}
neon_sql() { neon "$(pg_bin psql)" -X -q -w -v ON_ERROR_STOP=1 "$@"; }

# ---------------------------------------------------------------------------------------------------------------------
step "2/8  What's on Neon"
ver_num=$(neon_sql -A -t -c 'SHOW server_version_num' 2>"$tmpd/err") ||
  { sed 's/^/    | /' "$tmpd/err" >&2; die "Couldn't connect to Neon with that string (above). Nothing was changed."; }
say "Neon's PostgreSQL: $(neon_sql -A -t -c 'SHOW server_version')"
[ $((ver_num / 10000)) -le "$PG_MAJOR" ] ||
  die "Neon runs PostgreSQL $((ver_num / 10000)), newer than this server's $PG_MAJOR: pg_dump $PG_MAJOR can't read it. Nothing was changed."
neon_before=$(table_counts neon_sql)
count_rows() { printf '%s\n' "$1" | awk '{ printf "    %-30s %10s rows\n", $1, $2 }'; }
if [ -z "$neon_before" ]; then
  say "no tables: Neon has never had the server's data (that's fine: there's nothing to copy)"
else
  count_rows "$neon_before"
fi
exts=$(neon_sql -A -t -c "SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension WHERE extname <> 'plpgsql'")
[ -z "$exts" ] || say "extensions on Neon: $exts"
if printf '%s\n' "$neon_before" | grep -q '^public\.users '; then
  last=$(neon_sql -A -t -c 'SELECT COALESCE(max(last_seen), 0) FROM users')
  if [ "$last" -gt 0 ]; then
    mins=$(( ($(date +%s%3N) - last) / 60000 ))
    say "the last player was seen $mins minutes ago"
    [ "$mins" -ge 2 ] || warn "that's very recent: is the Render service really suspended? (A change of rows is caught below.)"
  fi
fi

# ---------------------------------------------------------------------------------------------------------------------
step "3/8  Stopping the server on this VPS"
printf 'the move from Neon (migrate-from-neon.sh), started %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')" > "$CS2_HOLD"
STOPPED=1
systemctl stop cs2-server.service
say "stopped (and the deploy is on hold until the move is done)"

# ---------------------------------------------------------------------------------------------------------------------
step "4/8  Dumping Neon's database"
install -d -m 0700 -o root -g root "$CS2_BACKUPS"
dump=$CS2_BACKUPS/neon-$(date -u +%Y%m%d-%H%M%S).dump
neon "$(pg_bin pg_dump)" -w -Fc -f "$dump" || die "pg_dump failed (above)."
chmod 0600 "$dump"
listing=$(dump_listing "$dump") || die "pg_restore -l can't read the dump."
entries=$(printf '%s\n' "$listing" | count_matching '^[0-9]')
say "$dump ($(du -h "$dump" | cut -f1), $entries entries, root only)"
neon_after=$(table_counts neon_sql)
[ "$neon_after" = "$neon_before" ] ||
  die "Neon's row counts changed while it was being copied: something still writes to it. Suspend the Render service and run this again."
say "Neon's row counts are the same as before the dump: nothing wrote to it meanwhile"

# ---------------------------------------------------------------------------------------------------------------------
step "5/8  This server's database"
players=$(local_players)
if [ "$players" -gt 0 ]; then
  say "it already has $players players: $(local_sql -Atc "SELECT string_agg(name, ', ') FROM (SELECT name FROM users ORDER BY id LIMIT 8) s")$([ "$players" -le 8 ] || printf ', ...')"
  confirm_yes "Replace them with Neon's copy (they're saved in $CS2_BACKUPS first)?" ||
    die "Stopped: nothing was replaced."
  before=$CS2_BACKUPS/before-move-$(date -u +%Y%m%d-%H%M%S).dump
  runuser -u postgres -- "$(pg_bin pg_dump)" -Fc -d "$CS2_DB" > "$before"
  say "saved first: $before (sudo cs2-restore-backup puts it back)"
else
  say "no players yet: nothing to keep"
fi

# ---------------------------------------------------------------------------------------------------------------------
step "6/8  Replacing this server's database with Neon's copy"
REPLACING=1
recreate_and_restore "$dump" || die "The restore failed (above)."
say "restored; everything in it belongs to cs2"

# ---------------------------------------------------------------------------------------------------------------------
step "7/8  Comparing every table's rows: Neon and this server"
local_counts=$(table_counts local_sql)
if [ -z "$neon_after" ] && [ -z "$local_counts" ]; then
  say "no tables on either side: the server creates them when it starts"
else
  printf '    %-30s %10s %10s\n' table Neon here
  LC_ALL=C join -a 1 -a 2 -e '-' -o 0,1.2,2.2 <(printf '%s\n' "$neon_after") <(printf '%s\n' "$local_counts") |
    awk '{ printf "    %-30s %10s %10s  %s\n", $1, $2, $3, ($2 == $3 ? "ok" : "<<< DIFFERENT") }'
  [ "$local_counts" = "$neon_after" ] ||
    die "ROW COUNTS DIFFER between Neon and this server (marked above). The copy can't be trusted: the server stays stopped."
  say "every table has the same number of rows on both sides"
fi

# ---------------------------------------------------------------------------------------------------------------------
step "8/8  Starting the server on the copy"
rm -f "$CS2_HOLD"
REPLACING=0 STOPPED=0
server_up start
head=$(git_cs2 rev-parse HEAD)
if body=$(wait_health "$head" 120); then
  say "/health: $body"
  mark_deployed "$head"
else
  journalctl -u cs2-server.service -n 40 --no-pager -o cat 2>/dev/null | sed 's/^/    | /' >&2 || true
  die "The server didn't answer /health within 2 minutes (its last lines are above). The database is in place: sudo systemctl restart cs2-server once it's fixed."
fi
say "players now: $(local_players)"
if curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then
  say "https://$DOMAIN/health answers"
else
  warn "https://$DOMAIN/health doesn't answer (sudo cs2-status)"
fi
cat <<EOF

The move is done. Next: sudo cs2-set-discord (the bot's token and settings), then publish the release.
Keep Neon and the suspended Render service for two weeks before deleting them. Neon's dump stays in $dump.
EOF
