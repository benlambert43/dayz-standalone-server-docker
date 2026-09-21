// Every knob of the status page, all overridable from .env through docker-compose.yml.
// The defaults are the ones that fit this repository's compose stack, so in practice none
// of them has to be set.
import { int, num } from './util.js';

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v)));

export const cfg = {
  // http
  port: int(process.env.STATUS_PORT, 8093),
  bind: process.env.STATUS_BIND || '0.0.0.0',           // inside the container; the host side
                                                        // is bound to 127.0.0.1 by compose
  // the game server
  dayzHost: process.env.DAYZ_HOST || 'dayz',
  queryPort: int(process.env.DAYZ_QUERY_PORT, 27016),
  gamePort: int(process.env.DAYZ_GAME_PORT, 2302),
  queryTimeoutMs: int(process.env.STATUS_QUERY_TIMEOUT_MS, 2500),

  // Second probe path: the same query, but sent the long way round through the port the
  // Docker host publishes. That is the only way to see the known Docker Desktop bug where
  // a published UDP port silently stops forwarding while the container stays healthy.
  hostProbe: process.env.STATUS_HOST_PROBE || 'host.docker.internal',
  hostProbeEnabled: bool(process.env.STATUS_HOST_PROBE_ENABLED, true),

  // volumes
  dataRoot: process.env.DAYZ_DATA_ROOT || '/dayz/data',
  serverRoot: process.env.DAYZ_SERVER_ROOT || '/dayz/server',
  configDir: process.env.DAYZ_CONFIG_DIR || '/config',
  stateDir: process.env.STATUS_STATE_DIR || '/var/lib/dayz-status',

  // docker
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  composeProject: process.env.COMPOSE_PROJECT_NAME || 'dayz',
  dayzService: process.env.DAYZ_SERVICE || 'dayz',
  statusService: process.env.STATUS_SERVICE || 'status',

  // sampling
  pollSeconds: Math.max(5, int(process.env.STATUS_POLL_SECONDS, 20)),
  historyDays: Math.max(1, int(process.env.STATUS_HISTORY_DAYS, 14)),
  admTailBytes: int(process.env.STATUS_ADM_TAIL_BYTES, 3 * 1024 * 1024),
  rptTailBytes: int(process.env.STATUS_RPT_TAIL_BYTES, 1024 * 1024),

  // presentation
  redactIds: bool(process.env.STATUS_REDACT_IDS, false),
  dayStartHour: num(process.env.STATUS_DAY_START_HOUR, 5),
  dayEndHour: num(process.env.STATUS_DAY_END_HOUR, 19),
  worldSize: int(process.env.STATUS_WORLD_SIZE, 0),     // 0 = work it out
  title: process.env.STATUS_TITLE || 'DayZ Server Status',

  // opt-in, because it is the only outbound request this container ever makes
  steamBuildCheck: bool(process.env.STATUS_CHECK_STEAM_BUILD, false),
  steamBuildUrl: process.env.STATUS_STEAM_BUILD_URL || 'https://api.steamcmd.net/v1/info/',

  // fallbacks used only until the game container has published its own status file
  branchFallback: (process.env.DAYZ_BRANCH || 'stable').toLowerCase(),
};

export const APP_IDS = { stable: 223350, experimental: 1042420 };
