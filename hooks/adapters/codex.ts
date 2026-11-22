// Codex's side (HCM-207, route A): the app-server's answers as a window thread. Codex keeps a turn/start effort for
// the thread's later turns and null resets nothing (HCM-217, re-measured on 0.171.0): window.ts sends a level only
// when it differs and names the base when going back.
import type { AppliedLevel } from '../judge-core.ts'
import type { WindowThread } from './window.ts'

/** model/list's answer, as far as the window client reads it. */
export type ModelList = { data: { id: string; defaultReasoningEffort?: string | null; supportedReasoningEfforts: { reasoningEffort: string }[] }[] }

/** model/list's answer as levels by model. */
export function levelsFrom(list: ModelList): WindowThread['levels'] {
  return Object.fromEntries(list.data.map(m => [m.id, m.supportedReasoningEfforts.map(o => o.reasoningEffort)]))
}

/** The level a model runs at when nobody named one: no effort in the config (Codex reports null) means this one. */
export function defaultFor(list: ModelList, model: string): string | null {
  return list.data.find(m => m.id === model)?.defaultReasoningEffort ?? null
}

/**
 * The thread's state from a thread/start or thread/resume response. effort: the response's level, else the model's
 * default (model/list). base: the level Auto off puts back: the config's model_reasoning_effort (config/read), else the
 * model's default. A resumed thread runs at its last level, which may be one the window client chose, so the base is
 * never taken from the thread while a configured or default level is known.
 */
export function threadFrom(res: { thread: { id: string }; model: string; reasoningEffort: string | null }, list: ModelList, base?: string | null): WindowThread {
  const fallback = defaultFor(list, res.model)
  const effort = res.reasoningEffort ?? fallback
  return { harness: 'codex', id: res.thread.id, model: res.model, effort, by: 'app', base: base ?? fallback ?? effort, levels: levelsFrom(list), messages: [] }
}

/**
 * The level one turn ran at: the effort of the rollout's turn_context for that turn id (the last one, when Codex wrote
 * several). undefined when the turn has none yet: an earlier turn's level is never taken for this one.
 */
export function turnEffort(rollout: string, turnId: string): AppliedLevel | null | undefined {
  let effort: AppliedLevel | null | undefined
  for (const line of rollout.split('\n')) {
    if (!line.includes('"turn_context"') || !line.includes(turnId)) continue
    try {
      const e = JSON.parse(line) as { type?: string; payload?: { turn_id?: string; effort?: string | null } }
      if (e.type === 'turn_context' && e.payload?.turn_id === turnId) effort = e.payload.effort ?? null
    } catch {
      // A line cut short while Codex writes it: the earlier one stands.
    }
  }
  return effort
}
