import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { HostedArtifact } from "../../../contracts/agent-registry/v1alpha1/contract.gen.js";
import { ExternalProviderError } from "../externalProviders/policy.js";

const PROTOCOL = "agent-hosted-supervisor/v1",
  LIMIT = 256000;
export interface HostedRunnerConfig {
  python: string;
  docker: string;
  /** Development/assembled source location; never supplied by a task. */
  modulePath?: string;
}
export interface HostedRunOptions {
  artifact: HostedArtifact;
  query: string;
  timeoutSeconds: number;
  maxModelCalls: number;
  signal: AbortSignal;
  model: (sequence: number, body: unknown) => Promise<string>;
  trace: (frame: {
    node: string;
    phase: "started" | "completed";
    origin: "worker_reported";
  }) => Promise<void>;
}
function fail(code: string): never {
  throw new ExternalProviderError(502, code);
}

/** Launches the trusted Nexus supervisor, which owns strict Docker isolation and cleanup. */
export class HostedRunner {
  private readonly config: HostedRunnerConfig;
  constructor(config: HostedRunnerConfig) {
    if (
      !isAbsolute(config.python) ||
      !isAbsolute(config.docker) ||
      (config.modulePath && !isAbsolute(config.modulePath))
    )
      fail("HOSTED_RUNNER_CONFIGURATION_INVALID");
    this.config = { ...config };
  }
  async run(
    options: HostedRunOptions,
  ): Promise<{ answer: string; modelCalls: number }> {
    if (
      typeof options.query !== "string" ||
      !options.query.length ||
      options.query.length > 16000 ||
      !Number.isSafeInteger(options.timeoutSeconds) ||
      options.timeoutSeconds < 1 ||
      options.timeoutSeconds > 240 ||
      !Number.isSafeInteger(options.maxModelCalls) ||
      options.maxModelCalls < 1 ||
      options.maxModelCalls > 32
    )
      fail("HOSTED_INPUT_INVALID");
    options.signal.throwIfAborted();
    const child = spawn(
      this.config.python,
      [
        "-m",
        "nexus.bricks.sandbox.hosted_supervisor",
        "--docker",
        this.config.docker,
      ],
      {
        cwd: "/",
        env: {
          PATH: "/usr/bin:/bin",
          PYTHONUNBUFFERED: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
          ...(this.config.modulePath
            ? { PYTHONPATH: this.config.modulePath }
            : {}),
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    // Attach the error listener before the first await, including a missing executable.
    let spawnFailed = false;
    const closed = new Promise<number | null>((resolve) => {
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", resolve);
    });
    child.stdin.on("error", () => {});
    let killed = false,
      forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode || killed) return;
      killed = true;
      child.kill("SIGTERM"); // Supervisor cancels the runner and verifies removal.
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 15000);
    };
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout((options.timeoutSeconds + 20) * 1000),
    ]);
    signal.addEventListener("abort", stop, { once: true });
    let sequence = 0,
      frameCount = 0,
      totalBytes = 0,
      buffered = Buffer.alloc(0);
    let final: { answer: string; modelCalls: number } | undefined;
    const send = (frame: object) => {
      const bytes = Buffer.from(
        JSON.stringify({ protocol: PROTOCOL, ...frame }) + "\n",
      );
      if (bytes.length > LIMIT || child.stdin.destroyed)
        fail("HOSTED_FRAME_LIMIT");
      child.stdin.write(bytes);
    };
    try {
      signal.throwIfAborted();
      send({
        kind: "execute",
        artifact: options.artifact.image,
        query: options.query,
        timeout_seconds: options.timeoutSeconds,
        max_model_calls: options.maxModelCalls,
        max_output_tokens: options.artifact.image.max_output_tokens,
      });
      for await (const chunk of child.stdout) {
        totalBytes += chunk.length;
        if (totalBytes > 4 * 1024 * 1024) fail("HOSTED_FRAME_LIMIT");
        buffered = Buffer.concat([buffered, chunk]);
        while (true) {
          const end = buffered.indexOf(10);
          if (end < 0) {
            if (buffered.length >= LIMIT) fail("HOSTED_FRAME_LIMIT");
            break;
          }
          if (end + 1 > LIMIT || ++frameCount > 256 || final)
            fail("HOSTED_FRAME_ORDER");
          const raw = buffered.subarray(0, end);
          buffered = buffered.subarray(end + 1);
          let frame: any;
          try {
            frame = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(raw),
            );
          } catch {
            fail("HOSTED_FRAME_INVALID");
          }
          if (!frame || frame.protocol !== PROTOCOL)
            fail("HOSTED_FRAME_INVALID");
          signal.throwIfAborted();
          if (frame.kind === "model_request") {
            if (
              frame.sequence !== ++sequence ||
              sequence > options.maxModelCalls
            )
              fail("HOSTED_CALL_LIMIT");
            const {
              protocol: _protocol,
              kind: _kind,
              sequence: _sequence,
              ...body
            } = frame;
            const answer = await options.model(sequence, body);
            signal.throwIfAborted();
            send({ kind: "model_response", sequence, answer });
          } else if (frame.kind === "trace") {
            if (
              Object.keys(frame).sort().join(",") !==
                "kind,node,origin,phase,protocol" ||
              typeof frame.node !== "string" ||
              !frame.node.length ||
              frame.node.length > 100 ||
              !["started", "completed"].includes(frame.phase) ||
              frame.origin !== "worker_reported"
            )
              fail("HOSTED_TRACE_INVALID");
            await options.trace({
              node: frame.node,
              phase: frame.phase,
              origin: "worker_reported",
            });
          } else if (frame.kind === "completed") {
            if (
              Object.keys(frame).sort().join(",") !==
                "answer,kind,model_calls,protocol" ||
              typeof frame.answer !== "string" ||
              Buffer.byteLength(frame.answer) > 128000 ||
              frame.model_calls !== sequence
            )
              fail("HOSTED_RESULT_INVALID");
            final = { answer: frame.answer, modelCalls: sequence };
            child.stdin.end();
          } else if (
            frame.kind === "failed" &&
            [
              "HOSTED_RUNTIME_UNAVAILABLE",
              "HOSTED_IMAGE_MISMATCH",
              "HOSTED_CLEANUP_UNCONFIRMED",
              "HOSTED_WORKER_FAILED",
              "HOSTED_MODEL_REQUEST_INVALID",
              "HOSTED_CALL_LIMIT",
              "HOSTED_PARENT_FRAME_INVALID",
              "HOSTED_LIMIT_INVALID",
              "HOSTED_INPUT_INVALID",
            ].includes(frame.code)
          )
            fail(frame.code);
          else fail("HOSTED_RESULT_UNCONFIRMED");
        }
      }
      if (
        (await closed) !== 0 ||
        spawnFailed ||
        buffered.length ||
        !final ||
        signal.aborted
      )
        fail("HOSTED_RESULT_UNCONFIRMED");
      return final;
    } catch (error) {
      if (error instanceof ExternalProviderError) throw error;
      throw new ExternalProviderError(502, "HOSTED_RESULT_UNCONFIRMED");
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      await closed;
      if (forceTimer) clearTimeout(forceTimer);
    }
  }
}
