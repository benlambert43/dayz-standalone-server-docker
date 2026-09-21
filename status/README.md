# Status page

A read-only web page for the DayZ server container, at <http://localhost:8093>.

It starts with the rest of the stack:

```bash
docker-compose up -d
```

Nothing has to be configured. The page finds the server on the compose network, reads the
two game volumes read-only, and asks Docker about the container.

## What it shows

| Tab | Content |
|---|---|
| **Overview** | State, players, map, version, uptime, next restart, CPU and memory, a 24 hour player chart, who is online, and anything that is failing |
| **Health** | Every check, grouped, with the reason and what to do about it |
| **Players** | Online now, everyone the admin log knows, play time, kills, deaths, K/D, longest shot, favourite weapon, and recent sessions |
| **Map** | Live player positions, deaths, spawn points and contaminated areas, drawn over a settlement map derived from the mission's own data. Pan, zoom and measure distances. Overlays - place names, loot tiers, a loot run - switch on over it, and the drawn map switches off under them |
| **Chat** | In-game chat, searchable |
| **Events** | Kills, hits, connects, base building and everything else in the admin log, filterable by kind |
| **Logs** | The container log, the engine `.RPT`, the admin `.ADM`, script logs, and every file in the profiles folder |
| **Missions** | Installed missions, which one is live, which of your `config/mission/` overrides took effect, and a file browser for the live mission |
| **Economy** | The full `types.xml` loot table with search, dynamic events, global variables and scheduled messages |
| **Mods** | Mods found in the install folder, on the command line, and in what the server advertises |
| **Config** | The effective `serverDZ.cfg` (passwords removed), the launch command, player lists and the container's settings |
| **World** | Persistence files, last world save, disk space and backup commands |
| **Ask the server** | Send A2S_INFO, A2S_PLAYER or A2S_RULES by hand and read the raw answer, from inside Docker or the long way round through the host |

## Where the numbers come from

- **Steam queries** to `dayz:27016/udp` — the same A2S_INFO, A2S_PLAYER and A2S_RULES the
  game launcher sends. Live player count, map, version, server tags and the advertised mod list.
- **The Docker API** over a socket mounted read-only — container state, the result of the
  container's own healthcheck, CPU and memory, restart count, port bindings, the container log.
- **The data volume**, read-only — the admin log (`.ADM`) for chat, kills and positions, the
  engine log (`.RPT`) for the exact game version, script errors, the list of addons the engine
  loaded and players it kicked for data it did not load, the generated `serverDZ.cfg`, and the
  world persistence files.
- **The game files volume**, read-only — installed missions, the live mission working copy,
  the central economy files, and the Steam app manifest.
- **A status file** the game container publishes to `data/state/status.json` every 15 seconds.
  It carries the few facts that exist only inside that container: the supervisor state, the
  server process id, when the mission finished loading and when the next restart is due.

## What it cannot do

There is no endpoint that changes anything. The server cannot be started, stopped, kicked,
banned or messaged from this page, and only `GET` is accepted. It is a window, not a console.

Two numbers are honest estimates rather than measurements, and the page says so where they
appear:

- **The in-game clock.** DayZ does not report its world time over any query this container can
  send, so it is reconstructed from `serverTime`, the two acceleration settings and the moment
  the server started, switching acceleration at 05:00 and 19:00 (`STATUS_DAY_START_HOUR` and
  `STATUS_DAY_END_HOUR`).
- **Player positions.** They come from the newest admin-log line that mentions each player, not
  from a live feed, so someone who has been standing still shows their last logged position.

Some DayZ builds answer the player-list query with empty names. When that happens the page
falls back to the admin log and marks those rows "admin log" in the "Seen via" column.

## Settings

All optional, all set in `.env`:

| Variable | Default | Effect |
|---|---|---|
| `STATUS_BIND` | `127.0.0.1` | Host address the page is published on. `0.0.0.0` makes it reachable from the LAN |
| `STATUS_REDACT_IDS` | `false` | Blank player and Steam IDs everywhere. The page also has a toggle |
| `STATUS_POLL_SECONDS` | `20` | How often the page samples for the history chart |
| `STATUS_HISTORY_DAYS` | `14` | How long the player-count history is kept |
| `STATUS_CHECK_STEAM_BUILD` | `false` | Ask Steam whether a newer build exists. The only outbound request this stack makes |
| `DOCKER_GID` | `0` | Group that may read the Docker socket. Correct for Docker Desktop; on a Linux host use `getent group docker` |

Running without Docker access at all: comment out the `/var/run/docker.sock` line in
`docker-compose.yml`. The page keeps working and loses container health, CPU, memory and the
container log tab.

## For scripts and monitoring

Everything on the page is also JSON, and the numbers are Prometheus metrics:

```bash
curl -s http://localhost:8093/api/summary
```

```bash
curl -s http://localhost:8093/metrics
```

`/api/health`, `/api/players`, `/api/chat`, `/api/events`, `/api/map`, `/api/map/overlays`,
`/api/missions`, `/api/economy`, `/api/mods`, `/api/config`, `/api/storage`, `/api/logs`,
`/api/docker`, `/api/history`, `/api/query` and `/api/stream` (server-sent events) are all
available too. Add `?redact=1` to any of them to blank player IDs.

## Map overlays

The map itself is drawn from the mission's own `mapgrouppos.xml`, so the page needs no map
image to work. On top of it, anything in `public/overlays` is offered as a layer that can be
switched on, faded with its own slider or stacked with the others, and the drawn map can be
switched off underneath. Three ship with the page, all for Chernarus:

| Layer | What it is |
| --- | --- |
| **places** | Named settlements, military sites and landmarks. Cities and towns are labelled at any zoom, villages and landmarks as you go in |
| **loot tiers** | A coarse sketch of where the vanilla tiers fall: coast low, inland higher, the north-west military sites highest |
| **loot run** | A suggested circuit through the north-west and back down the east coast, with its loot stops |

All three are **drawn**, not pictures: each is a list of polygons, circles, lines and labelled
points in world metres, which the page renders in its own palette. Nothing in this repository
is an image of the map, so there is no map imagery to license, and the whole set is about 6 KB.

The positions were read off a 1 km grid and cross-checked against the fixture towns in
`test/demo.js`, which disagree by up to about half a kilometre. **Treat every coordinate as
good to roughly 500 m and no better.** To correct one, switch the `basemap` layer on, see which
way a label sits off its building cluster and edit the number - the cluster comes from the
mission's own data and is the thing to trust.

### Editing a drawn layer

Each layer is a JSON file in `public/overlays`, named by `overlays.json`. The four kinds of
shape can be mixed in one file and all take world metres:

```json
{
  "areas":   [{ "label": "Tier 1", "colour": "#4f9d6a", "polygon": [[0, 3600], [2400, 3700]],
                "labelAt": [11500, 3500] }],
  "circles": [{ "label": "Tisy", "colour": "#d8a531", "at": [1700, 14100], "radius": 1000 }],
  "lines":   [{ "label": "north-west run", "colour": "#e8593f", "width": 2.6, "dash": [9, 7],
                "points": [[1700, 14100], [4000, 10900]] }],
  "points":  [{ "label": "Gorka", "at": [9320, 9460], "class": "village" }]
}
```

`class` on a point decides when its label appears: `city` and `town` always, then `airfield`,
`military`, `landmark` and `village` as you zoom in. `colour` must be a plain `#rrggbb`. A
shape the page cannot draw - a polygon with two corners, a circle with no radius - is dropped
without taking the rest of the layer with it, so a half-finished edit still loads.

### Bringing your own picture

Nothing ships as an image, but the support is there for a terrain render of your own. Drop the
file in `public/overlays` and it is offered straight away, stretched across the whole world. To
place it properly, give it an entry in `public/overlays/overlays.json`:

```json
{ "id": "north-west", "label": "north west", "file": "nw.png", "world": "chernarusplus",
  "bounds": [7680, 7680, 15360, 15360], "opacity": 0.8, "credit": "who drew it" }
```

`bounds` is where the image sits in world metres, as `[xWest, zSouth, xEast, zNorth]`, and the
string `"world"` means the whole square. The image's top row is north. A picture layer also
gets the shared **dim** slider, which washes it back so the markers on top stay readable.

`world` hides a layer on any other map; leave it out to offer it everywhere. Only use images
you have the right to serve - the page will happily show anything you put in the folder.

## Development

No npm dependencies: the page is the Node standard library and four static files. There is no
build step, so the files in `public/` are the files the browser runs.

Run the tests, which need neither Docker nor a Steam account (the Steam protocol tests talk to
a fake query responder started inside the test process):

```bash
node status/test/run-tests.js
```

Work on the page without a DayZ server at all. `demo.js` writes a plausible data volume and
game-files volume and then answers Steam queries exactly as the real server does:

```bash
node status/test/demo.js --data ./tmp/data --server ./tmp/server --port 27016
```

```bash
DAYZ_DATA_ROOT=./tmp/data DAYZ_SERVER_ROOT=./tmp/server DAYZ_HOST=127.0.0.1 node status/src/server.js
```

## Layout

```
status/
  Dockerfile         node:22-alpine, pinned by digest, no npm install
  src/
    server.js        HTTP routes, the JSON API, server-sent events, Prometheus metrics
    collector.js     pulls every source together into one snapshot, with per-source caching
    health.js        the checks, and what each one means
    a2s.js           Steam query client: challenge handshake, split packets, Bohemia mod list
    dockerapi.js     Docker Engine API over the unix socket, GET only
    adm.js           admin log parser and the rollups built from it
    logs.js          log discovery, .RPT header, loaded addons and error classification
    mission.js       missions, types.xml, events.xml, spawn points, effect areas, mods
    world.js         world sizes, map grid, the reconstructed in-game clock
    overlays.js      the map's extra layers: the folder, the manifest, shapes and bounds
    xml.js           a small tolerant XML reader
    history.js       the player-count time series
    util.js          file reading with size caps, redaction, formatting
    config.js        every setting and its default
  public/            index.html, app.js, map.js, style.css
    overlays/        map layers: places, loot tiers and a loot run, as world coordinates
  test/
    run-tests.js     145 checks, no Docker and no Steam account needed
    demo.js          a stand-in DayZ server: fixture volumes plus a real A2S responder
```
