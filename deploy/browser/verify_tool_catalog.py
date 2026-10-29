"""Check or regenerate pre-launch tools from the installed public browser SDK.

Run this inside the worker image with the deployment directory mounted read-only
to verify a release. Use --update in a checkout with the intended SDK installed
to regenerate its catalog. Neither operation launches a browser.
"""

import argparse
from importlib.metadata import version
from importlib.resources import files
import json
from pathlib import Path


def run(catalog, *, update=False):
    expected = json.loads(
        files("ai_dev_browser.remote").joinpath("mcp-tools.json").read_text("utf-8")
    )
    if not isinstance(expected, list) or not expected:
        raise ValueError("Installed SDK did not provide a tool catalog")
    if update:
        catalog.write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
    actual = json.loads(catalog.read_text(encoding="utf-8-sig"))
    matches = json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True)
    print(
        json.dumps(
            {
                "sdkVersion": version("ai-dev-browser"),
                "toolCount": len(expected),
                "catalogMatches": matches,
                "updated": update,
                "browserLaunched": False,
            }
        )
    )
    if not matches:
        raise SystemExit(
            "Moss pre-launch MCP tools differ from the installed SDK; "
            "regenerate this catalog with that SDK before publishing the host."
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--catalog", type=Path, default=Path(__file__).with_name("mcp-tools.json")
    )
    parser.add_argument("--update", action="store_true")
    args = parser.parse_args()
    run(args.catalog, update=args.update)
