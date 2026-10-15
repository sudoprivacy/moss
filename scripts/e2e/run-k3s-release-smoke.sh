#!/usr/bin/env bash
# Runs only on a disposable Linux release runner. Uses a mock provider; no
# customer cluster, database or model credentials are accessed.
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:?version required}"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo 'Unsupported runner architecture' >&2; exit 1 ;;
esac
DIST_DIR="$(cd "${2:?dist directory required}" && pwd)"
INSTALL_DIR=/tmp/moss-k3s-release-fixture
EVIDENCE="$DIST_DIR/k3s-evidence"
PORT=43139
MOCK_PID=""
ASSET_PID=""
mkdir -p "$EVIDENCE"
[ ! -e "$INSTALL_DIR" ] || { echo 'fixture directory already exists' >&2; exit 1; }
if sudo systemctl cat moss-server.service >/dev/null 2>&1; then
  echo 'A foreign Moss service exists; refusing to run the fixture' >&2
  exit 1
fi
finish() {
  status=$?
  trap - EXIT
  set +e
  sudo k3s kubectl -n moss-control-fixture get pods -o wide > "$EVIDENCE/pods.txt" 2>&1
  sudo k3s kubectl -n moss-control-fixture get events --sort-by=.lastTimestamp > "$EVIDENCE/events.txt" 2>&1
  sudo k3s kubectl -n moss-control-fixture logs deployment/moss-server -c server --tail=150 > "$EVIDENCE/server.log" 2>&1
  sudo k3s kubectl -n moss-control-fixture logs deployment/moss-server -c nexus --tail=150 > "$EVIDENCE/nexus.log" 2>&1
  if [ -f "$INSTALL_DIR/uninstall.sh" ]; then sudo "$INSTALL_DIR/uninstall.sh" --purge; fi
  [ -z "$MOCK_PID" ] || kill "$MOCK_PID"
  [ -z "$ASSET_PID" ] || kill "$ASSET_PID"
  exit "$status"
}
trap finish EXIT
cp "$DIST_DIR/SHA256SUMS-$ARCH" "$DIST_DIR/SHA256SUMS"
python3 -m http.server 18483 --bind 127.0.0.1 --directory "$DIST_DIR" > "$EVIDENCE/assets.log" 2>&1 &
ASSET_PID=$!
node "$ROOT_DIR/scripts/e2e/mock-openai-server.mjs" --host 0.0.0.0 --port 18484 \
  --api-key fixture-key --url-file "$EVIDENCE/mock-url.txt" --log-file "$EVIDENCE/mock-requests.jsonl" \
  > "$EVIDENCE/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18484/healthz >/dev/null 2>&1 && curl -fsS http://127.0.0.1:18483/install.sh >/dev/null 2>&1; then break; fi
  sleep 1
done
NODE_ADDRESS="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
sudo env MOSS_NON_INTERACTIVE=1 MOSS_INSTALL_DIR="$INSTALL_DIR" MOSS_PORT="$PORT" \
  MOSS_ADMIN_USERNAME=e2e-admin MOSS_ADMIN_PASSWORD=fixture-password \
  MOSS_ADVERTISED_HOST="$NODE_ADDRESS" MOSS_CONTROL_NAMESPACE=moss-control-fixture \
  MOSS_K8S_NAMESPACE=moss-sessions-fixture INSTALL_GVISOR=0 MOSS_K8S_RUNTIME_CLASS='' \
  K3S_MIRROR=off REGISTRY_MIRROR=off MOSS_DOWNLOAD_BASE=http://127.0.0.1:18483 \
  ANTHROPIC_BASE_URL="http://$NODE_ADDRESS:18484/v1" ANTHROPIC_API_KEY=fixture-key \
  bash "$DIST_DIR/install.sh" > "$EVIDENCE/install.log" 2>&1
! sudo systemctl is-active --quiet moss-server.service
! sudo test -f /etc/systemd/system/moss-server.service
sudo k3s kubectl -n moss-control-fixture get deployment moss-server -o json > "$EVIDENCE/deployment.json"
python3 - "$EVIDENCE/deployment.json" <<'PY'
import json, sys
spec = json.load(open(sys.argv[1]))['spec']
assert spec['replicas'] == 1 and spec['strategy']['type'] == 'Recreate'
containers = spec['template']['spec']['containers']
assert len(containers) == 2 and containers[0]['image'] != containers[1]['image']
PY
node "$ROOT_DIR/scripts/e2e/server-release-smoke.mjs" --base-url "http://127.0.0.1:$PORT" \
  --username e2e-admin --password fixture-password --runtimes k8s --keep-sessions --output-dir "$EVIDENCE/session-before-restart"
session_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtimes"][0]["sessionId"])' "$EVIDENCE/session-before-restart/e2e-summary.json")"
session_pod_before="$(sudo k3s kubectl -n moss-sessions-fixture get pods -l "moss.sudo.dev/session-id=$session_id" -o jsonpath='{.items[0].metadata.uid}')"
[ -n "$session_pod_before" ]
control_before="$(sudo k3s kubectl -n moss-control-fixture get pods -l app=moss-server -o jsonpath='{.items[0].metadata.uid}')"
sudo k3s kubectl -n moss-sessions-fixture get pods -l "moss.sudo.dev/session-id=$session_id" -o json > "$EVIDENCE/session-pod-before-restart.json"
master_before="$(sudo sha256sum "$INSTALL_DIR/.moss/nexus/data/vault/master.key" | awk '{print $1}')"
sudo "$INSTALL_DIR/restart.sh" > "$EVIDENCE/restart.log" 2>&1
master_after="$(sudo sha256sum "$INSTALL_DIR/.moss/nexus/data/vault/master.key" | awk '{print $1}')"
[ "$master_before" = "$master_after" ]
control_after="$(sudo k3s kubectl -n moss-control-fixture get pods -l app=moss-server -o jsonpath='{.items[0].metadata.uid}')"
[ -n "$control_after" ] && [ "$control_before" != "$control_after" ]
session_pod_after="$(sudo k3s kubectl -n moss-sessions-fixture get pods -l "moss.sudo.dev/session-id=$session_id" -o jsonpath='{.items[0].metadata.uid}')"
[ "$session_pod_before" = "$session_pod_after" ]
sudo k3s kubectl -n moss-sessions-fixture get pods -l "moss.sudo.dev/session-id=$session_id" -o json > "$EVIDENCE/session-pod-after-restart.json"
node "$ROOT_DIR/scripts/e2e/server-release-smoke.mjs" --base-url "http://127.0.0.1:$PORT" \
  --username e2e-admin --password fixture-password --runtimes k8s --output-dir "$EVIDENCE/session-after-restart" \
  --resume-from "$EVIDENCE/session-before-restart/e2e-summary.json"
before="$(sudo k3s kubectl -n moss-control-fixture get pods -l app=moss-server -o jsonpath='{.items[0].metadata.uid}')"
sudo env MOSS_INSTALL_DIR="$INSTALL_DIR" bash "$DIST_DIR/install.sh" --offline > "$EVIDENCE/repeat.log" 2>&1
after="$(sudo k3s kubectl -n moss-control-fixture get pods -l app=moss-server -o jsonpath='{.items[0].metadata.uid}')"
[ "$before" = "$after" ]
grep -Fq 'already installed; no downloads needed' "$EVIDENCE/repeat.log"
# Removing the workload keeps its PVC/data. Reinstall entirely from archives,
# using the already provisioned cluster, and verify the original vault key.
sudo "$INSTALL_DIR/uninstall.sh"
sudo env MOSS_NON_INTERACTIVE=1 MOSS_INSTALL_DIR="$INSTALL_DIR" MOSS_K8S_RUNTIME_CLASS='' \
  bash "$DIST_DIR/install.sh" --offline > "$EVIDENCE/offline-reinstall.log" 2>&1
[ "$master_before" = "$(sudo sha256sum "$INSTALL_DIR/.moss/nexus/data/vault/master.key" | awk '{print $1}')" ]
curl -fsS "http://127.0.0.1:$PORT/readyz" > "$EVIDENCE/readiness.json"
printf '%s\n' '{"status":"passed","separate_images":true,"real_k8s_session":true,"restart":true,"same_session_resumed":true,"session_pod_retained_during_restart":true,"offline_reinstall":true,"vault_key_preserved":true,"systemd_business_service":false}' > "$EVIDENCE/acceptance.json"
