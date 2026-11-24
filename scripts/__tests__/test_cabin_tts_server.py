"""Stdlib-only core tests; HTTP tests also run when fastapi/httpx are installed.

python3 -m unittest discover -s scripts/__tests__ -p test_cabin_tts_server.py -v
No MLX, model, network or GPU is needed. Mocks exercise the real MLX adapter too.
"""

import asyncio
import builtins
import hashlib
import importlib.util
import io
import math
import random
import struct
import sys
import threading
import time
import types
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "cabin_tts_server", Path(__file__).resolve().parents[1] / "cabin-tts-server.py"
)
server = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server
SPEC.loader.exec_module(server)
MODEL_PATH = "/models/Qwen3-TTS-CustomVoice"
HF_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
CAPABILITIES = server.Capabilities(("vivian", "ono_anna", "sohee"),
                                   ("auto", "chinese", "japanese", "korean"))


def payload(**options):
    return {"model": "qwen3-tts", "input": "测试语音", **options}


class FakeArray:
    def __init__(self, samples, *, ndim=1, size=None, kind="f"):
        self.samples = list(samples)
        self.ndim = ndim
        self.size = len(self.samples) if size is None else size
        self.dtype = types.SimpleNamespace(kind=kind)

    def all(self):
        return all(self.samples)

    def max(self):
        return max(self.samples)


class FakeNP:
    @staticmethod
    def asarray(value):
        return value if isinstance(value, FakeArray) else FakeArray(value)

    @staticmethod
    def isfinite(value):
        return FakeArray(math.isfinite(s) for s in value.samples)

    @staticmethod
    def abs(value):
        return FakeArray(abs(s) for s in value.samples)

    @staticmethod
    def concatenate(chunks):
        return FakeArray(s for chunk in chunks for s in chunk.samples)


def write_wav(output, audio, sample_rate, *, format):
    assert format == "wav"
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in audio.samples))


def result(audio=None, token_count=4, sample_rate=24000):
    return types.SimpleNamespace(audio=[0.1, -0.2, 0.3] if audio is None else audio,
                                 token_count=token_count, sample_rate=sample_rate)


class FakeBackend:
    capabilities = CAPABILITIES

    def __init__(self, path):
        self.path = path
        self.thread_ids = [threading.get_ident()]
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.closed = threading.Event()
        self.active = 0
        self.peak_active = 0

    def synthesize(self, request, check):
        self.thread_ids.append(threading.get_ident())
        self.calls.append(request)
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        try:
            if request.text == "block":
                self.entered.set()
                if not self.release.wait(3):
                    raise RuntimeError("test did not release native call")
            if request.text == "fail":
                raise RuntimeError("CONFIDENTIAL text and credential")
            check()
            rng = random.Random(request.seed)
            return server.encode_results(
                [result([rng.uniform(-0.5, 0.5) for _ in range(24)])],
                request, FakeNP, write_wav, check,
            )
        finally:
            self.active -= 1

    def close(self):
        self.thread_ids.append(threading.get_ident())
        self.closed.set()


class ValidationTests(unittest.TestCase):
    def parse(self, **options):
        return server.SpeechRequest.parse(payload(**options),
                                         {"qwen3-tts", MODEL_PATH, Path(MODEL_PATH).name})

    def test_defaults_and_model_aliases(self):
        request = self.parse()
        self.assertEqual((request.temperature, request.top_p, request.top_k,
                          request.repetition_penalty, request.max_tokens, request.seed),
                         (0.9, 1.0, 50, 1.05, 1024, 42))
        for alias in ("qwen3-tts", MODEL_PATH, Path(MODEL_PATH).name):
            self.parse(model=alias)
        for value in (1, 4096):
            self.assertEqual(self.parse(max_tokens=value).max_tokens, value)
        for value in (0, 4294967295):
            self.assertEqual(self.parse(seed=value).seed, value)

    def test_instruct_zero_sampling_and_unbounded_finite_penalty(self):
        instruct = "  用平静的语气说话。  "
        request = self.parse(instruct=instruct, temperature=0, top_k=0,
                             repetition_penalty=3.5)
        self.assertEqual(request.instruct, instruct)
        self.assertEqual((request.temperature, request.top_k, request.repetition_penalty),
                         (0.0, 0, 3.5))
        self.assertIsNone(self.parse().instruct)
        self.assertEqual(self.parse(top_k=1024).top_k, 1024)
        for value in (1e-300, 1e300):
            self.assertEqual(self.parse(repetition_penalty=value).repetition_penalty, value)

    def test_exact_hf_alias_is_opt_in_and_serves_same_local_model(self):
        service = server.SerialService("/models/qwen3tts", model_aliases=[HF_MODEL_ID])
        for alias in ("qwen3-tts", "qwen3tts", "/models/qwen3tts", HF_MODEL_ID):
            server.SpeechRequest.parse(payload(model=alias), service.aliases)
        for alias in ("Qwen/other-model", HF_MODEL_ID + "-other"):
            with self.assertRaises(server.ServiceError):
                server.SpeechRequest.parse(payload(model=alias), service.aliases)
        with self.assertRaises(server.ServiceError):
            server.SpeechRequest.parse(payload(model=HF_MODEL_ID),
                                      server.SerialService("/models/qwen3tts").aliases)

    def test_invalid_requests(self):
        cases = [
            {"model": "other"}, {"model": "/models/other"}, {"model": None},
            {"input": ""}, {"input": "  "}, {"input": "x" * 4001},
            {"input": "\ud800"}, {"input": 1}, {"seed": -1},
            {"seed": 4294967296}, {"seed": 42.0}, {"seed": True},
            {"seed": "42"}, {"max_tokens": 0}, {"max_tokens": 4097},
            {"max_tokens": True}, {"max_tokens": 100.5}, {"temperature": 2.01},
            {"temperature": -0.1}, {"temperature": math.nan},
            {"temperature": math.inf}, {"temperature": True},
            {"temperature": 10 ** 500}, {"temperature": "0.9"},
            {"top_p": 0}, {"top_p": 1.1}, {"top_k": -1}, {"top_k": 1.5},
            {"top_k": 1025}, {"top_k": True}, {"repetition_penalty": 0},
            {"repetition_penalty": math.inf}, {"repetition_penalty": math.nan},
            {"repetition_penalty": 10 ** 500}, {"repetition_penalty": True},
            {"instruct": ""}, {"instruct": None}, {"instruct": 1},
            {"instruct": "\ud800"}, {"response_format": "mp3"},
            {"stream": True}, {"stream": 0}, {"speed": 1.0},
            {"unknown": True}, {"options": {"seed": 42}},
            {"language": "Japanese", "lang_code": "Chinese"},
            {"language": None}, {"voice": None},
        ]
        for options in cases:
            with self.subTest(options=list(options)):
                with self.assertRaises(server.ServiceError) as error:
                    self.parse(**options)
                self.assertEqual(error.exception.status, 422)
        for body in (None, [], "input", {"input": "hello"}):
            with self.assertRaises(server.ServiceError):
                server.SpeechRequest.parse(body, {"qwen3-tts"})

    def test_capabilities_from_model_and_language_alias(self):
        for voice, language in (("Vivian", "Chinese"), ("ono_anna", "Japanese"),
                                ("sohee", "Korean")):
            request = CAPABILITIES.validate(self.parse(voice=voice, language=language))
            self.assertEqual(request.lang_code, language.lower())
            self.assertEqual(request.voice, voice.lower())
        self.parse(language="CHINESE", lang_code="Chinese")
        for options in ({"voice": "not-a-speaker"}, {"language": "not-a-language"}):
            with self.assertRaises(server.ServiceError):
                CAPABILITIES.validate(self.parse(**options))


class EncodingTests(unittest.TestCase):
    def encode(self, results, **options):
        request = server.SpeechRequest.parse(payload(**options), {"qwen3-tts"})
        return server.encode_results(results, request, FakeNP, write_wav, lambda: None)

    def test_concatenated_pcm_and_diagnostic_headers(self):
        audio = self.encode([result(), result(token_count=5)], seed=4294967295)
        with wave.open(io.BytesIO(audio.body), "rb") as wav:
            self.assertEqual((wav.getframerate(), wav.getsampwidth(), wav.getnchannels(),
                              wav.getnframes()), (24000, 2, 1, 6))
        headers = audio.headers
        self.assertEqual(headers["X-Cabin-TTS-Deterministic"], "seeded-serial-v1")
        self.assertEqual(headers["X-Cabin-TTS-Seed"], "4294967295")
        self.assertEqual(headers["X-Cabin-TTS-Token-Count"], "9")
        self.assertEqual(headers["X-Cabin-TTS-Sample-Rate"], "24000")
        self.assertEqual(headers["X-Cabin-TTS-SHA256"], hashlib.sha256(audio.body).hexdigest())

    def test_token_cap_discards_every_chunk(self):
        for results in ([result(token_count=10)], [result(token_count=11)],
                        [result(token_count=5), result(token_count=5)]):
            with self.subTest(tokens=[r.token_count for r in results]):
                with patch.object(server.io, "BytesIO", side_effect=AssertionError("must not encode")):
                    with self.assertRaises(server.ServiceError) as error:
                        self.encode(results, max_tokens=10)
                self.assertEqual(error.exception.status, 422)

    def test_invalid_audio_metadata_and_duration(self):
        cases = [[], [result([])], [result([math.nan])], [result([math.inf])],
                 [result([1.01])], [result([-1.01])],
                 [result(FakeArray([0.1], ndim=2))],
                 [result(FakeArray([0.1], kind="c"))],
                 [result(FakeArray([0.1], size=24000 * 120 + 1))],
                 [result(FakeArray([0.1], size=24000 * 60 + 1)),
                  result(FakeArray([0.1], size=24000 * 60))],
                 [result(sample_rate=16000)], [result(sample_rate=24000.0)],
                 [result(sample_rate=True)], [result(token_count=0)],
                 [result(token_count=-1)], [result(token_count=True)],
                 [result(token_count=3.0)]]
        for results in cases:
            with self.subTest(results=results), self.assertRaises(server.ServiceError) as error:
                self.encode(results)
            self.assertEqual(error.exception.status, 422)

    def test_invalid_encoding_and_generator_closed_on_cap(self):
        closed = []
        def generate():
            try:
                yield result(token_count=10)
            finally:
                closed.append(True)
        with self.assertRaises(server.ServiceError):
            self.encode(generate(), max_tokens=10)
        self.assertEqual(closed, [True])
        with self.assertRaises(server.ServiceError):
            server.encode_results([result()], server.SpeechRequest("hello"), FakeNP,
                                  lambda *a, **k: None, lambda: None)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.service = server.SerialService(MODEL_PATH, max_queue=4, backend_factory=self.factory)
        self.service.start().result(2)

    def factory(self, path):
        self.backend = FakeBackend(path)
        return self.backend

    def tearDown(self):
        self.backend.release.set()
        self.assertTrue(self.service.close(2))

    def block(self):
        job = self.service.submit(payload(input="block"))
        self.assertTrue(self.backend.entered.wait(1))
        return job

    def test_repeat_and_concurrent_jobs_are_serial(self):
        expected = self.service.submit(payload()).future.result(2)
        with ThreadPoolExecutor(max_workers=4) as pool:
            outputs = list(pool.map(lambda _: self.service.submit(payload()).future.result(2), range(4)))
        self.assertTrue(all(o.body == expected.body for o in outputs))
        self.assertEqual(self.backend.peak_active, 1)
        different = self.service.submit(payload(seed=43)).future.result(2)
        self.assertNotEqual(different.body, expected.body)
        self.service.close(2)
        self.assertTrue(self.backend.closed.is_set())
        self.assertEqual(len(set(self.backend.thread_ids)), 1)
        self.assertNotEqual(self.backend.thread_ids[0], threading.get_ident())

    def test_queue_bound_and_cancelled_slots_reclaimed(self):
        active = self.block()
        pending = [self.service.submit(payload(input=str(n))) for n in range(4)]
        with self.assertRaises(server.ServiceError) as error:
            self.service.submit(payload())
        self.assertEqual(error.exception.status, 503)
        pending[0].cancel()
        replacement = self.service.submit(payload(input="replacement"))
        self.assertEqual(self.service.health()["queued"], 4)
        self.backend.release.set()
        active.future.result(2)
        for job in pending[1:] + [replacement]:
            job.future.result(2)
        self.assertNotIn("0", [r.text for r in self.backend.calls])

    def test_expired_queued_jobs_skip_inference_and_reclaim_capacity(self):
        active = self.block()
        queued = self.service.submit(payload(input="expired"), deadline=time.monotonic() + 0.04)
        time.sleep(0.06)
        replacement = self.service.submit(payload(input="new"))
        with self.assertRaises(server.ServiceError) as error:
            queued.future.result(1)
        self.assertEqual(error.exception.status, 504)
        self.backend.release.set()
        active.future.result(2)
        replacement.future.result(2)
        self.assertNotIn("expired", [r.text for r in self.backend.calls])

    def test_expired_job_skipped_without_new_admission(self):
        active = self.block()
        queued = self.service.submit(payload(input="expired"), deadline=time.monotonic() + 0.02)
        time.sleep(0.04)
        self.backend.release.set()
        active.future.result(2)
        with self.assertRaises(server.ServiceError):
            queued.future.result(2)
        self.assertEqual([r.text for r in self.backend.calls], ["block"])

    def test_errors_are_sanitized_and_worker_recovers(self):
        failed = self.service.submit(payload(input="fail"))
        with self.assertRaises(server.ServiceError) as error:
            failed.future.result(2)
        self.assertEqual(str(error.exception), "Speech generation failed")
        self.assertEqual(error.exception.status, 500)
        self.service.submit(payload()).future.result(2)

    def test_shutdown_cancels_queue_and_waits_boundedly(self):
        active = self.block()
        pending = self.service.submit(payload())
        self.assertFalse(self.service.close(0.01))
        self.assertTrue(self.service.health()["busy"])
        with self.assertRaises(server.ServiceError) as error:
            pending.future.result(1)
        self.assertEqual(error.exception.status, 503)
        with self.assertRaises(server.ServiceError):
            self.service.submit(payload())
        self.backend.release.set()
        self.assertTrue(self.service.close(2))
        self.assertTrue(self.backend.closed.is_set())
        with self.assertRaises(server.ServiceError):
            active.future.result(1)

    def test_invalid_capabilities_never_enqueue(self):
        for options in ({"voice": "bad"}, {"language": "bad"}, {"speed": 1}):
            with self.assertRaises(server.ServiceError):
                self.service.submit(payload(**options))
        self.assertFalse(self.backend.calls)


class AsyncWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        def factory(path):
            self.backend = FakeBackend(path)
            return self.backend
        self.service = server.SerialService(MODEL_PATH, max_queue=1, backend_factory=factory)
        await asyncio.wrap_future(self.service.start())

    async def asyncTearDown(self):
        self.backend.release.set()
        self.assertTrue(await self.service.aclose(2))

    async def block(self, timeout=1):
        job = self.service.submit(payload(input="block"), deadline=time.monotonic() + timeout)
        for _ in range(100):
            if self.backend.entered.is_set():
                return job
            await asyncio.sleep(0.001)
        self.fail("worker did not start")

    async def test_active_timeout_keeps_worker_busy_and_queue_bounded(self):
        active = await self.block(0.06)
        with self.assertRaises(server.ServiceError) as error:
            await server.await_job(active)
        self.assertEqual(error.exception.status, 504)
        self.assertTrue(self.service.health()["busy"])
        queued = self.service.submit(payload())
        with self.assertRaises(server.ServiceError) as error:
            self.service.submit(payload())
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(len(self.backend.calls), 1)
        self.backend.release.set()
        await server.await_job(queued)
        self.assertEqual(self.backend.peak_active, 1)

    async def test_queued_timeout_is_skipped(self):
        active = await self.block()
        queued = self.service.submit(payload(input="skip"), deadline=time.monotonic() + 0.03)
        with self.assertRaises(server.ServiceError):
            await server.await_job(queued)
        self.backend.release.set()
        await server.await_job(active)
        self.assertEqual([r.text for r in self.backend.calls], ["block"])

    async def test_task_cancellation_and_disconnect_skip_queued_jobs(self):
        active = await self.block()
        queued = self.service.submit(payload(input="skip-cancel"))
        task = asyncio.create_task(server.await_job(queued))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        disconnected = self.service.submit(payload(input="skip-disconnect"))
        async def is_disconnected():
            return True
        with self.assertRaises(server.ServiceError) as error:
            await server.await_job(disconnected, is_disconnected)
        self.assertEqual(error.exception.status, 499)
        self.backend.release.set()
        await server.await_job(active)
        self.assertEqual([r.text for r in self.backend.calls], ["block"])


class WatcherCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_swallowed_cancel_does_not_block_result_error_timeout_or_cancellation(self):
        for outcome in ("result", "error", "timeout", "cancel"):
            with self.subTest(outcome=outcome):
                entered, swallowed, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
                calls = []
                async def disconnected():
                    calls.append(True)
                    entered.set()
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        swallowed.set()
                    return False
                job = server.Job(server.SpeechRequest("hello"), time.monotonic() + 1)
                task = asyncio.create_task(server.await_job(job, disconnected))
                try:
                    await asyncio.wait_for(entered.wait(), 0.5)
                    if outcome == "result":
                        job.future.set_result("audio")
                    elif outcome == "error":
                        job.future.set_exception(server.ServiceError(422, "Invalid audio"))
                    elif outcome == "timeout":
                        # await_job already captured the timeout; let its real
                        # deadline expire, rather than replacing its clock.
                        job.deadline = time.monotonic()
                        job.future.set_result("late audio")
                    else:
                        task.cancel()
                    done, _ = await asyncio.wait({task}, timeout=0.5)
                    self.assertIn(task, done, "watcher cleanup blocked the response")
                    self.assertTrue(swallowed.is_set())
                    self.assertEqual(len(calls), 1, "watcher polled again after stop")
                    if outcome == "result":
                        self.assertEqual(task.result(), "audio")
                    elif outcome == "cancel":
                        self.assertTrue(task.cancelled())
                    else:
                        with self.assertRaises(server.ServiceError) as error:
                            task.result()
                        self.assertEqual(error.exception.status, 422 if outcome == "error" else 504)
                finally:
                    release.set()
                    task.cancel()
                    await asyncio.wait({task}, timeout=0.5)

    async def test_cleanup_is_bounded_even_if_disconnect_probe_stays_blocked(self):
        entered, swallowed, release, exited = (asyncio.Event() for _ in range(4))
        async def disconnected():
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                swallowed.set()
                await release.wait()
            finally:
                exited.set()
            return False
        job = server.Job(server.SpeechRequest("hello"), time.monotonic() + 2)
        task = asyncio.create_task(server.await_job(job, disconnected))
        try:
            await asyncio.wait_for(entered.wait(), 0.5)
            job.future.set_result("audio")
            done, _ = await asyncio.wait({task}, timeout=0.5)
            self.assertIn(task, done, "cleanup waited without a bound")
            self.assertEqual(task.result(), "audio")
            self.assertTrue(swallowed.is_set())
            self.assertFalse(exited.is_set())
        finally:
            release.set()
            task.cancel()
            await asyncio.wait({task}, timeout=0.5)
            await asyncio.wait_for(exited.wait(), 0.5)
            await asyncio.sleep(0)


class AdapterTests(unittest.TestCase):
    def test_lazy_import_load_stream_seed_generate_and_encode_share_worker(self):
        events = []
        model = types.SimpleNamespace(model_type="qwen3_tts",
                                      config=types.SimpleNamespace(tts_model_type="custom_voice"),
                                      supported_speakers=CAPABILITIES.speakers,
                                      supported_languages=CAPABILITIES.languages)
        mx = types.ModuleType("mlx.core")
        def record(name):
            events.append((name, threading.get_ident()))
        def seed(value):
            record(("seed", value))
            mx.rng = random.Random(value)
        @contextmanager
        def stream(value):
            record("stream-enter")
            yield
            record("stream-exit")
        mx.random = types.SimpleNamespace(seed=seed)
        mx.cpu, mx.gpu = "cpu", "gpu"
        mx.new_stream = lambda device: record(("new-stream", device)) or device + "-stream"
        mx.set_default_stream = lambda value: record(("set-default", value))
        mx.stream = stream
        mx.synchronize = lambda: record("synchronize")
        mx.clear_cache = lambda: record("clear-cache")
        kwargs_seen = []
        def generate(**kwargs):
            record("generate")
            kwargs_seen.append(kwargs)
            yield result([mx.rng.random() / 2 for _ in range(8)])
        model.generate = generate
        def load(path):
            record("load")
            self.assertEqual(path, MODEL_PATH)
            return model
        def write(*args, **kwargs):
            record("write")
            return write_wav(*args, **kwargs)
        mlx = types.ModuleType("mlx")
        mlx.core = mx
        modules = {"mlx": mlx, "mlx.core": mx, "numpy": FakeNP,
                   "mlx_audio": types.ModuleType("mlx_audio"),
                   "mlx_audio.audio_io": types.SimpleNamespace(write=write),
                   "mlx_audio.utils": types.SimpleNamespace(load_model=load)}
        original_import = builtins.__import__
        def audit_import(name, *args, **kwargs):
            if name in ("mlx.core", "numpy") or name.startswith("mlx_audio"):
                record(("import", name))
            return original_import(name, *args, **kwargs)
        with patch.dict(sys.modules, modules), patch("builtins.__import__", new=audit_import):
            service = server.SerialService(MODEL_PATH)
            try:
                service.start().result(2)
                a = service.submit(payload()).future.result(2)
                b = service.submit(payload()).future.result(2)
                self.assertEqual(a.body, b.body)
                service.submit(payload(instruct="Speak calmly", temperature=0, top_k=0,
                                       repetition_penalty=3.5)).future.result(2)
            finally:
                self.assertTrue(service.close(2))
        self.assertEqual(len({tid for _, tid in events}), 1)
        self.assertNotEqual(events[0][1], threading.get_ident())
        names = [name for name, _ in events]
        self.assertEqual(names.count(("seed", 42)), 3)
        self.assertEqual(names.count("load"), 1)
        self.assertLess(names.index(("import", "mlx.core")), names.index(("new-stream", "cpu")))
        self.assertLess(names.index(("new-stream", "cpu")), names.index(("new-stream", "gpu")))
        self.assertLess(names.index(("new-stream", "gpu")), names.index(("set-default", "cpu-stream")))
        self.assertLess(names.index(("set-default", "cpu-stream")), names.index(("set-default", "gpu-stream")))
        for module in ("numpy", "mlx_audio.audio_io", "mlx_audio.utils"):
            self.assertLess(names.index(("set-default", "gpu-stream")), names.index(("import", module)))
        self.assertLess(names.index(("set-default", "gpu-stream")), names.index("load"))
        self.assertLess(names.index(("seed", 42)), names.index("generate"))
        self.assertEqual(kwargs_seen[0], {
            "text": "测试语音", "voice": "vivian", "lang_code": "chinese",
            "instruct": None,
            "temperature": 0.9, "top_p": 1.0, "top_k": 50,
            "repetition_penalty": 1.05, "max_tokens": 1024,
            "stream": False, "verbose": False,
        })
        self.assertEqual(kwargs_seen[2], {
            **kwargs_seen[0], "instruct": "Speak calmly", "temperature": 0.0,
            "top_k": 0, "repetition_penalty": 3.5,
        })

    def test_startup_failure_does_not_accept_work(self):
        def fail(path):
            raise RuntimeError("CONFIDENTIAL credential")
        service = server.SerialService(MODEL_PATH, backend_factory=fail)
        with self.assertRaisesRegex(RuntimeError, "^TTS model initialization failed$"):
            service.start().result(2)
        self.assertTrue(service.close(2))
        self.assertFalse(service.health()["ready"])
        with self.assertRaises(server.ServiceError):
            service.submit(payload())


HTTP_AVAILABLE = all(importlib.util.find_spec(name) for name in ("fastapi", "httpx"))


@unittest.skipUnless(HTTP_AVAILABLE, "optional fastapi/httpx HTTP integration dependencies")
class HTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import httpx
        self.app = server.create_app(MODEL_PATH, backend_factory=FakeBackend,
                                     model_aliases=[HF_MODEL_ID])
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                        base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.lifespan.__aexit__(None, None, None)

    async def test_routes_headers_aliases_and_repeat_concurrency(self):
        self.assertEqual((await self.client.get("/health")).status_code, 200)
        models = (await self.client.get("/v1/models")).json()["data"]
        self.assertEqual(models[0]["id"], "qwen3-tts")
        self.assertIn("ono_anna", models[0]["speakers"])
        self.assertIn(HF_MODEL_ID, models[0]["aliases"])
        outputs = await asyncio.gather(*[
            self.client.post("/v1/audio/speech", json=payload(model=alias))
            for alias in ("qwen3-tts", MODEL_PATH, Path(MODEL_PATH).name)
        ])
        for response in outputs:
            self.assertEqual(response.status_code, 200, response.text if response.status_code != 200 else "")
            self.assertEqual(response.headers["content-type"], "audio/wav")
            self.assertEqual(response.headers["x-cabin-tts-deterministic"], server.DETERMINISTIC)
            self.assertEqual(response.headers["x-cabin-tts-seed"], "42")
            self.assertEqual(response.headers["x-cabin-tts-sha256"], hashlib.sha256(response.content).hexdigest())
        self.assertEqual(len({response.content for response in outputs}), 1)
        for route in ("/v1/audio/transcriptions", "/v1/audio/translations"):
            self.assertEqual((await self.client.post(route)).status_code, 404)

    async def test_hf_alias_instruct_and_zero_sampling_are_accepted(self):
        response = await self.client.post("/v1/audio/speech", json=payload(
            model=HF_MODEL_ID, instruct="用温和的语气说话", temperature=0, top_k=0,
            repetition_penalty=10, seed=0,
        ))
        self.assertEqual(response.status_code, 200, response.text if response.status_code != 200 else "")
        self.assertEqual(response.headers["x-cabin-tts-seed"], "0")
        capped = await self.client.post("/v1/audio/speech", json=payload(
            instruct="Speak calmly", temperature=0, top_k=0, max_tokens=4,
        ))
        self.assertEqual(capped.status_code, 422)
        self.assertIn("max_tokens", capped.json()["error"]["message"])

    async def test_http_completes_when_disconnect_check_swallows_cancellation(self):
        from starlette.requests import Request
        entered, swallowed = threading.Event(), asyncio.Event()
        release = asyncio.Event()
        original_synthesize = FakeBackend.synthesize
        def synthesize(backend, request, check):
            if not entered.wait(1):
                raise RuntimeError("disconnect watcher did not start")
            return original_synthesize(backend, request, check)
        async def disconnected(request):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                swallowed.set()
            return False
        with patch.object(Request, "is_disconnected", new=disconnected), \
                patch.object(FakeBackend, "synthesize", new=synthesize):
            task = asyncio.create_task(self.client.post("/v1/audio/speech", json=payload()))
            try:
                done, _ = await asyncio.wait({task}, timeout=1.5)
                self.assertIn(task, done, "HTTP response hung after inference finished")
                response = task.result()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["x-cabin-tts-deterministic"], server.DETERMINISTIC)
                self.assertTrue(swallowed.is_set())
            finally:
                release.set()
                task.cancel()
                await asyncio.wait({task}, timeout=0.5)

    async def test_invalid_json_input_cap_and_oversized_body(self):
        for options in ({"model": "wrong"}, {"voice": "wrong"}, {"language": "wrong"},
                        {"seed": True}, {"speed": 1}, {"stream": True},
                        {"temperature": -1}, {"instruct": None}, {"top_k": 1025},
                        {"extra": "CONFIDENTIAL"}, {"max_tokens": 4}):
            response = await self.client.post("/v1/audio/speech", json=payload(**options))
            self.assertEqual(response.status_code, 422, response.text)
            self.assertNotIn("CONFIDENTIAL", response.text)
            self.assertNotIn("x-cabin-tts-deterministic", response.headers)
        response = await self.client.post("/v1/audio/speech", content="{")
        self.assertEqual(response.status_code, 422)
        response = await self.client.post("/v1/audio/speech", content="x" * 65537)
        self.assertEqual(response.status_code, 413)


if __name__ == "__main__":
    unittest.main()
