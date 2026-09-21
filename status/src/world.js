// World geometry and the in-game clock.
//
// Nothing here is asked of the server: DayZ does not report its world time over any query
// this container can send. The clock is therefore RECONSTRUCTED from the three settings
// that determine it (serverTime, serverTimeAcceleration, serverNightTimeAcceleration) plus
// the moment the server process started, and the UI labels it as an estimate. It is right
// to the second after a fresh start and drifts only if the engine's own sunrise differs
// from the day window configured below.

/** Default edge length in metres. Corrected from the mission's own data when available. */
export const WORLDS = {
  chernarusplus: { label: 'Chernarus+', size: 15360 },
  enoch: { label: 'Livonia', size: 12800 },
  sakhal: { label: 'Sakhal', size: 10240 },
  chernarus: { label: 'Chernarus', size: 15360 },
  namalsk: { label: 'Namalsk', size: 12800 },
  banov: { label: 'Banov', size: 12800 },
  deerisle: { label: 'DeerIsle', size: 16384 },
  esseker: { label: 'Esseker', size: 12800 },
  livonia: { label: 'Livonia', size: 12800 },
};

export function worldInfo(world, { observedMax = 0, override = 0 } = {}) {
  const key = String(world || '').toLowerCase();
  const known = WORLDS[key] || null;
  let size = override || known?.size || 0;
  // A modded map is bigger than its table entry far more often than the log is wrong.
  if (observedMax && observedMax > size) size = Math.ceil(observedMax / 1024) * 1024;
  if (!size) size = 15360;
  return { world: key || null, label: known?.label || world || 'unknown', size, known: !!known, sizeSource: override ? 'configured' : known && size === known.size ? 'known world' : 'derived from mission data' };
}

/** DayZ's in-game map grid: kilometre squares counted from the south-west corner. */
export function gridRef(x, z, size) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const col = Math.floor(x / 100).toString().padStart(3, '0');
  const row = Math.floor(z / 100).toString().padStart(3, '0');
  return `${col} ${row}`;
}

// ------------------------------------------------------------------- clock ---
function parseServerTime(serverTime, startEpochMs, tzOffsetMinutes) {
  // "2026/06/01/09/00" - a fixed start date and time, in the server's own time zone.
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\/(\d{1,2})\/(\d{1,2})$/.exec(String(serverTime || '').trim());
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - tzOffsetMinutes * 60000;
  // "SystemTime" (and anything unrecognised): the world starts at the wall clock.
  return startEpochMs;
}

function minutesOfDay(ms) {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
}

/**
 * Advance the in-game clock over `elapsedSeconds` of real time, switching acceleration at
 * every sunrise and sunset instead of averaging - a server on 1x day / 12x night really
 * does skip the night in a couple of hours, and averaging would hide that.
 */
export function inGameClock({
  serverTime = 'SystemTime',
  timeAcceleration = 1,
  nightTimeAcceleration = 1,
  startEpochMs,
  nowMs = Date.now(),
  tzOffsetMinutes = 0,
  dayStartHour = 5,
  dayEndHour = 19,
} = {}) {
  if (!startEpochMs) return null;
  const dayAccel = Math.max(0, Number(timeAcceleration) || 0);
  const nightAccel = Math.max(0, Number(nightTimeAcceleration) || 0) * dayAccel;
  const dayStart = dayStartHour * 60, dayEnd = dayEndHour * 60;

  let game = parseServerTime(serverTime, startEpochMs, tzOffsetMinutes) + tzOffsetMinutes * 60000;
  let realLeft = Math.max(0, (nowMs - startEpochMs) / 1000);

  for (let guard = 0; realLeft > 0.001 && guard < 5000; guard++) {
    const mins = minutesOfDay(game);
    const night = mins < dayStart || mins >= dayEnd;
    const accel = night ? nightAccel : dayAccel;
    if (accel <= 0) { realLeft = 0; break; }                    // frozen world time
    const nextBoundaryMins = night ? (mins < dayStart ? dayStart : 1440 + dayStart) : dayEnd;
    const gameSecondsToBoundary = (nextBoundaryMins - mins) * 60;
    const realSecondsToBoundary = gameSecondsToBoundary / accel;
    const step = Math.min(realLeft, Math.max(realSecondsToBoundary, 0.001));
    game += step * accel * 1000;
    realLeft -= step;
  }

  const d = new Date(game);
  const mins = minutesOfDay(game);
  const night = mins < dayStart || mins >= dayEnd;
  return {
    iso: d.toISOString().replace('Z', ''),
    time: d.toISOString().slice(11, 19),
    date: d.toISOString().slice(0, 10),
    night,
    phase: night ? 'night' : 'day',
    accelerationNow: night ? nightAccel : dayAccel,
    dayLengthHours: dayAccel > 0 ? Math.round((24 / dayAccel) * 10) / 10 : null,
    estimated: true,
    basis: /^SystemTime$/i.test(String(serverTime)) ? 'server start time (serverTime=SystemTime)' : `serverTime=${serverTime}`,
  };
}
