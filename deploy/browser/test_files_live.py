"""Real Chrome file picker, authenticated bytes and persistent downloads."""

import asyncio
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import uuid
from urllib.parse import quote

import aiohttp
import pytest
from aiohttp import web

sys.path.insert(0, str(pathlib.Path(__file__).parent))
spec = importlib.util.spec_from_file_location(
    "files_worker", pathlib.Path(__file__).with_name("worker.py")
)
worker_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_module)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "transport", os.environ.get("MOSS_BROWSER_LIVE_TRANSPORTS", "cdp").split(",")
)
async def test_real_worker_files_are_owned_and_bound_to_human_control(
    tmp_path, transport
):
    payload = ("real-browser-file-" + uuid.uuid4().hex).encode()
    receipts = []

    async def page(_request):
        return web.Response(
            text="""<!doctype html><meta charset="utf-8">
        <title>Files receipt</title><style>body{margin:0}input,a{display:block;
        margin:24px;width:320px;height:48px}</style><input id="upload" type="file">
        <a id="download" href="/download">Download receipt</a><script>
        document.cookie='files_login=present; Path=/; Max-Age=3600';
        upload.onchange=async event=>{const file=upload.files[0];
        await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:file.name,text:await file.text(),trusted:event.isTrusted})});};
        </script>""",
            content_type="text/html",
        )

    async def receive(request):
        value = await request.json()
        value["cookie"] = request.cookies.get("files_login")
        receipts.append(value)
        return web.json_response({"ok": True})

    async def download(request):
        assert request.cookies.get("files_login") == "present"
        return web.Response(
            body=payload,
            content_type="application/octet-stream",
            headers={"Content-Disposition": 'attachment; filename="receipt.txt"'},
        )

    website = web.Application()
    website.add_routes(
        [
            web.get("/", page),
            web.post("/receipt", receive),
            web.get("/download", download),
        ]
    )
    website_runner = web.AppRunner(website)
    await website_runner.setup()
    website_server = web.TCPSite(website_runner, "127.0.0.1", 0)
    await website_server.start()
    url = f"http://127.0.0.1:{website_server._server.sockets[0].getsockname()[1]}/"
    worker = worker_module.Worker(tmp_path, "files-host", "files-ai")
    runner = web.AppRunner(worker_module.application(worker))
    await runner.setup()
    server = web.TCPSite(runner, "127.0.0.1", 8080 if transport == "extension" else 0)
    await server.start()
    endpoint = f"http://127.0.0.1:{server._server.sockets[0].getsockname()[1]}"
    binding = {"orgId": "fixture", "userId": "owner", "sessionId": "files"}

    async with aiohttp.ClientSession() as http:

        async def host(action):
            async with http.post(
                endpoint + "/invoke",
                json={
                    "binding": binding,
                    "controller": "user-fixture",
                    "action": action,
                },
                headers={"Authorization": "Bearer files-host"},
            ) as response:
                return response.status, await response.json()

        async def agent(action):
            async with http.post(
                endpoint + "/agent",
                json=action,
                headers={"Authorization": "Bearer files-ai"},
            ) as response:
                return response.status, await response.json()

        def epochs(reply):
            return {
                key: reply["session"][key] for key in ("controlEpoch", "targetEpoch")
            }

        async def file_request(path, context, data=b"", token="files-host"):
            async with http.post(
                endpoint + path,
                data=data,
                headers={
                    "Authorization": "Bearer " + token,
                    "X-Moss-Browser-Context": quote(
                        json.dumps(
                            {
                                "binding": binding,
                                "controller": "user-fixture",
                                **context,
                            }
                        )
                    ),
                    "X-Moss-Browser-File-Name": quote("报告.txt"),
                },
            ) as response:
                raw = await response.read()
                return (
                    response.status,
                    raw
                    if response.content_type == "application/octet-stream"
                    else json.loads(raw)
                    if raw.startswith(b"{")
                    else raw,
                )

        async def state_until(predicate):
            deadline = asyncio.get_running_loop().time() + 15
            while True:
                status, reply = await host({"kind": "state"})
                assert status == 200, reply
                if predicate(reply["session"]):
                    return reply
                assert asyncio.get_running_loop().time() < deadline, reply
                await asyncio.sleep(0.1)

        try:
            assert (await host({"kind": "state"}))[0] == 200
            status, started = await agent(
                {"kind": "start", "transport": transport, "isHeadless": True}
            )
            assert status == 200, started
            status, navigated = await agent(
                {"kind": "navigate", "url": url, **epochs(started)}
            )
            assert status == 200, navigated
            deadline = asyncio.get_running_loop().time() + 15
            while True:
                status, ready = await agent(
                    {
                        "kind": "command",
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": "!!document.querySelector('#upload')",
                            "returnByValue": True,
                        },
                        **epochs(navigated),
                    }
                )
                assert status == 200, ready
                if ready["result"]["result"].get("value") is True:
                    break
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.1)
            status, held = await host({"kind": "take", **epochs(navigated)})
            assert status == 200, held
            status, clicked = await host(
                {
                    "kind": "input",
                    "input": {"kind": "click", "x": 100, "y": 48},
                    **epochs(held),
                }
            )
            assert status == 200, clicked
            chosen = await state_until(lambda state: state.get("fileChooser"))
            chooser = chosen["session"]["fileChooser"]["id"]
            assert (
                await file_request(
                    "/files/receive", epochs(held), payload, token="files-ai"
                )
            )[0] == 403
            status, rejected = await file_request(
                "/files/receive", {**epochs(navigated)}, payload
            )
            assert status == 409 and rejected["error"] == "stale_browser_operation"
            status, rejected = await file_request(
                "/files/receive",
                {**epochs(held), "binding": {**binding, "userId": "other"}},
                payload,
            )
            assert status == 409 and rejected["error"] == "browser_profile_in_use"
            status, staged = await file_request("/files/receive", epochs(held), payload)
            assert status == 200, staged
            assert staged["file"]["sha256"] == hashlib.sha256(payload).hexdigest()
            action = {
                "kind": "upload-files",
                "chooserId": chooser,
                "fileIds": [staged["file"]["id"]],
                **epochs(held),
            }
            status, rejected = await agent(action)
            assert status == 409 and rejected["error"] == "browser_control_held_by_user"
            status, uploaded = await host(action)
            assert status == 200, uploaded
            deadline = asyncio.get_running_loop().time() + 10
            while not receipts:
                assert asyncio.get_running_loop().time() < deadline
                await asyncio.sleep(0.05)
            assert receipts == [
                {
                    "name": "报告.txt",
                    "text": payload.decode(),
                    "trusted": True,
                    "cookie": "present",
                }
            ]
            assert (await host(action))[0] == 409
            status, clicked = await host(
                {
                    "kind": "input",
                    "input": {"kind": "click", "x": 100, "y": 120},
                    **epochs(held),
                }
            )
            assert status == 200, clicked
            downloaded = await state_until(lambda state: state.get("downloads"))
            file = downloaded["session"]["downloads"][0]
            assert (
                file["name"] == "receipt.txt"
                and file["sha256"] == hashlib.sha256(payload).hexdigest()
            )
            status, data = await file_request("/files/read", {"fileId": file["id"]})
            assert status == 200 and data == payload
            assert (await file_request("/files/read", {"fileId": uuid.uuid4().hex}))[
                0
            ] == 409
            assert (
                await file_request(
                    "/files/read", {"fileId": file["id"]}, token="files-ai"
                )
            )[0] == 403
            status, restarted = await host(
                {
                    "kind": "restart",
                    "isHeadless": True,
                    "transport": transport,
                    "acknowledgeStateLoss": True,
                    **epochs(downloaded),
                }
            )
            assert status == 200, restarted
            assert restarted["session"]["profileId"] == started["session"]["profileId"]
            assert restarted["session"]["downloads"][0]["id"] == file["id"]
            assert (await file_request("/files/read", {"fileId": file["id"]}))[
                1
            ] == payload
            (tmp_path / "file-transfer-evidence.json").write_text(
                json.dumps(
                    {
                        "transport": transport,
                        "upload": staged["file"],
                        "download": file,
                        "receipt": receipts[0],
                        "profileId": started["session"]["profileId"],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        finally:
            await runner.cleanup()
            await website_runner.cleanup()


@pytest.mark.asyncio
async def test_recovered_worker_reports_recovery_instead_of_an_absent_human_lease(
    tmp_path,
):
    binding = {"orgId": "fixture", "userId": "owner", "sessionId": "recovery"}
    previous = worker_module.Worker(tmp_path, "recovery-host", "recovery-ai")
    previous.bind(binding)
    await previous.close()
    recovered = worker_module.Worker(tmp_path, "recovery-host", "recovery-ai")
    runner = web.AppRunner(worker_module.application(recovered))
    await runner.setup()
    server = web.TCPSite(runner, "127.0.0.1", 0)
    await server.start()
    endpoint = f"http://127.0.0.1:{server._server.sockets[0].getsockname()[1]}"
    try:
        async with aiohttp.ClientSession() as http:

            async def host(action):
                async with http.post(
                    endpoint + "/invoke",
                    json={
                        "binding": binding,
                        "controller": "user-recovery",
                        "action": action,
                    },
                    headers={"Authorization": "Bearer recovery-host"},
                ) as response:
                    assert response.status == 200, await response.text()
                    return (await response.json())["session"]

            stopped = await host({"kind": "state"})
            assert stopped["state"] == "stopped" and not stopped["isHumanControlHeld"]
            async with http.post(
                endpoint + "/agent",
                json={"kind": "start", "isHeadless": True, "transport": "cdp"},
                headers={"Authorization": "Bearer recovery-ai"},
            ) as response:
                assert response.status == 409
                assert (await response.json())[
                    "error"
                ] == "browser_restart_requires_observation"
            started = await host(
                {"kind": "start", "isHeadless": True, "transport": "cdp"}
            )
            assert started["state"] == "human" and started["isController"]
            stopped = await host(
                {
                    "kind": "stop",
                    "controlEpoch": started["controlEpoch"],
                    "targetEpoch": started["targetEpoch"],
                }
            )
            returned = await host(
                {
                    "kind": "return",
                    "controlEpoch": stopped["controlEpoch"],
                    "targetEpoch": stopped["targetEpoch"],
                }
            )
            assert (
                returned["state"] == "stopped"
                and not returned["isHumanControlHeld"]
                and returned["error"] is None
            )
    finally:
        await runner.cleanup()
