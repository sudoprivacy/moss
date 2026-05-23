export type ServerLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  debug: (message: string) => void
}

export function createServerLogger(): ServerLogger {
  const write = (level: string, message: string) => {
    process.stderr.write(`[claude-server:${level}] ${message}\n`)
  }

  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => {
      if (process.env.DEBUG || process.env.CLAUDE_CODE_DEBUG) {
        write('debug', message)
      }
    },
  }
}
