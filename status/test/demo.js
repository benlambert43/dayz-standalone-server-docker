// A stand-in for a running DayZ server, so the status page can be developed and checked
// without a Steam account, a 1.6 GB download or a single real player.
//
// It writes a plausible data volume and game-files volume, then answers Steam queries on
// the query port exactly as the real server does, challenge handshake included.
//
//   node status/test/demo.js --data ./tmp/data --server ./tmp/server --port 27016
//
// In the compose network it is meant to run under the host name "dayz", so the status
// container finds it without any configuration change. See status/README.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import dgram from 'node:dgram';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') === false ? all[i + 1] : 'true']);
  return acc;
}, []));
const DATA = path.resolve(args.data || '/dayz/data');
const SERVER = path.resolve(args.server || '/dayz/server');
const PORT = Number(args.port || 27016);
const BRANCH = args.branch || 'stable';
const MISSION = 'dayzOffline.chernarusplus';
const ACTIVE = 'docker.chernarusplus';
const MISSION_DIR = path.join(SERVER, BRANCH, 'mpmissions', ACTIVE);

const PLAYERS = [
  { name: 'Survivor Sam', id: 'kJ3nR8xQ2mV7bL1pT5wZ9cF4dG6hY0aS', x: 6820, z: 2560 },
  { name: 'Bandit Bob', id: 'qW8eR2tY6uI0oP4aS7dF1gH5jK9lZ3xC', x: 4490, z: 10230 },
  { name: 'Medic Mia', id: 'zX4cV8bN2mQ6wE0rT5yU9iO3pA7sD1fG', x: 11760, z: 12400 },
  { name: 'Night Owl', id: 'mN5bV9cX3zL7kJ1hG4fD8sA2pO6iU0yT', x: 2340, z: 5120 },
  { name: 'Lone Wolf', id: 'tY7uI1oP5aS9dF3gH6jK0lZ4xC8vB2nM', x: 13400, z: 6180 },
];
const WEAPONS = ['M4-A1', 'AKM', 'Mosin 9130', 'SK 59/66', 'Fists', 'Splitting Axe', 'CR-75'];
let seed = 20260920;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const two = (n) => String(n).padStart(2, '0');

async function write(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

// ------------------------------------------------------------- admin log -----
function buildAdm(startedAt) {
  const lines = [`AdminLog started on ${startedAt.toISOString().slice(0, 10)} at ${startedAt.toISOString().slice(11, 19)}`];
  const at = (mins) => {
    const d = new Date(startedAt.getTime() + mins * 60000);
    return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  };
  const pos = (p, jitter = 400) => {
    const x = Math.max(20, p.x + (rnd() - 0.5) * jitter);
    const z = Math.max(20, p.z + (rnd() - 0.5) * jitter);
    return `pos=<${x.toFixed(1)}, ${z.toFixed(1)}, ${(100 + rnd() * 200).toFixed(1)}>`;
  };
  const who = (p, extra = '') => `Player "${p.name}"${extra}(id=${p.id} ${pos(p)})`;

  PLAYERS.forEach((p, i) => lines.push(`${at(i * 2)} | Player "${p.name}" is connected (id=${p.id})`));
  const chats = [
    'anyone near Cherno?', 'got a spare bandage?', 'watch the treeline north of Elektro',
    'heli crash at Stary, cleaned it out', 'friendly! do not shoot', 'server restart in a bit?',
    'found a car, needs a battery', 'my legs are broken again',
  ];
  for (let m = 3; m < 240; m += 1) {
    const p = pick(PLAYERS);
    const r = rnd();
    if (r < 0.16) lines.push(`${at(m)} | Chat("${p.name}"(id=${p.id} ${pos(p)})): ${pick(chats)}`);
    else if (r < 0.30) lines.push(`${at(m)} | ${who(p)} ${pick(['placed', 'built', 'dismantled'])} ${pick(['Fireplace', 'Wooden Crate', 'Fence', 'Watchtower', 'Garden Plot'])}`);
    else if (r < 0.40) lines.push(`${at(m)} | ${who(p)} is unconscious`);
    else if (r < 0.48) {
      const other = pick(PLAYERS.filter((x) => x !== p));
      lines.push(`${at(m)} | ${who(p)} hit by ${who(other)} into ${pick(['Head', 'Torso', 'LeftArm', 'RightLeg'])} for ${(rnd() * 90 + 5).toFixed(1)} damage`);
    } else if (r < 0.55) {
      const other = pick(PLAYERS.filter((x) => x !== p));
      lines.push(`${at(m)} | Player "${p.name}"(DEAD)(id=${p.id} ${pos(p)}) killed by ${who(other)} with ${pick(WEAPONS)} from ${(rnd() * 420 + 3).toFixed(2)} meters`);
    } else if (r < 0.58) {
      lines.push(`${at(m)} | Player "${p.name}"(DEAD)(id=${p.id} ${pos(p)}) died. Stats> Water: ${Math.round(rnd() * 500)} Energy: ${Math.round(rnd() * 500)} Bleed sources: ${Math.round(rnd() * 3)}`);
    } else if (r < 0.60) {
      lines.push(`${at(m)} | ${who(p)} killed by ZmbM_CitizenASkinny with Infected from 1.20 meters`);
    }
  }
  // Two players leave; the other three stay on, which is what the page should show as online.
  lines.push(`${at(238)} | ${who(PLAYERS[3])} has been disconnected`);
  lines.push(`${at(239)} | ${who(PLAYERS[4])} has been disconnected`);
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------- mission -------
const ITEM_GROUPS = [
  ['weapons', 'Tier3', ['AKM', 'M4A1', 'Mosin9130', 'SKS', 'CZ527', 'Winchester70', 'FAL', 'VSS']],
  ['clothes', 'Tier1', ['TShirt_Black', 'Jeans_Blue', 'HikingBoots_Brown', 'Raincoat_Green', 'BaseballCap_Red']],
  ['food', 'Tier1', ['TacticalBaconCan', 'BakedBeansCan', 'Apple', 'Pear', 'RiceBag', 'PowderedMilk']],
  ['tools', 'Tier2', ['Hatchet', 'Screwdriver', 'Pliers', 'Shovel', 'Hammer', 'Crowbar']],
  ['containers', 'Tier2', ['MountainBag', 'HuntingBag', 'DryBag_Orange', 'FieldBackpack']],
  ['vehiclesparts', 'Tier2', ['CarBattery', 'SparkPlug', 'CarRadiator', 'HeadlightH7']],
];
function buildTypes() {
  const rows = [];
  for (const [category, tier, names] of ITEM_GROUPS) {
    for (const name of names) {
      rows.push(`  <type name="${name}">
    <nominal>${Math.round(rnd() * 60 + 5)}</nominal>
    <lifetime>${[3600, 7200, 14400, 28800][Math.floor(rnd() * 4)]}</lifetime>
    <restock>${Math.round(rnd() * 1800)}</restock>
    <min>${Math.round(rnd() * 20)}</min>
    <quantmin>-1</quantmin>
    <quantmax>-1</quantmax>
    <cost>100</cost>
    <flags count_in_cargo="0" count_in_hoarder="0" count_in_map="1" count_in_player="0" crafted="0" deloot="0"/>
    <category name="${category}"/>
    <usage name="${pick(['Military', 'Police', 'Town', 'Village', 'Industrial', 'Hunting', 'Farm'])}"/>
    <value name="${tier}"/>
  </type>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<types>\n${rows.join('\n')}\n</types>\n`;
}

// Chernarus-shaped settlements: a coast strip in the south plus inland towns, so the
// density map the page draws looks like a map instead of noise.
const TOWNS = [
  [6800, 2500, 900, 2600], [4500, 2300, 700, 1800], [12000, 3200, 600, 1200], [2700, 2100, 500, 900],
  [9100, 5900, 550, 1100], [6400, 7700, 500, 1000], [11600, 12300, 700, 1600], [4300, 10200, 600, 1300],
  [2300, 5100, 450, 800], [13500, 6100, 500, 950], [7500, 11800, 450, 850], [9800, 9200, 400, 700],
  [5200, 5000, 380, 600], [10500, 2400, 420, 900], [3100, 13000, 400, 700], [14200, 9800, 380, 650],
];
function buildMapGroupPos() {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<map>'];
  for (const [cx, cz, spread, count] of TOWNS) {
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * spread;
      const x = Math.max(10, cx + Math.cos(a) * r), z = Math.max(10, cz + Math.sin(a) * r);
      out.push(`  <group name="Land_House_1W01" pos="${x.toFixed(3)} ${(rnd() * 200).toFixed(3)} ${z.toFixed(3)}" rpy="0.0 ${(rnd() * 360).toFixed(1)} 0.0" a="1"/>`);
    }
  }
  // A coast road: buildings strung along the southern shore.
  for (let x = 1500; x < 14000; x += 60) {
    if (rnd() < 0.45) continue;
    out.push(`  <group name="Land_Wreck" pos="${x.toFixed(1)} 5.0 ${(1800 + Math.sin(x / 900) * 600 + rnd() * 120).toFixed(1)}" rpy="0 0 0" a="1"/>`);
  }
  out.push('</map>');
  return out.join('\n');
}

const EVENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<events>
  <event name="StaticHeliCrash"><nominal>4</nominal><min>2</min><max>6</max><lifetime>1800</lifetime>
    <restock>0</restock><saferadius>1000</saferadius><distanceradius>800</distanceradius><cleanupradius>100</cleanupradius>
    <flags deletable="0" init_random="0" remove_damaged="1"/><position>fixed</position><limit>mixed</limit><active>1</active>
    <children><child lootmax="0" lootmin="0" max="0" min="0" type="Wreck_Mi8"/><child lootmax="0" lootmin="0" max="0" min="0" type="Wreck_UH1Y"/></children></event>
  <event name="VehicleCivilianSedan"><nominal>15</nominal><min>10</min><max>20</max><lifetime>3600</lifetime>
    <restock>0</restock><saferadius>500</saferadius><distanceradius>500</distanceradius><cleanupradius>200</cleanupradius>
    <flags deletable="0" init_random="0" remove_damaged="0"/><position>fixed</position><limit>mixed</limit><active>1</active>
    <children><child lootmax="0" lootmin="0" max="5" min="2" type="CivilianSedan"/></children></event>
  <event name="AnimalCow"><nominal>18</nominal><min>12</min><max>24</max><lifetime>300</lifetime>
    <restock>0</restock><saferadius>200</saferadius><distanceradius>300</distanceradius><cleanupradius>1000</cleanupradius>
    <flags deletable="1" init_random="0" remove_damaged="1"/><position>fixed</position><limit>mixed</limit><active>1</active>
    <children><child lootmax="0" lootmin="0" max="4" min="2" type="Animal_BosTaurus"/></children></event>
  <event name="InfectedArmy"><nominal>60</nominal><min>40</min><max>90</max><lifetime>180</lifetime>
    <restock>0</restock><saferadius>50</saferadius><distanceradius>100</distanceradius><cleanupradius>600</cleanupradius>
    <flags deletable="1" init_random="0" remove_damaged="1"/><position>fixed</position><limit>mixed</limit><active>1</active>
    <children><child lootmax="0" lootmin="0" max="3" min="1" type="ZmbM_SoldierNormal"/></children></event>
</events>
`;

const GLOBALS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<variables>
  <var name="AnimalMaxCount" type="0" value="200"/>
  <var name="CleanupLifetimeDeadPlayer" type="0" value="3600"/>
  <var name="IdleModeStartup" type="0" value="1"/>
  <var name="TimeHopping" type="0" value="60"/>
  <var name="ZombieMaxCount" type="0" value="1000"/>
  <var name="ZoneSpawnDist" type="0" value="300"/>
</variables>
`;

function buildSpawnPoints() {
  const zone = (name, x, z, r) => `      <generator_posbubbles name="${name}" x="${x}" z="${z}" r="${r}"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<playerspawnpoints>
  <fresh>
    <generator_posbubbles>
${TOWNS.slice(0, 8).map(([x, z], i) => zone(`fresh_${i}`, x, z, 200)).join('\n')}
    </generator_posbubbles>
  </fresh>
  <hop>
    <generator_posbubbles>
${TOWNS.slice(8).map(([x, z], i) => zone(`hop_${i}`, x, z, 150)).join('\n')}
    </generator_posbubbles>
  </hop>
</playerspawnpoints>
`;
}

const EFFECT_AREAS = JSON.stringify({
  Areas: [
    { AreaName: 'Pavlovo Static', Type: 'ContaminatedArea_Static', TriggerType: 'ContaminatedTrigger', Data: { Pos: [4500, 200, 2200], Radius: 300, InnerRingCount: 2, ParticleName: 'graphics/particles/contaminated_area_gas_bigass' } },
    { AreaName: 'Rify Static', Type: 'ContaminatedArea_Static', TriggerType: 'ContaminatedTrigger', Data: { Pos: [1600, 5, 13400], Radius: 250, InnerRingCount: 2 } },
    { AreaName: 'Kamensk Static', Type: 'ContaminatedArea_Static', TriggerType: 'ContaminatedTrigger', Data: { Pos: [7900, 300, 14400], Radius: 400, InnerRingCount: 3 } },
  ],
}, null, 2);

// ------------------------------------------------------------- generate ------
const startedAt = new Date(Date.now() - 4 * 3600_000);

async function generate() {
  const stamp = startedAt.toISOString().slice(0, 19).replace(/[-:T]/g, '-');
  await write(path.join(DATA, 'profiles', `DayZServer_x64_${stamp}.ADM`), buildAdm(startedAt));
  await write(path.join(DATA, 'profiles', `DayZServer_x64_${stamp}.RPT`), [
    '=====================================================================',
    '== ./DayZServer',
    `== ./DayZServer -config=${DATA}/config/serverDZ.cfg -port=2302 -profiles=${DATA}/profiles -dologs -adminlog -freezecheck -limitFPS=60`,
    '=====================================================================',
    `Current time:  ${startedAt.toISOString().slice(0, 10).replace(/-/g, '/')} ${startedAt.toISOString().slice(11, 19)}`,
    'Type: Public',
    'Build: 159123',
    'Version 1.28.159123',
    'Allocator: /dayz/server/stable/dta/tbbmalloc.so',
    'PhysMem: 31 GiB, VirtMem : 128 TiB, AvailPhys : 24 GiB',
    '22:57:55 [CE][Storage] Loading types',
    '22:58:01 Mission read.',
    '22:58:02 Warning Message: No entry .configfile/CfgVehicles.DemoOnly.',
    '22:58:07 [CE][Storage] ver:1 stamp:11842 , valid:YES',
    '23:14:00 Warning Message: Cannot open object dz\structures\demo.p3d',
  ].join('\n') + '\n');
  await write(path.join(DATA, 'config', 'serverDZ.cfg'), `// Generated at every start from the values in .env. Do not edit: changes are overwritten.
hostname = "Demo DayZ Server";
password = "";
passwordAdmin = "demo-admin-password-should-never-be-shown";
description = "status page demo fixture";
enableWhitelist = 0;
maxPlayers = 60;
verifySignatures = 2;
forceSameBuild = 1;
disableVoN = 0;
disable3rdPerson = 0;
thirdPersonView = 1;
disableCrosshair = 0;
serverTime = "SystemTime";
serverTimeAcceleration = 4;
serverNightTimeAcceleration = 8;
serverTimePersistent = 0;
instanceId = 1;
storageAutoFix = 1;
steamQueryPort = ${PORT};
class Missions
{
    class DayZ
    {
        template = "${ACTIVE}";
    };
};
`);
  for (const [name, size] of [['players.db', 41984], ['data/dynamic_001.bin', 210044], ['data/vehicles.bin', 18240], ['data/types.bin', 96512]]) {
    await write(path.join(DATA, 'storage', BRANCH, MISSION, 'storage_1', name), Buffer.alloc(size, 7).toString('latin1'));
  }
  await write(path.join(DATA, 'state', 'start-count'), '0\n');

  await write(path.join(MISSION_DIR, 'db', 'types.xml'), buildTypes());
  await write(path.join(MISSION_DIR, 'db', 'events.xml'), EVENTS_XML);
  await write(path.join(MISSION_DIR, 'db', 'globals.xml'), GLOBALS_XML);
  await write(path.join(MISSION_DIR, 'cfgplayerspawnpoints.xml'), buildSpawnPoints());
  await write(path.join(MISSION_DIR, 'cfgeffectarea.json'), EFFECT_AREAS);
  await write(path.join(MISSION_DIR, 'mapgrouppos.xml'), buildMapGroupPos());
  await write(path.join(MISSION_DIR, 'init.c'), 'void main()\n{\n  // demo fixture mission init\n}\n');
  await write(path.join(SERVER, BRANCH, 'mpmissions', MISSION, 'init.c'), '// vanilla copy\n');
  await write(path.join(SERVER, BRANCH, 'steamapps', 'appmanifest_223350.acf'), `"AppState"
{
	"appid"		"223350"
	"name"		"DayZServer"
	"StateFlags"		"4"
	"buildid"		"18995271"
	"LastUpdated"		"${Math.floor(startedAt.getTime() / 1000) - 86400}"
	"SizeOnDisk"		"4103428096"
}
`);
  await writeStatus();
  setInterval(writeStatus, 15000).unref?.();
}

/** The same file run-server.sh publishes, refreshed on the same 15 second heartbeat. */
async function writeStatus() {
  const now = Math.floor(Date.now() / 1000);
  await write(path.join(DATA, 'state', 'status.json'), JSON.stringify({
    schema: 1, state: 'RUNNING', phase: 'server', branch: BRANCH, app_id: 223350,
    mission: MISSION, active_mission: ACTIVE, world: 'chernarusplus',
    profiles_dir: path.join(DATA, 'profiles'), storage_dir: path.join(DATA, 'storage', BRANCH, MISSION),
    config_file: path.join(DATA, 'config', 'serverDZ.cfg'), config_source: 'generated',
    game_port: 2302, query_port: PORT, max_players: 60,
    server_time: 'SystemTime', time_acceleration: 4, night_time_acceleration: 8, tz: 'UTC',
    updates_paused: false, steam_status: 'ok', limit_fps: 60, log_retention_days: 14,
    mission_overrides: 0, launch_args: `-config=${DATA}/config/serverDZ.cfg -port=2302 -profiles=${DATA}/profiles -storage=${DATA}/storage -BEpath=${DATA}/battleye -dologs -adminlog -freezecheck -limitFPS=60`,
    server_pid: 4242, server_started_epoch: Math.floor(startedAt.getTime() / 1000),
    port_bound: true, port_bound_epoch: Math.floor(startedAt.getTime() / 1000) + 12,
    mission_ready: true, mission_ready_seconds: 48,
    restart_interval_seconds: 21600, restart_due_epoch: Math.floor(startedAt.getTime() / 1000) + 21600,
    restart_deadline_epoch: Math.floor(startedAt.getTime() / 1000) + 21600 + 7200,
    start_count: 0, updated_at: new Date().toISOString(), updated_epoch: now,
  }, null, 2) + '\n');
}

// -------------------------------------------------------------- A2S server ---
const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
const CHALLENGE = Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]);
const ONLINE = PLAYERS.slice(0, 3);

function infoPacket() {
  const nums = Buffer.alloc(9);
  nums.writeUInt16LE(223350 & 0xffff, 0);
  nums.writeUInt8(ONLINE.length, 2); nums.writeUInt8(60, 3); nums.writeUInt8(0, 4);
  nums.writeUInt8(100, 5); nums.writeUInt8(108, 6); nums.writeUInt8(0, 7); nums.writeUInt8(1, 8);
  const port = Buffer.alloc(2); port.writeUInt16LE(2302);
  const steamId = Buffer.alloc(8); steamId.writeBigUInt64LE(90200123456789012n);
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    cstr('Demo DayZ Server'), cstr('chernarusplus'), cstr('dayz'), cstr('DayZ'),
    nums, cstr('1.28.159123'),
    Buffer.from([0x80 | 0x10 | 0x20]), port, steamId,
    cstr('battleye,privHive,external,lqs5,etm4.000000,entm8.000000,shard001,allowedBuild:1'),
  ]);
}
function playersPacket() {
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, ONLINE.length])];
  ONLINE.forEach((p, i) => {
    const tail = Buffer.alloc(8);
    tail.writeInt32LE(Math.floor(rnd() * 5), 0);
    tail.writeFloatLE(600 + i * 1800 + rnd() * 900, 4);
    parts.push(Buffer.from([i]), cstr(p.name), tail);
  });
  return Buffer.concat(parts);
}
function rulesPacket() {
  const entries = [['allowedBuild', '1'], ['requiredVersion', '1.28'], ['island', 'chernarusplus'], ['language', '65545'], ['platform', 'lin']];
  const count = Buffer.alloc(2); count.writeUInt16LE(entries.length);
  return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x45]), count, ...entries.flatMap(([k, v]) => [cstr(k), cstr(v)])]);
}

function serve() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 5) return;
    const kind = msg.readUInt8(4);
    const solved = msg.subarray(msg.length - 4).equals(CHALLENGE);
    if (!solved) {
      return sock.send(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), CHALLENGE]), rinfo.port, rinfo.address);
    }
    const reply = kind === 0x54 ? infoPacket() : kind === 0x55 ? playersPacket() : kind === 0x56 ? rulesPacket() : null;
    if (reply) sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.bind(PORT, '0.0.0.0', () => console.log(`[demo] answering Steam queries on 0.0.0.0:${PORT}/udp`));
}

await generate();
console.log(`[demo] wrote a data volume to ${DATA}`);
console.log(`[demo] wrote game files to    ${SERVER}`);
if (args.serve !== 'false') serve();
else process.exit(0);
