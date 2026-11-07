#!/bin/sh
set -eu

if [ "$(id -u)" = 0 ]; then
  if [ "${REVIEW_ROOM_DATA_DIR:-}" != /var/lib/review-room ]; then
    echo 'Root initialization requires REVIEW_ROOM_DATA_DIR=/var/lib/review-room' >&2
    exit 1
  fi
  mkdir -p /var/lib/review-room
  chown node:node /var/lib/review-room
  exec setpriv --reuid=node --regid=node --init-groups node server/index.js
fi

exec node server/index.js
