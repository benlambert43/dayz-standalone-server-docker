// Docker Engine API over the unix socket, dependency free.
//
// The socket is mounted read-only and the process runs unprivileged, but it is still the
// most powerful thing this container touches, so only GET endpoints are implemented here.
// There is deliberately no exec, no start/stop and no image handling: the status page
// observes the stack, it never changes it.
import http from 'node:http';
import { safe } from './util.js';

export class Docker {
  constructor(socketPath = '/var/run/docker.sock') {
    this.socketPath = socketPath;
    this.available = null;      // null = not probed yet
    this.lastError = null;
  }

  request(path, { timeout = 4000, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path, method: 'GET', timeout }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            return reject(new Error(`docker ${path} -> HTTP ${res.statusCode}: ${body.toString('utf8').slice(0, 200)}`));
          }
          if (raw) return resolve(body);
          try { resolve(body.length ? JSON.parse(body.toString('utf8')) : null); }
          catch (e) { reject(new Error(`docker ${path}: unparsable answer (${e.message})`)); }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`docker ${path}: timed out after ${timeout} ms`)));
      req.on('error', reject);
      req.end();
    });
  }

  async probe() {
    try {
      const v = await this.request('/version');
      this.available = true; this.lastError = null;
      return { ok: true, version: v.Version, apiVersion: v.ApiVersion, os: v.Os, arch: v.Arch, kernel: v.KernelVersion };
    } catch (err) {
      this.available = false; this.lastError = err.message;
      return { ok: false, error: err.message };
    }
  }

  info() { return safe(() => this.request('/info'), null); }

  /** Every container of one compose project, running or not. */
  async projectContainers(project) {
    const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
    return this.request(`/containers/json?all=1&filters=${filters}`);
  }

  inspect(id) { return this.request(`/containers/${encodeURIComponent(id)}/json`); }
  top(id) { return this.request(`/containers/${encodeURIComponent(id)}/top?ps_args=${encodeURIComponent('-eo pid,user,pcpu,pmem,rss,etime,args')}`); }
  stats(id) { return this.request(`/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=false`, { timeout: 8000 }); }

  /**
   * `docker logs`, de-multiplexed. Without a TTY the stream is framed: 8 bytes of header
   * (stream id, three pad bytes, big-endian length) in front of every chunk.
   */
  async logs(id, { tail = 400, since = 0 } = {}) {
    const q = `stdout=1&stderr=1&timestamps=1&tail=${Number(tail) || 200}${since ? `&since=${Math.floor(since)}` : ''}`;
    const buf = await this.request(`/containers/${encodeURIComponent(id)}/logs?${q}`, { raw: true, timeout: 8000 });
    const lines = [];
    let i = 0;
    const framed = buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
    if (!framed) {
      for (const l of buf.toString('utf8').split('\n')) if (l) lines.push({ stream: 'stdout', text: l });
      return lines;
    }
    while (i + 8 <= buf.length) {
      const stream = buf[i] === 2 ? 'stderr' : 'stdout';
      const len = buf.readUInt32BE(i + 4);
      i += 8;
      if (len < 0 || i + len > buf.length) break;
      const text = buf.toString('utf8', i, i + len);
      i += len;
      for (const l of text.split('\n')) if (l.length) lines.push({ stream, text: l });
    }
    return lines;
  }
}

/** Docker's raw stats blob turned into the four numbers a dashboard actually shows. */
export function summariseStats(s) {
  if (!s || !s.cpu_stats) return null;
  const cpuDelta = (s.cpu_stats.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage?.percpu_usage?.length || 1;
  // `docker stats` convention: 100 % is one fully busy core, so the ceiling is cpus * 100.
  // The share of the whole machine is the more useful number for a capacity check, so both
  // are reported and the UI labels which is which.
  const cpuPct = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;

  // `cache` is page cache the kernel would drop under pressure; counting it as used makes
  // every long-running container look like it is about to run out of memory.
  const mem = s.memory_stats || {};
  const cache = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0;
  const memUsed = Math.max(0, (mem.usage ?? 0) - cache);
  const memLimit = mem.limit ?? null;

  let rx = 0, tx = 0;
  for (const nic of Object.values(s.networks || {})) { rx += nic.rx_bytes || 0; tx += nic.tx_bytes || 0; }

  let ioRead = 0, ioWrite = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive || []) {
    if (/^read$/i.test(e.op)) ioRead += e.value || 0;
    if (/^write$/i.test(e.op)) ioWrite += e.value || 0;
  }

  return {
    cpuPct: Math.round(cpuPct * 10) / 10,
    cpuPctOfHost: Math.round((cpuPct / cpus) * 10) / 10,
    cpus,
    memUsed,
    memLimit,
    memPct: memLimit ? Math.round((memUsed / memLimit) * 1000) / 10 : null,
    pids: s.pids_stats?.current ?? null,
    pidsLimit: s.pids_stats?.limit ?? null,
    netRx: rx, netTx: tx,
    ioRead, ioWrite,
  };
}

/** The parts of `docker inspect` the status page shows, with the environment redacted. */
export function summariseInspect(c, redactEnvList) {
  if (!c) return null;
  const state = c.State || {};
  const health = state.Health || null;
  return {
    id: c.Id,
    name: (c.Name || '').replace(/^\//, ''),
    image: c.Config?.Image,
    imageId: c.Image,
    created: c.Created,
    status: state.Status,
    running: !!state.Running,
    paused: !!state.Paused,
    restarting: !!state.Restarting,
    oomKilled: !!state.OOMKilled,
    dead: !!state.Dead,
    pid: state.Pid || null,
    exitCode: state.ExitCode,
    startedAt: state.StartedAt,
    finishedAt: state.FinishedAt,
    restartCount: c.RestartCount ?? 0,
    health: health && {
      status: health.Status,
      failingStreak: health.FailingStreak,
      log: (health.Log || []).slice(-6).map((l) => ({
        start: l.Start, end: l.End, exitCode: l.ExitCode, output: String(l.Output || '').trim().slice(0, 500),
      })),
    },
    restartPolicy: c.HostConfig?.RestartPolicy?.Name || null,
    memLimit: c.HostConfig?.Memory || 0,
    nanoCpus: c.HostConfig?.NanoCpus || 0,
    capDrop: c.HostConfig?.CapDrop || [],
    capAdd: c.HostConfig?.CapAdd || [],
    securityOpt: c.HostConfig?.SecurityOpt || [],
    ports: Object.entries(c.NetworkSettings?.Ports || {}).map(([k, v]) => ({
      container: k, host: (v || []).map((b) => `${b.HostIp}:${b.HostPort}`).join(', ') || null,
    })),
    mounts: (c.Mounts || []).map((m) => ({ type: m.Type, source: m.Name || m.Source, target: m.Destination, rw: m.RW })),
    networks: Object.entries(c.NetworkSettings?.Networks || {}).map(([k, v]) => ({ name: k, ip: v.IPAddress, gateway: v.Gateway })),
    env: redactEnvList(c.Config?.Env),
    labels: c.Config?.Labels || {},
    entrypoint: c.Config?.Entrypoint || [],
    cmd: c.Config?.Cmd || [],
    logDriver: c.HostConfig?.LogConfig?.Type || null,
  };
}
