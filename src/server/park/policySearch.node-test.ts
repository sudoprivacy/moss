import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { searchParkPolicySources } from './policySearch.js'

void test('MCP transports the query field and rejects invalid arguments before HTTP', async () => {
  const queries: string[] = []
  const server = http.createServer((req, res) => {
    queries.push(new URL(req.url!, 'http://localhost').searchParams.get('q')!)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ matches: [{ file: '人才政策.md', line_no: 1, line: '原文' }] }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number }
  const child = spawn(process.execPath, [resolve('skills/park-consultation-tools/scripts/park-tools-mcp.mjs')], {
    env: { ...process.env, SESSION_TOKEN: 'fixture', MOSS_SERVER_URL: `http://127.0.0.1:${address.port}` },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  try {
    const responses = new Map<number, { result: { isError?: boolean; content: Array<{ text: string }> } }>()
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const response = JSON.parse(line)
        responses.set(response.id, response)
      }
    })
    const call = async (id: number, args: unknown) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'policy_search', arguments: args } }) + '\n')
      const deadline = Date.now() + 10_000
      while (!responses.has(id) && Date.now() < deadline) await new Promise(done => setTimeout(done, 10))
      assert.ok(responses.has(id), 'MCP response received')
      return responses.get(id)!.result
    }
    assert.match((await call(1, { q: ' 人才引进政策 ' })).content[0]!.text, /原文/)
    for (const [index, args] of [{}, { q: '' }, { q: 12 }, { q: {} }].entries()) assert.equal((await call(index + 2, args)).isError, true)
    assert.deepEqual(queries, ['人才引进政策'])
  } finally {
    child.kill()
    await new Promise<void>(done => server.close(() => done()))
  }
})

void test('policy queries use complete verified source clauses, isolate duplicate names and reject corrupt snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'park-policy-search-'))
  try {
    await mkdir(join(root, '_sources'))
    const text = '# 人才引进与服务\n\n## 安居支持\n| 学历 | 金额 |\n| 本科 | 6000元 |\n| 硕士 | 12000元 |\n| 博士 | 24000元 |\n\n满6个月和12个月分两笔申请，90日内申请。\n\n## 人才公寓住房支持\n租金减免最长12个月。'
    const other = '# 人才引进\n另一个文件的特殊资格条件。'
    const sources = [text, other].map((markdown, index) => ({ id: `doc-${index}`, fileName: '人才引进与服务.md',
      nodeName: '政策', sizeBytes: Buffer.byteLength(markdown), markdownPath: `_sources/doc-${index}.md`,
      markdownSha256: createHash('sha256').update(markdown).digest('hex') }))
    for (const [index, markdown] of [text, other].entries()) await writeFile(join(root, sources[index]!.markdownPath), markdown)
    await writeFile(join(root, 'chunk-summary.md'), '# 摘要\n没有金额。')
    await writeFile(join(root, '_moss_meta.json'), JSON.stringify({ wikiId: 'wiki', builtAt: 1, sourceDocuments: sources }))
    for (const query of ['人才引进政策', '有哪些人才优惠', '人才公寓租金减免']) {
      const hits = await searchParkPolicySources(root, 'wiki', query)
      assert.ok(hits.length > 0, query)
      assert.match(hits.map(hit => hit.line).join('\n'), /6000元.*\n.*12000元.*\n.*24000元/)
      assert.match(hits.map(hit => hit.line).join('\n'), /满6个月和12个月.*90日/)
      const amount = hits.find(hit => hit.line.includes('6000元'))!
      const lines = text.split('\n')
      assert.equal(lines.slice(amount.line_no - 1, amount.end_line).join('\n').trim(), amount.line)
    }
    const hits = await searchParkPolicySources(root, 'wiki', '人才引进')
    assert.deepEqual(new Set(hits.map(hit => hit.document_id)), new Set(['doc-0', 'doc-1']))
    assert.deepEqual(await searchParkPolicySources(root, 'wiki', '航天发动机奖励'), [])
    await assert.rejects(searchParkPolicySources(root, 'other-wiki', '人才'), /Invalid source metadata/)
    await writeFile(join(root, sources[0]!.markdownPath), '被修改的正文')
    await assert.rejects(searchParkPolicySources(root, 'wiki', '人才'), /正文校验失败/)
    const meta = JSON.parse(await readFile(join(root, '_moss_meta.json'), 'utf8'))
    delete meta.sourceDocuments[0].markdownPath
    await writeFile(join(root, '_moss_meta.json'), JSON.stringify(meta))
    await assert.rejects(searchParkPolicySources(root, 'wiki', '人才'), /原文映射缺失/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('topic titles outrank exact mentions in other policies and retain all conditions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'park-policy-ranking-'))
  try {
    await mkdir(join(root, '_sources'))
    const policies = [
      { id: 'talent', fileName: '人才引进与服务政策.md', markdown: '# 人才引进与服务政策\n## 金额\n本科6000元。\n## 期限\n满6个完整自然月后90日内申请。\n## 有效期\n已纳入人员可完成后续申请，不统一截断。' },
      { id: 'faq', fileName: '常见问题.md', markdown: '# 常见问题\n## 人才引进政策\n请参考人才文件。' },
      { id: 'training', fileName: '人才培养办法.md', markdown: '# 人才培养\n与人才引进政策不同。' },
    ]
    const sourceDocuments = []
    for (const item of policies) {
      const markdownPath = `_sources/${item.id}.md`
      await writeFile(join(root, markdownPath), item.markdown)
      sourceDocuments.push({ id: item.id, fileName: item.fileName, markdownPath,
        markdownSha256: createHash('sha256').update(item.markdown).digest('hex') })
    }
    await writeFile(join(root, '_moss_meta.json'), JSON.stringify({ wikiId: 'wiki', builtAt: 1, sourceDocuments }))
    const hits = await searchParkPolicySources(root, 'wiki', '人才引进政策')
    assert.deepEqual(new Set(hits.map(hit => hit.document_id)), new Set(['talent']))
    assert.match(hits.map(hit => hit.line).join('\n'), /6000元[\s\S]*完整自然月[\s\S]*不统一截断/)
    const overview = await searchParkPolicySources(root, 'wiki', '有哪些政策')
    assert.deepEqual(new Set(overview.map(hit => hit.document_id)), new Set(['talent', 'faq', 'training']))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('a publish during search never returns mixed source generations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'park-policy-publish-'))
  try {
    await mkdir(join(root, '_sources'))
    const publish = async (generation: number) => {
      const sourceDocuments = []
      for (let index = 0; index < 40; index++) {
        const markdown = `# 人才政策 ${index}\n版本${generation}，完整资格条件${index}。`
        const markdownPath = `_sources/doc-${index}.md`
        await writeFile(join(root, markdownPath), markdown)
        sourceDocuments.push({ id: `doc-${index}`, fileName: `人才政策${index}.md`, markdownPath,
          markdownSha256: createHash('sha256').update(markdown).digest('hex') })
      }
      await writeFile(join(root, '_moss_meta.json'), JSON.stringify({ wikiId: 'wiki', builtAt: generation, sourceDocuments }))
    }
    await publish(1)
    // A collision may return 503; it must never return a partial mixed build.
    const search = searchParkPolicySources(root, 'wiki', '人才政策').then(hits => hits, error => {
      assert.equal(error.statusCode, 503)
      return null
    })
    await publish(2)
    const result = await search
    if (result) {
      const generations = new Set(result.map(hit => /版本(\d)/.exec(hit.line)?.[1]).filter(Boolean))
      assert.equal(generations.size, 1)
      assert.equal(new Set(result.map(hit => hit.version)).size, 1)
    }
    const current = await searchParkPolicySources(root, 'wiki', '人才政策')
    assert.ok(current.every(hit => !hit.line.includes('版本1')))
    assert.ok(current.some(hit => hit.line.includes('版本2')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
