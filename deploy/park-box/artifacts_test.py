import io
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
import subprocess

from artifacts import digest, extract_safe, file_manifest, verify_files, verify_signature
from agent import BoxAgent
from docker_engine import DockerEngine


class ArtifactTests(unittest.TestCase):
    def test_unnamed_removed_container_does_not_hide_running_replacement(self):
        engine = DockerEngine('park-box')
        engine.request = lambda *_: [{'Id': 'removed', 'Names': [], 'State': 'dead'},
                                    {'Id': 'replacement', 'Names': ['/park-box-moss-1'], 'State': 'running'}]
        self.assertEqual([item['Id'] for item in engine.containers()], ['replacement'])

    def test_real_ed25519_signature_and_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private, public, archive, message = [root / name for name in ('private.pem', 'public.pem', 'release.tar.gz', 'message')]
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(private)], check=True, capture_output=True)
            subprocess.run(['openssl', 'pkey', '-in', str(private), '-pubout', '-out', str(public)], check=True, capture_output=True)
            archive.write_bytes(b'versioned container payload')
            message.write_bytes(b'park-box-release-v1\x00' + bytes.fromhex(digest(archive)))
            subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(private), '-rawin', '-in', str(message), '-out', str(archive) + '.sig'], check=True, capture_output=True)
            verify_signature(archive, public)
            archive.write_bytes(b'tampered container payload')
            with self.assertRaisesRegex(ValueError, 'signature'):
                verify_signature(archive, public)

    def test_manifest_validates_database_empty_directories_links_and_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'empty').mkdir()
            with sqlite3.connect(root / 'database.sqlite') as db:
                db.execute('CREATE TABLE value (id INTEGER PRIMARY KEY)')
                db.execute('INSERT INTO value VALUES (7)')
            (root / 'link').symlink_to('database.sqlite')
            files, databases = file_manifest(root)
            self.assertIn('database.sqlite', databases)
            self.assertIn('empty', files)
            verify_files(root, files)
            with sqlite3.connect(root / 'database.sqlite') as db:
                db.execute('INSERT INTO value VALUES (8)')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                verify_files(root, files)

    def test_unsafe_archive_rejected_before_writing(self):
        for name, link in (('../escape', None), ('payload/link', '../../escape'), ('payload/link', '/etc/passwd')):
            with self.subTest(name=name, link=link), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'archive.tar'
                with tarfile.open(archive, 'w') as bundle:
                    entry = tarfile.TarInfo(name)
                    if link:
                        entry.type, entry.linkname = tarfile.SYMTYPE, link
                    else:
                        entry.size = 1
                    bundle.addfile(entry, None if link else io.BytesIO(b'x'))
                with self.assertRaises(ValueError):
                    extract_safe(archive, root / 'output', allow_links=True)

    def test_safe_relative_link_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            (source / 'policy.md').write_text('政策正文')
            (source / 'current').symlink_to('policy.md')
            files, _ = file_manifest(source)
            with tarfile.open(root / 'backup.tar', 'w') as bundle:
                for path in source.iterdir():
                    bundle.add(path, arcname=path.name)
            extract_safe(root / 'backup.tar', root / 'restored', allow_links=True)
            verify_files(root / 'restored', files)
            self.assertEqual((root / 'restored/current').read_text(), '政策正文')

    def test_wal_database_validation_does_not_create_unmanifested_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with sqlite3.connect(root / 'database.sqlite') as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE value (id INTEGER PRIMARY KEY)')
                db.commit()
                db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            before = {path.name for path in root.iterdir()}
            files, _ = file_manifest(root)
            self.assertEqual({path.name for path in root.iterdir()}, before)
            verify_files(root, files)

    def test_task_api_excludes_recovery_credentials(self):
        public = BoxAgent.public_task({'id': '123', 'action': 'backup', 'status': 'succeeded',
                 'containers': [{'Config': {'Env': ['SECRET=value']}}], 'actor': 'admin', 'result': {'archive': 'backup.tar.gz'}})
        self.assertNotIn('containers', public)
        self.assertNotIn('actor', public)
        self.assertEqual(public['result']['archive'], 'backup.tar.gz')


if __name__ == '__main__':
    unittest.main()
