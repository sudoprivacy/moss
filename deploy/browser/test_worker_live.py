"""Actual Chrome and HTTP authorization workflow for the isolated worker."""

import asyncio
import importlib.util
import json
import pathlib
import sys

import pytest

import aiohttp
from aiohttp import web

sys.path.insert(0, str(pathlib.Path(__file__).parent))
module = importlib.util.spec_from_file_location(
    "moss_browser_worker", pathlib.Path(__file__).with_name("worker.py")
)
worker_module = importlib.util.module_from_spec(module)
module.loader.exec_module(worker_module)


@pytest.mark.asyncio
async def test_worker_handoff_rejects_ai_and_preserves_profile(remote_site, tmp_path):
    worker = worker_module.Worker(tmp_path, "fixture-host", "fixture-ai")
    runner = web.AppRunner(worker_module.application(worker))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    endpoint = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    binding = {"orgId": "fixture", "userId": "owner", "sessionId": "conversation"}
    async with aiohttp.ClientSession() as http:

        async def invoke(action, *, identity=binding, token="fixture-host"):
            async with http.post(
                endpoint + "/invoke",
                json={
                    "binding": identity,
                    "controller": "user-fixture",
                    "action": action,
                },
                headers={"Authorization": "Bearer " + token},
            ) as response:
                return response.status, await response.json(content_type=None)

        async def agent(action):
            async with http.post(
                endpoint + "/agent",
                json=action,
                headers={"Authorization": "Bearer fixture-ai"},
            ) as response:
                return response.status, await response.json()

        try:
            status, stopped = await invoke({"kind": "state"})
            assert status == 200 and stopped["session"]["state"] == "stopped"
            status, started = await agent(
                {"kind": "start", "transport": "cdp", "isHeadless": True}
            )
            assert status == 200, started
            assert worker.display is None
            assert started["session"]["transport"] == "cdp"
            epoch = started["session"]["controlEpoch"]
            status, navigated = await agent(
                {
                    "kind": "navigate",
                    "url": remote_site[0],
                    "controlEpoch": epoch,
                    "targetEpoch": 0,
                }
            )
            assert status == 200, navigated
            # A real page dialog must be visible through the host state and
            # answerable after takeover; page pixels alone cannot handle it.
            deadline = asyncio.get_running_loop().time() + 10
            while True:
                status, ready = await agent(
                    {
                        "kind": "command",
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": "document.querySelector('#name') !== null",
                            "returnByValue": True,
                        },
                        "controlEpoch": epoch,
                        "targetEpoch": 0,
                    }
                )
                assert status == 200, ready
                if ready["result"].get("result", {}).get("value") is True:
                    break
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.05)
            status, prompted = await agent(
                {
                    "kind": "command",
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": "setTimeout(()=>{window.fixtureDialogResult=confirm('Continue after human review?')},50);true",
                        "returnByValue": True,
                    },
                    "controlEpoch": epoch,
                    "targetEpoch": 0,
                }
            )
            assert status == 200, prompted
            status, held = await invoke(
                {"kind": "take", "controlEpoch": epoch, "targetEpoch": 0}
            )
            assert status == 200, held
            epoch = held["session"]["controlEpoch"]
            deadline = asyncio.get_running_loop().time() + 10
            while True:
                status, prompted = await invoke({"kind": "state"})
                assert status == 200, prompted
                if prompted["session"]["dialog"]:
                    break
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.05)
            assert (
                prompted["session"]["dialog"]["message"]
                == "Continue after human review?"
            )
            status, answered = await invoke(
                {
                    "kind": "input",
                    "surface": "page",
                    "input": {"kind": "dialog", "accept": True},
                    "controlEpoch": epoch,
                    "targetEpoch": 0,
                }
            )
            assert status == 200, answered
            assert answered["session"]["dialog"] is None
            for event in [
                {"kind": "click", "x": 80, "y": 45},
                {"kind": "text", "text": "Manual worker input"},
            ]:
                status, reply = await invoke(
                    {
                        "kind": "input",
                        "input": event,
                        "controlEpoch": epoch,
                        "targetEpoch": 0,
                    }
                )
                assert status == 200, reply
            status, rejected = await agent(
                {
                    "kind": "command",
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": "document.querySelector('#name').value='bypass'"
                    },
                    "controlEpoch": epoch,
                    "targetEpoch": 0,
                }
            )
            assert status == 409 and rejected["error"] == "browser_control_held_by_user"
            status, rejected = await invoke(
                {"kind": "state"}, identity={**binding, "userId": "other"}
            )
            assert status == 409 and rejected["error"] == "browser_profile_in_use"
            # The AI capability cannot call the human endpoint.
            async with http.post(
                endpoint + "/invoke",
                json={},
                headers={"Authorization": "Bearer fixture-ai"},
            ) as response:
                assert response.status == 403
            saved = json.loads((tmp_path / "control.json").read_text())
            assert saved["controller"] == "user-fixture" and saved["state"] == "human"
            with pytest.raises(
                RuntimeError, match="managed_browser_profile_already_owned"
            ):
                worker_module.Worker(tmp_path, "fixture-host", "fixture-ai")

            status, resumed = await invoke(
                {"kind": "return", "controlEpoch": epoch, "targetEpoch": 0}
            )
            assert status == 200, resumed
            assert any(
                node.get("value", {}).get("value") == "Manual worker input"
                for node in resumed["observation"]["accessibility"]
            )
            assert resumed["session"]["state"] == "ai"
            assert (
                resumed["session"]["browserSessionId"]
                == started["session"]["browserSessionId"]
            )
            assert resumed["session"]["profileId"] == started["session"]["profileId"]

            # The actual HTTP MCP endpoint shares this browser and lease.
            async def mcp(name, arguments):
                async with http.post(
                    endpoint + "/mcp",
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {"name": name, "arguments": arguments},
                    },
                    headers={"Authorization": "Bearer fixture-ai"},
                ) as response:
                    assert response.status == 200
                    return (await response.json())["result"]

            observed = await mcp("browser_observe", {})
            assert not observed.get("isError"), observed
            assert any(item["type"] == "image" for item in observed["content"])
            state = json.loads(observed["content"][0]["text"])["session"]
            status, held = await invoke(
                {
                    "kind": "take",
                    "controlEpoch": state["controlEpoch"],
                    "targetEpoch": state["targetEpoch"],
                }
            )
            assert status == 200
            rejected = await mcp(
                "browser_action",
                {
                    "kind": "reload",
                    "controlEpoch": held["session"]["controlEpoch"],
                    "targetEpoch": held["session"]["targetEpoch"],
                },
            )
            assert (
                rejected["isError"]
                and rejected["content"][0]["text"] == "browser_control_held_by_user"
            )
        finally:
            await runner.cleanup()
    recovered = worker_module.Worker(tmp_path, "fixture-host", "fixture-ai")
    try:
        assert recovered.control.state == "error"
        assert recovered.control.controller == "user-fixture"
    finally:
        await recovered.close()
