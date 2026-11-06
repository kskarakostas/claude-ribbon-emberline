// Subagent bookkeeping for the panel. Pure.

import type { AgentRun } from '../types'

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// $ per million tokens: input, output, cache read, cache write at the 1-hour rate.
// First match wins, so a full version comes before its family. Verify against the
// Claude pricing page when a model ships.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable-5-1|mythos-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  // shortcut: Haiku 5.5's price above 100K prompt tokens is ignored, split it if panel costs matter there.
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

/** What usage costs at list price, or null for a model the table does not know. */
export const costOf = (model: string, u: Usage): number | null => {
  const price = PRICES.find(([re]) => re.test(model))?.[1]
  if (!price) return null
  const [input, output, read, write] = price
  return (
    (u.input_tokens * input +
      u.output_tokens * output +
      u.cache_read_input_tokens * read +
      u.cache_creation_input_tokens * write) /
    1e6
  )
}

export const tokensOf = (u: Usage): number =>
  u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

export const addUsage = (run: AgentRun, model: string, u: Usage): AgentRun => {
  const cost = costOf(model, u)
  return {
    ...run,
    model,
    tokens: run.tokens + tokensOf(u),
    costUsd: run.costUsd === null || cost === null ? null : run.costUsd + cost,
  }
}

const NOT_RUNNING = 1

/** Running agents first, newest first within each group. */
export const ordered = (list: readonly AgentRun[]): AgentRun[] =>
  [...list].sort(
    (a, b) =>
      (a.status === 'running' ? 0 : NOT_RUNNING) - (b.status === 'running' ? 0 : NOT_RUNNING) ||
      b.startedAt - a.startedAt,
  )
