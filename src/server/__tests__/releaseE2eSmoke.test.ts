import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

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
    const evidence = workflow.indexOf(
      "- name: Publish Server E2E evidence summary",
    );
    const releaseAssets = workflow.indexOf(
      "- name: Upload architecture assets",
    );

    expect(smoke).toBeGreaterThan(-1);
    expect(diagnostics).toBeGreaterThan(smoke);
    expect(evidence).toBeGreaterThan(diagnostics);
    expect(releaseAssets).toBeGreaterThan(evidence);
    expect(workflow).toContain("scripts/e2e/run-server-release-smoke.sh");
    expect(workflow).toContain("steps.server_e2e_diagnostics.outputs.artifact-url");
    expect(workflow).toContain("fonts-noto-cjk zip");
    expect(workflow).toContain("moss-server-e2e-report-");
    expect(workflow).toContain("release-assets/moss-server-e2e-report-*.zip");
    expect(workflow).not.toContain("release-assets/moss-server-e2e-*.png");
  });

  it("checks accessible lists instead of removed card titles", () => {
    const browser = readFileSync(
      resolve(root, "scripts/e2e/server-admin-browser-smoke.mjs"),
      "utf8",
    );
    expect(browser).toContain('waitForList("用户列表")');
    expect(browser).toContain('waitForList("用户列表", options.createdUsername)');
    expect(browser).not.toContain('waitForText("用户列表")');
    expect(browser).not.toContain('["用户与组织管理", "用户列表"]');
    expect(browser).not.toContain('["用户列表", options.createdUsername]');
    const usersPage = readFileSync(
      resolve(root, "admin/src/pages/users-page.tsx"),
      "utf8",
    );
    expect(usersPage).toContain('<ListSurface aria-label="用户列表" aria-busy={isRefreshing}');
    expect(usersPage).toContain('aria-label="搜索用户名、邮箱或部门"');
  });

  it("checks config list readiness and persisted fields in the editor", () => {
    const browser = readFileSync(
      resolve(root, "scripts/e2e/server-admin-browser-smoke.mjs"),
      "utf8",
    );
    const captureTexts = (name: string): string[] => {
      const match = browser.match(new RegExp(`capture\\("${name}", (\\[[\\s\\S]*?\\])\\)`));
      expect(match).not.toBeNull();
      return runInNewContext(match![1]);
    };
    // An empty successful list has no table headers. Field names live in the editor.
    expect(browser).toContain('waitForList("配置项列表")');
    expect(captureTexts("08-credential-config-items")).toEqual([
      "配置项列表", "全部分类", "全部状态", "创建配置项",
    ]);
    expect(captureTexts("09-credential-config-form")).toContain("认证方案");
    expect(browser).toContain('waitForList("配置项列表", "E2E凭据模板")');
    expect(captureTexts("10-credential-config-created")).toEqual([
      "配置项列表", "E2E凭据模板", "认证方式", "1 个",
    ]);
    expect(browser).toContain('button[aria-label="编辑 E2E凭据模板"]');
    expect(browser).toContain('input[placeholder="access_token"]\')?.value === "api_key"');
    expect(browser).toContain('input[placeholder="Access Token"]\')?.value === "API Key"');
    expect(browser).toContain('capture("10b-credential-config-persisted-fields"');
  });

  for (const scenario of [
    { name: "empty configuration list", label: "配置项列表", ready: true, expected: true },
    { name: "created configuration row", label: "配置项列表", ready: true, rowText: "E2E凭据模板", rows: ["E2E凭据模板 1 个"], expected: true },
    { name: "loaded empty list", ready: true, expected: true },
    { name: "missing list", ready: false, expected: false },
    { name: "busy list", ready: true, busy: true, expected: false },
    { name: "hidden list", ready: true, hidden: true, expected: false },
    { name: "failed refresh with stale rows", ready: true, error: true, expected: false },
    { name: "created row", ready: true, rowText: "e2e-user", rows: ["e2e-user"], expected: true },
    { name: "name outside the table", ready: true, rowText: "e2e-user", rows: ["other-user"], expected: false },
  ]) {
    it(`only accepts a ready list: ${scenario.name}`, async () => {
      const browser = readFileSync(
        resolve(root, "scripts/e2e/server-admin-browser-smoke.mjs"),
        "utf8",
      );
      // Evaluate just this helper, not the CLI entry point that launches Chrome.
      const start = browser.indexOf("async function waitForList(");
      const end = browser.indexOf("async function clickText(", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const label = scenario.label ?? "用户列表";
      const selector = `main section[aria-label="${label}"][aria-busy="false"]`;
      const list = {
        innerText: "e2e-user",
        getClientRects: () => scenario.hidden ? [] : [{}],
        querySelectorAll: (query: string) => {
          expect(query).toBe("tbody tr");
          return (scenario.rows ?? []).map(innerText => ({ innerText }));
        },
      };
      let checked = false;
      await runInNewContext(
        `${browser.slice(start, end)}\nwaitForList(${JSON.stringify(label)}, ${JSON.stringify(scenario.rowText ?? "")})`,
        {
          waitForExpression: async (expression: string) => {
            const result = runInNewContext(expression, {
              document: {
                body: { innerText: "e2e-user" },
                querySelector: (query: string) => {
                  if (query === 'main [role="alert"]') return scenario.error ? {} : null;
                  expect(query).toBe(selector);
                  return scenario.ready && !scenario.busy ? list : null;
                },
              },
            });
            checked = true;
            expect(result).toBe(scenario.expected);
          },
        },
      );
      expect(checked).toBe(true);
    });
  }

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
    const browser = readFileSync(
      resolve(root, "scripts/e2e/server-admin-browser-smoke.mjs"),
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
    expect(runner).toContain("server-admin-browser-smoke.mjs");
    expect(runner).toContain('sudo "$INSTALL_DIR/current/node/bin/node"');
    expect(runner).toContain("e2e-report.md");
    expect(runner).toContain("e2e-report.html");
    expect(runner).toContain('"$EVIDENCE_DIR/index.html"');
    expect(runner).toContain('EVIDENCE_NAME="moss-server-e2e-report-');
    expect(runner).toContain('zip -q -r "$DIST_DIR/$EVIDENCE_NAME.zip"');
    expect(runner).toContain('install.sh" --offline');
    expect(runner).toContain('uninstall.sh" --purge');
    expect(runner).not.toContain("MOSS_INSTANCE_ID=");
    expect(runner).not.toContain("MOSS_MODEL_LIST_URL=");
    expect(mock).toContain('"/v1/models"');
    expect(mock).not.toContain("/api/specific_pricing");
    expect(driver).toMatch(/type:\s*["']user["']/);
    expect(driver).toMatch(/event\.type\s*===\s*["']assistant["']/);
    expect(driver).toMatch(/event\.type\s*===\s*["']result["']/);
    expect(mock).toMatch(/pathname\.endsWith\(["']\/chat\/completions["']\)/);
    expect(mock).toMatch(
      /["']content-type["']:\s*["']text\/event-stream; charset=utf-8["']/,
    );
    expect(browser).toContain('capture("01-login-page"');
    expect(browser).toContain('clickText("新建用户"');
    expect(browser).toContain('capture("05-user-created"');
    expect(browser).toContain('capture("12-session-management"');
    expect(browser).toContain('capture("13-host-session-chat"');
    expect(browser).toContain('capture("14-docker-session-chat"');
    expect(browser).toContain("Page.captureScreenshot");
    expect(browser).toContain('"browser-evidence.html"');
    expect(hostBackend).toContain("plugins: { bundledRoot: bundledPluginsDir }");
    expect(hostBackend).toContain("SUDO_CODE_CONFIG_HOME: dotNexusDir");
    expect(dockerBackend).toContain("plugins: { bundledRoot: bundledPluginsDir }");
  });
});
