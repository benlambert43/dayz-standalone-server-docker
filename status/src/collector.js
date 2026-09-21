// One object that knows how to fetch every source and hands out a consistent snapshot.
//
// The three sources have very different costs, so each has its own cache window:
//   Steam queries   - a couple of UDP round trips, cached for a few seconds
//   Docker API      - a local socket, cached for a few seconds
//   log and mission files - cached until their mtime or size changes
// Nothing here throws: a snapshot with a dead Docker socket still carries the Steam answer.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { cfg, APP_IDS } from './config.js';
import { Docker, summariseStats, summariseInspect } from './dockerapi.js';
import * as a2s from './a2s.js';
import * as mission from './mission.js';
import * as logs from './logs.js';
import { parseAdm, rollup } from './adm.js';
import { worldInfo, inGameClock } from './world.js';
import { History } from './history.js';
import {
  safe, stat, exists, listDir, readCapped, readTail, diskFree, ttlCache,
  redactEnvList, redactServerCfg, MB, KB,
} from './util.js';

export class Collector {
  constructor() {
    this.docker = new Docker(cfg.dockerSocket);
    this.history = new History(cfg.stateDir, { days: cfg.historyDays });
    this.startedAt = Date.now();
    this.densityCache = new Map();
    this.admCache = { key: null, value: null };
    this.lastSnapshot = null;

    this.query = ttlCache(4000, () => a2s.queryAll(cfg.dayzHost, cfg.queryPort, { timeout: cfg.queryTimeoutMs }));
    this.hostQuery = ttlCache(15000, async () => {
      if (!cfg.hostProbeEnabled) return { skipped: true };
      return safe(
        async () => ({ ...(await a2s.info(cfg.hostProbe, cfg.queryPort, { timeout: cfg.queryTimeoutMs })), ok: true }),
        (err) => ({ ok: false, error: err.message }),
      );
    });
    this.dockerState = ttlCache(4000, () => this.#docker());
    this.steamBuild = ttlCache(900_000, () => this.#steamBuild());
  }

  // ------------------------------------------------------------------ paths --
  /** What the game container published about itself, or null before it ever ran. */
  async state() {
    const raw = await readCapped(path.join(cfg.dataRoot, 'state', 'status.json'), 64 * KB);
    if (!raw) return null;
    return safe(async () => JSON.parse(raw.text), null);
  }

  async paths() {
    const st = await this.state();
    let branch = (st && st.branch) || cfg.branchFallback;
    if (!(await exists(path.join(cfg.serverRoot, branch)))) {
      for (const candidate of ['stable', 'experimental']) {
        if (await exists(path.join(cfg.serverRoot, candidate))) { branch = candidate; break; }
      }
    }
    const installDir = path.join(cfg.serverRoot, branch);
    const world = (st && st.world) || (st && st.mission ? String(st.mission).split('.').pop() : null);
    const activeMission = (st && st.active_mission) || (world ? `docker.${world}` : null);
    return {
      state: st,
      branch,
      appId: APP_IDS[branch] || APP_IDS.stable,
      installDir,
      world,
      activeMission,
      activeMissionDir: activeMission ? path.join(installDir, 'mpmissions', activeMission) : null,
      profilesDir: (st && st.profiles_dir) || path.join(cfg.dataRoot, 'profiles'),
      storageDir: (st && st.storage_dir) || path.join(cfg.dataRoot, 'storage', branch),
      configFile: (st && st.config_file) || path.join(cfg.dataRoot, 'config', 'serverDZ.cfg'),
    };
  }

  // ----------------------------------------------------------------- docker --
  async #docker() {
    const probe = await this.docker.probe();
    if (!probe.ok) return { ok: false, error: probe.error, version: null, containers: [], dayz: null, stats: null };
    const containers = await safe(() => this.docker.projectContainers(cfg.composeProject), []);
    const rows = (containers || []).map((c) => ({
      id: c.Id,
      name: (c.Names && c.Names[0] || '').replace(/^\//, ''),
      service: c.Labels?.['com.docker.compose.service'] || null,
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: c.Created,
    }));
    // The compose label is authoritative. The name fallback exists only for a stack started
    // without compose, and must never match this container itself - which is also called
    // "dayz-something", and once did.
    const dayzRow = rows.find((r) => r.service === cfg.dayzService)
      || rows.find((r) => r.service !== cfg.statusService && /(^|[-_])dayz([-_]\d+)?$/.test(r.name));
    let dayz = null, stats = null;
    if (dayzRow) {
      const inspected = await safe(() => this.docker.inspect(dayzRow.id), null);
      dayz = summariseInspect(inspected, redactEnvList);
      if (dayz && dayz.running) {
        const raw = await safe(() => this.docker.stats(dayzRow.id), null);
        stats = summariseStats(raw);
      }
    }
    return { ok: true, version: probe, containers: rows, dayz, stats };
  }

  async containerLogs(tail = 300) {
    const d = await this.dockerState();
    if (!d.ok || !d.dayz) return { ok: false, error: d.error || 'the dayz container was not found', lines: [] };
    const lines = await safe(() => this.docker.logs(d.dayz.id, { tail }), null);
    return lines ? { ok: true, lines } : { ok: false, error: 'could not read the container log', lines: [] };
  }

  // -------------------------------------------------------------- admin log --
  /** Parsed .ADM of the newest run, re-parsed only when the file grows. */
  async adminLog() {
    const p = await this.paths();
    const file = await logs.newestOfKind(p.profilesDir, 'adm');
    if (!file) return { ok: false, error: 'no .ADM file yet (the server writes one at every start)', events: [] };
    const key = `${file.path}:${file.mtime}:${file.size}`;
    if (this.admCache.key === key) return this.admCache.value;
    const raw = await readTail(file.path, cfg.admTailBytes);
    if (!raw) return { ok: false, error: 'could not read the admin log', events: [] };
    const parsed = parseAdm(raw.text);
    const value = {
      ok: true,
      file: file.path,
      name: file.name,
      size: raw.size,
      mtime: raw.mtime,
      truncated: raw.truncated,
      startedAt: parsed.startedAt,
      events: parsed.events,
    };
    this.admCache = { key, value };
    return value;
  }

  /** Admin-log events joined with the live Steam player list. */
  async people() {
    const [adm, q] = await Promise.all([this.adminLog(), this.query()]);
    const live = q.players?.ok ? q.players.players : [];
    const roll = rollup(adm.events || []);
    const byName = new Map(roll.players.map((p) => [String(p.name).toLowerCase(), p]));

    const online = live.map((lp) => {
      const known = byName.get(String(lp.name).toLowerCase()) || null;
      return {
        name: lp.name || known?.name || '(name not reported)',
        id: known?.id || null,
        score: lp.score,
        seconds: lp.seconds,
        pos: known?.lastPos || null,
        kills: known?.kills ?? null,
        deaths: known?.deaths ?? null,
        source: 'A2S_PLAYER',
      };
    });

    // A DayZ build that answers A2S_PLAYER with empty names still reports a head count in
    // A2S_INFO, so the admin log fills the gap: everyone who connected and never left.
    if (!online.length || online.every((p) => !p.name || p.name.startsWith('('))) {
      const fromLog = roll.online.map((p) => ({
        name: p.name, id: p.id, seconds: p.sessionSeconds ?? null, pos: p.lastPos,
        kills: p.kills, deaths: p.deaths, score: null, source: 'admin log',
      }));
      if (fromLog.length) return { online: fromLog, roster: roll.players, rollup: roll, admOk: adm.ok, admError: adm.error || null };
    }
    return { online, roster: roll.players, rollup: roll, admOk: adm.ok, admError: adm.error || null };
  }

  // ---------------------------------------------------------------- mission --
  async missions() {
    const p = await this.paths();
    const installed = await mission.missionRoots(p.installDir);
    const overrides = p.activeMissionDir
      ? await mission.overrideStatus(path.join(cfg.configDir, 'mission'), p.activeMissionDir)
      : [];
    return { installed, active: p.activeMission, activeDir: p.activeMissionDir, overrides, installDir: p.installDir };
  }

  async economy() {
    const p = await this.paths();
    if (!p.activeMissionDir) return { ok: false, error: 'no active mission yet' };
    const db = path.join(p.activeMissionDir, 'db');
    const [types, events, globals, messages] = await Promise.all([
      safe(() => mission.readTypes(path.join(db, 'types.xml'))),
      safe(() => mission.readEvents(path.join(db, 'events.xml'))),
      safe(() => mission.readGlobals(path.join(db, 'globals.xml'))),
      safe(() => mission.readMessages(path.join(db, 'messages.xml'))),
    ]);
    return { ok: true, types, events, globals, messages, missionDir: p.activeMissionDir };
  }

  async mapData() {
    const p = await this.paths();
    if (!p.activeMissionDir) return { ok: false, error: 'no active mission yet' };
    const [spawns, areas] = await Promise.all([
      safe(() => mission.readSpawnPoints(path.join(p.activeMissionDir, 'cfgplayerspawnpoints.xml'))),
      safe(() => mission.readEffectAreas(path.join(p.activeMissionDir, 'cfgeffectarea.json'))),
    ]);
    const density = await this.density(p);
    const world = worldInfo(p.world, { observedMax: density ? Math.max(density.maxX, density.maxZ) : 0, override: cfg.worldSize });
    return { ok: true, world, density, spawns, areas };
  }

  /**
   * The settlement grid. Parsing mapgrouppos.xml costs a second or two and tens of megabytes
   * of reading, so it happens at most once per mission file version and is then kept.
   */
  async density(paths) {
    const p = paths || (await this.paths());
    if (!p.activeMissionDir) return null;
    const file = path.join(p.activeMissionDir, 'mapgrouppos.xml');
    const st = await stat(file);
    if (!st) return null;
    const key = `${file}:${Math.round(st.mtimeMs)}:${st.size}`;
    if (this.densityCache.has(key)) return this.densityCache.get(key);
    const world = worldInfo(p.world, { override: cfg.worldSize });
    const value = await safe(() => mission.buildingDensity(file, { worldSize: world.size, cells: 192 }), null);
    this.densityCache.clear();
    this.densityCache.set(key, value);
    return value;
  }

  // ------------------------------------------------------------------- mods --
  async mods() {
    const p = await this.paths();
    const [installed, q] = await Promise.all([mission.installedMods(p.installDir), this.query()]);
    const fromArgs = mission.modsFromArgs(p.state?.launch_args);
    const fromRules = q.rules?.ok ? (q.rules.bohemia?.mods || []) : [];
    const byName = new Map();
    for (const m of [...installed, ...fromArgs, ...fromRules]) {
      const key = String(m.name).toLowerCase();
      byName.set(key, { ...(byName.get(key) || {}), ...m, sources: [...new Set([...(byName.get(key)?.sources || []), m.source])] });
    }
    return {
      mods: [...byName.values()],
      rulesNote: q.rules?.ok ? q.rules.bohemia?.note || null : q.rules?.error || null,
      supported: false,     // this stack does not manage Workshop content yet
    };
  }

  // ---------------------------------------------------------------- storage --
  async storage() {
    const p = await this.paths();
    const walk = async (dir, depth = 0) => {
      const out = [];
      for (const e of await listDir(dir, { withStats: true })) {
        if (e.dir && depth < 3) out.push({ ...e, children: await walk(e.path, depth + 1) });
        else out.push(e);
      }
      return out;
    };
    const tree = await safe(() => walk(p.storageDir), []);
    const flatten = (nodes) => nodes.flatMap((n) => [n, ...(n.children ? flatten(n.children) : [])]);
    const all = flatten(tree);
    const files = all.filter((f) => f.file);
    const newest = files.reduce((a, b) => ((b.mtime || 0) > (a?.mtime || 0) ? b : a), null);
    const oldest = files.reduce((a, b) => ((b.mtime || Infinity) < (a?.mtime || Infinity) ? b : a), null);
    const [dataDisk, serverDisk] = await Promise.all([diskFree(cfg.dataRoot), diskFree(cfg.serverRoot)]);
    const rescued = (await listDir(cfg.dataRoot, { withStats: true })).filter((e) => e.dir && e.name.startsWith('rescued-storage-'));
    return {
      dir: p.storageDir,
      tree,
      fileCount: files.length,
      bytes: files.reduce((s, f) => s + (f.size || 0), 0),
      lastSave: newest ? newest.mtime : null,
      lastSaveFile: newest ? newest.name : null,
      worldAgeFrom: oldest ? oldest.mtime : null,
      dataDisk,
      serverDisk,
      rescued,
    };
  }

  // ----------------------------------------------------------------- config --
  async serverConfig() {
    const p = await this.paths();
    const raw = await readCapped(p.configFile, 512 * KB);
    if (!raw) return { ok: false, error: `${p.configFile} does not exist yet` };
    return {
      ok: true,
      file: p.configFile,
      mtime: raw.mtime,
      source: p.state?.config_source || 'generated',
      // Passwords never leave this process, not even for a page bound to localhost.
      text: redactServerCfg(raw.text),
      values: mission.parseServerCfgValues(raw.text),
      lists: await this.#lists(p),
    };
  }

  async #lists(p) {
    const out = {};
    for (const name of ['ban.txt', 'whitelist.txt', 'priority.txt']) {
      const f = await readCapped(path.join(p.installDir, name), 256 * KB);
      out[name] = f
        ? { present: true, lines: mission.countListEntries(f.text), mtime: f.mtime }
        : { present: false, lines: 0 };
    }
    return out;
  }

  // ------------------------------------------------------------- steam build --
  /**
   * The only outbound request this container can make, and it is off unless
   * STATUS_CHECK_STEAM_BUILD=true: it answers "is the installed build the current one?".
   */
  async #steamBuild() {
    if (!cfg.steamBuildCheck) return { enabled: false };
    const p = await this.paths();
    try {
      const res = await fetch(`${cfg.steamBuildUrl}${p.appId}`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const branches = body?.data?.[String(p.appId)]?.depots?.branches || {};
      const wanted = p.branch === 'experimental' ? 'public' : 'public';
      return {
        enabled: true, ok: true, source: cfg.steamBuildUrl,
        publicBuildId: branches[wanted]?.buildid ?? null,
        timeUpdated: Number(branches[wanted]?.timeupdated) || null,
      };
    } catch (err) {
      return { enabled: true, ok: false, error: err.message };
    }
  }

  // --------------------------------------------------------------- snapshot --
  /** Everything the dashboard shows in one object. Never throws. */
  async snapshot() {
    const [p, q, d, hostQ] = await Promise.all([this.paths(), this.query(), this.dockerState(), this.hostQuery()]);
    const [people, manifest, rpt, storage, logFiles, startCount] = await Promise.all([
      safe(() => this.people(), { online: [], roster: [], rollup: null }),
      safe(() => mission.appManifest(p.installDir, p.appId), null),
      safe(async () => {
        const f = await logs.newestOfKind(p.profilesDir, 'rpt');
        return f ? logs.readRpt(f.path, { tailBytes: cfg.rptTailBytes }) : null;
      }, null),
      safe(() => this.storage(), null),
      safe(() => logs.discoverLogs(p.profilesDir), []),
      // null, not 0: "the counter does not exist yet" and "no failed starts" are different
      // answers, and only the second one is good news.
      safe(async () => {
        const f = await readCapped(path.join(cfg.dataRoot, 'state', 'start-count'), 64);
        if (!f) return null;
        const n = Number.parseInt(f.text.trim(), 10);
        return Number.isFinite(n) ? n : null;
      }, null),
    ]);
    const crashDumps = (logFiles || []).filter((f) => f.kind === 'crash');

    const st = p.state || {};
    const serverStarted = st.server_started_epoch ? st.server_started_epoch * 1000 : null;
    const density = this.densityCache.size ? [...this.densityCache.values()][0] : null;
    const world = worldInfo(p.world, { observedMax: density ? Math.max(density.maxX, density.maxZ) : 0, override: cfg.worldSize });

    const clock = inGameClock({
      serverTime: st.server_time || 'SystemTime',
      timeAcceleration: st.time_acceleration ?? 1,
      nightTimeAcceleration: st.night_time_acceleration ?? 1,
      startEpochMs: serverStarted,
      dayStartHour: cfg.dayStartHour,
      dayEndHour: cfg.dayEndHour,
    });

    const containerStarted = d.dayz?.startedAt ? Date.parse(d.dayz.startedAt) : null;
    const snap = {
      at: Date.now(),
      statusPage: { startedAt: this.startedAt, uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000), version: 1 },
      supervisor: st,
      supervisorFresh: st.updated_epoch ? Date.now() / 1000 - st.updated_epoch < 90 : false,
      branch: p.branch,
      world,
      mission: { name: st.mission || null, active: p.activeMission, overrides: st.mission_overrides ?? null },
      clock,
      query: q,
      hostQuery: hostQ,
      docker: d,
      players: {
        online: people.online || [],
        count: q.info?.ok ? q.info.players : (people.online || []).length,
        max: q.info?.ok ? q.info.maxPlayers : st.max_players ?? null,
        namesReported: (q.players?.named ?? 0) > 0,
      },
      uptime: {
        containerStartedAt: containerStarted,
        containerSeconds: containerStarted ? Math.round((Date.now() - containerStarted) / 1000) : null,
        serverStartedAt: serverStarted,
        serverSeconds: serverStarted ? Math.round((Date.now() - serverStarted) / 1000) : null,
        missionReadySeconds: st.mission_ready_seconds ?? null,
        restartDueAt: st.restart_due_epoch ? st.restart_due_epoch * 1000 : null,
        restartDeadlineAt: st.restart_deadline_epoch ? st.restart_deadline_epoch * 1000 : null,
        restartIntervalSeconds: st.restart_interval_seconds ?? null,
      },
      build: {
        manifest,
        rpt: rpt ? { version: rpt.header?.version, build: rpt.header?.build, type: rpt.header?.type } : null,
        queryVersion: q.info?.ok ? q.info.version : null,
      },
      rpt: rpt ? { file: rpt.file, size: rpt.size, mtime: rpt.mtime, counts: rpt.counts, header: rpt.header } : null,
      storage,
      logs: {
        files: (logFiles || []).length,
        bytes: (logFiles || []).reduce((s, f) => s + (f.size || 0), 0),
        newestMtime: (logFiles || [])[0]?.mtime ?? null,
        crashDumps: crashDumps.length,
        newestCrashDump: crashDumps[0]?.mtime ?? null,
      },
      crashBackoff: { startsSinceHealthy: startCount },
      redactIds: cfg.redactIds,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  /** One history sample. Called on a timer by the server. */
  async sample() {
    const snap = await safe(() => this.snapshot(), null);
    if (!snap) return null;
    return this.history.add({
      p: snap.players.count ?? 0,
      m: snap.players.max ?? 0,
      up: snap.query.info?.ok ? 1 : 0,
      cpu: snap.docker.stats?.cpuPct ?? null,
      mem: snap.docker.stats?.memUsed ?? null,
      rtt: snap.query.info?.ok ? snap.query.info.rttMs : null,
    });
  }
}
