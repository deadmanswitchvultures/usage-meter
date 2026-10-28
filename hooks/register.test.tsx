import { expect, test } from 'claude-code/testing'

import { langOf } from './i18n'

const T0 = Date.parse('2026-10-28T03:00:00Z')
const RESET = '2026-10-28T04:00:00Z'
const ROOT = 'C:/Users/me/.claude/usage-meter'

const limits = (five: number, week: number) => [
  { kind: 'five_hour', percentUsed: five, resetsAt: '2026-10-28T02:30:00Z' },
  { kind: 'seven_day', percentUsed: week, resetsAt: RESET },
]

const measure = (five: number, week: number) => ({
  context: { contextWindowSize: 400000 } as never,
  rateLimits: limits(five, week),
  changed: ['rateLimits' as const],
})

const pane = (surface: 'terminal' | 'desktop') => ({
  plugin: 'usage-meter',
  component: 'Pane',
  requestId: 'usage-meter',
  surface,
  props: { title: 'Лимиты', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
}) as const

// Every hook here stands for the engine: an in-memory file system and store,
// and a clock the test moves.
function fakeEngine(on: Parameters<Parameters<typeof test>[1]>[1], language = 'russian') {
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const clock = { now: T0 }
  const norm = (p: string) => p.replace(/\\/g, '/')

  // A read of one key is the read of the whole object, projected.
  on('settings.read', () => ({ value: language ? { language } : {} }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('session.id', () => ({ value: 'sess1' }))
  on('session.cwd', () => ({ value: 'D:\\work\\demo' }))
  on('clock.now', () => ({ value: clock.now }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_, e) => { files.set(norm(e.path), e.text); return { value: undefined } })
  on('fs.list', (_, e) => {
    const dir = `${norm(e.path)}/`
    const value = [...files.entries()]
      .filter(([p]) => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
      .map(([p, text]) => ({ name: p.slice(dir.length), kind: 'file', size: text.length, mtimeMs: clock.now, isLink: false }))
    return { value }
  })
  on('session.usage', () => ({ value: { startedAt: T0, context: {}, rateLimits: [], cost: { usd: 1.5 } } }))
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('ui.status', () => ({ value: undefined }))
  return { files, clock }
}

test('samples land in the session file once per change, and the pane charts them', async ($, on) => {
  const { files, clock } = fakeEngine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(10, 68))
  clock.now += 10 * 60_000
  await $.session.measure(measure(10, 68)) // same values: no row
  clock.now += 30 * 60_000
  await $.session.measure(measure(30, 72))

  const path = `${ROOT}/limits/2026-10/sess1.jsonl`
  const rows = (files.get(path) ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(rows.length).toBe(2)
  expect(rows[1].r.seven_day[0]).toBe(72)
  expect(rows[1].r.seven_day[1]).toBe(Date.parse(RESET))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    const line = await ui.find({ type: 'Text', text: /темп/ })
    expect(line?.text).toMatch(/72%/)
    expect(line?.text).toMatch(/темп 6\.0 %\/ч/)
    await ui.unmount()
  }
})

test('turns and tool calls add up in the session file, and the sessions view ranks it', async ($, on) => {
  const { files, clock } = fakeEngine(on)
  const usage = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 2000, model: 'claude-opus-5-5' }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', usage })
  clock.now += 2 * 3_600_000
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer', usage })

  const s = JSON.parse(files.get(`${ROOT}/sessions/sess1.json`) ?? '{}')
  expect(s.src).toBe('live')
  expect(s.turns).toBe(1)
  expect(s.agentTurns).toBe(1)
  expect(s.tok).toEqual([10, 1000, 50000, 2000])
  expect(s.agentTok).toEqual([10, 1000, 50000, 2000])
  expect(s.tools).toEqual({ Bash: 2 })
  expect(Object.keys(s.hours).length).toBe(2)
  expect(s.costUsd).toBe(1.5)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    await ui.press({ key: 'vs' })
    const total = await ui.find({ type: 'Text', text: /^Всего/ })
    expect(total?.text).toMatch(/вых 2k/)
    const row = await ui.find({ type: 'Text', text: /^demo/ })
    expect(row?.text).toMatch(/ходов 1/)
    expect(row?.text).toMatch(/агенты 50%/)
    expect(row?.text).toMatch(/Bash 2/)
    await ui.unmount()
  }
})

test('with no language set the pane speaks English', async ($, on) => {
  const { clock } = fakeEngine(on, '')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(10, 68))
  clock.now += 40 * 60_000
  await $.session.measure(measure(30, 72))

  const ui = await $.ui.mount(pane('desktop'))
  const line = await ui.find({ type: 'Text', text: /rate/ })
  expect(line?.text).toMatch(/^wk 72% · resets/)
  expect(line?.text).toMatch(/rate 6\.0 %\/h over 3 h/)
  await ui.unmount()
})

test('language names and locale codes pick their table', async () => {
  const cases: [string, string | undefined][] = [
    ['russian', 'ru'], ['Русский', 'ru'], ['ru_RU.UTF-8', 'ru'], ['rus', 'ru'],
    ['Chinese', 'zh'], ['中文', 'zh'], ['zh-CN', 'zh'], ['español', 'es'], ['es_MX.UTF-8', 'es'],
    ['pt_BR', 'pt'], ['Portuguese', 'pt'], ['japanese', 'ja'], ['日本語', 'ja'], ['jp', 'ja'],
    ['Deutsch', 'de'], ['de_DE.UTF-8', 'de'], ['français', 'fr'], ['한국어', 'ko'], ['ko_KR', 'ko'],
    ['english', 'en'], ['en_US.UTF-8', 'en'], ['italian', 'en'], ['it_IT', 'en'],
    ['', undefined], ['C', undefined], ['C.UTF-8', undefined], ['POSIX', undefined],
  ]
  for (const [value, want] of cases) expect([value, langOf(value)]).toEqual([value, want])
})

test('a language option the mod has wins over the settings', { options: { language: 'ja' } }, async ($, on) => {
  const { clock } = fakeEngine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(10, 68))
  clock.now += 40 * 60_000
  await $.session.measure(measure(30, 72))

  const ui = await $.ui.mount(pane('desktop'))
  const line = await ui.find({ type: 'Text', text: /ペース/ })
  expect(line?.text).toMatch(/^週 72% · リセット 10\/28/)
  await ui.unmount()
})

test('a window that runs out on a later day says which day', async ($, on) => {
  const { clock } = fakeEngine(on, '')
  const far = (week: number) => ({
    context: { contextWindowSize: 400000 } as never,
    rateLimits: [{ kind: 'seven_day', percentUsed: week, resetsAt: '2026-11-04T04:00:00Z' }],
    changed: ['rateLimits' as const],
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(far(10))
  clock.now += 3 * 3_600_000
  await $.session.measure(far(16))

  const ui = await $.ui.mount(pane('desktop'))
  const line = await ui.find({ type: 'Text', text: /runs out/ })
  // 16% at 2 %/h fills in 42 hours: two days on, not today.
  expect(line?.text).toMatch(/runs out ~10\/30 \d\d:\d\d/)
  await ui.unmount()
})

test('the sessions tab weighs rows by their share and flags what to act on', async ($, on) => {
  const { files, clock } = fakeEngine(on, '')
  const hour = String(Math.floor(T0 / 3_600_000) * 3_600_000)
  const session = (id: string, cwd: string, tok: number[], agentTok: number[]) => ({
    id, cwd, first: T0, last: T0, turns: 3, tok, agentTok, agentTurns: 1, models: {}, tools: {},
    hours: { [hour]: tok.map((v, i) => v + agentTok[i]) }, src: 'live',
  })
  // big: 80% of the spend, mostly subagents; leaky: a cache that misses; tiny: under 3%.
  files.set(`${ROOT}/sessions/big.json`, JSON.stringify(session('big', 'D:/w/big', [0, 1000, 1_000_000, 0], [0, 15000, 9_000_000, 0])))
  files.set(`${ROOT}/sessions/leaky.json`, JSON.stringify(session('leaky', 'D:/w/leaky', [20000, 1000, 10000, 0], [0, 0, 0, 0])))
  files.set(`${ROOT}/sessions/tiny.json`, JSON.stringify(session('tiny', 'D:/w/tiny', [0, 200, 10000, 0], [0, 0, 0, 0])))
  clock.now += 30 * 60_000

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'vs' })
  const big = await ui.find({ type: 'Text', text: /^big \d+%$/ })
  expect(big?.props.weight).toBe('bold')
  const flag = await ui.find({ type: 'Text', text: /^ agents \d+%$/ })
  expect(flag?.props.color).toBe('warning')
  const leaky = await ui.find({ type: 'Text', text: /^ cache \d+%$/ })
  expect(leaky?.props.color).toBe('warning')
  const tiny = await ui.find({ type: 'Text', text: /^tiny/ })
  expect(tiny?.props.dimColor).toBe(true)
  const top = await ui.find({ type: 'Text', text: /subagents/ })
  expect(top?.text).toMatch(/peak hour/)
  await ui.unmount()
})
