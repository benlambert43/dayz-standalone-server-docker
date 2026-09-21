// Extra layers for the live map.
//
// The map itself is drawn from the mission's own mapgrouppos.xml, so the page works with
// nothing in this folder at all. A layer is an optional extra on top of it, and comes in two
// kinds.
//
// A DRAWN layer is a small JSON file of polygons, circles, lines and labelled points, all in
// world metres, which the page renders in its own palette. Everything shipped is drawn, which
// is why the container still holds no map imagery: a place name and a tier boundary are facts
// about the world, and writing them down is not the same as shipping somebody's picture of it.
//
// A PICTURE layer is an image placed by the world rectangle it covers, for anyone who has a
// terrain render of their own. Two things make that usable. The first is bounds: a crop of the
// north-west lines up as readily as a full-map render. The second is that the folder wins over
// the manifest - an image listed but missing is dropped, and an image present but unlisted is
// offered anyway with sane defaults, so dropping a file in is enough to see it.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { safe } from './util.js';

/** Extensions a browser can put on a canvas. svg is included; it is drawn, not scripted. */
export const IMAGE_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};

const clamp01 = (v, fallback) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : fallback);
const isPair = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
const pair = (p) => [Number(p[0]), Number(p[1])];

/**
 * Resolve one manifest entry against the world it will be drawn on.
 * Returns null when the entry names a different world or has no usable file.
 */
export function resolveOverlay(entry, { world, size, files }) {
  if (!entry || typeof entry !== 'object') return null;

  // A layer can name the world it belongs to. While the mission has not been read yet the
  // world is simply unknown, and hiding everything would look like a broken page - the
  // layers are offered, switched off, and whoever is looking can judge.
  const want = String(entry.world || '*').toLowerCase();
  if (want !== '*' && world && want !== String(world).toLowerCase()) return null;

  const common = {
    opacity: clamp01(entry.opacity, 0.8),
    on: entry.on === true,
    credit: entry.credit ? String(entry.credit) : null,
  };

  const shapes = safeName(entry.shapes);
  if (shapes) {
    if (!/\.json$/i.test(shapes)) return null;
    const name = shapes.replace(/\.[^.]+$/, '');
    return { kind: 'shapes', id: String(entry.id || name), label: String(entry.label || entry.id || name), shapes, ...common };
  }

  const asked = safeName(entry.file);
  if (!asked) return null;
  // The name on disk wins over the one in the manifest: a container's filesystem is case
  // sensitive and the person editing the JSON on Windows cannot tell.
  const file = files ? files.get(asked.toLowerCase()) : asked;
  if (!file || !IMAGE_TYPES[path.extname(file).toLowerCase()]) return null;
  const name = file.replace(/\.[^.]+$/, '');
  return {
    kind: 'image',
    id: String(entry.id || name),
    label: String(entry.label || entry.id || name),
    url: `/overlays/${encodeURIComponent(file)}`,
    bounds: resolveBounds(entry.bounds, size),
    ...common,
  };
}

/** A file name in this folder and nothing else: no path, no escape, no surprises. */
function safeName(value) {
  const s = String(value || '').trim();
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) return null;
  return s;
}

/**
 * "world" (or anything unreadable) means the whole square. Otherwise four metre values,
 * west/south/east/north, normalised so the rectangle is never inside out or zero sized.
 */
export function resolveBounds(bounds, size) {
  const full = [0, 0, size, size];
  if (!Array.isArray(bounds) || bounds.length !== 4) return full;
  const n = bounds.map(Number);
  if (n.some((v) => !Number.isFinite(v))) return full;
  const [x0, z0, x1, z1] = [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
  if (x1 - x0 < 1 || z1 - z0 < 1) return full;
  return [x0, z0, x1, z1];
}

/**
 * Take a shapes file down to what the page can draw. A hand-edited file is the normal case
 * here, so a bad polygon drops out quietly rather than breaking the whole layer - which is
 * also what keeps `_comment` and any other stray key from reaching the browser.
 */
export function readShapes(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const areas = [], circles = [], lines = [], points = [];

  for (const a of arr(doc.areas)) {
    const polygon = arr(a.polygon).filter(isPair).map(pair);
    if (polygon.length < 3) continue;
    areas.push({ label: text(a.label), colour: colour(a.colour), polygon, labelAt: isPair(a.labelAt) ? pair(a.labelAt) : null });
  }
  for (const c of arr(doc.circles)) {
    if (!isPair(c.at) || !(Number(c.radius) > 0)) continue;
    circles.push({ label: text(c.label), colour: colour(c.colour), at: pair(c.at), radius: Number(c.radius) });
  }
  for (const l of arr(doc.lines)) {
    const pts = arr(l.points).filter(isPair).map(pair);
    if (pts.length < 2) continue;
    const dash = arr(l.dash).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    lines.push({
      label: text(l.label),
      colour: colour(l.colour),
      width: Math.min(8, Math.max(0.5, Number(l.width) || 2)),
      dash: dash.length ? dash.slice(0, 4) : null,
      points: pts,
    });
  }
  for (const p of arr(doc.points)) {
    if (!isPair(p.at)) continue;
    points.push({ label: text(p.label), colour: p.colour ? colour(p.colour) : null, at: pair(p.at), class: text(p.class) || 'village' });
  }

  if (!areas.length && !circles.length && !lines.length && !points.length) return null;
  return { areas, circles, lines, points };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (v === null || v === undefined ? '' : String(v).slice(0, 80));
/** Only a plain hex colour is passed through; anything else falls back to the layer default. */
const colour = (v) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : null);

/** Every image in the folder, whether or not the manifest mentions it. */
export function extras(names, listed, { size }) {
  const out = [];
  for (const file of [...names].sort()) {
    if (listed.has(file.toLowerCase())) continue;
    if (!IMAGE_TYPES[path.extname(file).toLowerCase()]) continue;
    const name = file.replace(/\.[^.]+$/, '');
    out.push({
      kind: 'image',
      id: name,
      label: name.replace(/[-_]+/g, ' '),
      url: `/overlays/${encodeURIComponent(file)}`,
      bounds: [0, 0, size, size],
      opacity: 0.8,
      on: false,
      credit: null,
    });
  }
  return out;
}

/** Read the folder and the manifest and produce the list the page draws from. */
export async function listOverlays(dir, { world, size = 15360 } = {}) {
  const names = await safe(() => fsp.readdir(dir), []);
  const files = new Map(names.map((n) => [n.toLowerCase(), n]));
  const manifest = await safe(async () => JSON.parse(await fsp.readFile(path.join(dir, 'overlays.json'), 'utf8')), null);

  const entries = Array.isArray(manifest?.overlays) ? manifest.overlays : [];
  const listed = new Set(['overlays.json']);
  const out = [];
  const seen = new Set();

  for (const entry of entries) {
    if (entry?.file) listed.add(String(entry.file).toLowerCase());
    if (entry?.shapes) listed.add(String(entry.shapes).toLowerCase());
    const o = resolveOverlay(entry, { world, size, files });
    if (!o || seen.has(o.id)) continue;
    if (o.kind === 'shapes') {
      // Drawn layers are a few kilobytes, so they travel with the list instead of costing
      // the page a request each.
      const doc = await safe(async () => JSON.parse(await fsp.readFile(path.join(dir, files.get(o.shapes.toLowerCase()) || o.shapes), 'utf8')), null);
      const shapes = readShapes(doc);
      if (!shapes) continue;
      delete o.shapes;
      o.geometry = shapes;
    }
    seen.add(o.id);
    out.push(o);
  }
  for (const o of extras(names, listed, { size })) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
  }
  return out;
}
