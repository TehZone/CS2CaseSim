#!/usr/bin/env bash
# setup.sh: turns a fresh OVH VPS (Ubuntu 24.04 LTS) into the CS2 Case Simulator multiplayer server: Node.js 22,
# PostgreSQL, Caddy with HTTPS for your domain, the server as a systemd service that deploys every push to main, nightly
# backups, swap, a firewall and keys-only SSH. Run it once as the ubuntu user, with the rest of this folder next to it:
#   sudo bash ~/vps/setup.sh server.example.com
# It's safe to run again (the database, its password and your settings are kept), for example with a newer copy of the
# kit: sudo bash /opt/cs2-server/deploy/vps/setup.sh server.example.com. See "Your own server (OVH VPS)" in DEPLOY.md.
set -Eeuo pipefail
KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$KIT/lib.sh"
trap_errors

NODE_MAJOR=22   # server/package.json: node >= 22 (render.yaml pins 22.12.0)
PG_NEW=18       # a new install: the newest major apt.postgresql.org ships for noble (19 is only a release candidate there)
PGDG_FPR=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8   # PostgreSQL Debian Repository (postgresql.org/download/linux/ubuntu)
CADDY_FPR=65760C51EDEA2017CEA2CA15155B6D79CA56EA34  # Caddy Web Server (dl.cloudsmith.io/public/caddy/stable/gpg.key)
KIT_FILES='lib.sh setup.sh deploy.sh backup.sh status.sh migrate-from-neon.sh restore-backup.sh set-discord.sh Caddyfile
  cs2-server.service cs2-deploy.service cs2-deploy.timer cs2-backup.service cs2-backup.timer'
COMMANDS='deploy backup status migrate-from-neon restore-backup set-discord'
UNITS='cs2-server.service cs2-deploy.service cs2-deploy.timer cs2-backup.service cs2-backup.timer'

need_root
DOMAIN=$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')
[[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$ ]] ||
  die "Usage: sudo bash $0 <domain>   (the server's address, for example server.example.com)"

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a LC_ALL=C.UTF-8
cd /
tmpd=$(mktemp -d)
trap 'rm -rf "$tmpd"' EXIT
apt_get() { apt-get -q -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }
# Writes text $3 to file $1 (mode $2, root's) when it differs; true when it changed.
put_text() {
  if [ -f "$1" ] && printf '%s' "$3" | cmp -s - "$1"; then return 1; fi
  printf '%s' "$3" > "$tmpd/put" && install -m "$2" -o root -g root "$tmpd/put" "$1" || die "Could not write $1."
}
# Copies file $1 to $2 (mode $3, root's) when it differs; true when it changed.
put_file() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then chmod "$3" "$2"; return 1; fi
  install -m "$3" -o root -g root "$1" "$2" || die "Could not write $2."
}
# Key file $1 must have primary fingerprint $2.
check_key() {
  local fpr
  install -d -m 0700 "$tmpd/gnupg"
  fpr=$(GNUPGHOME="$tmpd/gnupg" gpg --batch --show-keys --with-colons "$1" 2>/dev/null | awk -F: '$1 == "fpr" && !n++ { print $10 }') || fpr=''
  [ "$fpr" = "$2" ] || die "The signing key from $3 has fingerprint ${fpr:-none}, not $2: stopping (it may have been replaced)."
  say "signing key checked: $2"
}
restart_needed=0

# ---------------------------------------------------------------------------------------------------------------------
step "Checking this machine and the kit"
os=$(. /etc/os-release && printf '%s %s' "${ID:-}" "${VERSION_CODENAME:-}")
[ "$os" = "ubuntu noble" ] || die "This kit is for Ubuntu 24.04 LTS (noble); this machine is: $os."
case $(dpkg --print-architecture) in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) die "Unsupported CPU architecture: $(dpkg --print-architecture)." ;;
esac
for f in $KIT_FILES; do
  [ -f "$KIT/$f" ] || die "$KIT/$f is missing: copy the whole deploy/vps folder."
  ! grep -q $'\r' "$KIT/$f" || die "$KIT/$f has Windows line endings: fix them with  sed -i 's/\r\$//' $KIT/*  and run this again."
done
say "Ubuntu 24.04 ($(dpkg --print-architecture)), domain $DOMAIN, kit in $KIT"
if [ -r "$CS2_KIT_CONF" ]; then
  PG_MAJOR=$(. "$CS2_KIT_CONF" && printf '%s' "${PG_MAJOR:-}")
fi
PG_MAJOR=${PG_MAJOR:-$PG_NEW}

if command -v cloud-init >/dev/null 2>&1; then
  step "Waiting for the first-boot setup (cloud-init) to finish"
  timeout 900 cloud-init status --wait >/dev/null 2>&1 || warn "cloud-init says: $(cloud-init status 2>/dev/null | tail -n 1)"
  say "done"
fi

# ---------------------------------------------------------------------------------------------------------------------
step "Swap (a 2 GB swapfile when there is none)"
if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
  say "already on: $(swapon --show --noheadings | awk '{ print $1 " (" $3 ")" }' | paste -sd ' ')"
else
  if [ ! -f /swapfile ] || ! { chmod 600 /swapfile && swapon /swapfile 2>/dev/null; }; then
    rm -f /swapfile
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  fi
  grep -qE '^/swapfile[[:space:]]' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
  say "on: /swapfile, 2 GB"
fi
if put_text /etc/sysctl.d/90-cs2-swap.conf 0644 $'# CS2 Case Simulator server (deploy/vps): swap only when memory runs short.\nvm.swappiness = 10\n'; then
  sysctl -q -p /etc/sysctl.d/90-cs2-swap.conf
fi

step "The journal (capped at 500 MB)"
install -d -m 0755 /etc/systemd/journald.conf.d
if put_text /etc/systemd/journald.conf.d/90-cs2-size.conf 0644 $'# CS2 Case Simulator server (deploy/vps)\n[Journal]\nSystemMaxUse=500M\n'; then
  systemctl restart systemd-journald
fi
say "SystemMaxUse=500M"

# ---------------------------------------------------------------------------------------------------------------------
step "Updating the package lists and installing the basics"
apt_get update
apt_get install ca-certificates curl gnupg git xz-utils openssl ufw unattended-upgrades
say "done"

step "Security updates (unattended-upgrades)"
put_text /etc/apt/apt.conf.d/20auto-upgrades 0644 $'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' || true
# Ubuntu's own list covers only its security updates. Caddy (the one program the internet talks to) and PostgreSQL come
# from their own repositories: these lines let their updates in too (Origin and Suite from each repository's Release).
put_text /etc/apt/apt.conf.d/51cs2-unattended-upgrades 0644 '// CS2 Case Simulator server (deploy/vps/setup.sh): updates from the Caddy and PostgreSQL repositories install
// themselves too, like Ubuntu'\''s security updates (their Release files: Origin and Suite).
Unattended-Upgrade::Origins-Pattern {
	"origin=apt.postgresql.org,archive=noble-pgdg";
	"origin=cloudsmith/caddy/stable,archive=any-version";
};
' || true
systemctl enable --quiet --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer
say "on: Ubuntu's security updates, Caddy's and PostgreSQL's install themselves daily (no automatic reboots: sudo cs2-status says when one is due)"

step "Firewall (ufw): SSH, HTTP and HTTPS only"
install -d -m 0755 /run/sshd   # (sshd -T needs it; ssh.service makes it too)
ssh_ports=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | sort -u) || ssh_ports=22
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
for p in $ssh_ports; do [ "$p" = 22 ] || ufw allow "$p/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'

# ---------------------------------------------------------------------------------------------------------------------
# From here until the server answers, setup holds the kit's lock: a deploy, a backup or the move from Neon doesn't run
# meanwhile (when setup runs again on a working server), so nothing else installs, checks out or restarts underneath it.
step "Waiting for the kit's other jobs to finish (a deploy, a backup...)"
take_lock 900 || die "Another job (a deploy, a backup, the move from Neon, a restore) held $CS2_LOCK for 15 minutes: run setup again later."
say "done: they wait until setup has started the server"

step "Node.js $NODE_MAJOR (the official build from nodejs.org, checked against SHASUMS256.txt)"
curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" -o "$tmpd/latest.txt"
node_file=$(grep -oE "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-$NODE_ARCH\.tar\.xz" "$tmpd/latest.txt" | head -n 1) || true
[ -n "$node_file" ] || die "nodejs.org lists no linux-$NODE_ARCH build of Node.js $NODE_MAJOR."
node_ver=${node_file#node-}
node_ver=${node_ver%-linux-*}
node_dir=/usr/local/lib/nodejs/${node_file%.tar.xz}
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" = "$node_ver" ] && [ -x "$node_dir/bin/node" ]; then
  say "already installed: $node_ver"
else
  curl -fsSL --retry 3 "https://nodejs.org/dist/$node_ver/SHASUMS256.txt" -o "$tmpd/SHASUMS256.txt"
  curl -fsSL --retry 3 "https://nodejs.org/dist/$node_ver/$node_file" -o "$tmpd/$node_file"
  awk -v f="$node_file" '$2 == f' "$tmpd/SHASUMS256.txt" > "$tmpd/node.sha"
  [ "$(wc -l < "$tmpd/node.sha")" = 1 ] || die "SHASUMS256.txt has no line for $node_file."
  (cd "$tmpd" && sha256sum --check --strict --quiet node.sha) || die "$node_file doesn't match SHASUMS256.txt: stopping."
  say "checksum matches SHASUMS256.txt"
  install -d -m 0755 /usr/local/lib/nodejs
  rm -rf "$node_dir"
  tar -xJf "$tmpd/$node_file" -C /usr/local/lib/nodejs --no-same-owner
  ln -sfn "$node_dir" /usr/local/lib/nodejs/current
  for b in node npm npx corepack; do ln -sfn "/usr/local/lib/nodejs/current/bin/$b" "/usr/local/bin/$b"; done
  for old in /usr/local/lib/nodejs/node-v*; do [ "$old" = "$node_dir" ] || rm -rf "$old"; done
  restart_needed=1
fi
say "node $(/usr/local/bin/node -v), npm $(/usr/local/bin/npm -v)"

# ---------------------------------------------------------------------------------------------------------------------
step "Package repositories: PostgreSQL (apt.postgresql.org) and Caddy (its official repository)"
curl -fsSL --retry 3 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$tmpd/pgdg.asc"
check_key "$tmpd/pgdg.asc" "$PGDG_FPR" www.postgresql.org
install -d -m 0755 /usr/share/postgresql-common/pgdg
put_file "$tmpd/pgdg.asc" /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc 0644 || true
put_text /etc/apt/sources.list.d/pgdg.sources 0644 'Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: noble-pgdg
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
' || true
curl -fsSL --retry 3 https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$tmpd/caddy.asc"
check_key "$tmpd/caddy.asc" "$CADDY_FPR" dl.cloudsmith.io
GNUPGHOME="$tmpd/gnupg" gpg --batch --dearmor < "$tmpd/caddy.asc" > "$tmpd/caddy.gpg"
put_file "$tmpd/caddy.gpg" /usr/share/keyrings/caddy-stable-archive-keyring.gpg 0644 || true
put_text /etc/apt/sources.list.d/caddy-stable.list 0644 \
  $'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' || true
apt_get update
say "done"

# ---------------------------------------------------------------------------------------------------------------------
step "PostgreSQL $PG_MAJOR (listening on localhost only)"
apt_get install "postgresql-$PG_MAJOR" "postgresql-client-$PG_MAJOR"
if ! pg_lsclusters -h 2>/dev/null | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main" { found = 1 } END { exit !found }'; then
  say "creating the cluster $PG_MAJOR/main"
  pg_createcluster --locale C.UTF-8 "$PG_MAJOR" main >/dev/null
fi
pgconf=/etc/postgresql/$PG_MAJOR/main
install -d -m 0755 -o postgres -g postgres "$pgconf/conf.d"
grep -qE "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf\.d'" "$pgconf/postgresql.conf" ||
  die "$pgconf/postgresql.conf doesn't include conf.d."
pg_changed=0
if put_text "$pgconf/conf.d/90-cs2.conf" 0644 $'# CS2 Case Simulator server (deploy/vps/setup.sh): only programs on this machine reach the database.\nlisten_addresses = \'localhost\'\n'; then
  pg_changed=1
fi
systemctl enable --quiet postgresql.service
systemctl enable --quiet "postgresql@$PG_MAJOR-main.service" 2>/dev/null || true
if [ "$pg_changed" = 1 ] && systemctl is-active --quiet "postgresql@$PG_MAJOR-main.service"; then
  systemctl restart "postgresql@$PG_MAJOR-main.service"
fi
systemctl start postgresql.service "postgresql@$PG_MAJOR-main.service"
pg_port=$(pg_super -d postgres -Atc 'SHOW port')
[ "$(pg_super -d postgres -Atc 'SHOW listen_addresses')" = localhost ] || die "PostgreSQL doesn't listen on localhost only."
say "$(pg_super -d postgres -Atc 'SELECT version()' | cut -d, -f1), port $pg_port, listen_addresses = localhost"

# ---------------------------------------------------------------------------------------------------------------------
step "The cs2 user and the server's code ($CS2_REPO_URL, branch $CS2_BRANCH)"
if ! id cs2 >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$CS2_HOME" --create-home --shell /usr/sbin/nologin cs2
  say "created the system user cs2 (no login shell)"
fi
install -d -m 0750 -o cs2 -g cs2 "$CS2_HOME"
install -d -m 0755 -o cs2 -g cs2 "$CS2_REPO"
install -d -m 0755 -o root -g root "$CS2_STATE" "$CS2_LIB"
if [ -d "$CS2_REPO/.git" ]; then
  origin=$(git_cs2 remote get-url origin)
  [ "$origin" = "$CS2_REPO_URL" ] || die "$CS2_REPO is a clone of $origin, not $CS2_REPO_URL."
  say "already cloned, at $(commit_line HEAD) (cs2-deploy keeps it up to date)"
elif [ -z "$(ls -A "$CS2_REPO")" ]; then
  as_cs2_in "$CS2_REPO" git clone --quiet --branch "$CS2_BRANCH" "$CS2_REPO_URL" .
  say "cloned, at $(commit_line HEAD)"
else
  die "$CS2_REPO isn't empty and isn't a git clone: move it away and run this again."
fi

step "The server's dependencies (cd server && npm ci --omit=dev, as on Render)"
npm_if_changed || die "npm ci failed (above)."
if [ "$NPM_RAN" = 1 ]; then restart_needed=1; else say "already installed"; fi

# ---------------------------------------------------------------------------------------------------------------------
step "The database (role cs2, database $CS2_DB) and the server's settings ($CS2_ENV)"
install -d -m 0750 -o root -g cs2 "$CS2_ETC"
[ -f "$CS2_ENV" ] || install -m 0640 -o root -g cs2 /dev/null "$CS2_ENV"
chown root:cs2 "$CS2_ENV"
chmod 0640 "$CS2_ENV"
db_pw=''
if [[ $(env_get "$CS2_ENV" DATABASE_URL) =~ ^postgres://cs2:([0-9a-f]{32,})@127\.0\.0\.1: ]]; then
  db_pw=${BASH_REMATCH[1]}
  say "keeping the database password already in $CS2_ENV"
else
  db_pw=$(openssl rand -hex 24)
  say "a new random database password (it goes only into $CS2_ENV)"
fi
# (The password reaches psql on its standard input, never on a command line.)
pg_super -d postgres <<SQL
SELECT 'CREATE ROLE cs2' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cs2')\gexec
ALTER ROLE cs2 WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$db_pw';
SELECT 'CREATE DATABASE $CS2_DB OWNER cs2 ENCODING ''UTF8'' LOCALE ''C.UTF-8'' TEMPLATE template0'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$CS2_DB')\gexec
SQL
env_before=$(sha256sum < "$CS2_ENV")
env_set "$CS2_ENV" NODE_ENV production
env_set "$CS2_ENV" HOST 127.0.0.1
env_set "$CS2_ENV" PORT "$CS2_PORT"
env_set "$CS2_ENV" TRUST_PROXY 1
env_set "$CS2_ENV" DATABASE_URL "postgres://cs2:$db_pw@127.0.0.1:$pg_port/$CS2_DB"
unset db_pw
[ "$(sha256sum < "$CS2_ENV")" = "$env_before" ] || restart_needed=1
say "NODE_ENV=production HOST=127.0.0.1 PORT=$CS2_PORT TRUST_PROXY=1 DATABASE_URL=postgres://cs2:***@127.0.0.1:$pg_port/$CS2_DB"
say "players in the database: $(local_players)"
put_text "$CS2_KIT_CONF" 0644 "# Written by deploy/vps/setup.sh: what the kit's other scripts need to know.
DOMAIN=$DOMAIN
PG_MAJOR=$PG_MAJOR
" || true

# ---------------------------------------------------------------------------------------------------------------------
step "The kit's scripts ($CS2_LIB, commands cs2-*) and systemd units"
for f in $KIT_FILES; do
  case $f in *.sh) mode=0755 ;; *) mode=0644 ;; esac
  put_file "$KIT/$f" "$CS2_LIB/$f" "$mode" || true
done
for c in $COMMANDS; do ln -sfn "$CS2_LIB/$c.sh" "/usr/local/sbin/cs2-$c"; done
units_changed=0
for u in $UNITS; do
  if put_file "$KIT/$u" "/etc/systemd/system/$u" 0644; then units_changed=1; fi
done
systemctl daemon-reload
[ "$units_changed" = 0 ] || restart_needed=1
say "commands: $(for c in $COMMANDS; do printf 'cs2-%s ' "$c"; done)"

# ---------------------------------------------------------------------------------------------------------------------
step "Starting the server (cs2-server.service, on 127.0.0.1:$CS2_PORT)"
head=$(git_cs2 rev-parse HEAD)
if [ "$(env_get "$CS2_COMMIT_ENV" SERVER_COMMIT)" != "$head" ]; then
  write_commit_env "$head"
  restart_needed=1
fi
systemctl enable --quiet cs2-server.service
if [ -e "$CS2_HOLD" ]; then
  warn "on hold ($(cat "$CS2_HOLD")): not started. Finish that first (DEPLOY.md), or remove $CS2_HOLD."
else
  if ! systemctl is-active --quiet cs2-server.service; then
    server_up start
  elif [ "$restart_needed" = 1 ]; then
    say "restarting it: its code, settings, units or Node.js changed"
    server_up restart
  else
    say "already running, and nothing it uses changed"
  fi
  if body=$(wait_health "$head" 120); then
    say "/health: $body"
    mark_deployed "$head"
  else
    journalctl -u cs2-server.service -n 40 --no-pager -o cat 2>/dev/null | sed 's/^/    | /' >&2 || true
    die "The server didn't answer /health with commit ${head:0:7} within 2 minutes (its last log lines are above)."
  fi
  case $body in
    *'"commit":'*) ;;
    *) say "(GitHub's main doesn't have this kit's server change yet, so the server listens on every interface, which the"
       say " firewall keeps closed, and /health shows no commit. The first deploy after main is pushed brings both.)" ;;
  esac
fi
exec 9>&-   # (the lock: the deploy and backups may run again, and the first backup below needs it)

step "Auto-deploy (every minute) and nightly backups (systemd timers)"
systemctl enable --quiet --now cs2-deploy.timer cs2-backup.timer
[ "$units_changed" = 0 ] || systemctl restart cs2-deploy.timer cs2-backup.timer
if [ -e "$CS2_HOLD" ]; then
  say "skipping the first backup while on hold"
elif systemctl start cs2-backup.service; then
  say "a first backup: $(ls -1 "$CS2_BACKUPS"/cs2-*.dump 2>/dev/null | tail -n 1)"
else
  warn "the first backup failed: journalctl -u cs2-backup -n 30"
fi

# ---------------------------------------------------------------------------------------------------------------------
step "Caddy (HTTPS for $DOMAIN, passing everything on to 127.0.0.1:$CS2_PORT)"
apt_get install caddy
caddy_changed=0
if put_text /etc/caddy/Caddyfile 0644 "$(sed "s/__DOMAIN__/$DOMAIN/g" "$KIT/Caddyfile")"$'\n'; then caddy_changed=1; fi
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >"$tmpd/caddy.log" 2>&1 ||
  { sed 's/^/    | /' "$tmpd/caddy.log" >&2; die "Caddy refuses /etc/caddy/Caddyfile (above)."; }
systemctl enable --quiet caddy.service
if ! systemctl is-active --quiet caddy.service; then
  systemctl start caddy.service
elif [ "$caddy_changed" = 1 ]; then
  systemctl reload caddy.service
fi
say "$(caddy version | cut -d' ' -f1) running, /etc/caddy/Caddyfile: $DOMAIN { reverse_proxy 127.0.0.1:$CS2_PORT }"

step "DNS and HTTPS for $DOMAIN"
mine4=$(ip -4 -o addr show scope global | awk '{ split($4, a, "/"); print a[1] }' | sort -u)
mine6=$(ip -6 -o addr show scope global | awk '{ split($4, a, "/"); print a[1] }' | sort -u)
dns4=$( (getent ahostsv4 "$DOMAIN" || true) | awk '{ print $1 }' | sort -u)
dns6=$( (getent ahostsv6 "$DOMAIN" || true) | awk '$1 !~ /^::ffff:/ { print $1 }' | sort -u)
say "this server: $(printf '%s ' $mine4 $mine6)"
dns_ok=1
if [ -z "$dns4" ]; then
  dns_ok=0
  warn "$DOMAIN has no A record yet: add one pointing at $(printf '%s' "$mine4" | head -n 1) (DNS only, no proxy)."
elif ! grep -qxF -f <(printf '%s\n' "$mine4") <(printf '%s\n' "$dns4"); then
  dns_ok=0
  warn "$DOMAIN points at $(printf '%s ' $dns4), not at this server: fix its A record."
else
  say "A record: $(printf '%s ' $dns4)(this server)"
fi
# The name stays IPv4-only: network bans and the login rate limit go by the player's whole address, and over IPv6 a
# player has a block of addresses to pick from (Windows even changes its own by itself).
if [ -n "$dns6" ]; then
  if ! grep -qxF -f <(printf '%s\n' "${mine6:-none}") <(printf '%s\n' "$dns6"); then
    dns_ok=0
    warn "$DOMAIN also has an AAAA record ($(printf '%s ' $dns6)) that isn't this server: remove it, or Let's Encrypt may check the wrong machine."
  else
    warn "$DOMAIN also has an AAAA record ($(printf '%s ' $dns6)): remove it and keep the name IPv4-only. Over IPv6 a player has a whole block of addresses, enough to get around network bans and the login rate limit."
  fi
fi
https_ok=0
if [ "$dns_ok" = 1 ]; then
  say "waiting for Caddy's certificate (up to 2 minutes)..."
  for _ in $(seq 1 24); do
    if curl -fsS --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" >/dev/null 2>&1; then https_ok=1; break; fi
    sleep 5
  done
fi
if [ "$https_ok" = 1 ]; then
  say "https://$DOMAIN/health answers, with a valid certificate"
else
  warn "https://$DOMAIN/health doesn't answer yet. Once DNS points here Caddy gets the certificate by itself; see journalctl -u caddy -n 50."
fi

# ---------------------------------------------------------------------------------------------------------------------
step "SSH: keys only, no root login"
ssh_user=${SUDO_USER:-}
ssh_conf=/etc/ssh/sshd_config.d/00-cs2-hardening.conf
if [ -z "$ssh_user" ] || [ "$ssh_user" = root ]; then
  warn "not run with sudo from a normal user (ubuntu): SSH left as it is, so nobody is locked out."
else
  keys=$(getent passwd "$ssh_user" | cut -d: -f6)/.ssh/authorized_keys
  how=$(journalctl -q --no-pager -o cat -t sshd -t sshd-session --since -7d 2>/dev/null |
    grep -E "^Accepted [a-z/-]+ for $ssh_user from" | tail -n 1 | awk '{ print $2 }') || how=''
  if [ ! -s "$keys" ] || ! ssh-keygen -l -f "$keys" >/dev/null 2>&1; then
    warn "$keys holds no key: SSH left as it is (passwords still work), so you can't be locked out."
  elif [ -n "$how" ] && [ "$how" != publickey ]; then
    warn "your last login as $ssh_user used '$how', not a key: SSH left as it is. Log in with your key and run this again."
  else
    say "keys that can log in as $ssh_user ($keys):"
    ssh-keygen -l -f "$keys" | sed 's/^/      /'
    [ -z "$how" ] || say "(your last login as $ssh_user used one of them)"
    if put_text "$ssh_conf" 0644 '# CS2 Case Simulator server (deploy/vps/setup.sh): keys only, no root login. It comes first in
# sshd_config.d, and the first value sshd reads wins. Written only after checking the user who ran setup has a key.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
'; then
      if ! sshd -t 2>"$tmpd/sshd.err"; then
        rm -f "$ssh_conf"
        sed 's/^/    | /' "$tmpd/sshd.err" >&2
        die "sshd -t refused the new settings (above): they were removed and SSH is as it was."
      fi
      systemctl try-reload-or-restart ssh.service
    fi
    eff=$(sshd -T 2>/dev/null | awk '$1 ~ /^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin)$/ { printf "%s %s, ", $1, $2 }')
    say "sshd now: ${eff%, }"
    case $eff in *"passwordauthentication yes"*) warn "sshd still allows passwords: another file in /etc/ssh sets it first." ;; esac
  fi
fi

# ---------------------------------------------------------------------------------------------------------------------
step "Done: status report"
bash "$CS2_LIB/status.sh" || true
cat <<EOF

Setup finished. Next (DEPLOY.md, "The move from Render and Neon"):
  - https://$DOMAIN/health should answer (above). Then the release with the new address, as a draft.
  - Suspend the Render service, then:  sudo cs2-migrate-from-neon   and   sudo cs2-set-discord
  - Any time:  sudo cs2-status    Logs:  journalctl -u cs2-server -f    Deploys:  journalctl -u cs2-deploy
EOF
