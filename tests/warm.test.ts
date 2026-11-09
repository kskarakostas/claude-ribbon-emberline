import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { capFrom, HOUR_MS, shouldPing } from '../hooks/warm'
import type { PingRecord } from '../types'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const MIN = 60_000
const MODEL = 'claude-opus-5-5'
const TOKENS = 300_000
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
} as const
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 299_000, cache_creation_input_tokens: 50 }
type Fork = () => unknown
const GOOD: Fork = () => ({ isAnswered: true, text: 'ok', usage: USAGE })

const start = async ($: Engine, on: On, fork: Fork = GOOD) => {
  const saved: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: saved[e.key] }) as never)
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined } as never
  })
  const clock = mock.clock(on, { now: NOW })
  const asked: string[] = []
  const sent: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.cwd', () => ({ value: '/home/k/demo' }) as never)
  on('session.model', () => ({ value: MODEL }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: TOKENS }, rateLimits: [] } }))
  on('ui.notify', (_, e) => {
    sent.push(e.text)
    return { value: { isSent: true, channel: 'test' } } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('model.fork', (_, e) => {
    asked.push(e.prompt)
    return { value: fork() } as never
  })
  on('session.compact', (_, e) => ({ messages: e.messages }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: MODEL, ...USAGE } } as never
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/home/k/demo' })
  return { clock, asked, sent, saved }
}
const reply = async ($: Engine) => {
  await ($.prompt.submit as (e: unknown) => Promise<unknown>)({ text: 'hi' })
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 't', text: 'hi' })
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: MODEL, messageCount: 1 })
  for await (const _ of stream) void _
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', usage: { model: MODEL, ...USAGE } })
}
const command = ($: Engine, args: string) =>
  ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'keep-warm', args, origin: { kind: 'plugin', name: 'test' } })
const band = ($: Engine) => $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

test('keep-warm is off by default and never calls the model', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await clock.advance(180 * MIN)
  expect(asked).toEqual([])
})

test('switched on, it pings at 50 minutes and the cache stays warm past the hour', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '2h')

  await clock.advance(49 * MIN)
  expect(asked.length).toBe(0)
  await clock.advance(2 * MIN)
  expect(asked.length).toBe(1)

  await clock.advance(19 * MIN) // 70 minutes after the last real request
  const ui = await band($)
  expect((await ui.findAll({ type: 'Svg' })).map(s => s.props.alt)).toContain('WARM')
  await ui.unmount()
})

test('while Ember holds, the band counts down Ember, then hands back to the cache hour', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await command($, '2h')

  await clock.advance(70 * MIN)
  const ui = await band($)
  expect(await ui.find({ text: ' ember 50m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ \d+m$/ })).toBeUndefined()
  await ui.unmount()

  const stacked = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 53 } })
  expect(await stacked.find({ text: 'ember 50m' })).toBeDefined()
  await stacked.unmount()

  // Past the cap no ping comes, so the cache hour is the true countdown again.
  await clock.advance(55 * MIN)
  const after = await band($)
  expect(await after.find({ type: 'Text', text: /^ ember/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /^ \d+m$/ })).toBeDefined()
  await after.unmount()
})

test('the cap stops the pings and lets the cache go cold', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '2h')

  await clock.advance(6 * 60 * MIN)
  expect(asked.length).toBe(2)
})

test('a real prompt starts a new idle window', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '2h')
  await clock.advance(110 * MIN)
  expect(asked.length).toBe(2)

  await reply($)
  await clock.advance(52 * MIN)
  expect(asked.length).toBe(3)
})

test('turn events alone never reopen the idle window', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '1h')
  await clock.advance(52 * MIN)
  expect(asked.length).toBe(1)

  // A turn with no prompt, as a fork might raise: the cap must hold.
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 'f', text: '' })
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 'f' })
  await clock.advance(120 * MIN)
  expect(asked.length).toBe(1)
})

test('nothing pings while a turn runs', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '2h')
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 't2', text: 'x' })

  await clock.advance(55 * MIN)
  expect(asked).toEqual([])
})

test('a late start skips the ping, because a lapsed cache would bill the whole prefix', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await clock.advance(59 * MIN)
  await command($, '2h')

  await clock.advance(10 * MIN)
  expect(asked).toEqual([])
})

test('a ping the cache did not serve switches it off and says so', async ($, on) => {
  const { clock, asked, sent } = await start($, on, () => ({
    isAnswered: true,
    text: 'ok',
    usage: { ...USAGE, cache_read_input_tokens: 1000, cache_creation_input_tokens: 299_000 },
  }))
  await reply($)
  await command($, '2h')

  await clock.advance(120 * MIN)
  expect(asked.length).toBe(1)
  expect(sent.join()).toContain('Keep-warm stopped')

  const ui = await band($)
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe('off')
  await ui.unmount()
})

for (const [name, result] of [
  ['an API error', { isAnswered: false, reason: 'api-error', status: 500, usage: USAGE }],
  ['nothing to fork', { isAnswered: false, reason: 'nothing-to-fork' }],
] as const) {
  test(`${name} switches it off`, async ($, on) => {
    const { clock, asked } = await start($, on, () => result)
    await reply($)
    await command($, '2h')

    await clock.advance(120 * MIN)
    expect(asked.length).toBe(1)
  })
}

test('a fork that rejects switches it off', async ($, on) => {
  const { clock, asked } = await start($, on, () => {
    throw new Error('boom')
  })
  await reply($)
  await command($, '2h')

  await clock.advance(120 * MIN)
  expect(asked.length).toBe(1)
})

test('a failed ping leaves the cache clock where it was', async ($, on) => {
  const { clock } = await start($, on, () => ({ isAnswered: false, reason: 'api-error', status: 500, usage: USAGE }))
  await reply($)
  await command($, '2h')
  await clock.advance(61 * MIN)

  const ui = await band($)
  const alts = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect(alts.some(alt => alt.startsWith('Cache cold.'))).toBe(true)
  await ui.unmount()
})

test('a session being kept warm gets no expiry warning', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await command($, '2h')

  await clock.advance(55 * MIN)
  expect(sent).toEqual([])
})

test('the band picker sets the time and switches it off', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)

  const ui = await band($)
  const pick = await ui.find({ key: 'warm-pick' })
  expect(pick?.props.label).toBe('Ember')
  expect(pick?.props.value).toBe('off')
  expect((pick?.props.options as { value: string }[]).map(o => o.value)).toEqual(['off', '2h', '6h', '12h'])

  await ui.select({ key: 'warm-pick', value: '12h' })
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe('12h')
  await ui.select({ key: 'warm-pick', value: 'off' })
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe('off')
  await ui.unmount()

  await clock.advance(55 * MIN)
  expect(asked).toEqual([])
})

test('a 12h pick keeps pinging past 8 hours', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  const ui = await band($)
  await ui.select({ key: 'warm-pick', value: '12h' })
  await ui.unmount()

  await clock.advance(9 * 60 * MIN)
  expect(asked.length).toBe(10)
})

test('the picker shows a time set by command', async ($, on) => {
  await start($, on)
  await reply($)
  await command($, '3h')

  const ui = await band($)
  const pick = await ui.find({ key: 'warm-pick' })
  expect(pick?.props.value).toBe('3h')
  expect((pick?.props.options as { value: string }[]).some(o => o.value === '3h')).toBe(true)
  await ui.unmount()
})

test('a surface with no picker gets the on and off button', async ($, on) => {
  await start($, on)
  await reply($)

  const ui = await $.ui.mount({ plugin: 'emberline', surface: 'mobile', component: 'AbovePrompt', props: PROPS })
  expect((await ui.find({ key: 'warm-toggle' }))?.props.label).toBe('Ember')
  await ui.press({ key: 'warm-toggle' })
  expect((await ui.find({ key: 'warm-toggle' }))?.props.label).toBe('Ember 2h')
  await ui.unmount()
})

test('/keep-warm off switches it off', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '2h')
  await command($, 'off')

  await clock.advance(55 * MIN)
  expect(asked).toEqual([])
})

test('/keep-warm ping fires one ping now and reports what the cache served', async ($, on) => {
  const { asked } = await start($, on)
  await reply($)

  const r = await command($, 'ping')
  expect(asked.length).toBe(1)
  expect(r.text).toContain('299k')
})

test('/keep-warm ping refuses a cache that may have lapsed', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await clock.advance(59 * MIN)

  const r = await command($, 'ping')
  expect(asked).toEqual([])
  expect(r.text).toContain('Not pinged')
})

test('a served ping leaves a record that outlives the session', async ($, on) => {
  const { clock, saved } = await start($, on)
  await reply($)
  await command($, '2h')
  await clock.advance(51 * MIN)

  const log = saved.pingLog as PingRecord[]
  expect(log.length).toBe(1)
  expect(log[0]?.served).toBe(299_000)
  expect(log[0]?.isServed).toBe(true)
})

test('a missed ping leaves a record too', async ($, on) => {
  const { clock, saved } = await start($, on, () => ({ isAnswered: false, reason: 'api-error', status: 500, usage: USAGE }))
  await reply($)
  await command($, '2h')
  await clock.advance(51 * MIN)

  const log = saved.pingLog as PingRecord[]
  expect(log[0]?.served).toBe(0)
  expect(log[0]?.isServed).toBe(false)
})

test('a bad argument changes nothing', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)

  const r = await command($, 'forever')
  expect(r.text).toContain('Usage')
  await clock.advance(55 * MIN)
  expect(asked).toEqual([])
})

const BASE = { now: 0, lastAt: -50 * MIN, lastPromptAt: -50 * MIN, capMs: 2 * HOUR_MS, isBusy: false }

test('ping timing: due at 50 minutes idle', async () => {
  expect(shouldPing(BASE)).toBe(true)
  expect(shouldPing({ ...BASE, lastAt: -49 * MIN })).toBe(false)
})

test('ping timing: never at 58 minutes idle or later', async () => {
  expect(shouldPing({ ...BASE, lastAt: -57 * MIN })).toBe(true)
  expect(shouldPing({ ...BASE, lastAt: -58 * MIN })).toBe(false)
})

test('ping timing: never when off, busy, or past the cap', async () => {
  expect(shouldPing({ ...BASE, capMs: null })).toBe(false)
  expect(shouldPing({ ...BASE, isBusy: true })).toBe(false)
  expect(shouldPing({ ...BASE, lastPromptAt: -120 * MIN })).toBe(false)
})

test('a skipped ping still gets the expiry warning', async ($, on) => {
  const { clock, asked, sent } = await start($, on)
  await reply($)
  await clock.advance(59 * MIN - 1000)
  await command($, '2h') // too late to ping, and the warning fired already at 50 minutes
  expect(asked).toEqual([])
  expect(sent.length).toBe(1)
})

test('the ribbon drops the word USAGE and separates its sections', async ($, on) => {
  await start($, on)
  await reply($)

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /USAGE/ })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: /│/ })).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('the band sits on the app background, not a colour of its own', async ($, on) => {
  await start($, on)
  await reply($)

  const ui = await band($)
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(b => b.props.backgroundColor !== undefined)).toBe(false)
  await ui.unmount()
})

const compact = ($: Engine, trigger: string) =>
  ($.session.compact as (e: unknown) => Promise<{ skip?: string }>)({ trigger, messages: [{ role: 'user', text: 'x', toolUses: [] }] })

test('while keep-warm holds, the idle compaction is skipped and recorded', async ($, on) => {
  const { saved } = await start($, on)
  await reply($)
  await command($, '2h')

  expect((await compact($, 'precompute')).skip).toContain('keep-warm')
  expect((saved.compactSkips as number[]).length).toBe(1)
})

test('with keep-warm off, the idle compaction runs', async ($, on) => {
  await start($, on)
  await reply($)

  expect((await compact($, 'precompute')).skip).toBeUndefined()
})

test('past its time, keep-warm lets the idle compaction run', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await command($, '1h')
  await clock.advance(61 * MIN)

  expect((await compact($, 'precompute')).skip).toBeUndefined()
})

test('keep-warm leaves other compactions alone', async ($, on) => {
  await start($, on)
  await reply($)
  await command($, '2h')

  expect((await compact($, 'manual')).skip).toBeUndefined()
})

test('/clear switches keep-warm off, because it is a new conversation', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '2h')
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'clear' })
  await reply($)

  await clock.advance(55 * MIN)
  expect(asked).toEqual([])
})

test('compaction leaves keep-warm on', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '2h')
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'compact' })
  await reply($)

  await clock.advance(55 * MIN)
  expect(asked.length).toBe(1)
})

for (const [name, extra] of [
  ['an automatic wake', { isMeta: true }],
  ['a slash command', { command: { name: 'keep-warm' } }],
] as const) {
  test(`${name} does not extend the idle window`, async ($, on) => {
    const { clock, saved } = await start($, on)
    await reply($)
    await command($, '1h')
    await clock.advance(61 * MIN)
    await ($.prompt.submit as (e: unknown) => Promise<unknown>)({ text: 'wake', ...extra })

    expect((await compact($, 'precompute')).skip).toBeUndefined()
    expect(saved.compactSkips).toBeUndefined()
  })
}

test('caps parse to hours within limits', async () => {
  expect(capFrom('1h')).toBe(HOUR_MS)
  expect(capFrom('12h')).toBe(12 * HOUR_MS)
  expect(capFrom('13h')).toBeNull()
  expect(capFrom('0h')).toBeNull()
  expect(capFrom('2')).toBeNull()
})
