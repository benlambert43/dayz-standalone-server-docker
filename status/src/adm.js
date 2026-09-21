// Parser for the DayZ admin log (.ADM, written because run-server.sh passes -adminlog).
//
// This one file carries almost everything a live status page wants: chat, connects and
// disconnects, kills, deaths, unconsciousness, hits and base building - each line stamped
// with the player's world position. Bohemia has changed the exact spacing and wording of
// these lines several times, so the parser is written to degrade instead of break: every
// line it does not recognise is still returned, with kind "other" and its raw text intact.
//
// Coordinates: DayZ prints pos=<x, z, y> where x is metres east, z is metres north and y is
// the altitude. The map only ever uses the first two.
const HEADER_RE = /AdminLog started on (\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2}):(\d{2})/;
const LINE_RE = /^(\d{2}):(\d{2}):(\d{2})\s*\|\s*(.*)$/;

// One actor, in every spelling Bohemia has used:
//   "Name"(id=X pos=<x, z, y>)      "Name" (DEAD) (id=X)      "Name" is connected (id=X)
// The gap between the name and "(id=" allows words but neither a quote nor a bracket, so a
// line naming two players can never bind the first name to the second player's id.
const ACTOR = String.raw`"([^"]*)"\s*(?:\(([A-Z]+)\)\s*)?[^"(]*\(id=([^\s)]*)(?:\s+pos=<\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*>)?\s*\)`;
const ACTOR_RE = new RegExp(ACTOR);
const ACTOR_RE_G = new RegExp(ACTOR, 'g');

function actorFrom(m, offset = 1) {
  if (!m) return null;
  const x = m[offset + 3], z = m[offset + 4], y = m[offset + 5];
  return {
    name: m[offset],
    dead: m[offset + 1] === 'DEAD',
    unconscious: m[offset + 1] === 'UNCONSCIOUS',
    id: m[offset + 2] || null,
    pos: x === undefined ? null : { x: Number(x), z: Number(z), y: Number(y) },
  };
}

/** All actors on a line, in order: [0] is the subject, [1] (when present) the other party. */
function actorsIn(rest) {
  ACTOR_RE_G.lastIndex = 0;
  const out = [];
  let m;
  while ((m = ACTOR_RE_G.exec(rest))) out.push(actorFrom(m));
  return out;
}

export function parseAdm(text, { fileDate = null } = {}) {
  const events = [];
  let day = fileDate ? new Date(fileDate) : null;
  let lastSeconds = -1;
  let startedAt = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const head = HEADER_RE.exec(line);
    if (head) {
      day = new Date(Date.UTC(+head[1], +head[2] - 1, +head[3]));
      startedAt = `${head[1]}-${head[2]}-${head[3]}T${head[4]}:${head[5]}:${head[6]}`;
      lastSeconds = (+head[4]) * 3600 + (+head[5]) * 60 + (+head[6]);
      continue;
    }

    const m = LINE_RE.exec(line);
    if (!m) continue;
    const seconds = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    // The log prints a clock, not a date. A clock that goes backwards means midnight passed.
    if (day && lastSeconds >= 0 && seconds < lastSeconds - 60) day = new Date(day.getTime() + 86400000);
    lastSeconds = seconds;
    const ts = day
      ? `${day.toISOString().slice(0, 10)}T${m[1]}:${m[2]}:${m[3]}`
      : `${m[1]}:${m[2]}:${m[3]}`;

    events.push(classify(ts, seconds, m[4], line));
  }
  return { startedAt, events };
}

function classify(ts, seconds, rest, raw) {
  const base = { ts, seconds, raw, kind: 'other', actor: null, target: null, text: null };
  let m;

  // Chat("Name"(id=... pos=<...>)): message
  // Some builds put the word "Player" inside the brackets, and some leave the brackets off
  // altogether, so both are accepted - a chat line landing in "other" would be invisible.
  if ((m = new RegExp(String.raw`^Chat\s*\(\s*(?:Player\s+)?${ACTOR}\s*\)\s*:\s*([\s\S]*)$`).exec(rest))) {
    return { ...base, kind: 'chat', channel: 'global', actor: actorFrom(m, 1), text: m[7] };
  }
  if ((m = new RegExp(String.raw`^Chat\s*(?:Player\s+)?${ACTOR}\s*:\s*([\s\S]*)$`).exec(rest))) {
    return { ...base, kind: 'chat', channel: 'global', actor: actorFrom(m, 1), text: m[7] };
  }

  const actors = actorsIn(rest);
  const actor = actors[0] || null;
  const other = actors[1] || null;

  if (/\bis connected\b/.test(rest)) return { ...base, kind: 'connect', actor };
  if (/\bhas been disconnected\b|\bis disconnected\b/.test(rest)) return { ...base, kind: 'disconnect', actor };

  if (/\bkilled by\b/.test(rest)) {
    const weapon = /\bwith\s+([^\n]*?)(?:\s+from\s+[\d.]+\s*meters?)?\s*$/.exec(rest);
    const distance = /\bfrom\s+([\d.]+)\s*meters?/.exec(rest);
    const killerText = /killed by\s+(.*)$/.exec(rest);
    return {
      ...base,
      kind: 'kill',
      actor,                                                  // the victim
      target: other,                                          // the killer, when it is a player
      killer: other ? other.name : killerLabel(killerText ? killerText[1] : ''),
      weapon: weapon ? weapon[1].trim() : null,
      distance: distance ? Number(distance[1]) : null,
      pvp: !!other,
    };
  }
  if (/\bcommitted suicide\b/.test(rest)) return { ...base, kind: 'death', cause: 'suicide', actor };
  if (/\bbled out\b/.test(rest)) return { ...base, kind: 'death', cause: 'bled out', actor };
  if (/\bdied\b/.test(rest)) {
    const stats = /Stats>\s*(.*)$/.exec(rest);
    return { ...base, kind: 'death', cause: 'died', actor, text: stats ? stats[1] : null };
  }

  if (/\bhit by\b/.test(rest)) {
    const dmg = /for\s+([\d.]+)\s+damage/.exec(rest);
    const part = /into\s+([A-Za-z]+)/.exec(rest);
    const withWhat = /\bwith\s+([^\n(]+)/.exec(rest);
    return {
      ...base, kind: 'hit', actor, target: other,
      damage: dmg ? Number(dmg[1]) : null,
      bodyPart: part ? part[1] : null,
      weapon: withWhat ? withWhat[1].trim() : null,
    };
  }

  if (/\bis unconscious\b/.test(rest)) return { ...base, kind: 'unconscious', actor };
  if (/\bregained consciousness\b/.test(rest)) return { ...base, kind: 'conscious', actor };

  if ((m = /\b(placed|built|dismantled|folded|packed|deployed)\s+([A-Za-z0-9_ ]+)/.exec(rest))) {
    return { ...base, kind: 'build', action: m[1], object: m[2].trim(), actor };
  }
  if (/\b(emote|gesture)\b/i.test(rest)) return { ...base, kind: 'emote', actor };

  return { ...base, actor };
}

/** "an infected", "explosion", "FallDamage"... - the non-player half of a kill line. */
function killerLabel(s) {
  const t = String(s).replace(/\s*with\s+.*$/, '').replace(/\s*from\s+[\d.]+\s*meters?.*$/, '').trim();
  if (!t) return 'unknown';
  if (/infected|zombie/i.test(t)) return 'infected';
  if (/animal|wolf|bear/i.test(t)) return 'animal';
  if (/fall/i.test(t)) return 'fall damage';
  if (/explos/i.test(t)) return 'explosion';
  return t.slice(0, 60);
}

// ------------------------------------------------------------------ rollups --
/**
 * Everything the UI derives from a stream of admin-log events.
 * `since` limits the session and leaderboard maths to one time window without having to
 * re-read the log file.
 */
export function rollup(events, { onlineIds = null } = {}) {
  const players = new Map();      // id -> aggregate
  const sessions = [];
  const open = new Map();         // id -> connect event
  const deaths = [];
  const kills = [];
  const chat = [];

  const touch = (a, ts) => {
    if (!a || !a.id) return null;
    let p = players.get(a.id);
    if (!p) {
      p = {
        id: a.id, name: a.name, firstSeen: ts, lastSeen: ts, sessions: 0, playSeconds: 0,
        kills: 0, deaths: 0, pvpDeaths: 0, hitsDealt: 0, damageDealt: 0, chatLines: 0,
        longestShot: 0, weapons: {}, lastPos: null, online: false,
      };
      players.set(a.id, p);
    }
    if (a.name) p.name = a.name;
    p.lastSeen = ts;
    if (a.pos) p.lastPos = { ...a.pos, ts };
    return p;
  };

  for (const e of events) {
    const p = touch(e.actor, e.ts);
    switch (e.kind) {
      case 'connect':
        if (p) { p.sessions++; open.set(e.actor.id, e); }
        break;
      case 'disconnect': {
        if (!e.actor || !e.actor.id) break;
        const started = open.get(e.actor.id);
        open.delete(e.actor.id);
        const secs = started ? Math.max(0, secondsBetween(started.ts, e.ts)) : null;
        if (p && secs !== null) p.playSeconds += secs;
        sessions.push({ id: e.actor.id, name: e.actor.name, from: started ? started.ts : null, to: e.ts, seconds: secs });
        break;
      }
      case 'chat':
        if (p) p.chatLines++;
        chat.push(e);
        break;
      case 'kill': {
        if (p) { p.deaths++; if (e.pvp) p.pvpDeaths++; }
        const k = touch(e.target, e.ts);
        if (k) {
          k.kills++;
          if (e.distance && e.distance > k.longestShot) k.longestShot = e.distance;
          if (e.weapon) k.weapons[e.weapon] = (k.weapons[e.weapon] || 0) + 1;
        }
        kills.push(e);
        deaths.push(e);
        break;
      }
      case 'death':
        if (p) p.deaths++;
        deaths.push(e);
        break;
      case 'hit': {
        const h = touch(e.target, e.ts);
        if (h) { h.hitsDealt++; h.damageDealt += e.damage || 0; }
        break;
      }
      default:
        break;
    }
  }

  // Still-open sessions: connected, never disconnected, and (when the Steam query could be
  // read) still in the live player list.
  const now = new Date().toISOString().slice(0, 19);
  for (const [id, ev] of open) {
    const p = players.get(id);
    const secs = Math.max(0, secondsBetween(ev.ts, now));
    if (p) { p.online = true; p.sessionStart = ev.ts; p.sessionSeconds = secs; p.playSeconds += secs; }
  }
  if (onlineIds) for (const p of players.values()) if (!onlineIds.has(p.id)) p.online = p.online && false;

  const list = [...players.values()].map((p) => ({
    ...p,
    kd: p.deaths ? Math.round((p.kills / p.deaths) * 100) / 100 : p.kills,
    topWeapon: Object.entries(p.weapons).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
  }));

  return {
    players: list.sort((a, b) => (b.lastSeen > a.lastSeen ? 1 : -1)),
    online: list.filter((p) => p.online),
    sessions: sessions.reverse(),
    kills: kills.slice().reverse(),
    deaths: deaths.slice().reverse(),
    chat: chat.slice().reverse(),
  };
}

function secondsBetween(a, b) {
  const ta = Date.parse(`${a}Z`), tb = Date.parse(`${b}Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 1000);
}
