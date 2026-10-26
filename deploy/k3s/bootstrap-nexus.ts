/** Provision Moss as an agent and session minter through the node-operator bootstrap. */
import { provisionMossIssuer } from '../nexus/mossIssuer.js'

const directory = process.argv[2]
if (!directory) throw new Error('Nexus data directory required')
await provisionMossIssuer(directory, '127.0.0.1:2126')
console.log('Moss agent identity and session-minter grant provisioned')
