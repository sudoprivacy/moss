import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const directory = dirname(fileURLToPath(import.meta.url))
const moss = resolve(directory, '../..')
const sudowork = resolve(moss, '../sudowork')
const configuration = resolve(directory, 'configuration')
const compose = ['compose', '-f', resolve(directory, 'compose.json')]
const [action, version = '1'] = process.argv.slice(2)
if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error('Invalid version')
function docker(args, cwd = moss) {
  const result = spawnSync('docker', args, { cwd, stdio: 'inherit', shell: false, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Docker command failed (${result.status ?? 'unavailable'})`)
}
function metadata(service) {
  const result = spawnSync('docker', ['run', '--rm', '--entrypoint', 'cat', `park-box-${service}:${version}`, '/app/box-build.json'], { encoding: 'utf8', shell: false, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Cannot read ${service} image build metadata`)
  return JSON.parse(result.stdout).components
}
function components() {
  const setup = JSON.parse(readFileSync(resolve(configuration, 'setup.json'), 'utf8'))
  const provider = setup.model.modelProviders.find(value => value.id === setup.model.defaultModelProviderId)
  if (!provider) throw new Error('The selected model provider is missing')
  const model = { provider: provider.id, protocol: provider.protocol, base_url: provider.baseUrl, model: setup.model.model }
  return { ...metadata('moss'), ...metadata('park'), model_configuration: {
    configuration_version: createHash('sha256').update(JSON.stringify(model)).digest('hex'),
  } }
}
function installedRelease() {
  const images = {}
  for (const service of ['moss', 'nexus', 'park']) {
    const result = spawnSync('docker', ['image', 'inspect', `park-box-${service}:${version}`], { encoding: 'utf8', shell: false, windowsHide: true })
    if (result.error || result.status !== 0) throw new Error(`Cannot inspect ${service} image`)
    const image = JSON.parse(result.stdout)[0]
    if (image.Architecture !== 'amd64' || image.Os !== 'linux') throw new Error('Linux amd64 images are required')
    images[service] = { id: image.Id, reference: `park-box-${service}:${version}` }
  }
  return { format: 1, agent_protocol: 1, architecture: 'amd64', version, components: components(), images }
}

switch (action) {
  case 'keys': {
    mkdirSync(configuration, { recursive: true })
    if (existsSync(resolve(configuration, 'upgrade-private.pem'))) throw new Error('Signing key already exists')
    const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    writeFileSync(resolve(configuration, 'upgrade-private.pem'), keys.privateKey, { mode: 0o600 })
    writeFileSync(resolve(configuration, 'upgrade-public.pem'), keys.publicKey, { mode: 0o600 })
    break
  }
  case 'build':
    docker(['build', '-t', 'park-box-operations:1', directory])
    docker(['build', '--target', 'park-box-nexus', '-f', 'deploy/server.Dockerfile.local', '-t', `park-box-nexus:${version}`, '.'])
    docker(['build', '--target', 'park-box-server', '-f', 'deploy/server.Dockerfile.local', '-t', `park-box-moss:${version}`, '.'])
    docker(['build', '-f', 'apps/park/deploy/Dockerfile', '-t', `park-box-park:${version}`, '.'], sudowork)
    break
  case 'install':
    if (!existsSync(resolve(configuration, 'setup.json'))) throw new Error('Create configuration/setup.json using setup.example.json first')
    for (const service of ['moss', 'nexus', 'park']) docker(['tag', `park-box-${service}:${version}`, `park-box-${service}:current`])
    docker([...compose, 'run', '--rm', 'initialize'])
    docker([...compose, 'up', '-d', 'nexus', 'moss', 'park', 'operations'])
    docker([...compose, 'run', '--rm', '--entrypoint', 'python', 'initialize', 'initialize.py'])
    docker([...compose, 'restart', 'moss'])
    docker([...compose, 'run', '--rm', '--entrypoint', 'python', 'initialize', 'initialize.py'])
    writeFileSync(resolve(configuration, 'installed-release.json'), JSON.stringify(installedRelease(), null, 2))
    docker([...compose, 'run', '--rm', '--entrypoint', 'python', 'initialize', 'finalize.py'])
    break
  case 'up':
    docker([...compose, 'up', '-d', 'nexus', 'moss', 'park', 'operations'])
    break
  case 'verify':
    writeFileSync(resolve(configuration, 'installed-release.json'), JSON.stringify(installedRelease(), null, 2))
    docker([...compose, 'run', '--rm', '--entrypoint', 'python', 'initialize', 'finalize.py'])
    break
  case 'status':
    docker([...compose, 'ps'])
    break
  case 'package':
    writeFileSync(resolve(configuration, 'components.json'), JSON.stringify(components(), null, 2))
    docker(['run', '--rm', '--entrypoint', 'python', '--mount', `type=bind,source=${configuration},target=/config,readonly`,
      '--mount', 'type=volume,source=park-box-operations-state,target=/state', '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      'park-box-operations:1', 'package.py', '--version', version])
    break
  default:
    process.stdout.write('Usage: node boxctl.mjs keys | build [version] | install [version] | verify [version] | up | status | package [version]\n')
    if (action) process.exitCode = 1
}
