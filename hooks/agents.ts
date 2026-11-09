// Subagent bookkeeping for the panel. Pure.

import type { AgentRun } from '../types'
import { ratesOf } from './prices'

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** What usage costs at list price, or null for a model the table does not know. */
export const costOf = (model: string, u: Usage): number | null => {
  const price = ratesOf(model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
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
