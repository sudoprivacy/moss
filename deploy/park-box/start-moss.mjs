import { readFileSync, existsSync } from 'node:fs'
const credentials = JSON.parse(readFileSync('/box/config/credentials.json', 'utf8'))
for (const [key, value] of Object.entries(credentials)) if (key.startsWith('PARK_')) process.env[key] = value
if (existsSync('/box/config/organization.json')) {
  const park = JSON.parse(readFileSync('/box/config/organization.json', 'utf8'))
  process.env.PARK_ORG_ID = park.org_id
  process.env.PARK_PUBLIC_URL = park.public_url
}
process.argv = ['node', '/app/bin/moss-server.mjs', 'start']
await import('/app/bin/moss-server.mjs')
