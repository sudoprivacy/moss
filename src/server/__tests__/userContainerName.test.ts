// Runs under Node: `tsx --test`. B5/R3: user-container names must be
// instance-scoped so two instances sharing a docker.sock never collide on or
// kill each other's containers. reconcile/shutdownAll's label filtering is
// docker-dependent (WSL integration); this pins the pure naming contract that
// both the registry and spawnAttempt rely on producing the SAME name.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUserContainerName } from "../runtime/userContainerRegistry.js";

describe("B5: buildUserContainerName instance scoping", () => {
  it("is deterministic for the same (org, user, instance)", () => {
    assert.equal(
      buildUserContainerName("o1", "u1", "inst-abc"),
      buildUserContainerName("o1", "u1", "inst-abc"),
    );
  });

  it("differs by instance so peers do not collide", () => {
    assert.notEqual(
      buildUserContainerName("o1", "u1", "inst-aaaaaa"),
      buildUserContainerName("o1", "u1", "inst-bbbbbb"),
    );
  });

  it("falls back to a 'default' suffix (never the literal 'undefined') for single instance", () => {
    const name = buildUserContainerName("o1", "u1");
    assert.match(name, /^moss-user-[0-9a-f]{12}-default$/);
    assert.ok(!name.includes("undefined"));
  });

  it("keeps the full instance id in the suffix and stays within Docker's 63-char limit", () => {
    const name = buildUserContainerName("o1", "u1", "0123456789abcdef");
    assert.ok(name.endsWith("-0123456789abcdef"), `unexpected suffix: ${name}`);
    assert.ok(name.length <= 63);
  });

  it("differs for instance ids sharing the same 6-char prefix (moss-server-0/1 regression)", () => {
    assert.notEqual(
      buildUserContainerName("o1", "u1", "moss-server-0"),
      buildUserContainerName("o1", "u1", "moss-server-1"),
    );
  });

  it("truncates >40-char instance ids to prefix-31 + '-' + hash8, staying within 63 and unique", () => {
    const longA = `${"x".repeat(41)}0`;
    const longB = `${"x".repeat(41)}1`;
    const nameA = buildUserContainerName("o1", "u1", longA);
    const nameB = buildUserContainerName("o1", "u1", longB);
    assert.notEqual(nameA, nameB);
    assert.match(nameA, /-[0-9a-f]{8}$/);
    assert.match(nameB, /-[0-9a-f]{8}$/);
    assert.ok(nameA.length <= 63, `nameA too long: ${nameA.length}`);
    assert.ok(nameB.length <= 63, `nameB too long: ${nameB.length}`);
  });
});
