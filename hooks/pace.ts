// When a usage window runs out at the pace seen in this session. Pure.

/** Each window's share used at one moment, by kind. */
export type PaceSample = { at: number; used: Record<string, number> }

/** Readings closer than this are one: the engine raises a measure on every whole point. */
const SAMPLE_GAP_MS = 60_000
/** The pace is the rise over at most this long, so a burst an hour ago does not linger. PROPOSED. */
const LOOKBACK_MS = 60 * 60_000
/** Less time than this says too little to forecast from. PROPOSED. */
const MIN_SPAN_MS = 10 * 60_000

/** The readings with this one added, dropping those past the lookback. */
export const withSample = (
  samples: readonly PaceSample[],
  at: number,
  windows: readonly { kind: string; percentUsed: number }[],
): PaceSample[] => {
  const kept = samples.filter(s => at - s.at <= LOOKBACK_MS)
  if (windows.length === 0) return kept // an empty reading would only block the first real one
  const last = kept[kept.length - 1]
  if (last && at - last.at < SAMPLE_GAP_MS) return kept
  return [...kept, { at, used: Object.fromEntries(windows.map(w => [w.kind, w.percentUsed])) }]
}

/**
 * When the window reaches 100% at the rise since the oldest reading at least ten minutes
 * old and within the hour, or null: no such reading, no rise, already used up, or it
 * resets first.
 */
export const runOutAt = (
  samples: readonly PaceSample[],
  kind: string,
  now: number,
  used: number,
  resetsAt: number | null,
): number | null => {
  if (resetsAt === null || used >= 100) return null
  // A reading above today's use is from before a reset: the rise counts from after the latest one.
  let since = 0
  samples.forEach((s, i) => {
    if ((s.used[kind] ?? -1) > used) since = i + 1
  })
  const base = samples.slice(since).find(s => kind in s.used && now - s.at >= MIN_SPAN_MS && now - s.at <= LOOKBACK_MS)
  if (!base) return null
  const rise = used - base.used[kind]
  if (rise <= 0) return null
  const at = now + ((100 - used) / rise) * (now - base.at)
  return at < resetsAt ? at : null
}
