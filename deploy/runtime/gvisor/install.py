#!/usr/bin/env python3
"""Stage immutable gVisor releases and register a versioned containerd handler."""
import argparse
import base64
import json
import os
from pathlib import Path
import stat
import shutil
import sys
import tempfile
from release import sha256, verified_archive, verify_archive, verify_release


def sync_directory(path):
    """Complete a host namespace barrier for an owned installation directory."""
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sync_ancestors(directory):
    """Retry the entire namespace chain, including ancestors from an earlier failed install."""
    for path in reversed([directory, *directory.parents]):
        sync_directory(path)


def prepare_prefix(prefix):
    """Create public executable ancestors, preserving existing directory modes."""
    missing = []
    current = prefix
    while not current.exists():
        missing.append(current)
        current = current.parent
    verify_ancestors(current)
    for path in reversed(missing):
        try:
            path.mkdir(mode=0o755)
        except FileExistsError:
            pass
        else:
            path.chmod(0o755)
            sync_directory(path.parent)
    verify_prefix(prefix)
    sync_ancestors(prefix)


def verify_ancestors(directory):
    """Protect executable names from replacement by another OS user."""
    for path in [directory, *directory.parents]:
        if path.is_symlink() or not stat.S_ISDIR(path.stat().st_mode):
            raise ValueError('Runtime ancestors must be materialized directories: ' + str(path))
        info = path.stat()
        if not info.st_mode & stat.S_IXOTH:
            raise ValueError('Runtime ancestor must allow Sentry search: ' + str(path))
        if info.st_uid not in (0, os.geteuid()) or (info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX):
            raise ValueError('Runtime ancestor permits another writer: ' + str(path))


def verify_prefix(prefix):
    """Require the installer to own the protected, publicly searchable version store."""
    verify_ancestors(prefix)
    if prefix.stat().st_uid != os.geteuid() or prefix.stat().st_mode & 0o022:
        raise ValueError('Runtime prefix must be owned by the installer and protected from other writers')


def installation_paths(destination, manifest_sha):
    """Derive every handler path from one immutable release identity."""
    archive_sha = sha256(destination.name)
    handler = 'moss-gv-' + base64.b32encode(bytes.fromhex(archive_sha)).decode().rstrip('=').lower()
    return {'installed': str(destination), 'manifestSha256': manifest_sha,
            'archiveSha256': archive_sha, 'handler': handler,
            'runsc': str(destination / 'bin/runsc'),
            'shim': str(destination / 'bin/containerd-shim-runsc-v1'),
            'shimConfig': str(destination / 'shim.toml')}


def shim_config(paths):
    """Keep a handler's executable and ephemeral runtime root in its own version."""
    return ('binary_name = ' + json.dumps(paths['runsc']) + '\nroot = ' +
            json.dumps('/run/moss-gvisor/' + paths['archiveSha256']) + '\n')


def verify_installed(destination, manifest_sha):
    """Verify immutable bytes, paths and configuration through one host seam."""
    if destination.is_symlink():
        raise ValueError('Installed runtime must be a materialized directory')
    verify_prefix(destination.parent)
    files = verify_release(destination / 'bin/runsc', destination / 'bin/manifest.json', manifest_sha)
    expected = {'LICENSE', 'provenance.json', 'shim.toml', 'bin/manifest.json'} | {'bin/' + name for name in files}
    observed = set()
    for path in destination.rglob('*'):
        if path.is_symlink():
            raise ValueError('Installed runtime must contain materialized files')
        if path.is_file():
            observed.add(path.relative_to(destination).as_posix())
    if observed != expected:
        raise ValueError('Installed runtime files differ')
    paths = installation_paths(destination, manifest_sha)
    if (destination / 'shim.toml').read_text() != shim_config(paths):
        raise ValueError('Installed shim configuration differs')
    return paths


def stage(archive, archive_sha, manifest_sha, prefix):
    """Verify a whole archive and publish one complete, immutable version directory."""
    if sys.platform != 'linux':
        raise RuntimeError('This host runtime installer supports Linux')
    import fcntl
    sha256(manifest_sha)
    with verified_archive(archive, archive_sha) as bundle:
        verify_archive(bundle, manifest_sha)
        members = bundle.getmembers()
        prefix = Path(prefix).absolute()
        if prefix != prefix.resolve():
            raise ValueError('Runtime prefix must be a canonical path')
        prepare_prefix(prefix)
        descriptor = os.open(prefix, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            destination = prefix / archive_sha
            paths = installation_paths(destination, manifest_sha)
            if destination.exists():
                verify_installed(destination, manifest_sha)
                for name in ['LICENSE', 'provenance.json']:
                    if (destination / name).read_bytes() != bundle.extractfile(name).read():
                        raise ValueError('Installed release metadata differs')
                for file in destination.rglob('*'):
                    if file.is_file():
                        with file.open('rb') as stream:
                            os.fsync(stream.fileno())
                for directory in sorted([destination, *(file for file in destination.rglob('*') if file.is_dir())], key=lambda path: len(path.parts), reverse=True):
                    sync_directory(directory)
                sync_directory(prefix)
                return {**paths, 'changed': False}
            with tempfile.TemporaryDirectory(prefix='.stage-', dir=prefix) as temporary:
                staged = Path(temporary) / 'release'
                staged.mkdir(mode=0o755)
                staged.chmod(0o755)
                for member in members:
                    path = staged / member.name
                    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                    with bundle.extractfile(member) as source, path.open('xb') as target:
                        shutil.copyfileobj(source, target)
                        os.fchmod(target.fileno(), 0o555 if member.name.startswith('bin/') and member.name != 'bin/manifest.json' else 0o444)
                        target.flush()
                        os.fsync(target.fileno())
                verify_release(staged / 'bin/runsc', staged / 'bin/manifest.json', manifest_sha)
                config = staged / 'shim.toml'
                with config.open('x') as file:
                    file.write(shim_config(paths))
                    os.fchmod(file.fileno(), 0o444)
                    file.flush()
                    os.fsync(file.fileno())
                for directory in sorted((path for path in staged.rglob('*') if path.is_dir()), key=lambda path: len(path.parts), reverse=True):
                    directory.chmod(0o755)
                    sync_directory(directory)
                sync_directory(staged)
                staged.rename(destination)
                sync_directory(prefix)
            return {**paths, 'changed': True}
        finally:
            os.close(descriptor)


def runtime_stanza(paths, config_version):
    """Render the versioned handler for the host's actual containerd schema."""
    plugin = {2: 'io.containerd.grpc.v1.cri', 3: 'io.containerd.cri.v1.runtime'}[config_version]
    table = 'plugins.' + json.dumps(plugin) + '.containerd.runtimes.' + json.dumps(paths['handler'])
    return ('[' + table + ']\nruntime_type = "io.containerd.runsc.v1"\nruntime_path = ' +
            json.dumps(paths['shim']) + '\n[' + table + '.options]\nTypeUrl = "io.containerd.runsc.v1.options"\nConfigPath = ' +
            json.dumps(paths['shimConfig']) + '\n')


def register_template(installed, manifest_sha, template, config_version):
    """Append one exact handler, retaining all existing template configuration."""
    if sys.platform != 'linux':
        raise RuntimeError('This host runtime installer supports Linux')
    import fcntl
    installed, template = Path(installed).absolute(), Path(template)
    if not template.parent.is_dir():
        raise ValueError('Containerd template directory must already exist')
    sync_ancestors(template.parent)
    descriptor = os.open(template.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        paths = verify_installed(installed, sha256(manifest_sha))
        return write_template(paths, template, config_version)
    finally:
        os.close(descriptor)


def write_template(paths, template, config_version):
    """Publish a complete template while holding its containing directory's lock."""
    stanza = runtime_stanza(paths, config_version)
    if template.is_symlink():
        raise ValueError('Containerd template must be a materialized file')
    previous = template.read_text() if template.exists() else '{{ template "base" . }}\n'
    if stanza in previous and previous.count(paths['handler']) == 2:
        return {**paths, 'changed': False}
    if paths['handler'] in previous:
        raise ValueError('Existing runtime handler configuration differs')
    previous_info = template.stat() if template.exists() else None
    mode = stat.S_IMODE(previous_info.st_mode) if previous_info else 0o600
    with tempfile.NamedTemporaryFile(mode='w', dir=template.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(previous.rstrip('\n') + '\n\n' + stanza)
            if previous_info:
                os.fchown(file.fileno(), previous_info.st_uid, previous_info.st_gid)
            os.fchmod(file.fileno(), mode)
            file.flush()
            os.fsync(file.fileno())
            file.close()
            temporary.replace(template)
            sync_directory(template.parent)
        finally:
            file.close()
            temporary.unlink(missing_ok=True)
    return {**paths, 'changed': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    staging = commands.add_parser('stage')
    staging.add_argument('--archive', required=True, type=Path)
    staging.add_argument('--sha256', required=True)
    staging.add_argument('--manifest-sha256', required=True)
    staging.add_argument('--prefix', type=Path, default=Path('/opt/moss/runtimes/gvisor'))
    registration = commands.add_parser('register-template')
    registration.add_argument('--installed', required=True, type=Path)
    registration.add_argument('--manifest-sha256', required=True)
    registration.add_argument('--template', required=True, type=Path)
    registration.add_argument('--config-version', required=True, type=int, choices=[2, 3])
    args = parser.parse_args()
    result = (stage(args.archive, args.sha256, args.manifest_sha256, args.prefix) if args.command == 'stage'
              else register_template(args.installed, args.manifest_sha256, args.template, args.config_version))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
