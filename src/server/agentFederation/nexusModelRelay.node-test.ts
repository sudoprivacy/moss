import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { NexusModelRelay } from "./nexusModelRelay.js";
import type { NexusHttpModelExchange } from "./provider/nexusModelExecutor.js";

const credential = "synthetic-mount-" + "x".repeat(32);
const target = {
  nexus_endpoint: "https://nexus.example",
  model_mount: "/model",
};
const context = { clientId: "org-a", providerRunId: "call-a" };
const input = {
  model: "fixed-model",
  stream: false,
  max_tokens: 32,
  temperature: 0.1,
  messages: [{ role: "user", content: "private-text" }],
};
const headers = (id?: string, key = credential) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  "x-request-id": id ?? "unknown",
});
async function fixture(
  t: TestContext,
  transport: (url: string, body: any, id?: string) => Promise<Response>,
) {
  let url = "";
  const exchange: NexusHttpModelExchange = async (
    _target,
    body,
    _signal,
    _context,
    id,
  ) => transport(url, body, id);
  const relay = new NexusModelRelay(credential, exchange);
  url = await relay.listen();
  t.after(() => relay.close());
  return { relay, url };
}
void test("relay permits only content rewrite, uses one dispatch and never sends a model credential through Nexus", async (t) => {
  let forwarded = 0;
  const f = await fixture(t, async (url, body, id) => {
    assert.ok(!JSON.stringify(body).includes(credential));
    assert.ok(id && !id.includes("call-a"));
    body.messages[0].content = "[REDACTED]";
    const response = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: headers(id),
      body: JSON.stringify(body),
    });
    assert.equal(
      (
        await fetch(`${url}/chat/completions`, {
          method: "POST",
          headers: headers(id),
          body: JSON.stringify(body),
        })
      ).status,
      409,
    );
    return response;
  });
  const result = await f.relay.invoke(
    target,
    input,
    AbortSignal.timeout(5000),
    context,
    async (body) => {
      forwarded++;
      assert.equal((body.messages as any)[0].content, "[REDACTED]");
      return Response.json({ choices: [{ message: { content: "42" } }] });
    },
  );
  assert.equal(result.status, 200);
  assert.equal(forwarded, 1);
  assert.equal(input.messages[0].content, "private-text");
});
void test("relay rejects altered model, budget, roles, added tools and missing messages before any dispatch", async (t) => {
  for (const mutate of [
    (body: any) => {
      body.model = "other";
    },
    (body: any) => {
      body.max_tokens = 1024;
    },
    (body: any) => {
      body.messages[0].role = "system";
    },
    (body: any) => {
      body.tools = [];
    },
    (body: any) => {
      body.messages = [];
    },
    (body: any) => {
      body.messages[0].extra = true;
    },
  ]) {
    const f = await fixture(t, async (url, body, id) => {
      mutate(body);
      return fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: headers(id),
        body: JSON.stringify(body),
      });
    });
    let dispatched = false;
    await assert.rejects(
      f.relay.invoke(
        target,
        input,
        AbortSignal.timeout(5000),
        context,
        async () => {
          dispatched = true;
          return Response.json({});
        },
      ),
      /MODEL_RELAY_UNAVAILABLE/,
    );
    assert.equal(dispatched, false);
  }
});
void test("wrong mount credential and unregistered ID cannot claim a legitimate invocation", async (t) => {
  const f = await fixture(t, async (url, body, id) => {
    const invoke = (key: string, requestId?: string) =>
      fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: headers(requestId, key),
        body: JSON.stringify(body),
      });
    assert.equal((await invoke("wrong", id)).status, 401);
    assert.equal((await invoke(credential, "foreign")).status, 409);
    return invoke(credential, id);
  });
  assert.equal(
    (
      await f.relay.invoke(
        target,
        input,
        AbortSignal.timeout(5000),
        context,
        async () => Response.json({}),
      )
    ).status,
    200,
  );
});
void test("concurrent relay delivery claims once; stale reply or forged response cannot prove success", async (t) => {
  let dispatched = 0;
  const f = await fixture(t, async (url, body, id) => {
    const responses = await Promise.all(
      [1, 2].map(() =>
        fetch(`${url}/chat/completions`, {
          method: "POST",
          headers: headers(id),
          body: JSON.stringify(body),
        }),
      ),
    );
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    return Response.json({ forged: true });
  });
  await assert.rejects(
    f.relay.invoke(
      target,
      input,
      AbortSignal.timeout(5000),
      context,
      async () => {
        dispatched++;
        return Response.json({ real: true });
      },
    ),
    /MODEL_RELAY_UNAVAILABLE/,
  );
  assert.equal(dispatched, 1);
  const stale = await fixture(t, async () => Response.json({ real: true }));
  await assert.rejects(
    stale.relay.invoke(
      target,
      input,
      AbortSignal.timeout(5000),
      context,
      async () => {
        assert.fail("stale reply must not dispatch");
      },
    ),
    /MODEL_RELAY_UNAVAILABLE/,
  );
});
void test("cancelled/closed invocation and failed callback never expose credentials or allow retry", async (t) => {
  const f = await fixture(t, async (url, body, id) => {
    const r = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: headers(id),
      body: JSON.stringify(body),
    });
    const text = await r.clone().text();
    assert.ok(!text.includes("secret"));
    return r;
  });
  await assert.rejects(
    f.relay.invoke(
      target,
      input,
      AbortSignal.timeout(5000),
      context,
      async () => {
        throw new Error("secret credential");
      },
    ),
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    f.relay.invoke(target, input, c.signal, context, async () =>
      Response.json({}),
    ),
  );
  await f.relay.close();
  await assert.rejects(
    f.relay.invoke(
      target,
      input,
      AbortSignal.timeout(5000),
      context,
      async () => Response.json({}),
    ),
  );
});
