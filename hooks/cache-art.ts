// The cache card's drawings. Pure: each function returns an SVG string the band
// hands to Svg. Nothing here touches the engine.

import { SANS } from './font'
import { ratesOf } from './prices'

export type Mode = 'warm' | 'cold'
export type Kind = 'wide' | 'stacked' | 'tight'

// Neutral greys: the band has no background of its own and sits on the app's.
export const TEXT = '#e6e6e6'
export const MUTED = '#8f8f8f'
export const EMPTY = '#4d4d4d'
export const LINE = '#3d3d3d'
/** The one accent. Colour means state: anything else stays calm. */
export const ACCENT = '#9fb3c8'
export const WARN = '#d0a85c'
export const ERROR = '#c47f7f'

// The cache's two states in a muted shade, so neither pulls the eye.
export const HUE: Record<Mode, string> = { warm: '#7fb09a', cold: '#6aaabd' }
/** Text on a filled chip. */
export const INK = '#1c1a16'
export const WORD: Record<Mode, string> = { warm: 'WARM', cold: 'COLD' }

/** A hit share under this means a request rebuilt most of the cache. */
export const HIT_LOW_AT = 50

/** The prompt cache lives an hour after the last request that read or wrote it, unless the engine reports 5 minutes. */
export const TTL_MIN = 60
export const TTL_MS = TTL_MIN * 60 * 1000

/** One row needs about 78 columns for two windows; under that, each window stacks. */
export const WIDE_AT = 78
/** Under this the dot bars shrink and the cache gets its own row. */
export const TIGHT_AT = 42

export const kindOf = (columns: number): Kind => (columns >= WIDE_AT ? 'wide' : columns >= TIGHT_AT ? 'stacked' : 'tight')

// The card's columns: each family priced at its current model. The session's own column
// uses its exact model, so an older version shows its own price.
export type Model = { id: string; NAME: string; ref: string }
export const MODELS: Model[] = [
  { id: 'fable', NAME: 'FABLE', ref: 'claude-fable-5-1' },
  { id: 'opus', NAME: 'OPUS', ref: 'claude-opus-5-5' },
  { id: 'sonnet', NAME: 'SONNET', ref: 'claude-sonnet-5-5' },
  { id: 'haiku', NAME: 'HAIKU', ref: 'claude-haiku-5-5' },
]

/** Which row of MODELS a model id belongs to, or null for one the card doesn't price. */
export const familyOf = (model: string | null | undefined): string | null => {
  const m = (model ?? '').toLowerCase().replace('mythos', 'fable')
  return MODELS.find(x => m.includes(x.id))?.id ?? null
}

/** A 5-minute cache write bills 1.25 times input; the 1-hour write is the table's own rate. */
const SHORT_WRITE = 1.25

/** What the next message costs: a cold one writes the context at the cache's rate, a warm one reads it. Null for an unpriced model. */
export const nextCost = (model: string | null, mode: Mode, tokens: number, ttlMin = TTL_MIN): number | null => {
  const r = model ? ratesOf(model, tokens) : null
  if (!r) return null
  const write = ttlMin < TTL_MIN ? r[0] * SHORT_WRITE : r[3]
  return (tokens / 1e6) * (mode === 'cold' ? write : r[2])
}
export const usd = (n: number): string => '$' + n.toFixed(2)
export const tok = (n: number): string => (n >= 1e6 ? `${Number((n / 1e6).toFixed(1))}M` : `${Math.round(n / 1000)}k`)

/** Idle time the way the card writes it: 18m, 2h 5m, 3d 9h. */
export const fmtIdle = (ms: number): string => {
  const mins = Math.max(0, Math.floor(ms / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** What every drawing of the cache reads. */
export type CacheView = {
  mode: Mode
  /** How long since the last request, written out: 3d 9h, 18m. */
  idle: string
  /** The same in whole minutes, for the warm countdown. */
  idleMin: number
  /** Context the next request re-sends. */
  tokens: number
  /** The model's context window. */
  window: number
  /** This session's MODELS id, or null when the model isn't priced. */
  mine: string | null
  /** This session's model id, for its exact price. */
  model: string | null
  /** How long the cache lives, in minutes: 60, or 5 when the engine says so. */
  ttlMin: number
}

/** Keep-warm on the card: its time left, the share of the cap spent, and the clock time the cache goes cold. */
export type EmberView = { left: string; spent: number; coldAt: string }

/** A clock time in the machine's own zone: 14:40. */
export const fmtClock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------- SVG helpers ----------
export const svgDoc = (w: number, h: number, body: string, font: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  (font
    ? `<style>@font-face{font-family:RS;font-weight:100 900;src:url(data:font/woff2;base64,${SANS}) format('woff2')} text{font-family:RS,system-ui,'Segoe UI',sans-serif}</style>`
    : '') +
  body +
  '</svg>'

// ---------- Tick bars: thin LED segments, lit from the left ----------
const TICK_PITCH = 5
const TICK_W = 3
const TICK_H = 12

export const ticksSvg = (percent: number, width: number, colour: string): { source: string; w: number; h: number } => {
  const n = Math.floor(width / TICK_PITCH)
  const share = Math.max(0, Math.min(100, percent)) / 100
  const lit = share > 0 ? Math.max(1, Math.round(share * n)) : 0
  let g = ''
  for (let i = 0; i < n; i++) {
    g += `<rect x="${i * TICK_PITCH}" width="${TICK_W}" height="${TICK_H}" rx="0.5" fill="${i < lit ? colour : EMPTY}"/>`
  }
  return { source: svgDoc(width, TICK_H, g, false), w: width, h: TICK_H }
}

// ---------- Rounded chips (WARM, COLD, YOU) ----------
// A text background can't be rounded, so a chip is a small drawing. The mod can't
// measure text, so each chip's size was measured once, in the
// embedded font: width = the word plus 0.62 em of padding each side, height 1.65 em.
const CHIP: Record<string, { w: number; h: number }> = {
  'WARM@13': { w: 63, h: 21 },
  'COLD@13': { w: 58, h: 21 },
  'WARM@11': { w: 54, h: 18 },
  'COLD@11': { w: 50, h: 18 },
  'YOU@10': { w: 36, h: 17 },
}

export const chipShapes = (x: number, y: number, word: string, fill: string, size: number, ls: number): { w: number; h: number; svg: string } => {
  const { w, h } = CHIP[`${word}@${size}`] ?? { w: Math.round(word.length * size * 0.8 + size * 1.24), h: Math.round(size * 1.65) }
  return {
    w,
    h,
    svg:
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.round(h * 0.32)}" fill="${fill}"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2 + size * 0.36}" font-size="${size}" font-weight="700" letter-spacing="${ls}"` +
      ` text-anchor="middle" fill="${INK}">${word}</text>`,
  }
}

/** The WARM or COLD chip beside Robo in the band's row. */
export const chipSvg = (mode: Mode): { source: string; w: number; h: number } => {
  const c = chipShapes(0, 0, WORD[mode], HUE[mode], 11, 1)
  return { source: svgDoc(c.w, c.h, c.svg, true), w: c.w, h: c.h }
}

// ---------- Robo: bobbing when warm, frozen in ice when cold ----------
const ROBO_PIX = ['..X..X..', 'XXXXXXXX', 'XXXXXXXX', 'X.XXXX.X', 'XXXXXXXX', 'XXXXXXXX', 'X..XX..X']

const mix = (a: string, b: string, t: number): string =>
  '#' +
  [1, 3, 5]
    .map(i => Math.round(parseInt(a.substr(i, 2), 16) * (1 - t) + parseInt(b.substr(i, 2), 16) * t).toString(16).padStart(2, '0'))
    .join('')

// One path, not a rect per pixel: separate rects at fractional sizes leave faint
// seams between them, while one path fills the shared edges solid.
const pixels = (u: number, fill: string): string => {
  let d = ''
  ROBO_PIX.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === 'X') d += `M${x * u} ${y * u}h${u}v${u}h${-u}z`
    }),
  )
  return `<path d="${d}" fill="${fill}"/>`
}

/** Robo in a box `size` pixels square, top-left at x, y. SMIL only, so the Svg needs isInteractive. */
export const roboShapes = (x: number, y: number, size: number, mode: Mode): string => {
  const ease = 'calcMode="spline" keyTimes="0;0.5;1" keySplines=".45 0 .55 1;.45 0 .55 1"'
  if (mode === 'warm') {
    // Robo takes the WARM chip's red, so the two read as one badge.
    const ROBO = HUE.warm
    const u = size / 10
    const ox = x + u
    const oy = y + 1.6 * u
    return (
      `<g transform="translate(${ox} ${oy})" shape-rendering="crispEdges">` +
      `<ellipse cx="${4 * u}" cy="${7.75 * u}" rx="${3 * u}" ry="${0.42 * u}" fill="#000" opacity=".4" shape-rendering="auto">` +
      `<animate attributeName="rx" values="${3 * u};${2.3 * u};${3 * u}" dur="1.2s" repeatCount="indefinite" ${ease}/></ellipse>` +
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 ${-1.1 * u};0 0" dur="1.2s" repeatCount="indefinite" ${ease}/>` +
      pixels(u, ROBO) +
      // A blink every few seconds: the eye holes fill for a moment.
      `<g opacity="0"><rect x="${u}" y="${3 * u}" width="${u}" height="${u}" fill="${ROBO}"/><rect x="${6 * u}" y="${3 * u}" width="${u}" height="${u}" fill="${ROBO}"/>` +
      `<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.9;0.91;0.95;1" dur="3.4s" repeatCount="indefinite"/></g>` +
      `</g></g>`
    )
  }
  // Cold: still, pale, inside a rounded ice block with icicles and one twinkle.
  const u = size / 12.2
  const ice = mix(HUE.cold, '#ffffff', 0.5)
  const ox = x + 1.6 * u
  const oy = y + 1.6 * u
  const bx = -1.2 * u
  const by = -1.2 * u
  const bw = 10.4 * u
  const bh = 9.4 * u
  let s = `<g transform="translate(${ox} ${oy})">`
  s += pixels(u, ice)
  s += `<rect x="${2 * u}" y="0" width="${u}" height="${u * 0.45}" fill="#fff" opacity=".9"/><rect x="${5 * u}" y="0" width="${u}" height="${u * 0.45}" fill="#fff" opacity=".9"/>`
  s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${1.5 * u}" fill="${HUE.cold}" fill-opacity=".28" stroke="${ice}" stroke-width="${0.38 * u}"/>`
  s += `<path d="M${bx + 0.9 * u} ${by + 2.6 * u}l${1.6 * u} ${-1.6 * u}M${bx + 0.9 * u} ${by + 4.2 * u}l${0.8 * u} ${-0.8 * u}" stroke="#fff" stroke-opacity=".75" stroke-width="${0.32 * u}" stroke-linecap="round"/>`
  for (const ix of [1.4, 4.4, 7.2]) {
    const tx = bx + ix * u
    const ty = by + bh
    s += `<path d="M${tx} ${ty}h${0.9 * u}l${-0.45 * u} ${1.5 * u}z" fill="${ice}"/>`
  }
  const sx = bx + bw - 0.2 * u
  const sy = by + 0.2 * u
  const r = 1.1 * u
  s +=
    `<path d="M${sx} ${sy - r}L${sx + 0.25 * r} ${sy - 0.25 * r}L${sx + r} ${sy}L${sx + 0.25 * r} ${sy + 0.25 * r}L${sx} ${sy + r}L${sx - 0.25 * r} ${sy + 0.25 * r}L${sx - r} ${sy}L${sx - 0.25 * r} ${sy - 0.25 * r}z" fill="#fff">` +
    `<animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;0.55;0.7;0.85;1" dur="2.8s" repeatCount="indefinite"/></path>`
  return s + '</g>'
}

/** Robo beside the chip in the band's row. */
export const ROBO_SIZE = 20
export const roboSvg = (mode: Mode): string => svgDoc(ROBO_SIZE, ROBO_SIZE, roboShapes(0, 0, ROBO_SIZE, mode), false)

// ---------- The card, laid out for the band's width ----------
/** Real CSS pixels: narrower than the slot, so the card shows at this size, not shrunk. */
const CARD_W = 720
const CARD_H = 60
/** The extra height of the keep-warm tally row. */
const NOTE_H = 18

/** How many recent requests the card's hit strip holds, and its size under the token count. */
export const HITS_MAX = 20
const HITS_X = 240
const HITS_W = 126
const HITS_H = 8
const HITS_BOTTOM = 58

/** The cache hit of recent requests as a strip of bars, a low one in amber, and the same in words; empty under two. */
const hitStrip = (hits: readonly number[]): { svg: string; alt: string } => {
  if (hits.length < 2) return { svg: '', alt: '' }
  const slot = HITS_W / HITS_MAX
  const svg = hits
    .map((hit, i) => {
      const h = Math.max(1, (Math.min(100, hit) / 100) * HITS_H)
      const fill = hit < HIT_LOW_AT ? WARN : MUTED
      return `<rect class="hit" x="${(HITS_X + i * slot).toFixed(1)}" y="${(HITS_BOTTOM - h).toFixed(1)}" width="${(slot * 0.7).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`
    })
    .join('')
  const alt = `Cache hit over the last ${hits.length} requests: lowest ${Math.min(...hits)}%, latest ${hits[hits.length - 1]}%.`
  return { svg, alt }
}

export const cardSvg = (
  v: CacheView,
  ember: EmberView | null = null,
  note: string | null = null,
  hits: readonly number[] = [],
): { source: string; w: number; h: number; alt: string } => {
  const { mode } = v
  const cold = mode === 'cold'
  const hue = HUE[mode]
  const left = Math.max(0, v.ttlMin - v.idleMin)
  const held = !cold && ember !== null
  const t = (x: number, y: number, str: string, size: number, weight: number, fill: string, anchor = 'start', ls = 0) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" letter-spacing="${ls}" text-anchor="${anchor}">${str}</text>`
  const vline = (x: number) => `<rect x="${x}" y="8" width="1" height="${CARD_H - 14}" fill="${LINE}"/>`

  // State and time left.
  const chip = chipShapes(0, 8, WORD[mode], hue, 11, 1)
  let g = chip.svg + t(chip.w + 10, 23, v.idle, 18, 600, TEXT)
  g += t(208, 23, cold ? 'cold now' : held ? `ember ${ember.left}` : `cold in ${left}m`, 11, 600, HUE.cold, 'end')
  const full = 208
  // Held, the bar is the share of keep-warm spent; otherwise the share of the cache's life.
  const spent = cold ? full : full * Math.min(1, held ? ember.spent : v.idleMin / v.ttlMin)
  g += `<rect x="0" y="40" width="${full}" height="3" rx="1.5" fill="${EMPTY}"/><rect x="0" y="40" width="${spent}" height="3" rx="1.5" fill="${hue}"/>`
  if (held) g += t(0, 56, `cold about ${ember.coldAt}`, 10, 500, MUTED)
  g += vline(224)

  // The conversation's size.
  const share = v.window > 0 ? Math.round((v.tokens / v.window) * 100) : 0
  g += t(240, 18, cold ? 'RE-CACHE' : 'IN CACHE', 11, 700, MUTED, 'start', 1.2)
  g += t(240, 44, tok(v.tokens), 20, 600, TEXT) + t(296, 44, `${share}% of ${tok(v.window)}`, 11, 500, MUTED)
  const strip = hitStrip(hits.slice(-HITS_MAX))
  g += strip.svg
  g += vline(376)

  // What the next message costs, by model.
  g += t(392, 18, cold ? 'NEXT MESSAGE COSTS' : 'NEXT MESSAGE, CACHED', 11, 700, MUTED, 'start', 1.2)
  MODELS.forEach((m, i) => {
    const x = 392 + i * 82
    const mine = m.id === v.mine
    // Every ref is in the price table; a session version the table does not list shows its family's, marked as an estimate.
    const own = mine ? nextCost(v.model, mode, v.tokens, v.ttlMin) : null
    const cost = own ?? nextCost(m.ref, mode, v.tokens, v.ttlMin) ?? 0
    g += t(x, 36, (mine && own === null ? '≈' : '') + usd(cost), 14, mine ? 700 : 500, mine ? TEXT : MUTED)
    g += t(x, 50, m.NAME, 10, 700, mine ? hue : MUTED, 'start', 0.6)
  })

  // Keep-warm's tally for the session, on a row of its own under the card.
  const h = note ? CARD_H + NOTE_H : CARD_H
  if (note) g += t(0, CARD_H + 12, note, 11, 500, MUTED)

  const alt0 = cold
    ? `Cache cold. Idle ${v.idle}. Next message re-caches ${tok(v.tokens)} tokens.`
    : held
      ? `Cache warm. Ember holds it for ${ember.left} more, then it goes cold about ${ember.coldAt}. ${tok(v.tokens)} tokens cached.`
      : `Cache warm. Goes cold in ${left} minute${left === 1 ? '' : 's'}. ${tok(v.tokens)} tokens cached.`
  const alt = [alt0, strip.alt, note].filter(Boolean).join(' ')
  return { source: svgDoc(CARD_W, h, g, true), w: CARD_W, h, alt }
}
