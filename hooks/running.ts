// What is running right now, as one short line for the upper row. Pure.

import type { AgentRun, BackgroundRun, ToolRun } from '../types'

/** Quicker calls never show, so the row does not flicker with every tool. */
const SHOW_AFTER_MS = 5000

export const fmtSpan = (ms: number): string => {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/** Shell commands and connector calls; the app's own `mcp__ccd_` tools are its plumbing. */
export const isWatched = (tool: string): boolean => tool === 'Bash' || (tool.startsWith('mcp__') && !tool.startsWith('mcp__ccd_'))

const BACKGROUND_CHARS = 32

/** The fields of the engine's background task list that this row reads. */
type BackgroundTask = { id: string; type: string; description: string }

/**
 * The turn-end list onto what the row holds, keeping when each was first seen. A task
 * that ends between turns wakes a turn of its own, so the next list drops it. Subagents
 * are left out: the agents list already follows them live.
 */
export const backgroundFrom = (tasks: readonly BackgroundTask[], held: readonly BackgroundRun[], now: number): BackgroundRun[] =>
  tasks
    .filter(t => t.type !== 'subagent')
    .map(t => ({
      id: t.id,
      // Not the command line: a bare one reads as `F=/tmp/…`. The type says 'shell'.
      label: t.description || t.type,
      seenAt: held.find(h => h.id === t.id)?.seenAt ?? now,
    }))

const clipTo = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

const clipLabel = (text: string): string => clipTo(text, BACKGROUND_CHARS)

const shortName = (tool: string): string => (tool.startsWith('mcp__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool)

/** Past this many, background work shows as a count: a fan-out of agents leaves many shells. */
const BACKGROUND_NAMED = 2

/**
 * As many parts as fit in `max` characters, then `+N more`. Short of room: a lone part
 * clips; else the first part clips and keeps the count; else just how many run.
 */
const fit = (parts: readonly string[], max: number): string => {
  for (let shown = parts.length; shown > 0; shown--) {
    const kept = parts.slice(0, shown)
    if (shown < parts.length) kept.push(`+${parts.length - shown} more`)
    const text = kept.join(' · ')
    if (text.length <= max) return text
  }
  if (parts.length === 1) return clipTo(parts[0], max)
  const more = ` · +${parts.length - 1} more`
  return max - more.length >= 2 ? clipTo(parts[0], max - more.length) + more : clipTo(`${parts.length} running`, max)
}

/** One line of at most `max` characters, so the row never wraps over the ribbon. */
export const runningLabel = (
  tools: readonly ToolRun[],
  agents: readonly AgentRun[],
  background: readonly BackgroundRun[],
  now: number,
  max = Infinity,
): string | null => {
  const live = agents.filter(a => a.status === 'running')
  const oldest = Math.min(...live.map(a => a.startedAt))
  const parts = live.length > 0 ? [`${live.length} agent${live.length > 1 ? 's' : ''} ${fmtSpan(now - oldest)}`] : []
  for (const t of tools) if (now - t.startedAt >= SHOW_AFTER_MS) parts.push(`${shortName(t.name)} ${fmtSpan(now - t.startedAt)}`)
  if (background.length > BACKGROUND_NAMED) {
    parts.push(`${background.length} background, oldest ${fmtSpan(now - Math.min(...background.map(b => b.seenAt)))}`)
  } else {
    for (const b of background) parts.push(`${clipLabel(b.label)} ${fmtSpan(now - b.seenAt)}`)
  }
  return parts.length > 0 ? fit(parts, max) : null
}
