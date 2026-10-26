"""Protect archive integrity, immutable installation and real concurrent registration."""
import hashlib
import io
import json
import multiprocessing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch
import install
import package as packaging
import publish as publication
from release import acquire, digest, relative_file, verify_release


def install_worker(archive, archive_sha, manifest_sha, prefix, template):
    result = install.stage(Path(archive), archive_sha, manifest_sha, Path(prefix))
    install.register_template(Path(result['installed']), manifest_sha, Path(template), 3)


class ManifestTests(unittest.TestCase):
    def test_names_reject_aliases_and_parent_paths(self):
        for name in ['.', '../escape', '/absolute', 'a//b', './runsc', 'a/../b', 'C:escape', 'a\\b', 'a\0b']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                relative_file(name)

    def test_a_changed_sidecar_cannot_pass_whole_release_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'runsc').write_bytes(b'runsc')
            (root / 'sentry').write_bytes(b'sentry')
            files = {name: digest(root / name) for name in ['runsc', 'sentry']}
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({'files': files}))
            expected = digest(manifest)
            self.assertEqual(verify_release(root / 'runsc', manifest, expected), files)
            (root / 'sentry').write_bytes(b'other sentry')
            with self.assertRaisesRegex(ValueError, 'files differ'):
                verify_release(root / 'runsc', manifest, expected)


class DownloadTests(unittest.TestCase):
    def test_real_http_fallback_authenticates_bytes_and_preserves_bad_existing_cache(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'qualified bytes' if self.path == '/good' else b'incorrect bytes')
            def log_message(self, *_arguments):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / 'artifact'
                origin = 'http://127.0.0.1:' + str(server.server_port)
                expected = hashlib.sha256(b'qualified bytes').hexdigest()
                acquire([origin + '/bad', origin + '/good'], expected, path)
                self.assertEqual(path.read_bytes(), b'qualified bytes')
                self.assertEqual(requests, ['/bad', '/good'])
                acquire([origin + '/good'], expected, path)
                self.assertEqual(len(requests), 2)
                path.write_bytes(b'local mismatch')
                with self.assertRaisesRegex(ValueError, 'Cached input checksum differs'):
                    acquire([origin + '/good'], expected, path)
                self.assertEqual(path.read_bytes(), b'local mismatch')
                self.assertEqual(list(root.iterdir()), [path])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class PublicationGateTests(unittest.TestCase):
    def utf8_cli(self, output, exit_code=0):
        """Decode actual child output using the caller's encoding or a Windows GBK default."""
        run = subprocess.run
        payload = output.encode('utf-8').hex()
        script = 'import os;os.write(' + str(2 if exit_code else 1) + ',bytes.fromhex(' + repr(payload) + '));raise SystemExit(' + str(exit_code) + ')'
        def command(_arguments, **kwargs):
            kwargs.setdefault('encoding', 'gbk')
            return run([sys.executable, '-c', script], **kwargs)
        return patch.object(subprocess, 'run', side_effect=command)

    def test_github_json_uses_utf8_with_a_windows_console_default(self):
        expected = {'title': '\u6743\u9650\u2713', 'source': 'reviewed'}
        with self.utf8_cli(json.dumps(expected, ensure_ascii=False)):
            self.assertEqual(publication.api('actions/runs'), expected)

    def test_github_failure_retains_utf8_diagnostics(self):
        message = '\u6743\u9650\u2713: HTTP 403'
        with self.utf8_cli(message, exit_code=1):
            with self.assertRaisesRegex(RuntimeError, message):
                publication.api('actions/runs')

    def runs(self):
        return [{'workflow_id': index, 'id': index, 'run_attempt': 1, 'path': name + '.yml',
                 'name': name, 'status': 'completed', 'conclusion': 'success'}
                for index, name in enumerate(['gVisor storage qualification', 'Build Moss Server Release', 'lint'], 1)]

    def test_pending_or_failed_source_workflow_prevents_publication(self):
        for status, conclusion in [('queued', None), ('completed', 'failure'), ('completed', 'cancelled')]:
            runs = self.runs()
            runs[0].update(status=status, conclusion=conclusion)
            with self.subTest(status=status, conclusion=conclusion), self.assertRaisesRegex(ValueError, 'incomplete'):
                publication.validate_source_runs(runs)

    def test_all_required_workflows_and_the_latest_attempt_are_required(self):
        runs = self.runs()
        with self.assertRaisesRegex(ValueError, 'missing'):
            publication.validate_source_runs(runs[:2])
        runs.append({**runs[0], 'run_attempt': 2, 'conclusion': 'failure'})
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            publication.validate_source_runs(runs)
        runs[-1]['conclusion'] = 'success'
        self.assertEqual(len(publication.validate_source_runs(runs)), 3)

    def test_the_publication_job_does_not_count_as_its_own_source_validation(self):
        runs = self.runs()
        runs.append({'path': publication.SELF_WORKFLOW, 'status': 'in_progress'})
        self.assertEqual(len(publication.validate_source_runs(runs)), 3)


class QualificationGateTests(unittest.TestCase):
    def test_failed_or_different_shim_cannot_qualify_an_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'gvisor-fixture-linux-amd64.tar.gz'
            archive.write_bytes(b'fixture archive')
            release = {'version': 'fixture', 'architecture': 'linux-amd64', 'filename': archive.name,
                       'archiveSha256': digest(archive), 'manifestSha256': 'a' * 64,
                       'archiveBytes': archive.stat().st_size}
            (root / 'release.json').write_text(json.dumps(release))
            installed = {'runsc': '/qualified/bin/runsc', **{key: release[key] for key in ['archiveSha256', 'manifestSha256']}}
            common = {'success': True, 'manifestSha256': release['manifestSha256'],
                      'runtimeSha256': 'b' * 64, 'releaseLibrarySha256': digest(Path(__file__).with_name('release.py')),
                      'platforms': ['ptrace', 'systrap'], 'directfsModes': [True, False]}
            calls = {**common, 'runtime': installed['runsc'], 'expect': 'propagated',
                     'hostSyncErrorPropagationQualified': True, 'cases': [{'case': str(i)} for i in range(20)]}
            storage = {**common, 'cases': [{'case': str(i)} for i in range(10)]}
            shim = {**common, 'installation': installed}
            inputs = [root / name for name in ['installed.json', 'syscalls.json', 'storage.json', 'shim.json']]
            for path, value in zip(inputs, [installed, calls, storage, shim]):
                path.write_text(json.dumps(value))
            for changed in [{'success': False}, {'installation': {**installed, 'archiveSha256': 'c' * 64}},
                            {'runtimeSha256': 'd' * 64}]:
                inputs[-1].write_text(json.dumps({**shim, **changed}))
                with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'shim'):
                    packaging.qualify(root, *inputs, 'f' * 40)
                self.assertFalse((root / 'qualification.json').exists())
            inputs[-1].write_text(json.dumps(shim))
            packaging.qualify(root, *inputs, 'f' * 40)
            self.assertTrue(json.loads((root / 'qualification.json').read_text())['success'])


@unittest.skipUnless(os.name == 'posix' and os.uname().sysname == 'Linux', 'Linux host installation')
class InstallationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='gvisor-install-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o755)
        self.prefix = self.root / 'versions'
        self.template = self.root / 'containerd/config.toml.tmpl'
        self.template.parent.mkdir()
        self.payload = {
            'runsc': b'runsc', 'containerd-shim-runsc-v1': b'shim',
            'gvisor-bin/gvisor_sentry': b'sentry',
        }
        self.archive, self.archive_sha, self.manifest_sha = self.make_archive('first.tar.gz')

    def make_archive(self, name, extra=None):
        files = {name: hashlib.sha256(raw).hexdigest() for name, raw in self.payload.items()}
        manifest = json.dumps({'version': 'fixture', 'files': files}).encode()
        rows = {'LICENSE': b'license', 'provenance.json': json.dumps({'manifestSha256': hashlib.sha256(manifest).hexdigest()}).encode(), 'bin/manifest.json': manifest,
                **{'bin/' + name: raw for name, raw in self.payload.items()}, **(extra or {})}
        archive = self.root / name
        with tarfile.open(archive, 'w:gz') as tar:
            for relative, raw in rows.items():
                member = tarfile.TarInfo(relative)
                member.size = len(raw)
                tar.addfile(member, io.BytesIO(raw))
        return archive, digest(archive), hashlib.sha256(manifest).hexdigest()

    def test_stage_is_complete_immutable_and_idempotent_under_private_umask(self):
        old = os.umask(0o077)
        try:
            first = install.stage(self.archive, self.archive_sha, self.manifest_sha, self.prefix)
        finally:
            os.umask(old)
        destination = Path(first['installed'])
        self.assertEqual(destination.name, self.archive_sha)
        self.assertLessEqual(len(first['handler']), 63)
        self.assertTrue(first['changed'])
        self.assertEqual((destination / 'bin/gvisor-bin/gvisor_sentry').stat().st_mode & 0o777, 0o555)
        self.assertEqual((destination / 'bin/gvisor-bin').stat().st_mode & 0o777, 0o755)
        self.assertIn(first['runsc'], (destination / 'shim.toml').read_text())
        second = install.stage(self.archive, self.archive_sha, self.manifest_sha, self.prefix)
        self.assertFalse(second['changed'])
        self.assertEqual(list(self.prefix.glob('.stage-*')), [])

    def test_bad_archive_and_path_traversal_leave_no_published_release(self):
        with self.assertRaisesRegex(ValueError, 'archive checksum'):
            install.stage(self.archive, '0' * 64, self.manifest_sha, self.prefix)
        self.assertFalse(self.prefix.exists())
        archive, archive_sha, manifest_sha = self.make_archive('escape.tar.gz', {'../escape': b'bad'})
        with self.assertRaisesRegex(ValueError, 'Unsafe release file'):
            install.stage(archive, archive_sha, manifest_sha, self.prefix)
        self.assertFalse(self.prefix.exists())
        self.assertFalse((self.root / 'escape').exists())

    def test_changed_sidecar_in_an_authenticated_archive_is_rejected(self):
        archive = self.root / 'tampered.tar.gz'
        with tarfile.open(self.archive) as source, tarfile.open(archive, 'w:gz') as target:
            for member in source:
                raw = source.extractfile(member).read()
                if member.name.endswith('gvisor_sentry'):
                    raw = b'changed'
                    member.size = len(raw)
                target.addfile(member, io.BytesIO(raw))
        with self.assertRaisesRegex(ValueError, 'files differ'):
            install.stage(archive, digest(archive), self.manifest_sha, self.prefix)
        self.assertFalse(self.prefix.exists())

    def test_links_and_duplicate_archive_members_cannot_enter_an_installation(self):
        for kind in ['symlink', 'duplicate']:
            archive = self.root / (kind + '.tar.gz')
            with tarfile.open(self.archive) as source, tarfile.open(archive, 'w:gz') as target:
                for member in source:
                    target.addfile(member, io.BytesIO(source.extractfile(member).read()))
                member = tarfile.TarInfo('bin/runsc' if kind == 'duplicate' else 'link')
                if kind == 'symlink':
                    member.type, member.linkname = tarfile.SYMTYPE, '/etc/passwd'
                target.addfile(member, io.BytesIO(b''))
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, 'unique regular files'):
                install.stage(archive, digest(archive), self.manifest_sha, self.prefix)
            self.assertFalse(self.prefix.exists())

    def test_a_failed_publication_barrier_preserves_the_complete_version_for_retry(self):
        original = install.sync_directory
        destination = self.prefix / self.archive_sha
        def fault(path):
            if path == self.prefix and destination.exists():
                raise OSError(5, 'injected namespace barrier error')
            original(path)
        with patch.object(install, 'sync_directory', side_effect=fault), self.assertRaisesRegex(OSError, 'barrier error'):
            install.stage(self.archive, self.archive_sha, self.manifest_sha, self.prefix)
        self.assertTrue(destination.is_dir())
        install.verify_installed(destination, self.manifest_sha)
        self.assertFalse(install.stage(self.archive, self.archive_sha, self.manifest_sha, self.prefix)['changed'])

    def test_retry_reestablishes_ancestors_after_a_failed_directory_creation_barrier(self):
        original = install.sync_directory
        def fault(path):
            if path == self.root and self.prefix.exists():
                raise OSError(5, 'injected ancestor barrier error')
            original(path)
        with patch.object(install, 'sync_directory', side_effect=fault):
            for _attempt in range(2):
                with self.assertRaisesRegex(OSError, 'ancestor barrier error'):
                    install.stage(self.archive, self.archive_sha, self.manifest_sha, self.prefix)
                self.assertFalse((self.prefix / self.archive_sha).exists())
        self.assertTrue(install.stage(self.archive, self.archive_sha, self.manifest_sha, self.prefix)['changed'])

    def test_registration_preserves_existing_configuration_for_both_schemas(self):
        result = install.stage(self.archive, self.archive_sha, self.manifest_sha, self.prefix)
        original = '{{ template "base" . }}\n# local config\n'
        self.template.write_text(original)
        for version in [2, 3]:
            template = self.template.with_name('v' + str(version) + '.tmpl')
            template.write_text(original)
            registered = install.register_template(Path(result['installed']), self.manifest_sha, template, version)
            self.assertTrue(registered['changed'])
            self.assertTrue(template.read_text().startswith(original))
            self.assertIn(result['shim'], template.read_text())
            try:
                import tomllib
            except ImportError:
                tomllib = None
            if tomllib:
                parsed = tomllib.loads(template.read_text().replace('{{ template "base" . }}', 'version = ' + str(version)))
                plugin = 'io.containerd.grpc.v1.cri' if version == 2 else 'io.containerd.cri.v1.runtime'
                options = parsed['plugins'][plugin]['containerd']['runtimes'][result['handler']]['options']
                self.assertEqual(options['ConfigPath'], result['shimConfig'])
            self.assertFalse(install.register_template(Path(result['installed']), self.manifest_sha, template, version)['changed'])
            template.write_text(template.read_text().replace(result['shim'], '/another/shim'))
            with self.assertRaisesRegex(ValueError, 'configuration differs'):
                install.register_template(Path(result['installed']), self.manifest_sha, template, version)

    def test_idempotent_registration_reestablishes_durability_under_the_template_lock(self):
        import fcntl
        result = install.stage(self.archive, self.archive_sha, self.manifest_sha, self.prefix)
        install.register_template(Path(result['installed']), self.manifest_sha, self.template, 3)
        original_flock, original_sync = fcntl.flock, install.sync_directory
        acquired = False
        def flock(descriptor, operation):
            nonlocal acquired
            original_flock(descriptor, operation)
            acquired = True
        def fault(path):
            if acquired and path == self.template.parent:
                raise OSError(5, 'injected locked template barrier error')
            original_sync(path)
        with patch.object(fcntl, 'flock', side_effect=flock), patch.object(install, 'sync_directory', side_effect=fault):
            with self.assertRaisesRegex(OSError, 'locked template barrier error'):
                install.register_template(Path(result['installed']), self.manifest_sha, self.template, 3)
        self.assertFalse(install.register_template(Path(result['installed']), self.manifest_sha, self.template, 3)['changed'])

    def test_concurrent_versions_preserve_both_registered_handlers(self):
        self.payload['gvisor-bin/gvisor_sentry'] = b'next sentry'
        second = self.make_archive('second.tar.gz')
        context = multiprocessing.get_context('spawn')
        prefixes = [self.prefix, self.root / 'other-store']
        workers = [context.Process(target=install_worker, args=(str(values[0]), values[1], values[2], str(prefix), str(self.template)))
                   for prefix, values in zip(prefixes, [(self.archive, self.archive_sha, self.manifest_sha), second])]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(15)
            self.assertEqual(worker.exitcode, 0)
        contents = self.template.read_text()
        self.assertEqual(contents.count('runtime_path ='), 2)
        self.assertEqual(sum(len([path for path in prefix.iterdir() if path.is_dir()]) for prefix in prefixes), 2)


if __name__ == '__main__':
    unittest.main()
