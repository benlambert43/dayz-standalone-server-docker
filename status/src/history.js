// A tiny append-only time series on the status container's own volume.
//
// One line of JSON per sample. That is enough for the player-count chart and the uptime
// figures, it survives a restart of this container, and it needs no database. Old lines are
// dropped by rewriting the file once an hour, which costs a few milliseconds at this size.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { safe, stat } from './util.js';

export class History {
  constructor(dir, { days = 14 } = {}) {
    this.file = path.join(dir, 'history.jsonl');
    this.dir = dir;
    this.days = days;
    this.buffer = [];
    this.lastPrune = 0;
    this.ready = this.#init();
  }

  async #init() {
    await safe(() => fsp.mkdir(this.dir, { recursive: true }));
    const raw = await safe(() => fsp.readFile(this.file, 'utf8'), '');
    const cutoff = Date.now() - this.days * 86400000;
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue;
      const row = await safe(async () => JSON.parse(line), null);
      if (row && row.t >= cutoff) this.buffer.push(row);
    }
    this.buffer.sort((a, b) => a.t - b.t);
    return true;
  }

  /** Sample shape: { t, p (players), m (max), up (1/0), cpu, mem, rtt }. */
  async add(sample) {
    await this.ready;
    const row = { t: Date.now(), ...sample };
    this.buffer.push(row);
    await safe(() => fsp.appendFile(this.file, `${JSON.stringify(row)}\n`));
    if (Date.now() - this.lastPrune > 3600_000) await this.prune();
    return row;
  }

  async prune() {
    this.lastPrune = Date.now();
    const cutoff = Date.now() - this.days * 86400000;
    const before = this.buffer.length;
    this.buffer = this.buffer.filter((r) => r.t >= cutoff);
    if (this.buffer.length !== before) {
      const tmp = `${this.file}.tmp`;
      await safe(async () => {
        await fsp.writeFile(tmp, this.buffer.map((r) => JSON.stringify(r)).join('\n') + '\n');
        await fsp.rename(tmp, this.file);
      });
    }
  }

  /** Samples of the last `hours`, thinned to at most `points` for the chart. */
  series(hours = 24, points = 240) {
    const cutoff = Date.now() - hours * 3600000;
    const rows = this.buffer.filter((r) => r.t >= cutoff);
    if (rows.length <= points) return rows;
    const step = rows.length / points;
    const out = [];
    for (let i = 0; i < points; i++) {
      const slice = rows.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1));
      if (!slice.length) continue;
      out.push({
        t: slice[Math.floor(slice.length / 2)].t,
        p: Math.max(...slice.map((r) => r.p ?? 0)),
        up: slice.some((r) => r.up) ? 1 : 0,
        cpu: avg(slice.map((r) => r.cpu).filter(Number.isFinite)),
        mem: avg(slice.map((r) => r.mem).filter(Number.isFinite)),
        rtt: avg(slice.map((r) => r.rtt).filter(Number.isFinite)),
      });
    }
    return out;
  }

  stats(hours = 24) {
    const cutoff = Date.now() - hours * 3600000;
    const rows = this.buffer.filter((r) => r.t >= cutoff);
    if (!rows.length) return null;
    const ups = rows.filter((r) => r.up).length;
    const players = rows.map((r) => r.p ?? 0);
    return {
      samples: rows.length,
      availabilityPct: Math.round((ups / rows.length) * 1000) / 10,
      peakPlayers: Math.max(...players),
      avgPlayers: Math.round(avg(players) * 10) / 10,
      from: rows[0].t,
      to: rows[rows.length - 1].t,
    };
  }

  async size() {
    const st = await stat(this.file);
    return { file: this.file, bytes: st ? st.size : 0, rows: this.buffer.length };
  }
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
