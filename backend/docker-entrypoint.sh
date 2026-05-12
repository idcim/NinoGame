#!/bin/sh
set -e

echo "[entrypoint] running schema migrations (idempotent) ..."
# node-pg-migrate is now a production dep; can run directly
npx --no-install node-pg-migrate -j sql -m sql -d DATABASE_URL up

echo "[entrypoint] starting server on ${HOST:-0.0.0.0}:${PORT:-8088} ..."
exec node dist/index.js
