export type TelemetryKind = 'perf' | 'conversation' | 'turn' | 'step' | 'install'

export interface TelemetryQueueMessage {
  ingestId: string
  kind: TelemetryKind
  payload: Record<string, unknown>
}
