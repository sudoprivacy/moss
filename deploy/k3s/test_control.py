import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("moss_control", HERE / "control.py")
control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control)


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "install"
        self.root.mkdir()
        self.bundle = self.base / "bundle"
        self.bundle.mkdir()
        shutil.copy(HERE.parent / "server.json", self.bundle / "server.json")
        self.environment = patch.dict(os.environ, {
            "MOSS_ADVERTISED_HOST": "127.0.0.1", "MOSS_ADMIN_USERNAME": "fixture",
            "MOSS_ADMIN_PASSWORD": "quote'\" and $(never-run)", "MOSS_K8S_RUNTIME_CLASS": "",
        }, clear=True)
        self.environment.start()
        self.script_path = patch.object(control, "__file__", str(self.bundle / "control.py"))
        self.script_path.start()

    def tearDown(self):
        self.script_path.stop()
        self.environment.stop()
        self.temp.cleanup()

    def render(self, version="1.0"):
        output = self.root / "releases" / version
        control.render(self.root, output, version, "fixture-node")
        return output

    def installed_fixture(self):
        release = self.render()
        for name in ("server.json", "server-env.json", "kubeconfig.json"):
            shutil.copy(release / name, self.root / name)
        shutil.copy(release / "state.json", self.root / "k8s-install.json")
        (self.root / "current").symlink_to(release)
        (self.root / "data").mkdir()
        (self.root / "data/moss.db").write_bytes(b"old-database")
        (self.root / ".moss/nexus/data/vault").mkdir(parents=True)
        (self.root / ".moss/nexus/data/vault/master.key").write_bytes(b"original-master-key")
        control.write_json(self.root / ".moss/settings.json", {"env": {"custom": "retained"}})
        return release

    def test_separate_images_share_paths_and_projected_credentials(self):
        output = self.render()
        items = control.read_json(output / "manifest.json")["items"]
        deployment = next(item for item in items if item["kind"] == "Deployment")
        spec = deployment["spec"]
        self.assertEqual(spec["replicas"], 1)
        self.assertEqual(spec["strategy"], {"type": "Recreate"})
        pod = spec["template"]["spec"]
        self.assertEqual(pod["terminationGracePeriodSeconds"], 45)
        self.assertEqual(pod["serviceAccountName"], "moss-controller")
        nexus, server = pod["containers"]
        self.assertNotEqual(nexus["image"], server["image"])
        for container in (nexus, server):
            self.assertEqual(container["volumeMounts"][0]["mountPath"], str(self.root))
            self.assertNotIn("terminationGracePeriodSeconds", container)
        self.assertEqual(nexus["args"][0], "serve-local")
        service = next(item for item in items if item["kind"] == "Service")
        self.assertNotIn(2126, [p["port"] for p in service["spec"]["ports"]])
        kubeconfig = control.read_json(output / "kubeconfig.json")
        self.assertIn("tokenFile", kubeconfig["users"][0]["user"])
        role = next(item for item in items if item["kind"] == "Role")
        self.assertTrue(any("pods/exec" in rule["resources"] for rule in role["rules"]))
        config = control.read_json(output / "server.json")
        self.assertEqual(config["bootstrapAdmin"]["password"], os.environ["MOSS_ADMIN_PASSWORD"])
        self.assertEqual(config["k8s"]["runtimeClassName"], "")
        self.assertEqual(config["k8s"]["workspaceStorageClass"], "local-path")
        self.assertEqual(config["runtimeDefaults"]["type"], "k8s")

    def test_arm64_manifest_and_upgrade_preserve_architecture(self):
        output = self.root / "releases/arm-first"
        control.render(self.root, output, "1.0", "fixture-node", "arm64")
        state = control.read_json(output / "state.json")
        self.assertEqual(state["architecture"], "arm64")
        manifest = control.read_json(output / "manifest.json")
        deployment = next(item for item in manifest["items"] if item["kind"] == "Deployment")
        self.assertEqual([c["image"] for c in deployment["spec"]["template"]["spec"]["containers"]],
                         ["docker.io/library/moss-nexus:1.0-arm64", "docker.io/library/moss-server:1.0-arm64"])
        shutil.copy(output / "state.json", self.root / "k8s-install.json")
        (self.root / "current").symlink_to(output)
        with patch.object(control, "kube"), patch.object(control, "stop"):
            control.manage(self.root, "restart", [])
        restarted = control.read_json(output / "manifest.json")
        self.assertEqual(restarted, manifest)
        control.render(self.root, self.root / "releases/arm-next", "2.0", "fixture-node", "arm64")
        with self.assertRaisesRegex(ValueError, "architecture"):
            self.render("3.0")

    def test_offline_compute_refuses_missing_assets_before_network_or_mutation(self):
        source = (HERE.parent / "install.sh").read_text()
        function = source.split("provision_compute_node() {", 1)[1].split('\nif [ "$ROLE" = compute ]; then', 1)[0]
        script = self.base / "offline-check.sh"
        script.write_text('''#!/usr/bin/env bash
set -Eeuo pipefail
log() { :; }
die() { echo "$*" >&2; exit 1; }
command() { [ "$*" != '-v k3s' ] && builtin command "$@"; }
curl() { echo 'NETWORK_MUST_NOT_RUN' >&2; exit 99; }
INSTALL_DIR="$1"
OFFLINE_DIR="$1/missing-offline"
OFFLINE_MODE=on
provision_compute_node() {''' + function + '\nprovision_compute_node\n')
        result = subprocess.run(["bash", str(script), str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("OFFLINE_MODE=on but " + str(self.root / "missing-offline"), result.stderr)
        self.assertNotIn("NETWORK_MUST_NOT_RUN", result.stderr)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_upgrade_preserves_credentials_paths_and_settings(self):
        self.installed_fixture()
        output = self.render("2.0")
        config = control.read_json(output / "server.json")
        self.assertEqual(config["bootstrapAdmin"]["username"], "fixture")
        self.assertEqual(config["storage"]["dbPath"], str(self.root / "data/moss.db"))
        self.assertIn(":2.0-amd64", config["k8s"]["image"])
        self.assertEqual(control.read_json(output / "settings.json"), {"env": {"custom": "retained"}})

    def test_rejects_unknown_migration_before_touching_data(self):
        self.installed_fixture()
        lock = self.root / ".moss/nexus/data.zone-id.lock.json"
        lock.write_text('{"version":1,"zoneId":"tenant"}')
        original = lock.read_bytes()
        with self.assertRaisesRegex(ValueError, "ZoneId-bound"):
            self.render("2.0")
        self.assertEqual(lock.read_bytes(), original)
        lock.unlink()
        (self.root / "k8s-install.json").unlink()
        (self.root / "moss-server.env").write_text("MOSS_NEXUS_MODE=external\n")
        with self.assertRaisesRegex(ValueError, "external Nexus"):
            self.render("2.0")
        (self.root / "moss-server.env").unlink()
        config = control.read_json(self.root / "server.json")
        config["storage"]["dbPath"] = "/outside/moss.db"
        control.write_json(self.root / "server.json", config)
        with self.assertRaisesRegex(ValueError, "outside"):
            self.render("2.0")

    @unittest.skipIf(os.name == "nt", "POSIX installer")
    def test_failed_rollout_restores_quiescent_snapshot_and_previous_manifest(self):
        previous = self.installed_fixture()
        original_config = (self.root / "server.json").read_bytes()
        work = self.base / "work"
        (work / "bundle").mkdir(parents=True)
        for source in (HERE / "control.py", HERE.parent / "server.json"):
            shutil.copy(source, work / "bundle" / source.name)
        fake_bin = self.base / "bin"
        fake_bin.mkdir()
        # The fixture emulates the Kubernetes API boundary, including a newer
        # process writing its database before readiness fails. It never calls a
        # real cluster, systemd, containerd or network endpoint.
        fake_k3s = fake_bin / "k3s"
        fake_k3s.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
args = sys.argv[1:]
with open(root.parent / 'calls.log', 'a') as stream: stream.write(' '.join(args) + '\\n')
if args[:3] == ['ctr','images','import']:
    sys.stdin.read()
elif args[:3] == ['ctr','images','ls']:
    print('docker.io/library/moss-server:2.0-amd64\\ndocker.io/library/moss-nexus:2.0-amd64\\ndocker.io/library/my-moss-runtime:2.0-amd64')
elif 'nodes' in args:
    print(json.dumps({'items':[{'metadata':{'labels':{'kubernetes.io/hostname':'fixture-node'}},'status':{'addresses':[{'address':'127.0.0.1'}]}}]}))
elif 'get' in args and 'deployment' in args and 'name' in args:
    print('deployment.apps/moss-server')
elif '--dry-run=client' in args:
    print('{}')
elif 'apply' in args and '-f' in args and args[args.index('-f')+1] == '-':
    sys.stdin.read()
elif 'apply' in args and '--dry-run=server' not in args:
    manifest = pathlib.Path(args[args.index('-f')+1])
    if 'work' in str(manifest):
        (root / 'data/moss.db').write_bytes(b'new-database')
        (root / '.moss/nexus/data/vault/master.key').write_bytes(b'new-master-key')
elif 'rollout' in args:
    marker = root.parent / 'failed-once'
    if not marker.exists():
        marker.touch()
        sys.exit(7)
""")
        fake_k3s.chmod(0o755)
        for name, body in (("gzip", "exit 0"), ("systemctl", "exit 1")):
            path = fake_bin / name
            path.write_text("#!/bin/sh\n" + body + "\n")
            path.chmod(0o755)
        env = {**os.environ, "PATH": str(fake_bin) + os.pathsep + os.defpath,
               "FIXTURE_ROOT": str(self.root), "INSTALL_DIR": str(self.root), "WORK_DIR": str(work),
               "ROLE": "control-plane", "ARCH": "amd64", "VERSION": "2.0", "RELEASE_TAG": "server-v2.0",
               "SOURCE_DIR": str(self.base), "SERVER_IMAGE_ARCHIVE": "server.tar.gz",
               "NEXUS_IMAGE_ARCHIVE": "nexus.tar.gz", "RUNTIME_ARCHIVE": "runtime.tar.gz", "NODE_IP": "127.0.0.1"}
        # macOS may not expose python3 through os.defpath.
        env["PATH"] += os.pathsep + str(Path(shutil.which("python3")).parent)
        script = '\n'.join([
            'log() { :; }; warn() { echo "$*" >&2; }; die() { echo "$*" >&2; exit 1; }',
            'acquire_asset() { :; }',
            'source "$1"',
        ])
        result = subprocess.run(["bash", "-c", script, "fixture", str(HERE / "install-control.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertEqual((self.root / "data/moss.db").read_bytes(), b"old-database")
        self.assertEqual((self.root / ".moss/nexus/data/vault/master.key").read_bytes(), b"original-master-key")
        self.assertEqual((self.root / "server.json").read_bytes(), original_config)
        self.assertEqual((self.root / "current").resolve(), previous)
        self.assertEqual(control.read_json(self.root / "k8s-install.json")["version"], "1.0")
        self.assertTrue(list(self.root.glob("backups/*/failed/data/moss.db")))
        calls = (self.base / "calls.log").read_text()
        self.assertIn("--replicas=0", calls)
        self.assertIn("backups/", calls)


if __name__ == "__main__":
    unittest.main()
