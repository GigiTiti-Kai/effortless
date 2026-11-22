// Codex's adapter (HCM-207): what goes on turn/start, and what the core is asked. Run by tools/test.sh with `node --test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { threadFrom, turnEffort } from '../hooks/adapters/codex.ts'
import { appliedEvent, command, inputFor, judgeable, remember, restore, sent, turnPlan } from '../hooks/adapters/window.ts'
import { decide, jevRequest } from '../hooks/judge-core.ts'

const list = {
  data: [
    { id: 'gpt-6.2-sol', defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort })) },
    { id: 'gpt-6-luna', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
  ],
}
const opened = threadFrom({ thread: { id: 'th' }, model: 'gpt-6.2-sol', reasoningEffort: 'medium' }, list, 'medium')
const settings = { judge: 'jev', bias: 0, floor: 'low', ceiling: 'max', saving: false, withModel: true }
const jev = (choice, extra = {}) => ({
  askJev: async () => ({ ok: true, status: 200, text: JSON.stringify({ answers: { effort: { choice, confidence: 0.9 }, ...extra } }) }),
  askHaiku: async () => undefined,
  sleep: () => new Promise(() => undefined),
  now: () => 0,
})

test('the same level sends nothing; a new one is sent once and then carried by Codex', () => {
  assert.deepEqual(turnPlan(opened, { by: 'jev', effort: 'medium' }), { carry: {}, by: 'jev' })
  const high = turnPlan(opened, { by: 'jev', effort: 'high' })
  assert.deepEqual(high, { carry: { effort: 'high' }, by: 'jev' })
  const after = sent(opened, high.carry, high.by)
  assert.deepEqual([after.effort, after.by], ['high', 'jev'])
  assert.deepEqual(turnPlan(after, { by: 'jev', effort: 'high' }).carry, {})
  // Back to the base is sent by name: null resets nothing in Codex.
  assert.deepEqual(turnPlan(after, { by: 'jev', effort: 'medium' }).carry, { effort: 'medium' })
})

test('no verdict, or a level the model does not offer, changes nothing and names nobody', () => {
  assert.deepEqual(turnPlan(opened, { by: 'none', effort: undefined }), { carry: {} })
  const luna = { ...opened, model: 'gpt-6-luna' }
  assert.deepEqual(turnPlan(luna, { by: 'jev', effort: 'max' }), { carry: {} })
})

test('only a checked model on one of the five levels is judged: ultra and unknown models keep their level', () => {
  assert.equal(judgeable(opened), true)
  assert.equal(judgeable({ ...opened, effort: 'ultra' }), false)
  assert.equal(judgeable({ ...opened, effort: null }), false)
  assert.equal(judgeable({ ...opened, model: 'gpt-7-unlisted' }), false)
  // The record keeps ultra as reported.
  const ev = appliedEvent({ ...opened, effort: 'ultra', by: 'manual' }, 'ultra', 5000, '3')
  assert.deepEqual(ev, { v: 1, harness: 'codex', session: 'th', turn: '3', at: 5, applied: 'ultra', by: 'manual' })
})

test('no effort in the config: the thread runs at the model default, is judged, and Auto off puts that default back', () => {
  const fresh = threadFrom({ thread: { id: 'th' }, model: 'gpt-6.2-sol', reasoningEffort: null }, list, null)
  assert.deepEqual([fresh.effort, fresh.base, judgeable(fresh)], ['low', 'low', true])
  assert.deepEqual(restore(sent(fresh, { effort: 'high' }, 'jev')), { effort: 'low' })
  // A model with no default listed is not judged: its level is not known.
  assert.equal(judgeable(threadFrom({ thread: { id: 'th' }, model: 'gpt-6-luna', reasoningEffort: null }, list, null)), false)
})

test('a resumed thread brings back its last question, so a yes to it is judged rather than kept as a go-ahead', async () => {
  const turns = [
    { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'fix the build' }] }, { type: 'agentMessage', text: 'Fixed.' }] },
    { items: [{ type: 'userMessage', content: [{ type: 'text', text: 'refactor the parser' }] }, { type: 'reasoning' }, { type: 'agentMessage', text: 'Done. Shall I also update the docs?' }] },
  ]
  const resumed = threadFrom({ thread: { id: 'th', turns }, model: 'gpt-6.2-sol', reasoningEffort: 'high' }, list, 'medium')
  assert.equal(inputFor(resumed, 'yes', settings, true).context, 'user: refactor the parser\nassistant: Done. Shall I also update the docs?')
  const d = await decide(inputFor(resumed, 'yes', settings, true), jev('medium'))
  assert.deepEqual([d.by, d.effort], ['jev', 'medium'])
  // A new thread has no turns: nothing to bring back.
  assert.deepEqual(opened.messages, [])
})

test("resume starts from the level the thread holds; Auto off puts back the config's level, not that one", () => {
  const resumed = threadFrom({ thread: { id: 'th' }, model: 'gpt-6.2-sol', reasoningEffort: 'low' }, list, 'medium')
  assert.deepEqual([resumed.effort, resumed.base, resumed.by], ['low', 'medium', 'app'])
  assert.deepEqual(restore(resumed), { effort: 'medium' })
  assert.deepEqual(restore(sent(resumed, { effort: 'medium' }, 'app')), {})
  // No level in the config: the model's default is the base, not the level a resumed thread came back with.
  assert.equal(threadFrom({ thread: { id: 'th' }, model: 'gpt-6.2-sol', reasoningEffort: 'high' }, list, null).base, 'low')
  // No default listed either: the thread's own.
  assert.equal(threadFrom({ thread: { id: 'th' }, model: 'gpt-6-luna', reasoningEffort: 'high' }, list, null).base, 'high')
  // A base the model does not list is not sent: luna has no xhigh.
  const luna = threadFrom({ thread: { id: 'th' }, model: 'gpt-6-luna', reasoningEffort: 'low' }, list, 'xhigh')
  assert.deepEqual(restore(luna), {})
})

test('a level the client set that did not run is reverted; a pick of the person or the app is not', () => {
  const low = sent(opened, { effort: 'low' }, 'jev')
  assert.equal(appliedEvent(low, 'low', 0).reverted, undefined)
  assert.deepEqual([appliedEvent(low, 'medium', 0).reverted, appliedEvent(low, 'medium', 0).by], [true, 'app'])
  assert.equal(appliedEvent({ ...low, by: 'manual' }, 'medium', 0).reverted, undefined)
})

test('the core is asked about the thread as it runs: no model question, manual after a pick, commands skip the rules', async () => {
  const input = inputFor(remember(remember(opened, 'user', 'fix the build'), 'assistant', 'Done. Shall I also update the docs?'), 'go', settings, true, '2')
  assert.equal(input.settings.withModel, false)
  assert.deepEqual(input.current, { model: 'opus', effort: 'medium' })
  assert.match(input.context, /^user: fix the build\nassistant: Done\. Shall I also/)
  const body = jevRequest(input.message, { ...input.current, why: '', by: 'manual' }, input.context, input.settings.withModel)
  assert.equal(body.questions.model, undefined)
  assert.equal(body.state.current_effort, 'medium')
  assert.equal(inputFor(opened, '/review', settings, true).rules, false)
  assert.equal(inputFor({ ...opened, by: 'manual' }, 'go', settings, true).manual, true)
})

test('a go-ahead keeps the level after a judged pick, and is judged after the person picked by hand', async () => {
  const ctx = (t) => remember(remember(t, 'user', 'refactor the parser'), 'assistant', 'Refactored. Next I will run the tests.')
  const judged = ctx(sent(opened, { effort: 'high' }, 'jev'))
  const kept = await decide(inputFor(judged, 'go', settings, true), jev('low'))
  assert.deepEqual([kept.by, kept.effort], ['rule', 'high'])
  assert.deepEqual(turnPlan(judged, kept).carry, {})
  const manual = ctx(sent(opened, { effort: 'high' }, 'manual'))
  const asked = await decide(inputFor(manual, 'go', settings, true), jev('low'))
  assert.deepEqual([asked.by, asked.effort], ['jev', 'low'])
  assert.deepEqual(turnPlan(manual, asked), { carry: { effort: 'low' }, by: 'jev' })
})

test('Jev down: Haiku stands in; both down: the level is kept and the input still goes', async () => {
  const down = { askJev: async () => ({ ok: false, status: 503, text: '' }), sleep: () => new Promise(() => undefined), now: () => 0 }
  const haiku = await decide(inputFor(opened, 'migrate the auth module to the new store', settings, true), { ...down, askHaiku: async () => ({ text: '{"model":"opus","effort":"xhigh","sure":0.8,"why":"migration"}', tokens: 9 }) })
  assert.deepEqual([haiku.by, haiku.effort, haiku.event.judge.fallback], ['haiku', 'xhigh', 'Jev failed (503)'])
  const none = await decide(inputFor(opened, 'migrate the auth module to the new store', settings, true), { ...down, askHaiku: async () => undefined })
  assert.deepEqual([none.by, none.effort], ['none', undefined])
  assert.deepEqual(turnPlan(opened, none), { carry: {} })
})

test('commands: /effort, /auto, /quit; anything else is a message', () => {
  assert.deepEqual(command('/effort High'), { kind: 'effort', level: 'high' })
  assert.deepEqual(command(' /auto off '), { kind: 'auto', on: false })
  assert.deepEqual(command('/quit'), { kind: 'quit' })
  assert.equal(command('/effort'), undefined)
  assert.equal(command('/review this'), undefined)
  assert.equal(command('please /effort high'), undefined)
})

test("the turn's own turn_context names the level it ran at; another turn's never does", () => {
  const rollout = [
    JSON.stringify({ type: 'session_meta', payload: {} }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1', effort: 'medium', model: 'gpt-6.2-sol' } }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 't2', effort: 'low', model: 'gpt-6.2-sol' } }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 't2', effort: 'ultra', model: 'gpt-6.2-sol' } }),
    '{"type":"turn_context","payload":{"turn_id":"t3","eff',
  ].join('\n')
  assert.equal(turnEffort(rollout, 't1'), 'medium')
  assert.equal(turnEffort(rollout, 't2'), 'ultra')
  // t3's line is cut short and t4 has none yet: nothing seen, not t2's level.
  assert.equal(turnEffort(rollout, 't3'), undefined)
  assert.equal(turnEffort(rollout, 't4'), undefined)
  assert.equal(turnEffort('', 't1'), undefined)
  // Real Codex 0.171.0 writes effort null for a turn at the model default (nothing configured or sent).
  const atDefault = JSON.stringify({ type: 'turn_context', payload: { turn_id: 't5', effort: null } })
  assert.equal(turnEffort(atDefault, 't5', 'low'), 'low')
  assert.equal(turnEffort(atDefault, 't5'), null)
})

test('the context is the last user message and the end of the last reply, as Claude Code sends it', () => {
  let t = opened
  for (let i = 0; i < 6; i++) t = remember(remember(t, 'user', `u${i}`), 'assistant', `a${i}`)
  assert.equal(t.messages.length, 4)
  assert.equal(inputFor(t, 'next', settings, true).context, 'user: u5\nassistant: a5')
})
