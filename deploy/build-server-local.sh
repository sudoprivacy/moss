#!/usr/bin/env bash
#
# Build the fully self-contained moss server image from source using
# deploy/server.Dockerfile.local.
#
# Unlike deploy/server.Dockerfile (which only COPYs prebuilt artifacts produced
# by CI), the .local variant builds EVERYTHING inside the image:
#   - moss-server.mjs / direct-connect-session-runner.mjs / admin/dist (bun)
#   - bin/wiki, bin/corpapp (Go, cross-compiled for target platform)
#   - native/nexus-napi/nexus-napi.node (Rust, target platform)
#   - bin/nexus/nexusd, bin/scode (downloaded)
#
# The nexus-napi addon depends on the PRIVATE crate `nexus-vfs-client` from
# github.com/sudoprivacy/sudocode. Rather than bake a GitHub token into the
# image build, this script uses a LOCAL clone of that repo at ~/sudocode:
#   - clones it (default branch: main) if missing,
#   - otherwise fetches + fast-forwards to the latest origin HEAD,
# then stages it into the build context so the Rust stage can `[patch]` the git
# dependency to the local path.
#
# Usage:
#   deploy/build-server-local.sh [image-tag]
#   MOSS_BUILD_PLATFORM=linux/arm64 deploy/build-server-local.sh my-moss-server:arm64
# Default tag: my-moss-server:local
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${1:-my-moss-server:local}"
BUILD_PLATFORM="${MOSS_BUILD_PLATFORM:-linux/amd64}"
SUDOCODE_DIR="${SUDOCODE_DIR:-$HOME/sudocode}"
SUDOCODE_REMOTE="${SUDOCODE_REMOTE:-https://github.com/sudoprivacy/sudocode.git}"
SUDOCODE_BRANCH="${SUDOCODE_BRANCH:-main}"
# Staged copy of sudocode inside the build context (cleaned up on exit).
STAGE_DIR="$REPO_ROOT/.sudocode-build-context"

log() { echo "[build-server-local] $*"; }

cleanup() { rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

# 1. Ensure ~/sudocode exists and fetch the latest branch from origin.
#    We never checkout/merge the working tree, so a dirty local clone (e.g. an
#    uncommitted rust/Cargo.lock) does NOT block the build and the user's local
#    changes are left untouched — we build from origin/<branch> directly.
if [ -d "$SUDOCODE_DIR/.git" ]; then
  log "Fetching latest sudocode in $SUDOCODE_DIR (origin/$SUDOCODE_BRANCH)"
  git -C "$SUDOCODE_DIR" fetch --quiet origin "$SUDOCODE_BRANCH"
else
  log "Cloning sudocode into $SUDOCODE_DIR ($SUDOCODE_BRANCH)"
  git clone --branch "$SUDOCODE_BRANCH" "$SUDOCODE_REMOTE" "$SUDOCODE_DIR"
fi
SUDOCODE_REF="origin/$SUDOCODE_BRANCH"
log "sudocode $SUDOCODE_REF -> $(git -C "$SUDOCODE_DIR" rev-parse --short "$SUDOCODE_REF")"

# 2. Stage sudocode into the build context (Docker cannot read arbitrary host
#    paths). Archive the committed tree at origin/<branch> — exactly the latest
#    remote HEAD, independent of the local working tree / checked-out branch.
log "Staging sudocode into build context: $STAGE_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
git -C "$SUDOCODE_DIR" archive --format=tar "$SUDOCODE_REF" | tar -x -C "$STAGE_DIR"

# 3. Pre-pull base images (with retry). Docker Hub pulls during `docker build`
#    are not retriable inside the Dockerfile, and a flaky proxy can drop them
#    (registry EOF). Pulling them first into the local cache makes the build
#    resilient to transient registry failures.
BASE_IMAGES=(oven/bun:1 golang:1.22-alpine rust:1-slim-bookworm debian:bookworm-slim node:22-trixie-slim)
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

# 4. Build the fully self-contained image for the selected platform.
log "Building $IMAGE_TAG ($BUILD_PLATFORM) from deploy/server.Dockerfile.local"
cd "$REPO_ROOT"
docker buildx build \
  --platform "$BUILD_PLATFORM" \
  --load \
  -t "$IMAGE_TAG" \
  -f deploy/server.Dockerfile.local \
  .

log "Done: $IMAGE_TAG"
