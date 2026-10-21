import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function fingerprint(paths) {
  const hash = createHash('sha256')
  function add(path) {
    if (statSync(path).isDirectory()) {
      for (const child of readdirSync(path).sort()) add(join(path, child))
    } else if (!/\.(?:node-test|test)\.[^.]+$/.test(path)) {
      hash.update(path.replaceAll('\\', '/') + '\0').update(readFileSync(path))
    }
  }
  for (const path of paths) add(path)
  return hash.digest('hex')
}
const versions = JSON.parse(readFileSync('src/server/nexus/runtime-versions.json', 'utf8'))
const components = {
  moss: { version: JSON.parse(readFileSync('package.json', 'utf8')).version, source_sha256: fingerprint(['src', 'scripts/build.js']) },
  nexus: { version: versions['nexusd-cluster'], vault_version: versions['nexus-vault'] },
  runtime: { version: versions.scode, artifact_sha256: versions['scode-linux-x64-bundle-sha256'] },
  webui: { version: JSON.parse(readFileSync('admin/package.json', 'utf8')).version, artifact_sha256: fingerprint(['admin/dist']) },
  assistant_skill: { source_sha256: fingerprint(['assistants', 'skills']) },
  database_migration: { source_sha256: fingerprint(['src/server/db.ts', 'src/server/auth', 'src/server/migration', 'src/server/park/schema.ts']) },
}
writeFileSync('/src/box-build.json', JSON.stringify({ components }, null, 2))
