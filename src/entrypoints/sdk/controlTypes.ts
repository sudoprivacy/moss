export type SDKControlPermissionRequest = {
  id: string
  tool_name: string
  input: Record<string, unknown>
}

export type StdoutMessage = {
  type: string
  [key: string]: unknown
}