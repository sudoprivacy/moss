"""Acquire pinned releases and execute the real owner-Pod acceptance entrypoint."""
import argparse
import json
from pathlib import Path

from cluster import run_cluster
from deploy.runtime.gvisor.release import acquire, relative_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', required=True, type=Path)
    parser.add_argument('--bin-dir', required=True, type=Path)
    parser.add_argument('--shared-source', required=True, type=Path)
    parser.add_argument('--helper-image', required=True)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    pin = json.loads((Path(__file__).parent / 'acceptance.lock.json').read_text())['worker']
    cache = args.cache.resolve()
    worker_cache = cache / 'worker'
    worker_cache.mkdir(parents=True, exist_ok=True)
    args.worker_release = worker_cache / 'runtime-release.json'
    acquire([] if args.offline else pin['metadataUrls'], pin['metadataSha256'], args.worker_release)
    worker = json.loads(args.worker_release.read_text())
    name = relative_file(worker['archive']['name'])
    args.worker_archive = worker_cache / name
    assert worker['archive']['digest'].startswith('sha256:')
    acquire([] if args.offline else [base + name for base in pin['archiveBases']],
            worker['archive']['digest'][7:], args.worker_archive)
    args.gvisor_cache = cache / 'gvisor'
    run_cluster(args)


if __name__ == '__main__':
    main()
