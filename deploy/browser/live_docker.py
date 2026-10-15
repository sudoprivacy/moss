"""Real managed Chrome policy installation, isolation and crash recovery.

Run on the Docker host with an image built from this directory and the public
adb SDK: python3 live_docker.py --image IMAGE --output evidence.json.
No external credentials are used. All owned containers/volumes are removed.
"""

import argparse
import json
import pathlib
import secrets
import subprocess
import time
import urllib.error
import urllib.request


def docker(*args, check=True):
    result = subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=40, check=False
    )
    if check and result.returncode:
        # Docker commands may contain fixture capabilities; never dump argv.
        raise RuntimeError(result.stderr[-1200:])
    return result


FIXTURE = """
from http.server import BaseHTTPRequestHandler,HTTPServer
class Page(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        page=b'<html><title>Persistent profile live fixture</title><input aria-label="Name" id="name"><p>Same isolated profile</p></html>'
        self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(page)));self.end_headers();self.wfile.write(page)
HTTPServer(('127.0.0.1',8813),Page).serve_forever()
"""


def run(image, output, prior_image=None):
    prefix = "moss-browser-live-" + secrets.token_hex(6)
    volume = prefix + "-profile"
    names = [prefix + "-first", prefix + "-flushed", prefix + "-recovered"]
    label = "sudowork.browser-live=" + prefix
    credentials = {"host": secrets.token_urlsafe(32), "ai": secrets.token_urlsafe(32)}
    binding = {"orgId": prefix, "userId": "fixture-owner", "sessionId": "live"}
    controller = "user-" + prefix
    docker("volume", "create", "--label", label, volume)
    owned = []
    evidence = {"workflow": "managed-extension-crash-recovery", "image": image}
    if prior_image:
        evidence["previousImage"] = prior_image
    installed_versions = []

    def request(port, route, body, *, ai=False, expected=200):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/{route}",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + credentials["ai" if ai else "host"],
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=100) as response:
                status, value = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            status, value = error.code, json.load(error)
        assert status == expected, {"status": status, "reply": value}
        return value

    def host(port, action, **kwargs):
        return request(
            port,
            "invoke",
            {"binding": binding, "controller": controller, "action": action},
            **kwargs,
        )

    def agent(port, action, **kwargs):
        return request(port, "agent", action, ai=True, **kwargs)

    def epochs(reply):
        return {key: reply["session"][key] for key in ("controlEpoch", "targetEpoch")}

    def start_container(name, runtime_image=None):
        docker(
            "run",
            "-d",
            "--name",
            name,
            "--hostname",
            name,
            "--label",
            label,
            "--memory",
            "1536m",
            "--cpus",
            "1.5",
            "--shm-size",
            "256m",
            "--pids-limit",
            "384",
            "-p",
            "127.0.0.1::8080",
            "--mount",
            "type=volume,source=" + volume + ",target=/profile",
            "-e",
            "MOSS_BROWSER_HOST_TOKEN=" + credentials["host"],
            "-e",
            "MOSS_BROWSER_AI_TOKEN=" + credentials["ai"],
            runtime_image or image,
        )
        owned.append(name)
        address = docker("port", name, "8080").stdout.strip()
        port = int(address.rsplit(":", 1)[1])
        deadline = time.monotonic() + 20
        while True:
            try:
                state = host(port, {"kind": "state"})
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        docker("exec", "-d", name, "/opt/browser/venv/bin/python", "-c", FIXTURE)
        return port, state

    def record_installed_version(name):
        # Inspect Chrome's persisted installation, rather than inferring an
        # upgrade from the container's bundled extension manifest alone.
        script = """import json,pathlib
identity=json.loads(pathlib.Path('/opt/browser/extension/identity.json').read_text())
profile=pathlib.Path('/profile/chrome/Default')
for filename in ('Preferences','Secure Preferences'):
    file=profile/filename
    if not file.exists():continue
    setting=json.loads(file.read_text()).get('extensions',{}).get('settings',{}).get(identity['id'])
    if not setting:continue
    version=setting.get('manifest',{}).get('version')
    if not version:
        for manifest in (profile/'Extensions'/identity['id']).glob('*/manifest.json'):
            version=json.loads(manifest.read_text()).get('version')
    assert version==identity['version'], (version,identity['version'])
    assert setting.get('location')!=8, 'Command-line extension is not a persistent installation'
    print(json.dumps({'id':identity['id'],'version':version}));break
else:raise AssertionError('Installed signed extension not found')
"""
        version = json.loads(
            docker("exec", name, "/opt/browser/venv/bin/python", "-c", script).stdout
        )
        installed_versions.append(version)

    def assert_no_display(name):
        processes = [
            line.split(maxsplit=1)[-1]
            for line in docker("top", name, "-eo", "pid,comm").stdout.splitlines()[1:]
        ]
        assert not any(
            line.strip() in {"Xvfb", "x11vnc", "websockify"} for line in processes
        ), processes

    try:
        port, state = start_container(names[0], prior_image)
        assert state["session"]["state"] == "stopped"
        first = agent(
            port, {"kind": "start", "isHeadless": True, "transport": "extension"}
        )
        assert first["session"]["transport"] == "extension"
        assert first["session"]["isHeadless"]
        assert first["session"]["capabilities"]["persistentProfile"]
        assert_no_display(names[0])
        record_installed_version(names[0])
        navigated = agent(
            port, {"kind": "navigate", "url": "http://127.0.0.1:8813/", **epochs(first)}
        )
        marker = "profile_" + prefix.replace("-", "_")
        observed = agent(port, {"kind": "observe", **epochs(navigated)})
        assert any(
            node.get("name", {}).get("value") == "Name"
            for node in observed["observation"]["accessibility"]
        )
        cookie = agent(
            port,
            {
                "kind": "command",
                "method": "Runtime.evaluate",
                "params": {
                    "expression": "document.cookie='"
                    + marker
                    + "=preserved; Max-Age=86400; SameSite=Lax';document.cookie",
                    "returnByValue": True,
                },
                **epochs(observed),
            },
        )
        assert marker + "=preserved" in cookie["result"]["result"]["value"]
        held = host(port, {"kind": "take", **epochs(cookie)})
        assert held["session"]["state"] == "human"
        refused = agent(port, {"kind": "reload", **epochs(held)}, expected=409)
        assert refused["error"] == "browser_control_held_by_user"
        # A second live process cannot claim the same profile volume.
        contender = docker(
            "run",
            "--rm",
            "--label",
            label,
            "--mount",
            "type=volume,source=" + volume + ",target=/profile",
            "--entrypoint",
            "/opt/browser/venv/bin/python",
            image,
            "-c",
            "from worker import Worker;Worker('/profile','fixture-host','fixture-ai')",
            check=False,
        )
        assert (
            contender.returncode != 0
            and "managed_browser_profile_already_owned" in contender.stderr
        )
        # First establish a cookie that Chrome has committed to disk. Chrome
        # may defer a new cookie write, so a 2s delay is not a durability signal.
        # Then hard-stop the next runtime to verify recovery of committed data
        # and the separately fsynced human lease, with different hostnames.
        for index in (1, 2):
            if index == 1:
                docker("stop", "--time", "15", names[index - 1])
            else:
                docker("kill", names[index - 1])
            new_port, stopped = start_container(names[index])
            assert stopped["session"]["controlEpoch"] > held["session"]["controlEpoch"]
            refused = agent(
                new_port,
                {"kind": "start", "isHeadless": True, "transport": "extension"},
                expected=409,
            )
            assert refused["error"] == "browser_control_held_by_user"
            recovered = host(
                new_port,
                {"kind": "start", "isHeadless": True, "transport": "extension"},
            )
            assert (
                recovered["session"]["state"] == "human"
                and recovered["session"]["isController"]
            )
            assert recovered["session"]["profileId"] == first["session"]["profileId"]
            record_installed_version(names[index])
            resumed = host(new_port, {"kind": "return", **epochs(recovered)})
            assert (
                resumed["observation"]["frame"]["data"]
                and resumed["session"]["state"] == "ai"
            )
            navigated = agent(
                new_port,
                {
                    "kind": "navigate",
                    "url": "http://127.0.0.1:8813/",
                    **epochs(resumed),
                },
            )
            cookie = agent(
                new_port,
                {
                    "kind": "command",
                    "method": "Runtime.evaluate",
                    "params": {"expression": "document.cookie", "returnByValue": True},
                    **epochs(navigated),
                },
            )
            assert marker + "=preserved" in cookie["result"]["result"]["value"]
            assert_no_display(names[index])
            if index == 1:
                held = host(new_port, {"kind": "take", **epochs(cookie)})
        evidence.update(
            chromeVersion=docker(
                "exec", names[-1], "google-chrome", "--version"
            ).stdout.strip(),
            extensionInstalled=True,
            cookieSurvivedCrash=True,
            humanLeaseSurvivedCrash=True,
            exclusiveProfileOwnership=True,
            noDisplayServices=True,
            freshObservationBeforeReturn=True,
            installedExtensionVersions=installed_versions,
        )
        if prior_image:
            assert installed_versions[0]["id"] == installed_versions[1]["id"]
            assert installed_versions[0]["version"] != installed_versions[1]["version"]
            assert installed_versions[1] == installed_versions[2]
            evidence["extensionUpgradePreservedProfile"] = True
    except BaseException:
        for name in owned:
            logs = docker("logs", "--tail", "20", name, check=False)
            print(json.dumps({"container": name, "workerLog": logs.stderr[-1600:]}))
            status = docker(
                "exec",
                name,
                "/opt/browser/venv/bin/python",
                "-c",
                "import asyncio,json,pathlib;from ai_dev_browser.core.ext_bridge import bridge_status;p=pathlib.Path('/profile/launch-failure.json');print(json.dumps({'bridge':asyncio.run(bridge_status()),'memory':pathlib.Path('/sys/fs/cgroup/memory.events').read_text(),'launchFailure':json.loads(p.read_text()) if p.exists() else None}))",
                check=False,
            )
            print(
                json.dumps(
                    {
                        "containerStatus": json.loads(status.stdout)
                        if status.stdout.strip()
                        else None,
                        "diagnosticError": status.stderr[-600:],
                    }
                )
            )
        raise
    finally:
        for name in reversed(owned):
            item = json.loads(docker("inspect", name).stdout)[0]
            assert (
                item["Name"] == "/" + name
                and item["Config"]["Labels"].get("sudowork.browser-live") == prefix
            )
            docker("rm", "-f", name)
        item = json.loads(docker("volume", "inspect", volume).stdout)[0]
        assert (
            item["Name"] == volume
            and item["Labels"].get("sudowork.browser-live") == prefix
        )
        docker("volume", "rm", volume)
    evidence["ownedResourcesRemoved"] = True
    pathlib.Path(output).write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--prior-image",
        help="Earlier signed worker image with the same signing identity, to verify a real persistent profile upgrade.",
    )
    args = parser.parse_args()
    run(args.image, args.output, args.prior_image)
