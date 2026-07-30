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
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}/debian|g; s|http://deb.debian.org/debian-security|${DEBIAN_MIRROR}/debian-security|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "dist-server/index.js"]