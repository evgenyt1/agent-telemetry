// agent-telemetry for Claude Code: keeps one JSON file per session (FORMAT.md, v1).
//
// Every write reads the session's figures fresh from `$.session.usage()` (the status line's own
// context, limits and cost). Writes happen at session start, when a main-loop turn starts and
// ends, when the engine measures the session, and during a long turn after a model response at
// most every few seconds; `turn.step` also names the model and effort. Each write replaces the
// session's file whole (temp file, then rename); writes run one after another.

import type { EngineInterface, Register } from 'claude-code'
import { changeKey, contextFrom, fileName, limitsFrom, telemetryDir, tempName, terminalIds, toRecord } from './record'

type Engine = EngineInterface

// The least time between two writes from inside one turn, in milliseconds.
const STEP_WRITE_GAP = 5000
// The least time between two tries to find the Claude process when it was not found.
const PID_RETRY_GAP = 30000

type Base = {
  dir: string | undefined
  registry: string | undefined
  terminal: Record<string, string> | undefined
  agentVersion: string | undefined
  // Names this process's temp files, so two processes never share one.
  nonce: string
}

type State = {
  base?: Base
  pid?: number
  pidTriedAt?: number
  model?: string
  effort?: string | number
  state: 'working' | 'idle'
  written?: { path: string; key: string }
  lastWriteAt: number
  // Sessions that ended while this process goes on (/clear, a resume): writes for them stop until
  // the person comes back to one.
  ended: Set<string>
  queue: Promise<void>
}

async function prepare($: Engine, st: State): Promise<Base> {
  if (st.base) return st.base
  const home = await $.env.get('HOME')
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const dir = telemetryDir({
    AGENT_TELEMETRY_DIR: await $.env.get('AGENT_TELEMETRY_DIR'),
    XDG_CACHE_HOME: await $.env.get('XDG_CACHE_HOME'),
    HOME: home,
  })
  const terminal = terminalIds({
    hc: await $.env.get('HC_TERMINAL_ID'),
    tmux: await $.env.get('TMUX_PANE'),
    wezterm: await $.env.get('WEZTERM_PANE'),
    kitty: await $.env.get('KITTY_WINDOW_ID'),
    zellij: await $.env.get('ZELLIJ_PANE_ID'),
    iterm: await $.env.get('ITERM_SESSION_ID'),
  })
  let agentVersion: string | undefined
  try {
    agentVersion = (await $.session.version()).version
  } catch {
    agentVersion = undefined
  }
  const registry = config ? `${config.replace(/\/+$/, '')}/sessions` : home ? `${home}/.claude/sessions` : undefined
  st.base = { dir, registry, terminal, agentVersion, nonce: crypto.randomUUID().slice(0, 8) }
  return st.base
}

// The Claude process: the parent of a shell the engine starts, when that parent is Claude; else
// the newest live entry for this session in Claude's own registry (<config>/sessions/<pid>.json).
// Found once; a miss is tried again after a while (the registry entry may come later).
async function processId($: Engine, st: State, registry: string | undefined, session: string): Promise<number | undefined> {
  if (st.pid !== undefined) return st.pid
  const now = await $.clock.now()
  if (st.pidTriedAt !== undefined && now - st.pidTriedAt < PID_RETRY_GAP) return undefined
  st.pidTriedAt = now
  try {
    const run = await $.process.run(['/bin/sh', '-c', 'echo $PPID; ps -o comm= -p $PPID'])
    const [ppid, comm] = run.stdout.split('\n')
    const parsed = Number.parseInt(ppid ?? '', 10)
    if (run.exitCode === 0 && parsed > 1 && /(^|\/)claude$/.test((comm ?? '').trim())) st.pid = parsed
  } catch {
    // Look in the registry instead.
  }
  if (st.pid === undefined && registry) st.pid = await fromRegistry($, registry, session)
  return st.pid
}

async function fromRegistry($: Engine, folder: string, session: string): Promise<number | undefined> {
  let entries: { name: string; mtimeMs: number }[]
  try {
    entries = await $.fs.list(folder)
  } catch {
    return undefined
  }
  const candidates: { pid: number; mtimeMs: number }[] = []
  for (const entry of entries) {
    const match = /^(\d+)\.json$/.exec(entry.name)
    if (!match) continue
    try {
      const text = await $.fs.read(`${folder}/${entry.name}`)
      if (typeof text === 'string' && JSON.parse(text).sessionId === session) {
        candidates.push({ pid: Number(match[1]), mtimeMs: entry.mtimeMs })
      }
    } catch {
      // A registry file being rewritten: skip it.
    }
  }
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  try {
    const run = await $.process.run(['ps', '-o', 'pid=', '-p', candidates.map(c => c.pid).join(',')])
    const alive = new Set(run.stdout.split('\n').map(line => Number.parseInt(line.trim(), 10)))
    // ps ran: only a live entry counts.
    return candidates.find(c => alive.has(c.pid))?.pid
  } catch {
    // Without ps, the newest entry stands.
    return candidates[0]?.pid
  }
}

async function remove($: Engine, path: string): Promise<void> {
  try {
    await $.process.run(['rm', '-f', path])
  } catch {
    // A file left behind is read as ended once its process is gone.
  }
}

async function write($: Engine, st: State): Promise<void> {
  const b = await prepare($, st)
  if (!b.dir) return
  const session = await $.session.id()
  if (st.ended.has(session)) return
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const record = toRecord({
    agent: 'claude',
    agentVersion: b.agentVersion,
    session,
    pid: await processId($, st, b.registry, session),
    cwd: await $.session.cwd(),
    terminal: b.terminal,
    model: st.model ?? (await $.session.model()),
    effort: st.effort,
    state: st.state,
    context: usage.context ? contextFrom(usage.context) : undefined,
    limits: limitsFrom(usage.rateLimits ?? []),
    cost: usage.cost ? { usd: usage.cost.usd } : undefined,
    startedAt: usage.startedAt,
    updatedAt: now,
  })
  st.lastWriteAt = now
  const path = `${b.dir}/${fileName('claude', session)}`
  const key = changeKey(record)
  if (st.written && st.written.path === path && st.written.key === key && (await $.fs.exists(path))) return
  const temp = `${b.dir}/${tempName('claude', session, b.nonce)}`
  await $.fs.write(temp, `${JSON.stringify(record, null, 2)}\n`)
  // The session may have ended while this write ran: its file stays removed.
  const moved = st.ended.has(session) ? undefined : await $.process.run(['mv', '-f', temp, path])
  if (!moved || moved.exitCode !== 0) {
    await remove($, temp)
    return
  }
  if (st.written && st.written.path !== path) await remove($, st.written.path)
  st.written = { path, key }
}

// Runs one write after the ones before it; a failure never reaches the session.
async function save($: Engine, st: State): Promise<void> {
  const next = st.queue.then(() => write($, st)).catch(() => {
    // Telemetry never gets in the session's way.
  })
  st.queue = next
  await next
}

// The session's end, inside the engine's short limit for it: the file goes first, at once (unless
// another process of the same session wrote it last); after /clear or a resume, the session the
// process goes on with gets its file.
async function end($: Engine, st: State, session: string, reason: string): Promise<void> {
  st.ended.add(session)
  const b = await prepare($, st)
  if (b.dir) {
    const path = `${b.dir}/${fileName('claude', session)}`
    let owner: number | undefined
    try {
      const text = await $.fs.read(path)
      owner = typeof text === 'string' ? JSON.parse(text).pid : undefined
    } catch {
      owner = undefined
    }
    if (owner === undefined || st.pid === undefined || owner === st.pid) await remove($, path)
    if (st.written && st.written.path === path) st.written = undefined
  }
  if (reason === 'clear' || reason === 'resume') {
    const now = await $.session.id()
    if (now !== session) {
      st.ended.delete(now)
      st.state = 'idle'
      st.model = undefined
      st.effort = undefined
      await save($, st)
    }
  }
}

export const register: Register = on => {
  const st: State = { state: 'idle', lastWriteAt: 0, ended: new Set(), queue: Promise.resolve() }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await save($, st)
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      st.state = 'working'
      st.ended.delete(await $.session.id())
      await save($, st)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    st.model = e.model
    st.effort = e.effort
    const result = yield* next(e)
    // The response has its usage now; in a long turn, show the context as it grows.
    if ((await $.clock.now()) - st.lastWriteAt >= STEP_WRITE_GAP) await save($, st)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      st.state = 'idle'
      await save($, st)
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await save($, st)
    return result
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    try {
      await end($, st, e.sessionId, e.reason)
    } catch {
      // The session ends either way.
    }
    return result
  })
}
