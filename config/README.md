# Optional overrides

Everything in this folder is optional, and everything except this README is git-ignored.
The folder is mounted read-only into the container. Changes apply at the next server
start:

```bash
docker-compose restart
```

| File or folder | Effect |
|---|---|
| `serverDZ.cfg` | Used instead of the config generated from `.env`. Only `steamQueryPort` and the mission `template` are still set by the container. Start from the generated file (see below). |
| `mission/` | Files here replace files of the same relative path in the active mission. Example: `mission/db/types.xml`, `mission/init.c`, `mission/cfggameplay.json`. File name case does not matter. |
| `ban.txt`, `whitelist.txt`, `priority.txt` | Copied into the server folder. A `whitelist.txt` also switches the whitelist on. |

## How mission overrides work

At every start the container builds a fresh working copy of the mission selected by
`MISSION` and then copies your `mission/` files over it. The original game files are never
edited, so a game update or a Steam file verification cannot destroy your changes, and
your copy can never be left behind on an old game version. Delete an override file and the
original comes back at the next start.

The world itself (players, bases, vehicles) is not stored in the mission folder. It lives in
the `data` volume and is untouched by all of this.

## Getting the generated serverDZ.cfg as a starting point

```bash
docker compose cp dayz:/dayz/data/config/serverDZ.cfg config/serverDZ.cfg
```

## Getting an original mission file to edit

```bash
docker compose cp dayz:/dayz/server/stable/mpmissions/dayzOffline.chernarusplus/db/types.xml config/mission/db/types.xml
```

Use `experimental` instead of `stable` in the path if `DAYZ_BRANCH=experimental`.
