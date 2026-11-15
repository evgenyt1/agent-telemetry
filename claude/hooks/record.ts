// The telemetry file's contents (FORMAT.md, v1), built from plain values. No engine calls here.

export const FORMAT_VERSION = 1

export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Context = { used?: number; window: number; percent?: number }

export type Snapshot = {
  agent: string
  agentVersion?: string
  session: string
  pid?: number
  cwd: string
  terminal?: Record<string, string>
  model?: string
  effort?: string | number
  state?: 'working' | 'idle'
  context?: Context
  limits?: Limit[]
  cost?: { usd: number }
  startedAt: number
  updatedAt: number
}

/** The environment variables that name the terminal an agent runs in, by kind. */
export const TERMINAL_VARIABLES = {
  hc: 'HC_TERMINAL_ID',
  tmux: 'TMUX_PANE',
  wezterm: 'WEZTERM_PANE',
  kitty: 'KITTY_WINDOW_ID',
  zellij: 'ZELLIJ_PANE_ID',
  iterm: 'ITERM_SESSION_ID',
} as const

export type TerminalKind = keyof typeof TERMINAL_VARIABLES

/** The terminal ids that are set, or undefined when none is. */
export function terminalIds(
  values: Partial<Record<TerminalKind, string | undefined>>,
): Record<string, string> | undefined {
  const ids: Record<string, string> = {}
  for (const kind of Object.keys(TERMINAL_VARIABLES) as TerminalKind[]) {
    const value = values[kind]
    if (value) ids[kind] = value
  }
  return Object.keys(ids).length > 0 ? ids : undefined
}

/** The folder the files live in: AGENT_TELEMETRY_DIR, else $XDG_CACHE_HOME/agent-telemetry, else ~/.cache/agent-telemetry. */
export function telemetryDir(env: {
  AGENT_TELEMETRY_DIR?: string
  XDG_CACHE_HOME?: string
  HOME?: string
}): string | undefined {
  const strip = (path: string) => path.replace(/\/+$/, '')
  if (env.AGENT_TELEMETRY_DIR) return strip(env.AGENT_TELEMETRY_DIR)
  if (env.XDG_CACHE_HOME) return `${strip(env.XDG_CACHE_HOME)}/agent-telemetry`
  if (env.HOME) return `${strip(env.HOME)}/.cache/agent-telemetry`
  return undefined
}

/** `<agent>-<session>.json`, the session id kept to characters safe in a file name. */
export function fileName(agent: string, session: string): string {
  return `${agent}-${session.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

/** The temporary name a whole write goes through before its rename. */
export function tempName(agent: string, session: string, nonce: string): string {
  return `.${fileName(agent, session)}.${nonce}.tmp`
}

/** The engine's rate-limit windows in the format's words. */
export function limitsFrom(
  windows: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): Limit[] {
  return windows.map(w => {
    const limit: Limit = { kind: w.kind, percent: w.percentUsed }
    if (w.resetsAt) limit.resetsAt = w.resetsAt
    return limit
  })
}

/** The engine's context figures in the format's words. */
export function contextFrom(c: { tokens?: number; window: number; percent?: number }): Context {
  const context: Context = c.tokens !== undefined ? { used: c.tokens, window: c.window } : { window: c.window }
  const percent =
    c.percent !== undefined ? c.percent : c.tokens !== undefined && c.window > 0 ? (c.tokens / c.window) * 100 : undefined
  if (percent !== undefined) context.percent = Math.min(100, Math.max(0, Math.round(percent)))
  return context
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The file's object, keys in the format's order, absent values left out. */
export function toRecord(s: Snapshot): Record<string, unknown> {
  const record: Record<string, unknown> = {
    v: FORMAT_VERSION,
    agent: s.agent,
    agentVersion: s.agentVersion,
    session: s.session,
    pid: s.pid,
    cwd: s.cwd,
    terminal: s.terminal,
    model: s.model,
    effort: s.effort,
    state: s.state,
    context: s.context,
    limits: s.limits && s.limits.length > 0 ? s.limits : undefined,
    cost: s.cost,
    startedAt: iso(s.startedAt),
    updatedAt: iso(s.updatedAt),
  }
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]
  return record
}

/** What decides whether a write is needed: the record without its write time. */
export function changeKey(record: Record<string, unknown>): string {
  const { updatedAt: _ignored, ...rest } = record
  return JSON.stringify(rest)
}
