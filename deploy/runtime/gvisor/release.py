"""Verified full-release files and atomic artifact downloads for build and installation."""
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import tarfile
import urllib.request


def sha256(value):
    """Validate an external SHA256 before using it as a trust or path boundary."""
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('A lowercase SHA256 digest is required')
    return value


def digest(path):
    """Hash in bounded memory on the installer's Python 3.9+ baseline."""
    with Path(path).open('rb') as file:
        return stream_digest(file)


def stream_digest(file):
    """Hash the remaining bytes of an open descriptor or archive member."""
    result = hashlib.sha256()
    for block in iter(lambda: file.read(1024 * 1024), b''):
        result.update(block)
    return result.hexdigest()


def relative_file(name):
    """Accept one canonical, portable relative file path."""
    if not isinstance(name, str):
        raise ValueError('A relative file name is required')
    path = PurePosixPath(name)
    if (not name or not path.parts or path.is_absolute() or path.as_posix() != name or
            any(part in ('.', '..') for part in path.parts) or '\\' in name or ':' in name or '\0' in name):
        raise ValueError('Unsafe release file name: ' + name)
    return name


def manifest_files(raw):
    """Validate the manifest's complete executable fileset."""
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate manifest key: ' + key)
            result[key] = value
        return result
    manifest = json.loads(raw, object_pairs_hook=unique)
    files = manifest.get('files') if isinstance(manifest, dict) else None
    if not isinstance(files, dict) or not files or 'runsc' not in files:
        raise ValueError('A release manifest with runsc is required')
    for name, expected in files.items():
        relative_file(name)
        sha256(expected)
    if 'manifest.json' in files:
        raise ValueError('The manifest must describe its payload files')
    return files


@contextmanager
def verified_archive(path, expected):
    """Read the inode whose bytes were authenticated, including atomic cache replacement."""
    with Path(path).open('rb') as file:
        if stream_digest(file) != sha256(expected):
            raise ValueError('Runtime archive checksum differs')
        file.seek(0)
        with tarfile.open(fileobj=file, mode='r:gz') as archive:
            yield archive


def verify_archive(archive, manifest_sha):
    """Verify regular portable members, complete contents and one manifest identity."""
    members = archive.getmembers()
    names = [relative_file(member.name) for member in members]
    if len(names) != len(set(names)) or any(not member.isfile() for member in members):
        raise ValueError('Runtime archive must contain unique regular files')
    if 'bin/manifest.json' not in names:
        raise ValueError('Runtime archive manifest is missing')
    member = archive.getmember('bin/manifest.json')
    if member.size > 1024 * 1024:
        raise ValueError('Runtime manifest is too large')
    raw = archive.extractfile(member).read()
    if hashlib.sha256(raw).hexdigest() != sha256(manifest_sha):
        raise ValueError('Runtime archive manifest differs')
    files = manifest_files(raw)
    if not {'runsc', 'containerd-shim-runsc-v1', 'gvisor-bin/gvisor_sentry'} <= files.keys():
        raise ValueError('A complete runsc, shim and Sentry release is required')
    expected = {'LICENSE', 'provenance.json', 'bin/manifest.json'} | {'bin/' + name for name in files}
    if set(names) != expected:
        raise ValueError('Runtime archive files differ from its complete manifest')
    for name in ['LICENSE', 'provenance.json']:
        if archive.getmember(name).size > 1024 * 1024:
            raise ValueError('Runtime metadata is too large')
    provenance = json.loads(archive.extractfile('provenance.json').read())
    if not isinstance(provenance, dict) or provenance.get('manifestSha256') != manifest_sha:
        raise ValueError('Runtime provenance differs from its manifest')
    for member in members:
        if member.name.startswith('bin/') and member.name != 'bin/manifest.json':
            with archive.extractfile(member) as file:
                if stream_digest(file) != files[member.name.removeprefix('bin/')]:
                    raise ValueError('Runtime archive files differ from the manifest')
    return json.loads(raw)


def release_metadata(value):
    """Validate the portable distribution identity shared by qualification and publication."""
    if not isinstance(value, dict) or not re.fullmatch('[0-9A-Za-z][0-9A-Za-z._-]*', value.get('version', '')):
        raise ValueError('A portable release version is required')
    if value.get('architecture') != 'linux-amd64' or value.get('filename') != 'gvisor-' + value['version'] + '-linux-amd64.tar.gz':
        raise ValueError('A complete Linux AMD64 release is required')
    sha256(value.get('archiveSha256'))
    sha256(value.get('manifestSha256'))
    return value


def verify_release(runtime, manifest, expected):
    """Verify every release file before launching any executable or sidecar."""
    runtime, manifest = Path(runtime), Path(manifest)
    if manifest.parent != runtime.parent or manifest.is_symlink():
        raise ValueError('Runtime and materialized manifest must share a directory')
    if digest(manifest) != sha256(expected):
        raise ValueError('Release manifest differs from the reviewed candidate')
    files = manifest_files(manifest.read_bytes())
    observed = {}
    for path in sorted(runtime.parent.rglob('*')):
        if path.is_symlink():
            raise ValueError('Qualify materialized release files')
        if path.is_file() and path != manifest:
            observed[path.relative_to(runtime.parent).as_posix()] = digest(path)
    if observed != files:
        raise ValueError('Release files differ from the reviewed manifest')
    if os.environ.get('GVISOR_SIDECAR_BINARIES_DIR'):
        raise ValueError('Qualify the reviewed release sidecars')
    return files


def acquire(urls, expected, path):
    """Download a verified complete file, retaining an existing verified cache hit."""
    expected = sha256(expected)
    path = Path(path)
    if path.is_symlink():
        raise ValueError('Artifact cache must contain materialized files')
    if path.exists():
        if digest(path) != expected:
            raise ValueError('Cached input checksum differs: ' + str(path))
        return
    if isinstance(urls, str):
        urls = [urls]
    if not urls:
        raise ValueError('An artifact source is required')
    errors = []
    for url in urls:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
            staged = Path(output.name)
            try:
                with urllib.request.urlopen(url, timeout=180) as response:
                    shutil.copyfileobj(response, output)
                output.close()
                if digest(staged) != expected:
                    raise ValueError('Download checksum differs')
                staged.replace(path)
                return
            except (OSError, ValueError) as error:
                errors.append(url + ': ' + str(error))
            finally:
                output.close()
                staged.unlink(missing_ok=True)
    raise OSError('Artifact sources failed: ' + '; '.join(errors))
