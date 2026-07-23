FROM node:22-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
COPY package*.json ./
RUN npm install --registry=${NPM_REGISTRY}
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}/debian|g; s|http://deb.debian.org/debian-security|${DEBIAN_MIRROR}/debian-security|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev --registry=${NPM_REGISTRY}
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "dist-server/index.js"]
