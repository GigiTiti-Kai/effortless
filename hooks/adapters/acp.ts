// ACP agents' side (HCM-207): Grok, agy and Hermes name their effort option differently (Grok and Hermes
// reasoning_effort, agy thought_level). Grok and agy offer fewer levels than the core (no max), Hermes more (none,
// minimal, ultra too), but all use the core's names for the ones they have, so the mapping is the option's id and its
// choices. A judged max on an agent that lists no max goes as its highest level (Grok's and agy's xhigh; the owner's
// decision, EFR-12); any other level an agent does not list is not sent, and the level in use stays (window.ts;
// HCM-217 decision 4). session/set_config_option changes the level and reads it back (Grok 1.0.77,
// agy 1.5.14, Hermes 0.23.3, there only for that gateway session); Grok starts its next session there too, agy and
// Hermes do not, so the client keeps to one session.
// shortcut: Hermes lists max for every model and clamps it per model (gpt-6.1-terra runs xhigh) while reading back max; the applied record cannot see that, check Hermes' ladder if it matters.
import { EFFORTS } from '../judge-core.ts'
import type { AppliedLevel, Effort, Harness } from '../judge-core.ts'
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

/**
 * The level to ask the agent for: a judged max on a model that lists no max is the highest core level it lists (by
 * the core's order, not the list's); anything else as judged. The decision record keeps max, the applied one what ran.
 */
export function levelFor(t: WindowThread, effort: Effort | undefined): Effort | undefined {
  const levels = t.levels[t.model]
  if (effort !== 'max' || !levels || levels.includes('max')) return effort
  return EFFORTS.filter(e => levels.includes(e)).at(-1) ?? effort
}

/** The thread after the agent reported its options again: a level or model nobody here set is the person's. */
export function synced(t: WindowThread, options: readonly ConfigOption[]): WindowThread {
  const { model, effort, choices } = effortFrom(t.harness, options)
  const levels = choices.length ? { ...t.levels, [model]: choices } : t.levels
  if (effort === t.effort && model === t.model) return { ...t, levels }
  return { ...t, model, effort, levels, by: 'manual' }
}
