#!/bin/bash
# Steam phase. Runs as user "steam" (owns steamcmd and the cached login token).
#
#   1. Is an update needed? Ask Steam ANONYMOUSLY for the public build id and compare it
#      with the installed manifest. Up to date => no account login at all.
#   2. Update with the CACHED login token (`+login <user>`, no password).
#   3. Only if there is no valid token: ONE password login per container, then back to 2.
#   4. Missions fallback for Steam accounts that do not own DayZ.
#
# Result for entrypoint.sh, in /run/dayz/steam/status:
#   ok      continue
#   paused  continue with the installed build; updates could not be fetched
#   hold    do not start; the banner in /run/dayz/steam/banner says what the human must do
#
# steamcmd's exit code is NOT trusted: it returns 0 on several failures. Its output is parsed.
set -uo pipefail
LOG_TAG=steam
. /opt/dayz/lib/common.sh
install_stop_trap
umask 022

resolve_branch || { echo "unknown DAYZ_BRANCH" >&2; exit 2; }

STATE_DIR=$RUN_DIR/steam
STATUS_FILE=$STATE_DIR/status
BANNER_FILE=$STATE_DIR/banner
OUT=$STATE_DIR/steamcmd.out
FIFO=$STATE_DIR/steamcmd.fifo
LOGIN_SCRIPT=$STATE_DIR/login.script
MANIFEST=$INSTALL_DIR/steamapps/appmanifest_$APP_ID.acf

# In the container's own filesystem on purpose: it survives restart-policy restarts (so the
# password is never re-sent automatically) and disappears when the container is recreated,
# which is exactly what `docker-compose up -d` does after .env was edited.
CRED_MARKER=/var/lib/dayz/password-login-attempted
# Same lifetime: tells an automatic restart of this container from a fresh container, which
# only a human creates (`docker-compose up -d` after an .env edit, or --force-recreate).
PHASE_MARKER=/var/lib/dayz/steam-phase-ran
FRESH_CONTAINER=1; [[ -e $PHASE_MARKER ]] && FRESH_CONTAINER=0
RATE_LIMIT_FILE=$HOME/.dayz-rate-limited-until
LAST_LOGIN_FILE=$HOME/.dayz-last-account-login

IS_ANON=0; [[ ${STEAM_USERNAME,,} == anonymous ]] && IS_ANON=1
RECREATE_CMD="docker-compose up -d --force-recreate"

trap 'rm -f "$LOGIN_SCRIPT" "$FIFO"' EXIT

# ------------------------------------------------------------ results --------
finish() {            # finish STATUS [banner lines...]
  local status=$1; shift
  printf '%s\n' "$status" > "$STATUS_FILE"
  if (( $# )); then printf '%s\n' "$@" > "$BANNER_FILE"; fi
  exit 0
}

# A problem that blocks updating. With a complete install we still start the server.
paused_or_hold() {    # paused_or_hold "TITLE" "line"...
  if installed; then
    banner "UPDATES PAUSED - $1" "${@:2}" "" \
           "Starting the build that is already installed. If the game has been updated," \
           "players cannot join until this is fixed."
    finish paused
  fi
  finish hold "$@"
}

# ------------------------------------------------------------ install state --
manifest_value() {    # manifest_value KEY
  [[ -r $MANIFEST ]] || return 1
  awk -v k="\"$1\"" '$1 == k { gsub(/"/, "", $2); print $2; exit }' "$MANIFEST"
}

# StateFlags 4 = fully installed. Anything else means an interrupted or pending update.
installed() {
  [[ -x $INSTALL_DIR/DayZServer ]] && [[ $(manifest_value StateFlags) == 4 ]]
}

# ------------------------------------------------------------ steamcmd -------
# Every output line: strip ANSI/CR, redact password and account name, keep a copy for
# parsing, print it, and raise the phone banner when steamcmd waits for an approval.
steam_filter() {
  trap '' TERM INT
  local line shown told_phone=0 esc=$'\e'
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line//$'\r'/}
    while [[ $line =~ $esc\[[0-9\;?]*[A-Za-z] ]]; do line=${line/"${BASH_REMATCH[0]}"/}; done
    [[ -n ${STEAM_PASSWORD:-} ]] && line=${line//"$STEAM_PASSWORD"/********}
    # The copy used for parsing keeps the account name: a name such as "user" or "info"
    # would otherwise mangle the very strings classify() looks for. $OUT lives on tmpfs in
    # a 0700 directory and is wiped at every start.
    printf '%s\n' "$line" >> "$OUT"
    shown=$line
    (( IS_ANON )) || shown=${line//"$STEAM_USERNAME"/<steam-account>}
    printf '    steamcmd | %s\n' "$shown"
    if (( ! told_phone )) && [[ $line == *"Steam Mobile app"* || $line == *"Waiting for confirmation"* ]]; then
      told_phone=1
      banner "ACTION NEEDED NOW: APPROVE THE LOGIN IN THE STEAM MOBILE APP" \
             "Open the Steam app on your phone and confirm the sign-in request." \
             "This is needed once. The login is then cached in a Docker volume."
    fi
  done
}

_exec_steamcmd() {    # runs in a background subshell; exec makes the PID the one we signal
  local t=$1; shift
  exec timeout -k 15 "$t" "$STEAMCMD" "$@" > "$FIFO" 2>&1 < /dev/null
}

# run_steamcmd TIMEOUT_SECONDS args...   - output ends up in $OUT
run_steamcmd() {
  local fpid
  : > "$OUT"; rm -f "$FIFO"; mkfifo "$FIFO"
  steam_filter < "$FIFO" &
  fpid=$!
  run_int _exec_steamcmd "$@"
  local rc=$?
  # The filter ends at EOF; never hang on it.
  local i; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$fpid" 2>/dev/null || break; sleep 0.2; done
  kill -KILL "$fpid" 2>/dev/null; wait "$fpid" 2>/dev/null
  rm -f "$FIFO"
  return "$rc"
}

# Case-sensitive on purpose: steamcmd echoes settings such as "@ShutdownOnFailedCommand",
# which a case-insensitive search for FAILED would mistake for an error.
out_has() { grep -qE -- "$1" "$OUT" 2>/dev/null; }

# Order matters: specific login failures first, generic timeouts last.
classify() {
  if   out_has "Rate Limit Exceeded";                                  then echo rate_limit
  elif out_has "Invalid Password";                                     then echo invalid_password
  elif out_has "Invalid Login Auth Code|Two-factor code mismatch";     then echo bad_code
  elif out_has "Timed out waiting for confirmation";                   then echo approval_timeout
  elif out_has "Account Logon Denied|Steam Guard code:|command 'set_steam_guard_code'|Two-factor code:"; then echo guard_needed
  elif out_has "Cached credentials not found|No cached credentials|invalid cached credentials|Cached credential is invalid|Access Denied|License expired"; then echo no_token
  elif out_has "No subscription";                                      then echo no_subscription
  elif out_has "Success! App '$APP_ID' (fully installed|already up to date)"; then echo ok
  elif out_has "No Connection|Service Unavailable|Try again later|Timeout|Timed out|Connection reset"; then echo network
  else echo unknown
  fi
}

# ------------------------------------------------------------ build id -------
APPINFO_OUT=$STATE_DIR/appinfo.out

_exec_appinfo() {
  # A separate HOME: the anonymous session must never touch the cached account token.
  # app_info_print is issued twice because steamcmd sometimes prints nothing the first time.
  mkdir -p /tmp/steam-anon
  exec env HOME=/tmp/steam-anon timeout -k 15 120 "$STEAMCMD" \
       +login anonymous +app_info_update 1 \
       +app_info_print "$APP_ID" +app_info_print "$APP_ID" +quit \
       > "$APPINFO_OUT" 2>&1 < /dev/null
}

# Sets REMOTE_BUILD (empty when Steam could not be reached). Not called through $(...):
# traps are deferred inside a command substitution, which would make a stop request wait.
fetch_remote_buildid() {
  REMOTE_BUILD=""
  run_int _exec_appinfo
  REMOTE_BUILD=$(awk '
    /"branches"/            { b = 1 }
    b && /"public"/         { p = 1 }
    b && p && /"buildid"/   { gsub(/"/, "", $2); print $2; exit }
  ' "$APPINFO_OUT" 2>/dev/null)
}

# ------------------------------------------------------------ logins ---------
account_login_too_recent() {     # at most one account session per 10 minutes once installed
  local last=0 now; now=$(date +%s)
  [[ -r $LAST_LOGIN_FILE ]] && read -r last < "$LAST_LOGIN_FILE"
  [[ $last =~ ^[0-9]+$ ]] || last=0
  (( now - last < 600 ))
}
note_account_login() { (( IS_ANON )) || date +%s > "$LAST_LOGIN_FILE"; }

update_with_token() {            # one steamcmd session: cached login + app_update
  local login=(+login "$STEAM_USERNAME") app=(+app_update "$APP_ID")
  (( IS_ANON )) && login=(+login anonymous)
  is_true "${VALIDATE_ON_START:-false}" && app+=(validate)
  note_account_login
  run_steamcmd 14400 +@ShutdownOnFailedCommand 1 +@NoPromptForPassword 1 \
      +@sSteamCmdForcePlatformType linux +force_install_dir "$INSTALL_DIR" \
      "${login[@]}" "${app[@]}" +quit
}

# After "Rate Limit Exceeded" no account login of any kind (password or token) for 6 hours.
rate_limit_gate() {
  local now until=0; now=$(date +%s)
  [[ -r $RATE_LIMIT_FILE ]] && read -r until < "$RATE_LIMIT_FILE"
  [[ $until =~ ^[0-9]+$ ]] || until=0
  if (( now < until )); then
    paused_or_hold "STEAM RATE LIMIT: no account login before $(date -d "@$until" '+%Y-%m-%d %H:%M %Z')" \
      "Steam answered 'Rate Limit Exceeded' earlier. More attempts would extend the lock-out." \
      "After that time run:  $RECREATE_CMD"
  fi
}

password_login() {               # returns 0 when the token is cached now
  rate_limit_gate
  if [[ -e $CRED_MARKER ]]; then
    paused_or_hold "STEAM LOGIN NEEDED (a password login was already tried by this container)" \
      "The password is sent to Steam at most once per container, so automatic restarts" \
      "can never lock your account out." \
      "When you are ready (phone at hand), run:  $RECREATE_CMD"
  fi
  if [[ -z ${STEAM_PASSWORD:-} ]]; then
    paused_or_hold "STEAM LOGIN NEEDED: set STEAM_PASSWORD in .env" \
      "There is no cached Steam login for this account yet (or it has expired)." \
      "Put the password in .env (single quotes if it contains \$ # or spaces), then run:" \
      "  docker-compose up -d" \
      "Mobile authenticator: have your phone ready and approve the sign-in." \
      "Email Steam Guard: the first attempt sends you a code; see the next message."
  fi

  : > "$CRED_MARKER"
  ( umask 077
    { printf '@ShutdownOnFailedCommand 1\n'
      [[ -n ${STEAM_GUARD_CODE:-} ]] && printf 'set_steam_guard_code %s\n' "$STEAM_GUARD_CODE"
      printf 'login "%s" "%s"\n' "$STEAM_USERNAME" "$STEAM_PASSWORD"
      printf 'quit\n'
    } > "$LOGIN_SCRIPT" )
  log "logging in with the password (once per container). Watch for a phone approval request."
  note_account_login
  # No @NoPromptForPassword here: prompts must behave normally so that the mobile approval
  # wait works; stdin is /dev/null, so a code prompt fails fast instead of hanging.
  run_steamcmd "${AUTH_TIMEOUT:-600}" +runscript "$LOGIN_SCRIPT"
  rm -f "$LOGIN_SCRIPT"
  (( STOP_REQUESTED )) && exit 0

  if out_has "Waiting for user info\.\.\.OK|Logged in OK" && ! out_has "FAILED \(|ERROR \(|ERROR!"; then
    banner "STEAM LOGIN CACHED" \
           "Later starts use the cached token and need no password and no phone." \
           "You can now blank STEAM_PASSWORD and STEAM_GUARD_CODE in .env."
    return 0
  fi

  case $(classify) in
    rate_limit)
      date -d '+6 hours' +%s > "$RATE_LIMIT_FILE"
      paused_or_hold "STEAM SAYS: RATE LIMIT EXCEEDED" \
        "Too many login attempts for this account or IP address." \
        "Do not retry for at least 6 hours, then run:  $RECREATE_CMD" ;;
    invalid_password)
      paused_or_hold "STEAM SAYS: INVALID PASSWORD" \
        "Check STEAM_USERNAME and STEAM_PASSWORD in .env." \
        "A password containing \$ # or spaces must be wrapped in single quotes:" \
        "  STEAM_PASSWORD='pa\$\$word #1'" \
        "Then run:  docker-compose up -d" ;;
    bad_code)
      paused_or_hold "STEAM SAYS: THE STEAM GUARD CODE IS WRONG OR EXPIRED" \
        "Steam has sent a new email. Put the code from the NEWEST email into .env as" \
        "STEAM_GUARD_CODE=XXXXX and run:  docker-compose up -d" ;;
    guard_needed)
      paused_or_hold "STEAM GUARD EMAIL CODE NEEDED" \
        "Steam has emailed a 5-character code to the account's address." \
        "Put it into .env as STEAM_GUARD_CODE=XXXXX and run:  docker-compose up -d" \
        "(Accounts using the mobile authenticator get an approval request instead.)" ;;
    approval_timeout)
      paused_or_hold "THE LOGIN WAS NOT APPROVED IN TIME" \
        "Have the Steam mobile app open, then run:  $RECREATE_CMD" ;;
    *)
      paused_or_hold "STEAM LOGIN FAILED" \
        "See the steamcmd lines above for the reason." \
        "To try again run:  $RECREATE_CMD" ;;
  esac
}

# ------------------------------------------------------------ update ---------
do_update() {
  local attempt result tried_password=0 skip_delay=0 delays=(0 30 120)
  [[ -n ${RETRY_DELAYS:-} ]] && read -ra delays <<< "$RETRY_DELAYS"     # test hook
  (( IS_ANON )) || rate_limit_gate
  # Only for automatic restarts of the same container. A fresh container means a human just
  # ran docker-compose (for example with a new Steam Guard code) and must not be refused.
  if (( ! IS_ANON && ! FRESH_CONTAINER )) && installed && account_login_too_recent; then
    paused_or_hold "STEAM LOGIN SKIPPED: the last account login was under 10 minutes ago" \
      "This protects the account from rapid repeated logins (for example in a crash loop)." \
      "To log in now anyway run:  $RECREATE_CMD"
  fi
  for attempt in 0 1 2; do
    if (( delays[attempt] && ! skip_delay )); then
      log "retrying in ${delays[attempt]} s"
      nap "${delays[attempt]}" || exit 0
    fi
    skip_delay=0
    update_with_token
    (( STOP_REQUESTED )) && exit 0
    result=$(classify)
    case $result in
      ok)
        if out_has "Timed out waiting for update to start"; then
          warn "steamcmd skipped the validation pass this time (known glitch); the install itself is fine"
        fi
        if installed; then log "server files are ready (build $(manifest_value buildid))"; return 0; fi
        warn "steamcmd reported success but the install is incomplete" ;;
      # This session sent no password and allowed no prompt, so a login-type failure here
      # can only mean that the cached token was rejected, whatever wording Steam chose.
      no_token|invalid_password|guard_needed|bad_code|approval_timeout)
        if (( IS_ANON || tried_password )); then break; fi
        tried_password=1
        password_login            # returns only on success
        skip_delay=1
        log "token cached - repeating the update with it" ;;
      no_subscription)
        if (( IS_ANON )); then
          finish hold "STEAM SAYS: NO SUBSCRIPTION" \
            "This app cannot be downloaded anonymously." \
            "Use a real Steam account, or DAYZ_BRANCH=experimental with STEAM_USERNAME=anonymous."
        fi
        paused_or_hold "STEAM SAYS: NO SUBSCRIPTION FOR APP $APP_ID" \
          "This Steam account is not allowed to download the DayZ server." \
          "Use the account that owns DayZ." ;;
      rate_limit)
        date -d '+6 hours' +%s > "$RATE_LIMIT_FILE"
        paused_or_hold "STEAM SAYS: RATE LIMIT EXCEEDED" \
          "Do not retry for at least 6 hours, then run:  $RECREATE_CMD" ;;
      *) warn "update attempt $(( attempt + 1 )) of 3 failed ($result)" ;;
    esac
  done
  paused_or_hold "COULD NOT UPDATE THE SERVER FILES" \
    "Steam may be unreachable, or the download failed. See the steamcmd lines above." \
    "The next container start tries again. To retry now:  docker-compose restart"
}

# ------------------------------------------------------------ missions -------
# A Steam account that does not own DayZ gets the server but not depot 223354 (mpmissions).
ensure_missions() {
  [[ -d $INSTALL_DIR/mpmissions/$MISSION ]] && return 0
  if [[ $MISSION != dayzOffline.* ]]; then
    finish hold "MISSION '$MISSION' DOES NOT EXIST" \
      "Bundled missions: dayzOffline.chernarusplus, dayzOffline.enoch, dayzOffline.sakhal." \
      "Fix MISSION in .env, then run:  docker-compose up -d"
  fi
  local ref=${MISSIONS_REF:-master} tmp=$INSTALL_DIR/.missions-tmp d n=0
  if [[ ! $ref =~ ^[A-Za-z0-9._/-]+$ ]]; then
    finish hold "INVALID SETTING: MISSIONS_REF='$ref'" "Expected a branch, tag or commit of DayZ-Central-Economy."
  fi
  banner "MISSION FILES ARE NOT PART OF THIS STEAM DOWNLOAD" \
         "Steam only delivers them to accounts that own DayZ. Fetching Bohemia's official" \
         "mission files from github.com/BohemiaInteractive/DayZ-Central-Economy ($ref)." \
         "They may be slightly newer or older than the server build."
  rm -rf "$tmp"; mkdir -p "$tmp/x"
  run_int curl --proto '=https' --tlsv1.2 -fL --retry 3 --max-time 1800 -sS -o "$tmp/missions.tar.gz" \
      "https://github.com/BohemiaInteractive/DayZ-Central-Economy/archive/$ref.tar.gz"
  local rc=$?
  (( STOP_REQUESTED )) && exit 0
  if (( rc == 0 )); then
    run_int tar -xzf "$tmp/missions.tar.gz" -C "$tmp/x" --strip-components=1 \
        --no-same-owner --no-same-permissions --wildcards '*/dayzOffline.*'
    rc=$?
  fi
  (( STOP_REQUESTED )) && exit 0
  if (( rc == 0 )); then
    mkdir -p "$INSTALL_DIR/mpmissions"
    for d in "$tmp"/x/dayzOffline.*; do
      [[ -d $d && ! -e $INSTALL_DIR/mpmissions/${d##*/} ]] || continue
      mv "$d" "$INSTALL_DIR/mpmissions/" && n=$(( n + 1 ))
    done
    printf 'source=github ref=%s fetched=%s\n' "$ref" "$(date -u +%FT%TZ)" > "$INSTALL_DIR/mpmissions/.missions-source"
  fi
  rm -rf "$tmp"
  if [[ ! -d $INSTALL_DIR/mpmissions/$MISSION ]]; then
    finish hold "COULD NOT FETCH THE MISSION FILES" \
      "The download from GitHub failed (exit code $rc). To retry:  docker-compose restart"
  fi
  log "installed $n mission folder(s) from GitHub ($ref)"
}

# ------------------------------------------------------------ main -----------
mkdir -p "$STATE_DIR"; rm -f "$STATUS_FILE" "$BANNER_FILE"
: > "$PHASE_MARKER"

if ! installed; then
  log "the server is not installed yet - downloading about 1.6 GB (4 GB on disk)"
  do_update
elif ! is_true "${UPDATE_ON_START:-true}"; then
  log "UPDATE_ON_START=false - keeping build $(manifest_value buildid)"
elif is_true "${VALIDATE_ON_START:-false}"; then
  log "VALIDATE_ON_START=true - verifying every file"
  do_update
else
  local_build=$(manifest_value buildid)
  fetch_remote_buildid
  remote_build=$REMOTE_BUILD
  (( STOP_REQUESTED )) && exit 0
  if [[ -z $remote_build ]]; then
    warn "could not read the current build id from Steam (offline?) - starting installed build $local_build"
  elif [[ $remote_build == "$local_build" ]]; then
    log "up to date (build $local_build) - no Steam account login needed"
  else
    log "update available: build $local_build -> $remote_build"
    do_update
  fi
fi

ensure_missions
finish ok
