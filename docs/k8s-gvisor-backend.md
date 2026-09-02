# K8s (gvisor pod) SessionBackend — wire + deploy guide

`K8sBackend` (`src/server/backends/k8sBackend.ts`) runs each session's `scode`
inside a **gvisor-isolated pod** on a **k3s** cluster, instead of a local
subprocess (`ScodeBackend`) or a local docker container (`DockerBackend`). It
plugs into the same `SessionBackend` seam and is selected by
`runtime.type === 'k8s'`.

## Topology: moss and the kubelet are on DIFFERENT hosts

This backend targets the real deployment: **moss (control plane) runs on one
box; k3s + gvisor (compute) runs on a separate node.** The pod's filesystem is
the *compute node's*, never moss's. That single fact drives every config
choice below — anything moss writes to its own disk is invisible to the pod, so
config must reach the pod through the k8s API, not through shared paths.

## How config reaches a (remote) pod

| What | Mechanism | In-pod mount path | Why |
|------|-----------|-------------------|-----|
| `sudocode.json` (proxy auth token + preloaded models) | per-session **Secret** `scode-cfg-<sid>`, read-only | `$SUDO_CODE_CONFIG_HOME/sudocode.json` | carries the sudorouter auth token → must be a Secret, and must cross the node boundary |
| `settings.json` (MCP + sandbox) | same **Secret** | `$SUDO_CODE_CONFIG_HOME/settings.json` | same |
| enabled-skill `SKILL.md` | same **Secret** | `$cwd/.nexus/sudocode/skills/<name>/SKILL.md` | scode discovers skills here; hostPath symlinks would dangle on the remote node |
| HOME / `CLAUDE_CONFIG_DIR` | **emptyDir** | `$HOME` (= `configDir`) | pod-local, writable; scode writes memory/state here |
| workspace / cwd | **emptyDir** | `$cwd` (= session workspace path) | scode writes results here; moss reads them back over the ACP stream, and the transcript is written **moss-side** by `acpBridge`, so the workspace is legitimately pod-local |
| `SUDO_CODE_CONFIG_HOME` dir | **emptyDir** + Secret files layered on top | `configDir/.nexus/sudocode` | writable dir so scode can create state; the two config files arrive read-only via the Secret |
| **scode binary** | **hostPath** (node-local, `type: File`) | `MOSS_K8S_SCODE_PATH` (same path in pod) | the binary legitimately lives on the compute node, pre-staged out-of-band per node — this is the ONE thing that stays hostPath |

The path strings (`configDir`, `cwd`, `scodeHomeDir`) double as the in-pod mount
paths, so the env (`HOME`, `SUDO_CODE_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, …) is
unchanged from the docker/host backends — only the *volume source* changed from
hostPath to emptyDir + Secret.

### The Secret is the only auth-carrying channel to the pod

`kubectl apply -f -` a `Secret` (`stringData`, kubectl base64-encodes it) BEFORE
the pod, labelled `app=moss-scode` + `moss.sudo.dev/session-id=<id>` for GC. The
pod mounts each key read-only via `subPath` at the exact path scode reads. On a
1 MiB Secret budget this carries `sudocode.json`, `settings.json`, and the
top-level `SKILL.md` of each enabled skill. (A skill's nested asset tree —
`scripts/`, `references/` — does **not** fit a flat Secret; deliver those by
baking them into the pod image or a PVC in production. Skill sync is best-effort.)

## How it mirrors the docker backend

The ACP bridge is unchanged. `createAcpBridgeHandle` only needs a
`ChildProcess` whose stdin/stdout carry scode's ACP JSON stream. `DockerBackend`
gives it `spawn('docker', ['exec','-i', …])`; `K8sBackend` gives it
`spawn('kubectl', ['exec','-i', pod, '--', scode, 'acp', …])`. A `docker exec`
child and a `kubectl exec` child are interchangeable from acpBridge's point of
view, so **`acpBridge.ts` is reused with no changes.**

Per session:

1. Build the scode config **in memory** (`sudocode.json` with proxy auth +
   preloaded models, `settings.json` with MCP, each enabled skill's `SKILL.md`)
   and pack it into the per-session Secret payload.
2. `kubectl apply` the Secret, then the Pod:
   - `spec.runtimeClassName: gvisor`
   - image = `MOSS_SCODE_IMAGE` (a Linux userland with the node runtime scode
     links against — the scode binary itself comes from the node hostPath mount)
   - `command: ["sleep","infinity"]` (keeps the pod alive so we can exec per turn)
   - `restartPolicy: Never`, `automountServiceAccountToken: false`
   - deterministic names `scode-<sessionId[:12]>` / `scode-cfg-<sessionId[:12]>`
   - labels `app=moss-scode`, `moss.sudo.dev/session-id=<id>` (for GC)
   - **emptyDir** volumes for HOME/config/workspace, the **Secret** mounted
     read-only at the config + skills paths, and a **hostPath** (`type: File`)
     for the node-local scode binary
   - resource limits (`cpuLimit`/`memoryLimit`, default `2` / `4Gi`)
   - the per-session env (ANTHROPIC_*, MOSS_*, SESSION_TOKEN, HOME,
     SUDO_CODE_CONFIG_HOME, …) on the container `env:`. `kubectl exec` inherits
     the container env (containerd behaviour), so this is the k8s analog of
     docker's `-e KEY=VAL`.
3. Wait for pod phase `Running`, then `kubectl exec -i` scode `acp …` and hand
   the child to `createAcpBridgeHandle`. (If the pod never reaches Running, both
   the pod and the Secret are deleted so the auth token doesn't leak.)
4. Teardown (`handle.destroy` / child close): `kubectl delete pod` +
   `kubectl delete secret` (the emptyDir workspace/config go with the pod).
   `gcOrphanedPods(activeSessionIds)` reaps both orphaned pods AND orphaned
   `scode-cfg-*` Secrets.

## scode-in-pod: the binary + the image

Split responsibilities:

- The **scode binary** is a node-local file, `hostPath`-mounted (`type: File`,
  read-only) into the pod at `MOSS_K8S_SCODE_PATH` and exec'd from there. It is
  staged out-of-band per compute node (e.g. `scp` it to `/opt/scode/scode` on
  every node, `chmod +x`). This is the one legitimately node-local artifact.
- The **image** only needs the userland + node runtime the scode build shells
  out to (if the build is not fully static), e.g. `node:22-bookworm-slim`. It
  needs **no baked config** — `sudocode.json` / `settings.json` / skills arrive
  via the Secret, HOME/workspace are emptyDirs.

### Staging the binary per node (option a — used here)

```bash
# on each compute node
sudo mkdir -p /opt/scode
sudo scp scode-linux-<arch> /opt/scode/scode   # release build matching the node arch
sudo chmod +x /opt/scode/scode
# then on moss: MOSS_K8S_SCODE_PATH=/opt/scode/scode
```

### Option b — bake scode into the image (production)

```dockerfile
# Dockerfile.scode-pod
FROM node:22-bookworm-slim
COPY scode /usr/local/bin/scode
RUN chmod +x /usr/local/bin/scode
ENTRYPOINT []
```

```bash
docker build -f Dockerfile.scode-pod -t moss/scode-pod:dev .
docker save moss/scode-pod:dev | sudo k3s ctr images import -   # per node, or a registry
# then set MOSS_K8S_SCODE_PATH=/usr/local/bin/scode (points at the baked binary)
```

With option (b) the hostPath File mount just shadows the baked binary with the
same path; either way scode is exec'd from `MOSS_K8S_SCODE_PATH`.

## Register the gvisor RuntimeClass on k3s

k3s ships containerd; add the runsc (gvisor) runtime, then a RuntimeClass.

```bash
# 1. install runsc on the node
( set -e; URL=https://storage.googleapis.com/gvisor/releases/release/latest/$(uname -m)
  wget ${URL}/runsc ${URL}/containerd-shim-runsc-v1
  chmod +x runsc containerd-shim-runsc-v1
  sudo mv runsc containerd-shim-runsc-v1 /usr/local/bin/ )

# 2. tell k3s' containerd about the runsc runtime (k3s merges *.toml.tmpl)
sudo tee /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl >/dev/null <<'EOF'
{{ template "base" . }}
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
EOF
sudo systemctl restart k3s
```

```yaml
# 3. RuntimeClass (kubectl apply -f -)
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
```

Secret volume mounts and the node-local `hostPath` File mount both work under
gvisor (runsc gofer), so the config delivery above is sandbox-compatible.

## Wiring moss to the k3s node

### kubeconfig

moss runs **off** the k3s node, so point it at the node's reachable API server:

```bash
sudo cp /etc/rancher/k3s/k3s.yaml ~/.moss/k3s-kubeconfig.yaml
sudo chown $USER ~/.moss/k3s-kubeconfig.yaml
# k3s.yaml points at https://127.0.0.1:6443 — rewrite to the node's reachable IP:
sed -i 's#https://127.0.0.1:6443#https://<NODE_IP>:6443#' ~/.moss/k3s-kubeconfig.yaml
```

Point moss at it with `MOSS_K8S_KUBECONFIG=~/.moss/k3s-kubeconfig.yaml`.
`kubectl` must be on moss's `PATH`.

### RBAC (least privilege)

`K8sBackend` needs `create/get/list/delete pods`, `create/delete secrets`, and
`create pods/exec` in the target namespace:

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: moss-sessions }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: moss-runner, namespace: moss-sessions }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: moss-scode-pods, namespace: moss-sessions }
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
metadata: { name: moss-scode-pods, namespace: moss-sessions }
subjects:
  - kind: ServiceAccount
    name: moss-runner
    namespace: moss-sessions
roleRef:
  kind: Role
  name: moss-scode-pods
  apiGroup: rbac.authorization.k8s.io
```

Use a kubeconfig scoped to this ServiceAccount (or the admin k3s.yaml for the
PoC), and set `MOSS_K8S_NAMESPACE=moss-sessions`.

### Env / config knobs on moss

| Env | server.json (`k8s.*`) | Default | Meaning |
|-----|-----------------------|---------|---------|
| `MOSS_SCODE_IMAGE` | `image` | (required) | pod image (userland + node runtime) |
| `MOSS_K8S_NAMESPACE` | `namespace` | `default` | namespace for session pods + Secrets |
| `MOSS_K8S_RUNTIME_CLASS` | `runtimeClassName` | `gvisor` | RuntimeClass name |
| `MOSS_K8S_KUBECONFIG` | `kubeconfig` | in-cluster / `~/.kube/config` | kubeconfig path |
| `MOSS_K8S_SCODE_PATH` | `scodePath` | `/usr/local/bin/scode` | **compute-node** scode path, hostPath-mounted into the pod at the same path |
| `MOSS_K8S_POD_READY_TIMEOUT_SEC` | `podReadyTimeoutSec` | `90` | wait-for-Running timeout |
| — | `cpuLimit` / `memoryLimit` | `2` / `4Gi` | pod resource limits |
| — | `labels` | `{}` | extra pod + Secret labels |

To make **every** session use the pod backend, set the default runtime in
`~/.nexus/sudocode/server/server.json`:

```jsonc
{
  "runtimeDefaults": { "type": "k8s", "engine": "scode" },
  "k8s": {
    "image": "docker.io/library/node:22-bookworm-slim",
    "namespace": "moss-sessions",
    "runtimeClassName": "gvisor",
    "kubeconfig": "~/.moss/k3s-kubeconfig.yaml",
    "scodePath": "/opt/scode/scode"
  }
}
```

`host` and `docker` behaviour is unchanged; k8s is only used when selected.

## Driving the e2e

`runtime.type` is chosen per session (falls back to `runtimeDefaults.type`).

- **Per session via the connect API** — POST the session-create request with
  `runtime: { type: "k8s" }` (same field docker uses with `type: "docker"`).
  The image/namespace/runtimeClass/kubeconfig resolve from `config.k8s` unless
  overridden per request (`k8sImage`, `k8sNamespace`, `k8sRuntimeClassName`,
  `k8sScodePath`, `k8sMode`).
- **Globally** — set `runtimeDefaults.type: "k8s"` (above); every new session
  routes to `K8sBackend`.

Verify:

```bash
kubectl -n moss-sessions get pods -l app=moss-scode      # scode-<sid> Running
kubectl -n moss-sessions get secret scode-cfg-<sid>      # the config Secret
kubectl -n moss-sessions get pod scode-<sid> -o jsonpath='{.spec.runtimeClassName}'  # gvisor
# scode reads its config out of the mounted Secret:
kubectl -n moss-sessions exec scode-<sid> -- cat "$SUDO_CODE_CONFIG_HOME/sudocode.json" | head
# send a turn; scode's ACP stream flows back over the moss WS unchanged.
# on session end BOTH the pod and its Secret are deleted:
kubectl -n moss-sessions get pods,secrets -l app=moss-scode      # gone
```

Reap orphans (e.g. on server startup / a timer) — deletes orphaned pods AND
`scode-cfg-*` Secrets:

```ts
import { gcOrphanedPods } from './backends/k8sBackend.js'
await gcOrphanedPods(activeSessionIds, { namespace, kubeconfig })
```

## Security / hardening notes (PoC → prod)

- **Secret vs hostPath.** The auth-carrying config now travels as a per-session
  Secret mounted read-only, so it reaches the remote pod correctly and is not
  written to any node's disk as a plaintext hostPath file. The Secret is deleted
  with the pod and reaped by `gcOrphanedPods`.
- **Auth token also on `env:`.** For parity with the docker/host backends the
  proxy token is still present on the container `env:` (`ANTHROPIC_API_KEY` etc.,
  visible via `kubectl get pod -o yaml`). scode's `--auth proxy` reads the token
  from the Secret's `sudocode.json`; dropping it from `env:` (relying solely on
  the Secret, or injecting through the auth-proxy) is a further hardening step.
- **hostPath is now binary-only.** The only hostPath left is the read-only scode
  binary (`type: File`), a node-local pre-staged artifact. No session config,
  workspace, or moss-server app dir is exposed to the pod.
- **Skill assets.** Only top-level `SKILL.md` files fit the flat Secret; skills
  needing nested assets should be baked into the image or delivered via a PVC.
- **`@kubernetes/client-node` upgrade.** The PoC shells out to `kubectl` (no new
  dependency, mirrors docker's `spawn` model so acpBridge is reused unchanged).
  The production upgrade is `@kubernetes/client-node`: `CoreV1Api` for
  pod/secret CRUD + GC and the `Exec` WebSocket API for the ACP stream (wrap its
  streams in a small `ChildProcess`-shaped adapter to keep `acpBridge`
  unchanged). Swap only the helper functions in `k8sBackend.ts`; the seam is
  identical.
