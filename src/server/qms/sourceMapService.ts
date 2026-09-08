import { basename } from 'node:path'
import { SourceMapConsumer } from 'source-map-js'

export interface QmsSourceMapRepository {
  find(tenantId: string, version: string, platform: string, fileName: string): Promise<string | null>
}

export class SourceMapService {
  constructor(private readonly repository: QmsSourceMapRepository) {}

  async symbolicate(input: {
    tenantId: string
    version: string
    platform: string
    stack: string
  }): Promise<string> {
    const lines = input.stack.split('\n')
    const output: string[] = []
    for (const line of lines) {
      const match = line.match(/(\(?)([^\s()]+):(\d+):(\d+)(\)?)$/)
      if (!match) {
        output.push(line)
        continue
      }
      const [, open = '', generatedFile = '', lineText = '', columnText = '', close = ''] = match
      const generatedName = basename(generatedFile)
      const map = await this.repository.find(input.tenantId, input.version, input.platform, generatedName)
        ?? await this.repository.find(input.tenantId, input.version, input.platform, `${generatedName}.map`)
      if (!map) {
        output.push(line)
        continue
      }
      try {
        const consumer = new SourceMapConsumer(JSON.parse(map))
        const original = consumer.originalPositionFor({ line: Number(lineText), column: Number(columnText) })
        if (!original.source || original.line == null || original.column == null) {
          output.push(line)
          continue
        }
        const replacement = `${open}${original.source}:${original.line}:${original.column}${close}`
        output.push(`${line.slice(0, match.index)}${replacement}`)
      } catch {
        output.push(line)
      }
    }
    return output.join('\n')
  }
}
