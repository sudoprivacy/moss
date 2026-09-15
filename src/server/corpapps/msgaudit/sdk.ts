/**
 * libWeWorkFinanceSdk binding (linux/amd64 only).
 *
 * WHY FFI AND NOT REST
 * --------------------
 * 会话存档's GetChatData / DecryptData / GetMediaData do not exist on
 * qyapi.weixin.qq.com — WeCom ships them only inside a native C library,
 * with no Node binding. So unlike every other corp-app connector (plain
 * fetch over REST), this one must cross into native code.
 *
 * WHY IN-PROCESS AND NOT A SIDECAR
 * --------------------------------
 * The .so is linux/amd64-only, but moss's own server image already is:
 * deploy/server.Dockerfile hardcodes /lib/x86_64-linux-gnu symlinks, so
 * the SDK adds no constraint that isn't already there. A native binding
 * in-process is also existing practice here (nexus/nexusClient.ts), and
 * this module copies its lazy-load-and-throw shape so a machine without
 * the library (e.g. a macOS dev box) fails only when an archive instance
 * is actually used, never at import time.
 *
 * The residual risk FFI carries over a sidecar is that a segfault inside
 * a black-box .so takes the process down rather than one container. That
 * is why the puller runs in a forked child (see worker.ts) — the crash
 * domain is a restartable child, without a second deployment unit.
 *
 * NOTE: koffi is marked --external in scripts/build.js and installed via
 * deploy/runtime-deps.package.json, like better-sqlite3.
 */

export type SdkHandle = {
  getChatData(seq: number, limit: number): Promise<RawChatRecord[]>
  decryptData(randomKey: string, encryptedMsg: string): string
  /**
   * Download one media object (image/emotion/file/video/voice) by its
   * `sdkfileid`. Returns the assembled bytes.
   *
   * WeCom streams media in chunks: each call returns a slice plus an
   * `outindexbuf` cursor for the next one, until `is_finish` is set. A
   * ~1MB image therefore takes several round trips.
   */
  getMediaData(sdkFileId: string): Buffer
  destroy(): void
}

/** A record as returned by GetChatData, before decryption. */
export type RawChatRecord = {
  seq: number
  msgid: string
  publickey_ver: number
  encrypt_random_key: string
  encrypt_chat_msg: string
}

type KoffiLib = { func(signature: string): (...args: unknown[]) => unknown }
type Koffi = {
  load(path: string): KoffiLib
  /** Read `len` elements of `type` from a native pointer (binary-safe). */
  decode(ptr: unknown, type: string, len: number): unknown
}

let koffiCache: Koffi | null = null

/**
 * Load koffi lazily. Absent on dev machines that never pull archives;
 * the error names the cause rather than surfacing MODULE_NOT_FOUND.
 */
function loadKoffi(): Koffi {
  if (koffiCache) return koffiCache
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    koffiCache = require('koffi') as Koffi
    return koffiCache
  } catch {
    throw new Error(
      'msgaudit: koffi not available — the WeCom finance SDK needs FFI. ' +
        'Install koffi (runtime-deps) and run on linux/amd64.',
    )
  }
}

/** Default install path; overridable for non-standard deployments. */
export function sdkLibraryPath(): string {
  return process.env.WEWORK_FINANCE_SDK_PATH || '/usr/local/lib/libWeWorkFinanceSdk_C.so'
}

/**
 * Open an SDK session for one corp. Throws with an actionable message on
 * any platform where the library cannot be loaded.
 *
 * IMPORTANT: callers must `destroy()` — the SDK allocates a native slot
 * per Init and leaking them exhausts the library's internal pool, the
 * same failure shape as leaked agent runtime sessions.
 */
export function openSdk(corpId: string, secret: string): SdkHandle {
  const koffi = loadKoffi()
  let lib: KoffiLib
  try {
    lib = koffi.load(sdkLibraryPath())
  } catch (err) {
    throw new Error(
      `msgaudit: cannot load ${sdkLibraryPath()} (${err instanceof Error ? err.message : String(err)}). ` +
        'The WeCom finance SDK ships linux/amd64 only and is not in this image.',
    )
  }

  // Signatures per the vendored SDK header. The library fills caller-
  // allocated Slice_t buffers rather than returning strings, so every
  // call pairs a NewSlice with a FreeSlice.
  const NewSdk = lib.func('void* NewSdk()')
  const Init = lib.func('int Init(void*, const char*, const char*)')
  const DestroySdk = lib.func('void DestroySdk(void*)')
  const NewSlice = lib.func('void* NewSlice()')
  const FreeSlice = lib.func('void FreeSlice(void*)')
  const GetContentFromSlice = lib.func('const char* GetContentFromSlice(void*)')
  const GetChatDataFn = lib.func(
    'int GetChatData(void*, unsigned long long, unsigned int, const char*, const char*, int, void*)',
  )
  const DecryptDataFn = lib.func('int DecryptData(const char*, const char*, void*)')

  const sdk = NewSdk() as unknown
  const initRc = Number(Init(sdk, corpId, secret))
  if (initRc !== 0) {
    try {
      DestroySdk(sdk)
    } catch {
      // best-effort
    }
    throw new Error(
      `msgaudit: SDK Init failed (rc=${initRc}) — check corpId and the 会话存档 Secret ` +
        '(it is issued under 安全与管理 → 会话内容存档, and is NOT any app secret)',
    )
  }

  /** Run `fn` against a fresh Slice and return its content, always freeing. */
  /**
   * Run `fn` against a fresh Slice and return its content, always freeing.
   *
   * On a non-zero return the Slice still carries WeCom's own error JSON
   * (e.g. {"errcode":40001,...}), and the library ALSO prints it to fd 2
   * from native code — which never reaches the container log. Reading the
   * Slice on the failure path is therefore the only way an operator ever
   * sees why a pull failed; without it every cause collapses into the
   * SDK's generic rc=10001.
   */
  const withSlice = (fn: (slice: unknown) => number): string => {
    const slice = NewSlice() as unknown
    try {
      const rc = fn(slice)
      if (rc !== 0) {
        let detail = ''
        try {
          detail = String(GetContentFromSlice(slice) ?? '').trim()
        } catch {
          // the Slice may be untouched on some failures
        }
        throw new Error(detail ? `rc=${rc}: ${detail.slice(0, 300)}` : `rc=${rc}`)
      }
      return String(GetContentFromSlice(slice) ?? '')
    } finally {
      try {
        FreeSlice(slice)
      } catch {
        // best-effort
      }
    }
  }

  // Media chunking: a single GetMediaData call returns at most ~512KB, so
  // large files need several passes threaded by outindexbuf.
  const NewMediaData = lib.func('void* NewMediaData()')
  const FreeMediaData = lib.func('void FreeMediaData(void*)')
  const GetMediaDataFn = lib.func(
    'int GetMediaData(void*, const char*, const char*, const char*, const char*, int, void*)',
  )
  const GetOutIndexBuf = lib.func('const char* GetOutIndexBuf(void*)')
  // MUST be void*, not const char*: koffi auto-marshals a char* return
  // into a JS string, which stops at the first NUL byte — that silently
  // truncates every binary payload. Verified against the real SDK: the
  // same call returns a string when declared char* and a pointer when
  // declared void*. The pointer is then decoded by explicit length.
  const GetDataFn = lib.func('void* GetData(void*)')
  const GetDataLen = lib.func('int GetDataLen(void*)')
  const IsMediaDataFinish = lib.func('int IsMediaDataFinish(void*)')

  /** Guard against a malformed is_finish looping forever. */
  const MAX_MEDIA_CHUNKS = 512

  return {
    async getChatData(seq: number, limit: number): Promise<RawChatRecord[]> {
      let body: string
      try {
        // proxy/passwd null, 10s timeout — matches the SDK's own default.
        body = withSlice((slice) =>
          Number(GetChatDataFn(sdk, BigInt(seq), limit, null, null, 10, slice)),
        )
      } catch (err) {
        throw new Error(`msgaudit: GetChatData failed at seq ${seq} (${err instanceof Error ? err.message : err})`)
      }
      const parsed = JSON.parse(body) as { errcode?: number; errmsg?: string; chatdata?: RawChatRecord[] }
      if (parsed.errcode && parsed.errcode !== 0) {
        throw new Error(`msgaudit: GetChatData errcode=${parsed.errcode} ${parsed.errmsg ?? ''}`)
      }
      return parsed.chatdata ?? []
    },

    decryptData(randomKey: string, encryptedMsg: string): string {
      return withSlice((slice) => Number(DecryptDataFn(randomKey, encryptedMsg, slice)))
    },

    getMediaData(sdkFileId: string): Buffer {
      const chunks: Buffer[] = []
      let indexBuf = ''
      for (let i = 0; i < MAX_MEDIA_CHUNKS; i++) {
        const media = NewMediaData() as unknown
        try {
          const rc = Number(GetMediaDataFn(sdk, indexBuf || null, sdkFileId, null, null, 30, media))
          if (rc !== 0) {
            // 10005 = fileid invalid/expired: sdkfileid lives ~3 days, so a
            // late download is the expected failure, not a bug.
            throw new Error(`GetMediaData rc=${rc}${rc === 10005 ? ' (sdkfileid expired or invalid)' : ''}`)
          }
          const len = Number(GetDataLen(media))
          if (len > 0) {
            // koffi hands back a NUL-terminated string view; media is
            // binary, so decode the pointer as a sized buffer instead.
            const ptr = GetDataFn(media) as unknown
            chunks.push(Buffer.from(koffi.decode(ptr, 'uint8_t', len) as Uint8Array))
          }
          if (Number(IsMediaDataFinish(media)) === 1) break
          indexBuf = String(GetOutIndexBuf(media) ?? '')
          if (!indexBuf) break
        } finally {
          try {
            FreeMediaData(media)
          } catch {
            // best-effort
          }
        }
      }
      return Buffer.concat(chunks)
    },

    destroy(): void {
      DestroySdk(sdk)
    },
  }
}
