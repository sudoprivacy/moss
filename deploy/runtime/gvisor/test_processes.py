"""Process audits bind live executable inodes to the installed release manifest."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts/e2e/gvisor-sync'))
from containerd import live_release_processes


class ProcessAuditTests(unittest.TestCase):
    def setUp(self):
        self.root = Path('/qualified-runtime')
        self.files = {'containerd-shim-runsc-v1': 'a' * 64, 'gvisor-bin/gvisor_sentry': 'b' * 64}
        self.records = [self.process(1, 'containerd-shim-runsc-v1', 'shim'),
                        self.process(2, 'containerd-shim-runsc-v1', 'shim'),
                        self.process(3, 'gvisor-bin/gvisor_sentry', 'sentry')]
        self.hashed = []

    def process(self, pid, name, identity, namespace='owned'):
        return {'pid': pid, 'executable': str(self.root / 'bin' / name),
                'identity': identity, 'args': namespace}

    def processes(self):
        return iter(self.records)

    def digest(self, pid):
        self.hashed.append(pid)
        return 'b' * 64 if pid == 3 else 'a' * 64

    def test_each_live_inode_is_hashed_once_with_namespace_and_path_confinement(self):
        self.records += [self.process(4, 'gvisor-bin/gvisor_sentry', 'foreign', 'other')]
        self.records += [{'pid': 5, 'executable': '/outside/bin/guest', 'identity': 'outside', 'args': 'owned'}]
        observed = live_release_processes(self.root, self.files, 'owned', self)
        self.assertEqual([item['pid'] for item in observed], [1, 2, 3])
        self.assertEqual(self.hashed, [1, 3])

    def test_running_executable_must_match_the_release(self):
        self.files['containerd-shim-runsc-v1'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'differs from the installed manifest'):
            live_release_processes(self.root, self.files, 'owned', self)

    def test_both_live_shim_and_sentry_are_required(self):
        self.records = self.records[:2]
        with self.assertRaisesRegex(ValueError, 'shim and Sentry must both be running'):
            live_release_processes(self.root, self.files, 'owned', self)

    def test_process_permission_errors_remain_visible(self):
        def denied(_pid):
            raise PermissionError('owned process inspection denied')
        self.digest = denied
        with self.assertRaisesRegex(PermissionError, 'owned process inspection denied'):
            live_release_processes(self.root, self.files, 'owned', self)


if __name__ == '__main__':
    unittest.main()
