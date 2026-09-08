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
type Koffi = { load(path: string): KoffiLib }

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
    throw new Error(`msgaudit: SDK Init failed (rc=${initRc}) — check corpId and the 会话存档 Secret`)
  }

  /** Run `fn` against a fresh Slice and return its content, always freeing. */
  const withSlice = (fn: (slice: unknown) => number): string => {
    const slice = NewSlice() as unknown
    try {
      const rc = fn(slice)
      if (rc !== 0) throw new Error(`rc=${rc}`)
      return String(GetContentFromSlice(slice) ?? '')
    } finally {
      try {
        FreeSlice(slice)
      } catch {
        // best-effort
      }
    }
  }

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

    destroy(): void {
      DestroySdk(sdk)
    },
  }
}
