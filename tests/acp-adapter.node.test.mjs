// The ACP agents' adapter (HCM-207): Grok's, agy's and Hermes' effort options as window threads. Run by tools/test.sh with `node --test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { effortFrom, sessionFrom, synced } from '../hooks/adapters/acp.ts'
import { inputFor, judgeable, turnPlan } from '../hooks/adapters/window.ts'
import { decide } from '../hooks/judge-core.ts'

// The option lists as Grok 1.0.77 and agy 1.5.14 sent them on session/new (HCM-207 M2/M3).
const choices = ['xhigh', 'high', 'medium', 'low'].map(value => ({ value }))
const grok = [{ id: 'model', currentValue: 'grok-4.7', options: [{ value: 'grok-4.7' }] }, { id: 'reasoning_effort', currentValue: 'high', options: choices }]
const agy = [{ id: 'model', currentValue: 'gemini-4-neon', options: [] }, { id: 'thought_level', currentValue: 'high', options: choices }, { id: 'mode', currentValue: 'default', options: [] }]
const settings = { judge: 'jev', bias: 0, floor: 'low', ceiling: 'max', saving: false, withModel: false }
const jev = choice => ({ askJev: async () => ({ ok: true, status: 200, text: JSON.stringify({ answers: { effort: { choice, confidence: 0.9 } } }) }), askHaiku: async () => undefined, sleep: () => new Promise(() => undefined), now: () => 0 })

test("each agent's effort option is read by its own id", () => {
  assert.deepEqual(effortFrom('grok', grok), { model: 'grok-4.7', effort: 'high', choices: ['xhigh', 'high', 'medium', 'low'] })
  assert.equal(effortFrom('agy', agy).effort, 'high')
  assert.equal(effortFrom('agy', grok).effort, null)
  const t = sessionFrom('agy', 's', agy)
  assert.deepEqual([t.harness, t.model, t.effort, t.base, t.by, judgeable(t)], ['agy', 'gemini-4-neon', 'high', 'high', 'app', true])
  assert.equal(judgeable(sessionFrom('agy', 's', grok)), false)
})

// Hermes 0.23.3 through `hermes acp` (HCM-207 M4): more levels than the core, and the model id carries its provider.
const hermesChoices = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(value => ({ value }))
const hermes = level => [{ id: 'edit_approval_policy', currentValue: 'ask', options: [] }, { id: 'model', currentValue: 'openai-codex:gpt-6.1-sol', options: [] }, { id: 'reasoning_effort', currentValue: level, options: hermesChoices }]

test('Hermes: a judged max is sent; a level outside the core (ultra, none, default) is not judged and stays', async () => {
  const t = sessionFrom('hermes', 's', hermes('high'))
  assert.deepEqual([t.model, t.effort, judgeable(t)], ['openai-codex:gpt-6.1-sol', 'high', true])
  const d = await decide(inputFor(t, 'prove this conjecture', settings, true), jev('max'))
  assert.deepEqual(turnPlan(t, d), { carry: { effort: 'max' }, by: 'jev' })
  for (const level of ['ultra', 'none', 'default']) assert.equal(judgeable(sessionFrom('hermes', 's', hermes(level))), false)
})

test('a judged max on an agent with no max sends nothing: the level in use stays (HCM-217 decision 4)', async () => {
  const t = sessionFrom('grok', 's', grok)
  const d = await decide(inputFor(t, 'prove this conjecture', settings, true), jev('max'))
  assert.deepEqual([d.by, d.effort], ['jev', 'max'])
  assert.deepEqual(turnPlan(t, d), { carry: {} })
})

test("the agent's own report of a new level or model is the person's pick; the same report changes nothing", () => {
  const t = sessionFrom('grok', 's', grok)
  assert.equal(synced(t, grok).by, 'app')
  const lowered = synced(t, [grok[0], { ...grok[1], currentValue: 'low' }])
  assert.deepEqual([lowered.effort, lowered.by], ['low', 'manual'])
})
