import { readFileSync } from 'node:fs'
const credentials = JSON.parse(readFileSync('/box/config/credentials.json', 'utf8'))
for (const [key, value] of Object.entries(credentials)) if (key.startsWith('PARK_')) process.env[key] = value
await import('/app/server.mjs')
