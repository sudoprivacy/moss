"""Moss deployment policy for the public ai-dev-browser worker."""

import os
from pathlib import Path

from ai_dev_browser.remote.worker import Worker as BrowserWorker
from ai_dev_browser.remote.worker import application
from aiohttp import web


class Worker(BrowserWorker):
    """Keep cloud Chrome's display and extension policy in the host."""

    def __init__(self, root, host_token, ai_token, *, chrome_path=None):
        super().__init__(
            root,
            host_token,
            ai_token,
            chrome_path=chrome_path,
            display_mode="x11",
            extension_directory=Path("/opt/browser/extension"),
            chrome_args=["--no-sandbox"] if os.name != "nt" else [],
        )


if __name__ == "__main__":
    host_token = os.environ.pop("MOSS_BROWSER_HOST_TOKEN")
    ai_token = os.environ.pop("MOSS_BROWSER_AI_TOKEN")
    worker = Worker(
        os.environ.get("MOSS_BROWSER_PROFILE_ROOT", "/profile"),
        host_token,
        ai_token,
        chrome_path=os.environ.get("AI_DEV_BROWSER_CHROME"),
    )
    web.run_app(
        application(worker),
        host="0.0.0.0",
        port=int(os.environ.get("MOSS_BROWSER_PORT", "8080")),
        access_log=None,
    )
