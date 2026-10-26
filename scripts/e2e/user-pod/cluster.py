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
from deploy.runtime.gvisor.install import register_template, stage
from deploy.runtime.gvisor.release import digest

PINS = json.loads((Path(__file__).parent / 'acceptance.lock.json').read_text())
TEST_BINARIES = ('run-user-pod-live.mjs', 'user-pod-runtime.mjs', 'user-pod-recovery.mjs',
                 'user-pod-release-upgrade.mjs', 'mock-openai-server.mjs', 'nexusd-linux')


def prepare_runtime(metadata, archive, output):
    """Install and register the complete qualified distribution through the production adapter."""
    import tomllib
    release = json.loads(metadata.read_text())
    installed = stage(archive, release['archiveSha256'], release['manifestSha256'], Path('/opt/moss/runtimes/gvisor'))
    directory = Path('/var/lib/rancher/k3s/agent/etc/containerd')
    configuration = tomllib.loads((directory / 'config.toml').read_text())
    version = configuration['version']
    template = directory / ('config-v3.toml.tmpl' if version == 3 else 'config.toml.tmpl')
    registration = register_template(Path(installed['installed']), release['manifestSha256'], template, version)
    images_plugin = 'io.containerd.cri.v1.images' if version == 3 else 'io.containerd.grpc.v1.cri'
    snapshotter = configuration['plugins'][images_plugin]['snapshotter']
    assert isinstance(snapshotter, str) and snapshotter, 'Use the configured CRI snapshotter'
    output.write_text(json.dumps({**registration, 'snapshotter': snapshotter}, indent=2))


def audit_runtime(installed, output):
    """Hash the actual shim and Sentry in this node's process namespace."""
    sys.path.insert(0, str(REPO / 'scripts/e2e/gvisor-sync'))
    from containerd import live_release_processes
    root = Path(json.loads(installed.read_text())['installed'])
    manifest = json.loads((root / 'bin/manifest.json').read_text())
    processes = live_release_processes(root, manifest['files'], '')
    output.write_text(json.dumps(processes, indent=2))


def run_cluster(args):
    root = args.work_dir.resolve()
    root.mkdir(parents=True, exist_ok=False)
    bins, shared = args.bin_dir.resolve(strict=True), args.shared_source.resolve(strict=True)
    lock = json.loads((REPO / 'deploy/k3s/sudostack-images.lock.json').read_text())
    for relative, expected in lock['files'].items():
        assert digest(shared / relative) == expected, 'The shared deployment tools must match their source pin'
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
    volumes = [name + '-data', name + '-runtime']
    namespace = 'moss-owner-e2e-' + uuid.uuid4().hex
    node = None
    commands = []
    proof = {'success': False, 'realKubernetes': True, 'productionChanged': False, 'nodeName': name,
        'label': label, 'volumes': volumes, 'namespace': namespace, 'gvisor': runtime,
        'workerRelease': worker, 'sharedImageSource': lock, 'commands': commands,
        'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}

    def run(step, arguments, timeout=90, data=None):
        started = time.monotonic()
        with (root / (step + '.stdout.log')).open('w') as stdout, (root / (step + '.stderr.log')).open('w') as stderr:
            result = subprocess.run(arguments, input=data, stdout=stdout, stderr=stderr, text=True,
                                    encoding='utf-8', timeout=timeout)
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

    def ready(step):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            result = subprocess.run(kube('get', 'nodes', '-o', 'json'), capture_output=True, text=True,
                                    encoding='utf-8', timeout=15)
            if result.returncode == 0:
                nodes = json.loads(result.stdout)['items']
                if nodes and all(any(c['type'] == 'Ready' and c['status'] == 'True'
                    for c in item['status'].get('conditions', [])) for item in nodes):
                    (root / (step + '.json')).write_text(result.stdout)
                    return nodes
            assert owned(node)['State']['Running'], 'The owned K3s process exited before readiness'
            time.sleep(1)
        raise TimeoutError('The owned Kubernetes node must become Ready within 120 seconds')

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
            assert owned(node)['State']['Running']
            time.sleep(1)
        raise TimeoutError('The bundled Kubernetes resource must appear: ' + kind + '/' + resource_name)

    def helper(step, command, timeout=180):
        helper_name = name + '-' + step
        try:
            return run(step, ['docker', 'run', '--name', helper_name,
                '--label', 'com.sudoprivacy.acceptance=' + label, '--network', 'container:' + node,
                '--pid', 'container:' + node, '--cap-add', 'SYS_PTRACE', '--cpus', '1', '--memory', '768m',
                '--mount', 'type=volume,source=' + volumes[0] + ',target=/var/lib/rancher/k3s',
                '--mount', 'type=volume,source=' + volumes[1] + ',target=/opt/moss/runtimes',
                '--mount', 'type=bind,source=' + root.as_posix() + ',target=/proof',
                '--mount', 'type=bind,source=' + REPO.as_posix() + ',target=/moss,readonly',
                '--mount', 'type=bind,source=' + shared.as_posix() + ',target=/shared,readonly',
                '--mount', 'type=bind,source=' + args.worker_archive.resolve().as_posix() + ',target=/inputs/worker.tar.gz,readonly',
                '--mount', 'type=bind,source=' + runtime['archivePath'] + ',target=/inputs/gvisor.tar.gz,readonly',
                '--env', 'PATH=/proof/bridge:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                args.helper_image, *command], timeout=timeout)
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
        for index, volume in enumerate(volumes):
            run('create-volume-' + str(index), ['docker', 'volume', 'create', '--label', 'com.sudoprivacy.acceptance=' + label, volume])
        node = run('start-node', ['docker', 'run', '-d', '--name', name, '--hostname', name,
            '--label', 'com.sudoprivacy.acceptance=' + label, '--privileged', '--cpus', '2', '--memory', '2g',
            '--memory-swap', '2g', '--tmpfs', '/run', '--tmpfs', '/var/run', '--stop-timeout', '30',
            '--mount', 'type=volume,source=' + volumes[0] + ',target=/var/lib/rancher/k3s',
            '--mount', 'type=volume,source=' + volumes[1] + ',target=/opt/moss/runtimes',
            '--mount', 'type=bind,source=' + bins.as_posix() + ',target=/tests,readonly',
            '--mount', 'type=bind,source=' + root.as_posix() + ',target=/proof',
            PINS['k3s']['image'], 'server', '--disable', 'traefik', '--disable', 'servicelb', '--disable', 'metrics-server']).strip()
        assert re.fullmatch('[a-f0-9]{64}', node)
        (root / 'node.json').write_text(json.dumps({'id': node, 'name': name, 'label': label}))
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
            'crictl) exec ' + native + '/crictl --runtime-endpoint unix:///proc/1/root/run/k3s/containerd/containerd.sock "$@" ;;\n'
            'ctr) exec ' + native + '/ctr --address /proc/1/root/run/k3s/containerd/containerd.sock "$@" ;;\n'
            '*) exit 64 ;;\nesac\n', newline='\n')
        (bridges / 'kubectl').write_text('#!/bin/sh\nexec ' + native + '/kubectl "$@"\n', newline='\n')
        helper('prepare-runtime', ['python3', '/moss/scripts/e2e/user-pod/cluster.py', '--prepare-node',
            '/moss/deploy/runtime/gvisor/distribution.lock.json', '/inputs/gvisor.tar.gz', '/proof/installed.json'])
        installed = json.loads((root / 'installed.json').read_text())
        run('activate-runtime', ['docker', 'restart', node], timeout=90)
        nodes = ready('qualified-ready')
        # Retain the worker after the final daemon restart. Node Ready alone
        # does not mean K3s has completed its startup archive import/unpack.
        retained = json.loads(helper('retain-worker', ['bash', '-c',
            'chmod +x /proof/bridge/*; exec python3 /shared/tools/deploy/images.py '
            '--archive /inputs/worker.tar.gz --sha256 ' + worker['archive']['digest'][7:]], timeout=360))
        # K3s imports content and pins its references; containerd materializes
        # the root filesystem separately. Prepare it before measuring service startup.
        run('unpack-worker', ['docker', 'exec', node, '/bin/sh', '-c',
            'set -eu; set -o pipefail; gzip -dc "$1" | /bin/ctr '
            '--address /run/k3s/containerd/containerd.sock --namespace k8s.io '
            'images import --local --snapshotter "$2" -', 'sh', retained['archive'], installed['snapshotter']], timeout=360)
        reference = worker['image']['reference']
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
        runtime_class = {'apiVersion': 'node.k8s.io/v1', 'kind': 'RuntimeClass', 'metadata': {'name': installed['handler']},
            'handler': installed['handler'], 'scheduling': {'nodeSelector': {'kubernetes.io/hostname': nodes[0]['metadata']['name']}}}
        run('create-runtime-class', ['docker', 'exec', '-i', node, '/bin/kubectl', 'create', '-f', '-'], data=json.dumps(runtime_class))
        host = next(row['IPAddress'] for row in owned(node)['NetworkSettings']['Networks'].values())
        (root / 'configuration.json').write_text(json.dumps({'nodeHost': host, 'namespace': namespace,
            'kubeconfig': '/var/lib/rancher/k3s/server/cred/admin.kubeconfig', 'runtimeClassName': installed['handler']}))
        helper('owner-journeys', ['node', native + '/run-user-pod-live.mjs', native + '/nexusd-linux',
            '/proof/configuration.json', '/proof/runtime-release.json', '/proof/evidence'], timeout=900)
        actual = json.loads((root / 'evidence/acceptance.json').read_text())
        assert actual['success'] and actual['realKubernetes'] and actual['controlledModel']
        helper('runtime-audit', ['python3', '/moss/scripts/e2e/user-pod/cluster.py', '--audit-node',
            '/proof/installed.json', '/proof/live-runtime-processes.json'])
        proof.update(success=True, actual=actual, installed=installed)
    finally:
        try:
            if node is not None:
                owned(node)
                with (root / 'node.private.log').open('w') as log:
                    subprocess.run(['docker', 'logs', node], stdout=log, stderr=log, text=True, encoding='utf-8', timeout=30)
                subprocess.run(['docker', 'stop', node], capture_output=True, check=True, timeout=60)
                proof['ownedNodeStopped'] = not owned(node)['State']['Running']
        finally:
            proof['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            (root / 'receipt.json').write_text(json.dumps(proof, indent=2))
    print(json.dumps({'success': proof['success'], 'receipt': str(root / 'receipt.json')}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare-node', nargs=3, type=Path, metavar=('METADATA', 'ARCHIVE', 'OUTPUT'))
    parser.add_argument('--audit-node', nargs=2, type=Path, metavar=('INSTALLED', 'OUTPUT'))
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
    elif args.audit_node:
        audit_runtime(*args.audit_node)
    else:
        if any(getattr(args, name) is None for name in ['work_dir', 'bin_dir', 'shared_source', 'worker_release',
                                                      'worker_archive', 'gvisor_cache', 'helper_image']):
            parser.error('The cluster needs isolated work, prepared binaries, pinned artifacts and a helper image')
        run_cluster(args)


if __name__ == '__main__':
    main()
