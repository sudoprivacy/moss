#!/usr/bin/env python3
"""Exercise Nexus database and CAS recovery inside the reviewed gVisor release."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
from qualify import add_runtime_selection, digest, run_logged, runtime_command, runtime_selection, verify_release

SUITES = [
    ('database', ['lib-tests', 'file_durability::tests', 'redb_storage::tests',
                  '--test-threads=2', '--nocapture'],
     'test result: ok. 7 passed; 0 failed; 1 ignored;'),
    ('cas', ['cas-tests', '--test-threads=2', '--nocapture'],
     'test result: ok. 14 passed; 0 failed; 0 ignored;'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--payload', required=True, type=Path)
    parser.add_argument('--payload-sha256', required=True)
    parser.add_argument('--results', required=True, type=Path)
    parser.add_argument('--work-dir', type=Path)
    add_runtime_selection(parser)
    args = parser.parse_args()
    platforms, directfs_modes = runtime_selection(args)
    if sys.platform != 'linux' or os.geteuid() != 0 or os.uname().machine != 'x86_64':
        parser.error('Run on an isolated Linux AMD64 host with runtime namespace capabilities.')
    assert os.getpriority(os.PRIO_PROCESS, 0) == 0, 'Actual tests require normal priority'
    runtime = args.runtime.resolve(strict=True)
    manifest = args.manifest.resolve(strict=True)
    files = verify_release(runtime, manifest, args.sha256)
    payload = args.payload.resolve(strict=True)
    assert digest(payload) == args.payload_sha256
    programs = json.loads(payload.read_text())
    lock = json.loads(Path(__file__).with_name('nexus-source.lock.json').read_text())
    assert programs['sourceRevision'] == lock['revision']
    assert set(programs['files']) == {'lib-tests', 'cas-tests'}
    for name, expected in programs['files'].items():
        assert digest(payload.parent / name) == expected
    results = args.results.resolve()
    results.mkdir(parents=True, exist_ok=False)
    work = (args.work_dir or results / 'workspace').resolve()
    work.mkdir(parents=True, exist_ok=False)
    bundle = work / 'bundle'
    rootfs = bundle / 'rootfs'
    rootfs.mkdir(parents=True)
    for name in programs['files']:
        shutil.copyfile(payload.parent / name, rootfs / name)
        (rootfs / name).chmod(0o755)
    for directory in ['dev', 'proc', 'data', 'tools', 'usr', 'bin', 'lib', 'lib64']:
        (rootfs / directory).mkdir()
    compiler = Path(shutil.which('cc')).resolve(strict=True)
    wrapper = rootfs / 'tools/cc'
    wrapper.write_text('#!/bin/sh\nexec /usr/bin/nice -n 10 ' + shlex.quote(str(compiler)) + ' "$@"\n')
    wrapper.chmod(0o755)
    data, state = work / 'data', work / 'state'
    data.mkdir()
    state.mkdir()
    receipt = {
        'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'runtimeSha256': digest(runtime), 'manifestSha256': args.sha256, 'releaseFiles': files,
        'payloadSha256': args.payload_sha256, 'payload': programs, 'testNice': 0,
        'platforms': platforms, 'directfsModes': directfs_modes,
        'sources': {name: digest(Path(__file__).with_name(name)) for name in
                    ['nexus_storage.py', 'qualify.py', 'nexus-source.lock.json']},
        'cases': [], 'hardwarePersistenceQualified': False,
    }

    def record(label, command, expected, env=None):
        text = run_logged(results, label, command, timeout=240, env=env)
        assert expected in text, (label, expected, text)
        receipt['cases'].append({'case': label, 'expected': expected})
        print(json.dumps({'case': label, 'passed': True}), flush=True)

    try:
        for label, command, expected in SUITES:
            directory = data / ('native-' + label)
            directory.mkdir()
            environment = {**os.environ, 'TMPDIR': str(directory),
                           'PATH': str(rootfs / 'tools') + ':/usr/bin:/bin'}
            record('native-' + label, [str(rootfs / command[0]), *command[1:]], expected, environment)
        for platform in platforms:
            for is_directfs in directfs_modes:
                for suite, command, expected in SUITES:
                    label = platform + ('-direct-' if is_directfs else '-lisafs-') + suite
                    directory = data / label
                    directory.mkdir()
                    mounts = [
                        {'destination': '/proc', 'type': 'proc', 'source': 'proc'},
                        {'destination': '/dev', 'type': 'tmpfs', 'source': 'tmpfs',
                         'options': ['nosuid', 'mode=755']},
                        {'destination': '/data', 'type': 'bind', 'source': str(directory),
                         'options': ['rbind', 'rw']},
                    ]
                    # These read-only OS paths belong to the isolated test host/container.
                    for path in ['/usr', '/bin', '/lib', '/lib64']:
                        mounts.append({'destination': path, 'type': 'bind', 'source': path,
                                       'options': ['rbind', 'ro']})
                    config = {
                        'ociVersion': '1.2.0', 'hostname': 'nexus-storage-qualification',
                        'process': {
                            'terminal': False, 'user': {'uid': 0, 'gid': 0},
                            'args': ['/' + command[0], *command[1:]],
                            'env': ['TMPDIR=/data', 'PATH=/tools:/usr/bin:/bin'], 'cwd': '/',
                            'capabilities': {key: [] for key in
                                             ['bounding', 'effective', 'inheritable', 'permitted', 'ambient']},
                        },
                        'root': {'path': 'rootfs', 'readonly': True}, 'mounts': mounts,
                        'linux': {
                            'namespaces': [{'type': kind} for kind in
                                           ['pid', 'ipc', 'uts', 'mount', 'network']],
                            'devices': [
                                {'path': '/dev/' + device, 'type': 'c', 'major': 1, 'minor': minor,
                                 'fileMode': 0o666, 'uid': 0, 'gid': 0}
                                for device, minor in [('null', 3), ('zero', 5), ('random', 8), ('urandom', 9)]]
                        },
                    }
                    (bundle / 'config.json').write_text(json.dumps(config))
                    invocation = runtime_command(runtime, state, bundle, results / (label + '.debug.log'),
                                                 label, platform, is_directfs)
                    try:
                        record(label, invocation, expected)
                    finally:
                        run_logged(results, label + '-cleanup', [str(runtime), '--root=' + str(state),
                                                                'delete', '--force', label])
        receipt['success'] = True
    finally:
        receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (results / 'receipt.json').write_text(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
