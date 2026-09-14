// Runs under Node (`tsx --test`). Covers every branch of isTranscriptMessage
// — moved from sessionStorage.ts into its own module so server-side code
// (budgetStats) can use the guard without sessionStorage's CLI-only import
// graph. These cases pin the exact filter set: progress entries must stay
// excluded (#14373/#23537 chain-fork regressions).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTranscriptMessage } from "../../utils/transcriptGuard.js";

// Minimal Entry-shaped objects: the guard only reads `type`.
function entry(type: string): { type: string } {
  return { type };
}

describe("isTranscriptMessage (transcript membership guard)", () => {
  it("accepts the four transcript message types", () => {
    assert.equal(isTranscriptMessage(entry("user") as never), true);
    assert.equal(isTranscriptMessage(entry("assistant") as never), true);
    assert.equal(isTranscriptMessage(entry("attachment") as never), true);
    assert.equal(isTranscriptMessage(entry("system") as never), true);
  });

  it("rejects progress — ephemeral UI state must not enter the parentUuid chain (#14373/#23537)", () => {
    assert.equal(isTranscriptMessage(entry("progress") as never), false);
  });

  it("rejects non-transcript bookkeeping entries (summary/customTitle/...)", () => {
    assert.equal(isTranscriptMessage(entry("summary") as never), false);
    assert.equal(isTranscriptMessage(entry("customTitle") as never), false);
  });

  it("rejects unknown and missing types without throwing", () => {
    assert.equal(isTranscriptMessage(entry("somethingNew") as never), false);
    assert.equal(isTranscriptMessage({} as never), false);
  });
});
