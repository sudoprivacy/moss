#!/usr/bin/env python3
"""Acquire a pinned complete runtime archive for online or offline installation."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from deploy.runtime.gvisor.release import acquire, release_metadata, sha256, verified_archive, verify_archive


def distribution(architecture, preference='auto', metadata=None):
    """Select the bundled qualified release or the requested upstream channel."""
    if architecture not in ('amd64', 'arm64'):
        raise ValueError('A supported compute architecture is required')
    metadata = metadata or Path(__file__).with_name('distribution.lock.json')
    raw = metadata.read_bytes()
    release = release_metadata(json.loads(raw))
    if preference in ('auto', 'qualified') and release['architecture'] == 'linux-' + architecture:
        return {'provider': 'qualified', 'release': str(metadata.resolve()),
                'releaseSha256': hashlib.sha256(raw).hexdigest()}
    if preference == 'qualified':
        raise ValueError('The bundled qualified runtime does not support ' + architecture)
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]*', preference):
        raise ValueError('Invalid upstream runtime release')
    return {'provider': 'upstream', 'version': 'latest' if preference == 'auto' else preference}


def fetch(metadata, metadata_sha, cache, offline=False):
    """Use one authenticated identity and complete verifier in both network modes."""
    with metadata.open('rb') as file:
        raw = file.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024 or hashlib.sha256(raw).hexdigest() != sha256(metadata_sha):
        raise ValueError('Runtime release metadata checksum differs')
    release = release_metadata(json.loads(raw))
    size = release.get('archiveBytes')
    if type(size) is not int or size <= 0:
        raise ValueError('A complete runtime archive size is required')
    urls = release.get('urls')
    if not isinstance(urls, list) or not urls or any(not isinstance(url, str) or not url for url in urls):
        raise ValueError('Runtime release sources are required')
    destination = cache / release['archiveSha256'] / release['filename']
    if not offline:
        destination.parent.mkdir(parents=True, exist_ok=True)
        acquire(urls, release['archiveSha256'], destination)
    if not destination.is_file():
        raise FileNotFoundError('Runtime archive is missing from the cache: ' + str(destination))
    if destination.stat().st_size != size:
        raise ValueError('Runtime archive size differs')
    with verified_archive(destination, release['archiveSha256']) as archive:
        verify_archive(archive, release['manifestSha256'])
    return {**release, 'archivePath': str(destination), 'releaseMetadataSha256': metadata_sha}


def main():
    if sys.argv[1:2] == ['plan']:
        parser = argparse.ArgumentParser(description='Select the authenticated bundled runtime for a compute architecture.')
        parser.add_argument('--architecture', required=True, choices=['amd64', 'arm64'])
        parser.add_argument('--preference', default='auto')
        args = parser.parse_args(sys.argv[2:])
        print(json.dumps(distribution(args.architecture, args.preference)))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--release-sha256', required=True)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    print(json.dumps(fetch(args.release, args.release_sha256, args.cache, args.offline)))


if __name__ == '__main__':
    main()
