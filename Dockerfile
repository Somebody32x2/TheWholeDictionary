# syntax=docker/dockerfile:1

# The client bundle is compiled with the mount point baked in, so BASE_PATH is
# a build argument rather than only a runtime variable. It must match the
# server's BASE_PATH at runtime.
ARG BASE_PATH=""

# --- build ------------------------------------------------------------------
FROM oven/bun:1-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json vite.config.ts svelte.config.js ./
COPY shared ./shared
COPY client ./client
COPY scripts ./scripts
COPY corpus ./corpus

ARG BASE_PATH
ENV BASE_PATH=${BASE_PATH}
RUN bun run build

# --- runtime ----------------------------------------------------------------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only, installed fresh rather than copied across: the
# build toolchain has no business in the image that faces the internet.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server ./server
COPY shared ./shared
COPY corpus ./corpus
COPY --from=build /app/dist ./dist

# Profiles live here. Mount a volume, or every account vanishes on redeploy -
# including /data/.pepper, without which no existing phrase resolves.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R bun:bun /data /app

# Number of proxies in front of this container, not a boolean. One reverse
# proxy means one hop, and the client address is read that far from the right-hand
# end of X-Forwarded-For - the only part of it a client cannot write for
# itself. Set it to 0 if you remove the proxy and expose this directly.
ENV TRUST_PROXY=1
ENV PORT=8080
ENV HOST=0.0.0.0

USER bun
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "server/index.js"]
