#!/usr/bin/env bash
# Download every artifact install-k3s.sh needs for a FULLY OFFLINE (air-gapped)
# install, into ./offline next to this script. Run this ONCE on a networked
# machine; then ship the whole deploy/k3s directory to the air-gapped host.
#
# install-k3s.sh prefers these local files and only falls back to the network
# when a file is missing (OFFLINE_MODE=auto), or requires them (OFFLINE_MODE=on).
#
# Usage:
#   ./fetch-offline-deps.sh                 # amd64 (default)
#   ARCH=arm64 ./fetch-offline-deps.sh      # arm64
#   ARCH=all   ./fetch-offline-deps.sh      # both
#   K3S_VERSION=v1.36.4+k3s1 ./fetch-offline-deps.sh   # pin k3s (default below)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFLINE_DIR="${OFFLINE_DIR:-$SCRIPT_DIR/offline}"
K3S_VERSION="${K3S_VERSION:-v1.36.4+k3s1}"      # must match the target's desired k3s
GVISOR_RELEASE="${GVISOR_RELEASE:-latest}"       # gvisor release channel/date
ARCH="${ARCH:-amd64}"

# moss scode runtime image (session container). Published to Tencent COS by CI;
# scode is baked INSIDE the image, so nothing scode-related needs staging on the
# node. The runtime image version is the latest server-v* release unless pinned.
# amd64-only upstream today.
COS_BASE="${MOSS_COS_BASE:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server}"
MOSS_RUNTIME_VERSION="${MOSS_RUNTIME_VERSION:-}"   # empty = latest (resolved from COS)
FETCH_MOSS="${FETCH_MOSS:-1}"                      # 0 to skip the runtime image

log() { printf '\033[0;32m[fetch-offline]\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m[fetch-offline] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

dl() { # dl <url> <dest>  — skip if present & non-empty
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then log "have $(basename "$dest") (skip)"; return; fi
  log "downloading $(basename "$dest") ..."
  curl -fL --retry 3 -m 600 "$url" -o "$dest.part" || die "download failed: $url"
  mv "$dest.part" "$dest"
}

fetch_arch() {
  local karch="$1"           # k3s arch label: amd64 | arm64
  local garch suffix
  case "$karch" in
    amd64) garch="x86_64";  suffix="" ;;      # k3s amd64 binary has no suffix upstream
    arm64) garch="aarch64"; suffix="-arm64" ;;
    *) die "unsupported ARCH: $karch (use amd64|arm64|all)" ;;
  esac
  local ver_enc="${K3S_VERSION//+/%2B}"
  local ghbase="https://github.com/k3s-io/k3s/releases/download/${ver_enc}"
  local gvbase="https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${garch}"

  # k3s binary + airgap images (airgap tar carries pause/coredns/traefik/... — the
  # pause image is what every pod needs for its sandbox, so this is mandatory offline).
  dl "${ghbase}/k3s${suffix}"                              "$OFFLINE_DIR/k3s-${karch}"
  dl "${ghbase}/k3s-airgap-images-${karch}.tar.zst"       "$OFFLINE_DIR/k3s-airgap-images-${karch}.tar.zst"
  # gvisor runtime.
  dl "${gvbase}/runsc"                                     "$OFFLINE_DIR/runsc-${karch}"
  dl "${gvbase}/containerd-shim-runsc-v1"                  "$OFFLINE_DIR/containerd-shim-runsc-v1-${karch}"
  # checksums for gvisor (verified at install time).
  dl "${gvbase}/runsc.sha512"                             "$OFFLINE_DIR/runsc-${karch}.sha512"
  dl "${gvbase}/containerd-shim-runsc-v1.sha512"          "$OFFLINE_DIR/containerd-shim-runsc-v1-${karch}.sha512"
}

# Download the moss scode runtime image (into images/, auto-imported by install).
# scode is baked into this image; amd64-only upstream. Stamps the image-ref for
# the offline installer to resolve the version without a network round-trip.
fetch_moss() {
  # runtime image version: latest server-v* from COS unless pinned.
  local mrv="${MOSS_RUNTIME_VERSION#server-v}"; mrv="${mrv#v}"
  if [ -z "$mrv" ]; then
    log "resolving latest moss-runtime version from COS ..."
    # Capture fully before grepping: `curl | grep -m1` makes grep close the pipe
    # early → curl dies with SIGPIPE (exit 23) → pipefail aborts the script.
    local latest_sh
    latest_sh="$(curl -fsSL "$COS_BASE/latest/install.sh" 2>/dev/null || true)"
    mrv="$(printf '%s\n' "$latest_sh" | grep 'RELEASE_TAG=' | head -1 | sed 's/.*server-v//; s/[}"].*//')"
    [ -n "$mrv" ] || die "could not resolve latest moss-runtime version (set MOSS_RUNTIME_VERSION=<x.y.z>)"
  fi
  log "moss-runtime version: $mrv"

  # runtime image tarball + its checksum manifest -> images/ (auto-imported).
  local rel="$COS_BASE/releases/server-v${mrv}"
  local tar="moss-runtime-${mrv}-linux-amd64.tar.gz"
  dl "$rel/$tar" "$OFFLINE_DIR/images/$tar"
  dl "$rel/SHA256SUMS" "$OFFLINE_DIR/images/moss-runtime-SHA256SUMS"
  local want got
  want="$(awk -v f="$tar" '$2==f || $2=="*"f {print $1}' "$OFFLINE_DIR/images/moss-runtime-SHA256SUMS" | head -1)"
  if [ -n "$want" ]; then
    got="$(sha256sum "$OFFLINE_DIR/images/$tar" | awk '{print $1}')"
    [ "$want" = "$got" ] || die "runtime image checksum mismatch for $tar"
    log "runtime image checksum OK"
  fi
  printf 'my-moss-runtime:%s-amd64\n' "$mrv" > "$OFFLINE_DIR/scode-image.ref"
}

mkdir -p "$OFFLINE_DIR" "$OFFLINE_DIR/images"

# Arch-independent: the k3s install script.
dl "https://get.k3s.io" "$OFFLINE_DIR/k3s-install.sh"

if [ "$ARCH" = "all" ]; then
  fetch_arch amd64
  fetch_arch arm64
else
  fetch_arch "$ARCH"
fi

# moss runtime image (scode baked in; amd64-only upstream).
if [ "$FETCH_MOSS" = 1 ]; then
  case "$ARCH" in
    amd64|all) fetch_moss ;;
    *) log "ARCH=$ARCH: skipping moss runtime image (amd64-only upstream)" ;;
  esac
fi

log "==================== DONE ===================="
log "offline dir: $OFFLINE_DIR"
ls -la "$OFFLINE_DIR"
cat <<EOF

The scode runtime image (images/moss-runtime-*.tar.gz) was fetched automatically;
install-k3s.sh imports it into containerd. scode ships inside the image, so the
node needs nothing else staged.

Optional: drop any extra workload image tarballs into $OFFLINE_DIR/images/ (e.g. a
busybox for smoke tests). install-k3s.sh imports every *.tar / *.tar.gz /
*.tar.zst there into k3s containerd after start. Produce one with:
  docker save <image> -o $OFFLINE_DIR/images/<name>.tar

Then ship the whole deploy/k3s directory to the air-gapped host and run
  sudo OFFLINE_MODE=on ./install-k3s.sh
EOF
