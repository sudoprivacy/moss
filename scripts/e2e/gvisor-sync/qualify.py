#!/usr/bin/env python3
"""Exercise native and sandbox sync calls against actual host errno injection."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

OPERATIONS = {
    'file-write-fsync', 'file-write-fdatasync', 'file-read-fsync',
    'existing-file-read-fsync', 'directory-read-fsync',
}
ERRORS = [0, 5, 28, 122]


def add_runtime_selection(parser):
    """Select deployment modes; omitted axes exercise the full CI matrix."""
    parser.add_argument('--platform', action='append', choices=['ptrace', 'systrap'])
    parser.add_argument('--filesystem', action='append', choices=['directfs', 'lisafs'])


def runtime_selection(args):
    """Share the same default matrix and deployment selectors between suites."""
    return (args.platform or ['ptrace', 'systrap'],
            [name == 'directfs' for name in (args.filesystem or ['directfs', 'lisafs'])])


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def verify_release(runtime, manifest, expected):
    """Verify the complete executable fileset before launching a runtime."""
    assert manifest.parent == runtime.parent
    assert digest(manifest) == expected, 'Release manifest differs from the reviewed candidate'
    files = json.loads(manifest.read_text())['files']
    assert files and 'runsc' in files
    observed = {}
    for path in sorted(runtime.parent.rglob('*')):
        assert not path.is_symlink(), 'Qualify materialized release files'
        if path.is_file() and path != manifest:
            observed[path.relative_to(runtime.parent).as_posix()] = digest(path)
    assert observed == files, 'Release files differ from the reviewed manifest'
    assert not os.environ.get('GVISOR_SIDECAR_BINARIES_DIR'), 'Qualify the reviewed release sidecars'
    return files


def run_logged(results, label, command, timeout=90, env=None):
    """Keep stdout, stderr and the actual exit status for one owned case."""
    with (results / (label + '.stdout.log')).open('wb') as out, \
         (results / (label + '.stderr.log')).open('wb') as err:
        process = subprocess.run(command, stdout=out, stderr=err, timeout=timeout, env=env)
    (results / (label + '.exit')).write_text(str(process.returncode))
    if process.returncode:
        with (results / (label + '.stderr.log')).open('rb') as error:
            error.seek(max(0, error.seek(0, os.SEEK_END) - 4096))
            print(label + ': ' + error.read().decode('utf-8', errors='replace'), file=sys.stderr, flush=True)
    assert process.returncode == 0, f'{label}: exit {process.returncode}; logs retained'
    return (results / (label + '.stdout.log')).read_text()


def runtime_command(runtime, state, bundle, debug_log, label, platform, is_directfs):
    """Use the same runtime configuration for syscall and Nexus qualification."""
    return [str(runtime), '--root=' + str(state), '--network=none',
            '--platform=' + platform, '--ignore-cgroups=true', '--overlay2=none',
            '--file-access=shared', '--directfs=' + str(is_directfs).lower(),
            '--debug-log=' + str(debug_log), 'run', '--bundle=' + str(bundle), label]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--sha256', required=True, help='Reviewed release manifest SHA256')
    parser.add_argument('--results', required=True, type=Path)
    parser.add_argument('--work-dir', type=Path)
    parser.add_argument('--expect', choices=['propagated', 'lost'], default='propagated')
    add_runtime_selection(parser)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('Run on an isolated Linux host or container with runtime namespace capabilities.')
    if os.uname().machine != 'x86_64':
        parser.error('The host fault fixture qualifies the Linux AMD64 syscall ABI.')
    runtime = args.runtime.resolve(strict=True)
    manifest = args.manifest.resolve(strict=True)
    files = verify_release(runtime, manifest, args.sha256)
    results = args.results.resolve()
    results.mkdir(parents=True, exist_ok=False)
    platforms, directfs_modes = runtime_selection(args)
    source = Path(__file__).resolve().parent
    work = (args.work_dir or results / 'workspace').resolve()
    work.mkdir(parents=True, exist_ok=False)
    bundle = work / 'bundle'
    rootfs = bundle / 'rootfs'
    (rootfs / 'data').mkdir(parents=True)
    (rootfs / 'proc').mkdir()
    (work / 'state').mkdir()
    receipt = {
        'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'runtime': str(runtime), 'runtimeSha256': digest(runtime),
        'manifestSha256': args.sha256, 'releaseFiles': files,
        'expect': args.expect, 'platforms': platforms, 'directfsModes': directfs_modes,
        'sources': {name: digest(source / name) for name in
                    ['qualify.py', 'gvisor-sync-probe.c', 'gvisor-sync-fault.c']},
        'method': 'An inherited host seccomp filter returns errno for fsync/fdatasync.',
        'cases': [], 'kernel': os.uname().release,
    }

    def run(label, command):
        return run_logged(results, label, command)

    def inspect(label, output, host_errno, is_sandbox):
        rows = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        assert len(rows) == len(OPERATIONS), (label, rows)
        assert {row['operation'] for row in rows} == OPERATIONS, (label, rows)
        expected = 0 if is_sandbox and args.expect == 'lost' else host_errno
        assert all(row['errno'] == expected and row['result'] == (-1 if expected else 0)
                   for row in rows), (label, expected, rows)
        receipt['cases'].append({'case': label, 'hostErrno': host_errno, 'observed': rows})
        print(json.dumps({'case': label, 'operations': len(rows), 'expectedErrno': expected}), flush=True)

    try:
        for name, target in [('gvisor-sync-probe.c', rootfs / 'probe'),
                             ('gvisor-sync-fault.c', work / 'fault')]:
            run('compile-' + name, ['nice', '-n', '10', 'cc', '-static', '-O2', '-Wall',
                                    '-Wextra', '-Werror', str(source / name), '-o', str(target)])
        receipt['probeSha256'] = digest(rootfs / 'probe')
        receipt['faultSha256'] = digest(work / 'fault')
        for error in ERRORS:
            label = 'native-' + str(error)
            directory = work / label
            directory.mkdir()
            (directory / 'existing-readonly-file').write_bytes(b'preexisting file')
            command = [str(rootfs / 'probe'), str(directory)]
            if error:
                command = [str(work / 'fault'), str(error), *command]
            inspect(label, run(label, command), error, False)
        for platform in platforms:
            for is_directfs in directfs_modes:
                for error in ERRORS:
                    label = platform + ('-direct-' if is_directfs else '-lisafs-') + str(error)
                    directory = work / label
                    directory.mkdir()
                    (directory / 'existing-readonly-file').write_bytes(b'preexisting file')
                    config = {
                        'ociVersion': '1.2.0', 'hostname': 'sync-qualification',
                        'process': {'terminal': False, 'user': {'uid': 0, 'gid': 0},
                                    'args': ['/probe', '/data'], 'env': ['PATH=/'], 'cwd': '/',
                                    'capabilities': {key: [] for key in
                                                     ['bounding', 'effective', 'inheritable', 'permitted', 'ambient']}},
                        'root': {'path': 'rootfs', 'readonly': True},
                        'mounts': [{'destination': '/proc', 'type': 'proc', 'source': 'proc'},
                                   {'destination': '/data', 'type': 'bind', 'source': str(directory),
                                    'options': ['rbind', 'rw']}],
                        'linux': {'namespaces': [{'type': kind} for kind in
                                                 ['pid', 'ipc', 'uts', 'mount', 'network']]},
                    }
                    (bundle / 'config.json').write_text(json.dumps(config))
                    command = runtime_command(runtime, work / 'state', bundle,
                                              results / (label + '.debug.log'), label, platform, is_directfs)
                    if error:
                        command = [str(work / 'fault'), str(error), *command]
                    try:
                        output = run(label, command)
                    finally:
                        # Each ID lives in this run's newly created private state root.
                        # Cleanup runs outside the child's inherited fault filter.
                        run(label + '-cleanup', [str(runtime), '--root=' + str(work / 'state'),
                                                'delete', '--force', label])
                    inspect(label, output, error, True)
        receipt['success'] = True
        receipt['hostSyncErrorPropagationQualified'] = args.expect == 'propagated'
        receipt['hardwarePersistenceQualified'] = False
    finally:
        receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (results / 'receipt.json').write_text(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
