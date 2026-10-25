#!/usr/bin/env python3
"""Publish the exact installed candidate after all source CI workflows succeed."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from release import digest, release_metadata, stream_digest, verified_archive, verify_archive

REPOSITORY = 'sudoprivacy/moss'
COS_BASE = 'https://sudowork-release-1309794936.cos.accelerate.myqcloud.com'
COS_PREFIX = 'moss/gvisor/releases'
SELF_WORKFLOW = '.github/workflows/publish-gvisor.yml'


def gh(arguments, optional=False):
    """Use the workflow's GitHub identity without moving tokens into command arguments."""
    result = subprocess.run(['gh', *arguments], capture_output=True, text=True, check=False)
    if result.returncode:
        if optional and 'HTTP 404' in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    return result.stdout


def api(path):
    return json.loads(gh(['api', 'repos/' + REPOSITORY + '/' + path]))


def pages(path, field):
    """Retain all exact-source runs and jobs, including reruns beyond the first page."""
    items, page = [], 1
    while True:
        result = api(path + ('&' if '?' in path else '?') + 'per_page=100&page=' + str(page))
        rows = result[field]
        items.extend(rows)
        if len(rows) < 100:
            return items
        page += 1


def validate_source_runs(runs):
    """Every latest source workflow must succeed; publication has its own separate gate."""
    latest = {}
    for run in runs:
        if run['path'].split('@', 1)[0] == SELF_WORKFLOW:
            continue
        key = run['workflow_id']
        if key not in latest or (run['id'], run['run_attempt']) > (latest[key]['id'], latest[key]['run_attempt']):
            latest[key] = run
    required = {'gVisor storage qualification', 'Build Moss Server Release', 'lint'}
    if not required <= {run['name'] for run in latest.values()}:
        raise ValueError('Required source CI workflows are missing')
    failed = [(run['name'], run['status'], run['conclusion']) for run in latest.values()
              if run['status'] != 'completed' or run['conclusion'] != 'success']
    if failed:
        raise ValueError('Source CI is incomplete: ' + json.dumps(failed))
    return list(latest.values())


def source_gate(run_id, candidate):
    """Require an exact, merged, clean source and a real installed-archive qualification."""
    if not re.fullmatch('[0-9]+', run_id):
        raise ValueError('A numeric qualification run ID is required')
    run = api('actions/runs/' + run_id)
    if (run['path'].split('@', 1)[0] != '.github/workflows/gvisor-storage.yml' or
            run['event'] != 'push' or run['head_branch'] != 'dev' or
            run['status'] != 'completed' or run['conclusion'] != 'success'):
        raise ValueError('Use a successful dev push qualification run')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if head != run['head_sha'] or subprocess.check_output(['git', 'status', '--porcelain']).strip():
        raise ValueError('The publication checkout must be the clean qualification source')
    subprocess.run(['git', 'merge-base', '--is-ancestor', head, 'origin/dev'], check=True)
    workflows = validate_source_runs(pages('actions/runs?head_sha=' + head, 'workflow_runs'))
    for workflow in workflows:
        for job in pages('actions/runs/' + str(workflow['id']) + '/jobs?filter=latest', 'jobs'):
            if job['status'] != 'completed' or job['conclusion'] not in ('success', 'skipped', 'neutral'):
                raise ValueError('Source CI job is incomplete: ' + job['name'])
    proof = json.loads((candidate / 'qualification.json').read_text())
    release = release_metadata(json.loads((candidate / 'release.json').read_text()))
    if not proof.get('success') or proof['sourceRevision'] != head or proof['release'] != release:
        raise ValueError('Candidate qualification differs from the reviewed source')
    if proof['installation']['archiveSha256'] != release['archiveSha256']:
        raise ValueError('Qualification must use the distributed archive')
    if not proof['shim']['success'] or proof['shim']['installation']['archiveSha256'] != release['archiveSha256']:
        raise ValueError('Publication requires the distributed shim qualification')
    if (candidate / release['filename']).stat().st_size != release['archiveBytes']:
        raise ValueError('Distributed archive size differs')
    with verified_archive(candidate / release['filename'], release['archiveSha256']) as archive:
        manifest = verify_archive(archive, release['manifestSha256'])
        provenance = json.loads(archive.extractfile('provenance.json').read())
    if manifest['version'] != release['version'] or provenance['manifestSha256'] != release['manifestSha256']:
        raise ValueError('Release metadata differs from the qualified executable manifest')
    tools = Path(__file__).resolve().parent
    for name, expected in provenance['recipeFiles'].items():
        if digest(tools / name) != expected:
            raise ValueError('Published recipe differs: ' + name)
    if provenance['packagerSha256'] != digest(tools / 'package.py'):
        raise ValueError('Published packager differs')
    if digest(tools / 'release.py') != proof['syscalls']['releaseLibrarySha256']:
        raise ValueError('Qualification must use the published release verifier')
    return run, release


def public_digest(url):
    """Verify public bytes; only a confirmed 404 means an object is absent."""
    try:
        with urllib.request.urlopen(url, timeout=180) as file:
            return stream_digest(file)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def publish(run_id, candidate, dry_run):
    run, release = source_gate(run_id, candidate)
    tag = 'gvisor-' + release['version']
    object_path = COS_PREFIX + '/' + release['version'] + '/' + release['archiveSha256']
    urls = [COS_BASE + '/' + object_path + '/' + release['filename'],
            'https://github.com/' + REPOSITORY + '/releases/download/' + tag + '/' + release['filename']]
    metadata = {**release, 'sourceRevision': run['head_sha'], 'qualificationRun': int(run_id), 'urls': urls}
    if dry_run:
        return {'releaseTag': tag, 'metadata': metadata, 'published': False}
    if not shutil.which('coscmd'):
        raise RuntimeError('The configured COS publisher is required')
    with tempfile.TemporaryDirectory(prefix='gvisor-publication-') as directory:
        assets = Path(directory)
        shutil.copyfile(candidate / release['filename'], assets / release['filename'])
        shutil.copyfile(candidate / 'qualification.json', assets / 'qualification.json')
        (assets / 'release.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
        (assets / 'SHA256SUMS').write_text(''.join(digest(path) + '  ' + path.name + '\n'
                                                 for path in sorted(assets.iterdir())), encoding='utf-8')
        current = gh(['api', 'repos/' + REPOSITORY + '/releases/tags/' + tag], optional=True)
        if current is not None and json.loads(current)['target_commitish'] != run['head_sha']:
            raise ValueError('An existing release belongs to a different source')
        for path in sorted(assets.iterdir()):
            url = COS_BASE + '/' + object_path + '/' + path.name
            expected = digest(path)
            observed = public_digest(url)
            if observed is not None and observed != expected:
                raise ValueError('Existing content-addressed COS object differs: ' + path.name)
            if observed is None:
                subprocess.run(['coscmd', 'upload', '-H', '{"Cache-Control":"public, max-age=31536000, immutable"}',
                                str(path), object_path + '/' + path.name], check=True)
                if public_digest(url) != expected:
                    raise ValueError('Published COS bytes differ: ' + path.name)
        if current is None:
            gh(['release', 'create', tag, '--repo', REPOSITORY, '--target', run['head_sha'],
                '--title', tag, '--latest=false', '--notes',
                'Complete gVisor Linux AMD64 runtime, matching sidecars and source-bound installed-archive qualification.',
                *(str(path) for path in sorted(assets.iterdir()))])
        else:
            current = json.loads(current)
            for path in sorted(assets.iterdir()):
                if path.name not in {asset['name'] for asset in current['assets']}:
                    gh(['release', 'upload', tag, '--repo', REPOSITORY, str(path)])
        downloaded = assets / 'readback'
        gh(['release', 'download', tag, '--repo', REPOSITORY, '--dir', str(downloaded)])
        for path in assets.iterdir():
            if path.is_file() and digest(path) != digest(downloaded / path.name):
                raise ValueError('Published GitHub asset differs: ' + path.name)
    return {'releaseTag': tag, 'metadata': metadata, 'published': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    print(json.dumps(publish(args.run_id, args.candidate, args.dry_run)))


if __name__ == '__main__':
    main()
