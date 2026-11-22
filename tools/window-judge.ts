// What the window clients share (HCM-207): the judge's settings, how Jev and Haiku are reached, the record and the
// terminal. Jev and Haiku see what effortless sends them in Claude Code: the message, the last user message and the end
// of the last reply, and the level in use (judge-core's jevRequest and judgeQuestion), never more.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { EFFORTS } from '../hooks/judge-core.ts'
import type { Effort, JudgeSettings, Ports } from '../hooks/judge-core.ts'

const JEV_URL = process.env.JEV_URL ?? 'https://api.typesafe.ai/v1/systemone'
const HAIKU_TIMEOUT_MS = 10_000
const level = (v: string | undefined, d: Effort): Effort => (EFFORTS.includes(v as Effort) ? (v as Effort) : d)

/** The options every window client takes: the judge's settings, Auto, and where the record goes. */
export const OPTIONS = {
  judge: { type: 'string', default: 'auto' },
  bias: { type: 'string', default: '0' },
  floor: { type: 'string', default: 'low' },
  ceiling: { type: 'string', default: 'max' },
  'no-auto': { type: 'boolean', default: false },
  log: { type: 'string' },
} as const

export function settingsFrom(opt: { judge?: string; bias?: string; floor?: string; ceiling?: string }): JudgeSettings {
  return {
    judge: opt.judge === 'jev' || opt.judge === 'haiku' ? opt.judge : 'auto',
    bias: Math.max(-2, Math.min(2, Number(opt.bias) || 0)),
    floor: level(opt.floor, 'low'),
    ceiling: level(opt.ceiling, 'max'),
    saving: false,
    withModel: false,
  }
}

/** Where a harness's records go: --log, else $XDG_STATE_HOME/effortless/<harness>-events.jsonl. */
export function logPath(harness: string, given?: string): string {
  return given ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'effortless', `${harness}-events.jsonl`)
}

/** The TypeSafe key: TYPESAFE_API_KEY, else ~/.config/jev/.env (the file effortless and the jev skills read). */
function jevKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  try {
    const text = readFileSync(join(homedir(), '.config', 'jev', '.env'), 'utf8')
    return text.match(/^\s*TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m)?.[1].replace(/^['"]|['"]$/g, '') || undefined
  } catch {
    return undefined
  }
}

/**
 * Haiku through the person's own Claude login: `claude -p` in safe mode (no CLAUDE.md, plugins, hooks or MCP, so
 * effortless itself does not run in it), no tools, no saved session, from an empty folder of its own.
 */
function askHaiku(system: string, prompt: string): Promise<{ text: string; tokens: number } | undefined> {
  const cwd = join(tmpdir(), 'effortless-window-haiku')
  mkdirSync(cwd, { recursive: true })
  const args = ['-p', '--safe-mode', '--model', 'claude-haiku-5-5', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--system-prompt', system]
  return new Promise(resolve => {
    const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), HAIKU_TIMEOUT_MS)
    child.stdout.on('data', b => (out += b))
    child.on('error', () => resolve(undefined))
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return resolve(undefined)
      try {
        const r = JSON.parse(out) as { result?: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number } }
        if (r.is_error || typeof r.result !== 'string') return resolve(undefined)
        resolve({ text: r.result, tokens: (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0) })
      } catch {
        resolve(undefined)
      }
    })
    child.stdin.end(prompt)
  })
}

/** Jev on TypeSafe with the person's key, and Haiku through their Claude login. */
export function judgePorts(settings: JudgeSettings): Ports {
  const key = settings.judge !== 'haiku' ? jevKey() : undefined
  return {
  askJev: key
    ? async body => {
        const res = await fetch(JEV_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) })
        return { ok: res.ok, status: res.status, text: await res.text() }
      }
    : undefined,
  askHaiku,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  now: () => Date.now(),
  warned: reason => process.stderr.write(`[effortless] ${reason}: Haiku stands in\n`),
  }
}

/** One line of the record: levels, odds, time and tokens only (the core's events hold no text). */
export function record(log: string, event: object) {
  mkdirSync(dirname(log), { recursive: true })
  appendFileSync(log, JSON.stringify(event) + '\n')
}

/** The terminal's lines, one at a time: messages, commands and approval answers share it. */
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
export const nextLine = async () => {
  const r = await lines.next()
  return r.done ? undefined : r.value
}
