"""Receipt fixture shared by browser HTTP and actual agent acceptance."""

import pathlib
import sys

import pytest_asyncio
from aiohttp import web

sys.path.insert(0, str(pathlib.Path(__file__).parent))


@pytest_asyncio.fixture
async def remote_site():
    receipts = []
    html = """<!doctype html><meta charset="utf-8">
    <style>body{margin:0;background:#eee}input,button{display:block;margin:24px;width:220px;height:40px}</style>
    <input id="name" aria-label="Name"><button id="submit">Submit once</button><pre id="receipt"></pre>
    <script>document.cookie='profile=isolated; SameSite=Lax';
    let press=null;submit.onmousedown=event=>{press={buttons:event.buttons,trusted:event.isTrusted}};
    submit.onclick=async event=>{
      const response=await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:document.querySelector('#name').value,trusted:event.isTrusted,press})});
      document.querySelector('#receipt').textContent=JSON.stringify(await response.json());
    };</script>"""

    async def page(_request):
        return web.Response(text=html, content_type="text/html")

    async def receipt(request):
        value = await request.json()
        value["cookie"] = request.cookies.get("profile")
        value["sequence"] = len(receipts) + 1
        receipts.append(value)
        return web.json_response(value)

    app = web.Application()
    app.add_routes([web.get("/", page), web.post("/receipt", receipt)])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}", receipts
    finally:
        await runner.cleanup()
