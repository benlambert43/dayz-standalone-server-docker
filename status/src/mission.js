// Everything that can be learned from the files on the two read-only volumes: which
// missions are installed, which one is live, what the central economy is configured to
// spawn, and where the fixed points of interest on the map are.
//
// The mission the server actually runs is the working copy run-server.sh builds
// ("docker.<world>"), never the vanilla folder, so that is what is read here.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseXml, children, child, textOf, numOf, find } from './xml.js';
import { fileCache, listDir, readCapped, stat, safe, MB } from './util.js';

export async function missionRoots(installDir) {
  const mp = path.join(installDir, 'mpmissions');
  const dirs = (await listDir(mp, { withStats: true })).filter((e) => e.dir && !e.name.startsWith('.'));
  return dirs.map((d) => ({
    name: d.name,
    path: d.path,
    world: d.name.includes('.') ? d.name.split('.').pop() : null,
    active: /^docker\./.test(d.name),
    vanilla: !/^docker\./.test(d.name),
    mtime: d.mtime,
  }));
}

export const readTypes = fileCache(async (file) => {
  const raw = await readCapped(file, 24 * MB);
  if (!raw) return null;
  const doc = parseXml(raw.text);
  const root = find(doc, 'types') || doc;
  const items = [];
  for (const t of children(root, 'type')) {
    const flags = child(t, 'flags');
    items.push({
      name: t.attrs.name || '',
      nominal: numOf(child(t, 'nominal'), 0),
      min: numOf(child(t, 'min'), 0),
      lifetime: numOf(child(t, 'lifetime'), 0),
      restock: numOf(child(t, 'restock'), 0),
      quantmin: numOf(child(t, 'quantmin'), -1),
      quantmax: numOf(child(t, 'quantmax'), -1),
      cost: numOf(child(t, 'cost'), 0),
      category: child(t, 'category')?.attrs.name || null,
      usage: children(t, 'usage').map((u) => u.attrs.name).filter(Boolean),
      value: children(t, 'value').map((v) => v.attrs.name).filter(Boolean),
      tag: children(t, 'tag').map((v) => v.attrs.name).filter(Boolean),
      flags: flags ? { ...flags.attrs } : {},
    });
  }
  return { file, count: items.length, truncated: raw.truncated, mtime: raw.mtime, items };
});

export const readEvents = fileCache(async (file) => {
  const raw = await readCapped(file, 8 * MB);
  if (!raw) return null;
  const root = find(parseXml(raw.text), 'events');
  const items = children(root, 'event').map((e) => ({
    name: e.attrs.name || '',
    nominal: numOf(child(e, 'nominal'), 0),
    min: numOf(child(e, 'min'), 0),
    max: numOf(child(e, 'max'), 0),
    lifetime: numOf(child(e, 'lifetime'), 0),
    restock: numOf(child(e, 'restock'), 0),
    saferadius: numOf(child(e, 'saferadius'), 0),
    distanceradius: numOf(child(e, 'distanceradius'), 0),
    cleanupradius: numOf(child(e, 'cleanupradius'), 0),
    position: textOf(child(e, 'position')) || null,
    limit: textOf(child(e, 'limit')) || null,
    active: numOf(child(e, 'active'), 0) === 1,
    children: children(child(e, 'children'), 'child').map((c) => c.attrs.type).filter(Boolean),
  }));
  return { file, count: items.length, mtime: raw.mtime, items };
});

export const readGlobals = fileCache(async (file) => {
  const raw = await readCapped(file, 2 * MB);
  if (!raw) return null;
  const root = find(parseXml(raw.text), 'variables');
  const items = children(root, 'var').map((v) => ({
    name: v.attrs.name, type: v.attrs.type, value: v.attrs.value,
  }));
  return { file, count: items.length, mtime: raw.mtime, items };
});

export const readMessages = fileCache(async (file) => {
  const raw = await readCapped(file, 1 * MB);
  if (!raw) return null;
  const root = find(parseXml(raw.text), 'messages');
  const items = children(root, 'message').map((m) => ({
    text: textOf(child(m, 'text')),
    deadline: numOf(child(m, 'deadline'), null),
    shutdown: numOf(child(m, 'shutdown'), null),
    repeat: numOf(child(m, 'repeat'), null),
    on: textOf(child(m, 'on')) || null,
  }));
  return { file, count: items.length, mtime: raw.mtime, items };
});

// ------------------------------------------------------------ map overlays --
/** Player spawn points. The file nests them differently per world, so the tree is walked. */
export const readSpawnPoints = fileCache(async (file) => {
  const raw = await readCapped(file, 8 * MB);
  if (!raw) return null;
  const doc = parseXml(raw.text);
  const points = [];
  const walk = (node, section) => {
    for (const c of node.children) {
      const here = ['fresh', 'hop', 'travel'].includes(c.name) ? c.name : section;
      const a = c.attrs;
      if (a.x !== undefined && a.z !== undefined) {
        points.push({ section: here, name: a.name || c.name, x: Number(a.x), z: Number(a.z), r: Number(a.r || 0) });
      } else if (a.pos) {
        const p = String(a.pos).trim().split(/\s+/).map(Number);
        if (p.length >= 3 && p.every(Number.isFinite)) points.push({ section: here, name: a.name || c.name, x: p[0], z: p[2], r: 0 });
      }
      walk(c, here);
    }
  };
  walk(doc, 'other');
  return { file, count: points.length, mtime: raw.mtime, points };
});

/** Contaminated / static effect areas - the only permanently lethal spots on the map. */
export const readEffectAreas = fileCache(async (file) => {
  const raw = await readCapped(file, 4 * MB);
  if (!raw) return null;
  const json = JSON.parse(raw.text);
  const areas = (json.Areas || []).map((a) => {
    const d = a.Data || {};
    const pos = d.Pos || d.pos || [];
    return {
      name: a.AreaName || d.Name || 'area',
      type: a.Type || null,
      trigger: a.TriggerType || null,
      x: Number(pos[0]), z: Number(pos[2]), y: Number(pos[1]),
      radius: Number(d.Radius ?? d.OuterRingToggle ?? 0),
      innerRings: d.InnerRingCount ?? null,
      particle: d.ParticleName || null,
    };
  }).filter((a) => Number.isFinite(a.x) && Number.isFinite(a.z));
  return { file, count: areas.length, mtime: raw.mtime, areas };
});

/**
 * Settlement density, read once per mission and cached.
 *
 * mapgrouppos.xml holds the world position of every building group - tens of megabytes on
 * Chernarus, far too much to send to a browser. It is streamed line by line here and
 * reduced to a coarse grid of counts, which is exactly what is needed to draw a recognisable
 * map background without shipping a single copyrighted map tile.
 */
export async function buildingDensity(file, { worldSize = 15360, cells = 192 } = {}) {
  const st = await stat(file);
  if (!st) return null;
  const grid = new Int32Array(cells * cells);
  const POS = /pos="(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)"/g;
  let total = 0, maxX = 0, maxZ = 0;

  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    rl.on('line', (line) => {
      POS.lastIndex = 0;
      let m;
      while ((m = POS.exec(line))) {
        const x = Number(m[1]), z = Number(m[3]);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        if (x > maxX) maxX = x;
        if (z > maxZ) maxZ = z;
        const cx = Math.floor((x / worldSize) * cells);
        const cz = Math.floor((z / worldSize) * cells);
        if (cx >= 0 && cx < cells && cz >= 0 && cz < cells) { grid[cz * cells + cx]++; total++; }
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  let peak = 0;
  for (const v of grid) if (v > peak) peak = v;
  return { file, cells, worldSize, total, peak, maxX: Math.round(maxX), maxZ: Math.round(maxZ), grid: Array.from(grid), mtime: Math.round(st.mtimeMs) };
}

// ------------------------------------------------------------ install state --
/** The Steam app manifest: which build is on disk and when it was written. */
export async function appManifest(installDir, appId) {
  const file = path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`);
  const raw = await readCapped(file, 512 * 1024);
  if (!raw) return null;
  const val = (key) => {
    const m = new RegExp(String.raw`"${key}"\s+"([^"]*)"`).exec(raw.text);
    return m ? m[1] : null;
  };
  const lastUpdated = Number(val('LastUpdated'));
  return {
    file,
    appId,
    buildId: val('buildid'),
    name: val('name'),
    branch: val('betakey') || 'public',
    stateFlags: Number(val('StateFlags')),
    installed: Number(val('StateFlags')) === 4,
    sizeOnDisk: Number(val('SizeOnDisk')) || null,
    lastUpdated: Number.isFinite(lastUpdated) && lastUpdated > 0 ? lastUpdated : null,
    mtime: raw.mtime,
  };
}

// ------------------------------------------------------------------- mods ----
/**
 * Mods installed next to the server binary. This stack does not manage Workshop content
 * yet, so an empty list is the normal, healthy answer; anything found here was put there by
 * hand or through EXTRA_ARGS.
 */
export async function installedMods(installDir) {
  const entries = (await listDir(installDir, { withStats: true })).filter((e) => e.dir && e.name.startsWith('@'));
  const mods = [];
  for (const e of entries) {
    const mod = { name: e.name.slice(1), folder: e.name, path: e.path, mtime: e.mtime, workshopId: null, source: 'install directory' };
    for (const metaName of ['meta.cpp', 'mod.cpp']) {
      const meta = await readCapped(path.join(e.path, metaName), 128 * 1024);
      if (!meta) continue;
      const pick = (k) => {
        const m = new RegExp(String.raw`${k}[ \t]*=[ \t]*"?([^";\n]*)"?[ \t]*;`, 'i').exec(meta.text);
        return m ? m[1].trim() : null;
      };
      mod.workshopId = pick('publishedid') || mod.workshopId;
      mod.displayName = pick('name') || mod.displayName;
      mod.version = pick('version') || mod.version;
      mod.author = pick('author') || mod.author;
    }
    const keys = (await listDir(path.join(e.path, 'keys'))).filter((k) => k.file);
    mod.bikeys = keys.map((k) => k.name);
    mods.push(mod);
  }
  return mods;
}

/** `-mod=` / `-servermod=` as they appear on the real command line. */
export function modsFromArgs(launchArgs) {
  const out = [];
  for (const m of String(launchArgs || '').matchAll(/-(server)?mod=([^\s]+)/gi)) {
    for (const part of m[2].split(';').filter(Boolean)) {
      out.push({ name: part.replace(/^@/, ''), folder: part, serverSide: !!m[1], source: 'launch arguments' });
    }
  }
  return out;
}

// -------------------------------------------------------------- file browser -
const TEXT_EXT = /\.(xml|json|c|cpp|hpp|txt|cfg|log|layout|map|csv|ini|acf)$/i;

/** A directory listing confined to `root`, for the mission file browser. */
export async function browse(root, rel = '') {
  const target = path.resolve(root, `.${path.sep}${rel}`);
  if (!target.startsWith(path.resolve(root))) throw new Error('path outside the mission folder');
  const st = await stat(target);
  if (!st) throw new Error('not found');
  if (st.isDirectory()) {
    const entries = await listDir(target, { withStats: true });
    return {
      kind: 'dir',
      rel,
      entries: entries.map((e) => ({
        name: e.name, dir: e.dir, size: e.size, mtime: e.mtime,
        rel: path.posix.join(rel, e.name), readable: e.dir || TEXT_EXT.test(e.name),
      })),
    };
  }
  if (!TEXT_EXT.test(target)) return { kind: 'binary', rel, size: st.size, mtime: Math.round(st.mtimeMs) };
  const raw = await readCapped(target, 1 * MB);
  return { kind: 'file', rel, size: raw.size, mtime: raw.mtime, truncated: raw.truncated, text: raw.text };
}

/** Which of the user's ./config/mission files are actually in the live working copy. */
export async function overrideStatus(configMissionDir, activeMissionDir) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const e of await listDir(dir, { withStats: true })) {
      const childRel = path.posix.join(rel, e.name);
      if (e.dir) { await walk(e.path, childRel); continue; }
      if (e.name === '.gitkeep') continue;
      const live = await stat(path.join(activeMissionDir, childRel));
      out.push({
        rel: childRel, size: e.size, mtime: e.mtime,
        appliedSize: live ? live.size : null,
        applied: !!live && live.size === e.size,
        note: !live ? 'not found in the live mission (file name case is resolved at start-up)' : null,
      });
    }
  };
  await safe(() => walk(configMissionDir, ''), null);
  return out;
}

// ------------------------------------------------------------- serverDZ.cfg --
/**
 * The handful of values from serverDZ.cfg that the health checks compare against reality.
 * Kept here, out of the collector, so it can be tested without a file system: a broken
 * pattern here silently turns half the configuration checks into "unknown".
 */
export function parseServerCfgValues(text) {
  const src = String(text || '');
  const pick = (key) => {
    const m = new RegExp(String.raw`^[ \t]*${key}[ \t]*=[ \t]*"?([^";\n]*)"?[ \t]*;`, 'im').exec(src);
    return m ? m[1].trim() : null;
  };
  const isSet = (key) => new RegExp(String.raw`^[ \t]*${key}[ \t]*=[ \t]*"(.+)"[ \t]*;`, 'im').test(src);
  return {
    hostname: pick('hostname'),
    maxPlayers: pick('maxPlayers'),
    template: pick('template'),
    instanceId: pick('instanceId'),
    steamQueryPort: pick('steamQueryPort'),
    verifySignatures: pick('verifySignatures'),
    forceSameBuild: pick('forceSameBuild'),
    disable3rdPerson: pick('disable3rdPerson'),
    disableVoN: pick('disableVoN'),
    enableWhitelist: pick('enableWhitelist'),
    serverTime: pick('serverTime'),
    serverTimeAcceleration: pick('serverTimeAcceleration'),
    serverNightTimeAcceleration: pick('serverNightTimeAcceleration'),
    serverTimePersistent: pick('serverTimePersistent'),
    loginQueueMaxPlayers: pick('loginQueueMaxPlayers'),
    storageAutoFix: pick('storageAutoFix'),
    adminPasswordSet: isSet('passwordAdmin'),
    passwordSet: isSet('password'),
  };
}

/**
 * How many player IDs a ban.txt, whitelist.txt or priority.txt actually holds.
 * DayZ ships these files full of // comments explaining how to use them, and an ID may carry
 * a trailing // comment of its own, so only lines that start with something else count.
 */
export function countListEntries(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('//'))
    .length;
}
