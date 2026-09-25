FROM node:22.14.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY src ./src
COPY views ./views
COPY public ./public
COPY assets ./assets

RUN chmod +x /docker-entrypoint.sh \
  && mkdir -p /data/photos \
  && chown -R node:node /app /data/photos

ENV NODE_ENV=production
ENV PHOTO_DIR=/data/photos
EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
