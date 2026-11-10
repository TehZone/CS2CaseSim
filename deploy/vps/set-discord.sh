#!/usr/bin/env bash
# set-discord.sh: the Discord bot's token and settings for this server, then a restart. Run it in your own SSH terminal,
# after the move from Neon and with the Render service suspended: only one server may run the bot at a time.
#   sudo cs2-set-discord        (the same as sudo bash ~/vps/set-discord.sh)
# Copy the values from Render's Environment page. The token is asked for without showing it and goes into
# /etc/cs2-server/discord-token (root:cs2 0640), which DISCORD_TOKEN_FILE points at; it never reaches a command line, a
# log or the shell's history. The other settings aren't secret and go into /etc/cs2-server/env. Run it again to change
# one: Enter keeps what's shown in [brackets] (a blank one stays unset), a single - removes it.
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
[ -f "$CS2_ENV" ] || die "$CS2_ENV is missing: run setup.sh first."
take_lock 300 || die "A deploy, backup or the move from Neon held the lock for 5 minutes: try again in a minute."
trap 'stty echo 2>/dev/null || true' EXIT
trim() { local s=$1; s=${s#"${s%%[![:space:]]*}"}; printf '%s' "${s%"${s##*[![:space:]]}"}"; }

cat <<'EOF'

The Discord bot: account linking, staff roles in the admin panel, /game commands, the mod log and rare drops
(DEPLOY.md, "Discord: account linking and the admin panel"). Copy each value from Render's Environment page.
Enter keeps what's shown in [brackets] (a blank one stays unset); a single - removes it.
EOF

# ---------------------------------------------------------------------------------------------------------------------
step "The bot's token (DISCORD_BOT_TOKEN on Render)"
if [ -s "$CS2_TOKEN" ]; then
  say "a token is set ($CS2_TOKEN): Enter keeps it, - removes it (no bot)"
else
  say "none yet: Enter leaves the bot off"
fi
IFS= read -r -s -p "    Bot token (hidden): " tok
echo
tok=$(trim "$tok")
tok=${tok#Bot }
case $tok in
  '')
    if [ -s "$CS2_TOKEN" ]; then
      chown root:cs2 "$CS2_TOKEN" && chmod 0640 "$CS2_TOKEN"
      env_set "$CS2_ENV" DISCORD_TOKEN_FILE "$CS2_TOKEN"
      say "kept"
    else
      say "no bot"
    fi
    ;;
  -)
    rm -f "$CS2_TOKEN"
    env_set "$CS2_ENV" DISCORD_TOKEN_FILE ''
    env_set "$CS2_ENV" DISCORD_BOT_TOKEN ''
    say "removed: no bot on this server"
    ;;
  *)
    [[ $tok =~ ^[A-Za-z0-9._-]{50,}$ ]] || die "That doesn't look like a bot token (Developer Portal, your application, Bot). Nothing was changed."
    confirm_yes "Is the Render service suspended (so its copy of the bot is off)?" ||
      die "Suspend it first: two servers with one token fight over the bot. Nothing was changed."
    tmp=$(mktemp "$CS2_TOKEN.XXXXXX")
    printf '%s\n' "$tok" > "$tmp"
    chown root:cs2 "$tmp"
    chmod 0640 "$tmp"
    mv -f "$tmp" "$CS2_TOKEN"
    env_set "$CS2_ENV" DISCORD_TOKEN_FILE "$CS2_TOKEN"
    env_set "$CS2_ENV" DISCORD_BOT_TOKEN ''   # (it would win over the file)
    say "saved in $CS2_TOKEN (root:cs2 0640)"
    ;;
esac
unset tok

# ---------------------------------------------------------------------------------------------------------------------
step "The other settings (not secret)"
# ask KEY "what it is" [digits]: one setting, asked again until it's valid.
ask() {
  local key=$1 cur v
  cur=$(env_get "$CS2_ENV" "$key")
  say "$2"
  while :; do
    read -r -p "      $key [$cur]: " v
    v=$(trim "$v")
    case $v in
      '') v=$cur ;;
      -) v='' ;;
    esac
    if [ "${3:-}" = digits ] && [ -n "$v" ] && ! [[ $v =~ ^[0-9]{5,25}$ ]]; then
      say "      that isn't an id (digits only: Discord, Developer Mode, right-click, Copy ID)"
      continue
    fi
    case $v in *"'"* | *'$'* | *'\'*) say "      it can't hold a ' \$ or \\"; continue ;; esac
    break
  done
  env_set "$CS2_ENV" "$key" "$v"
}
ask DISCORD_GUILD_ID "Your Discord server's id (Settings, Advanced, Developer Mode; right-click the server, Copy Server ID). Can stay blank while the bot is in one server." digits
ask DISCORD_ADMIN_ROLES "Role names that make someone Admin, comma-separated (blank: the ★ Developer role)."
ask DISCORD_MOD_ROLES "Role names that make someone Moderator, comma-separated (blank: Moderator)."
ask DISCORD_LINKED_ROLE "The role linked accounts get (blank: 🔗 Linked)."
ask DISCORD_LOG_CHANNEL "The mod log's channel id (blank: a text channel with mod-log in its name)." digits
ask DISCORD_DROPS_CHANNEL "The rare drops' channel id (blank: a text channel with rare-drops in its name)." digits
ask ADMIN_USERS "Game usernames that are admins without Discord, comma-separated (blank: none)."

step "What's set now ($CS2_ENV)"
if [ -s "$CS2_TOKEN" ]; then say "bot token: set ($CS2_TOKEN)"; else say "bot token: none (no bot)"; fi
for k in DISCORD_GUILD_ID DISCORD_ADMIN_ROLES DISCORD_MOD_ROLES DISCORD_LINKED_ROLE DISCORD_LOG_CHANNEL DISCORD_DROPS_CHANNEL ADMIN_USERS; do
  say "$(printf '%-22s %s' "$k" "$(env_get "$CS2_ENV" "$k")")"
done

# ---------------------------------------------------------------------------------------------------------------------
step "Restarting the server"
if [ -e "$CS2_HOLD" ]; then
  say "on hold ($(cat "$CS2_HOLD")): not restarted. The settings are saved and apply when the server starts."
  exit 0
fi
server_up restart
head=$(env_get "$CS2_COMMIT_ENV" SERVER_COMMIT)
body=$(wait_health "$head" 120) || {
  journalctl -u cs2-server.service -n 40 --no-pager -o cat 2>/dev/null | sed 's/^/    | /' >&2 || true
  die "The server didn't answer /health within 2 minutes (its last lines are above)."
}
say "running again"
if [ -s "$CS2_TOKEN" ]; then
  say "waiting for the bot to connect (up to a minute)..."
  connected=''
  for _ in $(seq 1 30); do
    connected=$(health_local | json_get discord.connected) || connected=''
    [ "$connected" != true ] || break
    sleep 2
  done
  if [ "$connected" = true ]; then
    say "/health: \"discord\":{\"connected\":true}: the bot is online"
  else
    journalctl -u cs2-server.service -n 200 --no-pager -o cat 2>/dev/null | grep -i '\[discord\]' | tail -n 10 | sed 's/^/    | /' >&2 || true
    warn "the bot hasn't connected yet (its log lines are above)."
  fi
fi
