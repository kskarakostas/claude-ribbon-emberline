// The usage pace forecast: when a window runs out at its average rate since it last reset. Pure.

const HOUR_MS = 60 * 60_000
/** How long each window runs, by the kind the engine names; a kind not listed gets no forecast rather than a guess. */
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS }
/** No forecast until this share of the window has passed: early on, one busy stretch would swing the average. PROPOSED. */
const MIN_SHARE = 0.1

/**
 * When the window reaches 100% at the rate it has been used since it reset, or null when that
 * comes after the reset, too little of the window has passed, or the window's length is unknown.
 */
export const runOutAt = (kind: string, used: number, resetsAt: number | null, now: number): number | null => {
  const span = WINDOW_MS[kind]
  if (span === undefined || resetsAt === null || used <= 0 || used >= 100) return null
  const elapsed = now - (resetsAt - span)
  if (elapsed < span * MIN_SHARE) return null
  const at = now + ((100 - used) / used) * elapsed
  return at < resetsAt ? at : null
}
