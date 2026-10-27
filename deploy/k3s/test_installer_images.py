"""Exercise actual installer role dispatch and release-bound image identity without a cluster."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

INSTALLER = Path(__file__).resolve().parent.parent / 'install.sh'


@unittest.skipIf(os.name == 'nt', 'POSIX installer')
class InstallerImageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = INSTALLER.read_text()

    def shell(self, script, **environment):
        return subprocess.run(['bash', '-c', 'set -Eeuo pipefail\n' + script],
                              env={**os.environ, **environment}, capture_output=True, text=True)

    def test_compute_role_retains_verified_release_after_provisioning(self):
        branch = self.source[self.source.index('if [ "$ROLE" = compute ]; then\n'):]
        script = '''
log() { printf '%s\\n' "$*"; }
acquire_asset() { printf 'verified %s\\n' "$1"; }
provision_compute_node() { printf 'provisioned\\n'; }
retain_release_image() { printf 'retained %s\\n' "$1"; }
''' + branch
        result = self.shell(script, ROLE='compute', VERSION='1.2.3', ARCH='arm64', RUNTIME_ARCHIVE='runtime.tar.gz')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['verified runtime.tar.gz', 'provisioned',
                         'retained runtime.tar.gz', 'Compute node ready; session image: docker.io/library/my-moss-runtime:1.2.3-arm64'])

    def test_shared_image_helper_receives_the_release_manifest_checksum(self):
        functions = self.source[self.source.index('release_asset_checksum() {'):self.source.index('\nacquire_asset() {')]
        retain = self.source[self.source.index('retain_release_image() {'):self.source.index('\nread_masked_value() {')]
        bundle = self.root / 'bundle'
        bundle.mkdir()
        recorder = bundle / 'images.py'
        recorder.write_text('import json,sys;print(json.dumps(sys.argv[1:]))\n')
        asset = self.root / 'runtime.tar.gz'
        asset.write_bytes(b'verified runtime fixture')
        digest = hashlib.sha256(asset.read_bytes()).hexdigest()
        manifest = self.root / 'SHA256SUMS'
        manifest.write_text(digest + '  runtime.tar.gz\n')
        result = self.shell(functions + '\n' + retain + '\nretain_release_image runtime.tar.gz',
                            SOURCE_DIR=str(self.root), WORK_DIR=str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ['--archive', str(asset), '--sha256', digest])
        manifest.write_text(digest + '  runtime.tar.gz\n' + '0' * 64 + '  runtime.tar.gz\n')
        result = self.shell('die() { echo "$*" >&2; exit 1; }\n' + functions + '\n' + retain + '\nretain_release_image runtime.tar.gz',
                            SOURCE_DIR=str(self.root), WORK_DIR=str(self.root))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('ambiguous asset checksum', result.stderr)

    def test_retention_failure_stops_compute_before_success_is_reported(self):
        branch = self.source[self.source.index('if [ "$ROLE" = compute ]; then\n'):]
        script = 'log() { echo "$*"; }; acquire_asset() { :; }; provision_compute_node() { :; }; retain_release_image() { return 23; };\n' + branch
        result = self.shell(script, ROLE='compute', VERSION='1.2.3', ARCH='amd64', RUNTIME_ARCHIVE='runtime.tar.gz')
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertNotIn('Compute node ready', result.stdout)

    def test_atlas_can_provision_infrastructure_and_own_image_retention(self):
        branch = self.source[self.source.index('if [ "$ROLE" = compute ]; then\n'):]
        script = 'log() { echo "$*"; }; acquire_asset() { :; }; provision_compute_node() { :; }; retain_release_image() { exit 23; };\n' + branch
        result = self.shell(script, ROLE='compute', VERSION='1.2.3', ARCH='amd64', RUNTIME_ARCHIVE='runtime.tar.gz', IMPORT_RUNTIME_IMAGE='0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'Compute node ready\n')

    def test_versioned_runtime_class_accepts_its_identity_and_refuses_an_existing_conflict(self):
        functions = self.source[self.source.index('apply_compute_runtime_class() {'):self.source.index('\nprovision_compute_node() {')]
        resource = {'apiVersion': 'node.k8s.io/v1', 'kind': 'RuntimeClass',
            'metadata': {'name': 'gvisor-qualified', 'annotations': {'moss.sudo.dev/runtime-archive': 'a' * 64}},
            'handler': 'verified-handler', 'scheduling': {'nodeSelector': {'version': 'verified'}}}
        receipt = self.root / 'receipt.json'
        receipt.write_text(json.dumps({'runtimeClass': resource}))
        existing = self.root / 'cluster.json'
        applied = self.root / 'applied.json'
        script = '''k3s() {
  if [ "$2" = get ]; then cat "$FIXTURE_EXISTING";
  elif [ "$2" = apply ]; then cp "$4" "$FIXTURE_APPLIED";
  else exit 99; fi
}
''' + functions + '\napply_compute_runtime_class gvisor-qualified "$FIXTURE_RECEIPT"\n'
        environment = {'WORK_DIR': str(self.root), 'FIXTURE_EXISTING': str(existing),
                       'FIXTURE_APPLIED': str(applied), 'FIXTURE_RECEIPT': str(receipt)}
        for previous in ['', json.dumps(resource)]:
            existing.write_text(previous)
            result = self.shell(script, **environment)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(applied.read_text()), resource)
        applied.unlink()
        resource['handler'] = 'different-handler'
        existing.write_text(json.dumps(resource))
        result = self.shell(script, **environment)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Existing RuntimeClass differs', result.stderr)
        self.assertFalse(applied.exists())


if __name__ == '__main__':
    unittest.main()
