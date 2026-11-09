import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T22:00:00Z')
const WINDOWS = [
  { kind: 'five_hour', percentUsed: 18, resetsAt: '2099-01-01T01:29:00Z' },
  { kind: 'seven_day', percentUsed: 1 },
]
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const
const WARM_IDLE = 18 * 60 // 18 minutes: warm, cold in 42m
const COLD_IDLE = (3 * 24 + 9) * 3600 // 3d 9h: cold

test('a warm cache shows Robo, the WARM chip and the minutes left, folded', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: WARM_IDLE, context_tokens: 770000, model: 'claude-opus-5-5' })

  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  // Drawings keep no key in the kit, so they are found by what they say.
  const alts = (await band.findAll({ type: 'Svg' })).map(s => s.props.alt)
  expect(alts.filter(a => !String(a).endsWith('% left'))).toEqual(['Robo, bobbing', 'WARM'])
  expect(await band.find({ text: ' 42m' })).toBeDefined()
  expect(await band.find({ key: 'card' })).toBeUndefined()
  expect((await band.find({ key: 'cache-fold' }))?.props.label).toBe('ⓘ')

  await band.press({ key: 'cache-fold' })
  expect(await band.find({ key: 'card' })).toBeDefined()
  expect((await band.find({ key: 'cache-fold' }))?.props.label).toBe('✕')
  await band.unmount()
})

test('a cold cache opens the card with the re-cache price, and Hide folds it to one row', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: COLD_IDLE, context_tokens: 770000, model: 'claude-opus-5-5' })

  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const card = await band.find({ key: 'card' })
  expect(card).toBeDefined()
  expect(JSON.stringify(card)).toContain('Cache cold. Idle 3d 9h. Next message re-caches 770k tokens.')

  await band.press({ key: 'cache-fold' })
  expect(await band.find({ key: 'card' })).toBeUndefined()
  expect(await band.find({ text: ' 3d 9h' })).toBeDefined()
  // Opus 5.5: 770k tokens at the 1-hour write price, 2 x $4 per million.
  expect(await band.find({ text: '$6.16' })).toBeDefined()
  await band.unmount()
})

test('squeezed, the folded cache stacks as a third block, then takes its own row', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: WARM_IDLE, context_tokens: 770000, model: 'claude-opus-5-5' })

  const half = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 53 } })
  expect(await half.find({ key: 'block' })).toBeDefined()
  expect(await half.find({ text: '42m' })).toBeDefined()
  expect(await half.find({ text: '$0.15' })).toBeDefined()
  await half.unmount()

  const narrow = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 33 } })
  expect(await narrow.find({ key: 'cache' })).toBeDefined()
  await narrow.press({ key: 'cache-fold' })
  expect(await narrow.find({ key: 'card' })).toBeDefined()
  await narrow.unmount()
})

test('the terminal draws the cache as text, with no drawings and no fold button', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: COLD_IDLE, context_tokens: 770000, model: 'claude-opus-5-5' })

  const band = await $.ui.mount({ plugin: 'emberline', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: ' COLD ' })).toBeDefined()
  expect(await band.find({ text: '$6.16' })).toBeDefined()
  expect(await band.findAll({ type: 'Svg' })).toEqual([])
  expect(await band.find({ key: 'cache-fold' })).toBeUndefined()
  expect(await band.find({ key: 'card' })).toBeUndefined()
  await band.unmount()
})

test('a cleared session drops the cache until the next reply', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: COLD_IDLE, context_tokens: 770000, model: 'claude-opus-5-5' })
  await $.classic.SessionStart({ source: 'clear' })

  const band = await $.ui.mount({ plugin: 'emberline', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect((await band.findAll({ type: 'Svg' })).filter(s => !String(s.props.alt).endsWith('% left'))).toEqual([])
  expect(await band.find({ text: ' 99% left' })).toBeDefined()
  await band.unmount()
})

const terminalBand = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], start: Record<string, unknown>) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'resume', ...start })
  return $.ui.mount({ plugin: 'emberline', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
}

test('an older model in a family is priced at its own rate, not the newest one', async ($, on) => {
  // Opus 4.8: 770k tokens at the 1-hour write price, 2 x $5 per million.
  const band = await terminalBand($, on, { seconds_since_last_response: COLD_IDLE, context_tokens: 770000, model: 'claude-opus-4-8' })
  expect(await band.find({ text: '$7.70' })).toBeDefined()
  await band.unmount()
})

test('Haiku 5.5 past 100k prompt tokens is priced at its higher rate', async ($, on) => {
  // 300k tokens at the 1-hour write price, 2 x $0.50 per million.
  const band = await terminalBand($, on, { seconds_since_last_response: COLD_IDLE, context_tokens: 300000, model: 'claude-haiku-5-5' })
  expect(await band.find({ text: '$0.30' })).toBeDefined()
  await band.unmount()
})

test('a resume the engine says outlived the cache shows cold, even inside the hour', async ($, on) => {
  const band = await terminalBand($, on, { seconds_since_last_response: 600, context_tokens: 770000, model: 'claude-opus-5-5', prompt_cache_likely_expired: true })
  expect(await band.find({ text: ' COLD ' })).toBeDefined()
  await band.unmount()
})

test('a 5-minute cache prices its cold write at 1.25 times input', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: WINDOWS } }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: COLD_IDLE, context_tokens: 800000, model: 'claude-opus-5-5' })
  await ($.classic.PostModelSwitch as (e: unknown) => Promise<unknown>)({
    from_model: 'claude-opus-5-5', to_model: 'claude-opus-5-5', requested_model: null, source: 'resume',
    context_tokens: 800000, prompt_cache_warm: false, cache_ttl: '5m', estimated_cache_write_usd: 4, pricing: 'catalog',
  })
  // Opus 5.5: 800k tokens at 1.25 x $4 per million.
  const band = await $.ui.mount({ plugin: 'emberline', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ text: '$4.00' })).toBeDefined()
  await band.unmount()
})
