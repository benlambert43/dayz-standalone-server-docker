#!/bin/bash
# Shared helpers. Sourced by entrypoint.sh, steam-update.sh, run-server.sh and healthcheck.sh.
#
# Deliberately NO `set -e` anywhere: these scripts supervise other processes, and `wait`
# legitimately returns >128 whenever a trapped signal arrives.

# ---------------------------------------------------------------- paths ------
SERVER_ROOT=/dayz/server          # Steam-managed installs, one folder per branch
DATA_ROOT=/dayz/data              # world persistence, logs, generated config, state
CONFIG_DIR=/config                # read-only bind mount of ./config (optional user overrides)
RUN_DIR=/run/dayz                 # tmpfs: run-time state, never persisted
STEAMCMD=${STEAMCMD:-/opt/steamcmd/steamcmd.sh}

GAME_PORT=2302
STEAM_QUERY_PORT=27016

# ---------------------------------------------------------------- logging ----
LOG_TAG=${LOG_TAG:-dayz}

log()  { printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$LOG_TAG" "$*"; }
warn() { log "WARNING: $*"; }

# banner "TITLE" "line" "line" ...   - impossible to miss in `docker-compose logs`
banner() {
  local title=$1 line; shift
  printf '\n'
  printf '%s\n' "================================================================================"
  printf '  %s\n' "$title"
  printf '%s\n' "--------------------------------------------------------------------------------"
  for line in "$@"; do printf '  %s\n' "$line"; done
  printf '%s\n\n' "================================================================================"
}

# ---------------------------------------------------------------- settings ---
# Compose strips CR from .env values; this is a cheap second line of defence for values
# that arrive some other way (docker run -e, env files edited on Windows).
strip_cr() { printf '%s' "${1//$'\r'/}"; }

is_true() {
  case "${1,,}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac
}

# Seconds since boot from /proc/uptime. Monotonic, unlike wall-clock time, which jumps when
# the Windows host sleeps and the WSL2 VM clock is corrected afterwards.
mono_now() {
  local up _
  read -r up _ < /proc/uptime
  printf '%s' "${up%%.*}"
}

# ---------------------------------------------------------------- signals ----
# A bash trap never runs while a FOREGROUND child is running, so every blocking command
# goes through run_int: start it in the background, then sit in an interruptible `wait`.
# The TERM/INT handler only sets a flag and forwards the signal to the current child.
STOP_REQUESTED=0
CHILD_PID=""

_on_stop_signal() {
  STOP_REQUESTED=1
  if [[ -n $CHILD_PID ]]; then kill -TERM "$CHILD_PID" 2>/dev/null; fi
}

install_stop_trap() { trap _on_stop_signal TERM INT; }

# run_int cmd [args...]   - returns the command's exit status
run_int() {
  local rc rc2
  "$@" &
  CHILD_PID=$!
  while :; do
    # Closes most of the window in which a signal lands before CHILD_PID was set.
    if (( STOP_REQUESTED )); then kill -TERM "$CHILD_PID" 2>/dev/null; fi
    wait "$CHILD_PID" 2>/dev/null
    rc=$?
    kill -0 "$CHILD_PID" 2>/dev/null || break
  done
  # rc > 128 can mean "wait was interrupted by a trapped signal" rather than the child's
  # own status. The child is gone by now, so one more wait returns its saved real status
  # (or 127 if bash has already handed it out, in which case the first value stands).
  if (( rc > 128 )); then
    wait "$CHILD_PID" 2>/dev/null; rc2=$?
    (( rc2 != 127 )) && rc=$rc2
  fi
  CHILD_PID=""
  return "$rc"
}

# Interruptible sleep. Returns 1 when a stop was requested.
nap() {
  (( STOP_REQUESTED )) && return 1
  run_int sleep "$1"
  (( STOP_REQUESTED )) && return 1
  return 0
}

# ---------------------------------------------------------------- network ----
# udp_port_bound PORT  - is any UDP socket in this network namespace bound to PORT?
# Pure bash (no fork): the supervisor calls this once per second for months.
udp_port_bound() {
  local want f _sl addr _rest
  printf -v want ':%04X' "$1"
  for f in /proc/net/udp /proc/net/udp6; do
    [[ -r $f ]] || continue
    while read -r _sl addr _rest; do
      [[ ${addr^^} == *"$want" ]] && return 0
    done < "$f"
  done
  return 1
}

# a2s_info [host] [port]  - prints the A2S_INFO reply as a hex string; returns 1 on no reply.
# Pure bash on /dev/udp. Two details matter (both found by experiment):
#   * every packet goes through `dd iflag=fullblock`, because bash's printf flushes at each
#     0x0a byte and would split a challenge containing 0x0a into two datagrams;
#   * non-loopback clients first get a challenge (0x41) that has to be echoed back.
a2s_info() (
  host=${1:-127.0.0.1}; port=${2:-$STEAM_QUERY_PORT}
  q='\xff\xff\xff\xffTSource Engine Query\x00'
  exec 2>/dev/null
  exec {fd}<>"/dev/udp/$host/$port" || exit 1
  send() { printf "$1" | dd bs=1400 count=1 iflag=fullblock >&"$fd"; }
  recv() { timeout 1.5 dd bs=1400 count=1 <&"$fd" | od -An -v -tx1 | tr -d ' \n'; }
  send "$q"; hex=$(recv)
  if [[ $hex == ffffffff41???????? ]]; then
    c=${hex:10:8}
    send "$q\x${c:0:2}\x${c:2:2}\x${c:4:2}\x${c:6:2}"; hex=$(recv)
  fi
  [[ $hex == ffffffff49* ]] || exit 1
  printf '%s' "$hex"
)

a2s_alive() { a2s_info "$@" >/dev/null; }

# a2s_players HEX  - player count from an A2S_INFO reply.
# Layout: ffffffff 49 <protocol> <name\0> <map\0> <folder\0> <game\0> <appid:2> <players:1> ...
a2s_players() {
  local body=${1:12} i=0 nul=0 n
  n=${#body}
  while (( i < n && nul < 4 )); do
    [[ ${body:i:2} == 00 ]] && (( nul++ ))
    (( i += 2 ))
  done
  (( nul == 4 && i + 6 <= n )) || return 1
  printf '%d' "$(( 16#${body:i+4:2} ))"
}

# ---------------------------------------------------------------- branch -----
# Sets APP_ID and BRANCH from DAYZ_BRANCH. Returns 1 on an unknown value.
resolve_branch() {
  BRANCH=$(strip_cr "${DAYZ_BRANCH:-stable}"); BRANCH=${BRANCH,,}
  case $BRANCH in
    stable|"")    BRANCH=stable;       APP_ID=223350  ;;
    experimental) BRANCH=experimental; APP_ID=1042420 ;;
    *) return 1 ;;
  esac
  INSTALL_DIR=$SERVER_ROOT/$BRANCH
}

# ---------------------------------------------------------------- status -----
# The status sidecar (see status/) runs in its own container and can reach neither this
# container's tmpfs nor its process table. The handful of facts it cannot obtain from a
# Steam query or from the Docker API - which phase the supervisor is in, why it is holding,
# when the server process started, when the next scheduled restart is due - are therefore
# published as one small JSON file on the shared data volume.
#
# Best effort by design: a full disk or a read-only volume must never take the server down,
# so every failure here is swallowed and the caller always sees success.
STATUS_JSON=$DATA_ROOT/state/status.json

declare -A STATUS_FIELDS=()
declare -A STATUS_RAW=()

# json_str VALUE  - VALUE as a JSON string literal.
#
# The escape characters are held in variables rather than written inline: a replacement text
# like ${s//X/\\n} is read twice by bash, once as a word and once as the replacement, and
# getting that wrong produces a file that looks right in the log and is unparsable for the
# reader. Remaining control characters become a space, because nothing published here needs
# them and a raw one would break the whole document.
json_str() {
  local s=${1-}
  local bs='\' q='"' nl=$'\n' cr=$'\r' tab=$'\t'
  s=${s//"$bs"/"$bs$bs"}
  s=${s//"$q"/"$bs$q"}
  s=${s//"$nl"/"${bs}n"}
  s=${s//"$cr"/"${bs}r"}
  s=${s//"$tab"/"${bs}t"}
  s=${s//[[:cntrl:]]/ }
  printf '%s%s%s' "$q" "$s" "$q"
}

status_set() { STATUS_FIELDS[$1]=${2-}; unset "STATUS_RAW[$1]"; }   # emitted as a string
status_raw() { STATUS_FIELDS[$1]=${2-}; STATUS_RAW[$1]=1; }         # emitted verbatim (number/bool/null)

status_publish() {
  local tmp k first=1
  mkdir -p "${STATUS_JSON%/*}" 2>/dev/null || return 0
  tmp=$STATUS_JSON.$$
  status_set updated_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  status_raw updated_epoch "$(date '+%s')"
  {
    printf '{'
    for k in "${!STATUS_FIELDS[@]}"; do
      (( first )) || printf ','
      first=0
      json_str "$k"; printf ':'
      if [[ -n ${STATUS_RAW[$k]:-} ]]; then printf '%s' "${STATUS_FIELDS[$k]:-null}"
      else json_str "${STATUS_FIELDS[$k]}"; fi
    done
    printf '}\n'
  } > "$tmp" 2>/dev/null && chmod 0644 "$tmp" 2>/dev/null && mv -f "$tmp" "$STATUS_JSON" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
  return 0
}
