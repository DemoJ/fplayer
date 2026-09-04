FROM node:22-bookworm-slim AS build
ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}/debian|g; s|http://deb.debian.org/debian-security|${DEBIAN_MIRROR}/debian-security|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
# Speed up native module install in CN:
#  - better-sqlite3 prebuild binary mirror (avoids slow GitHub Releases)
#  - node headers mirror (avoids slow nodejs.org when node-gyp builds from source)
#  - skip audit/fund to remove extra registry requests
ENV npm_config_better_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/better-sqlite3
ENV npm_config_node_mirror=https://npmmirror.com/mirrors/node
ENV NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
RUN npm install --registry=${NPM_REGISTRY} --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
# ffmpeg/ffprobe are provided by a host-mounted static build (see
# docker-compose.yml FFMPEG_PATH/FFPROBE_PATH), so the runtime image no longer
# needs apt to install the ~200 ffmpeg dependency packages on every build.
# Install production dependencies directly instead of copying the build-stage
# node_modules and pruning dev packages. `npm prune --omit=dev` walks the whole
# tree and is very slow; a fresh `npm ci --omit=dev` here is fast and leaves a
# clean, smaller runtime.
ENV npm_config_better_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/better-sqlite3
ENV npm_config_node_mirror=https://npmmirror.com/mirrors/node
ENV NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
COPY package*.json ./
RUN npm ci --omit=dev --registry=${NPM_REGISTRY} --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
# Run as the unprivileged "node" user (uid 1000) so files created in the
# bind-mounted /data belong to uid 1000 instead of root. That keeps host-side
# tooling working (npm test / npm run dev read the same database) and makes
# backups sane. Existing deployments must chown the data dir once, see README.
RUN mkdir -p /data && chown -R node:node /data
USER node
CMD ["node", "dist-server/index.js"]