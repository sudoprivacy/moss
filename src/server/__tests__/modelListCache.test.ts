import { afterEach, describe, expect, it } from "bun:test";
import { clearModelCache, getAvailableModels } from "../modelListCache.js";

const originalFetch = globalThis.fetch;
const originalModelListUrl = process.env.MOSS_MODEL_LIST_URL;

afterEach(() => {
  clearModelCache();
  globalThis.fetch = originalFetch;
  if (originalModelListUrl === undefined)
    delete process.env.MOSS_MODEL_LIST_URL;
  else process.env.MOSS_MODEL_LIST_URL = originalModelListUrl;
});

describe("model list cache", () => {
  it("uses the configured model-list URL for hermetic deployments", async () => {
    const expectedUrl = "http://127.0.0.1:43210/api/specific_pricing";
    let requestedUrl = "";
    process.env.MOSS_MODEL_LIST_URL = expectedUrl;
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          success: true,
          data: [
            { model_id: "moss-e2e-model", model: "Moss E2E Model", ratio: 1 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(getAvailableModels()).resolves.toEqual([
      { id: "moss-e2e-model", name: "Moss E2E Model", ratio: 1 },
    ]);
    expect(requestedUrl).toBe(expectedUrl);
  });
});
