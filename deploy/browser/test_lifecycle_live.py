"""Real Chrome lifecycle: persistent login, explicit restart and human control."""

import asyncio
import importlib.util
import json
import os
import pathlib
import sys
import uuid

import aiohttp
import pytest
from aiohttp import web

sys.path.insert(0, str(pathlib.Path(__file__).parent))
spec = importlib.util.spec_from_file_location(
    "lifecycle_worker", pathlib.Path(__file__).with_name("worker.py")
)
worker_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_module)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "transport", os.environ.get("MOSS_BROWSER_LIVE_TRANSPORTS", "cdp").split(",")
)
async def test_real_browser_restart_preserves_login_and_human_stop(
    remote_site, tmp_path, transport
):
    assert transport in ("cdp", "extension")
    is_headful = os.environ.get("MOSS_BROWSER_TEST_HEADFUL") == "1"
    worker = worker_module.Worker(tmp_path, "lifecycle-host", "lifecycle-ai")
    runner = web.AppRunner(worker_module.application(worker))
    await runner.setup()
    server = web.TCPSite(runner, "127.0.0.1", 8080 if transport == "extension" else 0)
    await server.start()
    endpoint = f"http://127.0.0.1:{server._server.sockets[0].getsockname()[1]}"
    binding = {"orgId": "fixture", "userId": "owner", "sessionId": "lifecycle"}
    cookie = "login_" + uuid.uuid4().hex

    async with aiohttp.ClientSession() as http:

        async def host(action):
            async with http.post(
                endpoint + "/invoke",
                json={
                    "binding": binding,
                    "controller": "user-fixture",
                    "action": action,
                },
                headers={"Authorization": "Bearer lifecycle-host"},
            ) as response:
                return response.status, await response.json()

        async def agent(action):
            async with http.post(
                endpoint + "/agent",
                json=action,
                headers={"Authorization": "Bearer lifecycle-ai"},
            ) as response:
                return response.status, await response.json()

        def epochs(reply):
            return {
                key: reply["session"][key] for key in ("controlEpoch", "targetEpoch")
            }

        async def mcp(name, arguments):
            async with http.post(
                endpoint + "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                },
                headers={"Authorization": "Bearer lifecycle-ai"},
            ) as response:
                assert response.status == 200
                return (await response.json())["result"]

        async def read_cookie(state):
            status, reply = await agent(
                {"kind": "navigate", "url": remote_site[0], **epochs(state)}
            )
            assert status == 200, reply
            deadline = asyncio.get_running_loop().time() + 10
            while True:
                status, reply = await agent(
                    {
                        "kind": "command",
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": "document.cookie",
                            "returnByValue": True,
                        },
                        **epochs(state),
                    }
                )
                assert status == 200, reply
                value = reply["result"].get("result", {}).get("value", "")
                if cookie in value:
                    return
                assert asyncio.get_running_loop().time() < deadline, (
                    "Login cookie did not survive"
                )
                await asyncio.sleep(0.05)

        try:
            assert (await host({"kind": "state"}))[0] == 200
            status, original = await agent(
                {"kind": "start", "transport": transport, "isHeadless": True}
            )
            assert status == 200, original
            status, reply = await agent(
                {"kind": "navigate", "url": remote_site[0], **epochs(original)}
            )
            assert status == 200, reply
            deadline = asyncio.get_running_loop().time() + 10
            while True:
                status, reply = await agent(
                    {
                        "kind": "command",
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": f"document.cookie='{cookie}=present; Path=/; Max-Age=3600';document.cookie",
                            "returnByValue": True,
                        },
                        **epochs(original),
                    }
                )
                assert status == 200, reply
                if cookie in reply["result"].get("result", {}).get("value", ""):
                    break
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.05)
            status, rejected = await agent(
                {"kind": "start", "transport": transport, "isHeadless": False}
            )
            assert status == 409 and rejected["error"] == "browser_restart_required"
            restart = {
                "kind": "restart",
                "transport": transport,
                "isHeadless": not is_headful,
                **epochs(original),
            }
            status, rejected = await agent(restart)
            assert (
                status == 409
                and rejected["error"] == "browser_restart_acknowledgement_required"
            )
            assert (await host({"kind": "state"}))[1]["session"][
                "browserSessionId"
            ] == original["session"]["browserSessionId"]
            tool = await mcp(
                "browser_restart",
                {
                    key: value
                    for key, value in {**restart, "acknowledgeStateLoss": True}.items()
                    if key != "kind"
                },
            )
            assert not tool.get("isError"), tool
            restarted = json.loads(tool["content"][0]["text"])
            assert restarted["session"]["profileId"] == original["session"]["profileId"]
            assert (
                restarted["session"]["browserSessionId"]
                != original["session"]["browserSessionId"]
            )
            assert any(
                item["type"] == "image" and item["data"] for item in tool["content"]
            )
            assert restarted["session"]["isHeadless"] is not is_headful
            assert restarted["session"]["capabilities"]["windowView"] is is_headful
            await read_cookie(restarted)
            observed = await mcp("browser_observe", {})
            assert not observed.get("isError"), observed
            assert (
                json.loads(observed["content"][0]["text"])["session"][
                    "browserSessionId"
                ]
                == restarted["session"]["browserSessionId"]
            )
            status, rejected = await agent({"kind": "stop", **epochs(original)})
            assert status == 409 and rejected["error"] == "stale_browser_operation"
            status, human = await host({"kind": "take", **epochs(restarted)})
            assert status == 200, human
            for kind in ("stop", "restart"):
                status, rejected = await agent(
                    {
                        **restart,
                        "kind": kind,
                        "acknowledgeStateLoss": True,
                        **epochs(human),
                    }
                )
                assert (
                    status == 409
                    and rejected["error"] == "browser_control_held_by_user"
                )
            status, stopped = await host({"kind": "stop", **epochs(human)})
            assert status == 200 and stopped["session"]["state"] == "stopped"
            assert stopped["session"]["isHumanControlHeld"] is True
            assert (
                worker.display is None
                and worker.session is None
                and worker.browser is None
            )
            status, rejected = await agent(
                {"kind": "start", "transport": transport, "isHeadless": True}
            )
            assert status == 409 and rejected["error"] == "browser_control_held_by_user"
            status, returned = await host({"kind": "return", **epochs(stopped)})
            assert status == 200, returned
            assert returned["observation"]["stopped"] is True
            assert worker.browser is None and worker.display is None
            assert returned["session"]["isHumanControlHeld"] is False
            status, resumed = await agent(
                {"kind": "start", "transport": transport, "isHeadless": True}
            )
            assert status == 200 and resumed["session"]["state"] == "ai"
            await read_cookie(resumed)
            tool = await mcp("browser_stop", epochs(resumed))
            assert not tool.get("isError"), tool
            stopped = json.loads(tool["content"][0]["text"])
            assert stopped["session"]["state"] == "stopped"
            assert (tmp_path / "chrome").is_dir()
            if transport == "extension":
                # A later conversation must be able to return to extension
                # after CDP has opened and closed this exact profile.
                status, cdp = await agent(
                    {"kind": "start", "transport": "cdp", "isHeadless": True}
                )
                assert status == 200, cdp
                await read_cookie(cdp)
                tool = await mcp("browser_stop", epochs(cdp))
                assert not tool.get("isError"), tool
                status, restored = await agent(
                    {"kind": "start", "transport": "extension", "isHeadless": True}
                )
                assert status == 200, restored
                assert (
                    restored["session"]["profileId"] == original["session"]["profileId"]
                )
                await read_cookie(restored)
                tool = await mcp("browser_stop", epochs(restored))
                assert not tool.get("isError"), tool
        finally:
            await runner.cleanup()
