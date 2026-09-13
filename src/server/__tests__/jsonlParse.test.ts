// Runs under Node (`tsx --test`) — deliberately the Node runner: without Bun's
// JSONL.parseChunk fast path these cases exercise parseJSONLString /
// parseJSONLBuffer, the fallback code path the production server actually
// executes (docker runs the node-target bundle). Covers the parseJSONL family
// moved from json.ts into its own module so server-side code (budgetStats)
// can read transcripts without json.ts's CLI-only import graph.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJSONL, readJSONLFile } from "../../utils/jsonl.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "moss-jsonl-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("parseJSONL (node fallback paths)", () => {
  it("parses a plain multi-line string", () => {
    const rows = parseJSONL<{ id: number }>('{"id":1}\n{"id":2}\n');
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  });

  it("parses Buffer input identically", () => {
    const rows = parseJSONL<{ id: number }>(Buffer.from('{"id":1}\n{"id":2}\n'));
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  });

  it("strips a UTF-8 BOM (PowerShell-written files)", () => {
    const bom = "﻿";
    const rows = parseJSONL<{ id: number }>(`${bom}{"id":1}\n`);
    assert.deepEqual(rows, [{ id: 1 }]);
  });

  it("skips malformed lines instead of failing the whole parse", () => {
    const rows = parseJSONL<{ id: number }>('{"id":1}\nnot json\n{"id":2}\n');
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  });

  it("skips empty/whitespace lines", () => {
    const rows = parseJSONL<{ id: number }>('{"id":1}\n\n   \n{"id":2}\n');
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  });

  it("keeps a trailing line without newline", () => {
    const rows = parseJSONL<{ id: number }>('{"id":1}\n{"id":2}');
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  });
});

describe("readJSONLFile (node fallback paths)", () => {
  it("round-trips objects written as JSONL", async () => {
    const rows = [{ a: 1 }, { b: "two" }, { c: [3, null, true] }];
    const path = join(tempDir, "transcript.jsonl");
    await writeFile(path, rows.map(r => JSON.stringify(r)).join("\n"), "utf8");
    const read = await readJSONLFile<typeof rows[number]>(path);
    assert.deepEqual(read, rows);
  });

  it("rejects with an error for a missing file (callers check isENOENT)", async () => {
    await assert.rejects(
      () => readJSONLFile(join(tempDir, "does-not-exist.jsonl")),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});
