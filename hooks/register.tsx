import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { UsageMeterRange, UsageMeterView } from '../types'
import { pickLang, t } from './i18n'
import { burn, countTool, loadSessions, openSession, rank, recordTurn, weight, zero } from './sessions'
import type { SessionRow, SessionStats } from './sessions'

// Plan limits as the engine already reports them after each model response
// (`session.measure`): no request of our own, no tokens.
//
// Storage: <home>/.claude/usage-meter (or $USAGE_METER_DIR)/limits/<yyyy-mm>/<session>.jsonl, one
// file per session, so sessions never race on a file. A row is written only
// when a window moved a whole point (the engine's own `changed`), and a value
// another session wrote in the last minutes is skipped; the reader dedupes the
// rest. Row: {"t":ms,"r":{"five_hour":[pct,"resetsAt"],"seven_day":[...]}}

const PANE = 'usage-meter'
const range = atom({ plugin: 'usage-meter', key: 'range' } as const, '7d' as UsageMeterRange)
const rev = atom({ plugin: 'usage-meter', key: 'rev' } as const, 0)
const view = atom({ plugin: 'usage-meter', key: 'view' } as const, 'limits' as UsageMeterView)

const HOUR = 3_600_000
const SHARED_DEDUPE_MS = 15 * 60_000

type Window = [pct: number, resetsAt?: number]
type Sample = { t: number; r: Record<string, Window> }

let root: string | undefined
let shownRoot = ''
let sessionId = 'unknown'
let ownPath: string | undefined
let ownText: string | undefined
let lastSig = ''

const COLOR: Record<string, string> = { seven_day: '#3b82f6', five_hour: '#9ca3af' }
const label = (kind: string) =>
  kind === 'five_hour' ? t.five_hour : kind === 'seven_day' ? t.seven_day : kind.replace(/^seven_day_/, t.seven_day_prefix)
const color = (kind: string) => COLOR[kind] ?? '#a855f7'

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const ddmm = (ms: number) => { const d = new Date(ms); return t.day(pad(d.getDate()), pad(d.getMonth() + 1)) }
const month = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }

async function init($: EngineInterface) {
  if (root) return root
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.').replace(/\\/g, '/')
  const custom = await $.env.get('USAGE_METER_DIR')
  root = custom ? custom.replace(/\\/g, '/').replace(/\/+$/, '') : `${home}/.claude/usage-meter`
  // Shown in the pane with the home folder as ~, so a screenshot names no user.
  shownRoot = root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root
  sessionId = await $.session.id().catch(() => 'unknown')
  return root
}

const signature = (limits: readonly SessionRateLimit[]) =>
  limits.map(l => `${l.kind}:${Math.floor(l.percentUsed)}`).sort().join(',')

function statusText(limits: readonly SessionRateLimit[]) {
  const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)
  return [...limits]
    .sort((a, b) => order(a.kind) - order(b.kind))
    .map(l => `${label(l.kind)} ${Math.round(l.percentUsed)}%`)
    .join(' · ')
}

async function record($: EngineInterface, limits: readonly SessionRateLimit[]) {
  const sig = signature(limits)
  if (sig === lastSig) return
  const dir = await init($)
  const t = await $.clock.now()

  const shared = (await $.store.get('last')) as { sig?: string; t?: number } | undefined
  lastSig = sig
  if (shared?.sig === sig && t - (shared.t ?? 0) < SHARED_DEDUPE_MS) return

  const path = `${dir}/limits/${month(t)}/${sessionId}.jsonl`
  if (path !== ownPath) {
    ownPath = path
    ownText = await $.fs.read(path).then(String).catch(() => '')
  }
  const r: Record<string, Window> = {}
  for (const l of limits) {
    const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    r[l.kind] = Number.isFinite(reset) ? [l.percentUsed, reset] : [l.percentUsed]
  }
  ownText += JSON.stringify({ t, r }) + '\n'
  await $.fs.write(path, ownText ?? '')
  await $.store.set('last', { sig, t })
  await update($, rev, n => (n ?? 0) + 1)
}

// Reader: files are re-read only when their size or mtime changed, and a file
// not touched since the range began is skipped without opening it.
const cache = new Map<string, { mtime: number; size: number; rows: Sample[] }>()

function parse(text: string): Sample[] {
  const rows: Sample[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const row = JSON.parse(line) as Sample
      if (typeof row.t === 'number' && row.r) rows.push(row)
    } catch { /* a torn last line */ }
  }
  return rows
}

async function load($: EngineInterface, since: number, now: number): Promise<Sample[]> {
  const dir = await init($)
  const months = new Set([month(since), month(now)])
  const all: Sample[] = []
  for (const m of months) {
    const folder = `${dir}/limits/${m}`
    const entries = await $.fs.list(folder).catch(() => [])
    for (const f of entries) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs < since) continue
      const path = `${folder}/${f.name}`
      let hit = cache.get(path)
      if (!hit || hit.mtime !== f.mtimeMs || hit.size !== f.size) {
        if (f.size > 4 * 1024 * 1024) continue
        const text = await $.fs.read(path).then(String).catch(() => '')
        hit = { mtime: f.mtimeMs, size: f.size, rows: parse(text) }
        cache.set(path, hit)
      }
      for (const row of hit.rows) if (row.t >= since) all.push(row)
    }
  }
  all.sort((a, b) => a.t - b.t)
  const out: Sample[] = []
  let prev = ''
  for (const row of all) {
    const sig = Object.keys(row.r).sort().map(k => `${k}:${Math.floor(row.r[k][0])}`).join(',')
    if (sig !== prev) out.push(row)
    prev = sig
  }
  return out
}

// A step line: a value holds until the next sample, or drops to 0 at its
// window's reset when that came first (a reset while every session was idle).
function steps(rows: Sample[], kind: string, now: number): [number, number][] {
  const pts: [number, number][] = []
  const own = rows.filter(r => r.r[kind])
  own.forEach((row, i) => {
    const [v, reset] = row.r[kind]
    const end = i + 1 < own.length ? own[i + 1].t : now
    pts.push([row.t, v])
    if (reset !== undefined && reset < end) pts.push([reset, v], [reset, 0], [end, 0])
    else pts.push([end, v])
  })
  return pts
}

type Forecast = { pct: number; reset?: number; rate?: number; atReset?: number; full?: number }

function forecast(rows: Sample[], kind: string, now: number): Forecast | undefined {
  const own = rows.filter(r => r.r[kind])
  const last = own[own.length - 1]
  if (!last) return undefined
  const [pct, reset] = last.r[kind]
  // Rate over the last 3 hours of the same window (same reset time).
  const from = own.find(r => r.t >= now - 3 * HOUR && r.r[kind][1] === reset)
  const out: Forecast = { pct, reset }
  if (from && last.t - from.t >= 20 * 60_000) {
    const rate = (pct - from.r[kind][0]) / ((now - from.t) / HOUR)
    out.rate = rate
    if (reset !== undefined && reset > now) {
      out.atReset = Math.min(100, pct + rate * ((reset - now) / HOUR))
      if (rate > 0 && out.atReset >= 100) out.full = now + ((100 - pct) / rate) * HOUR
    }
  }
  return out
}

function chartSvg(rows: Sample[], kinds: string[], since: number, now: number) {
  const W = 640, H = 220, L = 34, R = 8, T = 8, B = 22
  const x = (t: number) => L + ((t - since) / (now - since)) * (W - L - R)
  const y = (v: number) => T + ((100 - Math.min(100, v)) / 100) * (H - T - B)
  const parts: string[] = []
  for (const v of [0, 25, 50, 75, 100]) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#8884" />`)
    parts.push(`<text x="${L - 4}" y="${y(v) + 4}" text-anchor="end">${v}</text>`)
  }
  const span = now - since
  const step = span > 2 * 24 * HOUR ? 24 * HOUR : 3 * HOUR
  const first = new Date(since)
  first.setMinutes(0, 0, 0)
  if (step === 24 * HOUR) first.setHours(0)
  for (let t = first.getTime() + step; t < now; t += step) {
    parts.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" stroke="#8882" />`)
    parts.push(`<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${step === 24 * HOUR ? ddmm(t) : hhmm(t)}</text>`)
  }
  for (const kind of [...kinds].reverse()) {
    const pts = steps(rows, kind, now).filter(([t]) => t >= since)
    if (pts.length < 2) continue
    const d = pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    const w = kind === 'seven_day' ? 2.5 : 1.5
    parts.push(`<polyline points="${d}" fill="none" stroke="${color(kind)}" stroke-width="${w}" />`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="11" fill="#888">${parts.join('')}</svg>`
}

const BARS = '▁▂▃▄▅▆▇█'
function sparkline(rows: Sample[], kind: string, since: number, now: number, width: number) {
  const pts = steps(rows, kind, now)
  if (pts.length === 0) return ''
  let out = ''
  for (let i = 0; i < width; i++) {
    const t = since + ((i + 0.5) / width) * (now - since)
    let v: number | undefined
    for (const [pt, pv] of pts) { if (pt > t) break; v = pv }
    out += v === undefined ? ' ' : BARS[Math.min(7, Math.floor((v / 100) * 8))]
  }
  return out
}

function forecastText(f: Forecast | undefined, now: number) {
  if (!f) return t.noData
  const bits = [`${Math.round(f.pct)}%`]
  if (f.reset) bits.push(`${t.reset} ${ddmm(f.reset)} ${hhmm(f.reset)}`)
  if (f.rate !== undefined) bits.push(t.rate(f.rate.toFixed(1)))
  // The day too, unless it is today: "runs out ~15:46" two days off reads as this afternoon.
  if (f.full) bits.push(`${t.runsOut}${ddmm(f.full) === ddmm(now) ? '' : `${ddmm(f.full)} `}${hhmm(f.full)}`)
  else if (f.atReset !== undefined) bits.push(`${t.atReset}${Math.round(f.atReset)}%`)
  return bits.join(' · ')
}

// The sessions view.

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))

function sessionName(s: SessionStats) {
  if (s.title) return s.title
  const parts = (s.cwd ?? s.id).split(/[\\/]/).filter(Boolean)
  const wt = parts.lastIndexOf('worktrees')
  if (wt > 1) return `${parts[wt - 2]}/${parts[parts.length - 1]}`
  return parts[parts.length - 1] ?? s.id.slice(0, 8)
}

// What deserves a look: a session's share of the spend sets how heavy its row
// is drawn, and the two things one can act on are flagged in the theme's
// warning color: subagents taking most of it, and a cache that misses (each
// miss pays the full input price again).
const AGENTS_FLAG = 0.6
const CACHE_FLAG = 0.8

type Weight = 'regular' | 'medium' | 'semibold' | 'bold'
const rowWeight = (share: number): Weight =>
  share >= 0.15 ? 'bold' : share >= 0.07 ? 'semibold' : share >= 0.03 ? 'medium' : 'regular'

const agentShare = (s: SessionStats) => weight(s.agentTok) / Math.max(1, weight(s.agentTok) + weight(s.tok))

function sessionParts(r: SessionRow) {
  const { s, tok } = r
  const cached = tok[2] / Math.max(1, tok[0] + tok[2] + tok[3])
  const agents = agentShare(s)
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t, n]) => `${t} ${n}`).join(', ')
  const flags: string[] = []
  const rest = [`≈${fmt(r.w)}`, `${t.output} ${fmt(tok[1])}`]
  const cacheText = `${t.cache} ${Math.round(cached * 100)}%`
  if (cached < CACHE_FLAG && tok[0] + tok[2] + tok[3] > 0) flags.push(cacheText)
  else rest.push(cacheText)
  rest.push(`${t.turns} ${s.turns}`)
  const agentsText = `${t.agents} ${Math.round(agents * 100)}%`
  if (agents >= AGENTS_FLAG) flags.push(agentsText)
  else if (agents >= 0.01) rest.push(agentsText)
  if (s.costUsd !== undefined) rest.push(`$${s.costUsd.toFixed(2)}`)
  if (tools) rest.push(tools)
  return { flags, rest: rest.join(' · ') }
}

/** The line above the list: how concentrated the spend is, the subagents' part, the peak hour. */
function highlights(rows: SessionRow[], total: number, agentW: number, points: [number, number][]) {
  const bits: string[] = []
  const n = Math.min(3, rows.length)
  if (rows.length > n) bits.push(t.topShare(n, Math.round((rows.slice(0, n).reduce((a, r) => a + r.w, 0) / total) * 100)))
  if (agentW > 0) bits.push(t.agentsShare(Math.round((agentW / total) * 100)))
  const peak = points.reduce<[number, number] | undefined>((a, p) => (!a || p[1] > a[1] ? p : a), undefined)
  if (peak) bits.push(t.peak(`${ddmm(peak[0])} ${hhmm(peak[0])}`, `${fmt(peak[1])}`))
  return bits.join(' · ')
}

function burnSvg(points: [number, number][], since: number, now: number) {
  const W = 640, H = 120, L = 34, R = 8, T = 6, B = 18
  const max = Math.max(1, ...points.map(p => p[1]))
  const x = (t: number) => L + ((t - since) / (now - since)) * (W - L - R)
  const bw = Math.max(1, ((W - L - R) * HOUR) / (now - since) - 1)
  // The peak hour in a deeper blue, the rest lighter, so the eye lands there.
  const bars = points.map(([t, v]) => {
    const h = (v / max) * (H - T - B)
    const fill = v === max ? '#1d4ed8' : '#60a5fa'
    return `<rect x="${x(t).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" />`
  })
  const span = now - since
  const step = span > 2 * 24 * HOUR ? 24 * HOUR : 3 * HOUR
  const first = new Date(since)
  first.setMinutes(0, 0, 0)
  if (step === 24 * HOUR) first.setHours(0)
  const ticks: string[] = []
  for (let t = first.getTime() + step; t < now; t += step)
    ticks.push(`<text x="${x(t)}" y="${H - 4}" text-anchor="middle">${step === 24 * HOUR ? ddmm(t) : hhmm(t)}</text>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="11" fill="#888"><text x="${L - 4}" y="${T + 8}" text-anchor="end">${fmt(max)}</text><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#8884" />${bars.join('')}${ticks.join('')}</svg>`
}

function burnSpark(points: [number, number][], since: number, now: number, width: number) {
  const cells = new Array<number>(width).fill(0)
  for (const [t, v] of points) {
    const i = Math.floor(((t - since) / (now - since)) * width)
    if (i >= 0 && i < width) cells[i] += v
  }
  const max = Math.max(1, ...cells)
  return cells.map(v => (v === 0 ? ' ' : BARS[Math.min(7, Math.floor((v / max) * 7.99))])).join('')
}

async function currentId($: EngineInterface) {
  sessionId = await $.session.id().catch(() => sessionId)
  return sessionId
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const dir = await init($)
    await pickLang($, options.language)
    await $.command.register({
      name: 'usage-meter',
      description: t.commandDesc,
    })
    const now = await $.session.usage().catch(() => undefined)
    if (now?.rateLimits.length) $.ui.status(statusText(now.rateLimits))
    await openSession($, dir, await currentId($)).catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const out = await next(e)
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      $.ui.status(statusText(e.rateLimits))
      await record($, e.rateLimits).catch(() => undefined)
    }
    return out
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    const dir = await init($)
    await recordTurn($, dir, await currentId($), e.usage, e.agentId).catch(() => undefined)
    return out
  })

  // Observe only: counted in memory, written at the turn's end.
  on('tool.call', ($, e, next) => {
    countTool(String(e.tool))
    return next(e)
  })

  on('command.run', { command: 'usage-meter' }, async $ => {
    await $.ui.open({ id: PANE, title: t.paneTitle })
    return { text: 'Usage meter pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    await read($, rev)
    const span = await read($, range)
    const tab = await read($, view)
    const dir = await init($)
    const now = await $.clock.now()
    const since = now - (span === '24h' ? 24 : 7 * 24) * HOUR
    const width = Math.max(10, (e.props.bodyColumns ?? 60) - 8)

    const header = (
      <Box flexDirection="row" gap={1}>
        <Button key="vl" label={t.tabLimits} variant={tab === 'limits' ? 'primary' : undefined} onPress={() => update($, view, () => 'limits')} />
        <Button key="vs" label={t.tabSessions} variant={tab === 'sessions' ? 'primary' : undefined} onPress={() => update($, view, () => 'sessions')} />
        <Text dimColor>│</Text>
        <Button key="r24" label={t.range24} variant={span === '24h' ? 'primary' : undefined} onPress={() => update($, range, () => '24h')} />
        <Button key="r7d" label={t.range7} variant={span === '7d' ? 'primary' : undefined} onPress={() => update($, range, () => '7d')} />
      </Box>
    )

    if (tab === 'sessions') {
      const list = await loadSessions($, dir, since)
      const rows = rank(list, since)
      const total = zero()
      for (const r of rows) for (let i = 0; i < 4; i++) total[i] += r.tok[i]
      const points = burn(list, since)
      const cached = total[2] / Math.max(1, total[0] + total[2] + total[3])
      const totalW = Math.max(1, weight(total))
      // Subagents' part of the range: each session's own split applied to its weight in it.
      const agentW = rows.reduce((a, r) => a + r.w * agentShare(r.s), 0)
      const burnChart = (() => {
        if (rows.length === 0) return <Text dimColor>{t.noSessions}</Text>
        if ('Svg' in table) {
          const { Svg } = table
          return <Svg source={burnSvg(points, since, now)} alt={t.burnAlt} />
        }
        return <Text color="blue">{burnSpark(points, since, now, width)}</Text>
      })()
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {burnChart}
          <Text>
            <Text bold>{t.total}</Text> ≈{fmt(weight(total))} · {t.input} {fmt(total[0])} · {t.output} {fmt(total[1])} · {t.cacheRead} {fmt(total[2])} ({Math.round(cached * 100)}%) · {t.cacheWrite} {fmt(total[3])} · {t.sessions} {rows.length}
          </Text>
          {rows.length > 1 ? <Text weight="semibold">{highlights(rows, totalW, agentW, points)}</Text> : null}
          {rows.slice(0, 12).map(r => {
            const share = r.w / totalW
            const { flags, rest } = sessionParts(r)
            return (
              <Text dimColor={share < 0.03}>
                <Text weight={rowWeight(share)}>{sessionName(r.s)} {share < 0.005 ? '<1' : Math.round(share * 100)}%</Text>
                {flags.length > 0 ? <Text color="warning"> {flags.join(' · ')}</Text> : null}
                <Text dimColor> {r.s.src === 'backfill' ? t.backfilled : ''}{rest}</Text>
              </Text>
            )
          })}
          <Text dimColor>{t.weightNote}</Text>
        </Box>
      )
    }

    const rows = await load($, since - 7 * 24 * HOUR, now)
    const kinds = [...new Set(rows.flatMap(r => Object.keys(r.r)))].sort((a, b) =>
      a === 'seven_day' ? -1 : b === 'seven_day' ? 1 : a.localeCompare(b))
    const inRange = rows.filter(r => r.t >= since)

    const chart = (() => {
      if (kinds.length === 0) return <Text dimColor>{t.noSamples}</Text>
      if ('Svg' in table) {
        const { Svg } = table
        return <Svg source={chartSvg(rows, kinds, since, now)} alt={t.chartAlt(span === '24h')} />
      }
      return (
        <Box flexDirection="column">
          {kinds.map(k => <Text>{label(k).padEnd(6)} <Text color={k === 'seven_day' ? 'blue' : undefined}>{sparkline(rows, k, since, now, width)}</Text></Text>)}
        </Box>
      )
    })()

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {chart}
        {kinds.map(k => (
          <Text><Text bold color={k === 'seven_day' ? 'blue' : undefined}>{label(k)}</Text> {forecastText(forecast(rows, k, now), now)}</Text>
        ))}
        <Text dimColor>{inRange.length} {t.samples} · {shownRoot}</Text>
      </Box>
    )
  })
}
