import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { capFrom, coldAtMs, emberLeftMs, HOUR_MS, shouldPing, untilFrom } from '../hooks/warm'
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

/** `sleeps`: a test that naps gets the hook that stalls state reads; the others skip its cost on every read. */
const start = async ($: Engine, on: On, fork: Fork = GOOD, now: number = NOW, sleeps = false) => {
  const saved: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: saved[e.key] }) as never)
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined } as never
  })
  const clock = mock.clock(on, { now })
  const span = sleeps ? nap(on, clock) : { from: Infinity, to: 0 }
  const asked: string[] = []
  const sent: string[] = []
  const toasts: string[] = []
  /** The auto keep-warm setting, as the /config menu holds it now. */
  const settings = { autoKeepWarm: 'off' }
  on('config.list', () => ({ value: [{ key: 'emberline.autoKeepWarm', label: 'Auto keep-warm', kind: 'choice', value: settings.autoKeepWarm, options: ['off', '1h', '2h', '6h', '12h'], provider: { kind: 'plugin', name: 'emberline' }, isLocked: false }] }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.cwd', () => ({ value: '/home/k/demo' }) as never)
  on('session.model', () => ({ value: MODEL }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: TOKENS }, rateLimits: [] } }))
  on('ui.notify', (_, e) => {
    sent.push(e.text)
    return { value: { isSent: true, channel: 'test' } } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('model.fork', async (_, e) => {
    asked.push(e.prompt)
    return { value: await fork() } as never
  })
  on('session.compact', (_, e) => ({ messages: e.messages }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('classic.PostModelSwitch', () => ({}) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: MODEL, ...USAGE } } as never
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/home/k/demo' })
  return { clock, asked, sent, saved, toasts, settings, span }
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
/** A cold cache opens its card, so the state is read from the drawings' words, folded or not. */
const isColdOn = async (ui: Awaited<ReturnType<typeof band>>) =>
  (await ui.findAll({ type: 'Svg' })).some(s => s.props.alt === 'COLD' || String(s.props.alt).startsWith('Cache cold'))

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

test('while a turn holds the pings back, the band shows the cache hour, not Ember', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await command($, '2h')
  // A turn left open, as at an unanswered permission prompt: no ping can come.
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 'open', text: 'hi' })
  await clock.advance(55 * MIN)

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /^ ember/ })).toBeUndefined()
  expect(await ui.find({ text: ' 5m' })).toBeDefined()
  await ui.unmount()
})

test('too late for a ping, the band shows the cache hour, not Ember', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await clock.advance(59 * MIN)
  await command($, '2h')

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /^ ember/ })).toBeUndefined()
  expect(await ui.find({ text: ' 1m' })).toBeDefined()
  await ui.unmount()
})

test('the open card counts down Ember and says when the cache will go cold', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await command($, '2h')
  await clock.advance(70 * MIN)

  const ui = await band($)
  await ui.press({ key: 'cache-fold' })
  const card = JSON.stringify(await ui.find({ key: 'card' }))
  // Pings at 50 and 100 minutes; the one at 150 is past the cap, so cold at 160.
  const at = new Date(NOW + 160 * MIN)
  const clockText = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  expect(card).toContain(`Ember holds it for 50m more, then it goes cold about ${clockText}`)
  expect(card).not.toContain('Goes cold in')
  await ui.unmount()
})

test('no expiry warning while a ping is still in flight', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const { clock, asked, sent } = await start($, on, () => gate.then(GOOD))
  await reply($)
  await command($, '2h')

  await clock.advance(50 * MIN)
  expect(asked.length).toBe(1)
  await clock.advance(90_000) // three more ticks with the fork pending
  expect(sent).toEqual([])
  release()
})

test('a ping that never answers stops keep-warm and frees the next ping', async ($, on) => {
  let forks = 0
  const { clock, asked, sent } = await start($, on, () => (forks++ === 0 ? new Promise(() => {}) : GOOD()))
  await reply($)
  await command($, '2h')

  await clock.advance(50 * MIN)
  expect(asked.length).toBe(1)
  await clock.advance(4 * MIN)
  expect(sent.some(t => t.includes('Keep-warm stopped'))).toBe(true)
  const ui = await band($)
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe('off')
  await ui.unmount()
  // The hung fork no longer holds the guard: a manual ping runs and answers.
  const r = await command($, 'ping')
  expect(r.text).toContain('Ping read')
})

test('a reply during a ping keeps its own, later cache time', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const { clock, asked } = await start($, on, () => gate.then(GOOD))
  await reply($)
  await command($, '2h')
  await clock.advance(50 * MIN)
  expect(asked.length).toBe(1)

  await clock.advance(MIN)
  await reply($) // 51 minutes: the person is back while the ping is out
  release()
  await clock.advance(49 * MIN + 30_000) // 49.5 minutes after the reply: no ping yet
  expect(asked.length).toBe(1)
  await clock.advance(MIN)
  expect(asked.length).toBe(2)
})

test('a /model switch marks the cache cold and holds the pings until the next reply', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await command($, '2h')
  await ($.classic.PostModelSwitch as (e: unknown) => Promise<unknown>)({
    from_model: MODEL, to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command',
    context_tokens: TOKENS, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 1.2, pricing: 'catalog',
  })

  const ui = await band($)
  expect(await isColdOn(ui)).toBe(true)
  await ui.unmount()
  await clock.advance(55 * MIN)
  expect(asked).toEqual([])

  await reply($) // the new model's cache now exists
  await clock.advance(51 * MIN)
  expect(asked.length).toBe(1)
})

test('a resume that restores the same model leaves the cache warm', async ($, on) => {
  await start($, on)
  await reply($)
  await ($.classic.PostModelSwitch as (e: unknown) => Promise<unknown>)({
    from_model: MODEL, to_model: MODEL, requested_model: null, source: 'resume',
    context_tokens: TOKENS, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 1.2, pricing: 'catalog',
  })
  const ui = await band($)
  expect(await isColdOn(ui)).toBe(false)
  await ui.unmount()
})

test('a 5-minute cache goes cold at 5 minutes, and keep-warm never pings it', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  await ($.classic.PostModelSwitch as (e: unknown) => Promise<unknown>)({
    from_model: MODEL, to_model: MODEL, requested_model: null, source: 'resume',
    context_tokens: TOKENS, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 1.2, pricing: 'catalog',
  })
  await command($, '2h')

  const early = await band($)
  expect(await early.find({ type: 'Text', text: /^ ember/ })).toBeUndefined()
  await early.unmount()
  await clock.advance(6 * MIN)
  const ui = await band($)
  expect(await isColdOn(ui)).toBe(true)
  await ui.unmount()
  await clock.advance(55 * MIN)
  expect(asked).toEqual([])
})

const SWITCH = { requested_model: null, context_tokens: TOKENS, prompt_cache_warm: true, estimated_cache_write_usd: 1.2, pricing: 'catalog' }
const modelSwitch = ($: Engine, e: Record<string, unknown>) =>
  ($.classic.PostModelSwitch as (e: unknown) => Promise<unknown>)({ ...SWITCH, from_model: MODEL, to_model: MODEL, source: 'command', cache_ttl: '1h', ...e })

test('after a /model switch keep-warm no longer skips the idle compaction', async ($, on) => {
  await start($, on)
  await reply($)
  await command($, '2h')
  await modelSwitch($, { to_model: 'claude-sonnet-5-5' })
  expect((await compact($, 'precompute')).skip).toBeUndefined()
})

test('once no ping can come, keep-warm no longer skips the idle compaction', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await command($, '2h')
  // A turn left open past 58 minutes: no ping came, and none can now.
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 'open', text: 'hi' })
  await clock.advance(60 * MIN)
  expect((await compact($, 'precompute')).skip).toBeUndefined()
})

test('two pings asked at once fork once', async ($, on) => {
  const { asked } = await start($, on)
  await reply($)
  await Promise.all([command($, 'ping'), command($, 'ping')])
  expect(asked.length).toBe(1)
})

test('a resume onto another model leaves the cache as it was', async ($, on) => {
  await start($, on)
  await reply($)
  await modelSwitch($, { from_model: 'claude-sonnet-5-5', to_model: MODEL, source: 'resume' })
  const ui = await band($)
  expect(await isColdOn(ui)).toBe(false)
  await ui.unmount()
})

test('a cache a /model switch made cold gets no expiry warning and no manual ping', async ($, on) => {
  const { clock, asked, sent } = await start($, on)
  await reply($)
  await modelSwitch($, { to_model: 'claude-sonnet-5-5' })
  await clock.advance(51 * MIN)
  expect(sent).toEqual([])
  const r = await command($, 'ping')
  expect(r.text).toContain('Not pinged')
  expect(asked).toEqual([])
})

test('a later switch to a 1-hour cache restores the hour', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await modelSwitch($, { source: 'resume', cache_ttl: '5m' })
  await modelSwitch($, { source: 'resume', cache_ttl: '1h' })
  await clock.advance(10 * MIN)
  const ui = await band($)
  expect(await isColdOn(ui)).toBe(false)
  await ui.unmount()
})

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('until holds to a clock time, and a new prompt does not move it', async ($, on) => {
  const { clock, asked } = await start($, on)
  await reply($)
  const r = await command($, `until ${hhmm(NOW + 90 * MIN)}`)
  expect(r.text).toBe(`Keep-warm on until ${hhmm(NOW + 90 * MIN)}, this session only.`)
  await clock.advance(51 * MIN)
  expect(asked.length).toBe(1)
  await clock.advance(9 * MIN)
  await reply($) // at 60 minutes: a 1h cap would now run to 120, until stays at 90
  await clock.advance(55 * MIN)
  expect(asked.length).toBe(1)
  // Past its time, until switches keep-warm off rather than showing a stale clock.
  const ui = await band($)
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe('off')
  await ui.unmount()
})

test('a ping falling due as the until time arrives does not fire', async ($, on) => {
  const { clock, asked } = await start($, on)
  await command($, `until ${hhmm(NOW + 95 * MIN)}`)
  await clock.advance(45 * MIN)
  await reply($) // the next ping would fall due at 95 minutes, the until time itself
  await clock.advance(50 * MIN)
  expect(asked).toEqual([])
})

test('an until time ends on time even while a turn runs', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await command($, `until ${hhmm(NOW + 90 * MIN)}`)
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 'open', text: 'hi' })
  await clock.advance(91 * MIN)
  const ui = await band($)
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe('off')
  await ui.unmount()
})

test('the picker lists each until time once, across a clock change', async ($, on) => {
  // 01:30 in Athens two hours before the 2027 fall-back: 03:00 comes twice. Other zones pass trivially.
  await start($, on, GOOD, Date.parse('2027-10-30T22:30:00Z'))
  await reply($)
  const ui = await band($)
  const values = ((await ui.find({ key: 'warm-pick' }))?.props.options as { value: string }[]).map(o => o.value)
  expect(new Set(values).size).toBe(values.length)
  await ui.unmount()
})

test('until refuses a time it cannot reach within 12 hours', async ($, on) => {
  await start($, on)
  await reply($)
  expect((await command($, `until ${hhmm(NOW - 60 * MIN)}`)).text).toContain('Usage')
  expect((await command($, 'until 25:00')).text).toContain('Usage')
})

test('the picker offers the next three full hours at least an hour away', async ($, on) => {
  await start($, on)
  await reply($)
  const first = new Date(NOW + 60 * MIN)
  if (first.getMinutes() || first.getSeconds() || first.getMilliseconds()) first.setMinutes(60, 0, 0)
  const untils = [0, 1, 2].map(i => `until ${hhmm(first.getTime() + i * 60 * MIN)}`)
  const ui = await band($)
  const options = (await ui.find({ key: 'warm-pick' }))?.props.options as { value: string; label: string }[]
  expect(options.map(o => o.value)).toEqual(['off', '1h', '2h', '6h', '12h', ...untils, 'ping', 'status'])
  expect(options.find(o => o.value === untils[0])?.label).toBe(`Until ${untils[0].slice(6)}`)
  await ui.select({ key: 'warm-pick', value: untils[1] })
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe(untils[1])
  await ui.unmount()
})

test('/keep-warm status says what keep-warm and the cache are doing', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  expect((await command($, 'status')).text).toBe(`Keep-warm off. Cache warm, 300k tokens, cold about ${hhmm(NOW + 60 * MIN)}.`)

  await command($, '2h')
  await clock.advance(51 * MIN) // one ping, at 50 minutes
  const each = (299_000 * 0.2 + 10 * 4 + 20 * 20 + 50 * 8) / 1e6
  const want = `Keep-warm on (2h), 1h 9m left. Cache warm, 300k tokens, cold about ${hhmm(NOW + 160 * MIN)}. ` +
    `1 ping, $${each.toFixed(2)} spent, last ${hhmm(NOW + 50 * MIN)} read 299k.`
  expect((await command($, 'status')).text).toBe(want)
})

test('Status in the picker shows the same words and keeps the time picked', async ($, on) => {
  const { toasts } = await start($, on)
  await reply($)
  await command($, '2h')
  const said = (await command($, 'status')).text
  const ui = await band($)
  await ui.select({ key: 'warm-pick', value: 'status' })
  expect(toasts).toContain(said)
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe('2h')
  await ui.unmount()
})

test('Ping now in the picker pings, says what the cache served, and keeps the time picked', async ($, on) => {
  const { asked, toasts } = await start($, on)
  await reply($)
  await command($, '2h')
  const ui = await band($)
  expect((await ui.find({ key: 'warm-pick' }))?.props.options).toContainEqual({ value: 'ping', label: 'Ping now' })
  await ui.select({ key: 'warm-pick', value: 'ping' })
  expect(asked.length).toBe(1)
  expect(toasts).toContain('Ping read 299k tokens from the cache.')
  expect((await ui.find({ key: 'warm-pick' }))?.props.value).toBe('2h')
  await ui.unmount()
})

test('Ping now waits while a turn runs', async ($, on) => {
  const { asked, toasts } = await start($, on)
  await reply($)
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 'open', text: 'hi' })
  const ui = await band($)
  await ui.select({ key: 'warm-pick', value: 'ping' })
  expect(asked).toEqual([])
  expect(toasts).toContain('Not pinged: a turn is running.')
  await ui.unmount()
})

test('a second ping asked while one is out says so', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const { clock, asked } = await start($, on, () => gate.then(GOOD))
  await reply($)
  const first = command($, 'ping')
  await clock.advance(1000) // the first is now out, waiting on the fork
  expect(asked.length).toBe(1)
  expect((await command($, 'ping')).text).toBe('A ping is already out.')
  release()
  await first
})

test('a ping whose cost is unknown makes the tally a floor', async ($, on) => {
  let forks = 0
  const { clock } = await start($, on, () => (forks++ === 0 ? new Promise(() => {}) : GOOD()))
  await reply($)
  await command($, '2h')
  await clock.advance(54 * MIN) // the first ping times out at 53 minutes
  await command($, 'ping')
  const ui = await band($)
  await ui.press({ key: 'cache-fold' })
  expect(JSON.stringify(await ui.find({ key: 'card' }))).toContain('Ember: 2 pings, at least $0.06 spent')
  await ui.unmount()
})

test('the card keeps an Ember ledger for this session', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await command($, '2h')
  await clock.advance(101 * MIN) // pings at 50 and 100 minutes

  const ui = await band($)
  await ui.press({ key: 'cache-fold' })
  const card = JSON.stringify(await ui.find({ key: 'card' }))
  // Each ping: 299k read at $0.20, 10 input at $4, 20 output at $20, 50 written at $8 per million.
  const each = (299_000 * 0.2 + 10 * 4 + 20 * 20 + 50 * 8) / 1e6
  expect(card).toContain(`Ember: 2 pings, $${(2 * each).toFixed(2)} spent, against $2.40 to re-cache. Last ping ${hhmm(NOW + 100 * MIN)} read 299k.`)
  await ui.unmount()
})

test('when Ember runs out it says so once, with the time the cache goes cold', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await command($, '2h')
  await clock.advance(121 * MIN)
  expect(sent.filter(t => t.includes('Ember ended'))).toEqual([`demo: Ember ended. 300k tokens go cold about ${hhmm(NOW + 160 * MIN)}`])
  await clock.advance(20 * MIN)
  expect(sent.filter(t => t.includes('Ember ended')).length).toBe(1)
})

test('Ember running out on a cache already cold says nothing', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await command($, '1h')
  await modelSwitch($, { to_model: 'claude-sonnet-5-5' })
  await clock.advance(61 * MIN)
  expect(sent.filter(t => t.includes('Ember ended'))).toEqual([])
})

test('switching Ember off is not Ember running out', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await command($, '1h')
  await command($, 'off')
  await clock.advance(70 * MIN)
  expect(sent.filter(t => t.includes('Ember ended'))).toEqual([])
})

test('with keep-warm off, the expiry warning weighs a re-cache against keeping it warm', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await clock.advance(50 * MIN)
  // Opus 5.5 at 300k: a 1-hour write at $8 per million; Ember 2h from here pings 3 times at $0.20 per million.
  expect(sent).toEqual(['demo: 300k tokens go cold in 10m. Re-cache $2.40; Ember 2h would keep it warm for about $0.18.'])
})

test('too late for a ping, the expiry warning makes no offer', async ($, on) => {
  const { clock, sent } = await start($, on)
  // Back after 58.5 idle minutes: keep-warm could no longer ping in time.
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'resume', seconds_since_last_response: 3510, context_tokens: TOKENS, model: MODEL })
  await clock.advance(30_000)
  const warning = sent.find(t => t.includes('go cold in'))
  expect(warning).toBe('demo: 300k tokens go cold in 1m')
})

test('with keep-warm on but its time used up, the expiry warning makes no offer', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await command($, '1h') // one ping at 50 minutes; the next would be past the hour
  await clock.advance(101 * MIN)
  const warning = sent.find(t => t.includes('go cold in 10m'))
  expect(warning).toBe('demo: 300k tokens go cold in 10m')
})

test('a 5-minute cache gets no expiry warning after every reply', async ($, on) => {
  const { clock, sent } = await start($, on)
  await ($.classic.PostModelSwitch as (e: unknown) => Promise<unknown>)({
    from_model: MODEL, to_model: MODEL, requested_model: null, source: 'resume',
    context_tokens: TOKENS, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 1.2, pricing: 'catalog',
  })
  await reply($)
  await clock.advance(MIN)
  expect(sent).toEqual([])
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
  const values = (pick?.props.options as { value: string }[]).map(o => o.value)
  expect(values.slice(0, 5)).toEqual(['off', '1h', '2h', '6h', '12h'])
  expect(values.slice(-2)).toEqual(['ping', 'status'])

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

test('until times: the next such clock time within 12 hours, or nothing', async () => {
  expect(untilFrom(`until ${hhmm(NOW + 150 * MIN)}`, NOW)).toBe(NOW + 150 * MIN)
  expect(untilFrom(`until ${hhmm(NOW - 60 * MIN)}`, NOW)).toBeNull() // tomorrow is 23 hours away
  const lateEvening = new Date(NOW)
  lateEvening.setHours(23, 0, 0, 0) // from 23:00, 01:00 is tomorrow, two hours on
  expect(untilFrom(`until ${hhmm(lateEvening.getTime() + 120 * MIN)}`, lateEvening.getTime())).toBe(lateEvening.getTime() + 120 * MIN)
  expect(untilFrom('until 25:00', NOW)).toBeNull()
  expect(untilFrom('until 9', NOW)).toBeNull()
  expect(untilFrom('2h', NOW)).toBeNull()
})

test('ping timing: an until time ends the window whatever the last prompt', async () => {
  expect(shouldPing({ ...BASE, untilAt: 10 * MIN })).toBe(true)
  expect(shouldPing({ ...BASE, lastPromptAt: 0, untilAt: 0 })).toBe(false)
  expect(emberLeftMs({ ...BASE, untilAt: 10 * MIN })).toBe(10 * MIN)
})

test('ember time: what is left of the cap while a ping can still come', async () => {
  expect(emberLeftMs({ ...BASE, lastPromptAt: -30 * MIN })).toBe(90 * MIN)
  expect(emberLeftMs({ ...BASE, capMs: null })).toBe(0)
  expect(emberLeftMs({ ...BASE, isBusy: true })).toBe(0)
  expect(emberLeftMs({ ...BASE, lastAt: -58 * MIN })).toBe(0)
  expect(emberLeftMs({ ...BASE, lastPromptAt: -120 * MIN })).toBe(0)
})

test('cold time: an hour after the last ping the cap allows', async () => {
  const at0 = { now: 0, lastAt: 0, lastPromptAt: 0, capMs: 2 * HOUR_MS, isBusy: false }
  expect(coldAtMs(at0)).toBe(160 * MIN)
  expect(coldAtMs({ ...at0, capMs: HOUR_MS })).toBe(110 * MIN)
  expect(coldAtMs({ ...at0, capMs: null })).toBe(60 * MIN)
  expect(coldAtMs({ ...at0, isBusy: true })).toBe(60 * MIN)
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

/** A sleeping computer: every state read the band makes waits until the nap ends, so no tick runs inside it. */
const nap = (on: On, clock: { now(): number; sleep(ms: number): Promise<void> }) => {
  const span = { from: Infinity, to: 0 }
  on('state.get', (_, e, next) => {
    const now = clock.now()
    // No await outside a nap: an extra hop on every read slows the long tests.
    return now >= span.from && now < span.to ? clock.sleep(span.to - now).then(() => next(e)) : next(e)
  })
  return span
}
/** A turn with no prompt before it: the cache's time moves, the idle window's start does not. */
const turn = async ($: Engine) => {
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 't', text: 'hi' })
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: MODEL, messageCount: 1 })
  for await (const _ of stream) void _
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', usage: { model: MODEL, ...USAGE } })
}
const clockAt = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const keepWarmNotices = (sent: string[]) => sent.filter(t => t.includes('Ember') || t.includes('go cold in'))

test('a ping missed while the computer slept is told once, alone, with when the cache goes cold', async ($, on) => {
  const { clock, sent, asked, span } = await start($, on, GOOD, NOW, true)
  await reply($)
  await command($, '2h')
  span.from = NOW + 40 * MIN
  span.to = NOW + 59 * MIN
  await clock.advance(60 * MIN)
  expect(asked).toEqual([])
  expect(keepWarmNotices(sent)).toEqual([`demo: Ember missed its ping, likely while the computer slept. 300k tokens go cold about ${clockAt(NOW + HOUR_MS)}`])
})

test('a sleep past the hour says the cache went cold', async ($, on) => {
  const { clock, sent, span } = await start($, on, GOOD, NOW, true)
  await reply($)
  await command($, '2h')
  span.from = NOW + 40 * MIN
  span.to = NOW + 70 * MIN
  await clock.advance(71 * MIN)
  expect(keepWarmNotices(sent)).toEqual([`demo: Ember missed its ping, likely while the computer slept. 300k tokens went cold at ${clockAt(NOW + HOUR_MS)}`])
})

test('no missed-ping notice when Ember is switched on after the ping would have been due', async ($, on) => {
  const { clock, sent, span } = await start($, on, GOOD, NOW, true)
  await reply($)
  span.from = NOW + 40 * MIN
  span.to = NOW + 59 * MIN
  await clock.advance(59 * MIN)
  await command($, '2h')
  await clock.advance(MIN)
  await clock.advance(40 * MIN)
  await command($, '6h')
  await clock.advance(MIN)
  expect(sent.filter(t => t.includes('missed'))).toEqual([])
})

test('no missed-ping notice when the timer ran through the window, a turn kept the ping back, or its time ran out first', async ($, on) => {
  const { clock, sent } = await start($, on)
  await reply($)
  await command($, '2h')
  await clock.advance(45 * MIN)
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 't', text: 'hi' }) // a permission prompt, say
  await clock.advance(16 * MIN)
  expect(sent.filter(t => t.includes('missed'))).toEqual([])
  await ($.turn.complete as (e: unknown) => Promise<unknown>)({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' })
  await reply($)
  await command($, '1h') // one ping at 50 minutes; the next would fall past the hour
  await clock.advance(115 * MIN)
  expect(sent.filter(t => t.includes('missed'))).toEqual([])
})

test('no missed-ping notice for a cache keep-warm cannot hold: a switched model starts its own', async ($, on) => {
  const { clock, sent, span } = await start($, on, GOOD, NOW, true)
  await reply($)
  await command($, '2h')
  await ($.classic.PostModelSwitch as (e: unknown) => Promise<unknown>)({
    from_model: MODEL, to_model: 'claude-sonnet-5-5', requested_model: null, source: 'command',
    context_tokens: TOKENS, prompt_cache_warm: false, cache_ttl: '1h', estimated_cache_write_usd: 1.2, pricing: 'catalog',
  })
  span.from = NOW + 40 * MIN
  span.to = NOW + 59 * MIN
  await clock.advance(60 * MIN)
  expect(sent.filter(t => t.includes('missed'))).toEqual([])
})

test('a missed ping and the end of Ember\'s window in the same sleep make one notice', async ($, on) => {
  const { clock, sent, span } = await start($, on, GOOD, NOW, true)
  await command($, '1h') // the window ends an hour from here
  await clock.advance(5 * MIN)
  await turn($) // the cache's hour starts 5 minutes in; its ping falls due at 55, inside the window
  span.from = NOW + 40 * MIN
  span.to = NOW + 64 * MIN
  await clock.advance(70 * MIN)
  expect(keepWarmNotices(sent)).toEqual([`demo: Ember missed its ping, likely while the computer slept. 300k tokens go cold about ${clockAt(NOW + 65 * MIN)}`])
})

test('auto keep-warm switches on at a turn\'s end for a large session, and pings while it is away', async ($, on) => {
  const { clock, asked, settings } = await start($, on)
  settings.autoKeepWarm = '2h'
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm on (2h)')
  await clock.advance(51 * MIN)
  expect(asked.length).toBe(1)
})

test('auto keep-warm reads the setting as it is now, and stays out of a session where the person switched keep-warm off', async ($, on) => {
  const { clock, asked, settings } = await start($, on)
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm off')
  settings.autoKeepWarm = '1h'
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm on (1h)')
  await command($, 'off')
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm off')
  await clock.advance(55 * MIN)
  expect(asked).toEqual([])
})

test('after /clear, auto keep-warm may switch on again: it is a new conversation', async ($, on) => {
  const { settings } = await start($, on)
  settings.autoKeepWarm = '2h'
  await reply($)
  await command($, 'off')
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'clear' })
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm on (2h)')
})

test('the open card carries the hit of this conversation\'s requests, and /clear starts it over', async ($, on) => {
  const { clock } = await start($, on)
  await reply($)
  await reply($)
  await clock.advance(61 * MIN) // cold opens the card
  let ui = await band($)
  const alts = async () => (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.alt))
  expect((await alts()).some(a => a.includes('Cache hit over the last 2 requests: lowest 100%, latest 100%.'))).toBe(true)
  await ui.unmount()
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'clear' })
  await reply($)
  await clock.advance(61 * MIN)
  ui = await band($)
  expect((await alts()).some(a => a.includes('Cache hit over'))).toBe(false)
  await ui.unmount()
})

test('auto keep-warm also stays out after Off from the picker, or after a ping that missed the cache', async ($, on) => {
  const missed: Fork = () => ({ isAnswered: true, text: 'ok', usage: { ...USAGE, cache_read_input_tokens: 0 } })
  const { clock, settings } = await start($, on, missed)
  settings.autoKeepWarm = '2h'
  await reply($)
  const ui = await band($)
  await ui.select({ key: 'warm-pick', value: 'off' })
  await ui.unmount()
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm off')

  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'clear' })
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm on (2h)')
  await clock.advance(51 * MIN) // the ping reads nothing from the cache and stops keep-warm
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm off')
})

test('no missed-ping notice for a sleep after Ember\'s window ended, though it is still switched on', async ($, on) => {
  const { clock, sent, asked, span } = await start($, on, GOOD, NOW, true)
  await reply($)
  await command($, '1h') // one ping at 50 minutes, then the window ends at 60
  span.from = NOW + 95 * MIN
  span.to = NOW + 110 * MIN
  await clock.advance(111 * MIN)
  expect(asked.length).toBe(1)
  expect(sent.filter(t => t.includes('missed'))).toEqual([])
})

test('auto keep-warm stays out once an until time ends: the person chose when it stops', async ($, on) => {
  const { clock, settings } = await start($, on)
  settings.autoKeepWarm = '12h'
  await reply($)
  const end = new Date(NOW + 70 * MIN)
  end.setSeconds(0, 0)
  const hhmm = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
  await command($, `until ${hhmm}`)
  await clock.advance(75 * MIN)
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm off')
})

test('auto keep-warm also stays out after the bare toggle or the mobile button switches it off', async ($, on) => {
  const { settings } = await start($, on)
  settings.autoKeepWarm = '2h'
  await reply($)
  await command($, '') // on, so the bare command switches it off
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm off')
  await ($.classic.SessionStart as (e: unknown) => Promise<unknown>)({ source: 'clear' })
  await reply($)
  const ui = await $.ui.mount({ plugin: 'emberline', surface: 'mobile', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'warm-toggle' }) // on, so the button switches it off
  await ui.unmount()
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm off')
})

test('auto keep-warm leaves a 5-minute cache alone: it cannot be held', async ($, on) => {
  const { settings } = await start($, on)
  settings.autoKeepWarm = '2h'
  await ($.classic.PostModelSwitch as (e: unknown) => Promise<unknown>)({
    from_model: MODEL, to_model: MODEL, requested_model: null, source: 'resume',
    context_tokens: TOKENS, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 1.2, pricing: 'catalog',
  })
  await reply($)
  expect((await command($, 'status')).text).toContain('Keep-warm off')
})

test('a missed ping in a window that ends before the cache goes cold makes one notice, not two', async ($, on) => {
  const { clock, sent, span } = await start($, on, GOOD, NOW, true)
  await command($, '1h') // the window ends an hour from here
  await clock.advance(MIN)
  await turn($) // the cache goes cold a minute after the window ends
  span.from = NOW + 40 * MIN
  span.to = NOW + 59.2 * MIN
  await clock.advance(62 * MIN)
  expect(keepWarmNotices(sent)).toEqual([`demo: Ember missed its ping, likely while the computer slept. 300k tokens go cold about ${clockAt(NOW + 61 * MIN)}`])
})

test('no missed-ping notice when a turn is already under way as the timer wakes: its request holds the cache', async ($, on) => {
  const { clock, sent, span } = await start($, on, GOOD, NOW, true)
  await reply($)
  await command($, '2h')
  span.from = NOW + 40 * MIN
  span.to = NOW + 59 * MIN
  await clock.advance(58.4 * MIN)
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 't', text: 'hi' })
  await clock.advance(2 * MIN)
  expect(sent.filter(t => t.includes('missed'))).toEqual([])
})
