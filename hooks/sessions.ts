import type { EngineInterface, ModelUsage } from 'claude-code'

// Per-session spend, kept as the session works: one JSON file per session,
// <root>/sessions/<session id>.json, written at the end of each turn from what
// the engine reports for it (`turn.complete`'s usage), so nothing is read back
// but the session's own file once. tools/backfill.py writes the same shape
// from older transcripts (`src: "backfill"`) and leaves "live" files alone.

/** input, output, cache read, cache write */
export type Tok = [number, number, number, number]

export type SessionStats = {
  id: string
  cwd?: string
  title?: string
  first: number
  last: number
  /** Turns of the main loop (prompts answered). */
  turns: number
  /** Main loop tokens. */
  tok: Tok
  /** Subagents' tokens, all of them summed. */
  agentTok: Tok
  agentTurns: number
  models: Record<string, Tok>
  tools: Record<string, number>
  /** Tokens per hour, keyed by the hour's start in ms. */
  hours: Record<string, Tok>
  costUsd?: number
  src: 'live' | 'backfill'
}

const HOUR = 3_600_000

export const zero = (): Tok => [0, 0, 0, 0]
const addTo = (a: Tok, u: ModelUsage) => {
  a[0] += u.input_tokens ?? 0
  a[1] += u.output_tokens ?? 0
  a[2] += u.cache_read_input_tokens ?? 0
  a[3] += u.cache_creation_input_tokens ?? 0
}

/**
 * Input-equivalent weight, by the API's price ratios (output 5x input, a cache
 * write 1.25x, a cache read 0.1x): a ranking aid, not what the plan counts.
 */
export const weight = (t: Tok) => t[0] + 5 * t[1] + 0.1 * t[2] + 1.25 * t[3]

let stats: SessionStats | undefined
let path: string | undefined

async function own($: EngineInterface, root: string, id: string, now: number) {
  const want = `${root}/sessions/${id}.json`
  if (stats && path === want) return stats
  path = want
  const old = await $.fs.read(want).then(t => JSON.parse(String(t)) as SessionStats).catch(() => undefined)
  stats = old
    ? { ...old, src: 'live' }
    : { id, first: now, last: now, turns: 0, tok: zero(), agentTok: zero(), agentTurns: 0, models: {}, tools: {}, hours: {}, src: 'live' }
  stats.cwd ??= await $.session.cwd().catch(() => undefined)
  return stats
}

/** Counted in memory only; the next turn's end writes it. */
export function countTool(tool: string) {
  if (stats) stats.tools[tool] = (stats.tools[tool] ?? 0) + 1
}

export async function recordTurn(
  $: EngineInterface,
  root: string,
  id: string,
  usage: (ModelUsage & { model: string }) | undefined,
  agentId: string | undefined,
) {
  const now = await $.clock.now()
  const s = await own($, root, id, now)
  s.last = now
  if (agentId) s.agentTurns++
  else s.turns++
  if (usage) {
    addTo(agentId ? s.agentTok : s.tok, usage)
    addTo((s.models[usage.model] ??= zero()), usage)
    addTo((s.hours[String(Math.floor(now / HOUR) * HOUR)] ??= zero()), usage)
  }
  const cost = await $.session.usage().then(u => u.cost?.usd).catch(() => undefined)
  if (cost !== undefined) s.costUsd = cost
  await $.fs.write(path!, JSON.stringify(s))
}

/** The session's file is opened once at its first turn; call at start so tools count. */
export async function openSession($: EngineInterface, root: string, id: string) {
  await own($, root, id, await $.clock.now())
}

// Reader: a file is re-read only when its size or mtime changed, and one not
// written since the range began is skipped unopened.
const cache = new Map<string, { mtime: number; size: number; s?: SessionStats }>()

export async function loadSessions($: EngineInterface, root: string, since: number) {
  const dir = `${root}/sessions`
  const entries = await $.fs.list(dir).catch(() => [])
  const out: SessionStats[] = []
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || f.mtimeMs < since) continue
    const p = `${dir}/${f.name}`
    let hit = cache.get(p)
    if (!hit || hit.mtime !== f.mtimeMs || hit.size !== f.size) {
      const s = f.size > 4 * 1024 * 1024 ? undefined
        : await $.fs.read(p).then(t => JSON.parse(String(t)) as SessionStats).catch(() => undefined)
      hit = { mtime: f.mtimeMs, size: f.size, s }
      cache.set(p, hit)
    }
    if (hit.s && hit.s.last >= since) out.push(hit.s)
  }
  return out
}

export type SessionRow = { s: SessionStats; tok: Tok; w: number }

/** Each session's tokens inside [since, now], heaviest first. */
export function rank(list: SessionStats[], since: number): SessionRow[] {
  const rows: SessionRow[] = []
  for (const s of list) {
    const tok = zero()
    for (const [h, t] of Object.entries(s.hours)) {
      if (Number(h) + HOUR <= since) continue
      for (let i = 0; i < 4; i++) tok[i] += t[i]
    }
    const w = weight(tok)
    if (w > 0) rows.push({ s, tok, w })
  }
  return rows.sort((a, b) => b.w - a.w)
}

/** Summed weight per hour, for the burn chart. */
export function burn(list: SessionStats[], since: number) {
  const by = new Map<number, number>()
  for (const s of list)
    for (const [h, t] of Object.entries(s.hours)) {
      const k = Number(h)
      if (k + HOUR > since) by.set(k, (by.get(k) ?? 0) + weight(t))
    }
  return [...by.entries()].sort((a, b) => a[0] - b[0])
}
