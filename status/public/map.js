// The live map.
//
// There is no map image anywhere in this container: the background is drawn from the world
// coordinates of every building group in the mission's own mapgrouppos.xml, reduced to a
// density grid by the server. Settlements, industrial areas and the coast road come out of
// that on their own, and nothing copyrighted has to be shipped or downloaded.
//
// On top of that sit optional layers from public/overlays: drawn ones - place names, loot
// tiers, a route - given as polygons, circles, lines and points in world metres, and picture
// ones, an image placed by the world rectangle it covers. See src/overlays.js. Because a
// picture layer can be a busy photograph, everything drawn over it is drawn twice, once in
// near-black and once in its own colour, so a player marker reads the same on a dark forest
// and on a pale field.
//
// World axes: x runs east, z runs north. Canvas y is inverted so that north is up, exactly
// like the in-game map.

const TAU = Math.PI * 2;

const COLORS = {
  water: '#0b1316',
  land: '#151c17',
  void: '#090d0b',         // the backdrop when the drawn basemap is switched off
  building: '#5d7e65',
  player: '#a8ff5e',
  death: '#ff5347',
  spawn: '#ffc531',
  area: '#c88bff',
  measure: '#4fd2ff',
  shape: '#9fb8a6',        // a drawn layer that names no colour of its own
};

// A place label costs room, so each kind of place earns its name at a different zoom. The
// number is how many canvas pixels a kilometre takes up before the label is worth drawing;
// the whole world fits in about 91 of them, so cities and towns are all that show at first
// and the rest arrive as you go in.
const PLACE_ZOOM = { city: 0, town: 0, airfield: 70, military: 70, landmark: 110, village: 135 };

// Every marker is outlined in this before it is filled. It is what makes the map readable
// with a photograph underneath instead of only on the dark drawn background.
const INK = 'rgba(4,8,6,0.92)';
const INK_SOFT = 'rgba(4,8,6,0.45)';

const clamp01 = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : 0);

function transform(canvas, data, state) {
  const size = data.world.size || 15360;
  const base = canvas.width / size;
  const scale = base * state.zoom;
  // The canvas is 1400 px of world drawn into whatever width the card can spare, often little
  // more than half that. Markers and labels are sized in canvas pixels, so without this they
  // shrink with the card until the names are unreadable. `ui` holds their apparent size still.
  const ui = Math.min(2.6, Math.max(1, canvas.width / (canvas.clientWidth || canvas.width)));
  return {
    size, scale, ui,
    toX: (wx) => wx * scale + state.panX,
    toY: (wz) => canvas.height - (wz * scale + state.panY),
    fromX: (px) => (px - state.panX) / scale,
    fromZ: (py) => (canvas.height - py - state.panY) / scale,
  };
}

// ---------------------------------------------------------------- overlays ---
// One element per URL for the life of the page, so panning and zooming never refetch and a
// layer toggled off and on again is instant.
const images = new Map();

/**
 * The <img> for an overlay, loading it on first use. `onReady` is called once the image is
 * either decoded or known to be broken, which is the page's cue to draw again.
 */
export function overlayImage(url, onReady) {
  let rec = images.get(url);
  if (!rec) {
    const img = new Image();
    rec = { img, ready: false, failed: false, waiting: new Set() };
    images.set(url, rec);
    const settle = (key) => () => {
      rec[key] = true;
      for (const fn of rec.waiting) fn();
      rec.waiting.clear();
    };
    img.decoding = 'async';
    img.addEventListener('load', settle('ready'));
    img.addEventListener('error', settle('failed'));
    img.src = url;
  }
  // The map tab is rebuilt on every visit, so an image still in flight may owe a redraw to
  // more than one canvas - the discarded page's and the new one's.
  if (onReady && !rec.ready && !rec.failed) rec.waiting.add(onReady);
  return rec;
}

/** The overlays currently switched on, in manifest order, with their chosen opacity. */
export function activeOverlays(data, state) {
  const out = [];
  for (const o of data.overlays || []) {
    if (!state.overlay?.[o.id]) continue;
    const alpha = clamp01(state.opacity?.[o.id] ?? o.opacity);
    if (alpha <= 0) continue;
    out.push({ ...o, alpha, rec: o.kind === 'image' ? overlayImage(o.url, state.onOverlayLoad) : null });
  }
  return out;
}

function drawPicture(ctx, o, t) {
  if (!o.rec?.ready) return;
  const [x0, z0, x1, z1] = o.bounds;
  ctx.save();
  ctx.globalAlpha = o.alpha;
  ctx.imageSmoothingQuality = 'high';
  // The image's top row is north, which is also the canvas's top, so no flip is needed -
  // only the y of the northern edge, because canvas y grows the other way from world z.
  ctx.drawImage(o.rec.img, t.toX(x0), t.toY(z1), (x1 - x0) * t.scale, (z1 - z0) * t.scale);
  ctx.restore();
}

// A drawn layer gets the same treatment as a player marker: a dark spread under every stroke,
// then the colour inside it. That is what lets a tier boundary sit over a terrain photograph
// and over the bare drawn map without being restyled for either.
function drawShapes(ctx, o, t) {
  const g = o.geometry;
  if (!g) return;
  const u = t.ui;
  ctx.save();
  ctx.globalAlpha = o.alpha;

  for (const a of g.areas) {
    const c = a.colour || COLORS.shape;
    ctx.beginPath();
    a.polygon.forEach(([x, z], i) => (i ? ctx.lineTo(t.toX(x), t.toY(z)) : ctx.moveTo(t.toX(x), t.toY(z))));
    ctx.closePath();
    ctx.fillStyle = `${c}40`;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.5 * u;
    ctx.stroke();
    ctx.strokeStyle = `${c}cc`;
    ctx.lineWidth = 1.6 * u;
    ctx.stroke();
  }

  for (const c of g.circles) {
    const col = c.colour || COLORS.shape;
    ctx.beginPath();
    ctx.arc(t.toX(c.at[0]), t.toY(c.at[1]), Math.max(3 * u, c.radius * t.scale), 0, TAU);
    ctx.fillStyle = `${col}40`;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.5 * u;
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6 * u;
    ctx.stroke();
  }

  for (const l of g.lines) {
    ctx.beginPath();
    l.points.forEach(([x, z], i) => (i ? ctx.lineTo(t.toX(x), t.toY(z)) : ctx.moveTo(t.toX(x), t.toY(z))));
    ctx.setLineDash([]);
    ctx.strokeStyle = INK;
    ctx.lineWidth = (l.width + 2.2) * u;
    ctx.stroke();
    if (l.dash) ctx.setLineDash(l.dash.map((n) => n * u));
    ctx.strokeStyle = l.colour || COLORS.shape;
    ctx.lineWidth = l.width * u;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const p of g.points) {
    const x = t.toX(p.at[0]), y = t.toY(p.at[1]);
    ctx.beginPath();
    ctx.arc(x, y, 2.6 * u, 0, TAU);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3 * u;
    ctx.stroke();
    ctx.fillStyle = p.colour || COLORS.shape;
    ctx.fill();
  }

  // Labels last, and only where there is room for them, so a name never lands on the marker
  // that the next shape is about to draw. They also keep more of their opacity than the shapes
  // do: fading a tier layer back is meant to quieten the wash of colour, not to make the names
  // on it unreadable.
  ctx.globalAlpha = Math.min(1, o.alpha + 0.35);
  const km = t.scale * 1000;
  for (const a of g.areas) if (a.label && km > 24) label(ctx, a.label, t.toX(labelX(a)), t.toY(labelZ(a)), a.colour || COLORS.shape, u);
  for (const c of g.circles) {
    if (!c.label || km <= 30) continue;
    const r = Math.max(3 * u, c.radius * t.scale);
    label(ctx, c.label, t.toX(c.at[0]), t.toY(c.at[1]) - r - 6 * u, c.colour || COLORS.shape, u);
  }
  for (const l of g.lines) {
    if (!l.label || km <= 34) continue;
    const [x, z] = l.points[l.points.length - 1];
    label(ctx, l.label, t.toX(x), t.toY(z) - 10 * u, l.colour || COLORS.shape, u);
  }
  for (const p of g.points) {
    if (!p.label || km < (PLACE_ZOOM[p.class] ?? 58)) continue;
    label(ctx, p.label, t.toX(p.at[0]), t.toY(p.at[1]) - 8 * u, p.colour || COLORS.shape, u);
  }
  ctx.restore();
}

// The average of the vertices is good enough for a compact shape and hopeless for a long
// one, which is why a shapes file may say where its name belongs instead.
const labelX = (a) => (a.labelAt ? a.labelAt[0] : a.polygon.reduce((n, p) => n + p[0], 0) / a.polygon.length);
const labelZ = (a) => (a.labelAt ? a.labelAt[1] : a.polygon.reduce((n, p) => n + p[1], 0) / a.polygon.length);

// -------------------------------------------------------------------- draw ---
export function drawMap(canvas, data, state) {
  const ctx = canvas.getContext('2d');
  const t = transform(canvas, data, state);
  const shown = activeOverlays(data, state);
  const overPicture = shown.some((o) => o.rec?.ready);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.fillStyle = state.basemap ? COLORS.water : COLORS.void;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.basemap) {
    ctx.fillStyle = COLORS.land;
    ctx.fillRect(t.toX(0), t.toY(t.size), t.size * t.scale, t.size * t.scale);
  }

  for (const o of shown) if (o.kind === 'image') drawPicture(ctx, o, t);

  // A wash over the picture layers only. Pulling a photograph down a third costs nothing in
  // legibility for the picture and buys a great deal for everything drawn on top of it.
  const dim = overPicture ? clamp01(state.dim) : 0;
  if (dim > 0) {
    ctx.fillStyle = `rgba(6,10,8,${dim.toFixed(3)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Under a terrain render the density grid is confirmation, not the map, so it steps back.
  if (state.basemap && data.density && data.density.grid) drawDensity(ctx, data.density, t, overPicture ? 0.38 : 0.85);
  drawGrid(ctx, canvas, t, overPicture);

  // Drawn layers sit above the grid and below anything live: a tier boundary is background to
  // a player, however much of the map it covers.
  for (const o of shown) if (o.kind === 'shapes') drawShapes(ctx, o, t);

  if (state.areas && data.areas?.areas) drawAreas(ctx, data.areas.areas, t);
  if (state.spawns && data.spawns?.points) drawSpawns(ctx, data.spawns.points, t);
  if (state.trails && data.recent) drawTrail(ctx, data.recent, t);
  if (state.deaths && data.deaths) drawDeaths(ctx, data.deaths, t);
  if (state.players && data.players) drawPlayers(ctx, data.players, t);
  if (state.measureFrom && state.measureTo) drawMeasure(ctx, t, state);

  ctx.restore();
}

function drawDensity(ctx, density, t, strength) {
  const { cells, grid, peak } = density;
  const cell = (density.worldSize / cells) * t.scale;
  if (!peak) return;
  for (let z = 0; z < cells; z++) {
    for (let x = 0; x < cells; x++) {
      const v = grid[z * cells + x];
      if (!v) continue;
      // Square root keeps a village visible next to a city instead of washing it out.
      const a = Math.min(1, Math.sqrt(v / peak) * 1.35);
      ctx.fillStyle = `rgba(93,126,101,${(a * strength).toFixed(3)})`;
      const px = t.toX((x / cells) * density.worldSize);
      const py = t.toY(((z + 1) / cells) * density.worldSize);
      ctx.fillRect(px, py, cell + 0.6, cell + 0.6);
    }
  }
}

function drawGrid(ctx, canvas, t, overPicture) {
  const step = t.scale * 1000 < 28 ? 5000 : 1000;      // 1 km squares, 5 km when zoomed out
  const u = t.ui;
  const marks = [];
  ctx.beginPath();
  for (let v = 0; v <= t.size; v += step) {
    const x = t.toX(v), y = t.toY(v);
    ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height);
    ctx.moveTo(0, y); ctx.lineTo(canvas.width, y);
    marks.push({ v, x, y });
  }
  // The same path twice: a dark spread first, then a hairline of light inside it. On a photo
  // that reads as a crisp line; on the drawn background it is indistinguishable from one.
  ctx.strokeStyle = overPicture ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 3 * u;
  ctx.stroke();
  ctx.strokeStyle = overPicture ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1 * u;
  ctx.stroke();

  ctx.font = `${(10 * u).toFixed(1)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const m of marks) {
    const text = String(m.v / 1000).padStart(3, '0');
    if (m.x > 14 * u && m.x < canvas.width - 14 * u) tick(ctx, text, m.x + 4 * u, 13 * u, u);
    if (m.y > 14 * u && m.y < canvas.height - 6 * u) tick(ctx, text, 4 * u, m.y - 4 * u, u);
  }
}

/** A grid number on its own dark plate, so it survives a pale field underneath. */
function tick(ctx, text, x, y, u) {
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(6,10,8,0.72)';
  ctx.fillRect(x - 2 * u, y - 9.5 * u, w + 4 * u, 12 * u);
  ctx.fillStyle = 'rgba(232,242,233,0.82)';
  ctx.fillText(text, x, y);
}

function drawAreas(ctx, areas, t) {
  const u = t.ui;
  for (const a of areas) {
    const r = Math.max(3 * u, a.radius * t.scale);
    const x = t.toX(a.x), y = t.toY(a.z);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = `${COLORS.area}26`;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4 * u;
    ctx.stroke();
    ctx.strokeStyle = COLORS.area;
    ctx.lineWidth = 1.8 * u;
    ctx.stroke();
    if (t.scale * 1000 > 40) label(ctx, a.name, x, y - r - 6 * u, COLORS.area, u);
  }
}

function drawSpawns(ctx, points, t) {
  ctx.beginPath();
  for (const p of points) diamond(ctx, t.toX(p.x), t.toY(p.z), 3.6 * t.ui);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3 * t.ui;
  ctx.stroke();
  ctx.fillStyle = COLORS.spawn;
  ctx.fill();
}

function drawTrail(ctx, recent, t) {
  ctx.beginPath();
  let first = true;
  for (const e of recent) {
    const x = t.toX(e.x), y = t.toY(e.z);
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
  }
  ctx.strokeStyle = INK_SOFT;
  ctx.lineWidth = 3 * t.ui;
  ctx.stroke();
  ctx.strokeStyle = `${COLORS.player}66`;
  ctx.lineWidth = 1.2 * t.ui;
  ctx.stroke();
}

// A cross, not a dot: shape carries where colour may not, and a red dot on a brown field is
// exactly the case this map has to survive.
function drawDeaths(ctx, deaths, t) {
  const r = 3.6 * t.ui;
  ctx.beginPath();
  for (const d of deaths) {
    const x = t.toX(d.x), y = t.toY(d.z);
    ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4.5 * t.ui;
  ctx.stroke();
  ctx.strokeStyle = COLORS.death;
  ctx.lineWidth = 2.1 * t.ui;
  ctx.stroke();
}

function drawPlayers(ctx, players, t) {
  const u = t.ui;
  for (const p of players) {
    const x = t.toX(p.x), y = t.toY(p.z);
    ctx.beginPath();
    ctx.arc(x, y, 9 * u, 0, TAU);
    ctx.fillStyle = INK_SOFT;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, 4.6 * u, 0, TAU);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4 * u;
    ctx.stroke();
    ctx.fillStyle = COLORS.player;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.3 * u;
    ctx.stroke();
  }
  // Names after every marker, so one player's label never hides another's position.
  for (const p of players) label(ctx, p.name, t.toX(p.x), t.toY(p.z) - 12 * u, COLORS.player, u);
}

function diamond(ctx, x, y, r) {
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A name on its own plate. An outline alone disappears over a busy photograph; a plate does not. */
function label(ctx, text, x, y, color, u = 1) {
  if (!text) return;
  const max = 170 * u;
  ctx.font = `600 ${(11 * u).toFixed(1)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const w = Math.min(max, ctx.measureText(text).width);
  roundRect(ctx, x - w / 2 - 5 * u, y - 11 * u, w + 10 * u, 15 * u, 4 * u);
  ctx.fillStyle = 'rgba(6,10,8,0.85)';
  ctx.fill();
  ctx.strokeStyle = `${color}59`;
  ctx.lineWidth = 1 * u;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y, max);
  ctx.textAlign = 'left';
}

function drawMeasure(ctx, t, state) {
  const a = state.measureFrom, b = state.measureTo;
  const u = t.ui;
  const ax = t.toX(a.x), ay = t.toY(a.z), bx = t.toX(b.x), by = t.toY(b.z);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4 * u;
  ctx.stroke();
  ctx.setLineDash([6 * u, 4 * u]);
  ctx.strokeStyle = COLORS.measure;
  ctx.lineWidth = 1.6 * u;
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [x, y] of [[ax, ay], [bx, by]]) {
    ctx.beginPath();
    ctx.arc(x, y, 3 * u, 0, TAU);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3 * u;
    ctx.stroke();
    ctx.fillStyle = COLORS.measure;
    ctx.fill();
  }
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  label(ctx, `${Math.round(d)} m`, (ax + bx) / 2, (ay + by) / 2 - 6 * u, COLORS.measure, u);
}

/** Pan, zoom, a coordinate read-out and a two-click distance measure. */
export function attachMapInteraction(canvas, data, state, redraw, hud) {
  const px = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * canvas.width, y: ((ev.clientY - r.top) / r.height) * canvas.height };
  };
  let dragging = null, moved = 0;

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    dragging = { ...px(ev), panX: state.panX, panY: state.panY };
    moved = 0;
  });
  canvas.addEventListener('pointermove', (ev) => {
    const p = px(ev);
    const t = transform(canvas, data, state);
    if (dragging) {
      state.panX = dragging.panX + (p.x - dragging.x);
      state.panY = dragging.panY - (p.y - dragging.y);
      moved += Math.abs(p.x - dragging.x) + Math.abs(p.y - dragging.y);
      redraw();
    }
    const wx = Math.round(t.fromX(p.x)), wz = Math.round(t.fromZ(p.y));
    const near = nearest(data, wx, wz, 120 / t.scale);
    hud.textContent = `${wx}, ${wz}   grid ${String(Math.floor(wx / 100)).padStart(3, '0')} ${String(Math.floor(wz / 100)).padStart(3, '0')}`
      + (near ? `   • ${near}` : '');
  });
  const stop = (ev) => {
    if (dragging && moved < 4) {
      const t = transform(canvas, data, state);
      const p = px(ev);
      const point = { x: t.fromX(p.x), z: t.fromZ(p.y) };
      if (!state.measureFrom || state.measureTo) { state.measureFrom = point; state.measureTo = null; }
      else state.measureTo = point;
      redraw();
    }
    dragging = null;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', () => { dragging = null; });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = px(ev);
    const before = transform(canvas, data, state);
    const wx = before.fromX(p.x), wz = before.fromZ(p.y);
    state.zoom = Math.min(24, Math.max(1, state.zoom * (ev.deltaY < 0 ? 1.2 : 1 / 1.2)));
    const after = transform(canvas, data, state);
    state.panX += p.x - after.toX(wx);
    state.panY -= p.y - after.toY(wz);
    redraw();
  }, { passive: false });
}

function nearest(data, wx, wz, radius) {
  let best = null, bestD = radius;
  const consider = (label, x, z) => {
    const d = Math.hypot(x - wx, z - wz);
    if (d < bestD) { bestD = d; best = `${label} (${Math.round(d)} m)`; }
  };
  for (const p of data.players || []) consider(p.name, p.x, p.z);
  for (const d of data.deaths || []) consider(`death: ${d.name}`, d.x, d.z);
  for (const a of data.areas?.areas || []) consider(a.name, a.x, a.z);
  return best;
}
