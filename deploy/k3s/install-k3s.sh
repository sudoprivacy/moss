#!/usr/bin/env bash
# Deploy a single-node k3s cluster + all prerequisites the moss K8sBackend needs:
#   - k3s server (bundled containerd) + kubectl
#   - gvisor (runsc) runtime + RuntimeClass "gvisor"
#   - namespace + ServiceAccount + RBAC (least privilege for scode pods/secrets)
#   - the moss-runtime image imported into containerd (scode ships inside it)
#   - a SA-scoped kubeconfig (API server rewritten to the node's reachable IP)
#
# scode is NOT staged on the node — it lives in the runtime image, so this is a
# standard k3s + gvisor node with nothing extra to keep in sync.
#
# Idempotent: safe to re-run. Generic: every knob is an env var, so the same
# script deploys to any Ubuntu/Debian/RHEL-family host.
#
# Usage:   sudo ./install-k3s.sh                 (prompts for the few required params)
#          sudo ./install-k3s.sh --non-interactive   (accept all defaults, no prompts)
#          curl -fsSL .../install-k3s.sh | sudo bash (prompts read from /dev/tty)
# Uninstall with the companion uninstall-k3s.sh.
set -euo pipefail

# NON_INTERACTIVE=1 (or --non-interactive) → accept every default silently. Also
# forced when there is no controlling terminal to prompt on.
NON_INTERACTIVE="${MOSS_NON_INTERACTIVE:-0}"
for __arg in "$@"; do
  case "$__arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
  esac
done

# ----------------------------------------------------------------------------
# Configuration (override via env)
# ----------------------------------------------------------------------------
NAMESPACE="${MOSS_K8S_NAMESPACE:-moss-sessions}"
RUNTIME_CLASS="${MOSS_K8S_RUNTIME_CLASS:-gvisor}"
SA_NAME="${MOSS_K8S_SA_NAME:-moss-runner}"
# The generated kubeconfig lands NEXT TO moss-server's server.json (~/.moss/server),
# so server.json can reference it as ~/.moss/server/moss-k3s-kubeconfig.yaml. Mirrors
# install.sh: the sudo-invoking user's home. Override the dir via MOSS_INSTALL_DIR.
MOSS_INSTALL_USER="${MOSS_INSTALL_USER:-${SUDO_USER:-$(id -un)}}"
MOSS_INSTALL_HOME="$(getent passwd "$MOSS_INSTALL_USER" 2>/dev/null | awk -F: 'NR==1{print $6}')"
MOSS_INSTALL_HOME="${MOSS_INSTALL_HOME:-${HOME:-/root}}"
MOSS_INSTALL_DIR="${MOSS_INSTALL_DIR:-$MOSS_INSTALL_HOME/.moss/server}"
INSTALL_GVISOR="${INSTALL_GVISOR:-1}"          # 0 to skip gvisor (RuntimeClass still created)
K3S_MIRROR="${K3S_MIRROR:-auto}"               # auto | cn | off  (k3s binary download)
REGISTRY_MIRROR="${REGISTRY_MIRROR:-auto}"     # auto | off | <url>  (docker.io image pulls)
REGISTRY_MIRROR_DEFAULT="${REGISTRY_MIRROR_DEFAULT:-https://docker.m.daocloud.io}"
K3S_VERSION="${INSTALL_K3S_VERSION:-}"         # empty = installer default (stable)
NODE_IP="${NODE_IP:-}"                          # empty = auto-detect primary IP
OUTPUT_DIR="${MOSS_K8S_OUTPUT_DIR:-$MOSS_INSTALL_DIR}" # kubeconfig dir (beside server.json)
KUBECONFIG_OUT="${OUTPUT_DIR}/moss-k3s-kubeconfig.yaml"

# scode runtime image (session container). Published to Tencent COS by CI; scode
# is baked INSIDE this image, so the node needs nothing staged. The image version
# defaults to the latest server-v* release unless pinned via MOSS_RUNTIME_VERSION.
COS_BASE="${MOSS_COS_BASE:-https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server}"
MOSS_RUNTIME_VERSION="${MOSS_RUNTIME_VERSION:-}"   # empty = latest (resolved from COS latest/install.sh, or offline tarball name)
IMPORT_RUNTIME_IMAGE="${IMPORT_RUNTIME_IMAGE:-1}"  # 0 to skip importing the scode runtime image
SCODE_IMAGE=""                                     # resolved below (my-moss-runtime:<ver>-amd64)

# Release tag stamped by CI (server-vX.Y.Z). When present, pin the runtime image
# to that exact version so a released install-k3s.sh imports the SAME moss-runtime
# as its sibling moss-server. Unstamped (running from the repo) the case below
# won't match → MOSS_RUNTIME_VERSION stays empty → COS-latest resolution kicks in.
RELEASE_TAG="${MOSS_RELEASE_TAG:-@@MOSS_RELEASE_TAG@@}"
if [ -z "$MOSS_RUNTIME_VERSION" ]; then
  case "$RELEASE_TAG" in
    server-v*) MOSS_RUNTIME_VERSION="${RELEASE_TAG#server-v}" ;;
  esac
fi

# Offline / air-gap support: prefer local files in ./offline next to this script;
# fall back to network unless OFFLINE_MODE=on forces local-only. Populate the dir
# with fetch-offline-deps.sh (run once on a networked machine).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFLINE_DIR="${OFFLINE_DIR:-$SCRIPT_DIR/offline}"
OFFLINE_MODE="${OFFLINE_MODE:-auto}"           # auto | on | off

# Normalize arch to k3s (KARCH) + gvisor (GARCH) labels.
case "$(uname -m)" in
  x86_64|amd64)  KARCH=amd64; GARCH=x86_64  ;;
  aarch64|arm64) KARCH=arm64; GARCH=aarch64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

OFF_K3S="$OFFLINE_DIR/k3s-$KARCH"
OFF_K3S_INSTALL="$OFFLINE_DIR/k3s-install.sh"
OFF_K3S_AIRGAP="$OFFLINE_DIR/k3s-airgap-images-$KARCH.tar.zst"
OFF_RUNSC="$OFFLINE_DIR/runsc-$KARCH"
OFF_SHIM="$OFFLINE_DIR/containerd-shim-runsc-v1-$KARCH"
OFF_SCODE_IMAGE_REF="$OFFLINE_DIR/scode-image.ref"

K3S_YAML="/etc/rancher/k3s/k3s.yaml"
CONTAINERD_TMPL="/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl"
K3S_AIRGAP_DIR="/var/lib/rancher/k3s/agent/images"
GVISOR_BASE="https://storage.googleapis.com/gvisor/releases/release/latest/${GARCH}"

log()  { printf '\033[0;32m[k3s-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[k3s-install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[k3s-install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

kc() { k3s kubectl "$@"; }

# prompt_value VAR_NAME LABEL DEFAULT
# Ask the operator for a value, showing DEFAULT; empty input keeps DEFAULT. Reads
# from /dev/tty (not stdin) so `curl … | sudo bash` still prompts. NON_INTERACTIVE
# or no controlling tty → use DEFAULT silently. Pass the current (env/derived)
# value as DEFAULT so a pre-set MOSS_* env var becomes the shown default.
prompt_value() {
  local __var="$1" __label="$2" __default="$3" __input=""
  if [ "$NON_INTERACTIVE" = "1" ] || [ ! -e /dev/tty ]; then
    printf -v "$__var" '%s' "$__default"
    return
  fi
  printf '\033[0;36m[k3s-install]\033[0m %s [%s]: ' "$__label" "$__default" > /dev/tty
  IFS= read -r __input < /dev/tty || __input=""
  printf -v "$__var" '%s' "${__input:-$__default}"
}

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"

# Decide whether the k3s install uses offline artifacts.
K3S_USE_OFFLINE=0
if [ -s "$OFF_K3S" ] && [ -s "$OFF_K3S_INSTALL" ] && [ -s "$OFF_K3S_AIRGAP" ]; then
  [ "$OFFLINE_MODE" != "off" ] && K3S_USE_OFFLINE=1
fi
if [ "$OFFLINE_MODE" = "on" ]; then
  [ "$K3S_USE_OFFLINE" = 1 ] || die "OFFLINE_MODE=on but missing offline k3s files in $OFFLINE_DIR (need k3s-$KARCH, k3s-install.sh, k3s-airgap-images-$KARCH.tar.zst). Run fetch-offline-deps.sh first."
  [ "$INSTALL_GVISOR" != 1 ] || [ -s "$OFF_RUNSC" ] || die "OFFLINE_MODE=on but missing $OFF_RUNSC (or set INSTALL_GVISOR=0)"
fi
log "offline mode: $OFFLINE_MODE   k3s offline artifacts: $([ "$K3S_USE_OFFLINE" = 1 ] && echo yes || echo no)   arch: $KARCH"

# ----------------------------------------------------------------------------
# 0. Node IP + interactive parameters
#    Auto-detect the primary IP first so it seeds the prompt default, then ask
#    for the handful of params the rest of the run needs. (All are also env vars,
#    so `--non-interactive` / MOSS_* env pre-sets skip the questions.)
# ----------------------------------------------------------------------------
if [ -z "$NODE_IP" ]; then
  NODE_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  [ -n "$NODE_IP" ] || NODE_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
prompt_value NODE_IP 'k3s API address reachable from the moss server (IP/host)' "$NODE_IP"
[ -n "$NODE_IP" ] || die "could not detect node IP; set NODE_IP=<ip>"
prompt_value NAMESPACE 'Kubernetes namespace for session pods' "$NAMESPACE"
prompt_value MOSS_RUNTIME_VERSION 'moss-runtime image version (blank = latest)' "$MOSS_RUNTIME_VERSION"
prompt_value MOSS_INSTALL_DIR 'moss install dir (kubeconfig lands here, beside server.json)' "$MOSS_INSTALL_DIR"
# Re-derive the kubeconfig location against the (possibly prompted) install dir.
OUTPUT_DIR="${MOSS_K8S_OUTPUT_DIR:-$MOSS_INSTALL_DIR}"
KUBECONFIG_OUT="${OUTPUT_DIR}/moss-k3s-kubeconfig.yaml"
log "node IP: $NODE_IP   arch: $KARCH   namespace: $NAMESPACE"

# ----------------------------------------------------------------------------
# 0.5 Registry mirror for docker.io (pause/busybox/scode images).
#     Many hosts (esp. in CN) cannot reach registry-1.docker.io; without a
#     mirror every pod fails at the pause-sandbox pull. Written BEFORE k3s starts
#     so the first pull already uses it. `auto` only applies a mirror when
#     docker.io is actually unreachable, so this stays a no-op on open networks.
# ----------------------------------------------------------------------------
mirror_url=""
if [ "$K3S_USE_OFFLINE" = 1 ]; then
  REGISTRY_MIRROR="off"   # offline install: images come from the airgap tar + offline/images
  log "offline install — skipping registry mirror (images served locally)"
fi
case "$REGISTRY_MIRROR" in
  off) log "registry mirror disabled" ;;
  auto)
    if curl -sfL -m 5 -o /dev/null https://registry-1.docker.io/v2/ 2>/dev/null; then
      log "docker.io reachable — no registry mirror needed"
    else
      mirror_url="$REGISTRY_MIRROR_DEFAULT"
      log "docker.io unreachable — using registry mirror: $mirror_url"
    fi ;;
  *) mirror_url="$REGISTRY_MIRROR"; log "registry mirror (explicit): $mirror_url" ;;
esac
if [ -n "$mirror_url" ]; then
  mkdir -p /etc/rancher/k3s
  cat > /etc/rancher/k3s/registries.yaml <<EOF
mirrors:
  docker.io:
    endpoint:
      - "$mirror_url"
EOF
  # If k3s is already running, apply the mirror now.
  systemctl is-active --quiet k3s 2>/dev/null && { log "restarting k3s for registry mirror ..."; systemctl restart k3s; }
fi

# ----------------------------------------------------------------------------
# 1. Install k3s
# ----------------------------------------------------------------------------
if command -v k3s >/dev/null 2>&1 && systemctl is-active --quiet k3s 2>/dev/null; then
  log "k3s already installed and active — skipping install"
elif [ "$K3S_USE_OFFLINE" = 1 ]; then
  # ---- Air-gapped install: binary + airgap images from the offline dir ----
  log "installing k3s OFFLINE from $OFFLINE_DIR ..."
  install -m 0755 "$OFF_K3S" /usr/local/bin/k3s || die "failed to stage k3s binary"
  mkdir -p "$K3S_AIRGAP_DIR"
  cp -f "$OFF_K3S_AIRGAP" "$K3S_AIRGAP_DIR/" || die "failed to stage airgap images"
  log "staged airgap images: $(basename "$OFF_K3S_AIRGAP")"
  # INSTALL_K3S_SKIP_DOWNLOAD=true => installer uses the staged binary + images, no network.
  INSTALL_K3S_SKIP_DOWNLOAD=true \
  INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" \
    sh "$OFF_K3S_INSTALL" || die "offline k3s installation failed"
else
  # ---- Online install via the get.k3s.io / cn-mirror installer ----
  log "installing k3s (online) ..."
  mirror="$K3S_MIRROR"
  if [ "$mirror" = "auto" ]; then
    if curl -sfL -m 5 -o /dev/null https://get.k3s.io 2>/dev/null; then mirror="off"; else mirror="cn"; fi
    log "mirror auto-detected: $mirror"
  fi

  installer="$(mktemp)"
  if [ "$mirror" = "cn" ]; then
    curl -sfL -m 30 https://rancher-mirror.rancher.cn/k3s/k3s-install.sh -o "$installer" \
      || die "failed to download k3s installer (cn mirror)"
    export INSTALL_K3S_MIRROR=cn
  else
    curl -sfL -m 30 https://get.k3s.io -o "$installer" \
      || die "failed to download k3s installer"
  fi
  [ -n "$K3S_VERSION" ] && export INSTALL_K3S_VERSION="$K3S_VERSION"
  # write-kubeconfig-mode 644 so non-root tools can read it during testing.
  INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh "$installer" \
    || die "k3s installation failed"
  rm -f "$installer"
fi

log "waiting for node to be Ready ..."
for i in $(seq 1 60); do
  if kc get nodes 2>/dev/null | grep -q ' Ready '; then break; fi
  [ "$i" -eq 60 ] && die "node did not become Ready within 120s"
  sleep 2
done
kc get nodes

# kubectl symlink (the installer creates /usr/local/bin/kubectl; ensure it exists)
if ! command -v kubectl >/dev/null 2>&1; then
  ln -sf "$(command -v k3s)" /usr/local/bin/kubectl
fi
# Make `kubectl` work out of the box for interactive shells.
cat > /etc/profile.d/k3s-kubeconfig.sh <<EOF
export KUBECONFIG=$K3S_YAML
EOF
chmod 644 /etc/profile.d/k3s-kubeconfig.sh

# ----------------------------------------------------------------------------
# 1.5 Import workload images into k3s containerd.
#     (a) Any *.tar[.gz|.zst] staged in offline/images (e.g. a busybox smoke
#         image, or the moss-runtime image tarball fetch-offline-deps.sh drops
#         there) — imported so air-gapped pods have their images locally.
#     (b) The scode session runtime image (my-moss-runtime:<ver>-amd64): from the
#         offline tarball if present, else downloaded from COS (with checksum).
#     The resulting image ref is reported as MOSS_SCODE_IMAGE at the end.
# ----------------------------------------------------------------------------
# ctr_import <file> — import a docker-save archive (handles .tar/.tar.gz/.tar.zst),
# echoing the unpacked image ref(s) on stdout.
ctr_import() {
  local file="$1"
  case "$file" in
    *.tar.gz|*.tgz) gunzip -c "$file" | k3s ctr images import - ;;
    *.tar.zst)      zstd -dc "$file" | k3s ctr images import - ;;
    *)              k3s ctr images import "$file" ;;
  esac
}

if [ -d "$OFFLINE_DIR/images" ]; then
  shopt -s nullglob 2>/dev/null || true
  for img in "$OFFLINE_DIR"/images/*.tar "$OFFLINE_DIR"/images/*.tar.gz "$OFFLINE_DIR"/images/*.tar.zst; do
    [ -e "$img" ] || continue
    log "importing image tarball into containerd: $(basename "$img")"
    out="$(ctr_import "$img" 2>&1)" || warn "import failed: $img"
    printf '%s\n' "$out" | grep -E 'unpacking|import' >&2 || true
    # Remember the runtime image ref if this tarball carried it. `|| true`:
    # grep exits 1 on no match (e.g. the busybox tar) and set -e would abort.
    ref="$(printf '%s\n' "$out" | grep -oE 'my-moss-runtime:[^ )]+' | head -1 || true)"
    [ -n "$ref" ] && SCODE_IMAGE="docker.io/library/$ref"
  done
fi

image_in_containerd() { # image_in_containerd <docker.io/library/ref>
  k3s ctr images ls -q 2>/dev/null | grep -qF "$1"
}

if [ "$IMPORT_RUNTIME_IMAGE" = "1" ]; then
  # Resolve the runtime version: explicit env > offline ref file > offline tarball
  # name (the COS-latest fallback happens only in the online branch below).
  MRV="${MOSS_RUNTIME_VERSION#server-v}"; MRV="${MRV#v}"
  if [ -z "$MRV" ] && [ -s "$OFF_SCODE_IMAGE_REF" ]; then
    MRV="$(grep -oE 'my-moss-runtime:[^ )]+' "$OFF_SCODE_IMAGE_REF" | head -1 | sed 's/^my-moss-runtime://; s/-amd64$//' || true)"
  fi
  if [ -z "$MRV" ]; then
    for t in "$OFFLINE_DIR"/images/moss-runtime-*-linux-amd64.tar.gz; do
      [ -e "$t" ] || continue
      MRV="$(basename "$t" | sed 's/^moss-runtime-//; s/-linux-amd64\.tar\.gz$//')"; break
    done
  fi
  # Deterministic ref (the offline/images loop may already have imported it).
  [ -z "$SCODE_IMAGE" ] && [ -n "$MRV" ] && SCODE_IMAGE="docker.io/library/my-moss-runtime:${MRV}-amd64"

  if [ -n "$SCODE_IMAGE" ] && image_in_containerd "my-moss-runtime:${MRV}-amd64"; then
    log "scode runtime image ready in containerd: $SCODE_IMAGE"
  elif [ "$OFFLINE_MODE" = "on" ]; then
    warn "OFFLINE_MODE=on but runtime image not present in containerd and not staged in $OFFLINE_DIR/images — set MOSS_SCODE_IMAGE manually"
    SCODE_IMAGE=""
  else
    # Online: pull the runtime tarball from COS and import it.
    if [ -z "$MRV" ]; then
      log "resolving latest moss-runtime version from COS ..."
      # Capture fully first: `curl | grep -m1` closes the pipe early → curl
      # dies with SIGPIPE (exit 23) → pipefail aborts the script.
      latest_sh="$(curl -fsSL "$COS_BASE/latest/install.sh" 2>/dev/null || true)"
      MRV="$(printf '%s\n' "$latest_sh" | grep 'RELEASE_TAG=' | head -1 | sed 's/.*server-v//; s/[}"].*//' || true)"
    fi
    [ -n "$MRV" ] || die "could not resolve moss-runtime version (set MOSS_RUNTIME_VERSION=<x.y.z>)"
    rel="$COS_BASE/releases/server-v${MRV}"
    tar="moss-runtime-${MRV}-linux-amd64.tar.gz"
    tmp="$(mktemp -d)"
    log "downloading runtime image $tar from COS ..."
    curl -fL --retry 3 -m 900 "$rel/$tar" -o "$tmp/$tar" || die "runtime image download failed: $rel/$tar"
    if curl -fsSL "$rel/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
      want="$(awk -v f="$tar" '$2==f || $2=="*"f {print $1}' "$tmp/SHA256SUMS" | head -1)"
      if [ -n "$want" ]; then
        got="$(sha256sum "$tmp/$tar" | awk '{print $1}')"
        [ "$want" = "$got" ] || die "runtime image checksum mismatch for $tar"
        log "runtime image checksum OK"
      fi
    fi
    log "importing runtime image into containerd ..."
    ctr_import "$tmp/$tar" >/dev/null 2>&1 || die "runtime image import failed"
    rm -rf "$tmp"
    SCODE_IMAGE="docker.io/library/my-moss-runtime:${MRV}-amd64"
    if image_in_containerd "my-moss-runtime:${MRV}-amd64"; then
      log "scode runtime image ready in containerd: $SCODE_IMAGE"
    else
      warn "expected image $SCODE_IMAGE not found in containerd after import"
    fi
  fi

  # Stable alias: tag whatever version we imported as moss-runtime:latest so
  # server.json can pin a version-independent ref (imagePullPolicy: Never finds
  # it locally). MOSS_SCODE_IMAGE is reported as this alias to match server.json.
  if [ -n "$SCODE_IMAGE" ]; then
    LATEST_REF="docker.io/library/moss-runtime:latest"
    if k3s ctr images tag --force "$SCODE_IMAGE" "$LATEST_REF" >/dev/null 2>&1; then
      log "tagged $SCODE_IMAGE -> $LATEST_REF"
      SCODE_IMAGE="$LATEST_REF"
    else
      warn "could not tag $LATEST_REF (server.json expects it) — set MOSS_SCODE_IMAGE to $SCODE_IMAGE"
    fi
  fi
fi

# ----------------------------------------------------------------------------
# 2. gvisor (runsc) + containerd wiring
# ----------------------------------------------------------------------------
if [ "$INSTALL_GVISOR" = "1" ]; then
  if command -v runsc >/dev/null 2>&1; then
    log "runsc already installed: $(runsc --version 2>/dev/null | head -1)"
  elif [ -s "$OFF_RUNSC" ] && [ -s "$OFF_SHIM" ] && [ "$OFFLINE_MODE" != "off" ]; then
    log "installing gvisor OFFLINE from $OFFLINE_DIR ..."
    # Verify checksums if the .sha512 files were shipped alongside.
    for pair in "runsc:$OFF_RUNSC" "containerd-shim-runsc-v1:$OFF_SHIM"; do
      src="${pair#*:}"; sha="${src}.sha512"
      if [ -s "$sha" ]; then
        want="$(awk '{print $1}' "$sha")"
        got="$(sha512sum "$src" | awk '{print $1}')"
        [ "$want" = "$got" ] || die "checksum mismatch for $(basename "$src")"
      fi
    done
    install -m 0755 "$OFF_RUNSC" /usr/local/bin/runsc
    install -m 0755 "$OFF_SHIM"  /usr/local/bin/containerd-shim-runsc-v1
    log "runsc installed (offline): $(runsc --version 2>/dev/null | head -1)"
  else
    [ "$OFFLINE_MODE" = "on" ] && die "OFFLINE_MODE=on but $OFF_RUNSC missing"
    log "downloading gvisor (runsc + shim) from $GVISOR_BASE ..."
    tmp="$(mktemp -d)"
    for f in runsc containerd-shim-runsc-v1; do
      curl -fL -m 180 "${GVISOR_BASE}/${f}"        -o "${tmp}/${f}"        || die "download ${f} failed"
      curl -fL -m 60  "${GVISOR_BASE}/${f}.sha512" -o "${tmp}/${f}.sha512" || die "download ${f}.sha512 failed"
      ( cd "$tmp" && sha512sum -c "${f}.sha512" ) || die "checksum mismatch for ${f}"
      chmod +x "${tmp}/${f}"
      mv "${tmp}/${f}" /usr/local/bin/
    done
    rm -rf "$tmp"
    log "runsc installed: $(runsc --version 2>/dev/null | head -1)"
  fi

  # Tell k3s' bundled containerd about the runsc runtime (k3s merges *.toml.tmpl).
  mkdir -p "$(dirname "$CONTAINERD_TMPL")"
  if ! grep -q 'runtimes.runsc' "$CONTAINERD_TMPL" 2>/dev/null; then
    log "registering runsc runtime in k3s containerd template ..."
    cat > "$CONTAINERD_TMPL" <<'EOF'
{{ template "base" . }}
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
EOF
    log "restarting k3s to pick up the runsc runtime ..."
    systemctl restart k3s
    for i in $(seq 1 60); do
      kc get nodes 2>/dev/null | grep -q ' Ready ' && break
      [ "$i" -eq 60 ] && die "node did not return to Ready after restart"
      sleep 2
    done
  else
    log "runsc runtime already present in containerd template"
  fi
else
  warn "INSTALL_GVISOR=0 — skipping runsc install; RuntimeClass '$RUNTIME_CLASS' will have no handler"
fi

# ----------------------------------------------------------------------------
# 3. RuntimeClass
# ----------------------------------------------------------------------------
log "applying RuntimeClass '$RUNTIME_CLASS' (handler runsc) ..."
kc apply -f - <<EOF
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: $RUNTIME_CLASS
handler: runsc
EOF

# ----------------------------------------------------------------------------
# 4. Namespace + ServiceAccount + RBAC
# ----------------------------------------------------------------------------
log "applying namespace/$NAMESPACE + ServiceAccount/$SA_NAME + RBAC ..."
kc apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $NAMESPACE
  labels: { app.kubernetes.io/managed-by: moss-k3s-install }
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
EOF

# Long-lived SA token Secret (k8s >=1.24 no longer auto-creates one).
kc apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${SA_NAME}-token
  namespace: $NAMESPACE
  annotations:
    kubernetes.io/service-account.name: $SA_NAME
type: kubernetes.io/service-account-token
EOF

# ----------------------------------------------------------------------------
# 5. Generate SA-scoped kubeconfig (server rewritten to $NODE_IP)
# ----------------------------------------------------------------------------
log "generating SA-scoped kubeconfig -> $KUBECONFIG_OUT"
CA_DATA="$(awk '/certificate-authority-data:/{print $2; exit}' "$K3S_YAML")"
SA_TOKEN=""
for i in $(seq 1 15); do
  SA_TOKEN="$(kc -n "$NAMESPACE" get secret "${SA_NAME}-token" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  [ -n "$SA_TOKEN" ] && break
  sleep 1
done
[ -n "$SA_TOKEN" ] || die "SA token Secret not populated; re-run in a few seconds"

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

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
log "==================== DONE ===================="
kc get runtimeclass "$RUNTIME_CLASS" 2>/dev/null || true
kc get ns "$NAMESPACE"
echo
log "kubeconfig written beside moss server.json at:"
log "    $KUBECONFIG_OUT"
echo
log "point moss-server at this cluster — pick ONE:"
cat <<EOF
  A) Fresh moss-server install (one-click): run the server installer and choose
     'k8s' at the runtime prompt — it seeds the k8s block automatically.
         curl -fsSL $COS_BASE/latest/install.sh | sudo bash
  B) Existing moss-server: flip ONE field in $MOSS_INSTALL_DIR/server.json:
         runtimeDefaults.type = "k8s"      # then restart moss-server

  Resolved values (already match the server.json k8s defaults — no edit needed
  unless you overrode a dir/namespace):
    k8s.kubeconfig       = $KUBECONFIG_OUT
    k8s.namespace        = $NAMESPACE
    k8s.runtimeClassName = $RUNTIME_CLASS
    k8s.image            = moss-runtime:latest -> ${SCODE_IMAGE:-<not imported; set IMPORT_RUNTIME_IMAGE=1 or MOSS_SCODE_IMAGE>}

  Every field is env-overridable at runtime: MOSS_DEFAULT_RUNTIME, MOSS_K8S_KUBECONFIG,
  MOSS_K8S_NAMESPACE, MOSS_K8S_RUNTIME_CLASS, MOSS_SCODE_IMAGE.
EOF
echo
log "the moss host also needs a 'kubectl' on PATH (k3s installs one at /usr/local/bin/kubectl on this node)."
log "/etc/profile.d/k3s-kubeconfig.sh makes 'kubectl' work in new login shells on this node."
log "verify now:"
log "    export KUBECONFIG=$KUBECONFIG_OUT"
log "    kubectl -n $NAMESPACE get pods"
