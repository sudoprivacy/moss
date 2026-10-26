"""Shared deployment tools enter a release only with their exact pinned bytes."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

import package_deployment


class DeploymentPackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'source'
        files = {}
        for name in ['tools/deploy/images.py', 'tools/deploy/artifacts.py']:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('# fixture ' + name + '\n').encode())
            files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.lock = self.root / 'lock.json'
        self.lock.write_text(json.dumps({'repository': 'sudoprivacy/sudostack', 'revision': 'a' * 40, 'files': files}))
        self.output = self.root / 'release/deploy.tar.gz'

    def test_bundle_contains_exact_owner_bytes_and_provenance(self):
        package_deployment.package(self.output, self.source, self.lock)
        with tarfile.open(self.output) as bundle:
            members = bundle.getmembers()
            self.assertTrue(all(member.isfile() for member in members))
            self.assertEqual({m.name for m in members}, {'control.py', 'install-control.sh', 'fetch-offline-deps.sh',
                                                       'server.json', 'images.py', 'artifacts.py', 'sudostack-images.lock.json',
                                                       *('deploy/runtime/gvisor/' + name for name in ['fetch.py', 'install.py', 'release.py'])})
            self.assertEqual(bundle.extractfile('images.py').read(), (self.source / 'tools/deploy/images.py').read_bytes())
            self.assertEqual(bundle.extractfile('sudostack-images.lock.json').read(), self.lock.read_bytes())
            destination = self.root / 'unpacked'
            bundle.extractall(destination)
        for command in ['fetch.py', 'install.py']:
            result = subprocess.run([sys.executable, str(destination / 'deploy/runtime/gvisor' / command), '--help'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_changed_source_is_rejected_before_any_release_is_written(self):
        (self.source / 'tools/deploy/images.py').write_bytes(b'# modified\n')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            package_deployment.package(self.output, self.source, self.lock)
        self.assertFalse(self.output.parent.exists())

    def test_unpinned_source_or_extra_module_cannot_enter_bundle(self):
        for field, value in [('revision', 'main'), ('repository', 'another/repository')]:
            lock = json.loads(self.lock.read_text())
            lock[field] = value
            changed = self.root / (field + '.json')
            changed.write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, 'pinned Sudostack'):
                package_deployment.package(self.output, self.source, changed)
        self.assertFalse(self.output.parent.exists())
        lock = json.loads(self.lock.read_text())
        lock['files']['../../extra.py'] = '0' * 64
        changed = self.root / 'extra.json'
        changed.write_text(json.dumps(lock))
        with self.assertRaisesRegex(ValueError, 'Unexpected shared image tools'):
            package_deployment.package(self.output, self.source, changed)
        self.assertFalse(self.output.parent.exists())


if __name__ == '__main__':
    unittest.main()
