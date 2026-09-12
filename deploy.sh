#!/usr/bin/env sh
# Pull the newest published image and restart. Run on the server.
set -eu

cd "$(dirname "$0")"

echo "==> pulling image"
docker compose -f docker-compose.prod.yml pull

echo "==> restarting"
docker compose -f docker-compose.prod.yml up -d

echo "==> clearing old images"
docker image prune -f >/dev/null 2>&1 || true

echo "==> waiting for health"
for i in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' loop-lab 2>/dev/null || echo starting)
  if [ "$status" = "healthy" ]; then
    echo "healthy. serving on port ${HOST_PORT:-8080}"
    exit 0
  fi
  sleep 2
done

echo "did not become healthy in 60s. recent logs:" >&2
docker compose -f docker-compose.prod.yml logs --tail 40 >&2
exit 1
