# lib.sh: helpers shared by the scripts of the CS2 Case Simulator VPS kit (deploy/vps). The other scripts source it; run
# by itself it does nothing. setup.sh installs it with them in /usr/local/lib/cs2-server.
# shellcheck shell=bash

# ---- where everything lives ------------------------------------------------------------------------------------------
CS2_REPO_URL=https://github.com/TehZone/CS2CaseSim.git
CS2_BRANCH=main
CS2_REPO=/opt/cs2-server              # the git clone the server runs from (owned by the cs2 user)
CS2_HOME=/var/lib/cs2-server          # the cs2 user's home (npm's cache)
CS2_ETC=/etc/cs2-server
CS2_ENV=$CS2_ETC/env                  # the server's settings and secrets (root:cs2 0640)
CS2_COMMIT_ENV=$CS2_ETC/commit.env    # SERVER_COMMIT, written before each restart (/health reports it)
CS2_TOKEN=$CS2_ETC/discord-token      # the Discord bot's token (root:cs2 0640), DISCORD_TOKEN_FILE points here
CS2_KIT_CONF=$CS2_ETC/kit.conf        # DOMAIN and PG_MAJOR, written by setup.sh
CS2_LIB=/usr/local/lib/cs2-server     # the installed copy of this kit
CS2_STATE=/var/lib/cs2-deploy         # the deploy's record: deployed, last, failed, npm.sha, hold
CS2_DEPLOYED=$CS2_STATE/deployed      # the commit last seen answering /health (setup and the deploy write it)
CS2_HOLD=$CS2_STATE/hold              # while it exists the deploy changes nothing and cs2-server doesn't start, not even at boot
                                      # (the database is being replaced, or a replace didn't finish)
CS2_BACKUPS=/var/backups/cs2-server   # pg_dump files (root only)
CS2_LOCK=/run/lock/cs2-server.lock    # one job at a time: a deploy, a backup, the move from Neon, a restore, Discord settings
CS2_PORT=8787
CS2_DB=cs2
CS2_PATH=/usr/local/bin:/usr/bin:/bin

# ---- output and errors -----------------------------------------------------------------------------------------------
CS2_STEP='starting'
step() { CS2_STEP=$*; printf '\n==> %s\n' "$*"; }
say()  { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# With set -E: any command failing names the step it stopped in (die says its own reason instead).
cs2_on_error() {
  printf '\nFAILED: "%s" stopped (exit code %s, %s line %s).\n' "$CS2_STEP" "$1" "${3##*/}" "$2" >&2
}
trap_errors() { trap 'cs2_on_error $? $LINENO "${BASH_SOURCE[0]}"' ERR; }

need_root() { [ "$(id -u)" = 0 ] || die "Run it with sudo (sudo bash $0 ...)."; }
need_terminal() { [ -t 0 ] || die "Run it in your SSH terminal: it asks questions."; }

# The domain and PostgreSQL version setup.sh chose.
load_kit() {
  [ -r "$CS2_KIT_CONF" ] || die "$CS2_KIT_CONF is missing: run setup.sh first."
  # shellcheck source=/dev/null
  . "$CS2_KIT_CONF"
  [ -n "${DOMAIN:-}" ] && [ -n "${PG_MAJOR:-}" ] || die "$CS2_KIT_CONF has no DOMAIN or PG_MAJOR: run setup.sh again."
}

# Holds the lock until the script ends. $1: seconds to wait for it (0: give up at once).
take_lock() {
  exec 9>>"$CS2_LOCK"
  if [ "${1:-0}" -gt 0 ]; then flock -w "$1" 9; else flock -n 9; fi
}

# Typed "yes" or nothing.
confirm_yes() {
  local a
  read -r -p "    $1 Type yes to go on: " a
  [ "$a" = yes ]
}

# ---- the cs2 user, git and npm ---------------------------------------------------------------------------------------
# A command as the cs2 user in directory $1 (runuser runs it directly: cs2 has no login shell).
as_cs2_in() { local dir=$1; shift; runuser -u cs2 -- env -C "$dir" HOME="$CS2_HOME" PATH="$CS2_PATH" "$@"; }
git_cs2() { as_cs2_in "$CS2_REPO" git "$@"; }
# "abc1234 subject" of a commit.
commit_line() { git_cs2 log -1 --format='%h %s' "$1" 2>/dev/null || printf '%s' "${1:0:7}"; }

# npm ci --omit=dev in server/ (as on Render) when server/package.json or package-lock.json changed since the last
# install that finished, or nothing is installed. NPM_RAN=1 when it ran.
npm_needed() {
  local want have
  want=$(cd "$CS2_REPO/server" && sha256sum package.json package-lock.json) || return 0
  have=$(cat "$CS2_STATE/npm.sha" 2>/dev/null) || have=''
  [ "$want" != "$have" ] || [ ! -d "$CS2_REPO/server/node_modules" ]
}
npm_if_changed() {
  local want
  NPM_RAN=0
  npm_needed || return 0
  want=$(cd "$CS2_REPO/server" && sha256sum package.json package-lock.json) || return 1
  say "npm ci --omit=dev in server/ (server/package.json or package-lock.json changed)"
  rm -f "$CS2_STATE/npm.sha"   # (an install that stops halfway is redone next time)
  as_cs2_in "$CS2_REPO/server" npm ci --omit=dev --no-audit --no-fund --loglevel=error || return 1
  printf '%s\n' "$want" > "$CS2_STATE/npm.sha" || return 1
  NPM_RAN=1
}

# ---- the env files ---------------------------------------------------------------------------------------------------
# The value of $2 in env file $1 ('' when it isn't there). Reads back what env_set writes.
env_get() {
  local v
  v=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n 1) || true
  v=${v#*=}
  if [ "${#v}" -ge 2 ] && [ "${v:0:1}" = "'" ] && [ "${v: -1}" = "'" ]; then v=${v:1:${#v}-2}; fi
  printf '%s' "$v"
}

# Sets $2 to $3 in env file $1 (root:cs2 0640), in place, keeping every other line; an empty $3 removes $2. Only shell
# builtins see the value (no command line shows it). Anything but plain characters is single-quoted, which systemd reads
# verbatim; a ' $ \ or line break is refused.
env_set() {
  local file=$1 key=$2 val=$3 out='' line found=0 tmp
  case $val in *"'"* | *'$'* | *'\'* | *$'\n'* | *$'\r'*) die "$key can't hold a ' \$ \\ or a line break." ;; esac
  if [ -n "$val" ]; then
    if [[ $val =~ ^[A-Za-z0-9_.,:/@%+=-]+$ ]]; then out="$key=$val"; else out="$key='$val'"; fi
  fi
  tmp=$(mktemp "$file.XXXXXX") || return 1
  {
    if [ -f "$file" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        if [[ $line == "$key="* ]]; then
          if [ "$found" = 0 ] && [ -n "$out" ]; then printf '%s\n' "$out"; fi
          found=1
        else
          printf '%s\n' "$line"
        fi
      done < "$file"
    fi
    if [ "$found" = 0 ] && [ -n "$out" ]; then printf '%s\n' "$out"; fi
  } > "$tmp"
  chown root:cs2 "$tmp" && chmod 0640 "$tmp" && mv -f "$tmp" "$file"
}

# SERVER_COMMIT for the next start of cs2-server.
write_commit_env() {
  local tmp
  tmp=$(mktemp "$CS2_COMMIT_ENV.XXXXXX") || return 1
  printf 'SERVER_COMMIT=%s\n' "$1" > "$tmp" && chown root:cs2 "$tmp" && chmod 0640 "$tmp" && mv -f "$tmp" "$CS2_COMMIT_ENV"
}

# The commit last seen answering /health: what the deploy goes back to.
mark_deployed() { printf '%s\n' "$1" > "$CS2_DEPLOYED.tmp" && mv -f "$CS2_DEPLOYED.tmp" "$CS2_DEPLOYED"; }

# Starts cs2-server ($1: start or restart). reset-failed first: systemd doesn't restart a unit left failed by itself.
server_up() { systemctl reset-failed cs2-server.service 2>/dev/null || true; systemctl "${1:-start}" cs2-server.service; }

# ---- the server's /health --------------------------------------------------------------------------------------------
health_local() { curl -fsS --max-time 5 "http://127.0.0.1:$CS2_PORT/health" 2>/dev/null; }

# The commit /health reports ('' when it doesn't answer, or reports none).
health_commit() {
  local body re='"commit":"([0-9a-f]{7,40})"'
  body=$(health_local) || return 0
  if [[ $body =~ $re ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
}

# Waits up to $2 seconds (90) for /health to answer, reporting commit $1 when one is given. Prints the last answer.
# Code from before /health had a commit (GitHub's main until this kit's server change is pushed, or a commit from before
# it to go back to) answers with no "commit" at all: that counts too, with a warning. Every caller has just (re)started
# the server, or found it running with nothing changed, so whatever answers is the code checked out.
wait_health() {
  local want=${1:-} secs=${2:-90} start=$SECONDS body=''
  while [ $((SECONDS - start)) -lt "$secs" ]; do
    body=$(health_local) || body=''
    if [ -n "$body" ] && { [ -z "$want" ] || [[ $body == *"\"commit\":\"$want\""* ]]; }; then
      printf '%s\n' "$body"
      return 0
    fi
    if [ -n "$want" ] && [[ $body == '{"ok":true'* ]] && [[ $body != *'"commit":'* ]]; then
      warn "/health answers without a commit (code from before /health reported one): taking it as ${want:0:7}"
      printf '%s\n' "$body"
      return 0
    fi
    sleep 2
  done
  [ -z "$body" ] || printf '%s\n' "$body"
  return 1
}

# Field $1 (a dotted path) of the JSON on stdin, or ''.
json_get() {
  node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{}})' "$1"
}

# ---- PostgreSQL ------------------------------------------------------------------------------------------------------
pg_bin() { printf '/usr/lib/postgresql/%s/bin/%s' "$PG_MAJOR" "$1"; }
# What pg_restore -l lists in dump $1: fails only when it can't read the file (a dump of an empty database lists nothing).
dump_listing() { "$(pg_bin pg_restore)" -l "$1"; }
# How many lines of stdin match $1, 0 included (grep -c alone fails when it counts none).
count_matching() { grep -c -- "$1" || true; }
# psql as the postgres superuser over the local socket.
pg_super() { runuser -u postgres -- "$(pg_bin psql)" -X -q -v ON_ERROR_STOP=1 "$@"; }

# The local database as the cs2 user (TCP, the password from DATABASE_URL): what pg_restore creates this way is cs2's.
load_local_db() {
  local url
  url=$(env_get "$CS2_ENV" DATABASE_URL)
  [[ $url =~ ^postgres://cs2:([^@/]+)@([0-9.]+):([0-9]+)/([A-Za-z0-9_]+)$ ]] ||
    die "DATABASE_URL in $CS2_ENV isn't the local one setup.sh writes: run setup.sh again."
  L_PASS=${BASH_REMATCH[1]} L_HOST=${BASH_REMATCH[2]} L_PORT=${BASH_REMATCH[3]}
}
as_cs2_db() { PGHOST=$L_HOST PGPORT=$L_PORT PGUSER=cs2 PGPASSWORD=$L_PASS PGDATABASE=$CS2_DB PGSSLMODE=disable "$@"; }

# Players in the local database (0 when it or its users table doesn't exist yet).
local_players() {
  local has
  has=$(pg_super -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = '$CS2_DB'") || return 1
  [ "$has" = 1 ] || { printf '0'; return 0; }
  has=$(pg_super -d "$CS2_DB" -Atc "SELECT to_regclass('public.users') IS NOT NULL") || return 1
  [ "$has" = t ] || { printf '0'; return 0; }
  pg_super -d "$CS2_DB" -Atc 'SELECT count(*) FROM users'
}

# One SELECT per table counting its rows (extensions' own tables left out). Fed back to psql it prints "schema.table rows".
COUNT_SQL="SELECT format('SELECT %L, count(*) FROM %I.%I;', n.nspname || '.' || c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  ORDER BY 1"
# "schema.table rows" per table, sorted, from the psql command given ($@ takes -c and stdin).
table_counts() {
  local stmts
  stmts=$("$@" -A -t -c "$COUNT_SQL") || return 1
  [ -n "$stmts" ] || return 0
  printf '%s\n' "$stmts" | "$@" -A -t -F ' ' | LC_ALL=C sort
}
local_sql() { pg_super -d "$CS2_DB" "$@"; }

# Drops and recreates the local database, then restores dump $1 into it as cs2 with --no-owner --no-acl, so everything
# ends up owned by cs2, in one transaction. Extensions the dump carries (a Neon database can carry Neon's own) are left
# out of the restore: the superuser creates the ones this PostgreSQL has, the others are skipped (the server's tables,
# server/db.mjs, use none).
recreate_and_restore() {
  local dump=$1 list ext stats=()
  list=$(mktemp) || return 1
  "$(pg_bin pg_restore)" -l "$dump" |
    sed -E 's/^([0-9]+; [0-9]+ [0-9]+ (EXTENSION|COMMENT - EXTENSION|EVENT TRIGGER) )/;\1/' > "$list" || return 1
  say "recreating the database $CS2_DB (owner cs2)"
  pg_super -d postgres <<SQL || return 1
DROP DATABASE IF EXISTS $CS2_DB WITH (FORCE);
CREATE DATABASE $CS2_DB OWNER cs2 ENCODING 'UTF8' LOCALE 'C.UTF-8' TEMPLATE template0;
SQL
  for ext in $(sed -nE 's/^;[0-9]+; [0-9]+ [0-9]+ EXTENSION - ([^ ]+).*/\1/p' "$list"); do
    [ "$ext" != plpgsql ] || continue
    if [[ $ext =~ ^[a-z0-9_]+$ ]] && [ "$(pg_super -d postgres -Atc "SELECT count(*) FROM pg_available_extensions WHERE name = '$ext'")" = 1 ]; then
      say "extension $ext: created by the superuser"
      printf 'CREATE EXTENSION IF NOT EXISTS :"ext";\n' | pg_super -d "$CS2_DB" -v ext="$ext" || return 1
    else
      say "extension $ext: left out (this PostgreSQL doesn't have it; the game's tables don't use it)"
    fi
  done
  [ "$PG_MAJOR" -lt 18 ] || stats=(--no-statistics)
  say "restoring (pg_restore --no-owner --no-acl, one transaction)"
  as_cs2_db "$(pg_bin pg_restore)" --no-password --no-owner --no-acl --no-publications --no-subscriptions \
    --no-security-labels --no-tablespaces "${stats[@]}" --single-transaction --exit-on-error \
    -L "$list" -d "$CS2_DB" "$dump" || { rm -f "$list"; return 1; }
  rm -f "$list"
  local_sql -c 'ANALYZE' || return 1   # (as the superuser: cs2 would be warned off the system catalogs)
  local others
  others=$(local_sql -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'i') AND pg_get_userbyid(c.relowner) <> 'cs2'") || return 1
  [ "$others" = 0 ] || warn "$others objects in the database aren't owned by cs2"
}
