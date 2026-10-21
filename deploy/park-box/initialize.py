"""Finish delivery through existing business APIs from a Compose setup container."""
import base64
import json
from pathlib import Path
import time
import urllib.request
from artifacts import atomic_json


def initialize():
    setup = json.loads(Path('/config/setup.json').read_text())
    credentials = json.loads(Path('/box/config/credentials.json').read_text())
    base = 'http://moss:43127'
    token = None

    def request(path, body=None, method=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        value = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, value, headers, method=method or ('POST' if body is not None else 'GET'))
        with urllib.request.urlopen(req, timeout=40) as response:
            return json.load(response) if response.status != 204 else None

    deadline = time.monotonic() + 180
    while True:
        try:
            if request('/readyz').get('ready') is True:
                break
        except OSError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('Moss readiness timed out during initialization')
        time.sleep(1)
    login = request('/api/v1/auth/login', {'username': credentials['username'], 'password': credentials['password']})
    token = login['access_token']
    org_id = login['user']['orgId']
    org_file = Path('/box/config/organization.json')
    if not org_file.is_file():
        atomic_json(org_file, {'org_id': org_id, 'public_url': setup['public_url']})
        print('Organization bound. Restart Moss with Compose, then run initialize.py again.', flush=True)
        return
    if json.loads(org_file.read_text())['org_id'] != org_id:
        raise ValueError('Configured administrator belongs to another organization')
    if Path('/box/config/delivery.json').is_file():
        print('Business initialization already completed; proceed to delivery verification.', flush=True)
        return
    park = '/api/v1/parks/' + org_id
    request(park + '/roles/' + login['user']['id'], {'park_role': 'park_system_operator'}, 'PUT')
    model = setup['model']
    for provider in model['modelProviders']:
        if provider['id'] == model['defaultModelProviderId'] and 'apiKey' not in provider:
            provider['apiKey'] = model['apiKey']
    request('/api/v1/settings/system?scope=organization', model, 'PATCH')
    request(park + '/admin/config', setup['park'], 'PUT')
    # Role assignment is kept in the existing Park authorization subsystem.
    users = request('/api/v1/users')['users']
    for account in setup.get('accounts', []):
        existing = next((user for user in users if user['name'] == account['name']), None)
        user_id = existing['id'] if existing else request('/api/v1/users', {key: value for key, value in account.items() if key != 'park_role'})['user']['id']
        request(park + '/roles/' + user_id, {'park_role': account['park_role']}, 'PUT')
    progress_file = Path('/box/config/initialization.json')
    progress = json.loads(progress_file.read_text()) if progress_file.is_file() else {'documents': {}}
    if 'node_id' not in progress:
        progress['node_id'] = request(park + '/admin/policy/tree/nodes', {'name': setup.get('policy_node', '园区政策')})['id']
        atomic_json(progress_file, progress)
    documents = []
    for policy in setup['policies']:
        path = (Path('/config/policies') / policy['file']).resolve()
        if not path.is_relative_to(Path('/config/policies').resolve()) or not path.is_file():
            raise ValueError('Policy file is outside the configured policy directory or missing')
        if policy['file'] not in progress['documents']:
            document = request(park + '/admin/policy/nodes/' + progress['node_id'] + '/documents', {
                'file_name': path.name, 'mime_type': policy.get('mime_type', 'text/markdown'),
                'content_base64': base64.b64encode(path.read_bytes()).decode()})
            progress['documents'][policy['file']] = document['id']
            atomic_json(progress_file, progress)
        documents.append(progress['documents'][policy['file']])
    if 'wiki_id' not in progress:
        progress['wiki_id'] = request(park + '/admin/policy/wikis', {'name': setup.get('wiki_name', '园区政策库'), 'source_document_ids': documents})['id']
        atomic_json(progress_file, progress)
    wiki_id = progress['wiki_id']
    status = request(park + '/admin/policy/wikis/' + wiki_id + '/build-status')
    if not status.get('latest_job') or status['wiki_build_status'] == 'failed':
        request(park + '/admin/policy/wikis/' + wiki_id + '/build', {})
    deadline = time.monotonic() + 600
    while True:
        status = request(park + '/admin/policy/wikis/' + wiki_id + '/build-status')
        if status['wiki_build_status'] == 'succeeded':
            break
        if status['wiki_build_status'] == 'failed':
            raise RuntimeError('Policy build failed; inspect its build result')
        if time.monotonic() >= deadline:
            raise RuntimeError('Policy initialization build timed out')
        time.sleep(2)
    request(park + '/admin/assistant', {'status': 'published', 'value': {
        'policy_wiki_id': wiki_id, 'system_prompt': setup.get('assistant_prompt', '')}}, 'PUT')
    for index, question in enumerate(setup['quick_questions']):
        request(park + '/admin/quick-questions', {'id': 'box-initial-' + str(index), 'question': question, 'sort_order': index, 'enabled': True})
    for channel, label in (('web', '官网入口'), ('qr', '二维码入口'), ('other', '其他入口')):
        request(park + '/admin/public-links', {'channel': channel, 'label': label, 'enabled': True})
    links = request(park + '/admin/public-links')
    atomic_json(Path('/box/config/delivery.json'), {'org_id': org_id, 'wiki_id': wiki_id, 'links': links,
                'initialized_at': int(time.time() * 1000), 'verification': 'pending'})
    print('Business initialization finished. Run the real consultation verification before acceptance.', flush=True)


if __name__ == '__main__':
    initialize()
