"""Real model -> ACP HTTP MCP -> Chrome -> human input -> model submission.

Run explicitly with MOSS_BROWSER_AGENT_LIVE=1, SCODE_BROWSER_LIVE_BIN,
SCODE_BROWSER_LIVE_KEY, SCODE_BROWSER_LIVE_URL and SCODE_BROWSER_LIVE_MODEL.
This proves the agent/browser boundary; the full SudoWork UI is a separate gate.
"""

import asyncio
import importlib.util
import json
import os
import pathlib
import time

import aiohttp
import pytest
from aiohttp import web


class Acp:
    def __init__(self, process, stderr):
        self.process, self.stderr = process, stderr
        self.next_id = 0
        self.notifications = []

    async def request(self, method, params, timeout=180):
        self.next_id += 1
        request_id = self.next_id
        self.process.stdin.write(
            (
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": method,
                        "params": params,
                    }
                )
                + "\n"
            ).encode()
        )
        await self.process.stdin.drain()
        deadline = time.monotonic() + timeout
        while True:
            line = await asyncio.wait_for(
                self.process.stdout.readline(), max(0.1, deadline - time.monotonic())
            )
            assert line, "ACP closed before its response; see private stderr"
            message = json.loads(line)
            if message.get("id") == request_id and (
                "result" in message or "error" in message
            ):
                assert "error" not in message, message["error"]
                return message["result"]
            if message.get("method") == "session/request_permission":
                options = message["params"]["options"]
                selected = next(
                    option
                    for option in options
                    if option["kind"] in ("allow_once", "allow_always")
                )
                self.process.stdin.write(
                    (
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": message["id"],
                                "result": {
                                    "outcome": {
                                        "outcome": "selected",
                                        "optionId": selected["optionId"],
                                    }
                                },
                            }
                        )
                        + "\n"
                    ).encode()
                )
                await self.process.stdin.drain()
            else:
                self.notifications.append(message)

    async def prompt(self, session_id, text):
        return await self.request(
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": text}]},
        )


@pytest.mark.skipif(
    os.environ.get("MOSS_BROWSER_AGENT_LIVE") != "1",
    reason="Explicit real model opt-in required",
)
@pytest.mark.asyncio
async def test_real_agent_observes_human_input_before_submitting(remote_site, tmp_path):
    required = [
        "SCODE_BROWSER_LIVE_BIN",
        "SCODE_BROWSER_LIVE_KEY",
        "SCODE_BROWSER_LIVE_URL",
        "SCODE_BROWSER_LIVE_MODEL",
    ]
    assert all(os.environ.get(name) for name in required), (
        "Missing real model environment"
    )
    module = importlib.util.spec_from_file_location(
        "moss_browser_worker_live", pathlib.Path(__file__).with_name("worker.py")
    )
    implementation = importlib.util.module_from_spec(module)
    module.loader.exec_module(implementation)
    worker = implementation.Worker(
        tmp_path / "profile", "fixture-host", "fixture-agent"
    )
    worker.bind({"orgId": "fixture", "userId": "owner", "sessionId": "conversation"})
    runner = web.AppRunner(implementation.application(worker))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    endpoint = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    config = tmp_path / "config"
    workspace = tmp_path / "workspace"
    config.mkdir()
    workspace.mkdir()
    # Use the repository's ordinary default configuration without carrying any
    # developer accounts or instruction files into the acceptance workspace.
    sample_path = pathlib.Path(os.environ["SCODE_BROWSER_LIVE_SAMPLE"])
    configuration = json.loads(sample_path.read_text())
    wire_model = os.environ["SCODE_BROWSER_LIVE_MODEL"].split("/", 1)[-1]
    configuration["models"]["browser-live"] = {
        "alias": "browser-live",
        "name": "Browser live acceptance",
        "input": ["text", "image"],
        "providers": {
            "api-key": {
                "provider": "openai",
                "model": wire_model,
                "api": "openai-completions",
            }
        },
    }
    # Credentials stay in the process environment; clear placeholder accounts.
    configuration["auth_modes"]["api-key"]["openai"] = {
        "baseUrl": os.environ["SCODE_BROWSER_LIVE_URL"],
        "apiKeyEnv": "OPENAI_API_KEY",
    }
    (config / "sudocode.json").write_text(json.dumps(configuration))
    env = os.environ.copy()
    for name in list(env):
        if name.startswith(("ANTHROPIC_", "SUDO_CODE_", "SCODE_", "CLAUDE_")):
            env.pop(name)
    env.update(
        {
            "SUDO_CODE_CONFIG_HOME": str(config),
            "CLAUDE_CONFIG_DIR": str(config),
            "ANTHROPIC_API_KEY": os.environ["SCODE_BROWSER_LIVE_KEY"],
            "ANTHROPIC_BASE_URL": os.environ["SCODE_BROWSER_LIVE_URL"],
            "OPENAI_API_KEY": os.environ["SCODE_BROWSER_LIVE_KEY"],
            "OPENAI_BASE_URL": os.environ["SCODE_BROWSER_LIVE_URL"],
            "NO_PROXY": "127.0.0.1,localhost,::1",
        }
    )
    stderr_path = tmp_path / "agent.private.stderr"
    with stderr_path.open("wb") as stderr:
        process = await asyncio.create_subprocess_exec(
            os.environ["SCODE_BROWSER_LIVE_BIN"],
            "--auth",
            "api-key",
            "--model",
            "browser-live",
            "--dangerously-skip-permissions",
            "acp",
            cwd=workspace,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
        )
        acp = Acp(process, stderr)
        try:
            initialized = await acp.request(
                "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
            )
            assert initialized["agentCapabilities"]["mcpCapabilities"]["http"] is True
            created = await acp.request(
                "session/new",
                {
                    "cwd": str(workspace),
                    "mcpServers": [
                        {
                            "type": "http",
                            "name": "managed-browser",
                            "url": endpoint + "/mcp",
                            "headers": [
                                {
                                    "name": "Authorization",
                                    "value": "Bearer fixture-agent",
                                }
                            ],
                        }
                    ],
                },
            )
            session_id = created["sessionId"]
            await acp.prompt(
                session_id,
                f"Use only the managed-browser MCP tools for this task. Launch with isHeadless=true and transport=cdp, navigate to {remote_site[0]}, and call browser_observe. Stop and wait for me; do not fill or submit the form. Do not use shell or create another browser.",
            )
            assert worker.session is not None, (
                "Real model did not launch the managed browser"
            )
            original = await worker.state()
            assert any(
                tab["url"].rstrip("/") == remote_site[0] for tab in original["tabs"]
            ), "Real model did not navigate through MCP"
            is_lifecycle = os.environ.get("MOSS_BROWSER_LIFECYCLE_AGENT_LIVE") == "1"
            if is_lifecycle:
                previous_browser = original["browserSessionId"]
                previous_profile = original["profileId"]
                await acp.prompt(
                    session_id,
                    f"This explicit restart is intended; I accept loss of unsubmitted page state. Observe current epochs and use browser_restart with acknowledgeStateLoss=true, isHeadless=true and transport=cdp. Reuse the same persistent profile. Then navigate to {remote_site[0]} and observe the form. Do not fill or submit it, use shell or start a second browser.",
                )
                original = await worker.state()
                assert original["browserSessionId"] != previous_browser, (
                    "The real model did not restart Chrome"
                )
                assert original["profileId"] == previous_profile
                assert worker.session is not None and worker.browser["headless"] is True
            async with aiohttp.ClientSession() as http:

                async def human(action):
                    async with http.post(
                        endpoint + "/invoke",
                        json={
                            "binding": worker.binding,
                            "controller": "user-fixture",
                            "action": action,
                        },
                        headers={"Authorization": "Bearer fixture-host"},
                    ) as response:
                        reply = await response.json()
                        assert response.status == 200, reply
                        return reply

                held = await human(
                    {
                        "kind": "take",
                        "controlEpoch": original["controlEpoch"],
                        "targetEpoch": original["targetEpoch"],
                    }
                )
                epoch = held["session"]["controlEpoch"]
                for event in [
                    {"kind": "click", "x": 80, "y": 45},
                    {"kind": "text", "text": "Human live receipt 7319"},
                ]:
                    await human(
                        {
                            "kind": "input",
                            "input": event,
                            "controlEpoch": epoch,
                            "targetEpoch": original["targetEpoch"],
                        }
                    )
                await acp.prompt(
                    session_id,
                    "Try one managed-browser browser_action reload while I hold human control. Observe the server's refusal, then stop. Do not use another transport or browser.",
                )
                assert worker.control.state == "human"
                assert remote_site[1] == [], (
                    "AI submitted while the human owned the browser"
                )
                resumed = await human(
                    {
                        "kind": "return",
                        "controlEpoch": epoch,
                        "targetEpoch": original["targetEpoch"],
                    }
                )
                assert (
                    resumed["session"]["browserSessionId"]
                    == original["browserSessionId"]
                )
                await acp.prompt(
                    session_id,
                    "I have returned browser control. First call browser_observe to read my updated form. Do not overwrite the input. Use managed-browser browser_action trusted mouse click to press Submit once, then observe the receipt and report its name and sequence. Do not use JS to submit and do not repeat a click.",
                )
                assert len(remote_site[1]) == 1, remote_site[1]
                assert remote_site[1][0]["name"] == "Human live receipt 7319"
                assert remote_site[1][0]["trusted"] is True
                assert remote_site[1][0]["cookie"] == "isolated"
                text = json.dumps(acp.notifications)
                assert "Human live receipt 7319" in text
                assert (
                    "browser_control_held_by_user" in text
                    or "stale_browser_operation" in text
                )
                if is_lifecycle:
                    await acp.prompt(
                        session_id,
                        "The review is complete. Observe the current control epochs and use browser_stop to close this owned Chrome while preserving its profile. Do not restart it or use shell. Report that the browser is stopped.",
                    )
                    assert worker.session is None and worker.browser is None
                    assert worker.display is None
                    assert (worker.root / "chrome").is_dir()
                (tmp_path / "agent-browser-live-evidence.json").write_text(
                    json.dumps(
                        {
                            "passed": True,
                            "model": os.environ["SCODE_BROWSER_LIVE_MODEL"],
                            "sameBrowser": True,
                            "trustedReceipts": remote_site[1],
                            "actualAgentNotifications": len(acp.notifications),
                            "humanControlRefusal": True,
                            "explicitAgentRestart": is_lifecycle,
                            "agentStoppedOwnedBrowser": is_lifecycle,
                        },
                        indent=2,
                    )
                )
        finally:
            (tmp_path / "agent-browser.private.json").write_text(
                json.dumps(acp.notifications, indent=2)
            )
            if process.returncode is None:
                process.terminate()
            await asyncio.wait_for(process.wait(), 10)
            await runner.cleanup()
