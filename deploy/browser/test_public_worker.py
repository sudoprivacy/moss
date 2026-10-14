"""Check the host's discovery contract against the public package owner."""

import json
from importlib import resources
from pathlib import Path


def test_discovery_manifest_matches_the_installed_public_sdk():
    owned = resources.files("ai_dev_browser.remote").joinpath("mcp-tools.json")
    assert json.loads(owned.read_text(encoding="utf-8")) == json.loads(
        Path(__file__).with_name("mcp-tools.json").read_text(encoding="utf-8")
    )
