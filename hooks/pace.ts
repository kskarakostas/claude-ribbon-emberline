// The usage pace forecast: when a window runs out at the faster of two paces, the average since
// it reset and the pace of the recent stretch, read from the readings kept across sessions. Pure.

import type { PaceLog, PaceSample } from '../types'

const HOUR_MS = 60 * 60_000
/** How long each window runs, by the kind the engine names; a kind not listed gets no forecast rather than a guess. */
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS }
/**
 * The recent stretch each window's pace is also read over. A week's is a whole day, so a night and
 * a working day weigh as they do in any other day, and an idle day already behind stops diluting it.
 * PROPOSED.
 */
const RECENT_MS: Record<string, number> = { five_hour: HOUR_MS, seven_day: 24 * HOUR_MS }
/** No forecast until this share of the window has passed: early on, one busy stretch would swing the average. PROPOSED. */
const MIN_SHARE = 0.1
/** Readings closer than this share of the recent stretch fold into one, so the log stays small. */
const GAP_SHARE = 1 / 24
/** A reset this close to the one kept is the same window. */
const SAME_RESET_MS = 60_000

/** What the window had used at `at`, read linearly between the readings either side of it. */
const usedAt = (points: readonly PaceSample[], at: number): number => {
  let before = points[0]!
  for (const p of points) {
    if (p.at > at) {
      return p.at === before.at ? p.used : before.used + ((p.used - before.used) * (at - before.at)) / (p.at - before.at)
    }
    before = p
  }
  return before.used
}

/**
 * When the window reaches 100% at the faster of its average pace since it reset and its pace over
 * the recent stretch, or null when that comes after the reset, too little of the window has passed,
 * or the window's length is unknown. `samples` are earlier readings of this same window; without
 * them the recent pace is read from the reset onwards, which is the average.
 */
export const runOutAt = (
  kind: string,
  used: number,
  resetsAt: number | null,
  now: number,
  samples: readonly PaceSample[] = [],
): number | null => {
  const span = WINDOW_MS[kind]
  if (span === undefined || resetsAt === null || used <= 0 || used >= 100) return null
  const start = resetsAt - span
  const elapsed = now - start
  if (elapsed < span * MIN_SHARE) return null
  const average = used / elapsed
  const recentMs = Math.min(RECENT_MS[kind] ?? elapsed, elapsed)
  // The window began at 0%, so its start is a reading too.
  const points = [{ at: start, used: 0 }, ...samples.filter(s => s.at > start && s.at < now), { at: now, used }]
  const recent = Math.max(0, used - usedAt(points, now - recentMs)) / recentMs
  const at = now + (100 - used) / Math.max(average, recent)
  return at < resetsAt ? at : null
}

/**
 * The log with this reading added: a window that reset starts over, a reading close behind the
 * one before replaces it, and readings older than the one the recent stretch reaches back to go.
 */
export const noteReading = (log: PaceLog, kind: string, used: number, resetsAt: number | null, now: number): PaceLog => {
  const recentMs = RECENT_MS[kind]
  if (recentMs === undefined || resetsAt === null || !Number.isFinite(used)) return log
  const kept = log[kind]
  const isSame = kept !== undefined && Math.abs(kept.resetsAt - resetsAt) <= SAME_RESET_MS
  const samples = isSame ? kept.samples.filter(s => s.at < now) : []
  const last = samples[samples.length - 1]
  const beforeLast = samples[samples.length - 2]
  if (last && beforeLast && now - beforeLast.at < recentMs * GAP_SHARE) samples.pop()
  samples.push({ at: now, used })
  // Keep the newest reading at or before the stretch's far end: the stretch reads from it.
  let from = 0
  for (let i = 0; i < samples.length; i++) if (samples[i]!.at <= now - recentMs) from = i
  return { ...log, [kind]: { resetsAt, samples: samples.slice(from) } }
}
