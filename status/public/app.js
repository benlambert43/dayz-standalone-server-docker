// The whole front end: a hash router, one renderer per tab and a server-sent-event stream
// that keeps the header and the overview live. No build step and no framework, so the file
// you read here is the file the browser runs.
import { drawMap, attachMapInteraction } from './map.js';

// ------------------------------------------------------------------- basics --
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const raw = (v) => ({ __raw: true, v });
const html = (strings, ...vals) => strings.reduce(
  (out, s, i) => out + s + (i < vals.length ? (vals[i] && vals[i].__raw ? vals[i].v : esc(vals[i])) : ''), '');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
  redact: localStorage.getItem('dayz-status-redact') === '1',
  summary: null,
  settings: null,
  tab: null,
};

async function api(pathname, params = {}) {
  const u = new URL(pathname, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  if (store.redact) u.searchParams.set('redact', '1');
  const res = await fetch(u, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

// ------------------------------------------------------------------ format ---
const N = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '-');
function bytes(b) {
  if (!Number.isFinite(Number(b))) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(b), i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function dur(s) {
  if (!Number.isFinite(Number(s))) return '-';
  let n = Math.max(0, Math.round(s));
  const d = Math.floor(n / 86400); n -= d * 86400;
  const h = Math.floor(n / 3600); n -= h * 3600;
  const m = Math.floor(n / 60); n -= m * 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${n}s`;
  return `${n}s`;
}
const when = (ms) => (ms ? new Date(ms).toLocaleString() : '-');
const since = (ms) => (ms ? dur((Date.now() - ms) / 1000) : '-');
const until = (ms) => (ms ? (ms > Date.now() ? dur((ms - Date.now()) / 1000) : 'due now') : '-');
const tsLabel = (ts) => String(ts || '').replace('T', ' ').slice(-8);
const badge = (status, text) => html`<span class="badge ${status}">${text ?? status}</span>`;

function card(title, bodyHtml, { tools = '', flush = false, cls = '' } = {}) {
  return html`<section class="card ${raw(cls)}">
    <h2>${title}${raw(tools ? `<span class="tools">${tools}</span>` : '')}</h2>
    <div class="body ${raw(flush ? 'flush' : '')}">${raw(bodyHtml)}</div>
  </section>`;
}
function kv(pairs) {
  const rows = pairs.filter(Boolean).map(([k, v]) => html`<dt>${k}</dt><dd>${raw(v && v.__raw ? v.v : esc(v ?? '-'))}</dd>`).join('');
  return `<dl class="kv">${rows}</dl>`;
}
function table(cols, rows, { sortable = true, empty = 'nothing to show' } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const head = cols.map((c, i) => html`<th class="${raw(c.num ? 'num ' : '')}${raw(sortable ? '' : 'nosort')}" data-col="${i}">${c.label}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => {
    const v = c.get(r);
    return html`<td class="${raw((c.num ? 'num ' : '') + (c.mono ? 'mono' : ''))}">${raw(v && v.__raw ? v.v : esc(v ?? ''))}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Click-to-sort for every table this file renders.
document.addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-col]');
  if (!th || th.classList.contains('nosort')) return;
  const tableEl = th.closest('table');
  const idx = Number(th.dataset.col);
  const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
  $$('th', tableEl).forEach((x) => delete x.dataset.dir);
  th.dataset.dir = dir;
  const body = $('tbody', tableEl);
  const rows = [...body.rows];
  const val = (tr) => {
    const raw = tr.cells[idx]?.textContent.trim() ?? '';
    const n = Number(raw.replace(/[^\d.eE+-]/g, ''));
    return raw !== '' && Number.isFinite(n) && /\d/.test(raw) ? n : raw.toLowerCase();
  };
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return dir === 'asc' ? c : -c;
  });
  rows.forEach((r) => body.appendChild(r));
});

// ------------------------------------------------------------------ header ---
function renderHeader(summary) {
  const s = summary.snapshot, h = summary.health;
  const info = s.query.info?.ok ? s.query.info : null;
  const name = info?.name || s.docker?.dayz?.name || 'DayZ server';
  $('#server-name').textContent = name;

  const bits = [
    s.world?.label,
    s.branch,
    s.build?.rpt?.version ? `v${s.build.rpt.version}` : info?.version ? `v${info.version}` : null,
    s.supervisor?.state,
  ].filter(Boolean);
  $('#server-sub').textContent = bits.join(' \u00b7 ');

  const dot = $('#live-dot');
  dot.className = `dot ${h.overall}`;
  dot.title = `${h.counts.fail} failing, ${h.counts.warn} warning, ${h.counts.ok} ok`;

  const stat = (label, value, title = '') => html`<div class="topstat" title="${title}"><b>${value}</b><span>${label}</span></div>`;
  $('#topstats').innerHTML = [
    stat('players', `${s.players.count ?? '-'}/${s.players.max ?? '-'}`, 'From the Steam query'),
    stat('server up', dur(s.uptime.serverSeconds), `Process started ${when(s.uptime.serverStartedAt)}`),
    stat('container up', dur(s.uptime.containerSeconds), `Container started ${when(s.uptime.containerStartedAt)}`),
    s.clock ? stat('in game', `${s.clock.time.slice(0, 5)} ${s.clock.night ? '\u263e' : '\u2600'}`, `Estimated from ${s.clock.basis}`) : '',
    stat('restart in', until(s.uptime.restartDueAt), 'Scheduled restart, deferred while players are online'),
    stat('checks', `${h.counts.fail}F ${h.counts.warn}W`, `${h.total} checks`),
  ].join('');

  $('#foot-left').textContent = `updated ${new Date(s.at).toLocaleTimeString()} \u00b7 status page up ${dur(s.statusPage.uptimeSeconds)}`;
  $('#foot-right').textContent = `${s.query.host}:${s.query.port}/udp \u00b7 ${s.docker.ok ? `docker ${s.docker.version?.version}` : 'no docker socket'}`;
}

// -------------------------------------------------------------------- tabs ---
const TABS = [];
const tab = (id, label, render) => TABS.push({ id, label, render });

function renderTabs() {
  $('#tabs').innerHTML = TABS.map((t) => html`<a href="#${t.id}" data-tab="${t.id}" class="${raw(store.tab === t.id ? 'active' : '')}">${t.label}</a>`).join('');
}

async function show(id) {
  const t = TABS.find((x) => x.id === id) || TABS[0];
  store.tab = t.id;
  renderTabs();
  const view = $('#view');
  view.innerHTML = '<div class="loading">Loading&hellip;</div>';
  try {
    await t.render(view);
  } catch (err) {
    view.innerHTML = card('Could not load this tab', html`<p>${err.message}</p>
      <p class="note">The rest of the page still works. If this keeps happening, look at the status container log:
      <code>docker-compose logs status</code></p>`);
  }
}

// ---------------------------------------------------------------- overview ---
function sparkline(series, key, { height = 56, color = 'var(--accent)', max = null } = {}) {
  if (!series.length) return '<div class="empty">no samples yet</div>';
  const w = 600, h = height, pad = 2;
  const top = max ?? Math.max(1, ...series.map((r) => r[key] ?? 0));
  const x = (i) => pad + (i / Math.max(1, series.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v ?? 0) / top) * (h - 2 * pad);
  const pts = series.map((r, i) => `${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const area = `${x(0).toFixed(1)},${h - pad} ${pts} ${x(series.length - 1).toFixed(1)},${h - pad}`;
  const gaps = series.map((r, i) => (r.up ? '' : `<rect x="${x(i) - 1}" y="0" width="2" height="${h}" fill="var(--fail)" opacity=".28"/>`)).join('');
  const seen = Math.max(0, ...series.map((r) => r[key] ?? 0));
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="players over time">
    ${gaps}
    <polygon points="${area}" fill="${color}" opacity=".16"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
  </svg><div class="note">highest ${seen}, scale to ${top} \u00b7 red bands are periods when the server did not answer</div>`;
}

tab('overview', 'Overview', async (view) => {
  const [summary, hist, people] = await Promise.all([
    api('/api/summary'), api('/api/history', { hours: 24 }), api('/api/players'),
  ]);
  store.summary = summary;
  renderHeader(summary);
  const s = summary.snapshot, h = summary.health;
  const info = s.query.info?.ok ? s.query.info : null;

  const groupPills = h.groups.map((g) => badge(g.status, `${g.name}`)).join(' ');
  const onlineRows = people.online.slice(0, 20);

  const cards = [
    card('Right now', kv([
      ['State', raw(badge(h.overall, s.supervisor?.state || 'unknown'))],
      ['Players', `${s.players.count ?? '-'} of ${s.players.max ?? '-'}`],
      ['Map', `${s.world?.label ?? '-'} (${s.world?.size ?? '?'} m)`],
      ['Mission', s.mission?.active || s.mission?.name || '-'],
      ['Branch', s.branch],
      ['Game version', s.build?.rpt?.version || info?.version || '-'],
      ['Steam build', s.build?.manifest?.buildId || '-'],
      ['Password', info ? (info.passworded ? 'yes' : 'no') : '-'],
      ['BattlEye', info?.tags?.some((t) => t.raw === 'battleye') ? 'on' : 'not advertised'],
      s.clock && ['In-game time', `${s.clock.date} ${s.clock.time} (${s.clock.phase}, ${s.clock.accelerationNow}x) \u2013 estimated`],
    ]), { tools: groupPills }),

    card('Uptime and restarts', kv([
      ['Container up', `${dur(s.uptime.containerSeconds)} \u00b7 since ${when(s.uptime.containerStartedAt)}`],
      ['Server process up', `${dur(s.uptime.serverSeconds)} \u00b7 since ${when(s.uptime.serverStartedAt)}`],
      ['Mission load time', s.uptime.missionReadySeconds ? `${s.uptime.missionReadySeconds} s` : '-'],
      ['Scheduled restart', s.uptime.restartIntervalSeconds ? `every ${dur(s.uptime.restartIntervalSeconds)}` : 'disabled'],
      ['Next restart', s.uptime.restartDueAt ? `${until(s.uptime.restartDueAt)} (waits for an empty server until ${when(s.uptime.restartDeadlineAt)})` : '-'],
      ['Docker restarts', String(s.docker.dayz?.restartCount ?? '-')],
      ['Failed starts', String(s.crashBackoff?.startsSinceHealthy ?? '-')],
      ['Availability 24 h', hist.stats24 ? `${hist.stats24.availabilityPct}% of ${hist.stats24.samples} samples` : 'not enough history yet'],
    ])),

    card('Players over 24 hours', sparkline(hist.series, 'p', { max: s.players.max || null }),
      { tools: hist.stats24 ? `<span class="pill">peak ${hist.stats24.peakPlayers}</span><span class="pill">avg ${hist.stats24.avgPlayers}</span>` : '' }),

    card('Resources', s.docker.stats ? kv([
      ['CPU', raw(`${N(s.docker.stats.cpuPct, 1)} % of one core \u00b7 ${N(s.docker.stats.cpuPctOfHost, 1)} % of the machine (${s.docker.stats.cpus} cores)
        <div class="bar"><i class="${(s.docker.stats.cpuPctOfHost ?? 0) > 85 ? 'fail' : (s.docker.stats.cpuPctOfHost ?? 0) > 60 ? 'warn' : ''}" style="width:${Math.min(100, s.docker.stats.cpuPctOfHost ?? 0)}%"></i></div>`)],
      ['Memory', raw(`${bytes(s.docker.stats.memUsed)}${s.docker.stats.memLimit ? ` of ${bytes(s.docker.stats.memLimit)}` : ''}
        <div class="bar"><i class="${(s.docker.stats.memPct ?? 0) > 90 ? 'fail' : (s.docker.stats.memPct ?? 0) > 75 ? 'warn' : ''}" style="width:${s.docker.stats.memPct ?? 0}%"></i></div>`)],
      ['Processes', String(s.docker.stats.pids ?? '-')],
      ['Network', `${bytes(s.docker.stats.netRx)} in / ${bytes(s.docker.stats.netTx)} out`],
      ['Disk I/O', `${bytes(s.docker.stats.ioRead)} read / ${bytes(s.docker.stats.ioWrite)} written`],
      ['Data volume', s.storage?.dataDisk ? `${bytes(s.storage.dataDisk.free)} free (${s.storage.dataDisk.usedPct}% used)` : '-'],
    ]) : `<div class="empty">${esc(s.docker.error || 'no Docker stats')}</div>`),

    card('Online now', onlineRows.length
      ? table([
        { label: 'Player', get: (p) => p.name },
        { label: 'Session', num: true, get: (p) => dur(p.seconds) },
        { label: 'Grid', mono: true, get: (p) => (p.pos ? `${Math.round(p.pos.x)} / ${Math.round(p.pos.z)}` : '-') },
        { label: 'K/D', num: true, get: (p) => (p.kills === null ? '-' : `${p.kills}/${p.deaths}`) },
        { label: 'Source', get: (p) => p.source },
      ], onlineRows, { empty: 'nobody online' })
      : '<div class="empty">nobody online</div>', { flush: true }),

    card('Failing and warning checks', h.checks.filter((c) => c.status === 'fail' || c.status === 'warn').length
      ? h.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map(checkRow).join('')
      : '<div class="empty">every check is green</div>', { flush: true }),
  ];
  view.innerHTML = `<div class="grid wide">${cards.join('')}</div>`;
});

const checkRow = (c) => html`<div class="check">
  <span class="mark ${c.status}"></span>
  <div>
    <div class="title">${c.title} <span class="badge ${c.status}">${c.status}</span></div>
    <div class="detail">${c.detail}</div>
    ${raw(c.hint ? `<div class="hint">${esc(c.hint)}</div>` : '')}
  </div>
</div>`;

// ------------------------------------------------------------------ health ---
tab('health', 'Health', async (view) => {
  const h = await api('/api/health');
  const summary = html`<div class="toolbar">
    ${raw(badge(h.overall, `overall: ${h.overall}`))}
    <span class="pill">${h.counts.ok} ok</span>
    <span class="pill">${h.counts.warn} warning</span>
    <span class="pill">${h.counts.fail} failing</span>
    <span class="pill">${h.counts.unknown} unknown</span>
    <span class="spacer"></span>
    <span class="note">${h.total} checks \u00b7 ${new Date(h.at).toLocaleTimeString()}</span>
  </div>`;
  const groups = h.groups.map((g) => card(
    `${g.name}`,
    g.checks.map(checkRow).join(''),
    { flush: true, tools: badge(g.status) },
  )).join('');
  view.innerHTML = summary + `<div class="grid wide">${groups}</div>`;
});

// ----------------------------------------------------------------- players ---
tab('players', 'Players', async (view) => {
  const p = await api('/api/players');
  const board = (title, rows, col) => card(title, table([
    { label: 'Player', get: (r) => r.name },
    { label: col.label, num: true, get: col.get },
  ], rows, { empty: 'no data yet' }), { flush: true });

  view.innerHTML = `<div class="grid wide">
    ${card('Online now', table([
      { label: 'Player', get: (r) => r.name },
      { label: 'ID', mono: true, get: (r) => r.id || '-' },
      { label: 'Session', num: true, get: (r) => dur(r.seconds) },
      { label: 'Position', mono: true, get: (r) => (r.pos ? `${Math.round(r.pos.x)}, ${Math.round(r.pos.z)}` : '-') },
      { label: 'Kills', num: true, get: (r) => r.kills ?? '-' },
      { label: 'Deaths', num: true, get: (r) => r.deaths ?? '-' },
      { label: 'Seen via', get: (r) => r.source },
    ], p.online, { empty: 'nobody online' }), { flush: true, cls: 'span2' })}

    ${card('Everyone the admin log knows', table([
      { label: 'Player', get: (r) => r.name },
      { label: 'ID', mono: true, get: (r) => r.id || '-' },
      { label: 'Sessions', num: true, get: (r) => r.sessions },
      { label: 'Played', num: true, get: (r) => dur(r.playSeconds) },
      { label: 'Kills', num: true, get: (r) => r.kills },
      { label: 'Deaths', num: true, get: (r) => r.deaths },
      { label: 'K/D', num: true, get: (r) => r.kd },
      { label: 'Longest shot', num: true, get: (r) => (r.longestShot ? `${Math.round(r.longestShot)} m` : '-') },
      { label: 'Favourite weapon', get: (r) => r.topWeapon || '-' },
      { label: 'Last seen', mono: true, get: (r) => tsLabel(r.lastSeen) },
    ], p.roster, { empty: p.admError || 'the admin log has no player events yet' }), { flush: true, cls: 'span2' })}

    ${board('Most kills', p.leaderboard.kills, { label: 'Kills', get: (r) => r.kills })}
    ${board('Most time played', p.leaderboard.playtime, { label: 'Played', get: (r) => dur(r.playSeconds) })}
    ${board('Longest shot', p.leaderboard.longestShot, { label: 'Metres', get: (r) => Math.round(r.longestShot) })}
    ${board('Most talkative', p.leaderboard.chat, { label: 'Lines', get: (r) => r.chatLines })}

    ${card('Recent sessions', table([
      { label: 'Player', get: (r) => r.name },
      { label: 'Connected', mono: true, get: (r) => tsLabel(r.from) },
      { label: 'Left', mono: true, get: (r) => tsLabel(r.to) },
      { label: 'Length', num: true, get: (r) => dur(r.seconds) },
    ], p.sessions, { empty: 'no completed sessions in this log' }), { flush: true, cls: 'span2' })}
  </div>
  <p class="note">Names and IDs come from the admin log (<code>.ADM</code>), which the container enables with
  <code>-adminlog</code>. Totals cover the part of the log that is still on disk, not the whole life of the server.</p>`;
});

// -------------------------------------------------------------------- chat ---
tab('chat', 'Chat', async (view) => {
  const render = async (q) => {
    const c = await api('/api/chat', { limit: 500, q });
    const lines = c.chat.map((e) => html`<div class="chat-line">
      <span class="t">${tsLabel(e.ts)}</span>
      <span class="n">${e.actor?.name || '?'}</span>
      <span class="m">${e.text}</span>
    </div>`).join('');
    $('#chatbox').innerHTML = lines || `<div class="empty">${esc(c.error || 'no chat in this log yet')}</div>`;
    $('#chatcount').textContent = `${c.total} line(s)`;
  };
  view.innerHTML = `<div class="toolbar">
      <input type="search" id="chatq" placeholder="search chat and names">
      <span class="pill" id="chatcount"></span>
      <span class="spacer"></span>
      <span class="note">newest first \u00b7 from the admin log</span>
    </div>
    ${card('In-game chat', '<div id="chatbox"></div>', { flush: true })}`;
  let t;
  $('#chatq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => render(e.target.value), 250); });
  await render('');
});

// ------------------------------------------------------------------ events ---
const KIND_STYLE = {
  kill: 'fail', death: 'warn', connect: 'ok', disconnect: 'plain', chat: 'info',
  hit: 'warn', build: 'info', unconscious: 'warn', conscious: 'ok', other: 'plain', emote: 'plain',
};

function eventText(e) {
  switch (e.kind) {
    case 'kill': return html`<b>${e.actor?.name}</b> killed by <b>${e.killer || 'unknown'}</b>${raw(e.weapon ? ` with <code>${esc(e.weapon)}</code>` : '')}${raw(e.distance ? ` at ${Math.round(e.distance)} m` : '')}`;
    case 'death': return html`<b>${e.actor?.name}</b> died (${e.cause})${raw(e.text ? ` <span class="note">${esc(e.text)}</span>` : '')}`;
    case 'hit': return html`<b>${e.target?.name || '?'}</b> hit <b>${e.actor?.name}</b> for ${N(e.damage, 1)} into ${e.bodyPart || '?'}${raw(e.weapon ? ` with <code>${esc(e.weapon)}</code>` : '')}`;
    case 'connect': return html`<b>${e.actor?.name}</b> connected`;
    case 'disconnect': return html`<b>${e.actor?.name}</b> disconnected`;
    case 'chat': return html`<b>${e.actor?.name}</b>: ${e.text}`;
    case 'build': return html`<b>${e.actor?.name}</b> ${e.action} ${e.object}`;
    case 'unconscious': return html`<b>${e.actor?.name}</b> went unconscious`;
    case 'conscious': return html`<b>${e.actor?.name}</b> regained consciousness`;
    default: return esc(e.raw.replace(/^\d{2}:\d{2}:\d{2}\s*\|\s*/, ''));
  }
}

tab('events', 'Events', async (view) => {
  let kinds = new Set();
  let q = '';
  const render = async () => {
    const data = await api('/api/events', { limit: 600, kind: [...kinds].join(','), q });
    $('#chips').innerHTML = Object.entries(data.counts).sort((a, b) => b[1] - a[1])
      .map(([k, n]) => html`<button class="chip ${raw(kinds.has(k) ? 'on' : '')}" data-kind="${k}">${k} ${n}</button>`).join('');
    $('#feed').innerHTML = data.events.map((e) => html`<div class="row">
      <span class="t">${tsLabel(e.ts)}</span>
      <span>${raw(badge(KIND_STYLE[e.kind] || 'plain', e.kind))}</span>
      <span>${raw(eventText(e))}${raw(e.actor?.pos ? ` <span class="note">@ ${Math.round(e.actor.pos.x)}, ${Math.round(e.actor.pos.z)}</span>` : '')}</span>
    </div>`).join('') || `<div class="empty">${esc(data.error || 'no events match')}</div>`;
    $('#evcount').textContent = `${data.total} shown`;
  };
  view.innerHTML = `<div class="toolbar">
      <input type="search" id="evq" placeholder="search raw log lines">
      <span class="pill" id="evcount"></span>
      <span class="spacer"></span>
      <span class="note">newest first</span>
    </div>
    <div class="chips" id="chips" style="margin-bottom:12px"></div>
    ${card('Admin log events', '<div class="feed scroll tall" id="feed"></div>', { flush: true })}`;
  $('#chips').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-kind]');
    if (!b) return;
    kinds.has(b.dataset.kind) ? kinds.delete(b.dataset.kind) : kinds.add(b.dataset.kind);
    render();
  });
  let t;
  $('#evq').addEventListener('input', (e) => { clearTimeout(t); q = e.target.value; t = setTimeout(render, 250); });
  await render();
});

// --------------------------------------------------------------------- map ---
// Which layers are on, how bright each picture overlay is and how far the picture is dimmed
// are a viewing preference, not server state, so they live in the browser and survive both a
// reload and a tab switch.
const MAP_LAYERS = { players: true, deaths: true, spawns: false, areas: true, basemap: true, trails: false };
const MAP_PREFS = 'dayz-status-map';
const pct = (v) => `${Math.round(v * 100)}%`;

function mapPrefs() {
  try { return JSON.parse(localStorage.getItem(MAP_PREFS)) || {}; } catch { return {}; }
}
function saveMapPrefs(state) {
  const keep = { overlay: state.overlay, opacity: state.opacity, dim: state.dim };
  for (const k of Object.keys(MAP_LAYERS)) keep[k] = state[k];
  try { localStorage.setItem(MAP_PREFS, JSON.stringify(keep)); } catch { /* private mode */ }
}

tab('map', 'Map', async (view) => {
  const [data, picture] = await Promise.all([
    api('/api/map'),
    api('/api/map/overlays').catch(() => ({ overlays: [] })),
  ]);
  if (!data.ok) { view.innerHTML = card('Map', `<div class="empty">${esc(data.error)}</div>`); return; }
  data.overlays = picture.overlays || [];

  const prefs = mapPrefs();
  const state = { ...MAP_LAYERS, overlay: {}, opacity: {}, dim: 0.35, zoom: 1, panX: 0, panY: 0 };
  for (const k of Object.keys(MAP_LAYERS)) if (typeof prefs[k] === 'boolean') state[k] = prefs[k];
  if (Number.isFinite(prefs.dim)) state.dim = Math.min(1, Math.max(0, prefs.dim));
  for (const o of data.overlays) {
    state.overlay[o.id] = typeof prefs.overlay?.[o.id] === 'boolean' ? prefs.overlay[o.id] : o.on;
    state.opacity[o.id] = Number.isFinite(prefs.opacity?.[o.id]) ? prefs.opacity[o.id] : o.opacity;
  }

  const chip = (key, on, attr) => html`<button class="chip ${raw(on ? 'on' : '')}" ${raw(attr)}="${key}">${key}</button>`;
  const overlayBar = data.overlays.length
    ? `<div class="toolbar sub">
        <span class="toolbar-label">overlays</span>
        <span class="chips" id="overlays">${data.overlays.map((o) =>
          html`<button class="chip ${raw(state.overlay[o.id] ? 'on' : '')}" data-overlay="${o.id}">${o.label}</button>`).join('')}</span>
      </div>`
    : '';

  view.innerHTML = `<div class="toolbar">
      <span class="chips" id="layers">${Object.keys(MAP_LAYERS).map((k) => chip(k, state[k], 'data-layer')).join('')}</span>
      <span class="spacer"></span>
      <button id="fit" class="ghost">Reset view</button>
    </div>
    ${overlayBar}
    ${card(`${data.world.label} \u00b7 ${data.world.size} m`, `
      <div class="mapwrap">
        <canvas id="map" width="1400" height="1400"></canvas>
        <div class="maphud" id="hud">move the pointer over the map</div>
      </div>
      <div class="mapsliders" id="sliders"></div>
      <div class="maplegend">
        <span><i class="sw dot" style="--c:#a8ff5e"></i>player</span>
        <span><i class="sw cross" style="--c:#ff5347"></i>death</span>
        <span><i class="sw diamond" style="--c:#ffc531"></i>spawn point</span>
        <span><i class="sw ring" style="--c:#c88bff"></i>effect area</span>
        <span><i class="sw block" style="--c:#5d7e65"></i>buildings</span>
        <span>drag to pan, wheel to zoom, click twice to measure</span>
      </div>`, { flush: true })}
    <p class="note" id="mapnote"></p>`;

  const canvas = $('#map');
  const redraw = () => drawMap(canvas, data, state);
  state.onOverlayLoad = redraw;
  attachMapInteraction(canvas, data, state, redraw, $('#hud'));

  // One slider per layer that is switched on, plus the dim control - which only earns its
  // place when a picture layer is showing, because it has nothing to dim otherwise. Rebuilt
  // only when a chip is clicked, so dragging a slider keeps its grip.
  const controls = () => {
    const on = data.overlays.filter((o) => state.overlay[o.id]);
    const dimmable = on.some((o) => o.kind === 'image');
    $('#sliders').innerHTML = on.length ? on.map((o) => html`<label class="slider">
        <span class="name">${o.label}</span>
        <input type="range" min="0" max="100" step="1" value="${Math.round(state.opacity[o.id] * 100)}" data-opacity="${o.id}">
        <span class="val">${pct(state.opacity[o.id])}</span>
      </label>`).join('') + (dimmable ? html`<label class="slider">
        <span class="name">dim picture</span>
        <input type="range" min="0" max="80" step="1" value="${Math.round(state.dim * 100)}" id="dim">
        <span class="val">${pct(state.dim)}</span>
      </label>` : '') : '';
    const credits = on.map((o) => o.credit).filter(Boolean);
    $('#mapnote').innerHTML = (credits.length ? html`${credits.join('; ')}. ` : '')
      + `Overlays are files in <code>status/public/overlays</code>: the ones shipped here are drawn from lists of world
        coordinates rather than being map images, so the page still carries no map imagery. Drop an image in that folder
        and it is offered as a layer too.`
      + ` The background is drawn as well, from the world positions in the mission's own
        <code>mapgrouppos.xml</code>, so towns and industrial areas appear as denser clusters. Player positions come from
        the newest lines of the admin log, so a player who has not triggered a logged event for a while shows their last
        known spot.`;
  };

  $('#layers').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-layer]');
    if (!b) return;
    state[b.dataset.layer] = !state[b.dataset.layer];
    b.classList.toggle('on', state[b.dataset.layer]);
    saveMapPrefs(state);
    redraw();
  });
  $('#overlays')?.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-overlay]');
    if (!b) return;
    const id = b.dataset.overlay;
    state.overlay[id] = !state.overlay[id];
    b.classList.toggle('on', state.overlay[id]);
    controls();
    saveMapPrefs(state);
    redraw();
  });
  $('#sliders').addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'dim') state.dim = Number(el.value) / 100;
    else if (el.dataset.opacity) state.opacity[el.dataset.opacity] = Number(el.value) / 100;
    else return;
    el.parentElement.querySelector('.val').textContent = `${el.value}%`;
    saveMapPrefs(state);
    redraw();
  });
  $('#fit').addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; redraw(); });

  controls();
  redraw();
});

// -------------------------------------------------------------------- logs ---
function colourLog(text) {
  return esc(text).split('\n').map((l) => {
    const cls = /error|cannot|failed|fatal|segmentation|crash/i.test(l) ? 'l-error'
      : /warning|warn/i.test(l) ? 'l-warn'
      : /\[CE\]|mission read|server is up/i.test(l) ? 'l-info'
      : /^\s*$/.test(l) ? 'l-dim' : '';
    return cls ? `<span class="${cls}">${l}</span>` : l;
  }).join('\n');
}

tab('logs', 'Logs', async (view) => {
  const [list, dockerLog] = await Promise.all([api('/api/logs'), api('/api/docker/logs', { tail: 400 })]);
  const options = list.files.filter((f) => f.kind !== 'crash')
    .map((f) => html`<option value="${f.name}">${f.name} \u2014 ${f.label}, ${bytes(f.size)}</option>`).join('');

  view.innerHTML = `<div class="grid wide">
    ${card('Container log (docker compose logs)', `<pre class="log">${dockerLog.ok
      ? colourLog(dockerLog.lines.map((l) => l.text).join('\n'))
      : esc(dockerLog.error)}</pre>`, { flush: true, cls: 'span2', tools: `<span class="pill">${dockerLog.lines.length} lines</span>` })}

    ${card('Server log files', `<div class="toolbar" style="padding:10px 14px 0">
        <select id="logfile">${options || '<option>no log files yet</option>'}</select>
        <select id="logbytes">
          <option value="65536">last 64 KB</option>
          <option value="262144" selected>last 256 KB</option>
          <option value="1048576">last 1 MB</option>
        </select>
        <span class="pill" id="loginfo"></span>
      </div>
      <pre class="log" id="logbox">pick a file</pre>`, { flush: true, cls: 'span2' })}

    ${card('All files in the profiles folder', table([
      { label: 'File', mono: true, get: (f) => f.name },
      { label: 'Kind', get: (f) => f.label },
      { label: 'Size', num: true, get: (f) => bytes(f.size) },
      { label: 'Modified', get: (f) => when(f.mtime) },
    ], list.files, { empty: 'no files yet' }), { flush: true, cls: 'span2' })}
  </div>
  <p class="note">Crash dumps are binary and are not shown here. Copy one out with
  <code>docker compose cp dayz:${esc(list.dir)}/&lt;file&gt; .</code> \u2014 never post it publicly, it can contain player IDs.</p>`;

  const load = async () => {
    const name = $('#logfile').value;
    if (!name) return;
    $('#logbox').textContent = 'loading...';
    const d = await api('/api/logs/tail', { file: name, bytes: $('#logbytes').value });
    if (!d.ok) { $('#logbox').textContent = d.error; return; }
    $('#logbox').innerHTML = colourLog(d.text);
    $('#logbox').scrollTop = $('#logbox').scrollHeight;
    const c = d.summary?.counts || {};
    $('#loginfo').textContent = `${bytes(d.size)}${d.truncated ? ' (tail only)' : ''}`
      + (c.scriptError ? ` \u00b7 ${c.scriptError} script errors` : '')
      + (c.error ? ` \u00b7 ${c.error} errors` : '')
      + (c.warning ? ` \u00b7 ${c.warning} warnings` : '');
  };
  $('#logfile').addEventListener('change', load);
  $('#logbytes').addEventListener('change', load);
  if (options) await load();
});

// ---------------------------------------------------------------- missions ---
tab('missions', 'Missions', async (view) => {
  const m = await api('/api/missions');
  const crumbs = (rel) => {
    const parts = rel ? rel.split('/') : [];
    const out = [html`<a href="#" data-rel="">mission root</a>`];
    parts.forEach((p, i) => out.push(html`<a href="#" data-rel="${parts.slice(0, i + 1).join('/')}">${p}</a>`));
    return out.join(' / ');
  };

  view.innerHTML = `<div class="grid wide">
    ${card('Installed missions', table([
      { label: 'Folder', mono: true, get: (x) => x.name },
      { label: 'World', get: (x) => x.world || '-' },
      { label: 'Role', get: (x) => (x.active ? raw(badge('ok', 'live working copy')) : raw(badge('plain', 'vanilla, untouched'))) },
      { label: 'Modified', get: (x) => when(x.mtime) },
    ], m.installed, { empty: 'no mpmissions folder yet' }), { flush: true })}

    ${card('Your overrides (config/mission)', table([
      { label: 'File', mono: true, get: (o) => o.rel },
      { label: 'Applied', get: (o) => raw(badge(o.applied ? 'ok' : 'warn', o.applied ? 'yes' : 'check')) },
      { label: 'Size', num: true, get: (o) => bytes(o.size) },
      { label: 'Note', get: (o) => o.note || '' },
    ], m.overrides, { empty: 'no override files - the mission is vanilla' }), { flush: true })}

    ${card('Mission file browser', `<div class="toolbar" style="padding:10px 14px 0" id="crumbs">${crumbs('')}</div>
      <div id="browser"></div>`, { flush: true, cls: 'span2' })}
  </div>
  <p class="note">The working copy is rebuilt from the vanilla mission plus your overrides at every start, so editing files
  in here directly would be lost. Put changes in <code>config/mission/</code> instead.</p>`;

  const open = async (rel) => {
    const d = await api('/api/mission/browse', { rel });
    $('#crumbs').innerHTML = crumbs(rel);
    if (!d.ok) { $('#browser').innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
    if (d.kind === 'dir') {
      $('#browser').innerHTML = table([
        { label: 'Name', get: (e) => (e.readable ? raw(`<a href="#" data-rel="${esc(e.rel)}">${esc(e.name)}${e.dir ? '/' : ''}</a>`) : esc(e.name)) },
        { label: 'Size', num: true, get: (e) => (e.dir ? '' : bytes(e.size)) },
        { label: 'Modified', get: (e) => when(e.mtime) },
      ], d.entries, { empty: 'empty folder' });
    } else if (d.kind === 'file') {
      $('#browser').innerHTML = `<pre class="log">${esc(d.text)}</pre>`
        + (d.truncated ? '<p class="note">only the first megabyte is shown</p>' : '');
    } else {
      $('#browser').innerHTML = `<div class="empty">binary file, ${bytes(d.size)}</div>`;
    }
  };
  view.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-rel]');
    if (!a) return;
    ev.preventDefault();
    open(a.dataset.rel);
  });
  await open('');
});

// ----------------------------------------------------------------- economy ---
tab('economy', 'Economy', async (view) => {
  const e = await api('/api/economy');
  if (!e.ok) { view.innerHTML = card('Central economy', `<div class="empty">${esc(e.error)}</div>`); return; }
  const types = e.types?.items || [];
  const byCategory = {};
  for (const t of types) byCategory[t.category || '(none)'] = (byCategory[t.category || '(none)'] || 0) + t.nominal;
  const totalNominal = types.reduce((s, t) => s + t.nominal, 0);

  view.innerHTML = `<div class="grid wide">
    ${card('Loot summary', kv([
      ['Types defined', `${types.length}`],
      ['Total nominal items', `${totalNominal}`],
      ['Events defined', `${e.events?.count ?? '-'}`],
      ['Global variables', `${e.globals?.count ?? '-'}`],
      ['Scheduled messages', `${e.messages?.count ?? 0}`],
      ['Source', raw(`<code>${esc(e.missionDir)}</code>`)],
    ]) + '<div style="margin-top:10px">' + Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      `<div style="margin:5px 0"><div style="display:flex;justify-content:space-between"><span>${esc(k)}</span><span class="mono">${v}</span></div>
       <div class="bar"><i style="width:${Math.round((v / Math.max(1, totalNominal)) * 100)}%"></i></div></div>`).join('') + '</div>')}

    ${card('Global variables', table([
      { label: 'Name', mono: true, get: (v) => v.name },
      { label: 'Value', num: true, get: (v) => v.value },
    ], e.globals?.items || [], { empty: 'globals.xml not readable' }), { flush: true })}

    ${card('Loot table (types.xml)', `<div class="toolbar" style="padding:10px 14px 0">
        <input type="search" id="tq" placeholder="search item, category, usage or tier">
        <span class="pill" id="tcount"></span>
      </div><div id="ttable"></div>`, { flush: true, cls: 'span2' })}

    ${card('Dynamic events (events.xml)', table([
      { label: 'Event', mono: true, get: (x) => x.name },
      { label: 'Active', get: (x) => (x.active ? raw(badge('ok', 'yes')) : raw(badge('plain', 'no'))) },
      { label: 'Nominal', num: true, get: (x) => x.nominal },
      { label: 'Min', num: true, get: (x) => x.min },
      { label: 'Max', num: true, get: (x) => x.max },
      { label: 'Lifetime', num: true, get: (x) => dur(x.lifetime) },
      { label: 'Restock', num: true, get: (x) => dur(x.restock) },
      { label: 'Safe radius', num: true, get: (x) => x.saferadius },
      { label: 'Spawns', get: (x) => x.children.slice(0, 4).join(', ') + (x.children.length > 4 ? ` +${x.children.length - 4}` : '') },
    ], e.events?.items || [], { empty: 'events.xml not readable' }), { flush: true, cls: 'span2' })}

    ${card('Scheduled messages (messages.xml)', table([
      { label: 'Text', get: (m) => m.text },
      { label: 'Repeat', num: true, get: (m) => (m.repeat ? dur(m.repeat) : '-') },
      { label: 'Deadline', num: true, get: (m) => (m.deadline ? dur(m.deadline) : '-') },
      { label: 'Shutdown', get: (m) => (m.shutdown ? 'yes' : '') },
    ], e.messages?.items || [], { empty: 'no messages.xml (this container drives restarts itself)' }), { flush: true, cls: 'span2' })}
  </div>`;

  const renderTypes = (q) => {
    const needle = q.toLowerCase();
    const rows = (needle
      ? types.filter((t) => `${t.name} ${t.category} ${t.usage.join(' ')} ${t.value.join(' ')} ${t.tag.join(' ')}`.toLowerCase().includes(needle))
      : types).slice(0, 2000);
    $('#tcount').textContent = `${rows.length} of ${types.length}`;
    $('#ttable').innerHTML = table([
      { label: 'Item', mono: true, get: (t) => t.name },
      { label: 'Nominal', num: true, get: (t) => t.nominal },
      { label: 'Min', num: true, get: (t) => t.min },
      { label: 'Lifetime', num: true, get: (t) => dur(t.lifetime) },
      { label: 'Restock', num: true, get: (t) => dur(t.restock) },
      { label: 'Category', get: (t) => t.category || '' },
      { label: 'Usage', get: (t) => t.usage.join(', ') },
      { label: 'Tier', get: (t) => t.value.join(', ') },
      { label: 'In map', get: (t) => (t.flags.count_in_map === '1' ? 'yes' : '') },
    ], rows, { empty: 'nothing matches' });
  };
  let t;
  $('#tq').addEventListener('input', (ev) => { clearTimeout(t); t = setTimeout(() => renderTypes(ev.target.value), 200); });
  renderTypes('');
});

// -------------------------------------------------------------------- mods ---
tab('mods', 'Mods', async (view) => {
  const m = await api('/api/mods');
  view.innerHTML = `<div class="grid wide">
    ${card('Mods', table([
      { label: 'Name', get: (x) => x.displayName || x.name },
      { label: 'Folder', mono: true, get: (x) => x.folder || '' },
      { label: 'Workshop', get: (x) => (x.workshopId ? raw(`<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${esc(x.workshopId)}" target="_blank" rel="noreferrer">${esc(x.workshopId)}</a>`) : '') },
      { label: 'Version', get: (x) => x.version || '' },
      { label: 'Keys', num: true, get: (x) => (x.bikeys ? x.bikeys.length : '') },
      { label: 'Found via', get: (x) => (x.sources || []).join(', ') },
    ], m.mods, { empty: 'no mods - this stack does not manage Workshop content yet' }), { flush: true, cls: 'span2' })}
    ${card('How mods were looked for', `<ul>
      <li>Folders called <code>@Something</code> next to the server binary, with <code>meta.cpp</code> read for the name and Workshop id.</li>
      <li><code>-mod=</code> and <code>-servermod=</code> on the real command line (set through <code>EXTRA_ARGS</code>).</li>
      <li>The mod list the server itself advertises in its A2S_RULES answer.</li>
    </ul>
    <p class="note">${esc(m.rulesNote || 'The server advertised no mod list.')}</p>`, { cls: 'span2' })}
  </div>`;
});

// ------------------------------------------------------------------ config ---
tab('config', 'Config', async (view) => {
  const d = await api('/api/config');
  const c = d.config;
  const v = c?.values || {};
  const yn = (x) => (x === '1' || x === true ? raw(badge('ok', 'on')) : raw(badge('plain', 'off')));
  view.innerHTML = `<div class="grid wide">
    ${card('Effective server settings', kv([
      ['Config source', c?.source || '-'],
      ['Host name', v.hostname],
      ['Slots', v.maxPlayers],
      ['Mission template', v.template],
      ['Instance id', v.instanceId],
      ['Steam query port', v.steamQueryPort],
      ['Signature check', v.verifySignatures === '2' ? raw(badge('ok', 'full (2)')) : raw(badge('warn', v.verifySignatures ?? '?'))],
      ['Same build forced', yn(v.forceSameBuild)],
      ['Third person disabled', yn(v.disable3rdPerson)],
      ['Voice chat off', yn(v.disableVoN)],
      ['Whitelist', yn(v.enableWhitelist)],
      ['Join password', v.passwordSet ? raw(badge('ok', 'set')) : raw(badge('plain', 'public'))],
      ['Admin password', v.adminPasswordSet ? raw(badge('ok', 'set')) : raw(badge('warn', 'not set'))],
      ['Server time', v.serverTime],
      ['Time acceleration', `${v.serverTimeAcceleration}x day, ${v.serverNightTimeAcceleration}x night`],
      ['Persistent world time', yn(v.serverTimePersistent)],
    ]))}

    ${card('Player lists', table([
      { label: 'File', mono: true, get: (r) => r[0] },
      { label: 'Present', get: (r) => (r[1].present ? raw(badge('ok', 'yes')) : raw(badge('plain', 'no'))) },
      { label: 'Entries', num: true, get: (r) => r[1].lines },
      { label: 'Modified', get: (r) => when(r[1].mtime) },
    ], Object.entries(c?.lists || {}), { empty: 'no lists' }), { flush: true })}

    ${card('Container settings (environment)', table([
      { label: 'Variable', mono: true, get: (r) => r.key },
      { label: 'Value', mono: true, get: (r) => (r.secret ? raw(`<span class="badge plain">hidden</span>`) : r.value) },
    ], (d.container?.env || []).filter((r) => !/^(PATH|LANG|DEBIAN_FRONTEND|HOSTNAME|HOME)$/.test(r.key)), { empty: 'Docker API not reachable' }),
      { flush: true, cls: 'span2', tools: '<span class="note">passwords and tokens are never sent to this page</span>' })}

    ${card('Launch command', `<pre class="log">./DayZServer ${esc(d.supervisor?.launch_args || '(not published yet)')}</pre>`, { flush: true, cls: 'span2' })}

    ${card('Generated serverDZ.cfg', `<pre class="log">${esc(c?.text || c?.error || '')}</pre>`, { flush: true, cls: 'span2' })}

    ${card('Status page settings', kv(Object.entries(d.statusPageSettings || {}).map(([k, val]) => [k, Array.isArray(val) ? val.join(' - ') : String(val)])), { cls: 'span2' })}
  </div>`;
});

// ----------------------------------------------------------------- storage ---
tab('storage', 'World', async (view) => {
  const s = await api('/api/storage');
  const flat = [];
  const walk = (nodes, depth) => nodes.forEach((n) => {
    flat.push({ ...n, depth });
    if (n.children) walk(n.children, depth + 1);
  });
  walk(s.tree || [], 0);

  view.innerHTML = `<div class="grid wide">
    ${card('World persistence', kv([
      ['Folder', raw(`<code>${esc(s.dir)}</code>`)],
      ['Files', String(s.fileCount)],
      ['Size', bytes(s.bytes)],
      ['Last write', s.lastSave ? `${since(s.lastSave)} ago (${s.lastSaveFile})` : 'never'],
      ['Oldest file', s.worldAgeFrom ? `${since(s.worldAgeFrom)} ago` : '-'],
      ['Rescued folders', String(s.rescued?.length || 0)],
    ]))}

    ${card('Disk', kv([
      ['Data volume free', s.dataDisk ? `${bytes(s.dataDisk.free)} of ${bytes(s.dataDisk.total)}` : '-'],
      ['Data volume used', s.dataDisk ? raw(`${s.dataDisk.usedPct}%<div class="bar"><i class="${s.dataDisk.usedPct > 90 ? 'fail' : s.dataDisk.usedPct > 75 ? 'warn' : ''}" style="width:${s.dataDisk.usedPct}%"></i></div>`) : '-'],
      ['Server volume free', s.serverDisk ? `${bytes(s.serverDisk.free)} of ${bytes(s.serverDisk.total)}` : '-'],
      ['Server volume used', s.serverDisk ? raw(`${s.serverDisk.usedPct}%<div class="bar"><i class="${s.serverDisk.usedPct > 90 ? 'fail' : s.serverDisk.usedPct > 75 ? 'warn' : ''}" style="width:${s.serverDisk.usedPct}%"></i></div>`) : '-'],
    ]))}

    ${card('Back up and restore', `<p>Back up while the server is stopped, so the world on disk is complete:</p>
      <pre class="log">docker-compose stop dayz
docker run --rm -v dayz_data:/data:ro -v "${'${PWD}'}:/backup" debian:bookworm-slim \
  tar czf /backup/dayz-world-$(date +%%Y%%m%%d).tar.gz -C /data storage
docker-compose start dayz</pre>
      <p class="note">Wipe the world but keep everything else: stop the server, then delete the
      <code>storage</code> folder inside the <code>dayz_data</code> volume. This page never writes anything,
      so both of these are yours to run.</p>`, { cls: 'span2' })}

    ${card('Files', table([
      { label: 'Name', mono: true, get: (f) => `${'\u00a0\u00a0'.repeat(f.depth)}${f.dir ? '\u{1f4c1} ' : ''}${f.name}` },
      { label: 'Size', num: true, get: (f) => (f.dir ? '' : bytes(f.size)) },
      { label: 'Modified', get: (f) => when(f.mtime) },
    ], flat, { sortable: false, empty: 'no persistence files yet - a fresh world writes them at the first save' }), { flush: true, cls: 'span2' })}
  </div>`;
});

// ------------------------------------------------------------------- query ---
tab('query', 'Ask the server', async (view) => {
  const [settings, dockerInfo] = await Promise.all([api('/api/settings'), api('/api/docker')]);
  view.innerHTML = `<div class="grid wide">
    ${card('Send a Steam query', `<div class="toolbar">
        <select id="qtarget">
          <option value="container">to the container (${esc(settings.dayzHost)})</option>
          <option value="host">the long way round, through the Docker host</option>
          <option value="loopback">to 127.0.0.1 (this container - expected to fail)</option>
        </select>
        <select id="qtype">
          <option value="info">A2S_INFO \u2014 name, map, players, version, tags</option>
          <option value="players">A2S_PLAYER \u2014 the player list</option>
          <option value="rules">A2S_RULES \u2014 rules and the mod list</option>
        </select>
        <input type="text" id="qport" value="${settings.queryPort}" style="width:90px">
        <button id="qgo">Send</button>
        <span class="pill" id="qtime"></span>
      </div>
      <pre class="log" id="qout">The launcher and the Steam server browser use exactly these three queries.
Sending them through the host is the only way to see the Docker Desktop bug where a published UDP port
stops forwarding while the container still looks healthy.</pre>`, { cls: 'span2' })}

    ${card('Docker host', kv([
      ['Docker', dockerInfo.ok ? `${dockerInfo.version?.version} (API ${dockerInfo.version?.apiVersion})` : dockerInfo.error],
      ['Host', dockerInfo.host?.name],
      ['Operating system', dockerInfo.host?.os],
      ['Kernel', dockerInfo.host?.kernel],
      ['CPUs', String(dockerInfo.host?.cpus ?? '-')],
      ['Memory', bytes(dockerInfo.host?.memory)],
      ['Containers', `${dockerInfo.host?.running ?? '-'} running of ${dockerInfo.host?.containers ?? '-'}`],
    ]))}

    ${card('Containers in this project', table([
      { label: 'Service', get: (c) => c.service || '-' },
      { label: 'Name', mono: true, get: (c) => c.name },
      { label: 'State', get: (c) => raw(badge(c.state === 'running' ? 'ok' : 'warn', c.state)) },
      { label: 'Status', get: (c) => c.status },
    ], dockerInfo.containers || [], { empty: dockerInfo.error || 'none' }), { flush: true })}

    ${card('Processes inside the game container', dockerInfo.processes
      ? table(dockerInfo.processes.Titles.map((t, i) => ({ label: t, mono: i === dockerInfo.processes.Titles.length - 1, get: (r) => r[i] })),
        dockerInfo.processes.Processes || [], { empty: 'none' })
      : '<div class="empty">not available</div>', { flush: true, cls: 'span2' })}
  </div>`;

  $('#qgo').addEventListener('click', async () => {
    $('#qout').textContent = 'sending...';
    try {
      const r = await api('/api/query', { target: $('#qtarget').value, type: $('#qtype').value, port: $('#qport').value });
      $('#qtime').textContent = `${r.elapsedMs} ms`;
      $('#qout').textContent = r.ok ? JSON.stringify(r.data, null, 2) : `no answer: ${r.error}`;
    } catch (err) {
      $('#qout').textContent = err.message;
    }
  });
});

// ------------------------------------------------------------------- about ---
tab('about', 'About', async (view) => {
  const [settings, summary] = await Promise.all([api('/api/settings'), api('/api/summary')]);
  const s = summary.snapshot;
  view.innerHTML = `<div class="grid wide">
    ${card('What this page reads', `<ul>
      <li><b>Steam queries</b> to <code>${esc(settings.dayzHost)}:${settings.queryPort}/udp</code> \u2014 the same A2S_INFO, A2S_PLAYER and
        A2S_RULES the game launcher sends. Live player count, map, version, tags and the advertised mod list.</li>
      <li><b>The Docker API</b> over a read-only socket \u2014 container state, the result of the container's own healthcheck,
        CPU and memory, restart count, port bindings and the container log. Read-only: this page has no endpoint that
        starts, stops or changes anything.</li>
      <li><b>The data volume</b> (read-only) \u2014 the admin log for chat, kills and positions, the engine log for the exact game
        version and script errors, the generated <code>serverDZ.cfg</code>, and the world persistence files.</li>
      <li><b>The game files volume</b> (read-only) \u2014 installed missions, the live mission working copy, the central
        economy files and the Steam app manifest.</li>
      <li><b>A status file</b> the game container publishes to the data volume every 15 seconds, for the few facts that
        live only inside it: the supervisor state, the server process id and when the next restart is due.</li>
    </ul>`, { cls: 'span2' })}

    ${card('Settings', kv(Object.entries(settings).map(([k, v]) => [k, Array.isArray(v) ? v.join(' - ') : String(v)])))}

    ${card('Endpoints', `<p class="note">Everything on this page is also available as JSON, and the numbers as Prometheus metrics.</p>
      ${['/api/summary', '/api/health', '/api/players', '/api/chat', '/api/events', '/api/map', '/api/map/overlays', '/api/missions', '/api/economy',
         '/api/mods', '/api/config', '/api/storage', '/api/logs', '/api/docker', '/api/history', '/api/query', '/api/stream', '/metrics', '/healthz']
        .map((p) => `<div><a href="${p}" target="_blank" rel="noreferrer"><code>${p}</code></a></div>`).join('')}`)}

    ${card('Accuracy notes', `<ul>
      <li>The <b>in-game clock</b> is not reported by DayZ over any query. It is reconstructed from
        <code>serverTime</code>, the two acceleration settings and the moment the server started, switching acceleration at
        ${settings.dayWindow[0]}:00 and ${settings.dayWindow[1]}:00. Treat it as an estimate.</li>
      <li><b>Player positions</b> come from the newest admin-log line that mentions each player, not from a live feed, so a
        player standing still in a field shows their last logged position.</li>
      <li>Some DayZ builds answer the player-list query with <b>empty names</b>. When that happens the page falls back to the
        admin log and says so in the "Seen via" column.</li>
      <li>Everything derived from logs only covers the period still on disk (<code>LOG_RETENTION_DAYS</code>, currently
        ${esc(String(s.supervisor?.log_retention_days ?? '14'))} days).</li>
    </ul>`, { cls: 'span2' })}
  </div>`;
});

// -------------------------------------------------------------------- boot ---
function applyPrivacyButton() {
  const b = $('#privacy');
  b.textContent = store.redact ? 'IDs hidden' : 'IDs shown';
  b.classList.toggle('on', store.redact);
}

$('#privacy').addEventListener('click', () => {
  store.redact = !store.redact;
  localStorage.setItem('dayz-status-redact', store.redact ? '1' : '0');
  applyPrivacyButton();
  show(store.tab);
});
$('#refresh').addEventListener('click', () => show(store.tab));
window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'overview'));

// The stream keeps the header and the overview current without the page polling; every
// other tab is refreshed when you open it or press Refresh.
function connectStream() {
  const es = new EventSource(`/api/stream${store.redact ? '?redact=1' : ''}`);
  es.addEventListener('summary', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      store.summary = data;
      renderHeader(data);
      if (store.tab === 'overview' && !document.hidden) show('overview');
    } catch { /* a malformed frame is not worth breaking the page for */ }
  });
  es.onerror = () => {
    $('#live-dot').classList.add('warn');
    es.close();
    setTimeout(connectStream, 5000);
  };
}

applyPrivacyButton();
renderTabs();
show(location.hash.slice(1) || 'overview');
connectStream();
