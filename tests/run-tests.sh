#!/bin/bash
# Tests for the Steam login/update state machine (docker/steam-update.sh) using
# tests/fake-steamcmd.sh. No Steam account and no network needed (except the optional
# GitHub missions test: RUN_NETWORK_TESTS=1).
#
# Run from the repository root:
#   docker compose build
#   docker run --rm -v "./tests:/tests:ro" --entrypoint /tests/run-tests.sh dayz-server:local
set -u
PASS=0; FAIL=0
T=/tmp/t; SECRET='S3cr3t-Pa$$w0rd #1'

reset_all()       { rm -rf /dayz/server/* /var/lib/dayz/* /run/dayz/steam "$T"; mkdir -p "$T/home" /run/dayz/steam /var/lib/dayz; : > "$T/calls"; }
new_container()   { rm -f /var/lib/dayz/*; }          # what `docker-compose up -d` after an .env edit does
count()           { grep -c "^$1\$" "$T/calls" 2>/dev/null || true; }
status()          { cat /run/dayz/steam/status 2>/dev/null; }
banner_text()     { cat /run/dayz/steam/banner 2>/dev/null; }

# run KEY=VALUE...   - one container start; output in $T/out
run() {
  : > "$T/calls"
  env -i PATH="$PATH" HOME="$T/home" STEAMCMD=/tests/fake-steamcmd.sh FAKE_CALLS="$T/calls" \
      RETRY_DELAYS="0 0 0" AUTH_TIMEOUT=20 DAYZ_BRANCH=stable MISSION=dayzOffline.chernarusplus \
      STEAM_USERNAME=someuser STEAM_PASSWORD="" STEAM_GUARD_CODE="" \
      UPDATE_ON_START=true VALIDATE_ON_START=false MISSIONS_REF=master "$@" \
      /opt/dayz/steam-update.sh > "$T/out" 2>&1
}

check() {   # check "description" command...
  local d=$1; shift
  if "$@" > /dev/null 2>&1; then PASS=$((PASS+1)); printf '  ok    %s\n' "$d"
  else FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$d"; sed 's/^/        | /' "$T/out" | tail -15; fi
}
is()       { [[ $1 == "$2" ]]; }
has()      { grep -qF -- "$1" "$2"; }
has_not()  { ! grep -qF -- "$1" "$2"; }

echo "1. anonymous Experimental install"
reset_all; run DAYZ_BRANCH=experimental STEAM_USERNAME=anonymous
check "status ok"                       is "$(status)" ok
check "no password login attempted"     is "$(count login)" 0
check "server binary installed"         test -x /dayz/server/experimental/DayZServer

echo "2. first login with the mobile authenticator"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=mobile
check "status ok"                       is "$(status)" ok
check "exactly one password login"      is "$(count login)" 1
check "phone banner shown"              has "APPROVE THE LOGIN IN THE STEAM MOBILE APP" "$T/out"
check "token-cached banner shown"       has "STEAM LOGIN CACHED" "$T/out"
check "password never printed"          has_not "$SECRET" "$T/out"
check "account name never printed"      has_not "someuser" "$T/out"
check "login script removed"            test ! -e /run/dayz/steam/login.script

echo "3. restart of the same container: up to date => no account login at all"
run STEAM_PASSWORD="$SECRET"
check "status ok"                       is "$(status)" ok
check "only the anonymous build check"  is "$(count update)$(count login)" 00
check "says no login needed"            has "no Steam account login needed" "$T/out"

echo "4. game update available, cached token works, password not needed"
rm -f "$T/home/.dayz-last-account-login"      # pretend the first login was long ago
run FAKE_REMOTE_BUILD=2000
check "status ok"                       is "$(status)" ok
check "one token update, no password login" is "$(count update)$(count login)" 10

echo "5. no token and no password => hold with instructions, Steam never contacted with a password"
reset_all; run
check "status hold"                     is "$(status)" hold
check "banner asks for STEAM_PASSWORD"  has "set STEAM_PASSWORD in .env" /run/dayz/steam/banner
check "no password login attempted"     is "$(count login)" 0

echo "6. email Steam Guard: first attempt asks for the code, a restart does NOT re-send the password"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=guard
check "status hold"                     is "$(status)" hold
check "banner asks for the emailed code" has "STEAM GUARD EMAIL CODE NEEDED" /run/dayz/steam/banner
run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=guard            # restart policy: same container
check "restart: no second password login" is "$(count login)" 0
check "restart: explains how to retry"  has "force-recreate" /run/dayz/steam/banner
new_container; run STEAM_PASSWORD="$SECRET" STEAM_GUARD_CODE=AB12C FAKE_LOGIN=ok   # .env edited + up -d
check "new container with code: ok"     is "$(status)" ok
check "code was passed to steamcmd"     test "$(count login)" = 1

echo "7. rate limit survives a new container"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ratelimit
check "status hold"                     is "$(status)" hold
check "banner names the rate limit"     has "RATE LIMIT" /run/dayz/steam/banner
new_container; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok
check "still refused in a new container" is "$(status)$(count login)" hold0

echo "8. wrong password and wrong code"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=invalid
check "invalid password => hold"        has "INVALID PASSWORD" /run/dayz/steam/banner
reset_all; run STEAM_PASSWORD="$SECRET" STEAM_GUARD_CODE=ZZZZZ FAKE_LOGIN=badcode
check "bad code => hold, newest email"  has "NEWEST email" /run/dayz/steam/banner
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=timeout
check "approval timeout => hold"        has "NOT APPROVED IN TIME" /run/dayz/steam/banner

echo "9. installed server + expired token + no password => start the installed build"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok
rm -f "$T/home/fake-token" "$T/home/.dayz-last-account-login"; new_container
run FAKE_REMOTE_BUILD=3000
check "status paused"                   is "$(status)" paused
check "UPDATES PAUSED banner"           has "UPDATES PAUSED" "$T/out"

echo "10. steamcmd exits 0 but failed => not trusted, retried, then hold"
reset_all; run DAYZ_BRANCH=experimental STEAM_USERNAME=anonymous FAKE_UPDATE=lies
check "status hold"                     is "$(status)" hold
check "three attempts"                  is "$(count update)" 3

echo "11. no subscription"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok FAKE_UPDATE=nosub
check "status hold"                     is "$(status)" hold
check "banner explains"                 has "NO SUBSCRIPTION" /run/dayz/steam/banner

echo "12. Steam unreachable with an installed server => start it, no login"
reset_all; run DAYZ_BRANCH=experimental STEAM_USERNAME=anonymous
run DAYZ_BRANCH=experimental STEAM_USERNAME=anonymous FAKE_REMOTE_BUILD=offline
check "status ok"                       is "$(status)" ok
check "no update attempted"             is "$(count update)" 0

echo "13. crash-loop guard: a second account login within 10 minutes is skipped"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok
run FAKE_REMOTE_BUILD=4000
check "status paused, Steam not contacted" is "$(status)$(count update)" paused0

echo "15. account name that is part of the strings being parsed (\"user\")"
reset_all; run STEAM_USERNAME=user STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok
check "login success still recognised"  is "$(status)" ok
check "name redacted in the log"        has "<steam-account>" "$T/out"

echo "16. installed server, stale token rejected as 'Invalid Password' => falls through to the password login"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok
rm -f "$T/home/fake-token-fresh" "$T/home/.dayz-last-account-login"; new_container
run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok FAKE_REMOTE_BUILD=5000 FAKE_TOKEN_REJECT=1
check "status ok"                       is "$(status)" ok
check "exactly one password login"      is "$(count login)" 1

echo "17. installed server: a human retry right after a failed attempt is not refused"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok
rm -f "$T/home/fake-token" "$T/home/fake-token-fresh"; new_container
run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=guard FAKE_REMOTE_BUILD=6000      # emails a code
check "first attempt: paused, code requested" has "STEAM GUARD EMAIL CODE NEEDED" "$T/out"
new_container                                                              # .env edited + up -d, seconds later
run STEAM_PASSWORD="$SECRET" STEAM_GUARD_CODE=AB12C FAKE_LOGIN=ok FAKE_REMOTE_BUILD=6000
check "retry with the code succeeds"    is "$(status)$(count login)" ok1
check "not refused as 'too recent'"     has_not "LOGIN SKIPPED" "$T/out"

echo "18. rate limit also blocks token logins"
reset_all; run STEAM_PASSWORD="$SECRET" FAKE_LOGIN=ok
date -d '+1 hour' +%s > "$T/home/.dayz-rate-limited-until"; rm -f "$T/home/.dayz-last-account-login"; new_container
run FAKE_REMOTE_BUILD=7000
check "paused, Steam not contacted"     is "$(status)$(count update)$(count login)" paused00

if [[ ${RUN_NETWORK_TESTS:-0} == 1 ]]; then
  echo "14. account without DayZ: missions come from Bohemia's GitHub repository (network)"
  reset_all; run DAYZ_BRANCH=experimental STEAM_USERNAME=anonymous FAKE_NO_MISSIONS=1
  check "status ok"                     is "$(status)" ok
  check "chernarus mission present"     test -f /dayz/server/experimental/mpmissions/dayzOffline.chernarusplus/init.c
  check "livonia mission present"       test -d /dayz/server/experimental/mpmissions/dayzOffline.enoch
  check "source recorded"               test -f /dayz/server/experimental/mpmissions/.missions-source
fi

# The status sidecar reads state/status.json and nothing else can tell it what the supervisor
# is doing, so a single unescaped character in here blinds the whole status page while the
# server keeps running happily. These checks parse the file the way the sidecar does.
echo "15. the status file published for the status sidecar"
(
  rm -rf /dayz/data/state
  LOG_TAG=test
  . /opt/dayz/lib/common.sh
  mkdir -p "$DATA_ROOT/state"
  status_set schema 1
  status_set state RUNNING
  status_set hold_title "$(printf 'quote " backslash \\ tab \t end')"
  status_set hold_lines "$(printf 'first line\nsecond line')"
  status_set control "$(printf 'bell \a and CR \r here')"
  status_raw server_pid 4242
  status_raw updates_paused false
  status_raw restart_due_epoch null
  status_publish
) > /dev/null 2>&1
# The image ships no JSON parser, so the escaping is checked byte for byte. That is the part
# that actually broke once: a replacement text written as \\n rather than "${bs}n" puts a bare
# "n" in the file, which still looks plausible in a log and is wrong for every reader.
check "status.json was written"        test -s /dayz/data/state/status.json
check "it is world readable"           test -r /dayz/data/state/status.json
check "quotes are escaped"             grep -qF 'quote \"' /dayz/data/state/status.json
check "backslash is doubled"           grep -qF 'backslash \\ tab' /dayz/data/state/status.json
check "tab became a two-character \t"  grep -qF 'tab \t end' /dayz/data/state/status.json
check "newline became a two-character \n" grep -qF 'first line\nsecond line' /dayz/data/state/status.json
check "carriage return became \r"      grep -qF 'CR \r here' /dayz/data/state/status.json
check "other control bytes are dropped" test -z "$(tr -d '\12\40-\176' < /dayz/data/state/status.json)"
check "numbers are not quoted"         grep -qF '"server_pid":4242' /dayz/data/state/status.json
check "booleans are not quoted"        grep -qF '"updates_paused":false' /dayz/data/state/status.json
check "null is not quoted"             grep -qF '"restart_due_epoch":null' /dayz/data/state/status.json
rm -rf /dayz/data/state

echo
echo "passed: $PASS   failed: $FAIL"
(( FAIL == 0 ))
