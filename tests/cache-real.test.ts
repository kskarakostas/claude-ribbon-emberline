import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const MIN = 60_000
const MODEL = 'claude-opus-5-5'
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
} as const
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const HIT: Usage = { input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 299_900, cache_creation_input_tokens: 0 }
const MISS: Usage = { input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 299_900 }

const start = async ($: Engine, on: On, tokens: number, usage: Usage = HIT) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const sent: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  on('session.cwd', () => ({ value: '/home/k/demo' }) as never)
  on('session.model', () => ({ value: MODEL }) as never)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [] },
  }))
  on('ui.notify', (_, e) => {
    sent.push(`${e.title ?? ''}|${e.text}`)
    return { value: { isSent: true, channel: 'test' } } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: MODEL, ...usage } } as never
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/home/k/demo' })
  return { clock, sent }
}
const reply = async ($: Engine) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: MODEL, messageCount: 1 })
  for await (const _ of stream) void _
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', usage: { model: MODEL, ...HIT } })
}
const band = ($: Engine) => $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

test('the band shows the share of the last request the cache served', async ($, on) => {
  await start($, on, 300_000)
  await reply($)

  const ui = await band($)
  expect(await ui.find({ text: /100% hit/ })).toBeDefined()
  await ui.unmount()
})

test('a request that missed the cache shows, even while the timer says warm', async ($, on) => {
  await start($, on, 300_000, MISS)
  await reply($)

  const ui = await band($)
  expect(await ui.find({ text: / 0% hit/ })).toBeDefined()
  await ui.unmount()
})

test('the band shows context fill', async ($, on) => {
  await start($, on, 300_000)
  await reply($)

  const ui = await band($)
  expect(await ui.find({ text: /300k · 30%/ })).toBeDefined()
  await ui.unmount()
})

test('the countdown turns yellow inside the warning window', async ($, on) => {
  const { clock } = await start($, on, 300_000)
  await reply($)
  await clock.advance(52 * MIN)

  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /^ 8m$/ }))?.props.color).toBe('#d0a85c')
  await ui.unmount()
})

test('a large session warns once, ten minutes before the cache goes cold', async ($, on) => {
  const { clock, sent } = await start($, on, 300_000)
  await reply($)

  await clock.advance(49 * MIN)
  expect(sent).toEqual([])

  await clock.advance(9 * MIN)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('Cache expiring|')
  expect(sent[0]).toContain('demo')
  expect(sent[0]).toContain('300k')
})

test('a small session never warns', async ($, on) => {
  const { clock, sent } = await start($, on, 40_000)
  await reply($)

  await clock.advance(58 * MIN)
  expect(sent).toEqual([])
})

test('nothing warns while a turn runs', async ($, on) => {
  const { clock, sent } = await start($, on, 300_000)
  await reply($)
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 't2', prompt: 'x' })

  await clock.advance(58 * MIN)
  expect(sent).toEqual([])
})

test('a warning fires again after the next reply restarts the clock', async ($, on) => {
  const { clock, sent } = await start($, on, 300_000)
  await reply($)
  await clock.advance(52 * MIN)
  await reply($)
  await clock.advance(52 * MIN)
  expect(sent.length).toBe(2)
})

test('a cold cache does not warn', async ($, on) => {
  const { clock, sent } = await start($, on, 300_000)
  await reply($)
  await clock.advance(50 * MIN)
  sent.length = 0
  await clock.advance(30 * MIN)
  expect(sent).toEqual([])
})
