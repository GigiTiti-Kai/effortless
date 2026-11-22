// Codex's side (HCM-207, route A): the app-server's answers as a window thread. Codex keeps a turn/start effort for
// the thread's later turns and null resets nothing (HCM-217, re-measured on 0.171.0): window.ts sends a level only
// when it differs and names the base when going back.
import type { AppliedLevel } from '../judge-core.ts'
import type { WindowThread } from './window.ts'

/**
 * The thread's state from a thread/start or thread/resume response. base: the level Auto off puts back, the
 * config's model_reasoning_effort (config/read). A resumed thread runs at its last level, which may be one the window
 * client chose, so the base is never taken from the thread; without a configured level it is the thread's own.
 */
export function threadFrom(res: { thread: { id: string }; model: string; reasoningEffort: string | null }, levels: WindowThread['levels'], base?: string | null): WindowThread {
  return { harness: 'codex', id: res.thread.id, model: res.model, effort: res.reasoningEffort, by: 'app', base: base ?? res.reasoningEffort, levels, messages: [] }
}

/** model/list's answer as levels by model. */
export function levelsFrom(list: { data: { id: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[] }): WindowThread['levels'] {
  return Object.fromEntries(list.data.map(m => [m.id, m.supportedReasoningEfforts.map(o => o.reasoningEffort)]))
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
