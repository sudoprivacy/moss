export async function resolveDirectConnectAccessToken(options: {
  authToken?: string
  serverUrl?: string
  apiKey?: string
  username?: string
  email?: string
  password?: string
}): Promise<string | undefined> {
  if (options.authToken) {
    return options.authToken
  }

  const envToken = process.env.MOSS_SESSION_ACCESS_TOKEN
  if (envToken) {
    return envToken
  }

  const serverUrl = options.serverUrl || process.env.MOSS_SERVER_URL || ''
  const apiKey = options.apiKey || process.env.MOSS_API_KEY || ''
  const username =
    options.username ||
    process.env.MOSS_USER_USERNAME ||
    process.env.MOSS_USER_NAME ||
    ''
  const email = options.email || process.env.MOSS_USER_EMAIL || ''
  const password = options.password || process.env.MOSS_USER_PASSWORD || ''
  const loginIdentifier = username || email
  if (!serverUrl || (!apiKey && !(loginIdentifier && password))) {
    return undefined
  }

  const response = await fetch(
    `${serverUrl.replace(/\/+$/, '')}/api/v1/auth/token`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        apiKey
          ? {
              grant_type: 'api_key',
              api_key: apiKey,
            }
          : {
              grant_type: 'password',
              ...(username ? { username } : { email }),
              password,
            },
      ),
    },
  )

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const data = (await response.json()) as { error?: string }
      if (data.error) {
        message = data.error
      }
    } catch {}
    throw new Error(`Failed to get access token from moss server: ${message}`)
  }

  const data = (await response.json()) as { access_token?: string }
  if (!data.access_token) {
    throw new Error('Moss server response missing access_token')
  }

  return data.access_token
}
