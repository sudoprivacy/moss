#!/usr/bin/env python3
"""Single-model, seeded serial Qwen CustomVoice HTTP server.

Run: python scripts/cabin-tts-server.py --model /absolute/model --port 18004
Only the worker imports MLX (including modules with import-time local streams),
loads the model, seeds, generates, materializes arrays and writes WAV bytes.
Determinism describes repeat requests on this model/runtime/device, not equality
across different MLX versions or hardware. No batching, retries or ASR routes.

Generation accepts instruct (nonempty string), temperature 0..2 (default 0.9),
top_k 0..1024 (0 disables truncation; this gateway caps it at 1024), top_p (0,1],
and any finite repetition_penalty > 0. Model aliases always address the loaded
local model: qwen3-tts, its absolute path and directory name are built in. Add
an exact Hugging Face identifier with --model-alias; no wildcard aliases or
request-time model downloads are supported.

Timeouts bound HTTP waits, not uninterruptible native code. An abandoned active
job keeps the sole worker occupied until it returns; admission remains bounded.
Shutdown drains/cancels pending jobs and waits a bounded time for active work.
An irrecoverably stuck native call requires process termination by the operator.
"""

import argparse
import asyncio
import concurrent.futures
import hashlib
import io
import json
import math
import numbers
import threading
import time
import wave
from collections import deque
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field, replace
from pathlib import Path


DETERMINISTIC = "seeded-serial-v1"
MODEL_ID = "qwen3-tts"
MAX_TEXT_CHARS = 4000
MAX_BODY_BYTES = 65536
MAX_DURATION = 120
SAMPLE_RATE = 24000
WATCHER_CLEANUP_TIMEOUT = 0.1


class ServiceError(Exception):
    """Messages are deliberately static: never include input or native errors."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class SpeechRequest:
    text: str
    voice: str = "Vivian"
    lang_code: str = "Chinese"
    seed: int = 42
    temperature: float = 0.9
    top_p: float = 1.0
    top_k: int = 50
    repetition_penalty: float = 1.05
    max_tokens: int = 1024
    instruct: str | None = None

    @classmethod
    def parse(cls, payload, aliases):
        allowed = {
            "input", "model", "voice", "lang_code", "language", "seed",
            "temperature", "top_p", "top_k", "repetition_penalty",
            "max_tokens", "response_format", "stream", "instruct",
        }
        if not isinstance(payload, dict) or payload.keys() - allowed:
            raise ServiceError(422, "Unknown or unsupported request fields")
        if not isinstance(payload.get("model"), str) or payload["model"] not in aliases:
            raise ServiceError(422, "Requested model is not served")
        text = payload.get("input")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            raise ServiceError(422, "input must contain 1..4000 characters")
        # Reject invalid Unicode before tokenization, without reflecting the text.
        try:
            text.encode("utf-8")
        except UnicodeError:
            raise ServiceError(422, "input must be valid Unicode") from None
        if payload.get("response_format", "wav") != "wav":
            raise ServiceError(422, "Only response_format wav is supported")
        if type(payload.get("stream", False)) is not bool or payload.get("stream", False):
            raise ServiceError(422, "Streaming is not supported")
        voice = payload.get("voice", "Vivian")
        language = payload.get("lang_code", payload.get("language", "Chinese"))
        if not isinstance(voice, str) or not voice.strip():
            raise ServiceError(422, "voice must be a supported speaker")
        if not isinstance(language, str) or not language.strip():
            raise ServiceError(422, "language must be supported")
        if "lang_code" in payload and "language" in payload:
            other = payload["language"]
            if not isinstance(other, str) or language.casefold() != other.casefold():
                raise ServiceError(422, "language and lang_code must agree")
        values = {"text": text, "voice": voice, "lang_code": language}
        if "instruct" in payload:
            instruct = payload["instruct"]
            if not isinstance(instruct, str) or not instruct:
                raise ServiceError(422, "instruct must be a nonempty string")
            try:
                instruct.encode("utf-8")
            except UnicodeError:
                raise ServiceError(422, "instruct must be valid Unicode") from None
            values["instruct"] = instruct
        for name, low, high in (("seed", 0, 4294967295), ("max_tokens", 1, 4096),
                                ("top_k", 0, 1024)):
            value = payload.get(name, cls.__dataclass_fields__[name].default)
            if type(value) is not int or not low <= value <= high:
                raise ServiceError(422, name + " must be an integer in " + str(low) + ".." + str(high))
            values[name] = value
        for name, high in (("temperature", 2.0), ("top_p", 1.0),
                           ("repetition_penalty", None)):
            value = payload.get(name, cls.__dataclass_fields__[name].default)
            if type(value) not in (int, float):
                raise ServiceError(422, name + " must be a finite number within range")
            try:
                value = float(value)
            except OverflowError:
                raise ServiceError(422, name + " must be a finite number within range") from None
            if (not math.isfinite(value) or value < 0
                    or (value == 0 and name != "temperature")
                    or (high is not None and value > high)):
                raise ServiceError(422, name + " must be a finite number within range")
            values[name] = value
        return cls(**values)


@dataclass(frozen=True)
class Capabilities:
    speakers: tuple
    languages: tuple

    def validate(self, request):
        voices = {v.casefold(): v for v in self.speakers}
        languages = {v.casefold(): v for v in self.languages}
        if request.voice.casefold() not in voices:
            raise ServiceError(422, "Unsupported speaker; see /v1/models")
        if request.lang_code.casefold() not in languages:
            raise ServiceError(422, "Unsupported language; see /v1/models")
        return replace(request, voice=voices[request.voice.casefold()],
                       lang_code=languages[request.lang_code.casefold()])


@dataclass(frozen=True)
class AudioResponse:
    body: bytes
    sample_rate: int
    token_count: int
    seed: int

    @property
    def headers(self):
        return {
            "X-Cabin-TTS-Deterministic": DETERMINISTIC,
            "X-Cabin-TTS-Seed": str(self.seed),
            "X-Cabin-TTS-SHA256": hashlib.sha256(self.body).hexdigest(),
            "X-Cabin-TTS-Sample-Rate": str(self.sample_rate),
            "X-Cabin-TTS-Token-Count": str(self.token_count),
            "Cache-Control": "no-store",
        }


def encode_results(results, request, np, write, check):
    """Fully validate before returning any audio; cap applies across all results."""
    chunks, total_tokens, total_samples = [], 0, 0
    iterator = iter(results)
    try:
        for result in iterator:
            check()
            tokens = result.token_count
            if (isinstance(tokens, bool) or not isinstance(tokens, numbers.Integral)
                    or tokens < 1):
                raise ServiceError(422, "Invalid generated token count")
            total_tokens += int(tokens)
            if total_tokens >= request.max_tokens:
                raise ServiceError(422, "Generation reached max_tokens; audio discarded")
            rate = result.sample_rate
            if isinstance(rate, bool) or not isinstance(rate, numbers.Integral) or rate != SAMPLE_RATE:
                raise ServiceError(422, "Expected 24000 Hz generated audio")
            audio = np.asarray(result.audio)
            if (audio.ndim != 1 or audio.size == 0 or audio.dtype.kind != "f"
                    or not np.isfinite(audio).all() or np.abs(audio).max() > 1.0):
                raise ServiceError(422, "Generated audio must be finite normalized mono samples")
            total_samples += audio.size
            if total_samples > SAMPLE_RATE * MAX_DURATION:
                raise ServiceError(422, "Generated audio exceeds 120 seconds")
            chunks.append(audio)
        check()
        if not chunks:
            raise ServiceError(422, "Model generated no audio")
        audio = np.concatenate(chunks)
        output = io.BytesIO()
        write(output, audio, SAMPLE_RATE, format="wav")
        body = output.getvalue()
        # Guard the actual encoded format as well as the model's metadata.
        try:
            with wave.open(io.BytesIO(body), "rb") as wav:
                valid = (wav.getframerate() == SAMPLE_RATE and wav.getnchannels() == 1
                         and wav.getsampwidth() == 2 and wav.getcomptype() == "NONE"
                         and wav.getnframes() == total_samples
                         and len(wav.readframes(total_samples)) == total_samples * 2)
        except (wave.Error, EOFError):
            valid = False
        if not valid:
            raise ServiceError(422, "Encoder did not produce complete mono PCM16 WAV")
        check()
        return AudioResponse(body, SAMPLE_RATE, total_tokens, request.seed)
    finally:
        close = getattr(iterator, "close", None)
        if close is not None:
            close()


class MLXBackend:
    def __init__(self, model_path):
        # Do not move these imports to module scope or into an HTTP executor.
        import mlx.core as mx

        # Match InferenceBroker: both device defaults belong to this worker.
        # Install them BEFORE importing MLX Audio: imports may create streams or
        # MLX arrays that otherwise inherit an uninitialized CPU default.
        self.mx = mx
        self.worker_streams = (mx.new_stream(mx.cpu), mx.new_stream(mx.gpu))
        for stream in self.worker_streams:
            mx.set_default_stream(stream)

        import numpy as np
        from mlx_audio.audio_io import write
        from mlx_audio.utils import load_model

        self.np, self.write = np, write
        self.stream = self.worker_streams[1]
        with mx.stream(self.stream):
            self.model = load_model(model_path)
            if (getattr(self.model, "model_type", None) != "qwen3_tts"
                    or getattr(getattr(self.model, "config", None), "tts_model_type", None)
                    != "custom_voice"):
                raise RuntimeError("A Qwen3 CustomVoice model is required")
            speakers = tuple(self.model.supported_speakers)
            languages = tuple(self.model.supported_languages)
            if not speakers or not languages or not all(
                isinstance(v, str) and v for v in speakers + languages
            ):
                raise RuntimeError("Model capabilities are missing")
            self.capabilities = Capabilities(speakers, languages)
            mx.synchronize()

    def synthesize(self, request, check):
        with self.mx.stream(self.stream):
            try:
                check()
                self.mx.random.seed(request.seed)
                results = self.model.generate(
                    text=request.text, voice=request.voice, lang_code=request.lang_code,
                    instruct=request.instruct,
                    temperature=request.temperature, top_p=request.top_p,
                    top_k=request.top_k, repetition_penalty=request.repetition_penalty,
                    max_tokens=request.max_tokens, stream=False, verbose=False,
                )
                return encode_results(results, request, self.np, self.write, check)
            finally:
                # Finish lazy/native work before another job can seed or infer.
                self.mx.synchronize()

    def close(self):
        self.mx.synchronize()
        self.model = None
        self.mx.clear_cache()


@dataclass
class Job:
    request: SpeechRequest
    deadline: float
    future: concurrent.futures.Future = field(default_factory=concurrent.futures.Future)
    abandoned: threading.Event = field(default_factory=threading.Event)

    def cancel(self):
        self.abandoned.set()
        self.future.cancel()

    def check(self):
        if self.abandoned.is_set() or time.monotonic() >= self.deadline:
            raise ServiceError(504, "Speech request expired or was cancelled")


class SerialService:
    def __init__(self, model_path, *, max_queue=4, request_timeout=30.0,
                 backend_factory=MLXBackend, model_aliases=()):
        path = Path(model_path)
        if not path.is_absolute():
            raise ValueError("--model must be an absolute local directory")
        if type(max_queue) is not int or max_queue < 1:
            raise ValueError("max_queue must be a positive integer")
        if not math.isfinite(request_timeout) or request_timeout <= 0:
            raise ValueError("request_timeout must be finite and positive")
        if isinstance(model_aliases, str) or any(
            not isinstance(alias, str) or not alias or alias != alias.strip()
            for alias in model_aliases
        ):
            raise ValueError("model_aliases must contain nonempty exact model identifiers")
        self.model_path = str(path)
        self.aliases = frozenset((MODEL_ID, self.model_path, path.name, *model_aliases))
        self.max_queue, self.request_timeout = max_queue, request_timeout
        self._factory = backend_factory
        self._condition = threading.Condition()
        self._pending = deque()
        self._active = None
        self._closing = False
        self._ready = concurrent.futures.Future()
        self.capabilities = None
        self._thread = threading.Thread(target=self._run, name="cabin-tts-mlx", daemon=True)

    def start(self):
        self._thread.start()
        return self._ready

    def _run(self):
        backend = None
        try:
            backend = self._factory(self.model_path)
            self.capabilities = backend.capabilities
            self._ready.set_result(None)
            while True:
                with self._condition:
                    self._condition.wait_for(lambda: self._closing or self._pending)
                    if self._closing:
                        break
                    job = self._pending.popleft()
                    if not job.future.set_running_or_notify_cancel():
                        continue
                    self._active = job
                try:
                    job.check()
                    result = backend.synthesize(job.request, job.check)
                    job.check()
                except ServiceError as error:
                    job.future.set_exception(error)
                except Exception:
                    # Native exception strings can contain text, paths or secrets.
                    job.future.set_exception(ServiceError(500, "Speech generation failed"))
                else:
                    job.future.set_result(result)
                finally:
                    with self._condition:
                        self._active = None
        except Exception:
            if not self._ready.done():
                self._ready.set_exception(RuntimeError("TTS model initialization failed"))
        finally:
            self.begin_shutdown()
            if backend is not None:
                with suppress(Exception):
                    backend.close()

    def submit(self, payload, *, deadline=None):
        deadline = time.monotonic() + self.request_timeout if deadline is None else deadline
        request = SpeechRequest.parse(payload, self.aliases)
        with self._condition:
            if self._closing or not self._ready.done() or self.capabilities is None:
                raise ServiceError(503, "TTS worker is unavailable")
            request = self.capabilities.validate(request)
            if time.monotonic() >= deadline:
                raise ServiceError(504, "Speech request deadline exceeded")
            # Reclaim cancelled/expired queue slots even while native inference is busy.
            pending = deque()
            for job in self._pending:
                if job.abandoned.is_set() or job.future.cancelled():
                    job.cancel()
                elif time.monotonic() >= job.deadline:
                    if job.future.set_running_or_notify_cancel():
                        job.future.set_exception(ServiceError(504, "Speech request deadline exceeded"))
                else:
                    pending.append(job)
            self._pending = pending
            if len(self._pending) >= self.max_queue:
                raise ServiceError(503, "TTS queue is full")
            job = Job(request, deadline)
            self._pending.append(job)
            self._condition.notify()
            return job

    def health(self):
        with self._condition:
            ready = self.capabilities is not None and not self._closing
            return {"status": "ok" if ready else "unavailable", "ready": ready,
                    "busy": self._active is not None, "queued": len(self._pending),
                    "max_queue": self.max_queue, "model": MODEL_ID,
                    "deterministic": DETERMINISTIC}

    def begin_shutdown(self):
        with self._condition:
            self._closing = True
            if self._active is not None:
                self._active.cancel()
            while self._pending:
                job = self._pending.popleft()
                if job.future.set_running_or_notify_cancel():
                    job.future.set_exception(ServiceError(503, "TTS worker is shutting down"))
            self._condition.notify_all()

    def close(self, timeout=30.0):
        self.begin_shutdown()
        if self._thread.ident is not None:
            self._thread.join(timeout)
        return not self._thread.is_alive()

    async def aclose(self, timeout=30.0):
        self.begin_shutdown()
        deadline = time.monotonic() + timeout
        while self._thread.is_alive() and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        return not self._thread.is_alive()


async def await_job(job, disconnected=None):
    """Cancellation never frees the native worker for overlapping generation."""
    future = asyncio.wrap_future(job.future)
    watcher = None
    stop_watching = asyncio.Event()
    if disconnected is not None:
        async def watch():
            while not stop_watching.is_set():
                if await disconnected() or stop_watching.is_set():
                    return
                await asyncio.sleep(0.05)
        watcher = asyncio.create_task(watch())
    try:
        done, _ = await asyncio.wait(
            [future] + ([watcher] if watcher is not None else []),
            timeout=max(0, job.deadline - time.monotonic()),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if watcher is not None and watcher in done:
            raise ServiceError(499, "Client disconnected")
        if future not in done or time.monotonic() >= job.deadline:
            raise ServiceError(504, "Speech request deadline exceeded")
        return future.result()
    finally:
        stop_watching.set()
        job.cancel()
        # Consume late native failures after HTTP timeout; no unhandled Future logs.
        def consume(completed):
            if not completed.cancelled():
                completed.exception()
        future.add_done_callback(consume)
        if watcher is not None:
            watcher.add_done_callback(consume)
            watcher.cancel()
            # Starlette's AnyIO CancelScope can swallow Task.cancel() and return
            # False. The stop flag prevents another poll. Never await the task
            # directly, or use wait_for (which waits for cancellation to finish).
            with suppress(asyncio.CancelledError):
                await asyncio.wait({watcher}, timeout=WATCHER_CLEANUP_TIMEOUT)


def create_app(model_path, *, max_queue=4, request_timeout=30.0,
               shutdown_timeout=30.0, backend_factory=MLXBackend, model_aliases=()):
    # HTTP dependencies are optional when importing for stdlib unit tests.
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, Response

    service = SerialService(model_path, max_queue=max_queue,
                            request_timeout=request_timeout, backend_factory=backend_factory,
                            model_aliases=model_aliases)

    @asynccontextmanager
    async def lifespan(app):
        try:
            await asyncio.shield(asyncio.wrap_future(service.start()))
            yield
        finally:
            stopped = await service.aclose(shutdown_timeout)
            if not stopped:
                # Static diagnostic only; native work must never be restarted in parallel.
                import logging
                logging.getLogger("cabin.tts").warning("TTS shutdown timed out; native worker still busy")

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.tts = service

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse({"error": {"message": str(error)}}, status_code=error.status)

    @app.get("/health")
    async def health():
        status = service.health()
        return JSONResponse(status, status_code=200 if status["ready"] else 503)

    @app.get("/v1/models")
    async def models():
        if not service.health()["ready"]:
            raise ServiceError(503, "TTS worker is unavailable")
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model",
                "owned_by": "local", "aliases": sorted(service.aliases),
                "speakers": list(service.capabilities.speakers),
                "languages": list(service.capabilities.languages),
                "deterministic": DETERMINISTIC}]}

    @app.post("/v1/audio/speech")
    async def speech(request: Request):
        deadline = time.monotonic() + request_timeout
        async def read_body():
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_BODY_BYTES:
                    raise ServiceError(413, "Request body is too large")
            return body
        try:
            body = await asyncio.wait_for(read_body(), max(0, deadline - time.monotonic()))
            payload = json.loads(body)
        except asyncio.TimeoutError:
            raise ServiceError(504, "Speech request deadline exceeded") from None
        except (ValueError, UnicodeError, RecursionError):
            raise ServiceError(422, "Request body must be a JSON object") from None
        job = service.submit(payload, deadline=deadline)
        audio = await await_job(job, request.is_disconnected)
        return Response(audio.body, media_type="audio/wav", headers=audio.headers)

    return app


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Absolute local Qwen3 CustomVoice directory")
    parser.add_argument("--model-alias", action="append", default=[],
                        help="Additional exact request model identifier, e.g. its HF repo ID; repeatable")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18004)
    parser.add_argument("--max-queue", type=int, default=4, help="Waiting jobs, excluding the active job")
    parser.add_argument("--request-timeout", type=float, default=30.0, help="Total HTTP/queue/execution seconds")
    parser.add_argument("--shutdown-timeout", type=float, default=30.0)
    args = parser.parse_args(argv)
    if not Path(args.model).is_absolute() or not Path(args.model).is_dir():
        parser.error("--model must be an existing absolute local directory")
    if not 1 <= args.port <= 65535 or args.max_queue < 1:
        parser.error("--port must be 1..65535 and --max-queue must be positive")
    if any(not math.isfinite(v) or v <= 0 for v in (args.request_timeout, args.shutdown_timeout)):
        parser.error("timeouts must be finite and positive")
    import uvicorn
    app = create_app(args.model, max_queue=args.max_queue,
                     request_timeout=args.request_timeout, shutdown_timeout=args.shutdown_timeout,
                     model_aliases=args.model_alias)
    uvicorn.run(app, host=args.host, port=args.port, workers=1, access_log=False,
                timeout_graceful_shutdown=args.shutdown_timeout)


if __name__ == "__main__":
    main()
