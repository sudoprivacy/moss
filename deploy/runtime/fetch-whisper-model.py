"""Fetch the subtitle model into the image, surviving Hugging Face rate limits.

The download runs on a shared GitHub runner whose egress IP is shared with
everyone else's builds, so an unauthenticated request regularly answers
`429 ... you have reached your 'api' rate limit` — a build failure that has
nothing to do with the change being built. The limit is counted over a 300s
window and the error says how long to wait, so the fix is to wait rather than
to fail the build.

`HF_TOKEN` is used when the build was given one (an authenticated request has
its own, much higher budget); without one this behaves exactly as before, just
patiently.
"""

import os
import sys
import time

from huggingface_hub import snapshot_download

REPO = "Systran/faster-whisper-small"
REVISION = "536b0662742c02347bc0e980a01041f333bce120"
LOCAL_DIR = "/opt/sudowork-models/faster-whisper-small"
# Everything the runtime loads; the full repo carries weights we never read.
PATTERNS = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]

# 20+40+60+80+100 = 300s of waiting, which is exactly one rate-limit window —
# enough for the budget to reset once, and bounded so a real outage still fails.
BACKOFF_SECONDS = [20, 40, 60, 80, 100]


def main() -> int:
    token = os.environ.get("HF_TOKEN") or None
    attempts = len(BACKOFF_SECONDS) + 1
    for attempt in range(attempts):
        try:
            snapshot_download(
                REPO,
                revision=REVISION,
                local_dir=LOCAL_DIR,
                allow_patterns=PATTERNS,
                token=token,
            )
            return 0
        except Exception as error:  # noqa: BLE001 — any failure is worth retrying once
            if attempt == attempts - 1:
                raise
            delay = BACKOFF_SECONDS[attempt]
            print(
                f"[whisper-model] attempt {attempt + 1}/{attempts} failed: {error}\n"
                f"[whisper-model] retrying in {delay}s",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(delay)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
