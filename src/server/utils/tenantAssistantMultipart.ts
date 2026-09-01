import type http from 'http'

export type TenantAssistantMultipartFile = {
  filename: string
  contentType: string
  data: Buffer
}

export type TenantAssistantMultipartForm = {
  fields: Record<string, string>
  avatar: TenantAssistantMultipartFile | null
}

const MAX_BODY_BYTES = 2 * 1024 * 1024 + 128 * 1024

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('请求体不能超过 2 MiB'))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseDisposition(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of value.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const key = part.slice(0, separator).trim().toLowerCase()
    result[key] = part.slice(separator + 1).trim().replace(/^"|"$/g, '')
  }
  return result
}

export async function readTenantAssistantMultipart(req: http.IncomingMessage): Promise<TenantAssistantMultipartForm> {
  const contentType = req.headers['content-type'] || ''
  const boundaryMatch = contentType.match(/multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;\s]+))/i)
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]
  if (!boundary) throw new Error('请求必须为 multipart/form-data')

  const body = await readBody(req)
  const delimiter = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  let avatar: TenantAssistantMultipartFile | null = null
  let offset = 0

  while (offset < body.length) {
    const start = body.indexOf(delimiter, offset)
    if (start < 0) break
    const next = body.indexOf(delimiter, start + delimiter.length)
    if (next < 0) break
    let part = body.subarray(start + delimiter.length, next)
    if (part.subarray(0, 2).equals(Buffer.from('\r\n'))) part = part.subarray(2)
    if (part.subarray(part.length - 2).equals(Buffer.from('\r\n'))) part = part.subarray(0, -2)
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd < 0) {
      offset = next
      continue
    }
    const headers = new Map<string, string>()
    for (const line of part.subarray(0, headerEnd).toString('utf8').split('\r\n')) {
      const separator = line.indexOf(':')
      if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
    }
    const disposition = headers.get('content-disposition')
    if (!disposition) {
      offset = next
      continue
    }
    const params = parseDisposition(disposition)
    const fieldName = params.name
    if (!fieldName) throw new Error('multipart 字段缺少名称')
    const data = part.subarray(headerEnd + 4)
    if (params.filename !== undefined) {
      if (fieldName !== 'avatar' || avatar) throw new Error('仅允许一个 avatar 文件字段')
      avatar = {
        filename: params.filename,
        contentType: headers.get('content-type') || 'application/octet-stream',
        data,
      }
    } else {
      if (fields[fieldName] !== undefined) throw new Error(`重复的 multipart 字段: ${fieldName}`)
      fields[fieldName] = data.toString('utf8')
    }
    offset = next
  }

  return { fields, avatar }
}
