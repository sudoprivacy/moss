"""Exercise the pinned scode download boundary without network access."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


class FetchScodeTests(unittest.TestCase):
    def test_architecture_payloads_and_checksum_rejection(self):
        for arch, payload in (("amd64", "scode-linux-x64-bundle"), ("arm64", "scode-linux-arm64")):
            with self.subTest(arch=arch), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "payload.tar.gz"
                binary = b"#!/bin/sh\necho scode-fixture\n"
                entries = {"scode": binary}
                if arch == "amd64":
                    entries["SHA256SUMS.txt"] = (hashlib.sha256(binary).hexdigest() + "  scode\n").encode()
                with tarfile.open(archive, "w:gz") as tar:
                    for name, data in entries.items():
                        info = tarfile.TarInfo(payload + "/" + name)
                        info.size = len(data)
                        tar.addfile(info, io.BytesIO(data))
                versions = root / "versions.json"
                versions.write_text(json.dumps({"scode": "v0.2.23", payload + "-sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}))
                target = root / "bin/scode"
                env = {**os.environ, "SCODE_DOWNLOAD_URL": archive.as_uri()}
                args = ["bash", str(Path(__file__).with_name("fetch-scode.sh")), str(versions), arch, str(target)]
                result = subprocess.run(args, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(target.read_bytes(), binary)
                self.assertTrue(os.access(target, os.X_OK))
                self.assertEqual(target.with_suffix(".version").read_text(), "v0.2.23\n")
                target.unlink()
                archive.write_bytes(archive.read_bytes() + b"corrupt")
                result = subprocess.run(args, env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
