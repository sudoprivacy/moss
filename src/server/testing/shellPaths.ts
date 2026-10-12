/** Convert native Windows paths for Bash without changing POSIX filenames. */
export function toShellPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/** Convert only the explicitly identified path variables, leaving other values intact. */
export function shellPathEnvironment(paths: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(paths).map(([name, path]) =>
    [name, toShellPath(path)]))
}
