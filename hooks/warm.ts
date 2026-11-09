// When a keep-warm ping is due. Pure.

export const HOUR_MS = 60 * 60_000
/** Longest idle window a person can ask for. PROPOSED: pings pay for one re-cache after about 33h on Opus 5.5, 17h on most others. */
const MAX_CAP_HOURS = 12
export const DEFAULT_CAP_MS = 2 * HOUR_MS
/** Idle time at which a ping fires. PROPOSED: 10 minutes of margin under the hour. */
export const PING_MS = 50 * 60_000
/**
 * No ping at or past this idle time. A cache read restarts the hour, but once the entry
 * has lapsed a fork bills the whole prefix as a rebuild, so a timer that wakes late
 * (a sleeping laptop) must do nothing.
 */
export const LATE_MS = 58 * 60_000

export type PingFacts = {
  now: number
  /** The last request that touched the cache, a ping included. */
  lastAt: number
  /** The last prompt submitted, or when keep-warm was switched on. */
  lastPromptAt: number
  capMs: number | null
  isBusy: boolean
}

export const shouldPing = (f: PingFacts): boolean => {
  if (f.capMs === null || f.isBusy) return false
  const idle = f.now - f.lastAt
  if (idle < PING_MS || idle >= LATE_MS) return false
  return f.now - f.lastPromptAt < f.capMs
}

/** `2h` as milliseconds, or null for anything else. */
export const capFrom = (text: string): number | null => {
  const hours = /^(\d+)h$/.exec(text)?.[1]
  if (!hours) return null
  const n = Number(hours)
  return n >= 1 && n <= MAX_CAP_HOURS ? n * HOUR_MS : null
}

/** How long keep-warm has left, or 0 when no ping can come: off, busy, too late, or past the cap. */
export const emberLeftMs = (f: PingFacts): number => {
  if (f.capMs === null || f.isBusy || f.now - f.lastAt >= LATE_MS) return 0
  return Math.max(0, f.capMs - (f.now - f.lastPromptAt))
}

/**
 * When the cache goes cold if only pings touch it: an hour after the last ping the cap
 * still allows. Pings land a tick late, so this is about, not exact.
 */
export const coldAtMs = (f: PingFacts): number => {
  let last = f.lastAt
  if (emberLeftMs(f) > 0 && f.capMs !== null) {
    const end = f.lastPromptAt + f.capMs
    while (last + PING_MS < end) last += PING_MS
  }
  return last + HOUR_MS
}
