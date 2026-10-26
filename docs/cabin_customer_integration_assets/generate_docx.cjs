#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = require('docx')

const input = path.resolve(process.argv[2] || path.join(__dirname, '..', 'cabin_customer_integration_guide.md'))
const output = path.resolve(process.argv[3] || path.join(__dirname, '..', 'Moss_Cabin_接口交互与现场排障手册.docx'))
const markdown = fs.readFileSync(input, 'utf8')
const lines = markdown.split(/\r?\n/)

const PAGE_WIDTH = 11906
const PAGE_HEIGHT = 16838
const CONTENT_WIDTH = 9746
const BRAND = '24577A'
const LIGHT = 'EAF2F7'
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'B7C9D6' }
const CELL_BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER }

function inlineRuns(text, options = {}) {
  const runs = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let cursor = 0
  let match
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) runs.push(new TextRun({ text: text.slice(cursor, match.index), ...options }))
    const token = match[0]
    if (token.startsWith('`')) {
      runs.push(new TextRun({ text: token.slice(1, -1), font: 'Courier New', color: '7A2E2E', size: 19 }))
    } else {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true, ...options }))
    }
    cursor = match.index + token.length
  }
  if (cursor < text.length) runs.push(new TextRun({ text: text.slice(cursor), ...options }))
  return runs.length ? runs : [new TextRun({ text, ...options })]
}

function pngSize(data) {
  if (data.length >= 24 && data.toString('ascii', 1, 4) === 'PNG') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  return { width: 1200, height: 700 }
}

function imageParagraph(relativePath, alt) {
  const imagePath = path.resolve(path.dirname(input), relativePath)
  const data = fs.readFileSync(imagePath)
  const size = pngSize(data)
  const width = Math.min(620, size.width)
  const height = Math.round(width * size.height / size.width)
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 180 },
    children: [new ImageRun({
      type: path.extname(imagePath).slice(1).toLowerCase() || 'png',
      data,
      transformation: { width, height },
      altText: { title: alt, description: alt, name: alt },
    })],
  })
}

function parseTable(start) {
  const rows = []
  let i = start
  while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
    rows.push(lines[i].trim().slice(1, -1).split('|').map(cell => cell.trim()))
    i += 1
  }
  const contentRows = rows.filter((_, index) => index !== 1)
  const colCount = Math.max(...contentRows.map(row => row.length))
  const width = Math.floor(CONTENT_WIDTH / colCount)
  const widths = Array(colCount).fill(width)
  widths[widths.length - 1] += CONTENT_WIDTH - widths.reduce((sum, item) => sum + item, 0)
  return {
    next: i,
    node: new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: widths,
      rows: contentRows.map((row, rowIndex) => new TableRow({
        tableHeader: rowIndex === 0,
        children: widths.map((cellWidth, columnIndex) => new TableCell({
          width: { size: cellWidth, type: WidthType.DXA },
          borders: CELL_BORDERS,
          shading: rowIndex === 0 ? { fill: BRAND, type: ShadingType.CLEAR } : undefined,
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          children: [new Paragraph({
            spacing: { before: 0, after: 0 },
            children: inlineRuns(row[columnIndex] || '', {
              bold: rowIndex === 0,
              color: rowIndex === 0 ? 'FFFFFF' : '222222',
              size: colCount >= 5 ? 15 : 17,
            }),
          })],
        })),
      })),
    }),
  }
}

const numbering = []
for (let i = 0; i < 80; i += 1) {
  numbering.push({
    reference: `numbers-${i}`,
    levels: [{
      level: 0,
      format: LevelFormat.DECIMAL,
      text: '%1.',
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 560, hanging: 280 } } },
    }],
  })
  numbering.push({
    reference: `bullets-${i}`,
    levels: [{
      level: 0,
      format: LevelFormat.BULLET,
      text: '•',
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 560, hanging: 280 } } },
    }],
  })
}

const title = lines[0].replace(/^#\s+/, '')
const subtitle = lines[2] || ''
const sourceNote = lines[4] || ''
const chapterHeadings = lines
  .filter(line => /^##\s+/.test(line))
  .map(line => line.replace(/^##\s+/, ''))
const children = [
  new Paragraph({ spacing: { before: 1800, after: 360 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: title, size: 44, bold: true, color: BRAND })] }),
  new Paragraph({ spacing: { after: 720 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: subtitle, size: 24, color: '526675' })] }),
  new Paragraph({ spacing: { before: 600, after: 160 }, children: [new TextRun({ text: '文档说明', bold: true, color: BRAND, size: 24 })] }),
  new Paragraph({ spacing: { after: 160 }, children: inlineRuns(sourceNote, { size: 21, color: '333333' }) }),
  new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: lines[6] || '', size: 21, color: '333333' })] }),
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('目录')] }),
  new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: '以下目录按正文顺序列出，可使用 Word 导航窗格按标题跳转。', size: 19, color: '607D8B' })] }),
  ...chapterHeadings.map(item => new Paragraph({
    spacing: { after: 90 },
    border: { bottom: { style: BorderStyle.DOTTED, size: 2, color: 'CBD8DF', space: 2 } },
    children: [new TextRun({ text: item, size: 21, color: '36586B' })],
  })),
  new Paragraph({ children: [new PageBreak()] }),
]

let i = 8
let listBlock = 0
let inCode = false
let codeLines = []
while (i < lines.length) {
  const line = lines[i]
  if (/^```/.test(line)) {
    if (inCode) {
      children.push(new Paragraph({
        shading: { fill: 'F4F6F8', type: ShadingType.CLEAR },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: '7AA6C2', space: 8 } },
        spacing: { before: 80, after: 140 },
        children: [new TextRun({ text: codeLines.join('\n'), font: 'Courier New', size: 17, color: '1F2933' })],
      }))
      codeLines = []
      inCode = false
    } else {
      inCode = true
    }
    i += 1
    continue
  }
  if (inCode) {
    codeLines.push(line)
    i += 1
    continue
  }
  const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
  if (image) {
    children.push(imageParagraph(image[2], image[1] || '示意图'))
    i += 1
    continue
  }
  if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[i + 1])) {
    const parsed = parseTable(i)
    children.push(parsed.node, new Paragraph({ spacing: { after: 80 } }))
    i = parsed.next
    continue
  }
  const heading = line.match(/^(#{2,4})\s+(.+)$/)
  if (heading) {
    const level = heading[1].length === 2 ? HeadingLevel.HEADING_1 : heading[1].length === 3 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3
    children.push(new Paragraph({ heading: level, children: inlineRuns(heading[2]) }))
    i += 1
    continue
  }
  const numbered = line.match(/^\s*\d+\.\s+(.+)$/)
  const bullet = line.match(/^\s*-\s+(.+)$/)
  if (numbered || bullet) {
    const isNumbered = Boolean(numbered)
    const reference = `${isNumbered ? 'numbers' : 'bullets'}-${listBlock}`
    children.push(new Paragraph({
      numbering: { reference, level: 0 },
      spacing: { after: 60 },
      children: inlineRuns((numbered || bullet)[1], { size: 21 }),
    }))
    const next = lines[i + 1] || ''
    if (!(isNumbered ? /^\s*\d+\.\s+/.test(next) : /^\s*-\s+/.test(next))) listBlock += 1
    i += 1
    continue
  }
  if (!line.trim()) {
    i += 1
    continue
  }
  children.push(new Paragraph({
    spacing: { after: 120, line: 340 },
    children: inlineRuns(line, { size: 21, color: '222222' }),
  }))
  i += 1
}

const doc = new Document({
  creator: 'Moss Cabin Team',
  title,
  description: 'Moss Cabin 客户联调接口、WebSocket、健康报告与排障说明',
  styles: {
    default: { document: { run: { font: 'Arial Unicode MS', size: 21, color: '222222' }, paragraph: { spacing: { line: 340 } } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Arial Unicode MS', size: 31, bold: true, color: BRAND }, paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0, keepNext: true } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Arial Unicode MS', size: 27, bold: true, color: '2F6F8F' }, paragraph: { spacing: { before: 260, after: 120 }, outlineLevel: 1, keepNext: true } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: 'Arial Unicode MS', size: 23, bold: true, color: '36586B' }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2, keepNext: true } },
    ],
  },
  numbering: { config: numbering },
  sections: [{
    properties: {
      page: {
        size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
        margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
      },
    },
    headers: {
      default: new Header({ children: [new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'AFC5D2', space: 4 } },
        children: [new TextRun({ text: 'Moss Cabin 客户联调手册', size: 17, color: '607D8B' })],
      })] }),
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: '第 ', size: 17, color: '607D8B' }), new TextRun({ children: [PageNumber.CURRENT], size: 17, color: '607D8B' }), new TextRun({ text: ' 页', size: 17, color: '607D8B' })],
      })] }),
    },
    children,
  }],
})

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(output, buffer)
  process.stdout.write(`${output}\n`)
})
