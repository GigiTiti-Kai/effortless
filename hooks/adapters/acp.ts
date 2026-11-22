// ACP agents' side (HCM-207): Grok, agy and Hermes name their effort option differently (Grok and Hermes
// reasoning_effort, agy thought_level). Grok and agy offer fewer levels than the core (no max), Hermes more (none,
// minimal, ultra too), but all use the core's names for the ones they have, so the mapping is the option's id and its
// choices. A level an agent does not list is not sent, and the level in use
// stays (window.ts; HCM-217 decision 4). session/set_config_option changes the level and reads it back (Grok 1.0.77,
// agy 1.5.14, Hermes 0.23.3, there only for that gateway session); Grok starts its next session there too, agy and
// Hermes do not, so the client keeps to one session.
import type { AppliedLevel, Harness } from '../judge-core.ts'
import type { WindowThread } from './window.ts'

/** The config option that holds the effort, by agent. */
export const EFFORT_OPTION: Partial<Record<Harness, string>> = { grok: 'reasoning_effort', agy: 'thought_level', hermes: 'reasoning_effort' }

/** A config option as ACP sends it (session/new, session/set_config_option, config_option_update). */
export type ConfigOption = { id: string; currentValue?: string; options?: { value: string }[] }

/** The effort option's level and choices, and the model's id, out of a config options list. */
export function effortFrom(harness: Harness, options: readonly ConfigOption[]): { model: string; effort: AppliedLevel | null; choices: string[] } {
  const effort = options.find(o => o.id === EFFORT_OPTION[harness])
  return {
    model: options.find(o => o.id === 'model')?.currentValue ?? '',
    effort: effort?.currentValue ?? null,
    choices: (effort?.options ?? []).map(o => o.value),
  }
}

/** The session as a window thread: its model's levels are the choices the agent offers now. No option: not judged. */
export function sessionFrom(harness: Harness, sessionId: string, options: readonly ConfigOption[]): WindowThread {
  const { model, effort, choices } = effortFrom(harness, options)
  return { harness, id: sessionId, model, effort, by: 'app', base: effort, levels: choices.length ? { [model]: choices } : {}, messages: [] }
}

/** The thread after the agent reported its options again: a level or model nobody here set is the person's. */
export function synced(t: WindowThread, options: readonly ConfigOption[]): WindowThread {
  const { model, effort, choices } = effortFrom(t.harness, options)
  const levels = choices.length ? { ...t.levels, [model]: choices } : t.levels
  if (effort === t.effort && model === t.model) return { ...t, levels }
  return { ...t, model, effort, levels, by: 'manual' }
}
