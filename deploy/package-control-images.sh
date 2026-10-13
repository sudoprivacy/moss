#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?usage: package-control-images.sh VERSION ARCH OUTPUT_DIR}"
ARCH="${2:?architecture required}"
OUTPUT_DIR="${3:?output directory required}"
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || exit 1
[ "$ARCH" = amd64 ] || { echo 'Control images currently require amd64' >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"
for component in server nexus; do
  target=nexus-image
  [ "$component" != server ] || target=control-server-image
  ref="moss-$component:$VERSION-$ARCH"
  docker buildx build --platform "linux/$ARCH" --target "$target" --load \
    -t "$ref" -f "$ROOT_DIR/deploy/server.Dockerfile.local" "$ROOT_DIR"
  docker run --rm --entrypoint kubectl "$ref" version --client=true >/dev/null
  if [ "$component" = nexus ]; then
    docker run --rm "$ref" --version
  else
    docker run --rm --entrypoint node "$ref" --no-warnings -e "require('node:sqlite')"
    docker run --rm --entrypoint sh "$ref" -c 'test ! -e /app/bin/nexus/nexusd'
  fi
  docker save "$ref" | gzip -1 > "$OUTPUT_DIR/moss-$component-image-$VERSION-linux-$ARCH.tar.gz"
done
docker buildx build --platform "linux/$ARCH" --target nexus-bootstrap-bundle \
  --output "type=local,dest=$OUTPUT_DIR" -f "$ROOT_DIR/deploy/server.Dockerfile.local" "$ROOT_DIR"
tar -C "$ROOT_DIR/deploy/k3s" -czf "$OUTPUT_DIR/moss-deploy-$VERSION-linux-$ARCH.tar.gz" control.py install-control.sh fetch-offline-deps.sh \
  -C "$ROOT_DIR/deploy" server.json
