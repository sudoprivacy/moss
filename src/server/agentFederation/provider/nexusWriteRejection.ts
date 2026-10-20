import { createHash } from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020.js'
import schema from '../../../../contracts/nexus-prewrite/v1/schema.json' with { type: 'json' }
import { AgentProtocolError } from './protocol.js'

export interface NexusWriteReceipt {
  code: -32003
  message: 'write rejected before mutation'
  data: {
    schema_version: 1; kind: 'PreWriteRejection'; operation: 'write'; stage: 'pre_write'
    hook: string; reason_code: string; path: string; request_digest: string
  }
}
const validate = new Ajv2020({ strict: true }).compile<NexusWriteReceipt>(schema)
const codes = new Map([
  ['CONTENT_DENIED', 'MODEL_CONTENT_DENIED'],
  ['CLASSIFIER_UNAVAILABLE', 'MODEL_CLASSIFIER_UNAVAILABLE'],
  ['REDACTION_UNSAFE', 'MODEL_REDACTION_UNSAFE'],
])
export const modelWriteRejectionCodes = new Set(codes.values())

/** A trusted Write RPC receipt, never inferred from an error's free text. */
export class NexusWriteRejected extends AgentProtocolError {
  private constructor(code: string, readonly receipt: NexusWriteReceipt) { super(403, code) }

  static fromWriteError(error: unknown, path: string, body: Buffer): NexusWriteRejected | undefined {
    if (!(error instanceof Error) || error.message.length > 16384) return
    let payload: unknown
    try { payload = JSON.parse(error.message) } catch { return }
    if (!validate(payload) || payload.data.hook !== 'egress_content_gate' || payload.data.path !== path
      || payload.data.request_digest !== `sha256:${createHash('sha256').update(body).digest('hex')}`) return
    const code = codes.get(payload.data.reason_code)
    if (code) return new NexusWriteRejected(code, payload)
  }
}
