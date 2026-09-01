#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?usage: package-server.sh VERSION ARCH OUTPUT_DIR}"
ARCH="${2:?usage: package-server.sh VERSION ARCH OUTPUT_DIR}"
OUTPUT_DIR="${3:?usage: package-server.sh VERSION ARCH OUTPUT_DIR}"
PLATFORM="linux/$ARCH"

case "$ARCH" in
  amd64|arm64) ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [ ! -d "$ROOT_DIR/.sudocode-build-context" ]; then
  echo "Missing .sudocode-build-context; stage sudocode before packaging." >&2
  exit 1
fi
mkdir -p "$OUTPUT_DIR"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

docker buildx build \
  --platform "$PLATFORM" \
  --target host-export \
  --build-arg "RELEASE_VERSION=$VERSION" \
  --output "type=local,dest=$STAGE_DIR" \
  -f "$ROOT_DIR/deploy/server.Dockerfile.local" \
  "$ROOT_DIR"

test -x "$STAGE_DIR/moss-server/node/bin/node"
test -f "$STAGE_DIR/moss-server/app/bin/moss-server.mjs"
test -f "$STAGE_DIR/moss-server/app/bin/direct-connect-session-runner.mjs"
test -x "$STAGE_DIR/moss-server/app/bin/nexus/nexusd"
test -x "$STAGE_DIR/moss-server/app/bin/scode"
test -f "$STAGE_DIR/moss-server/app/native/nexus-napi/nexus-napi.node"
test -f "$STAGE_DIR/moss-server/app/admin/dist/index.html"
test -f "$STAGE_DIR/moss-server/app/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx"

tar -C "$STAGE_DIR" -czf "$OUTPUT_DIR/moss-server-$VERSION-linux-$ARCH.tar.gz" moss-server
echo "$OUTPUT_DIR/moss-server-$VERSION-linux-$ARCH.tar.gz"
