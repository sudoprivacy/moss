"""Drive the real non-root download entry against a local release server."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
import unittest

HERE = Path(__file__).resolve().parent


@unittest.skipUnless(os.name == 'posix', 'Linux installer entry')
class InstallerDownloadTests(unittest.TestCase):
    def run_installer(self, extra=None, corrupt=False, omit=None):
        with tempfile.TemporaryDirectory(prefix='moss-download-') as directory:
            root = Path(directory)
            script = (HERE.parent / 'install.sh').read_bytes().replace(b'@@MOSS_RELEASE_TAG@@', b'server-vfixture')
            bundle = io.BytesIO()
            modules = {}
            for name in ['fetch.py', 'install.py', 'release.py']:
                modules['deploy/runtime/gvisor/' + name] = (HERE.parent / 'runtime/gvisor' / name).read_bytes()
            modules['fetch-offline-deps.sh'] = b'''set -eu
mkdir -p "$OFFLINE_DIR"
tools="$(dirname "$0")/deploy/runtime/gvisor"
python3 "$tools/fetch.py" --help > "$OFFLINE_DIR/bundled-fetch-help.txt"
printf '%s' "$ARCH" > "$OFFLINE_DIR/architecture"
'''
            for name in ['control.py', 'install-control.sh', 'server.json', 'images.py', 'artifacts.py', 'sudostack-images.lock.json']:
                modules[name] = b'# opaque download fixture\n'
            if omit:
                del modules[omit]
            rows = [(name, raw, None) for name, raw in modules.items()]
            rows.extend(extra or [])
            with tarfile.open(fileobj=bundle, mode='w:gz') as archive:
                for name, raw, kind in rows:
                    member = tarfile.TarInfo(name)
                    if kind:
                        member.type, member.linkname = kind, '/tmp/escape'
                    member.size = len(raw)
                    archive.addfile(member, io.BytesIO(raw))
            assets = {'install.sh': script, 'moss-deploy-fixture-linux-amd64.tar.gz': bundle.getvalue()}
            for name in ['moss-server-image', 'moss-nexus-image', 'moss-runtime']:
                assets[name + '-fixture-linux-amd64.tar.gz'] = b'authenticated opaque image fixture'
            assets['SHA256SUMS'] = ''.join(hashlib.sha256(raw).hexdigest() + '  ' + name + '\n' for name, raw in assets.items()).encode()
            if corrupt:
                assets['moss-deploy-fixture-linux-amd64.tar.gz'] += b'corrupted after manifest creation'
            requests = []
            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    name = self.path.lstrip('/')
                    requests.append(name)
                    self.send_response(200 if name in assets else 404)
                    self.end_headers()
                    self.wfile.write(assets.get(name, b'Unlisted asset'))
                def log_message(self, *_args):
                    pass
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                output = root / 'offline-release'
                env = {**os.environ, 'MOSS_RELEASE_TAG': 'server-vfixture', 'MOSS_ARCH': 'amd64',
                       'MOSS_DOWNLOAD_BASE': 'http://127.0.0.1:' + str(server.server_port)}
                process = subprocess.run(['bash', '-s', '--', '--download', str(output)], input=script,
                                         capture_output=True, env=env, timeout=45)
                marker = output / 'offline/architecture'
                result = {'exitCode': process.returncode, 'stdout': process.stdout.decode(errors='replace'),
                          'stderr': process.stderr.decode(errors='replace'), 'requests': requests[:],
                          'architecture': marker.read_text() if marker.exists() else None}
                help_file = output / 'offline/bundled-fetch-help.txt'
                result['helperLoaded'] = help_file.exists() and '--release-sha256' in help_file.read_text()
                return result
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_pipe_installer_uses_the_authenticated_bundle_including_nested_tools(self):
        result = self.run_installer()
        self.assertEqual(result['exitCode'], 0, result)
        self.assertEqual(result['architecture'], 'amd64')
        self.assertTrue(result['helperLoaded'])
        self.assertNotIn('fetch-offline-deps.sh', result['requests'])

    def test_unsafe_bundle_members_cannot_reach_the_staging_script(self):
        for row in [('../escape', b'escape', None), ('/absolute', b'escape', None),
                    ('a\\escape', b'escape', None), ('a//alias', b'escape', None),
                    ('deploy/runtime/gvisor/fetch.py', b'duplicate', None),
                    ('symlink', b'', tarfile.SYMTYPE), ('hardlink', b'', tarfile.LNKTYPE)]:
            with self.subTest(member=row[0], kind=row[2]):
                result = self.run_installer([row])
                self.assertNotEqual(result['exitCode'], 0, result)
                self.assertIn('Unsafe deployment bundle', result['stderr'])
                self.assertIsNone(result['architecture'])

    def test_outer_release_checksum_failure_precedes_bundle_execution(self):
        result = self.run_installer(corrupt=True)
        self.assertNotEqual(result['exitCode'], 0, result)
        self.assertIsNone(result['architecture'])

    def test_missing_host_entrypoint_is_rejected_before_the_download_helper_runs(self):
        result = self.run_installer(omit='install-control.sh')
        self.assertNotEqual(result['exitCode'], 0, result)
        self.assertIn('Missing deployment entrypoint', result['stderr'])
        self.assertIsNone(result['architecture'])


if __name__ == '__main__':
    unittest.main()
