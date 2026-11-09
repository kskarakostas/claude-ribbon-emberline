import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { runOutAt } from '../hooks/pace'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
} as const
const iso = (ms: number) => new Date(ms).toISOString()

test('pace: the run-out time at the average rate since the window reset', async () => {
  // A 5-hour window two hours in at 50%: 25% an hour, so the other 50% takes two hours.
  expect(runOutAt('five_hour', 50, NOW + 3 * HOUR, NOW)).toBe(NOW + 2 * HOUR)
  // A week two days in at 30%: 15% a day, so the other 70% takes 4 2/3 days.
  expect(runOutAt('seven_day', 30, NOW + 5 * DAY, NOW)).toBe(NOW + (70 / 30) * 2 * DAY)
})

test('pace: nothing when the window resets first, too little of it has passed, or nothing says how long it runs', async () => {
  expect(runOutAt('five_hour', 20, NOW + 3 * HOUR, NOW)).toBeNull() // 10% an hour: 8 more hours, past the reset
  expect(runOutAt('five_hour', 10, NOW + 4 * HOUR + 40 * MIN, NOW)).toBeNull() // 20 minutes in: under a tenth of the window
  expect(runOutAt('seven_day', 20, NOW + 6 * DAY + 8 * HOUR, NOW)).toBeNull() // 16 hours in: under a tenth of a week
  expect(runOutAt('seven_day_fable', 50, NOW + 3 * DAY, NOW)).toBeNull()
  expect(runOutAt('five_hour', 0, NOW + 3 * HOUR, NOW)).toBeNull()
  expect(runOutAt('five_hour', 100, NOW + 3 * HOUR, NOW)).toBeNull()
  expect(runOutAt('five_hour', 50, null, NOW)).toBeNull()
})

const start = async ($: Engine, on: On, limits: { kind: string; percentUsed: number; resetsAt: string }[]) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: limits } }))
  on('session.measure', (_, e) => ({ changed: e.changed }) as never)
  on('classic.SessionStart', () => ({}) as never)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
}

test('the ribbon says when a window will run out at its pace since the reset, from the first reading', async ($, on) => {
  await start($, on, [{ kind: 'five_hour', percentUsed: 50, resetsAt: iso(NOW + 3 * HOUR) }])
  for (const bodyColumns of [160, 53]) {
    const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })
    expect(await band.find({ type: 'Text', text: /out in ~2h 0m/ })).toBeDefined()
    await band.unmount()
  }
})

test('the forecast follows each new reading the session takes', async ($, on) => {
  await start($, on, [{ kind: 'seven_day', percentUsed: 10, resetsAt: iso(NOW + 5 * DAY) }])
  let band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ type: 'Text', text: /out in/ })).toBeUndefined() // 5% a day: the week resets first
  await band.unmount()
  await ($.session.measure as (e: unknown) => Promise<unknown>)({
    context: { window: 1000000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 5 * DAY) }],
    changed: ['rateLimits'],
  })
  band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ type: 'Text', text: /out in ~4d 16h/ })).toBeDefined()
  await band.unmount()
})

test('when two forecasts would not fit the wide row, the ribbon stacks', async ($, on) => {
  await start($, on, [
    { kind: 'five_hour', percentUsed: 50, resetsAt: iso(NOW + 3 * HOUR) },
    { kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 5 * DAY) },
  ])
  // A resumed session gives the cache its size, which the wide row then has to fit beside the forecasts.
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'resume', seconds_since_last_response: 60, context_tokens: 300000, model: 'claude-opus-5-5' })

  const wide = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 200 } })
  expect(await wide.find({ key: 'block' })).toBeUndefined()
  await wide.unmount()
  const narrower = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 140 } })
  expect(await narrower.find({ key: 'block' })).toBeDefined()
  expect(await narrower.find({ type: 'Text', text: /out in ~2h 0m/ })).toBeDefined()
  await narrower.unmount()
})
