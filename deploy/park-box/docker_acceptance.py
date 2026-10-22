"""Acceptance fixtures and assertions against the actual isolated Docker project."""
import argparse
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import uuid

from artifacts import digest
from docker_engine import DockerEngine
from finalize import request, wait_ready


def signed_fixture(name, kind):
    root = Path('/state/artifacts/upgrades')
    output = root / name
    if output.exists():
        raise RuntimeError('Acceptance fixture already exists')
    source = root / 'park-box-2.tar.gz'
    with tarfile.open(source, 'r:gz') as original:
        manifest = json.load(original.extractfile('release.json'))
        manifest['version'] = name.removesuffix('.tar.gz')
        if kind == 'missing':
            del manifest['components']['bff']
        else:
            manifest['components']['model_configuration']['configuration_version'] = 'acceptance-deliberately-invalid'
        body = json.dumps(manifest).encode()
        with tarfile.open(output, 'w:gz') as target:
            entry = tarfile.TarInfo('release.json')
            entry.size = len(body)
            target.addfile(entry, io.BytesIO(body))
            if kind == 'failed-upgrade':
                for entry in original:
                    if entry.name != 'release.json':
                        target.addfile(entry, original.extractfile(entry) if entry.isfile() else None)
    with tempfile.NamedTemporaryFile() as message:
        message.write(b'park-box-release-v1\x00' + bytes.fromhex(digest(output)))
        message.flush()
        subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', '/config/upgrade-private.pem', '-rawin',
                        '-in', message.name, '-out', str(output) + '.sig'], check=True, capture_output=True)
    if kind == 'tampered':
        with output.open('ab') as stream:
            stream.write(b'deliberate acceptance tampering')
    print('Created deliberate negative acceptance fixture: ' + name, flush=True)


def submit(action, name='', request_id=None):
    org_id = json.loads(Path('/box/config/organization.json').read_text())['org_id']
    return request('/tasks', {'action': action, 'name': name, 'org_id': org_id,
                             'actor': 'docker-acceptance', 'request_id': request_id or str(uuid.uuid4())})


def wait_task(task):
    deadline = time.monotonic() + 900
    print(json.dumps({'task_id': task['id'], 'action': task['action']}), flush=True)
    while task['status'] not in ('succeeded', 'failed'):
        if time.monotonic() >= deadline:
            raise RuntimeError('Acceptance task timed out; inspect durable task')
        time.sleep(2)
        task = request('/tasks/' + task['id'])
    print(json.dumps(task, ensure_ascii=False), flush=True)
    return task


def reject_packages():
    engine = DockerEngine('park-box')
    before = {i['Id']: engine.inspect(i['Id'])['State']['StartedAt'] for i in engine.containers()}
    for name, reason in [('acceptance-tampered.tar.gz', 'signature'), ('acceptance-missing.tar.gz', 'missing required')]:
        task = wait_task(submit('upgrade', name))
        assert task['status'] == 'failed' and reason in task['error'], task
    after = {i['Id']: engine.inspect(i['Id'])['State']['StartedAt'] for i in engine.containers()}
    assert before == after, 'Rejected packages changed running containers'
    print('Tampered and incomplete signed packages rejected before stopping any real container.', flush=True)


def failed_upgrade():
    before = json.loads(Path('/box/config/release.json').read_text())
    task = wait_task(submit('upgrade', 'acceptance-failed-upgrade.tar.gz'))
    assert task['status'] == 'failed' and task.get('recovered') is True and not task.get('recovery_error'), task
    assert 'model_configuration' in task['error'], task
    after = json.loads(Path('/box/config/release.json').read_text())
    assert before == after, 'Automatic recovery changed the prior installed release'
    assert not Path('/state/maintenance.json').exists(), 'Recovery did not reopen service'
    print('Real post-install verification failure preserved; prior images/data and business recovered.', flush=True)


def concurrency():
    identifier = str(uuid.uuid4())
    task = submit('model-check', request_id=identifier)
    assert submit('model-check', request_id=identifier)['id'] == task['id'], 'Retry created a duplicate task'
    try:
        submit('backup')
    except RuntimeError as error:
        assert 'Another box task' in str(error), error
    else:
        raise AssertionError('Concurrent task was not rejected')
    task = wait_task(task)
    assert task['status'] == 'succeeded' and task['result']['model']['healthy'] is True, task
    print('Real model inference, request idempotency and mutual exclusion passed.', flush=True)


def interrupted_backup():
    engine = DockerEngine('park-box')
    task = submit('backup')
    deadline = time.monotonic() + 120
    while True:
        saved = json.loads((Path('/state/tasks') / (task['id'] + '.json')).read_text())
        if saved.get('containers') and saved['phase'] == 'stopping-writers':
            if any(not engine.inspect(info['Name'].lstrip('/'))['State']['Running'] for info in saved['containers']):
                break
        if saved['status'] in ('succeeded', 'failed') or time.monotonic() >= deadline:
            raise RuntimeError('Could not reach the real writer-stop interruption point')
        time.sleep(0.05)
    operation = next(item for item in engine.containers() if item['Labels'].get('com.docker.compose.service') == 'operations')
    engine.request('POST', '/containers/' + operation['Id'] + '/kill?signal=SIGKILL')
    # Explicit Docker kill suppresses restart-policy handling; simulate the
    # operator/Compose restart before checking durable interruption recovery.
    engine.start(operation['Id'])
    time.sleep(3)
    wait_ready()
    task = wait_task(task)
    assert task['status'] == 'failed' and 'restarted' in task['interruption_error'] and task.get('recovered') is True, task
    assert not task.get('recovery_error') and not Path('/state/maintenance.json').exists(), task
    assert all(engine.inspect(item['Id'])['State']['Running'] for item in engine.containers()), 'Container did not recover'
    print('Real operations process interruption recovered writers and verified business; interrupted backup remains failed.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['fixtures', 'rejections', 'failed-upgrade', 'concurrency', 'interruption'])
    mode = parser.parse_args().mode
    if mode == 'fixtures':
        for kind in ('tampered', 'missing', 'failed-upgrade'):
            signed_fixture('acceptance-' + kind + '.tar.gz', kind)
    else:
        wait_ready()
        {'rejections': reject_packages, 'failed-upgrade': failed_upgrade, 'concurrency': concurrency,
         'interruption': interrupted_backup}[mode]()
