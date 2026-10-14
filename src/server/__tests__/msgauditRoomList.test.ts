/**
 * 会话存档 room-id list: extraction from txt / csv / xlsx, persistence, and
 * the union with rooms.json that the snapshot worker photographs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import JSZip from 'jszip'
import {
  clearRoomList,
  extractRoomIds,
  readRoomList,
  snapshotRoomSet,
  writeRoomList,
} from '../corpapps/msgaudit/roomList.js'

// Real-shaped ids: wr_ + 28 base64url chars. B ends in '-' and C in '_' on
// purpose — \b-based matching would truncate those.
const A = 'wr_l7aCgAAHdij98j-KBrdSYYsPBIZew'
const B = 'wr_l7aCgAAhDigqrNMysaFbaGzf5jGM-'
const C = 'wr_l7aCgAAAFhvwxM8_gFtGsopg3EE1_'
const WO = 'wo_l7aCgAAaaaaaaaaaaaaaaaaaaaaaaaa'
const WM = 'wm_l7aCgAAbbbbbbbbbbbbbbbbbbbbbbbb'

describe('extractRoomIds — text', () => {
  it('accepts any mix of separators and keeps ids ending in - or _', async () => {
    const txt = `${A}, ${B}\n${C}，${A}`
    const r = await extractRoomIds(Buffer.from(txt, 'utf8'), 'ids.txt')
    expect(r.ids).toEqual([A, B, C].sort())
    expect(r.ignored).toBe(0)
  })

  it('reads csv, ignores contact ids, ignores headers and prose', async () => {
    const csv = `群名,群ID,群主\n"⭐五金店",${A},${WO}\n"另一家",${B},${WM}\nwr_short,not an id,\n`
    const r = await extractRoomIds(Buffer.from(csv, 'utf8'), 'board.csv')
    expect(r.ids).toEqual([A, B].sort())
    expect(r.ignored).toBe(2)
  })

  it('decodes GBK when the bytes are not utf-8', async () => {
    const r = await extractRoomIds(iconv.encode(`群ID,群名\n${C},锐锢五金\n`, 'gbk'), 'gbk.csv')
    expect(r.ids).toEqual([C])
  })

  it('treats a .xlsx name with non-zip bytes as text', async () => {
    const r = await extractRoomIds(Buffer.from(`${A}\n`, 'utf8'), 'misnamed.xlsx')
    expect(r.ids).toEqual([A])
  })
})

describe('extractRoomIds — xlsx', () => {
  async function workbook(entries: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip()
    for (const [name, body] of Object.entries(entries)) zip.file(name, body)
    return zip.generateAsync({ type: 'nodebuffer' })
  }

  it('finds ids in both shared strings and inline strings', async () => {
    const buf = await workbook({
      '[Content_Types].xml': '<Types/>',
      'xl/workbook.xml': '<workbook/>',
      'xl/sharedStrings.xml': `<sst><si><t>${A}</t></si><si><t>${WO}</t></si></sst>`,
      'xl/worksheets/sheet1.xml':
        `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c>` +
        `<c r="B1" t="inlineStr"><is><t>${B}</t></is></c></row></sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': `<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>${A}</t></is></c></row></sheetData></worksheet>`,
    })
    const r = await extractRoomIds(buf, 'board.xlsx')
    expect(r.ids).toEqual([A, B].sort())
    expect(r.ignored).toBe(1)
  })

  it('rejects a zip that holds no worksheet', async () => {
    const buf = await workbook({ 'readme.txt': A })
    await expect(extractRoomIds(buf, 'not-a-sheet.xlsx')).rejects.toThrow('未找到工作表')
  })
})

describe('snapshotRoomSet', () => {
  const meta = (roomid: string) => ({ roomid, dir: roomid, count: 1, lastSeen: 0 })

  it('unions the upload with rooms.json, drops _direct and empties, sorts', () => {
    expect(snapshotRoomSet([B, A], [meta(C), meta(A), meta('_direct'), meta('')])).toEqual([A, B, C].sort())
  })

  it('falls back to rooms.json alone when nothing was uploaded', () => {
    expect(snapshotRoomSet(null, [meta(C)])).toEqual([C])
  })
})

describe('write / read / clear', () => {
  let home = ''
  const prev = process.env.MOSS_HOME

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'moss-roomlist-'))
    process.env.MOSS_HOME = home
  })
  afterAll(async () => {
    if (prev === undefined) delete process.env.MOSS_HOME
    else process.env.MOSS_HOME = prev
    await rm(home, { recursive: true, force: true })
  })

  it('round-trips, keeps only the latest original, and clears', async () => {
    expect(await readRoomList('app1')).toBeNull()
    await writeRoomList('app1', 'old.txt', Buffer.from(A), [A], 0)
    const saved = await writeRoomList('app1', '../../群活跃度看板.xlsx', Buffer.from('x'), [A, B], 3)
    expect(saved.count).toBe(2)
    expect(saved.ignored).toBe(3)
    expect(await readRoomList('app1')).toEqual([A, B])

    const dir = join(home, 'msgaudit', 'app1', 'roomlist')
    const files = await readdir(dir)
    expect(files).toEqual(['群活跃度看板.xlsx'])
    expect((await readFile(join(dir, files[0]!))).toString()).toBe('x')

    await clearRoomList('app1')
    expect(await readRoomList('app1')).toBeNull()
  })
})
