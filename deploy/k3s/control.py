#!/usr/bin/env python3
"""Render the single-writer installation and manage it without a host daemon.

JSON is a Kubernetes manifest format; no PyYAML or host Node installation is
needed. Paths and credentials are always encoded as data, never shell code.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import urllib.request


def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def checked_root(value):
    path = Path(value)
    if not path.is_absolute() or path == Path("/") or path.resolve() != path:
        raise ValueError("install directory must be an absolute, non-symlink path below /")
    return path


def legacy_env(root):
    result = {}
    path = root / "moss-server.env"
    if not path.exists():
        return result
    # The legacy installer emitted simple assignments and single-quoted ZoneId.
    # Refuse unfamiliar syntax instead of executing it as shell or losing values.
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("unsupported legacy EnvironmentFile assignment")
        if value.endswith("\\"):
            raise ValueError("multiline legacy EnvironmentFile needs manual migration")
        if value.startswith(("'", '"')):
            words = shlex.split(value)
            if len(words) != 1:
                raise ValueError("unsupported legacy EnvironmentFile quoting")
            value = words[0]
        result[key] = value
    return result


def preflight(root):
    state = read_json(root / "k8s-install.json")
    env = read_json(root / "server-env.json", {}) if state else legacy_env(root)
    if (root / ".moss/nexus/data.zone-id.lock.json").exists() or "MOSS_NEXUS_ZONE_ID" in env or "MOSS_NEXUS_ZONE_ID" in os.environ:
        raise ValueError("ZoneId-bound Nexus requires a separate topology migration; its data and lock have not been changed")
    if not state and (env.get("MOSS_NEXUS_MODE") == "external" or env.get("MOSS_COHOST_NEXUS_MODE") == "external"):
        raise ValueError("external Nexus installation requires an explicit data/certificate migration; existing services have not been stopped")
    config = read_json(root / "server.json", {})
    # A local PV preserves the old absolute paths. Unknown external disks must
    # not silently turn into empty directories in a container.
    for key, value in config.get("storage", {}).items():
        if isinstance(value, str) and (key.endswith("Dir") or key.endswith("Path")):
            if value.startswith("/") and not Path(value).resolve().is_relative_to(root):
                raise ValueError(f"storage.{key} is outside the installation; migrate that volume explicitly first")
    workspace = config.get("runtimeDefaults", {}).get("workspace")
    if workspace and not Path(workspace).resolve().is_relative_to(root):
        raise ValueError("runtime workspace is outside the installation; migrate that volume explicitly first")
    for key in ("HOME", "MOSS_HOME"):
        if env.get(key) and not Path(env[key]).resolve().is_relative_to(root):
            raise ValueError(f"custom {key} is outside the installation; migrate it explicitly first")
    return state, env, config


def dns_name(value):
    if len(value) > 63 or not re.fullmatch(r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?", value):
        raise ValueError("invalid Kubernetes namespace: " + value)
    return value


def render(root, output, version, node, architecture="amd64"):
    if architecture not in ("amd64", "arm64"):
        raise ValueError("Unsupported image architecture: " + architecture)
    previous, env, existing = preflight(root)
    previous = previous or {}
    if previous and previous.get("architecture", "amd64") != architecture:
        raise ValueError("Cannot change the architecture of an existing installation")
    namespace = dns_name(previous.get("namespace", os.environ.get("MOSS_CONTROL_NAMESPACE", "moss-control")))
    sessions = dns_name(previous.get("sessions", os.environ.get("MOSS_K8S_NAMESPACE", "moss-sessions")))
    if namespace == sessions:
        raise ValueError("control and session namespaces must be different")
    node = previous.get("node", node)
    if not node:
        raise ValueError("a control node is required")
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._-]*", version):
        raise ValueError("invalid release version")
    config = existing or read_json(Path(__file__).with_name("server.json"))
    if not config:
        raise ValueError("deployment bundle is missing server.json")
    config = json.loads(json.dumps(config))
    port = int(config.get("server", {}).get("port", 43127)) if existing else int(os.environ.get("MOSS_PORT", "43127"))
    if not 1 <= port <= 65535 or port in (2126, 12013):
        raise ValueError("invalid or reserved Moss port")
    host = config.get("server", {}).get("advertisedHost") if existing else os.environ.get("MOSS_ADVERTISED_HOST")
    if not host or host == "0.0.0.0":
        raise ValueError("MOSS_ADVERTISED_HOST must be an address reachable by browsers")
    config["server"] = {**config.get("server", {}), "host": "0.0.0.0", "port": port, "advertisedHost": host}
    config["server"].setdefault("publicBaseUrl", "")
    if not config["server"]["publicBaseUrl"]:
        config["server"]["publicBaseUrl"] = f"http://{host}:{port}"
    if not existing:
        password = os.environ.get("MOSS_ADMIN_PASSWORD", "")
        if not password:
            raise ValueError("administrator password must be generated before rendering")
        config["bootstrapAdmin"] = {"username": os.environ.get("MOSS_ADMIN_USERNAME", "admin"), "password": password}
        config["storage"] = {key: str(root / value) for key, value in {
            "rootDir": "data", "dbPath": "data/moss.db", "transcriptDir": "data/transcripts", "runtimeDir": "data/runtime"}.items()}
    config["runtimeDefaults"] = {**config.get("runtimeDefaults", {}), "type": "k8s"}
    config["k8s"] = {**config.get("k8s", {}), "namespace": sessions,
        "kubeconfig": str(root / "kubeconfig.json"),
        "image": f"docker.io/library/my-moss-runtime:{version}-{architecture}"}
    config["k8s"]["runtimeClassName"] = os.environ.get("MOSS_K8S_RUNTIME_CLASS", config["k8s"].get("runtimeClassName", "gvisor"))
    # Persist workspaces by default, while retaining the old installation's
    # explicit storage class. k3s ships the local-path provisioner.
    config["k8s"].setdefault("workspaceStorageClass", "local-path")
    config["k8s"].setdefault("workspaceStorageSize", "10Gi")
    fqdn = f"moss-server.{namespace}.svc.cluster.local"
    env.update({"HOME": str(root), "MOSS_HOME": str(root / ".moss"),
        "MOSS_SERVER_CONFIG": "/etc/moss/server.json", "MOSS_MODELS_DIR": "/app/models",
        "MOSS_NODE_PATH": "/usr/local/bin/node", "PATH": "/app/bin:/usr/local/bin:/usr/bin:/bin",
        "MOSS_DEFAULT_RUNTIME": "k8s", "MOSS_NEXUS_MODE": "external",
        "MOSS_NEXUS_ENDPOINT": "http://127.0.0.1:2126", "MOSS_AUTH_PROXY_HOST": "0.0.0.0",
        "MOSS_AUTH_PROXY_URL": f"http://{fqdn}:12013", "MOSS_SERVER_URL": f"http://{fqdn}:{port}",
        "MOSS_K8S_KUBECONFIG": str(root / "kubeconfig.json"), "MOSS_SHUTDOWN_GRACE_MS": "30000"})
    for key in ("MOSS_NEXUS_TLS_CA", "MOSS_NEXUS_TLS_CERT", "MOSS_NEXUS_TLS_KEY", "MOSS_NEXUS_AUTH_TOKEN"):
        env.pop(key, None)
    env.setdefault("MOSS_INSTANCE_ID", "moss-server")
    settings = read_json(root / ".moss/settings.json", {})
    if not existing:
        settings.setdefault("env", {})["ANTHROPIC_BASE_URL"] = os.environ.get("ANTHROPIC_BASE_URL", "https://hk.sudorouter.ai/v1")
    token_dir = "/var/run/secrets/kubernetes.io/serviceaccount"
    kubeconfig = {"apiVersion": "v1", "kind": "Config", "current-context": "sessions",
        "clusters": [{"name": "cluster", "cluster": {"server": "https://kubernetes.default.svc",
            "certificate-authority": token_dir + "/ca.crt"}}],
        "users": [{"name": "runner", "user": {"tokenFile": token_dir + "/token"}}],
        "contexts": [{"name": "sessions", "context": {"cluster": "cluster", "user": "runner", "namespace": sessions}}]}
    state = {"version": version, "architecture": architecture, "namespace": namespace, "sessions": sessions, "node": node, "port": port, "root": str(root)}
    output.mkdir(parents=True, exist_ok=True)
    for name, value in (("server.json", config), ("server-env.json", env), ("settings.json", settings),
                        ("kubeconfig.json", kubeconfig), ("state.json", state)):
        write_json(output / name, value)
    write_json(output / "manifest.json", manifest(root, state, config, env))


def manifest(root, state, config, env):
    ns, sessions, version = state["namespace"], state["sessions"], state["version"]
    architecture = state.get("architecture", "amd64")
    owner = hashlib.sha256(str(root).encode()).hexdigest()[:12]
    labels = {"app": "moss-server", "app.kubernetes.io/managed-by": "moss-install"}
    annotations = {"moss.sudo.dev/install-root": str(root)}
    def resource(kind, name, spec=None, namespace=ns, api="v1", **fields):
        meta = {"name": name, "labels": labels, "annotations": annotations}
        if namespace:
            meta["namespace"] = namespace
        return {"apiVersion": api, "kind": kind, "metadata": meta, **({"spec": spec} if spec is not None else {}), **fields}
    volume = {"name": "data", "mountPath": str(root)}
    probe = {"exec": {"command": ["node", "-e", "const s=require('net').connect(2126,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)"]}, "timeoutSeconds": 3, "periodSeconds": 5}
    containers = [
        {"name": "nexus", "image": f"docker.io/library/moss-nexus:{version}-{architecture}", "imagePullPolicy": "IfNotPresent",
         "args": ["serve-local", "--port", "2126", "--no-tls", "--data-dir", str(root / ".moss/nexus/data"), "--plugin-dir", "/app/bin/nexus/plugins"],
         "env": [{"name": "NEXUS_DATA_DIR", "value": str(root / ".moss/nexus/data")}], "volumeMounts": [volume],
         "startupProbe": {**probe, "failureThreshold": 60}, "readinessProbe": probe,
         "resources": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"memory": "2Gi"}}},
        {"name": "server", "image": f"docker.io/library/moss-server:{version}-{architecture}", "imagePullPolicy": "IfNotPresent",
         "envFrom": [{"secretRef": {"name": "moss-server-env"}}],
         "ports": [{"name": "http", "containerPort": state["port"], "hostPort": state["port"]},
                   {"name": "auth-proxy", "containerPort": 12013}],
         "volumeMounts": [volume, {"name": "config", "mountPath": "/etc/moss", "readOnly": True}],
         "startupProbe": {"httpGet": {"path": "/healthz", "port": "http"}, "periodSeconds": 2, "failureThreshold": 90},
         "readinessProbe": {"httpGet": {"path": "/readyz", "port": "http"}, "timeoutSeconds": 3, "periodSeconds": 5},
         "livenessProbe": {"httpGet": {"path": "/healthz", "port": "http"}, "timeoutSeconds": 3, "periodSeconds": 15},
         "resources": {"requests": {"cpu": "250m", "memory": "512Mi"}, "limits": {"memory": "4Gi"}}}]
    pv_name = "moss-control-" + owner
    return {"apiVersion": "v1", "kind": "List", "items": [
        resource("Namespace", ns, namespace=None), resource("Namespace", sessions, namespace=None),
        resource("ServiceAccount", "moss-controller"),
        resource("Role", "moss-controller", namespace=sessions, api="rbac.authorization.k8s.io/v1", rules=[
            {"apiGroups": [""], "resources": ["pods", "secrets"], "verbs": ["get", "list", "watch", "create", "patch", "delete"]},
            {"apiGroups": [""], "resources": ["services"], "verbs": ["get", "create"]},
            {"apiGroups": [""], "resources": ["pods/exec"], "verbs": ["get", "create"]},
            {"apiGroups": [""], "resources": ["persistentvolumeclaims"], "verbs": ["get", "create", "patch"]}]),
        resource("RoleBinding", "moss-controller", namespace=sessions, api="rbac.authorization.k8s.io/v1",
            subjects=[{"kind": "ServiceAccount", "name": "moss-controller", "namespace": ns}],
            roleRef={"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "moss-controller"}),
        resource("PersistentVolume", pv_name, {"capacity": {"storage": "100Gi"}, "accessModes": ["ReadWriteOnce"],
            "persistentVolumeReclaimPolicy": "Retain", "storageClassName": "", "local": {"path": str(root)},
            "claimRef": {"namespace": ns, "name": "moss-data"},
            "nodeAffinity": {"required": {"nodeSelectorTerms": [{"matchExpressions": [
                {"key": "kubernetes.io/hostname", "operator": "In", "values": [state["node"]]}]}]}}}, namespace=None),
        resource("PersistentVolumeClaim", "moss-data", {"accessModes": ["ReadWriteOnce"], "storageClassName": "",
            "volumeName": pv_name, "resources": {"requests": {"storage": "100Gi"}}}),
        resource("Secret", "moss-server-config", type="Opaque", stringData={"server.json": json.dumps(config)}),
        resource("Secret", "moss-server-env", type="Opaque", stringData=env),
        resource("Service", "moss-server", {"selector": {"app": "moss-server"}, "ports": [
            {"name": "http", "port": state["port"], "targetPort": "http"},
            {"name": "auth-proxy", "port": 12013, "targetPort": "auth-proxy"}]}),
        resource("Deployment", "moss-server", {"replicas": 1, "strategy": {"type": "Recreate"},
            "selector": {"matchLabels": {"app": "moss-server"}},
            "template": {"metadata": {"labels": labels, "annotations": {**annotations, "moss.sudo.dev/version": version}},
            "spec": {"serviceAccountName": "moss-controller", "terminationGracePeriodSeconds": 45,
                "nodeSelector": {"kubernetes.io/hostname": state["node"]}, "containers": containers,
                "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "moss-data"}},
                            {"name": "config", "secret": {"secretName": "moss-server-config"}}]}}}, api="apps/v1")
    ]}


def kube(*args, **kwargs):
    return subprocess.run(["k3s", "kubectl", *args], check=True, **kwargs)


def stop(state):
    ns = state["namespace"]
    found = kube("-n", ns, "get", "deployment", "moss-server", "--ignore-not-found", "-o", "name", capture_output=True, text=True)
    if found.stdout.strip():
        kube("-n", ns, "scale", "deployment/moss-server", "--replicas=0")
        kube("-n", ns, "wait", "--for=delete", "pod", "-l", "app=moss-server", "--timeout=180s")


def manage(root, action, extra):
    state = read_json(root / "k8s-install.json")
    if not state:
        raise ValueError("no Kubernetes installation found")
    ns = state["namespace"]
    if action == "stop":
        stop(state)
    elif action in ("start", "restart"):
        render(root, root / "current", state["version"], state["node"], state.get("architecture", "amd64"))
        if action == "restart":
            stop(state)
        kube("apply", "-f", str(root / "current/manifest.json"))
        kube("-n", ns, "rollout", "status", "deployment/moss-server", "--timeout=300s")
    elif action == "status":
        kube("-n", ns, "get", "deployment,pods,pvc,service", "-l", "app=moss-server")
    elif action == "logs":
        container = extra[0] if extra else "server"
        if container not in ("server", "nexus"):
            raise ValueError("logs container must be server or nexus")
        kube("-n", ns, "logs", "deployment/moss-server", "-c", container, "--tail=100", "-f")
    elif action == "uninstall":
        if extra not in ([], ["--purge"]):
            raise ValueError("usage: uninstall.sh [--purge]")
        stop(state)
        kube("-n", state["sessions"], "delete", "pods,secrets", "-l", "app=moss-scode", "--ignore-not-found")
        kube("-n", ns, "delete", "deployment,service", "moss-server", "--ignore-not-found")
        kube("-n", ns, "delete", "secret", "moss-server-env", "moss-server-config", "--ignore-not-found")
        kube("-n", state["sessions"], "delete", "role,rolebinding", "moss-controller", "--ignore-not-found")
        kube("-n", ns, "delete", "serviceaccount", "moss-controller", "--ignore-not-found")
        if extra:
            kube("-n", state["sessions"], "delete", "pvc", "-l", "app=moss-scode", "--ignore-not-found")
            kube("-n", ns, "delete", "pvc", "moss-data", "--ignore-not-found")
            owner = hashlib.sha256(str(root).encode()).hexdigest()[:12]
            kube("delete", "pv", "moss-control-" + owner, "--ignore-not-found")
            shutil.rmtree(root)
        else:
            print("Moss stopped and removed from Kubernetes; data retained at", root)
    else:
        raise ValueError("unknown operation: " + action)


def seed(root):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return
    config = read_json(root / "server.json")
    base = f"http://127.0.0.1:{config['server']['port']}"
    def request(path, data, method="POST", token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + path, data=json.dumps(data).encode(), headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    token = request("/api/v1/auth/token", config["bootstrapAdmin"])["access_token"]
    request("/api/v1/settings/system?scope=organization", {"apiKey": key,
        "url": os.environ.get("ANTHROPIC_BASE_URL", "https://hk.sudorouter.ai/v1")}, "PATCH", token)


def main():
    action = sys.argv[1]
    root = checked_root(sys.argv[2])
    if action == "preflight":
        preflight(root)
    elif action == "render":
        render(root, Path(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6] if len(sys.argv) > 6 else "amd64")
    elif action == "seed":
        seed(root)
    else:
        manage(root, action, sys.argv[3:])


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # Exception bodies from HTTP operations can contain secrets; never dump
        # request data or a rendered Secret into diagnostics.
        print("moss-control:", str(error), file=sys.stderr)
        sys.exit(1)
