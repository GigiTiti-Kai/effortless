// The effort judge, with no harness in it: which level a message needs, the rules before any judge, how Jev and Haiku
// are asked and how their answers are read, and the floors, lean and range after them. It imports nothing at run time
// and touches no file, network or environment, so Claude Code (register.tsx) and any other harness's adapter can load
// it; Node 24 runs it as it is (types are only stripped: no enum, namespace or parameter property here).
import type { Effort, ModelKey, Pick } from '../types'

export type { Effort, ModelKey } from '../types'

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
// The model names a judge may answer with, cheapest first. Each harness maps them to its own model ids.
export const MODEL_KEYS: ModelKey[] = ['haiku', 'sonnet', 'opus', 'fable']

export const JEV_TIMEOUT_MS = 3000

export const JUDGE_SYSTEM = `You choose which Claude model and reasoning effort an agentic assistant (it reads files, runs tools and edits things, not only code) should use for the user's next message. Pick the cheapest pair that will still do the job well.

Models, cheapest first:
- haiku: quick questions, lookups, renames, small edits in one or two files, summaries, chit-chat. It can read files and run tools; pick it for any small, well-defined job.
- sonnet: normal coding, edits across a few files, explanations, writing.
- opus: hard debugging, architecture, large refactors, careful reviews.
- fable: the hardest long-horizon or research-level work.

Effort: low for quick answers, medium for normal work, high for hard problems, xhigh or max only for very hard ones.

Effort is relative to the model in use ("Current" names it): a stronger model needs less effort for the same job. Opus at medium does about what Sonnet does at high, and Fable is stronger again. So for one and the same task pick one step lower on Opus than on Sonnet, and lower still on Fable; on Sonnet, go one step higher for hard work than you would on Opus.

Judge the SCOPE and the amount of work, not whether it is code. A short message can ask for a lot: "go through my whole drive and clean it up", "review the entire repo", "migrate everything" are big, multi-step, tool-heavy jobs where mistakes are costly: never low, usually high. Low is only for answers that need no tools and no planning.

If the message answers a question in the assistant's last reply (picks an option, says which one, confirms a plan), judge only the work that answer starts, as the reply describes it, not the length of the answer and not the work done before the question: "B" can mean "build the complicated section B" (high), while "yes" or "no" to one small action ("should I archive this?", "delete the old ones too?") is low, and picking a value for one setting (a log level, a colour, a font) is low. But picking which way to build something ("option 1", "the same shapes", "B") starts that build: judge the build. Approving a whole plan or several steps takes the effort of that plan. A plain "yes", "ok" or "do it" after "Is that OK? Then I'll build X" or "Should I build X?" approves building X: judge X, not the word.

A message that pushes back on, corrects or adds to a plan or claim under discussion continues that work: keep at least the effort that work had, never drop to low for it. Thanks, praise or a closing remark with no new request is low. A question about how to do something, or about effort itself, that needs no tools is low.

If the person asks for deep thought ("think hard", "ultrathink", "be thorough"), pick at least high; if they ask for a quick answer, pick low.

If the message is a short follow-up to ongoing work ("yes", "go", "ok", "continue", or the same in any language), keep the current pair.

Reply with JSON only: {"model":"haiku|sonnet|opus|fable","effort":"low|medium|high|xhigh|max","sure":0.0-1.0 how sure you are of the effort,"why":"at most 6 words, in the user's language"}`

/** Reads `{ model, effort, why }` out of a reply, or nothing when it doesn't hold one. */
export function parseVerdict(text: string): { model: ModelKey; effort: Effort; why: string; sure?: number; handoff?: string } | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { model, effort, why, sure, handoff } = raw as Record<string, unknown>
  const key = typeof model === 'string' ? model.toLowerCase() : ''
  // A model id ("claude-sonnet-5-5") holds its key, so matching the key inside it finds the same model.
  const found = MODEL_KEYS.find(k => key.includes(k))
  if (!found || !EFFORTS.includes(effort as Effort)) return undefined
  const how = typeof sure === 'number' && sure >= 0 && sure <= 1 ? { sure } : {}
  // Only a reason counts: "handoff":"" or false is no advice.
  const advice = typeof handoff === 'string' && handoff.trim() ? { handoff: handoff.trim().slice(0, 70) } : {}
  return { model: found, effort: effort as Effort, why: typeof why === 'string' ? why.slice(0, 60) : '', ...how, ...advice }
}

/** The context text from the conversation so far: the last user message, short, and the assistant's last reply's end. */
export function contextFrom(messages: readonly { role: string; text: string }[]): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const lastAssistant = lastAssistantText(messages)
  return [lastUser ? `user: ${lastUser.text.slice(0, 400)}` : '', lastAssistant ? `assistant: ${lastAssistant.slice(-2000)}` : '']
    .filter(Boolean)
    .join('\n')
}

/** The assistant's last reply, or nothing. */
export function lastAssistantText(messages: readonly { role: string; text: string }[]): string {
  return [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim())?.text ?? ''
}

// Jev answers typed questions with probabilities; these are the options it picks between, each with what it is for,
// what it is not for and examples (EFR-5 plan 3: on made-up cases 98/98 against Haiku's 91/98).
export const JEV_EFFORTS: Record<Effort, { what: string; not_for: string; examples: string[] }> = {
  low: {
    what: 'Answerable from the message itself or from general knowledge, with no files, logs, commands or web pages to look at; thanks or a closing remark; yes or no to one small action; picking one value for one setting.',
    not_for: 'Anything that needs looking at files, logs, running programs or the web to answer, even when the message is short or casual (that is medium or more).',
    examples: ["Thanks, that's all for today.", "What's the difference between a list and a tuple in Python?", '「締め切り」って英語で何て言う？'],
  },
  medium: {
    what: 'Normal work: a few tool calls or edits. Reading some files or a log to answer, checking a status, a small edit in one or two files, explaining how something in this project works after looking it up.',
    not_for: 'A question answerable from memory with no tools (low); a job across many files, an unclear failure to debug, or a design decision (high).',
    examples: ['設定ファイルの読み込み順がどうなってるか、コードを見て教えて', 'Add a --verbose flag to the CLI script in tools/.', 'このプロジェクトのテストってどうやって走らせるの？調べて教えて', 'Is the staging DB still on the old schema?'],
  },
  high: {
    what: 'A hard or large multi-step job where mistakes are costly: debugging a failure whose cause is unknown, changes across many files, a migration or design plan, a careful review.',
    not_for: 'A lookup, a status check or a small edit (medium); a long open-ended investigation with many unknowns (xhigh).',
    examples: ['Split the 3,000-line server.js into modules without changing behavior, and keep the tests green.', 'このPRをマージ前にセキュリティの観点でレビューして', "Why did sign-ups drop after Tuesday's release?"],
  },
  xhigh: {
    what: 'Very hard: a long investigation or research with many unknowns, the architecture of a whole system, or a problem earlier attempts failed to solve.',
    not_for: 'A large but straightforward change or a normal review (high).',
    examples: ["We've tried three times to fix the race condition in the job queue; dig until you find the root cause.", '端末をまたいでオフラインでも編集できるように、データの持ち方と同期の仕組みを設計して'],
  },
  max: {
    what: 'The hardest research-level work, or the person explicitly asks for the deepest possible effort.',
    not_for: 'Very hard engineering work that a long investigation can finish (xhigh).',
    examples: ['Prove or disprove that this consensus algorithm stays safe under network partitions, with a full argument.'],
  },
}
export const JEV_EFFORT_FOCUS = 'Judge how much looking things up, tool use and planning the request needs, not how long or casual the message is.'
// Two judgments code turns into floors (jevFloor): Jev keeps rules that read the state ("keep the current effort") badly.
export const JEV_NOULS = {
  continues_work: {
    type: 'noul',
    instructions: 'Does next_message continue, correct, redirect or push back on work the assistant is doing or just delivered? False for an unrelated new request and for thanks or a closing remark.',
  },
  needs_lookup: {
    type: 'noul',
    instructions: 'To respond well, must the assistant look at something outside the message: files, code, logs, command output, the web?',
  },
}
export const JEV_MODELS: Record<ModelKey, string> = {
  haiku: 'trivial questions, lookups, renames, chit-chat',
  sonnet: 'normal coding, edits across a few files, explanations, writing',
  opus: 'hard debugging, architecture, large refactors, careful reviews',
  fable: 'the hardest long-horizon or research-level work',
}
export const JEV_TASK =
  'Choose the reasoning effort (and model) an agentic assistant should use for the next user message. It reads files, ' +
  'runs tools and edits things, not only code. Pick the cheapest that still does the job well. Judge the scope and the ' +
  'amount of work, not whether it is code: "go through my whole drive and clean it up" is a big tool-heavy job. ' +
  'When the message answers a ' +
  "question in the assistant's last reply (picks an option), judge only the work that answer starts, not its length and " +
  'not the work before the question: yes/no to one small action, or picking a value for one setting (a log level, a colour), is low; picking which way to build something starts that build, so judge the build; ' +
  'approving a whole plan takes the effort of that plan; a plain yes to "Then I will build X" means judge X. Thanks or a closing remark with no new request is low. ' +
  '"think hard", "ultrathink" or "be thorough" means ' +
  'at least high; "quick question" means low.'

const LEVEL_WORD = '(low|medium|high|xhigh|x-high|extra[- ]high|max|maximum)'
const NAMED_LEVEL = new RegExp(`\\b${LEVEL_WORD}\\s+effort\\b|\\beffort(?:\\s+level)?\\s*(?:[:=]|to|at|of|on)?\\s*${LEVEL_WORD}\\b|\\bxhigh\\b`, 'gi')
const LEVEL_OF: Record<string, Effort> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', 'x-high': 'xhigh', 'extra high': 'xhigh', 'extra-high': 'xhigh', max: 'max', maximum: 'max' }

/**
 * The level a prompt asks for by name ("max effort", "effort: high", "xhigh"), or nothing. The word effort must sit
 * beside the level, so "a medium sized image" names nothing, and "don't use max effort" is a no. A named level runs
 * without the judge: effort-auto found Haiku also calls prompts that only describe hard work "named".
 */
export function namedEffort(text: string): Effort | undefined {
  for (const m of text.matchAll(NAMED_LEVEL)) {
    const before = text.slice(Math.max(0, m.index - 20), m.index).toLowerCase()
    if (/\b(not|no|don'?t|never|without|instead of)\b/.test(before)) continue
    return LEVEL_OF[(m[1] ?? m[2] ?? 'xhigh').toLowerCase().replace(/\s+/, ' ')]
  }
  return undefined
}

// Go-aheads and thanks, matched by word: Japanese has no spaces, so a length rule made every short request ("テスト直して")
// a go-ahead. Words may repeat and run together ("はいお願いします", "ありがとう、助かった"), with punctuation between.
const ACK_WORDS = ['ok', 'okay', 'k', 'yes', 'y', 'yep', 'yeah', 'sure', 'go', 'go ahead', 'continue', 'next', 'proceed', 'lgtm', 'please',
  'はい', 'うん', 'ええ', 'おけ', 'おk', 'おっけー', '了解', 'りょ', 'りょうかい', '続けて', 'つづけて', '続きを', '続き', '進めて', 'すすめて',
  'お願いします', 'おねがいします', 'お願い', 'おねがい', 'それで', 'いいよ', 'いいね', 'どうぞ', 'やって', 'よろしく', '頼む', 'たのむ',
  'わかりました', '分かりました', 'わかった', '分かった', 'ください', 'です']
const THANKS_WORDS = ['thanks', 'thank you', 'thx', 'ty', 'ありがとうございます', 'ありがとうございました', 'ありがとう', 'ありがと',
  'サンキュー', 'さんきゅ', '助かりました', '助かります', '助かった', '助かる', '感謝']
const wordsOnly = (words: string[]) =>
  new RegExp(`^(?:(?:${[...words].sort((a, b) => b.length - a.length).join('|')})[\\s、。,.!！?？…~〜ー笑w]*)+$`)
const ACK_OR_THANKS = wordsOnly([...ACK_WORDS, ...THANKS_WORDS])
const THANKS_ONLY = wordsOnly(THANKS_WORDS)

/** A go-ahead such as "go", "ok", "はい", "続けて", or thanks: nothing but words from the lists. */
export function isFollowUp(text: string): boolean {
  return ACK_OR_THANKS.test(text.trim().toLowerCase())
}

/** Thanks and nothing else ("ありがとう", "thanks!"): low by rule, no judge. */
export function isThanks(text: string): boolean {
  return THANKS_ONLY.test(text.trim().toLowerCase())
}

/**
 * Whether the assistant's last reply ended on a question ("Should I archive it?", "A, B or C?"). A short message
 * after one answers it, and the answer can start a small or a big job, so it goes to the judge instead of keeping
 * the effort.
 */
export function endsOnQuestion(context: string): boolean {
  const reply = context.split('\nassistant: ').pop() ?? ''
  return context.includes('assistant: ') && reply.slice(-400).includes('?')
}

/** The message as the judge reads it: images and files it carries are named, since the judge sees only text. */
export function withAttachments(text: string, attachments?: readonly { type: string }[]): string {
  if (!attachments?.length) return text
  const counts = new Map<string, number>()
  for (const a of attachments) counts.set(a.type, (counts.get(a.type) ?? 0) + 1)
  const said = [...counts].map(([type, n]) => `${n} ${type}${n > 1 ? 's' : ''}`).join(', ')
  return `${text}

[The message comes with ${said} to look at.]`
}

/** The message as the judge reads it when messages typed during the last turn were carried over to it. */
export function withCarried(text: string, carried: string): string {
  return `${text}

[Typed earlier, while the last task was still running, and not judged then: ${carried}]`
}

/** The level named last in messages typed during a turn: a later correction ("actually low effort") wins. */
export function lastNamed(texts: readonly string[]): Effort | undefined {
  for (const t of [...texts].reverse()) {
    const named = namedEffort(t)
    if (named) return named
  }
  return undefined
}

/** A short follow-up that keeps the current effort: "go" between two steps, not an answer to a question. */
export function keepsEffort(message: string, context: string): boolean {
  return isFollowUp(message) && !endsOnQuestion(context)
}

/** Messages typed mid-turn that carry work: go-aheads and thanks carry none, so they never send a message to the judge. */
export function carriesWork(texts: readonly string[]): string[] {
  return texts.filter(t => !isFollowUp(t))
}

/**
 * The floors the two Nouls set (at 0.5 or more): carrying on with work under way keeps at least the current
 * effort, and a message that needs looking things up gets at least medium.
 */
export function jevFloor(effort: Effort, current: Effort | undefined, continuesWork?: number, needsLookup?: number): Effort {
  const at = (e: Effort) => EFFORTS.indexOf(e)
  let floor: Effort = 'low'
  if (typeof needsLookup === 'number' && needsLookup >= 0.5) floor = 'medium'
  if (current && typeof continuesWork === 'number' && continuesWork >= 0.5 && at(current) > at(floor)) floor = current
  return at(effort) < at(floor) ? floor : effort
}

/** The verdict's effort leaned by the person's effortBias, never below the floor Jev's Nouls set. */
export function leanedVerdict(verdict: Pick, bias: number): Effort {
  const leaned = tipped(verdict.effort, verdict.sure, bias)
  return verdict.least && EFFORTS.indexOf(leaned) < EFFORTS.indexOf(verdict.least) ? verdict.least : leaned
}

/** Jev's answer as a verdict: its effort raised to the Nouls' floors, which it keeps as least. The model is Jev's only when it was asked. */
export function parseJevAnswer(text: string, current: Pick | null): { model: ModelKey; effort: Effort; why: string; sure?: number; least?: Effort } | undefined {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  const answers = (json.answers ?? (json.result as Record<string, unknown> | undefined)?.answers) as
    | Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }>
    | undefined
  const chosen = answers?.effort?.choice as Effort | undefined
  if (!chosen || !EFFORTS.includes(chosen)) return undefined
  const model = MODEL_KEYS.find(k => k === answers?.model?.choice) ?? current?.model ?? 'sonnet'
  const sure = answers?.effort?.confidence ?? answers?.effort?.probabilities?.[chosen]
  const least = jevFloor('low', current?.effort, answers?.continues_work?.noul, answers?.needs_lookup?.noul)
  const floored = least !== 'low' ? { least } : {}
  const effort = EFFORTS.indexOf(chosen) < EFFORTS.indexOf(least) ? least : chosen
  // A raised level carries no sure: the odds were for Jev's own pick.
  if (effort !== chosen) return { model, effort, why: `raised from ${chosen}`, ...floored }
  if (typeof sure !== 'number') return { model, effort, why: '', ...floored }
  return { model, effort, why: `${Math.round(sure * 100)}% sure`, sure, ...floored }
}

/** Why a judge the person picked could not answer, in words: what a status code means for them. */
export function judgeFailure(name: string, status: number | 'timeout'): string {
  if (status === 'timeout') return `${name} did not answer in time`
  if (status === 401 || status === 403) return `${name} rejected the key (${status})`
  if (status === 402) return `${name} is out of credits (${status})`
  if (status === 429) return `${name} is rate limited (${status})`
  return `${name} failed (${status})`
}

/** The text the judge reads: the current pair, the last turns and the next message. */
export function judgeQuestion(prompt: string, current: Pick | null, context: string): string {
  return [
    current ? `Current: ${current.model} / ${current.effort}` : 'Current: none',
    context ? `Recent conversation:\n${context}` : '',
    `Next message:\n${prompt.slice(0, 2000)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * What effortless sends Jev. No current_model and no model question unless a model may be picked or suggested: the
 * model sat beside "one step lower on Opus" and pulled efforts down (EFR-5).
 */
export function jevRequest(prompt: string, current: Pick | null, context: string, withModel: boolean) {
  return {
    model: 'jev-latest',
    state: { task: JEV_TASK, current_effort: current?.effort ?? null, recent_conversation: context, next_message: prompt.slice(0, 4000) },
    questions: {
      effort: { type: 'choice', instructions: { question: 'Which effort fits the next message?', focus: JEV_EFFORT_FOCUS }, criteria: JEV_EFFORTS },
      ...(withModel ? { model: { type: 'choice', instructions: 'Which model fits the next message?', criteria: JEV_MODELS } } : {}),
      ...JEV_NOULS,
    },
  }
}

/**
 * The effort slider tips close calls only: a verdict the judge was unsure of moves one step toward cheaper or smarter.
 * The outer stops count more calls as close. A sure verdict, or one without a confidence, stays as it is.
 */
export function tipped(effort: Effort, sure: number | undefined, bias: number): Effort {
  if (!bias || sure === undefined || sure >= (Math.abs(bias) === 1 ? 0.65 : 0.85)) return effort
  const i = Math.max(0, Math.min(EFFORTS.length - 1, EFFORTS.indexOf(effort) + Math.sign(bias)))
  return EFFORTS[i]
}

/** Floor and ceiling from the settings: what Auto picks stays between them. */
export function bounded(effort: Effort, floor: Effort, ceiling: Effort): Effort {
  const lo = EFFORTS.indexOf(floor)
  const hi = Math.max(lo, EFFORTS.indexOf(ceiling))
  return EFFORTS[Math.max(lo, Math.min(hi, EFFORTS.indexOf(effort)))]
}

/** Save mode caps what Auto picks at medium; a higher pick comes down to it. */
export function capped(effort: Effort, saving: boolean): Effort {
  return saving && EFFORTS.indexOf(effort) > EFFORTS.indexOf('medium') ? 'medium' : effort
}

/** The lowest effort a helper gets: medium, or the person's Min when higher, never above their Max. A helper's answer
 * goes back to the chat unchecked, and at low it miscounted where medium did not (bench/results/helpers-2026-10-10.md). */
export function helperFloor(floor: Effort, ceiling: Effort): Effort {
  const i = Math.min(Math.max(EFFORTS.indexOf(floor), EFFORTS.indexOf('medium')), EFFORTS.indexOf(ceiling))
  return EFFORTS[i]
}

// One decision. The core says which level is right; when to send it, and whether a harness can apply it at all
// (Claude Code leaves Haiku and cache-unsafe models alone), stays with the harness.

export type Harness = 'claude-code' | 'codex' | 'grok' | 'agy' | 'hermes'

/** The person's settings a decision reads. saving: save mode caps at medium. withModel: the judge is asked for a model too. */
export type JudgeSettings = { judge: 'auto' | 'haiku' | 'jev'; bias: number; floor: Effort; ceiling: Effort; saving: boolean; withModel: boolean }

/** What a harness lends the judge to reach the world. Without askJev, Jev is not asked. */
export type Ports = {
  askJev?: (body: unknown) => Promise<{ ok: boolean; status: number; text: string }>
  /** Haiku's reply text and the tokens it took, or nothing when it did not answer. */
  askHaiku: (system: string, prompt: string) => Promise<{ text: string; tokens: number } | undefined>
  sleep: (ms: number) => Promise<unknown>
  now: () => number
  /** Called once, just before a judge is asked: Claude Code starts its glow here. */
  judging?: () => Promise<void>
  /** Called as soon as Jev fails in a way to tell the person, before Haiku is asked. */
  warned?: (reason: string) => void
}

/** What Jev said, as numbers only: the record keeps no text. */
export type JevSeen = { choice: Effort; sure?: number; continues_work?: number; needs_lookup?: number; least?: Effort; p?: Partial<Record<Effort, number>> }

/** One ask of the judges: the verdict, or why there is none. */
export type Judged = {
  verdict?: Pick
  tokens: number
  ms?: number
  /** Why Jev failed, in words for the person, when they should be told: an error status, a timeout, no connection. */
  warn?: string
  /** Jev was asked and gave no verdict (an unreadable answer too, which warns nobody). */
  fellBack?: boolean
  jev?: JevSeen
}

/** Jev on TypeSafe: a verdict, or why not. Never throws: a stalled endpoint is given up after JEV_TIMEOUT_MS. */
export async function askJevOnce(message: string, current: Pick | null, context: string, withModel: boolean, ports: Ports): Promise<Judged> {
  if (!ports.askJev) return { tokens: 0 }
  try {
    const res = await Promise.race([
      ports.askJev(jevRequest(message, current, context, withModel)),
      ports.sleep(JEV_TIMEOUT_MS).then(() => {
        throw new Error('jev timeout')
      }),
    ])
    const warn = res.ok ? undefined : judgeFailure('Jev', res.status)
    if (warn) ports.warned?.(warn)
    const verdict = res.ok ? parseJevAnswer(res.text, current) : undefined
    if (!verdict) return { tokens: 0, warn, fellBack: true }
    let used = 0
    try {
      const usage = (JSON.parse(res.text) as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
      used = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)
    } catch {
      // No usage in the reply: counted as 0.
    }
    return { verdict: { ...verdict, by: 'jev' }, tokens: used, jev: jevSeen(res.text, verdict.least) }
  } catch (error) {
    const warn = String(error).includes('timeout') ? judgeFailure('Jev', 'timeout') : 'Jev could not be reached'
    ports.warned?.(warn)
    return { tokens: 0, warn, fellBack: true }
  }
}

/** Jev's answer as the record keeps it. */
function jevSeen(text: string, least: Effort | undefined): JevSeen {
  type Answer = { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }
  const json = JSON.parse(text) as { answers?: Record<string, Answer>; result?: { answers?: Record<string, Answer> } }
  const a = json.answers ?? json.result?.answers
  const choice = a?.effort?.choice as Effort
  const p = a?.effort?.probabilities
  const seen: JevSeen = { choice }
  const sure = a?.effort?.confidence ?? p?.[choice]
  if (typeof sure === 'number') seen.sure = sure
  if (typeof a?.continues_work?.noul === 'number') seen.continues_work = a.continues_work.noul
  if (typeof a?.needs_lookup?.noul === 'number') seen.needs_lookup = a.needs_lookup.noul
  if (least) seen.least = least
  if (p) seen.p = Object.fromEntries(EFFORTS.filter(e => typeof p[e] === 'number').map(e => [e, p[e]]))
  return seen
}

/** Haiku with the old judge prompt: a verdict, or nothing. */
export async function askHaikuOnce(message: string, current: Pick | null, context: string, ports: Ports): Promise<Judged> {
  const r = await ports.askHaiku(JUDGE_SYSTEM, judgeQuestion(message, current, context))
  const verdict = r ? parseVerdict(r.text) : undefined
  return { verdict: verdict && { ...verdict, by: 'haiku' }, tokens: r?.tokens ?? 0 }
}

/**
 * Jev first, when it can be asked and the setting is not haiku; Haiku makes the call only when Jev is down, slow or
 * unreadable: sending Jev's unsure calls to Haiku scored the same or lower (EFR-5).
 */
export async function askJudges(message: string, current: Pick | null, context: string, settings: JudgeSettings, ports: Ports): Promise<Judged> {
  const start = ports.now()
  const jev = settings.judge !== 'haiku' ? await askJevOnce(message, current, context, settings.withModel, ports) : { tokens: 0 }
  if (jev.verdict) return { ...jev, ms: ports.now() - start }
  const haiku = await askHaikuOnce(message, current, context, ports)
  return { ...haiku, warn: jev.warn, fellBack: jev.fellBack, ms: ports.now() - start }
}

/** A verdict's level after the person's lean, Min, Max and save mode, and the reason shown for it. */
export function settle(verdict: Pick, bias: number, floor: Effort, ceiling: Effort, saving: boolean) {
  const leaned = leanedVerdict(verdict, bias)
  const inRange = bounded(leaned, floor, ceiling)
  const effort = capped(inRange, saving)
  const why = effort !== inRange ? 'save mode' : inRange !== verdict.effort ? 'your settings' : verdict.why
  return { leaned, inRange, effort, why }
}

/** Thanks is low within Min and Max; a go-ahead keeps the session's own effort (nothing, when it is not known yet). */
export function ruleEffort(thanks: boolean, sessionEffort: Effort | undefined, floor: Effort, ceiling: Effort): Effort | undefined {
  return thanks ? bounded('low', floor, ceiling) : sessionEffort
}

export type DecisionInput = {
  /** What the judge reads: the message with what it carries (attachments, a skill's description, carried messages). */
  message: string
  /** The person's own words: a named level, thanks and a go-ahead are read here. */
  typed: string
  /** Messages typed during the last turn that carry work: a level named last there counts as named. */
  earlier?: readonly string[]
  /** contextFrom's text: the last user message and the end of the assistant's last reply. */
  context: string
  /** The level in use. Claude Code: the saved pick (medium without one) on the session's model. */
  current: { model: ModelKey; effort: Effort } | null
  /** What a go-ahead keeps. */
  sessionEffort?: Effort
  /** The phase running now; the harness finds it. */
  phase?: { name: string; effort: Effort }
  settings: JudgeSettings
  /** The rules before the judge may decide: Auto runs effort and the message is not a slash command. */
  rules: boolean
  /** And the message carries no image, file or carried message: thanks and a go-ahead are read as such only then. */
  bare: boolean
  /** The level in use was set by hand: a go-ahead is judged rather than kept. */
  manual?: boolean
  harness: Harness
  session: string
  turn?: string
}

export type Decision = {
  /** The level to run; undefined is "change nothing" (a go-ahead before the session effort is known, no verdict). */
  effort: Effort | undefined
  /** The judge's model, only when it was asked for one. */
  model?: ModelKey
  by: 'named' | 'rule' | 'phase' | 'jev' | 'haiku' | 'none'
  why: string
  /** The judge's own answer, before the person's lean, Min, Max and save mode. */
  verdict?: Pick
  /** Jev failed in a way to tell the person; Haiku stood in. */
  warn?: string
  event: DecisionEvent
}

/** One decision as a record: levels, odds, time and tokens; never the message, the context or a key. */
export type DecisionEvent = {
  v: 1
  harness: Harness
  session: string
  turn?: string
  /** UNIX seconds. */
  at: number
  decided: Effort | null
  by: Decision['by']
  auto: boolean
  judge?: {
    jev?: JevSeen
    haiku?: { effort: Effort; sure?: number }
    leaned?: Effort
    bounded?: Effort
    capped?: Effort
    ms: number
    tokens: number
    fallback?: string
  }
}

/** A level as the harness reported it: wider than Effort (Codex has ultra, and its levels are any non-empty string). */
export type AppliedLevel = string

/** What a harness saw run, written when it sees the level that took effect. */
export type AppliedEvent = {
  v: 1
  harness: Harness
  session: string
  turn?: string
  at: number
  applied: AppliedLevel | null
  by: 'jev' | 'haiku' | 'rule' | 'phase' | 'named' | 'skill' | 'manual' | 'app'
  /** The level that ran differs from the one decided, and the person did not change it. */
  reverted?: boolean
}

/**
 * The level for the next message: a phase's level, thanks, a go-ahead, a named level, else Jev, else Haiku, then the
 * person's lean, Min, Max and save mode. The same order prompt.submit always had. A named level beats the phase.
 */
export async function decide(input: DecisionInput, ports: Ports): Promise<Decision> {
  const s = input.settings
  const named = input.rules ? namedEffort(input.typed) ?? lastNamed(input.earlier ?? []) : undefined
  const made = (effort: Effort | undefined, by: Decision['by'], why: string, rest: Partial<Decision> = {}, judge?: DecisionEvent['judge']): Decision => ({
    effort,
    by,
    why,
    ...rest,
    event: {
      v: 1,
      harness: input.harness,
      session: input.session,
      ...(input.turn !== undefined ? { turn: input.turn } : {}),
      at: Math.floor(ports.now() / 1000),
      decided: effort ?? null,
      by,
      auto: by !== 'named' && by !== 'none',
      ...(judge ? { judge } : {}),
    },
  })
  if (input.rules && input.phase && !named) return made(capped(bounded(input.phase.effort, s.floor, s.ceiling), s.saving), 'phase', `${input.phase.name} phase`)
  if (input.rules && input.bare && isThanks(input.typed)) return made(ruleEffort(true, input.sessionEffort, s.floor, s.ceiling), 'rule', 'thanks')
  if (input.rules && input.bare && !input.manual && isFollowUp(input.typed) && keepsEffort(input.typed, input.context)) {
    return made(ruleEffort(false, input.sessionEffort, s.floor, s.ceiling), 'rule', 'a go-ahead: the session effort')
  }
  if (named) return made(named, 'named', 'you asked for it')

  await ports.judging?.()
  const current: Pick | null = input.current && { ...input.current, why: '', by: 'manual' }
  const j = await askJudges(input.message, current, input.context, s, ports)
  const fallback = j.warn ?? (j.fellBack ? 'Jev gave no usable answer' : undefined)
  const record = { ms: j.ms ?? 0, tokens: j.tokens, ...(j.jev ? { jev: j.jev } : {}), ...(fallback ? { fallback } : {}) }
  const rest = { ...(j.warn ? { warn: j.warn } : {}) }
  const verdict = j.verdict
  if (!verdict) return made(undefined, 'none', '', rest, record)
  const { leaned, inRange, effort, why } = settle(verdict, s.bias, s.floor, s.ceiling, s.saving)
  const haiku = verdict.by === 'haiku' ? { haiku: { effort: verdict.effort, ...(verdict.sure !== undefined ? { sure: verdict.sure } : {}) } } : {}
  const by = verdict.by === 'jev' ? 'jev' : 'haiku'
  return made(effort, by, why, { ...rest, verdict, ...(s.withModel ? { model: verdict.model } : {}) }, { ...record, ...haiku, leaned, bounded: inRange, capped: effort })
}

export type Scorecard = {
  decisions: number
  /** Decisions by harness, by who made them and by level ('none': nothing changed). */
  counts: { harness: Harness; by: Decision['by']; effort: Effort | 'none'; n: number }[]
  /** Share of decisions a rule, a phase or a judge made (0-1). */
  auto: number
  /** Share of the decisions Jev was asked for that it gave none and Haiku (or nothing) stood in (0-1). */
  fellBack: number
  /** Levels that ran, by harness, by who set them and by level as reported ('ultra' is a column of its own). */
  applied: { harness: Harness; by: AppliedEvent['by']; level: string; n: number }[]
  /** Applied levels that differed from the decided one without the person changing it. */
  reverted: number
  /** For each level, Jev's probability for it in tenths: [0] counts 0-0.1, [9] counts 0.9-1. */
  jev: Record<Effort, number[]>
}

/** The table HCM-210 reads, from the records alone. */
export function scorecard(events: readonly (DecisionEvent | AppliedEvent)[]): Scorecard {
  const decisions = events.filter((e): e is DecisionEvent => 'decided' in e)
  const counts = new Map<string, Scorecard['counts'][number]>()
  const jev = Object.fromEntries(EFFORTS.map(e => [e, Array<number>(10).fill(0)])) as Record<Effort, number[]>
  let auto = 0
  let asked = 0
  let fell = 0
  for (const d of decisions) {
    const effort = d.decided ?? 'none'
    const key = `${d.harness}|${d.by}|${effort}`
    const row = counts.get(key) ?? { harness: d.harness, by: d.by, effort, n: 0 }
    row.n++
    counts.set(key, row)
    if (d.auto) auto++
    if (d.judge?.jev || d.judge?.fallback) asked++
    if (d.judge?.fallback) fell++
    for (const [level, p] of Object.entries(d.judge?.jev?.p ?? {}) as [Effort, number][]) jev[level][Math.min(9, Math.floor(p * 10))]++
  }
  const applied = new Map<string, Scorecard['applied'][number]>()
  for (const a of events.filter((e): e is AppliedEvent => 'applied' in e)) {
    const level = a.applied ?? 'none'
    const key = `${a.harness}|${a.by}|${level}`
    const row = applied.get(key) ?? { harness: a.harness, by: a.by, level, n: 0 }
    row.n++
    applied.set(key, row)
  }
  const share = (n: number, of: number) => (of ? n / of : 0)
  return {
    decisions: decisions.length,
    counts: [...counts.values()],
    auto: share(auto, decisions.length),
    fellBack: share(fell, asked),
    applied: [...applied.values()],
    reverted: events.filter(e => 'applied' in e && e.reverted).length,
    jev,
  }
}
