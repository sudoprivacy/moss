"""Expose the isolated node's native K3s lifecycle to the production installer."""
import json
import re
import subprocess
import time
import uuid


class NodeService:
    """Keep the helper in its own PID namespace and exchange one scoped request."""
    def __init__(self, directory, node=None, inspect=None):
        self.directory, self.node, self.inspect = directory, node, inspect

    def command(self, *arguments):
        from deploy.runtime.gvisor.node import command
        if arguments == ('systemctl', 'show', 'k3s', '--property=KillMode,ExecStop,ActiveState,ExecStart,Environment'):
            return 'KillMode=process\nExecStop=\nActiveState=active\nExecStart=/bin/k3s server\nEnvironment=\n'
        if arguments == ('systemctl', 'is-active', 'k3s'):
            command('k3s', 'crictl', 'info')
            return 'active\n'
        if arguments == ('systemctl', 'restart', 'k3s'):
            token = uuid.uuid4().hex
            request = self.directory / 'node-service.request'
            assert not request.exists(), 'A node lifecycle operation is already pending'
            temporary = request.with_suffix('.new')
            temporary.write_text(json.dumps({'action': 'restart-k3s', 'token': token}))
            temporary.replace(request)
            response = self.directory / ('node-service-' + token + '.json')
            end = time.monotonic() + 90
            while time.monotonic() < end:
                if response.exists():
                    result = json.loads(response.read_text())
                    if not result['success']:
                        raise RuntimeError(result['error'])
                    return ''
                time.sleep(0.1)
            raise TimeoutError('The owned K3s lifecycle adapter did not respond')
        return command(*arguments)

    def identity(self):
        self.inspect(self.node)
        output = subprocess.check_output(['docker', 'exec', self.node, '/bin/sh', '-c',
            'read pid ticks < /run/moss-k3s.identity; '
            '[ "$(awk \'{print $22}\' /proc/$pid/stat)" = "$ticks" ]; '
            '[ "$(readlink /proc/$pid/exe)" = /bin/k3s ]; '
            'printf "%s %s\\n" "$pid" "$ticks"'], text=True, timeout=15)
        fields = output.split()
        assert len(fields) == 2 and all(field.isdecimal() for field in fields)
        return fields

    def poll(self):
        """Execute only a validated restart on the exact owned native process."""
        request = self.directory / 'node-service.request'
        if not request.exists():
            return
        operation = json.loads(request.read_text())
        assert set(operation) == {'action', 'token'} and operation['action'] == 'restart-k3s'
        token = operation['token']
        assert isinstance(token, str) and re.fullmatch('[a-f0-9]{32}', token)
        response = self.directory / ('node-service-' + token + '.json')
        assert not response.exists()
        result = {'success': False, 'action': operation['action']}
        try:
            before = self.identity()
            self.inspect(self.node)
            subprocess.run(['docker', 'exec', self.node, '/bin/sh', '-c',
                'read pid ticks < /run/moss-k3s.identity; [ "$pid $ticks" = "$1 $2" ]; '
                '[ "$(awk \'{print $22}\' /proc/$pid/stat)" = "$ticks" ]; '
                '[ "$(readlink /proc/$pid/exe)" = /bin/k3s ]; '
                'touch /run/moss-k3s.restart; kill -TERM "$pid"', 'restart', *before], check=True, timeout=15)
            end = time.monotonic() + 60
            while time.monotonic() < end:
                try:
                    after = self.identity()
                except subprocess.CalledProcessError:
                    time.sleep(0.1)
                    continue
                if after != before:
                    result.update(success=True, before=before, after=after)
                    break
                time.sleep(0.1)
            if not result['success']:
                raise TimeoutError('The owned K3s service did not restart')
        except Exception as error:
            result['error'] = str(error)
        temporary = response.with_suffix('.new')
        temporary.write_text(json.dumps(result, indent=2))
        temporary.replace(response)
        request.unlink()
