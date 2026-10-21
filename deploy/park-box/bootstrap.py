"""Create the registered data layout in a Docker volume, never in host data."""
import json
from pathlib import Path
import secrets
import shutil
from artifacts import atomic_json


def bootstrap(configuration=Path('/config'), data=Path('/box')):
    settings = json.loads((configuration / 'setup.json').read_text())
    if len(settings['administrator']['password']) < 12 or settings['administrator']['password'].startswith('REPLACE_'):
        raise ValueError('Provide a deployment administrator password of at least 12 characters')
    if not settings.get('policies') or len(settings.get('quick_questions', [])) < 4:
        raise ValueError('Delivery requires policy files and at least four quick questions')
    if not {'park_leader', 'park_recruiter'}.issubset({account.get('park_role') for account in settings.get('accounts', [])}):
        raise ValueError('Delivery requires initial park_leader and park_recruiter accounts')
    if not (configuration / 'upgrade-public.pem').is_file():
        raise ValueError('Provide the release signing public key before initialization')
    if (data / 'data/moss.db').exists():
        if not all((data / 'config' / name).is_file() for name in ('server.json', 'credentials.json', 'start-moss.mjs', 'start-park.mjs')):
            raise ValueError('Existing data has no complete deployment configuration; refusing to overwrite it')
        existing = json.loads((data / 'config/credentials.json').read_text())
        if existing['username'] != settings['administrator']['username'] or existing['password'] != settings['administrator']['password']:
            raise ValueError('Existing deployment administrator differs from setup; refusing to overwrite data')
        print('Existing Docker data preserved; resume business initialization.', flush=True)
        return
    for name in ('config', 'data/runtime', 'data/transcripts', 'home', 'park', 'workspaces'):
        (data / name).mkdir(parents=True, exist_ok=True)
    (data / 'config').chmod(0o700)
    (data / 'home').chmod(0o700)
    credentials = {
        'username': settings['administrator']['username'],
        'password': settings['administrator']['password'],
        'PARK_SESSION_HMAC_KEY': secrets.token_hex(32),
        'PARK_TOKEN_AES_KEY': secrets.token_hex(32),
        'PARK_PUBLIC_PROXY_HMAC_KEY': secrets.token_hex(32),
        'PARK_SMS_HMAC_KEY': secrets.token_hex(32),
        'PARK_CAPTCHA_HMAC_KEY': secrets.token_hex(32),
    }
    atomic_json(data / 'config/credentials.json', credentials)
    server = {
        'server': {'host': '0.0.0.0', 'port': 43127},
        'auth': {'mode': 'local', 'tokenTtlSec': 86400},
        'bootstrapAdmin': {'username': credentials['username'], 'password': credentials['password']},
        'storage': {'rootDir': '/box/data', 'dbPath': '/box/data/moss.db',
                    'transcriptDir': '/box/data/transcripts', 'runtimeDir': '/box/data/runtime'},
        'runtimeDefaults': {'type': 'host', 'engine': 'scode', 'hostScodePath': '/app/bin/scode',
                            'idleTimeoutMs': 600000, 'maxSessions': 32},
    }
    atomic_json(data / 'config/server.json', server)
    for name in ('start-moss.mjs', 'start-park.mjs'):
        shutil.copyfile(Path(__file__).parent / name, data / 'config' / name)
    # The signing private key remains on the release-builder side. Only trust is installed here.
    atomic_json(configuration / 'agent.json', {'project': 'park-box', 'data_volume': 'park-box-data',
                'public_key': '/config/upgrade-public.pem', 'ready_timeout': 180})


if __name__ == '__main__':
    bootstrap()
