import argparse
import concurrent.futures
import contextlib
import fcntl
import http.server
import json
import os
from pathlib import Path
import secrets
import shutil
import socketserver
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
import tarfile

from artifacts import atomic_json, digest, extract_safe, file_manifest, validate_sqlite, verify_files, verify_signature
from docker_engine import DockerEngine

TERMINAL = {'succeeded', 'failed'}
ACTIONS = {'backup', 'restore', 'verify-upgrade', 'upgrade', 'rollback', 'reindex', 'model-check', 'verify-delivery', 'recover'}
COMPONENTS = {'moss', 'nexus', 'runtime', 'park', 'webui', 'bff', 'public_frontend', 'assistant_skill', 'database_migration', 'model_configuration'}


class BoxAgent:
    def __init__(self, config):
        self.config = config
        self.project = config['project']
        self.root = Path(config.get('state_dir', '/state'))
        self.data = Path(config.get('data_dir', '/box'))
        self.artifacts = self.root / 'artifacts'
        self.tasks = self.root / 'tasks'
        self.upgrades = self.artifacts / 'upgrades'
        self.backups = self.artifacts / 'backups'
        for directory in (self.root, self.tasks, self.upgrades, self.backups):
            directory.mkdir(parents=True, exist_ok=True)
            directory.chmod(0o700)
        self.engine = DockerEngine(self.project, config.get('docker_socket', '/var/run/docker.sock'))
        self.lock_stream = (self.root / 'agent.lock').open('a')
        fcntl.flock(self.lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.mutex = threading.Lock()
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.key_version = None
        self.key_errors = []
        self.recover_interrupted()

    def save(self, task):
        task['updated_at'] = int(time.time() * 1000)
        atomic_json(self.tasks / (task['id'] + '.json'), task)

    def phase(self, task, phase, status='running'):
        task.update(phase=phase, status=status)
        self.save(task)

    def task(self, task_id):
        if not task_id or not all(c in '0123456789abcdef-' for c in task_id):
            raise ValueError('Invalid task identifier')
        path = self.tasks / (task_id + '.json')
        if not path.is_file():
            raise ValueError('Task not found')
        return json.loads(path.read_text())

    @staticmethod
    def public_task(task):
        # Container snapshots contain credentials and are recovery state only.
        allowed = ('id', 'action', 'name', 'status', 'phase', 'created_at', 'updated_at',
                   'result', 'error', 'interruption_error', 'recovery_error', 'recovered')
        return {key: task[key] for key in allowed if key in task}

    def recover_interrupted(self):
        for path in self.tasks.glob('*.json'):
            task = json.loads(path.read_text())
            if task['status'] not in TERMINAL:
                task['interruption_error'] = 'Operations container restarted before task completion'
                task.setdefault('error', task['interruption_error'])
                try:
                    if task.get('protection'):
                        self.recover(task)
                    elif task.get('containers'):
                        self.start_containers(task['containers'])
                        self.verify_business(task)
                        self.clear_maintenance()
                        task['recovered'] = True
                    else:
                        self.clear_maintenance()
                except Exception as error:
                    task['recovery_error'] = self.error(error)
                task.update(status='failed', phase='interrupted')
                self.save(task)

    @staticmethod
    def error(error):
        if isinstance(error, (ValueError, RuntimeError, FileNotFoundError)):
            return str(error)[:500]
        if isinstance(error, urllib.error.HTTPError):
            try:
                value = json.loads(error.read(4096))
                reason = value.get('error')
                if isinstance(reason, str):
                    return 'Business verification failed (HTTP %s): %s' % (error.code, reason[:400])
            except (OSError, ValueError):
                pass
            return 'Business verification failed (HTTP %s)' % error.code
        return 'Operation failed: ' + type(error).__name__

    def org_id(self):
        org_file = self.data / 'config/organization.json'
        return json.loads(org_file.read_text())['org_id'] if org_file.is_file() else None

    def submit(self, value):
        action = value.get('action')
        if action not in ACTIONS or value.get('org_id') != self.org_id():
            raise ValueError('Operation or park is not authorized')
        request_id = value.get('request_id')
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            raise ValueError('Request identifier is required')
        with self.mutex:
            previous = [json.loads(p.read_text()) for p in self.tasks.glob('*.json')]
            for task in previous:
                if task.get('request_id') == request_id:
                    if task['action'] != action or task.get('name', '') != value.get('name', ''):
                        raise ValueError('Request identifier was reused for a different operation')
                    return task
            if any(t['status'] not in TERMINAL for t in previous):
                raise ValueError('Another box task is running')
            if action == 'recover':
                interrupted = self.task(value.get('name', ''))
                if (not (self.root / 'maintenance.json').is_file() or interrupted['status'] != 'failed'
                        or interrupted.get('recovered') or not interrupted.get('recovery_error')
                        or not interrupted.get('containers')):
                    raise ValueError('Selected task has no failed recovery to retry')
            elif (self.root / 'maintenance.json').is_file():
                raise ValueError('Box maintenance requires recovery before another operation')
            task = {'id': str(uuid.uuid4()), 'action': action, 'name': value.get('name', ''), 'request_id': request_id,
                    'actor': value.get('actor', ''), 'status': 'queued', 'phase': 'queued', 'created_at': int(time.time() * 1000)}
            self.save(task)
            self.executor.submit(self.execute, task)
            return task

    def artifact(self, directory, name):
        if not isinstance(name, str) or Path(name).name != name or '/' in name or '\\' in name:
            raise ValueError('Invalid artifact name')
        path = directory / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Artifact not found')
        return path

    def status(self):
        tasks = sorted((json.loads(p.read_text()) for p in self.tasks.glob('*.json')), key=lambda t: t['created_at'], reverse=True)
        configured = bool(self.org_id())
        errors = []
        containers = []
        try:
            containers = self.engine.containers()
            services = {c['Labels'].get('com.docker.compose.service') for c in containers}
            if not {'moss', 'nexus', 'park'}.issubset(services):
                errors.append('Moss, Nexus and Park containers are required')
        except Exception as error:
            errors.append(self.error(error))
        if not configured:
            errors.append('Finish park initialization in the deployment configuration')
        if any(item.get('State') != 'running' for item in containers if item['Labels'].get('com.docker.compose.service') in ('moss', 'nexus', 'park')):
            errors.append('Start all business containers with Docker Compose')
        key = Path(self.config.get('public_key', '/config/upgrade-public.pem'))
        key_errors = [] if key.is_file() else ['Install the trusted upgrade public key at configuration/upgrade-public.pem']
        if not key_errors:
            version = (key.stat().st_mtime_ns, key.stat().st_size)
            if version != self.key_version:
                result = subprocess.run(['openssl', 'pkey', '-pubin', '-in', str(key), '-text', '-noout'], capture_output=True, timeout=5)
                self.key_errors = ([] if not result.returncode and b'ED25519' in result.stdout else
                                   ['The configured upgrade public key must be a valid Ed25519 public key'])
                self.key_version = version
            key_errors.extend(self.key_errors)
        rollback = self.root / 'rollback.json'
        version_file = self.data / 'config/release.json'
        release = json.loads(version_file.read_text()) if version_file.is_file() else None
        if not release:
            errors.append('Register the installed release through the Docker Compose installation entry')
        running = []
        try:
            for item in self.engine.containers():
                service = item['Labels'].get('com.docker.compose.service')
                if service in ('moss', 'nexus', 'park', 'operations'):
                    info = self.engine.inspect(item['Id'])
                    running.append({'service': service, 'running': info['State']['Running'], 'image_id': info['Image'],
                                    'started_at': info['State']['StartedAt'], 'restart_count': info['RestartCount']})
        except Exception as error:
            errors.append(self.error(error))
        available = {action: not errors for action in ACTIONS}
        directories = {}
        listings = {}
        for kind, directory in (('backup', self.backups), ('upgrade', self.upgrades)):
            try:
                if not directory.is_dir() or not os.access(directory, os.R_OK | os.W_OK | os.X_OK):
                    raise ValueError(kind + ' artifact directory is missing or inaccessible')
                listings[kind] = [p.name for p in sorted(directory.iterdir()) if p.is_file() and not p.is_symlink() and p.name.endswith('.tar.gz')]
                directories[kind] = {'status': 'ready'}
            except (OSError, ValueError) as error:
                listings[kind] = []
                directories[kind] = {'status': 'error', 'reason': self.error(error)}
        failed_backups = {'backup-' + task['id'] + '.tar.gz' for task in tasks
                          if task['action'] == 'backup' and task['status'] == 'failed'}
        listings['backup'] = [name for name in listings['backup'] if name not in failed_backups]
        if (self.root / 'maintenance.json').is_file() or any(t['status'] not in TERMINAL for t in tasks):
            for action in ACTIONS:
                available[action] = False
            errors.append('A box operation or unresolved recovery is in progress')
        for action in ('upgrade', 'verify-upgrade'):
            available[action] = available[action] and not key_errors
        rollback_errors = []
        try:
            saved = json.loads(rollback.read_text())
            self.artifact(self.backups, saved['archive'])
            if len(saved['containers']) != 3:
                raise ValueError('Previous upgrade container snapshot is incomplete')
            for info in saved['containers']:
                self.engine.image(info['Image'])
        except Exception as error:
            rollback_errors = ['No usable previous upgrade snapshot: ' + self.error(error)]
        available['rollback'] = available['rollback'] and not rollback_errors
        action_reasons = {}
        for action in ACTIONS:
            reasons = errors + (key_errors if action in ('upgrade', 'verify-upgrade') else [])
            if action in ('backup', 'restore', 'upgrade', 'rollback') and directories['backup']['status'] != 'ready':
                reasons = reasons + [directories['backup']['reason']]
            if action in ('upgrade', 'verify-upgrade') and directories['upgrade']['status'] != 'ready':
                reasons = reasons + [directories['upgrade']['reason']]
            if action == 'rollback':
                reasons = reasons + rollback_errors
            action_reasons[action] = reasons
            available[action] = available[action] and not reasons
        recovery_tasks = [task for task in tasks if task.get('recovery_error') and not task.get('recovered') and task.get('containers')]
        available['recover'] = (bool(recovery_tasks) and (self.root / 'maintenance.json').is_file()
                                and not any(task['status'] not in TERMINAL for task in tasks))
        action_reasons['recover'] = [] if available['recover'] else ['No failed recovery to retry, or a task is still running']
        memory = {}
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.split(':')[0] in ('MemTotal', 'MemAvailable'):
                memory[line.split(':')[0]] = int(line.split()[1]) * 1024
        disk = shutil.disk_usage(self.data)
        return {'configured': configured, 'checked_at': int(time.time() * 1000), 'version': release and release.get('version'),
                'components': release and release.get('components'), 'available_actions': available,
                'action_reasons': action_reasons,
                'archives': listings['backup'], 'upgrades': listings['upgrade'],
                'directories': directories,
                'disk': {'total_bytes': disk.total, 'free_bytes': disk.free},
                'memory': {'total_bytes': memory.get('MemTotal', 0), 'free_bytes': memory.get('MemAvailable', 0)},
                'services': running,
                'current_task': self.public_task(tasks[0]) if tasks else None, 'maintenance': (self.root / 'maintenance.json').is_file()}

    def maintenance(self):
        token = secrets.token_hex(32)
        atomic_json(self.root / 'maintenance.json', {'token': token})
        return token

    def clear_maintenance(self):
        (self.root / 'maintenance.json').unlink(missing_ok=True)

    def containers(self):
        result = []
        for item in self.engine.containers():
            if item['Labels'].get('com.docker.compose.service') in ('operations', 'initialize'):
                continue
            info = self.engine.inspect(item['Id'])
            for mount in info.get('Mounts', []):
                if mount['Type'] == 'volume' and mount.get('RW') and mount['Name'] != self.config['data_volume']:
                    raise ValueError('Unregistered persistent volume: ' + mount['Name'])
                if mount['Type'] == 'bind' and mount.get('RW'):
                    raise ValueError('Unregistered writable bind mount')
            result.append(info)
        if {info['Config']['Labels'].get('com.docker.compose.service') for info in result} != {'moss', 'nexus', 'park'}:
            raise ValueError('Exactly the Moss, Nexus and Park business containers are required')
        return result

    def preflight(self, action):
        if action in ('verify-upgrade', 'recover'):
            return
        containers = self.containers()
        if any(not info['State']['Running'] for info in containers):
            raise ValueError('Start all business containers with Docker Compose before this operation')
        for info in containers:
            self.engine.image(info['Image'])

    def stop_containers(self, task):
        if 'containers' not in task:
            task['containers'] = self.containers()
            self.save(task)
        order = {'park': 0, 'moss': 1, 'nexus': 2}
        existing = {name.lstrip('/') for item in self.engine.containers() for name in item['Names']}
        for info in sorted(task['containers'], key=lambda i: order.get(i['Config']['Labels'].get('com.docker.compose.service'), 0)):
            if info['Name'].lstrip('/') not in existing:
                continue
            if self.engine.inspect(info['Name'].lstrip('/'))['State']['Running']:
                self.engine.stop(info['Name'].lstrip('/'))

    def start_containers(self, containers):
        order = {'nexus': 0, 'moss': 1, 'park': 2}
        for info in sorted(containers, key=lambda i: order.get(i['Config']['Labels'].get('com.docker.compose.service'), 3)):
            if info['State']['Running']:
                self.engine.start(info['Name'].lstrip('/'))

    def check_references(self):
        database = self.data / 'data/moss.db'
        if not database.is_file():
            raise ValueError('Moss database is missing')
        connection = sqlite3.connect('file:' + str(database) + '?mode=ro&immutable=1', uri=True)
        try:
            tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in ('documents', 'wikis'):
                if table not in tables:
                    continue
                for (name,) in connection.execute('SELECT storage_path FROM ' + table):
                    path = Path(name)
                    if not path.is_absolute() or not path.resolve().is_relative_to(self.data.resolve()):
                        raise ValueError('Database references data outside the registered volume')
                    if not path.exists():
                        raise ValueError('Database references a missing policy file or Wiki')
        finally:
            connection.close()

    def capacity(self, extra=0):
        size = sum(p.stat().st_size for p in self.data.rglob('*') if p.is_file() and not p.is_symlink())
        required = int((size * 3 + extra) * 1.2) + 512 * 1024 * 1024
        if shutil.disk_usage(self.root).free < required:
            raise ValueError('Insufficient storage for artifacts and protected recovery snapshots')

    def snapshot(self, task, protection=False):
        self.check_references()
        self.capacity()
        work = self.root / ('snapshot-' + task['id'])
        work.mkdir(exist_ok=False)
        archive = None
        try:
            shutil.copytree(self.data, work / 'payload', symlinks=True)
            for link in (work / 'payload').rglob('*'):
                if link.is_symlink():
                    original = self.data / link.relative_to(work / 'payload')
                    target = original.resolve()
                    if not target.is_relative_to(self.data.resolve()):
                        raise ValueError('Backup link escapes the registered data volume')
                    relative = os.path.relpath(target, original.parent)
                    link.unlink()
                    link.symlink_to(relative)
            files, databases = file_manifest(work / 'payload')
            if 'data/moss.db' not in databases or 'park/sessions.sqlite' not in databases:
                raise ValueError('Both Moss and Park databases must be included in backup')
            # Store a SQLite-consistent database in the stopped-writer snapshot.
            for name in databases:
                source = work / 'payload' / name
                temporary = source.with_name(source.name + '.consistent')
                with sqlite3.connect(str(source)) as old, sqlite3.connect(str(temporary)) as new:
                    old.backup(new)
                source.unlink()
                temporary.replace(source)
                for suffix in ('-wal', '-shm'):
                    source.with_name(source.name + suffix).unlink(missing_ok=True)
            files, databases = file_manifest(work / 'payload')
            manifest = {'format': 1, 'org_id': self.org_id(), 'created_at': int(time.time() * 1000), 'files': files, 'databases': databases}
            atomic_json(work / 'backup.json', manifest)
            destination = self.backups / (('protection-' if protection else 'backup-') + task['id'] + '.tar.gz')
            archive = destination.with_name(destination.name + '.partial')
            with tarfile.open(archive, 'w:gz') as bundle:
                bundle.add(work / 'backup.json', arcname='backup.json')
                bundle.add(work / 'payload', arcname='payload')
            archive.chmod(0o600)
            with self.unpack_backup(archive):
                pass
            archive.replace(destination)
            return destination.name
        finally:
            if archive is not None:
                archive.unlink(missing_ok=True)
            shutil.rmtree(work)

    @contextlib.contextmanager
    def unpack_backup(self, archive):
        work = self.root / ('restore-' + uuid.uuid4().hex)
        try:
            extract_safe(archive, work, allow_links=True)
            manifest = json.loads((work / 'backup.json').read_text())
            if manifest['format'] != 1 or manifest['org_id'] != self.org_id():
                raise ValueError('Backup belongs to a different park or format')
            verify_files(work / 'payload', manifest['files'])
            if not {'data/moss.db', 'park/sessions.sqlite'}.issubset(manifest['databases']):
                raise ValueError('Backup manifest does not cover both required databases')
            for name in manifest['databases']:
                if not validate_sqlite(work / 'payload' / name):
                    raise ValueError('Backup database format is invalid')
            yield work / 'payload'
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def restore_payload(self, archive):
        with self.unpack_backup(archive) as payload:
            for child in self.data.iterdir():
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            shutil.copytree(payload, self.data, dirs_exist_ok=True, symlinks=True)
            self.check_references()
            expected = json.loads((payload.parent / 'backup.json').read_text())
            verify_files(self.data, expected['files'])

    def business(self, operation, token, timeout=180):
        request = urllib.request.Request(self.config.get('moss_url', 'http://moss:43127') + '/internal/park-box/' + operation,
                                         data=b'{}', headers={'Content-Type': 'application/json', 'X-Park-Box-Token': token})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)

    def verify_business(self, task, consultation=True):
        self.phase(task, 'business-verification', 'verifying')
        deadline = time.monotonic() + self.config.get('ready_timeout', 180)
        url = self.config.get('moss_url', 'http://moss:43127') + '/readyz'
        while True:
            try:
                with urllib.request.urlopen(url, timeout=5) as response:
                    value = json.load(response)
                if value.get('ok') is True and value.get('ready') is True:
                    break
            except (OSError, ValueError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('Moss readiness did not recover')
            time.sleep(1)
        token = json.loads((self.root / 'maintenance.json').read_text())['token']
        value = self.business('verify' if consultation else 'probe', token)
        if not value.get('healthy'):
            raise RuntimeError('Business verification failed')
        with urllib.request.urlopen(self.config.get('park_url', 'http://park:4176') + '/park/login', timeout=10) as response:
            if response.status != 200:
                raise RuntimeError('Park frontend is unavailable')
        release_file = self.data / 'config/release.json'
        if not release_file.is_file():
            raise RuntimeError('Installed release metadata is missing')
        release = json.loads(release_file.read_text())
        actual = self.business('versions', token)
        for info in self.containers():
            service = info['Config']['Labels']['com.docker.compose.service']
            if info['Image'] != release['images'][service]['id']:
                raise RuntimeError('Running image differs from installed release: ' + service)
            if service == 'park':
                actual['components'].update(self.engine.build_metadata(info['Id'])['components'])
        for name, expected in release['components'].items():
            observed = ({'configuration_version': value['model']['configuration_version']}
                        if name == 'model_configuration' else actual['components'].get(name))
            if observed != expected:
                raise RuntimeError('Running component metadata differs from installed release: ' + name)
        revision = release['components']['database_migration']['source_sha256']
        if revision not in actual.get('database_revisions', []):
            raise RuntimeError('Installed database revision has not been applied')
        value['version'] = release['version']
        return value

    def prepare(self, task):
        self.capacity()
        self.maintenance()
        self.phase(task, 'stopping-writers')
        self.stop_containers(task)

    def recover(self, task):
        self.phase(task, 'restoring-protection', 'recovering')
        self.stop_containers(task)
        if task.get('protection'):
            self.restore_payload(self.artifact(self.backups, task['protection']))
        for info in task.get('containers', []):
            self.engine.replace(info, info['Image'])
            self.engine.tag(info['Image'], 'park-box-' + info['Config']['Labels']['com.docker.compose.service'] + ':current')
        self.start_containers(task.get('containers', []))
        self.verify_business(task)
        task['recovered'] = True
        self.clear_maintenance()

    @contextlib.contextmanager
    def release(self, name):
        archive = self.artifact(self.upgrades, name)
        verify_signature(archive, Path(self.config.get('public_key', '/config/upgrade-public.pem')))
        work = self.root / ('release-' + uuid.uuid4().hex)
        try:
            extract_safe(archive, work)
            manifest = json.loads((work / 'release.json').read_text())
            if manifest.get('format') != 1 or manifest.get('architecture') != 'amd64' or manifest.get('agent_protocol') != 1:
                raise ValueError('Upgrade architecture, format or agent protocol is incompatible')
            if not COMPONENTS.issubset(manifest.get('components', {})) or set(manifest.get('images', {})) != {'moss', 'nexus', 'park'}:
                raise ValueError('Upgrade package is missing required components')
            for name, component in manifest['components'].items():
                if not isinstance(component, dict) or not any(component.get(key) for key in ('version', 'source_sha256', 'artifact_sha256', 'configuration_version')):
                    raise ValueError('Upgrade component has no verifiable version: ' + name)
            verify_files(work, manifest['files'], ignored=('release.json',))
            yield work, manifest
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def execute(self, task):
        try:
            self.phase(task, 'preflight')
            action = task['action']
            self.preflight(action)
            if action == 'recover':
                interrupted = self.task(task['name'])
                task['containers'] = interrupted['containers']
                if interrupted.get('protection'):
                    task['protection'] = interrupted['protection']
                self.save(task)
                self.maintenance()
                self.recover(task)
                interrupted.update(recovered=True, recovery_task_id=task['id'])
                self.save(interrupted)
                task['result'] = {'recovered': True, 'original_task': interrupted['id']}
            elif action == 'verify-upgrade':
                with self.release(task['name']) as (_, manifest):
                    task['result'] = {'verified': True, 'version': manifest['version']}
            elif action == 'verify-delivery':
                self.maintenance()
                task['result'] = self.verify_business(task)
                delivery_file = self.data / 'config/delivery.json'
                delivery = json.loads(delivery_file.read_text())
                delivery.update(verification=task['result'], verified_at=int(time.time() * 1000))
                atomic_json(delivery_file, delivery)
                self.clear_maintenance()
            elif action in ('model-check', 'reindex'):
                token = self.maintenance()
                # Reindex blocks competing operations but the existing business service stays running.
                task['result'] = self.business(action, token, timeout=600)
                if task['result'].get('healthy') is not True:
                    raise RuntimeError('Operation verification did not pass')
                self.clear_maintenance()
            elif action == 'backup':
                self.prepare(task)
                self.phase(task, 'creating-backup')
                name = self.snapshot(task)
                self.start_containers(task['containers'])
                self.verify_business(task)
                self.clear_maintenance()
                task['result'] = {'archive': name, 'sha256': digest(self.backups / name)}
            elif action in ('restore', 'rollback'):
                if action == 'rollback':
                    saved = json.loads((self.root / 'rollback.json').read_text())
                    archive = self.artifact(self.backups, saved['archive'])
                    for info in saved['containers']:
                        self.engine.image(info['Image'])
                else:
                    archive = self.artifact(self.backups, task['name'])
                with self.unpack_backup(archive):
                    pass
                self.prepare(task)
                self.phase(task, 'protecting-current-state')
                task['protection'] = self.snapshot(task, protection=True)
                self.save(task)
                self.phase(task, 'restoring-data')
                self.restore_payload(archive)
                if action == 'rollback':
                    for info in saved['containers']:
                        self.engine.replace(info, info['Image'])
                self.start_containers(task['containers'])
                task['result'] = self.verify_business(task)
                if action == 'rollback':
                    for info in saved['containers']:
                        self.engine.tag(info['Image'], 'park-box-' + info['Config']['Labels']['com.docker.compose.service'] + ':current')
                self.clear_maintenance()
            else:
                with self.release(task['name']) as (work, manifest):
                    self.capacity(sum(p.stat().st_size for p in work.rglob('*') if p.is_file()) * 2)
                    for service, image in manifest['images'].items():
                        self.engine.load(work / image['archive'])
                        actual = self.engine.image(image['reference'])
                        if actual['Id'] != image['id'] or actual['Architecture'] != 'amd64':
                            raise ValueError('Loaded image does not match the signed release')
                    self.prepare(task)
                    self.phase(task, 'protecting-current-state')
                    task['protection'] = self.snapshot(task, protection=True)
                    self.save(task)
                    self.phase(task, 'installing-release')
                    for info in task['containers']:
                        service = info['Config']['Labels'].get('com.docker.compose.service')
                        if service in manifest['images']:
                            self.engine.replace(info, manifest['images'][service]['id'])
                    atomic_json(self.data / 'config/release.json', manifest)
                    self.start_containers(task['containers'])
                    task['result'] = self.verify_business(task)
                    for info in task['containers']:
                        service = info['Config']['Labels'].get('com.docker.compose.service')
                        if service in manifest['images'] and self.engine.inspect(info['Name'].lstrip('/'))['Image'] != manifest['images'][service]['id']:
                            raise RuntimeError('Running component version does not match the release')
                    atomic_json(self.root / 'rollback.json', {'archive': task['protection'], 'containers': task['containers']})
                    for info in task['containers']:
                        service = info['Config']['Labels'].get('com.docker.compose.service')
                        if service in manifest['images']:
                            self.engine.tag(manifest['images'][service]['id'], 'park-box-' + service + ':current')
                    self.clear_maintenance()
            self.phase(task, 'complete', 'succeeded')
        except Exception as error:
            task['error'] = self.error(error)
            try:
                if task.get('containers'):
                    if task.get('protection'):
                        self.recover(task)
                    else:
                        self.start_containers(task['containers'])
                        self.verify_business(task)
                        self.clear_maintenance()
                        task['recovered'] = True
                else:
                    self.clear_maintenance()
            except Exception as recovery_error:
                task['recovery_error'] = self.error(recovery_error)
            self.phase(task, 'failed', 'failed')


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='/config/agent.json')
    options = parser.parse_args()
    config = json.loads(Path(options.config).read_text())
    agent = BoxAgent(config)
    socket = Path(config.get('socket', '/socket/agent.sock'))
    socket.parent.mkdir(parents=True, exist_ok=True)
    socket.unlink(missing_ok=True)

    class Handler(http.server.BaseHTTPRequestHandler):
        def respond(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            try:
                if self.path == '/status':
                    self.respond(200, agent.status())
                elif self.path.startswith('/tasks/'):
                    self.respond(200, agent.public_task(agent.task(self.path.split('/')[-1])))
                else:
                    self.respond(404, {'error': 'Unknown operation'})
            except Exception as error:
                self.respond(503, {'error': agent.error(error)})

        def do_POST(self):
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if self.path != '/tasks' or not 0 < length <= 4096:
                    raise ValueError('Invalid operation request')
                self.respond(202, agent.public_task(agent.submit(json.loads(self.rfile.read(length)))))
            except Exception as error:
                self.respond(409 if isinstance(error, ValueError) else 503, {'error': agent.error(error)})

        def log_message(self, *args):
            pass

    with Server(str(socket), Handler) as server:
        socket.chmod(0o660)
        server.serve_forever()


if __name__ == '__main__':
    main()
