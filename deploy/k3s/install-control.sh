#!/usr/bin/env bash
# Sourced only after the deployment bundle's checksum has been verified.
set -Eeuo pipefail
CONTROL="$WORK_DIR/bundle/control.py"
python3 "$CONTROL" preflight "$INSTALL_DIR"

PREVIOUS_STATE="$INSTALL_DIR/k8s-install.json"
EXISTING_INSTALL=0
[ ! -f "$INSTALL_DIR/server.json" ] || EXISTING_INSTALL=1
if [ "$EXISTING_INSTALL" = 0 ]; then
  MOSS_PORT="${MOSS_PORT:-}"
  MOSS_ADVERTISED_HOST="${MOSS_ADVERTISED_HOST:-}"
  MOSS_ADMIN_USERNAME="${MOSS_ADMIN_USERNAME:-}"
  MOSS_ADMIN_PASSWORD="${MOSS_ADMIN_PASSWORD:-}"
  ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-}"
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
  prompt_value MOSS_PORT 'Service port' 43127
  prompt_value MOSS_ADVERTISED_HOST 'Server IP or hostname' "$(hostname -I | awk '{print $1}')"
  prompt_value MOSS_ADMIN_USERNAME 'Administrator username' admin
  prompt_value MOSS_ADMIN_PASSWORD 'Administrator password (blank generates one): ' '' 1 \
    'Confirm administrator password: ' 'Passwords do not match; try again.'
  GENERATED_PASSWORD=0
  if [ -z "$MOSS_ADMIN_PASSWORD" ]; then
    MOSS_ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
    GENERATED_PASSWORD=1
  fi
  prompt_value ANTHROPIC_BASE_URL 'Anthropic API Base URL' https://hk.sudorouter.ai/v1
  prompt_value ANTHROPIC_API_KEY 'Anthropic API Key (optional): ' '' 1 \
    'Confirm Anthropic API Key: ' 'API Keys do not match; try again.'
  export MOSS_PORT MOSS_ADVERTISED_HOST MOSS_ADMIN_USERNAME MOSS_ADMIN_PASSWORD ANTHROPIC_BASE_URL ANTHROPIC_API_KEY
fi

# Fetch and verify everything before touching the old service or provisioning.
for archive in "$SERVER_IMAGE_ARCHIVE" "$NEXUS_IMAGE_ARCHIVE" "$RUNTIME_ARCHIVE"; do
  acquire_asset "$archive"
done
if [ "$ROLE" = all-in-one ] && [ ! -f "$PREVIOUS_STATE" ]; then
  provision_compute_node
elif ! command -v k3s >/dev/null 2>&1; then
  die "--role control-plane requires a running local k3s server; use --role all-in-one to install it"
fi
k3s kubectl get nodes >/dev/null
if [ "$ROLE" = all-in-one ] && [ -f "$PREVIOUS_STATE" ] && [ "${INSTALL_GVISOR:-1}" = 1 ]; then
  plan_gvisor_runtime "$ARCH"
  if [ "$GVISOR_PROVIDER" = qualified ]; then
    provision_qualified_gvisor k3s "${OFFLINE_DIR:-$SOURCE_DIR/offline}" "${OFFLINE_MODE:-auto}"
    apply_compute_runtime_class "$QUALIFIED_RUNTIME_CLASS" "$QUALIFIED_RUNTIME_RECEIPT"
  fi
fi
if [ "$EXISTING_INSTALL" = 0 ] && [ -n "${COMPUTE_RUNTIME_CLASS:-}" ] && [ -z "${MOSS_K8S_RUNTIME_CLASS+x}" ]; then
  export MOSS_K8S_RUNTIME_CLASS="$COMPUTE_RUNTIME_CLASS"
fi
for pair in "server:$SERVER_IMAGE_ARCHIVE" "nexus:$NEXUS_IMAGE_ARCHIVE" "runtime:$RUNTIME_ARCHIVE"; do
  log "Retaining ${pair%%:*} image"
  retain_release_image "${pair#*:}"
done
for ref in "moss-server:$VERSION-$ARCH" "moss-nexus:$VERSION-$ARCH" "my-moss-runtime:$VERSION-$ARCH"; do
  k3s ctr images check "name==docker.io/library/$ref" >/dev/null
  k3s ctr images ls -q | grep -Fx "docker.io/library/$ref" >/dev/null \
    || die "image archive is missing $ref"
done

# Pin local data to the node on which this installer is running. Do not guess
# another cluster member merely because it was first in the API response.
NODE_ADDRESS="${NODE_IP:-$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}"
k3s kubectl get nodes -o json > "$WORK_DIR/nodes.json"
CONTROL_NODE="$(python3 - "$WORK_DIR/nodes.json" "$NODE_ADDRESS" "${MOSS_CONTROL_NODE:-}" "$PREVIOUS_STATE" <<'PY'
import json, pathlib, sys
nodes = json.load(open(sys.argv[1]))['items']
state = pathlib.Path(sys.argv[4])
name = json.loads(state.read_text())['node'] if state.exists() else sys.argv[3]
matches = [n for n in nodes if (n['metadata']['labels'].get('kubernetes.io/hostname') == name if name else any(a['address'] == sys.argv[2] for a in n['status']['addresses']))]
if len(matches) != 1:
    sys.exit('Cannot identify this control node; set MOSS_CONTROL_NODE to its kubernetes.io/hostname label')
print(matches[0]['metadata']['labels']['kubernetes.io/hostname'])
PY
)"
STAGED_RELEASE="$WORK_DIR/release"
mkdir -p "$STAGED_RELEASE"
cp "$WORK_DIR/bundle/control.py" "$WORK_DIR/bundle/server.json" "$STAGED_RELEASE/"
python3 "$CONTROL" render "$INSTALL_DIR" "$STAGED_RELEASE" "$VERSION" "$CONTROL_NODE" "$ARCH"
CONTROL_NAMESPACE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["namespace"])' "$STAGED_RELEASE/state.json")"
PORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$STAGED_RELEASE/state.json")"
# Refuse to take over resources belonging to a different local installation.
for kind in deployment/moss-server pvc/moss-data; do
  found="$(k3s kubectl -n "$CONTROL_NAMESPACE" get "$kind" --ignore-not-found \
    -o 'jsonpath={.metadata.name}{"|"}{.metadata.annotations.moss\.sudo\.dev/install-root}')"
  [ -z "$found" ] || [ "$found" = "${kind#*/}|$INSTALL_DIR" ] || die "$kind belongs to another or untracked installation"
done
# Namespace dry-runs are not persisted for later objects in a List. Create the
# two namespaces first so server-side validation works on a fresh cluster too.
SESSION_NAMESPACE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sessions"])' "$STAGED_RELEASE/state.json")"
for ns in "$CONTROL_NAMESPACE" "$SESSION_NAMESPACE"; do
  owner="$(k3s kubectl get namespace "$ns" --ignore-not-found -o 'jsonpath={.metadata.annotations.moss\.sudo\.dev/install-root}')"
  [ -z "$owner" ] || [ "$owner" = "$INSTALL_DIR" ] || die "namespace $ns belongs to another installation"
  k3s kubectl create namespace "$ns" --dry-run=client -o json | k3s kubectl apply -f - >/dev/null
done
if [ "$EXISTING_INSTALL" = 0 ]; then
  active_sessions="$(k3s kubectl -n "$SESSION_NAMESPACE" get pods -l app=moss-scode -o name)"
  [ -z "$active_sessions" ] || die "namespace $SESSION_NAMESPACE already contains sessions; choose a separate MOSS_K8S_NAMESPACE"
fi
k3s kubectl apply --dry-run=server -f "$STAGED_RELEASE/manifest.json" > "$WORK_DIR/validation.log" 2>&1 \
  || die 'Kubernetes rejected the deployment manifest; the existing services have not been stopped'

BACKUP_DIR="$INSTALL_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
HAD_K8S=0
LEGACY_WAS_ACTIVE=0
SNAPSHOT_READY=0
WRITERS_STOPPED=0
APPLY_STARTED=0
[ ! -f "$PREVIOUS_STATE" ] || HAD_K8S=1

rollback_control() {
  local status=$?
  trap - ERR
  set +e
  log "Installation failed; restoring the previous installation"
  if [ "$APPLY_STARTED" = 1 ]; then
    python3 "$CONTROL" stop "$INSTALL_DIR"
    # A first install has no committed state yet; still fence its new writer.
    if [ "$HAD_K8S" = 0 ]; then
      k3s kubectl -n "$CONTROL_NAMESPACE" scale deployment/moss-server --replicas=0
      k3s kubectl -n "$CONTROL_NAMESPACE" wait --for=delete pod -l app=moss-server --timeout=180s
    fi
    if ! remaining_pods="$(k3s kubectl -n "$CONTROL_NAMESPACE" get pods -l app=moss-server -o name)" || [ -n "$remaining_pods" ]; then
      warn "Cannot prove new writers stopped; snapshot retained at $BACKUP_DIR. Previous service remains stopped."
      exit "$status"
    fi
  fi
  if [ "$SNAPSHOT_READY" = 1 ]; then
    # Keep failed-version data for diagnosis; never overlay a snapshot on a
    # newer SQLite/WAL or vault directory.
    mkdir -p "$BACKUP_DIR/failed"
    for name in "${SNAPSHOT_NAMES[@]}"; do
      [ ! -e "$INSTALL_DIR/$name" ] || mv "$INSTALL_DIR/$name" "$BACKUP_DIR/failed/$name"
    done
    tar -xpf "$BACKUP_DIR/data.tar" -C "$INSTALL_DIR" || exit "$status"
  fi
  if [ "$HAD_K8S" = 1 ] && [ "$WRITERS_STOPPED" = 1 ]; then
    k3s kubectl apply -f "$BACKUP_DIR/manifest.json"
    k3s kubectl -n "$CONTROL_NAMESPACE" rollout status deployment/moss-server --timeout=300s
  elif [ "$LEGACY_WAS_ACTIVE" = 1 ]; then
    systemctl start moss-server.service
  fi
  exit "$status"
}
trap rollback_control ERR
if [ "$HAD_K8S" = 1 ]; then
  cp "$INSTALL_DIR/current/manifest.json" "$BACKUP_DIR/manifest.json"
  python3 "$CONTROL" stop "$INSTALL_DIR"
elif systemctl is-active --quiet moss-server.service; then
  LEGACY_WAS_ACTIVE=1
  systemctl stop moss-server.service
fi
WRITERS_STOPPED=1
# Quiescent snapshot: no running Moss/Nexus writer can race the copy.
snapshot_paths=()
SNAPSHOT_NAMES=(data .moss server.json server-env.json kubeconfig.json k8s-install.json current install.sh start.sh stop.sh restart.sh status.sh logs.sh uninstall.sh)
for name in "${SNAPSHOT_NAMES[@]}"; do
  [ ! -e "$INSTALL_DIR/$name" ] || snapshot_paths+=("$name")
done
tar -cpf "$BACKUP_DIR/data.tar" -C "$INSTALL_DIR" --files-from /dev/null "${snapshot_paths[@]}"
SNAPSHOT_READY=1
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/.moss/nexus/data"
for name in server.json server-env.json kubeconfig.json; do
  cp "$STAGED_RELEASE/$name" "$INSTALL_DIR/$name"
done
cp "$STAGED_RELEASE/settings.json" "$INSTALL_DIR/.moss/settings.json"
APPLY_STARTED=1
k3s kubectl apply -f "$STAGED_RELEASE/manifest.json"
k3s kubectl -n "$CONTROL_NAMESPACE" rollout status deployment/moss-server --timeout="${MOSS_ROLLOUT_TIMEOUT:-300s}"
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$PORT/readyz" >/dev/null

# Commit only after both containers and the public listener are ready.
RELEASE_DIR="$INSTALL_DIR/releases/$RELEASE_TAG"
mkdir -p "$INSTALL_DIR/releases"
if [ -d "$RELEASE_DIR" ]; then
  # Reinstalling an uninstalled same-version deployment keeps the old release
  # path valid until the atomic current-link switch.
  RELEASE_DIR="$RELEASE_DIR-reinstall-$$"
fi
mv "$STAGED_RELEASE" "$RELEASE_DIR"
cp "$RELEASE_DIR/state.json" "$PREVIOUS_STATE"
ln -sfn "${RELEASE_DIR#"$INSTALL_DIR/"}" "$INSTALL_DIR/.current.new"
mv -Tf "$INSTALL_DIR/.current.new" "$INSTALL_DIR/current"
install -m 755 "$SOURCE_DIR/install.sh" "$INSTALL_DIR/install.sh"
for action in start stop restart status logs uninstall; do
  python3 - "$INSTALL_DIR" "$action" <<'PY'
from pathlib import Path
import shlex, sys
root, action = Path(sys.argv[1]), sys.argv[2]
path = root / (action + '.sh')
path.write_text('#!/usr/bin/env bash\nset -euo pipefail\nexec python3 ' + shlex.quote(str(root / 'current/control.py')) + ' ' + shlex.quote(action) + ' ' + shlex.quote(str(root)) + ' "$@"\n')
path.chmod(0o755)
PY
done
trap - ERR
# One-time retirement of the old business service, after successful cutover.
if systemctl cat moss-server.service >/dev/null 2>&1; then
  systemctl disable moss-server.service >/dev/null
  [ ! -f /etc/systemd/system/moss-server.service ] || mv /etc/systemd/system/moss-server.service "$BACKUP_DIR/legacy-moss-server.service"
  systemctl daemon-reload
fi
if [ "$EXISTING_INSTALL" = 0 ]; then
  python3 "$CONTROL" seed "$INSTALL_DIR" || warn 'Model key was not seeded; configure it in Admin → Settings'
  log "Administrator: $MOSS_ADMIN_USERNAME"
  [ "$GENERATED_PASSWORD" != 1 ] || log "Generated administrator password: $MOSS_ADMIN_PASSWORD"
fi
log "Moss Server and Nexus $RELEASE_TAG are running in k3s ($CONTROL_NAMESPACE)"
log "Admin: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["server"]["publicBaseUrl"])' "$INSTALL_DIR/server.json")/admin/"
log "Start/stop/restart/status: sudo $INSTALL_DIR/{start,stop,restart,status}.sh"
log "Logs: sudo $INSTALL_DIR/logs.sh [server|nexus]"
log "Upgrade: sudo $INSTALL_DIR/install.sh --upgrade"
log "Backup: $BACKUP_DIR"
