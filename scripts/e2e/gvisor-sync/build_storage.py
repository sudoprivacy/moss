#!/usr/bin/env python3
"""Build the pinned Nexus storage suites without running tests at compiler priority."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from deploy.runtime.gvisor.release import digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    lock = json.loads(Path(__file__).with_name('nexus-source.lock.json').read_text())
    source = args.source.resolve(strict=True)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    assert revision == lock['revision'], 'Nexus source differs from the reviewed commit'
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=source).strip()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    target = args.target.resolve()
    environment = {
        **os.environ, 'CARGO_TARGET_DIR': str(target), 'CARGO_BUILD_JOBS': '1',
        'CARGO_INCREMENTAL': '0', 'CARGO_PROFILE_DEV_DEBUG': '0',
        'CARGO_PROFILE_TEST_DEBUG': '0', 'CMAKE_BUILD_PARALLEL_LEVEL': '1',
    }
    receipt = {
        'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'sourceRevision': revision, 'lockSha256': digest(Path(__file__).with_name('nexus-source.lock.json')),
        'sourceFiles': {name: digest(source / name) for name in
                        ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']},
        'builds': [],
    }
    files = {}
    try:
        for label, package, selection in [
            ('lib-tests', 'lib', ['--features', 'redb-storage', '--lib']),
            ('cas-tests', 'kernel', ['--test', 'cas_publication']),
        ]:
            command = ['nice', '-n', '10', 'cargo', 'test', '--locked', '-p', package,
                       *selection, '--no-run', '--message-format=json']
            with (output / (label + '.stdout.log')).open('wb') as out, \
                 (output / (label + '.stderr.log')).open('wb') as err:
                result = subprocess.run(command, cwd=source, env=environment,
                                        stdout=out, stderr=err, check=False)
            receipt['builds'].append({'command': command, 'exitCode': result.returncode})
            assert result.returncode == 0, f'{label}: build failed; logs retained'
            objects = [json.loads(line) for line in (output / (label + '.stdout.log')).read_text().splitlines()
                       if line.startswith('{')]
            artifacts = [item for item in objects if item.get('reason') == 'compiler-artifact'
                         and item.get('executable') and item['profile']['test']]
            assert len(artifacts) == 1, artifacts
            destination = output / label
            shutil.copyfile(artifacts[0]['executable'], destination)
            destination.chmod(0o755)
            files[label] = digest(destination)
        manifest = output / 'manifest.json'
        manifest.write_text(json.dumps({'sourceRevision': revision, 'files': files}, indent=2))
        receipt['manifestSha256'] = digest(manifest)
        receipt['success'] = True
    finally:
        receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (output / 'build.json').write_text(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
