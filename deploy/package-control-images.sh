#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?usage: package-control-images.sh VERSION ARCH OUTPUT_DIR}"
ARCH="${2:?architecture required}"
OUTPUT_DIR="${3:?output directory required}"
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || exit 1
case "$ARCH" in amd64|arm64) ;; *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; esac
mkdir -p "$OUTPUT_DIR"
for component in server nexus; do
  target=nexus-image
  [ "$component" != server ] || target=control-server-image
  ref="moss-$component:$VERSION-$ARCH"
  docker buildx build --platform "linux/$ARCH" --target "$target" --load \
    -t "$ref" -f "$ROOT_DIR/deploy/server.Dockerfile.local" "$ROOT_DIR"
  [ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$ref")" = "linux/$ARCH" ]
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
python3 "$ROOT_DIR/deploy/k3s/package_deployment.py" \
  --shared-source "${MOSS_SHARED_IMAGE_SOURCE:-$ROOT_DIR/.moss-image-tools}" \
  --output "$OUTPUT_DIR/moss-deploy-$VERSION-linux-$ARCH.tar.gz"
