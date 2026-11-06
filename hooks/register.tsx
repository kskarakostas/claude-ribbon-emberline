import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { addUsage, ordered } from './agents'
import { applyPlan, currentOf, doneOf, etaMs } from './plan'
import { contextMiniSvg, contextPanelSvg } from './context-art'
import { backgroundFrom, fmtSpan, isWatched, runningLabel } from './running'
import { capFrom, DEFAULT_CAP_MS, HOUR_MS, LATE_MS, shouldPing } from './warm'
import type { AgentRun, AgentStatus, BackgroundRun, CacheFacts, ContextMix, Fold, PingRecord, Plan, ToolRun, Warm, Window } from '../types'
import {
  ACCENT, EMPTY, ERROR, HUE, INK, MUTED, ROBO_SIZE, TEXT, ticksSvg, tok, TTL_MIN, TTL_MS, WARN, WORD,
  cardSvg, chipSvg, costOf, familyOf, fmtIdle, kindOf, mineModel, roboSvg, usd,
} from './cache-art'
import type { CacheView } from './cache-art'

// A band above the prompt on the app's own background: neutral grey text,
// tick bars. Each usage window's bar fills with what is used, beside the share LEFT,
// 7-day first, then 5-hour; a window under 15% left turns amber and adds a bold LOW.
//
// After the first reply it also shows the prompt cache: WARM (sage, Robo bobbing)
// for an hour after the last request, then COLD (blue, Robo frozen) with what the
// next message costs to re-cache. Hide / Show folds the card; warm starts folded,
// cold starts open, and a choice holds until the cache flips. Zero token cost:
// it reads the engine's own figures and draws.

const CELLS = 10
/** Tick bar widths in pixels, for the wide row and for the tight row or the plan. */
const BAR_W = 100
const TIGHT_BAR_W = 60
const LOW_AT = 15
const TIGHT_CELLS = 6
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 30_000

const windows = atom({ plugin: 'emberline', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'emberline', key: 'cache' } as const, null as CacheFacts | null)
const fold = atom({ plugin: 'emberline', key: 'fold' } as const, null as Fold | null)

const plan = atom({ plugin: 'emberline', key: 'plan' } as const, null as Plan | null)
const agents = atom({ plugin: 'emberline', key: 'agents' } as const, [] as AgentRun[])
const tools = atom({ plugin: 'emberline', key: 'tools' } as const, [] as ToolRun[])
const background = atom({ plugin: 'emberline', key: 'background' } as const, [] as BackgroundRun[])
const mix = atom({ plugin: 'emberline', key: 'mix' } as const, null as ContextMix | null)
/** The `lastAt` the expiry warning last fired for, so each cache cycle warns once. */
const warnedFor = atom({ plugin: 'emberline', key: 'warnedFor' } as const, 0)

const warm = atom({ plugin: 'emberline', key: 'warm' } as const, { capMs: null, lastPromptAt: 0 } as Warm)

const PING_PROMPT = 'Keep-alive ping, not a task. Reply with only the word: ok'
/** A ping must read at least this share of the context, or the cache was not there. */
const SERVED_SHARE = 0.5
const PING_LOG = 'pingLog'
const PING_LOG_MAX = 50
const COMPACT_SKIPS = 'compactSkips'
/** How often a running turn recounts what fills the context. */
const MIX_REFRESH_MS = 30_000
const WARM_USAGE = 'Usage: /keep-warm [1h to 12h | off | ping]. Alone it switches 2h on or off.'
const WARM_PICKS = ['off', '2h', '6h', '12h']
/** A timer's ping and a command's cannot overlap. Lost on reload, which ends any ping. */
type PingGuard = { isPinging: boolean }

const PANE = 'emberline-agents'
const PANE_TITLE = 'Agents'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
/** Below this a cold start is cheap, so no notification. PROPOSED, tune from use. */
const WARN_TOKENS = 100_000
const DEFAULT_WARN_MIN = 10
/** A hit share under this means the last request rebuilt most of the cache. */
const HIT_LOW_AT = 50
// What a wide row spends, in cells: label, badge, countdown and fold button; each usage
// window; the Agents button; then what the two optional readings need.
const ROW_CELLS = 26
const WINDOW_CELLS = 34
const AGENTS_CELLS = 12
const WARM_CELLS = 16
const HIT_CELLS = 11
const FILL_CELLS = 14
const COST_CELLS = 10
const MINI_CELLS = 9

const NAMES: Record<string, string> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const ORDER: Record<string, number> = { seven_day: 0, five_hour: 1 }

const clean = (list: readonly Window[]): Window[] =>
  list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))

const dots = (left: number, cells: number): { on: string; off: string } => {
  const n = Math.max(0, Math.min(cells, Math.round((left / 100) * cells)))
  return { on: '⣿'.repeat(n), off: '⣀'.repeat(cells - n) }
}

const fmtReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** What the cache drawings read, or null until a request and its context size are known. */
export const viewOf = (c: CacheFacts | null, now: number): CacheView | null => {
  if (!c || c.lastAt <= 0 || c.tokens <= 0) return null
  const idleMs = Math.max(0, now - c.lastAt)
  return {
    mode: idleMs >= TTL_MS ? 'cold' : 'warm',
    idle: fmtIdle(idleMs),
    idleMin: Math.floor(idleMs / 60000),
    tokens: c.tokens,
    window: c.window,
    mine: familyOf(c.model),
  }
}

const warnMinutesOf = (value: unknown): number | null => {
  if (value === 'off') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WARN_MIN
}


const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

const togglePane = async ($: EngineInterface): Promise<void> => {
  if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: PANE_TITLE })
}

const warnIfDue = async ($: EngineInterface, warnMin: number | null): Promise<void> => {
  const c = await read($, cache)
  if (warnMin === null || !c || c.tokens < WARN_TOKENS) return
  const leftMs = TTL_MS - ((await $.clock.now()) - c.lastAt)
  if (leftMs <= 0 || leftMs > warnMin * 60_000 || (await read($, warnedFor)) === c.lastAt) return
  await update($, warnedFor, () => c.lastAt)
  const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? 'session'
  const text = `${project}: ${Math.round(c.tokens / 1000)}k tokens go cold in ${Math.ceil(leftMs / 60_000)}m`
  const sent = await $.ui.notify(text, { title: 'Cache expiring' }).catch(() => null)
  if (!sent?.isSent) $.ui.toast(text)
}

const setCap = async ($: EngineInterface, capMs: number | null): Promise<void> => {
  const now = await $.clock.now()
  await update($, warm, () => ({ capMs, lastPromptAt: now }))
}

/** Keeps the last pings on disk: a fork leaves no row in the transcript, so this is the only trace of one. */
const recordPing = async ($: EngineInterface, record: PingRecord): Promise<void> => {
  try {
    const old = ((await $.store.get(PING_LOG)) ?? []) as PingRecord[]
    await $.store.set(PING_LOG, [...old, record].slice(-PING_LOG_MAX))
  } catch {
    // A record that cannot be written must not stop the ping or the warning after it.
  }
}

/** One fork over the transcript. Resolves the tokens the cache served, or null and switches keep-warm off. */
const ping = async ($: EngineInterface, guard: PingGuard): Promise<number | null> => {
  const startedAt = await $.clock.now()
  const tokens = (await read($, cache))?.tokens ?? 0
  guard.isPinging = true
  let served = 0
  try {
    const r = await $.model.fork({ prompt: PING_PROMPT })
    // A reply with no text still completed; an error's usage says nothing about the cache.
    const isComplete = r.isAnswered || r.reason === 'empty-reply'
    served = isComplete && 'usage' in r ? r.usage.cache_read_input_tokens : 0
  } catch {
    served = 0
  } finally {
    guard.isPinging = false
  }
  const isServed = served > 0 && served >= tokens * SERVED_SHARE
  await recordPing($, { at: startedAt, served, tokens, isServed })
  if (isServed) {
    await update($, cache, c => (c ? { ...c, lastAt: startedAt } : c))
    return served
  }
  await update($, warm, w => ({ ...w, capMs: null }))
  const text = `Keep-warm stopped: the ping read ${Math.round(served / 1000)}k of ${Math.round(tokens / 1000)}k tokens from the cache`
  const sent = await $.ui.notify(text, { title: 'Keep-warm' }).catch(() => null)
  if (!sent?.isSent) $.ui.toast(text)
  return null
}

const pingIfDue = async ($: EngineInterface, guard: PingGuard, isBusy: boolean): Promise<void> => {
  const c = await read($, cache)
  if (!c || guard.isPinging) return
  const w = await read($, warm)
  if (shouldPing({ now: await $.clock.now(), lastAt: c.lastAt, lastPromptAt: w.lastPromptAt, capMs: w.capMs, isBusy })) {
    await ping($, guard)
  }
}

const warmCommand = async ($: EngineInterface, args: string, guard: PingGuard): Promise<string> => {
  const arg = args.trim()
  const w = await read($, warm)
  if (arg === 'ping') {
    const c = await read($, cache)
    if (!c || guard.isPinging) return 'Nothing to ping yet.'
    if ((await $.clock.now()) - c.lastAt >= LATE_MS) return 'Not pinged: the cache may have lapsed, and a ping would pay to rebuild it.'
    const served = await ping($, guard)
    return served === null ? 'The ping missed the cache, so keep-warm is off.' : `Ping read ${Math.round(served / 1000)}k tokens from the cache.`
  }
  if (arg === 'off' || (arg === '' && w.capMs !== null)) {
    await setCap($, null)
    return 'Keep-warm off.'
  }
  const capMs = arg === '' ? DEFAULT_CAP_MS : capFrom(arg)
  if (capMs === null) return WARM_USAGE
  await setCap($, capMs)
  return `Keep-warm on: up to ${capMs / HOUR_MS}h of idle time, this session only.`
}

/** `off` is no cap: `capFrom` answers null for it. */
const pickWarm = ($: EngineInterface, value: string): Promise<void> => setCap($, capFrom(value))

const toggleWarm = async ($: EngineInterface): Promise<void> => {
  const w = await read($, warm)
  await setCap($, w.capMs === null ? DEFAULT_CAP_MS : null)
}

/** Never throws: a band that cannot note a call must not stop the call. */
const noteTool = async ($: EngineInterface, run: Omit<ToolRun, 'startedAt'>): Promise<void> => {
  try {
    const startedAt = await $.clock.now()
    await update($, tools, list => [...list, { ...run, startedAt }])
  } catch {
    // The row just misses this call.
  }
}

const dropTool = async ($: EngineInterface, id: number): Promise<void> => {
  try {
    await update($, tools, list => list.filter(t => t.id !== id))
  } catch {
    // A stale row beats a failed tool.
  }
}

/** `summary` counts locally and sends no request; `full` would call the token-count API. */
const refreshMix = async ($: EngineInterface): Promise<void> => {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  const breakdown = usage?.context.breakdown
  if (!breakdown) return
  const rows = breakdown.categories.filter(c => c.kind === 'used' && c.tokens > 0).map(c => ({ name: c.name, tokens: c.tokens }))
  await update($, mix, () => ({ rows, window: breakdown.rawMaxTokens }))
}

/** Keeps the time of each skip on disk, the only trace that a compaction would have run. */
const recordSkip = async ($: EngineInterface, at: number): Promise<void> => {
  try {
    const old = ((await $.store.get(COMPACT_SKIPS)) ?? []) as number[]
    await $.store.set(COMPACT_SKIPS, [...old, at].slice(-PING_LOG_MAX))
  } catch {
    // The skip stands without its record.
  }
}

const pull = async ($: EngineInterface): Promise<void> => {
  const u = await $.session.usage()
  await update($, windows, () => clean(u.rateLimits))
}

/** Fresh context figures from the engine onto the cache facts, when it has them. */
const measure = async ($: EngineInterface, lastAt: number | null, model: string | null): Promise<void> => {
  const u = await $.session.usage()
  const m = model ?? (await $.session.model())
  await update($, cache, c => ({
    lastAt: lastAt ?? c?.lastAt ?? 0,
    tokens: u.context.tokens && u.context.tokens > 0 ? u.context.tokens : (c?.tokens ?? 0),
    window: u.context.window || c?.window || 0,
    model: m || c?.model || null,
    hit: c?.hit ?? null,
    costUsd: u.cost?.usd ?? c?.costUsd,
  }))
}

export const register: Register = (on, options) => {
  const warnMin = warnMinutesOf(options.warnMinutes)
  // The module variable resets on reload, which at worst lets one warning through mid-turn.
  let inTurn = false
  const guard: PingGuard = { isPinging: false }
  let toolSeq = 0
  let mixAt = -Infinity

  on('session.start', async ($, e, next) => {
    // Timer first: a failed read or registration must not stop the band ticking.
    $.clock.every(TICK_MS, async () => {
      $.ui.invalidate('ui.render')
      try {
        // In this order: a ping at 50 minutes idle lands before a warning due in the same tick.
        await pingIfDue($, guard, inTurn)
        if (!inTurn) await warnIfDue($, warnMin)
      } catch {
        // The next tick tries again.
      }
    })
    await pull($).catch(() => null)
    await $.command.register({ name: 'agents-panel', description: 'Show or hide the subagents panel' }).catch(() => null)
    await $.command.register({ name: 'keep-warm', description: 'Keep this idle session\'s cache warm: 1h to 12h, off, or ping' }).catch(() => null)
    return next(e)
  })

  on('command.run', { command: 'keep-warm' }, async ($, e) => ({ text: await warmCommand($, e.args, guard) }))

  // Only a prompt reopens the idle window. A turn would not do: nothing here can rule
  // out a fork raising turn events, and that would let the pings run on for ever.
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command) return next(e) // a wake or a slash command is not the person returning
    const now = await $.clock.now()
    await update($, warm, w => ({ ...w, lastPromptAt: now }))
    return next(e)
  }).catch(($, e, next) => next(e)) // the band never holds up a prompt

  on('command.run', { command: 'agents-panel' }, async $ => {
    await togglePane($)
    return { text: 'Agents panel toggled.' }
  })

  // The app summarises an idle session over 200k at 54 minutes, which would swap out the
  // very context keep-warm holds. Only that ahead-of-time pass stops; the threshold's runs.
  on('session.compact', { trigger: 'precompute' }, async ($, e, next) => {
    const w = await read($, warm)
    const now = await $.clock.now()
    if (e.agentId || w.capMs === null || now - w.lastPromptAt >= w.capMs) return next(e)
    await recordSkip($, now)
    return { skip: 'keep-warm is holding this session' }
  })

  on('classic.Stop', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, background, held => backgroundFrom(e.background_tasks ?? [], held, now))
    } catch {
      // The row keeps its last list; a turn must still end.
    }
    return next(e)
  })

  // No .catch: running `next` a second time would run the tool twice. The helpers never throw.
  on('tool.call', async ($, e, next) => {
    if (!isWatched(e.tool)) return next(e)
    const id = ++toolSeq
    await noteTool($, { id, name: e.tool })
    try {
      return await next(e)
    } finally {
      await dropTool($, id)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    // After next the agent runs, so this stays out of a .catch that would start it twice.
    try {
      const at = await $.clock.now()
      const id = started.agentId ?? e.tool_use_id
      await update($, agents, list => {
        const old = list.find(a => a.id === id) // a resumed agent keeps its totals
        const run: AgentRun = old
          ? { ...old, model: started.model, status: 'running', endedAt: undefined }
          : { id, description: e.description, model: started.model, status: 'running', startedAt: at, tokens: 0, costUsd: 0 }
        return [...list.filter(a => a.id !== id), run].slice(-100)
      })
    } catch {
      // The panel misses one row; the spawn stands.
    }
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) inTurn = true
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, windows, () => clean(e.rateLimits))
    }
    if (e.changed.includes('context') && e.context.tokens && e.context.tokens > 0) {
      const tokens = e.context.tokens
      await update($, cache, c => (c ? { ...c, tokens, window: e.context.window || c.window } : c))
    }
    return next(e)
  })

  // A resumed or forked session knows how long it was away and how big it is.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, cache, () => null)
      await update($, fold, () => null)
      await update($, mix, () => null)
      if (e.source === 'clear') await update($, warm, w => ({ ...w, capMs: null }))
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      const window = (await $.session.usage()).context.window
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      const tokens = typeof e.context_tokens === 'number' ? e.context_tokens : 0
      await update($, cache, () => ({ lastAt, tokens, window, model }))
    }
    return r
  }).catch(($, e, next) => next(e)) // a band that fails to seed never holds up the session

  // The cache's hour runs from a request's start, but only a request that got a
  // response touched it, so the start time lands once the usage has come back.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const startedAt = await $.clock.now()
    const result = yield* next(e)
    // Read here, as the app's own list does: the tool itself can queue behind a long command.
    if (!agentId) {
      const now = await $.clock.now()
      for (const use of result.toolUses) {
        if (use.name === UPDATE_PLAN) await update($, plan, p => applyPlan(p, use.input as Record<string, unknown>, now))
        // The app ticks every step when a turn wraps up.
        if (use.name === WRAP_UP) await update($, plan, p => (p ? applyPlan(p, { done: p.steps.map((_, i) => i + 1) }, now) : p))
      }
    }
    const usage = result.usage
    if (!usage) return result
    if (agentId) {
      await update($, agents, list => list.map(a => (a.id === agentId ? addUsage(a, usage.model || e.model, usage) : a)))
    } else {
      const sent = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      const hit = sent > 0 ? Math.round((usage.cache_read_input_tokens / sent) * 100) : null
      // The first reply is the first time the size is known, so read the window once here:
      // waiting for a turn to end would keep a new session's ribbon bare through its first turn.
      const held = await read($, cache)
      const window = held?.window || ((await $.session.usage().catch(() => null))?.context.window ?? 0)
      await update($, cache, c => ({
        lastAt: startedAt,
        tokens: sent || (c?.tokens ?? 0),
        window,
        model: c?.model ?? null,
        hit,
        costUsd: c?.costUsd,
      }))
      // A long turn would otherwise leave the panel far behind the ribbon's token count.
      if (startedAt - mixAt >= MIX_REFRESH_MS) {
        mixAt = startedAt
        await refreshMix($)
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) inTurn = false
    const r = await next(e)
    if (e.agentId) {
      const at = await $.clock.now()
      const status: AgentStatus = e.reason === 'answer' ? 'done' : 'failed'
      await update($, agents, list => list.map(a => (a.id === e.agentId ? { ...a, status, endedAt: at } : a)))
      return r
    }
    // Every turn ends its list, however it ended; the next turn sends a new one.
    await update($, plan, () => null)
    await update($, tools, () => [])
    await refreshMix($)
    const now = await $.clock.now()
    const c = await read($, cache)
    // turn.step stamps the exact request time; a turn that answered with no step seen floors at its end.
    const lastAt = e.usage && (!c || now - c.lastAt > e.durationMs) ? now : (c?.lastAt ?? null)
    await measure($, lastAt, e.usage?.model ?? null)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = ordered(await read($, agents))
    const now = await $.clock.now()
    if (list.length === 0) return <Text dimColor>No subagents yet.</Text>

    const width = Math.max(20, (e.props.bodyColumns ?? 60) - 34)
    return (
      <Box flexDirection="column">
        {list.map(a => (
          <Box key={a.id} flexDirection="row">
            <Text color={a.status === 'failed' ? ERROR : a.status === 'done' ? MUTED : ACCENT}>
              {a.status === 'running' ? '▸' : a.status === 'done' ? '✔' : '✗'}{' '}
            </Text>
            <Text>{clip(a.description, width)} </Text>
            <Text dimColor>
              {a.model.replace('claude-', '')} · {fmtSpan((a.endedAt ?? now) - a.startedAt)} · {Math.round(a.tokens / 1000)}k
              {a.costUsd === null ? '' : ` · ≈${usd(a.costUsd)}`}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Svg draws on desktop, mobile and VS Code; the terminal gets the text form.
    // Ask the surface, not the table: the terminal's table still lists Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    // The mobile app draws no picker, so it keeps the on and off button.
    const Select = e.surface !== 'mobile' && 'Select' in ui ? ui.Select : null
    const list = await read($, windows)
    const now = await $.clock.now()
    const facts = await read($, cache)
    const view = viewOf(facts, now)
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100

    const crew = await read($, agents)
    const runningAgents = crew.filter(a => a.status === 'running').length
    const agentsButton =
      runningAgents > 0 ? (
        <Box key="agents" flexShrink={0} marginRight={1}>
          <Button key="agents-toggle" label={`Agents ${runningAgents}`} onPress={() => togglePane($)} />
        </Box>
      ) : null

    const sep = (key: string) => <Text key={key} color={MUTED}>{'  │  '}</Text>
    // Drawings where the surface has them; text in a terminal.
    const bar = (key: string, percent: number, cells: number, width: number, colour: string, alt: string) => {
      if (Svg) {
        const t = ticksSvg(percent, width, colour)
        return <Svg key={key} source={t.source} alt={alt} width={t.w} height={t.h} />
      }
      const d = dots(percent, cells)
      return [<Text key={`${key}-on`} color={colour}>{d.on}</Text>, <Text key={`${key}-off`} color={EMPTY}>{d.off}</Text>]
    }
    const busy = runningLabel(await read($, tools), crew, await read($, background), now)
    const busyPart = busy ? <Text key="busy" color={MUTED}>{busy}</Text> : null

    const steps = await read($, plan)
    const step = steps && e.props.isWorking ? currentOf(steps) : undefined
    let planRow = busyPart ? <Box key="plan" flexDirection="row" paddingX={1}>{busyPart}</Box> : null
    if (steps && step) {
      const done = doneOf(steps)
      const total = steps.steps.length
      const eta = etaMs(steps, now)
      planRow = (
        <Box key="plan" flexDirection="row" paddingX={1} alignItems="center">
          <Text color={ACCENT}>▸ </Text>
          <Text color={TEXT}>{clip(step.content, Math.max(12, columns - 34))} </Text>
          {bar('plan-bar', (done / total) * 100, TIGHT_CELLS, TIGHT_BAR_W, ACCENT, `${done} of ${total} steps done`)}
          <Text color={MUTED}> {done}/{total}</Text>
          {eta ? <Text color={MUTED}> · ~{fmtSpan(eta)} left</Text> : null}
          {busyPart ? sep('sep-busy') : null}
          {busyPart}
        </Box>
      )
    }

    if (list.length === 0 && !view) {
      return (
        <Box flexDirection="column">
          {planRow}
          <Box flexDirection="row" paddingX={1}>
            <Text color={MUTED}>waiting for the first reply</Text>
            <Box flexGrow={1} />
            {agentsButton}
          </Box>
        </Box>
      )
    }

    const kind = kindOf(columns)
    const isWide = kind === 'wide'
    const cells = kind === 'tight' ? TIGHT_CELLS : CELLS

    const parts = (w: Window) => {
      const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
      return {
        left,
        used: Math.round(w.percentUsed * 10) / 10,
        col: left < LOW_AT ? WARN : ACCENT,
        name: NAMES[w.kind] ?? w.kind.toUpperCase(),
        reset: fmtReset(w.resetsAt, now),
      }
    }

    // Wide: every window on one row. Narrow: each window is a block of three
    // lines (name and dots, percent left, reset time) so nothing wraps or clips.
    const wide = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="row" flexShrink={0} alignItems="center">
          <Text color={MUTED} bold>{p.name} </Text>
          {bar(`bar-${i}`, p.used, cells, BAR_W, p.col, `${p.name} ${p.used}% used, ${p.left}% left`)}
          <Text color={p.col} bold> {p.left}% left</Text>
          {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          {p.reset ? <Text color={MUTED}> · {p.reset}</Text> : null}
        </Box>
      )
    }

    const stacked = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="column" flexShrink={0} marginRight={3}>
          <Box flexDirection="row" alignItems="center">
            <Text color={MUTED} bold>{p.name} </Text>
            {bar(`bar-${i}`, p.used, cells, kind === 'tight' ? TIGHT_BAR_W : BAR_W, p.col, `${p.name} ${p.used}% used, ${p.left}% left`)}
          </Box>
          <Box flexDirection="row">
            <Text color={p.col} bold>{p.left}% left</Text>
            {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          </Box>
          {p.reset ? <Text color={MUTED}>resets {p.reset}</Text> : null}
        </Box>
      )
    }

    const usage = list.length > 0
      ? list.flatMap((w, i) => (isWide ? [i > 0 ? sep(`sep-${i}`) : null, wide(w, i)] : [stacked(w, i)]))
      : [<Box key="wait" flexShrink={0} marginRight={3}><Text color={MUTED}>waiting for the first reply</Text></Box>]

    // Before the first reply there is no cache to show: today's band, as it was.
    if (!view) {
      return (
        <Box flexDirection="column">
          {planRow}
          <Box flexDirection="row" paddingX={1}>
            {usage}
            <Box flexGrow={1} />
            {agentsButton}
          </Box>
        </Box>
      )
    }

    const mode = view.mode
    const cold = mode === 'cold'
    const hue = HUE[mode]
    const mine = mineModel(view)
    const minsLeft = Math.max(0, TTL_MIN - view.idleMin)
    const hitValue = cold ? null : (facts?.hit ?? null)
    const hitLabel = hitValue === null ? null : `${hitValue}% hit`
    const isHitLow = hitValue !== null && hitValue < HIT_LOW_AT
    const fillLabel = view.window > 0 ? `${tok(view.tokens)} · ${Math.round((view.tokens / view.window) * 100)}%` : null
    // shortcut: these widths are estimates in cells; measure them if a wide row still overflows.
    const capMs = (await read($, warm)).capMs
    const capValue = capMs === null ? 'off' : `${capMs / HOUR_MS}h`
    const picks = WARM_PICKS.includes(capValue) ? WARM_PICKS : [...WARM_PICKS, capValue]
    const warmButton = (
      <Box key="warm" flexShrink={0} marginRight={1}>
        {Select ? (
          <Select
            key="warm-pick"
            label="Ember"
            value={capValue}
            options={picks.map(value => ({ value, label: value === 'off' ? 'Off' : value }))}
            onSelect={value => pickWarm($, value)}
          />
        ) : (
          <Button key="warm-toggle" label={capMs === null ? 'Ember' : `Ember ${capMs / HOUR_MS}h`} onPress={() => toggleWarm($)} />
        )}
      </Box>
    )
    // The tokens always show; only what is left after them is spare.
    const spare = columns - ROW_CELLS - WARM_CELLS - FILL_CELLS - Math.max(1, list.length) * WINDOW_CELLS - (agentsButton ? AGENTS_CELLS : 0)
    const showHit = kind !== 'wide' || spare >= HIT_CELLS
    const composition = await read($, mix)
    const showMini = kind === 'wide' && spare >= HIT_CELLS + MINI_CELLS
    const mini = Svg && composition && showMini ? contextMiniSvg(composition) : null
    const costLabel = showMini && facts?.costUsd !== undefined && spare >= HIT_CELLS + MINI_CELLS + COST_CELLS ? ` · ${usd(facts.costUsd)}` : null
    const stored = await read($, fold)
    // Folding needs the card, and the card is a drawing: the terminal stays folded.
    const open = Svg !== null && (stored && stored.mode === mode ? stored.open : cold)
    const toggle = () =>
      update($, fold, f => ({ mode, open: !(f && f.mode === mode ? f.open : mode === 'cold') }))

    const badge = Svg
      ? [
          <Svg key="robo" source={roboSvg(mode)} alt={cold ? 'Robo, frozen' : 'Robo, bobbing'} width={ROBO_SIZE} height={ROBO_SIZE} isInteractive />,
          <Text key="gap"> </Text>,
          (() => {
            const c = chipSvg(mode)
            return <Svg key="chip" source={c.source} alt={WORD[mode]} width={c.w} height={c.h} />
          })(),
        ]
      : [<Text key="chip" backgroundColor={hue} color={INK} bold>{` ${WORD[mode]} `}</Text>]

    const summary = cold
      ? [
          <Text key="idle" color={hue} bold>{` ${view.idle}`}</Text>,
          mine ? <Text key="dot" color={MUTED}> · </Text> : null,
          mine ? <Text key="cost" color={TEXT} bold>{usd(costOf(mine, mode, view.tokens))}</Text> : null,
        ]
      : [
          <Text key="left" color={warnMin !== null && minsLeft <= warnMin ? WARN : hue} bold>{` ${minsLeft}m`}</Text>,
          hitLabel && showHit ? (
            <Text key="hit" color={isHitLow ? TEXT : MUTED} bold={isHitLow}>{` · ${hitLabel}`}</Text>
          ) : null,
        ]
    const fill = fillLabel ? <Text key="fill" color={TEXT}>{fillLabel}</Text> : null

    const button = Svg ? (
      <Box key="fold" flexShrink={0} alignItems="flex-start">
        <Button key="cache-fold" label={open ? '✕' : 'ⓘ'} plain dimColor onPress={toggle} />
      </Box>
    ) : null
    const grow = <Box key="grow" flexGrow={1} />

    let rows
    if (kind === 'wide') {
      rows = (
        <Box key="row" flexDirection="row" paddingX={1} alignItems="center">
          <Box key="usage" flexDirection="row" flexShrink={0}>{usage}</Box>
          {fill ? sep('sep-fill') : null}
          {fill ? (
            <Box key="context" flexDirection="row" flexShrink={0} alignItems="center">
              {fill}
              {mini && Svg ? <Text key="mini-gap"> </Text> : null}
              {mini && Svg ? <Svg key="mix" source={mini.source} alt={mini.alt} width={mini.w} height={mini.h} /> : null}
              {costLabel ? <Text key="cost" color={MUTED}>{costLabel}</Text> : null}
            </Box>
          ) : null}
          {open ? null : sep('sep-cache')}
          {open ? null : (
            <Box key="inline" flexDirection="row" flexShrink={0} alignItems="center">
              {badge}
              {summary}
            </Box>
          )}
          {grow}
          <Box key="controls" flexDirection="row" flexShrink={0} alignItems="center">
            {warmButton}
            {agentsButton}
            {button}
          </Box>
        </Box>
      )
    } else if (kind === 'stacked') {
      // The cache becomes a third stacked block, the same shape as 7D and 5H.
      rows = (
        <Box key="row" flexDirection="row" paddingX={1}>
          {usage}
          {open ? null : (
            <Box key="block" flexDirection="column" flexShrink={0} marginRight={2}>
              <Box flexDirection="row" alignItems="center">{badge}</Box>
              <Text color={hue} bold>{cold ? `${view.idle} idle` : `${Math.max(0, TTL_MIN - view.idleMin)}m`}</Text>
              {mine ? (
                <Box flexDirection="row">
                  <Text color={TEXT} bold>{usd(costOf(mine, mode, view.tokens))}</Text>
                  <Text color={MUTED}> next</Text>
                </Box>
              ) : null}
              {hitLabel || fillLabel ? <Text color={MUTED}>{[hitLabel, fillLabel].filter(Boolean).join(' · ')}</Text> : null}
            </Box>
          )}
          {grow}
          {warmButton}
          {agentsButton}
          {button}
        </Box>
      )
    } else {
      // Narrow: the cache gets its own row under the usage blocks.
      rows = [
        <Box key="row" flexDirection="row" paddingX={1}>
          {usage}
        </Box>,
        <Box key="cache" flexDirection="row" paddingX={1} alignItems="center">
          {badge}
          {summary}
          {fill ? sep('sep-fill') : null}
          {fill}
          {grow}
          {warmButton}
          {agentsButton}
          {button}
        </Box>,
      ]
    }

    let card = null
    if (open && Svg) {
      const c = cardSvg(view)
      const panel = composition && composition.rows.length > 0 ? contextPanelSvg(composition) : null
      card = (
        <Box key="card" flexDirection="column" paddingX={1}>
          {panel ? <Svg key="context" source={panel.source} alt={panel.alt} /> : null}
          <Svg key="cache-card" source={c.source} alt={c.alt} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {planRow}
        {rows}
        {card}
      </Box>
    )
  })
}
