// The judge core loads in plain Node 24 (types stripped, nothing else), as another harness's adapter would load it.
// Run by tools/test.sh with `node --test`; `claude plugin test` reads only *.test.ts(x), so it skips this file.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { decide, EFFORTS, scorecard } from '../hooks/judge-core.ts'

test('judge-core.ts runs in Node: a decision through fake ports, and its record in the scorecard', async () => {
  const reply = { model: 'jev', answers: { effort: { choice: 'high', confidence: 0.9 }, continues_work: { noul: 0.1 }, needs_lookup: { noul: 0.9 } } }
  const d = await decide(
    {
      message: 'migrate the auth module',
      typed: 'migrate the auth module',
      context: '',
      current: { model: 'opus', effort: 'medium' },
      settings: { judge: 'jev', bias: 0, floor: 'low', ceiling: 'max', saving: false, withModel: false },
      rules: true,
      bare: true,
      harness: 'codex',
      session: 'node',
    },
    {
      askJev: async () => ({ ok: true, status: 200, text: JSON.stringify(reply) }),
      askHaiku: async () => undefined,
      sleep: () => new Promise(() => undefined),
      now: () => 0,
    },
  )
  assert.deepEqual([d.by, d.effort], ['jev', 'high'])
  assert.equal(scorecard([d.event]).counts[0].n, 1)
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('judge-core.ts imports nothing at run time and reaches no file, network or environment', () => {
  const source = readFileSync(new URL('../hooks/judge-core.ts', import.meta.url), 'utf8')
  const imports = source.match(/^import .*$/gm) ?? []
  assert.ok(imports.every(line => line.startsWith('import type ')), imports.join('\n'))
  assert.doesNotMatch(source, /from 'claude-code|\bprocess\.|\bfetch\(|\brequire\(|\bimport\(|\bDeno\.|\bBun\.|^\s*(export\s+)?(declare\s+)?(const\s+)?(enum|namespace)\s/m)
})
