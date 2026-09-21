#!/bin/bash
# Container healthcheck: state RUNNING, server process alive, game port bound, and the Steam
# query port answers an A2S_INFO request. Informational only - Docker never restarts a
# container because of its health; run-server.sh does the supervising.
. /opt/dayz/lib/common.sh

state=unknown
[[ -r $RUN_DIR/state ]] && read -r state < "$RUN_DIR/state"
if [[ $state != RUNNING ]]; then
  echo "state: $state"
  exit 1
fi

pid=""
[[ -r $RUN_DIR/server/pid ]] && read -r pid < "$RUN_DIR/server/pid"
if [[ -z $pid ]] || ! kill -0 "$pid" 2>/dev/null; then
  echo "server process is not running"
  exit 1
fi
if ! udp_port_bound "$GAME_PORT"; then
  echo "game port $GAME_PORT/udp is not bound"
  exit 1
fi
if ! a2s_alive 127.0.0.1 "$STEAM_QUERY_PORT"; then
  echo "no answer to a Steam query on port $STEAM_QUERY_PORT/udp"
  exit 1
fi
echo "ok"
