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
  /** A clock time keep-warm holds to, set by `until`: it ends the window whatever the last prompt. */
  untilAt?: number | null
}

/** When keep-warm's window ends: the until time, else the cap after the last prompt. Only meaningful while on. */
const windowEnd = (f: PingFacts): number => f.untilAt ?? f.lastPromptAt + (f.capMs ?? 0)

export const shouldPing = (f: PingFacts): boolean => {
  if (f.capMs === null || f.isBusy) return false
  const idle = f.now - f.lastAt
  if (idle < PING_MS || idle >= LATE_MS) return false
  return f.now < windowEnd(f)
}

/**
 * `until 18:30` as the next such clock time in the machine's zone, or null for anything
 * else or a time more than the longest window away.
 */
export const untilFrom = (text: string, now: number): number | null => {
  const m = /^until (\d{1,2}):(\d{2})$/.exec(text)
  if (!m) return null
  const [h, min] = [Number(m[1]), Number(m[2])]
  if (h > 23 || min > 59) return null
  const at = new Date(now)
  at.setHours(h, min, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime() - now <= MAX_CAP_HOURS * HOUR_MS ? at.getTime() : null
}

/** The next full hours at least an hour away, for the picker's until entries. */
export const untilChoices = (now: number, count: number): number[] => {
  const first = new Date(now + HOUR_MS)
  if (first.getMinutes() || first.getSeconds() || first.getMilliseconds()) first.setMinutes(60, 0, 0)
  return Array.from({ length: count }, (_, i) => first.getTime() + i * HOUR_MS)
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
  return Math.max(0, windowEnd(f) - f.now)
}

/** How many pings keep-warm would send in its window, if nothing else touches the cache. */
export const pingCount = (f: PingFacts): number => {
  if (f.now - f.lastAt >= LATE_MS) return 0 // too late for the first, as shouldPing says
  const end = windowEnd(f)
  let n = 0
  for (let last = f.lastAt; last + PING_MS < end; last += PING_MS) n++
  return n
}

/**
 * When the cache goes cold if only pings touch it: an hour after the last ping the cap
 * still allows. Pings land a tick late, so this is about, not exact.
 */
export const coldAtMs = (f: PingFacts): number => {
  let last = f.lastAt
  if (emberLeftMs(f) > 0) {
    const end = windowEnd(f)
    while (last + PING_MS < end) last += PING_MS
  }
  return last + HOUR_MS
}
