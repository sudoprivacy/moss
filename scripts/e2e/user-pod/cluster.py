"""Run owner isolation and durable recovery in a bounded, isolated real K3s cluster."""
import argparse
import datetime
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))
from deploy.runtime.gvisor.fetch import fetch
from deploy.runtime.gvisor.node import activate
from deploy.runtime.gvisor.release import digest
from node_service import NodeService

PINS = json.loads((Path(__file__).parent / 'acceptance.lock.json').read_text())
TEST_BINARIES = ('run-user-pod-live.mjs', 'user-pod-runtime.mjs', 'user-pod-recovery.mjs',
                 'user-pod-release-upgrade.mjs', 'mock-openai-server.mjs', 'nexusd-linux')


def node_exit_state(info):
    """Retain process-exit evidence without publishing node logs or credentials."""
    return {key: info['State'].get(key) for key in [
        'Status', 'Running', 'OOMKilled', 'Dead', 'ExitCode', 'StartedAt', 'FinishedAt']}


def prepare_runtime(metadata, archive, output):
    """Install and register the complete qualified distribution through the production adapter."""
    import tomllib
    release = json.loads(metadata.read_text())
    release['archivePath'] = str(archive)
    directory = Path('/var/lib/rancher/k3s/agent/etc/containerd')
    configuration = tomllib.loads((directory / 'config.toml').read_text())
    version = configuration['version']
    registration = activate(release, Path('/opt/moss/runtimes/gvisor'), directory,
        Path('/etc/rancher/k3s/config.yaml.d/90-moss-gvisor.yaml'), 'k3s', NodeService(output.parent).command)
    images_plugin = 'io.containerd.cri.v1.images' if version == 3 else 'io.containerd.grpc.v1.cri'
    snapshotter = configuration['plugins'][images_plugin]['snapshotter']
    assert isinstance(snapshotter, str) and snapshotter, 'Use the configured CRI snapshotter'
    output.write_text(json.dumps({**registration, 'snapshotter': snapshotter}, indent=2))


def audit_runtime(node, installed, output):
    """Read process inodes in their owning node and share the release validator."""
    sys.path.insert(0, str(REPO / 'scripts/e2e/gvisor-sync'))
    from containerd import live_release_processes
    root = Path(json.loads(installed.read_text())['installed'])
    def execute(*arguments):
        result = subprocess.run(['docker', 'exec', node, *arguments], capture_output=True, timeout=60)
        if result.returncode:
            error = result.stderr.decode(errors='replace')
            if 'No such file or directory' in error:
                raise FileNotFoundError(error)
            raise RuntimeError('Node process inspection failed: ' + error)
        return result.stdout

    class NodeProcesses:
        def processes(self):
            script = r'''for process in /proc/[0-9]*; do
executable=$(readlink "$process/exe") || continue
case "$executable" in "$1"/bin/*) ;; *) continue ;; esac
identity=$(stat -Lc '%d %i %s %y' "$process/exe") || exit 1
printf '%s\000%s\000%s\000' "${process##*/}" "$executable" "$identity"
tr '\000' ' ' < "$process/cmdline" || exit 1
printf '\000'
done'''
            fields = execute('/bin/sh', '-c', script, 'inspect', root.as_posix()).split(b'\0')
            assert fields[-1] == b'' and (len(fields) - 1) % 4 == 0
            for index in range(0, len(fields) - 1, 4):
                yield {'pid': int(fields[index]), 'executable': fields[index + 1].decode(),
                       'identity': fields[index + 2], 'args': fields[index + 3].decode(errors='replace')}

        def digest(self, pid):
            assert isinstance(pid, int) and pid > 0
            value = execute('/bin/sha256sum', '/proc/' + str(pid) + '/exe').split()[0].decode()
            assert re.fullmatch('[a-f0-9]{64}', value)
            return value

    manifest = json.loads(execute('/bin/cat', (root / 'bin/manifest.json').as_posix()))
    processes = live_release_processes(root, manifest['files'], '', NodeProcesses())
    output.write_text(json.dumps(processes, indent=2))


def run_cluster(args):
    root = args.work_dir.resolve()
    root.mkdir(parents=True, exist_ok=False)
    bins, shared = args.bin_dir.resolve(strict=True), args.shared_source.resolve(strict=True)
    lock = json.loads((REPO / 'deploy/k3s/sudostack-images.lock.json').read_text())
    for relative, expected in lock['files'].items():
        assert digest(shared / relative) == expected, 'The shared deployment tools must match their source pin'
    network_pin = PINS['networkHelper']
    assert network_pin['path'] == 'tools/deploy/e2e_docker_network.py'
    network_source = shared / network_pin['path']
    assert network_source.is_file() and not network_source.is_symlink()
    assert digest(network_source) == network_pin['sha256'], 'The shared network helper must match its acceptance pin'
    sys.path.insert(0, str(network_source.parent))
    import e2e_docker_network as network_tools
    assert Path(network_tools.__file__).resolve() == network_source.resolve()
    worker = json.loads(args.worker_release.read_text())
    assert digest(args.worker_release) == PINS['worker']['metadataSha256'], 'Worker release metadata checksum mismatch'
    assert worker['archive']['digest'].startswith('sha256:')
    assert digest(args.worker_archive) == worker['archive']['digest'][7:], 'Worker archive checksum mismatch'
    runtime_metadata = REPO / 'deploy/runtime/gvisor/distribution.lock.json'
    runtime = fetch(runtime_metadata, digest(runtime_metadata), args.gvisor_cache.resolve(), args.offline)
    for name in TEST_BINARIES:
        assert (bins / name).is_file(), 'A prepared acceptance binary is missing: ' + name
    (root / 'runtime-release.json').write_bytes(args.worker_release.read_bytes())
    label = 'owner-e2e-' + uuid.uuid4().hex
    name = 'codex-owned-' + label
    volumes = [name + '-data', name + '-runtime', name + '-sockets', name + '-config']
    namespace = 'moss-owner-e2e-' + uuid.uuid4().hex
    node, network = None, None
    commands = []
    proof = {'success': False, 'realKubernetes': True, 'productionChanged': False, 'nodeName': name,
        'label': label, 'volumes': volumes, 'namespace': namespace, 'gvisor': runtime,
        'workerRelease': worker, 'sharedImageSource': lock, 'commands': commands,
        'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}

    def run(step, arguments, timeout=90, data=None, lifecycle=None):
        started = time.monotonic()
        with (root / (step + '.stdout.log')).open('w') as stdout, (root / (step + '.stderr.log')).open('w') as stderr:
            if lifecycle is None:
                result = subprocess.run(arguments, input=data, stdout=stdout, stderr=stderr, text=True,
                                        encoding='utf-8', timeout=timeout)
            else:
                assert data is None
                with subprocess.Popen(arguments, stdout=stdout, stderr=stderr, text=True, encoding='utf-8') as result:
                    try:
                        while result.poll() is None:
                            if time.monotonic() - started >= timeout:
                                raise subprocess.TimeoutExpired(arguments, timeout)
                            lifecycle.poll()
                            time.sleep(0.1)
                    except BaseException:
                        result.kill()
                        result.wait()
                        raise
        commands.append({'step': step, 'exitCode': result.returncode, 'elapsedSeconds': round(time.monotonic() - started, 3)})
        if result.returncode:
            raise RuntimeError('Inspect retained ' + step + ' logs; exit ' + str(result.returncode))
        return (root / (step + '.stdout.log')).read_text()

    def owned(identifier):
        info = json.loads(subprocess.check_output(['docker', 'inspect', identifier], text=True, encoding='utf-8'))[0]
        assert (info['Id'] == identifier or info['Name'] == '/' + identifier)
        assert info['Config']['Labels']['com.sudoprivacy.acceptance'] == label
        return info

    def kube(*arguments):
        return ['docker', 'exec', node, '/bin/kubectl', *arguments]

    def ctr(*arguments):
        return ['docker', 'exec', node, '/bin/ctr', '--address', '/run/k3s/containerd/containerd.sock',
                '--namespace', 'k8s.io', *arguments]

    def ready(step, started=None):
        started = started or datetime.datetime.fromisoformat(owned(node)['State']['StartedAt'].replace('Z', '+00:00'))
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            result = subprocess.run(kube('get', 'nodes', '-o', 'json'), capture_output=True, text=True,
                                    encoding='utf-8', timeout=15)
            if result.returncode == 0:
                nodes = json.loads(result.stdout)['items']
                if nodes and all(any(c['type'] == 'Ready' and c['status'] == 'True'
                    for c in item['status'].get('conditions', [])) for item in nodes):
                    lease = subprocess.run(kube('-n', 'kube-node-lease', 'get', 'lease', name,
                        '--ignore-not-found', '-o', 'json'), capture_output=True, text=True, encoding='utf-8', timeout=15)
                    if lease.returncode == 0 and lease.stdout.strip():
                        renewed = json.loads(lease.stdout)['spec']['renewTime']
                        if datetime.datetime.fromisoformat(renewed.replace('Z', '+00:00')) >= started:
                            (root / (step + '.json')).write_text(result.stdout)
                            (root / (step + '-generation.json')).write_text(json.dumps({
                                'startedAt': started.isoformat(), 'renewTime': renewed}, indent=2))
                            return nodes
            state = node_exit_state(owned(node))
            assert state['Running'], 'The owned K3s process exited before readiness: ' + json.dumps(state)
            time.sleep(1)
        raise TimeoutError('The current Kubernetes node must become Ready within 120 seconds')

    def system_resource(kind, resource_name):
        # Kubelet readiness precedes the asynchronous bundled-addon controller.
        # Read the required desired state before gathering its image inputs.
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            result = subprocess.run(kube('-n', 'kube-system', 'get', kind, resource_name,
                '--ignore-not-found', '-o', 'json'), capture_output=True, text=True, encoding='utf-8', timeout=15)
            result.check_returncode()
            if result.stdout.strip():
                (root / ('system-' + resource_name + '.json')).write_text(result.stdout)
                return json.loads(result.stdout)
            state = node_exit_state(owned(node))
            assert state['Running'], 'The owned K3s process exited before bundled resources appeared: ' + json.dumps(state)
            time.sleep(1)
        raise TimeoutError('The bundled Kubernetes resource must appear: ' + kind + '/' + resource_name)

    def helper(step, command, timeout=180, lifecycle=None):
        helper_name = name + '-' + step
        try:
            return run(step, ['docker', 'run', '--name', helper_name,
                '--label', 'com.sudoprivacy.acceptance=' + label, '--network', 'container:' + node,
                '--cpus', '1', '--memory', '768m',
                '--mount', 'type=volume,source=' + volumes[0] + ',target=/var/lib/rancher/k3s',
                '--mount', 'type=volume,source=' + volumes[1] + ',target=/opt/moss/runtimes',
                '--mount', 'type=volume,source=' + volumes[2] + ',target=/run/k3s',
                '--mount', 'type=volume,source=' + volumes[3] + ',target=/etc/rancher/k3s',
                '--mount', 'type=bind,source=' + root.as_posix() + ',target=/proof',
                '--mount', 'type=bind,source=' + REPO.as_posix() + ',target=/moss,readonly',
                '--mount', 'type=bind,source=' + shared.as_posix() + ',target=/shared,readonly',
                '--mount', 'type=bind,source=' + args.worker_archive.resolve().as_posix() + ',target=/inputs/worker.tar.gz,readonly',
                '--mount', 'type=bind,source=' + runtime['archivePath'] + ',target=/inputs/gvisor.tar.gz,readonly',
                '--env', 'PATH=/proof/bridge:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                args.helper_image, *command], timeout=timeout, lifecycle=lifecycle)
        finally:
            # Keep the object until its ownership is checked. With --rm, an
            # exited helper can disappear between discovery and inspection.
            check = subprocess.run(['docker', 'container', 'ls', '--all', '--quiet', '--no-trunc',
                '--filter', 'label=com.sudoprivacy.acceptance=' + label,
                '--filter', 'name=^/' + re.escape(helper_name) + '$'],
                capture_output=True, text=True, encoding='utf-8', check=True)
            for identifier in check.stdout.split():
                info = owned(identifier)
                assert info['Name'] == '/' + helper_name
                if info['State']['Running']:
                    subprocess.run(['docker', 'stop', info['Id']], capture_output=True, check=True, timeout=60)
                subprocess.run(['docker', 'container', 'rm', info['Id']], capture_output=True, check=True, timeout=30)

    try:
        network = network_tools.create_owned_network(name, label)
        address = network['address']
        proof['network'] = network
        for index, volume in enumerate(volumes):
            options = ['--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs',
                '--opt', 'o=size=64m,mode=0755'] if index == 2 else []
            run('create-volume-' + str(index), ['docker', 'volume', 'create', '--label',
                'com.sudoprivacy.acceptance=' + label, *options, volume])
        proof['runtimeSocketStorage'] = 'shared tmpfs, 64 MiB'
        (root / 'node-service.sh').write_bytes((Path(__file__).parent / 'node-service.sh').read_bytes().replace(b'\r\n', b'\n'))
        node = run('create-node', ['docker', 'create', '--name', name, '--hostname', name,
            '--label', 'com.sudoprivacy.acceptance=' + label, '--privileged', '--cpus', '2', '--memory', '2g',
            '--network', network['id'], '--ip', address,
            '--memory-swap', '2g', '--tmpfs', '/run', '--tmpfs', '/var/run', '--stop-timeout', '30',
            '--mount', 'type=volume,source=' + volumes[0] + ',target=/var/lib/rancher/k3s',
            '--mount', 'type=volume,source=' + volumes[1] + ',target=/opt/moss/runtimes',
            '--mount', 'type=volume,source=' + volumes[2] + ',target=/run/k3s',
            '--mount', 'type=volume,source=' + volumes[3] + ',target=/etc/rancher/k3s',
            '--mount', 'type=bind,source=' + bins.as_posix() + ',target=/tests,readonly',
            '--mount', 'type=bind,source=' + root.as_posix() + ',target=/proof',
            '--entrypoint', '/bin/sh', PINS['k3s']['image'], '/proof/node-service.sh', 'server',
            '--disable', 'traefik', '--disable', 'servicelb', '--disable', 'metrics-server']).strip()
        assert re.fullmatch('[a-f0-9]{64}', node)
        (root / 'node.json').write_text(json.dumps({'id': node, 'name': name, 'label': label}))
        run('start-node', ['docker', 'start', node])
        ready('initial-ready')
        run('create-namespace', kube('create', 'namespace', namespace))
        config = system_resource('configmap', 'local-path-config')
        deployments = [system_resource('deployment', name) for name in ['local-path-provisioner', 'coredns']]
        pods = json.loads(run('system-pods', kube('-n', 'kube-system', 'get', 'pods', '-o', 'json')))['items']
        specs = [pod['spec'] for pod in pods] + [item['spec']['template']['spec'] for item in deployments]
        images = {row['image'] for spec in specs for key in ['containers', 'initContainers'] for row in spec.get(key, [])}
        images.add(PINS['k3s']['pauseImage'])
        storage_helper = json.loads(run('parse-storage-helper', ['docker', 'exec', '-i', node, '/bin/kubectl',
            'create', '--dry-run=client', '--validate=false', '-f', '-', '-o', 'json'], data=config['data']['helperPod.yaml']))
        images.update(row['image'] for row in storage_helper['spec']['containers'])
        for index, image in enumerate(sorted(images)):
            run('pull-system-' + str(index), ['docker', 'pull', image], timeout=180)
        run('save-system', ['docker', 'image', 'save', '--output', str(root / 'system-images.tar'), *sorted(images)], timeout=120)
        run('import-system', ctr('images', 'import', '/proof/system-images.tar'), timeout=180)
        retained_workload = {'apiVersion': 'v1', 'kind': 'Pod',
            'metadata': {'name': 'retained-workload', 'namespace': namespace},
            'spec': {'containers': [{'name': 'hold', 'image': PINS['k3s']['pauseImage'], 'imagePullPolicy': 'Never'}]}}
        run('create-retained-workload', ['docker', 'exec', '-i', node, '/bin/kubectl', 'create', '-f', '-'],
            data=json.dumps(retained_workload))
        run('retained-workload-ready', kube('-n', namespace, 'wait', 'pod/retained-workload', '--for=condition=Ready', '--timeout=90s'), timeout=100)
        preceding = json.loads(run('preceding-workload', kube('-n', namespace, 'get', 'pod/retained-workload', '-o', 'json')))
        native = '/opt/moss/runtimes/acceptance-tools/' + label
        run('create-native-tools', ['docker', 'exec', node, 'mkdir', '-p', native])
        run('copy-native-tools', ['docker', 'exec', node, 'cp', *['/tests/' + name for name in TEST_BINARIES], native + '/'])
        run('copy-node-cli', ['docker', 'exec', node, 'cp', '/bin/k3s', native + '/k3s'])
        for binary in ['crictl', 'ctr', 'kubectl']:
            run('link-' + binary, ['docker', 'exec', node, 'ln', '-s', 'k3s', native + '/' + binary])
        run('native-daemon-mode', ['docker', 'exec', node, 'chmod', '+x', native + '/nexusd-linux'])
        bridges = root / 'bridge'
        bridges.mkdir()
        (bridges / 'k3s').write_text('#!/bin/sh\nset -eu\ntool="$1"\nshift\ncase "$tool" in\n'
            'crictl) exec ' + native + '/crictl --runtime-endpoint unix:///run/k3s/containerd/containerd.sock "$@" ;;\n'
            'ctr) exec ' + native + '/ctr --address /run/k3s/containerd/containerd.sock "$@" ;;\n'
            '*) exit 64 ;;\nesac\n', newline='\n')
        (bridges / 'kubectl').write_text('#!/bin/sh\nexec ' + native + '/kubectl "$@"\n', newline='\n')
        (bridges / 'k3s').chmod(0o755)
        activated_at = datetime.datetime.now(datetime.timezone.utc)
        helper('prepare-runtime', ['python3', '/moss/scripts/e2e/user-pod/cluster.py', '--prepare-node',
            '/moss/deploy/runtime/gvisor/distribution.lock.json', '/inputs/gvisor.tar.gz', '/proof/installed.json'],
            lifecycle=NodeService(root, node, owned))
        installed = json.loads((root / 'installed.json').read_text())
        proof['installed'] = installed
        assert owned(node)['NetworkSettings']['Networks'][name]['IPAddress'] == address
        nodes = ready('qualified-ready', activated_at)
        for key, value in installed['runtimeClass']['scheduling']['nodeSelector'].items():
            assert nodes[0]['metadata']['labels'].get(key) == value, 'The node must advertise its installed capability'
        retained = json.loads(run('retained-workload', kube('-n', namespace, 'get', 'pod/retained-workload', '-o', 'json')))
        assert retained['metadata']['uid'] == preceding['metadata']['uid']
        assert retained['status']['containerStatuses'][0]['containerID'] == preceding['status']['containerStatuses'][0]['containerID']
        assert retained['status']['containerStatuses'][0]['restartCount'] == 0
        assert installed['retainedContainerCount'] >= 1
        proof['retainedWorkload'] = {'uid': retained['metadata']['uid'],
            'containerId': retained['status']['containerStatuses'][0]['containerID'], 'restartCount': 0}
        # Retain the worker after the final daemon restart. Node Ready alone
        # does not mean K3s has completed its startup archive import/unpack.
        retained = json.loads(helper('retain-worker', ['bash', '-c',
            'chmod +x /proof/bridge/*; exec python3 /shared/tools/deploy/images.py '
            '--archive /inputs/worker.tar.gz --sha256 ' + worker['archive']['digest'][7:]], timeout=360))
        reference = worker['image']['reference']
        # Prepare the verified local content through containerd's snapshot API.
        mountpoint = '/run/moss-worker-' + label
        run('prepare-worker-mountpoint', ['docker', 'exec', node, 'mkdir', '-p', mountpoint])
        run('unpack-worker', ctr('images', 'mount', '--snapshotter', installed['snapshotter'],
            reference, mountpoint), timeout=360)
        run('release-unpack-mount', ctr('images', 'unmount', '--snapshotter', installed['snapshotter'],
            '--rm', mountpoint))
        unpacked = run('verify-worker-unpacked', ctr('images', 'check', '--snapshotter', installed['snapshotter'],
            '--quiet', 'name==' + json.dumps(reference))).splitlines()
        assert unpacked == [reference], 'All worker content must be available and unpacked'
        status = json.loads(run('verify-worker-identity', ['docker', 'exec', node, '/bin/crictl',
            '--runtime-endpoint', 'unix:///run/k3s/containerd/containerd.sock',
            'inspecti', '--output', 'json', reference]))['status']
        before = retained['images'][reference]
        assert status['id'] == before['id'] and status.get('pinned') is True
        assert set(before['repoDigests']).issubset(status.get('repoDigests') or [])
        proof['preparedWorker'] = {'id': status['id'], 'pinned': True,
            'repoDigests': status['repoDigests'], 'snapshotter': installed['snapshotter'], 'unpacked': True}
        runtime_class = installed['runtimeClass']
        run('create-runtime-class', ['docker', 'exec', '-i', node, '/bin/kubectl', 'create', '-f', '-'], data=json.dumps(runtime_class))
        host = next(row['IPAddress'] for row in owned(node)['NetworkSettings']['Networks'].values())
        (root / 'configuration.json').write_text(json.dumps({'nodeHost': host, 'namespace': namespace,
            'kubeconfig': '/var/lib/rancher/k3s/server/cred/admin.kubeconfig', 'runtimeClassName': runtime_class['metadata']['name']}))
        helper('owner-journeys', ['node', native + '/run-user-pod-live.mjs', native + '/nexusd-linux',
            '/proof/configuration.json', '/proof/runtime-release.json', '/proof/evidence'], timeout=900)
        actual = json.loads((root / 'evidence/acceptance.json').read_text())
        assert actual['success'] and actual['realKubernetes'] and actual['controlledModel']
        audit_runtime(node, root / 'installed.json', root / 'live-runtime-processes.json')
        proof.update(success=True, actual=actual, installed=installed)
    finally:
        try:
            if node is not None:
                proof['ownedNodeStateBeforeCleanup'] = node_exit_state(owned(node))
                with (root / 'node.private.log').open('w') as log:
                    subprocess.run(['docker', 'logs', node], stdout=log, stderr=log, text=True, encoding='utf-8', timeout=30)
                subprocess.run(['docker', 'stop', node], capture_output=True, check=True, timeout=60)
                proof['ownedNodeStopped'] = not owned(node)['State']['Running']
                subprocess.run(['docker', 'rm', node], capture_output=True, check=True, timeout=30)
                proof['ownedNodeRemoved'] = True
            if network is not None:
                network_tools.remove_owned_network(network, label)
                proof['ownedNetworkRemoved'] = True
            if proof['success']:
                for volume in volumes:
                    resource = json.loads(subprocess.check_output(['docker', 'volume', 'inspect', volume], text=True))[0]
                    assert resource['Name'] == volume and resource['Labels']['com.sudoprivacy.acceptance'] == label
                    subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, check=True, timeout=30)
                proof['ownedVolumesRemoved'] = True
        finally:
            proof['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            (root / 'receipt.json').write_text(json.dumps(proof, indent=2))
    print(json.dumps({'success': proof['success'], 'receipt': str(root / 'receipt.json')}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare-node', nargs=3, type=Path, metavar=('METADATA', 'ARCHIVE', 'OUTPUT'))
    parser.add_argument('--work-dir', type=Path)
    parser.add_argument('--bin-dir', type=Path)
    parser.add_argument('--shared-source', type=Path)
    parser.add_argument('--worker-release', type=Path)
    parser.add_argument('--worker-archive', type=Path)
    parser.add_argument('--gvisor-cache', type=Path)
    parser.add_argument('--helper-image')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    if args.prepare_node:
        prepare_runtime(*args.prepare_node)
    else:
        if any(getattr(args, name) is None for name in ['work_dir', 'bin_dir', 'shared_source', 'worker_release',
                                                      'worker_archive', 'gvisor_cache', 'helper_image']):
            parser.error('The cluster needs isolated work, prepared binaries, pinned artifacts and a helper image')
        run_cluster(args)


if __name__ == '__main__':
    main()
