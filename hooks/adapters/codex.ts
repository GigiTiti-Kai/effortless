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

/** The level in the rollout's last turn_context line, or null when it holds none. */
export function lastTurnEffort(rollout: string): AppliedLevel | null {
  let effort: AppliedLevel | null = null
  for (const line of rollout.split('\n')) {
    if (!line.includes('"turn_context"')) continue
    try {
      const e = JSON.parse(line) as { type?: string; payload?: { effort?: string | null } }
      if (e.type === 'turn_context') effort = e.payload?.effort ?? null
    } catch {
      // A line cut short while Codex writes it: the earlier one stands.
    }
  }
  return effort
}
