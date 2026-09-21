// Small helpers shared by the collectors. Two rules run through all of them:
//   * every read is size-capped, because an .RPT file can reach hundreds of megabytes and
//     this container is meant to stay small;
//   * nothing throws at the caller. A status page whose Docker socket is missing must still
//     show the Steam query, and vice versa, so every source is wrapped in `safe()`.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const KB = 1024, MB = 1024 * KB;

export async function safe(fn, fallback = null) {
  try { return await fn(); } catch (err) { return typeof fallback === 'function' ? fallback(err) : fallback; }
}

/** Result envelope used by every collector, so the UI can always say why a panel is empty. */
export function ok(data, extra = {}) { return { ok: true, error: null, ...extra, ...data }; }
export function fail(error, extra = {}) { return { ok: false, error: String(error && error.message || error), ...extra }; }

export function human(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = Number(bytes);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-';
  let s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export async function stat(p) { return safe(() => fsp.stat(p)); }
export async function exists(p) { return (await stat(p)) !== null; }

export async function listDir(dir, { withStats = false } = {}) {
  const entries = await safe(() => fsp.readdir(dir, { withFileTypes: true }), []);
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const row = { name: e.name, path: full, dir: e.isDirectory(), file: e.isFile(), link: e.isSymbolicLink() };
    if (withStats) {
      const st = await stat(full);
      row.size = st ? st.size : null;
      row.mtime = st ? Math.round(st.mtimeMs) : null;
    }
    out.push(row);
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** Newest file matching a predicate, recursing one level at most. */
export async function newestFile(dir, re) {
  const files = (await listDir(dir, { withStats: true })).filter((f) => f.file && re.test(f.name));
  files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return files[0] || null;
}

/** Whole file, truncated to `max` bytes from the START (config-sized files). */
export async function readCapped(file, max = 2 * MB) {
  const st = await stat(file);
  if (!st) return null;
  const fh = await fsp.open(file, 'r');
  try {
    const len = Math.min(st.size, max);
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, 0);
    return { text: buf.toString('utf8'), truncated: st.size > max, size: st.size, mtime: Math.round(st.mtimeMs) };
  } finally { await fh.close(); }
}

/** Last `max` bytes of a file, cut at the first newline so no half line is returned. */
export async function readTail(file, max = 512 * KB) {
  const st = await stat(file);
  if (!st) return null;
  const fh = await fsp.open(file, 'r');
  try {
    const len = Math.min(st.size, max);
    const start = st.size - len;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    return { text, truncated: start > 0, size: st.size, mtime: Math.round(st.mtimeMs) };
  } finally { await fh.close(); }
}

export async function diskFree(p) {
  return safe(async () => {
    const s = await fsp.statfs(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free, usedPct: total ? Math.round(((total - free) / total) * 1000) / 10 : null };
  });
}

/** Cache keyed on (mtime, size): re-parses a mission file only after it actually changed. */
export function fileCache(loader) {
  const store = new Map();
  return async (file, ...rest) => {
    const st = await stat(file);
    if (!st) { store.delete(file); return null; }
    const key = `${Math.round(st.mtimeMs)}:${st.size}`;
    const hit = store.get(file);
    if (hit && hit.key === key) return hit.value;
    const value = await loader(file, ...rest);
    store.set(file, { key, value });
    return value;
  };
}

/** Time-based cache with single-flight, so ten browser tabs cost one Steam query. */
export function ttlCache(ttlMs, fn) {
  let at = -Infinity, value, inflight = null;
  return async (...args) => {
    if (Date.now() - at < ttlMs) return value;
    if (inflight) return inflight;
    inflight = (async () => {
      try { value = await fn(...args); at = Date.now(); return value; }
      finally { inflight = null; }
    })();
    return inflight;
  };
}

export function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
export function int(v, dflt = 0) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }
export function num(v, dflt = 0) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

/** Constant-ish redaction used before anything leaves this process. */
const SECRET_KEY = /(pass|passwd|password|secret|token|key|guard|rcon|credential)/i;
export function isSecretKey(k) { return SECRET_KEY.test(String(k)); }

/** `KEY=value` list (Docker `Config.Env`) with secret values replaced. */
export function redactEnvList(list) {
  return (list || []).map((line) => {
    const i = String(line).indexOf('=');
    if (i < 0) return { key: String(line), value: '', secret: false };
    const key = line.slice(0, i), value = line.slice(i + 1);
    const secret = isSecretKey(key);
    return { key, value: secret ? (value ? '********' : '') : value, secret };
  });
}

/** serverDZ.cfg with every `something...password... = "x";` value blanked. */
export function redactServerCfg(text) {
  return String(text || '').replace(
    /^([ \t]*[A-Za-z0-9_]*(?:password|passwd|rcon)[A-Za-z0-9_]*[ \t]*=[ \t]*)(.*)$/gim,
    (_m, head, val) => {
      // An empty value is not a secret, and saying "public server" is worth more than
      // hiding nothing behind stars - so it is left exactly as it is, comment included.
      if (/^["']?[ \t]*["']?;?[ \t]*$/.test(val)) return `${head}${val}`;
      return `${head}"********";  // redacted by the status page`;
    },
  );
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
