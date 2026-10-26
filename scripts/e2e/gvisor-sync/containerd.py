#!/usr/bin/env python3
"""Exercise an installed shim through a private containerd and CRI-shaped containers."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from deploy.runtime.gvisor.install import register_template, verify_installed
from deploy.runtime.gvisor.release import digest
from qualify import run_logged


def wait_for_file(path, process):
    """Bound readiness by the running producer, retaining failures for diagnosis."""
    deadline = time.monotonic() + 30
    while not path.exists() and time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Producer exited before readiness; inspect retained logs')
        time.sleep(.1)
    if not path.exists():
        raise TimeoutError('Producer did not publish readiness: ' + str(path))


def live_release_processes(installed, files, namespace):
    """Hash each actual executable inode once while both guest containers are alive."""
    observed, hashed = [], {}
    for process in Path('/proc').iterdir():
        if not process.name.isdecimal():
            continue
        try:
            executable = (process / 'exe').resolve(strict=True)
            if not executable.is_relative_to(installed / 'bin'):
                continue
            arguments = (process / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            if namespace not in arguments:
                continue
            relative = executable.relative_to(installed / 'bin').as_posix()
            info = (process / 'exe').stat()
            identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            if identity not in hashed:
                hashed[identity] = digest(process / 'exe')
            if hashed[identity] != files[relative]:
                raise ValueError('Running executable differs from the installed manifest')
            observed.append({'pid': int(process.name), 'executable': relative, 'sha256': hashed[identity],
                             'args': arguments})
        except (FileNotFoundError, ProcessLookupError):
            continue
    if not {'containerd-shim-runsc-v1', 'gvisor-bin/gvisor_sentry'} <= {row['executable'] for row in observed}:
        raise ValueError('The installed shim and Sentry must both be running')
    return observed


def qualify(args):
    """Keep daemon state, sockets and cleanup scoped to this newly created test workspace."""
    paths = verify_installed(args.installed.resolve(strict=True), args.manifest_sha256)
    installed = Path(paths['installed'])
    files = json.loads((installed / 'bin/manifest.json').read_text())['files']
    results, work = args.results.resolve(), args.work_dir.resolve()
    results.mkdir(parents=True, exist_ok=False)
    work.mkdir(parents=True, mode=0o700, exist_ok=False)
    namespace = 'moss-gv-' + str(os.getpid())
    socket = work / 'containerd.sock'
    if len(os.fsencode(socket)) >= 104:
        raise ValueError('Use a short private workspace for the containerd Unix socket')
    ctr = [*args.ctr_command, '--address', str(socket), '--namespace', namespace]
    control = [*ctr, '--timeout', '25s']
    processes, daemon = {}, None
    proof = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'installation': paths, 'manifestSha256': args.manifest_sha256,
             'runtimeSha256': files['runsc'], 'namespace': namespace,
             'testNice': os.getpriority(os.PRIO_PROCESS, 0), 'configVersion': args.config_version,
             'sources': {path.name: digest(path) for path in [Path(__file__), Path(__file__).with_name('shim-guest.c')]},
             'success': False}
    try:
        config = work / 'containerd.toml'
        disabled = ['io.containerd.grpc.v1.cri', 'io.containerd.cri.v1.runtime',
                    'io.containerd.cri.v1.images', 'io.containerd.nri.v1.nri']
        config.write_text('version = ' + str(args.config_version) + '\nroot = ' + json.dumps(str(work / 'root')) +
                          '\nstate = ' + json.dumps(str(work / 'state')) + '\ndisabled_plugins = ' + json.dumps(disabled) +
                          '\n[grpc]\naddress = ' + json.dumps(str(socket)) + '\n[debug]\nlevel = "debug"\n')
        register_template(installed, args.manifest_sha256, config, args.config_version)
        proof['containerdVersion'] = run_logged(results, 'containerd-version', [str(args.containerd), '--version']).strip()
        rootfs, data = work / 'rootfs', work / 'data'
        for directory in [rootfs / 'proc', rootfs / 'data', data]:
            directory.mkdir(parents=True)
        run_logged(results, 'compile-guest', ['nice', '-n', '10', 'cc', '-static', '-O2', '-Wall', '-Wextra', '-Werror',
                                             str(Path(__file__).with_name('shim-guest.c')), '-o', str(rootfs / 'guest')])
        with (results / 'daemon.stdout.log').open('wb') as out, (results / 'daemon.stderr.log').open('wb') as err:
            daemon = subprocess.Popen([str(args.containerd), '--config', str(config)], stdout=out, stderr=err)
        wait_for_file(socket, daemon)
        run_logged(results, 'daemon-ready', [*control, 'version'])
        for kind in ['sandbox', 'container']:
            annotations = {'io.kubernetes.cri.container-type': kind}
            if kind == 'container':
                annotations['io.kubernetes.cri.sandbox-id'] = 'sandbox'
            spec = {'ociVersion': '1.2.0', 'annotations': annotations,
                    'process': {'terminal': False, 'user': {'uid': 0, 'gid': 0}, 'args': ['/guest', kind],
                                'env': ['PATH=/'], 'cwd': '/', 'capabilities': {name: [] for name in
                                     ['bounding', 'effective', 'inheritable', 'permitted', 'ambient']}},
                    'root': {'path': str(rootfs), 'readonly': True},
                    'mounts': [{'destination': '/proc', 'type': 'proc', 'source': 'proc'},
                               {'destination': '/data', 'type': 'bind', 'source': str(data), 'options': ['rbind', 'rw']}],
                    'linux': {'namespaces': [{'type': name} for name in ['pid', 'ipc', 'uts', 'mount', 'network']]}}
            spec_path = work / (kind + '.json')
            spec_path.write_text(json.dumps(spec))
            command = [*ctr, '--timeout', '120s', 'run', '--rm', '--runtime', paths['shim'],
                       '--runtime-config-path', paths['shimConfig'], '--config', str(spec_path), kind]
            with (results / (kind + '.stdout.log')).open('wb') as out, (results / (kind + '.stderr.log')).open('wb') as err:
                processes[kind] = subprocess.Popen(command, stdout=out, stderr=err)
            wait_for_file(data / (kind + '-committed'), processes[kind])
            if (data / (kind + '-committed')).read_text() != 'MOSS_SHIM_' + kind + '_OK\n':
                raise ValueError('Guest fsync result differs')
        proof['liveProcesses'] = live_release_processes(installed, files, namespace)
        expected_root = '--root=/run/moss-gvisor/' + paths['archiveSha256'] + '/' + namespace
        kernels = [row for row in proof['liveProcesses'] if row['executable'] == 'gvisor-bin/gvisor_sentry' and ' boot ' in row['args']]
        if len(kernels) != 1 or expected_root not in kernels[0]['args']:
            raise ValueError('The sandbox and workload must share one Sentry at the versioned runtime root')
        for kind in ['container', 'sandbox']:
            (data / (kind + '-release')).touch()
            if processes[kind].wait(timeout=30) != 0:
                raise RuntimeError('Guest completion failed: ' + kind)
            for channel in ['stdout', 'stderr']:
                if 'MOSS_SHIM_' + kind + '_OK' not in (results / (kind + '.' + channel + '.log')).read_text():
                    raise ValueError('Guest ' + channel + ' delivery failed: ' + kind)
        for resource in ['tasks', 'containers']:
            output = run_logged(results, resource + '-after', [*control, resource, 'list'])
            if len(output.splitlines()) != 1:
                raise ValueError('Private containerd retained a test ' + resource)
        proof['success'] = True
    finally:
        if daemon is not None and daemon.poll() is None:
            for kind in reversed(processes):
                for operation in [['tasks', 'delete', '--force', kind], ['containers', 'delete', kind]]:
                    result = subprocess.run([*control, *operation], capture_output=True, text=True, timeout=30)
                    proof.setdefault('cleanup', []).append({'args': operation, 'exitCode': result.returncode,
                                                            'stderr': result.stderr})
            daemon.terminate()
            try:
                daemon.wait(timeout=15)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait(timeout=10)
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        proof['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (results / 'receipt.json').write_text(json.dumps(proof, indent=2))
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installed', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--containerd', default='containerd', type=Path)
    parser.add_argument('--ctr-command', nargs='+', default=['ctr'])
    parser.add_argument('--config-version', type=int, choices=[2, 3], default=2)
    parser.add_argument('--results', required=True, type=Path)
    parser.add_argument('--work-dir', required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('Use an isolated Linux host with runtime namespace capabilities')
    print(json.dumps(qualify(args)))


if __name__ == '__main__':
    main()
