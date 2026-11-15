import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// The hooks below stand for the engine and the machine: a file system in memory, a process
// runner that knows sh, ps, mv and rm, and the session's own answers.

const DIR = '/home/me/.cache/agent-telemetry'
const FILE = `${DIR}/claude-s1.json`

type Usage = {
  startedAt: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

type World = {
  files: Map<string, string>
  env: Record<string, string>
  session: string
  usage: Usage
  now: number
  // What the shell started by the plugin reports: its parent's pid and that parent's command.
  shell: string
  // The pids ps reports as alive.
  alive: number[]
  writes: string[]
}

function world(): World {
  const files = new Map<string, string>()
  files.set('/home/me/.claude/sessions/4242.json', JSON.stringify({ pid: 4242, sessionId: 's1' }))
  files.set('/home/me/.claude/sessions/7.json', JSON.stringify({ pid: 7, sessionId: 'other' }))
  return {
    files,
    env: { HOME: '/home/me', HC_TERMINAL_ID: 't24' },
    session: 's1',
    usage: { startedAt: Date.UTC(2026, 10, 15, 15, 12, 19), context: { window: 1000000 }, rateLimits: [] },
    now: Date.UTC(2026, 10, 15, 15, 40, 2),
    shell: '999\nnode\n',
    alive: [4242, 7],
    writes: [],
  }
}

const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

function engine(on: On, w: World) {
  let mtime = 0
  on('env.get', (_, e) => ({ value: w.env[e.name] }))
  on('session.version', () => ({ value: { version: '2.1.325' } }))
  on('session.id', () => ({ value: w.session }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'opus' }))
  on('session.usage', () => ({ value: w.usage }))
  on('clock.now', () => ({ value: w.now }))
  on('fs.list', (_, e) => ({
    value: [...w.files.keys()]
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: (mtime += 1), isLink: false })),
  }))
  on('fs.read', (_, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.exists', (_, e) => ({ value: w.files.has(e.path) }))
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    w.writes.push(e.path)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'mv') {
      const [, from, to] = args
      const text = w.files.get(from!)
      if (text === undefined) return { value: { ...OK, exitCode: 1 } }
      w.files.delete(from!)
      w.files.set(to!, text)
    } else if (cmd === 'rm') {
      w.files.delete(args[1]!)
    } else if (cmd === '/bin/sh') {
      return { value: { ...OK, stdout: w.shell } }
    } else if (cmd === 'ps') {
      const asked = (args[3] ?? '').split(',').map(Number)
      return { value: { ...OK, stdout: asked.filter(p => w.alive.includes(p)).map(p => `${p}\n`).join('') } }
    }
    return { value: OK }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
}

const read = (w: World, path = FILE) => JSON.parse(w.files.get(path) ?? 'null')
const temps = (w: World) => [...w.files.keys()].filter(p => p.endsWith('.tmp'))
const START = { cwd: '/work/app', surface: 'terminal', isInteractive: true } as const
const MEASURE = { context: { window: 1000000 }, rateLimits: [], changed: ['context' as const] }
const DONE = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const

test('session start writes the file through a temp file, never in place', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)

  expect(read(w)).toEqual({
    v: 1,
    agent: 'claude',
    agentVersion: '2.1.325',
    session: 's1',
    pid: 4242,
    cwd: '/work/app',
    terminal: { hc: 't24' },
    model: 'opus',
    state: 'idle',
    context: { window: 1000000 },
    startedAt: '2026-11-15T15:12:19Z',
    updatedAt: '2026-11-15T15:40:02Z',
  })
  expect(w.writes.length).toBeGreaterThan(0)
  expect(w.writes.every(p => /\/\.claude-s1\.json\.[0-9a-f]{8}\.tmp$/.test(p))).toBe(true)
  expect(temps(w)).toEqual([])
})

test('a measurement writes the session figures; the same figures write nothing', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  w.usage = {
    ...w.usage,
    context: { tokens: 68224, window: 1000000, percent: 7 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-15T20:00:00Z' }],
    cost: { usd: 4.12 },
  }
  await $.session.measure(MEASURE)

  const record = read(w)
  expect(record.context).toEqual({ used: 68224, window: 1000000, percent: 7 })
  expect(record.limits).toEqual([{ kind: 'five_hour', percent: 23.5, resetsAt: '2026-11-15T20:00:00Z' }])
  expect(record.cost).toEqual({ usd: 4.12 })

  const before = w.writes.length
  w.now += 5000
  await $.session.measure(MEASURE)
  expect(w.writes.length).toBe(before)
})

test('a file a reader deleted is written again', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  w.files.delete(FILE)
  await $.session.measure(MEASURE)
  expect(read(w).session).toBe('s1')
})

test('a turn shows as working, then idle; a subagent turn changes nothing', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)

  await $.turn.start({ text: 'hi', turnId: 'u1' })
  expect(read(w).state).toBe('working')

  await $.turn.complete({ ...DONE, turnId: 'u1' })
  expect(read(w).state).toBe('idle')

  const before = w.writes.length
  await $.turn.start({ text: '', turnId: 'u2', agentId: 'a1' })
  expect(w.writes.length).toBe(before)
  expect(read(w).state).toBe('idle')
})

test('the pid is the shell parent when that parent is claude', async ($, on) => {
  const w = world()
  w.shell = '999\n/usr/local/bin/claude\n'
  engine(on, w)
  await $.session.start(START)
  expect(read(w).pid).toBe(999)
})

test('else the newest live registry entry for the session', async ($, on) => {
  const w = world()
  w.files.set('/home/me/.claude/sessions/5000.json', JSON.stringify({ pid: 5000, sessionId: 's1' }))
  w.files.set('/home/me/.claude/sessions/broken.json', '{')
  w.files.set('/home/me/.claude/sessions/6000.json', '{"sessionId": "s1"')
  w.alive = [4242]
  engine(on, w)
  await $.session.start(START)
  expect(read(w).pid).toBe(4242)
})

test('no dead pid: when ps finds none of the entries alive, no pid', async ($, on) => {
  const w = world()
  w.alive = []
  engine(on, w)
  await $.session.start(START)
  expect(read(w).pid).toBeUndefined()
})

test('a missed pid is looked for again after a while', async ($, on) => {
  const w = world()
  w.session = 'late'
  engine(on, w)
  await $.session.start(START)
  expect(read(w, `${DIR}/claude-late.json`).pid).toBeUndefined()

  w.files.set('/home/me/.claude/sessions/8080.json', JSON.stringify({ pid: 8080, sessionId: 'late' }))
  w.alive.push(8080)
  w.now += 1000
  await $.session.measure(MEASURE)
  expect(read(w, `${DIR}/claude-late.json`).pid).toBeUndefined()

  w.now += 30000
  await $.session.measure(MEASURE)
  expect(read(w, `${DIR}/claude-late.json`).pid).toBe(8080)
})

test('the registry follows CLAUDE_CONFIG_DIR', async ($, on) => {
  const w = world()
  w.env.CLAUDE_CONFIG_DIR = '/home/me/.claude-work/'
  w.files.set('/home/me/.claude-work/sessions/3131.json', JSON.stringify({ pid: 3131, sessionId: 's1' }))
  w.alive = [3131, 4242]
  engine(on, w)
  await $.session.start(START)
  expect(read(w).pid).toBe(3131)
})

test('no pid when nothing names one', async ($, on) => {
  const w = world()
  w.session = 'fresh'
  engine(on, w)
  await $.session.start(START)
  expect(read(w, `${DIR}/claude-fresh.json`).pid).toBeUndefined()
})

test('AGENT_TELEMETRY_DIR moves the folder', async ($, on) => {
  const w = world()
  w.env.AGENT_TELEMETRY_DIR = '/tmp/t'
  engine(on, w)
  await $.session.start(START)
  expect(read(w, '/tmp/t/claude-s1.json').session).toBe('s1')
  expect(w.files.has(FILE)).toBe(false)
})

test('session end removes the file', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  expect(w.files.has(FILE)).toBe(true)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } as never })
  expect(w.files.has(FILE)).toBe(false)
})

// The test engine dispatches events one at a time, so the two tests below check the outcome of
// events sent together, not an overlap of writes; the queue that orders overlapping writes in a
// live session is not exercised here.

test('a measurement sent with the end leaves no file', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  w.usage = { ...w.usage, context: { tokens: 10, window: 1000000, percent: 0 } }

  const measuring = $.session.measure(MEASURE)
  const ending = $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } as never })
  await Promise.all([measuring, ending])

  expect(w.files.has(FILE)).toBe(false)
  expect(temps(w)).toEqual([])
})

test('the end leaves a file another process of the session wrote last', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  w.files.set(FILE, JSON.stringify({ v: 1, agent: 'claude', session: 's1', pid: 5555 }))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } as never })
  expect(read(w).pid).toBe(5555)
})

test('back to a session after /clear: it is written again', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  w.session = 's2'
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } as never })
  w.session = 's1'
  await $.session.end({ reason: 'resume', sessionId: 's2', resume: { id: 's2' } as never })

  expect(w.files.has(`${DIR}/claude-s2.json`)).toBe(false)
  expect(read(w).session).toBe('s1')
})

test('after /clear the new session gets its file at once, without the old one', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  w.session = 's2'
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } as never })

  expect(w.files.has(FILE)).toBe(false)
  expect(read(w, `${DIR}/claude-s2.json`).state).toBe('idle')
})

test('a turn start sent with its end leaves the idle state on disk', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)
  const starting = $.turn.start({ text: 'hi', turnId: 'u1' })
  const completing = $.turn.complete({ ...DONE, turnId: 'u1' })
  await Promise.all([starting, completing])

  expect(read(w).state).toBe('idle')
})
