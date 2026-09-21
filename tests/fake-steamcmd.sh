#!/bin/bash
# Stand-in for steamcmd. Prints the strings the real tool prints (collected during research
# and from live anonymous runs) and mimics its exit codes, so that the login/update state
# machine in docker/steam-update.sh can be tested without a Steam account.
#
# Behaviour is chosen through environment variables:
#   FAKE_REMOTE_BUILD   build id reported by the anonymous app-info call        (default 1000)
#   FAKE_UPDATE         ok | nosub | network | lies        result of app_update (default ok)
#   FAKE_LOGIN          ok | mobile | guard | badcode | invalid | ratelimit | timeout
#   FAKE_NO_MISSIONS    1 = install without mpmissions (account that does not own DayZ)
#   FAKE_TOKEN_REJECT   1 = the cached token is rejected with "Invalid Password" until a new login
#   FAKE_CALLS          file that receives one line per call: appinfo | update | login
args="$*"
calls=${FAKE_CALLS:-/tmp/fake-steamcmd.calls}
token=$HOME/fake-token

echo "Steam Console Client (c) Valve Corporation - version 1788292693"
echo "Loading Steam API...OK"

# ---- anonymous app info ------------------------------------------------------
if [[ $args == *"+app_info_print"* ]]; then
  echo appinfo >> "$calls"
  [[ ${FAKE_REMOTE_BUILD:-1000} == offline ]] && { echo "FAILED (No Connection)"; exit 5; }
  cat <<EOF
Connecting anonymously to Steam Public...OK
AppID : 223350, change number : 1/1
"223350"
{
	"depots"
	{
		"branches"
		{
			"public"
			{
				"buildid"		"${FAKE_REMOTE_BUILD:-1000}"
				"timeupdated"		"1786528820"
			}
			"experimental_public"
			{
				"buildid"		"3889697"
			}
		}
	}
}
EOF
  exit 0
fi

# ---- password login (runscript) ----------------------------------------------
if [[ $args == *"+runscript"* ]]; then
  echo login >> "$calls"
  script=${args##*+runscript }
  # The real tool may echo script lines; do the same so the redaction can be tested.
  while IFS= read -r l; do echo "$l"; done < "$script"
  echo "Logging in user '${STEAM_USERNAME}' [U:1:0] to Steam Public..."
  case ${FAKE_LOGIN:-ok} in
    ok)      echo "OK"; echo "Waiting for client config...OK"; echo "Waiting for user info...OK"; : > "$token"; : > "$token-fresh"; exit 0 ;;
    mobile)  echo "This account is protected by a Steam Guard mobile authenticator."
             echo "Please confirm the login in the Steam Mobile app on your phone."
             echo "Waiting for confirmation..."; echo "Waiting for confirmation...OK"
             echo "Waiting for client config...OK"; echo "Waiting for user info...OK"; : > "$token"; exit 0 ;;
    # Verbatim from a real mobile-authenticator login: steamcmd printed a progress message
    # into the line it was on, so the "OK" no longer follows "Waiting for user info...".
    mobile_noisy)
             echo "This account is protected by a Steam Guard mobile authenticator."
             echo "Please confirm the login in the Steam Mobile app on your phone."
             echo "Waiting for confirmation..."; echo "Waiting for confirmation...OK"
             echo "Waiting for client config...OK"
             echo "Waiting for user info...Waiting for compat in post-logon took: 0.098765sOK"
             : > "$token"; exit 0 ;;
    # A login whose outcome cannot be read at all: no known success and no known error string.
    # It worked, so the token is there for the update retry to find.
    silent)  : > "$token"; exit 0 ;;
    # The same silence, but the login really did fail, so no token appears.
    silent_fail) exit 0 ;;
    guard)   printf 'This computer has not been authenticated for your account using Steam Guard.\nSteam Guard code:ERROR (Account Logon Denied)\n'; exit 5 ;;
    badcode) echo "FAILED (Invalid Login Auth Code)"; exit 5 ;;
    invalid) echo "FAILED (Invalid Password)"; exit 5 ;;
    ratelimit) echo "FAILED (Rate Limit Exceeded)"; exit 5 ;;
    timeout) echo "Please confirm the login in the Steam Mobile app on your phone."
             echo "Waiting for confirmation..."; echo "ERROR (Timed out waiting for confirmation)"; exit 5 ;;
  esac
  exit 5
fi

# ---- cached login + app_update ------------------------------------------------
echo update >> "$calls"
dir=${args##*+force_install_dir }; dir=${dir%% *}
app=${args##*+app_update };        app=${app%% *}
if [[ $args == *"+login anonymous"* ]]; then
  echo "Connecting anonymously to Steam Public...OK"
elif [[ -e $token && ${FAKE_TOKEN_REJECT:-0} == 1 && ! -e $token-fresh ]]; then
  # A stale token that Steam rejects with the same words it uses for a wrong password.
  echo "Logging in using cached credentials."
  echo "FAILED (Invalid Password)"
  exit 5
elif [[ -e $token ]]; then
  echo "Logging in using cached credentials."
  echo "Logging in user '${STEAM_USERNAME}' [U:1:0] to Steam Public...OK"
else
  echo "Cached credentials not found."
  echo "FAILED (No cached credentials and @NoPromptForPassword is set)"
  exit 5
fi
echo "Waiting for client config...OK"
echo "Waiting for user info...OK"

case ${FAKE_UPDATE:-ok} in
  nosub)   echo "ERROR! Failed to install app '$app' (No subscription)"; exit 8 ;;
  network) echo "ERROR! Failed to install app '$app' (No Connection)"; exit 8 ;;
  lies)    echo "ERROR! Failed to install app '$app' (Disk write failure)"; exit 0 ;;   # exit 0 on failure, like the real tool
esac

mkdir -p "$dir/steamapps" "$dir/mpmissions"
printf '#!/bin/sh\nexit 0\n' > "$dir/DayZServer"; chmod 0755 "$dir/DayZServer"
[[ ${FAKE_NO_MISSIONS:-0} == 1 ]] || mkdir -p "$dir/mpmissions/dayzOffline.chernarusplus/db"
cat > "$dir/steamapps/appmanifest_$app.acf" <<EOF
"AppState"
{
	"appid"		"$app"
	"StateFlags"		"4"
	"buildid"		"${FAKE_REMOTE_BUILD:-1000}"
}
EOF
echo " Update state (0x61) downloading, progress: 50.00 (1 / 2)"
echo "Success! App '$app' fully installed."
exit 0
