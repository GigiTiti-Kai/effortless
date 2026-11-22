#!/usr/bin/env node
// The Codex window client (HCM-207, route A): type messages here instead of in the codex TUI, and each one is judged
// before Codex sees it. The judged level goes on turn/start only when it differs from the level the thread runs now.
// Only the turns started here are judged; a plain `codex` run is not touched. Run: node tools/codex-window.ts [--resume <thread id>]
//   /effort <level>  your pick: Auto goes off until /auto on
//   /auto on|off     off puts the config's level (model_reasoning_effort, else the model's default) back on the next turn
//   /quit
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

import { defaultFor, threadFrom, turnEffort } from '../hooks/adapters/codex.ts'
import type { ModelList } from '../hooks/adapters/codex.ts'
import { appliedEvent, command, inputFor, judgeable, remember, restore, sent, turnPlan } from '../hooks/adapters/window.ts'
import { decide } from '../hooks/judge-core.ts'
import { ask, judgePorts, logPath, nextLine, OPTIONS, record as recordTo, settingsFrom } from './window-judge.ts'

const { values: opt } = parseArgs({ options: { ...OPTIONS, resume: { type: 'string' } } })
const settings = settingsFrom(opt)
const ports = judgePorts(settings)
const LOG = logPath('codex', opt.log)
const record = (event: object) => recordTo(LOG, event)

// Codex's app-server over stdio: one JSON message per line.
const server = spawn(process.env.CODEX_BIN ?? 'codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] })
// The window lives as long as Codex: /quit ends its input, and Codex going away (also a crash) ends the window.
let quitting = false
server.on('exit', code => {
  if (!quitting) console.error(`\n[effortless] codex app-server exited (${code})`)
  process.exit(quitting ? 0 : 1)
})
let id = 0
const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>()
const listeners: ((m: { method: string; params: Record<string, unknown>; id?: number }) => void)[] = []
createInterface({ input: server.stdout }).on('line', line => {
  let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id !== undefined && !m.method) waiting.get(m.id)?.(m)
  else if (m.method) for (const l of listeners) l(m as never)
})
const call = <T>(method: string, params: object): Promise<T> =>
  new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, m => (waiting.delete(n), m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result as T)))
    server.stdin.write(JSON.stringify({ id: n, method, params }) + '\n')
  })
const reply = (n: number, result: object) => server.stdin.write(JSON.stringify({ id: n, result }) + '\n')

// experimentalApi: without it Codex never sends thread/settings/updated, so a level another client picks goes unseen.
await call('initialize', { clientInfo: { name: 'effortless-codex-window', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
server.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
const list = await call<ModelList>('model/list', {})
type Opened = Parameters<typeof threadFrom>[0] & { thread: { path: string | null } }
const opened = await call<Opened>(opt.resume ? 'thread/resume' : 'thread/start', opt.resume ? { threadId: opt.resume } : {})
// The base is the config's level: a resumed thread may hold one this client chose last time.
const config = await call<{ config: { model_reasoning_effort?: string | null } }>('config/read', {}).catch(() => undefined)
let t = threadFrom(opened, list, config?.config.model_reasoning_effort)
const rollout = opened.thread.path
let auto = !opt['no-auto']
let restoring = false
let picked: string | undefined
let elsewhere = 0 // how many changes another client made: a turn that saw one does not put its own level back
console.log(`[effortless] thread ${t.id}, ${t.model} at ${t.effort ?? 'its default'}${judgeable(t) ? '' : ' (not judged: level or model not checked)'}; Auto ${auto ? 'on' : 'off'}`)

// Another client on the same thread (the codex TUI with --remote) changed its settings: the person's pick.
listeners.push(m => {
  if (m.method !== 'thread/settings/updated' || m.params.threadId !== t.id) return
  const s = m.params.threadSettings as { model: string; effort: string | null }
  const effort = s.effort ?? defaultFor(list, s.model)
  if (effort === t.effort && s.model === t.model) return
  t = { ...t, model: s.model, effort, by: 'manual' }
  elsewhere++
  auto = false
  // The latest pick wins: one typed here and not sent yet, or the base an Auto off would put back, is dropped.
  picked = undefined
  restoring = false
  console.log(`\n[effortless] ${s.model} at ${effort} set elsewhere: Auto off`)
})

type Change = { path: string; kind?: unknown; diff?: string }

/**
 * An approval's question, as the terminal shows it: everything Codex sent but its ids and clock (the command, extra
 * permissions, network, the permissions asked), so nothing it grants is left off; and for a file change, each file
 * with its diff, as Codex reported them when the change started.
 */
function question(a: { method: string; params: Record<string, unknown> }, changes: Map<string, Change[]>): string {
  const hidden = new Set(['threadId', 'turnId', 'itemId', 'approvalId', 'startedAtMs'])
  const shown: Record<string, unknown> = Object.fromEntries(Object.entries(a.params).filter(([k, v]) => !hidden.has(k) && v != null))
  const span = a.method === 'item/permissions/requestApproval' ? 'for this turn' : 'once'
  const files = changes.get(String(a.params.itemId))
  const diffs = files?.map(c => `--- ${c.path} ${JSON.stringify(c.kind ?? '')}\n${c.diff ?? '(no diff reported)'}`).join('\n')
  const body = a.method === 'item/fileChange/requestApproval' ? `\n${diffs ?? '(Codex has not reported which files or what changes)'}` : ''
  return `\n[approve ${a.method.split('/')[1]} ${span}: ${JSON.stringify(shown)}]${body}\ny/N `
}

// Items Codex makes without the model: the input, a hook's prompt, compaction and review markers.
const NOT_MODEL = new Set(['userMessage', 'hookPrompt', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode'])

/**
 * Runs one turn to its end, printing the reply; approvals are asked on the terminal. Returns the turn's id, or nothing
 * when Codex refused to start it. ran: the model answered at least once: it made an item, or Codex counted tokens for
 * this turn (a refusal-only reply makes no item but uses tokens). A turn it never answered ran at no level: one a local
 * hook stopped before the model was asked (completed, no request), or one the Responses API refused (a 400).
 */
async function runTurn(text: string, carry: { effort?: string }): Promise<{ id: string; ran: boolean } | undefined> {
  let answer = ''
  let streamed = false
  let answered = false
  const used = new Set<string>() // turns Codex reported tokens for
  let resolveDone!: () => void
  const done = new Promise<void>(r => (resolveDone = r))
  const approvals: { id: number; method: string; params: Record<string, unknown> }[] = []
  const changes = new Map<string, Change[]>()
  const on = (m: { method: string; params: Record<string, unknown>; id?: number }) => {
    if (m.params?.threadId !== undefined && m.params.threadId !== t.id) return
    if (m.method === 'item/agentMessage/delta') {
      streamed = true
      process.stdout.write(String(m.params.delta))
    }
    const item = m.params?.item as { type?: string; id?: string; text?: string; changes?: Change[] } | undefined
    if (m.method.startsWith('item/') && item?.type === 'fileChange' && item.id && item.changes) changes.set(item.id, item.changes)
    if (m.method === 'item/completed' && item?.type === 'agentMessage') answer = String(item.text ?? '')
    if (m.method === 'item/completed' && item?.type && !NOT_MODEL.has(item.type)) answered = true
    const usage = m.params?.tokenUsage as { last?: { totalTokens?: number } } | undefined
    if (m.method === 'thread/tokenUsage/updated' && (usage?.last?.totalTokens ?? 0) > 0) used.add(String(m.params.turnId))
    if (m.method === 'hook/completed') {
      // A hook that stopped the message: say so and why, or the window shows only an empty line.
      const run = m.params.run as { eventName?: string; status?: string; entries?: { text?: string }[] } | undefined
      if (run?.status === 'blocked' || run?.status === 'failed') process.stdout.write(`\n[effortless] the ${run.eventName} hook ${run.status} it${run.entries?.length ? `: ${run.entries.map(e => e.text).join(' ')}` : ''}\n`)
    }
    if (m.id !== undefined && /requestApproval$/.test(m.method)) approvals.push(m as never)
    else if (m.id !== undefined) {
      // Codex asks something this client cannot show (user input, an MCP form, a client tool): say no, so the turn goes on.
      process.stdout.write(`\n[effortless] codex asked ${m.method}: not supported in the window client, declined\n`)
      server.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'not supported by effortless-codex-window' } }) + '\n')
    }
    if (m.method === 'turn/completed') {
      // A turn the model refused or that broke off ends too: say so, or the window shows only an empty line.
      const turn = m.params.turn as { status?: string; error?: { message?: string } | null } | undefined
      if (turn?.status && turn.status !== 'completed') process.stdout.write(`\n[effortless] the turn ${turn.status}${turn.error?.message ? `: ${turn.error.message}` : ''}\n`)
      resolveDone()
    }
  }
  listeners.push(on)
  let started: { turn: { id: string } }
  try {
    started = await call<{ turn: { id: string } }>('turn/start', { threadId: t.id, input: [{ type: 'text', text }], ...carry })
  } catch (error) {
    listeners.splice(listeners.indexOf(on), 1)
    console.log(`[effortless] codex did not start the turn: ${error instanceof Error ? error.message : error}`)
    return undefined
  }
  while (true) {
    const next = await Promise.race([done.then(() => 'done' as const), new Promise<'tick'>(r => setTimeout(() => r('tick'), 100))])
    for (const a of approvals.splice(0)) {
      // Only y or yes typed after the question grants: a message that merely starts with y ("yes, that report...") declines.
      const yes = /^\s*(y|yes)\s*$/i.test((await ask(question(a, changes))) ?? '')
      reply(a.id, a.method === 'item/permissions/requestApproval' ? { permissions: yes ? a.params.permissions : {}, scope: 'turn' } : { decision: yes ? 'accept' : 'decline' })
    }
    if (next === 'done') break
  }
  listeners.splice(listeners.indexOf(on), 1)
  process.stdout.write(streamed ? '\n' : `${answer}\n`)
  t = remember(t, 'assistant', answer)
  // The model was asked and answered with nothing to show (a refusal-only reply): say so rather than print an empty line.
  if (!answered && used.has(started.turn.id)) console.log('[effortless] the model gave no message (a refusal or an empty reply)')
  return { id: started.turn.id, ran: answered || used.has(started.turn.id) }
}

while (true) {
  process.stdout.write(`${t.effort ?? '-'}${auto ? '·auto' : ''}> `)
  const typed = await nextLine()
  if (typed === undefined) break
  if (!typed.trim()) continue
  const cmd = command(typed)
  if (cmd?.kind === 'quit') break
  if (cmd?.kind === 'auto') {
    auto = cmd.on
    restoring = !cmd.on
    picked = undefined // a pick not yet sent is dropped: on judges the next message, off puts the base back
    console.log(`[effortless] Auto ${auto ? 'on' : `off: ${t.base ?? 'the starting level'} goes back on the next turn`}`)
    continue
  }
  if (cmd?.kind === 'effort') {
    if (!t.levels[t.model]?.includes(cmd.level)) {
      console.log(`[effortless] ${t.model} does not list ${cmd.level}: kept ${t.effort}`)
      continue
    }
    // As in Claude Code: your pick turns Auto off and holds until you turn Auto on. It goes out with the next message.
    picked = cmd.level
    auto = false
    restoring = false
    console.log(`[effortless] ${picked} from the next message; Auto off (/auto on hands it back)`)
    continue
  }
  // Records name the turn by Codex's own id (unique across resumes), known once the turn started.
  let decided: object | undefined
  let carry: { effort?: string } = {}
  let by: Parameters<typeof sent>[2]
  const pending = { picked, restoring } // given back if Codex refuses the turn
  const mark = elsewhere // from before judging: a change another client makes while the judge thinks counts too
  if (picked !== undefined) {
    carry = picked !== t.effort ? { effort: picked } : {}
    by = 'manual'
    picked = undefined
  } else if (restoring) {
    carry = restore(t)
    by = 'app'
    restoring = false
  } else if (auto && judgeable(t)) {
    const d = await decide(inputFor(t, typed, settings, auto), ports)
    decided = d.event
    if (!auto) {
      // Set elsewhere while the judge thought (Auto went off): that pick stands, the late verdict is dropped.
      console.log(`[effortless] ${t.effort} set elsewhere while judging: kept`)
    } else {
      const p = turnPlan(t, d)
      carry = p.carry
      by = p.by
      if (d.by === 'none') process.stderr.write(`[effortless] no judge answered: kept ${t.effort}\n`)
    }
  }
  const before = t
  t = remember(sent(t, carry, by), 'user', typed)
  if (carry.effort) console.log(`[effortless] ${carry.effort} (${t.by})`)
  const ranWith = t // the thread as this turn started: its record names who chose its level, whatever came after
  const turn = await runTurn(typed, carry)
  const changed = elsewhere !== mark
  if (decided) record(turn ? { ...decided, turn: turn.id } : decided)
  if (!turn) {
    // Nothing was sent: the thread, a pick and an Auto off restore are as they were, unless another client changed
    // the level meanwhile (that pick is the latest; only the message is taken back).
    if (changed) {
      t = { ...t, messages: before.messages }
    } else {
      t = before
      picked = pending.picked
      restoring = pending.restoring
    }
    continue
  }
  // The level this turn ran at, from its own turn_context. None seen (an ephemeral thread, a rollout not written
  // yet): nothing is recorded.
  let text = ''
  try {
    if (rollout) text = readFileSync(rollout, 'utf8')
  } catch {
    // Not written yet.
  }
  const turnId = turn.id
  const seen = turnEffort(text, turnId, defaultFor(list, ranWith.model))
  if (seen !== undefined) {
    // A turn the model never answered is not counted as run; the thread still holds the level for the next one.
    if (turn.ran) record(appliedEvent(ranWith, seen, Date.now(), turnId))
    // What ran is the level in use: a level that did not take is sent again when it is picked again. A level another
    // client set during the turn is newer than what the turn ran at, and stays.
    if (!changed && seen !== t.effort) t = { ...t, effort: seen, by: 'app' }
  }
}
quitting = true
server.stdin.end()
setTimeout(() => server.kill(), 5000).unref()
