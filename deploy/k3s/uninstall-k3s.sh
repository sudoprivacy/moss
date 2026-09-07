#!/usr/bin/env bash
# Completely remove everything install-k3s.sh deployed:
#   - k8s resources (namespace, RuntimeClass) — best effort while k3s is up
#   - k3s itself (runs the bundled k3s-uninstall.sh: server, kubectl, /var/lib/rancher)
#   - gvisor binaries (runsc, containerd-shim-runsc-v1)
#   - the generated kubeconfig (a single file beside moss server.json)
#
# Idempotent: safe to run on a partially-installed or clean host.
# NOTE: only the kubeconfig FILE is removed; the moss install dir (~/.moss/server)
# holds server.json + data and is left untouched.
#
# Usage:  sudo ./uninstall-k3s.sh
set -uo pipefail   # NOT -e: uninstall is best-effort, keep going through failures

NAMESPACE="${MOSS_K8S_NAMESPACE:-moss-sessions}"
RUNTIME_CLASS="${MOSS_K8S_RUNTIME_CLASS:-gvisor}"
# kubeconfig lives beside moss server.json (mirror install-k3s.sh's derivation).
MOSS_INSTALL_USER="${MOSS_INSTALL_USER:-${SUDO_USER:-$(id -un)}}"
MOSS_INSTALL_HOME="$(getent passwd "$MOSS_INSTALL_USER" 2>/dev/null | awk -F: 'NR==1{print $6}')"
MOSS_INSTALL_HOME="${MOSS_INSTALL_HOME:-${HOME:-/root}}"
MOSS_INSTALL_DIR="${MOSS_INSTALL_DIR:-$MOSS_INSTALL_HOME/.moss/server}"
OUTPUT_DIR="${MOSS_K8S_OUTPUT_DIR:-$MOSS_INSTALL_DIR}"
KUBECONFIG_OUT="${OUTPUT_DIR}/moss-k3s-kubeconfig.yaml"

log()  { printf '\033[0;32m[k3s-uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[k3s-uninstall]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[k3s-uninstall] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"

# ----------------------------------------------------------------------------
# 1. Delete k8s resources while the API is still up (clean teardown of pods/secrets).
# ----------------------------------------------------------------------------
if command -v k3s >/dev/null 2>&1 && systemctl is-active --quiet k3s 2>/dev/null; then
  log "deleting namespace/$NAMESPACE (pods + secrets go with it) ..."
  k3s kubectl delete namespace "$NAMESPACE" --ignore-not-found --wait=false 2>/dev/null
  log "deleting RuntimeClass/$RUNTIME_CLASS ..."
  k3s kubectl delete runtimeclass "$RUNTIME_CLASS" --ignore-not-found 2>/dev/null
else
  log "k3s not active — skipping k8s resource deletion"
fi

# ----------------------------------------------------------------------------
# 2. Uninstall k3s (server variant; falls back to agent variant).
# ----------------------------------------------------------------------------
if [ -x /usr/local/bin/k3s-uninstall.sh ]; then
  log "running k3s-uninstall.sh ..."
  /usr/local/bin/k3s-uninstall.sh
elif [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then
  log "running k3s-agent-uninstall.sh ..."
  /usr/local/bin/k3s-agent-uninstall.sh
else
  warn "no k3s uninstall script found — k3s may not be installed"
fi

# ----------------------------------------------------------------------------
# 3. Remove gvisor binaries.
# ----------------------------------------------------------------------------
for f in runsc containerd-shim-runsc-v1; do
  if [ -e "/usr/local/bin/$f" ]; then
    log "removing /usr/local/bin/$f"
    rm -f "/usr/local/bin/$f"
  fi
done

# ----------------------------------------------------------------------------
# 4. Remove the generated kubeconfig file + profile snippet.
#    Only the kubeconfig FILE is deleted — the moss install dir (server.json,
#    data) is NOT touched.
# ----------------------------------------------------------------------------
[ -f "$KUBECONFIG_OUT" ] && { log "removing kubeconfig $KUBECONFIG_OUT"; rm -f "$KUBECONFIG_OUT"; }
rm -f /etc/profile.d/k3s-kubeconfig.sh
# registries.yaml normally lives under /etc/rancher/k3s (removed by k3s-uninstall),
# but remove it explicitly in case k3s-uninstall did not run.
rm -f /etc/rancher/k3s/registries.yaml 2>/dev/null
# k3s-uninstall leaves /etc/rancher/node/password behind — remove it, then rmdir
# the rancher parents only if empty (don't clobber other rancher products).
rm -rf /etc/rancher/node 2>/dev/null
rmdir /etc/rancher /var/lib/rancher 2>/dev/null || true

log "==================== UNINSTALL COMPLETE ===================="
log "verify: 'command -v k3s runsc kubectl' should print nothing."
log "note: moss server.json + data under $MOSS_INSTALL_DIR were left in place."
