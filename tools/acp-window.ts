#!/usr/bin/env node
// The ACP window client (HCM-207) for Grok, agy and Hermes: type messages here instead of in their own screen, and
// each one is judged before the agent sees it. The judged level is set with session/set_config_option only when it
// differs from the session's, and read back. Only the sessions opened here are judged. `hermes acp` starts the Hermes
// gateway if none runs; it ends by itself once idle (--idle-exit). Run: node tools/acp-window.ts --agent grok|agy|hermes
//   /effort <level>  your pick: Auto goes off until /auto on
//   /auto on|off     off puts the session's starting level back before the next message
//   /quit
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

import { EFFORT_OPTION, levelFor, sessionFrom, synced } from '../hooks/adapters/acp.ts'
import type { ConfigOption } from '../hooks/adapters/acp.ts'
import { appliedEvent, command, inputFor, judgeable, remember, restore, sent, turnPlan } from '../hooks/adapters/window.ts'
import { decide } from '../hooks/judge-core.ts'
import { ask, judgePorts, logPath, nextLine, OPTIONS, record as recordTo, settingsFrom } from './window-judge.ts'

const AGENTS = { grok: ['grok', 'agent', '--no-leader', 'stdio'], agy: ['agy', 'acp'], hermes: ['hermes', 'acp'] } as const
const { values: opt } = parseArgs({ options: { ...OPTIONS, agent: { type: 'string' } } })
const harness = opt.agent === 'grok' || opt.agent === 'agy' || opt.agent === 'hermes' ? opt.agent : undefined
if (!harness) {
  console.error('usage: acp-window.ts --agent grok|agy|hermes')
  process.exit(2)
}
const settings = settingsFrom(opt)
const ports = judgePorts(settings)
const LOG = logPath(harness, opt.log)
const record = (event: object) => recordTo(LOG, event)

const [bin, ...args] = AGENTS[harness]
const agent = spawn(process.env[`${harness.toUpperCase()}_BIN`] ?? bin, args, { stdio: ['pipe', 'pipe', 'ignore'] })
// The window lives as long as the agent: /quit ends its input, and the agent going away (also a crash) ends the window.
let quitting = false
agent.on('exit', code => {
  if (!quitting) console.error(`\n[effortless] ${harness} exited (${code})`)
  process.exit(quitting ? 0 : 1)
})
let id = 0
const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>()
type Note = { method: string; params: Record<string, unknown>; id?: number }
const listeners: ((m: Note) => void)[] = []
createInterface({ input: agent.stdout }).on('line', line => {
  let m: Note & { result?: unknown; error?: unknown }
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id !== undefined && !m.method) waiting.get(m.id)?.(m)
  else if (m.method) for (const l of listeners) l(m)
})
const call = <T>(method: string, params: object): Promise<T> =>
  new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, m => (waiting.delete(n), m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result as T)))
    agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
  })
const reply = (n: number, result: object) => agent.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, result }) + '\n')

await call('initialize', { protocolVersion: 1, clientInfo: { name: 'effortless-acp-window', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
const opened = await call<{ sessionId: string; configOptions?: ConfigOption[] }>('session/new', { cwd: process.cwd(), mcpServers: [] })
let t = sessionFrom(harness, opened.sessionId, opened.configOptions ?? [])
let auto = !opt['no-auto']
let restoring = false
let picked: string | undefined
let setting = false
console.log(`[effortless] ${harness} session ${t.id}, ${t.model} at ${t.effort ?? 'no effort option'}${judgeable(t) ? '' : ' (not judged)'}; Auto ${auto ? 'on' : 'off'}`)

/** Sets the effort and reads it back: what the agent reports is the level in use. false: the agent refused it. */
async function setEffort(level: string): Promise<boolean> {
  setting = true
  try {
    const r = await call<{ configOptions?: ConfigOption[] }>('session/set_config_option', { sessionId: t.id, configId: EFFORT_OPTION[harness], value: level })
    const back = sessionFrom(harness, t.id, r.configOptions ?? [])
    t = { ...t, effort: back.effort ?? t.effort }
    return true
  } catch (error) {
    // Refused: the level stays.
    console.log(`[effortless] ${harness} refused ${level}: ${error instanceof Error ? error.message : error}`)
    return false
  } finally {
    setting = false
  }
}

// The agent reported its options while nobody here was setting one (its own /effort, a model switch): the person's.
listeners.push(m => {
  if (m.method !== 'session/update' || m.params.sessionId !== t.id || setting) return
  const u = m.params.update as { sessionUpdate?: string; configOptions?: ConfigOption[] }
  if (u?.sessionUpdate !== 'config_option_update' || !u.configOptions) return
  const next = synced(t, u.configOptions)
  // Any change is the person's, also after an earlier pick of theirs: Auto goes off, so a verdict in flight is dropped.
  if (next.effort !== t.effort || next.model !== t.model) {
    auto = false
    // The latest pick wins: one typed here and not sent yet, or the base an Auto off would put back, is dropped.
    picked = undefined
    restoring = false
    console.log(`\n[effortless] ${next.model} at ${next.effort} set elsewhere: Auto off`)
  }
  t = next
})

/** Runs one prompt to its end. false: the agent refused it, and nothing ran. */
async function runTurn(text: string): Promise<boolean> {
  let answer = ''
  let asking = Promise.resolve() // one approval on screen at a time: the next waits for the answer to this one
  // Each tool call as the agent reported it so far (tool_call, then tool_call_update): an approval may name only its id.
  const calls = new Map<string, Record<string, unknown>>()
  // A partial report on top of the earlier ones: a null field, like a missing one, leaves it as it was (ACP v1).
  const over = (base: Record<string, unknown> | undefined, update: Record<string, unknown> | undefined) => ({ ...base, ...Object.fromEntries(Object.entries(update ?? {}).filter(([, v]) => v != null)) })
  const on = (m: Note) => {
    if (m.method === 'session/update' && m.params.sessionId === t.id) {
      const u = m.params.update as { sessionUpdate?: string; content?: { text?: string }; toolCallId?: string }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
        answer += u.content.text
        process.stdout.write(u.content.text)
      }
      if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u.toolCallId) calls.set(u.toolCallId, over(calls.get(u.toolCallId), u))
    }
    if (m.method === 'session/request_permission' && m.id !== undefined) asking = asking.then(() => approve(m))
  }
  const approve = async (m: Note) => {
    if (m.id !== undefined) {
      const p = m.params as { toolCall?: Record<string, unknown>; options?: { optionId: string; name?: string; kind?: string }[] }
      const options = p.options ?? []
      // What the call does, as everything the agent told about it but its bookkeeping: its kind, the files it touches
      // (locations), its input (rawInput: the path and the text to write) and its content (diffs).
      const call = over(calls.get(String(p.toolCall?.toolCallId)), p.toolCall)
      const hidden = new Set(['sessionUpdate', 'toolCallId', 'title', 'status', 'rawOutput', 'content'])
      const shown = Object.fromEntries(Object.entries(call).filter(([k, v]) => !hidden.has(k) && v != null))
      // Each diff as text (the old text and the new), other content as it came.
      type Content = { type?: string; path?: string; oldText?: string | null; newText?: string }
      const content = Array.isArray(call.content) ? (call.content as Content[]) : []
      const diffs = content.map(c => (c.type === 'diff' ? `--- ${c.path}\n${c.oldText == null ? '(new file)' : `old:\n${c.oldText}`}\nnew:\n${c.newText}` : JSON.stringify(c, null, 2)))
      // Every option with how long it holds (allow_always is never behind a plain yes); anything else rejects once.
      const list = options.map((o, i) => `  ${i + 1}) ${o.name ?? o.optionId} [${o.kind ?? 'kind not given'}]`).join('\n')
      const question = `\n[approve? ${call.title ?? 'a tool'}]\n${JSON.stringify(shown, null, 2)}\n${diffs.map(d => `${d}\n`).join('')}${list}\nnumber (anything else: reject this once) `
      // Only a line typed after the question answers it: a message typed ahead stays queued as a message.
      const n = Number(((await ask(question)) ?? '').trim())
      const pick = (Number.isInteger(n) && n > 0 ? options[n - 1] : undefined) ?? options.find(o => o.kind === 'reject_once')
      reply(m.id, { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } })
    }
  }
  listeners.push(on)
  try {
    await call('session/prompt', { sessionId: t.id, prompt: [{ type: 'text', text }] })
  } catch (error) {
    console.log(`\n[effortless] ${harness} refused the message: ${error instanceof Error ? error.message : error}`)
    return false
  } finally {
    listeners.splice(listeners.indexOf(on), 1)
  }
  process.stdout.write('\n')
  t = remember(t, 'assistant', answer)
  return true
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
    console.log(`[effortless] Auto ${auto ? 'on' : `off: ${t.base ?? 'the starting level'} goes back before the next message`}`)
    continue
  }
  if (cmd?.kind === 'effort') {
    if (!t.levels[t.model]?.includes(cmd.level)) {
      console.log(`[effortless] ${t.model} does not list ${cmd.level}: kept ${t.effort}`)
      continue
    }
    picked = cmd.level
    auto = false
    restoring = false
    console.log(`[effortless] ${picked} from the next message; Auto off (/auto on hands it back)`)
    continue
  }
  turns++
  const turn = String(turns)
  let carry: { effort?: string } = {}
  let by: Parameters<typeof sent>[2]
  const pending = { picked, restoring } // given back if the agent refuses the level
  if (picked !== undefined) {
    carry = picked !== t.effort ? { effort: picked } : {}
    by = 'manual'
    picked = undefined
  } else if (restoring) {
    carry = restore(t)
    by = 'app'
    restoring = false
  } else if (auto && judgeable(t)) {
    const d = await decide(inputFor(t, typed, settings, auto, turn), ports)
    record(d.event)
    if (!auto) {
      // Set elsewhere while the judge thought (Auto went off): that pick stands, the late verdict is dropped.
      console.log(`[effortless] ${t.effort} set elsewhere while judging: kept`)
    } else {
      const p = turnPlan(t, { ...d, effort: levelFor(t, d.effort) })
      carry = p.carry
      by = p.by
      if (d.by === 'none') process.stderr.write(`[effortless] no judge answered: kept ${t.effort}\n`)
    }
  }
  const wanted = carry.effort
  const refused = wanted !== undefined && !(await setEffort(wanted))
  // A pick or the base the agent refused goes again before the next message, and the thread stays as it was (its
  // level and who chose it). A refused judged level is recorded as a set that did not take; the next message is judged.
  const kept = refused && (pending.picked !== undefined || pending.restoring)
  if (kept) {
    picked = pending.picked
    restoring = pending.restoring
    console.log(`[effortless] ${wanted} goes again before the next message`)
  }
  // What the agent read back is the level the prompt runs at; a set that did not take is recorded as reverted.
  const ran = t.effort
  t = remember(kept ? t : sent({ ...t, effort: wanted ?? t.effort }, {}, by), 'user', typed)
  if (wanted) console.log(`[effortless] ${ran} (${t.by})`)
  const applied = appliedEvent(t, ran, Date.now(), turn)
  if (ran !== t.effort) t = { ...t, effort: ran, by: 'app' }
  // Recorded once the agent took the prompt: a refused one ran at no level.
  if (await runTurn(typed)) record(applied)
}
quitting = true
agent.stdin.end()
setTimeout(() => agent.kill(), 5000).unref()
