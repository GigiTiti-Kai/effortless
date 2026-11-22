#!/usr/bin/env node
// The Codex window client (HCM-207, route A): type messages here instead of in the codex TUI, and each one is judged
// before Codex sees it. The judged level goes on turn/start only when it differs from the level the thread runs now.
// Only the turns started here are judged; a plain `codex` run is not touched. Run: node tools/codex-window.ts [--resume <thread id>]
//   /effort <level>  your pick: Auto goes off until /auto on
//   /auto on|off     off puts the config's level (model_reasoning_effort) back on the next turn
//   /quit
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

import { levelsFrom, threadFrom, turnEffort } from '../hooks/adapters/codex.ts'
import { appliedEvent, command, inputFor, judgeable, remember, restore, sent, turnPlan } from '../hooks/adapters/window.ts'
import { decide } from '../hooks/judge-core.ts'
import { judgePorts, logPath, nextLine, OPTIONS, record as recordTo, settingsFrom } from './window-judge.ts'

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

await call('initialize', { clientInfo: { name: 'effortless-codex-window', version: '1' } })
server.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
const levels = levelsFrom(await call('model/list', {}))
type Opened = { thread: { id: string; path: string | null }; model: string; reasoningEffort: string | null }
const opened = await call<Opened>(opt.resume ? 'thread/resume' : 'thread/start', opt.resume ? { threadId: opt.resume } : {})
// The base is the config's level: a resumed thread may hold one this client chose last time.
const config = await call<{ config: { model_reasoning_effort?: string | null } }>('config/read', {}).catch(() => undefined)
let t = threadFrom(opened, levels, config?.config.model_reasoning_effort)
const rollout = opened.thread.path
let auto = !opt['no-auto']
let restoring = false
let picked: string | undefined
console.log(`[effortless] thread ${t.id}, ${t.model} at ${t.effort ?? 'its default'}${judgeable(t) ? '' : ' (not judged: level or model not checked)'}; Auto ${auto ? 'on' : 'off'}`)

// Another client on the same thread (the codex TUI with --remote) changed its settings: the person's pick.
listeners.push(m => {
  if (m.method !== 'thread/settings/updated' || m.params.threadId !== t.id) return
  const s = m.params.threadSettings as { model: string; effort: string | null }
  if (s.effort === t.effort && s.model === t.model) return
  t = { ...t, model: s.model, effort: s.effort, by: 'manual' }
  auto = false
  console.log(`\n[effortless] ${s.model} at ${s.effort} set elsewhere: Auto off`)
})

/** What an approval grants, as the terminal shows it: the command, the files, the permissions, never less. */
function asked(a: { method: string; params: Record<string, unknown> }, files: Map<string, string[]>): string {
  const keys = ['command', 'cwd', 'reason', 'networkApprovalContext', 'grantRoot', 'permissions']
  const shown: Record<string, unknown> = Object.fromEntries(keys.filter(k => a.params[k] != null).map(k => [k, a.params[k]]))
  const paths = files.get(String(a.params.itemId))
  if (paths) shown.files = paths
  const span = a.method === 'item/permissions/requestApproval' ? 'for this turn' : 'once'
  return `${a.method.split('/')[1]} ${span}: ${JSON.stringify(shown)}`
}

/** Runs one turn to its end, printing the reply; approvals are asked on the terminal. Returns the turn's id. */
async function runTurn(text: string, carry: { effort?: string }): Promise<string> {
  let answer = ''
  let streamed = false
  let resolveDone!: () => void
  const done = new Promise<void>(r => (resolveDone = r))
  const approvals: { id: number; method: string; params: Record<string, unknown> }[] = []
  const files = new Map<string, string[]>()
  const on = (m: { method: string; params: Record<string, unknown>; id?: number }) => {
    if (m.params?.threadId !== undefined && m.params.threadId !== t.id) return
    if (m.method === 'item/agentMessage/delta') {
      streamed = true
      process.stdout.write(String(m.params.delta))
    }
    const item = m.params?.item as { type?: string; id?: string; text?: string; changes?: { path: string }[] } | undefined
    if (m.method === 'item/started' && item?.type === 'fileChange' && item.id) files.set(item.id, (item.changes ?? []).map(c => c.path))
    if (m.method === 'item/completed' && item?.type === 'agentMessage') answer = String(item.text ?? '')
    if (m.id !== undefined && /requestApproval$/.test(m.method)) approvals.push(m as never)
    else if (m.id !== undefined) {
      // Codex asks something this client cannot show (user input, an MCP form, a client tool): say no, so the turn goes on.
      process.stdout.write(`\n[effortless] codex asked ${m.method}: not supported in the window client, declined\n`)
      server.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'not supported by effortless-codex-window' } }) + '\n')
    }
    if (m.method === 'turn/completed') resolveDone()
  }
  listeners.push(on)
  const started = await call<{ turn: { id: string } }>('turn/start', { threadId: t.id, input: [{ type: 'text', text }], ...carry })
  while (true) {
    const next = await Promise.race([done.then(() => 'done' as const), new Promise<'tick'>(r => setTimeout(() => r('tick'), 100))])
    for (const a of approvals.splice(0)) {
      process.stdout.write(`\n[approve ${asked(a, files)}] y/N `)
      const yes = /^y/i.test((await nextLine()) ?? '')
      reply(a.id, a.method === 'item/permissions/requestApproval' ? { permissions: yes ? a.params.permissions : {}, scope: 'turn' } : { decision: yes ? 'accept' : 'decline' })
    }
    if (next === 'done') break
  }
  listeners.splice(listeners.indexOf(on), 1)
  process.stdout.write(streamed ? '\n' : `${answer}\n`)
  t = remember(t, 'assistant', answer)
  return started.turn.id
}

let turns = 0
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
    if (!levels[t.model]?.includes(cmd.level)) {
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
  turns++
  const turn = String(turns)
  let carry: { effort?: string } = {}
  if (picked !== undefined) {
    carry = picked !== t.effort ? { effort: picked } : {}
    t = sent(t, carry, 'manual')
    picked = undefined
  } else if (restoring) {
    carry = restore(t)
    restoring = false
    t = sent(t, carry, 'app')
  } else if (auto && judgeable(t)) {
    const d = await decide(inputFor(t, typed, settings, auto, turn), ports)
    record(d.event)
    if (!auto) {
      // Set elsewhere while the judge thought (Auto went off): that pick stands, the late verdict is dropped.
      console.log(`[effortless] ${t.effort} set elsewhere while judging: kept`)
    } else {
      const p = turnPlan(t, d)
      carry = p.carry
      t = sent(t, carry, p.by)
      if (d.by === 'none') process.stderr.write(`[effortless] no judge answered: kept ${t.effort}\n`)
    }
  }
  t = remember(t, 'user', typed)
  if (carry.effort) console.log(`[effortless] ${carry.effort} (${t.by})`)
  const turnId = await runTurn(typed, carry)
  // The level this turn ran at, from its own turn_context. None seen (an ephemeral thread, a rollout not written
  // yet): nothing is recorded.
  let text = ''
  try {
    if (rollout) text = readFileSync(rollout, 'utf8')
  } catch {
    // Not written yet.
  }
  const seen = turnEffort(text, turnId)
  if (seen !== undefined) {
    record(appliedEvent(t, seen, Date.now(), turn))
    // What ran is the level in use: a level that did not take is sent again when it is picked again.
    if (seen !== t.effort) t = { ...t, effort: seen, by: 'app' }
  }
}
quitting = true
server.stdin.end()
setTimeout(() => server.kill(), 5000).unref()
