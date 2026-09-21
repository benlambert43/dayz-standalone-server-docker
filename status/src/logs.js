// The server's own log files in the profiles folder of the data volume.
//
//   *.RPT  the engine log (-dologs). Its header is the only place the exact game version
//          and build number appear, and its body is where script errors show up.
//   *.ADM  the admin log (-adminlog), parsed in adm.js.
//   *.log  script logs and the tiny error_<stamp>.log the engine drops at every start.
//   *.mdmp crash dumps.
import path from 'node:path';
import { listDir, readTail, readCapped, KB, MB } from './util.js';

export const LOG_KINDS = [
  { kind: 'rpt', re: /\.rpt$/i, label: 'engine log (.RPT)' },
  { kind: 'adm', re: /\.adm$/i, label: 'admin log (.ADM)' },
  { kind: 'crash', re: /\.mdmp$/i, label: 'crash dump' },
  { kind: 'script', re: /^script_.*\.log$/i, label: 'script log' },
  { kind: 'error', re: /^error.*\.log$/i, label: 'start-up error log' },
  { kind: 'log', re: /\.log$/i, label: 'log' },
];

function kindOf(name) {
  for (const k of LOG_KINDS) if (k.re.test(name)) return k;
  return { kind: 'other', label: 'file' };
}

export async function discoverLogs(profilesDir) {
  const files = (await listDir(profilesDir, { withStats: true })).filter((f) => f.file);
  return files
    .map((f) => ({ ...f, ...kindOf(f.name) }))
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

/** Newest file of a kind - the one belonging to the run that is live right now. */
export async function newestOfKind(profilesDir, kind) {
  const all = await discoverLogs(profilesDir);
  return all.find((f) => f.kind === kind) || null;
}

// --------------------------------------------------------------- RPT header --
// The first two dozen lines of an .RPT identify the build exactly. Nothing else in the
// container does: the Steam manifest only knows a build id, not the 1.2x.yyyyy version
// players see in the launcher.
export function parseRptHeader(text) {
  const head = String(text).slice(0, 8 * KB);
  const pick = (re) => { const m = re.exec(head); return m ? m[1].trim() : null; };
  // The colon is present on some lines and absent on others, and it has moved between
  // builds, so every key here accepts both spellings.
  return {
    version: pick(/^Version:?\s+(.+)$/m) || pick(/Version:?\s+([\d.]+)/m),
    build: pick(/^Build:?\s+(.+)$/m),
    type: pick(/^Type:?\s+(.+)$/m),
    startedAt: pick(/^Current time:?\s+(.+)$/m),
    exe: pick(/^Item\s+.*\bExe\s*=\s*(.+)$/m) || pick(/^Exe\s+name:\s*(.+)$/m),
    allocator: pick(/^Allocator:\s*(.+)$/m),
    physMem: pick(/^PhysMem:\s*(.+)$/m),
    cpu: pick(/^Detected\s+(.+)$/m),
  };
}

// ------------------------------------------------------------- RPT contents --
const CLASSES = [
  { id: 'scriptError', label: 'script error', re: /Can't compile|Compiling .* failed|Script file .* not found|^SCRIPT\s+\(E\)|Error position|Class '[^']*' unknown/i, level: 'error' },
  { id: 'error', label: 'error', re: /\berror\b(?!\s*position)/i, level: 'error' },
  { id: 'warning', label: 'warning', re: /Warning Message:|\bwarning\b/i, level: 'warn' },
  { id: 'ce', label: 'central economy', re: /\[CE\]/i, level: 'info' },
  { id: 'shutdown', label: 'shutdown', re: /\[Shutdown\]|Destroying game|Termination successfully/i, level: 'info' },
  { id: 'mission', label: 'mission', re: /Mission read\.|Loading mission/i, level: 'info' },
];

export function classifyRptLine(line) {
  for (const c of CLASSES) if (c.re.test(line)) return c;
  return null;
}

/** Counts plus the newest examples of every interesting class in an .RPT tail. */
export function summariseRpt(text, { keep = 40 } = {}) {
  const counts = {};
  const samples = {};
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = classifyRptLine(line);
    if (!c) continue;
    counts[c.id] = (counts[c.id] || 0) + 1;
    (samples[c.id] ||= []).push(line.trim());
    if (samples[c.id].length > keep) samples[c.id].shift();
  }
  for (const k of Object.keys(samples)) samples[k] = samples[k].slice(-keep).reverse();
  return { lines: lines.length, counts, samples, header: parseRptHeader(text) };
}

/** The whole RPT picture for one file, size capped at both ends. */
export async function readRpt(file, { tailBytes = 512 * KB } = {}) {
  const [head, tail] = await Promise.all([readCapped(file, 16 * KB), readTail(file, tailBytes)]);
  if (!tail) return null;
  const summary = summariseRpt(tail.text);
  summary.header = parseRptHeader(head ? head.text : tail.text);
  return { file, size: tail.size, mtime: tail.mtime, truncated: tail.truncated, ...summary };
}
