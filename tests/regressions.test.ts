// Defects an independent review found, each pinned by a test that failed first.
import type { On, SessionRateLimit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cardSvg } from '../hooks/cache-art'
import { contextPanelSvg } from '../hooks/context-art'

import { applyPlan, etaMs } from '../hooks/plan'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const MIN = 60_000
const MODEL = 'claude-opus-5-5'
const UPDATE = 'mcp__ccd_turn__update_plan'
const ITEMS = [
  { content: 'Read the code', status: 'in_progress' },
  { content: 'Ship it', status: 'pending' },
]
const HIT = { input_tokens: 100_000, output_tokens: 500, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 }
const TWO = [
  { kind: 'seven_day', percentUsed: 64, resetsAt: '2099-01-02T00:00:00Z' },
  { kind: 'five_hour', percentUsed: 18, resetsAt: '2099-01-01T01:00:00Z' },
]
const props = (isWorking: boolean, bodyColumns = 120) =>
  ({ hasSurvey: false, isWorking, maxRows: 8, bodyColumns, scroll: { offset: 0, bodyRows: 8 }, view: {} }) as const

type Options = { tokens?: number; usage?: typeof HIT | null; rateLimits?: SessionRateLimit[]; cost?: number; categories?: object[]; hold?: Promise<void> }

let uses: object[] = []
const start = async ($: Engine, on: On, o: Options = {}) => {
  uses = []
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const sent: string[] = []
  const usage = o.usage === undefined ? HIT : o.usage
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  on('session.cwd', () => ({ value: '/home/k/demo' }) as never)
  on('session.model', () => ({ value: MODEL }) as never)
  const asked: unknown[] = []
  on('session.usage', (_, e) => {
    asked.push(e?.breakdown)
    return {
      value: {
        startedAt: 0,
        context: { window: 1_000_000, tokens: o.tokens ?? 300_000, breakdown: e?.breakdown && o.categories ? { categories: o.categories } : undefined },
        rateLimits: o.rateLimits ?? [],
        cost: o.cost === undefined ? undefined : { usd: o.cost },
      },
    } as never
  })
  on('ui.notify', (_, e) => {
    sent.push(e.text)
    return { value: { isSent: true, channel: 'test' } } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('tool.call', async () => {
    await o.hold
    return { result: {} }
  })
  on('classic.Stop', () => ({}) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }) as never)
  on('turn.step', async function* () {
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: uses,
      stopReason: usage ? 'end_turn' : null,
      usage: usage ? { model: MODEL, ...usage } : null,
    } as never
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/home/k/demo' })
  return { clock, sent, asked }
}
const step = async ($: Engine, agentId?: string) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: MODEL, messageCount: 1, agentId })
  for await (const _ of stream) void _
}
const say = async ($: Engine, input: object, agentId?: string) => {
  uses = [{ name: UPDATE, input }]
  await step($, agentId)
  uses = []
}
const end = ($: Engine, reason: string, agentId?: string, usage?: object) =>
  ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason, answer: '', durationMs: 1000, isAborted: reason === 'aborted', turnId: 't', agentId, usage })
const turnStart = ($: Engine, agentId?: string) =>
  ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 't', text: 'x', agentId })
const reply = async ($: Engine) => {
  await step($)
  await end($, 'answer', undefined, { model: MODEL, ...HIT })
}
const band = ($: Engine, isWorking = false, bodyColumns = 120) =>
  $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: props(isWorking, bodyColumns) })

for (const reason of ['aborted', 'error', 'answer']) {
  test(`a turn that ends with ${reason} leaves no stale step for the next turn`, async ($, on) => {
    await start($, on)
    await say($, { items: ITEMS, scope: 'first_task' })
    await end($, reason)

    const ui = await band($, true)
    expect(await ui.find({ type: 'Text', text: /Read the code/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('a subagent ending its own turn leaves the main plan alone', async ($, on) => {
  await start($, on)
  await say($, { items: ITEMS, scope: 'first_task' })
  await end($, 'answer', 'a1')

  const ui = await band($, true)
  expect(await ui.find({ type: 'Text', text: /Read the code/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent update_plan does not replace the main plan', async ($, on) => {
  await start($, on)
  await say($, { items: ITEMS, scope: 'first_task' })
  await say($, { items: [{ content: 'Sub step', status: 'in_progress' }] }, 'a1')

  const ui = await band($, true)
  expect(await ui.find({ type: 'Text', text: /Read the code/ })).toBeDefined()
  await ui.unmount()
})

test('a failed request does not turn a cold cache warm', async ($, on) => {
  const { clock } = await start($, on, { usage: null })
  // Seed a real exchange through turn.complete, then let the cache lapse.
  await end($, 'answer', undefined, { model: MODEL, ...HIT })
  await clock.advance(70 * MIN)
  await step($)
  await end($, 'error')

  const ui = await band($)
  // A cold cache opens its card, which takes the place of the inline chip.
  const alts = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect(alts.some(alt => alt.startsWith('Cache cold.'))).toBe(true)
  await ui.unmount()
})

test('a subagent request does not restart the main cache clock', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await clock.advance(20 * MIN)
  await step($, 'a1')

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /^ 40m$/ })).toBeDefined()
  await ui.unmount()
})

test('the hit share counts uncached input', async ($, on) => {
  await start($, on)
  await reply($)

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /75% hit/ })).toBeDefined()
  await ui.unmount()
})

test('the countdown stays its usual colour outside the warning window', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await clock.advance(20 * MIN)

  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /^ 40m$/ }))?.props.color).not.toBe('#d0a85c')
  await ui.unmount()
})

test('warnings resume once a turn has ended', async ($, on) => {
  const { clock, sent } = await start($, on)
  await turnStart($)
  await reply($)

  await clock.advance(52 * MIN)
  expect(sent.length).toBe(1)
})

test('a subagent turn does not hold back a warning', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await turnStart($, 'a1')

  await clock.advance(52 * MIN)
  expect(sent.length).toBe(1)
})

test('a cache already cold does not warn', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await turnStart($)
  await clock.advance(65 * MIN)
  await end($, 'aborted')

  await clock.advance(MIN)
  expect(sent).toEqual([])
})

test('a resumed agent keeps its tokens and start time', async ($, on) => {
  await start($, on)
  const spawn = (resume?: object) =>
    $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Verify', subagentType: 'general-purpose', resume } as never)
  await spawn()
  await step($, 'a1')
  await end($, 'answer', 'a1')
  await spawn({ agentId: 'a1' })

  const ui = await $.ui.mount({
    plugin: 'emberline',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'emberline-agents',
    props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /401k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▸/ })).toBeDefined()
  await ui.unmount()
})

test('the stacked layout still shows hit share and context fill', async ($, on) => {
  await start($, on)
  await reply($)

  const ui = await band($, false, 60)
  expect(await ui.find({ type: 'Text', text: /75% hit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /300k · 30%/ })).toBeDefined()
  await ui.unmount()
})

test('the tight layout still shows context fill', async ($, on) => {
  await start($, on)
  await reply($)

  const ui = await band($, false, 36)
  expect(await ui.find({ type: 'Text', text: /300k · 30%/ })).toBeDefined()
  await ui.unmount()
})

test('a wide row with room puts tokens and fill beside the usage', async ($, on) => {
  await start($, on)
  await reply($)

  const ui = await band($, false, 140)
  expect(await ui.find({ type: 'Text', text: /^300k · 30%$/ })).toBeDefined()
  await ui.unmount()
})

test('a wide row short of room keeps tokens and drops the hit share first', async ($, on) => {
  await start($, on)
  await reply($)

  const ui = await band($, false, 90)
  expect(await ui.find({ type: 'Text', text: /^300k · 30%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /% hit/ })).toBeUndefined()
  await ui.unmount()
})

test('a wide row without room keeps the tokens and drops the extras', async ($, on) => {
  await start($, on, { rateLimits: TWO, categories: CATEGORIES })
  await reply($)

  const ui = await band($, false, 100)
  expect(await ui.find({ type: 'Text', text: /^300k · 30%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /% hit/ })).toBeUndefined()
  expect((await ui.findAll({ type: 'Svg' })).some(s => String(s.props.alt).startsWith('Context mix'))).toBe(false)
  expect(await ui.find({ key: 'cache-fold' })).toBeDefined()
  await ui.unmount()
})

test('the estimate holds the steps still ahead once a step overruns', async () => {
  let p = applyPlan(null, { items: [...ITEMS, { content: 'Third', status: 'pending' }] }, 0)
  p = applyPlan(p, { advance: true }, 60_000)
  // Two steps left at a 60s median, 150s into the current one: one whole step remains.
  expect(etaMs(p, 210_000)).toBe(60_000)
})

test('the estimate uses the median, not the latest step', async () => {
  const items = [1, 2, 3, 4].map((n, i) => ({ content: `S${n}`, status: i ? 'pending' : 'in_progress' }))
  let p = applyPlan(null, { items }, 0)
  p = applyPlan(p, { advance: true }, 10_000)
  p = applyPlan(p, { advance: true }, 30_000)
  p = applyPlan(p, { advance: true }, 120_000)
  // Durations 10s, 20s, 90s: median 20s, one step left, none of it spent.
  expect(etaMs(p, 120_000)).toBe(20_000)
})

const CATEGORIES = [
  { name: 'Messages', tokens: 120_000, kind: 'used' },
  { name: 'System tools', tokens: 22_000, kind: 'used' },
  { name: 'Skills', tokens: 400, kind: 'used' },
  { name: 'Free space', tokens: 800_000, kind: 'free' },
  { name: 'MCP tools', tokens: 9000, kind: 'deferred' },
  { name: 'Agents', tokens: 0, kind: 'used' },
]
const tool = ($: Engine, name: string, agentId?: string) =>
  ($.tool.call as (e: unknown) => Promise<unknown>)({ tool: name, input: {}, agentId })

test('the details draw what fills the context, counted without an API call', async ($, on) => {
  const { asked } = await start($, on, { categories: CATEGORIES })
  await reply($)

  const ui = await band($)
  const alts = async () => (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect((await alts()).some(a => a.startsWith('Context panel'))).toBe(false)

  await ui.press({ key: 'cache-fold' })
  const panel = (await alts()).find(a => a.startsWith('Context panel'))
  expect(panel).toBe('Context panel: Messages 120k, System tools 22k, Skills 400')
  expect(asked).toContain('summary')
  expect(asked).not.toContain('full')
  await ui.unmount()
})

const MIX = {
  window: 1_000_000,
  rows: [
    { name: 'Messages', tokens: 281_000 },
    { name: 'System tools', tokens: 30_000 },
    { name: 'Skills', tokens: 10_000 },
    { name: 'MCP server instructions', tokens: 1000 },
    { name: 'Agents', tokens: 900 },
  ],
}
const textsOf = (source: string) => [...source.matchAll(/<text[^>]*>([^<]*)</g)].map(m => m[1])

test('the panel folds categories under 1% into Other', async () => {
  const texts = textsOf(contextPanelSvg(MIX).source)
  expect(texts).toContain('Skills')
  expect(texts).not.toContain('MCP server instructions')
  expect(texts).not.toContain('Agents')
  expect(texts).toContain('Other')
  expect(texts).toContain('2k')
})

test('the panel draws no Other when every category shows', async () => {
  const texts = textsOf(contextPanelSvg({ window: 1000, rows: MIX.rows.slice(0, 3) }).source)
  expect(texts).not.toContain('Other')
})

test('the details are short enough to fit together', async () => {
  const card = cardSvg({ mode: 'warm', idle: '1m', idleMin: 1, tokens: 358_000, window: 1_000_000, mine: 'opus' })
  expect(contextPanelSvg(MIX).h + card.h).toBeLessThan(160)
  expect(card.w).toBe(720)
})

test('the details drawings set no height, so they take the height they are drawn at', async ($, on) => {
  await start($, on, { categories: CATEGORIES })
  await reply($)

  const ui = await band($)
  await ui.press({ key: 'cache-fold' })
  const big = (await ui.findAll({ type: 'Svg' })).filter(s => /^(Context panel|Cache)/.test(String(s.props.alt)))
  expect(big.length).toBe(2)
  expect(big.some(s => s.props.height !== undefined)).toBe(false)
  await ui.unmount()
})

test('the ribbon draws the context mix when there is room, and not when short of it', async ($, on) => {
  await start($, on, { categories: CATEGORIES })
  await reply($)
  const mix = async (columns: number) => {
    const ui = await band($, false, columns)
    const found = (await ui.findAll({ type: 'Svg' })).some(s => String(s.props.alt).startsWith('Context mix'))
    await ui.unmount()
    return found
  }
  expect(await mix(140)).toBe(true)
  expect(await mix(100)).toBe(false)
})

test('a plan update moves the row when the model asks, not when the tool runs', async ($, on) => {
  await start($, on)
  await say($, { items: ITEMS, scope: 'first_task' })
  await say($, { done: [1], start: 2 })

  const ui = await band($, true)
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeDefined()
  await ui.unmount()
})

test('finishing the turn ticks every step, as the app does', async ($, on) => {
  await start($, on)
  await say($, { items: ITEMS, scope: 'first_task' })
  uses = [{ name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Done.' } }]
  await step($)
  uses = []

  const ui = await band($, true)
  expect(await ui.find({ type: 'Text', text: /Read the code/ })).toBeUndefined()
  await ui.unmount()
})

test('another tool with a plan-shaped input leaves the row alone', async ($, on) => {
  await start($, on)
  await say($, { items: ITEMS, scope: 'first_task' })
  uses = [{ name: 'Read', input: { items: [{ content: 'Not a plan', status: 'in_progress' }] } }]
  await step($)
  uses = []

  const ui = await band($, true)
  expect(await ui.find({ type: 'Text', text: /Not a plan/ })).toBeUndefined()
  await ui.unmount()
})

test('the mix fits before the cost does', async ($, on) => {
  await start($, on, { cost: 18.2, categories: CATEGORIES })
  await reply($)

  const ui = await band($, false, 112)
  expect((await ui.findAll({ type: 'Svg' })).some(s => String(s.props.alt).startsWith('Context mix'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /\$18/ })).toBeUndefined()
  await ui.unmount()
})

const stop = ($: Engine, tasks: object[]) =>
  ($.classic.Stop as (e: unknown) => Promise<unknown>)({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: tasks })
const SHELL = { id: 'b1', type: 'shell', status: 'running', description: 'Run the test suite', command: 'bun test' }

test('background work shows on the upper row until a turn ends without it', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await stop($, [SHELL, { id: 'a9', type: 'subagent', status: 'running', description: 'Review' }])
  await clock.advance(180_000)

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /Run the test suite 3m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Review/ })).toBeUndefined()

  await stop($, [SHELL])
  expect(await ui.find({ type: 'Text', text: /Run the test suite 3m/ })).toBeDefined()
  await stop($, [])
  expect(await ui.find({ type: 'Text', text: /Run the test suite/ })).toBeUndefined()
  await ui.unmount()
})

test('a shell with no description shows its command', async ($, on) => {
  await start($, on)
  await reply($)
  await stop($, [{ id: 'b2', type: 'shell', status: 'running', description: '', command: 'npm run dev' }])

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /npm run dev/ })).toBeDefined()
  await ui.unmount()
})

test('the ribbon shows the session cost when there is room', async ($, on) => {
  await start($, on, { cost: 18.2 })
  await reply($)

  const ui = await band($, false, 140)
  expect(await ui.find({ type: 'Text', text: /^ · \$18\.20$/ })).toBeDefined()
  await ui.unmount()
})

test('a short row drops the cost before anything else', async ($, on) => {
  await start($, on, { cost: 18.2 })
  await reply($)

  const ui = await band($, false, 100)
  expect(await ui.find({ type: 'Text', text: /\$18/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /% hit/ })).toBeDefined()
  await ui.unmount()
})

test('a slow connector call shows on the upper row, even between turns', async ($, on) => {
  let release = () => {}
  const hold = new Promise<void>(r => { release = r })
  const { clock } = await start($, on, { hold })
  await reply($)

  const call = tool($, 'mcp__dd72da63__getJiraIssue')
  await clock.advance(31_000)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /getJiraIssue 31s/ })).toBeDefined()

  release()
  await call
  expect(await ui.find({ type: 'Text', text: /getJiraIssue/ })).toBeUndefined()
  await ui.unmount()
})

test('a quick call and the app own tools stay off the upper row', async ($, on) => {
  let release = () => {}
  const hold = new Promise<void>(r => { release = r })
  const { clock } = await start($, on, { hold })
  await reply($)

  const calls = [tool($, 'Bash'), tool($, 'mcp__ccd_turn__wrap_up'), tool($, 'Read')]
  await clock.advance(2000)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeUndefined()
  await clock.advance(30_000)
  await ui.unmount()
  const later = await band($)
  expect(await later.find({ type: 'Text', text: /Bash 32s/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /wrap_up/ })).toBeUndefined()
  expect(await later.find({ type: 'Text', text: /Read/ })).toBeUndefined()
  release()
  await Promise.all(calls)
  await later.unmount()
})

test('a call that fails still leaves the upper row', async ($, on) => {
  const hold = Promise.reject(new Error('boom'))
  hold.catch(() => {})
  const { clock } = await start($, on, { hold })
  await reply($)

  await tool($, 'Bash').catch(() => null)
  await clock.advance(31_000)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeUndefined()
  await ui.unmount()
})

test('a main turn ending clears any tool row left behind', async ($, on) => {
  const hold = new Promise<void>(() => {})
  const { clock } = await start($, on, { hold })
  await reply($)
  void tool($, 'Bash')
  await clock.advance(31_000)
  await end($, 'answer')

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeUndefined()
  await ui.unmount()
})

test('a failed first usage read still starts the band', async ($, on) => {
  const registered: string[] = []
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => {
    throw new Error('not ready')
  })
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  expect(registered).toContain('keep-warm')
})

test('a category name cannot break the panel drawing', async () => {
  const { source } = contextPanelSvg({ window: 1000, rows: [{ name: 'Tools & <plugins>', tokens: 100 }] })
  expect(source).toContain('Tools &amp; &lt;plugins&gt;')
})

test('a long category name is cut before it reaches the figures', async () => {
  const texts = textsOf(contextPanelSvg({ window: 1000, rows: [{ name: 'Memory files (CLAUDE.md, rules and more)', tokens: 100 }] }).source)
  expect(texts.some(t => t?.startsWith('Memory files') && t.length <= 26)).toBe(true)
})

test('one minute left reads as one minute', async () => {
  const card = cardSvg({ mode: 'warm', idle: '59m', idleMin: 59, tokens: 1000, window: 1_000_000, mine: 'opus' })
  expect(card.alt).toContain('in 1 minute.')
})

test('the tokens stay on the ribbon at the width the app really uses, with agents running', async ($, on) => {
  await start($, on)
  await reply($)
  await ($.agent.spawn as (e: unknown) => Promise<unknown>)({ prompt: 'x', description: 'Review', subagentType: 'general-purpose', background: true })

  const ui = await band($, false, 95)
  expect(await ui.find({ type: 'Text', text: /^300k · 30%$/ })).toBeDefined()
  await ui.unmount()
})

test('the Agents button shows only while agents run, counting those running', async ($, on) => {
  await start($, on)
  await reply($)
  const ui = await band($)
  expect(await ui.find({ key: 'agents-toggle' })).toBeUndefined()

  await ($.agent.spawn as (e: unknown) => Promise<unknown>)({ prompt: 'x', description: 'Review', subagentType: 'general-purpose', background: true })
  expect((await ui.find({ key: 'agents-toggle' }))?.props.label).toBe('Agents 1')

  await end($, 'answer', 'a1')
  expect(await ui.find({ key: 'agents-toggle' })).toBeUndefined()
  await ui.unmount()
})

test('the full ribbon shows from the first reply, before any turn has ended', async ($, on) => {
  await start($, on, { categories: CATEGORIES })
  await step($)

  const ui = await band($, true, 140)
  expect(await ui.find({ type: 'Text', text: /^400k · 40%$/ })).toBeDefined()
  expect(await ui.find({ key: 'warm-pick' })).toBeDefined()
  expect((await ui.findAll({ type: 'Svg' })).some(s => String(s.props.alt).startsWith('Context mix'))).toBe(true)
  await ui.unmount()
})

test('the token count follows each reply during a turn', async ($, on) => {
  await start($, on)
  await reply($)
  await step($)

  const ui = await band($, true)
  expect(await ui.find({ type: 'Text', text: /^400k · 40%$/ })).toBeDefined()
  await ui.unmount()
})

test('running subagents show on the upper row and leave when they end', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)

  await ($.agent.spawn as (e: unknown) => Promise<unknown>)({ prompt: 'x', description: 'Review', subagentType: 'general-purpose', background: true })
  await clock.advance(120_000)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /1 agent 2m/ })).toBeDefined()

  await end($, 'answer', 'a1')
  expect(await ui.find({ type: 'Text', text: /1 agent/ })).toBeUndefined()
  await ui.unmount()
})
