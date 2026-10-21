"""Export the complete signed release from fixed Docker image references."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from artifacts import atomic_json, digest, file_manifest, verify_signature
from docker_engine import DockerEngine
from agent import COMPONENTS


def package(version, metadata, output, key):
    if not version or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in version):
        raise ValueError('Invalid release version')
    components = json.loads(metadata.read_text())
    if not COMPONENTS.issubset(components):
        raise ValueError('Component version metadata is incomplete')
    engine = DockerEngine('park-box')
    output.mkdir(parents=True, exist_ok=True)
    archive = output / ('park-box-' + version + '.tar.gz')
    if archive.exists():
        raise ValueError('Release already exists; choose a new version')
    with tempfile.TemporaryDirectory(dir=output) as temporary:
        work = Path(temporary)
        (work / 'images').mkdir()
        images = {}
        for service in ('moss', 'nexus', 'park'):
            reference = 'park-box-' + service + ':' + version
            image = engine.image(reference)
            if image['Architecture'] != 'amd64' or image['Os'] != 'linux':
                raise ValueError('Release requires Linux amd64 images')
            name = 'images/' + service + '.tar'
            engine.export_image(reference, work / name)
            images[service] = {'reference': reference, 'id': image['Id'], 'archive': name}
        files, _ = file_manifest(work)
        release = {'format': 1, 'agent_protocol': 1, 'architecture': 'amd64', 'version': version,
                   'components': components, 'images': images, 'files': files}
        atomic_json(work / 'release.json', release)
        with tarfile.open(archive, 'w:gz') as bundle:
            for child in work.iterdir():
                bundle.add(child, arcname=child.name)
        message = work / 'signature-message'
        message.write_bytes(b'park-box-release-v1\x00' + bytes.fromhex(digest(archive)))
        subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin', '-in', str(message),
                        '-out', str(archive) + '.sig'], check=True, capture_output=True, timeout=180)
        verify_signature(archive, key.with_name('upgrade-public.pem'))
        atomic_json(output / ('park-box-' + version + '.release.json'), release)
        print('Signed release created and cryptographically verified: ' + archive.name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    parser.add_argument('--metadata', default='/config/components.json')
    parser.add_argument('--output', default='/state/artifacts/upgrades')
    parser.add_argument('--key', default='/config/upgrade-private.pem')
    options = parser.parse_args()
    package(options.version, Path(options.metadata), Path(options.output), Path(options.key))
