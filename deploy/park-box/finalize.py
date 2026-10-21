"""Register installed artifacts and require the real delivery verification task."""
import json
from pathlib import Path
import time
import uuid
from artifacts import atomic_json
from docker_engine import UnixConnection


def request(path, value=None):
    connection = UnixConnection('/socket/agent.sock')
    try:
        body = None if value is None else json.dumps(value).encode()
        connection.request('GET' if value is None else 'POST', path, body,
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        result = json.loads(response.read())
        if response.status >= 400:
            raise RuntimeError(result.get('error', 'Delivery task was rejected'))
        return result
    finally:
        connection.close()


def wait_ready():
    deadline = time.monotonic() + 180
    while True:
        try:
            request('/status')
            return
        except (ConnectionError, FileNotFoundError):
            if time.monotonic() >= deadline:
                raise RuntimeError('Operations socket did not become ready')
            time.sleep(1)


def finalize():
    wait_ready()
    release = json.loads(Path('/config/installed-release.json').read_text())
    atomic_json(Path('/box/config/release.json'), release)
    organization = json.loads(Path('/box/config/organization.json').read_text())
    task = request('/tasks', {'action': 'verify-delivery', 'org_id': organization['org_id'],
                             'actor': 'compose-initialization', 'request_id': str(uuid.uuid4())})
    deadline = time.monotonic() + 600
    while task['status'] not in ('succeeded', 'failed'):
        if time.monotonic() >= deadline:
            raise RuntimeError('Delivery verification timed out; query the operations task before retrying')
        time.sleep(2)
        task = request('/tasks/' + task['id'])
    if task['status'] != 'succeeded':
        raise RuntimeError(task.get('error', 'Delivery verification failed'))
    print('Docker delivery verified: ' + json.dumps(task['result'], ensure_ascii=False), flush=True)


if __name__ == '__main__':
    finalize()
