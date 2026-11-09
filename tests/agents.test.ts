import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { costOf } from '../hooks/agents'

const MODEL = 'claude-sonnet-5-5'
const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 8,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
} as const
const PANE = {
  title: 'Agents',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const start = async ($: Engine, on: On) => {
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('agent.spawn', () => ({ model: MODEL, agentId: 'a1' }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return {
      turnId: 't',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: MODEL, input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 },
    } as never
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
}
const spawn = ($: Engine) =>
  $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'Verify the numbers', subagentType: 'general-purpose' } as never)
const step = async ($: Engine) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: MODEL, messageCount: 1, agentId: 'a1' })
  for await (const _ of stream) void _
}
const pane = ($: Engine) =>
  $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'Pane', requestId: 'emberline-agents', props: PANE })

test('a spawned agent gets a band button and a pane row', async ($, on) => {
  await start($, on)
  await spawn($)

  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ key: 'agents-toggle' }))?.props.label).toBe('Agents 1')
  await band.unmount()

  const ui = await pane($)
  expect(await ui.find({ text: /Verify the numbers/ })).toBeDefined()
  await ui.unmount()
})

test('no agents means no button', async ($, on) => {
  await start($, on)

  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'agents-toggle' })).toBeUndefined()
  await band.unmount()
})

test('a step adds up the agent tokens and cost', async ($, on) => {
  await start($, on)
  await spawn($)
  await step($)

  const ui = await pane($)
  expect(await ui.find({ text: /44k/ })).toBeDefined()
  expect(await ui.find({ text: /≈\$0\.03/ })).toBeDefined()
  await ui.unmount()
})

test('a finished agent shows as done', async ($, on) => {
  await start($, on)
  await spawn($)
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' })

  const ui = await pane($)
  expect(await ui.find({ text: /✔/ })).toBeDefined()
  await ui.unmount()
})

test('a failed agent shows as failed', async ($, on) => {
  await start($, on)
  await spawn($)
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't' })

  const ui = await pane($)
  expect(await ui.find({ text: /✗/ })).toBeDefined()
  await ui.unmount()
})

const MTOK = { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }
const PRICED: readonly (readonly [string, number])[] = [
  ['claude-fable-5-1', 10 + 0.25 + 20],
  ['claude-opus-5-5', 4 + 0.2 + 8],
  ['claude-opus-5', 5 + 0.5 + 10],
  ['claude-sonnet-5-5', 2 + 0.2 + 4],
  ['claude-sonnet-4-6', 3 + 0.3 + 6],
  ['claude-haiku-4-5', 1 + 0.1 + 2],
]
for (const [model, want] of PRICED) {
  test(`list price for ${model}`, async () => {
    expect(Math.abs((costOf(model, MTOK) ?? 0) - want) < 1e-6).toBe(true)
  })
}

test('an unknown model has no price rather than a guess', async () => {
  expect(costOf('some-new-model', MTOK)).toBeNull()
})

test('Haiku 5.5 is priced by prompt size: the low rate up to 100k, the high rate above', async () => {
  const small = { input_tokens: 50_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(Math.abs((costOf('claude-haiku-5-5', small) ?? 0) - (0.05 * 0.1 + 0.5)) < 1e-6).toBe(true)
  expect(Math.abs((costOf('claude-haiku-5-5', MTOK) ?? 0) - (0.5 + 0.05 + 1)) < 1e-6).toBe(true)
})
