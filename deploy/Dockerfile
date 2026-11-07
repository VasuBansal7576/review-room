FROM node:24-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 REVIEW_ROOM_DATA_DIR=/var/lib/review-room
WORKDIR /app
RUN mkdir -p /var/lib/review-room && chown node:node /var/lib/review-room
COPY --chown=node:node package.json ./
COPY --chown=node:node server/index.js server/access.js server/turn.js server/cloudflare-turn.js server/events.js server/switch.js ./server/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node --chmod=755 deploy/entrypoint.sh /usr/local/bin/review-entrypoint
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/review-entrypoint"]
