import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { AgentProtocolError } from './protocol.js'

export interface RouterNetworkPolicy {
  /** Optional deployment-owned exact IP pins; never supplied by an invocation. */
  allowedAddresses?: readonly string[]
}
type Address = { address: string; family: number }
type Resolver = (hostname: string) => Promise<Address[]>
export type RouterRequest = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

const nonPublic = new BlockList()
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(ip, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) nonPublic.addSubnet(ip, prefix, 'ipv6')
const forbiddenV4 = new BlockList(), forbiddenV6 = new BlockList()
for (const [ip, prefix] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) forbiddenV4.addSubnet(ip, prefix, 'ipv4')
// No mapped/translated addresses, metadata/link-local destinations or multicast,
// even with an operator pin. Native IPv4 and IPv6 loopback remain usable in labs.
for (const [ip, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2001::', 32], ['2002::', 16], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) forbiddenV6.addSubnet(ip, prefix, 'ipv6')

function address(value: string): string {
  if (typeof value !== 'string' || !isIP(value) || value.includes('%')) throw new AgentProtocolError(400, 'INVALID_ROUTER_NETWORK_POLICY')
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value
}
function publicAddress(ip: string): boolean {
  return isIP(ip) === 4 ? !nonPublic.check(ip, 'ipv4') : globalV6.check(ip, 'ipv6') && !nonPublic.check(ip, 'ipv6')
}
function forbiddenAddress(ip: string): boolean {
  return isIP(ip) === 4 ? forbiddenV4.check(ip, 'ipv4') : ip !== '::1' && forbiddenV6.check(ip, 'ipv6')
}

/** Native HTTP connection pinned to the checked DNS result; no proxy, redirect or connection reuse. */
export function routerTransport(endpoint: string, policy: RouterNetworkPolicy = {}, dependencies: {
  resolve?: Resolver
  /** Trust roots owned by the composition root, for isolated TLS tests/private PKI. */
  ca?: string
} = {}): RouterRequest {
  let target: URL
  try { target = new URL(`${endpoint}/chat/completions`) } catch { throw new AgentProtocolError(400, 'INVALID_ROUTER_ENDPOINT') }
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash
    || endpoint.endsWith('/') || (target.protocol === 'http:' && !isIP(hostname))) throw new AgentProtocolError(400, 'INVALID_ROUTER_ENDPOINT')
  if (policy.allowedAddresses !== undefined && (!Array.isArray(policy.allowedAddresses) || !policy.allowedAddresses.length || policy.allowedAddresses.length > 32)) throw new AgentProtocolError(400, 'INVALID_ROUTER_NETWORK_POLICY')
  const pins = policy.allowedAddresses ? new Set(policy.allowedAddresses.map(address)) : undefined
  if (pins && [...pins].some(forbiddenAddress)) throw new AgentProtocolError(400, 'INVALID_ROUTER_NETWORK_POLICY')
  const resolve = dependencies.resolve ?? (name => lookup(name, { all: true, verbatim: true }))
  return async (input, init) => {
    if (String(input) !== target.href || init?.method !== 'POST' || init.redirect !== 'error'
      || typeof init.body !== 'string' || Buffer.byteLength(init.body) > 2 * 1024 * 1024) throw new AgentProtocolError(403, 'MODEL_EGRESS_DENIED')
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(120_000)])
    let addresses: Address[]
    try {
      signal.throwIfAborted()
      // DNS itself is bounded and cancellable before any authenticated HTTP request.
      addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise<Address[]>((resolveResult, reject) => {
        const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        const aborted = () => reject(new Error('DNS unavailable'))
        dnsSignal.addEventListener('abort', aborted, { once: true })
        void resolve(hostname).then(resolveResult, reject).finally(() => dnsSignal.removeEventListener('abort', aborted))
      })
      signal.throwIfAborted()
    } catch { throw new AgentProtocolError(503, 'MODEL_EGRESS_UNAVAILABLE') }
    if (!addresses.length || addresses.length > 32) throw new AgentProtocolError(403, 'MODEL_EGRESS_DENIED')
    const checked = addresses.map(item => {
      let ip: string
      try { ip = address(item.address) } catch { throw new AgentProtocolError(403, 'MODEL_EGRESS_DENIED') }
      if (item.family !== isIP(ip) || forbiddenAddress(ip) || (pins ? !pins.has(ip) : !isIP(hostname) && !publicAddress(ip))) throw new AgentProtocolError(403, 'MODEL_EGRESS_DENIED')
      return { address: ip, family: isIP(ip) }
    })
    // Every answer must pass; do not select a public answer from a mixed public/private response.
    const selected = checked[0]
    const headers = new Headers(init.headers)
    if (headers.has('host') || headers.has('connection') || headers.has('content-length') || headers.has('transfer-encoding')) throw new AgentProtocolError(403, 'MODEL_EGRESS_DENIED')
    headers.set('accept-encoding', 'identity')
    const body = init.body
    return new Promise<Response>((resolveResponse, reject) => {
      const unconfirmed = () => new AgentProtocolError(502, 'MODEL_EXECUTION_UNCONFIRMED')
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: 'POST', agent: false, signal,
        headers: Object.fromEntries(headers),
        // The OS must never perform a second lookup after policy validation.
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, [selected])
          else callback(null, selected.address, selected.family)
        },
        ...(target.protocol === 'https:' ? { rejectUnauthorized: true, minVersion: 'TLSv1.2', checkServerIdentity, ...(dependencies.ca ? { ca: dependencies.ca } : {}) } : {}),
      }, response => {
        const status = response.statusCode ?? 502
        if (status >= 300 && status < 400) {
          // The original POST may already have run. Never follow or classify it as zero-dispatch.
          response.destroy(); reject(unconfirmed()); return
        }
        if (status < 200 || status >= 300) {
          response.destroy(); resolveResponse(new Response(null, { status })); return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 2 * 1024 * 1024) { response.destroy(); reject(new AgentProtocolError(502, 'MODEL_OUTPUT_INVALID')); return }
          chunks.push(chunk)
        })
        response.on('error', () => reject(unconfirmed()))
        response.on('end', () => {
          const contentType = response.headers['content-type'] ?? ''
          if (!/^application\/json(?:\s*;|$)/i.test(contentType) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            reject(new AgentProtocolError(502, 'MODEL_OUTPUT_INVALID')); return
          }
          resolveResponse(new Response(status === 204 || status === 205 ? null : Buffer.concat(chunks), { status, headers: { 'content-type': contentType } }))
        })
      })
      request.on('error', () => reject(unconfirmed()))
      request.on('upgrade', (_response, socket) => { socket.destroy(); reject(unconfirmed()) })
      request.setTimeout(30_000, () => request.destroy())
      request.end(body)
    })
  }
}
