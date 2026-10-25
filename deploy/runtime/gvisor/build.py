#!/usr/bin/env python3
"""Build the pinned runtime and verify the backport's exact source images."""
import argparse
import datetime
import hashlib
import inspect
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def acquire(url, expected, path):
    if path.exists():
        assert digest(path) == expected, f'Cached input checksum differs: {path}'
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        staged = Path(output.name)
        try:
            with urllib.request.urlopen(url, timeout=180) as response:
                shutil.copyfileobj(response, output)
            output.close()
            assert digest(staged) == expected, f'Download checksum differs: {url}'
            staged.replace(path)
        finally:
            staged.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--baseline', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    lock = json.loads((root / 'runtime.lock.json').read_text())
    assert os.uname().machine == lock['architecture'], 'This runtime recipe qualifies Linux AMD64'
    work, output, cache = [path.resolve() for path in [args.workspace, args.output, args.cache]]
    work.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'baseline': args.baseline, 'lockSha256': digest(root / 'runtime.lock.json'),
               'sourceCommit': lock['source']['commit'], 'sourceArchiveSha256': lock['source']['sha256']}

    def run(label, command, cwd=None):
        with (output / (label + '.stdout.log')).open('wb') as out, \
             (output / (label + '.stderr.log')).open('wb') as err:
            result = subprocess.run(command, cwd=cwd, stdout=out, stderr=err, check=False)
        assert result.returncode == 0, f'{label}: exit {result.returncode}; logs retained'

    try:
        archive = cache / ('source-' + lock['source']['commit'] + '.tar.gz')
        acquire(lock['source']['url'], lock['source']['sha256'], archive)
        source = work
        marker = work / '.moss-source.json'
        if not marker.exists():
            assert not list(source.iterdir()), 'An incomplete source extraction needs review'
            with tarfile.open(archive) as tar:
                members = []
                for member in tar:
                    parts = Path(member.name).parts
                    assert parts[0] == 'gvisor-' + lock['source']['commit'], member.name
                    if len(parts) == 1:
                        continue
                    member.name = str(Path(*parts[1:]))
                    target = (work / member.name).resolve()
                    assert target.is_relative_to(source), member.name
                    assert member.isfile() or member.isdir() or member.issym(), member.name
                    if member.issym():
                        assert (target.parent / member.linkname).resolve().is_relative_to(source), member.name
                    members.append(member)
                # Debian's supported Python 3.11 predates the filter argument.
                # Check each resolved destination at extraction time as links
                # appear, keep ownership local and strip special mode bits.
                filters = {'filter': 'data'} if 'filter' in inspect.signature(tar.extract).parameters else {}
                for member in members:
                    assert (work / member.name).resolve().is_relative_to(source), member.name
                    if member.issym():
                        assert ((work / member.name).parent / member.linkname).resolve().is_relative_to(source), member.name
                    member.uid, member.gid = os.getuid(), os.getgid()
                    member.uname = member.gname = ''
                    member.mode &= 0o755
                    tar.extract(member, work, **filters)
                for member in members:
                    assert (work / member.name).resolve().is_relative_to(source), member.name
            marker.write_text(json.dumps(lock['source']))
        assert json.loads(marker.read_text()) == lock['source']
        assert (source / 'images/default/bazelversion').read_text().strip() == lock['bazel']['version']
        assert '\ngo ' + lock['go'] + '\n' in (source / 'go.mod').read_text()
        current = {name: digest(source / name) for name in lock['patch']['before']}
        if args.baseline:
            assert current == lock['patch']['before'], 'Baseline requires pristine upstream source'
        else:
            assert digest(root / lock['patch']['file']) == lock['patch']['sha256']
            if current == lock['patch']['before']:
                run('apply-patch', ['patch', '--batch', '--forward', '--fuzz=0', '-p1',
                                    '-i', str(root / lock['patch']['file'])], source)
            after = {name: digest(source / name) for name in current}
            assert after == lock['patch']['after'], {'observed': after, 'expected': lock['patch']['after']}
        receipt['sourceImages'] = {name: digest(source / name) for name in current}
        bazel = cache / ('bazel-' + lock['bazel']['version'])
        acquire(lock['bazel']['url'], lock['bazel']['sha256'], bazel)
        bazel.chmod(0o755)
        version = lock['source']['tag'] if args.baseline else lock['version']
        status = output / 'workspace-status.sh'
        assert all(c.isalnum() or c in '.-_' for c in version)
        status.write_text('#!/bin/sh\nprintf "STABLE_VERSION ' + version + '\\n"\n')
        status.chmod(0o755)
        command = ['nice', '-n', '10', str(bazel), '--batch',
                   '--output_user_root=' + str(cache / ('bazel-' + lock['bazel']['version'] + '-sandbox-cache')),
                   '--host_jvm_args=-Xmx1024m', '--host_jvm_args=-XX:ActiveProcessorCount=1', 'build',
                   '--config=x86_64', '--compilation_mode=opt',
                   '--jobs=1', '--loading_phase_threads=1', '--local_resources=cpu=1',
                   '--local_resources=memory=2048', '--spawn_strategy=processwrapper-sandbox',
                   '--repository_cache=' + str(cache / ('bazel-' + lock['bazel']['version'] + '-cache/cache/repos/v1')),
                   '--action_env=GOMAXPROCS=1', '--host_action_env=GOMAXPROCS=1',
                   '--action_env=GOFLAGS=-p=1', '--host_action_env=GOFLAGS=-p=1',
                   '--workspace_status_command=' + str(status), '//:release']
        if not args.baseline:
            command.append('//pkg/sentry/fsimpl/gofer:gofer_test')
        receipt['buildCommand'] = command
        run('build', command, source)
        if not args.baseline:
            # The compiler job has ended. Actual tests inherit normal priority.
            receipt['testNice'] = os.getpriority(os.PRIO_PROCESS, 0)
            assert receipt['testNice'] == 0
            run('gofer-tests', [str(source / 'bazel-bin/pkg/sentry/fsimpl/gofer/gofer_test_/gofer_test'),
                                '-test.v', '-test.timeout=2m'], source)
        release = output / 'release'
        shutil.copytree(source / 'bazel-bin/release', release, symlinks=False)
        files = {}
        for path in sorted(release.rglob('*')):
            if path.is_file():
                path.chmod(0o755)
                files[path.relative_to(release).as_posix()] = digest(path)
        assert 'runsc' in files and 'containerd-shim-runsc-v1' in files
        assert 'gvisor-bin/gvisor_sentry' in files
        manifest = release / 'manifest.json'
        manifest.write_text(json.dumps({'version': version, 'files': files}, indent=2))
        receipt['releaseFiles'] = files
        receipt['manifestSha256'] = digest(manifest)
        binary = release / 'runsc'
        receipt['binarySha256'] = digest(binary)
        run('version', [str(binary), '--version'])
        receipt['version'] = (output / 'version.stdout.log').read_text().strip()
        assert receipt['version'].splitlines()[0] == 'runsc version ' + version
        receipt['success'] = True
    finally:
        receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / 'build.json').write_text(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
