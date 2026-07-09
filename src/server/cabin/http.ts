type FetchLike = typeof fetch

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
  label = 'request',
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(input, init)
  }

  const controller = new AbortController()
  let timedOut = false
  let timer: NodeJS.Timeout | null = null
  const abortFromCaller = () => controller.abort(init.signal?.reason)
  if (init.signal) {
    if (init.signal.aborted) abortFromCaller()
    else init.signal.addEventListener('abort', abortFromCaller, { once: true })
  }

  const request = fetchImpl(input, { ...init, signal: controller.signal })
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error(`${label} timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
  })

  try {
    return await Promise.race([request, timeout])
  } catch (error) {
    if (timedOut) throw new Error(`${label} timeout after ${timeoutMs}ms`)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (init.signal) init.signal.removeEventListener('abort', abortFromCaller)
  }
}
