/** Metadata captured when a document successfully enters a wiki build. */
export interface WikiSourceSnapshot {
  id: string
  fileName: string
  nodeName: string
  sizeBytes: number
  /** Server-owned parsed source, relative to the published wiki directory. */
  markdownPath?: string
  markdownSha256?: string
}
