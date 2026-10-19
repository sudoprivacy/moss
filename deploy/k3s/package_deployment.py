#!/usr/bin/env python3
"""Bundle Moss deployment adapters with exact-source Sudostack image tools."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
LOCK = HERE / 'sudostack-images.lock.json'


def package(output, shared_source, lock_path=LOCK):
    lock_bytes = lock_path.read_bytes()
    lock = json.loads(lock_bytes)
    if lock.get('repository') != 'sudoprivacy/sudostack' or not re.fullmatch(r'[a-f0-9]{40}', lock.get('revision', '')):
        raise ValueError('A pinned Sudostack source revision is required')
    if set(lock.get('files', {})) != {'tools/deploy/images.py', 'tools/deploy/artifacts.py'}:
        raise ValueError('Unexpected shared image tools')
    files = {'sudostack-images.lock.json': lock_bytes}
    for name, expected in lock['files'].items():
        path = shared_source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing shared image tool: ' + name)
        content = path.read_bytes()
        if not re.fullmatch(r'[a-f0-9]{64}', expected) or hashlib.sha256(content).hexdigest() != expected:
            raise ValueError('Shared image tool checksum mismatch: ' + name)
        compile(content.decode('utf-8'), name, 'exec')
        files[path.name] = content
    for name in ['control.py', 'install-control.sh', 'fetch-offline-deps.sh']:
        files[name] = (HERE / name).read_bytes()
    files['server.json'] = (HERE.parent / 'server.json').read_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.', suffix='.part', delete=False) as stream:
        temporary = Path(stream.name)
    try:
        with tarfile.open(temporary, 'w:gz') as bundle:
            for name, content in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.size, member.mode = len(content), 0o644
                bundle.addfile(member, io.BytesIO(content))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--shared-source', required=True, type=Path)
    args = parser.parse_args()
    package(args.output, args.shared_source)


if __name__ == '__main__':
    main()
