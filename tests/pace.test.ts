import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { noteReading, runOutAt } from '../hooks/pace'

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

test('pace: a busy recent day speeds the forecast past an idle stretch since the reset', async () => {
  // A week four days in at 40%: an idle first day, then 10% a day until yesterday, and 20% in the last day.
  const resetsAt = NOW + 3 * DAY
  const samples = [
    { at: NOW - 3 * DAY, used: 0 },
    { at: NOW - 2 * DAY, used: 10 },
    { at: NOW - DAY, used: 20 },
  ]
  // The average, about 10% a day, lasts the week; at 20% a day the other 60% takes 3 days, an hour before the reset.
  expect(runOutAt('seven_day', 40, resetsAt + HOUR, NOW)).toBeNull()
  expect(Math.abs(runOutAt('seven_day', 40, resetsAt + HOUR, NOW, samples)! - (NOW + 3 * DAY))).toBeLessThan(1)
})

test('pace: a quiet recent day keeps the average, so a weekend alone never hides a busy week', async () => {
  const samples = [{ at: NOW - 2 * DAY, used: 60 }, { at: NOW - 20 * HOUR, used: 60 }]
  // 60% in three days is 20% a day; nothing used in the last day does not slow it.
  expect(runOutAt('seven_day', 60, NOW + 4 * DAY, NOW, samples)).toBe(NOW + 2 * DAY)
})

test('pace: the recent day is read between the readings either side of it', async () => {
  // Readings two days and twelve hours back: a day back is two thirds of the way, 10 + 20 * 2/3 = 23 1/3%.
  const samples = [{ at: NOW - 2 * DAY, used: 10 }, { at: NOW - 12 * HOUR, used: 30 }]
  const recent = (50 - (10 + 40 / 3)) / DAY
  expect(Math.abs(runOutAt('seven_day', 50, NOW + 4 * DAY, NOW, samples)! - (NOW + 50 / recent))).toBeLessThan(1)
})

test('pace: readings from before the reset play no part', async () => {
  const samples = [{ at: NOW - 6 * DAY, used: 90 }]
  expect(runOutAt('seven_day', 30, NOW + 5 * DAY, NOW, samples)).toBe(runOutAt('seven_day', 30, NOW + 5 * DAY, NOW))
})

test('pace: the five-hour window reads its recent pace over the last hour', async () => {
  // Two hours in at 30%: 15% an hour on average, but 25% came in the last hour, so the other 70% takes 2h 48m.
  expect(Math.abs(runOutAt('five_hour', 30, NOW + 3 * HOUR, NOW, [{ at: NOW - HOUR, used: 5 }])! - (NOW + (70 / 25) * HOUR))).toBeLessThan(1)
})

test('pace log: a reading is kept, a close one replaces the one before, a reset starts over, and the old ones go', async () => {
  const resetsAt = NOW + 3 * DAY
  let log = noteReading({}, 'seven_day', 10, resetsAt, NOW)
  log = noteReading(log, 'seven_day', 12, resetsAt, NOW + 2 * HOUR)
  log = noteReading(log, 'seven_day', 13, resetsAt, NOW + 2 * HOUR + 10 * MIN)
  log = noteReading(log, 'seven_day', 14, resetsAt, NOW + 2 * HOUR + 20 * MIN) // within the hour after the 12% one: replaces the 13%
  expect(log.seven_day!.samples).toEqual([{ at: NOW, used: 10 }, { at: NOW + 2 * HOUR, used: 12 }, { at: NOW + 2 * HOUR + 20 * MIN, used: 14 }])
  log = noteReading(log, 'seven_day', 30, resetsAt, NOW + 30 * HOUR)
  // Only the newest reading at or before a day back stays behind the stretch.
  expect(log.seven_day!.samples).toEqual([{ at: NOW + 2 * HOUR + 20 * MIN, used: 14 }, { at: NOW + 30 * HOUR, used: 30 }])
  log = noteReading(log, 'seven_day', 1, resetsAt + 7 * DAY, NOW + 4 * DAY)
  expect(log.seven_day).toEqual({ resetsAt: resetsAt + 7 * DAY, samples: [{ at: NOW + 4 * DAY, used: 1 }] })
  expect(noteReading(log, 'spend_limit', 5, resetsAt, NOW)).toBe(log)
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
    expect(await band.find({ type: 'Text', text: /out ~2h 0m/ })).toBeDefined()
    await band.unmount()
  }
})

test('the forecast reads the readings earlier sessions kept, and each reading adds to them', async ($, on) => {
  // An earlier session saw 20% a day ago; the average since the reset alone would forecast nothing.
  const resetsAt = NOW + 3 * DAY + HOUR
  const saved: Record<string, unknown> = { paceLog: { seven_day: { resetsAt, samples: [{ at: NOW - DAY, used: 20 }] } } }
  on('store.get', (_, e) => ({ value: saved[e.key] }) as never)
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined } as never
  })
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: iso(resetsAt) }] } }))
  on('classic.SessionStart', () => ({}) as never)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ type: 'Text', text: /out ~3d 0h/ })).toBeDefined()
  await band.unmount()
  expect(saved.paceLog).toEqual({ seven_day: { resetsAt, samples: [{ at: NOW - DAY, used: 20 }, { at: NOW, used: 40 }] } })
})

test('a stacked window keeps three lines: the forecast joins the share left', async ($, on) => {
  await start($, on, [{ kind: 'seven_day', percentUsed: 30, resetsAt: iso(NOW + 5 * DAY) }])
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'resume', seconds_since_last_response: 60, context_tokens: 300000, model: 'claude-opus-5-5' })
  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 70 } })
  expect(await band.find({ key: 'block' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^ · out ~4d 16h$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^out ~4d 16h$/ })).toBeUndefined()
  await band.unmount()
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
  expect(await band.find({ type: 'Text', text: /out ~4d 16h/ })).toBeDefined()
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
  expect(await narrower.find({ type: 'Text', text: /out ~2h 0m/ })).toBeDefined()
  await narrower.unmount()
})
