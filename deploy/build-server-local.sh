#!/usr/bin/env bash
#
# Build the fully self-contained moss server image from source using
# deploy/server.Dockerfile.local.
#
# Unlike deploy/server.Dockerfile (which only COPYs prebuilt artifacts produced
# by CI), the .local variant builds EVERYTHING inside the image:
#   - moss-server.mjs / direct-connect-session-runner.mjs / admin/dist (bun)
#   - bin/wiki, bin/corpapp (Go, cross-compiled for target platform)
#   - bin/nexus/nexusd, bin/scode (downloaded)
#
# Usage:
#   deploy/build-server-local.sh [image-tag]
#   MOSS_BUILD_PLATFORM=linux/arm64 deploy/build-server-local.sh my-moss-server:arm64
# Default tag: my-moss-server:local
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${1:-my-moss-server:local}"
BUILD_PLATFORM="${MOSS_BUILD_PLATFORM:-linux/amd64}"

log() { echo "[build-server-local] $*"; }

# 1. Pre-pull base images (with retry). Docker Hub pulls during `docker build`
#    are not retriable inside the Dockerfile, and a flaky proxy can drop them
#    (registry EOF). Pulling them first into the local cache makes the build
#    resilient to transient registry failures.
BASE_IMAGES=(oven/bun:1 golang:1.22-alpine debian:bookworm-slim node:22-trixie-slim)
for img in "${BASE_IMAGES[@]}"; do
  for attempt in 1 2 3 4 5; do
    if docker pull --platform "$BUILD_PLATFORM" "$img" >/dev/null 2>&1; then
      log "base image ready: $img"; break
    fi
    log "pull attempt $attempt failed for $img; retrying in 5s..."; sleep 5
    [ "$attempt" = 5 ] && { log "ERROR: could not pull $img"; exit 1; }
  done
done

# The embedding model ships in-repo at deploy/models/Xenova.zip (git-lfs) and is
# unzipped inside server.Dockerfile.local's model-stage, so no host-side staging
# is needed here. Warn early if the LFS object wasn't materialized (a plain
# `git clone` without `git lfs pull` leaves a ~130B pointer in its place).
MODEL_ZIP_IN_REPO="$REPO_ROOT/deploy/models/Xenova.zip"
if [ ! -f "$MODEL_ZIP_IN_REPO" ] || [ "$(wc -c < "$MODEL_ZIP_IN_REPO")" -lt 1000000 ]; then
  log "WARNING: $MODEL_ZIP_IN_REPO missing or looks like an unresolved git-lfs pointer."
  log "         Run 'git lfs pull' so the embedding model is baked into the image."
fi

# 2. Build the fully self-contained image for the selected platform.
log "Building $IMAGE_TAG ($BUILD_PLATFORM) from deploy/server.Dockerfile.local"
cd "$REPO_ROOT"
docker buildx build \
  --platform "$BUILD_PLATFORM" \
  --load \
  -t "$IMAGE_TAG" \
  -f deploy/server.Dockerfile.local \
  .

log "Done: $IMAGE_TAG"
