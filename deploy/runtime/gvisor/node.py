#!/usr/bin/env python3
"""Register a complete release on a K3s node while retaining existing sandboxes."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from deploy.runtime.gvisor import install
from deploy.runtime.gvisor.fetch import fetch


def runtime_class(release, installed):
    """Schedule a release only on nodes advertising its exact installed archive."""
    platform, architecture = release['architecture'].split('-', 1)
    identity = base64.b32encode(bytes.fromhex(installed['archiveSha256'])).decode().rstrip('=').lower()
    label = 'moss.sudo.dev/gvisor-' + identity
    return {'apiVersion': 'node.k8s.io/v1', 'kind': 'RuntimeClass',
            'metadata': {'name': 'gvisor-' + identity,
                         'labels': {'app.kubernetes.io/managed-by': 'moss-install'},
                         'annotations': {'moss.sudo.dev/runtime-archive': installed['archiveSha256'],
                                         'moss.sudo.dev/runtime-manifest': installed['manifestSha256']}},
            'handler': installed['handler'],
            'scheduling': {'nodeSelector': {label: 'installed',
                            'kubernetes.io/os': platform, 'kubernetes.io/arch': architecture}}}


class NativeCommandError(subprocess.CalledProcessError):
    """Retain native diagnostics when an installation failure is chained."""
    def __str__(self):
        return super().__str__() + ('\n' + self.stderr.rstrip() if self.stderr else '')


def command(*arguments):
    """Keep native command failures and their original diagnostics intact."""
    try:
        return subprocess.check_output(arguments, text=True, stderr=subprocess.PIPE, timeout=45)
    except subprocess.CalledProcessError as error:
        raise NativeCommandError(error.returncode, error.cmd, error.output, error.stderr) from error


def running_containers(run):
    return {row['id'] for row in json.loads(run('k3s', 'crictl', 'ps', '-o', 'json'))['containers']
            if row['state'] == 'CONTAINER_RUNNING'}


def wait_ready(service, handler, paths, run, deadline=120):
    """Observe the loaded CRI registration after the node service becomes ready."""
    end = time.monotonic() + deadline
    last = None
    while time.monotonic() < end:
        try:
            if run('systemctl', 'is-active', service).strip() == 'active':
                info = json.loads(run('k3s', 'crictl', 'info'))
                if handler is None:
                    return
                entry = info['config']['containerd']['runtimes'].get(handler)
                if entry:
                    if (entry.get('runtimeType') != 'io.containerd.runsc.v1' or
                            entry.get('runtimePath') != paths['shim'] or
                            entry.get('options', {}).get('ConfigPath') != paths['shimConfig']):
                        raise ValueError('Loaded runtime handler differs from the verified installation')
                    return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
            last = error
        time.sleep(1)
    raise TimeoutError('K3s did not load the installed runtime handler') from last


def snapshot(path):
    if path.is_symlink():
        raise ValueError('Host configuration must be a materialized file: ' + str(path))
    if not path.exists():
        return None, None
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o022:
        raise ValueError('Host configuration must be a protected regular file: ' + str(path))
    return path.read_bytes(), info


def restore(path, previous, expected):
    """Restore only the exact file published by this node operation."""
    current, info = snapshot(path)
    raw, previous_info = previous
    if current == raw:
        return
    if current != expected:
        raise ValueError('Host configuration changed during installation: ' + str(path))
    if raw is None:
        path.unlink()
        install.sync_directory(path.parent)
    else:
        install.publish_file(path, raw, previous_info)


def activate(release, prefix, containerd, node_config, service, run=command):
    """Load a versioned handler; agent and server nodes share this lifecycle."""
    if sys.platform != 'linux':
        raise RuntimeError('This node installer supports Linux')
    import fcntl
    if service not in ('k3s', 'k3s-agent'):
        raise ValueError('A K3s node service is required')
    if not containerd.is_dir() or containerd.is_symlink():
        raise ValueError('The existing containerd configuration directory is required')
    install.verify_ancestors(containerd, searchable=False)
    properties = dict(row.split('=', 1) for row in run('systemctl', 'show', service,
        '--property=KillMode,ExecStop,ActiveState,ExecStart,Environment').splitlines() if '=' in row)
    if {key: properties.get(key) for key in ('KillMode', 'ExecStop', 'ActiveState')} != {'KillMode': 'process', 'ExecStop': '', 'ActiveState': 'active'}:
        raise ValueError('K3s must retain its container processes during a service restart')
    overrides = properties.get('ExecStart', '') + ' ' + properties.get('Environment', '')
    if re.search(r'--node-label(?:=|\s)|\bK3S_NODE_LABEL=', overrides):
        raise ValueError('Move node labels from the K3s service arguments into its configuration file before installing a runtime')
    if node_config == Path('/etc/rancher/k3s/config.yaml.d/90-moss-gvisor.yaml') and re.search(r'--config(?:=|\s)|\bK3S_CONFIG_FILE=', overrides):
        raise ValueError('Select --node-config beside the custom K3s configuration file')
    config = (containerd / 'config.toml').read_text()
    versions = re.findall(r'^version\s*=\s*([23])\s*$', config, re.MULTILINE)
    if len(versions) != 1:
        raise ValueError('A rendered containerd v2 or v3 configuration is required')
    version = int(versions[0])
    preferred = containerd / ('config-v3.toml.tmpl' if version == 3 else 'config.toml.tmpl')
    fallback = containerd / 'config.toml.tmpl'
    if preferred.is_symlink() or fallback.is_symlink():
        raise ValueError('Containerd templates must be materialized files')
    template = preferred if preferred.exists() or not fallback.exists() else fallback
    staged = install.stage(Path(release['archivePath']), release['archiveSha256'],
                           release['manifestSha256'], prefix)
    resource = runtime_class(release, staged)
    label = next(key for key in resource['scheduling']['nodeSelector'] if key.startswith('moss.sudo.dev/'))
    descriptor = os.open(containerd, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = running_containers(run)
        old_template = snapshot(template)
        previous = old_template[0].decode() if old_template[0] is not None else '{{ template "base" . }}\n'
        desired_template = install.template_contents(staged, previous, version).encode()
        ancestor = node_config.parent
        while not ancestor.exists():
            ancestor = ancestor.parent
        install.verify_ancestors(ancestor, searchable=False)
        node_config.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        install.verify_ancestors(node_config.parent, searchable=False)
        install.sync_ancestors(node_config.parent)
        old_labels = snapshot(node_config)
        labels = json.loads(old_labels[0]) if old_labels[0] is not None else {'node-label+': []}
        if (set(labels) != {'node-label+'} or not isinstance(labels['node-label+'], list) or
                any(not isinstance(value, str) or not re.fullmatch(r'moss\.sudo\.dev/gvisor-[a-z2-7]{52}=installed', value)
                    for value in labels['node-label+'])):
            raise ValueError('The runtime label file contains unrelated configuration')
        desired_labels = json.dumps({'node-label+': sorted(set([*labels['node-label+'], label + '=installed']))}, indent=2).encode() + b'\n'
        changed = old_template[0] != desired_template or old_labels[0] != desired_labels
        restarted = False
        try:
            install.write_template(staged, template, version)
            if old_labels[0] != desired_labels:
                install.publish_file(node_config, desired_labels, old_labels[1])
            if changed:
                restarted = True
                run('systemctl', 'restart', service)
            wait_ready(service, staged['handler'], staged, run)
            if not before <= running_containers(run):
                raise ValueError('An existing running container disappeared during the node reload')
        except Exception:
            try:
                restore(node_config, old_labels, desired_labels)
            finally:
                restore(template, old_template, desired_template)
            if restarted:
                run('systemctl', 'restart', service)
                wait_ready(service, None, None, run)
            raise
        return {**staged, 'changed': changed, 'service': service,
                'runtimeClass': resource, 'retainedContainerCount': len(before)}
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--release-sha256', required=True)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--service', choices=['k3s', 'k3s-agent'], default='k3s')
    parser.add_argument('--prefix', type=Path, default=Path('/opt/moss/runtimes/gvisor'))
    parser.add_argument('--containerd', type=Path, default=Path('/var/lib/rancher/k3s/agent/etc/containerd'))
    parser.add_argument('--node-config', type=Path, default=Path('/etc/rancher/k3s/config.yaml.d/90-moss-gvisor.yaml'))
    args = parser.parse_args()
    release = fetch(args.release, args.release_sha256, args.cache, args.offline)
    print(json.dumps(activate(release, args.prefix, args.containerd, args.node_config, args.service)))


if __name__ == '__main__':
    main()
