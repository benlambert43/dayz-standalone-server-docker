// Tests for the status page. No Docker, no Steam account, no running game server: the A2S
// tests talk to a fake DayZ query responder started inside this process, which also lets
// them cover the two things that are easy to get wrong - the challenge handshake and split
// packet reassembly.
//
//   node status/test/run-tests.js
//   docker compose run --rm --no-deps -v "./status/test:/opt/status/test:ro" status node test/run-tests.js
import dgram from 'node:dgram';
import assert from 'node:assert/strict';
import { parseXml, child, children, textOf, find, decodeEntities } from '../src/xml.js';
import { parseAdm, rollup } from '../src/adm.js';
import * as a2s from '../src/a2s.js';
import { inGameClock, worldInfo, gridRef } from '../src/world.js';
import { redactServerCfg, redactEnvList, human, duration, isSecretKey } from '../src/util.js';
import { summariseRpt, parseRptHeader, classifyRptLine, parseLoadedAddons, findDataKicks, readRpt } from '../src/logs.js';
import { evaluate } from '../src/health.js';
import { summariseStats } from '../src/dockerapi.js';
import { parseServerCfgValues, appManifest, installedMods, modsFromArgs, countListEntries } from '../src/mission.js';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0, group = '';
const section = (s) => { group = s; console.log(`\n${s}`); };
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (err) { fail++; console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').slice(0, 6).join('\n        ')}`); }
}
async function acheck(name, fn) {
  try { await fn(); pass++; console.log(`  ok    ${name}`); }
  catch (err) { fail++; console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').slice(0, 6).join('\n        ')}`); }
}

// ------------------------------------------------------------------ 1. xml ---
section('1. XML reader');
{
  const doc = parseXml(`<?xml version="1.0"?>
    <types>
      <!-- a comment with <angle> brackets -->
      <type name="AKM">
        <nominal>10</nominal><min>5</min>
        <flags count_in_map="1" deloot='0'/>
        <category name="weapons"/>
        <usage name="Military"/><usage name="Police"/>
      </type>
      <type name="Un&amp;closed">
        <nominal>3</nominal>
      </type>
    </types>`);
  const root = find(doc, 'types');
  const list = children(root, 'type');
  check('finds both types', () => assert.equal(list.length, 2));
  check('reads attributes in both quote styles', () => {
    assert.equal(child(list[0], 'flags').attrs.count_in_map, '1');
    assert.equal(child(list[0], 'flags').attrs.deloot, '0');
  });
  check('reads element text', () => assert.equal(textOf(child(list[0], 'nominal')), '10'));
  check('keeps repeated elements', () => assert.equal(children(list[0], 'usage').length, 2));
  check('decodes entities in attributes', () => assert.equal(list[1].attrs.name, 'Un&closed'));
  check('skips comments containing markup', () => assert.equal(children(root, 'type').length, 2));
  check('decodes numeric entities', () => assert.equal(decodeEntities('a&#65;b&#x42;'), 'aAbB'));
  check('survives an unclosed element', () => {
    const d = parseXml('<a><b><c>x</c></a>');
    assert.equal(find(d, 'c').text, 'x');
  });
  check('survives a stray ampersand', () => assert.equal(parseXml('<a>Tom & Jerry</a>').children[0].text.trim(), 'Tom & Jerry'));
}

// ------------------------------------------------------------------ 2. adm ---
section('2. Admin log parser');
const ADM = [
  'AdminLog started on 2026-09-19 at 22:58:00',
  '22:58:10 | Player "Survivor Sam" is connected (id=AbCd1234EfGh5678)',
  '22:58:40 | Chat("Survivor Sam"(id=AbCd1234EfGh5678 pos=<7500.5, 8500.25, 301.4>)): hello there',
  '22:59:00 | Player "Survivor Sam"(id=AbCd1234EfGh5678 pos=<7501.0, 8502.0, 301.0>) placed Fireplace',
  '23:00:00 | Player "Bandit Bob"(id=ZzZz9999YyYy8888 pos=<7600.0, 8600.0, 300.0>) is unconscious',
  '23:01:00 | Player "Bandit Bob"(DEAD)(id=ZzZz9999YyYy8888 pos=<7600.0, 8600.0, 300.0>) killed by Player "Survivor Sam"(id=AbCd1234EfGh5678 pos=<7500.0, 8500.0, 301.0>) with M4-A1 from 141.42 meters',
  '23:02:00 | Player "Survivor Sam"(id=AbCd1234EfGh5678 pos=<7500.0, 8500.0, 301.0>) hit by Player "Ghost"(id=QqQq pos=<7510.0, 8510.0, 300.0>) into Head for 55.5 damage',
  '23:03:00 | Player "Survivor Sam"(DEAD)(id=AbCd1234EfGh5678 pos=<7500.0, 8500.0, 301.0>) died. Stats> Water: 250 Energy: 300 Bleed sources: 2',
  '23:59:59 | Player "Night Owl" is connected (id=NnNn0000)',
  '00:00:30 | Player "Night Owl"(id=NnNn0000 pos=<1.0, 2.0, 3.0>) has been disconnected',
  '00:01:00 | Something the parser has never seen before',
];
const parsed = parseAdm(ADM.join('\n'));
const byKind = (k) => parsed.events.filter((e) => e.kind === k);
{
  check('reads the header date', () => assert.equal(parsed.startedAt, '2026-09-19T22:58:00'));
  check('counts every timestamped line', () => assert.equal(parsed.events.length, ADM.length - 1));
  check('connect without a position', () => {
    const e = byKind('connect')[0];
    assert.equal(e.actor.name, 'Survivor Sam');
    assert.equal(e.actor.id, 'AbCd1234EfGh5678');
    assert.equal(e.actor.pos, null);
  });
  check('chat text and position', () => {
    const e = byKind('chat')[0];
    assert.equal(e.text, 'hello there');
    assert.equal(e.actor.name, 'Survivor Sam');
    assert.deepEqual(e.actor.pos, { x: 7500.5, z: 8500.25, y: 301.4 });
  });
  check('chat is still recognised when the line says "Player" inside the brackets', () => {
    const p = parseAdm('AdminLog started on 2026-09-19 at 10:00:00\n10:00:01 | Chat(Player "Sam"(id=X pos=<1.0, 2.0, 3.0>)): hi\n');
    assert.equal(p.events[0].kind, 'chat');
    assert.equal(p.events[0].text, 'hi');
    assert.equal(p.events[0].actor.name, 'Sam');
  });
  check('chat is still recognised without the outer brackets', () => {
    const p = parseAdm('AdminLog started on 2026-09-19 at 10:00:00\n10:00:01 | Chat "Sam"(id=X): hi there\n');
    assert.equal(p.events[0].kind, 'chat');
    assert.equal(p.events[0].text, 'hi there');
  });
  check('build action', () => {
    const e = byKind('build')[0];
    assert.equal(e.action, 'placed');
    assert.equal(e.object, 'Fireplace');
  });
  check('unconscious', () => assert.equal(byKind('unconscious')[0].actor.name, 'Bandit Bob'));
  check('kill: victim, killer, weapon and distance', () => {
    const e = byKind('kill')[0];
    assert.equal(e.actor.name, 'Bandit Bob');
    assert.equal(e.actor.dead, true);
    assert.equal(e.target.name, 'Survivor Sam');
    assert.equal(e.killer, 'Survivor Sam');
    assert.equal(e.weapon, 'M4-A1');
    assert.equal(e.distance, 141.42);
    assert.equal(e.pvp, true);
  });
  check('hit: damage, body part and who hit whom', () => {
    const e = byKind('hit')[0];
    assert.equal(e.actor.name, 'Survivor Sam');
    assert.equal(e.target.name, 'Ghost');
    assert.equal(e.damage, 55.5);
    assert.equal(e.bodyPart, 'Head');
  });
  check('death keeps the stats tail', () => {
    const e = byKind('death').find((x) => x.cause === 'died');
    assert.match(e.text, /Bleed sources: 2/);
  });
  check('rolls over midnight into the next day', () => {
    const d = byKind('disconnect')[0];
    assert.equal(d.ts.slice(0, 10), '2026-09-20');
  });
  check('keeps unrecognised lines as "other" with the raw text', () => {
    const e = parsed.events[parsed.events.length - 1];
    assert.equal(e.kind, 'other');
    assert.match(e.raw, /never seen before/);
  });
  check('a garbage file produces no events instead of throwing', () => {
    assert.equal(parseAdm('\u0000\u0001 not a log at all\n').events.length, 0);
  });
}

section('3. Admin log rollups');
{
  const r = rollup(parsed.events);
  const sam = r.players.find((p) => p.name === 'Survivor Sam');
  const bob = r.players.find((p) => p.name === 'Bandit Bob');
  check('credits the kill to the killer', () => assert.equal(sam.kills, 1));
  check('counts deaths for the victim', () => assert.equal(bob.deaths, 1));
  check('counts the victim of the "died" line too', () => assert.equal(sam.deaths, 1));
  check('records the longest shot and the weapon', () => {
    assert.equal(sam.longestShot, 141.42);
    assert.equal(sam.topWeapon, 'M4-A1');
  });
  check('counts chat lines', () => assert.equal(sam.chatLines, 1));
  check('pairs a connect with its disconnect', () => {
    const s = r.sessions.find((x) => x.name === 'Night Owl');
    assert.equal(s.seconds, 31);
  });
  check('a still-open session counts as online', () => assert.equal(sam.online, true));
  check('tracks the last known position', () => assert.equal(Math.round(sam.lastPos.x), 7500));
}

// ------------------------------------------------------------------ 4. a2s ---
// A stand-in for the DayZ query port. It insists on the challenge handshake (which is what
// a real server does to anything that is not loopback) and splits its rules answer, so both
// of the awkward parts of the protocol are actually exercised.
const CHALLENGE = Buffer.from([0x11, 0x22, 0x33, 0x44]);

function cstr(s) { return Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]); }
function escapeBohemia(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 0x01) out.push(0x01, 0x01);
    else if (b === 0x00) out.push(0x01, 0x02);
    else if (b === 0xff) out.push(0x01, 0x03);
    else out.push(b);
  }
  return Buffer.from(out);
}

const WORKSHOP_ID = 1559212036;
function buildModStream() {
  const name = Buffer.from('Community Framework', 'utf8');
  const id = Buffer.alloc(4);
  id.writeUInt32LE(WORKSHOP_ID);
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0]),                                   // header the decoder must skip
    Buffer.from([1]),                                            // one mod
    Buffer.from([4]), Buffer.from([0xde, 0xad, 0xbe, 0xef]),     // hash
    Buffer.from([4]), id,                                        // workshop id, little endian
    Buffer.from([name.length]), name,
  ]);
}

function buildInfo() {
  const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]);
  const strings = Buffer.concat([cstr('Test DayZ Server'), cstr('chernarusplus'), cstr('dayz'), cstr('DayZ')]);
  const nums = Buffer.alloc(9);
  // DayZ's app id (221100) does not fit the protocol's 16-bit field, so a real server sends
  // the low half. The client must report exactly that rather than pretending otherwise.
  nums.writeUInt16LE(221100 & 0xffff, 0);
  nums.writeUInt8(7, 2); nums.writeUInt8(60, 3); nums.writeUInt8(0, 4);
  nums.writeUInt8('d'.charCodeAt(0), 5); nums.writeUInt8('l'.charCodeAt(0), 6);
  nums.writeUInt8(0, 7); nums.writeUInt8(1, 8);
  const port = Buffer.alloc(2); port.writeUInt16LE(2302);
  const steamId = Buffer.alloc(8); steamId.writeBigUInt64LE(90200000000000000n);
  return Buffer.concat([
    head, strings, nums, cstr('1.28.159123'),
    Buffer.from([0x80 | 0x10 | 0x20]), port, steamId,
    cstr('battleye,no3rd,privHive,lqs5,etm2.000000,entm4.000000,shard007,allowedBuild:1'),
  ]);
}

function buildPlayers() {
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, 2])];
  [['Survivor Sam', 3, 1830.5], ['Bandit Bob', 0, 42.25]].forEach(([n, score, secs], i) => {
    const tail = Buffer.alloc(8);
    tail.writeInt32LE(score, 0);
    tail.writeFloatLE(secs, 4);
    parts.push(Buffer.from([i]), cstr(n), tail);
  });
  return Buffer.concat(parts);
}

function buildRules() {
  const stream = escapeBohemia(buildModStream());
  const half = Math.ceil(stream.length / 2);
  const entries = [['0', stream.subarray(0, half)], ['1', stream.subarray(half)], ['plainRule', Buffer.from('yes')]];
  const count = Buffer.alloc(2); count.writeUInt16LE(entries.length);
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x45]), count,
    ...entries.flatMap(([k, v]) => [cstr(k), v, Buffer.from([0])]),
  ]);
}

function split(payload, parts = 3) {
  const size = Math.ceil(payload.length / parts);
  const out = [];
  for (let i = 0; i < parts; i++) {
    const head = Buffer.alloc(12);
    head.writeInt32LE(-2, 0);
    head.writeUInt32LE(0x1234, 4);      // request id, compression bit clear
    head.writeUInt8(parts, 8);
    head.writeUInt8(i, 9);
    head.writeUInt16LE(size, 10);
    out.push(Buffer.concat([head, payload.subarray(i * size, (i + 1) * size)]));
  }
  return out;
}

function startFakeServer() {
  const sock = dgram.createSocket('udp4');
  const seen = { challenged: 0, answered: 0 };
  sock.on('message', (msg, rinfo) => {
    const kind = msg.readUInt8(4);
    const tail = msg.subarray(msg.length - 4);
    const solved = tail.equals(CHALLENGE);
    if (!solved) {
      seen.challenged++;
      return sock.send(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), CHALLENGE]), rinfo.port, rinfo.address);
    }
    seen.answered++;
    if (kind === 0x54) return sock.send(buildInfo(), rinfo.port, rinfo.address);
    if (kind === 0x55) return sock.send(buildPlayers(), rinfo.port, rinfo.address);
    if (kind === 0x56) {
      // Deliberately out of order: the client has to sort the parts before joining them.
      const parts = split(buildRules(), 3);
      for (const p of [parts[2], parts[0], parts[1]]) sock.send(p, rinfo.port, rinfo.address);
      return;
    }
  });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve({ sock, port: sock.address().port, seen })));
}

section('4. Steam A2S client');
const fake = await startFakeServer();
{
  await acheck('A2S_INFO survives the challenge handshake', async () => {
    const i = await a2s.info('127.0.0.1', fake.port, { timeout: 1500 });
    assert.equal(i.name, 'Test DayZ Server');
    assert.equal(i.map, 'chernarusplus');
    assert.equal(i.players, 7);
    assert.equal(i.maxPlayers, 60);
    assert.equal(i.version, '1.28.159123');
    assert.equal(i.environmentLabel, 'Linux');
    assert.equal(i.serverTypeLabel, 'dedicated');
    assert.equal(i.gamePort, 2302);
    assert.equal(i.vac, 1);
    assert.equal(i.passworded, false);
    assert.equal(i.appId, 221100 & 0xffff);
    assert.ok(fake.seen.challenged > 0, 'the server should have issued a challenge');
  });

  await acheck('keywords are decoded into readable tags', async () => {
    const i = await a2s.info('127.0.0.1', fake.port, { timeout: 1500 });
    const by = Object.fromEntries(i.tags.map((t) => [t.raw, t]));
    assert.equal(by.battleye.label, 'BattlEye enabled');
    assert.equal(by.no3rd.label, 'first person only');
    assert.equal(by['etm2.000000'].value, 2);
    assert.equal(by['entm4.000000'].value, 4);
    assert.equal(by.shard007.label, 'shard 7');
    assert.equal(by.lqs5.label, 'login queue 5');
  });

  await acheck('A2S_PLAYER reads names, scores and session length', async () => {
    const p = await a2s.players('127.0.0.1', fake.port, { timeout: 1500 });
    assert.equal(p.count, 2);
    assert.equal(p.named, 2);
    assert.equal(p.players[0].name, 'Survivor Sam');
    assert.equal(p.players[0].score, 3);
    assert.equal(p.players[0].seconds, 1831);
    assert.equal(p.players[1].name, 'Bandit Bob');
  });

  await acheck('A2S_RULES reassembles out-of-order split packets', async () => {
    const r = await a2s.rules('127.0.0.1', fake.port, { timeout: 1500 });
    assert.equal(r.count, 3);
    assert.equal(r.rules.find((x) => x.name === 'plainRule').value, 'yes');
  });

  await acheck('the mod list is decoded out of the Bohemia byte stream', async () => {
    const r = await a2s.rules('127.0.0.1', fake.port, { timeout: 1500 });
    assert.equal(r.bohemia.encoded, true);
    assert.equal(r.bohemia.mods.length, 1);
    assert.equal(r.bohemia.mods[0].name, 'Community Framework');
    assert.equal(r.bohemia.mods[0].workshopId, String(WORKSHOP_ID));
    assert.equal(r.bohemia.mods[0].hash, 'deadbeef');
  });

  check('a server with no mods reports none rather than guessing', () => {
    const out = a2s.decodeBohemiaRules([{ name: '0', valueRaw: '\u0000\u0000\u0000' }]);
    assert.equal(out.mods.length, 0);
    assert.match(out.note, /without mods/);
  });

  check('plain rules are recognised as not being a byte stream', () => {
    const out = a2s.decodeBohemiaRules([{ name: 'allowedBuild', valueRaw: '1' }]);
    assert.equal(out.encoded, false);
  });

  check('unescaping restores 0x00, 0x01 and 0xff', () => {
    const src = Buffer.from([0x00, 0x01, 0xff, 0x41]);
    assert.deepEqual([...a2s.unescapeBohemia(escapeBohemia(src))], [...src]);
  });

  await acheck('a silent port fails with a clear message instead of hanging', async () => {
    await assert.rejects(() => a2s.info('127.0.0.1', 1, { timeout: 300 }), /no answer|EACCES|ECONNREFUSED/);
  });

  await acheck('queryAll keeps the answers that worked', async () => {
    const all = await a2s.queryAll('127.0.0.1', fake.port, { timeout: 1500 });
    assert.equal(all.info.ok, true);
    assert.equal(all.players.ok, true);
    assert.equal(all.rules.ok, true);
  });
}
fake.sock.close();

// -------------------------------------------------------------- 5. the clock -
section('5. In-game clock');
{
  const start = Date.parse('2026-06-01T00:00:00Z');
  check('a fixed serverTime advances at the day acceleration', () => {
    const c = inGameClock({ serverTime: '2026/06/01/08/00', timeAcceleration: 1, nightTimeAcceleration: 1, startEpochMs: start, nowMs: start + 3600_000 });
    assert.equal(c.time, '09:00:00');
    assert.equal(c.night, false);
  });
  check('night acceleration takes over after sunset', () => {
    // 18:00 + one real hour at 1x reaches 19:00, then half an hour at 4x adds two more.
    const c = inGameClock({ serverTime: '2026/06/01/18/00', timeAcceleration: 1, nightTimeAcceleration: 4, startEpochMs: start, nowMs: start + 5400_000 });
    assert.equal(c.time, '21:00:00');
    assert.equal(c.night, true);
    assert.equal(c.accelerationNow, 4);
  });
  check('a 12x server has a two hour day', () => {
    const c = inGameClock({ serverTime: 'SystemTime', timeAcceleration: 12, nightTimeAcceleration: 1, startEpochMs: start, nowMs: start });
    assert.equal(c.dayLengthHours, 2);
    assert.match(c.basis, /SystemTime/);
  });
  check('acceleration 0 freezes the clock instead of looping forever', () => {
    const c = inGameClock({ serverTime: '2026/06/01/12/00', timeAcceleration: 0, startEpochMs: start, nowMs: start + 86400_000 });
    assert.equal(c.time, '12:00:00');
  });
  check('no start time means no clock at all, rather than a wrong one', () => {
    assert.equal(inGameClock({ startEpochMs: null }), null);
  });
  check('the clock is always flagged as an estimate', () => {
    assert.equal(inGameClock({ serverTime: 'SystemTime', startEpochMs: start, nowMs: start }).estimated, true);
  });
}

section('6. World geometry');
{
  check('known worlds get their real edge length', () => {
    assert.equal(worldInfo('chernarusplus').size, 15360);
    assert.equal(worldInfo('enoch').label, 'Livonia');
  });
  check('an unknown world falls back and says so', () => {
    const w = worldInfo('somemodmap');
    assert.equal(w.known, false);
    assert.ok(w.size >= 15360);
  });
  check('a map bigger than its table entry is grown, not clipped', () => {
    assert.equal(worldInfo('enoch', { observedMax: 16000 }).size, 16384);
  });
  check('an explicit override wins', () => assert.equal(worldInfo('chernarusplus', { override: 8192 }).size, 8192));
  check('grid reference counts 100 m squares', () => assert.equal(gridRef(7530, 8460, 15360), '075 084'));
}

// ------------------------------------------------------------- 7. redaction --
section('7. Redaction');
{
  const cfgText = [
    'hostname = "My password-protected server";',
    'password = "hunter2";',
    'passwordAdmin = "letmein";',
    'maxPlayers = 60;',
    'password = "";',
  ].join('\n');
  const out = redactServerCfg(cfgText);
  check('the join password is removed', () => assert.ok(!out.includes('hunter2')));
  check('the admin password is removed', () => assert.ok(!out.includes('letmein')));
  check('an empty password stays visible as empty', () => assert.match(out, /^password = "";$/m));
  check('only the lines that changed are marked as redacted', () => {
    assert.equal((out.match(/redacted by the status page/g) || []).length, 2);
  });
  check('unrelated settings are untouched', () => {
    assert.match(out, /maxPlayers = 60;/);
    assert.match(out, /My password-protected server/);
  });
  check('secret keys are recognised by name', () => {
    assert.ok(isSecretKey('STEAM_PASSWORD') && isSecretKey('ADMIN_PASSWORD') && isSecretKey('STEAM_GUARD_CODE'));
    assert.ok(!isSecretKey('SERVER_NAME') && !isSecretKey('MAX_PLAYERS'));
  });
  check('the container environment is redacted by key', () => {
    const list = redactEnvList(['STEAM_USERNAME=someone', 'STEAM_PASSWORD=S3cr3t', 'SERVER_NAME=Home', 'ADMIN_PASSWORD=']);
    assert.equal(list[0].value, 'someone');
    assert.equal(list[1].value, '********');
    assert.equal(list[1].secret, true);
    assert.equal(list[2].value, 'Home');
    assert.equal(list[3].value, '');
  });
  check('human and duration read naturally', () => {
    assert.equal(human(1536), '1.5 KB');
    assert.equal(duration(3725), '1h 2m');
    assert.equal(duration(90061), '1d 1h 1m');
  });
}

// ------------------------------------------------------------------ 8. logs --
section('8. Engine log');
{
  const rpt = [
    '=====================================================================',
    '== ./DayZServer',
    '== ./DayZServer -config=/dayz/data/config/serverDZ.cfg -port=2302',
    '=====================================================================',
    'Current time:  2026/09/19 22:57:41',
    'Type: Public',
    'Build: 159123',
    'Version 1.28.159123',
    'Allocator: /dayz/server/stable/dta/tbbmalloc.so',
    '22:58:01 Mission read.',
    '22:58:02 Warning Message: No entry .configfile/CfgVehicles.Nonsense.',
    "22:58:03 Can't compile \"World\" script module!",
    '22:58:04 [CE][Storage] ver:0 stamp:0, valid:YES',
    '22:58:05 Error position: <foo|#|bar>',
  ].join('\n');
  const head = parseRptHeader(rpt);
  check('reads the exact game version from the header', () => assert.equal(head.version, '1.28.159123'));
  check('reads the build number', () => assert.equal(head.build, '159123'));
  check('reads the branch type', () => assert.equal(head.type, 'Public'));
  const sum = summariseRpt(rpt);
  check('counts script errors', () => assert.ok(sum.counts.scriptError >= 2));
  check('counts warnings', () => assert.equal(sum.counts.warning, 1));
  check('recognises central economy lines', () => assert.equal(sum.counts.ce, 1));
  check('recognises the mission-read marker', () => assert.equal(sum.counts.mission, 1));
  check('keeps examples for each class', () => assert.match(sum.samples.warning[0], /No entry/));
  check('an ordinary line is classified as nothing', () => assert.equal(classifyRptLine('22:58:06 Player connected'), null));
}

// Lines copied from a real stable 1.29 log. The engine skips sakhal/ without a word when the
// server's user may not write to the folder, so this list is the only evidence there is.
const ADDONS_HEAD = [
  ' 3:16:02 Updating base class Overcast->, by DZ\\worlds\\chernarusplus\\world\\config.bin/CfgWorlds/CAWorld/Weather/Overcast/',
  ' 3:16:02 ',
  ' 3:16:02 ==== Loaded addons ====',
  ' 3:16:02 ',
  ' 3:16:02 dta/bin.pbo - 120569',
  ' 3:16:02 addons/worlds_chernarusplus_ce.pbo - 125393',
  ' 3:16:02 addons/data_bliss.pbo - 120565',
];
const ADDONS_SAKHAL = [
  ' 3:16:02 /dayz/server/stable/sakhal/addons/worlds_sakhal.ebo - 120940',
  ' 3:16:02 /dayz/server/stable/sakhal/addons/data_sakhal.pbo - 120565',
];
const ADDONS_END = [
  ' 3:16:02 ',
  ' 3:16:02 =======================',
  ' 3:16:02 ',
  " 3:16:04 ANIMATION (E): Can't load sakhal/Anims/cfg/skeletons.anim.xml",
];
const KICK_118 = ' 2:46:40 Player Unknown (520938673) kicked from server: 118 (Server installation is corrupt. Missing PBO from game files. (D:\\SteamLibrary\\steamapps\\common\\DayZ\\sakhal\\addons\\data_sakhal.pbo))';
{
  const loaded = parseLoadedAddons([...ADDONS_HEAD, ...ADDONS_SAKHAL, ...ADDONS_END].join('\n'));
  const skipped = parseLoadedAddons([...ADDONS_HEAD, ...ADDONS_END].join('\r\n'));
  check('counts the loaded addons, .ebo files included', () => assert.equal(loaded.count, 5));
  check('sees that sakhal/addons was loaded', () => assert.deepEqual(loaded.folders, ['sakhal']));
  check('sees that it was skipped - the skeleton error after the list does not count', () => {
    assert.equal(skipped.count, 3);
    assert.deepEqual(skipped.folders, []);
    assert.equal(skipped.complete, true);
  });
  check('a list that is cut off says so', () => assert.equal(parseLoadedAddons(ADDONS_HEAD.join('\n')).complete, false));
  check('a log without the list is null, not an empty list', () => assert.equal(parseLoadedAddons('22:58:01 Mission read.'), null));

  const kicks = findDataKicks(['22:58:01 Mission read.', KICK_118, KICK_118, ' 2:50:00 Player Bob (1) kicked from server: 4 (Ping too high)'].join('\n'));
  check('counts kicks with reason 118 only', () => assert.equal(kicks.count, 2));
  check('keeps the whole reason, nested brackets included', () => assert.match(kicks.last, /^Server installation is corrupt\..*data_sakhal\.pbo\)$/));
  check('no kicks is a zero, not a null', () => assert.deepEqual(findDataKicks(''), { count: 0, last: null }));
}
await acheck('readRpt finds the list at the head and the kicks at the tail of a real file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dayz-status-rpt-'));
  try {
    const file = path.join(dir, 'DayZServer_2026-09-21_03-16-00.RPT');
    const filler = Array.from({ length: 4000 }, (_, i) => ` 3:17:00 Warning Message: No entry 'bin\\config.bin/CfgVehicles/Filler${i}'.`);
    await fsp.writeFile(file, [...ADDONS_HEAD, ...ADDONS_SAKHAL, ...ADDONS_END, ...filler, KICK_118, ''].join('\n'));
    const rpt = await readRpt(file, { tailBytes: 64 * 1024 });
    assert.equal(rpt.truncated, true, 'the fixture must be larger than the tail that is read');
    assert.deepEqual(rpt.addons.folders, ['sakhal']);
    assert.equal(rpt.dataKicks.count, 1);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 9. docker --
section('9. Docker stats');
{
  const blob = {
    cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 100_000_000_000, online_cpus: 8 },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 90_000_000_000 },
    memory_stats: { usage: 3 * 1024 ** 3, limit: 8 * 1024 ** 3, stats: { inactive_file: 1024 ** 3 } },
    pids_stats: { current: 42 },
    networks: { eth0: { rx_bytes: 100, tx_bytes: 200 }, eth1: { rx_bytes: 5, tx_bytes: 5 } },
    blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 10 }, { op: 'Write', value: 20 }] },
  };
  const s = summariseStats(blob);
  check('CPU follows the docker stats convention (100 % = one core)', () => assert.equal(s.cpuPct, 80));
  check('the share of the whole machine is reported separately', () => assert.equal(s.cpuPctOfHost, 10));
  check('page cache is not counted as used memory', () => assert.equal(s.memUsed, 2 * 1024 ** 3));
  check('memory percentage uses the limit', () => assert.equal(s.memPct, 25));
  check('network counters are summed over all interfaces', () => {
    assert.equal(s.netRx, 105);
    assert.equal(s.netTx, 205);
  });
  check('block I/O is split into read and write', () => assert.equal(s.ioRead, 10) || assert.equal(s.ioWrite, 20));
  check('a missing stats blob is survivable', () => assert.equal(summariseStats(null), null));
}

// --------------------------------------------------------------- 10. health --
section('10. Health checks');
const HEALTHY = {
  supervisor: {
    state: 'RUNNING', updated_epoch: Math.floor(Date.now() / 1000), server_pid: 123, port_bound: true,
    mission_ready: true, mission_ready_seconds: 48, active_mission: 'docker.chernarusplus', query_port: 27016,
    game_port: 2302, updates_paused: false, steam_status: 'ok', launch_args: '-config=x -port=2302',
  },
  supervisorFresh: true,
  players: { count: 3, max: 60 },
  query: {
    info: { ok: true, rttMs: 4, name: 'Test', version: '1.28.159123' },
    players: { ok: true, count: 3, named: 3 },
    rules: { ok: true, count: 5, bohemia: { mods: [] } },
  },
  hostQuery: { ok: true, rttMs: 9 },
  docker: {
    ok: true, version: { version: '29.8.0', apiVersion: '1.52' },
    dayz: { name: 'dayz-dayz-1', running: true, startedAt: new Date(Date.now() - 7200_000).toISOString(), restartCount: 1, oomKilled: false, health: { status: 'healthy', log: [{ output: 'ok', exitCode: 0 }] } },
    stats: { cpuPct: 12, cpus: 8, memUsed: 2 * 1024 ** 3, memLimit: 8 * 1024 ** 3, memPct: 25, pids: 40 },
  },
  crashBackoff: { startsSinceHealthy: 0 },
  storage: {
    lastSave: Date.now() - 300_000, lastSaveFile: 'data_001.bin', fileCount: 12, bytes: 400_000, rescued: [],
    dataDisk: { free: 60 * 1024 ** 3, total: 200 * 1024 ** 3, usedPct: 70 },
    serverDisk: { free: 60 * 1024 ** 3, total: 200 * 1024 ** 3, usedPct: 70 },
  },
  logs: { crashDumps: 0, newestCrashDump: null },
  rpt: {
    mtime: Date.now() - 60_000, counts: {},
    addons: parseLoadedAddons([...ADDONS_HEAD, ...ADDONS_SAKHAL, ...ADDONS_END].join('\n')),
    dataKicks: findDataKicks(''),
  },
  build: { manifest: { installed: true, buildId: '20260919', stateFlags: 4, lastUpdated: 1758240000 }, dataFolders: ['sakhal'], rpt: { version: '1.28.159123' } },
};
const EXTRAS = {
  config: {
    ok: true, source: 'generated', mtime: Date.now() - 600_000,
    values: { steamQueryPort: '27016', template: 'docker.chernarusplus', verifySignatures: '2', maxPlayers: '60', adminPasswordSet: true },
  },
  overrides: [],
};
{
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const run = (snap, extras = EXTRAS) => {
    const h = evaluate(snap, extras);
    return { h, get: (id) => h.checks.find((c) => c.id === id) };
  };

  const good = run(HEALTHY);
  check('a healthy server passes every check', () => {
    const bad = good.h.checks.filter((c) => c.status !== 'ok');
    assert.equal(bad.length, 0, `not ok: ${bad.map((c) => `${c.id} (${c.status}: ${c.detail})`).join(', ')}`);
  });
  check('the overall verdict is ok', () => assert.equal(good.h.overall, 'ok'));
  check('checks are grouped for the UI', () => assert.ok(good.h.groups.length >= 5));

  check('the Docker Desktop UDP bug is caught: reachable inside, dead from the host', () => {
    const s = clone(HEALTHY);
    s.hostQuery = { ok: false, error: 'no answer from host.docker.internal:27016 within 2500 ms' };
    const r = run(s).get('query.host');
    assert.equal(r.status, 'fail');
    assert.match(r.hint, /Docker Desktop/);
  });
  check('a dead server does not also blame the host port', () => {
    const s = clone(HEALTHY);
    s.query.info = { ok: false, error: 'no answer' };
    s.hostQuery = { ok: false, error: 'no answer' };
    assert.equal(run(s).get('query.host').status, 'unknown');
    assert.equal(run(s).get('query.info').status, 'fail');
  });
  check('a held container is a failure with the reason attached', () => {
    const s = clone(HEALTHY);
    s.supervisor.state = 'HOLD';
    s.supervisor.hold_title = 'STEAM LOGIN NEEDED';
    const r = run(s).get('supervisor.state');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /STEAM LOGIN NEEDED/);
  });
  check('a stale status file is a warning, not a crash', () => {
    const s = clone(HEALTHY);
    s.supervisorFresh = false;
    s.supervisor.updated_epoch = Math.floor(Date.now() / 1000) - 600;
    assert.equal(run(s).get('supervisor.state').status, 'warn');
  });
  check('repeated short starts raise the back-off alarm', () => {
    const s = clone(HEALTHY);
    s.crashBackoff.startsSinceHealthy = 4;
    assert.equal(run(s).get('server.backoff').status, 'fail');
  });
  check('a full disk fails before the world can be lost', () => {
    const s = clone(HEALTHY);
    s.storage.dataDisk = { free: 100 * 1024 ** 2, total: 200 * 1024 ** 3, usedPct: 99 };
    assert.equal(run(s).get('disk.data').status, 'fail');
  });
  check('a fresh crash dump is a failure', () => {
    const s = clone(HEALTHY);
    s.logs = { crashDumps: 1, newestCrashDump: Date.now() - 3600_000 };
    assert.equal(run(s).get('logs.crashDumps').status, 'fail');
  });
  check('an old crash dump is only a warning', () => {
    const s = clone(HEALTHY);
    s.logs = { crashDumps: 1, newestCrashDump: Date.now() - 5 * 86400_000 };
    assert.equal(run(s).get('logs.crashDumps').status, 'warn');
  });
  check('a query port that does not match the published one fails', () => {
    const e = clone(EXTRAS);
    e.config.values.steamQueryPort = '27017';
    assert.equal(run(HEALTHY, e).get('cfg.queryPort').status, 'fail');
  });
  // DayZ answers Steam queries on a ~50 ms cadence of its own and this figure covers the
  // challenge and the query, so about 100 ms is what a healthy server on an idle machine
  // actually reports. It used to be called slow, which left the page permanently "warn".
  check('the latency a healthy DayZ server really shows is not a warning', () => {
    const s = clone(HEALTHY);
    s.query.info = { ...s.query.info, rttMs: 100 };
    assert.equal(run(s).get('query.latency').status, 'ok');
  });
  check('a genuinely slow exchange is still flagged', () => {
    const s = clone(HEALTHY);
    s.query.info = { ...s.query.info, rttMs: 450 };
    assert.equal(run(s).get('query.latency').status, 'warn');
    s.query.info = { ...s.query.info, rttMs: 1500 };
    assert.equal(run(s).get('query.latency').status, 'fail');
  });
  check('weakened signature checking is flagged', () => {
    const e = clone(EXTRAS);
    e.config.values.verifySignatures = '0';
    assert.equal(run(HEALTHY, e).get('cfg.signatures').status, 'warn');
  });
  check('an override that never reached the mission is flagged', () => {
    const e = clone(EXTRAS);
    e.overrides = [{ rel: 'db/types.xml', applied: true }, { rel: 'init.c', applied: false }];
    const r = run(HEALTHY, e).get('cfg.overrides');
    assert.equal(r.status, 'warn');
    assert.match(r.hint, /init\.c/);
  });
  check('a build with empty names falls back to the admin log and says so', () => {
    const s = clone(HEALTHY);
    s.query.players = { ok: true, count: 3, named: 0 };
    const r = run(s).get('query.players');
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /hides them/);
  });
  // The defect this check exists for: every client was kicked, the container was healthy, and
  // nothing on the page said a word.
  check('a loaded sakhal/ folder is ok and says how many addons there are', () => {
    const r = good.get('server.gameData');
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /5 addons, including sakhal\/addons/);
  });
  check('an installed sakhal/ folder that the engine skipped is a failure with the fix attached', () => {
    const s = clone(HEALTHY);
    s.rpt.addons = parseLoadedAddons([...ADDONS_HEAD, ...ADDONS_END].join('\n'));
    const r = run(s).get('server.gameData');
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /sakhal\/ is installed but the engine did not load it/);
    assert.match(r.hint, /Missing PBO from game files/);
    assert.match(r.hint, /git pull, then docker-compose up -d/);
    assert.equal(run(s).h.overall, 'fail');
  });
  check('a list that was cut off before sakhal/ could appear is unknown, not a failure', () => {
    const s = clone(HEALTHY);
    s.rpt.addons = parseLoadedAddons(ADDONS_HEAD.join('\n'));
    assert.equal(run(s).get('server.gameData').status, 'unknown');
  });
  check('an install without the folder is worth a look', () => {
    const s = clone(HEALTHY);
    s.build.dataFolders = [];
    s.rpt.addons = parseLoadedAddons([...ADDONS_HEAD, ...ADDONS_END].join('\n'));
    assert.equal(run(s).get('server.gameData').status, 'warn');
  });
  check('a kick with reason 118 is a warning that quotes the reason', () => {
    const s = clone(HEALTHY);
    s.rpt.dataKicks = findDataKicks(KICK_118);
    const r = run(s).get('logs.dataKicks');
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /1 kick\(s\) with reason 118/);
    assert.match(r.detail, /Missing PBO from game files/);
  });
  check('no .RPT yet, or a server that never ran, is unknown for both', () => {
    const s = clone(HEALTHY);
    s.rpt = null;
    assert.equal(run(s).get('server.gameData').status, 'unknown');
    assert.equal(run(s).get('logs.dataKicks').status, 'unknown');
    const never = clone(HEALTHY);
    never.supervisor = {};
    assert.equal(run(never).get('server.gameData').status, 'unknown');
  });

  check('an out-of-memory kill is a failure', () => {
    const s = clone(HEALTHY);
    s.docker.dayz.oomKilled = true;
    assert.equal(run(s).get('container.oom').status, 'fail');
  });
  check('no Docker socket downgrades to unknown, it never fails the server', () => {
    const s = clone(HEALTHY);
    s.docker = { ok: false, error: 'connect ENOENT /var/run/docker.sock', dayz: null, stats: null };
    const r = run(s);
    assert.equal(r.get('docker.socket').status, 'unknown');
    assert.equal(r.get('res.cpu').status, 'unknown');
    assert.equal(r.get('query.info').status, 'ok');
  });
  check('an empty snapshot produces results instead of exceptions', () => {
    const h = evaluate({}, {});
    assert.equal(h.checks.length, h.total);
    assert.ok(h.checks.every((c) => typeof c.detail === 'string'));
    assert.ok(h.checks.every((c) => ['ok', 'warn', 'fail', 'unknown'].includes(c.status)));
  });
}

// ------------------------------------------------------- 11. file readers ----
// These used to be regexes built from ordinary template strings, where "\s" quietly
// becomes "s" and every value comes back null while the page still looks healthy. They are
// covered here so that can never pass unnoticed again.
section('11. serverDZ.cfg and the Steam manifest');
{
  const cfgText = `hostname = "Demo DayZ Server";
password = "";
passwordAdmin = "secret";
maxPlayers = 60;
	verifySignatures = 2;
serverTime = "SystemTime";
serverTimeAcceleration = 4;
steamQueryPort = 27016;
class Missions
{
    class DayZ
    {
        template = "docker.chernarusplus";
    };
};
`;
  const v = parseServerCfgValues(cfgText);
  check('reads a plain numeric setting', () => assert.equal(v.maxPlayers, '60'));
  check('reads a quoted setting', () => assert.equal(v.hostname, 'Demo DayZ Server'));
  check('reads a setting indented with a tab', () => assert.equal(v.verifySignatures, '2'));
  check('reads the mission template out of the nested class', () => assert.equal(v.template, 'docker.chernarusplus'));
  check('reads the query port', () => assert.equal(v.steamQueryPort, '27016'));
  check('tells an empty password from a set one', () => {
    assert.equal(v.passwordSet, false);
    assert.equal(v.adminPasswordSet, true);
  });
  check('every documented key is looked for', () => {
    assert.ok(Object.keys(v).length >= 16);
    assert.ok(Object.values(v).some((x) => x !== null));
  });

  await acheck('the Steam app manifest yields the build id and install state', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dayz-status-test-'));
    await fsp.mkdir(path.join(dir, 'steamapps'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'steamapps', 'appmanifest_223350.acf'),
      '"AppState"\n{\n\t"appid"\t\t"223350"\n\t"name"\t\t"DayZServer"\n\t"StateFlags"\t\t"4"\n\t"buildid"\t\t"18995271"\n\t"LastUpdated"\t\t"1758240000"\n\t"SizeOnDisk"\t\t"4103428096"\n}\n');
    const m = await appManifest(dir, 223350);
    assert.equal(m.buildId, '18995271');
    assert.equal(m.installed, true);
    assert.equal(m.sizeOnDisk, 4103428096);
    assert.equal(m.lastUpdated, 1758240000);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await acheck('a mod folder is read from meta.cpp', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dayz-status-test-'));
    await fsp.mkdir(path.join(dir, '@CF', 'keys'), { recursive: true });
    await fsp.writeFile(path.join(dir, '@CF', 'meta.cpp'), 'protocol = 1;\npublishedid = 1559212036;\nname = "Community Framework";\ntimestamp = 1;\n');
    await fsp.writeFile(path.join(dir, '@CF', 'keys', 'cf.bikey'), '');
    const mods = await installedMods(dir);
    assert.equal(mods.length, 1);
    assert.equal(mods[0].workshopId, '1559212036');
    assert.equal(mods[0].displayName, 'Community Framework');
    assert.deepEqual(mods[0].bikeys, ['cf.bikey']);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  check('mods are also recognised on the command line', () => {
    const mods = modsFromArgs('-config=x -mod=@CF;@BuilderItems -servermod=@AdminTools');
    assert.deepEqual(mods.map((m) => m.name), ['CF', 'BuilderItems', 'AdminTools']);
    assert.equal(mods[2].serverSide, true);
  });

  // Verbatim from the ban.txt Steam installs: six comment lines and two real bans. Counting
  // the comments made the page report eight.
  const shippedBanTxt = [
    "//Players added to the ban.txt won't be able to connect to this server.",
    '//Bans can be added/removed while the server is running and will come in effect immediately, kicking the player.',
    '//-----------------------------------------------------------------------------------------------------',
    '//To ban a player, add his player ID (44 characters long ID) which can be found in the admin log file (.ADM).',
    '//-----------------------------------------------------------------------------------------------------',
    '//For comments use the // prefix. It can be used after an inserted ID, to easily mark it.',
    '',
    '76561198120341761',
    '76561198956764064',
  ].join('\n');
  check('a ban list counts IDs, not the comments around them', () => {
    assert.equal(countListEntries(shippedBanTxt), 2);
  });
  check('an ID with a trailing comment still counts once', () => {
    assert.equal(countListEntries('1111111111112222222222222333333333XXXXXXAAAA\t//Example of a character ID'), 1);
  });
  check('a comment-only list is empty, and so is no list at all', () => {
    assert.equal(countListEntries('//nobody is banned\n\n  \n'), 0);
    assert.equal(countListEntries(''), 0);
    assert.equal(countListEntries(null), 0);
  });
  check('CRLF line endings count the same', () => {
    assert.equal(countListEntries('//note\r\n76561198120341761\r\n76561198956764064\r\n'), 2);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
