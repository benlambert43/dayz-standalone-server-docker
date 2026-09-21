# No "# syntax=" line on purpose: it would make every `docker-compose up -d` contact Docker
# Hub to resolve the frontend image, and an offline start must keep working.

# Pinned by digest so that a moved tag never forces a surprise rebuild (and with it a
# recreate of a populated server) on a plain `docker-compose up -d`.
# To pick up Debian security updates: docker pull debian:bookworm-slim, then replace the digest.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# ca-certificates : without it DayZServer starts but never connects to Steam (server is never listed)
# lib32gcc-s1, lib32stdc++6 : steamcmd is a 32-bit binary
# libcap2         : DayZServer links against libcap.so.2
# tini            : PID 1, forwards signals and reaps zombies
# tzdata          : serverTime="SystemTime" follows the container's TZ
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl lib32gcc-s1 lib32stdc++6 libcap2 procps tini tzdata \
 && rm -rf /var/lib/apt/lists/*

# Two unprivileged users with real passwd entries (DayZServer segfaults without one):
#   steam (1000) owns steamcmd and the cached Steam login token
#   dayz  (1001) runs the internet-facing game server and can read neither
RUN groupadd -g 1001 dayz \
 && useradd  -u 1000 -m -d /home/steam -s /bin/bash steam \
 && useradd  -u 1001 -g 1001 -m -d /home/dayz -s /bin/bash dayz \
 && chmod 0700 /home/steam \
 && mkdir -p /opt/steamcmd /dayz/server /dayz/data /var/lib/dayz /run/dayz \
 && chown steam:steam /opt/steamcmd /var/lib/dayz

# steamcmd from Valve's CDN, self-updated once at build time so that a new container does
# not repeat the self-update. No credentials and no game files are part of the image.
RUN curl --proto '=https' --tlsv1.2 -fsSL \
      https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
    | setpriv --reuid=steam --regid=steam --init-groups tar -xz -C /opt/steamcmd \
 && setpriv --reuid=steam --regid=steam --init-groups \
      env HOME=/tmp/steamcmd-bootstrap /opt/steamcmd/steamcmd.sh +quit \
 && rm -rf /tmp/steamcmd-bootstrap /tmp/dumps

# Git on Windows records no executable bit and may check files out with CRLF line endings.
COPY --chmod=0755 docker/ /opt/dayz/
RUN find /opt/dayz -type f -exec sed -i 's/\r$//' {} +

VOLUME ["/dayz/server", "/dayz/data", "/home/steam"]

# SIGTERM and SIGINT behave identically for DayZServer (tested); SIGTERM avoids the bash
# rule that background children of a non-interactive shell ignore SIGINT.
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=10s --start-period=60m --start-interval=15s --retries=3 \
    CMD ["/opt/dayz/healthcheck.sh"]

# No -g: tini must signal only the entrypoint, which forwards the signal to the right child.
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/dayz/entrypoint.sh"]
