// Valve A2S query client (UDP), dependency free.
//
// This is the only channel through which the status page really "asks the server", so it
// implements the three parts DayZ answers: A2S_INFO, A2S_PLAYERS and A2S_RULES. Three
// details are easy to get wrong and are handled explicitly:
//   * every request may be answered with a 0x41 challenge that has to be echoed back;
//   * A2S_RULES usually arrives as several 0xFFFFFFFE split packets that have to be
//     reassembled in order, and their payload may be bzip2-compressed (which is reported
//     rather than guessed at, because this container ships no bzip2);
//   * DayZ packs its mod list into numbered rules using Bohemia's escaped byte stream.
import dgram from 'node:dgram';

const REQ_INFO = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'ascii')]);
const REQ_PLAYERS = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x55, 0xff, 0xff, 0xff, 0xff]);
const REQ_RULES = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x56, 0xff, 0xff, 0xff, 0xff]);

class Reader {
  constructor(buf) { this.b = buf; this.i = 0; }
  get left() { return this.b.length - this.i; }
  u8() { return this.b.readUInt8(this.i++); }
  u16() { const v = this.b.readUInt16LE(this.i); this.i += 2; return v; }
  i32() { const v = this.b.readInt32LE(this.i); this.i += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.i); this.i += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.i); this.i += 8; return v.toString(); }
  str(encoding = 'utf8') {
    const end = this.b.indexOf(0, this.i);
    const stop = end < 0 ? this.b.length : end;
    const s = this.b.toString(encoding, this.i, stop);
    this.i = stop + 1;
    return s;
  }
}

/** One request/response exchange with challenge retry and split-packet reassembly. */
function exchange(host, port, request, { timeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const parts = new Map();
    let done = false, sentAt = 0, triedChallenge = false, expected = null;

    const finish = (err, payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve({ payload, rttMs: Date.now() - sentAt });
    };
    const timer = setTimeout(() => finish(new Error(`no answer from ${host}:${port} within ${timeout} ms`)), timeout);
    const send = (buf) => {
      if (!sentAt) sentAt = Date.now();
      sock.send(buf, port, host, (e) => { if (e) finish(e); });
    };

    function handle(body) {
      // 0x41 = "solve this challenge first". Loopback clients usually skip it; anything
      // coming from another container or from the host gateway does not.
      if (body.length >= 5 && body.readUInt8(0) === 0x41 && !triedChallenge) {
        triedChallenge = true;
        parts.clear(); expected = null;
        const challenge = body.subarray(1, 5);
        if (request.readUInt8(4) === 0x54) return send(Buffer.concat([request, challenge]));
        const next = Buffer.from(request);
        challenge.copy(next, next.length - 4);
        return send(next);
      }
      finish(null, body);
    }

    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => {
      if (msg.length < 5) return;
      const head = msg.readInt32LE(0);
      if (head === -2) {
        const id = msg.readUInt32LE(4);
        expected = msg.readUInt8(8);
        const number = msg.readUInt8(9);
        if (number === 0 && (id & 0x80000000) !== 0) {
          return finish(new Error('the server compressed its answer (bzip2), which this container cannot unpack'));
        }
        parts.set(number, msg.subarray(12));          // id(4) + total(1) + number(1) + splitSize(2)
        if (parts.size !== expected) return;
        const joined = Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k)));
        return handle(joined.readInt32LE(0) === -1 ? joined.subarray(4) : joined);
      }
      if (head === -1) handle(msg.subarray(4));
    });

    send(request);
  });
}

export async function info(host, port, opts = {}) {
  const { payload, rttMs } = await exchange(host, port, REQ_INFO, opts);
  const r = new Reader(payload);
  const type = r.u8();
  if (type !== 0x49) throw new Error(`unexpected A2S_INFO reply type 0x${type.toString(16)}`);
  const out = {
    protocol: r.u8(), name: r.str(), map: r.str(), folder: r.str(), game: r.str(),
    appId: r.u16(), players: r.u8(), maxPlayers: r.u8(), bots: r.u8(),
    serverType: String.fromCharCode(r.u8()), environment: String.fromCharCode(r.u8()),
    visibility: r.u8(), vac: r.u8(), version: r.str(),
  };
  if (r.left >= 1) {
    const edf = r.u8();
    if (edf & 0x80 && r.left >= 2) out.gamePort = r.u16();
    if (edf & 0x10 && r.left >= 8) out.serverSteamId = r.u64();
    if (edf & 0x40 && r.left >= 3) { out.specPort = r.u16(); out.specName = r.str(); }
    if (edf & 0x20 && r.left >= 1) out.keywords = r.str();
    if (edf & 0x01 && r.left >= 8) out.gameId = r.u64();
  }
  out.rttMs = rttMs;
  out.tags = decodeKeywords(out.keywords || '');
  out.passworded = out.visibility === 1;
  out.serverTypeLabel = { d: 'dedicated', l: 'listen', p: 'SourceTV relay' }[out.serverType] || out.serverType;
  out.environmentLabel = { l: 'Linux', w: 'Windows', m: 'macOS', o: 'macOS' }[out.environment] || out.environment;
  return out;
}

export async function players(host, port, opts = {}) {
  const { payload, rttMs } = await exchange(host, port, REQ_PLAYERS, opts);
  const r = new Reader(payload);
  const type = r.u8();
  if (type !== 0x44) throw new Error(`unexpected A2S_PLAYER reply type 0x${type.toString(16)}`);
  const count = r.u8();
  const list = [];
  for (let n = 0; n < count && r.left >= 6; n++) {
    const index = r.u8(), name = r.str(), score = r.i32(), seconds = r.f32();
    list.push({ index, name, score, seconds: Number.isFinite(seconds) ? Math.round(seconds) : null });
  }
  // DayZ reports the head count in A2S_INFO, but builds exist that answer A2S_PLAYER with
  // empty names, so the caller is told how much of this list is actually usable.
  return { count, players: list, named: list.filter((p) => p.name && p.name.trim()).length, rttMs };
}

export async function rules(host, port, opts = {}) {
  const { payload, rttMs } = await exchange(host, port, REQ_RULES, opts);
  const r = new Reader(payload);
  const type = r.u8();
  if (type !== 0x45) throw new Error(`unexpected A2S_RULES reply type 0x${type.toString(16)}`);
  const count = r.u16();
  const list = [];
  // Rule values are read byte for byte (latin1): the numbered rules of a Bohemia engine are
  // binary, and decoding them as UTF-8 first would replace every byte above 0x7f. `value`
  // is the text form for display, `valueRaw` the bytes the mod-list decoder needs.
  for (let n = 0; n < count && r.left >= 2; n++) {
    const name = r.str();
    const valueRaw = r.str('latin1');
    list.push({ name, valueRaw, value: Buffer.from(valueRaw, 'latin1').toString('utf8') });
  }
  return { count, rules: list, rttMs, bohemia: decodeBohemiaRules(list) };
}

// ------------------------------------------------------------------ keywords --
// DayZ crams its server tags into the A2S_INFO keywords field as a comma separated list.
// Only tokens whose meaning is stable across builds get a label; everything else is passed
// through verbatim so that nothing is silently dropped.
const TAG_LABELS = {
  battleye: 'BattlEye enabled',
  no3rd: 'first person only',
  privHive: 'private hive (characters stay on this server)',
  publicHive: 'public hive (shared characters)',
  external: 'community server',
  mod: 'running mods',
  isDLC: 'DLC content',
  allowedFilePatching: 'file patching allowed',
};

export function decodeKeywords(keywords) {
  const out = [];
  for (const raw of String(keywords).split(',').map((s) => s.trim()).filter(Boolean)) {
    let m;
    if (TAG_LABELS[raw]) out.push({ raw, label: TAG_LABELS[raw] });
    else if ((m = /^lqs(\d+)$/.exec(raw))) out.push({ raw, label: `login queue ${m[1]}` });
    else if ((m = /^etm([\d.]+)$/.exec(raw))) out.push({ raw, label: `day time acceleration ${Number(m[1])}x`, key: 'timeAcceleration', value: Number(m[1]) });
    else if ((m = /^entm([\d.]+)$/.exec(raw))) out.push({ raw, label: `night time acceleration ${Number(m[1])}x`, key: 'nightTimeAcceleration', value: Number(m[1]) });
    else if ((m = /^shard(\d+)$/.exec(raw))) out.push({ raw, label: `shard ${Number(m[1])}` });
    else if ((m = /^(allowedBuild|requiredBuild|requiredVersion):?(\d+)$/.exec(raw))) out.push({ raw, label: `${m[1]} ${m[2]}`, key: m[1], value: Number(m[2]) });
    else out.push({ raw, label: null });
  }
  return out;
}

// ------------------------------------------------------------------ mod list --
// Bohemia engines answer A2S_RULES with rules named "0", "1", "2"... whose values, once
// concatenated and unescaped, form one binary stream carrying the DLC flags, the mod list
// and the signature list. The header length in front of the mod block has changed between
// engine versions, so rather than trust one offset the decoder tries every plausible start
// and keeps the first that yields a completely self-consistent block.
export function unescapeBohemia(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x01 && i + 1 < buf.length) {
      const next = buf[++i];
      out[n++] = next === 0x01 ? 0x01 : next === 0x02 ? 0x00 : next === 0x03 ? 0xff : next;
    } else out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

function tryModBlock(b, start) {
  let i = start;
  if (i >= b.length) return null;
  const count = b[i++];
  if (count === 0 || count > 64) return null;
  const mods = [];
  for (let m = 0; m < count; m++) {
    if (i + 2 > b.length) return null;
    const hashLen = b[i++];
    if (hashLen > 8 || i + hashLen + 1 > b.length) return null;
    const hash = b.subarray(i, i + hashLen); i += hashLen;
    const idLen = b[i++];
    if (idLen > 8 || i + idLen + 1 > b.length) return null;
    let id = 0n;
    for (let k = 0; k < idLen; k++) id |= BigInt(b[i + k]) << BigInt(8 * k);
    i += idLen;
    const nameLen = b[i++];
    if (nameLen === 0 || nameLen > 127 || i + nameLen > b.length) return null;
    const name = b.toString('utf8', i, i + nameLen); i += nameLen;
    if (!/^[^\u0000-\u001f]+$/.test(name)) return null;
    mods.push({ name, workshopId: id ? id.toString() : null, hash: hash.toString('hex'), source: 'A2S_RULES' });
  }
  return { mods, end: i };
}

export function decodeBohemiaRules(list) {
  const numbered = list.filter((r) => /^\d+$/.test(r.name)).sort((a, b) => Number(a.name) - Number(b.name));
  if (!numbered.length) {
    return { encoded: false, mods: [], note: 'the server answered with plain rules, not with a Bohemia byte stream' };
  }
  const raw = Buffer.concat(numbered.map((r) => Buffer.from(r.valueRaw ?? r.value, 'latin1')));
  const b = unescapeBohemia(raw);
  for (let start = 0; start < Math.min(b.length, 64); start++) {
    const got = tryModBlock(b, start);
    if (got && got.mods.length) {
      return { encoded: true, mods: got.mods, headerBytes: start, streamBytes: b.length, hex: b.subarray(0, 96).toString('hex') };
    }
  }
  return {
    encoded: true, mods: [], streamBytes: b.length, hex: b.subarray(0, 96).toString('hex'),
    note: 'no mod list found in the byte stream - which is what a server without mods looks like',
  };
}

/** All three queries at once; each may fail on its own without hiding the others. */
export async function queryAll(host, port, opts = {}) {
  const [i, p, r] = await Promise.allSettled([info(host, port, opts), players(host, port, opts), rules(host, port, opts)]);
  const unwrap = (s) => (s.status === 'fulfilled'
    ? { ok: true, ...s.value }
    : { ok: false, error: String((s.reason && s.reason.message) || s.reason) });
  return { host, port, at: Date.now(), info: unwrap(i), players: unwrap(p), rules: unwrap(r) };
}
