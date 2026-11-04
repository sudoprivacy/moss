/**
 * Searchable session files: what an employee gave a session (inputs) and what
 * it produced (outputs), with their content extracted — spreadsheets row by
 * row with column names, documents, slides, PDFs — and a JSON copy of the
 * data in the agent home.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import JSZip from 'jszip'
import iconv from 'iconv-lite'
import { classifyFile, displayName } from '../artifacts.js'
import { extractFile, type ExtractData, type SheetData } from '../fileExtract.js'
import { A2AError } from '../a2aService.js'
import type { Viewer } from '../access.js'
import { DIGEST_VERSION } from '../digestService.js'
import { createFixture, ORG, PAIR_AGENTS, configurePair, type Fixture } from './agentifyFixture.js'

const SHOUHOU = 'agent-shouhou-uuid'

// ------------------------------------------------------------ test files

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A workbook shaped like ruigu's: a title merged across the top, the header
 * in row 2, dates stored as serial numbers with a date style, shared and
 * inline strings, a formula with its cached result, a boolean, an error, and
 * a second (hidden) sheet.
 */
async function sampleXlsx(): Promise<Buffer> {
  const zip = new JSZip()
  const shared = ['总仓发车时效记录表-2026年十月', '日期', '出发地', '目的地', '运费含税', '是否准时', '发车班次号', '上虞', '温州', '南京', 'FCBC26100300000002', 'FCBC26100400000007']
  const s = (v: string) => shared.indexOf(v)
  const cell = (ref: string, v: string | number | boolean, opts: { style?: number; formula?: string } = {}) => {
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
    if (typeof v === 'number') return `<c r="${ref}"${opts.style ? ` s="${opts.style}"` : ''}>${opts.formula ? `<f>${opts.formula}</f>` : ''}<v>${v}</v></c>`
    return s(v) >= 0 ? `<c r="${ref}" t="s"><v>${s(v)}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
  }
  const rows = [
    `<row r="1">${cell('A1', '总仓发车时效记录表-2026年十月')}</row>`,
    `<row r="2">${['日期', '出发地', '目的地', '运费含税', '是否准时', '发车班次号'].map((h, i) => cell(`${'ABCDEF'[i]}2`, h)).join('')}</row>`,
    // 46298 = 2026-10-03 (1900 date system)
    `<row r="3">${cell('A3', 46298, { style: 1 })}${cell('B3', '上虞')}${cell('C3', '温州')}${cell('D3', 694.2)}${cell('E3', true)}${cell('F3', 'FCBC26100300000002')}</row>`,
    `<row r="4">${cell('A4', 46299, { style: 1 })}${cell('B4', '上虞')}${cell('C4', '南京')}${cell('D4', 1305.8, { formula: 'D3*2-82.6' })}${cell('E4', false)}${cell('F4', 'FCBC26100400000007')}</row>`,
    `<row r="5">${cell('A5', 46300, { style: 2 })}${cell('B5', '上虞')}${cell('C5', '绍兴（临时）')}<c r="D5" t="e"><v>#N/A</v></c></row>`,
  ].join('')
  // A complete package (LibreOffice refuses partial ones).
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="${ct}.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${ct}.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns}><sheets><sheet name="明细表" sheetId="1" r:id="rId1"/><sheet name="备注" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="${rel}/styles" Target="styles.xml"/></Relationships>`)
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst ${ns}>${shared.map(v => `<si><t>${esc(v)}</t></si>`).join('')}</sst>`)
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${ns}><numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="176" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData>${rows}</sheetData><mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells></worksheet>`)
  zip.file('xl/worksheets/sheet2.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData><row r="1">${cell('A1', '说明')}${cell('B1', '值')}</row><row r="2">${cell('A2', '负责人')}${cell('B2', '沈洪文')}</row></sheetData></worksheet>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function sampleDocx(): Promise<Buffer> {
  const zip = new JSZip()
  const p = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${esc(text)}</w:t></w:r></w:p>`
  const tc = (text: string) => `<w:tc><w:p><w:r><w:t>${esc(text)}</w:t></w:r></w:p></w:tc>`
  const table = `<w:tbl>${[['线路', '准点率', '备注'], ['上虞-温州', '96%', '雨天延误 1 次'], ['上虞-南京', '88%', '车辆故障']].map(r => `<w:tr>${r.map(tc).join('')}</w:tr>`).join('')}</w:tbl>`
  zip.file('word/styles.xml', '<w:styles><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/></w:style></w:styles>')
  zip.file('word/document.xml', `<w:document><w:body>${p('十月干线时效分析', '1')}${p('本月共发车 280 次，整体准点率 93%。')}${p('分线路', '2')}${table}${p('结论：上虞-南京线需要更换车辆。')}</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function samplePptx(): Promise<Buffer> {
  const zip = new JSZip()
  const slide = (texts: string[]) => `<p:sld><p:cSld><p:spTree>${texts.map(t => `<p:sp><p:txBody><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`
  zip.file('ppt/slides/slide1.xml', slide(['十月运营复盘', '干线准点率 93%']))
  zip.file('ppt/slides/slide2.xml', slide(['下月计划', '上虞-南京线换车']))
  zip.file('ppt/slides/slide10.xml', slide(['附录']))
  zip.file('ppt/notesSlides/notesSlide2.xml', '<p:notes><a:p><a:r><a:t>演讲备注：预算 3 万</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** A minimal two-page PDF with ASCII text (offsets computed so pdftotext accepts it). */
function samplePdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    null, // page 1 content
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    null, // page 2 content
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = (text: string) => {
    const body = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
    return `<< /Length ${body.length} >>\nstream\n${body}\nendstream`
  }
  objs[3] = stream('Invoice INV-2026-1031 total 18300')
  objs[5] = stream('Carrier Shangyu Logistics')
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function hasBinary(cmd: string): boolean {
  try {
    execFileSync(cmd, ['-v'], { stdio: 'ignore' })
    return true
  } catch (err) {
    return (err as { code?: string }).code !== 'ENOENT'
  }
}

// ------------------------------------------------------------- extraction

describe('file extraction', () => {
  it('reads a workbook: header below a merged title, typed values, profile, one line per row', async () => {
    const r = (await extractFile(await sampleXlsx(), '2026十月份.xlsx'))!
    assert.ok(r, 'extracted')
    const data = r.data as Extract<ExtractData, { format: 'sheet' }>
    const sheet = data.sheets[0] as SheetData
    assert.equal(sheet.name, '明细表')
    assert.equal(sheet.headerRow, 2, 'the merged title row is not mistaken for the header')
    assert.deepEqual(sheet.caption, ['总仓发车时效记录表-2026年十月'])
    assert.equal(sheet.rowCount, 3)
    assert.deepEqual(sheet.rows[0], { 日期: '2026-10-03', 出发地: '上虞', 目的地: '温州', 运费含税: 694.2, 是否准时: true, 发车班次号: 'FCBC26100300000002' })
    assert.equal(sheet.rows[1]!.运费含税, 1305.8, 'formula cells keep their computed value')
    assert.equal(sheet.rows[2]!.日期, '2026-10-05', 'custom 年月日 formats are dates too')
    assert.equal(sheet.rows[2]!.运费含税, '#N/A')
    assert.deepEqual(sheet.rowNumbers, [3, 4, 5])
    const fee = sheet.columns.find(c => c.name === '运费含税')!
    assert.equal(fee.type, 'number')
    assert.equal(fee.sum, 2000)
    const date = sheet.columns.find(c => c.name === '日期')!
    assert.deepEqual([date.type, date.min, date.max], ['date', '2026-10-03', '2026-10-05'])
    assert.equal(data.sheets[1]!.hidden, true)
    assert.deepEqual(data.sheets[1]!.rows, [{ 说明: '负责人', 值: '沈洪文' }])

    // Index text: a profile chunk (embedded) and row chunks (keyword only) that repeat column names.
    const profile = r.chunks[0]!
    assert.equal(profile.embed, true)
    assert.match(profile.text, /「2026十月份.xlsx」工作表「明细表」：3 行数据 × 6 列（表头在第 2 行）/)
    assert.match(profile.text, /运费含税（数值，694.2~1,305.8，合计 2,000）/)
    assert.match(profile.text, /日期（日期，2026-10-03~2026-10-05）/)
    const rows = r.chunks.find(c => c.text.includes('第4行'))!
    assert.equal(rows.embed, false)
    assert.match(rows.text, /^「2026十月份.xlsx」工作表「明细表」\n/)
    assert.match(rows.text, /第4行：日期=2026-10-04｜出发地=上虞｜目的地=南京｜运费含税=1305.8｜是否准时=false｜发车班次号=FCBC26100400000007/)
    assert.match(r.outline, /2 个工作表：「明细表」3 行×6 列（日期、出发地、目的地、运费含税、是否准时、发车班次号）/)
  })

  it('reads GB18030 and UTF-8 CSV, keeping leading zeros as text', async () => {
    const csv = '工号,姓名,封车号,金额\n007,张三,014222,950\n008,李四,014254,1200.5\n'
    for (const buf of [iconv.encode(csv, 'gb18030'), Buffer.from(`﻿${csv}`, 'utf8')]) {
      const r = (await extractFile(buf, '司机名单.csv'))!
      const sheet = (r.data as Extract<ExtractData, { format: 'sheet' }>).sheets[0]!
      assert.deepEqual(sheet.rows[0], { 工号: '007', 姓名: '张三', 封车号: '014222', 金额: 950 })
      assert.equal(sheet.columns.find(c => c.name === '金额')!.sum, 2150.5)
    }
  })

  it('reads a Word document with headings and its table as rows', async () => {
    const r = (await extractFile(await sampleDocx(), '十月分析.docx'))!
    const blocks = (r.data as Extract<ExtractData, { format: 'document' }>).blocks
    assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: '十月干线时效分析' })
    assert.deepEqual(blocks.find(b => b.type === 'table')!.rows![1], ['上虞-温州', '96%', '雨天延误 1 次'])
    const all = r.chunks.map(c => c.text).join('\n')
    assert.match(all, /「十月分析.docx」「分线路」表格\n第1行：线路=上虞-温州｜准点率=96%｜备注=雨天延误 1 次/)
    assert.match(all, /结论：上虞-南京线需要更换车辆/)
    assert.match(r.outline, /1 个表格.*章节 十月干线时效分析、分线路/)
  })

  it('reads slides in order with their notes', async () => {
    const r = (await extractFile(await samplePptx(), '复盘.pptx'))!
    const slides = (r.data as Extract<ExtractData, { format: 'slides' }>).slides
    assert.deepEqual(slides.map(s => s.index), [1, 2, 10])
    assert.equal(slides[1]!.notes, '演讲备注：预算 3 万')
    assert.match(r.chunks.map(c => c.text).join('\n'), /「复盘.pptx」第2页\n下月计划\n上虞-南京线换车\n备注：演讲备注：预算 3 万/)
  })

  it('reads a PDF page by page', { skip: !hasBinary('pdftotext') && 'pdftotext not installed' }, async () => {
    const r = (await extractFile(samplePdf(), 'invoice.pdf'))!
    const pages = (r.data as Extract<ExtractData, { format: 'pdf' }>).pages
    assert.match(pages[0]!.text, /INV-2026-1031 total 18300/)
    assert.match(pages[1]!.text, /Shangyu Logistics/)
    assert.match(r.chunks[1]!.text, /^「invoice.pdf」第2页/)
  })

  it('converts legacy .xls with LibreOffice', async t => {
    // Make a real .xls from the sample workbook.
    const xls = await (async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'xls-'))
      try {
        writeFileSync(path.join(dir, 'in.xlsx'), await sampleXlsx())
        const bin = process.env.LIBREOFFICE_BIN ?? (existsSync('/Applications/LibreOffice.app/Contents/MacOS/soffice') ? '/Applications/LibreOffice.app/Contents/MacOS/soffice' : 'soffice')
        execFileSync(bin, [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', 'xls', '--outdir', dir, path.join(dir, 'in.xlsx')], { stdio: 'ignore', timeout: 120_000 })
        return readFileSync(path.join(dir, 'in.xls'))
      } catch {
        return null
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })()
    if (!xls) return t.skip('LibreOffice not installed')
    const r = (await extractFile(xls, '2026十月份_nexus_1791447625115.xls'))!
    assert.match(r.via, /^libreoffice\+xlsx/)
    const sheet = (r.data as Extract<ExtractData, { format: 'sheet' }>).sheets[0]!
    assert.equal(sheet.headerRow, 2)
    assert.equal(sheet.rows[0]!.发车班次号, 'FCBC26100300000002')
    assert.equal(sheet.rows[0]!.日期, '2026-10-03')
  })

  it('refuses archives that expand too far, and ignores unknown binaries', async () => {
    const big = new JSZip()
    big.file('xl/workbook.xml', '<workbook/>')
    big.file('xl/worksheets/sheet1.xml', 'x'.repeat(2_000_000))
    const buf = await big.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    assert.equal(await extractFile(buf, 'bomb.xlsx', { maxJsonRows: 10, maxIndexRows: 10, maxIndexChars: 1000, maxEmbeddedChunks: 1, maxUncompressedBytes: 1_000_000, convertTimeoutMs: 1000 }), null)
    assert.equal(await extractFile(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'photo.png'), null)
  })

  it('caps rows, index text and vectors on large sheets', async () => {
    const lines = ['编号,金额', ...Array.from({ length: 5000 }, (_, i) => `SKU-${i},${i}`)]
    const r = (await extractFile(Buffer.from(lines.join('\n')), 'big.csv', { maxJsonRows: 1000, maxIndexRows: 200, maxIndexChars: 400_000, maxEmbeddedChunks: 3, maxUncompressedBytes: 1e9, convertTimeoutMs: 1000 }))!
    const sheet = (r.data as Extract<ExtractData, { format: 'sheet' }>).sheets[0]!
    assert.equal(sheet.rowCount, 5000)
    assert.equal(sheet.rows.length, 1000)
    assert.equal(sheet.columns.find(c => c.name === '金额')!.sum, (4999 * 5000) / 2, 'the profile covers every row')
    assert.equal(r.truncated, true)
    assert.ok(r.chunks.some(c => c.text.includes('SKU-199')) && !r.chunks.some(c => c.text.includes('SKU-200,')))
    assert.ok(r.chunks.filter(c => c.embed).length <= 3)
  })
})

describe('inputs and outputs', () => {
  it('names files the way people do', () => {
    assert.equal(displayName('华东干线请款明细2026年_nexus_1791453549547.xls'), '华东干线请款明细2026年.xls')
    assert.equal(displayName('output/ganxian/report_20261005.md'), 'report_20261005.md')
  })

  it('tells inputs from outputs', () => {
    const win = { start: 10_000_000, end: 20_000_000 }
    const hints = { uploaded: ['upload/a.xlsx'], userTurns: [{ text: '@十月份_nexus_1791447625115.xls 统计一下，顺便更新 台账.xlsx', at: 15_000_000 }], agentStartedAt: 12_000_000 }
    assert.equal(classifyFile({ rel: 'upload/a.xlsx', mtime: 18_000_000 }, win, hints), 'input', 'uploaded')
    assert.equal(classifyFile({ rel: '十月份_nexus_1791447625115.xls', mtime: 1_000 }, win, hints), 'input', 'named by the employee, even if older than the session')
    assert.equal(classifyFile({ rel: '台账.xlsx', mtime: 1_000 }, win, hints), 'input', 'named and untouched')
    assert.equal(classifyFile({ rel: '台账.xlsx', mtime: 16_000_000 }, win, hints), 'output', 'named, but rewritten by the agent afterwards')
    assert.equal(classifyFile({ rel: 'data.csv', mtime: 11_000_000 }, win, hints), 'input', 'there before the agent started')
    assert.equal(classifyFile({ rel: 'output/report.md', mtime: 11_000_000 }, win, hints), 'output')
    assert.equal(classifyFile({ rel: 'report.md', mtime: 13_000_000 }, win, hints), 'output')
    assert.equal(classifyFile({ rel: '.drafts/x.py', mtime: 13_000_000 }, win, hints), 'intermediate')
    assert.equal(classifyFile({ rel: 'old.md', mtime: 1_000 }, win, hints), null, 'unrelated older file')
    assert.equal(classifyFile({ rel: '请款明细_nexus_1791425442674.xls', mtime: 18_000_000 }, win, hints), 'input', 'named like a moss client upload')
    assert.equal(classifyFile({ rel: 'output/x_nexus_1791425442674.xls', mtime: 18_000_000 }, win, hints), 'output')
  })
})

describe('searchable session files', () => {
  let fx: Fixture
  afterEach(() => fx?.cleanup())

  async function analysisSession(): Promise<string> {
    const xlsx = await sampleXlsx()
    return fx.addSession({
      agent: 'shouhou',
      userId: 'u-a',
      inputs: {
        '2026十月份_nexus_1791447625115.xlsx': xlsx,
        // The same workbook uploaded again under another name.
        'uploads/十月份-副本.xlsx': xlsx,
        '司机名单_nexus_1791400000000.csv': '工号,姓名,封车号\n007,张三,014222\n',
      },
      uploaded: ['2026十月份_nexus_1791447625115.xlsx', 'uploads/十月份-副本.xlsx'],
      turns: [
        { role: 'user', text: '@2026十月份_nexus_1791447625115.xlsx @司机名单_nexus_1791400000000.csv 分析十月干线时效，写成报告' },
        { role: 'assistant', text: '已完成分析，报告见 十月分析.docx 与 summary.md。' },
      ],
      files: { '十月分析.docx': await sampleDocx(), 'summary.md': '# 十月小结\n上虞-南京线准点率 88%，需要换车。\n' },
    })
  }

  it('indexes inputs (private to the employee) and outputs (shared), with JSON copies and the link between them', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const sid = await analysisSession()
    assert.equal((await fx.svc.digest.digestSessionById(sid)).status, 'ok')
    const home = path.join(fx.dir, 'agent-home', ORG, SHOUHOU)

    // Inputs are copied under inputs/, once per distinct content, with their JSON data.
    const inputCopy = path.join(home, 'inputs', sid, '2026十月份_nexus_1791447625115.xlsx')
    assert.ok(existsSync(inputCopy))
    assert.ok(!existsSync(path.join(home, 'inputs', sid, 'uploads', '十月份-副本.xlsx')), 'identical re-upload not copied again')
    const json = JSON.parse(readFileSync(`${inputCopy}.extract.json`, 'utf8'))
    assert.equal(json.format, 'sheet')
    assert.equal(json.role, 'input')
    assert.equal(json.file, '2026十月份.xlsx')
    assert.equal(json.sheets[0].rows[1].发车班次号, 'FCBC26100400000007')
    assert.ok(existsSync(path.join(home, 'artifacts', sid, '十月分析.docx.extract.json')))

    const docs = fx.svc.store.listSessionDocs(ORG, SHOUHOU, sid, 'file:')
    const titles = docs.map(d => `${d.kind}:${d.title}:${d.visibility}`).sort()
    assert.deepEqual(titles, [
      'artifact:summary.md（产出）:shared',
      'artifact:十月分析.docx（产出）:shared',
      'input:2026十月份.xlsx（输入）:private',
      'input:司机名单.csv（输入）:private',
    ])
    assert.deepEqual(docs.find(d => d.kind === 'input' && d.title.startsWith('2026'))!.meta.sameContent, ['uploads/十月份-副本.xlsx'])

    // The summary and the file list connect inputs to outputs.
    const summary = readFileSync(path.join(fx.dir, 'agent-home', fx.svc.store.getDocByKey(ORG, SHOUHOU, `summary:${sid}`)!.path.replace(/^\/agent-home\//, '')), 'utf8')
    assert.match(summary, /- 输入文件：2026十月份.xlsx、司机名单.csv/)
    assert.match(summary, /- 产出文件：(十月分析.docx、summary.md|summary.md、十月分析.docx)/)
    const list = fx.svc.store.getDocByKey(ORG, SHOUHOU, `artifacts:${sid}`)!
    assert.equal(list.visibility, 'shared')
    // Inputs are private while summaries are shared: the summary names them but carries none of their content.
    const inputOutline = fx.svc.store.listSessionDocs(ORG, SHOUHOU, sid, 'file:').find(d => d.kind === 'input' && d.title.startsWith('2026'))!.meta.outline as string
    assert.ok(inputOutline.length > 10)
    assert.ok(!summary.includes(inputOutline), 'no input outline in the summary')

    // A value that exists only inside the spreadsheet: the employee who gave it finds the row.
    const mine = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: 'FCBC26100400000007', viewer: { kind: 'user', userId: 'u-a' } })
    assert.equal(mine[0]?.kind, 'input')
    assert.match(mine[0]!.snippet, /第4行：日期=2026-10-04｜出发地=上虞｜目的地=南京｜运费含税=1305.8/)
    // Another employee does not, unless the agent shares inputs with its employees.
    const other = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: 'FCBC26100400000007', viewer: { kind: 'user', userId: 'u-b' } })
    assert.ok(other.every(h => h.kind !== 'input'))
    await fx.svc.configure(ORG, 'shouhou', { ...fx.svc.store.getAgent(ORG, SHOUHOU)!.config, sharing: { input: 'users' } })
    const opened = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: 'FCBC26100400000007', viewer: { kind: 'user', userId: 'u-b' } })
    assert.equal(opened[0]?.kind, 'input')
    // Outputs are shared: the table inside the Word report is searchable by anyone.
    const report = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: '雨天延误', viewer: { kind: 'user', userId: 'u-b' } })
    assert.equal(report[0]?.title, '十月分析.docx（产出）')
    assert.match(report[0]!.snippet, /线路=上虞-温州｜准点率=96%/)
    // Meaning, not just keywords: the profile chunk is embedded.
    const profile = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: '十月份发车明细表有哪些列', viewer: { kind: 'user', userId: 'u-a' }, kinds: ['input'] })
    assert.ok(profile.length > 0)
  })

  it('does not extract unchanged files again, and redoes sessions digested by an older version', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const sid = await analysisSession()
    await fx.svc.digest.digestSessionById(sid)
    const before = new Map(fx.svc.store.listSessionDocs(ORG, SHOUHOU, sid, 'file:').map(d => [d.docKey, d.id]))
    // An older digest version: the session is digested again, files are reused.
    const st = fx.svc.store.getDigestState(sid)!
    fx.svc.store.setDigestState(sid, { size: st.size, mtime: st.mtime, status: 'ok', version: DIGEST_VERSION - 1 })
    assert.equal((await fx.svc.digest.digestSessionById(sid)).status, 'ok')
    assert.equal((await fx.svc.digest.digestSessionById(sid)).status, 'unchanged')
    const after = new Map(fx.svc.store.listSessionDocs(ORG, SHOUHOU, sid, 'file:').map(d => [d.docKey, d.id]))
    assert.deepEqual(after, before, 'same documents, not re-extracted')
  })

  it('applies the same rules to reading files, for employees and for agents being answered', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const sid = await analysisSession()
    await fx.svc.digest.digestSessionById(sid)
    const inputPath = fx.svc.store.listSessionDocs(ORG, SHOUHOU, sid, 'file:').find(d => d.kind === 'input' && d.title.startsWith('2026'))!.path
    const outputPath = fx.svc.store.listSessionDocs(ORG, SHOUHOU, sid, 'file:').find(d => d.title.startsWith('十月分析'))!.path
    const convPath = fx.svc.store.getDocByKey(ORG, SHOUHOU, `conversation:${sid}`)!.path
    const row = () => fx.svc.store.getAgent(ORG, SHOUHOU)!
    const read = (path: string, viewer: Viewer) => fx.svc.a2a.readHomeFile(ORG, row(), path, viewer).then(r => r.buf.toString())
    const code = (path: string, viewer: Viewer) => read(path, viewer).then(() => 'ok', (err: A2AError) => err.code)
    const userA: Viewer = { kind: 'user', userId: 'u-a' }
    const userB: Viewer = { kind: 'user', userId: 'u-b' }
    const gendan: Viewer = { kind: 'agent', agent: { id: 'agent-gendan-uuid', name: 'gendan', displayName: '跟单助手' } }
    const other: Viewer = { kind: 'agent', agent: { id: 'agent-other-uuid', name: 'other', displayName: '其他助手' } }

    // Employees of the returns agent: the input for the employee who gave it, not for a colleague.
    assert.equal(await code(inputPath, userA), 'ok')
    assert.match(await read(`${inputPath}.extract.json`, userA), /FCBC26100400000007/)
    assert.equal(await code(inputPath, userB), 'private')
    assert.equal(await code(`${inputPath}.extract.json`, userB), 'private')
    assert.equal(await code(convPath, userB), 'private')
    assert.equal(await code('司机名单.csv', userB), 'file_not_found')
    assert.match(await read('司机名单.csv', userA), /张三/, 'found by its name for the employee who gave it')

    // While answering 跟单助手 (outputs shared with it): outputs and their data yes, inputs no; 其他助手 nothing.
    assert.match(await read(`${outputPath}.extract.json`, gendan), /上虞-南京/)
    assert.equal(await code(inputPath, gendan), 'private')
    assert.equal(await code(convPath, gendan), 'private')
    assert.equal(await code(`${outputPath}.extract.json`, other), 'private')
    const hits = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: 'FCBC26100400000007 雨天延误', viewer: gendan })
    assert.ok(hits.some(h => h.title === '十月分析.docx（产出）'))
    assert.ok(hits.every(h => h.kind !== 'input'))

    // Inputs opened to employees only: colleagues yes, agents still no.
    await fx.svc.configure(ORG, 'shouhou', { ...row().config, sharing: { ...row().config.sharing, input: { level: 'users' } } })
    assert.equal(await code(inputPath, userB), 'ok')
    assert.equal(await code(inputPath, gendan), 'private')
    // Opened to agents: the agents that may call it.
    await fx.svc.configure(ORG, 'shouhou', { ...row().config, sharing: { ...row().config.sharing, input: { level: 'agents' } } })
    assert.equal(await code(inputPath, gendan), 'ok')
    const inputHits = await fx.svc.index.search({ orgId: ORG, agentId: SHOUHOU, query: 'FCBC26100400000007', viewer: gendan })
    assert.equal(inputHits[0]?.kind, 'input')
    // A colleague left out by name, while the rest keep access.
    await fx.svc.configure(ORG, 'shouhou', { ...row().config, sharing: { ...row().config.sharing, input: { level: 'users', users: { allow: ['*'], deny: ['u-b'] } } } })
    assert.equal(await code(inputPath, userB), 'private')
    assert.equal(await code(inputPath, { kind: 'user', userId: 'u-c' }), 'ok')
  })

  it('deletes input and output copies with the session', async () => {
    fx = createFixture(PAIR_AGENTS)
    await configurePair(fx)
    const sid = await analysisSession()
    await fx.svc.digest.digestSessionById(sid)
    const home = path.join(fx.dir, 'agent-home', ORG, SHOUHOU)
    assert.ok(existsSync(path.join(home, 'inputs', sid)))
    const cfg = fx.svc.store.getAgent(ORG, SHOUHOU)!.config
    await fx.svc.configure(ORG, 'shouhou', { ...cfg, memory: { ...cfg.memory, deleteAfterHours: 1 } })
    const purged = await fx.svc.digest.purgeExpired(Date.now() + 2 * 3600_000)
    assert.equal(purged.sessions, 1)
    assert.equal(fx.svc.store.listSessionDocs(ORG, SHOUHOU, sid, 'file:').length, 0)
    assert.ok(!existsSync(path.join(home, 'inputs', sid)), 'input copies and their JSON removed')
    assert.ok(!existsSync(path.join(home, 'artifacts', sid)), 'output copies removed')
    assert.deepEqual(fx.svc.store.listUploads(sid), [])
  })
})
