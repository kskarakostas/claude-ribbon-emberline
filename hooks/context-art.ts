// What fills the context, in the cache card's language: caps labels and figures,
// with one bar and a table sized to read at real size. Pure: returns SVG strings.

import { EMPTY, MUTED, svgDoc, TEXT, tok } from './cache-art'
import type { ContextMix } from '../types'

const MIX = ['#9fb3c8', '#7fb09a', '#c2b280', '#b39cc4', '#7fb5b5', '#c49a8a', '#a0a0a0']
/** Real CSS pixels: narrower than the slot, so the drawing is shown at this size, not shrunk. */
const PANEL_W = 720
const BAR_X = 76
const BAR_RIGHT = 112
const BAR_H = 8
const TABLE_TOP = 40
const TABLE_ROW = 18
const TABLE_COLUMNS = 3
const GUTTER = 24

const NAME_CHARS = 26
const escaped = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const label = (name: string): string => escaped(name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name)

const count = (n: number): string => (n < 1000 ? String(n) : tok(n))
const colourOf = (i: number): string => MIX[i % MIX.length]!
const listOf = (mix: ContextMix): string => mix.rows.map(r => `${r.name} ${count(r.tokens)}`).join(', ')

/** The panel behind the details icon: one bar of the window, then a table of what fills it. */
export const contextPanelSvg = (mix: ContextMix): { source: string; w: number; h: number; alt: string } => {
  const W = PANEL_W
  const used = mix.rows.reduce((n, r) => n + r.tokens, 0)
  const shareOf = (tokens: number) => (used > 0 ? Math.round((tokens / used) * 100) : 0)
  const t = (x: number, y: number, s: string, fill: string, size: number, weight: number, anchor = 'start', ls = 0) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" letter-spacing="${ls}" text-anchor="${anchor}">${s}</text>`

  let g = t(0, 18, 'CONTEXT', MUTED, 11, 700, 'start', 1.2)
  const pct = mix.window > 0 ? Math.round((used / mix.window) * 100) : 0
  g += t(W, 18, `${tok(used)} of ${tok(mix.window)} · ${pct}%`, TEXT, 12, 600, 'end')

  const barW = W - BAR_X - BAR_RIGHT
  let x = 0
  let segments = `<rect width="${barW}" height="${BAR_H}" fill="${EMPTY}"/>`
  mix.rows.forEach((r, i) => {
    const w = mix.window > 0 ? (r.tokens / mix.window) * barW : 0
    segments += `<rect x="${x.toFixed(2)}" width="${w.toFixed(2)}" height="${BAR_H}" fill="${colourOf(i)}"/>`
    x += w
  })
  g += `<clipPath id="p"><rect width="${barW}" height="${BAR_H}" rx="3"/></clipPath><g transform="translate(${BAR_X} 10)" clip-path="url(#p)">${segments}</g>`

  // Largest first, down each column. Anything that rounds to 0% folds into Other.
  const coloured = mix.rows.map((r, i) => ({ ...r, colour: colourOf(i) })).sort((a, b) => b.tokens - a.tokens)
  const rows = coloured.filter(r => shareOf(r.tokens) > 0)
  const rest = coloured.filter(r => shareOf(r.tokens) === 0).reduce((n, r) => n + r.tokens, 0)
  if (rest > 0) rows.push({ name: 'Other', tokens: rest, colour: MUTED })

  const perColumn = Math.ceil(rows.length / TABLE_COLUMNS)
  const cell = (W - GUTTER * (TABLE_COLUMNS - 1)) / TABLE_COLUMNS
  rows.forEach((r, i) => {
    const cx = Math.floor(i / perColumn) * (cell + GUTTER)
    const y = TABLE_TOP + (i % perColumn) * TABLE_ROW
    const share = shareOf(r.tokens)
    g += `<circle cx="${cx + 4}" cy="${y - 4}" r="4" fill="${r.colour}"/>`
    g += t(cx + 14, y, label(r.name), TEXT, 12, 500)
    g += t(cx + cell - 34, y, count(r.tokens), TEXT, 12, 600, 'end')
    g += t(cx + cell, y, share > 0 ? `${share}%` : '&lt;1%', MUTED, 12, 500, 'end')
  })
  const h = TABLE_TOP + perColumn * TABLE_ROW - 8
  return { source: svgDoc(W, h, g, true), w: W, h, alt: `Context panel: ${listOf(mix)}` }
}

const MINI_W = 72
const MINI_H = 8

/** The ribbon's small bar: what the used context is made of, whole bar being the context in use. */
export const contextMiniSvg = (mix: ContextMix): { source: string; w: number; h: number; alt: string } => {
  const used = mix.rows.reduce((n, r) => n + r.tokens, 0)
  let x = 0
  let g = ''
  mix.rows.forEach((r, i) => {
    const w = used > 0 ? (r.tokens / used) * MINI_W : 0
    g += `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${MINI_H}" fill="${colourOf(i)}"/>`
    x += w
  })
  const clip = `<clipPath id="m"><rect width="${MINI_W}" height="${MINI_H}" rx="3"/></clipPath>`
  return { source: svgDoc(MINI_W, MINI_H, `${clip}<g clip-path="url(#m)">${g}</g>`, false), w: MINI_W, h: MINI_H, alt: `Context mix: ${listOf(mix)}` }
}
