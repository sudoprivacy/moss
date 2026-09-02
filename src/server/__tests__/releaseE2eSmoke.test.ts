import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

describe("packaged Server E2E smoke", () => {
  it("gates release asset upload on the packaged smoke test", () => {
    const workflow = readFileSync(
      resolve(root, ".github/workflows/build-release.yml"),
      "utf8",
    );
    const smoke = workflow.indexOf("- name: Run packaged Server E2E smoke");
    const diagnostics = workflow.indexOf(
      "- name: Upload Server E2E diagnostics",
    );
    const releaseAssets = workflow.indexOf(
      "- name: Upload architecture assets",
    );

    expect(smoke).toBeGreaterThan(-1);
    expect(diagnostics).toBeGreaterThan(smoke);
    expect(releaseAssets).toBeGreaterThan(diagnostics);
    expect(workflow).toContain("scripts/e2e/run-server-release-smoke.sh");
  });

  it("exercises both packaged scode runtimes without a real provider", () => {
    const runner = readFileSync(
      resolve(root, "scripts/e2e/run-server-release-smoke.sh"),
      "utf8",
    );
    const driver = readFileSync(
      resolve(root, "scripts/e2e/server-release-smoke.mjs"),
      "utf8",
    );
    const mock = readFileSync(
      resolve(root, "scripts/e2e/mock-openai-server.mjs"),
      "utf8",
    );
    const hostBackend = readFileSync(
      resolve(root, "src/server/backends/scodeBackend.ts"),
      "utf8",
    );
    const dockerBackend = readFileSync(
      resolve(root, "src/server/backends/dockerBackend.ts"),
      "utf8",
    );

    expect(runner).toContain("--runtimes host,docker");
    expect(runner).toContain('install.sh" --offline');
    expect(runner).toContain('uninstall.sh" --purge');
    expect(runner).toContain("MOSS_MODEL_LIST_URL=");
    expect(driver).toMatch(/type:\s*["']user["']/);
    expect(driver).toMatch(/event\.type\s*===\s*["']assistant["']/);
    expect(driver).toMatch(/event\.type\s*===\s*["']result["']/);
    expect(mock).toMatch(/pathname\.endsWith\(["']\/chat\/completions["']\)/);
    expect(mock).toMatch(
      /["']content-type["']:\s*["']text\/event-stream; charset=utf-8["']/,
    );
    expect(hostBackend).toContain("plugins: { bundledRoot: bundledPluginsDir }");
    expect(hostBackend).toContain("SUDO_CODE_CONFIG_HOME: dotNexusDir");
    expect(dockerBackend).toContain("plugins: { bundledRoot: bundledPluginsDir }");
  });
});
