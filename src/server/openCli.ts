import { parseConnectUrl } from './parseConnectUrl.js'
import { runConnectHeadless } from './connectHeadless.js'
import { createDirectConnectSession } from './createDirectConnectSession.js'
import type { SessionRuntimeOptions } from './sessionManager.js'

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: direct-connect-open <cc-url> [options]',
      '',
      'Options:',
      '  -p, --print <prompt>    Prompt to send immediately',
      '  --output-format <fmt>   text | stream-json (default: text)',
      '  --api-key <key>         API key used to get an access token',
      '  --user-email <email>    User email used to get an access token',
      '  --user-password <pwd>   User password used to get an access token',
      '  --runtime <type>        Session runtime override: host | docker',
      '  --docker-image <image>  Docker image when --runtime=docker',
      '  --docker-mode <mode>    Docker mode: session | user',
      '  -h, --help              Show this help',
      '',
    ].join('\n'),
  )
}

function parseArgs(argv: string[]): {
  ccUrl: string
  prompt: string
  outputFormat: string
  apiKey?: string
  userEmail?: string
  userPassword?: string
  runtime?: SessionRuntimeOptions
} {
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp()
    process.exit(0)
  }

  let ccUrl = ''
  let prompt = ''
  let outputFormat = 'text'
  let apiKey: string | undefined
  let userEmail: string | undefined
  let userPassword: string | undefined
  let runtime: SessionRuntimeOptions | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!ccUrl && !arg.startsWith('-')) {
      ccUrl = arg
      continue
    }
    if (arg === '-p' || arg === '--print') {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        prompt = next
        i += 1
      }
      continue
    }
    if (arg === '--output-format') {
      outputFormat = argv[i + 1] || outputFormat
      i += 1
      continue
    }
    if (arg === '--api-key') {
      apiKey = argv[i + 1] || undefined
      i += 1
      continue
    }
    if (arg === '--user-email') {
      userEmail = argv[i + 1] || undefined
      i += 1
      continue
    }
    if (arg === '--user-password') {
      userPassword = argv[i + 1] || undefined
      i += 1
      continue
    }
    if (arg === '--runtime') {
      runtime = {
        ...(runtime ?? {}),
        type:
          argv[i + 1] === 'docker'
            ? 'docker'
            : argv[i + 1] === 'host'
              ? 'host'
              : undefined,
      }
      i += 1
      continue
    }
    if (arg === '--docker-image') {
      runtime = {
        ...(runtime ?? {}),
        dockerImage: argv[i + 1] || undefined,
      }
      i += 1
      continue
    }
    if (arg === '--docker-mode') {
      runtime = {
        ...(runtime ?? {}),
        dockerMode:
          argv[i + 1] === 'user'
            ? 'user'
            : argv[i + 1] === 'session'
              ? 'session'
              : undefined,
      }
      i += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!ccUrl) {
    throw new Error('Missing cc:// URL')
  }
  if (!['text', 'stream-json'].includes(outputFormat)) {
    throw new Error(`Unsupported --output-format: ${outputFormat}`)
  }

  return {
    ccUrl,
    prompt,
    outputFormat,
    apiKey,
    userEmail,
    userPassword,
    runtime,
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const { serverUrl } = parseConnectUrl(options.ccUrl)
  const session = await createDirectConnectSession({
    serverUrl,
    apiKey: options.apiKey,
    email: options.userEmail,
    password: options.userPassword,
    cwd: process.cwd(),
    runtime: options.runtime,
  })

  await runConnectHeadless(
    session.config,
    options.prompt,
    options.outputFormat,
    true,
  )
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
