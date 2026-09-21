#!/bin/bash
# Root phase. Runs as root under tini and does only what needs root:
#   1. validate the settings that came from .env
#   2. create directories and fix ownership of the named volumes
#   3. crash back-off, so that a crash loop can never turn into a Steam login loop
#   4. run the Steam phase as user "steam"   (steam-update.sh)
#   5. exec the server phase as user "dayz"  (run-server.sh)
# Both phases get a clean environment (env -i + whitelist): the game server never sees the
# Steam password, and it cannot read the cached login token in /home/steam.
set -uo pipefail
LOG_TAG=entrypoint
. /opt/dayz/lib/common.sh
install_stop_trap

SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# hold "TITLE" "line"...  - keep the container up without a server and repeat the message.
# Never exit on a problem that a human has to fix: with `restart: unless-stopped` an exit
# would restart the container forever (and, for login problems, hammer Steam with logins).
hold() {
  printf 'HOLD\n' > "$RUN_DIR/state"
  status_set state HOLD
  status_set hold_title "$1"
  status_set hold_lines "$(printf '%s\n' "${@:2}")"
  status_publish
  while :; do
    banner "$@"
    nap 600 || { log "stop requested while on hold - exiting"; exit 0; }
  done
}

# ------------------------------------------------------------ 1. validate ----
mkdir -p "$RUN_DIR"
printf 'STARTING\n' > "$RUN_DIR/state"
status_set schema 1
status_set state STARTING
status_set phase entrypoint
status_raw container_started_epoch "$(date '+%s')"
status_publish

for v in STEAM_USERNAME STEAM_PASSWORD STEAM_GUARD_CODE DAYZ_BRANCH MISSION MAX_PLAYERS \
         RESTART_INTERVAL_HOURS LIMIT_FPS PRIORITY_STEAM_IDS; do
  declare "$v=$(strip_cr "${!v:-}")"
done

FIX_HINT="Fix the value in .env, then run:  docker-compose up -d"

if ! resolve_branch; then
  hold "INVALID SETTING: DAYZ_BRANCH='${DAYZ_BRANCH:-}'" \
       "Allowed values: stable, experimental." "$FIX_HINT"
fi

if [[ -z $STEAM_USERNAME ]]; then
  hold "MISSING SETTING: STEAM_USERNAME" "$FIX_HINT"
fi
if [[ ${STEAM_USERNAME,,} == anonymous && $BRANCH != experimental ]]; then
  hold "STEAM_USERNAME=anonymous only works with DAYZ_BRANCH=experimental" \
       "The stable DayZ server (Steam app 223350) cannot be downloaded anonymously." \
       "Use a real Steam account, or set DAYZ_BRANCH=experimental (then only players" \
       "running DayZ Experimental can join)." "$FIX_HINT"
fi
# steamcmd's script parser has no escape for a double quote. Refuse before any login is
# attempted: a failed login counts toward Steam's rate limit.
if [[ $STEAM_PASSWORD == *'"'* || $STEAM_PASSWORD == *$'\n'* ]]; then
  hold "STEAM_PASSWORD contains a double quote or a line break" \
       "steamcmd cannot accept such a password from a script." \
       "Change the Steam password, or use an account whose password has neither." "$FIX_HINT"
fi
if [[ -n $STEAM_GUARD_CODE && ! $STEAM_GUARD_CODE =~ ^[A-Za-z0-9]{5}$ ]]; then
  warn "STEAM_GUARD_CODE is not a 5-character code - ignoring it"
  STEAM_GUARD_CODE=""
fi

MISSION=${MISSION:-dayzOffline.chernarusplus}
if [[ ! $MISSION =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$ ]]; then
  hold "INVALID SETTING: MISSION='$MISSION'" \
       "Expected <name>.<world>, for example dayzOffline.chernarusplus," \
       "dayzOffline.enoch (Livonia) or dayzOffline.sakhal." "$FIX_HINT"
fi
for pair in "MAX_PLAYERS:${MAX_PLAYERS:-60}" "RESTART_INTERVAL_HOURS:${RESTART_INTERVAL_HOURS:-6}" \
            "LIMIT_FPS:${LIMIT_FPS:-60}"; do
  if [[ ! ${pair#*:} =~ ^[0-9]+$ ]]; then
    hold "INVALID SETTING: ${pair%%:*}='${pair#*:}'" "Expected a whole number." "$FIX_HINT"
  fi
  # Normalise to base 10: "08" would otherwise be a fatal octal error in later arithmetic.
  printf -v "${pair%%:*}" '%d' "$(( 10#${pair#*:} ))"
done
if [[ -n ${PRIORITY_STEAM_IDS:-} && ! $PRIORITY_STEAM_IDS =~ ^[0-9]{17}(\;[0-9]{17})*\;?$ ]]; then
  hold "INVALID SETTING: PRIORITY_STEAM_IDS" \
       "Expected 17-digit SteamID64 values separated by semicolons, for example" \
       "PRIORITY_STEAM_IDS=76561198000000001;76561198000000002" "$FIX_HINT"
fi

# ------------------------------------------------------------ 2. volumes -----
# Named volumes are created root-owned. Recursive chown only once per volume (marker file);
# the cheap non-recursive part runs every start because steamcmd may recreate directories.
mkdir -p "$INSTALL_DIR" "$DATA_ROOT"/{config,profiles,storage,battleye,state} \
         "$RUN_DIR/steam" "$RUN_DIR/server" /var/lib/dayz

if [[ ! -e /home/steam/.owner-ok ]]; then
  chown -Rh steam:steam /home/steam && : > /home/steam/.owner-ok
fi
chmod 0700 /home/steam

if [[ ! -e $DATA_ROOT/.owner-ok ]]; then
  chown -Rh dayz:dayz "$DATA_ROOT" && : > "$DATA_ROOT/.owner-ok"
fi
chown -h dayz:dayz "$DATA_ROOT" "$DATA_ROOT"/{config,profiles,storage,battleye,state}
chmod 0750 "$DATA_ROOT"

# Install tree: owned by steam, readable by everyone, and group-writable for "dayz" only at
# the top level and in mpmissions/ (DayZServer insists on a writable working directory and
# the mission working copy is built inside mpmissions/).
if [[ ! -e $INSTALL_DIR/.owner-ok ]]; then
  chown -Rh steam:dayz "$INSTALL_DIR" && : > "$INSTALL_DIR/.owner-ok"
fi
chown -h steam:dayz "$SERVER_ROOT" "$INSTALL_DIR"
chmod 0755 "$SERVER_ROOT"
chmod 0775 "$INSTALL_DIR"

chown -h steam:steam "$RUN_DIR/steam" /var/lib/dayz; chmod 0700 "$RUN_DIR/steam"
chown -h dayz:dayz  "$RUN_DIR/server";               chmod 0755 "$RUN_DIR/server"
rm -f "$RUN_DIR"/steam/* "$RUN_DIR"/server/* 2>/dev/null

# ------------------------------------------------------------ 3. back-off ----
# run-server.sh resets the counter after 10 healthy minutes or after a requested stop.
COUNT_FILE=$DATA_ROOT/state/start-count
starts=0
[[ -r $COUNT_FILE ]] && read -r starts < "$COUNT_FILE"
[[ $starts =~ ^[0-9]+$ ]] || starts=0
# $starts = server launches since the last healthy run. It is incremented just before the
# server phase (step 5), so hold states and stops during the Steam phase never count.
if (( starts >= 3 )); then
  exp=$(( starts - 3 )); (( exp > 6 )) && exp=6
  delay=$(( 60 * (1 << exp) )); (( delay > 3600 )) && delay=3600
  banner "CRASH BACK-OFF: the last $starts server starts ended early" \
         "The server stopped shortly after each of the last starts." \
         "Waiting $delay seconds before trying again. Look further up in this log (and in" \
         "the profiles folder of the data volume) for the reason." \
         "To retry immediately:  docker-compose restart"
  # A stop during the wait means a human stepped in: clear the counter so that the
  # `docker-compose restart` promised above really does retry at once.
  nap "$delay" || { printf '0\n' > "$COUNT_FILE"; log "stop requested during back-off - exiting"; exit 0; }
fi

# ------------------------------------------------------------ 4. steam -------
log "branch: $BRANCH (Steam app $APP_ID)   mission: $MISSION   install dir: $INSTALL_DIR"

status_set phase steam
status_set branch "$BRANCH"
status_raw app_id "$APP_ID"
status_set mission "$MISSION"
status_set install_dir "$INSTALL_DIR"
status_raw start_count "$starts"
status_publish

run_int setpriv --reuid=steam --regid=steam --init-groups \
  env -i PATH="$SAFE_PATH" HOME=/home/steam LANG=C.UTF-8 TZ="${TZ:-UTC}" \
      STEAMCMD="$STEAMCMD" \
      STEAM_USERNAME="$STEAM_USERNAME" STEAM_PASSWORD="$STEAM_PASSWORD" \
      STEAM_GUARD_CODE="$STEAM_GUARD_CODE" DAYZ_BRANCH="$BRANCH" MISSION="$MISSION" \
      UPDATE_ON_START="${UPDATE_ON_START:-true}" VALIDATE_ON_START="${VALIDATE_ON_START:-false}" \
      MISSIONS_REF="${MISSIONS_REF:-master}" AUTH_TIMEOUT="${AUTH_TIMEOUT:-600}" \
  /opt/dayz/steam-update.sh
steam_rc=$?

if (( STOP_REQUESTED )); then log "stop requested during the Steam phase - exiting"; exit 0; fi

steam_status=""
[[ -r $RUN_DIR/steam/status ]] && read -r steam_status < "$RUN_DIR/steam/status"
status_set steam_status "${steam_status:-unknown}"
status_publish
case $steam_status in
  ok|paused) ;;
  hold)
    lines=(); mapfile -t lines < "$RUN_DIR/steam/banner" 2>/dev/null
    (( ${#lines[@]} )) || lines=("STEAM PHASE FAILED" "See the log above.")
    hold "${lines[@]}" ;;
  *)
    hold "STEAM PHASE ENDED UNEXPECTEDLY (exit code $steam_rc)" \
         "See the log above. To retry:  docker-compose restart" ;;
esac

# The install tree may have been created or extended by steamcmd just now.
chown -h steam:dayz "$INSTALL_DIR"; chmod 0775 "$INSTALL_DIR"
if [[ -d $INSTALL_DIR/mpmissions ]]; then
  chown -h steam:dayz "$INSTALL_DIR/mpmissions"; chmod 0775 "$INSTALL_DIR/mpmissions"
fi

# ------------------------------------------------------------ 5. server ------
chown -h dayz:dayz "$RUN_DIR/state"          # run-server.sh keeps this file up to date
printf '%s\n' "$(( starts + 1 ))" > "$COUNT_FILE"; chown -h dayz:dayz "$COUNT_FILE"
# exec: run-server.sh becomes tini's direct child, so it receives the stop signal itself.
exec setpriv --reuid=dayz --regid=dayz --init-groups \
  env -i PATH="$SAFE_PATH" HOME=/home/dayz LANG=C.UTF-8 TZ="${TZ:-UTC}" \
      DAYZ_BRANCH="$BRANCH" MISSION="$MISSION" UPDATES_PAUSED="$([[ $steam_status == paused ]] && echo 1 || echo 0)" \
      SERVER_NAME="${SERVER_NAME:-}" SERVER_PASSWORD="${SERVER_PASSWORD:-}" \
      ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" SERVER_DESCRIPTION="${SERVER_DESCRIPTION:-}" \
      MAX_PLAYERS="${MAX_PLAYERS:-60}" DISABLE_THIRD_PERSON="${DISABLE_THIRD_PERSON:-false}" \
      DISABLE_CROSSHAIR="${DISABLE_CROSSHAIR:-false}" SERVER_TIME="${SERVER_TIME:-SystemTime}" \
      TIME_ACCELERATION="${TIME_ACCELERATION:-1}" NIGHT_TIME_ACCELERATION="${NIGHT_TIME_ACCELERATION:-1}" \
      PRIORITY_STEAM_IDS="${PRIORITY_STEAM_IDS:-}" RESTART_INTERVAL_HOURS="${RESTART_INTERVAL_HOURS:-6}" \
      LIMIT_FPS="${LIMIT_FPS:-60}" LOG_VERBOSE="${LOG_VERBOSE:-false}" \
      LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-14}" EXTRA_ARGS="${EXTRA_ARGS:-}" \
      RESTART_INTERVAL_SECONDS="${RESTART_INTERVAL_SECONDS:-}" RESTART_DEFER_MAX="${RESTART_DEFER_MAX:-7200}" \
  /opt/dayz/run-server.sh
