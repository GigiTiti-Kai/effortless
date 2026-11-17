import { describe, expect, test } from 'claude-code/testing'

import { type AppliedEvent, type DecisionEvent, type DecisionInput, decide, type Ports, parseVerdict, scorecard } from '../hooks/judge-core'

// The judge core on its own: no engine, only fake ports. Jev's replies have the shape TypeSafe sends.
const jevReply = (choice: string, confidence: number, nouls: { cont?: number; look?: number } = {}) =>
  JSON.stringify({
    model: 'jev-1.14.0',
    answers: {
      effort: { type: 'choice', choice, confidence, probabilities: { low: 0.1, medium: 0.2, high: 0.3, xhigh: 0.05, max: 0.0 } },
      continues_work: { type: 'noul', noul: nouls.cont ?? 0.1 },
      needs_lookup: { type: 'noul', noul: nouls.look ?? 0.1 },
    },
    usage: { input_tokens: 1400, output_tokens: 90 },
  })

type Jev = { ok: boolean; status: number; text: string } | 'hang' | 'throw'
// haiku null: Haiku does not answer.
function ports(jev: Jev | undefined, haiku: string | null = '{"model":"sonnet","effort":"medium","sure":0.8,"why":"normal"}') {
  const asked = { jev: 0, haiku: 0, judging: 0, bodies: [] as unknown[], prompts: [] as string[] }
  const p: Ports = {
    askJev:
      jev === undefined
        ? undefined
        : async body => {
            asked.jev++
            asked.bodies.push(body)
            if (jev === 'hang') return new Promise(() => undefined)
            if (jev === 'throw') throw new Error('ECONNREFUSED')
            return jev
          },
    askHaiku: async (_system, prompt) => {
      asked.haiku++
      asked.prompts.push(prompt)
      return haiku === null ? undefined : { text: haiku, tokens: 120 }
    },
    // Only the Jev timeout sleeps: it runs out at once for a Jev that hangs, and never for one that answers.
    sleep: () => (jev === 'hang' ? Promise.resolve() : new Promise(() => undefined)),
    now: () => 1_800_000_000_000,
    judging: async () => {
      asked.judging++
    },
  }
  return { p, asked }
}
const ok = (text: string) => ({ ok: true, status: 200, text })

const input = (o: Partial<DecisionInput> = {}): DecisionInput => ({
  message: o.typed ?? 'refactor the sync engine',
  typed: 'refactor the sync engine',
  context: '',
  current: { model: 'opus', effort: 'medium' },
  settings: { judge: 'jev', bias: 0, floor: 'low', ceiling: 'max', saving: false, withModel: false },
  rules: true,
  bare: true,
  harness: 'claude-code',
  session: 's1',
  ...o,
})

describe('judge core: Jev, then Haiku', () => {
  test('a Jev answer is used as it is, even unsure, and Haiku is not asked', async () => {
    const { p, asked } = ports(ok(jevReply('high', 0.41)))
    const d = await decide(input(), p)
    expect([d.by, d.effort, d.why]).toEqual(['jev', 'high', '41% sure'])
    expect(asked).toMatchObject({ jev: 1, haiku: 0, judging: 1 })
    expect(d.model).toBeUndefined()
    expect(d.event.judge).toMatchObject({ jev: { choice: 'high', sure: 0.41 }, tokens: 1490, leaned: 'high', bounded: 'high', capped: 'high' })
  })

  test('Jev failing, slow or unreadable hands the call to Haiku; only a failure the person can act on warns', async () => {
    const cases: [Jev, string | undefined, string][] = [
      [{ ok: false, status: 402, text: 'payment required' }, 'Jev is out of credits (402)', 'Jev is out of credits (402)'],
      ['hang', 'Jev did not answer in time', 'Jev did not answer in time'],
      ['throw', 'Jev could not be reached', 'Jev could not be reached'],
      [ok('not json'), undefined, 'Jev gave no usable answer'],
    ]
    for (const [jev, warn, fallback] of cases) {
      const { p, asked } = ports(jev)
      const d = await decide(input(), p)
      expect([d.by, d.effort, d.warn]).toEqual(['haiku', 'medium', warn])
      expect(d.event.judge?.fallback).toBe(fallback)
      expect(asked.haiku).toBe(1)
    }
  })

  test('a Jev failure is told before Haiku is asked, so a Haiku that throws does not swallow it', async () => {
    const { p } = ports({ ok: false, status: 402, text: 'payment required' })
    const told: string[] = []
    p.warned = reason => told.push(reason)
    p.askHaiku = async () => {
      throw new Error('haiku down')
    }
    await expect(decide(input(), p)).rejects.toThrow('haiku down')
    expect(told).toEqual(['Jev is out of credits (402)'])
  })

  test('with the haiku setting or no way to reach Jev, Jev is not asked; no verdict changes nothing', async () => {
    const haikuSet = ports(ok(jevReply('low', 0.9)))
    await decide(input({ settings: { ...input().settings, judge: 'haiku' } }), haikuSet.p)
    expect(haikuSet.asked).toMatchObject({ jev: 0, haiku: 1 })
    const none = ports(undefined, null)
    const d = await decide(input(), none.p)
    expect([d.by, d.effort, d.event.decided, d.event.auto]).toEqual(['none', undefined, null, false])
    expect(d.event.judge?.fallback).toBeUndefined()
  })

  test('the body Jev gets carries the current effort and asks for a model only when asked to', async () => {
    const { p, asked } = ports(ok(jevReply('medium', 0.9)))
    await decide(input({ settings: { ...input().settings, withModel: true } }), p)
    const body = asked.bodies[0] as { state: { current_effort: string; next_message: string }; questions: Record<string, unknown> }
    expect(body.state.current_effort).toBe('medium')
    expect(body.state.next_message).toBe('refactor the sync engine')
    expect(Object.keys(body.questions)).toEqual(['effort', 'model', 'continues_work', 'needs_lookup'])
  })
})

describe('judge core: floors, lean, range and save mode', () => {
  test('carrying on keeps the current level and a lookup keeps medium, and the lean never goes below them', async () => {
    const carry = await decide(input({ current: { model: 'opus', effort: 'high' } }), ports(ok(jevReply('low', 0.4, { cont: 0.9 }))).p)
    expect([carry.effort, carry.why, carry.verdict?.least]).toEqual(['high', 'raised from low', 'high'])
    const lookup = await decide(input({ settings: { ...input().settings, bias: -2 } }), ports(ok(jevReply('medium', 0.3, { look: 0.8 }))).p)
    expect(lookup.effort).toBe('medium')
    const leaned = await decide(input({ settings: { ...input().settings, bias: 1 } }), ports(ok(jevReply('medium', 0.5))).p)
    expect([leaned.effort, leaned.why]).toEqual(['high', 'your settings'])
  })

  test('Min and Max clamp the verdict, then save mode caps it at medium', async () => {
    const range = await decide(input({ settings: { ...input().settings, ceiling: 'high' } }), ports(ok(jevReply('xhigh', 0.9))).p)
    expect([range.effort, range.why, range.verdict?.effort]).toEqual(['high', 'your settings', 'xhigh'])
    const saving = await decide(input({ settings: { ...input().settings, saving: true } }), ports(ok(jevReply('xhigh', 0.9))).p)
    expect([saving.effort, saving.why]).toEqual(['medium', 'save mode'])
    expect(saving.event.judge).toMatchObject({ leaned: 'xhigh', bounded: 'xhigh', capped: 'medium' })
  })
})

describe('judge core: the rules before the judge', () => {
  test('a named level runs past Min, Max and save mode, beats the phase, and the last one typed mid-turn counts', async () => {
    const strict = { ...input().settings, ceiling: 'medium' as const, saving: true }
    const { p, asked } = ports(ok(jevReply('low', 0.9)))
    const d = await decide(input({ typed: 'use max effort for this', settings: strict, phase: { name: 'build', effort: 'medium' } }), p)
    expect([d.by, d.effort, d.event.auto]).toEqual(['named', 'max', false])
    const carried = await decide(input({ typed: 'go on', bare: false, earlier: ['effort: high please', 'actually low effort'] }), p)
    expect([carried.by, carried.effort]).toEqual(['named', 'low'])
    expect(asked).toMatchObject({ jev: 0, haiku: 0, judging: 0 })
  })

  test('in a phase its level runs, within Min, Max and save mode', async () => {
    const { p, asked } = ports(ok(jevReply('low', 0.9)))
    const d = await decide(input({ phase: { name: 'design', effort: 'xhigh' } }), p)
    expect([d.by, d.effort, d.why]).toEqual(['phase', 'xhigh', 'design phase'])
    const saving = await decide(input({ phase: { name: 'design', effort: 'xhigh' }, settings: { ...input().settings, saving: true } }), p)
    expect(saving.effort).toBe('medium')
    expect(asked.judging).toBe(0)
  })

  test('thanks is low within Min; a go-ahead keeps the session effort unless it answers a question or the level was set by hand', async () => {
    const { p, asked } = ports(ok(jevReply('high', 0.9)))
    const thanks = await decide(input({ typed: 'ありがとう！', settings: { ...input().settings, floor: 'medium' } }), p)
    expect([thanks.by, thanks.effort, thanks.why]).toEqual(['rule', 'medium', 'thanks'])
    const go = await decide(input({ typed: 'ok', sessionEffort: 'xhigh' }), p)
    expect([go.by, go.effort]).toEqual(['rule', 'xhigh'])
    const unknown = await decide(input({ typed: '続けて' }), p)
    expect([unknown.by, unknown.effort, unknown.event.decided]).toEqual(['rule', undefined, null])
    expect(asked.jev).toBe(0)
    expect((await decide(input({ typed: 'yes', context: 'assistant: Should I rebuild the index?' }), p)).by).toBe('jev')
    expect((await decide(input({ typed: 'ok', manual: true, sessionEffort: 'low' }), p)).by).toBe('jev')
    // The same 'go' (b9ec423 register.tsx:4396): after a pick by hand it is judged; after Jev's it keeps medium by rule.
    const same = { typed: 'go', context: 'assistant: done.', sessionEffort: 'medium' as const, bare: true }
    expect((await decide(input({ ...same, manual: true }), p)).by).toBe('jev')
    expect([(await decide(input({ ...same, manual: false }), p)).by, (await decide(input({ ...same, manual: false }), p)).effort]).toEqual(['rule', 'medium'])
  })

  test('without rules (Auto off for effort, a slash command) or for a message that carries more, the judge decides', async () => {
    const { p } = ports(ok(jevReply('high', 0.9)))
    expect((await decide(input({ typed: 'thanks', rules: false, bare: false }), p)).by).toBe('jev')
    // rules off wins even for a bare message: thanks and a go-ahead go to the judge, which is asked for a model too.
    const withModel = { ...input().settings, withModel: true }
    for (const typed of ['thanks', 'go']) {
      const d = await decide(input({ typed, rules: false, bare: true, sessionEffort: 'medium', settings: withModel }), p)
      expect([d.by, d.model]).toEqual(['jev', 'opus'])
    }
    expect((await decide(input({ typed: 'thanks', bare: false }), p)).by).toBe('jev')
    expect((await decide(input({ typed: 'max effort', rules: false, bare: false }), p)).effort).toBe('high')
  })
})

describe('judge core: the record', () => {
  test('the record holds levels, odds, time and tokens, and never the message, the context or a reason', async () => {
    const secret = 'the launch code is zebra-42, my mail is me@example.com'
    const jev = await decide(input({ message: secret, typed: secret, context: `user: ${secret}` }), ports(ok(jevReply('high', 0.9))).p)
    const haiku = await decide(input({ message: secret, typed: secret }), ports({ ok: false, status: 500, text: secret }, `{"model":"sonnet","effort":"low","why":"${secret}"}`).p)
    for (const d of [jev, haiku]) {
      expect(JSON.stringify(d.event)).not.toContain('zebra')
      expect(JSON.stringify(d.event)).not.toContain('example.com')
    }
    expect(jev.event).toMatchObject({ v: 1, harness: 'claude-code', session: 's1', at: 1_800_000_000, decided: 'high', by: 'jev', auto: true })
    expect(jev.event.judge?.jev?.p).toEqual({ low: 0.1, medium: 0.2, high: 0.3, xhigh: 0.05, max: 0 })
    expect(haiku.event.judge).toMatchObject({ haiku: { effort: 'low' }, fallback: 'Jev failed (500)', tokens: 120 })
  })

  test('the scorecard counts by harness, decider and level, the automatic share, Haiku standing in, reverts and Jev odds', async () => {
    const at = { v: 1, session: 's', at: 0 } as const
    const jevAt = (p: number): DecisionEvent => ({ ...at, harness: 'codex', decided: 'high', by: 'jev', auto: true, judge: { jev: { choice: 'high', p: { max: p } }, ms: 1, tokens: 1 } })
    // Codex reports ultra, past the core's five levels: the record keeps it and the scorecard counts it as its own column.
    const ultra: AppliedEvent = { ...at, harness: 'codex', applied: 'ultra', by: 'manual' }
    const card = scorecard([
      jevAt(0.0),
      jevAt(1.0),
      { ...at, harness: 'codex', decided: 'medium', by: 'haiku', auto: true, judge: { ms: 1, tokens: 1, fallback: 'Jev did not answer in time' } },
      { ...at, harness: 'claude-code', decided: 'max', by: 'named', auto: false },
      { ...at, harness: 'codex', applied: 'low', by: 'app', reverted: true },
      { ...at, harness: 'codex', applied: 'high', by: 'jev' },
      ultra,
      ultra,
    ])
    expect(card.decisions).toBe(4)
    expect(card.counts).toContainEqual({ harness: 'codex', by: 'jev', effort: 'high', n: 2 })
    expect(card.counts).toContainEqual({ harness: 'claude-code', by: 'named', effort: 'max', n: 1 })
    expect([card.auto, card.reverted]).toEqual([0.75, 1])
    expect(card.applied).toContainEqual({ harness: 'codex', by: 'manual', level: 'ultra', n: 2 })
    expect(card.applied).toContainEqual({ harness: 'codex', by: 'jev', level: 'high', n: 1 })
    expect(Math.round(card.fellBack * 1000)).toBe(333)
    expect([card.jev.max[0], card.jev.max[9], card.jev.high[0]]).toEqual([1, 1, 0])
  })
})

test('parseVerdict reads a model by its key inside any id, as it did when it matched the ids too', () => {
  const said = (model: string) => parseVerdict(`{"model":"${model}","effort":"low","why":"x"}`)?.model
  expect(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2', 'Opus', 'sonnet'].map(said)).toEqual(['haiku', 'sonnet', 'opus', 'fable', 'opus', 'sonnet'])
  expect(said('gpt')).toBeUndefined()
})
