// The health model.
//
// Docker's own healthcheck answers one question: "would a Steam query be answered right
// now?". That is the right question for a container, but it is a poor summary for an
// operator, because a server can be perfectly reachable and still be about to fall over -
// out of disk, crash-looping between starts, throwing script errors, or reachable from
// inside Docker but no longer from the host. Each of those gets its own check here.
//
// Three levels only: ok, warn (worth looking at, nothing is broken yet) and fail (players
// are affected or about to be). "unknown" means the source could not be read, which is
// never treated as a failure of the server itself.
const OK = 'ok', WARN = 'warn', FAIL = 'fail', UNKNOWN = 'unknown';
const ago = (ms) => (ms ? Math.round((Date.now() - ms) / 1000) : null);

// A stack that has never started a server is not a broken stack. Several checks would
// otherwise report a first `docker-compose up -d` as a pile of failures while Steam is
// still downloading the game.
const neverRan = (s) => !s.supervisor || !s.supervisor.state;

function check(id, group, title, fn) { return { id, group, title, fn }; }

export const CHECKS = [
  // ------------------------------------------------------------- container --
  check('docker.socket', 'Container', 'Docker API reachable', (s) =>
    s.docker.ok
      ? { status: OK, detail: `Docker ${s.docker.version?.version} (API ${s.docker.version?.apiVersion})` }
      : { status: UNKNOWN, detail: s.docker.error, hint: 'Mount /var/run/docker.sock into the status container and give it a group that may read it (DOCKER_GID in .env).' }),

  check('container.running', 'Container', 'Game container running', (s) => {
    if (!s.docker.ok) return { status: UNKNOWN, detail: 'Docker API not reachable' };
    const c = s.docker.dayz;
    if (!c) return { status: FAIL, detail: 'no container of this compose project matched the dayz service' };
    if (c.running) return { status: OK, detail: `${c.name} up for ${ago(Date.parse(c.startedAt))} s` };
    return { status: FAIL, detail: `${c.name} is ${c.status} (exit code ${c.exitCode})`, hint: 'docker-compose up -d' };
  }),

  check('container.health', 'Container', "Docker's own healthcheck", (s) => {
    const h = s.docker.dayz?.health;
    if (!h) return { status: UNKNOWN, detail: 'no healthcheck reported' };
    const last = h.log?.[h.log.length - 1];
    const detail = `${h.status}${last ? ` - ${last.output || `exit ${last.exitCode}`}` : ''}`;
    if (h.status === 'healthy') return { status: OK, detail };
    if (h.status === 'starting') return { status: WARN, detail: `${detail} (first start can take an hour while Steam downloads)` };
    return { status: FAIL, detail, hint: 'docker-compose logs -f' };
  }),

  check('container.restarts', 'Container', 'Restart count', (s) => {
    const c = s.docker.dayz;
    if (!c) return { status: UNKNOWN, detail: 'container not inspected' };
    if (c.restartCount === 0) return { status: OK, detail: 'never restarted by Docker' };
    if (c.restartCount < 5) return { status: OK, detail: `${c.restartCount} restarts (scheduled restarts count too)` };
    return { status: WARN, detail: `${c.restartCount} restarts`, hint: 'Look for CRASH BACK-OFF in the log.' };
  }),

  check('container.oom', 'Container', 'Not killed for memory', (s) => {
    const c = s.docker.dayz;
    if (!c) return { status: UNKNOWN, detail: 'container not inspected' };
    return c.oomKilled
      ? { status: FAIL, detail: 'the last run was killed by the out-of-memory killer', hint: 'Give Docker Desktop more RAM (Settings, Resources).' }
      : { status: OK, detail: 'no out-of-memory kill recorded' };
  }),

  // ----------------------------------------------------------- game server --
  check('supervisor.state', 'Game server', 'Supervisor state', (s) => {
    const st = s.supervisor || {};
    if (!st.state) return { status: UNKNOWN, detail: 'the game container has not published a state file yet' };
    if (!s.supervisorFresh) return { status: WARN, detail: `last update ${ago(st.updated_epoch * 1000)} s ago (state: ${st.state})`, hint: 'The supervisor writes this every 15 s while it runs.' };
    if (st.state === 'RUNNING') return { status: OK, detail: 'RUNNING' };
    if (st.state === 'HOLD') return { status: FAIL, detail: `HOLD - ${st.hold_title || 'a setting needs fixing'}`, hint: st.hold_lines || 'See the banner in docker-compose logs.' };
    if (['STARTING', 'PREPARING'].includes(st.state)) return { status: WARN, detail: `${st.state} (not accepting players yet)` };
    return { status: WARN, detail: st.state };
  }),

  check('server.process', 'Game server', 'DayZServer process', (s) => {
    if (neverRan(s)) return { status: UNKNOWN, detail: 'the server has not run yet' };
    const st = s.supervisor;
    if (st.server_pid) return { status: OK, detail: `pid ${st.server_pid}` };
    if (st.state === 'RUNNING') return { status: WARN, detail: 'state is RUNNING but no pid was published' };
    return { status: st.state === 'HOLD' ? FAIL : WARN, detail: 'no server process' };
  }),

  check('server.port', 'Game server', 'Game port bound', (s) => {
    if (neverRan(s)) return { status: UNKNOWN, detail: 'the server has not run yet' };
    const st = s.supervisor;
    if (st.port_bound) return { status: OK, detail: `UDP ${st.game_port ?? 2302} is bound inside the container` };
    if (st.state === 'STARTING' || st.state === 'PREPARING') return { status: WARN, detail: 'still starting' };
    return { status: FAIL, detail: 'the server has not bound its game port' };
  }),

  check('server.mission', 'Game server', 'Mission loaded', (s) => {
    if (neverRan(s)) return { status: UNKNOWN, detail: 'the server has not run yet' };
    const st = s.supervisor;
    if (st.mission_ready) return { status: OK, detail: `${st.active_mission || 'mission'} ready${st.mission_ready_seconds ? ` after ${st.mission_ready_seconds} s` : ''}` };
    if (st.port_bound) return { status: WARN, detail: 'port is bound, mission still loading' };
    return { status: WARN, detail: 'not loaded yet' };
  }),

  // Found the hard way: the engine loads sakhal/addons only if the server's user may read AND
  // write the sakhal/ folder, and skips it without a log line otherwise. Every client loads
  // that folder on every map, DLC owner or not, and is then kicked with a message that blames
  // the player's own game. The list of loaded addons is the only place it shows.
  check('server.gameData', 'Game server', 'Game data folders loaded', (s) => {
    if (neverRan(s)) return { status: UNKNOWN, detail: 'the server has not run yet' };
    if (!s.rpt) return { status: UNKNOWN, detail: 'no .RPT file found yet' };
    const a = s.rpt.addons;
    const installed = s.build?.dataFolders;
    if (!a) return { status: UNKNOWN, detail: 'the list of loaded addons is not in the part of the log that was read' };
    if (!installed) return { status: UNKNOWN, detail: 'install folder not readable' };
    const skipped = installed.filter((f) => !a.folders.includes(f));
    if (skipped.length && !a.complete) return { status: UNKNOWN, detail: `the list of loaded addons is cut off after ${a.count} entries` };
    if (skipped.length) {
      return {
        status: FAIL,
        detail: `${skipped.map((f) => `${f}/`).join(', ')} is installed but the engine did not load it (${a.count} addons, none from ${skipped[0]}/addons)`,
        hint: 'Every client loads that folder on every map, DLC or not, so every player is kicked with "Missing PBO from game files". '
          + 'The engine skips it silently unless the server\'s user may write to the folder. git pull, then docker-compose up -d.',
      };
    }
    if (!installed.length) return { status: WARN, detail: `${a.count} addons, but this install has no sakhal/addons folder`, hint: 'Current DayZ clients all load it, so they would be kicked. Set VALIDATE_ON_START=true once.' };
    return { status: OK, detail: `${a.count} addons, including ${installed.map((f) => `${f}/addons`).join(', ')}` };
  }),

  check('server.updates', 'Game server', 'Steam updates', (s) => {
    if (neverRan(s)) return { status: UNKNOWN, detail: 'the server has not run yet' };
    const st = s.supervisor;
    if (st.updates_paused) return { status: WARN, detail: 'UPDATES PAUSED - running the installed build', hint: 'Players cannot join after a DayZ patch until this is fixed. See the banner in the log.' };
    if (st.steam_status === 'ok' || !st.steam_status) return { status: OK, detail: 'up to date at the last start' };
    return { status: WARN, detail: `steam phase: ${st.steam_status}` };
  }),

  check('server.backoff', 'Game server', 'Crash back-off', (s) => {
    const n = s.crashBackoff?.startsSinceHealthy ?? null;
    if (n === null) return { status: UNKNOWN, detail: neverRan(s) ? 'the server has not run yet' : 'counter not readable' };
    if (n === 0) return { status: OK, detail: 'no failed starts since the last healthy run' };
    if (n < 3) return { status: WARN, detail: `${n} start(s) since the last healthy run` };
    return { status: FAIL, detail: `${n} short-lived starts in a row - the container is backing off`, hint: 'The reason is in the log and in the profiles folder.' };
  }),

  // --------------------------------------------------------------- network --
  check('query.info', 'Network', 'Steam query answers (inside Docker)', (s) => {
    const q = s.query?.info;
    if (q?.ok) return { status: OK, detail: `A2S_INFO in ${q.rttMs} ms - "${q.name}"` };
    if (neverRan(s)) return { status: UNKNOWN, detail: 'the server has not run yet' };
    return { status: FAIL, detail: q?.error || 'no answer', hint: 'The launcher and the server browser use exactly this query.' };
  }),

  check('query.players', 'Network', 'Player list query', (s) => {
    const p = s.query.players;
    if (!p?.ok) return { status: WARN, detail: p?.error || 'no answer' };
    if (p.count && !p.named) return { status: WARN, detail: `${p.count} slots reported but no names - this DayZ build hides them`, hint: 'The admin log is used instead, so the Players tab still fills.' };
    return { status: OK, detail: `${p.count} player(s), ${p.named} with a name` };
  }),

  check('query.rules', 'Network', 'Rules query', (s) => {
    const r = s.query.rules;
    if (!r?.ok) return { status: WARN, detail: r?.error || 'no answer' };
    return { status: OK, detail: `${r.count} rules${r.bohemia?.mods?.length ? `, ${r.bohemia.mods.length} mods advertised` : ''}` };
  }),

  // This is NOT a network measurement, and it is not what a connected player experiences.
  // Measured on this stack: a bare UDP round trip from the Windows host through the published
  // port into a container and back is 1.2 ms, while DayZ answers Steam queries on a fixed
  // ~50 ms cadence of its own - unchanged with -limitFPS at 60, at 120 and removed entirely.
  // The exchange is two round trips (challenge, then query), so a perfectly healthy server
  // sits between 50 and 100 ms and the server browser shows about 90. The old 50 ms budget
  // could never be met, which left the whole page reading "warn" forever. 300 ms is three
  // exchanges' worth of jitter; past 800 ms the host really is struggling.
  check('query.latency', 'Network', 'Query latency', (s) => {
    const rtt = s.query.info?.ok ? s.query.info.rttMs : null;
    const floor = "DayZ answers queries on a ~50 ms tick and the browser needs two round trips, "
      + 'so 50-100 ms is normal here. It is the cost of the query, not of the network, and not '
      + 'the latency a connected player sees.';
    if (rtt === null) return { status: UNKNOWN, detail: 'no answer to time' };
    if (rtt < 300) return { status: OK, detail: `${rtt} ms for the challenge and the query`, hint: floor };
    if (rtt < 800) return { status: WARN, detail: `${rtt} ms - slower than this exchange should be`, hint: floor };
    return { status: FAIL, detail: `${rtt} ms`, hint: 'A loaded host or a saturated WSL2 VM.' };
  }),

  // The single most valuable check on Docker Desktop: the container can look perfectly
  // healthy while the Windows side has quietly stopped forwarding the published UDP port,
  // and then nobody can join. This is the same query taken the long way round.
  check('query.host', 'Network', 'Published port forwards (host side)', (s) => {
    const h = s.hostQuery;
    if (!h || h.skipped) return { status: UNKNOWN, detail: 'host probe disabled (STATUS_HOST_PROBE_ENABLED=false)' };
    if (h.ok) return { status: OK, detail: `answered through the host in ${h.rttMs} ms` };
    if (!s.query.info?.ok) return { status: UNKNOWN, detail: 'the server itself is not answering, so this tells us nothing' };
    return {
      status: FAIL,
      detail: `the server answers inside Docker but not through the host: ${h.error}`,
      hint: 'This is the known Docker Desktop UDP forwarding bug. docker-compose restart fixes it.',
    };
  }),

  check('query.slots', 'Network', 'Free player slots', (s) => {
    const { count, max } = s.players;
    if (count === null || !max) return { status: UNKNOWN, detail: 'player count unknown' };
    const pct = (count / max) * 100;
    if (pct < 90) return { status: OK, detail: `${count}/${max}` };
    if (pct < 100) return { status: WARN, detail: `${count}/${max} - nearly full` };
    return { status: WARN, detail: `${count}/${max} - full, new players go into the login queue` };
  }),

  // ------------------------------------------------------- world and disk ---
  check('world.save', 'World', 'World saved recently', (s) => {
    const last = s.storage?.lastSave;
    if (!last) return { status: UNKNOWN, detail: 'no persistence files yet (a brand new world has none until the first save)' };
    const mins = Math.round((Date.now() - last) / 60000);
    if (mins < 30) return { status: OK, detail: `last write ${mins} min ago (${s.storage.lastSaveFile})` };
    if (mins < 180) return { status: OK, detail: `last write ${mins} min ago - normal on an empty server` };
    return { status: WARN, detail: `last write ${mins} min ago`, hint: 'Expected while nobody plays; worth a look if players are online.' };
  }),

  check('world.size', 'World', 'Persistence present', (s) => {
    const st = s.storage;
    if (!st) return { status: UNKNOWN, detail: 'storage folder not readable' };
    if (!st.fileCount && neverRan(s)) return { status: UNKNOWN, detail: 'the server has not run yet' };
    if (!st.fileCount) return { status: WARN, detail: 'no persistence files - the world is brand new or was wiped' };
    return { status: OK, detail: `${st.fileCount} files, ${Math.round(st.bytes / 1024)} KB` };
  }),

  check('world.rescued', 'World', 'No rescued world folders', (s) => {
    const n = s.storage?.rescued?.length || 0;
    return n
      ? { status: WARN, detail: `${n} rescued-storage-* folder(s) in the data volume`, hint: 'The server ignored -storage at least once. Nothing was deleted; see the banner in the log.' }
      : { status: OK, detail: 'none' };
  }),

  check('disk.data', 'World', 'Disk space for the world', (s) => diskCheck(s.storage?.dataDisk, 'data volume')),
  check('disk.server', 'World', 'Disk space for the game files', (s) => diskCheck(s.storage?.serverDisk, 'server volume')),

  // -------------------------------------------------------------- resources --
  check('res.cpu', 'Resources', 'CPU use', (s) => {
    const st = s.docker.stats;
    if (!st) return { status: UNKNOWN, detail: 'no stats (Docker API not reachable or container stopped)' };
    const share = st.cpuPctOfHost ?? st.cpuPct / (st.cpus || 1);
    const detail = `${st.cpuPct}% of one core, ${share}% of the machine (${st.cpus} cores)`;
    if (share < 60) return { status: OK, detail };
    if (share < 85) return { status: WARN, detail, hint: 'LIMIT_FPS in .env caps the simulation rate.' };
    return { status: FAIL, detail, hint: 'The host has almost nothing left; players will feel it.' };
  }),

  check('res.mem', 'Resources', 'Memory use', (s) => {
    const st = s.docker.stats;
    if (!st) return { status: UNKNOWN, detail: 'no stats' };
    const mb = Math.round(st.memUsed / 1048576);
    if (st.memPct === null) return { status: OK, detail: `${mb} MB (no limit set)` };
    if (st.memPct < 80) return { status: OK, detail: `${mb} MB, ${st.memPct}% of the limit` };
    if (st.memPct < 95) return { status: WARN, detail: `${mb} MB, ${st.memPct}% of the limit` };
    return { status: FAIL, detail: `${mb} MB, ${st.memPct}% of the limit`, hint: 'An out-of-memory kill loses the unsaved world state.' };
  }),

  // ------------------------------------------------------- logs and crashes --
  check('logs.fresh', 'Logs', 'Server is still writing logs', (s) => {
    const m = s.rpt?.mtime;
    if (!m) return { status: UNKNOWN, detail: 'no .RPT file found yet' };
    const mins = Math.round((Date.now() - m) / 60000);
    if (mins < 10) return { status: OK, detail: `engine log written ${mins} min ago` };
    if (mins < 60) return { status: OK, detail: `engine log written ${mins} min ago (an idle server writes little)` };
    if (s.supervisor?.state === 'RUNNING') return { status: WARN, detail: `engine log untouched for ${mins} min` };
    return { status: OK, detail: `engine log written ${mins} min ago` };
  }),

  check('logs.scriptErrors', 'Logs', 'No script errors this run', (s) => {
    const n = s.rpt?.counts?.scriptError || 0;
    if (!s.rpt) return { status: UNKNOWN, detail: 'no .RPT file' };
    if (!n) return { status: OK, detail: 'none in the part of the log that was read' };
    return { status: WARN, detail: `${n} script error line(s)`, hint: 'Usually a mission override; see the Logs tab.' };
  }),

  check('logs.dataKicks', 'Logs', 'No players kicked for server data', (s) => {
    if (!s.rpt) return { status: UNKNOWN, detail: 'no .RPT file' };
    const k = s.rpt.dataKicks;
    if (!k?.count) return { status: OK, detail: 'none in the part of the log that was read' };
    return {
      status: WARN,
      detail: `${k.count} kick(s) with reason 118 this run: "${k.last}"`,
      hint: 'The player loaded a game file that this server did not. Their game is fine; see "Game data folders loaded" above.',
    };
  }),

  check('logs.crashDumps', 'Logs', 'No recent crash dumps', (s) => {
    const newest = s.logs?.newestCrashDump;
    const n = s.logs?.crashDumps || 0;
    if (!n) return { status: OK, detail: 'none' };
    const hours = Math.round((Date.now() - newest) / 3600000);
    if (hours < 24) return { status: FAIL, detail: `${n} dump(s), newest ${hours} h ago`, hint: 'The server crashed. The .RPT next to the dump says what it was doing.' };
    return { status: WARN, detail: `${n} dump(s), newest ${hours} h ago (kept for post-mortems)` };
  }),

  // ----------------------------------------------------------- config sanity -
  check('cfg.present', 'Configuration', 'Server config generated', (s, x) => {
    const c = x.config;
    if (!c?.ok && neverRan(s)) return { status: UNKNOWN, detail: 'written at the first start, which has not happened yet' };
    if (!c?.ok) return { status: FAIL, detail: c?.error || 'serverDZ.cfg missing' };
    return { status: OK, detail: `${c.source}, written ${Math.round((Date.now() - c.mtime) / 60000)} min ago` };
  }),

  check('cfg.queryPort', 'Configuration', 'Query port matches the published port', (s, x) => {
    const want = String(s.supervisor?.query_port ?? 27016);
    const have = x.config?.values?.steamQueryPort;
    if (!have) return { status: UNKNOWN, detail: 'not set in the config' };
    return have === want
      ? { status: OK, detail: `steamQueryPort = ${have}` }
      : { status: FAIL, detail: `config says ${have}, the container publishes ${want}`, hint: 'The server would not be listed in the browser.' };
  }),

  check('cfg.template', 'Configuration', 'Config points at the live mission', (s, x) => {
    const want = s.supervisor?.active_mission;
    const have = x.config?.values?.template;
    if (!want || !have) return { status: UNKNOWN, detail: 'mission template unknown' };
    return have === want
      ? { status: OK, detail: `template = ${have}` }
      : { status: FAIL, detail: `config loads ${have} but the container prepared ${want}` };
  }),

  check('cfg.signatures', 'Configuration', 'Signature verification on', (s, x) => {
    const v = x.config?.values?.verifySignatures;
    if (v === null || v === undefined) return { status: UNKNOWN, detail: 'not set' };
    return v === '2'
      ? { status: OK, detail: 'verifySignatures = 2' }
      : { status: WARN, detail: `verifySignatures = ${v}`, hint: 'Anything below 2 lets modified clients connect.' };
  }),

  check('cfg.maxPlayers', 'Configuration', 'Slot count agrees with the server', (s, x) => {
    const cfgMax = Number(x.config?.values?.maxPlayers);
    const queryMax = s.players.max;
    if (!cfgMax || !queryMax) return { status: UNKNOWN, detail: 'unknown' };
    return cfgMax === queryMax
      ? { status: OK, detail: `${cfgMax} slots` }
      : { status: WARN, detail: `config says ${cfgMax}, the running server reports ${queryMax}`, hint: 'The server is still running an older config; restart to apply.' };
  }),

  check('cfg.admin', 'Configuration', 'Admin login', (s, x) => {
    const set = x.config?.values?.adminPasswordSet;
    if (set === undefined) return { status: UNKNOWN, detail: 'unknown' };
    return set
      ? { status: OK, detail: 'passwordAdmin is set (#login works in game)' }
      : { status: WARN, detail: 'no admin password - #login is disabled', hint: 'Set ADMIN_PASSWORD in .env if you want in-game admin commands.' };
  }),

  check('cfg.overrides', 'Configuration', 'Mission overrides applied', (s, x) => {
    const list = x.overrides || [];
    if (!list.length) return { status: OK, detail: 'none configured' };
    const missing = list.filter((o) => !o.applied);
    return missing.length
      ? { status: WARN, detail: `${list.length - missing.length}/${list.length} applied`, hint: `Not found in the live mission: ${missing.slice(0, 3).map((m) => m.rel).join(', ')}` }
      : { status: OK, detail: `${list.length} file(s) applied to the working copy` };
  }),

  check('build.current', 'Configuration', 'Installed build', (s) => {
    const m = s.build?.manifest;
    if (!m) return { status: UNKNOWN, detail: 'no Steam app manifest' };
    if (!m.installed) return { status: FAIL, detail: `StateFlags ${m.stateFlags} - the install is incomplete`, hint: 'Set VALIDATE_ON_START=true once.' };
    const v = s.build?.rpt?.version || s.build?.queryVersion;
    return { status: OK, detail: `build ${m.buildId}${v ? `, version ${v}` : ''}${m.lastUpdated ? `, downloaded ${new Date(m.lastUpdated * 1000).toISOString().slice(0, 10)}` : ''}` };
  }),
];

function diskCheck(d, label) {
  if (!d) return { status: UNKNOWN, detail: `${label}: not readable` };
  const freeGb = Math.round((d.free / 1073741824) * 10) / 10;
  const detail = `${freeGb} GB free of ${Math.round(d.total / 1073741824)} GB (${d.usedPct}% used)`;
  if (d.free > 5 * 1073741824) return { status: OK, detail };
  if (d.free > 1073741824) return { status: WARN, detail, hint: 'A DayZ update needs a few gigabytes.' };
  return { status: FAIL, detail, hint: 'The world cannot be saved on a full disk.' };
}

const RANK = { fail: 3, warn: 2, unknown: 1, ok: 0 };

/**
 * Run every check against a snapshot. `extras` carries the sources that are too expensive
 * to put in every snapshot (the parsed server config and the override list).
 */
export function evaluate(snapshot, extras = {}) {
  const results = CHECKS.map((c) => {
    let out;
    try { out = c.fn(snapshot, extras) || { status: UNKNOWN, detail: 'no result' }; }
    catch (err) { out = { status: UNKNOWN, detail: `check failed: ${err.message}` }; }
    return { id: c.id, group: c.group, title: c.title, status: out.status, detail: out.detail || '', hint: out.hint || null, value: out.value ?? null };
  });

  const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  const groups = [];
  for (const r of results) {
    let g = groups.find((x) => x.name === r.group);
    if (!g) groups.push((g = { name: r.group, checks: [], status: OK }));
    g.checks.push(r);
    if (RANK[r.status] > RANK[g.status]) g.status = r.status;
  }

  const overall = counts.fail ? FAIL : counts.warn ? WARN : counts.ok ? OK : UNKNOWN;
  return { at: Date.now(), overall, counts, total: results.length, groups, checks: results };
}
