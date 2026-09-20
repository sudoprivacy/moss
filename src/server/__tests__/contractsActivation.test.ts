import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { buildNexusArgs } from '../nexus/nexusManager.js'

const root = resolve(import.meta.dir, '../../..')
const candidateVersion = '0.2.1'
const baselineVersion = '0.2.0'
const contentSha = '273fd4097cbc33c1c049c39bb1fb60cef2663e2b'
const contentShortSha = contentSha.slice(0, 7)
const mergeSha = 'dc9cf01acf61dff586d292d15710332d35a5f811'
const previousCandidateContentSha = '30da0ddd953268ff8a9a0f0980276300ab153003'
const previousActivationSha = '60bd8dda6fb2d348ec8571b9b1a4eaa535e36dc5'
const retiredPinSha = '45304cf15d1e8d02814e46b7b2fe0b3c30c1709c'
const dependencySpec = `github:sudoprivacy/sudostack#${contentSha}`
const lockIntegrity = 'sha512-Z/cwfFmCElZxS0Dik5cH8ThmRAwireEYV1fNqzhSln+twc9RBVGBfZvCHSiUXQMKpAFIovsSm0F1ueF998foIg=='
const candidateManifestSha256 = '956a19cbc6b42ebc3c4e1c9ebe93e0842e1c295d1f6465e0d42d532d45785a9b'
const compatibilitySha256 = 'a27553991ab8bd57d66bc12aaca4b08f52cd8def13a1f971d698fa3f435b35ad'
const baselineSha256 = '9ec2cffbcb19f3e728a6691176ed739bab6de52a56b60abe4217420d2ce0c17c'
const tarballSha256 = '1c6b2794de3572bffb59e3dd3f0a504c68a23fd2531c7838773bf78d01469c5e'
const serverNodeVersion = '22.22.1'

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function readJsonWithSha256<T>(path: string): { value: T; sha256: string } {
  const bytes = readFileSync(path)
  return {
    value: JSON.parse(bytes.toString('utf8')) as T,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const contractEntry = realpathSync(fileURLToPath(import.meta.resolve('@sudo/contracts/zone-id')))
const contractRoot = resolve(dirname(contractEntry), '../..')
const installedPackage = readJson<{ name: string; version: string; engines: { node: string } }>(
  resolve(contractRoot, 'package.json'),
)
const nodeMinimumVersion = installedPackage.engines.node.match(/^>=(\d+\.\d+\.\d+)$/)?.[1]

type CandidateManifest = {
  compatibility: { prior_baseline_sha256: string; runtime_contract: string }
  lifecycle: {
    artifact_publication: string
    content_stage: string
    contract_baseline: string
    deployment_evidence: string
  }
  package: {
    actual_consumers: string[]
    actual_producers: string[]
    support_state: string
    version: string
  }
  sudostack: {
    activation_state: string
    candidate_revision: null
    content_stage: { exact_pin_target: string; state: string }
    predecessor: { activation_revision: string; candidate_content_revision: string }
  }
  support_evidence: { current_candidate: string }
}

type CompatibilityManifest = {
  baseline: { sha256: string }
  families: {
    resource_ref: { runtime_bytes: string }
    zone_id: { runtime_bytes: string }
  }
  package: { candidate: string; previous: string; semver_change: string }
  support_matrix: { actual_consumers: string[]; actual_producers: string[]; state: string }
}

type PackMetadata = {
  filename: string
  files: unknown[]
  shasum: string
  size: number
}

type ZoneVector = {
  id: string
  value: string
  expected: 'accept' | 'reject'
}

describe('@sudo/contracts evaluation pin', () => {
  it(`pins Candidate2 and verifies the installed unfrozen ${candidateVersion} package identity`, () => {
    const appPackage = readJson<{ dependencies: Record<string, string> }>(resolve(root, 'package.json'))
    const lockfile = readFileSync(resolve(root, 'bun.lock'), 'utf8')
    const candidateManifestPath = resolve(
      contractRoot,
      `manifests/releases/${candidateVersion}-candidate.gen.json`,
    )
    const compatibilityPath = resolve(contractRoot, 'compatibility/current.gen.json')
    const baselinePath = resolve(
      contractRoot,
      `compatibility/baselines/${baselineVersion}-package.json`,
    )
    const candidateArtifact = readJsonWithSha256<CandidateManifest>(candidateManifestPath)
    const compatibilityArtifact = readJsonWithSha256<CompatibilityManifest>(compatibilityPath)
    const candidate = candidateArtifact.value
    const compatibility = compatibilityArtifact.value
    const installedEntry = relative(root, contractEntry)

    expect(appPackage.dependencies['@sudo/contracts']).toBe(dependencySpec)
    expect(lockfile).toContain(dependencySpec)
    const contractLockEntries = lockfile.match(
      /"@sudo\/contracts": \["@sudo\/contracts@github:sudoprivacy\/sudostack#[0-9a-f]+"/g,
    ) ?? []
    expect(contractLockEntries).toEqual([
      `"@sudo/contracts": ["@sudo/contracts@github:sudoprivacy/sudostack#${contentShortSha}"`,
    ])
    expect(lockfile).toContain(`sudoprivacy-sudostack-${contentShortSha}`)
    expect(lockfile).toContain(lockIntegrity)
    expect(lockfile).not.toContain(previousActivationSha)
    expect(lockfile).not.toContain(previousActivationSha.slice(0, 7))
    expect(lockfile).not.toContain(retiredPinSha)
    expect(lockfile).not.toContain(retiredPinSha.slice(0, 7))
    expect(lockfile).not.toContain(mergeSha)
    expect(installedEntry.startsWith(`node_modules${sep}`)).toBe(true)
    expect(installedPackage).toEqual(expect.objectContaining({
      name: '@sudo/contracts',
      version: candidateVersion,
      engines: { node: '>=22.21.0' },
    }))

    expect(candidateArtifact.sha256).toBe(candidateManifestSha256)
    expect(compatibilityArtifact.sha256).toBe(compatibilitySha256)
    expect(sha256(baselinePath)).toBe(baselineSha256)
    expect(candidate.lifecycle).toEqual(expect.objectContaining({
      content_stage: 'staged',
      contract_baseline: 'unfrozen',
      artifact_publication: 'candidate_unpublished',
      deployment_evidence: 'not_deployed',
    }))
    expect(candidate.package).toEqual(expect.objectContaining({
      version: candidateVersion,
      support_state: 'pending_moss_repin',
      actual_consumers: [],
      actual_producers: [],
    }))
    expect(candidate.sudostack.candidate_revision).toBeNull()
    expect(candidate.sudostack.activation_state).toBe('pending_future_commit')
    expect(candidate.sudostack.content_stage).toEqual(expect.objectContaining({
      state: 'staged',
      exact_pin_target: 'content_commit_C',
    }))
    expect(candidate.sudostack.predecessor).toEqual(expect.objectContaining({
      activation_revision: previousActivationSha,
      candidate_content_revision: previousCandidateContentSha,
    }))
    expect(candidate.support_evidence.current_candidate).toBe('none_pending_moss_repin')
    expect(candidate.compatibility).toEqual(expect.objectContaining({
      prior_baseline_sha256: baselineSha256,
      runtime_contract: 'byte_identical',
    }))
    expect(compatibility).toEqual(expect.objectContaining({
      baseline: expect.objectContaining({ sha256: baselineSha256 }),
      package: { candidate: candidateVersion, previous: baselineVersion, semver_change: 'patch' },
      support_matrix: expect.objectContaining({
        state: 'pending_moss_repin',
        actual_consumers: [],
        actual_producers: [],
      }),
    }))
    const expectedRuntimeIdentity = `byte_identical_to_${baselineVersion}`
    expect(compatibility.families.resource_ref.runtime_bytes).toBe(expectedRuntimeIdentity)
    expect(compatibility.families.zone_id.runtime_bytes).toBe(expectedRuntimeIdentity)
    expect(sha256(contractEntry)).toBe(
      '87734eb51ac89a9ca9d50bbb4993ac6fba42af50c6d0c612cfe1b49fbb0a9b56',
    )

    const packDir = mkdtempSync(resolve(tmpdir(), 'moss-contracts-pack-'))
    try {
      const packed = spawnSync(
        'npm',
        ['pack', contractRoot, '--json', '--pack-destination', packDir],
        { encoding: 'utf8', timeout: 30_000 },
      )
      if (packed.status !== 0) {
        throw new Error(`npm pack failed: ${packed.error?.message || packed.stderr || packed.stdout}`)
      }
      const [metadata] = JSON.parse(packed.stdout) as PackMetadata[]
      expect(metadata).toEqual(expect.objectContaining({
        files: expect.any(Array),
        shasum: '5774dcb821d483bf8848ba0bda511ec728ae6cf9',
        size: 39_541,
      }))
      expect(metadata.files).toHaveLength(43)
      expect(sha256(resolve(packDir, metadata.filename))).toBe(tarballSha256)
    } finally {
      rmSync(packDir, { recursive: true, force: true })
    }
  })

  it('applies every installed owner vector at the pre-spawn argument boundary', () => {
    const vectors = readJson<{ cases: ZoneVector[] }>(
      resolve(contractRoot, 'contracts/zone-id/vectors.source.gen.json'),
    )
    const base = [8080, '/data', '/plugins'] as const

    for (const vector of vectors.cases) {
      if (vector.expected === 'accept') {
        expect(() => buildNexusArgs(...base, vector.value), vector.id).not.toThrow()
      } else {
        expect(() => buildNexusArgs(...base, vector.value), vector.id).toThrow(
          /refusing to start nexusd/,
        )
      }
    }
  })
})

describe('embedded Nexus ZoneId deployment surfaces', () => {
  it('exposes an opt-in value only on single-instance embedded deployments', () => {
    const compose = readFileSync(resolve(root, 'deploy/docker-compose.yml'), 'utf8')
    const installer = readFileSync(resolve(root, 'deploy/install.sh'), 'utf8')
    const deploymentDocs = readFileSync(resolve(root, 'deploy/README.md'), 'utf8')

    expect(compose).toContain('- MOSS_NEXUS_ZONE_ID')
    expect(compose).not.toMatch(/MOSS_NEXUS_ZONE_ID=/)
    expect(installer).toContain(
      'MOSS_NEXUS_ZONE_ID (optional, embedded Nexus only; immutable after first use)',
    )
    expect(installer).toContain('[ "${MOSS_NEXUS_ZONE_ID+x}" = x ]')
    expect(installer).toContain('MOSS_NEXUS_ZONE_ID_OVERRIDE_SET=1')
    expect(installer).toContain("MOSS_NEXUS_ZONE_ID_LINE=\"MOSS_NEXUS_ZONE_ID='$MOSS_NEXUS_ZONE_ID_VALUE'\"")
    expect(installer).toContain('/^[[:space:]]*MOSS_NEXUS_ZONE_ID=/ {')
    expect(installer).toContain('block = block ORS $0')
    expect(installer).toContain('cp -L -p "$ENV_PATH" "$ENV_BACKUP"')
    expect(installer).toContain('ENV_BACKUP="$WORK_DIR/moss-server.env.backup"')
    expect(installer.match(/restore_install_config/g)).toHaveLength(4)
    expect(installer.indexOf('characters unsafe for the systemd EnvironmentFile')).toBeLessThan(
      installer.indexOf('systemctl stop "$SERVICE_NAME.service"'),
    )
    expect(installer.lastIndexOf('assert_nexus_zone_id_upgrade_safe')).toBeLessThan(
      installer.indexOf('systemctl stop "$SERVICE_NAME.service"'),
    )

    const upgradeGuard = installer.match(/assert_nexus_zone_id_upgrade_safe\(\) \{[\s\S]*?\n\}/)?.[0]
    expect(upgradeGuard).toBeDefined()
    const guardDir = mkdtempSync(resolve(tmpdir(), 'moss-zone-upgrade-'))
    const envPath = resolve(guardDir, 'moss-server.env')
    const lockPath = resolve(guardDir, 'nexus', 'data.zone-id.lock.json')
    const runUpgradeGuard = (existingInstall: '0' | '1', explicitDeclaration: '0' | '1') =>
      spawnSync('bash', ['-c', [
        upgradeGuard,
        'die() { return 1; }',
        'assert_nexus_zone_id_upgrade_safe "$EXISTING_INSTALL" "$ENV_PATH" "$LOCK_PATH" "$EXPLICIT_DECLARATION"',
      ].join('\n')], {
        env: {
          ...process.env,
          EXISTING_INSTALL: existingInstall,
          EXPLICIT_DECLARATION: explicitDeclaration,
          ENV_PATH: envPath,
          LOCK_PATH: lockPath,
        },
      })
    try {
      expect(runUpgradeGuard('1', '1').status).not.toBe(0)
      writeFileSync(envPath, 'MOSS_NEXUS_ZONE_ID=existing-zone\n')
      expect(runUpgradeGuard('1', '0').status).not.toBe(0)
      mkdirSync(resolve(guardDir, 'nexus'))
      writeFileSync(lockPath, '{}')
      expect(runUpgradeGuard('1', '0').status).toBe(0)
      rmSync(lockPath)
      expect(runUpgradeGuard('0', '1').status).toBe(0)
    } finally {
      rmSync(guardDir, { recursive: true, force: true })
    }

    const assignmentExtractor = installer.match(
      /MOSS_NEXUS_ZONE_ID_LINE="\$\(awk '([\s\S]*?)' "\$ENV_PATH"\)"/,
    )?.[1]
    expect(assignmentExtractor).toBeDefined()
    for (const [source, preserved] of [
      ['MOSS_NEXUS_ZONE_ID="customer-a"\n', 'MOSS_NEXUS_ZONE_ID="customer-a"'],
      ['MOSS_NEXUS_ZONE_ID=old-zone\nMOSS_NEXUS_ZONE_ID=new-zone\n', 'MOSS_NEXUS_ZONE_ID=new-zone'],
      ['MOSS_NEXUS_ZONE_ID=customer-\\\na\nOTHER=value\n', 'MOSS_NEXUS_ZONE_ID=customer-\\\na'],
    ] as const) {
      const result = spawnSync('awk', [assignmentExtractor!], { input: source, encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(preserved)
    }

    expect(deploymentDocs).toContain('data.zone-id.lock.json')
    expect(deploymentDocs).toContain('整个 Nexus 目录作为一个单元')
    expect(deploymentDocs).toContain('不得只恢复')
    expect(deploymentDocs).toContain('moss-server.env')
    expect(deploymentDocs).toContain('MOSS_NEXUS_MODE=external')

    for (const externalManifest of [
      'deploy/docker-compose.ha.yml',
      'deploy/docker-compose.ha-crosshost.yml',
      'deploy/docker-compose.nexus-host.yml',
      'deploy/k8s/moss-server-statefulset.yaml',
      'deploy/k8s/moss-nexus.yaml',
    ]) {
      expect(readFileSync(resolve(root, externalManifest), 'utf8')).not.toContain('MOSS_NEXUS_ZONE_ID')
    }
  })
})

describe('contracts Node runtime floor', () => {
  it('pins the effective Moss server and release-test runtimes above the package minimum', () => {
    const serverDockerfile = readFileSync(resolve(root, 'deploy/server.Dockerfile'), 'utf8')
    const localDockerfile = readFileSync(resolve(root, 'deploy/server.Dockerfile.local'), 'utf8')
    const localBuild = readFileSync(resolve(root, 'deploy/build-server-local.sh'), 'utf8')
    const packageServer = readFileSync(resolve(root, 'deploy/package-server.sh'), 'utf8')
    const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/build-release.yml'), 'utf8')
    const serverRuntime = `FROM node:${serverNodeVersion}-trixie-slim AS server-runtime`
    const hostNodeRuntime = 'FROM ubuntu:22.04 AS host-node-runtime'

    expect(serverDockerfile.match(/^FROM .+$/gm)?.at(-1)).toBe(`FROM node:${serverNodeVersion}-slim`)
    expect(localDockerfile.indexOf(serverRuntime)).toBeGreaterThan(-1)
    expect(localDockerfile.indexOf('FROM server-runtime AS server-image')).toBeGreaterThan(
      localDockerfile.indexOf(serverRuntime),
    )
    expect(localDockerfile.indexOf(`ARG NODE_VERSION=${serverNodeVersion}`)).toBeGreaterThan(
      localDockerfile.indexOf(hostNodeRuntime),
    )
    expect(localDockerfile.indexOf('COPY --from=host-node-runtime /opt/node ./node')).toBeGreaterThan(
      localDockerfile.indexOf(`ARG NODE_VERSION=${serverNodeVersion}`),
    )
    expect(localDockerfile.indexOf('FROM scratch AS host-export')).toBeGreaterThan(
      localDockerfile.indexOf('COPY --from=host-node-runtime /opt/node ./node'),
    )
    expect(localBuild).toContain(`node:${serverNodeVersion}-trixie-slim`)
    expect(packageServer).toContain('--target host-export')
    expect(packageServer).toContain('deploy/server.Dockerfile.local')
    expect(releaseWorkflow.indexOf(`node-version: '${serverNodeVersion}'`)).toBeGreaterThan(-1)
    expect(releaseWorkflow.indexOf('- name: Install dependencies')).toBeGreaterThan(
      releaseWorkflow.indexOf(`node-version: '${serverNodeVersion}'`),
    )
    expect(nodeMinimumVersion).toBe('22.21.0')
  })

  it('makes the installer reject Node 22.20.x and accept the supported range', () => {
    const installer = readFileSync(resolve(root, 'deploy/install.sh'), 'utf8')
    const checker = installer.match(/SERVER_NODE_VERSION_CHECK='([\s\S]*?)'\nNODE_VERSION=/)?.[1]
    expect(checker).toBeDefined()

    for (const [version, supported] of [
      ['22.20.99', false],
      ['22.21.0', true],
      [serverNodeVersion, true],
      ['23.0.0', true],
    ] as const) {
      const result = spawnSync('node', ['--no-warnings', '-e', checker!, version, nodeMinimumVersion!])
      expect(result.status === 0, version).toBe(supported)
    }

    expect(installer).toContain(`SERVER_NODE_VERSION_MINIMUM=${nodeMinimumVersion}`)
    expect(installer).toContain('server package must contain Node >=$SERVER_NODE_VERSION_MINIMUM')
  })
})
