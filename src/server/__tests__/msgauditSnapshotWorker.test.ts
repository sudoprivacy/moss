/**
 * 会话存档 daily snapshot worker: the union of uploaded list and rooms.json
 * is photographed, a room that keeps failing leaves the day incomplete (so
 * no departures are computed from a half-built picture), and departures are
 * diffed against the previous photo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RosterSnapshotWorker, runWithConcurrency, isThrottle } from '../corpapps/msgaudit/snapshotWorker.js'
import { writeRoomList } from '../corpapps/msgaudit/roomList.js'
import { readLastUpdated, readLeaves, readSnapshot, writeSnapshot } from '../corpapps/msgaudit/members.js'
import { dayKey } from '../corpapps/msgaudit/store.js'

const R1 = 'wr_room1aaaaaaaaaaaaaaaaaaaaaaaaa'
const R2 = 'wr_room2bbbbbbbbbbbbbbbbbbbbbbbbb'
const R3 = 'wr_room3ccccccccccccccccccccccccc'
const CUST = 'wm_customer11111111111111111111111'

let home = ''
const prevHome = process.env.MOSS_HOME

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'moss-snapshot-'))
  process.env.MOSS_HOME = home
})
afterAll(async () => {
  if (prevHome === undefined) delete process.env.MOSS_HOME
  else process.env.MOSS_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

async function seedRoomsJson(corpAppId: string, roomIds: string[]) {
  const dir = join(home, 'msgaudit', corpAppId)
  await mkdir(dir, { recursive: true })
  const rooms = Object.fromEntries(roomIds.map((r) => [r, { roomid: r, dir: r, count: 1, lastSeen: 1 }]))
  await writeFile(join(dir, 'rooms.json'), JSON.stringify(rooms))
}

describe('helpers', () => {
  it('runWithConcurrency visits every item with bounded parallelism', async () => {
    let live = 0
    let peak = 0
    const seen: number[] = []
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      seen.push(n)
      live--
    })
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('isThrottle recognises only 45009', () => {
    expect(isThrottle(new Error('/cgi-bin/externalcontact/groupchat/get errcode=45009 api freq out of limit'))).toBe(true)
    expect(isThrottle(new Error('errcode=90501 not external group'))).toBe(false)
    expect(isThrottle(new Error('fetch failed'))).toBe(false)
  })
})

describe('RosterSnapshotWorker.snapshotInstance', () => {
  it('photographs uploaded ∪ archived rooms, skips no-roster rooms, completes the day', async () => {
    const id = 'appA'
    await seedRoomsJson(id, [R1, '_direct'])
    await writeRoomList(id, 'list.txt', Buffer.from(''), [R2, R3], 0)

    const asked: string[] = []
    const w = new RosterSnapshotWorker(async () => [], { intervalSec: 60, concurrency: 2 })
    const r = await w.snapshotInstance({
      corpAppId: id,
      rosterLookup: async (roomId) => {
        asked.push(roomId)
        if (roomId === R3) return null // e.g. internal group: definitive "no roster"
        return { members: ['staff1', CUST], roomName: `name-${roomId}` }
      },
    })

    expect(asked.sort()).toEqual([R1, R2, R3].sort())
    expect(r).toMatchObject({ rooms: 3, photographed: 2, skipped: 1, failed: 0, complete: true })
    const today = dayKey(Date.now())
    expect((await readSnapshot(id, R2, today))?.members).toEqual([CUST, 'staff1'].sort())
    expect(await readLastUpdated(id)).toBe(today)
    const leaves = await readLeaves(id, today)
    expect(leaves?.rooms.map((x) => [x.roomid, x.previousDate])).toEqual([
      [R1, null],
      [R2, null],
    ])

    // A second pass the same day has nothing left to ask.
    asked.length = 0
    await w.snapshotInstance({ corpAppId: id, rosterLookup: async () => ({ members: ['x'] }) })
    expect(asked).toEqual([])
  })

  it('a room that keeps throwing leaves the day incomplete; a later pass finishes it', async () => {
    const id = 'appB'
    await seedRoomsJson(id, [R1, R2])
    const w = new RosterSnapshotWorker(async () => [], { intervalSec: 60, concurrency: 2 })

    const broken = await w.snapshotInstance({
      corpAppId: id,
      rosterLookup: async (roomId) => {
        if (roomId === R2) throw new Error('fetch failed')
        return { members: ['staff1'] }
      },
    })
    expect(broken).toMatchObject({ photographed: 1, failed: 1, complete: false })
    expect(await readLastUpdated(id)).toBeNull()

    const fixed = await w.snapshotInstance({ corpAppId: id, rosterLookup: async () => ({ members: ['staff1'] }) })
    expect(fixed).toMatchObject({ photographed: 1, failed: 0, complete: true })
    expect(await readLastUpdated(id)).toBe(dayKey(Date.now()))
  }, 15_000)

  it('reports a customer missing since the previous photo as a departure', async () => {
    const id = 'appC'
    await seedRoomsJson(id, [R1])
    // Yesterday's photo, written with a takenAt one day back.
    await writeSnapshot(id, R1, ['staff1', CUST], Date.now() - 24 * 3600 * 1000)

    const w = new RosterSnapshotWorker(async () => [], { intervalSec: 60, concurrency: 1 })
    const r = await w.snapshotInstance({ corpAppId: id, rosterLookup: async () => ({ members: ['staff1'] }) })
    expect(r.leaves).toBe(1)
    const file = JSON.parse(
      await readFile(join(home, 'msgaudit', id, 'members', 'leaves', `${dayKey(Date.now())}.json`), 'utf8'),
    )
    expect(file.rooms[0].leaves).toEqual([CUST])
  })

  it('reports a departed customer by the name the previous photo recorded', async () => {
    const id = 'appD'
    await seedRoomsJson(id, [R1])
    await writeSnapshot(id, R1, ['staff1', CUST], Date.now() - 24 * 3600 * 1000, {
      memberNames: { staff1: '员工', [CUST]: '张三' },
    })

    const w = new RosterSnapshotWorker(async () => [], { intervalSec: 60, concurrency: 1 })
    await w.snapshotInstance({ corpAppId: id, rosterLookup: async () => ({ members: ['staff1'] }) })
    expect((await readLeaves(id, dayKey(Date.now())))?.rooms[0].leaves).toEqual(['张三'])
  })
})
