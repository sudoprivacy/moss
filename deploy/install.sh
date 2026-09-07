#!/usr/bin/env bash
set -euo pipefail

RELEASE_TAG="${MOSS_RELEASE_TAG:-@@MOSS_RELEASE_TAG@@}"
DEFAULT_DOWNLOAD_BASE="https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/releases/$RELEASE_TAG"
DEFAULT_INSTALL_DIR=""
NETWORK_NAME="moss-network"
SERVICE_NAME="moss-server"
OFFLINE=0
DOWNLOAD_ONLY=0
DOWNLOAD_DIR=""
UPGRADE_ONLY="${MOSS_PROGRAM_UPGRADE:-0}"
INSTALLER_REFRESHED="${MOSS_INSTALLER_REFRESHED:-0}"
NON_INTERACTIVE="${MOSS_NON_INTERACTIVE:-0}"
INSTALL_DIR="${MOSS_INSTALL_DIR:-}"
ROLE="${MOSS_ROLE:-}"

log() { printf '[moss-install] %s\n' "$*"; }
warn() { printf '[moss-install] WARNING: %s\n' "$*" >&2; }
die() { printf '[moss-install] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs Moss. One machine can take either half of the deployment, or both:

  --role all-in-one         Session runtime + Moss Server on this machine (default).
  --role control-plane      Moss Server only; sessions run on a separate compute node.
  --role compute            Session runtime only: k3s + gvisor + the runtime image.

A control-plane install asks which session runtime to drive. 'k8s' (the default)
talks to a compute node and needs no container engine on this machine. 'docker'
runs sessions in local containers and requires a Docker daemon here.

Options:
  --role ROLE               See above. Default: all-in-one.
  --offline                 Read release archives next to this script.
  --download PATH           Download files for a later offline installation.
  --upgrade                 Upgrade an existing installation without changing user data.
  --install-dir PATH        Installation root (default: <install-user-home>/.moss/server).
  --non-interactive         Read configuration from MOSS_* environment variables.
  -h, --help                Show this help.

Configuration environment variables:
  MOSS_ROLE, MOSS_INSTALL_USER, MOSS_INSTALL_DIR, MOSS_PORT, MOSS_ADVERTISED_HOST,
  MOSS_ADMIN_USERNAME, MOSS_ADMIN_PASSWORD, MOSS_RUNTIME (docker|k8s),
  MOSS_DOWNLOAD_BASE, MOSS_INSTALLER_URL, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY.

Compute-node environment variables:
  MOSS_K8S_NAMESPACE, MOSS_K8S_RUNTIME_CLASS, MOSS_K8S_SA_NAME, MOSS_K8S_OUTPUT_DIR,
  MOSS_RUNTIME_VERSION, NODE_IP, INSTALL_GVISOR, IMPORT_RUNTIME_IMAGE,
  K3S_MIRROR, REGISTRY_MIRROR, INSTALL_K3S_VERSION, OFFLINE_DIR, OFFLINE_MODE.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --offline) OFFLINE=1 ;;
    --upgrade) UPGRADE_ONLY=1 ;;
    --download)
      [ "$#" -ge 2 ] || die "--download requires a path"
      DOWNLOAD_ONLY=1
      DOWNLOAD_DIR="$2"
      shift
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || die "--install-dir requires a path"
      INSTALL_DIR="$2"
      shift
      ;;
    --role)
      [ "$#" -ge 2 ] || die "--role requires a value"
      ROLE="$2"
      shift
      ;;
    --role=*) ROLE="${1#--role=}" ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ "$OFFLINE" = 0 ] || [ "$DOWNLOAD_ONLY" = 0 ] \
  || die "--offline and --download cannot be used together"
[ "$UPGRADE_ONLY" = 0 ] || [ "$DOWNLOAD_ONLY" = 0 ] \
  || die "--upgrade and --download cannot be used together"

# An upgrade re-runs whatever this installation already is; asking again would
# only invite a role change that the upgrade path cannot carry out.
if [ "$UPGRADE_ONLY" = 1 ] && [ -z "$ROLE" ]; then
  ROLE=control-plane
fi
case "${ROLE:-}" in
  ''|all-in-one|control-plane|compute) ;;
  *) die "role must be 'all-in-one', 'control-plane' or 'compute' (got '$ROLE')" ;;
esac
[ "$ROLE" != compute ] || [ "$DOWNLOAD_ONLY" = 0 ] \
  || die "--download packages the server release; it does not apply to --role compute"
ARCH=amd64

case "$RELEASE_TAG" in
  server-v*) VERSION="${RELEASE_TAG#server-v}" ;;
  *) die "invalid server release tag: $RELEASE_TAG" ;;
esac

SERVER_ARCHIVE="moss-server-$VERSION-linux-$ARCH.tar.gz"
RUNTIME_ARCHIVE="moss-runtime-$VERSION-linux-$ARCH.tar.gz"

if [ "$DOWNLOAD_ONLY" = 1 ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM_COMMAND=(sha256sum -c)
  elif command -v shasum >/dev/null 2>&1; then
    CHECKSUM_COMMAND=(shasum -a 256 -c)
  else
    die "sha256sum or shasum is required"
  fi

  mkdir -p "$DOWNLOAD_DIR"
  DOWNLOAD_DIR="$(cd "$DOWNLOAD_DIR" && pwd)"
  DOWNLOAD_BASE="${MOSS_DOWNLOAD_BASE:-$DEFAULT_DOWNLOAD_BASE}"
  DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"

  download_offline_file() {
    local step="$1" filename="$2"
    log "Downloading [$step/4] $filename"
    curl --fail --location --progress-bar --retry 3 --connect-timeout 20 \
      -o "$DOWNLOAD_DIR/$filename" "$DOWNLOAD_BASE/$filename"
  }

  download_offline_file 1 install.sh
  download_offline_file 2 SHA256SUMS
  for archive in "$SERVER_ARCHIVE" "$RUNTIME_ARCHIVE"; do
    if ! awk -v filename="$archive" '$2 == filename || $2 == "*" filename { found=1 } END { exit found ? 0 : 1 }' \
      "$DOWNLOAD_DIR/SHA256SUMS"; then
      die "checksum manifest does not contain $archive"
    fi
  done
  download_offline_file 3 "$SERVER_ARCHIVE"
  download_offline_file 4 "$RUNTIME_ARCHIVE"

  for archive in "$SERVER_ARCHIVE" "$RUNTIME_ARCHIVE"; do
    CHECKSUM_FILE="$(mktemp)"
    awk -v filename="$archive" '$2 == filename || $2 == "*" filename { print }' \
      "$DOWNLOAD_DIR/SHA256SUMS" > "$CHECKSUM_FILE"
    (cd "$DOWNLOAD_DIR" && "${CHECKSUM_COMMAND[@]}" "$CHECKSUM_FILE")
    rm -f "$CHECKSUM_FILE"
  done
  EXPECTED_RELEASE_LINE="$(printf 'RELEASE_TAG="${MOSS_RELEASE_TAG:-%s}"' "$RELEASE_TAG")"
  grep -Fq "$EXPECTED_RELEASE_LINE" "$DOWNLOAD_DIR/install.sh" \
    || die "downloaded install.sh does not match $RELEASE_TAG"
  chmod +x "$DOWNLOAD_DIR/install.sh"

  log "Offline files are ready: $DOWNLOAD_DIR"
  log "Copy this directory to the target server, then run: sudo ./install.sh --offline"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "run as root (for example: curl ... | sudo bash)"
[ "$(uname -s)" = Linux ] || die "only Linux is supported"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "only x86_64/amd64 is supported" ;;
esac

command -v getent >/dev/null 2>&1 || die "getent is required"
resolve_install_account() {
  PASSWD_ENTRY="$(getent passwd "$INSTALL_USER" || true)"
  [ -n "$PASSWD_ENTRY" ] || die "install user does not exist: $INSTALL_USER"
  INSTALL_USER_HOME="$(printf '%s\n' "$PASSWD_ENTRY" | awk -F: 'NR == 1 { print $6 }')"
  INSTALL_USER_GROUP="$(id -gn "$INSTALL_USER")"
  case "$INSTALL_USER_HOME" in
    /*) ;;
    *) die "install user has no absolute home directory: $INSTALL_USER" ;;
  esac
  [ -d "$INSTALL_USER_HOME" ] || die "install user home does not exist: $INSTALL_USER_HOME"
}

INSTALL_USER="${MOSS_INSTALL_USER:-${SUDO_USER:-$(id -un)}}"
resolve_install_account
DEFAULT_INSTALL_DIR="${INSTALL_USER_HOME%/}/.moss/server"

read_masked_value() {
  local label="$1" value='' char='' tty_state=''
  tty_state="$(stty -g < /dev/tty)"
  trap 'stty "$tty_state" < /dev/tty' EXIT
  trap 'exit 130' HUP INT TERM
  stty -echo < /dev/tty
  printf '%s' "$label" > /dev/tty
  while IFS= read -r -n 1 char < /dev/tty; do
    case "$char" in
      '') break ;;
      $'\177'|$'\b')
        if [ -n "$value" ]; then
          value="${value%?}"
          printf '\b \b' > /dev/tty
        fi
        ;;
      *)
        value+="$char"
        printf '*' > /dev/tty
        ;;
    esac
  done
  stty "$tty_state" < /dev/tty
  trap - EXIT HUP INT TERM
  printf '\n' > /dev/tty
  printf '%s' "$value"
}

prompt_value() {
  local variable="$1" label="$2" default_value="$3" secret="${4:-0}"
  local confirmation_label="${5:-}" mismatch_message="${6:-Values do not match; try again.}"
  local current="${!variable:-}" answer='' confirmation=''
  if [ -n "$current" ]; then
    return
  fi
  if [ "$NON_INTERACTIVE" = 1 ]; then
    printf -v "$variable" '%s' "$default_value"
    return
  fi
  if [ "$secret" = 1 ]; then
    while true; do
      answer="$(read_masked_value "$label")"
      if [ -z "$answer" ] || [ -z "$confirmation_label" ]; then
        break
      fi
      confirmation="$(read_masked_value "$confirmation_label")"
      if [ "$answer" = "$confirmation" ]; then
        break
      fi
      printf '[moss-install] %s\n' "$mismatch_message" > /dev/tty
    done
  else
    if [ -n "$default_value" ]; then
      printf '%s [%s]: ' "$label" "$default_value" > /dev/tty
    else
      printf '%s: ' "$label" > /dev/tty
    fi
    IFS= read -r answer < /dev/tty || true
  fi
  printf -v "$variable" '%s' "${answer:-$default_value}"
}

# ---------------------------------------------------------------------------
# Compute node: k3s + gvisor + the moss-runtime image
#
# Everything the K8sBackend needs on the machine that runs session pods:
#   - k3s server (bundled containerd) + kubectl
#   - gvisor (runsc) and a RuntimeClass pointing at it
#   - namespace + ServiceAccount + least-privilege RBAC for scode pods
#   - the moss-runtime image imported into containerd (scode ships inside it,
#     so nothing is staged on the node and nothing drifts out of sync)
#   - an SA-scoped kubeconfig, written beside server.json
#
# No container engine of its own: k3s brings containerd, and images are
# imported with `ctr`. Idempotent — safe to re-run. Every knob is an env var,
# so the same code provisions any Ubuntu/Debian/RHEL-family host.
# ---------------------------------------------------------------------------
provision_compute_node() {
  local NAMESPACE="${MOSS_K8S_NAMESPACE:-moss-sessions}"
  local RUNTIME_CLASS="${MOSS_K8S_RUNTIME_CLASS:-gvisor}"
  local SA_NAME="${MOSS_K8S_SA_NAME:-moss-runner}"
  local INSTALL_GVISOR="${INSTALL_GVISOR:-1}"
  local K3S_MIRROR="${K3S_MIRROR:-auto}"
  local REGISTRY_MIRROR="${REGISTRY_MIRROR:-auto}"
  local REGISTRY_MIRROR_DEFAULT="${REGISTRY_MIRROR_DEFAULT:-https://docker.m.daocloud.io}"
  local K3S_VERSION="${INSTALL_K3S_VERSION:-}"
  local NODE_IP="${NODE_IP:-}"
  local OUTPUT_DIR="${MOSS_K8S_OUTPUT_DIR:-$INSTALL_DIR}"
  local RUNTIME_VERSION="${MOSS_RUNTIME_VERSION:-}"
  local IMPORT_RUNTIME_IMAGE="${IMPORT_RUNTIME_IMAGE:-1}"
  local SCODE_IMAGE=""

  local K3S_YAML=/etc/rancher/k3s/k3s.yaml
  local CONTAINERD_TMPL=/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl
  local K3S_AIRGAP_DIR=/var/lib/rancher/k3s/agent/images
  local KARCH GARCH
  case "$(uname -m)" in
    x86_64|amd64)  KARCH=amd64; GARCH=x86_64  ;;
    aarch64|arm64) KARCH=arm64; GARCH=aarch64 ;;
    *) die "unsupported architecture for a compute node: $(uname -m)" ;;
  esac
  local GVISOR_BASE="https://storage.googleapis.com/gvisor/releases/release/latest/${GARCH}"

  # Air-gap support: prefer files staged next to this script, fall back to the
  # network unless OFFLINE_MODE=on forbids it. fetch-offline-deps.sh fills the
  # directory on a networked machine.
  local SCRIPT_DIR OFFLINE_DIR OFFLINE_MODE
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  OFFLINE_DIR="${OFFLINE_DIR:-$SCRIPT_DIR/offline}"
  OFFLINE_MODE="${OFFLINE_MODE:-auto}"
  local OFF_K3S="$OFFLINE_DIR/k3s-$KARCH"
  local OFF_K3S_INSTALL="$OFFLINE_DIR/k3s-install.sh"
  local OFF_K3S_AIRGAP="$OFFLINE_DIR/k3s-airgap-images-$KARCH.tar.zst"
  local OFF_RUNSC="$OFFLINE_DIR/runsc-$KARCH"
  local OFF_SHIM="$OFFLINE_DIR/containerd-shim-runsc-v1-$KARCH"
  local OFF_SCODE_IMAGE_REF="$OFFLINE_DIR/scode-image.ref"

  kc() { k3s kubectl "$@"; }
  ctr_import() {
    case "$1" in
      *.tar.gz|*.tgz) gunzip -c "$1" | k3s ctr images import - ;;
      *.tar.zst)      zstd -dc "$1" | k3s ctr images import - ;;
      *)              k3s ctr images import "$1" ;;
    esac
  }
  image_in_containerd() { k3s ctr images ls -q 2>/dev/null | grep -qF "$1"; }

  local K3S_USE_OFFLINE=0
  if [ -s "$OFF_K3S" ] && [ -s "$OFF_K3S_INSTALL" ] && [ -s "$OFF_K3S_AIRGAP" ] \
    && [ "$OFFLINE_MODE" != off ]; then
    K3S_USE_OFFLINE=1
  fi
  if [ "$OFFLINE_MODE" = on ]; then
    [ "$K3S_USE_OFFLINE" = 1 ] \
      || die "OFFLINE_MODE=on but $OFFLINE_DIR lacks k3s-$KARCH, k3s-install.sh and k3s-airgap-images-$KARCH.tar.zst; run fetch-offline-deps.sh first"
    [ "$INSTALL_GVISOR" != 1 ] || [ -s "$OFF_RUNSC" ] \
      || die "OFFLINE_MODE=on but $OFF_RUNSC is missing (or set INSTALL_GVISOR=0)"
  fi

  if [ -z "$NODE_IP" ]; then
    NODE_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [ -n "$NODE_IP" ] || NODE_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  prompt_value NODE_IP 'k3s API address reachable from the Moss Server (IP or hostname)' "$NODE_IP"
  [ -n "$NODE_IP" ] || die "could not detect the node IP; set NODE_IP=<ip>"
  prompt_value NAMESPACE 'Kubernetes namespace for session pods' "$NAMESPACE"
  prompt_value RUNTIME_VERSION 'moss-runtime image version (blank uses the latest release)' "$RUNTIME_VERSION"
  local KUBECONFIG_OUT="$OUTPUT_DIR/moss-k3s-kubeconfig.yaml"
  log "Compute node: ip=$NODE_IP arch=$KARCH namespace=$NAMESPACE offline=$OFFLINE_MODE"

  # A registry mirror for docker.io, written before k3s starts so the very
  # first pause-sandbox pull already uses it. 'auto' only steps in when
  # docker.io is actually unreachable, so it is a no-op on an open network.
  local mirror_url=""
  if [ "$K3S_USE_OFFLINE" = 1 ]; then
    REGISTRY_MIRROR=off
    log "Offline install; images come from the staged archives"
  fi
  case "$REGISTRY_MIRROR" in
    off) : ;;
    auto)
      if curl -sfL -m 5 -o /dev/null https://registry-1.docker.io/v2/ 2>/dev/null; then
        log "docker.io is reachable; no registry mirror needed"
      else
        mirror_url="$REGISTRY_MIRROR_DEFAULT"
        log "docker.io is unreachable; using registry mirror $mirror_url"
      fi ;;
    *) mirror_url="$REGISTRY_MIRROR"; log "Registry mirror: $mirror_url" ;;
  esac
  if [ -n "$mirror_url" ]; then
    mkdir -p /etc/rancher/k3s
    cat > /etc/rancher/k3s/registries.yaml <<EOF
mirrors:
  docker.io:
    endpoint:
      - "$mirror_url"
EOF
    systemctl is-active --quiet k3s 2>/dev/null && systemctl restart k3s
  fi

  if command -v k3s >/dev/null 2>&1 && systemctl is-active --quiet k3s 2>/dev/null; then
    log "k3s is already installed and running"
  elif [ "$K3S_USE_OFFLINE" = 1 ]; then
    log "Installing k3s from $OFFLINE_DIR"
    install -m 0755 "$OFF_K3S" /usr/local/bin/k3s || die "could not stage the k3s binary"
    mkdir -p "$K3S_AIRGAP_DIR"
    cp -f "$OFF_K3S_AIRGAP" "$K3S_AIRGAP_DIR/" || die "could not stage the airgap images"
    INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" \
      sh "$OFF_K3S_INSTALL" || die "offline k3s installation failed"
  else
    log "Installing k3s"
    local mirror="$K3S_MIRROR" installer
    if [ "$mirror" = auto ]; then
      if curl -sfL -m 5 -o /dev/null https://get.k3s.io 2>/dev/null; then mirror=off; else mirror=cn; fi
    fi
    installer="$(mktemp)"
    if [ "$mirror" = cn ]; then
      curl -sfL -m 30 https://rancher-mirror.rancher.cn/k3s/k3s-install.sh -o "$installer" \
        || die "could not download the k3s installer from the cn mirror"
      export INSTALL_K3S_MIRROR=cn
    else
      curl -sfL -m 30 https://get.k3s.io -o "$installer" \
        || die "could not download the k3s installer"
    fi
    [ -n "$K3S_VERSION" ] && export INSTALL_K3S_VERSION="$K3S_VERSION"
    INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh "$installer" || die "k3s installation failed"
    rm -f "$installer"
  fi

  log "Waiting for the node to become Ready"
  local i
  for i in $(seq 1 60); do
    kc get nodes 2>/dev/null | grep -q ' Ready ' && break
    [ "$i" -eq 60 ] && die "the node did not become Ready within 120s"
    sleep 2
  done

  command -v kubectl >/dev/null 2>&1 || ln -sf "$(command -v k3s)" /usr/local/bin/kubectl
  printf 'export KUBECONFIG=%s\n' "$K3S_YAML" > /etc/profile.d/k3s-kubeconfig.sh
  chmod 644 /etc/profile.d/k3s-kubeconfig.sh

  if [ -d "$OFFLINE_DIR/images" ]; then
    # Unmatched globs stay literal, so every loop below tests for the file.
    local img out ref
    for img in "$OFFLINE_DIR"/images/*.tar "$OFFLINE_DIR"/images/*.tar.gz "$OFFLINE_DIR"/images/*.tar.zst; do
      [ -e "$img" ] || continue
      log "Importing $(basename "$img") into containerd"
      out="$(ctr_import "$img" 2>&1)" || warn "could not import $img"
      # grep exits 1 when a tarball carries some other image; `|| true` keeps
      # `set -e` from aborting the whole run on that.
      ref="$(printf '%s\n' "$out" | grep -oE 'my-moss-runtime:[^ )]+' | head -1 || true)"
      [ -n "$ref" ] && SCODE_IMAGE="docker.io/library/$ref"
    done
  fi

  if [ "$IMPORT_RUNTIME_IMAGE" = 1 ]; then
    local MRV="${RUNTIME_VERSION#server-v}" t
    MRV="${MRV#v}"
    if [ -z "$MRV" ] && [ -s "$OFF_SCODE_IMAGE_REF" ]; then
      MRV="$(grep -oE 'my-moss-runtime:[^ )]+' "$OFF_SCODE_IMAGE_REF" | head -1 | sed 's/^my-moss-runtime://; s/-amd64$//' || true)"
    fi
    # An --offline run, or a previous install, already has the tarball on disk;
    # importing that beats a second 160 MB download of the same bytes.
    local STAGED_TARBALL="" d
    for d in "$OFFLINE_DIR/images" "$SCRIPT_DIR" "$INSTALL_DIR/packages/$RELEASE_TAG"; do
      [ -d "$d" ] || continue
      for t in "$d"/moss-runtime-*-linux-amd64.tar.gz; do
        [ -e "$t" ] || continue
        STAGED_TARBALL="$t"
        [ -n "$MRV" ] || MRV="$(basename "$t" | sed 's/^moss-runtime-//; s/-linux-amd64\.tar\.gz$//')"
        break
      done
      [ -n "$STAGED_TARBALL" ] && break
    done
    [ -z "$MRV" ] && [ "$RELEASE_TAG" != "@@MOSS_RELEASE_TAG@@" ] && MRV="${RELEASE_TAG#server-v}"
    [ -z "$SCODE_IMAGE" ] && [ -n "$MRV" ] && SCODE_IMAGE="docker.io/library/my-moss-runtime:${MRV}-amd64"

    if [ -n "$SCODE_IMAGE" ] && image_in_containerd "my-moss-runtime:${MRV}-amd64"; then
      log "Runtime image already in containerd: $SCODE_IMAGE"
    elif [ -n "$STAGED_TARBALL" ]; then
      log "Importing the runtime image from $STAGED_TARBALL"
      ctr_import "$STAGED_TARBALL" >/dev/null 2>&1 || die "could not import $STAGED_TARBALL"
      SCODE_IMAGE="docker.io/library/my-moss-runtime:${MRV}-amd64"
      image_in_containerd "my-moss-runtime:${MRV}-amd64" \
        || warn "$SCODE_IMAGE is not in containerd after the import"
    elif [ "$OFFLINE_MODE" = on ]; then
      warn "OFFLINE_MODE=on and the runtime image is neither in containerd nor staged in $OFFLINE_DIR/images; set MOSS_SCODE_IMAGE by hand"
      SCODE_IMAGE=""
    else
      local rel tar tmp want got latest_sh
      if [ -z "$MRV" ]; then
        # Capture the whole response first: `curl | grep -m1` closes the pipe
        # early, curl dies of SIGPIPE, and pipefail aborts the run.
        latest_sh="$(curl -fsSL "${MOSS_COS_BASE:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server}/latest/install.sh" 2>/dev/null || true)"
        MRV="$(printf '%s\n' "$latest_sh" | grep 'RELEASE_TAG=' | head -1 | sed 's/.*server-v//; s/[}"].*//' || true)"
      fi
      [ -n "$MRV" ] || die "could not resolve the moss-runtime version; set MOSS_RUNTIME_VERSION=<x.y.z>"
      rel="${MOSS_COS_BASE:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server}/releases/server-v${MRV}"
      tar="moss-runtime-${MRV}-linux-amd64.tar.gz"
      tmp="$(mktemp -d)"
      log "Downloading runtime image $tar"
      curl -fL --retry 3 -m 900 "$rel/$tar" -o "$tmp/$tar" || die "could not download $rel/$tar"
      if curl -fsSL "$rel/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
        want="$(awk -v f="$tar" '$2==f || $2=="*"f {print $1}' "$tmp/SHA256SUMS" | head -1)"
        if [ -n "$want" ]; then
          got="$(sha256sum "$tmp/$tar" | awk '{print $1}')"
          [ "$want" = "$got" ] || die "checksum mismatch for $tar"
        fi
      fi
      log "Importing the runtime image into containerd"
      ctr_import "$tmp/$tar" >/dev/null 2>&1 || die "could not import the runtime image"
      rm -rf "$tmp"
      SCODE_IMAGE="docker.io/library/my-moss-runtime:${MRV}-amd64"
      image_in_containerd "my-moss-runtime:${MRV}-amd64" \
        || warn "$SCODE_IMAGE is not in containerd after the import"
    fi

    # Stable alias, so server.json can pin a version-independent ref and no
    # release needs a config edit.
    if [ -n "$SCODE_IMAGE" ]; then
      if k3s ctr images tag --force "$SCODE_IMAGE" docker.io/library/moss-runtime:latest >/dev/null 2>&1; then
        SCODE_IMAGE=docker.io/library/moss-runtime:latest
      else
        warn "could not tag moss-runtime:latest, which server.json expects; set MOSS_SCODE_IMAGE to $SCODE_IMAGE"
      fi
    fi
  fi

  if [ "$INSTALL_GVISOR" = 1 ]; then
    if command -v runsc >/dev/null 2>&1; then
      log "runsc is already installed: $(runsc --version 2>/dev/null | head -1)"
    elif [ -s "$OFF_RUNSC" ] && [ -s "$OFF_SHIM" ] && [ "$OFFLINE_MODE" != off ]; then
      log "Installing gvisor from $OFFLINE_DIR"
      local pair src sha want got
      for pair in "runsc:$OFF_RUNSC" "containerd-shim-runsc-v1:$OFF_SHIM"; do
        src="${pair#*:}"; sha="${src}.sha512"
        if [ -s "$sha" ]; then
          want="$(awk '{print $1}' "$sha")"
          got="$(sha512sum "$src" | awk '{print $1}')"
          [ "$want" = "$got" ] || die "checksum mismatch for $(basename "$src")"
        fi
      done
      install -m 0755 "$OFF_RUNSC" /usr/local/bin/runsc
      install -m 0755 "$OFF_SHIM" /usr/local/bin/containerd-shim-runsc-v1
    else
      [ "$OFFLINE_MODE" = on ] && die "OFFLINE_MODE=on but $OFF_RUNSC is missing"
      log "Downloading gvisor (runsc and its containerd shim)"
      local tmp f
      tmp="$(mktemp -d)"
      for f in runsc containerd-shim-runsc-v1; do
        curl -fL -m 180 "$GVISOR_BASE/$f" -o "$tmp/$f" || die "could not download $f"
        curl -fL -m 60 "$GVISOR_BASE/$f.sha512" -o "$tmp/$f.sha512" || die "could not download $f.sha512"
        (cd "$tmp" && sha512sum -c "$f.sha512") || die "checksum mismatch for $f"
        chmod +x "$tmp/$f"
        mv "$tmp/$f" /usr/local/bin/
      done
      rm -rf "$tmp"
    fi

    # k3s merges *.toml.tmpl into its containerd config.
    mkdir -p "$(dirname "$CONTAINERD_TMPL")"
    if ! grep -q 'runtimes.runsc' "$CONTAINERD_TMPL" 2>/dev/null; then
      log "Registering runsc with the k3s containerd"
      cat > "$CONTAINERD_TMPL" <<'EOF'
{{ template "base" . }}
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
EOF
      systemctl restart k3s
      for i in $(seq 1 60); do
        kc get nodes 2>/dev/null | grep -q ' Ready ' && break
        [ "$i" -eq 60 ] && die "the node did not return to Ready after the k3s restart"
        sleep 2
      done
    fi
  else
    warn "INSTALL_GVISOR=0; RuntimeClass '$RUNTIME_CLASS' will have no handler"
  fi

  log "Applying RuntimeClass/$RUNTIME_CLASS, namespace/$NAMESPACE, ServiceAccount/$SA_NAME and RBAC"
  kc apply -f - <<EOF
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: $RUNTIME_CLASS
handler: runsc
---
apiVersion: v1
kind: Namespace
metadata:
  name: $NAMESPACE
  labels: { app.kubernetes.io/managed-by: moss-install }
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $SA_NAME
  namespace: $NAMESPACE
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: moss-scode-pods
  namespace: $NAMESPACE
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "create", "delete"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: moss-scode-pods
  namespace: $NAMESPACE
subjects:
  - kind: ServiceAccount
    name: $SA_NAME
    namespace: $NAMESPACE
roleRef:
  kind: Role
  name: moss-scode-pods
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SA_NAME}-token
  namespace: $NAMESPACE
  annotations:
    kubernetes.io/service-account.name: $SA_NAME
type: kubernetes.io/service-account-token
EOF

  log "Writing the ServiceAccount-scoped kubeconfig to $KUBECONFIG_OUT"
  local CA_DATA SA_TOKEN=""
  CA_DATA="$(awk '/certificate-authority-data:/{print $2; exit}' "$K3S_YAML")"
  for i in $(seq 1 15); do
    SA_TOKEN="$(kc -n "$NAMESPACE" get secret "${SA_NAME}-token" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)"
    [ -n "$SA_TOKEN" ] && break
    sleep 1
  done
  [ -n "$SA_TOKEN" ] || die "the ServiceAccount token Secret was not populated; re-run in a few seconds"

  mkdir -p "$OUTPUT_DIR"
  cat > "$KUBECONFIG_OUT" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: k3s
    cluster:
      certificate-authority-data: $CA_DATA
      server: https://${NODE_IP}:6443
contexts:
  - name: moss
    context:
      cluster: k3s
      namespace: $NAMESPACE
      user: $SA_NAME
current-context: moss
users:
  - name: $SA_NAME
    user:
      token: $SA_TOKEN
EOF
  chmod 600 "$KUBECONFIG_OUT"
  if [ -n "${INSTALL_USER:-}" ] && [ -n "${INSTALL_USER_GROUP:-}" ]; then
    chown "$INSTALL_USER:$INSTALL_USER_GROUP" "$KUBECONFIG_OUT" 2>/dev/null || true
  fi

  COMPUTE_KUBECONFIG="$KUBECONFIG_OUT"
  COMPUTE_NAMESPACE="$NAMESPACE"
  COMPUTE_RUNTIME_CLASS="$RUNTIME_CLASS"
  COMPUTE_SCODE_IMAGE="$SCODE_IMAGE"
  COMPUTE_NODE_IP="$NODE_IP"
  log "Compute node ready"
}

USING_DEFAULT_INSTALL_DIR=0
if [ -z "$INSTALL_DIR" ] && [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
  EXISTING_ENV_PATH="$(awk -F= '$1 == "EnvironmentFile" { print substr($0, index($0, "=") + 1); exit }' \
    "/etc/systemd/system/$SERVICE_NAME.service")"
  if [ -n "$EXISTING_ENV_PATH" ] && [ -f "$EXISTING_ENV_PATH" ]; then
    EXISTING_INSTALL_DIR="$(dirname "$EXISTING_ENV_PATH")"
    if [ -f "$EXISTING_INSTALL_DIR/server.json" ]; then
      INSTALL_DIR="$EXISTING_INSTALL_DIR"
      log "Existing service found; using install directory: $INSTALL_DIR"
    fi
  fi
fi
[ -n "$INSTALL_DIR" ] || USING_DEFAULT_INSTALL_DIR=1
if [ "$UPGRADE_ONLY" = 1 ]; then
  INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
else
  prompt_value INSTALL_DIR 'Install directory' "$DEFAULT_INSTALL_DIR"
fi
case "$INSTALL_DIR" in
  /*) ;;
  *) die "install directory must be an absolute path" ;;
esac
case "$INSTALL_DIR" in
  *[[:space:]]*) die "install directory must not contain whitespace" ;;
esac
[ "$INSTALL_DIR" != / ] || die "refusing to install into /"

if [ -f "$INSTALL_DIR/server.json" ]; then
  EXISTING_INSTALL_USER="$(stat -c %U "$INSTALL_DIR")"
  if [ -n "${MOSS_INSTALL_USER:-}" ] && [ "$EXISTING_INSTALL_USER" != "$INSTALL_USER" ]; then
    die "existing installation belongs to $EXISTING_INSTALL_USER; service-user migration is not supported"
  fi
  if [ -z "${MOSS_INSTALL_USER:-}" ] && [ -n "$EXISTING_INSTALL_USER" ] \
    && [ "$EXISTING_INSTALL_USER" != "$INSTALL_USER" ]; then
    INSTALL_USER="$EXISTING_INSTALL_USER"
    resolve_install_account
  fi
fi
[ "$UPGRADE_ONLY" = 0 ] || [ -f "$INSTALL_DIR/server.json" ] \
  || die "no existing Moss Server installation found in $INSTALL_DIR"
log "Service user: $INSTALL_USER"
log "Install directory: $INSTALL_DIR"

# Re-running over an existing installation is almost always a program update,
# so offer that rather than proposing to re-provision the machine.
if [ -z "$ROLE" ]; then
  if [ -f "$INSTALL_DIR/server.json" ]; then
    ROLE=control-plane
  else
    prompt_value ROLE 'Install on this machine (all-in-one/control-plane/compute)' 'all-in-one'
    case "$ROLE" in
      all-in-one|control-plane|compute) ;;
      *) die "role must be 'all-in-one', 'control-plane' or 'compute' (got '$ROLE')" ;;
    esac
  fi
fi
log "Role: $ROLE"

COMPUTE_KUBECONFIG=""
COMPUTE_NAMESPACE=""
COMPUTE_RUNTIME_CLASS=""
COMPUTE_SCODE_IMAGE=""
COMPUTE_NODE_IP=""
if [ "$ROLE" = compute ] || [ "$ROLE" = all-in-one ]; then
  install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" "$INSTALL_DIR"
  provision_compute_node
fi
# Which session runtime this server drives decides what the machine needs: 'k8s'
# talks to a compute node over the Kubernetes API and needs no container engine
# here, 'docker' runs sessions locally and needs a daemon. Resolved before the
# dependency checks so a k8s install never demands Docker.
MOSS_RUNTIME_VALUE="${MOSS_RUNTIME:-}"
existing_runtime_type() {
  [ -f "$INSTALL_DIR/server.json" ] || return 0
  grep -A6 '"runtimeDefaults"' "$INSTALL_DIR/server.json" \
    | grep -m1 '"type"' \
    | sed 's/.*: *"\([^"]*\)".*/\1/'
}
if [ -z "$MOSS_RUNTIME_VALUE" ]; then
  if [ "$ROLE" = all-in-one ]; then
    MOSS_RUNTIME_VALUE=k8s
  elif [ -f "$INSTALL_DIR/server.json" ]; then
    MOSS_RUNTIME_VALUE="$(existing_runtime_type)"
    case "$MOSS_RUNTIME_VALUE" in
      docker|k8s) ;;
      # Unreadable config: keep whatever this machine can actually run.
      *) if command -v docker >/dev/null 2>&1; then MOSS_RUNTIME_VALUE=docker; else MOSS_RUNTIME_VALUE=k8s; fi ;;
    esac
  else
    prompt_value MOSS_RUNTIME_VALUE 'Session runtime (k8s/docker)' 'k8s'
  fi
fi
case "$MOSS_RUNTIME_VALUE" in
  docker|k8s) ;;
  *) die "runtime must be 'docker' or 'k8s' (got '$MOSS_RUNTIME_VALUE')" ;;
esac
# Only the docker runtime loads the session image on this machine. Under k8s it
# lives in the compute node's containerd, so the control plane neither needs the
# 160 MB archive nor a container engine to unpack it with.
NEED_RUNTIME_ARCHIVE=0
[ "$MOSS_RUNTIME_VALUE" = docker ] && NEED_RUNTIME_ARCHIVE=1
INSTALL_ARCHIVES=("$SERVER_ARCHIVE")
[ "$NEED_RUNTIME_ARCHIVE" = 1 ] && INSTALL_ARCHIVES+=("$RUNTIME_ARCHIVE")

if [ "$ROLE" = compute ]; then
  log "Session runtime installed on this node"
  log "kubeconfig: $COMPUTE_KUBECONFIG"
  log "namespace: $COMPUTE_NAMESPACE   RuntimeClass: $COMPUTE_RUNTIME_CLASS"
  log "scode image: ${COMPUTE_SCODE_IMAGE:-<not imported; set MOSS_SCODE_IMAGE on the server>}"
  log "Point a Moss Server at it with these values, or install one here with --role all-in-one."
  log "Verify: KUBECONFIG=$COMPUTE_KUBECONFIG kubectl -n $COMPUTE_NAMESPACE get pods"
  exit 0
fi

INSTALLED_RELEASE_DIR="$(readlink -f "$INSTALL_DIR/current" 2>/dev/null || true)"
INSTALLED_RELEASE_TAG="${INSTALLED_RELEASE_DIR##*/}"
CURRENT_SCRIPT="${BASH_SOURCE[0]:-}"
RUNNING_INSTALLED_SCRIPT=0
if [ -n "$CURRENT_SCRIPT" ] && [ -f "$CURRENT_SCRIPT" ] \
  && [ -f "$INSTALL_DIR/install.sh" ] \
  && [ "$(readlink -f "$CURRENT_SCRIPT")" = "$(readlink -f "$INSTALL_DIR/install.sh")" ]; then
  RUNNING_INSTALLED_SCRIPT=1
fi

SKIP_SAME_RELEASE=0
if [ -f "$INSTALL_DIR/server.json" ] && [ "$INSTALLED_RELEASE_TAG" = "$RELEASE_TAG" ]; then
  if [ "$UPGRADE_ONLY" = 0 ] || [ "$OFFLINE" = 1 ] || [ "$INSTALLER_REFRESHED" = 1 ] \
    || [ "$RUNNING_INSTALLED_SCRIPT" = 0 ]; then
    SKIP_SAME_RELEASE=1
  fi
fi

if [ "$SKIP_SAME_RELEASE" = 1 ]; then
  if [ -n "$CURRENT_SCRIPT" ] && [ -f "$CURRENT_SCRIPT" ] \
    && [ "$CURRENT_SCRIPT" != "$INSTALL_DIR/install.sh" ]; then
    install -m 755 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" \
      "$CURRENT_SCRIPT" "$INSTALL_DIR/install.sh"
  fi
  log "Moss Server $RELEASE_TAG is already installed; no downloads needed"
  exit 0
fi

if [ "$UPGRADE_ONLY" = 1 ] && [ "$OFFLINE" = 0 ] && [ "$INSTALLER_REFRESHED" != 1 ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
  LATEST_INSTALLER_URL="${MOSS_INSTALLER_URL:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh}"
  LATEST_INSTALLER="$(mktemp)"
  log "Downloading latest installer"
  if ! curl --fail --location --progress-bar --retry 3 --connect-timeout 20 \
    -o "$LATEST_INSTALLER" "$LATEST_INSTALLER_URL"; then
    rm -f "$LATEST_INSTALLER"
    die "could not download latest installer"
  fi
  chmod +x "$LATEST_INSTALLER"
  set +e
  MOSS_PROGRAM_UPGRADE=1 MOSS_INSTALLER_REFRESHED=1 \
    MOSS_INSTALL_USER="$INSTALL_USER" MOSS_INSTALL_DIR="$INSTALL_DIR" \
    bash "$LATEST_INSTALLER"
  UPGRADE_STATUS=$?
  set -e
  rm -f "$LATEST_INSTALLER"
  exit "$UPGRADE_STATUS"
fi

command -v ldd >/dev/null 2>&1 || die "ldd is required"
GLIBC_VERSION="$(ldd --version 2>&1 | awk '
  NR == 1 {
    for (i = NF; i >= 1; i--) {
      if ($i ~ /^[0-9]+\.[0-9]+$/) {
        print $i
        found = 1
        break
      }
    }
  }
  END { if (!found) exit 1 }
')"
[ -n "$GLIBC_VERSION" ] || die "could not determine glibc version"
GLIBC_MAJOR="${GLIBC_VERSION%%.*}"
GLIBC_MINOR="${GLIBC_VERSION#*.}"
if [ "$GLIBC_MAJOR" -lt 2 ] || { [ "$GLIBC_MAJOR" -eq 2 ] && [ "$GLIBC_MINOR" -lt 35 ]; }; then
  die "glibc 2.35 or newer is required (Ubuntu 22.04+); found $GLIBC_VERSION"
fi

for command_name in tar gzip sha256sum systemctl curl install stat stty; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done

DOCKER_GROUP=""
if [ "$MOSS_RUNTIME_VALUE" = docker ]; then
  command -v docker >/dev/null 2>&1 || die "docker is required for the docker session runtime"
  docker info >/dev/null 2>&1 || die "Docker daemon is not available"

  DOCKER_SOCKET="/var/run/docker.sock"
  [ -S "$DOCKER_SOCKET" ] || die "Docker socket is not available: $DOCKER_SOCKET"
  DOCKER_GROUP_ID="$(stat -c %g "$DOCKER_SOCKET")"
  DOCKER_GROUP_ENTRY="$(getent group "$DOCKER_GROUP_ID" || true)"
  [ -n "$DOCKER_GROUP_ENTRY" ] || die "Docker socket group does not exist: $DOCKER_GROUP_ID"
  DOCKER_GROUP="${DOCKER_GROUP_ENTRY%%:*}"

  DOCKER_VERSION="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  DOCKER_MAJOR="${DOCKER_VERSION%%.*}"
  DOCKER_REST="${DOCKER_VERSION#*.}"
  DOCKER_MINOR="${DOCKER_REST%%.*}"
  if [ -z "$DOCKER_VERSION" ] || [ "${DOCKER_MAJOR:-0}" -lt 20 ] \
    || { [ "$DOCKER_MAJOR" -eq 20 ] && [ "${DOCKER_MINOR:-0}" -lt 10 ]; }; then
    die "Docker daemon 20.10 or newer is required; found ${DOCKER_VERSION:-unknown}"
  fi
elif [ "$ROLE" = control-plane ]; then
  # The server drives a cluster it does not host, so it needs a client and a
  # kubeconfig. all-in-one just provisioned both.
  command -v kubectl >/dev/null 2>&1 \
    || die "kubectl is required for the k8s session runtime; install it, or run --role all-in-one to provision a cluster here"
fi

if [ "$USING_DEFAULT_INSTALL_DIR" = 1 ]; then
  install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" "$INSTALL_USER_HOME/.moss"
fi
install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" \
  "$INSTALL_DIR" "$INSTALL_DIR/packages"

WORK_DIR="$(mktemp -d)"
DOWNLOAD_PART=""
cleanup() {
  rm -rf "$WORK_DIR"
  [ -z "$DOWNLOAD_PART" ] || rm -f "$DOWNLOAD_PART"
}
trap cleanup EXIT

if [ "$OFFLINE" = 1 ]; then
  SCRIPT_PATH="${BASH_SOURCE[0]:-}"
  [ -n "$SCRIPT_PATH" ] || die "--offline must be run from the unpacked install.sh file"
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SOURCE_DIR="$SCRIPT_DIR"
  for archive in "${INSTALL_ARCHIVES[@]}"; do
    [ -f "$SOURCE_DIR/$archive" ] || die "missing offline asset: $archive"
  done
  [ -f "$SOURCE_DIR/SHA256SUMS" ] || die "missing offline asset: SHA256SUMS"
else
  SOURCE_DIR="$INSTALL_DIR/packages/$RELEASE_TAG"
  install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" "$SOURCE_DIR"
  DOWNLOAD_BASE="${MOSS_DOWNLOAD_BASE:-$DEFAULT_DOWNLOAD_BASE}"
  DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"

  download_asset() {
    local step="$1" filename="$2"
    log "Downloading [$step/4] $filename"
    DOWNLOAD_PART="$SOURCE_DIR/.$filename.part.$$"
    rm -f "$DOWNLOAD_PART"
    if ! curl --fail --location --progress-bar --retry 3 --connect-timeout 20 \
      -o "$DOWNLOAD_PART" "$DOWNLOAD_BASE/$filename"; then
      rm -f "$DOWNLOAD_PART"
      DOWNLOAD_PART=""
      die "could not download $filename"
    fi
    mv -f "$DOWNLOAD_PART" "$SOURCE_DIR/$filename"
    DOWNLOAD_PART=""
  }

  cached_asset_is_valid() {
    local filename="$1" checksum_file=''
    checksum_file="$WORK_DIR/$filename.cached.sha256"
    [ -f "$SOURCE_DIR/$filename" ] || return 1
    awk -v filename="$filename" '$2 == filename || $2 == "*" filename { print }' \
      "$SOURCE_DIR/SHA256SUMS" > "$checksum_file"
    [ -s "$checksum_file" ] \
      && (cd "$SOURCE_DIR" && sha256sum -c "$checksum_file" >/dev/null 2>&1)
  }

  CURRENT_SCRIPT="${BASH_SOURCE[0]:-}"
  if [ -n "$CURRENT_SCRIPT" ] && [ -f "$CURRENT_SCRIPT" ]; then
    log "Preparing [1/4] install.sh"
    if [ "$CURRENT_SCRIPT" != "$SOURCE_DIR/install.sh" ]; then
      install -m 755 "$CURRENT_SCRIPT" "$SOURCE_DIR/install.sh"
    else
      chmod 755 "$SOURCE_DIR/install.sh"
    fi
  else
    download_asset 1 install.sh
  fi
  download_asset 2 SHA256SUMS
  for archive in "${INSTALL_ARCHIVES[@]}"; do
    if ! awk -v filename="$archive" '$2 == filename || $2 == "*" filename { found=1 } END { exit found ? 0 : 1 }' \
      "$SOURCE_DIR/SHA256SUMS"; then
      die "checksum manifest does not contain $archive; the download source is incomplete"
    fi
  done
  step=3
  for archive in "${INSTALL_ARCHIVES[@]}"; do
    if cached_asset_is_valid "$archive"; then
      log "Using cached [$step/4] $archive"
    else
      rm -f "$SOURCE_DIR/$archive"
      download_asset "$step" "$archive"
    fi
    step=$((step + 1))
  done
  chmod 644 "$SOURCE_DIR/SHA256SUMS"
  for archive in "${INSTALL_ARCHIVES[@]}"; do
    chmod 644 "$SOURCE_DIR/$archive"
  done
  chown -R "$INSTALL_USER:$INSTALL_USER_GROUP" "$SOURCE_DIR"
fi

EXPECTED_RELEASE_LINE="$(printf 'RELEASE_TAG="${MOSS_RELEASE_TAG:-%s}"' "$RELEASE_TAG")"
grep -Fq "$EXPECTED_RELEASE_LINE" "$SOURCE_DIR/install.sh" \
  || die "installer script does not match $RELEASE_TAG"

verify_asset() {
  local filename="$1"
  awk -v filename="$filename" '$2 == filename || $2 == "*" filename { print }' \
    "$SOURCE_DIR/SHA256SUMS" > "$WORK_DIR/$filename.sha256"
  [ -s "$WORK_DIR/$filename.sha256" ] || die "no checksum found for $filename"
  (cd "$SOURCE_DIR" && sha256sum -c "$WORK_DIR/$filename.sha256")
}
for archive in "${INSTALL_ARCHIVES[@]}"; do
  verify_asset "$archive"
done

if tar -tzf "$SOURCE_DIR/$SERVER_ARCHIVE" \
  | awk '$0 !~ /^moss-server\// || $0 ~ /(^|\/)\.\.($|\/)/ { bad=1 } END { exit bad ? 0 : 1 }'; then
  die "server archive contains an unsafe path"
fi
tar -xzf "$SOURCE_DIR/$SERVER_ARCHIVE" -C "$WORK_DIR"
PACKAGE_DIR="$WORK_DIR/moss-server"
NODE_BINARY="$PACKAGE_DIR/node/bin/node"
[ -x "$NODE_BINARY" ] || die "server package does not contain Node"
[ "$($NODE_BINARY -p 'process.versions.node.split(`.`)[0]')" -eq 22 ] \
  || die "server package must contain Node 22"
"$NODE_BINARY" --no-warnings -e "require('node:sqlite')" >/dev/null
[ -f "$PACKAGE_DIR/app/bin/moss-server.mjs" ] || die "server package is incomplete"
[ -x "$PACKAGE_DIR/app/bin/scode" ] || die "server package does not contain host scode"
HOST_SCODE_VERSION="$($PACKAGE_DIR/app/bin/scode --version 2>&1)" \
  || die "host scode could not run"
log "Host scode: $HOST_SCODE_VERSION"

RUNTIME_IMAGE="my-moss-runtime:$VERSION-$ARCH"
if [ "$NEED_RUNTIME_ARCHIVE" = 1 ]; then
  log "Loading Docker runtime image"
  docker load -i "$SOURCE_DIR/$RUNTIME_ARCHIVE"
  docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1 \
    || die "runtime archive did not load expected image $RUNTIME_IMAGE"
fi

EXISTING_INSTALL=0
[ -f "$INSTALL_DIR/server.json" ] && EXISTING_INSTALL=1
DEFAULT_HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
DEFAULT_HOST="${DEFAULT_HOST:-127.0.0.1}"
EXISTING_PORT=43127
EXISTING_HOST="$DEFAULT_HOST"
if [ "$EXISTING_INSTALL" = 1 ]; then
  EXISTING_PORT="$($NODE_BINARY -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).server.port" "$INSTALL_DIR/server.json")"
  EXISTING_HOST="$($NODE_BINARY -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).server.advertisedHost || '$DEFAULT_HOST'" "$INSTALL_DIR/server.json")"
fi
MOSS_PORT_VALUE="${MOSS_PORT:-}"
MOSS_ADVERTISED_HOST_VALUE="${MOSS_ADVERTISED_HOST:-}"
MOSS_ADMIN_USERNAME_VALUE="${MOSS_ADMIN_USERNAME:-}"
MOSS_ADMIN_PASSWORD_VALUE="${MOSS_ADMIN_PASSWORD:-}"
ANTHROPIC_BASE_URL_VALUE="${ANTHROPIC_BASE_URL:-}"
ANTHROPIC_API_KEY_VALUE="${ANTHROPIC_API_KEY:-}"
GENERATED_PASSWORD=0

if [ "$EXISTING_INSTALL" = 0 ]; then
  prompt_value MOSS_PORT_VALUE 'Service port' '43127'
  prompt_value MOSS_ADVERTISED_HOST_VALUE 'Public server address (IP or hostname)' "$DEFAULT_HOST"
  prompt_value MOSS_ADMIN_USERNAME_VALUE 'Administrator username' 'admin'
  prompt_value MOSS_ADMIN_PASSWORD_VALUE 'Administrator password (blank generates one): ' '' 1 \
    'Confirm administrator password: ' 'Passwords do not match; try again.'
  if [ -z "$MOSS_ADMIN_PASSWORD_VALUE" ]; then
    MOSS_ADMIN_PASSWORD_VALUE="$($NODE_BINARY -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")"
    GENERATED_PASSWORD=1
  fi
  prompt_value ANTHROPIC_BASE_URL_VALUE 'Anthropic API Base URL' 'https://hk.sudorouter.ai/v1'
  prompt_value ANTHROPIC_API_KEY_VALUE 'Anthropic API Key (optional): ' '' 1 \
    'Confirm Anthropic API Key: ' 'API Keys do not match; try again.'
else
  MOSS_PORT_VALUE="$EXISTING_PORT"
  MOSS_ADVERTISED_HOST_VALUE="$EXISTING_HOST"
  log "Existing installation found; upgrading program only"
fi

case "$MOSS_PORT_VALUE" in
  ''|*[!0-9]*) die "port must be numeric" ;;
esac
[ "$MOSS_PORT_VALUE" -ge 1 ] && [ "$MOSS_PORT_VALUE" -le 65535 ] \
  || die "port must be between 1 and 65535"

if [ "$EXISTING_INSTALL" = 0 ] && command -v ss >/dev/null 2>&1 \
  && ss -ltn | awk '{print $4}' | grep -Eq "(^|:)$MOSS_PORT_VALUE$"; then
  die "port $MOSS_PORT_VALUE is already in use"
fi

# How a session reaches back to this server (the `wiki` CLI and the auth proxy).
# Docker sessions sit on the moss-network bridge and see its gateway; k8s pods
# run on a different machine, so only the advertised address works for them --
# and the auth proxy has to listen beyond the loopback for those to arrive.
if [ "$MOSS_RUNTIME_VALUE" = docker ]; then
  if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    docker network create "$NETWORK_NAME" >/dev/null
  fi
  SESSION_REACHABLE_HOST="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK_NAME")"
  [ -n "$SESSION_REACHABLE_HOST" ] || die "could not determine $NETWORK_NAME gateway"
  AUTH_PROXY_BIND_HOST="$SESSION_REACHABLE_HOST"
else
  SESSION_REACHABLE_HOST="$MOSS_ADVERTISED_HOST_VALUE"
  [ -n "$SESSION_REACHABLE_HOST" ] \
    || die "the k8s runtime needs a public server address; set MOSS_ADVERTISED_HOST"
  AUTH_PROXY_BIND_HOST=0.0.0.0
fi

install -d -m 700 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" \
  "$INSTALL_DIR" "$INSTALL_DIR/releases" "$INSTALL_DIR/data" "$INSTALL_DIR/.moss" \
  "$INSTALL_DIR/packages"
if [ "$SOURCE_DIR/install.sh" != "$INSTALL_DIR/install.sh" ]; then
  install -m 755 -o "$INSTALL_USER" -g "$INSTALL_USER_GROUP" \
    "$SOURCE_DIR/install.sh" "$INSTALL_DIR/install.sh"
else
  chmod 755 "$INSTALL_DIR/install.sh"
  chown "$INSTALL_USER:$INSTALL_USER_GROUP" "$INSTALL_DIR/install.sh"
fi
RELEASE_DIR="$INSTALL_DIR/releases/$RELEASE_TAG"
NEW_RELEASE_DIR="$INSTALL_DIR/releases/.$RELEASE_TAG.new.$$"
PREVIOUS_TARGET="$(readlink -f "$INSTALL_DIR/current" 2>/dev/null || true)"
CONFIG_PATH="$INSTALL_DIR/server.json"
CONFIG_BACKUP=""
if [ "$EXISTING_INSTALL" = 1 ]; then
  CONFIG_BACKUP="$WORK_DIR/server.json.backup"
  cp -a "$CONFIG_PATH" "$CONFIG_BACKUP"
fi
SERVICE_STOPPED=0

rollback_on_error() {
  local status=$?
  trap - ERR
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    cp -a "$CONFIG_BACKUP" "$CONFIG_PATH"
  fi
  if [ "$SERVICE_STOPPED" = 1 ] && [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    log "Installation failed; restoring $PREVIOUS_TARGET"
    ln -sfn "$PREVIOUS_TARGET" "$INSTALL_DIR/.current.rollback"
    mv -Tf "$INSTALL_DIR/.current.rollback" "$INSTALL_DIR/current"
    systemctl restart "$SERVICE_NAME.service" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback_on_error ERR

if systemctl cat "$SERVICE_NAME.service" >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME.service" || true
  SERVICE_STOPPED=1
fi
rm -rf "$NEW_RELEASE_DIR"
cp -a "$PACKAGE_DIR" "$NEW_RELEASE_DIR"
chown -R "$INSTALL_USER:$INSTALL_USER_GROUP" "$NEW_RELEASE_DIR"
rm -rf "$RELEASE_DIR"
mv "$NEW_RELEASE_DIR" "$RELEASE_DIR"

TEMPLATE_PATH="$RELEASE_DIR/server.json.template"
CONFIG_PATH="$CONFIG_PATH" TEMPLATE_PATH="$TEMPLATE_PATH" \
EXISTING_INSTALL="$EXISTING_INSTALL" \
MOSS_INSTALL_ROOT="$INSTALL_DIR" MOSS_PORT_VALUE="$MOSS_PORT_VALUE" \
MOSS_ADVERTISED_HOST_VALUE="$MOSS_ADVERTISED_HOST_VALUE" \
MOSS_ADMIN_USERNAME_VALUE="$MOSS_ADMIN_USERNAME_VALUE" \
MOSS_ADMIN_PASSWORD_VALUE="$MOSS_ADMIN_PASSWORD_VALUE" \
MOSS_RUNTIME_IMAGE="$RUNTIME_IMAGE" MOSS_NETWORK_NAME="$NETWORK_NAME" \
MOSS_RUNTIME_VALUE="$MOSS_RUNTIME_VALUE" \
COMPUTE_KUBECONFIG="$COMPUTE_KUBECONFIG" COMPUTE_NAMESPACE="$COMPUTE_NAMESPACE" \
COMPUTE_RUNTIME_CLASS="$COMPUTE_RUNTIME_CLASS" COMPUTE_SCODE_IMAGE="$COMPUTE_SCODE_IMAGE" \
"$RELEASE_DIR/node/bin/node" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const configPath = process.env.CONFIG_PATH
const source = fs.existsSync(configPath) ? configPath : process.env.TEMPLATE_PATH
const config = JSON.parse(fs.readFileSync(source, 'utf8'))
const root = process.env.MOSS_INSTALL_ROOT
const port = Number(process.env.MOSS_PORT_VALUE)
const hostScodePath = path.join(root, 'current', 'app', 'bin', 'scode')
const dockerScodePath = '/usr/local/bin/scode'
if (process.env.EXISTING_INSTALL === '1') {
  const legacyScodePath = config.runtimeDefaults?.scodePath
  config.runtimeDefaults = {
    ...config.runtimeDefaults,
    dockerImage: process.env.MOSS_RUNTIME_IMAGE,
    hostScodePath: config.runtimeDefaults?.hostScodePath
      || (legacyScodePath && legacyScodePath !== dockerScodePath
        ? legacyScodePath
        : hostScodePath),
    dockerScodePath: config.runtimeDefaults?.dockerScodePath
      || (legacyScodePath === dockerScodePath ? legacyScodePath : undefined)
      || dockerScodePath,
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(configPath, 0o600)
  process.exit(0)
}
config.server = { ...config.server, host: '0.0.0.0', port }
if (process.env.MOSS_ADVERTISED_HOST_VALUE) {
  config.server.advertisedHost = process.env.MOSS_ADVERTISED_HOST_VALUE
  config.server.publicBaseUrl = `http://${process.env.MOSS_ADVERTISED_HOST_VALUE}:${port}`
}
if (!fs.existsSync(configPath)) {
  config.bootstrapAdmin = {
    username: process.env.MOSS_ADMIN_USERNAME_VALUE,
    password: process.env.MOSS_ADMIN_PASSWORD_VALUE,
  }
}
const runtime = process.env.MOSS_RUNTIME_VALUE === 'k8s' ? 'k8s' : 'docker'
config.runtimeDefaults = {
  ...config.runtimeDefaults,
  type: runtime,
  dockerImage: process.env.MOSS_RUNTIME_IMAGE,
  dockerMode: 'session',
  hostScodePath,
  dockerScodePath,
}
if (runtime === 'k8s') {
  // Seed the k8s block from the template defaults and pin the kubeconfig to the
  // file the compute role writes beside this server.json. When that role ran on
  // this machine it also reports the namespace, RuntimeClass and image ref it
  // actually created, so an all-in-one install needs no config edit; otherwise
  // the template defaults stand and the operator points them at their cluster.
  config.k8s = {
    ...config.k8s,
    kubeconfig: process.env.COMPUTE_KUBECONFIG || path.join(root, 'moss-k3s-kubeconfig.yaml'),
    ...(process.env.COMPUTE_NAMESPACE ? { namespace: process.env.COMPUTE_NAMESPACE } : {}),
    ...(process.env.COMPUTE_RUNTIME_CLASS
      ? { runtimeClassName: process.env.COMPUTE_RUNTIME_CLASS }
      : {}),
    ...(process.env.COMPUTE_SCODE_IMAGE
      ? { image: process.env.COMPUTE_SCODE_IMAGE.replace(/^docker\.io\/library\//, '') }
      : {}),
  }
}
config.storage = {
  rootDir: path.join(root, 'data'),
  dbPath: path.join(root, 'data', 'moss.db'),
  transcriptDir: path.join(root, 'data', 'transcripts'),
  runtimeDir: path.join(root, 'data', 'runtime'),
}
config.docker = { ...config.docker, network: process.env.MOSS_NETWORK_NAME }
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(configPath, 0o600)
NODE

SETTINGS_PATH="$INSTALL_DIR/.moss/settings.json"
if [ "$EXISTING_INSTALL" = 0 ]; then
  SETTINGS_PATH="$SETTINGS_PATH" ANTHROPIC_BASE_URL_VALUE="$ANTHROPIC_BASE_URL_VALUE" \
  ANTHROPIC_API_KEY_VALUE="$ANTHROPIC_API_KEY_VALUE" "$RELEASE_DIR/node/bin/node" <<'NODE'
const fs = require('node:fs')
const settingsPath = process.env.SETTINGS_PATH
let settings = {}
if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
settings.env = { ...settings.env }
if (process.env.ANTHROPIC_BASE_URL_VALUE) settings.env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL_VALUE
if (process.env.ANTHROPIC_API_KEY_VALUE) settings.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY_VALUE
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
fs.chmodSync(settingsPath, 0o600)
NODE
fi

ENV_PATH="$INSTALL_DIR/moss-server.env"
cat > "$ENV_PATH" <<EOF
HOME=$INSTALL_DIR
MOSS_SERVER_CONFIG=$INSTALL_DIR/server.json
MOSS_HOME=$INSTALL_DIR/.moss
MOSS_MODELS_DIR=$INSTALL_DIR/current/app/models
MOSS_NODE_PATH=$INSTALL_DIR/current/node/bin/node
MOSS_AUTH_PROXY_HOST=$AUTH_PROXY_BIND_HOST
MOSS_AUTH_PROXY_URL=http://$SESSION_REACHABLE_HOST:12013
MOSS_SERVER_URL=http://$SESSION_REACHABLE_HOST:$MOSS_PORT_VALUE
PATH=$INSTALL_DIR/current/node/bin:$INSTALL_DIR/current/app/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
chmod 600 "$ENV_PATH"

ln -sfn "releases/$RELEASE_TAG" "$INSTALL_DIR/.current.new"
mv -Tf "$INSTALL_DIR/.current.new" "$INSTALL_DIR/current"

# Bind the unit to whatever actually runs the sessions: the Docker daemon, or a
# k3s server when this machine is also the compute node. A control-plane install
# driving a remote cluster has no local runtime to wait for.
UNIT_REQUIRES=""
UNIT_AFTER="network-online.target"
UNIT_SUPPLEMENTARY_GROUPS=""
if [ "$MOSS_RUNTIME_VALUE" = docker ]; then
  UNIT_REQUIRES="Requires=docker.service"
  UNIT_AFTER="docker.service network-online.target"
  UNIT_SUPPLEMENTARY_GROUPS="SupplementaryGroups=$DOCKER_GROUP"
elif systemctl cat k3s.service >/dev/null 2>&1; then
  UNIT_AFTER="k3s.service network-online.target"
fi

cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Moss Server
$UNIT_REQUIRES
After=$UNIT_AFTER
Wants=network-online.target

[Service]
Type=simple
User=$INSTALL_USER
Group=$INSTALL_USER_GROUP
$UNIT_SUPPLEMENTARY_GROUPS
WorkingDirectory=$INSTALL_DIR/current/app
EnvironmentFile=$ENV_PATH
ExecStart=$INSTALL_DIR/current/node/bin/node $INSTALL_DIR/current/app/bin/moss-server.mjs start
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > "$INSTALL_DIR/start.sh" <<EOF
#!/usr/bin/env bash
set -e
systemctl start $SERVICE_NAME.service
EOF
cat > "$INSTALL_DIR/stop.sh" <<EOF
#!/usr/bin/env bash
set -e
systemctl stop $SERVICE_NAME.service
EOF
cat > "$INSTALL_DIR/status.sh" <<EOF
#!/usr/bin/env bash
set -e
systemctl status $SERVICE_NAME.service --no-pager
curl -fsS http://127.0.0.1:$MOSS_PORT_VALUE/healthz
printf '\n'
EOF
cat > "$INSTALL_DIR/uninstall.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\$(id -u)" -eq 0 ] || { echo 'run as root' >&2; exit 1; }
systemctl disable --now $SERVICE_NAME.service 2>/dev/null || true
rm -f /etc/systemd/system/$SERVICE_NAME.service
systemctl daemon-reload
# Leftover sessions, in whichever runtime this installation used. The k3s
# cluster itself stays: it may be shared, and uninstall-k3s.sh removes it.
if command -v docker >/dev/null 2>&1; then
  docker ps -aq --filter label=moss.kind=user-container | xargs -r docker rm -f
fi
if command -v kubectl >/dev/null 2>&1 && [ -f '$INSTALL_DIR/moss-k3s-kubeconfig.yaml' ]; then
  KUBECONFIG='$INSTALL_DIR/moss-k3s-kubeconfig.yaml' \
    kubectl delete pods -l app=moss-scode --ignore-not-found 2>/dev/null || true
fi
if [ "\${1:-}" = --purge ]; then
  rm -rf '$INSTALL_DIR'
  echo 'Moss program and data removed.'
else
  rm -rf '$INSTALL_DIR/current' '$INSTALL_DIR/releases'
  echo 'Moss program removed; data and configuration retained in $INSTALL_DIR.'
fi
EOF
chmod +x "$INSTALL_DIR/start.sh" "$INSTALL_DIR/stop.sh" "$INSTALL_DIR/status.sh" "$INSTALL_DIR/uninstall.sh"
for owned_path in "$CONFIG_PATH" "$ENV_PATH" "$SETTINGS_PATH" \
  "$INSTALL_DIR/install.sh" "$INSTALL_DIR/start.sh" "$INSTALL_DIR/stop.sh" \
  "$INSTALL_DIR/status.sh" "$INSTALL_DIR/uninstall.sh"; do
  [ ! -e "$owned_path" ] || chown "$INSTALL_USER:$INSTALL_USER_GROUP" "$owned_path"
done

systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service" >/dev/null
if ! systemctl restart "$SERVICE_NAME.service"; then
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    cp -a "$CONFIG_BACKUP" "$CONFIG_PATH"
  fi
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    ln -sfn "$PREVIOUS_TARGET" "$INSTALL_DIR/.current.rollback"
    mv -Tf "$INSTALL_DIR/.current.rollback" "$INSTALL_DIR/current"
    systemctl restart "$SERVICE_NAME.service" || true
  fi
  die "failed to start $SERVICE_NAME.service"
fi

HEALTHY=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$MOSS_PORT_VALUE/healthz" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [ "$HEALTHY" != 1 ]; then
  journalctl -u "$SERVICE_NAME.service" -n 80 --no-pager >&2 || true
  if [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
    cp -a "$CONFIG_BACKUP" "$CONFIG_PATH"
  fi
  if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
    log "Health check failed; rolling back to $PREVIOUS_TARGET"
    systemctl stop "$SERVICE_NAME.service" || true
    ln -sfn "$PREVIOUS_TARGET" "$INSTALL_DIR/.current.rollback"
    mv -Tf "$INSTALL_DIR/.current.rollback" "$INSTALL_DIR/current"
    systemctl restart "$SERVICE_NAME.service" || true
  fi
  die "health check failed on port $MOSS_PORT_VALUE"
fi

SERVICE_STOPPED=0
trap - ERR

if [ "$EXISTING_INSTALL" = 1 ]; then
  log "Moss Server upgraded to $RELEASE_TAG successfully"
else
  log "Moss Server $RELEASE_TAG installed successfully"
fi
log "URL: http://$MOSS_ADVERTISED_HOST_VALUE:$MOSS_PORT_VALUE/admin/"
log "Session runtime: $MOSS_RUNTIME_VALUE"
if [ "$MOSS_RUNTIME_VALUE" = k8s ]; then
  if [ -n "$COMPUTE_KUBECONFIG" ]; then
    log "Sessions run on this node: namespace $COMPUTE_NAMESPACE, RuntimeClass $COMPUTE_RUNTIME_CLASS"
    log "Session image: ${COMPUTE_SCODE_IMAGE:-<not imported; set MOSS_SCODE_IMAGE>}"
  else
    log "Sessions run on the cluster in $INSTALL_DIR/server.json (k8s block)."
    log "Provision one with: sudo ./install.sh --role compute"
  fi
fi
if [ "$EXISTING_INSTALL" = 0 ]; then
  log "Administrator: $MOSS_ADMIN_USERNAME_VALUE"
  if [ "$GENERATED_PASSWORD" = 1 ]; then
    log "Generated administrator password: $MOSS_ADMIN_PASSWORD_VALUE"
  fi
fi
log "Start: sudo systemctl start $SERVICE_NAME"
log "Stop: sudo systemctl stop $SERVICE_NAME"
log "Restart: sudo systemctl restart $SERVICE_NAME"
log "Status: sudo systemctl status $SERVICE_NAME"
log "Logs: sudo journalctl -u $SERVICE_NAME.service -f"
log "Upgrade: sudo $INSTALL_DIR/install.sh --upgrade"
log "Uninstall: sudo $INSTALL_DIR/uninstall.sh"
if [ "$OFFLINE" = 0 ]; then
  log "Packages: $SOURCE_DIR"
else
  log "Offline packages retained: $SOURCE_DIR"
fi
