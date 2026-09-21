// The status page itself: a read-only HTTP server with a small JSON API, an SSE stream for
// live updates and a handful of static files. No framework, no dependencies.
//
// Everything it exposes is observation. There is no endpoint that changes the game server,
// the containers or any file - the worst a request can do is make this process read a log.
import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { Collector } from './collector.js';
import { evaluate } from './health.js';
import * as a2s from './a2s.js';
import * as logs from './logs.js';
import * as mission from './mission.js';
import { listOverlays, IMAGE_TYPES } from './overlays.js';
import { safe, readTail, readCapped, human, duration, KB, MB } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const OVERLAYS = path.join(PUBLIC, 'overlays');
const collector = new Collector();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  ...IMAGE_TYPES,
};

// Player and Steam IDs are personal data. The page is bound to localhost, but a screenshot
// or a stream is not, so the whole API can be asked to blank them.
function maskId(id, on) {
  if (!on || !id) return id;
  const s = String(id);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}...${s.slice(-4)}`;
}
function maskDeep(value, on) {
  if (!on) return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, on));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'id' || k === 'serverSteamId' ? maskId(v, on) : maskDeep(v, on);
    return out;
  }
  return value;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(buf);
}
const json = (res, data, status = 200) =>
  send(res, status, JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), { 'content-type': 'application/json; charset=utf-8' });

async function serveStatic(res, file, headers = {}) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  const body = await safe(() => fsp.readFile(full));
  if (!body) return send(res, 404, 'not found');
  return send(res, 200, body, { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', ...headers });
}

// ------------------------------------------------------------------ routes ---
const routes = new Map();
const route = (p, fn) => routes.set(p, fn);

route('/api/summary', async (u, res) => {
  const redact = wantsRedaction(u);
  const [snap, config, missions] = await Promise.all([
    collector.snapshot(),
    safe(() => collector.serverConfig(), { ok: false, error: 'not readable' }),
    safe(() => collector.missions(), { overrides: [] }),
  ]);
  const health = evaluate(snap, { config, overrides: missions.overrides });
  json(res, maskDeep({ snapshot: snap, health, config, missions }, redact));
});

route('/api/health', async (u, res) => {
  const [snap, config, missions] = await Promise.all([
    collector.snapshot(),
    safe(() => collector.serverConfig(), { ok: false }),
    safe(() => collector.missions(), { overrides: [] }),
  ]);
  json(res, evaluate(snap, { config, overrides: missions.overrides }));
});

route('/api/players', async (u, res) => {
  const redact = wantsRedaction(u);
  const people = await collector.people();
  const roster = people.roster.slice(0, 500);
  json(res, maskDeep({
    online: people.online,
    roster,
    sessions: people.rollup?.sessions.slice(0, 200) || [],
    admOk: people.admOk,
    admError: people.admError,
    leaderboard: {
      kills: [...roster].sort((a, b) => b.kills - a.kills).slice(0, 15),
      playtime: [...roster].sort((a, b) => b.playSeconds - a.playSeconds).slice(0, 15),
      longestShot: [...roster].filter((p) => p.longestShot > 0).sort((a, b) => b.longestShot - a.longestShot).slice(0, 15),
      chat: [...roster].sort((a, b) => b.chatLines - a.chatLines).slice(0, 15),
    },
  }, redact));
});

route('/api/chat', async (u, res) => {
  const redact = wantsRedaction(u);
  const limit = Math.min(Number(u.searchParams.get('limit')) || 300, 2000);
  const q = (u.searchParams.get('q') || '').toLowerCase();
  const adm = await collector.adminLog();
  let chat = (adm.events || []).filter((e) => e.kind === 'chat');
  if (q) chat = chat.filter((e) => `${e.actor?.name} ${e.text}`.toLowerCase().includes(q));
  json(res, maskDeep({ ok: adm.ok, error: adm.error || null, file: adm.name, total: chat.length, chat: chat.slice(-limit).reverse() }, redact));
});

route('/api/events', async (u, res) => {
  const redact = wantsRedaction(u);
  const limit = Math.min(Number(u.searchParams.get('limit')) || 400, 3000);
  const kinds = (u.searchParams.get('kind') || '').split(',').filter(Boolean);
  const q = (u.searchParams.get('q') || '').toLowerCase();
  const adm = await collector.adminLog();
  let evts = adm.events || [];
  if (kinds.length) evts = evts.filter((e) => kinds.includes(e.kind));
  if (q) evts = evts.filter((e) => e.raw.toLowerCase().includes(q));
  const counts = {};
  for (const e of adm.events || []) counts[e.kind] = (counts[e.kind] || 0) + 1;
  json(res, maskDeep({ ok: adm.ok, error: adm.error || null, file: adm.name, counts, total: evts.length, events: evts.slice(-limit).reverse() }, redact));
});

route('/api/map', async (u, res) => {
  const redact = wantsRedaction(u);
  const [map, people, adm] = await Promise.all([collector.mapData(), collector.people(), collector.adminLog()]);
  const events = adm.events || [];
  const pick = (kind, n) => events.filter((e) => e.kind === kind && e.actor?.pos).slice(-n)
    .map((e) => ({ ts: e.ts, name: e.actor.name, id: e.actor.id, x: e.actor.pos.x, z: e.actor.pos.z, y: e.actor.pos.y, kind: e.kind, weapon: e.weapon || null, distance: e.distance || null, killer: e.killer || null }));
  json(res, maskDeep({
    ...map,
    players: (people.online || []).filter((p) => p.pos).map((p) => ({ name: p.name, id: p.id, x: p.pos.x, z: p.pos.z, y: p.pos.y, ts: p.pos.ts })),
    deaths: pick('death', 400).concat(pick('kill', 400)),
    kills: pick('kill', 400),
    recent: events.filter((e) => e.actor?.pos).slice(-800).map((e) => ({ kind: e.kind, x: e.actor.pos.x, z: e.actor.pos.z, ts: e.ts, name: e.actor.name })),
  }, redact));
});

// The extra layers the map tab can put under the markers: drawn ones, whose geometry travels
// inline because it is a few kilobytes, and pictures, which are fetched by url. Driven by what
// is actually in public/overlays, so a dropped-in image needs no code change and a deleted one
// cannot 404.
route('/api/map/overlays', async (u, res) => {
  const map = await safe(() => collector.mapData(), { ok: false });
  const world = map?.world || {};
  json(res, { ok: true, world: world.world || null, size: world.size || 15360, overlays: await listOverlays(OVERLAYS, world) });
});

route('/api/missions', async (u, res) => json(res, await collector.missions()));

route('/api/mission/browse', async (u, res) => {
  const p = await collector.paths();
  if (!p.activeMissionDir) return json(res, { ok: false, error: 'no active mission yet' }, 404);
  const rel = u.searchParams.get('rel') || '';
  const out = await safe(() => mission.browse(p.activeMissionDir, rel), (err) => ({ error: err.message }));
  if (out && out.error) return json(res, { ok: false, ...out }, 400);
  json(res, { ok: true, root: p.activeMissionDir, ...out });
});

route('/api/economy', async (u, res) => json(res, await collector.economy()));
route('/api/mods', async (u, res) => json(res, await collector.mods()));
route('/api/storage', async (u, res) => json(res, await collector.storage()));
route('/api/config', async (u, res) => {
  const [config, missions, snap] = await Promise.all([collector.serverConfig(), collector.missions(), collector.snapshot()]);
  json(res, { config, overrides: missions.overrides, container: snap.docker.dayz, supervisor: snap.supervisor, statusPageSettings: publicSettings() });
});

route('/api/logs', async (u, res) => {
  const p = await collector.paths();
  const files = await logs.discoverLogs(p.profilesDir);
  json(res, { dir: p.profilesDir, files: files.map((f) => ({ name: f.name, kind: f.kind, label: f.label, size: f.size, mtime: f.mtime })) });
});

route('/api/logs/tail', async (u, res) => {
  const p = await collector.paths();
  const name = u.searchParams.get('file') || '';
  const bytes = Math.min(Number(u.searchParams.get('bytes')) || 256 * KB, 4 * MB);
  // Only files the log scanner itself found, so `file=` can never walk out of the folder.
  const known = await logs.discoverLogs(p.profilesDir);
  const hit = known.find((f) => f.name === name);
  if (!hit) return json(res, { ok: false, error: 'unknown log file' }, 404);
  if (hit.kind === 'crash') return json(res, { ok: false, error: 'crash dumps are binary; download them with docker compose cp' }, 400);
  const raw = await readTail(hit.path, bytes);
  const body = { ok: true, name, kind: hit.kind, size: raw.size, mtime: raw.mtime, truncated: raw.truncated, text: raw.text };
  if (hit.kind === 'rpt') body.summary = logs.summariseRpt(raw.text);
  json(res, body);
});

route('/api/docker/logs', async (u, res) => {
  const tail = Math.min(Number(u.searchParams.get('tail')) || 300, 5000);
  json(res, await collector.containerLogs(tail));
});

route('/api/docker', async (u, res) => {
  const d = await collector.dockerState();
  const info = d.ok ? await safe(() => collector.docker.info(), null) : null;
  const top = d.ok && d.dayz?.running ? await safe(() => collector.docker.top(d.dayz.id), null) : null;
  json(res, {
    ...d,
    host: info && {
      name: info.Name, os: info.OperatingSystem, kernel: info.KernelVersion, arch: info.Architecture,
      cpus: info.NCPU, memory: info.MemTotal, containers: info.Containers, running: info.ContainersRunning,
      images: info.Images, serverVersion: info.ServerVersion, driver: info.Driver,
    },
    processes: top,
  });
});

route('/api/history', async (u, res) => {
  const hours = Math.min(Number(u.searchParams.get('hours')) || 24, 24 * 31);
  await collector.history.ready;
  json(res, {
    hours,
    series: collector.history.series(hours),
    stats24: collector.history.stats(24),
    stats7d: collector.history.stats(24 * 7),
    store: await collector.history.size(),
  });
});

// "Ask the server": a raw A2S console. The target is restricted to the game container and
// the Docker host, so the page can never be used to probe anything else on the network.
route('/api/query', async (u, res) => {
  const target = u.searchParams.get('target') || 'container';
  const type = u.searchParams.get('type') || 'info';
  const port = Math.min(Math.max(Number(u.searchParams.get('port')) || cfg.queryPort, 1), 65535);
  const hosts = { container: cfg.dayzHost, host: cfg.hostProbe, loopback: '127.0.0.1' };
  const host = hosts[target];
  if (!host) return json(res, { ok: false, error: `target must be one of ${Object.keys(hosts).join(', ')}` }, 400);
  const fn = { info: a2s.info, players: a2s.players, rules: a2s.rules }[type];
  if (!fn) return json(res, { ok: false, error: 'type must be info, players or rules' }, 400);
  const started = Date.now();
  const out = await safe(async () => ({ ok: true, data: await fn(host, port, { timeout: cfg.queryTimeoutMs }) }), (err) => ({ ok: false, error: err.message }));
  json(res, { target, host, port, type, elapsedMs: Date.now() - started, ...out });
});

route('/healthz', async (u, res) => {
  const snap = await safe(() => collector.snapshot(), null);
  const alive = !!snap;
  send(res, alive ? 200 : 503, alive ? 'ok\n' : 'collector failed\n', { 'content-type': 'text/plain; charset=utf-8' });
});

// Prometheus text format, so the same numbers can go into an existing monitoring setup
// without scraping the HTML.
route('/metrics', async (u, res) => {
  const [snap, config, missions] = await Promise.all([
    collector.snapshot(),
    safe(() => collector.serverConfig(), { ok: false }),
    safe(() => collector.missions(), { overrides: [] }),
  ]);
  const health = evaluate(snap, { config, overrides: missions.overrides });
  const L = [];
  const metric = (name, help, type, value, labels = '') => {
    L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) L.push(`${name}${labels} ${Number(value)}`);
  };
  metric('dayz_up', 'Steam query answered (1) or not (0)', 'gauge', snap.query.info?.ok ? 1 : 0);
  metric('dayz_players', 'Players online', 'gauge', snap.players.count);
  metric('dayz_players_max', 'Player slots', 'gauge', snap.players.max);
  metric('dayz_query_rtt_ms', 'Steam query round trip', 'gauge', snap.query.info?.ok ? snap.query.info.rttMs : null);
  metric('dayz_host_port_ok', 'Published UDP port forwards from the host (1) or not (0)', 'gauge', snap.hostQuery?.skipped ? null : (snap.hostQuery?.ok ? 1 : 0));
  metric('dayz_server_uptime_seconds', 'Seconds since the game server process started', 'gauge', snap.uptime.serverSeconds);
  metric('dayz_container_uptime_seconds', 'Seconds since the container started', 'gauge', snap.uptime.containerSeconds);
  metric('dayz_restart_due_seconds', 'Seconds until the scheduled restart is due', 'gauge', snap.uptime.restartDueAt ? Math.round((snap.uptime.restartDueAt - Date.now()) / 1000) : null);
  metric('dayz_cpu_percent', 'Container CPU use in percent of one host', 'gauge', snap.docker.stats?.cpuPct);
  metric('dayz_memory_bytes', 'Container memory in use', 'gauge', snap.docker.stats?.memUsed);
  metric('dayz_restart_count', 'Docker restart count', 'counter', snap.docker.dayz?.restartCount);
  metric('dayz_crash_dumps', 'Crash dumps kept in the profiles folder', 'gauge', snap.logs?.crashDumps);
  metric('dayz_storage_bytes', 'Size of the world persistence files', 'gauge', snap.storage?.bytes);
  metric('dayz_disk_free_bytes', 'Free space on the data volume', 'gauge', snap.storage?.dataDisk?.free);
  metric('dayz_health_failing', 'Status page checks at level fail', 'gauge', health.counts.fail);
  metric('dayz_health_warning', 'Status page checks at level warn', 'gauge', health.counts.warn);
  L.push('# HELP dayz_check Result of one status page check (1 ok, 0.5 warn, 0 fail, -1 unknown)', '# TYPE dayz_check gauge');
  for (const c of health.checks) {
    const v = c.status === 'ok' ? 1 : c.status === 'warn' ? 0.5 : c.status === 'fail' ? 0 : -1;
    L.push(`dayz_check{id="${c.id}",group="${c.group.replace(/"/g, '')}"} ${v}`);
  }
  send(res, 200, `${L.join('\n')}\n`, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
});

// ------------------------------------------------------------------- stream --
const streams = new Set();

function sse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const client = { res, redact: wantsRedaction(new URL(req.url, 'http://x')) };
  streams.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); streams.delete(client); });
  pushTo(client).catch(() => {});
}

async function pushTo(client) {
  const [snap, config, missions] = await Promise.all([
    collector.snapshot(),
    safe(() => collector.serverConfig(), { ok: false }),
    safe(() => collector.missions(), { overrides: [] }),
  ]);
  const payload = maskDeep({ snapshot: snap, health: evaluate(snap, { config, overrides: missions.overrides }) }, client.redact);
  client.res.write(`event: summary\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function broadcast() {
  if (!streams.size) return;
  for (const c of streams) await safe(() => pushTo(c));
}

// ------------------------------------------------------------------ helpers --
function wantsRedaction(u) {
  const p = u.searchParams.get('redact');
  if (p === null) return cfg.redactIds;
  return /^(1|true|yes|on)$/i.test(p);
}

function publicSettings() {
  return {
    pollSeconds: cfg.pollSeconds, historyDays: cfg.historyDays, title: cfg.title,
    dayzHost: cfg.dayzHost, queryPort: cfg.queryPort, gamePort: cfg.gamePort,
    hostProbe: cfg.hostProbeEnabled ? cfg.hostProbe : null, redactIds: cfg.redactIds,
    dayWindow: [cfg.dayStartHour, cfg.dayEndHour], steamBuildCheck: cfg.steamBuildCheck,
  };
}

// -------------------------------------------------------------------- serve --
/** A malformed escape is a bad request, not a crash, so it simply matches nothing. */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return ''; }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'only GET is supported');
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (u.pathname === '/api/stream') return sse(req, res);
    if (u.pathname === '/api/settings') return json(res, publicSettings());

    const handler = routes.get(u.pathname);
    if (handler) return await handler(u, res);

    if (u.pathname === '/' || u.pathname === '/index.html') return serveStatic(res, 'index.html');
    if (/^\/[\w.-]+\.(js|css|svg|ico|json|webmanifest)$/.test(u.pathname)) return serveStatic(res, u.pathname.slice(1));
    // Map overlays. A few hundred kilobytes each and redrawn on every pan, so unlike the rest
    // of the page they are worth caching - briefly, so that replacing a file still shows up.
    const overlay = /^\/overlays\/([\w -]+\.[a-z0-9]+)$/i.exec(safeDecode(u.pathname));
    if (overlay && IMAGE_TYPES[path.extname(overlay[1]).toLowerCase()]) {
      return serveStatic(res, path.join('overlays', overlay[1]), { 'cache-control': 'public, max-age=300' });
    }
    return json(res, { error: 'not found', path: u.pathname }, 404);
  } catch (err) {
    console.error(`[status] ${req.url} failed after ${Date.now() - started} ms:`, err);
    if (!res.headersSent) json(res, { error: err.message }, 500);
    else res.end();
  }
});

server.headersTimeout = 20000;
server.requestTimeout = 60000;

server.listen(cfg.port, cfg.bind, () => {
  console.log(`[status] listening on ${cfg.bind}:${cfg.port}`);
  console.log(`[status] game server: ${cfg.dayzHost}:${cfg.queryPort}/udp   data: ${cfg.dataRoot}   install: ${cfg.serverRoot}`);
  console.log(`[status] docker socket: ${cfg.dockerSocket}   compose project: ${cfg.composeProject}`);
});

// One sampler for the history and one broadcast to every open page, on the same tick.
const timer = setInterval(async () => {
  await safe(() => collector.sample());
  await safe(() => broadcast());
}, cfg.pollSeconds * 1000);
timer.unref?.();
safe(() => collector.sample());

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[status] ${sig} received, shutting down`);
    clearInterval(timer);
    for (const c of streams) safe(() => c.res.end());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on('unhandledRejection', (err) => console.error('[status] unhandled rejection:', err));
