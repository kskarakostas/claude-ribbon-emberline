import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { applyPlan, etaMs } from '../hooks/plan'

const UPDATE = 'mcp__ccd_turn__update_plan'
const NOW = Date.parse('2098-12-31T22:00:00Z')
const props = (isWorking: boolean) =>
  ({ hasSurvey: false, isWorking, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} }) as const
const ITEMS = [
  { content: 'Read the code', status: 'in_progress' },
  { content: 'Write the tests', status: 'pending' },
  { content: 'Ship it', status: 'pending' },
]

let uses: object[] = []
const start = async ($: Engine, on: On) => {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: uses, stopReason: 'tool_use', usage: null } as never
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  return clock
}
const call = async ($: Engine, name: string, input: object) => {
  uses = [{ name, input }]
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of stream) void _
}
const band = ($: Engine, isWorking: boolean) =>
  $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: props(isWorking) })

test('a plan shows its current step and count while a turn runs', async ($, on) => {
  await start($, on)
  await call($, UPDATE, { items: ITEMS, scope: 'first_task' })

  const ui = await band($, true)
  expect(await ui.find({ text: /Read the code/ })).toBeDefined()
  expect(await ui.find({ text: /0\/3/ })).toBeDefined()
  await ui.unmount()
})

test('advance moves to the next step', async ($, on) => {
  await start($, on)
  await call($, UPDATE, { items: ITEMS, scope: 'first_task' })
  await call($, UPDATE, { advance: true })

  const ui = await band($, true)
  expect(await ui.find({ text: /Write the tests/ })).toBeDefined()
  expect(await ui.find({ text: /1\/3/ })).toBeDefined()
  await ui.unmount()
})

test('a new list starts its own pace: no time left until one of its steps finishes', async ($, on) => {
  const clock = await start($, on)
  await call($, UPDATE, { items: ITEMS, scope: 'first_task' })
  await clock.advance(300_000)
  await call($, UPDATE, { advance: true })
  await call($, UPDATE, { items: ITEMS, scope: 'new_task' })

  const ui = await band($, true)
  expect(await ui.find({ text: /0\/3/ })).toBeDefined()
  expect(await ui.find({ text: /left/ })).toBeUndefined()
  await ui.unmount()
})

test('the row stays hidden when no turn runs', async ($, on) => {
  await start($, on)
  await call($, UPDATE, { items: ITEMS, scope: 'first_task' })

  const ui = await band($, false)
  expect(await ui.find({ text: /Read the code/ })).toBeUndefined()
  await ui.unmount()
})

test('done and start pick steps out of order, numbered from 1', async () => {
  const p = applyPlan(null, { items: ITEMS }, 0)
  const q = applyPlan(p, { done: [1, 2], start: 3 }, 1000)
  expect(q?.steps.map(s => s.status)).toEqual(['completed', 'completed', 'in_progress'])
})

test('an advance past the last step leaves nothing running', async () => {
  const p = applyPlan(null, { items: [{ content: 'One', status: 'in_progress' }] }, 0)
  const q = applyPlan(p, { advance: true }, 1000)
  expect(q?.steps.map(s => s.status)).toEqual(['completed'])
})

test('a progress call with no plan yet is ignored', async () => {
  expect(applyPlan(null, { advance: true }, 0)).toBeNull()
})

test('malformed items keep the plan as it stood', async () => {
  const p = applyPlan(null, { items: ITEMS }, 0)
  expect(applyPlan(p, { items: 'not a list' }, 1000)).toEqual(p)
})

test('no estimate until a step has finished', async () => {
  expect(etaMs(applyPlan(null, { items: ITEMS }, 0), 5000)).toBeNull()
})

test('the estimate is the median step time times the steps left, less the current step so far', async () => {
  let p = applyPlan(null, { items: ITEMS }, 0)
  p = applyPlan(p, { advance: true }, 60_000) // one step, 60s
  // Two steps left at 60s each, 15s into the current one.
  expect(etaMs(p, 75_000)).toBe(105_000)
})

test('the estimate never goes below zero', async () => {
  let p = applyPlan(null, { items: ITEMS }, 0)
  p = applyPlan(p, { advance: true }, 1000)
  // Two steps left, far past the median: the one still ahead remains.
  expect(etaMs(p, 900_000)).toBe(1000)
})

test('an input that is not an object leaves the plan alone', async () => {
  const plan = applyPlan(null, { items: ITEMS }, NOW)
  expect(applyPlan(plan, null, NOW)).toBe(plan)
  expect(applyPlan(plan, 'x', NOW)).toBe(plan)
})
