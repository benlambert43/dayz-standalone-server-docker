# Status page sidecar. No "# syntax=" line, for the same reason as the server image: it
# would make every `docker-compose up -d` contact Docker Hub.

# Pinned by digest so a moved tag never forces a surprise rebuild.
# To pick up Alpine and Node security updates: docker pull node:22-alpine, then replace the
# digest with the one that command prints.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85

ENV NODE_ENV=production

# The page has no npm dependencies at all - only the Node standard library - so there is no
# install step here, nothing to audit and nothing to break when a registry is unreachable.

# uid/gid 1001 on purpose: that is the "dayz" user of the server container, which owns the
# data volume. Matching it is what lets this container read the world and the logs while
# staying unprivileged. It never needs to write to either volume.
RUN addgroup -g 1001 dayz \
 && adduser -D -u 1001 -G dayz -h /home/status status \
 && mkdir -p /opt/status /var/lib/dayz-status \
 && chown status:dayz /var/lib/dayz-status

WORKDIR /opt/status
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

USER status:dayz
EXPOSE 8093

# Answers only once the collector has produced a snapshot, so a container that cannot read
# any of its sources is reported unhealthy instead of serving an empty page.
HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8093/healthz || exit 1

CMD ["node", "src/server.js"]
