import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

describe("packaged Server E2E smoke", () => {
  it("keeps local Node startup and both server Dockerfiles self-contained", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const buildScript = readFileSync(resolve(root, "scripts/build.js"), "utf8");
    const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
    const dockerignore = readFileSync(resolve(root, ".dockerignore"), "utf8");
    const prebuiltDockerfile = readFileSync(
      resolve(root, "deploy/server.Dockerfile"),
      "utf8",
    );
    const sourceDockerfile = readFileSync(
      resolve(root, "deploy/server.Dockerfile.local"),
      "utf8",
    );
    const installer = readFileSync(resolve(root, "deploy/install.sh"), "utf8");
    const releaseSmoke = readFileSync(
      resolve(root, "scripts/e2e/run-server-release-smoke.sh"),
      "utf8",
    );

    expect(packageJson.scripts["build:native"]).toBe("node scripts/build-nexus-napi.js");
    expect(buildScript).toContain("buildNexusNapi");
    expect(buildScript).toContain("MOSS_SKIP_NEXUS_NAPI_BUILD");
    expect(gitignore).toContain("native/nexus-napi/target/");
    expect(dockerignore).toContain("!bin/moss-server.mjs");
    expect(dockerignore).toContain("!bin/nexus/**");
    expect(prebuiltDockerfile).toContain("COPY native/nexus-napi/index.js");
    expect(prebuiltDockerfile).toContain("COPY native/nexus-napi/nexus-napi.*.node");
    expect(prebuiltDockerfile).toContain("COPY bin/nexus/ ./bin/nexus/");
    expect(prebuiltDockerfile).toContain("COPY bin/corpapp bin/");
    expect(prebuiltDockerfile).toContain("require('./native/nexus-napi')");
    expect(sourceDockerfile).toContain("MOSS_SKIP_NEXUS_NAPI_BUILD=1 bun run build:node");
    expect(prebuiltDockerfile).toContain('CMD ["node", "bin/moss-server.mjs"]');
    expect(sourceDockerfile).toContain('CMD ["node", "bin/moss-server.mjs"]');
    expect(sourceDockerfile).toContain(
      "FROM --platform=$BUILDPLATFORM oven/bun:1 AS js-builder",
    );
    expect(sourceDockerfile).toContain(
      "FROM --platform=$BUILDPLATFORM oven/bun:1 AS runtime-deps",
    );
    expect(sourceDockerfile).toContain('bun install --os=linux --cpu="$BUN_TARGET_CPU"');
    expect(sourceDockerfile).toContain(
      "FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS go-builder",
    );
    expect(sourceDockerfile).toContain("ARG BUILDPLATFORM");
    expect(sourceDockerfile).toContain("ARG TARGETPLATFORM");
    expect(installer).toContain(
      "ExecStart=$INSTALL_DIR/current/node/bin/node $INSTALL_DIR/current/app/bin/moss-server.mjs\n",
    );
    expect(installer).not.toContain("moss-server.mjs start");
    expect(releaseSmoke).not.toContain("moss-server.mjs start");
  });

  it("pins the Docker nexus-napi source and advertises only supported image platforms", () => {
    const versions = JSON.parse(
      readFileSync(resolve(root, "src/server/nexus/runtime-versions.json"), "utf8"),
    ) as Record<string, string>;
    const cargoToml = readFileSync(
      resolve(root, "native/nexus-napi/Cargo.toml"),
      "utf8",
    );
    const workflow = readFileSync(
      resolve(root, ".github/workflows/build-release.yml"),
      "utf8",
    );
    const localBuild = readFileSync(
      resolve(root, "deploy/build-server-local.sh"),
      "utf8",
    );
    const packageServer = readFileSync(
      resolve(root, "deploy/package-server.sh"),
      "utf8",
    );

    expect(versions["sudocode-revision"]).toMatch(/^[0-9a-f]{40}$/);
    expect(cargoToml).toContain(`rev = "${versions["sudocode-revision"]}"`);
    expect(workflow).toContain("sudocode_revision=${SUDOCODE_REVISION}");
    expect(workflow).toContain("ref: ${{ steps.release.outputs.sudocode_revision }}");
    expect(localBuild).toContain('SUDOCODE_REVISION="$(node -p');
    expect(localBuild).toContain('git -C "$SUDOCODE_DIR" fetch --quiet origin "$SUDOCODE_REVISION"');
    expect(localBuild).toContain('git -C "$SUDOCODE_DIR" archive --format=tar "$SUDOCODE_REVISION"');
    expect(localBuild).not.toContain('SUDOCODE_REF="origin/$SUDOCODE_BRANCH"');
    expect(localBuild).toContain('BUILD_PLATFORM" != "linux/amd64"');
    expect(localBuild).toContain('--build-arg "BUILDPLATFORM=$DOCKER_BUILD_PLATFORM"');
    expect(localBuild).toContain('--build-arg "TARGETPLATFORM=$BUILD_PLATFORM"');
    expect(packageServer).toContain('--build-arg "BUILDPLATFORM=$DOCKER_BUILD_PLATFORM"');
    expect(packageServer).toContain('--build-arg "TARGETPLATFORM=$PLATFORM"');
    const sourceDockerfile = readFileSync(
      resolve(root, "deploy/server.Dockerfile.local"),
      "utf8",
    );
    expect(sourceDockerfile).toContain("cargo build --release --target");
    expect(sourceDockerfile).not.toContain("cargo build --release --locked --target");
  });

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
    expect(runner).toContain("MOSS_MODEL_LIST_URL=");
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
