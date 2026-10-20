// A page with lots of media must not freeze the archive.
//
// On 2026-10-16 one 4.6 MB image was posted to 351 groups inside a single
// page. Media was downloaded before the cursor was saved, so every pull hit
// the 10-minute limit, was killed, and replayed the page from the start,
// downloading the same files again. These tests pin the fix: cursor first,
// files on disk are not fetched again, same content is fetched once, and a
// pull stops cleanly at its time budget.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { constants, generateKeyPairSync, publicEncrypt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pullOnce, type PullConfig } from "../corpapps/msgaudit/puller.js";
import type { RawChatRecord, SdkHandle } from "../corpapps/msgaudit/sdk.js";
import { appDir, readCursor, writeCursor } from "../corpapps/msgaudit/store.js";
import { readMediaIndex } from "../corpapps/msgaudit/mediaIndex.js";

const APP = "app1";
const T = Date.parse("2026-10-16T08:30:00Z");
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const ENC_KEY = publicEncrypt(
  { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
  Buffer.from("k"),
).toString("base64");

/** 5 copies of one image, 1 other image, 1 text — seq 1..7. */
function page(): RawChatRecord[] {
  const msgs: Record<string, unknown>[] = [];
  for (let i = 0; i < 5; i++) {
    msgs.push({
      msgtype: "image",
      roomid: `room${i}`,
      image: { sdkfileid: `same-${i}`, md5sum: "md5-same", filesize: 4 },
    });
  }
  msgs.push({ msgtype: "image", roomid: "room9", image: { sdkfileid: "other", md5sum: "md5-other", filesize: 4 } });
  msgs.push({ msgtype: "text", roomid: "room9", text: { content: "hi" } });
  return msgs.map((m, i) => ({
    seq: i + 1,
    msgid: `m${i + 1}`,
    publickey_ver: 1,
    encrypt_random_key: ENC_KEY,
    encrypt_chat_msg: JSON.stringify({ ...m, msgid: `m${i + 1}`, msgtime: T + i, from: "u" }),
  }));
}

type Fake = { sdk: SdkHandle; downloads: string[]; cursorAtFirstDownload: number | null };

function fakeSdk(opts: { chatDelayMs?: number } = {}): Fake {
  const f: Fake = { downloads: [], cursorAtFirstDownload: null, sdk: null as never };
  const cursorFile = path.join(appDir(APP), "cursor.json");
  f.sdk = {
    async getChatData(seq) {
      if (opts.chatDelayMs) await new Promise((r) => setTimeout(r, opts.chatDelayMs));
      return page().filter((r) => r.seq > seq);
    },
    decryptData: (_key, msg) => msg,
    getMediaData(id) {
      if (f.cursorAtFirstDownload == null) {
        f.cursorAtFirstDownload = JSON.parse(fs.readFileSync(cursorFile, "utf8")).seq;
      }
      f.downloads.push(id);
      return Buffer.from(`bytes-of-${id}`);
    },
    destroy() {},
  };
  return f;
}

const cfg = (extra: Partial<PullConfig> = {}): PullConfig => ({
  corpAppId: APP,
  corpId: "c",
  secret: "s",
  privateKeysRaw: PEM,
  mediaTypesRaw: "all",
  ...extra,
});

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.MOSS_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "msgaudit-media-"));
  process.env.MOSS_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.MOSS_HOME;
  else process.env.MOSS_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("msgaudit pull with heavy media", () => {
  it("saves the cursor before downloading any media", async () => {
    const f = fakeSdk();
    const r = await pullOnce(cfg(), () => f.sdk);
    expect(f.cursorAtFirstDownload).toBe(7);
    expect(r.cursor).toBe(7);
  });

  it("downloads identical content once and links the repeats", async () => {
    const f = fakeSdk();
    const r = await pullOnce(cfg(), () => f.sdk);
    expect(f.downloads.sort()).toEqual(["other", "same-0"]);
    expect(r.media).toBe(2);
    expect(r.mediaReused).toBe(4);

    const idx = await readMediaIndex(APP, "2026-10-16");
    for (let i = 1; i <= 6; i++) {
      const e = idx.get(`m${i}`)!;
      expect(e.path).toBeTruthy();
      const bytes = fs.readFileSync(path.join(appDir(APP), e.path!), "utf8");
      expect(bytes).toBe(i <= 5 ? "bytes-of-same-0" : "bytes-of-other");
    }
  });

  it("does not download files again when a page is replayed", async () => {
    await pullOnce(cfg(), () => fakeSdk().sdk);
    await writeCursor(APP, 0); // replay the same page
    const f = fakeSdk();
    const r = await pullOnce(cfg(), () => f.sdk);
    expect(f.downloads).toEqual([]);
    expect(r.mediaReused).toBe(6);
    expect(r.written).toBe(0); // messages deduped by msgid as before
  });

  it("stops downloading at the time budget but still saves messages and cursor", async () => {
    const f = fakeSdk({ chatDelayMs: 30 });
    const r = await pullOnce(cfg({ budgetMs: 10 }), () => f.sdk);
    expect(r.budgetHit).toBe(true);
    expect(f.downloads).toEqual([]);
    expect(r.written).toBe(7);
    expect((await readCursor(APP)).seq).toBe(7);
    const idx = await readMediaIndex(APP, "2026-10-16");
    expect(idx.get("m1")?.error).toContain("time budget");
  });
});
