// Stub: contextCollapse service
export function getStats() {
  return {
    collapsedSpans: 0,
    stagedSpans: 0,
    health: { totalErrors: 0, totalEmptySpawns: 0, emptySpawnWarningEmitted: false },
  }
}
export function subscribe(_cb: () => void): () => void {
  return () => {}
}
