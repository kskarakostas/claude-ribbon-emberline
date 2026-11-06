// The task list as the app's update_plan tool last set it. Pure: the mod feeds it
// the tool's input and draws what comes back. The input shapes are the tool's own:
// { items }, { advance: true }, { done: [n], start: n }, steps numbered from 1.

import type { Plan, PlanStep } from '../types'

const STATUSES = ['pending', 'in_progress', 'completed']

const clean = (value: unknown): PlanStep[] | null => {
  if (!Array.isArray(value)) return null
  const steps: PlanStep[] = []
  for (const item of value as { content?: unknown; status?: unknown }[]) {
    if (typeof item?.content !== 'string' || !STATUSES.includes(item.status as string)) return null
    steps.push({ content: item.content, status: item.status as PlanStep['status'] })
  }
  return steps.length > 0 ? steps : null
}

const finishedCount = (steps: PlanStep[]): number => steps.filter(s => s.status === 'completed').length

export const applyPlan = (prev: Plan | null, value: unknown, now: number): Plan | null => {
  if (typeof value !== 'object' || value === null) return prev
  const input = value as Record<string, unknown>
  if ('items' in input) {
    const steps = clean(input.items)
    if (!steps) return prev
    return { steps, stepStartedAt: now, durations: prev?.durations ?? [] }
  }
  if (!prev) return null

  const steps = prev.steps.map(s => ({ ...s }))
  if (input.advance === true) {
    const running = steps.find(s => s.status === 'in_progress')
    if (running) running.status = 'completed'
    const next = steps.find(s => s.status === 'pending')
    if (next) next.status = 'in_progress'
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done as number[]) {
      const step = steps[n - 1]
      if (step) step.status = 'completed'
    }
  }
  if (typeof input.start === 'number') {
    for (const s of steps) if (s.status === 'in_progress') s.status = 'pending'
    const step = steps[input.start - 1]
    if (step) step.status = 'in_progress'
  }

  const finished = finishedCount(steps) - finishedCount(prev.steps)
  if (finished <= 0) return { ...prev, steps }
  const each = (now - prev.stepStartedAt) / finished
  return { steps, stepStartedAt: now, durations: [...prev.durations, ...Array<number>(finished).fill(each)] }
}

export const doneOf = (plan: Plan): number => finishedCount(plan.steps)

export const currentOf = (plan: Plan): PlanStep | undefined =>
  plan.steps.find(s => s.status === 'in_progress') ?? plan.steps.find(s => s.status === 'pending')

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** A rough estimate of the time left, or null until a step has finished. */
export const etaMs = (plan: Plan | null, now: number): number | null => {
  if (!plan || plan.durations.length === 0) return null
  const left = plan.steps.length - doneOf(plan)
  if (left <= 0) return 0
  const each = median(plan.durations)
  // A step running past the median costs its own share only, not the steps after it.
  return each * (left - 1) + Math.max(0, each - (now - plan.stepStartedAt))
}
