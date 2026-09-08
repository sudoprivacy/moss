export const POINT_SUBUNITS = 100

export function toStoredPointUnits(points: number): number {
  if (!Number.isFinite(points)) throw new Error('Points must be finite')
  const subunits = Math.round(points * POINT_SUBUNITS)
  if (!Number.isSafeInteger(subunits) || Math.abs(subunits / POINT_SUBUNITS - points) > 1e-9) {
    throw new Error('Points support at most two decimal places')
  }
  return subunits
}

export function fromStoredPointUnits(units: unknown): number {
  return Number(units) / POINT_SUBUNITS
}
