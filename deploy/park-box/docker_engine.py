import http.client
import json
import socket
import io
import tarfile
import urllib.parse


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, socket_path):
        super().__init__('localhost', timeout=180)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


class DockerEngine:
    """Docker API used only for the explicitly configured box project."""

    def __init__(self, project, socket_path='/var/run/docker.sock'):
        self.project = project
        self.socket_path = socket_path

    def request(self, method, path, value=None, stream=None, length=None):
        connection = UnixConnection(self.socket_path)
        headers = {}
        body = None
        if value is not None:
            body = json.dumps(value).encode()
            headers['Content-Type'] = 'application/json'
        if stream is not None:
            body = stream
            headers['Content-Type'] = 'application/x-tar'
            headers['Content-Length'] = str(length)
        try:
            connection.request(method, '/v1.47' + path, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read()
            if response.status >= 400:
                # Engine error messages can contain environment data or command text.
                raise RuntimeError('Docker operation failed (HTTP %s)' % response.status)
            if not payload:
                return None
            try:
                return json.loads(payload)
            except ValueError:
                return payload
        finally:
            connection.close()

    def containers(self):
        filters = urllib.parse.quote(json.dumps({'label': ['com.docker.compose.project=' + self.project]}))
        # After an interrupted removal Docker can list an unnamed dead entry
        # that its inspect API already reports as missing. It has no service
        # container name and must not replace the actual Compose container.
        return [item for item in self.request('GET', '/containers/json?all=true&filters=' + filters)
                if item.get('Names')]

    def inspect(self, container):
        return self.request('GET', '/containers/' + container + '/json')

    def build_metadata(self, container):
        payload = self.request('GET', '/containers/' + container + '/archive?path=%2Fapp%2Fbox-build.json')
        if not isinstance(payload, bytes) or len(payload) > 1024 * 1024:
            raise RuntimeError('Invalid container build metadata')
        with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
            member = archive.getmember('box-build.json')
            if not member.isfile() or member.size > 64 * 1024:
                raise RuntimeError('Invalid container build metadata')
            return json.load(archive.extractfile(member))

    def stop(self, container):
        self.request('POST', '/containers/' + container + '/stop?t=60')
        if self.inspect(container)['State']['Running']:
            raise RuntimeError('Cannot prove container writers stopped')

    def start(self, container):
        self.request('POST', '/containers/' + container + '/start')

    def replace(self, original, image):
        name = original['Name'].lstrip('/')
        if original['Config'].get('Labels', {}).get('com.docker.compose.project') != self.project:
            raise RuntimeError('Refusing to restore a foreign container')
        current = next((item for item in self.containers() if '/' + name in item['Names']), None)
        if current:
            current = self.inspect(current['Id'])
        labels = (current or original)['Config'].get('Labels', {})
        if labels.get('com.docker.compose.project') != self.project or labels.get('com.docker.compose.service') == 'operations':
            raise RuntimeError('Refusing to manage a foreign container')
        if current and current['State']['Running']:
            self.stop(current['Id'])
        if current:
            self.request('DELETE', '/containers/' + current['Id'])
        spec = {**original['Config'], 'Image': image, 'HostConfig': original['HostConfig']}
        networks = original['NetworkSettings'].get('Networks', {})
        spec['NetworkingConfig'] = {'EndpointsConfig': {network: {'Aliases': endpoint.get('Aliases', [])}
                                                       for network, endpoint in networks.items()}}
        created = self.request('POST', '/containers/create?name=' + urllib.parse.quote(name), spec)
        return created['Id']

    def load(self, archive):
        with archive.open('rb') as stream:
            result = self.request('POST', '/images/load?quiet=true', stream=stream, length=archive.stat().st_size)
        if isinstance(result, bytes):
            for line in result.splitlines():
                if json.loads(line).get('error'):
                    raise RuntimeError('Docker image import failed')

    def image(self, reference):
        return self.request('GET', '/images/' + urllib.parse.quote(reference, safe='') + '/json')

    def export_image(self, reference, archive):
        connection = UnixConnection(self.socket_path)
        try:
            connection.request('GET', '/v1.47/images/' + urllib.parse.quote(reference, safe='') + '/get')
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError('Docker image export failed (HTTP %s)' % response.status)
            with archive.open('xb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        finally:
            connection.close()

    def tag(self, image, reference):
        repository, tag = reference.rsplit(':', 1)
        self.request('POST', '/images/' + urllib.parse.quote(image, safe='') + '/tag?repo=' +
                     urllib.parse.quote(repository, safe='') + '&tag=' + urllib.parse.quote(tag, safe=''))
