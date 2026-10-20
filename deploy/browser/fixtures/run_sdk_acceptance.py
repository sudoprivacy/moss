"""Run public SDK browser tests with a disposable native X11 display."""

import asyncio
import os
import sys

from ai_dev_browser.remote.window import XDisplay


async def main():
    display = XDisplay()
    try:
        environment = {**os.environ, "DISPLAY": await display.start()}
        child = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pytest", *sys.argv[1:], env=environment
        )
        return await child.wait()
    finally:
        await display.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
