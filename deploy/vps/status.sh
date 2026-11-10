#!/usr/bin/env bash
# status.sh: how the CS2 Case Simulator server is doing: its services, /health (here and over HTTPS), the last deploy
# and its commit, the last backup, disk and memory, the HTTPS certificate's expiry, whether a reboot is due, and the
# updates waiting (Node.js's too).
#   sudo cs2-status        (the same as sudo bash ~/vps/status.sh)
# It only looks; it changes nothing.
set -uo pipefail
LIB=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=lib.sh
. "$LIB/lib.sh"
need_root
load_kit
cd /
section() { printf '\n== %s\n' "$*"; }
row() { printf '    %-24s %s\n' "$1" "$2"; }
since() { systemctl show -p ActiveEnterTimestamp --value "$1" 2>/dev/null; }

section "Services"
for u in cs2-server.service caddy.service "postgresql@$PG_MAJOR-main.service"; do
  row "${u%.service}" "$(systemctl is-active "$u" 2>/dev/null) (since $(since "$u"))"
done
for t in cs2-deploy cs2-backup; do
  row "$t.timer" "$(systemctl is-active "$t.timer" 2>/dev/null); last run: $(systemctl show -p Result --value "$t.service" 2>/dev/null) at $(systemctl show -p ExecMainExitTimestamp --value "$t.service" 2>/dev/null)"
done
systemctl list-timers --all --no-pager cs2-deploy.timer cs2-backup.timer 2>/dev/null | sed -n '1,3p' | sed 's/^/    /'

section "The server (/health)"
if body=$(health_local); then
  for k in commit online data pricedAt requiredVersion discord.connected; do row "$k" "$(printf '%s' "$body" | json_get "$k")"; done
else
  row "http://127.0.0.1:$CS2_PORT" "NO ANSWER (journalctl -u cs2-server -n 50)"
fi
if curl -fsS --max-time 8 "https://$DOMAIN/health" >/dev/null 2>&1; then
  row "https://$DOMAIN" "answers"
else
  row "https://$DOMAIN" "NO ANSWER over HTTPS (DNS, the certificate, or the firewall: journalctl -u caddy -n 50)"
fi

section "Deploys (origin/main -> $CS2_REPO)"
row "checked out" "$(commit_line HEAD) ($(git_cs2 log -1 --format=%cd --date=iso HEAD 2>/dev/null))"
row "origin/main" "$(commit_line "refs/remotes/origin/$CS2_BRANCH")"
row "SERVER_COMMIT" "$(env_get "$CS2_COMMIT_ENV" SERVER_COMMIT | cut -c1-7)"
if [ -s "$CS2_DEPLOYED" ]; then
  row "last seen working" "$(commit_line "$(cat "$CS2_DEPLOYED")")"
  [ "$(cat "$CS2_DEPLOYED")" = "$(git_cs2 rev-parse HEAD 2>/dev/null)" ] ||
    row "UNFINISHED" "what's checked out hasn't answered /health yet: the next deploy run finishes it, or goes back"
fi
if [ -r "$CS2_STATE/last" ]; then
  row "last deploy" "$(env_get "$CS2_STATE/last" result): $(env_get "$CS2_STATE/last" commit | cut -c1-7) at $(env_get "$CS2_STATE/last" at)"
else
  row "last deploy" "none since setup"
fi
[ ! -s "$CS2_STATE/failed" ] || row "FAILED, not retried" "$(commit_line "$(cat "$CS2_STATE/failed")") (sudo cs2-deploy --force retries it)"
[ ! -e "$CS2_HOLD" ] || row "ON HOLD" "$(cat "$CS2_HOLD") (while $CS2_HOLD exists the server doesn't start, not even at boot, and the deploy and backups change nothing: finish that first)"

section "Backups ($CS2_BACKUPS)"
newest=$(ls -1 "$CS2_BACKUPS"/cs2-*.dump 2>/dev/null | LC_ALL=C sort | tail -n 1)
if [ -n "$newest" ]; then
  row "newest" "${newest##*/} ($(du -h "$newest" | cut -f1), $(date -u -r "$newest" '+%Y-%m-%d %H:%M UTC'))"
  row "kept" "$(ls -1 "$CS2_BACKUPS"/cs2-*.dump | wc -l) nightly, $(du -sh "$CS2_BACKUPS" | cut -f1) in all"
else
  row "newest" "NONE (sudo systemctl start cs2-backup)"
fi

section "Disk and memory"
df -h / | awk 'NR == 2 { printf "    %-24s %s free of %s (%s used)\n", "disk /", $4, $2, $5 }'
free -h | awk '$1 == "Mem:" { printf "    %-24s %s available of %s\n", "memory", $7, $2 } $1 == "Swap:" { printf "    %-24s %s used of %s\n", "swap", $3, $2 }'
row "database" "$(pg_super -d "$CS2_DB" -Atc "SELECT pg_size_pretty(pg_database_size('$CS2_DB'))" 2>/dev/null), $(local_players 2>/dev/null) players"

section "HTTPS certificate ($DOMAIN)"
cert=$(timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" </dev/null 2>/dev/null | openssl x509 -noout -enddate -issuer 2>/dev/null)
if [ -n "$cert" ]; then
  end=$(printf '%s\n' "$cert" | sed -n 's/^notAfter=//p')
  days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
  row "expires" "$end ($days days; Caddy renews it about 30 days before)"
  row "issuer" "$(printf '%s\n' "$cert" | sed -n 's/^issuer=//p')"
else
  row "certificate" "NONE YET (journalctl -u caddy -n 50)"
fi

section "System"
row "uptime" "$(uptime -p)"
if [ -e /var/run/reboot-required ]; then row "REBOOT DUE" "for security updates: sudo reboot (players reconnect by themselves)"; else row "reboot" "not needed"; fi
# Waiting updates (from the package lists apt-daily refreshes). Ubuntu's security ones, Caddy's and PostgreSQL's install
# themselves overnight; the rest wait for sudo apt upgrade.
ups=$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | awk '$1 == "Inst" { print $2 }')
if [ -z "$ups" ]; then
  row "updates waiting" "none"
else
  ours=$(printf '%s\n' "$ups" | grep -E '^(caddy|postgresql|libpq)' | paste -sd ' ')
  row "updates waiting" "$(printf '%s\n' "$ups" | wc -l)${ours:+, among them $ours} (security, Caddy and PostgreSQL install overnight; the rest: sudo apt upgrade)"
fi
# Node.js comes from nodejs.org, not apt: running setup again installs a newer 22.x.
node_now=$(/usr/local/bin/node -v 2>/dev/null) || node_now=''
node_major=${node_now#v}
node_major=${node_major%%.*}
node_new=''
if [ -n "$node_major" ]; then
  node_new=$(curl -fsS --max-time 5 "https://nodejs.org/dist/latest-v$node_major.x/SHASUMS256.txt" 2>/dev/null |
    grep -oE "node-v$node_major\.[0-9]+\.[0-9]+" | head -n 1) || true
  node_new=${node_new#node-}
fi
if [ -n "$node_new" ] && [ "$node_new" != "$node_now" ]; then
  row "Node.js" "$node_now; $node_new is out: sudo bash $CS2_REPO/deploy/vps/setup.sh $DOMAIN (or ~/vps/setup.sh) installs it"
else
  row "Node.js" "${node_now:-not found}${node_new:+ (the newest $node_major.x)}"
fi
row "firewall" "$(ufw status 2>/dev/null | head -n 1)"
