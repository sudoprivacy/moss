"""Submit fixed operations and follow durable task results through the local socket."""
import argparse
import json
from pathlib import Path
import time
import uuid
from finalize import request, wait_ready


def run(action, name=''):
    wait_ready()
    org_id = json.loads(Path('/box/config/organization.json').read_text())['org_id']
    task = request('/tasks', {'action': action, 'name': name, 'org_id': org_id,
                             'actor': 'docker-boxctl', 'request_id': str(uuid.uuid4())})
    print(json.dumps({'task_id': task['id'], 'action': action}), flush=True)
    deadline = time.monotonic() + 900
    while task['status'] not in ('succeeded', 'failed'):
        if time.monotonic() >= deadline:
            raise RuntimeError('Task wait timed out; the durable task remains queryable')
        time.sleep(2)
        task = request('/tasks/' + task['id'])
    print(json.dumps(task, ensure_ascii=False), flush=True)
    if task['status'] != 'succeeded':
        raise RuntimeError(task.get('error', 'Box task failed'))
    return task


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['backup', 'restore', 'verify-upgrade', 'upgrade', 'rollback', 'reindex', 'model-check', 'recover'])
    parser.add_argument('name', nargs='?', default='')
    arguments = parser.parse_args()
    run(arguments.action, arguments.name)
