#!/usr/bin/env python3
"""Move every drifted owner runtime to the controller's current release, one owner at a time.

Run on the controller host as the service user. Each upgrade goes through the
server's operator route, so it keeps the owner lock, refuses owners with active
work and rolls back a failed replacement. Busy owners are reported for a later
run; they are not failures.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
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
    args = parser.parse_args()
    if not args.token_file:
        parser.error('--token-file or MOSS_OPERATOR_TOKEN_FILE is required')
    config = json.loads(args.config.read_text())
    base = f"http://127.0.0.1:{config['server']['port']}"
    token = Path(args.token_file).read_text().strip()
    found = owners(config['k8s']['kubeconfig'], config['k8s']['namespace'])
    selected = [owner for owner in sorted(found) if not args.owner or owner in args.owner]
    summary = {'upgraded': [], 'current': [], 'busy': [], 'failed': [], 'planned': []}
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
        status, body = call(base, token, 'POST', f'/api/v1/operator/agent-runtimes/{owner}/upgrade', args.timeout)
        outcome = {'owner': owner, 'pod': found[owner], 'status': status}
        if status == 200:
            summary['upgraded'].append({**outcome, 'isDrifted': body['runtime'].get('isDrifted')})
        elif status == 409:
            summary['busy'].append({**outcome, 'error': body.get('error')})
        else:
            summary['failed'].append({**outcome, 'error': body.get('error')})
        print(json.dumps(summary['upgraded'][-1] if status == 200 else outcome), flush=True)
    print(json.dumps({key: len(value) for key, value in summary.items()} | {'details': summary}, indent=2))
    sys.exit(1 if summary['failed'] else 0)


if __name__ == '__main__':
    main()
