// List prices, the one table the card, the ribbon and the Agents panel all read. Pure.

/** $ per million tokens: input, output, cache read, cache write at the 1-hour rate. */
export type Rates = readonly [input: number, output: number, read: number, write: number]

// First match wins, so a full version comes before its family. A third entry is the rate
// above TIER_AT prompt tokens. Verify against the Claude pricing page when a model ships.
const PRICES: readonly (readonly [RegExp, Rates, Rates?])[] = [
  [/fable-5-1|mythos-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2], [0.5, 2.5, 0.05, 1]],
  [/haiku/, [1, 5, 0.1, 2]],
]

/** Prompt tokens (input, cache read and cache write together) above which a tiered model bills its higher rate. */
const TIER_AT = 100_000

/** The rates for a model at a prompt size, or null for a model the table does not know. */
export const ratesOf = (model: string, promptTokens: number): Rates | null => {
  const row = PRICES.find(([re]) => re.test(model.toLowerCase()))
  if (!row) return null
  return promptTokens > TIER_AT && row[2] ? row[2] : row[1]
}
