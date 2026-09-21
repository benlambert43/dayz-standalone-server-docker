#!/bin/bash
# Server phase. Runs as user "dayz" and is tini's direct child (entrypoint.sh exec'd into it).
#
#   1. mission working copy = untouched vanilla mission + ./config/mission overlay
#   2. serverDZ.cfg (from ./config/serverDZ.cfg, or rendered from the .env values)
#   3. launch DayZServer as a background child with a clean environment
#   4. supervise: stop handling, shutdown-hang kill, scheduled restart, housekeeping
#
# Why a supervisor: the Linux server can save the world and then hang forever instead of
# exiting (observed 3 of 3 times on Experimental 1.30, and reported for stable too). Observed
# order after a stop request: world files written (+0.8 s), game port released (+2.5 s), then
# a busy loop at 100 % CPU. So the rule that needs no log text is:
#   "game port was bound, is gone now, process still alive"  =>  world is saved  =>  SIGKILL.
set -uo pipefail
LOG_TAG=server
. /opt/dayz/lib/common.sh
install_stop_trap

resolve_branch || { echo "unknown DAYZ_BRANCH" >&2; exit 2; }

WORLD=${MISSION#*.}
ACTIVE_MISSION=docker.$WORLD
MP=$INSTALL_DIR/mpmissions
CFG=$DATA_ROOT/config/serverDZ.cfg
PROFILES=$DATA_ROOT/profiles
STORAGE=$DATA_ROOT/storage/$BRANCH/$MISSION
BEPATH=$DATA_ROOT/battleye
STATE=$RUN_DIR/server
COUNT_FILE=$DATA_ROOT/state/start-count

START_TIMEOUT=${START_TIMEOUT:-900}       # game port must be bound within this many seconds
STOP_TIMEOUT=${STOP_TIMEOUT:-60}          # SIGTERM -> SIGKILL ceiling when the port never goes away
PORT_GONE_GRACE=${PORT_GONE_GRACE:-5}     # port released -> SIGKILL
RESTART_DEFER_MAX=${RESTART_DEFER_MAX:-7200}  # wait this long for an empty server before a scheduled restart

set_state() {
  printf '%s\n' "$1" > "$RUN_DIR/state"
  status_set state "$1"
  status_publish
}

fatal_hold() {   # a problem only a human can fix: keep the container up and repeat the message
  status_set hold_title "$1"
  status_set hold_lines "$(printf '%s\n' "${@:2}")"
  set_state HOLD
  while :; do
    banner "$@"
    nap 600 || exit 0
  done
}

# ---------------------------------------------------------------- mission ----
# Resolve REL inside BASE case-insensitively: ./config lives on NTFS, where Init.c and
# init.c are the same file, but on ext4 a wrongly-cased overlay file would be ignored.
resolve_ci() {
  local base=$1 rel=$2 cur="" part match parts
  IFS=/ read -ra parts <<< "$rel"
  for part in "${parts[@]}"; do
    if [[ -e $base/$cur$part ]]; then
      cur+=$part/
    else
      match=$(find "$base/${cur%/}" -mindepth 1 -maxdepth 1 -iname "$part" -printf '%f\n' -quit 2>/dev/null)
      cur+=${match:-$part}/
    fi
  done
  printf '%s' "${cur%/}"
}

build_mission() {
  local src=$MP/$MISSION dst=$MP/$ACTIVE_MISSION tmp=$MP/.docker-build f rel target n=0
  [[ -d $src ]] || fatal_hold "MISSION FOLDER NOT FOUND: mpmissions/$MISSION" \
      "Check MISSION in .env, then run:  docker-compose up -d"

  # Persistence lives in $STORAGE (via -storage). If a world is ever found inside the
  # working copy, -storage was not honoured: never delete it.
  if compgen -G "$dst/storage_*" > /dev/null; then
    local rescue; rescue=$DATA_ROOT/rescued-storage-$(date +%Y%m%d-%H%M%S)
    mkdir -p "$rescue" && mv "$dst"/storage_* "$rescue"/
    banner "WORLD DATA FOUND INSIDE THE MISSION FOLDER - MOVED TO SAFETY" \
           "This build seems to ignore -storage. The data is now in the data volume:" \
           "  $rescue" "Please report this; nothing was deleted."
  fi

  rm -rf "$tmp"
  run_int cp -r --no-preserve=mode,ownership "$src" "$tmp" || {
    (( STOP_REQUESTED )) && exit 0
    fatal_hold "COULD NOT COPY THE MISSION FOLDER" "Is the data disk full?  docker system df"; }
  (( STOP_REQUESTED )) && { rm -rf "$tmp"; exit 0; }
  rm -rf "$tmp"/storage_*

  if [[ -d $CONFIG_DIR/mission ]]; then
    while IFS= read -r -d '' f; do
      rel=${f#"$CONFIG_DIR/mission/"}
      target=$tmp/$(resolve_ci "$tmp" "$rel")
      mkdir -p "${target%/*}"
      if cp --no-preserve=mode,ownership "$f" "$target"; then
        n=$(( n + 1 )); log "mission override: ${target#"$tmp/"}"
      else
        warn "could not apply mission override $rel"
      fi
    done < <(find "$CONFIG_DIR/mission" -type f ! -name .gitkeep -print0 2>/dev/null)
  fi

  rm -rf "$dst" && mv "$tmp" "$dst" || fatal_hold "COULD NOT ACTIVATE THE MISSION WORKING COPY"
  MISSION_OVERRIDES=$n
  log "mission ready: $ACTIVE_MISSION = $MISSION + $n override file(s)"
}

# ---------------------------------------------------------------- config -----
q()    { printf '%s' "${1//\"/\"\"}"; }          # DayZ config strings escape " as ""
flag() { is_true "$1" && printf 1 || printf 0; }

render_config() {
  local tmp=$CFG.tmp whitelist=0
  [[ -f $CONFIG_DIR/whitelist.txt ]] && whitelist=1
  ( umask 077; : > "$tmp" )

  if [[ -f $CONFIG_DIR/serverDZ.cfg ]]; then
    CONFIG_SOURCE=config/serverDZ.cfg
    log "using your config/serverDZ.cfg (server settings in .env are ignored)"
    tr -d '\r' < "$CONFIG_DIR/serverDZ.cfg" > "$tmp"
    # These two must match what the container publishes and the mission it prepared.
    sed -i -E '/^[[:space:]]*steamQueryPort[[:space:]]*=/d' "$tmp"
    if grep -qE 'template[[:space:]]*=' "$tmp"; then
      sed -i -E "s|(template[[:space:]]*=[[:space:]]*\")[^\"]*(\")|\1$ACTIVE_MISSION\2|" "$tmp"
    else
      printf '\nclass Missions { class DayZ { template="%s"; }; };\n' "$ACTIVE_MISSION" >> "$tmp"
    fi
    printf '\nsteamQueryPort = %s;\n' "$STEAM_QUERY_PORT" >> "$tmp"
  else
    local third=1 no3rd=0
    if is_true "${DISABLE_THIRD_PERSON:-false}"; then third=0; no3rd=1; fi
    cat > "$tmp" <<EOF
// Generated at every start from the values in .env. Do not edit: changes are overwritten.
// For full control copy this file to ./config/serverDZ.cfg and edit that copy.
hostname = "$(q "${SERVER_NAME:-DayZ Docker Server}")";
password = "$(q "${SERVER_PASSWORD:-}")";
passwordAdmin = "$(q "${ADMIN_PASSWORD:-}")";
description = "$(q "${SERVER_DESCRIPTION:-}")";
enableWhitelist = $whitelist;
maxPlayers = ${MAX_PLAYERS:-60};
verifySignatures = 2;
forceSameBuild = 1;
disableVoN = 0;
vonCodecQuality = 20;
disable3rdPerson = $no3rd;
thirdPersonView = $third;
disableCrosshair = $(flag "${DISABLE_CROSSHAIR:-false}");
disablePersonalLight = 1;
lightingConfig = 0;
serverTime = "$(q "${SERVER_TIME:-SystemTime}")";
serverTimeAcceleration = ${TIME_ACCELERATION:-1};
serverNightTimeAcceleration = ${NIGHT_TIME_ACCELERATION:-1};
serverTimePersistent = 0;
guaranteedUpdates = 1;
loginQueueConcurrentPlayers = 5;
loginQueueMaxPlayers = 500;
instanceId = 1;
storageAutoFix = 1;
steamQueryPort = $STEAM_QUERY_PORT;
class Missions
{
    class DayZ
    {
        template = "$ACTIVE_MISSION";
    };
};
EOF
  fi
  mv "$tmp" "$CFG"; chmod 0600 "$CFG"
}

install_lists() {
  local f
  for f in ban.txt whitelist.txt priority.txt; do
    [[ -f $CONFIG_DIR/$f ]] || continue
    tr -d '\r' < "$CONFIG_DIR/$f" > "$INSTALL_DIR/.$f.tmp" && mv -f "$INSTALL_DIR/.$f.tmp" "$INSTALL_DIR/$f" \
      && log "installed your config/$f"
  done
  if [[ -n ${PRIORITY_STEAM_IDS:-} ]]; then
    if [[ -f $CONFIG_DIR/priority.txt ]]; then
      warn "config/priority.txt exists - ignoring PRIORITY_STEAM_IDS"
    else
      printf '%s\n' "${PRIORITY_STEAM_IDS%;};" > "$INSTALL_DIR/.priority.tmp" \
        && mv -f "$INSTALL_DIR/.priority.tmp" "$INSTALL_DIR/priority.txt" \
        && log "priority queue: wrote priority.txt from PRIORITY_STEAM_IDS"
    fi
  fi
}

# ---------------------------------------------------------------- housekeeping
housekeep() {
  local days=${LOG_RETENTION_DAYS:-14}
  [[ $days =~ ^[0-9]+$ ]] || days=14
  find "$PROFILES" -maxdepth 1 -type f \
       \( -name '*.RPT' -o -name '*.ADM' -o -name '*.log' -o -name '*.mdmp' \) -mtime +"$days" -delete 2>/dev/null
  # crash dumps are large: keep the newest 10 regardless of age
  find "$PROFILES" -maxdepth 1 -type f -name '*.mdmp' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | awk 'NR > 10 { sub(/^[^ ]+ /, ""); print }' | while IFS= read -r f; do rm -f "$f"; done
  # the server drops a tiny error_<timestamp>.log into its working directory at every start
  find "$INSTALL_DIR" -maxdepth 1 -type f -name 'error_*.log' -mmin +60 -delete 2>/dev/null
}

# ---------------------------------------------------------------- log filters
# stdout is the server console. A vanilla boot prints several hundred lines of harmless
# engine chatter; they are dropped unless LOG_VERBOSE=true (the RPT files keep them).
filter_stdout() {
  trap '' TERM INT
  local line verbose=0
  is_true "${LOG_VERBOSE:-false}" && verbose=1
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == *"Mission read."* ]] && : > "$STATE/mission-read"
    if (( ! verbose )); then
      case $line in
        *"Warning Message: No entry "*|*"Attempt to insert input twice"*|\
        *"Warning Message: Cannot open object"*|*"[CE][Storage] ver:0 stamp:0, valid:NO"*|\
        *"Primary Spawner:"*) continue ;;
      esac
      [[ $line =~ ^[0-9:]+\ \[[0-9]+\]\ [A-Za-z0-9_]+$ ]] && continue   # spawner list entries
    fi
    printf '%s\n' "$line"
  done
}

# stderr carries the -dologs mirror of the RPT file: thousands of lines per minute at boot.
# The RPT files in the data volume keep everything, so by default only the lines that matter
# for operating the container are passed on.
filter_stderr() {
  trap '' TERM INT
  local line verbose=0
  is_true "${LOG_VERBOSE:-false}" && verbose=1
  while IFS= read -r line || [[ -n $line ]]; do
    if (( verbose )); then printf '%s\n' "$line" >&2; continue; fi
    case $line in
      *"Destroying game"*|*"~DayZGame()"*|*"Cleaning up script module"*|*"Termination successfully"*|\
      *"double free"*|*"Assertion failed"*|*"Segmentation"*|*"termination in"*|*"[Shutdown]"*)
        printf '%s\n' "$line" >&2 ;;
    esac
  done
}

# ---------------------------------------------------------------- prepare ----
mkdir -p "$STATE" "$PROFILES" "$STORAGE" "$BEPATH" "${CFG%/*}"
rm -f "$STATE"/* 2>/dev/null

# Everything the status sidecar cannot ask the game server or Docker for. Published once
# here and then kept current by set_state and by the heartbeat in the supervisor loop.
MISSION_OVERRIDES=0
CONFIG_SOURCE=generated
status_set phase server
status_set branch "$BRANCH"
status_set mission "$MISSION"
status_set active_mission "$ACTIVE_MISSION"
status_set world "$WORLD"
status_set profiles_dir "$PROFILES"
status_set storage_dir "$STORAGE"
status_set config_file "$CFG"
status_raw game_port "$GAME_PORT"
status_raw query_port "$STEAM_QUERY_PORT"
status_raw max_players "${MAX_PLAYERS:-60}"
status_set server_time "${SERVER_TIME:-SystemTime}"
status_raw time_acceleration "${TIME_ACCELERATION:-1}"
status_raw night_time_acceleration "${NIGHT_TIME_ACCELERATION:-1}"
status_set tz "${TZ:-UTC}"
status_raw updates_paused "$([[ ${UPDATES_PAUSED:-0} == 1 ]] && echo true || echo false)"
status_raw limit_fps "${LIMIT_FPS:-60}"
status_raw log_retention_days "${LOG_RETENTION_DAYS:-14}"
set_state PREPARING

build_mission
render_config
install_lists
housekeep
(( STOP_REQUESTED )) && exit 0

args=( "-config=$CFG" "-port=$GAME_PORT" "-profiles=$PROFILES" "-storage=$STORAGE"
       "-BEpath=$BEPATH" -dologs -adminlog -freezecheck )
(( ${LIMIT_FPS:-60} > 0 )) && args+=( "-limitFPS=${LIMIT_FPS:-60}" )
if [[ -n ${EXTRA_ARGS:-} ]]; then read -ra extra <<< "$EXTRA_ARGS"; args+=( "${extra[@]}" ); fi

status_raw mission_overrides "$MISSION_OVERRIDES"
status_set config_source "$CONFIG_SOURCE"
status_set launch_args "${args[*]}"

if [[ $BRANCH == experimental ]]; then
  banner "EXPERIMENTAL BRANCH" \
         "Only players running 'DayZ Experimental' can join this server." \
         "For a normal server set DAYZ_BRANCH=stable in .env."
fi

# ---------------------------------------------------------------- launch -----
# Two FIFOs and two filter processes with known PIDs, all direct children of this script:
# the stop signal goes to the server itself, never to a pipe (a killed filter would end
# the server with SIGPIPE before it has saved anything).
mkfifo "$STATE/out.fifo" "$STATE/err.fifo" "$STATE/tick.fifo"
filter_stdout < "$STATE/out.fifo" & F_OUT=$!
filter_stderr < "$STATE/err.fifo" & F_ERR=$!

cd "$INSTALL_DIR" || fatal_hold "INSTALL DIRECTORY MISSING: $INSTALL_DIR"
log "starting: ./DayZServer ${args[*]}"
# setsid: own process group, so a final SIGKILL also reaches helpers such as CrashReporter.
# env -i: no settings, passwords or tokens in the game server's environment or crash dumps.
setsid env -i HOME=/home/dayz PATH="$PATH" LANG=C.UTF-8 TZ="${TZ:-UTC}" \
  ./DayZServer "${args[@]}" > "$STATE/out.fifo" 2> "$STATE/err.fifo" < /dev/null &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$STATE/pid"
status_raw server_pid "$SERVER_PID"
status_raw server_started_epoch "$(date '+%s')"
status_raw port_bound false
status_raw mission_ready false
status_raw restart_due_epoch null
set_state STARTING

# ---------------------------------------------------------------- supervise --
exec 9<> "$STATE/tick.fifo"               # `read -t` on it = interruptible 1 s tick, no fork
alive()   { kill -0 "$SERVER_PID" 2>/dev/null; }
kill_all(){ kill -KILL -- "-$SERVER_PID" 2>/dev/null; kill -KILL "$SERVER_PID" 2>/dev/null; }

interval=$(( ${RESTART_INTERVAL_HOURS:-6} * 3600 ))
# Test hook (not exposed in docker-compose.yml): a restart interval in seconds.
[[ ${RESTART_INTERVAL_SECONDS:-} =~ ^[0-9]+$ ]] && interval=$RESTART_INTERVAL_SECONDS
read -r up _ < /proc/uptime; started=${up%%.*}
port_seen_at=""; port_gone_at=""; term_sent=0; deadline=0; stop_reason=""; flushed=0
told_ready=0; counter_reset=0; last_housekeep=$started; last_restart_check=0
last_status=0

# Monotonic seconds -> wall-clock epoch, for the sidecar (which has no view of this
# container's /proc/uptime). Recomputed at each publish so a corrected host clock - the
# WSL2 VM does that after the Windows host sleeps - cannot freeze a stale timestamp.
publish_heartbeat() {   # publish_heartbeat MONO_NOW
  local mono=$1 epoch; epoch=$(date '+%s')
  status_raw port_bound "$([[ -n $port_seen_at ]] && echo true || echo false)"
  status_raw mission_ready "$([[ $told_ready == 1 ]] && echo true || echo false)"
  if [[ -n $port_seen_at ]]; then
    status_raw port_bound_epoch "$(( epoch - (mono - port_seen_at) ))"
    if (( interval > 0 )); then
      status_raw restart_due_epoch "$(( epoch + (port_seen_at + interval - mono) ))"
      status_raw restart_deadline_epoch "$(( epoch + (port_seen_at + interval + RESTART_DEFER_MAX - mono) ))"
    fi
  fi
  status_raw restart_interval_seconds "$interval"
  status_publish
}

while alive; do
  read -r up _ < /proc/uptime; now=${up%%.*}

  if udp_port_bound "$GAME_PORT"; then
    if [[ -z $port_seen_at ]]; then
      port_seen_at=$now
      set_state RUNNING
      publish_heartbeat "$now"
      log "game port $GAME_PORT/udp is bound - loading the mission"
    fi
    port_gone_at=""
  elif [[ -n $port_seen_at && -z $port_gone_at ]]; then
    port_gone_at=$now
    (( term_sent )) || log "the server released its game port on its own (shutdown or crash)"
  fi

  if (( ! told_ready )) && [[ -e $STATE/mission-read ]]; then
    told_ready=1
    status_raw mission_ready_seconds "$(( now - started ))"
    publish_heartbeat "$now"
    banner "SERVER IS UP  (startup took $(( now - started )) s)" \
           "Players connect to this PC's address on port $GAME_PORT, for example 192.168.1.20:$GAME_PORT." \
           "Internet players additionally need UDP 2302-2305 and 27016 forwarded on the router."
    [[ ${UPDATES_PAUSED:-0} == 1 ]] && warn "updates are paused - see the UPDATES PAUSED message above"
  fi

  # A docker stop / compose down / restart arrived.
  if (( STOP_REQUESTED )) && [[ -z $stop_reason ]]; then stop_reason=requested; fi

  if [[ -z $stop_reason ]]; then
    if [[ -z $port_seen_at ]] && (( now - started >= START_TIMEOUT )); then
      stop_reason=start-timeout
      warn "the game port was not bound within $START_TIMEOUT s - giving up on this start"
    elif (( interval > 0 )) && [[ -n $port_seen_at ]] && (( now - port_seen_at >= interval )) \
         && (( now - last_restart_check >= 60 )); then
      last_restart_check=$now
      players=$(a2s_players "$(a2s_info 127.0.0.1 "$STEAM_QUERY_PORT")" 2>/dev/null) || players=""
      if [[ $players == 0 ]]; then
        stop_reason=scheduled; log "scheduled restart: the server is empty"
      elif (( now - port_seen_at >= interval + RESTART_DEFER_MAX )); then
        stop_reason=scheduled; log "scheduled restart: waited long enough for an empty server (players: ${players:-unknown})"
      fi
    fi
  fi

  if [[ -n $stop_reason ]] && (( ! term_sent )); then
    set_state STOPPING
    log "stopping the server ($stop_reason): SIGTERM, then waiting for the world to be saved"
    kill -TERM "$SERVER_PID" 2>/dev/null
    term_sent=1; deadline=$(( now + STOP_TIMEOUT ))
  fi

  if [[ -n $port_gone_at ]] && (( now - port_gone_at >= PORT_GONE_GRACE )); then
    log "world saved and game port released ${PORT_GONE_GRACE} s ago, but the process is still running - SIGKILL (known shutdown hang)"
    flushed=1; [[ -z $stop_reason ]] && stop_reason=self-shutdown
    kill_all; break
  fi
  if (( term_sent )) && (( now >= deadline )); then
    warn "the server ignored SIGTERM for $STOP_TIMEOUT s - SIGKILL (the last world save may be incomplete)"
    kill_all; break
  fi

  # Ten healthy minutes (or a requested stop, below) clear the crash back-off counter.
  if (( ! counter_reset )) && [[ -n $port_seen_at ]] && (( now - port_seen_at >= 600 )); then
    counter_reset=1; printf '0\n' > "$COUNT_FILE"
  fi
  if (( now - last_housekeep >= 86400 )); then last_housekeep=$now; housekeep; fi
  if (( now - last_status >= 15 )); then last_status=$now; publish_heartbeat "$now"; fi

  read -r -t 1 -u 9 _ 2>/dev/null
done

wait "$SERVER_PID" 2>/dev/null; server_rc=$?
[[ -n $port_gone_at ]] && flushed=1
(( server_rc == 0 )) && flushed=1
set_state STOPPED

# Let the filters drain to EOF, but never hang on them.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$F_OUT" 2>/dev/null || kill -0 "$F_ERR" 2>/dev/null || break
  sleep 0.2
done
kill -KILL "$F_OUT" "$F_ERR" 2>/dev/null; wait "$F_OUT" "$F_ERR" 2>/dev/null
rm -f "$STATE"/*.fifo "$STATE/pid"

[[ -z $stop_reason ]] && stop_reason=exited
log "server process ended (reason: $stop_reason, exit status: $server_rc, world saved first: $( (( flushed )) && echo yes || echo 'NOT CONFIRMED'))"

status_set stop_reason "$stop_reason"
status_raw server_exit_status "$server_rc"
status_raw world_saved "$( (( flushed )) && echo true || echo false )"
status_raw stopped_epoch "$(date '+%s')"
status_raw server_pid null
status_raw port_bound false
status_publish

case $stop_reason in
  requested)
    printf '0\n' > "$COUNT_FILE"          # a requested stop is not a crash
    exit 0 ;;
  scheduled|self-shutdown)
    # Exit so that `restart: unless-stopped` starts a fresh run, which checks for updates.
    exit 0 ;;
  *)
    exit 1 ;;
esac
