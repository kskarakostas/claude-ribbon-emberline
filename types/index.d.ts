/** One usage window: which one, how much is used (0 to 100), when it resets. */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The prompt cache as the band last saw it: when the main thread last sent a
 * request (clock milliseconds), how much context the next request re-sends,
 * the model's context window, and the model.
 */
export type CacheFacts = {
  lastAt: number
  tokens: number
  window: number
  model: string | null
  /** The share of the last main-thread request the cache served, 0 to 100, or null until one reports. */
  hit?: number | null
  /** What the session has cost so far, as /cost totals it, when the host keeps a ledger. */
  costUsd?: number
  /** True when the cache stopped counting before its hour: a model switch, or a resume the engine says outlived it. The next request clears it. */
  isCold?: boolean
}

/** Whether the cache card is open, remembered only for the state it was set in. */
export type Fold = { mode: 'warm' | 'cold'; open: boolean }

/** Each usage window's share used at one moment, by kind, for the pace forecast. */
export type PaceSample = { at: number; used: Record<string, number> }

/** One step of the app's task list. */
export type PlanStep = { content: string; status: 'pending' | 'in_progress' | 'completed' }

/** The task list, when its current step began, and how long finished steps took (ms). */
export type Plan = { steps: PlanStep[]; stepStartedAt: number; durations: number[] }

/** A shell command or connector call in flight. */
export type ToolRun = { id: number; name: string; startedAt: number }

/** Background work the engine listed at a turn's end, and when the band first saw it. */
export type BackgroundRun = { id: string; label: string; seenAt: number }

/** What occupies the context, by category, against the window. */
export type ContextMix = { rows: { name: string; tokens: number }[]; window: number }

export type AgentStatus = 'running' | 'done' | 'failed'

/** One subagent of this session; `costUsd` is null when its model has no list price here. */
export type AgentRun = {
  id: string
  description: string
  model: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  tokens: number
  costUsd: number | null
}

/**
 * Keep-warm for this session: the idle cap (null is off) and the time of the last
 * prompt, or of switching it on.
 */
export type Warm = { capMs: number | null; lastPromptAt: number; untilAt?: number | null }

/** One ping as `$.store` keeps it under `pingLog`: what the cache served of the context it expected. */
export type PingRecord = { at: number; served: number; tokens: number; isServed: boolean }

/**
 * This session's pings: how many, what they cost at list price, and the last one's time and
 * tokens served. `isFloor` is set once a ping's cost could not be known (it timed out or threw).
 */
export type Ledger = { count: number; costUsd: number; lastAt: number; lastServed: number; isFloor: boolean }

declare module 'claude-code' {
  interface PluginState {
    'emberline': {
      windows: Window[]
      cache: CacheFacts | null
      fold: Fold | null
      plan: Plan | null
      agents: AgentRun[]
      tools: ToolRun[]
      background: BackgroundRun[]
      mix: ContextMix | null
      warnedFor: number
      warm: Warm
      ttl: number
      ledger: Ledger | null
      endedFor: number
      seenFor: number
      autoOff: boolean
      hits: number[]
      pace: PaceSample[]
    }
  }
}
