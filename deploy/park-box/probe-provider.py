"""Read the local deployment input and verify real inference without printing secrets."""
import json
from pathlib import Path
import time
import sys
import urllib.request
import urllib.error

setup = json.loads((Path(__file__).parent / 'configuration/setup.json').read_text(encoding='utf8'))
model = setup['model']
if len(sys.argv) > 1:
    model['model'] = sys.argv[1]
provider = next(value for value in model['modelProviders'] if value['id'] == model['defaultModelProviderId'])
request = urllib.request.Request(provider['baseUrl'].rstrip('/') + '/chat/completions',
    json.dumps({'model': model['model'], 'messages': [{'role': 'user', 'content': 'Reply with OK.'}], 'max_tokens': 16}).encode(),
    {'Authorization': 'Bearer ' + model['apiKey'], 'Content-Type': 'application/json'})
started = time.monotonic()
try:
    with urllib.request.urlopen(request, timeout=45) as response:
        result = json.load(response)
        answer = result['choices'][0]['message']['content']
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError('The model returned no text')
        print(json.dumps({'http_status': response.status, 'has_answer': True, 'latency_ms': int((time.monotonic() - started) * 1000)}))
except urllib.error.HTTPError as error:
    value = error.read(4096).decode(errors='replace').replace(model['apiKey'], '[REDACTED]')
    print(json.dumps({'http_status': error.code, 'reason': value}, ensure_ascii=False))
