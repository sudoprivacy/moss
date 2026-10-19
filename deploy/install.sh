#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

RELEASE_TAG="${MOSS_RELEASE_TAG:-@@MOSS_RELEASE_TAG@@}"
MOSS_DEPLOYMENT_FORMAT=k3s-v1
DEFAULT_DOWNLOAD_BASE="https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/releases/$RELEASE_TAG"
ROLE="${MOSS_ROLE:-all-in-one}"
INSTALL_DIR="${MOSS_INSTALL_DIR:-}"
NON_INTERACTIVE="${MOSS_NON_INTERACTIVE:-0}"
OFFLINE=0
DOWNLOAD_ONLY=0
DOWNLOAD_DIR=""
UPGRADE_ONLY="${MOSS_PROGRAM_UPGRADE:-0}"
K3S_URL_JOIN="${MOSS_K3S_URL:-}"
K3S_JOIN_TOKEN="${MOSS_K3S_TOKEN:-}"
export INSTALL_K3S_VERSION="${INSTALL_K3S_VERSION:-v1.34.1+k3s1}"
log() { printf '[moss-install] %s\n' "$*"; }
warn() { printf '[moss-install] WARNING: %s\n' "$*" >&2; }
die() { printf '[moss-install] ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: install.sh [options]

Deploy separate Moss Server and Nexus images as two containers in one k3s Pod.
Business services are managed by Kubernetes. k3s itself is a host service.

  --role all-in-one     Install k3s + gvisor and Moss/Nexus (default).
  --role control-plane Deploy Moss/Nexus into the local, existing k3s server.
  --role compute       Only provision a session worker; --join adds an agent.
  --join URL           Join a k3s server (implies --role compute).
  --token TOKEN        Node token for --join.
  --offline            Use release files beside this script; never download.
  --download PATH      Download release images and k3s/gvisor offline assets.
  --upgrade            Fetch the latest installer and upgrade with rollback.
  --install-dir PATH   Data root (default: <install-user-home>/.moss/server).
  --non-interactive    Read configuration from environment variables.
  -h, --help           Show this help.

Environment: MOSS_INSTALL_USER, MOSS_INSTALL_DIR, MOSS_PORT,
MOSS_ADVERTISED_HOST, MOSS_ADMIN_USERNAME, MOSS_ADMIN_PASSWORD,
ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, MOSS_DOWNLOAD_BASE, MOSS_INSTALLER_URL,
MOSS_CONTROL_NAMESPACE, MOSS_CONTROL_NODE, MOSS_K8S_NAMESPACE,
MOSS_K8S_RUNTIME_CLASS, NODE_IP, INSTALL_GVISOR, INSTALL_K3S_VERSION,
K3S_MIRROR, REGISTRY_MIRROR, OFFLINE_DIR, MOSS_ARCH (download target: amd64|arm64).

Existing embedded installations are migrated after a stopped-data backup.
Custom external Nexus, ZoneId-bound data and external data paths require a
separate migration; the preflight refuses them before stopping any service.
EOF
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --offline) OFFLINE=1 ;;
    --upgrade) UPGRADE_ONLY=1 ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    --download|--install-dir|--role|--join|--server|--token)
      [ "$#" -ge 2 ] || die "$1 requires a value"
      case "$1" in
        --download) DOWNLOAD_ONLY=1; DOWNLOAD_DIR="$2" ;;
        --install-dir) INSTALL_DIR="$2" ;;
        --role) ROLE="$2" ;;
        --join|--server) K3S_URL_JOIN="$2" ;;
        --token) K3S_JOIN_TOKEN="$2" ;;
      esac
      shift ;;
    --role=*) ROLE="${1#*=}" ;;
    --join=*|--server=*) K3S_URL_JOIN="${1#*=}" ;;
    --token=*) K3S_JOIN_TOKEN="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
[ "$OFFLINE" = 0 ] || [ "$DOWNLOAD_ONLY" = 0 ] || die '--offline and --download cannot be combined'
[ "$UPGRADE_ONLY" = 0 ] || [ "$DOWNLOAD_ONLY" = 0 ] || die '--upgrade and --download cannot be combined'
if [ -n "$K3S_URL_JOIN" ]; then
  ROLE=compute
  [ -n "$K3S_JOIN_TOKEN" ] || die '--join requires --token'
elif [ -n "$K3S_JOIN_TOKEN" ]; then
  die '--token requires --join'
fi
case "$ROLE" in all-in-one|control-plane|compute) ;; *) die "invalid role: $ROLE" ;; esac
case "$RELEASE_TAG" in server-v*) VERSION="${RELEASE_TAG#server-v}" ;; *) die "invalid server release tag: $RELEASE_TAG" ;; esac
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || die 'invalid release version'
[ "${MOSS_RUNTIME:-k8s}" = k8s ] || die 'The container installer uses k8s sessions; Docker/host installers are archived under deploy/legacy'
for command_name in python3 curl tar gzip; do
  command -v "$command_name" >/dev/null || die "$command_name is required"
done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "Python 3.9+ is required")'
python3 - <<'PY'
import os, re, sys
for key in ('MOSS_CONTROL_NAMESPACE', 'MOSS_K8S_NAMESPACE', 'MOSS_K8S_SA_NAME'):
    value = os.environ.get(key)
    if value is not None and (len(value) > 63 or not re.fullmatch(r'[a-z0-9](?:[-a-z0-9]*[a-z0-9])?', value)):
        sys.exit('Invalid Kubernetes name: ' + key)
PY
case "$(uname -m)" in
  x86_64|amd64) HOST_ARCH=amd64 ;;
  aarch64|arm64) HOST_ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
ARCH="${MOSS_ARCH:-$HOST_ARCH}"
case "$ARCH" in amd64|arm64) ;; *) die "unsupported MOSS_ARCH: $ARCH" ;; esac
[ "$DOWNLOAD_ONLY" = 1 ] || [ "$ARCH" = "$HOST_ARCH" ] || die "release architecture $ARCH does not match host $HOST_ARCH"
SERVER_IMAGE_ARCHIVE="moss-server-image-$VERSION-linux-$ARCH.tar.gz"
NEXUS_IMAGE_ARCHIVE="moss-nexus-image-$VERSION-linux-$ARCH.tar.gz"
RUNTIME_ARCHIVE="moss-runtime-$VERSION-linux-$ARCH.tar.gz"
DEPLOY_ARCHIVE="moss-deploy-$VERSION-linux-$ARCH.tar.gz"
SCRIPT_DIR=""
CURRENT_SCRIPT="${BASH_SOURCE[0]:-}"
if [ -n "$CURRENT_SCRIPT" ] && [ -f "$CURRENT_SCRIPT" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$CURRENT_SCRIPT")" && pwd)"
fi
[ "$OFFLINE" = 0 ] || [ -n "$SCRIPT_DIR" ] || die '--offline must be run from the unpacked install.sh file'
DOWNLOAD_BASE="${MOSS_DOWNLOAD_BASE:-$DEFAULT_DOWNLOAD_BASE}"
DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"
WORK_DIR="$(mktemp -d)"
chmod 700 "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

download_file() {
  local name="$1"
  log "Downloading $name"
  curl --fail --location --progress-bar --retry 3 --connect-timeout 20 \
    -o "$SOURCE_DIR/$name.part" "$DOWNLOAD_BASE/$name"
  mv "$SOURCE_DIR/$name.part" "$SOURCE_DIR/$name"
}
release_asset_checksum() {
  python3 - "$SOURCE_DIR/SHA256SUMS" "$1" <<'PY'
import pathlib, re, sys
matches = [line.split()[0] for line in pathlib.Path(sys.argv[1]).read_text().splitlines()
           if len(line.split()) == 2 and line.split()[1].lstrip('*') == sys.argv[2]]
if len(matches) != 1 or not re.fullmatch(r'[a-f0-9]{64}', matches[0]):
    sys.exit('Missing or ambiguous asset checksum: ' + sys.argv[2])
print(matches[0])
PY
}
verify_asset() {
  local expected
  expected="$(release_asset_checksum "$1")" || return 1
  python3 - "$SOURCE_DIR/$1" "$expected" <<'PY'
import hashlib, pathlib, sys
path = pathlib.Path(sys.argv[1])
if not path.is_file():
    sys.exit('Missing asset: ' + path.name)
digest = hashlib.sha256()
with path.open('rb') as stream:
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
if digest.hexdigest() != sys.argv[2]:
    sys.exit('Checksum mismatch: ' + path.name)
PY
}
acquire_asset() {
  if verify_asset "$1" 2>/dev/null; then
    log "Using verified $1"
  else
    [ "$OFFLINE" = 0 ] || die "offline asset missing or invalid: $1"
    download_file "$1"
    verify_asset "$1"
  fi
}
verify_installer() {
  local expected
  expected="$(printf 'RELEASE_TAG="${MOSS_RELEASE_TAG:-%s}"' "$RELEASE_TAG")"
  grep -Fxq "$expected" "$SOURCE_DIR/install.sh" || die 'installer version mismatch'
}

if [ "$DOWNLOAD_ONLY" = 1 ]; then
  SOURCE_DIR="$DOWNLOAD_DIR"
  mkdir -p "$SOURCE_DIR"
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
  download_file install.sh
  verify_installer
  download_file SHA256SUMS
  for archive in "$DEPLOY_ARCHIVE" "$SERVER_IMAGE_ARCHIVE" "$NEXUS_IMAGE_ARCHIVE" "$RUNTIME_ARCHIVE"; do
    acquire_asset "$archive"
  done
  download_file fetch-offline-deps.sh
  FETCH_MOSS=0 ARCH="$ARCH" K3S_VERSION="$INSTALL_K3S_VERSION" OFFLINE_DIR="$SOURCE_DIR/offline" \
    bash "$SOURCE_DIR/fetch-offline-deps.sh"
  chmod 755 "$SOURCE_DIR/install.sh"
  log "Offline files are ready: $SOURCE_DIR"
  log 'Copy the directory to the target and run sudo ./install.sh --offline'
  exit 0
fi
[ "$(id -u)" -eq 0 ] || die 'run as root (for example: curl ... | sudo bash)'
[ "$(uname -s)" = Linux ] || die 'only Linux is supported'
if [ "$ARCH" = arm64 ] && [ "${INSTALL_GVISOR:-1}" != 0 ]; then
  [ "$(getconf PAGE_SIZE)" = 4096 ] || die 'the ARM64 gVisor release requires a 4096-byte host page size'
fi
INSTALL_USER="${MOSS_INSTALL_USER:-${SUDO_USER:-$(id -un)}}"
INSTALL_USER_HOME="$(getent passwd "$INSTALL_USER" | cut -d: -f6)"
[ -d "$INSTALL_USER_HOME" ] || die 'install user has no home directory'
INSTALL_USER_GROUP="$(id -gn "$INSTALL_USER")"
DEFAULT_INSTALL_DIR="${INSTALL_USER_HOME%/}/.moss/server"
if [ -z "$INSTALL_DIR" ] && [ -f /etc/systemd/system/moss-server.service ]; then
  LEGACY_ENV="$(awk -F= '$1 == "EnvironmentFile" { print substr($0, index($0, "=") + 1); exit }' /etc/systemd/system/moss-server.service)"
  [ -z "$LEGACY_ENV" ] || INSTALL_DIR="$(dirname "$LEGACY_ENV")"
fi
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
case "$INSTALL_DIR" in /*) ;; *) die 'install directory must be absolute' ;; esac
case "$INSTALL_DIR" in /|*[[:space:]]*) die 'invalid install directory' ;; esac
log "Install directory: $INSTALL_DIR"
[ "$UPGRADE_ONLY" = 0 ] || [ -f "$INSTALL_DIR/server.json" ] || die 'no existing Moss installation'
if [ "$UPGRADE_ONLY" = 1 ] && [ "$OFFLINE" = 0 ] && [ "${MOSS_INSTALLER_REFRESHED:-0}" != 1 ]; then
  curl --fail --location --progress-bar --retry 3 --connect-timeout 20 \
    "${MOSS_INSTALLER_URL:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh}" \
    -o "$WORK_DIR/latest.sh"
  grep -Fxq 'MOSS_DEPLOYMENT_FORMAT=k3s-v1' "$WORK_DIR/latest.sh" \
    || die 'The latest release still uses the legacy process installer; publish a container release before upgrading this installation'
  MOSS_INSTALLER_REFRESHED=1 MOSS_PROGRAM_UPGRADE=1 MOSS_INSTALL_DIR="$INSTALL_DIR" MOSS_ROLE="$ROLE" \
    bash "$WORK_DIR/latest.sh"
  exit $?
fi
if [ -f "$INSTALL_DIR/k8s-install.json" ]; then
  read -r installed_version installed_namespace < <(python3 -c 'import json,sys;s=json.load(open(sys.argv[1]));print(s["version"],s["namespace"])' "$INSTALL_DIR/k8s-install.json")
  if [ "$installed_version" = "$VERSION" ] && k3s kubectl -n "$installed_namespace" get deployment moss-server >/dev/null 2>&1; then
    log "Moss Server $RELEASE_TAG is already installed; no downloads needed"
    exit 0
  fi
fi
mkdir -p "$INSTALL_DIR"
command -v flock >/dev/null || die 'flock is required'
exec 9> "$INSTALL_DIR/.install.lock"
flock -n 9 || die 'another installer is running for this installation'
if [ "$OFFLINE" = 1 ]; then
  SOURCE_DIR="$SCRIPT_DIR"
  export OFFLINE_MODE=on OFFLINE_DIR="${OFFLINE_DIR:-$SCRIPT_DIR/offline}"
else
  SOURCE_DIR="$INSTALL_DIR/packages/$RELEASE_TAG"
  mkdir -p "$SOURCE_DIR"
  download_file SHA256SUMS
  if [ -n "$CURRENT_SCRIPT" ] && [ -f "$CURRENT_SCRIPT" ]; then
    cp "$CURRENT_SCRIPT" "$SOURCE_DIR/install.sh"
  else
    download_file install.sh
  fi
fi
verify_installer
acquire_asset "$DEPLOY_ARCHIVE"
mkdir -p "$WORK_DIR/bundle"
python3 - "$SOURCE_DIR/$DEPLOY_ARCHIVE" "$WORK_DIR/bundle" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as bundle:
    members = bundle.getmembers()
    expected = {'control.py', 'install-control.sh', 'fetch-offline-deps.sh', 'server.json',
                'images.py', 'artifacts.py', 'sudostack-images.lock.json'}
    if len(members) != len(expected) or {m.name for m in members} != expected or any(not m.isfile() for m in members):
        sys.exit('Unsafe deployment bundle')
    bundle.extractall(sys.argv[2], members=members)
PY

retain_release_image() {
  local expected
  expected="$(release_asset_checksum "$1")" || die "missing image identity: $1"
  python3 "$WORK_DIR/bundle/images.py" --archive "$SOURCE_DIR/$1" --sha256 "$expected"
}

read_masked_value() {
  local label="$1" value='' char='' tty_state=''
  tty_state="$(stty -g < /dev/tty)"
  trap 'stty "$tty_state" < /dev/tty; rm -rf "$WORK_DIR"' EXIT
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
  trap 'rm -rf "$WORK_DIR"' EXIT
  trap - HUP INT TERM
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
# Compute-node infrastructure: k3s, gvisor and scoped Kubernetes access
#
# Everything the K8sBackend needs on the machine that runs session pods:
#   - k3s server (bundled containerd) + kubectl
#   - gvisor (runsc) and a RuntimeClass pointing at it
#   - namespace + ServiceAccount + least-privilege RBAC for scode pods
#   - an SA-scoped kubeconfig, written beside server.json
#
# The release-bound caller retains business images through the shared image
# tool after the node is ready. Configuration uses environment variables.
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

  # A join URL turns this node into a k3s agent that grows an existing cluster;
  # otherwise it is the seed that starts a fresh single-node server. Agents run
  # gvisor pods too, so they still need runsc + the runtime image locally, but
  # they never apply cluster resources or write a kubeconfig — the seed owns those.
  local K3S_ROLE K3S_SERVICE
  if [ -n "${K3S_URL_JOIN:-}" ]; then
    K3S_ROLE=agent; K3S_SERVICE=k3s-agent
  else
    K3S_ROLE=server; K3S_SERVICE=k3s
  fi

  local K3S_YAML=/etc/rancher/k3s/k3s.yaml
  local CONTAINERD_TMPL=/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl
  local K3S_AIRGAP_DIR=/var/lib/rancher/k3s/agent/images
  local KARCH GARCH
  case "$(uname -m)" in
    x86_64|amd64)  KARCH=amd64; GARCH=x86_64  ;;
    aarch64|arm64) KARCH=arm64; GARCH=aarch64 ;;
    *) die "unsupported architecture for a compute node: $(uname -m)" ;;
  esac

  # Air-gap support: prefer files staged next to this script, fall back to the
  # network unless OFFLINE_MODE=on forbids it. fetch-offline-deps.sh fills the
  # directory on a networked machine.
  local SCRIPT_DIR
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local OFFLINE_DIR="${OFFLINE_DIR:-$SCRIPT_DIR/offline}"
  local OFFLINE_MODE="${OFFLINE_MODE:-auto}"
  local OFF_K3S="$OFFLINE_DIR/k3s-$KARCH"
  local OFF_K3S_INSTALL="$OFFLINE_DIR/k3s-install.sh"
  local OFF_K3S_AIRGAP="$OFFLINE_DIR/k3s-airgap-images-$KARCH.tar.zst"
  if [ ! -s "$OFF_K3S_AIRGAP" ] && [ -s "$OFFLINE_DIR/k3s-airgap-images-$KARCH.tar.gz" ]; then
    OFF_K3S_AIRGAP="$OFFLINE_DIR/k3s-airgap-images-$KARCH.tar.gz"
  fi
  local OFF_RUNSC="$OFFLINE_DIR/runsc-$KARCH"
  local OFF_SHIM="$OFFLINE_DIR/containerd-shim-runsc-v1-$KARCH"

  kc() { k3s kubectl "$@"; }
  ctr_import() {
    case "$1" in
      *.tar.gz|*.tgz) gunzip -c "$1" | k3s ctr images import - ;;
      *.tar.zst)      zstd -dc "$1" | k3s ctr images import - ;;
      *)              k3s ctr images import "$1" ;;
    esac
  }

  # A server is Ready when the API reports its node Ready; an agent has no local
  # kubeconfig, so we settle for its containerd answering (that is all the image
  # import and gvisor registration below need).
  wait_node_ready() {
    local i
    if [ "$K3S_ROLE" = server ]; then
      for i in $(seq 1 60); do
        kc get nodes 2>/dev/null | grep -q ' Ready ' && return 0
        sleep 2
      done
      die "the node did not become Ready within 120s"
    else
      for i in $(seq 1 60); do
        k3s ctr version >/dev/null 2>&1 && return 0
        sleep 2
      done
      die "the k3s agent did not come up within 120s (check --join URL/--token and that $NODE_IP can reach the seed on 6443/tcp)"
    fi
  }

  # Best-effort: a multi-node cluster needs flannel VXLAN (8472/udp) and kubelet
  # (10250/tcp) between nodes, plus the API (6443/tcp) reachable on the seed. Only
  # touch a firewall that is actually active; cloud security groups still apply.
  open_cluster_ports() {
    local p
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
      for p in "$@"; do ufw allow "$p" >/dev/null 2>&1 || true; done
      log "Opened cluster ports via ufw: $*"
    elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
      for p in "$@"; do firewall-cmd --permanent --add-port="$p" >/dev/null 2>&1 || true; done
      firewall-cmd --reload >/dev/null 2>&1 || true
      log "Opened cluster ports via firewalld: $*"
    fi
  }

  local K3S_USE_OFFLINE=0
  if [ -s "$OFF_K3S" ] && [ -s "$OFF_K3S_INSTALL" ] && [ -s "$OFF_K3S_AIRGAP" ] \
    && [ "$OFFLINE_MODE" != off ]; then
    K3S_USE_OFFLINE=1
  fi
  if [ "$OFFLINE_MODE" = on ] && ! { command -v k3s >/dev/null 2>&1 && systemctl is-active --quiet "$K3S_SERVICE"; }; then
    [ "$K3S_USE_OFFLINE" = 1 ] \
      || die "OFFLINE_MODE=on but $OFFLINE_DIR lacks k3s-$KARCH, k3s-install.sh and k3s-airgap-images-$KARCH.tar.zst (or .tar.gz); run fetch-offline-deps.sh first"
    [ "$INSTALL_GVISOR" != 1 ] || [ -s "$OFF_RUNSC" ] \
      || die "OFFLINE_MODE=on but $OFF_RUNSC is missing (or set INSTALL_GVISOR=0)"
  fi

  if [ -z "$NODE_IP" ]; then
    NODE_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [ -n "$NODE_IP" ] || NODE_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  # The seed advertises this address in the kubeconfig it hands the Moss Server;
  # an agent only needs the version to import the matching image, so it skips the
  # API-address and namespace prompts (the seed already owns both).
  if [ "$K3S_ROLE" = server ]; then
    prompt_value NODE_IP 'k3s API address reachable from the Moss Server (IP or hostname)' "$NODE_IP"
    [ -n "$NODE_IP" ] || die "could not detect the node IP; set NODE_IP=<ip>"
    prompt_value NAMESPACE 'Kubernetes namespace for session pods' "$NAMESPACE"
  fi
  local KUBECONFIG_OUT="$OUTPUT_DIR/moss-k3s-kubeconfig.yaml"
  log "Compute node: role=$K3S_ROLE ip=$NODE_IP arch=$KARCH namespace=$NAMESPACE offline=$OFFLINE_MODE"

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
    systemctl is-active --quiet "$K3S_SERVICE" 2>/dev/null && systemctl restart "$K3S_SERVICE"
  fi

  # Open the ports the cluster fabric needs before k3s starts (best-effort; only
  # a live host firewall is touched). The seed also exposes the API on 6443/tcp.
  if [ "$K3S_ROLE" = server ]; then
    open_cluster_ports 6443/tcp 8472/udp 10250/tcp
  else
    open_cluster_ports 8472/udp 10250/tcp
  fi

  if command -v k3s >/dev/null 2>&1 && systemctl is-active --quiet "$K3S_SERVICE" 2>/dev/null; then
    log "k3s ($K3S_ROLE) is already installed and running"
  elif [ "$K3S_USE_OFFLINE" = 1 ]; then
    log "Installing k3s ($K3S_ROLE) from $OFFLINE_DIR"
    install -m 0755 "$OFF_K3S" /usr/local/bin/k3s || die "could not stage the k3s binary"
    mkdir -p "$K3S_AIRGAP_DIR"
    cp -f "$OFF_K3S_AIRGAP" "$K3S_AIRGAP_DIR/" || die "could not stage the airgap images"
    if [ "$K3S_ROLE" = agent ]; then
      INSTALL_K3S_SKIP_DOWNLOAD=true K3S_URL="$K3S_URL_JOIN" K3S_TOKEN="$K3S_JOIN_TOKEN" \
        sh "$OFF_K3S_INSTALL" || die "offline k3s agent installation failed"
    else
      INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_EXEC="--write-kubeconfig-mode 600" \
        sh "$OFF_K3S_INSTALL" || die "offline k3s installation failed"
    fi
  else
    log "Installing k3s ($K3S_ROLE)"
    # Cloud VMs cloned from one image often share hostname "ubuntu"; k3s keys node
    # identity on the hostname, so a second node with the same name is rejected
    # ("Node password rejected, duplicate hostname"). Derive a unique, stable node
    # name from the node IP so agents (and the seed) never collide on join.
    local NODE_NAME
    NODE_NAME="moss-$(printf '%s' "$NODE_IP" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')"
    [ "$NODE_NAME" != moss- ] || NODE_NAME="moss-$(hostname | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '-' | sed 's/-*$//')-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    log "k3s node name: $NODE_NAME"
    local mirror="$K3S_MIRROR" installer
    if [ "$mirror" = auto ]; then
      # Decide by real throughput to the github release *binary* CDN, not mere
      # reachability. In China get.k3s.io (script CDN), github HTML pages, and even
      # the first bytes of a release asset are reachable, but sustained downloads
      # from objects.githubusercontent.com stall — so a plain reachability/1-byte
      # probe wrongly picks 'off' and then hangs for minutes on the ~60MB k3s
      # binary. Pull a few MB of the actual binary with a speed floor: a stalled
      # connection drops below the floor and aborts in seconds, falling back to cn.
      if curl -sfL --connect-timeout 5 --max-time 8 \
        --speed-limit 500000 --speed-time 3 -r 0-3000000 -o /dev/null \
        https://github.com/k3s-io/k3s/releases/latest/download/k3s 2>/dev/null; then
        mirror=off
      else
        mirror=cn
      fi
    fi
    # Mirrors to try in order. A probe that picked 'off' (github) can be fooled by
    # intermittent China connectivity — the first few MB arrive fast enough to pass
    # the speed floor, then the full ~40MB binary stalls — so fall back to cn if the
    # off install fails. An explicit K3S_MIRROR=cn skips github entirely.
    local mirrors m ok=0
    if [ "$mirror" = cn ]; then mirrors="cn"; else mirrors="off cn"; fi
    installer="$(mktemp)"
    [ -n "$K3S_VERSION" ] && export INSTALL_K3S_VERSION="$K3S_VERSION"
    for m in $mirrors; do
      if [ "$m" = cn ]; then
        curl -sfL -m 30 https://rancher-mirror.rancher.cn/k3s/k3s-install.sh -o "$installer" \
          || { warn "could not download the k3s installer from the cn mirror"; continue; }
        export INSTALL_K3S_MIRROR=cn
      else
        curl -sfL -m 30 https://get.k3s.io -o "$installer" \
          || { warn "could not download the k3s installer from get.k3s.io"; continue; }
        unset INSTALL_K3S_MIRROR
      fi
      # K3S_URL/K3S_TOKEN make the official installer set up an agent unit
      # (k3s-agent) instead of a server; INSTALL_K3S_EXEC is server-only.
      if [ "$K3S_ROLE" = agent ]; then
        if INSTALL_K3S_EXEC="--node-name $NODE_NAME" \
          K3S_URL="$K3S_URL_JOIN" K3S_TOKEN="$K3S_JOIN_TOKEN" sh "$installer"; then ok=1; break; fi
      else
        if INSTALL_K3S_EXEC="--write-kubeconfig-mode 600 --node-name $NODE_NAME" sh "$installer"; then ok=1; break; fi
      fi
      warn "k3s ($K3S_ROLE) install via '$m' mirror failed; trying the next mirror"
    done
    rm -f "$installer"
    [ "$ok" = 1 ] || die "k3s ($K3S_ROLE) installation failed (check --join URL/--token and network)"
  fi

  log "Waiting for k3s ($K3S_ROLE) to come up"
  wait_node_ready

  # kubectl and the shell KUBECONFIG only make sense on the seed; an agent has no
  # local API access.
  if [ "$K3S_ROLE" = server ]; then
    command -v kubectl >/dev/null 2>&1 || ln -sf "$(command -v k3s)" /usr/local/bin/kubectl
    printf 'export KUBECONFIG=%s\n' "$K3S_YAML" > /etc/profile.d/k3s-kubeconfig.sh
    chmod 644 /etc/profile.d/k3s-kubeconfig.sh
  fi

  if [ -d "$OFFLINE_DIR/images" ]; then
    # Unmatched globs stay literal, so every loop below tests for the file.
    local img
    for img in "$OFFLINE_DIR"/images/*.tar "$OFFLINE_DIR"/images/*.tar.gz "$OFFLINE_DIR"/images/*.tar.zst; do
      [ -e "$img" ] || continue
      case "$(basename "$img")" in
        moss-runtime-*-linux-*.tar.gz) continue ;;
      esac
      log "Importing $(basename "$img") into containerd"
      ctr_import "$img" >/dev/null 2>&1 || die "could not import $img"
    done
  fi


  install_staged_gvisor() {
    local stage="$1"
    local pair src sha want got
    for pair in "runsc:$stage/runsc-$KARCH" "containerd-shim-runsc-v1:$stage/containerd-shim-runsc-v1-$KARCH"; do
      src="${pair#*:}"; sha="${src}.sha512"
      if [ -s "$sha" ]; then
        want="$(awk '{print $1}' "$sha")"
        got="$(sha512sum "$src" | awk '{print $1}')"
        [ "$want" = "$got" ] || die "checksum mismatch for $(basename "$src")"
      fi
    done
    install -m 0755 "$stage/runsc-$KARCH" /usr/local/bin/runsc
    install -m 0755 "$stage/containerd-shim-runsc-v1-$KARCH" /usr/local/bin/containerd-shim-runsc-v1
    if [ -s "$stage/gvisor-bin-$KARCH/SHA512SUMS" ]; then
      (cd "$stage/gvisor-bin-$KARCH" && sha512sum -c SHA512SUMS >/dev/null) || die 'gvisor helper checksum mismatch'
      install -d -m 0755 /usr/local/bin/gvisor-bin
      for src in "$stage/gvisor-bin-$KARCH/"*; do
        [ "$(basename "$src")" = SHA512SUMS ] || install -m 0755 "$src" /usr/local/bin/gvisor-bin/
      done
    fi
  }

  if [ "$INSTALL_GVISOR" = 1 ]; then
    if command -v runsc >/dev/null 2>&1; then
      log "runsc is already installed: $(runsc --version 2>/dev/null | head -1)"
    elif [ -s "$OFF_RUNSC" ] && [ -s "$OFF_SHIM" ] && [ "$OFFLINE_MODE" != off ]; then
      log "Installing gvisor from $OFFLINE_DIR"
      install_staged_gvisor "$OFFLINE_DIR"
    else
      [ "$OFFLINE_MODE" = on ] && die "OFFLINE_MODE=on but $OFF_RUNSC is missing"
      log "Downloading gvisor (runsc and its containerd shim)"
      local tmp f
      tmp="$(mktemp -d)"
      FETCH_K3S=0 FETCH_MOSS=0 ARCH="$KARCH" OFFLINE_DIR="$tmp" \
        bash "$WORK_DIR/bundle/fetch-offline-deps.sh" || die 'could not stage verified gvisor release'
      install_staged_gvisor "$tmp"
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
      systemctl restart "$K3S_SERVICE"
      wait_node_ready
    fi
  else
    warn "INSTALL_GVISOR=0; RuntimeClass '$RUNTIME_CLASS' will have no handler"
  fi

  # An agent grows an existing cluster: its runsc handler + runtime image are now
  # in place, and the k8s scheduler will place gvisor pods on it. Cluster
  # resources (RuntimeClass/namespace/RBAC) and the Moss Server kubeconfig belong
  # to the seed, which already applied them, so the agent stops here.
  if [ "$K3S_ROLE" = agent ]; then
    COMPUTE_KUBECONFIG=""
    COMPUTE_NAMESPACE="$NAMESPACE"
    COMPUTE_RUNTIME_CLASS="$RUNTIME_CLASS"
    COMPUTE_NODE_IP="$NODE_IP"
    COMPUTE_K3S_ROLE="agent"
    COMPUTE_JOIN_URL="$K3S_URL_JOIN"
    log "Compute agent joined $K3S_URL_JOIN"
    return 0
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
    verbs: ["get", "list", "watch", "create", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["get", "create"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "create"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "create", "patch", "delete"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "create", "patch"]
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
  COMPUTE_NODE_IP="$NODE_IP"
  COMPUTE_K3S_ROLE="server"
  # The node-token lets a later `--role compute --join` attach an agent. It is a
  # cluster join secret, so it is surfaced only in the seed's own summary.
  COMPUTE_K3S_TOKEN="$(cat /var/lib/rancher/k3s/server/node-token 2>/dev/null || true)"
  log "Compute node ready"
}


if [ "$ROLE" = compute ]; then
  # Keep worker provisioning independent of the business-service lifecycle.
  acquire_asset "$RUNTIME_ARCHIVE"
  provision_compute_node
  if [ "${IMPORT_RUNTIME_IMAGE:-1}" = 1 ]; then
    retain_release_image "$RUNTIME_ARCHIVE"
    COMPUTE_SCODE_IMAGE="docker.io/library/my-moss-runtime:$VERSION-$ARCH"
    log "Compute node ready; session image: $COMPUTE_SCODE_IMAGE"
  else
    log 'Compute node ready'
  fi
  exit 0
fi
source "$WORK_DIR/bundle/install-control.sh"
