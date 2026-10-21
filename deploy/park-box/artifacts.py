import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    temporary.replace(path)
    directory = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def checked_path(root, name):
    relative = PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts or '\\' in name:
        raise ValueError('Unsafe archive path')
    target = root.joinpath(*relative.parts)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('Archive path escapes destination')
    return target


def extract_safe(archive, destination, allow_links=False):
    """Never delegate untrusted names or special files to tar extractall."""
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'r:*') as bundle:
        members = bundle.getmembers()
        names = set()
        for member in members:
            if member.name in names:
                raise ValueError('Duplicate archive entry')
            names.add(member.name)
            checked_path(destination, member.name)
            if member.issym() and allow_links:
                if PurePosixPath(member.linkname).is_absolute():
                    raise ValueError('Absolute archive links are forbidden')
                target = destination / member.name
                if not (target.parent / member.linkname).resolve().is_relative_to(destination.resolve()):
                    raise ValueError('Archive link escapes destination')
                if any(other.name.startswith(member.name.rstrip('/') + '/') for other in members):
                    raise ValueError('Archive entries beneath a symbolic link are forbidden')
            elif not (member.isfile() or member.isdir()):
                raise ValueError('Archive links and special files are forbidden')
        for member in members:
            target = checked_path(destination, member.name)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o777)
        for member in members:
            if member.issym():
                target = checked_path(destination, member.name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
        for member in reversed(members):
            if member.isdir():
                checked_path(destination, member.name).chmod(member.mode & 0o777)


def validate_sqlite(path):
    with path.open('rb') as stream:
        if stream.read(16) != b'SQLite format 3\x00':
            return None
    connection = sqlite3.connect('file:' + str(path) + '?mode=ro&immutable=1', uri=True)
    try:
        rows = connection.execute('PRAGMA integrity_check').fetchall()
        if rows != [('ok',)]:
            raise ValueError('SQLite integrity validation failed: ' + path.name)
        if connection.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('SQLite foreign-key validation failed: ' + path.name)
        return {'integrity': 'ok', 'foreign_keys': 'ok'}
    finally:
        connection.close()


def file_manifest(root):
    result = {}
    databases = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError('Backup link escapes the data volume: ' + name)
            result[name] = {'type': 'symlink', 'target': os.readlink(path)}
        elif path.is_file():
            result[name] = {'sha256': digest(path), 'bytes': path.stat().st_size}
            database = validate_sqlite(path)
            if database:
                databases[name] = database
        elif path.is_dir():
            result[name] = {'type': 'directory'}
        else:
            raise ValueError('Backup contains a special file')
    return result, databases


def verify_files(root, manifest, ignored=()):
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*')}
    if actual - set(ignored) != set(manifest):
        raise ValueError('Artifact file coverage does not match manifest')
    for name, expected in manifest.items():
        path = checked_path(root, name)
        if expected.get('type') == 'directory':
            if not path.is_dir() or path.is_symlink():
                raise ValueError('Artifact directory mismatch: ' + name)
            continue
        if expected.get('type') == 'symlink':
            if not path.is_symlink() or os.readlink(path) != expected['target']:
                raise ValueError('Artifact link mismatch: ' + name)
            continue
        if path.is_symlink() or not path.is_file() or path.stat().st_size != expected['bytes'] or digest(path) != expected['sha256']:
            raise ValueError('Artifact checksum mismatch: ' + name)


def verify_signature(archive, public_key):
    signature = archive.with_name(archive.name + '.sig')
    if not signature.is_file() or not public_key.is_file():
        raise ValueError('Upgrade signature or public key is missing')
    # Domain-separated Ed25519 over streamed SHA-256 avoids buffering image archives.
    # The complete payload digest is verified before any parsing or extraction.
    with tempfile.NamedTemporaryFile() as message:
        message.write(b'park-box-release-v1\x00' + bytes.fromhex(digest(archive)))
        message.flush()
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(public_key),
                                 '-rawin', '-in', message.name, '-sigfile', str(signature)],
                                capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError('Upgrade signature is invalid')
