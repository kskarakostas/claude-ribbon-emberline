import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { runOutAt, withSample } from '../hooks/pace'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const MIN = 60_000
const RESETS = '2099-01-01T03:00:00Z' // five hours on
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
} as const

const at = (minutes: number, used: number) => ({ at: NOW + minutes * MIN, used: { five_hour: used } })

test('pace: the run-out time at the rise seen since the oldest reading in the last hour', async () => {
  // 40% to 50% in 30 minutes: the other 50% takes 150 minutes.
  expect(runOutAt([at(0, 40)], 'five_hour', NOW + 30 * MIN, 50, NOW + 300 * MIN)).toBe(NOW + 180 * MIN)
})

test('pace: nothing when the window resets first, the span is short, usage fell, or it is used up', async () => {
  expect(runOutAt([at(0, 40)], 'five_hour', NOW + 30 * MIN, 50, NOW + 100 * MIN)).toBeNull()
  expect(runOutAt([at(25, 49)], 'five_hour', NOW + 30 * MIN, 50, NOW + 300 * MIN)).toBeNull()
  expect(runOutAt([at(0, 60)], 'five_hour', NOW + 30 * MIN, 5, NOW + 300 * MIN)).toBeNull()
  expect(runOutAt([at(0, 40)], 'five_hour', NOW + 30 * MIN, 100, NOW + 300 * MIN)).toBeNull()
  expect(runOutAt([at(0, 40)], 'five_hour', NOW + 30 * MIN, 50, null)).toBeNull()
})

test('pace: after a reset inside the hour, the rise counts from the reset', async () => {
  const s = [at(0, 90), at(10, 2), at(20, 10)]
  // 2% to 20% in 30 minutes since the reset: the other 80% takes about 133 minutes.
  expect(runOutAt(s, 'five_hour', NOW + 40 * MIN, 20, NOW + 300 * MIN)).toBe(NOW + 40 * MIN + (80 / 18) * 30 * MIN)
})

test('pace: an empty reading is not kept, so it cannot block the first real one', async () => {
  expect(withSample([], NOW, [])).toEqual([])
})

test('pace: readings older than an hour drop out, and close ones are not kept twice', async () => {
  const w = [{ kind: 'five_hour', percentUsed: 50 }]
  expect(withSample([at(0, 40)], NOW + 61 * MIN, w).map(s => s.at)).toEqual([NOW + 61 * MIN])
  expect(withSample([at(0, 40)], NOW + 30_000, w).map(s => s.at)).toEqual([NOW])
})

const start = async ($: Engine, on: On, used: number) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [{ kind: 'five_hour', percentUsed: used, resetsAt: RESETS }] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }) as never)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  return clock
}
const measure = ($: Engine, used: number, resetsAt = RESETS) =>
  ($.session.measure as (e: unknown) => Promise<unknown>)({
    context: { window: 1000000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: used, resetsAt }],
    changed: ['rateLimits'],
  })

test('the ribbon says when a window will run out at this pace, before it resets', async ($, on) => {
  const clock = await start($, on, 40)
  await clock.advance(30 * MIN)
  await measure($, 50)
  for (const bodyColumns of [160, 53]) {
    const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })
    expect(await band.find({ type: 'Text', text: /out in ~2h 30m/ })).toBeDefined()
    await band.unmount()
  }
})

test('the pace follows the last hour, from readings the session took as usage moved', async ($, on) => {
  const clock = await start($, on, 40)
  await clock.advance(50 * MIN)
  await measure($, 45)
  await clock.advance(30 * MIN) // the start's reading is now past the hour; the one at 50 minutes counts
  await measure($, 55)
  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  // 45% to 55% in 30 minutes: the other 45% takes 135 minutes.
  expect(await band.find({ type: 'Text', text: /out in ~2h 15m/ })).toBeDefined()
  await band.unmount()
})

test('when two forecasts would not fit the wide row, the ribbon stacks', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  const both = (u5: number, u7: number) => [
    { kind: 'five_hour', percentUsed: u5, resetsAt: RESETS },
    { kind: 'seven_day', percentUsed: u7, resetsAt: RESETS },
  ]
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: both(40, 40) } }))
  on('session.measure', (_, e) => ({ changed: e.changed }) as never)
  on('classic.SessionStart', () => ({}) as never)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'resume', seconds_since_last_response: 60, context_tokens: 300000, model: 'claude-opus-5-5' })
  await clock.advance(30 * MIN)
  await ($.session.measure as (e: unknown) => Promise<unknown>)({ context: { window: 1000000 }, rateLimits: both(50, 50), changed: ['rateLimits'] })

  const wide = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 200 } })
  expect(await wide.find({ key: 'block' })).toBeUndefined()
  await wide.unmount()
  const narrower = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 140 } })
  expect(await narrower.find({ key: 'block' })).toBeDefined()
  expect(await narrower.find({ type: 'Text', text: /out in ~2h 30m/ })).toBeDefined()
  await narrower.unmount()
})

test('no forecast while the pace would not use the window up before it resets', async ($, on) => {
  const clock = await start($, on, 40)
  await clock.advance(30 * MIN)
  await measure($, 41)
  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ type: 'Text', text: /out in/ })).toBeUndefined()
  await band.unmount()
})
