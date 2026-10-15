#!/usr/bin/env bash
# Download every artifact `install.sh --role compute` needs for a FULLY OFFLINE
# install, into ./offline next to this script. Run this ONCE on a networked
# machine; then ship the whole deploy/k3s directory to the air-gapped host.
#
# The installer prefers these local files and only falls back to the network
# when a file is missing (OFFLINE_MODE=auto), or requires them (OFFLINE_MODE=on).
#
# Usage:
#   ./fetch-offline-deps.sh                 # amd64 (default)
#   ARCH=arm64 ./fetch-offline-deps.sh      # arm64
#   ARCH=all   ./fetch-offline-deps.sh      # both
#   K3S_VERSION=v1.34.1+k3s1 ./fetch-offline-deps.sh   # pin k3s (default below)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFLINE_DIR="${OFFLINE_DIR:-$SCRIPT_DIR/offline}"
K3S_VERSION="${K3S_VERSION:-v1.34.1+k3s1}"      # must match the target's desired k3s
GVISOR_RELEASE="${GVISOR_RELEASE:-latest}"       # gvisor release channel/date
ARCH="${ARCH:-amd64}"

# moss scode runtime image (session container). Published to Tencent COS by CI;
# scode is baked INSIDE the image, so nothing scode-related needs staging on the
# node. The runtime image version is the latest server-v* release unless pinned.
COS_BASE="${MOSS_COS_BASE:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server}"
MOSS_RUNTIME_VERSION="${MOSS_RUNTIME_VERSION:-}"   # empty = latest (resolved from COS)
FETCH_MOSS="${FETCH_MOSS:-1}"                      # 0 to skip the runtime image
FETCH_K3S="${FETCH_K3S:-1}"                        # 0 for gvisor-only staging

log() { printf '\033[0;32m[fetch-offline]\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m[fetch-offline] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

dl() { # dl <url> <dest>  — skip if present & non-empty
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then log "have $(basename "$dest") (skip)"; return; fi
  log "downloading $(basename "$dest") ..."
  curl -fL -H "Accept: ${3:-application/octet-stream}" --retry 3 --retry-all-errors --connect-timeout 15 --speed-limit 1024 --speed-time 20 -m 600 \
    "$url" -o "$dest.part" || die "download failed: $url"
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
  local airgap="k3s-airgap-images-${karch}.tar.zst"
  if [ "${K3S_MIRROR:-off}" = cn ]; then
    ghbase="https://rancher-mirror.rancher.cn/k3s/${K3S_VERSION//+/-}"
    airgap="k3s-airgap-images-${karch}.tar.gz"
  fi
  if [ "$FETCH_K3S" = 1 ]; then
  # k3s binary + airgap images (airgap tar carries pause/coredns/traefik/... — the
  # pause image is what every pod needs for its sandbox, so this is mandatory offline).
  dl "${ghbase}/k3s${suffix}"                              "$OFFLINE_DIR/k3s-${karch}"
  dl "${ghbase}/${airgap}" "$OFFLINE_DIR/${airgap}"
  dl "${ghbase}/sha256sum-${karch}.txt" "$OFFLINE_DIR/k3s-sha256sum-${karch}.txt"
  local file published want got
  for published in "k3s${suffix}" "$airgap"; do
    file="$OFFLINE_DIR/$published"
    [ "$published" != "k3s${suffix}" ] || file="$OFFLINE_DIR/k3s-${karch}"
    want="$(awk -v f="$published" '$2==f || $2=="*"f {print $1}' "$OFFLINE_DIR/k3s-sha256sum-${karch}.txt")"
    got="$(sha256sum "$file" | awk '{print $1}')"
    [ -n "$want" ] && [ "$want" = "$got" ] || die "k3s checksum mismatch for $published"
  done
  fi
  # Current gVisor releases ship checksum-verified archives on GitHub; the old
  # storage.googleapis.com per-binary download paths are no longer available.
  local endpoint=latest release_json="$OFFLINE_DIR/gvisor-${GVISOR_RELEASE}.json"
  [ "$GVISOR_RELEASE" = latest ] || endpoint="tags/release-${GVISOR_RELEASE#release-}"
  dl "https://api.github.com/repos/google/gvisor/releases/$endpoint" "$release_json" application/vnd.github+json
  local asset url archive="gvisor-${garch}.tar.bz2"
  for asset in "$archive" SHA512SUMS; do
    url="$(python3 - "$release_json" "$asset" <<'PY'
import json, sys
assets = json.load(open(sys.argv[1]))['assets']
print(next(asset['url'] for asset in assets if asset['name'] == sys.argv[2]))
PY
)"
    dl "$url" "$OFFLINE_DIR/gvisor-${GVISOR_RELEASE}-${asset}"
  done
  python3 - "$OFFLINE_DIR" "$GVISOR_RELEASE" "$archive" "$karch" <<'PY'
import hashlib, pathlib, shutil, sys, tarfile
root, release, archive, arch = pathlib.Path(sys.argv[1]), *sys.argv[2:]
path = root / f'gvisor-{release}-{archive}'
checksums = (root / f'gvisor-{release}-SHA512SUMS').read_text().splitlines()
expected = [line.split()[0] for line in checksums if len(line.split()) == 2 and line.split()[1].lstrip('*') == archive]
with path.open('rb') as stream:
    digest = hashlib.sha512()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
if expected != [digest.hexdigest()]:
    sys.exit('gvisor archive checksum mismatch')
with tarfile.open(path, 'r:bz2') as bundle:
    for name in ('runsc', 'containerd-shim-runsc-v1'):
        members = [m for m in bundle.getmembers() if m.isfile() and pathlib.PurePosixPath(m.name).name == name]
        if len(members) != 1:
            sys.exit('gvisor archive has missing or ambiguous binary: ' + name)
        dest = root / f'{name}-{arch}'
        with bundle.extractfile(members[0]) as source, dest.open('wb') as target:
            shutil.copyfileobj(source, target)
        (root / f'{name}-{arch}.sha512').write_text(hashlib.sha512(dest.read_bytes()).hexdigest() + '  ' + dest.name + '\n')
    helpers = root / f'gvisor-bin-{arch}'
    helpers.mkdir(exist_ok=True)
    helper_checksums = []
    for member in bundle.getmembers():
        parts = pathlib.PurePosixPath(member.name).parts
        if len(parts) != 2 or parts[0] != 'gvisor-bin' or parts[1] in ('.', '..') or not member.isfile():
            continue
        dest = helpers / parts[1]
        with bundle.extractfile(member) as source, dest.open('wb') as target:
            shutil.copyfileobj(source, target)
        helper_checksums.append(hashlib.sha512(dest.read_bytes()).hexdigest() + '  ' + dest.name)
    (helpers / 'SHA512SUMS').write_text('\n'.join(helper_checksums) + '\n')
PY
}

# Download the moss scode runtime image (into images/, auto-imported by install).
# scode is baked into each native image. Stamps the image-ref for
# the offline installer to resolve the version without a network round-trip.
fetch_moss() {
  local karch="$1"
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
  local tar="moss-runtime-${mrv}-linux-${karch}.tar.gz"
  dl "$rel/$tar" "$OFFLINE_DIR/images/$tar"
  dl "$rel/SHA256SUMS" "$OFFLINE_DIR/images/moss-runtime-SHA256SUMS"
  local want got
  want="$(awk -v f="$tar" '$2==f || $2=="*"f {print $1}' "$OFFLINE_DIR/images/moss-runtime-SHA256SUMS" | head -1)"
  [ -n "$want" ] || die "release checksum manifest does not contain $tar"
  if [ -n "$want" ]; then
    got="$(sha256sum "$OFFLINE_DIR/images/$tar" | awk '{print $1}')"
    [ "$want" = "$got" ] || die "runtime image checksum mismatch for $tar"
    log "runtime image checksum OK"
  fi
  printf 'my-moss-runtime:%s-%s\n' "$mrv" "$karch" > "$OFFLINE_DIR/scode-image-$karch.ref"
  if [ "$ARCH" != all ]; then
    cp "$OFFLINE_DIR/scode-image-$karch.ref" "$OFFLINE_DIR/scode-image.ref"
  fi
}

mkdir -p "$OFFLINE_DIR" "$OFFLINE_DIR/images"

# Arch-independent: the k3s install script.
if [ "$FETCH_K3S" = 0 ]; then
  :
elif [ "${K3S_MIRROR:-off}" = cn ]; then
  dl "https://rancher-mirror.rancher.cn/k3s/k3s-install.sh" "$OFFLINE_DIR/k3s-install.sh"
else
  dl "https://get.k3s.io" "$OFFLINE_DIR/k3s-install.sh"
fi

if [ "$FETCH_K3S" != 0 ]; then
  sh -n "$OFFLINE_DIR/k3s-install.sh" || die "invalid downloaded k3s installer"
fi

if [ "$ARCH" = "all" ]; then
  fetch_arch amd64
  fetch_arch arm64
else
  fetch_arch "$ARCH"
fi

# Stage both runtime archives for ARCH=all, or just the requested architecture.
if [ "$FETCH_MOSS" = 1 ]; then
  case "$ARCH" in
    all) fetch_moss amd64; fetch_moss arm64 ;;
    amd64|arm64) fetch_moss "$ARCH" ;;
  esac
fi

log "==================== DONE ===================="
log "offline dir: $OFFLINE_DIR"
ls -la "$OFFLINE_DIR"
cat <<EOF

The scode runtime image (images/moss-runtime-*.tar.gz) was fetched automatically;
the installer imports it into containerd. scode ships inside the image, so the
node needs nothing else staged.

Optional: drop any extra workload image tarballs into $OFFLINE_DIR/images/ (e.g. a
busybox for smoke tests). The installer imports every *.tar / *.tar.gz /
*.tar.zst there into k3s containerd after start. Produce one with:
  docker save <image> -o $OFFLINE_DIR/images/<name>.tar

Then ship the whole deploy/k3s directory to the air-gapped host and run
  sudo OFFLINE_MODE=on ./install.sh --role compute
EOF
