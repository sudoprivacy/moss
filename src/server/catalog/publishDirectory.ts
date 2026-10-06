import { lstat, rename } from 'node:fs/promises'

/** Publish an immutable directory; false means another writer already won. */
export async function publishDirectory(staging: string, target: string): Promise<boolean> {
  const existing = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  })
  if (existing) {
    if (!existing.isDirectory()) throw new Error(`Publication target is not a directory: ${target}`)
    return false
  }
  try {
    await rename(staging, target)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Windows reports EPERM when rename meets an existing directory. Do not
    // swallow actual access failures, missing destinations, files or symlinks.
    const collision = code === 'EEXIST' || code === 'ENOTEMPTY'
      || (process.platform === 'win32' && code === 'EPERM')
    if (!collision || !(await lstat(target).catch(() => null))?.isDirectory()) throw error
    return false
  }
}
