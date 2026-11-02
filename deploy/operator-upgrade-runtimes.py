#!/usr/bin/env python3
"""Move every drifted owner runtime to the controller's current release, one owner at a time.

Run on the controller host as the service user. Each upgrade goes through the
server's operator route, so it keeps the owner lock, refuses owners with active
work and rolls back a failed replacement. Busy owners are reported for a later
run; they are not failures.

An upgrade resumes the owner's sessions in the controller after it returns.
Back-to-back upgrades once drove the controller's memory past the host's limit,
so each owner waits until the controller's anonymous memory is below the pause
threshold, and the run stops when it stays above the stop threshold.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

OWNER_ANNOTATION = 'moss.sudo.dev/runtime-owner'


def owners(kubeconfig, namespace):
    raw = subprocess.check_output(['kubectl', '--kubeconfig', kubeconfig, 'get', 'pods', '-n', namespace, '-o', 'json'])
    found = {}
    for pod in json.loads(raw)['items']:
        owner = (pod['metadata'].get('annotations') or {}).get(OWNER_ANNOTATION)
        if owner:
            found.setdefault(owner, pod['metadata']['name'])
    return found


def controller_memory():
    """The controller's anonymous memory and the host total, in bytes, or None off a systemd host."""
    try:
        pid = subprocess.check_output(['systemctl', 'show', 'moss-server', '-p', 'MainPID', '--value'], text=True).strip()
        group = Path(f'/proc/{pid}/cgroup').read_text().split('::', 1)[1].strip()
        stat = dict(line.split() for line in Path(f'/sys/fs/cgroup{group}/memory.stat').read_text().splitlines())
        total = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()
                     if line.startswith('MemTotal:'))
        return int(stat['anon']), total
    except (OSError, subprocess.CalledProcessError, KeyError, IndexError, StopIteration, ValueError):
        return None


def settle(pause, stop, seconds):
    """Wait until controller memory is below the pause fraction; report whether it settled."""
    deadline = time.monotonic() + seconds
    while True:
        observed = controller_memory()
        if observed is None:
            return True, None
        used, total = observed
        if used < pause * total:
            return True, round(used / total, 3)
        if used >= stop * total or time.monotonic() >= deadline:
            return False, round(used / total, 3)
        time.sleep(5)


def call(base, token, method, path, timeout):
    request = urllib.request.Request(base + path, method=method, data=b'{}' if method == 'POST' else None,
                                     headers={'X-Moss-Operator-Token': token, 'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b'{}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path.home() / '.moss/server/server.json')
    parser.add_argument('--token-file', type=Path, default=os.environ.get('MOSS_OPERATOR_TOKEN_FILE'))
    parser.add_argument('--owner', action='append', default=[], help='Limit to these owner IDs')
    parser.add_argument('--dry-run', action='store_true', help='Inspect and report without upgrading')
    parser.add_argument('--timeout', type=int, default=600, help='Seconds allowed for one owner upgrade')
    parser.add_argument('--pause-memory', type=float, default=0.35,
                        help='Start an owner only when controller anonymous memory is below this fraction of host memory')
    parser.add_argument('--stop-memory', type=float, default=0.6,
                        help='Stop the run when controller anonymous memory reaches this fraction of host memory')
    parser.add_argument('--settle-seconds', type=int, default=300,
                        help='Longest wait for controller memory to fall below the pause fraction')
    args = parser.parse_args()
    if not args.token_file:
        parser.error('--token-file or MOSS_OPERATOR_TOKEN_FILE is required')
    config = json.loads(args.config.read_text())
    base = f"http://127.0.0.1:{config['server']['port']}"
    token = Path(args.token_file).read_text().strip()
    found = owners(config['k8s']['kubeconfig'], config['k8s']['namespace'])
    selected = [owner for owner in sorted(found) if not args.owner or owner in args.owner]
    summary = {'upgraded': [], 'current': [], 'busy': [], 'failed': [], 'planned': [], 'stopped': None}
    if not args.dry_run and controller_memory() is None:
        print('Controller memory is not observable on this host; upgrades run without the memory guard', flush=True)
    for owner in selected:
        status, body = call(base, token, 'GET', f'/api/v1/operator/agent-runtimes/{owner}', 60)
        if status != 200:
            summary['failed'].append({'owner': owner, 'status': status, 'error': body.get('error')})
            continue
        if not body['runtime'].get('isDrifted'):
            summary['current'].append(owner)
            continue
        if args.dry_run:
            summary['planned'].append(owner)
            continue
        settled, fraction = settle(args.pause_memory, args.stop_memory, args.settle_seconds)
        if not settled:
            summary['stopped'] = {'before': owner, 'controllerMemory': fraction}
            print(json.dumps({'stopped': summary['stopped']}), flush=True)
            break
        status, body = call(base, token, 'POST', f'/api/v1/operator/agent-runtimes/{owner}/upgrade', args.timeout)
        outcome = {'owner': owner, 'pod': found[owner], 'status': status, 'controllerMemoryBefore': fraction}
        if status == 200:
            summary['upgraded'].append({**outcome, 'isDrifted': body['runtime'].get('isDrifted')})
        elif status == 409:
            summary['busy'].append({**outcome, 'error': body.get('error')})
        else:
            summary['failed'].append({**outcome, 'error': body.get('error')})
        print(json.dumps(summary['upgraded'][-1] if status == 200 else outcome), flush=True)
    counts = {key: len(value) for key, value in summary.items() if isinstance(value, list)}
    print(json.dumps(counts | {'stopped': summary['stopped'], 'details': summary}, indent=2))
    sys.exit(1 if summary['failed'] or summary['stopped'] else 0)


if __name__ == '__main__':
    main()
