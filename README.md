# dayz-standalone-server-docker

A DayZ Standalone dedicated server (Bohemia's native Linux build) that installs, configures
and runs itself with one command, plus a status page that tells you what it is doing.
Built and tested on Windows 11 with Docker Desktop (WSL2).

```bash
docker-compose up -d
```

Then open <http://localhost:8093>.

## Quick start

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) 4.86 or newer and start it.
   Plan for about 8 GB of free RAM and 10 GB of disk.
2. Copy the settings template and open the copy in an editor:

   ```bash
   copy .env.example .env
   ```

3. Fill in `STEAM_USERNAME`, `STEAM_PASSWORD` and `SERVER_NAME`. Wrap the password in single
   quotes if it contains `$`, `#` or spaces.
4. Start it and watch the log:

   ```bash
   docker-compose up -d
   ```

   ```bash
   docker-compose logs -f
   ```

5. If your Steam account uses the mobile authenticator, the log shows
   **ACTION NEEDED NOW: APPROVE THE LOGIN IN THE STEAM MOBILE APP**. Approve it on your phone.
   This happens once; the login is then cached in a Docker volume.
6. The first start downloads about 1.6 GB. When the log shows **SERVER IS UP**, players can
   connect to your PC's LAN address on port `2302`.
7. Once the log has shown **STEAM LOGIN CACHED**, you can blank `STEAM_PASSWORD` in `.env`.
8. Open the status page at <http://localhost:8093>. It is up from the first second and shows
   what the server is waiting for while it downloads.

Changing a setting later is the same command: edit `.env`, then run `docker-compose up -d`.

## Which Steam account

The Linux server is part of the normal "DayZ Server" Steam app (223350). Steam does not allow
anonymous downloads of it, so a real account is needed.

| Account | First start | Notes |
|---|---|---|
| Owns DayZ, mobile authenticator | One approval on your phone | Recommended |
| Owns DayZ, Steam Guard by email | The first attempt emails you a code. Put it in `STEAM_GUARD_CODE` and run `docker-compose up -d` again | The code must be from the newest email |
| Any account with Steam Guard off | Fully hands-off | A spare account keeps your main password off this PC |
| Account that does not own DayZ | Works | Steam delivers no mission files to it, so they are fetched from Bohemia's GitHub repository instead |

How the login is protected:

- The password is sent to Steam at most once per container. Automatic restarts never re-send it,
  so a problem can never turn into a lock-out of your account.
- A routine restart does not log in at all. The container first asks Steam anonymously whether
  a new build exists and only logs in when there is something to download.
- The password and the cached login token are only visible to a separate user inside the
  container. The game server process, which faces the internet, cannot read either.
- If a login problem needs you, the container stays up, repeats the instructions in the log
  every ten minutes, and never retries on its own.

To retry a login without changing `.env`:

```bash
docker-compose up -d --force-recreate
```

## Connecting

- **Same PC or LAN:** in the DayZ launcher use "Direct connect" with the PC's LAN address and
  port `2302`, or find the server in the LAN tab.
- **Internet:** forward UDP `2302-2305` and UDP `27016` on your router to this PC.
- **Windows Firewall:** the first start may show a prompt for "Docker Desktop Backend". Choose
  Allow. If you clicked Cancel earlier, Windows created Block rules; remove them under
  Windows Defender Firewall, Inbound Rules.

## Playing without any DLC

Nothing needs changing. The default `MISSION=dayzOffline.chernarusplus` is the base game:
neither the server nor any player needs a DLC for it.

| `MISSION` in `.env` | Map | What players need |
|---|---|---|
| `dayzOffline.chernarusplus` | Chernarus | DayZ (default) |
| `dayzOffline.enoch` | Livonia | DayZ. Livonia has been part of the base game since update 1.25 (May 2024) |
| `dayzOffline.sakhal` | Sakhal | DayZ **and** the Frostline DLC |

So the only setting to stay away from is `dayzOffline.sakhal`.

The server still downloads a `sakhal/` folder of about 800 MB, and so does every DayZ client,
whether its owner bought Frostline or not. That is how Bohemia ships the game, not a setting:
the game loads that folder on every map, and the server checks the files of each joining player
against its own. Do not delete the folder and do not try to switch it off. A server that has
not loaded it kicks everybody, DLC or not, with the `Missing PBO from game files` error
described under [Troubleshooting](#troubleshooting).

## Status page

<http://localhost:8093> — starts with the stack, needs no configuration, and changes nothing:
every endpoint is read-only and only `GET` is accepted.

| | |
|---|---|
| **Health** | About thirty checks in one place: container and supervisor state, the Steam query, disk space, crash dumps, script errors, world saves, and whether the config the server is running still matches the one on disk. Each one says what it means and what to do |
| **Players** | Who is online, how long they have been on, play time, kills, deaths, K/D, longest shot and favourite weapon, from the server's admin log |
| **Map** | Live player positions, deaths, spawn points and contaminated areas, drawn over a settlement map built from the mission's own `mapgrouppos.xml`. Pan, zoom, measure distances |
| **Chat and events** | In-game chat, the kill feed, connects, hits and base building, searchable and filterable |
| **Logs** | The container log and every file in the profiles folder, with errors and warnings picked out |
| **Missions and economy** | Which mission is live, which of your overrides took effect, a file browser, and the whole `types.xml` loot table with search |
| **Ask the server** | Send the Steam queries by hand and read the raw answer |

Three checks are worth knowing about:

- It sends the same Steam query **twice** — once inside Docker and once the long way round
  through the port published on the host. That is the only way to catch the Docker Desktop bug
  in the limitations below, where the server stays healthy but nobody can reach it any more.
- It compares the **running** server against the config and mission on disk, so a setting that
  needs a restart to take effect shows up as a warning instead of a surprise.
- It reads the engine's list of **loaded addons**. The engine can skip the `sakhal/` data
  folder without logging anything, and then every player is kicked while the container stays
  healthy. "Game data folders loaded" goes red for that, and "No players kicked for server
  data" shows the kicks themselves.

The page is published on `127.0.0.1` only, because it shows player IDs, log contents and the
container's settings. `STATUS_BIND=0.0.0.0` in `.env` opens it to the LAN. A toggle in the
header (or `STATUS_REDACT_IDS=true`) blanks player IDs for screenshots and streaming; passwords
are never sent to it at all.

Everything on the page is also JSON at `/api/...` and Prometheus metrics at `/metrics`. Full
details, including how to run it without a DayZ server, are in [status/README.md](status/README.md).

## Customising

Everyday settings live in `.env` and are documented there. For anything beyond that, see
[config/README.md](config/README.md):

- `config/serverDZ.cfg` replaces the generated server config.
- `config/mission/` holds files that override mission files, such as `db/types.xml` or `init.c`.
  They survive game updates.
- `config/ban.txt`, `config/whitelist.txt`, `config/priority.txt`.

A SteamID64 is only needed for the priority queue (`PRIORITY_STEAM_IDS`). Bans and the whitelist
use the 44-character player ID from the server's `.ADM` log, not the Steam ID.

## Updates and restarts

- The server restarts itself every `RESTART_INTERVAL_HOURS` (default 6). It waits for an empty
  server, for up to two extra hours. Players get no in-game countdown.
- Every start checks for a new game version and installs it. After a DayZ update, clients
  cannot join until the server has restarted once:

  ```bash
  docker-compose restart
  ```

- If Steam is unreachable or the login has expired, the installed version starts anyway and the
  log shows **UPDATES PAUSED** with the reason.

## Where things are

| Docker volume | Content |
|---|---|
| `dayz_data` | **Your world** (`storage/`), logs and crash dumps (`profiles/`), generated config |
| `dayz_server` | Game files, managed by steamcmd. Safe to delete; they are downloaded again |
| `dayz_steam-home` | Cached Steam login |
| `dayz_status` | The status page's player-count history. Safe to delete |

Browse them in Docker Desktop under Volumes. Back up the world while the server is stopped
(PowerShell):

```bash
docker run --rm -v dayz_data:/data:ro -v "${PWD}:/backup" debian:bookworm-slim tar czf /backup/dayz-world-backup.tar.gz -C /data storage
```

Wipe the world, keep everything else: stop the server, then delete the `storage` folder in
the `dayz_data` volume.

`docker-compose down` keeps all volumes. `docker-compose down -v` deletes the world **and**
the cached Steam login.

## Experimental branch

`DAYZ_BRANCH=experimental` with `STEAM_USERNAME=anonymous` needs no account at all. Only
players running "DayZ Experimental" can join such a server. It has its own game files and its
own world, separate from stable.

## Known limitations

- **One address for all players.** Docker Desktop forwards traffic itself, so the server sees
  every player as the same internal address. IP bans and IP-based admin tools are meaningless;
  ban by player ID.
- **Reboots.** Docker Desktop does not start with Windows by default. Enable "Start Docker
  Desktop when you sign in" if the server should come back after a reboot.
- **Shutdown hang.** The Linux server can save the world and then hang instead of exiting. The
  container detects this (game port released, process still running) and ends the process, so
  a stop takes a few seconds. The log line mentioning "known shutdown hang" is expected.
- **Docker Desktop UDP bug.** A published UDP port can stop forwarding while the container
  looks healthy. `docker-compose restart` fixes it, and the scheduled restart limits how long
  it can last. The status page has a check for exactly this: "Published port forwards (host
  side)" goes red while the server itself stays green.
- **Not included yet:** Workshop mods, BattlEye RCon, in-game restart warnings, configurable
  ports. See [scratchpad/scratch.md](scratchpad/scratch.md).

## Troubleshooting

Search the log for the banner title.

| Banner | Meaning and fix |
|---|---|
| `required variable STEAM_USERNAME is missing a value` | There is no `.env` yet, or `STEAM_USERNAME` is empty |
| `STEAM LOGIN NEEDED: set STEAM_PASSWORD in .env` | No cached login. Add the password and run `docker-compose up -d` |
| `STEAM GUARD EMAIL CODE NEEDED` | Put the emailed code into `STEAM_GUARD_CODE` and run `docker-compose up -d` |
| `THE LOGIN WAS NOT APPROVED IN TIME` | Open the Steam app first, then run `docker-compose up -d --force-recreate` |
| `STEAM SAYS: INVALID PASSWORD` | Check the account name, and quote the password with single quotes |
| `STEAM SAYS: RATE LIMIT EXCEEDED` | Too many attempts. Wait at least 6 hours; the container refuses to try earlier |
| `UPDATES PAUSED` | The installed version is running, but updates could not be fetched. The banner says why |
| `CRASH BACK-OFF` | The server died shortly after several starts. The reason is above in the log and in `profiles/` |
| `INVALID SETTING` | A value in `.env` is wrong. The banner names it |

The Health tab of the status page shows the same problems with the same wording, plus the ones
that never reach the log, such as a full disk or a published port that stopped forwarding.

Errors that the game shows to a player instead:

| Message in DayZ | Meaning and fix |
|---|---|
| `Warning (0x00040076)` ... `Server installation is corrupt. Missing PBO from game files (...\sakhal\addons\data_sakhal.pbo)` | Despite the file name, this has nothing to do with owning a DLC, and nothing is wrong with the player's game. The server did not load its own `sakhal/` folder, which every client loads. The engine skips that folder without a word unless the server's user may read **and write** the folder itself; older versions of this project left it read-only. Fixed: `git pull`, then `docker-compose up -d`. To check, look at "Game data folders loaded" on the Health tab, or open the newest `.RPT` file in the Logs tab: the list under `Loaded addons` must contain `sakhal/addons/data_sakhal.pbo` |

Never post your `.env`, the output of `docker inspect` or `docker compose config`, or RPT and
crash dump files in public: they can contain passwords and player IDs.

## Development

The Steam login logic is tested against a scripted stand-in for steamcmd, so the tests need
no Steam account:

```bash
docker compose build
```

```bash
docker run --rm -v "${PWD}/tests:/tests:ro" --entrypoint /tests/run-tests.sh dayz-server:local
```

The status page has its own tests, which need neither Docker nor a Steam account. Its Steam
protocol tests run against a fake query responder started inside the test process:

```bash
node status/test/run-tests.js
```

```bash
docker compose run --rm --no-deps -v "${PWD}/status/test:/opt/status/test:ro" status node test/run-tests.js
```

If applicable, additional notes and implementation details specific to your individual environment are located in the scratchpad folder:
[scratchpad/scratch.md](scratchpad/scratch.md).
