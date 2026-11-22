// The window clients' side of the effort judge (HCM-207): what a client that owns the input asks the core before each
// message, and what it tells the harness. The core says which level is right; this file says when the harness is told.
// Every harness here keeps a level once it is set (Codex for the thread's later turns, ACP agents for the session),
// so a level is sent only when it differs from the one in use, and a return to the base is sent as the level itself.
// Pure: no file, process or network here, so Node's type stripping runs it and the tests reach every branch.
import { contextFrom, EFFORTS } from '../judge-core.ts'
import type { AppliedEvent, AppliedLevel, Decision, DecisionInput, Effort, Harness, JudgeSettings } from '../judge-core.ts'

/** The thread as the window client knows it. */
export type WindowThread = {
  harness: Harness
  id: string
  model: string
  /** The level in use, as the harness reports it (Codex's ultra included); null when it reports none. */
  effort: AppliedLevel | null
  /** Who set that level: 'app' when the session opened, 'manual' from /effort or another client. */
  by: AppliedEvent['by']
  /** The level the thread had when the window client took it over: what turning Auto off puts back. */
  base: AppliedLevel | null
  /** Each model's levels, as the harness lists them (Codex: model/list; ACP: the effort option's choices). A model
   * not listed is not judged (HCM-217 decision 4). */
  levels: Record<string, readonly string[]>
  /** The last user message and the assistant's last reply, for the judge's context (the same as Claude Code's). */
  messages: { role: 'user' | 'assistant'; text: string }[]
}

/** The core may judge only a thread on one of its five levels, on a model whose levels were checked. Ultra is kept. */
export function judgeable(t: WindowThread): boolean {
  return EFFORTS.includes(t.effort as Effort) && t.levels[t.model] !== undefined
}

/**
 * The core's input for one message typed into the window client. The model sent to the core is 'opus': Jev is not
 * told the model (no current_model, EFR-5), and Haiku's prompt reads it only to scale effort to a frontier model.
 */
export function inputFor(t: WindowThread, typed: string, settings: JudgeSettings, auto: boolean, turn?: string): DecisionInput {
  const effort = t.effort as Effort
  return {
    message: typed,
    typed,
    context: contextFrom(t.messages),
    current: { model: 'opus', effort },
    sessionEffort: effort,
    settings: { ...settings, withModel: false },
    rules: auto && !typed.trimStart().startsWith('/'),
    bare: true,
    manual: t.by === 'manual',
    harness: t.harness,
    session: t.id,
    ...(turn !== undefined ? { turn } : {}),
  }
}

/**
 * The level to send for this decision: only when it differs from the one in use and the model offers it. Nothing
 * otherwise: the message is sent all the same (Codex: turn/start without an effort field), with no extra request.
 */
export function override(t: WindowThread, d: Pick<Decision, 'effort'>): { effort?: Effort } {
  if (!d.effort || d.effort === t.effort) return {}
  if (!t.levels[t.model]?.includes(d.effort)) return {}
  return { effort: d.effort }
}

/** What to send and who chose it. A level the model does not offer changes nothing and names nobody. */
export function turnPlan(t: WindowThread, d: Pick<Decision, 'by' | 'effort'>): { carry: { effort?: Effort }; by?: AppliedEvent['by'] } {
  const carry = override(t, d)
  const by = carry.effort || d.effort === t.effort ? chooser(d) : undefined
  return by ? { carry, by } : { carry }
}

/**
 * Turning Auto off puts the base back on the next message, by name (Codex's null resets nothing). A base the model
 * does not list is not sent either (Codex's base is the config's, and the model may have changed since).
 */
export function restore(t: WindowThread): { effort?: string } {
  return t.base && t.effort !== t.base && t.levels[t.model]?.includes(t.base) ? { effort: t.base } : {}
}

/** The window client's own commands. /effort <level> is the person's pick: it wins over the judge (decision 3). */
export function command(typed: string): { kind: 'effort'; level: string } | { kind: 'auto'; on: boolean } | { kind: 'quit' } | undefined {
  const m = typed.trim().match(/^\/(effort|auto|quit)\b\s*(\S*)\s*$/i)
  if (!m) return undefined
  const [, name, arg] = m
  if (name.toLowerCase() === 'quit') return { kind: 'quit' }
  if (name.toLowerCase() === 'auto' && /^(on|off)$/i.test(arg)) return { kind: 'auto', on: arg.toLowerCase() === 'on' }
  if (name.toLowerCase() === 'effort' && arg) return { kind: 'effort', level: arg.toLowerCase() }
  return undefined
}

/**
 * The thread after the harness took the message. by: who chose the level for this turn, also when it stayed the
 * same (a judged level that matches the thread's is the judge's pick from now on); none when nobody chose.
 */
export function sent(t: WindowThread, carried: { effort?: string }, by?: AppliedEvent['by']): WindowThread {
  return { ...t, ...(carried.effort ? { effort: carried.effort } : {}), ...(by ? { by } : {}) }
}

/** Who a decision says chose the level, as the applied record names it; none when it chose nothing. */
export function chooser(d: Pick<Decision, 'by' | 'effort'>): AppliedEvent['by'] | undefined {
  return d.by === 'none' || !d.effort ? undefined : d.by
}

/**
 * The record of the level a turn ran at (Codex: turn_context.effort in the rollout; ACP: the option read back).
 * reverted: the client set the level and the turn ran at another one, with nobody changing it. Nothing seen (no
 * turn_context read) is not a revert.
 */
export function appliedEvent(t: WindowThread, seen: AppliedLevel | null, now: number, turn?: string): AppliedEvent {
  const reverted = seen !== null && t.by !== 'manual' && t.by !== 'app' && seen !== t.effort
  return {
    v: 1,
    harness: t.harness,
    session: t.id,
    ...(turn !== undefined ? { turn } : {}),
    at: Math.floor(now / 1000),
    applied: seen,
    by: reverted ? 'app' : t.by,
    ...(reverted ? { reverted: true } : {}),
  }
}

/** A message of the conversation kept for the context: the last user message and the last reply are all it reads. */
export function remember(t: WindowThread, role: 'user' | 'assistant', text: string): WindowThread {
  return { ...t, messages: [...t.messages, { role, text }].slice(-4) }
}
