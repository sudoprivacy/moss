#!/usr/bin/env python3
"""Exercise real archive download fallback and disconnected recovery before installation."""
import argparse
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from deploy.runtime.gvisor.fetch import fetch
from deploy.runtime.gvisor.release import digest, release_metadata


def qualify(distribution, cache, results):
    """Use the distributed bytes and same production fetcher for both network modes."""
    release = release_metadata(json.loads((distribution / 'release.json').read_text()))
    archive = distribution / release['filename']
    results.mkdir(parents=True, exist_ok=False)
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
            if self.path == '/bad':
                self.wfile.write(b'incorrect archive')
                return
            with archive.open('rb') as file:
                shutil.copyfileobj(file, self.wfile)
        def log_message(self, *_arguments):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    proof = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'sources': {'fixture': digest(Path(__file__)), 'fetcher': digest(Path(fetch.__code__.co_filename))},
             'release': release, 'requests': requests, 'success': False}
    try:
        thread.start()
        origin = 'http://127.0.0.1:' + str(server.server_port)
        metadata = results / 'release.json'
        metadata.write_text(json.dumps({**release, 'urls': [origin + '/bad', origin + '/good']}))
        pin = digest(metadata)
        online = fetch(metadata, pin, cache)
        server.shutdown()
        server.server_close()
        thread.join()
        offline = fetch(metadata, pin, cache, offline=True)
        if requests != ['/bad', '/good'] or online != offline:
            raise ValueError('Disconnected recovery must use the exact downloaded archive')
        proof.update({'archivePath': online['archivePath'], 'releaseMetadataSha256': pin,
                      'onlineEqualsOffline': True, 'serverStoppedBeforeRestore': True, 'success': True})
    finally:
        if thread.is_alive():
            server.shutdown()
            server.server_close()
            thread.join()
        proof['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (results / 'receipt.json').write_text(json.dumps(proof, indent=2))
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distribution', required=True, type=Path)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--results', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(qualify(args.distribution, args.cache, args.results)))


if __name__ == '__main__':
    main()
