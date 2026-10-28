"""Exercise node configuration, idempotence, workload retention and rollback."""
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import node
import test_release


@unittest.skipUnless(os.name == 'posix' and os.uname().sysname == 'Linux', 'Linux K3s host lifecycle')
class NodeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_release.InstallationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.containerd = self.root / 'containerd'
        self.containerd.mkdir(exist_ok=True)
        (self.containerd / 'config.toml').write_text('version = 3\n')
        self.labels = self.root / 'node-config/90-moss-gvisor.yaml'
        self.release = {'architecture': 'linux-amd64', 'archivePath': str(self.fixture.archive),
                        'archiveSha256': self.fixture.archive_sha, 'manifestSha256': self.fixture.manifest_sha}
        self.loaded = {}
        self.restarts = 0
        self.running = {'preceding-workload'}
        self.properties = 'KillMode=process\nExecStop=\nActiveState=active\n'
        self.fail_restart = False
        self.lose_container = False

    def native(self, *args):
        if args[:3] == ('systemctl', 'show', 'k3s') and args[3:] in (
                ('--property=ExecStop', '--value'), ('--property=ExecStopPost', '--value')):
            return dict(row.split('=', 1) for row in self.properties.splitlines() if '=' in row).get(args[3].split('=', 1)[1], '')
        if args[:2] == ('systemctl', 'show'):
            return '\n'.join(row for row in self.properties.splitlines() if not row.startswith('ExecStop=') and
                             ('--all' in args or not row.endswith('='))) + '\n'
        if args[:2] == ('systemctl', 'restart'):
            self.restarts += 1
            if self.fail_restart and self.restarts == 1:
                raise subprocess.CalledProcessError(1, args, stderr='injected node restart failure')
            import tomllib
            template = self.containerd / 'config-v3.toml.tmpl'
            if not template.exists():
                template = self.containerd / 'config.toml.tmpl'
            if template.exists():
                content = template.read_text().replace('{{ template "base" . }}', '')
                self.loaded = tomllib.loads(content).get('plugins', {}).get('io.containerd.cri.v1.runtime', {}).get('containerd', {}).get('runtimes', {})
            else:
                self.loaded = {}
            if self.lose_container and self.restarts == 1:
                self.running.clear()
            return ''
        if args[:2] == ('systemctl', 'is-active'):
            return 'active\n'
        if args == ('k3s', 'crictl', 'info'):
            return json.dumps({'config': {'containerd': {'runtimes': {
                key: {'runtimeType': value['runtime_type'], 'runtimePath': value['runtime_path'],
                      'options': value['options']} for key, value in self.loaded.items()}}}})
        if args == ('k3s', 'crictl', 'ps', '-o', 'json'):
            return json.dumps({'containers': [{'id': value, 'state': 'CONTAINER_RUNNING'} for value in self.running]})
        raise AssertionError('Unexpected native operation: ' + repr(args))

    def activate(self, **kwargs):
        return node.activate(self.release, self.fixture.prefix, self.containerd, self.labels,
                             'k3s', run=kwargs.get('run', self.native))

    def test_native_failure_retains_stderr_and_called_process_error_semantics(self):
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            node.command('/bin/sh', '-c', 'echo native-diagnostic >&2; exit 3')
        self.assertEqual(caught.exception.returncode, 3)
        self.assertIn('native-diagnostic', str(caught.exception))

    def test_new_handler_retains_workload_and_advertises_exact_node_capability(self):
        result = self.activate()
        resource = result['runtimeClass']
        self.assertEqual(result['retainedContainerCount'], 1)
        self.assertEqual(self.restarts, 1)
        self.assertEqual(resource['handler'], result['handler'])
        self.assertEqual(resource['scheduling']['nodeSelector']['kubernetes.io/arch'], 'amd64')
        label = next(key for key in resource['scheduling']['nodeSelector'] if key.startswith('moss.sudo.dev/'))
        self.assertLessEqual(len(label.split('/')[1]), 63)
        self.assertEqual(json.loads(self.labels.read_text())['node-label+'], [label + '=installed'])
        self.assertEqual(self.running, {'preceding-workload'})

    def test_idempotent_install_verifies_loaded_handler_without_another_restart(self):
        first = self.activate()
        second = self.activate()
        self.assertTrue(first['changed'])
        self.assertFalse(second['changed'])
        self.assertEqual(self.restarts, 1)

    def test_existing_template_and_previous_version_labels_are_preserved(self):
        template = self.containerd / 'config.toml.tmpl'
        original = '{{ template "base" . }}\n# customer handler\n'
        template.write_text(original)
        self.labels.parent.mkdir()
        old = 'moss.sudo.dev/gvisor-' + 'a' * 52 + '=installed'
        self.labels.write_text(json.dumps({'node-label+': [old]}))
        self.activate()
        self.assertTrue(template.read_text().startswith(original))
        self.assertIn(old, json.loads(self.labels.read_text())['node-label+'])
        self.assertFalse((self.containerd / 'config-v3.toml.tmpl').exists())

    def test_template_line_endings_remain_identical_across_install_and_retry(self):
        template = self.containerd / 'config-v3.toml.tmpl'
        original = b'{{ template "base" . }}\r\n# customer configuration\r\n'
        template.write_bytes(original)
        self.activate()
        self.assertTrue(template.read_bytes().startswith(original))
        installed = template.read_bytes()
        self.activate()
        self.assertEqual(template.read_bytes(), installed)
        self.assertEqual(self.restarts, 1)

    def test_service_that_would_kill_sandboxes_is_refused_before_staging(self):
        for properties in ['KillMode=control-group\nExecStop=\nActiveState=active\n',
                           'KillMode=process\nExecStop=/bin/kill-all\nActiveState=active\n',
                           'KillMode=process\nExecStop=\nExecStopPost=/bin/kill-all\nActiveState=active\n']:
            self.properties = properties
            with self.assertRaisesRegex(ValueError, 'retain its container processes'):
                self.activate()
            self.assertFalse(self.fixture.prefix.exists())
            self.assertEqual(self.restarts, 0)

    def test_command_line_labels_cannot_silently_hide_the_runtime_capability(self):
        self.properties += 'ExecStart=/usr/local/bin/k3s server --node-label customer=true\n'
        with self.assertRaisesRegex(ValueError, 'Move node labels'):
            self.activate()
        self.assertFalse(self.fixture.prefix.exists())

    def test_a_writable_or_symlinked_configuration_is_refused(self):
        self.labels.parent.mkdir()
        self.labels.write_text('{}')
        self.labels.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'protected regular file'):
            self.activate()
        self.assertEqual(self.restarts, 0)
        self.labels.unlink()
        target = self.root / 'foreign'
        target.write_text('retain')
        self.labels.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'materialized file'):
            self.activate()
        self.assertEqual(target.read_text(), 'retain')

    def test_failed_restart_restores_original_files_and_reloads_previous_configuration(self):
        template = self.containerd / 'config-v3.toml.tmpl'
        original = '{{ template "base" . }}\n# retained template\n'
        template.write_text(original)
        self.fail_restart = True
        with self.assertRaisesRegex(subprocess.CalledProcessError, 'non-zero'):
            self.activate()
        self.assertEqual(template.read_text(), original)
        self.assertFalse(self.labels.exists())
        self.assertEqual(self.restarts, 2)

    def test_post_publication_barrier_error_restores_the_published_label_file(self):
        publish = node.install.publish_file
        def fault(path, *args):
            publish(path, *args)
            if path == self.labels:
                raise OSError(5, 'injected post-publication barrier error')
        with patch.object(node.install, 'publish_file', side_effect=fault):
            with self.assertRaisesRegex(OSError, 'post-publication'):
                self.activate()
        self.assertFalse(self.labels.exists())
        self.assertFalse((self.containerd / 'config-v3.toml.tmpl').exists())
        self.assertEqual(self.restarts, 0)

    def test_concurrent_label_writer_is_preserved_on_failure(self):
        native = self.native
        def changed(*args):
            if args[:2] == ('systemctl', 'restart'):
                self.labels.write_text('foreign update\n')
                raise RuntimeError('injected reload failure')
            return native(*args)
        with self.assertRaisesRegex(ValueError, 'changed during installation'):
            self.activate(run=changed)
        self.assertEqual(self.labels.read_text(), 'foreign update\n')
        self.assertFalse((self.containerd / 'config-v3.toml.tmpl').exists())

    def test_disappearing_business_container_prevents_success_and_restores_registration(self):
        self.lose_container = True
        with self.assertRaisesRegex(ValueError, 'running container disappeared'):
            self.activate()
        self.assertFalse(self.labels.exists())
        self.assertEqual(self.restarts, 2)

    def test_a_different_loaded_handler_is_rejected_even_when_service_is_active(self):
        self.activate()
        for entry in self.loaded.values():
            entry['runtime_path'] = '/unverified/shim'
        with self.assertRaisesRegex(ValueError, 'Loaded runtime handler differs'):
            self.activate()
        self.assertEqual(self.restarts, 1)


if __name__ == '__main__':
    unittest.main()
