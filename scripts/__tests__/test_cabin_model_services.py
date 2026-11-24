"""Behavioral deployment boundaries; no macOS, Docker, MLX or third-party packages."""

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shlex
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "cabin-model-services.py"
SPEC = importlib.util.spec_from_file_location("cabin_model_services", SCRIPT)
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)
LLM = "com.comac.mlx-lm"
AUDIO = "com.comac.mlx-audio"
ASR = "com.comac.mlx-asr"


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cabin tools ' spaces ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source deployment"
        self.launch = self.source / "launch"
        self.docker = self.source / "docker"
        self.launch.mkdir(parents=True)
        self.docker.mkdir()
        self.output = self.root / "review ' bundle"
        self.model_home = self.root / "models docker mac"
        self.model_home.mkdir()
        self.executable = self.model_home / ".venv/bin/mlx_audio.server"
        self.executable.parent.mkdir(parents=True)
        self.executable.write_text("#!/bin/sh\ntouch " + shlex.quote(str(self.root / "EXECUTED")) + "\n")
        self.executable.chmod(0o700)
        common = {
            "EnvironmentVariables": {"HF_HOME": str(self.model_home / "cache"), "UNKNOWN": "retain me"},
            "WorkingDirectory": str(self.model_home),
            "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False},
            "ThrottleInterval": 17, "ProcessType": "Adaptive",
            "UnknownFutureField": {"nested": [1, True, b"opaque data"]},
            "StandardOutPath": str(self.model_home / "logs/legacy out.log"),
            "StandardErrorPath": str(self.model_home / "logs/legacy err.log"),
        }
        self.llm = dict(copy.deepcopy(common), Label=LLM, ProgramArguments=[
            str(self.executable), "--model", str(self.model_home / "models/Existing Model"),
            "--host", "0.0.0.0", "--port", "8000", "--unrecognized-option", "leave unchanged",
        ])
        self.audio = dict(copy.deepcopy(common), Label=AUDIO, ProgramArguments=[
            str(self.executable), "--host", "0.0.0.0", "--port", "8004", "--future-option=keep",
        ])
        self.save_agents()
        # Deliberately use a name different from the dated snapshot: no hard-coded service.
        self.compose = self.docker / "docker-compose.yml"
        self.compose.write_text('''services:
  unrelated-tts:
    image: tts:unchanged
    environment:
      TTS_URL: http://host.docker.internal:8004
  actual-transcription-gateway:
    image: asr-proxy:mac
    environment:
      UPSTREAM_URL: http://host.docker.internal:8004
      UNKNOWN: preserve-on-merge
    ports:
      - "8002:8080"
volumes:
  untouched:
''')
        self.gateway_source = self.root / "gateway source.py"
        self.gateway_source.write_text("raise SystemExit('gateway must never execute in prepare tests')\n")
        self.tts_model = str(self.model_home / "models/Actual TTS Model")
        self.args = ["--root", str(self.source), "--tts-server-script", str(self.gateway_source),
                     "--tts-model", self.tts_model, "--output", str(self.output)]

    def expected_tts_args(self):
        sha = hashlib.sha256(self.gateway_source.read_bytes()).hexdigest()[:12]
        return [str(self.model_home / ".venv/bin/python"),
                str(self.model_home / ("cabin-tts-server." + sha + ".py")),
                "--model", self.tts_model, "--host", "0.0.0.0", "--port", "8004"]

    def save_agents(self):
        # Binary plists verify that preservation means data/bytes, not textual XML surgery.
        for name, data in ((LLM, self.llm), (AUDIO, self.audio)):
            (self.launch / (name + ".plist")).write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY))

    def run_cli(self, *extra):
        return subprocess.run([sys.executable, "-B", str(SCRIPT)] + self.args + list(extra),
                              text=True, capture_output=True, cwd=self.root)

    def tree(self):
        return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_mode & 0o777)
                for p in self.root.rglob("*") if p.is_file() and self.output not in p.parents}

    def load(self, name):
        return plistlib.loads((self.output / "prepared" / (name + ".plist")).read_bytes())

    def test_cli_only_writes_output_and_preserves_llm_tts_and_unknowns(self):
        before = self.tree()
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("actual-transcription-gateway", result.stdout)
        self.assertEqual(self.tree(), before)
        self.assertFalse((self.root / "EXECUTED").exists())
        expected_llm = copy.deepcopy(self.llm)
        expected_llm["ProgramArguments"] += ["--prompt-cache-size", "64"]
        self.assertEqual(self.load(LLM), expected_llm)
        expected_tts = copy.deepcopy(self.audio)
        expected_tts["ProgramArguments"] = self.expected_tts_args()
        self.assertEqual(self.load(AUDIO), expected_tts)
        expected_asr = copy.deepcopy(self.audio)
        expected_asr["Label"] = ASR
        expected_asr["ProgramArguments"][4] = "8005"
        expected_asr["StandardOutPath"] = str(self.model_home / ("logs/" + ASR + ".stdout.log"))
        expected_asr["StandardErrorPath"] = str(self.model_home / ("logs/" + ASR + ".stderr.log"))
        self.assertEqual(self.load(ASR), expected_asr)
        for label in (LLM, AUDIO):
            self.assertEqual((self.output / "backup" / (label + ".plist")).read_bytes(),
                             (self.launch / (label + ".plist")).read_bytes())
        self.assertEqual((self.output / "backup/docker-compose.yml").read_bytes(), self.compose.read_bytes())
        override = (self.output / "compose.asr-8005.override.yml").read_text()
        self.assertEqual(override, 'services:\n  "actual-transcription-gateway":\n    environment:\n      UPSTREAM_URL: "http://host.docker.internal:8005"\n')
        self.assertNotIn("unrelated-tts", override)
        rollback = (self.output / "compose.rollback.override.yml").read_text()
        self.assertIn("http://host.docker.internal:8004", rollback)
        manifest = json.loads((self.output / "manifest.json").read_text())
        for path, sha in manifest["artifacts"].items():
            self.assertEqual(hashlib.sha256((self.output / path).read_bytes()).hexdigest(), sha)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in self.output.rglob("*") if p.is_file()))

    def test_existing_cache_forms_replace_in_place_without_other_edits(self):
        for cache in (["--prompt-cache-size", "10"], ["--prompt-cache-size=10"]):
            with self.subTest(cache=cache):
                self.llm["ProgramArguments"] = self.llm["ProgramArguments"][:9] + cache + ["--unknown", "value"]
                self.save_agents()
                self.output = self.root / ("form " + str(len(cache)))
                self.args[-1] = str(self.output)
                result = self.run_cli("dry-run")
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = copy.deepcopy(self.llm)
                expected["ProgramArguments"][9:9 + len(cache)] = (
                    ["--prompt-cache-size", "64"] if len(cache) == 2 else ["--prompt-cache-size=64"])
                self.assertEqual(self.load(LLM), expected)

    def test_tts_gateway_and_asr_keep_original_environment_even_when_batch_variable_exists(self):
        for existing_env in (None, {"HF_HOME": "/existing cache", "MLX_AUDIO_TTS_MAX_BATCH_SIZE": "8"}):
            with self.subTest(environment=existing_env):
                if existing_env is None:
                    self.audio.pop("EnvironmentVariables", None)
                else:
                    self.audio["EnvironmentVariables"] = existing_env
                self.save_agents()
                self.output = self.root / ("env absent" if existing_env is None else "env present")
                self.args[-1] = str(self.output)
                original = (self.launch / (AUDIO + ".plist")).read_bytes()
                result = self.run_cli()
                self.assertEqual(result.returncode, 0, result.stderr)
                candidate = self.load(AUDIO)
                expected = copy.deepcopy(self.audio)
                expected["ProgramArguments"] = self.expected_tts_args()
                self.assertEqual(candidate, expected)
                self.assertEqual(self.load(ASR).get("EnvironmentVariables"), existing_env)
                self.assertEqual((self.output / "backup" / (AUDIO + ".plist")).read_bytes(), original)

    def test_old_native_batch_flag_is_not_forwarded_to_gateway_but_asr_keeps_it(self):
        self.audio["ProgramArguments"].append("--tts-max-batch-size=8")
        self.save_agents()
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.load(AUDIO)["ProgramArguments"], self.expected_tts_args())
        self.assertIn("--tts-max-batch-size=8", self.load(ASR)["ProgramArguments"])

    def test_inline_audio_port_is_preserved_except_for_asr_value(self):
        self.audio["ProgramArguments"][3:5] = ["--port=8004"]
        self.save_agents()
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.load(AUDIO)["ProgramArguments"], self.expected_tts_args())
        self.assertIn("--port=8005", self.load(ASR)["ProgramArguments"])

    def test_optional_tts_script_uses_venv_python_and_explicit_model_without_affecting_asr(self):
        native_exe = str(self.model_home / ".venv/bin/mlx_audio.server")
        python = str(self.model_home / ".venv/bin/python")
        script = str(self.root / "target user's scripts/cabin tts server.py")
        source_script = self.root / "local user's gateway.py"
        source_script.write_text("raise SystemExit('this script must never execute during prepare')\n")
        model = str(self.model_home / "models/Actual TTS Model")
        # Target paths need not exist on the machine preparing a remote deployment bundle.
        self.audio["ProgramArguments"][0] = native_exe
        self.audio["ProgramArguments"].append("--tts-max-batch-size=8")
        for has_program in (False, True):
            with self.subTest(Program=has_program):
                if has_program:
                    self.audio["Program"] = native_exe
                    self.audio["ProgramArguments"][0] = str(self.executable)
                self.save_agents()
                self.output = self.root / ("script with Program" if has_program else "script without Program")
                self.args[-1] = str(self.output)
                before = self.tree()
                result = self.run_cli("--tts-server-script", str(source_script),
                                      "--tts-script-target", script, "--tts-model", model)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.tree(), before)
                self.assertFalse(Path(script).exists())
                self.assertFalse((self.root / "EXECUTED").exists())
                tts = self.load(AUDIO)
                expected = copy.deepcopy(self.audio)
                expected["ProgramArguments"] = [python, script, "--model", model,
                                                 "--host", "0.0.0.0", "--port", "8004"]
                if has_program:
                    expected["Program"] = python
                self.assertEqual(tts, expected)
                self.assertNotIn("MLX_AUDIO_TTS_MAX_BATCH_SIZE", tts["EnvironmentVariables"])
                asr = self.load(ASR)
                original_args = list(self.audio["ProgramArguments"])
                original_args[4] = "8005"
                self.assertEqual(asr["ProgramArguments"], original_args)
                self.assertEqual(asr.get("Program"), self.audio.get("Program"))
                self.assertEqual(asr["EnvironmentVariables"], self.audio["EnvironmentVariables"])
                self.assertEqual((self.output / "backup" / (AUDIO + ".plist")).read_bytes(),
                                 (self.launch / (AUDIO + ".plist")).read_bytes())
                manifest = json.loads((self.output / "manifest.json").read_text())
                self.assertEqual(manifest["tts_runtime"],
                                 {"mode": "script", "script": script, "python": python, "model": model,
                                  "source": str(source_script.resolve()),
                                  "sha256": hashlib.sha256(source_script.read_bytes()).hexdigest()})
                self.assertEqual((self.output / "payload/cabin-tts-server.py").read_bytes(), source_script.read_bytes())
                verified = subprocess.run([sys.executable, "-B", str(self.output / "verify-bundle.py")],
                                          text=True, capture_output=True)
                self.assertEqual(verified.returncode, 0, verified.stderr)
                plan = (self.output / "DEPLOYMENT.md").read_text()
                commands = [shlex.split(line) for line in plan.splitlines()
                            if line.startswith(("test -r ", "test -x ", "test -d "))]
                self.assertIn('test ! -e "$TTS_SCRIPT"', plan)
                self.assertIn(["test", "-x", python], commands)
                self.assertIn(["test", "-d", model], commands)
                shell = "\n".join(block.split("```", 1)[0] for block in plan.split("```sh\n")[1:])
                checked = subprocess.run(["/bin/sh", "-n"], input=shell, text=True, capture_output=True)
                self.assertEqual(checked.returncode, 0, checked.stderr)
                self.assertIn('cp -p "$BACKUP/$TTS.plist" "$AGENTS/$TTS.plist"', plan)

    def test_script_mode_requires_explicit_absolute_paths_and_identifiable_existing_venv(self):
        source_script = self.root / "local gateway.py"
        source_script.write_text("raise SystemExit('must not execute')\n")
        source = str(source_script)
        original_args = ["--root", str(self.source), "--output", str(self.output)]
        for extra, error in [
            (["--tts-server-script", "/target/nonexistent-gateway.py"], "source not found"),
            (["--tts-server-script", source], "provide --tts-model"),
            (["--tts-server-script", source, "--tts-script-target", "relative.py", "--tts-model", "/models/tts"], "absolute"),
            (["--tts-server-script", source, "--tts-model", "${MODEL_HOME}/tts"], "absolute"),
        ]:
            with self.subTest(options=extra):
                self.args = original_args + extra
                self.assert_rejected_without_writes(error)
        self.audio["ProgramArguments"][0] = "/unidentified/audio-wrapper"
        self.save_agents()
        self.args = original_args + ["--tts-server-script", source, "--tts-model", "/models/tts"]
        self.assert_rejected_without_writes("venv/bin/python")

    def prepare_script_fixture(self):
        source = self.root / "gateway source.py"
        source.write_text("raise SystemExit('never execute gateway in deployment tests')\n")
        self.audio["ProgramArguments"][0] = str(self.model_home / ".venv/bin/mlx_audio.server")
        self.save_agents()
        target = self.model_home / "installed gateway.py"
        result = self.run_cli("--tts-server-script", str(source), "--tts-script-target", str(target),
                              "--tts-model", str(self.model_home / "models/Actual TTS"))
        self.assertEqual(result.returncode, 0, result.stderr)
        return source, target

    def test_packaged_script_hash_verification_rejects_changed_payload(self):
        self.prepare_script_fixture()
        payload = self.output / "payload/cabin-tts-server.py"
        payload.write_text("tampered")
        result = subprocess.run([sys.executable, "-B", str(self.output / "verify-bundle.py")],
                                text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stderr)

    def test_file_helper_exclusive_install_and_rollback_protects_others_files(self):
        source, target = self.prepare_script_fixture()
        backup = self.output / "live-backup"
        backup.mkdir()
        (backup / "complete").touch()

        def action(name):
            return subprocess.run([sys.executable, "-B", str(self.output / "gateway-file.py"), name, str(target)],
                                  text=True, capture_output=True)

        # These are inert text file copies in a temporary fixture, never a service installation.
        target.write_text("preexisting file")
        self.assertNotEqual(action("install").returncode, 0)
        self.assertEqual(target.read_text(), "preexisting file")
        self.assertEqual(action("remove").returncode, 0)
        self.assertTrue(target.exists())  # No ownership record: no deletion.
        target.unlink()
        self.assertEqual(action("install").returncode, 0)
        self.assertEqual(target.read_bytes(), source.read_bytes())
        self.assertEqual(action("check").returncode, 0)
        self.assertNotEqual(action("install").returncode, 0)
        target.write_text("modified by someone else")
        self.assertNotEqual(action("remove").returncode, 0)
        self.assertEqual(target.read_text(), "modified by someone else")
        target.write_bytes(source.read_bytes())
        moved = target.with_suffix(".saved")
        target.rename(moved)
        target.write_bytes(source.read_bytes())
        self.assertNotEqual(action("remove").returncode, 0)  # Same hash, different inode.
        target.unlink()
        target.symlink_to(moved)
        self.assertNotEqual(action("remove").returncode, 0)
        target.unlink()
        moved.rename(target)
        self.assertEqual(action("remove").returncode, 0)
        self.assertFalse(target.exists())
        self.assertTrue((backup / "gateway-created.json").is_file())

    def test_snapshot_model_resolution_uses_compose_and_llm_and_corroborating_config(self):
        source = self.root / "gateway.py"
        source.write_text("raise SystemExit('never execute')\n")
        self.audio["ProgramArguments"][0] = str(self.model_home / ".venv/bin/mlx_audio.server")
        self.save_agents()
        model = self.source / "models/Actual TTS Model"
        model.mkdir(parents=True)
        config = model / "config.json"
        config.write_text('{"model_type":"qwen3_tts"}')
        self.compose.write_text(self.compose.read_text().replace("  unrelated-tts:\n", '''  model-client:
    environment:
      DEFAULT_MODELS: ${MODEL_HOME}/Existing Model
      AUDIO_TTS_MODEL: ${MODEL_HOME}/Actual TTS Model
  unrelated-tts:
'''))
        args = ["--root", str(self.source), "--output", str(self.output)]
        with mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")), \
             mock.patch.object(subprocess, "Popen", side_effect=AssertionError("subprocess forbidden")), \
             mock.patch.object(os, "system", side_effect=AssertionError("shell forbidden")), \
             mock.patch.object(TOOL, "GATEWAY", source):
            self.assertEqual(TOOL.main(args), 0)
        tts = self.load(AUDIO)
        self.assertEqual(tts["ProgramArguments"][3], str(self.model_home / "models/Actual TTS Model"))
        self.assertIn(hashlib.sha256(source.read_bytes()).hexdigest()[:12], tts["ProgramArguments"][1])
        # Lack of model evidence or a mismatched LLM is an error, never a guessed path.
        self.output = self.root / "missing model evidence"
        self.args = ["--root", str(self.source), "--output", str(self.output), "--tts-server-script", str(source)]
        config.unlink()
        self.assert_rejected_without_writes("not corroborated")
        config.write_text('{"model_type":"qwen3_tts"}')
        self.llm["ProgramArguments"][2] = str(self.model_home / "different/model")
        self.save_agents()
        self.assert_rejected_without_writes("does not match LLM")

    def test_path_overrides_and_shell_commands_handle_apostrophes_and_spaces(self):
        custom_agents = str(self.root / "target user's LaunchAgents")
        custom_compose = str(self.root / "target user's docker/compose.yml")
        self.args = ["--root", str(self.root / "unused root"), "--launch-dir", str(self.launch),
                     "--compose-file", str(self.compose), "--compose-target", custom_compose,
                     "--launch-agent-dir", custom_agents, "--tts-server-script", str(self.gateway_source),
                     "--tts-model", self.tts_model, "--output", str(self.output), "--dry-run"]
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = (self.output / "DEPLOYMENT.md").read_text()
        assignments = [line for line in plan.splitlines() if line.startswith(("BUNDLE=", "BASE=", "AGENTS="))]
        # Ask a real POSIX shell to interpret assignments, without executing any deployment block.
        parsed = subprocess.run(["/bin/sh", "-c", "\n".join(assignments) +
                                 '\nprintf "%s\\n" "$BUNDLE" "$BASE" "$AGENTS"'],
                                capture_output=True, text=True, check=True)
        self.assertEqual(parsed.stdout.splitlines(), [str(self.output.resolve()), custom_compose, custom_agents])
        # Syntax-check all generated shell blocks; -n executes no commands.
        blocks = plan.split("```sh\n")[1:]
        shell = "\n".join(block.split("```", 1)[0] for block in blocks)
        checked = subprocess.run(["/bin/sh", "-n"], input=shell, text=True, capture_output=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertLess(plan.index('mkdir "$BACKUP"'), plan.index('launchctl bootout "$DOMAIN/$LLM"'))
        self.assertIn('launchctl bootout "$DOMAIN/$TTS"', plan)
        self.assertIn('cp -p "$BACKUP/$TTS.plist" "$AGENTS/$TTS.plist"', plan)

    def test_no_process_or_network_calls_in_prepare(self):
        with mock.patch.object(socket, "socket", side_effect=AssertionError("network forbidden")), \
             mock.patch.object(subprocess, "Popen", side_effect=AssertionError("subprocess forbidden")), \
             mock.patch.object(os, "system", side_effect=AssertionError("shell forbidden")):
            self.assertEqual(TOOL.main(self.args), 0)

    def assert_rejected_without_writes(self, expected):
        before = self.tree()
        result = self.run_cli()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(expected, result.stderr)
        self.assertFalse(self.output.exists())
        self.assertEqual(before, self.tree())

    def test_ambiguous_or_missing_proxy_never_guesses_service(self):
        base = self.compose.read_text()
        self.compose.write_text(base.replace("UPSTREAM_URL:", "DIFFERENT_URL:"))
        self.assert_rejected_without_writes("found 0")
        self.compose.write_text(base.replace("  unrelated-tts:\n", "  other-proxy:\n    environment:\n      UPSTREAM_URL: http://host.docker.internal:8004\n  unrelated-tts:\n"))
        self.assert_rejected_without_writes("found 2")

    def test_literal_list_environment_and_quoted_service_are_discovered(self):
        self.compose.write_text('''services:
  'renamed-proxy':
    environment:
      - "UPSTREAM_URL=http://host.docker.internal:8004" # known source
      - OTHER=untouched
''')
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.output / "manifest.json").read_text())["proxy_service"], "renamed-proxy")

    def test_unsupported_compose_is_rejected_before_output(self):
        cases = [
            ("services:\n  proxy:\n    environment:\n      UPSTREAM_URL: ${UPSTREAM}\n", "interpolated"),
            ("services:\n  proxy:\n    environment: {UPSTREAM_URL: http://host.docker.internal:8004}\n", "block-style"),
            ("services:\n  proxy:\n    <<: *defaults\n", "unsupported"),
            ("services:\n  proxy:\n    env_file: production.env\n", "unsupported"),
            ("services:\n  proxy:\n    environment:\n      UPSTREAM_URL: http://host.docker.internal:8004\n      UPSTREAM_URL: http://elsewhere:8004\n", "duplicate UPSTREAM_URL"),
        ]
        for text, error in cases:
            with self.subTest(text=text):
                self.compose.write_text(text)
                self.assert_rejected_without_writes(error)

    def test_invalid_agent_and_conflicts_leave_no_partial_bundle(self):
        original_llm, original_audio = copy.deepcopy(self.llm), copy.deepcopy(self.audio)
        for change, expected in [
            (lambda: self.llm.update(Label="wrong"), "unexpected Label"),
            (lambda: self.llm["ProgramArguments"].extend(["--prompt-cache-size", "2", "--prompt-cache-size=3"]), "duplicate option"),
            (lambda: self.llm["ProgramArguments"].append("--prompt-cache-size"), "missing value"),
            (lambda: self.audio["ProgramArguments"].__setitem__(4, "8005"), "port 8004"),
            (lambda: self.llm["ProgramArguments"].__setitem__(6, "8005"), "collides"),
            (lambda: self.audio.update(Sockets={"listener": {}}), "manual review"),
        ]:
            with self.subTest(error=expected):
                self.llm, self.audio = copy.deepcopy(original_llm), copy.deepcopy(original_audio)
                change()
                self.save_agents()
                self.assert_rejected_without_writes(expected)

    def test_duplicate_asr_label_and_label_override(self):
        (self.launch / "some-other-file.plist").write_bytes(plistlib.dumps({"Label": ASR}))
        self.assert_rejected_without_writes("already exists")
        result = self.run_cli("--asr-label", "com.example.independent-asr")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.load("com.example.independent-asr")["Label"], "com.example.independent-asr")

    def test_existing_output_and_symlink_are_never_overwritten(self):
        self.output.mkdir()
        sentinel = self.output / "keep.txt"
        sentinel.write_text("someone else's work")
        result = self.run_cli()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(sentinel.read_text(), "someone else's work")
        linked = self.root / "linked output"
        linked.symlink_to(self.output, target_is_directory=True)
        self.args[-1] = str(linked)
        self.assertEqual(self.run_cli().returncode, 2)
        self.assertEqual(list(self.output.iterdir()), [sentinel])

    def test_no_parent_creation_or_output_inside_inputs(self):
        self.output = self.root / "nonexistent parent/bundle"
        self.args[-1] = str(self.output)
        self.assert_rejected_without_writes("parent must already exist")
        self.assertFalse(self.output.parent.exists())
        for directory in (self.launch, self.docker):
            self.output = directory / "bad output"
            self.args[-1] = str(self.output)
            self.assert_rejected_without_writes("inside an input")

    def test_malformed_plist_reports_actionable_cli_error(self):
        for data in ("not a plist", '<?xml version="1.0"?><plist><dict>'):
            with self.subTest(data=data):
                (self.launch / (LLM + ".plist")).write_text(data)
                self.assert_rejected_without_writes("prepare failed")


if __name__ == "__main__":
    unittest.main()
