"""Exercise authenticated archive acquisition and network-free recovery from its cache."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch
import fetch
from release import digest


class FetchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / 'gvisor-fixture-linux-amd64.tar.gz'
        payload = {'runsc': b'runsc', 'containerd-shim-runsc-v1': b'shim', 'gvisor-bin/gvisor_sentry': b'sentry'}
        manifest = json.dumps({'version': 'fixture', 'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in payload.items()}}).encode()
        self.manifest_sha = hashlib.sha256(manifest).hexdigest()
        members = {'LICENSE': b'license', 'provenance.json': json.dumps({'manifestSha256': self.manifest_sha}).encode(),
                   'bin/manifest.json': manifest, **{'bin/' + name: raw for name, raw in payload.items()}}
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, raw in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                archive.addfile(info, io.BytesIO(raw))
        self.metadata = self.root / 'release.json'
        self.cache = self.root / 'cache'
        self.release = {'version': 'fixture', 'architecture': 'linux-amd64', 'filename': self.archive.name,
                        'archiveSha256': digest(self.archive), 'manifestSha256': self.manifest_sha,
                        'archiveBytes': self.archive.stat().st_size, 'urls': [self.archive.as_uri()]}
        self.metadata.write_text(json.dumps(self.release))

    def acquire(self, offline=False):
        return fetch.fetch(self.metadata, digest(self.metadata), self.cache, offline)

    def test_real_http_fallback_then_offline_restore_uses_the_same_complete_archive(self):
        requests = []
        raw = self.archive.read_bytes()
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(raw if self.path == '/good' else b'corrupt download')
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = 'http://127.0.0.1:' + str(server.server_port)
        self.release['urls'] = [origin + '/bad', origin + '/good']
        self.metadata.write_text(json.dumps(self.release))
        try:
            first = self.acquire()
            second = self.acquire(offline=True)
            self.assertEqual(first, second)
            self.assertEqual(requests, ['/bad', '/good'])
            self.assertEqual(Path(first['archivePath']).read_bytes(), raw)
            self.assertEqual(Path(first['archivePath']).parent.name, self.release['archiveSha256'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_offline_cache_miss_makes_no_network_request_or_directory(self):
        with self.assertRaisesRegex(FileNotFoundError, 'missing from the cache'):
            self.acquire(offline=True)
        self.assertFalse(self.cache.exists())

    def test_modified_metadata_is_rejected_before_any_cache_mutation(self):
        expected = digest(self.metadata)
        self.metadata.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'metadata checksum'):
            fetch.fetch(self.metadata, expected, self.cache)
        self.assertFalse(self.cache.exists())

    def test_tampered_cached_bytes_are_retained_and_rejected_in_both_modes(self):
        result = self.acquire()
        path = Path(result['archivePath'])
        corrupted = bytes([self.archive.read_bytes()[0] ^ 1]) + self.archive.read_bytes()[1:]
        path.write_bytes(corrupted)
        for offline in [True, False]:
            with self.subTest(offline=offline), self.assertRaisesRegex(ValueError, 'checksum differs'):
                self.acquire(offline)
            self.assertEqual(path.read_bytes(), corrupted)

    def test_a_different_manifest_cannot_pass_an_authenticated_archive_hash(self):
        self.release['manifestSha256'] = '0' * 64
        self.metadata.write_text(json.dumps(self.release))
        with self.assertRaisesRegex(ValueError, 'manifest differs'):
            self.acquire()

    def test_metadata_rename_after_open_cannot_change_the_authenticated_identity(self):
        expected = digest(self.metadata)
        replacement = self.root / 'next.json'
        replacement.write_text('{}')
        original_open = Path.open
        replaced = False
        def opening(path, *args, **kwargs):
            nonlocal replaced
            file = original_open(path, *args, **kwargs)
            if path == self.metadata and not replaced:
                replaced = True
                replacement.replace(self.metadata)
            return file
        with patch.object(Path, 'open', opening):
            result = fetch.fetch(self.metadata, expected, self.cache)
        self.assertTrue(replaced)
        self.assertEqual(result['archiveSha256'], self.release['archiveSha256'])
        self.assertEqual(self.metadata.read_text(), '{}')


if __name__ == '__main__':
    unittest.main()
