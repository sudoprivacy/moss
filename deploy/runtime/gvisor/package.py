#!/usr/bin/env python3
"""Package complete build output; qualification then exercises the installed archive."""
import argparse
import gzip
import io
import json
from pathlib import Path
import re
import tarfile
from release import digest, release_metadata, verify_release


def package(build, source, output):
    """Produce a portable archive with stable bytes and durable build provenance."""
    tools = Path(__file__).resolve().parent
    lock = json.loads((tools / 'runtime.lock.json').read_text())
    if not re.fullmatch('[0-9A-Za-z][0-9A-Za-z._-]*', lock['version']):
        raise ValueError('A portable release version is required')
    receipt = json.loads((build / 'build.json').read_text())
    if (not receipt.get('success') or receipt['baseline'] or
            receipt['sourceCommit'] != lock['source']['commit'] or
            receipt['sourceArchiveSha256'] != lock['source']['sha256'] or
            receipt['lockSha256'] != digest(tools / 'runtime.lock.json') or
            receipt['sourceImages'] != lock['patch']['after']):
        raise ValueError('A successful build of the exact pinned backport is required')
    expected_recipe = {name: digest(tools / name) for name in
                       ['build.py', 'release.py', 'runtime.lock.json', 'sync-errors.patch',
                        'Dockerfile', 'install-build-deps.sh']}
    if receipt.get('recipeFiles') != expected_recipe:
        raise ValueError('Build producer bytes differ from the current recipe')
    release = build / 'release'
    files = verify_release(release / 'runsc', release / 'manifest.json', receipt['manifestSha256'])
    if files != receipt['releaseFiles']:
        raise ValueError('Build receipt differs from the release files')
    if json.loads((release / 'manifest.json').read_text())['version'] != lock['version']:
        raise ValueError('Build version differs from the release pin')
    provenance = {
        'version': lock['version'], 'architecture': 'linux-amd64',
        'upstream': lock['source'], 'lockSha256': receipt['lockSha256'],
        'manifestSha256': receipt['manifestSha256'], 'sourceImages': receipt['sourceImages'],
        'recipeFiles': receipt['recipeFiles'], 'packagerSha256': digest(Path(__file__)),
    }
    metadata = {'LICENSE': (source / 'LICENSE').read_bytes(),
                'provenance.json': json.dumps(provenance, indent=2).encode(),
                'bin/manifest.json': (release / 'manifest.json').read_bytes()}
    output.mkdir(parents=True, exist_ok=False)
    filename = 'gvisor-' + lock['version'] + '-linux-amd64.tar.gz'
    archive = output / filename
    with archive.open('xb') as file, gzip.GzipFile(filename='', mode='wb', compresslevel=1, fileobj=file, mtime=0) as compressed, \
            tarfile.open(fileobj=compressed, mode='w') as tar:
        for name in sorted([*metadata, *('bin/' + name for name in files)]):
            member = tarfile.TarInfo(name)
            member.uid = member.gid = member.mtime = 0
            member.uname = member.gname = ''
            if name in metadata:
                raw = metadata[name]
                member.mode, member.size = 0o644, len(raw)
                tar.addfile(member, io.BytesIO(raw))
            else:
                path = release / name.removeprefix('bin/')
                member.mode, member.size = 0o555, path.stat().st_size
                with path.open('rb') as stream:
                    tar.addfile(member, stream)
    result = {'version': lock['version'], 'architecture': 'linux-amd64', 'filename': filename,
              'archiveSha256': digest(archive), 'manifestSha256': receipt['manifestSha256'],
              'archiveBytes': archive.stat().st_size}
    (output / 'release.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    (output / 'SHA256SUMS').write_text(result['archiveSha256'] + '  ' + filename + '\n', encoding='utf-8')
    return result


def qualify(distribution, installation, syscalls, storage, shim, revision):
    """Bind a packaged archive to its actual installed full-matrix qualification."""
    result = release_metadata(json.loads((distribution / 'release.json').read_text()))
    installed, calls, nexus, runtime = [json.loads(path.read_text()) for path in [installation, syscalls, storage, shim]]
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('An exact source revision is required')
    if (installed['archiveSha256'] != result['archiveSha256'] or
            installed['manifestSha256'] != result['manifestSha256'] or
            digest(distribution / result['filename']) != result['archiveSha256']):
        raise ValueError('Qualification must exercise the packaged archive')
    for receipt, count in [(calls, 20), (nexus, 10)]:
        if (not receipt.get('success') or receipt['manifestSha256'] != result['manifestSha256'] or
                receipt['platforms'] != ['ptrace', 'systrap'] or receipt['directfsModes'] != [True, False] or
                len(receipt['cases']) != count or len({case['case'] for case in receipt['cases']}) != count or
                receipt['releaseLibrarySha256'] != digest(Path(__file__).with_name('release.py'))):
            raise ValueError('The installed full runtime matrix must pass')
    if calls['runtime'] != installed['runsc'] or calls['expect'] != 'propagated' or not calls['hostSyncErrorPropagationQualified']:
        raise ValueError('Candidate qualification must preserve injected host errors')
    if calls['runtimeSha256'] != nexus['runtimeSha256']:
        raise ValueError('Syscall and Nexus suites must exercise the same executable')
    if (not runtime.get('success') or runtime['manifestSha256'] != result['manifestSha256'] or
            runtime['installation']['archiveSha256'] != result['archiveSha256'] or
            runtime['runtimeSha256'] != calls['runtimeSha256']):
        raise ValueError('The distributed shim must pass private containerd qualification')
    proof = {'sourceRevision': revision, 'release': result, 'installation': installed,
             'syscalls': calls, 'nexus': nexus, 'shim': runtime, 'success': True,
             'hardwarePersistenceQualified': False}
    (distribution / 'qualification.json').write_text(json.dumps(proof, indent=2), encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('build')
    build.add_argument('--build', required=True, type=Path)
    build.add_argument('--source', required=True, type=Path)
    build.add_argument('--output', required=True, type=Path)
    qualification = commands.add_parser('qualify')
    qualification.add_argument('--distribution', required=True, type=Path)
    qualification.add_argument('--installation', required=True, type=Path)
    qualification.add_argument('--syscalls', required=True, type=Path)
    qualification.add_argument('--storage', required=True, type=Path)
    qualification.add_argument('--shim', required=True, type=Path)
    qualification.add_argument('--revision', required=True)
    args = parser.parse_args()
    result = (package(args.build, args.source, args.output) if args.command == 'build' else
              qualify(args.distribution, args.installation, args.syscalls, args.storage, args.shim, args.revision))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
