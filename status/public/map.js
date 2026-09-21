// The live map.
//
// There is no map image anywhere in this container: the background is drawn from the world
// coordinates of every building group in the mission's own mapgrouppos.xml, reduced to a
// density grid by the server. Settlements, industrial areas and the coast road come out of
// that on their own, and nothing copyrighted has to be shipped or downloaded.
//
// World axes: x runs east, z runs north. Canvas y is inverted so that north is up, exactly
// like the in-game map.

const COLORS = {
  water: '#0d1417',
  land: '#151c17',
  building: '#3d5545',
  grid: '#ffffff12',
  gridText: '#ffffff44',
  player: '#8fbc6a',
  death: '#d96a5f',
  spawn: '#c8a24a',
  area: '#9b6ad9',
  measure: '#6fa8c9',
};

function transform(canvas, data, state) {
  const size = data.world.size || 15360;
  const base = canvas.width / size;
  const scale = base * state.zoom;
  return {
    size, scale,
    toX: (wx) => wx * scale + state.panX,
    toY: (wz) => canvas.height - (wz * scale + state.panY),
    fromX: (px) => (px - state.panX) / scale,
    fromZ: (py) => (canvas.height - py - state.panY) / scale,
  };
}

export function drawMap(canvas, data, state) {
  const ctx = canvas.getContext('2d');
  const t = transform(canvas, data, state);
  ctx.save();
  ctx.fillStyle = COLORS.water;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // land plate
  ctx.fillStyle = COLORS.land;
  ctx.fillRect(t.toX(0), t.toY(t.size), t.size * t.scale, t.size * t.scale);

  if (state.buildings && data.density && data.density.grid) drawDensity(ctx, data.density, t);
  drawGrid(ctx, canvas, t);

  if (state.areas && data.areas?.areas) {
    for (const a of data.areas.areas) {
      const r = Math.max(2, a.radius * t.scale);
      ctx.beginPath();
      ctx.arc(t.toX(a.x), t.toY(a.z), r, 0, Math.PI * 2);
      ctx.fillStyle = `${COLORS.area}22`;
      ctx.fill();
      ctx.strokeStyle = `${COLORS.area}aa`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (t.scale * 1000 > 40) label(ctx, a.name, t.toX(a.x), t.toY(a.z) - r - 4, COLORS.area);
    }
  }

  if (state.spawns && data.spawns?.points) {
    ctx.fillStyle = `${COLORS.spawn}cc`;
    for (const p of data.spawns.points) {
      ctx.beginPath();
      ctx.arc(t.toX(p.x), t.toY(p.z), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (state.trails && data.recent) {
    ctx.strokeStyle = '#8fbc6a33';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let first = true;
    for (const e of data.recent) {
      const x = t.toX(e.x), y = t.toY(e.z);
      first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      first = false;
    }
    ctx.stroke();
  }

  if (state.deaths && data.deaths) {
    for (const d of data.deaths) {
      ctx.beginPath();
      ctx.arc(t.toX(d.x), t.toY(d.z), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = `${COLORS.death}bb`;
      ctx.fill();
    }
  }

  if (state.players && data.players) {
    for (const p of data.players) {
      const x = t.toX(p.x), y = t.toY(p.z);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = `${COLORS.player}33`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.player;
      ctx.fill();
      label(ctx, p.name, x, y - 9, COLORS.player);
    }
  }

  if (state.measureFrom && state.measureTo) drawMeasure(ctx, t, state);
  ctx.restore();
}

function drawDensity(ctx, density, t) {
  const { cells, grid, peak } = density;
  const cell = (density.worldSize / cells) * t.scale;
  if (!peak) return;
  for (let z = 0; z < cells; z++) {
    for (let x = 0; x < cells; x++) {
      const v = grid[z * cells + x];
      if (!v) continue;
      // Square root keeps a village visible next to a city instead of washing it out.
      const a = Math.min(1, Math.sqrt(v / peak) * 1.35);
      ctx.fillStyle = `rgba(93,126,101,${(a * 0.85).toFixed(3)})`;
      const px = t.toX((x / cells) * density.worldSize);
      const py = t.toY(((z + 1) / cells) * density.worldSize);
      ctx.fillRect(px, py, cell + 0.6, cell + 0.6);
    }
  }
}

function drawGrid(ctx, canvas, t) {
  const step = t.scale * 1000 < 28 ? 5000 : 1000;      // 1 km squares, 5 km when zoomed out
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = COLORS.gridText;
  for (let v = 0; v <= t.size; v += step) {
    const x = t.toX(v), y = t.toY(v);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    if (x > 14 && x < canvas.width - 14) ctx.fillText(String(v / 1000).padStart(3, '0'), x + 3, 12);
    if (y > 14 && y < canvas.height - 6) ctx.fillText(String(v / 1000).padStart(3, '0'), 3, y - 3);
  }
}

function label(ctx, text, x, y, color) {
  if (!text) return;
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#0b0f0ccc';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

function drawMeasure(ctx, t, state) {
  const a = state.measureFrom, b = state.measureTo;
  ctx.strokeStyle = COLORS.measure;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(t.toX(a.x), t.toY(a.z));
  ctx.lineTo(t.toX(b.x), t.toY(b.z));
  ctx.stroke();
  ctx.setLineDash([]);
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  label(ctx, `${Math.round(d)} m`, (t.toX(a.x) + t.toX(b.x)) / 2, (t.toY(a.z) + t.toY(b.z)) / 2 - 6, COLORS.measure);
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
      + (near ? `   \u2022 ${near}` : '');
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
