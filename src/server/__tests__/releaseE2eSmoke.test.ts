import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { shellPathEnvironment, toShellPath } from "../testing/shellPaths.js";

const root = resolve(import.meta.dir, "../../..");

function extractShellFunction(source: string, name: string): string {
  const match = source.replace(/\r\n/g, "\n").match(new RegExp(`(?:^|\\n)${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  expect(match, `${name} must remain extractable from deploy/legacy/install-host.sh`).not.toBeNull();
  return match![0].replace(/^\n/, "");
}

type RollbackScenario = {
  envExisted: boolean;
  failureStatus: number;
  previousRelease: boolean;
  serviceStopped: boolean;
};

type RollbackResult = {
  actionLog: string;
  config: string;
  currentTarget: string;
  env: string | null;
  newRelease: string;
  nexusLock: string;
  nexusState: string;
  oldRelease: string;
  previousTarget: string;
  restartLog: string;
  rollbackLinkExists: boolean;
  status: number | null;
};

function runRollbackScenario(
  restoreInstallConfig: string,
  rollbackOnError: string,
  scenario: RollbackScenario,
): RollbackResult {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "moss-installer-rollback-"));
  try {
    const installDir = resolve(tempRoot, "install");
    const oldRelease = resolve(installDir, "releases/old");
    const newRelease = resolve(installDir, "releases/new");
    const current = resolve(installDir, "current");
    const configPath = resolve(installDir, "server.json");
    const envPath = resolve(installDir, "moss-server.env");
    const configBackup = resolve(tempRoot, "server.json.backup");
    const envBackup = resolve(tempRoot, "moss-server.env.backup");
    const actionLog = resolve(tempRoot, "actions.log");
    const systemctlLog = resolve(tempRoot, "systemctl.log");
    const nexusLock = resolve(installDir, ".moss/nexus/data.zone-id.lock.json");
    const nexusState = resolve(installDir, ".moss/nexus/data/state.bin");

    mkdirSync(oldRelease, { recursive: true });
    mkdirSync(newRelease, { recursive: true });
    mkdirSync(resolve(nexusLock, ".."), { recursive: true });
    mkdirSync(resolve(nexusState, ".."), { recursive: true });
    symlinkSync(newRelease, current);
    writeFileSync(configBackup, "original-config\n");
    writeFileSync(configPath, "mutated-config\n");
    if (scenario.envExisted) writeFileSync(envBackup, "original-env\n");
    writeFileSync(envPath, "mutated-env\n");
    writeFileSync(nexusLock, "immutable-zone-lock\n");
    writeFileSync(nexusState, "immutable-nexus-state\n");

    const script = `
set -u
${restoreInstallConfig}
${rollbackOnError}
log() {
  printf '%s\\n' "$*" >> "$ACTION_LOG"
}
systemctl() {
  [ "$#" -eq 2 ] && [ "$1" = restart ] && [ "$2" = "$SERVICE_NAME.service" ] || return 91
  printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
}
# macOS mv has no GNU -T. This narrow shim accepts only the installer's expected
# temporary-link replacement beneath this fixture; real systemd and target-host
# filesystem behavior remains the packaged smoke/deployment gate's responsibility.
mv() {
  [ "$#" -eq 3 ] && [ "$1" = -Tf ] || return 92
  [ "$2" = "$INSTALL_DIR/.current.rollback" ] || return 93
  [ "$3" = "$INSTALL_DIR/current" ] || return 94
  command rm -f -- "$3"
  command mv -- "$2" "$3"
}
trap rollback_on_error ERR
bash -c 'exit "$1"' _ "$FAILURE_STATUS"
exit 99
`;
    const execution = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        // Git Bash otherwise copies directories for ln -s on Windows, so the
        // rollback test would never exercise the production symlink switch.
        ...(process.platform === "win32" ? { MSYS: "winsymlinks:nativestrict" } : {}),
        ENV_EXISTED: scenario.envExisted ? "1" : "0",
        EXISTING_INSTALL: "1",
        FAILURE_STATUS: String(scenario.failureStatus),
        SERVICE_NAME: "moss-server-test",
        SERVICE_STOPPED: scenario.serviceStopped ? "1" : "0",
        ...shellPathEnvironment({
          ACTION_LOG: actionLog,
          CONFIG_BACKUP: configBackup,
          CONFIG_PATH: configPath,
          ENV_BACKUP: scenario.envExisted ? envBackup : "",
          ENV_PATH: envPath,
          HOME: tempRoot,
          INSTALL_DIR: installDir,
          PREVIOUS_TARGET: scenario.previousRelease ? oldRelease : "",
          SYSTEMCTL_LOG: systemctlLog,
          TMPDIR: tempRoot,
        }),
      },
    });

    return {
      actionLog: existsSync(actionLog) ? readFileSync(actionLog, "utf8") : "",
      config: readFileSync(configPath, "utf8"),
      currentTarget: realpathSync(current),
      env: existsSync(envPath) ? readFileSync(envPath, "utf8") : null,
      newRelease: realpathSync(newRelease),
      nexusLock: readFileSync(nexusLock, "utf8"),
      nexusState: readFileSync(nexusState, "utf8"),
      oldRelease: realpathSync(oldRelease),
      previousTarget: toShellPath(oldRelease),
      restartLog: existsSync(systemctlLog) ? readFileSync(systemctlLog, "utf8") : "",
      rollbackLinkExists: existsSync(resolve(installDir, ".current.rollback")),
      status: execution.status,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function expectRollbackResult(result: RollbackResult, scenario: RollbackScenario): void {
  const switchesRelease = scenario.serviceStopped && scenario.previousRelease;
  expect(result.status).toBe(scenario.failureStatus);
  expect(result.config).toBe("original-config\n");
  expect(result.env).toBe(scenario.envExisted ? "original-env\n" : null);
  expect(result.currentTarget).toBe(switchesRelease ? result.oldRelease : result.newRelease);
  expect(result.restartLog).toBe(switchesRelease ? "restart moss-server-test.service\n" : "");
  expect(result.actionLog).toBe(
    switchesRelease ? `Installation failed; restoring ${result.previousTarget}\n` : "",
  );
  expect(result.rollbackLinkExists).toBe(false);
  expect(result.nexusLock).toBe("immutable-zone-lock\n");
  expect(result.nexusState).toBe("immutable-nexus-state\n");
}

describe("packaged Server E2E smoke", () => {
  it("preserves execution placement independently of a program upgrade", () => {
    const installer = readFileSync(resolve(root, "deploy/legacy/install-host.sh"), "utf8");
    const placement = extractShellFunction(installer, "runtime_placement_environment");
    const tempRoot = mkdtempSync(resolve(tmpdir(), "moss-runtime-placement-"));
    const envPath = resolve(tempRoot, "moss-server.env");
    const scriptPath = resolve(tempRoot, "placement.sh");
    writeFileSync(scriptPath, `set -euo pipefail\n${placement}\ndie() { exit 1; }\nruntime_placement_environment "$ENV_PATH" "$DEFAULT_MANIFEST"\n`);
    const run = (source: string, overrides: Record<string, string> = {}, defaultManifest = "") => {
      writeFileSync(envPath, source);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^MOSS_(RUNTIME_MANIFEST_PATH|USER_RUNTIME_|SCODE_IMAGE|K8S_)/.test(key)));
      return spawnSync("bash", [toShellPath(scriptPath)], {
        encoding: "utf8",
        env: { ...env, ...shellPathEnvironment({ ENV_PATH: envPath }), DEFAULT_MANIFEST: defaultManifest, ...overrides },
      });
    };
    try {
      const original = [
        'MOSS_USER_RUNTIME_IMAGE="runtime:old"',
        'MOSS_RUNTIME_MANIFEST_PATH="/releases/old/runtime-release.json"',
        'MOSS_USER_RUNTIME_HOST=10.0.0.2',
        'MOSS_K8S_RUNTIME_CLASS=""',
        'MOSS_K8S_WORKSPACE_STORAGE_CLASS=retained-storage',
        'MOSS_K8S_IMAGE_PULL_POLICY=Never',
        'UNRELATED=value',
        '',
      ].join("\n");
      const retained = run(original, {}, "/current/runtime-release.json");
      expect(retained.status).toBe(0);
      for (const line of original.split("\n").filter(line => line.startsWith("MOSS_"))) expect(retained.stdout).toContain(line + "\n");
      expect(retained.stdout).not.toContain("UNRELATED");
      expect(retained.stdout).not.toContain("/current/");
      expect(run("").stdout).toBe("");
      expect(run("", {}, "/current/runtime-release.json").stdout).toBe('MOSS_RUNTIME_MANIFEST_PATH="/current/runtime-release.json"\n');
      const overridden = run(original, { MOSS_USER_RUNTIME_IMAGE: 'runtime:new', MOSS_RUNTIME_MANIFEST_PATH: '/next/runtime-release.json', MOSS_K8S_RUNTIME_CLASS: '' });
      expect(overridden.status).toBe(0);
      expect(overridden.stdout).toContain('MOSS_USER_RUNTIME_IMAGE="runtime:new"\n');
      expect(overridden.stdout).toContain('MOSS_RUNTIME_MANIFEST_PATH="/next/runtime-release.json"\n');
      expect(overridden.stdout).not.toContain("runtime:old");
      expect(overridden.stdout).not.toContain("/releases/old/");
      expect(run("MOSS_USER_RUNTIME_IMAGE=first\nMOSS_USER_RUNTIME_IMAGE=last\n").stdout).toBe("MOSS_USER_RUNTIME_IMAGE=last\n");
      expect(run("", { MOSS_K8S_KUBECONFIG: 'a"b\\c' }).stdout).toBe('MOSS_K8S_KUBECONFIG="a\\"b\\\\c"\n');
      expect(run("", { MOSS_USER_RUNTIME_HOST: "host\ninjected=value" }).status).not.toBe(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, process.platform === "win32" ? 15_000 : 5_000);

  for (const arch of ["amd64", "arm64"] as const) for (const scenario of ["shared release", "legacy release", "missing cohost manifest", "corrupt manifest"] as const) {
    it("downloads " + arch + " offline assets safely for " + scenario, async () => {
      const tempRoot = mkdtempSync(resolve(tmpdir(), "moss-offline-download-"));
      const downloadDir = resolve(tempRoot, "download");
      const manifestName = arch === "amd64" ? "runtime-release.json" : "runtime-release-arm64.json";
      const isManifestIncluded = scenario === "shared release" || scenario === "corrupt manifest";
      const assets = new Map<string, Buffer>([
        ["install.sh", Buffer.from('#!/usr/bin/env bash\nRELEASE_TAG="${MOSS_RELEASE_TAG:-server-vtest}"\n')],
        [`moss-server-test-linux-${arch}.tar.gz`, Buffer.from("host archive fixture\n")],
        [`moss-runtime-test-linux-${arch}.tar.gz`, Buffer.from("runtime archive fixture\n")],
      ]);
      if (isManifestIncluded) assets.set(manifestName, Buffer.from('{"schemaVersion":1}\n'));
      const checksums = [...assets].filter(([name]) => name !== "install.sh")
        .map(([name, data]) => createHash("sha256").update(data).digest("hex") + "  " + name + "\n").join("");
      assets.set("SHA256SUMS", Buffer.from(checksums));
      if (scenario === "corrupt manifest") assets.set(manifestName, Buffer.from("tampered manifest\n"));
      const server = createServer((request, response) => {
        const data = assets.get(request.url?.slice(1) ?? "");
        response.writeHead(data ? 200 : 404);
        response.end(data ?? "Not found");
      });
      await new Promise<void>(resolveReady => server.listen(0, "127.0.0.1", resolveReady));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing download fixture address");
        const child = spawn("bash", [toShellPath(resolve(root, "deploy/legacy/install-host.sh")), "--download", toShellPath(downloadDir)], {
          env: {
            ...process.env,
            MOSS_RELEASE_TAG: "server-vtest",
            MOSS_ARCH: arch,
            MOSS_DOWNLOAD_BASE: "http://127.0.0.1:" + address.port,
            MOSS_RUNTIME: scenario === "missing cohost manifest" ? "cohost" : "",
          },
          signal: AbortSignal.timeout(20_000),
        });
        let output = "";
        child.stdout.on("data", chunk => { output += chunk.toString(); });
        child.stderr.on("data", chunk => { output += chunk.toString(); });
        const status = await new Promise<number | null>((resolveExit, reject) => {
          child.once("error", reject);
          child.once("close", resolveExit);
        });
        if (scenario === "corrupt manifest" || scenario === "missing cohost manifest") {
          expect(status).not.toBe(0);
          expect(output).not.toContain("Offline files are ready");
          expect(output).toContain("runtime-release");
        } else {
          expect(status).toBe(0);
          expect(output).toContain("Offline files are ready");
          expect(Buffer.compare(readFileSync(resolve(downloadDir, `moss-server-test-linux-${arch}.tar.gz`)), assets.get(`moss-server-test-linux-${arch}.tar.gz`)!)).toBe(0);
          expect(existsSync(resolve(downloadDir, manifestName))).toBe(isManifestIncluded);
          if (isManifestIncluded) {
            expect(Buffer.compare(readFileSync(resolve(downloadDir, manifestName)), assets.get(manifestName)!)).toBe(0);
            expect(output).toContain(manifestName + ": OK");
          }
        }
      } finally {
        await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }, 30_000);
  }

  it("restores failed upgrades without touching Nexus state", () => {
    const installer = readFileSync(resolve(root, "deploy/legacy/install-host.sh"), "utf8");
    const restoreInstallConfig = extractShellFunction(installer, "restore_install_config");
    const rollbackOnError = extractShellFunction(installer, "rollback_on_error");

    for (const scenario of [
      { envExisted: true, failureStatus: 17, previousRelease: true, serviceStopped: true },
      { envExisted: false, failureStatus: 18, previousRelease: true, serviceStopped: true },
      { envExisted: true, failureStatus: 19, previousRelease: true, serviceStopped: false },
      { envExisted: true, failureStatus: 20, previousRelease: false, serviceStopped: true },
    ] satisfies RollbackScenario[]) {
      expectRollbackResult(
        runRollbackScenario(restoreInstallConfig, rollbackOnError, scenario),
        scenario,
      );
    }
  }, process.platform === "win32" ? 60_000 : 5_000);

  it("detects rollback behavior removed from the test-local function copy", () => {
    const installer = readFileSync(resolve(root, "deploy/legacy/install-host.sh"), "utf8");
    const restoreInstallConfig = extractShellFunction(installer, "restore_install_config");
    const rollbackOnError = extractShellFunction(installer, "rollback_on_error");
    const scenario: RollbackScenario = {
      envExisted: true,
      failureStatus: 29,
      previousRelease: true,
      serviceStopped: true,
    };
    const releaseSwitch = [
      '    ln -sfn "$PREVIOUS_TARGET" "$INSTALL_DIR/.current.rollback"',
      '    mv -Tf "$INSTALL_DIR/.current.rollback" "$INSTALL_DIR/current"',
      "",
    ].join("\n");
    const restart = '    systemctl restart "$SERVICE_NAME.service" >/dev/null 2>&1 || true\n';
    const mutations = [
      {
        name: "config restoration",
        rollback: rollbackOnError.replace(
          "  restore_install_config\n",
          "  : # restoration removed by mutation probe\n",
        ),
      },
      {
        name: "release symlink restoration",
        rollback: rollbackOnError.replace(
          releaseSwitch,
          "    : # release switch removed by mutation probe\n",
        ),
      },
      {
        name: "previous service restart",
        rollback: rollbackOnError.replace(
          restart,
          "    : # restart removed by mutation probe\n",
        ),
      },
      {
        name: "Nexus data preservation",
        rollback: rollbackOnError.replace(
          "  restore_install_config\n",
          '  restore_install_config\n  rm -rf -- "$INSTALL_DIR/.moss/nexus/data"\n',
        ),
      },
      {
        name: "Nexus lock preservation",
        rollback: rollbackOnError.replace(
          "  restore_install_config\n",
          '  restore_install_config\n  printf "corrupted-lock\\n" > "$INSTALL_DIR/.moss/nexus/data.zone-id.lock.json"\n',
        ),
      },
    ];

    for (const mutation of mutations) {
      expect(mutation.rollback, mutation.name).not.toBe(rollbackOnError);
      expect(() => {
        const result = runRollbackScenario(restoreInstallConfig, mutation.rollback, scenario);
        expectRollbackResult(result, scenario);
      }, mutation.name).toThrow();
    }
  }, process.platform === "win32" ? 60_000 : 5_000);

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
