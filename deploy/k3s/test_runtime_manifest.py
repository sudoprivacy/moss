"""A published runtime must compare the same OCI object that Kubernetes reports."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class RuntimeManifestTests(unittest.TestCase):
    def setUp(self):
        self.bun = shutil.which('bun')
        self.assertIsNotNone(self.bun, 'Runtime manifest tests require the release build toolchain')
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        pins = json.loads((ROOT / 'src/server/nexus/runtime-versions.json').read_text())
        self.reference = 'docker.io/library/my-moss-runtime:fixture-amd64'
        self.config = 'sha256:' + '1' * 64
        self.manifest = 'sha256:' + '2' * 64
        self.identities = self.root / 'image-identities.json'
        self.identities.write_text(json.dumps({self.reference: {'id': self.config, 'manifestDigest': self.manifest}}))
        self.archive = self.root / 'runtime.tar.gz'
        self.archive.write_bytes(b'fixture archive bytes')
        self.scode = self.root / 'scode-version.txt'
        self.scode.write_text('Version ' + pins['scode'].lstrip('v') + '\nGit SHA ' + 'a' * 40 + '\n')
        self.cohost = self.root / 'cohost-version.txt'
        self.cohost.write_text('nexusd-cohost v' + pins['nexusd-cohost'] + ' (sudocode ' + 'a' * 40 +
                               ', nexus-vfs v' + pins['nexusd-cluster'] + ') (plugin-abi 7)\n')
        self.output = self.root / 'runtime-release.json'

    def generate(self):
        return subprocess.run([self.bun, str(ROOT / 'scripts/create-runtime-manifest.ts'),
                               'server-vfixture', self.reference, self.config, str(self.identities),
                               str(self.archive), str(self.scode), str(self.cohost),
                               'sha256:' + '3' * 64, str(self.output)],
                              cwd=ROOT, capture_output=True, text=True)

    def test_publishes_the_verified_manifest_digest_and_keeps_archive_and_binary_provenance(self):
        result = self.generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        release = json.loads(self.output.read_text())
        self.assertEqual(release['image'], {'reference': self.reference, 'digest': self.manifest, 'digestKind': 'oci-manifest'})
        self.assertEqual(release['archive']['digest'], 'sha256:' + hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.assertEqual(release['cohost']['binaryDigest'], 'sha256:' + '3' * 64)

    def test_wrong_archive_config_is_rejected_before_publication(self):
        self.identities.write_text(json.dumps({self.reference: {'id': 'sha256:' + '4' * 64, 'manifestDigest': self.manifest}}))
        result = self.generate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('saved archive does not match', result.stderr)
        self.assertFalse(self.output.exists())

    def test_config_only_metadata_cannot_publish_an_uncomparable_digest(self):
        self.identities.write_text(json.dumps({self.reference: {'id': self.config}}))
        result = self.generate()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
