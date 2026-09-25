#!/bin/sh
set -eu
mkdir -p "${PHOTO_DIR:-/data/photos}"
chown -R node:node "${PHOTO_DIR:-/data/photos}"
exec gosu node node src/server.js
