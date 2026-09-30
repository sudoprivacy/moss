import { createServer } from 'node:http'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { FuiouMock, type MockPaymentOrder } from '../src/server/billing/testing/fuiouMock.js'

const directory = resolve(process.env.FUIOU_MOCK_DIR ?? `${homedir()}/.local/state/moss-fuiou-mock`)
const port = Number(process.env.FUIOU_MOCK_PORT ?? 3303)
const callbackUrl = process.env.FUIOU_MOCK_CALLBACK_URL ?? 'http://127.0.0.1:43127/api/v1/model-billing/callback'
const baseUrl = `http://127.0.0.1:${port}`
mkdirSync(directory, { recursive: true, mode: 0o700 })
const configFile = `${directory}/config.json`
if (!existsSync(configFile)) {
  const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const merchant = pair(); const provider = pair()
  writeFileSync(configFile, JSON.stringify({ merchantCode: 'LOCAL_ORG_PREVIEW', controlToken: randomBytes(32).toString('hex'), merchant, provider }), { mode: 0o600 })
}
const config = JSON.parse(readFileSync(configFile, 'utf8'))
writeFileSync(`${directory}/merchant-private.pem`, config.merchant.privateKey, { mode: 0o600 })
writeFileSync(`${directory}/provider-public.pem`, config.provider.publicKey, { mode: 0o600 })
writeFileSync(`${directory}/moss.env`, [
  'SUDOWORK_BILLING_ENABLED=true', 'FUIOU_TEST_MODE=true', `FUIOU_MERCHANT_CODE=${config.merchantCode}`,
  `FUIOU_MERCHANT_PRIVATE_KEY_FILE=${directory}/merchant-private.pem`, `FUIOU_PUBLIC_KEY_FILE=${directory}/provider-public.pem`,
  `FUIOU_TEST_API_URL=${baseUrl}`, `FUIOU_TEST_REFUND_URL=${baseUrl}`,
].join('\n') + '\n', { mode: 0o600 })
const stateFile = `${directory}/orders.json`
const mock = new FuiouMock({
  merchantCode: config.merchantCode, controlToken: config.controlToken, providerPrivateKey: config.provider.privateKey,
  merchantPublicKey: config.merchant.publicKey, baseUrl, callbackUrl,
  orders: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) as MockPaymentOrder[] : [],
  save: orders => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(orders), { mode: 0o600 }); renameSync(`${stateFile}.tmp`, stateFile) },
})
createServer(async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== `127.0.0.1:${port}`) { outgoing.writeHead(403).end(); return }
    const chunks: Buffer[] = []; let length = 0
    for await (const chunk of incoming) {
      length += chunk.length
      if (length > 1_048_576) { outgoing.writeHead(413).end(); return }
      chunks.push(Buffer.from(chunk))
    }
    const method = incoming.method ?? 'GET'; const headers = new Headers()
    for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value)
    const response = await mock.handle(new Request(`${baseUrl}${incoming.url}`, { method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }) }))
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch { outgoing.writeHead(500).end('Local mock request failed') }
}).listen(port, '127.0.0.1', () => console.info(`Local Fuiou simulator: ${baseUrl}; Moss env: ${directory}/moss.env`))
