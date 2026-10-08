#!/usr/bin/env bash
# Exercise Moss's real consumer against the checksum-verified co-host release.
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077

WORK="${MOSS_COHOST_ARTIFACTS:-$(mktemp -d "${TMPDIR:-/tmp}/moss-cohost.XXXXXX")}"
mkdir -p "$WORK"
export MOSS_COHOST_ARTIFACTS="$WORK"
TAG="nexusd-cohost-v$(node -p "require('./src/server/nexus/runtime-versions.json')['nexusd-cohost']")"
if [[ -z "${NEXUSD_COHOST_BIN:-}" ]]; then
  mkdir -p "$WORK/release"
  gh release download "$TAG" --repo sudoprivacy/sudocode \
    --pattern nexusd-cohost-linux-x64.tar.gz --pattern SHA256SUMS.txt \
    --dir "$WORK/release"
  (
    cd "$WORK/release"
    sha256sum --check --ignore-missing SHA256SUMS.txt
    tar -xzf nexusd-cohost-linux-x64.tar.gz
  )
  export NEXUSD_COHOST_BIN="$WORK/release/nexusd-cohost-linux-x64/nexusd-cohost"
fi

"$NEXUSD_COHOST_BIN" --version | tee "$WORK/binary-version.txt"
KERNEL="$(node -p "require('./src/server/nexus/runtime-versions.json')['nexusd-cluster']")"
grep -Fq "nexus-vfs v$KERNEL" "$WORK/binary-version.txt"
bun build --target=node scripts/e2e/cohost-session-recovery.ts --outfile "$WORK/recovery.mjs"
node "$WORK/recovery.mjs"
