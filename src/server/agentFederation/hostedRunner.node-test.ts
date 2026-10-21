import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedRunner } from "./hostedRunner.js";
import type { HostedArtifact } from "../../../contracts/agent-registry/v1alpha1/contract.gen.js";
import { ExternalProviderError } from "../externalProviders/policy.js";
const artifact = { image: { max_output_tokens: 32 } } as HostedArtifact;
async function fixture(t: TestContext, script: string) {
  const dir = await mkdtemp(join(tmpdir(), "hosted-runner-test-")),
    python = join(dir, "supervisor");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(python, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  return new HostedRunner({ python, docker: "/usr/bin/docker" });
}
const prelude = `const send = frame => process.stdout.write(JSON.stringify({protocol:'agent-hosted-supervisor/v1',...frame})+'\\n');let text='';process.stdin.on('data',chunk=>{text+=chunk;while(text.includes('\\n')){const at=text.indexOf('\\n'),frame=JSON.parse(text.slice(0,at));text=text.slice(at+1);handle(frame)}});`;
const base = () => ({
  artifact,
  query: "6 * 7",
  timeoutSeconds: 5,
  maxModelCalls: 1,
  signal: AbortSignal.timeout(5000),
  model: async () => "42",
  trace: async () => {},
});
void test("parent runner delegates only fixed supervisor configuration and awaits clean exit", async (t) => {
  const runner = await fixture(
    t,
    prelude +
      `function handle(frame){if(frame.kind==='execute'){if(Object.keys(process.env).some(k=>/TOKEN|KEY|SECRET/.test(k)))process.exit(2);send({kind:'trace',node:'model',phase:'started',origin:'worker_reported'});send({kind:'model_request',sequence:1,messages:[{role:'user',content:frame.query}],max_tokens:32})}else{send({kind:'completed',answer:frame.answer,model_calls:1});process.exit(0)}}`,
  );
  let models = 0,
    traces = 0;
  const result = await runner.run({
    ...base(),
    model: async (seq, body: any) => {
      models++;
      assert.equal(seq, 1);
      assert.equal(body.messages[0].content, "6 * 7");
      return "42";
    },
    trace: async () => {
      traces++;
    },
  });
  assert.deepEqual(result, { answer: "42", modelCalls: 1 });
  assert.equal(models, 1);
  assert.equal(traces, 1);
});
void test("forged model sequence, oversized frame, inconsistent result and nonzero exit are rejected", async (t) => {
  for (const script of [
    `send({kind:'model_request',sequence:2});process.exit(0)`,
    `process.stdout.write('x'.repeat(256001));process.exit(0)`,
    `send({kind:'completed',answer:'42',model_calls:1});process.exit(0)`,
    `send({kind:'completed',answer:'42',model_calls:0});process.exit(2)`,
  ]) {
    const runner = await fixture(t, prelude + `function handle(){${script}}`);
    let dispatched = false;
    await assert.rejects(
      runner.run({
        ...base(),
        model: async () => {
          dispatched = true;
          return "42";
        },
      }),
    );
    assert.equal(dispatched, false);
  }
});
void test("IAM/model callback refusal is preserved and supervisor is terminated", async (t) => {
  const runner = await fixture(
    t,
    prelude +
      `function handle(){send({kind:'model_request',sequence:1,messages:[],max_tokens:32})}`,
  );
  await assert.rejects(
    runner.run({
      ...base(),
      model: async () => {
        throw new ExternalProviderError(401, "EXECUTION_INACTIVE");
      },
    }),
    /EXECUTION_INACTIVE/,
  );
});
void test("missing supervisor path fails without exposing local path", async () => {
  const runner = new HostedRunner({
    python: "/private/nonexistent-supervisor",
    docker: "/usr/bin/docker",
  });
  await assert.rejects(
    runner.run(base()),
    (error) =>
      error instanceof ExternalProviderError &&
      error.code === "HOSTED_RESULT_UNCONFIRMED" &&
      !error.message.includes("/private"),
  );
});
void test("abort stops a live supervisor instead of accepting an incomplete result", async (t) => {
  const runner = await fixture(
      t,
      prelude + `function handle(){setInterval(()=>{},1000)}`,
    ),
    c = new AbortController();
  const active = runner.run({ ...base(), signal: c.signal });
  setTimeout(() => c.abort(), 50);
  await assert.rejects(active, /HOSTED_RESULT_UNCONFIRMED/);
});
