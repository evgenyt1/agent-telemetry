// Tests for codex/hooks/agent-telemetry.sh: run it as Codex would, with a hook's JSON on stdin and
// a session log written here, and read the file it leaves. Run: node --test codex/test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'agent-telemetry.sh')

const META = {
  timestamp: '2026-11-15T15:50:58.412Z',
  type: 'session_meta',
  payload: { id: 's1', timestamp: '2026-11-15T15:50:58.412Z', cli_version: '0.167.0', cwd: '/w', base_instructions: 'Be helpful. "quoted"' },
}
const TURN = (effort) => ({
  timestamp: '2026-11-15T15:51:00.000Z',
  type: 'turn_context',
  payload: { cwd: '/w', model: 'gpt-6.1-sol', ...(effort ? { effort } : {}), collaboration_mode: { settings: { reasoning_effort: null } } },
})
const COUNT = {
  timestamp: '2026-11-15T15:51:03.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 99999, cached_input_tokens: 1, output_tokens: 5, total_tokens: 100004 },
      last_token_usage: { input_tokens: 14662, cached_input_tokens: 14000, output_tokens: 39, total_tokens: 14701 },
      model_context_window: 475000,
    },
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1794772800 },
      secondary: { used_percent: 41.0, window_minutes: 10080, resets_at: 1795334967 },
    },
  },
}

function setup({ lines = [META, TURN('low'), COUNT], config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-telemetry-'))
  const dir = join(root, 'out')
  const rollout = join(root, 'rollout.jsonl')
  writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const codexHome = join(root, 'codex')
  mkdirSync(codexHome)
  if (config) writeFileSync(join(codexHome, 'config.toml'), config)
  return { root, dir, rollout, codexHome, file: join(dir, 'codex-s1.json') }
}

function run(w, event, input = {}, env = {}) {
  const payload = { session_id: 's1', transcript_path: w.rollout, cwd: '/w', model: 'gpt-6.1-sol', hook_event_name: 'X', ...input }
  const r = spawnSync(process.env.TEST_SH || 'sh', [SCRIPT, event], {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME: w.root, AGENT_TELEMETRY_DIR: w.dir, CODEX_HOME: w.codexHome, ...env },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '', 'a hook prints nothing')
  return r
}

const read = (w) => JSON.parse(readFileSync(w.file, 'utf8'))

test('stop writes the whole record from the session log', () => {
  const w = setup()
  run(w, 'stop', {}, { HC_TERMINAL_ID: 't7', TMUX_PANE: '%3' })
  const r = read(w)
  // A pid appears only when a codex process is up the tree (as when this suite runs inside Codex).
  assert.deepEqual(Object.keys(r).filter((k) => k !== 'pid'), ['v', 'agent', 'agentVersion', 'session', 'cwd', 'terminal', 'model', 'effort', 'state', 'context', 'limits', 'startedAt', 'updatedAt'])
  assert.equal(r.v, 1)
  assert.equal(r.agent, 'codex')
  assert.equal(r.agentVersion, '0.167.0')
  assert.equal(r.session, 's1')
  assert.deepEqual(r.terminal, { hc: 't7', tmux: '%3' })
  assert.equal(r.model, 'gpt-6.1-sol')
  assert.equal(r.effort, 'low')
  assert.equal(r.state, 'idle')
  assert.deepEqual(r.context, { used: 14662, window: 475000, percent: 3 })
  assert.deepEqual(r.limits, [
    { kind: 'five_hour', percent: 12.5, resetsAt: '2026-11-15T20:00:00Z' },
    { kind: 'seven_day', percent: 41.0, resetsAt: '2026-11-22T08:09:27Z' },
  ])
  assert.equal(r.startedAt, '2026-11-15T15:50:58Z')
  assert.match(r.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  assert.deepEqual(readdirSync(w.dir), ['codex-s1.json'], 'no temp file left')
})

test('prompt and tool mark the turn working, stop idle, compact keeps the state', () => {
  const w = setup()
  run(w, 'prompt')
  assert.equal(read(w).state, 'working')
  run(w, 'tool')
  assert.equal(read(w).state, 'working')
  run(w, 'compact')
  assert.equal(read(w).state, 'working')
  run(w, 'stop')
  assert.equal(read(w).state, 'idle')
  run(w, 'compact')
  assert.equal(read(w).state, 'idle')
})

test('end removes the file', () => {
  const w = setup()
  run(w, 'start')
  assert.ok(existsSync(w.file))
  run(w, 'end')
  assert.ok(!existsSync(w.file))
})

test('a resumed session replaces another live owner', () => {
  const w = setup()
  const fakeBin = join(w.root, 'bin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'ps'), '#!/bin/sh\nprintf "codex\\n"\n', { mode: 0o755 })
  const env = { PATH: `${fakeBin}:${process.env.PATH}` }
  run(w, 'start', {}, env)
  const initial = read(w)
  assert.equal(initial.pid, process.pid)

  writeFileSync(w.file, JSON.stringify({ ...initial, pid: process.ppid }, null, 2))
  run(w, 'end', {}, env)
  assert.equal(read(w).pid, process.ppid)
  run(w, 'start', {}, env)
  assert.equal(read(w).pid, process.pid)
})

test('the same figures do not rewrite the file', () => {
  const w = setup()
  run(w, 'stop')
  const marked = readFileSync(w.file, 'utf8').replace(/"updatedAt": "[^"]*"/, '"updatedAt": "MARK"')
  writeFileSync(w.file, marked)
  run(w, 'stop')
  assert.equal(read(w).updatedAt, 'MARK')
  run(w, 'prompt')
  assert.notEqual(read(w).updatedAt, 'MARK')
})

test('effort: a turn context without one means the configured default, or none', () => {
  const w = setup({ lines: [META, TURN(), COUNT], config: 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n\n[tui]\nmodel_reasoning_effort = "low"\n' })
  run(w, 'stop')
  assert.equal(read(w).effort, 'high')

  const v = setup({ lines: [META, TURN(), COUNT] })
  run(v, 'stop')
  assert.equal(read(v).effort, undefined)
})

test('effort: an earlier one does not outlive a turn context without one', () => {
  const w = setup()
  run(w, 'stop')
  assert.equal(read(w).effort, 'low')
  writeFileSync(w.rollout, [META, TURN('low'), COUNT, TURN(), COUNT].map((l) => JSON.stringify(l)).join('\n') + '\n')
  run(w, 'stop')
  assert.equal(read(w).effort, undefined)
})

test('effort: with no turn context in reach, the known one is kept', () => {
  const w = setup()
  run(w, 'stop')
  writeFileSync(w.rollout, [META, COUNT].map((l) => JSON.stringify(l)).join('\n') + '\n')
  run(w, 'prompt')
  assert.equal(read(w).effort, 'low')
})

const limitsOf = (primary, secondary = null) => ({ ...COUNT, payload: { ...COUNT.payload, rate_limits: { primary, secondary } } })

test('limits: a window without minutes or without a percent is left out; a tiny percent stays', () => {
  const w = setup({ lines: [META, TURN('low'), limitsOf({ used_percent: 12.5, window_minutes: null, resets_at: null }, { window_minutes: 10080, resets_at: 1795334967 })] })
  run(w, 'stop')
  assert.equal(read(w).limits, undefined)

  const t = setup({ lines: [META, TURN('low'), limitsOf({ used_percent: 1e-7, window_minutes: 300, resets_at: null })] })
  run(t, 'stop')
  assert.deepEqual(read(t).limits, [{ kind: 'five_hour', percent: 1e-7 }])
})

test('limits: another window length is named in minutes', () => {
  const w = setup({ lines: [META, TURN('low'), limitsOf({ used_percent: 3, window_minutes: 60, resets_at: 1794772800 })] })
  run(w, 'stop')
  assert.deepEqual(read(w).limits, [{ kind: '60m', percent: 3, resetsAt: '2026-11-15T20:00:00Z' }])
})

const usageOf = (used, window) => ({
  ...COUNT,
  payload: { ...COUNT.payload, info: { ...COUNT.payload.info, last_token_usage: { input_tokens: used }, model_context_window: window } },
})

test('context: past the window shows 100, a zero window no percent, and the file stays JSON', () => {
  const w = setup({ lines: [META, TURN('low'), usageOf(500000, 475000)] })
  run(w, 'stop')
  assert.deepEqual(read(w).context, { used: 500000, window: 475000, percent: 100 })

  const z = setup({ lines: [META, TURN('low'), usageOf(100, 0)] })
  run(z, 'stop')
  assert.equal(read(z).context, undefined)
})

test('a huge last line (a pasted image) keeps the known context and limits', () => {
  const w = setup()
  run(w, 'stop')
  const known = read(w)
  const image = { type: 'response_item', payload: { type: 'message', content: [{ type: 'input_image', image_url: 'data:' + 'A'.repeat(400000) }] } }
  writeFileSync(w.rollout, [META, TURN('low'), COUNT, image].map((l) => JSON.stringify(l)).join('\n') + '\n')
  run(w, 'prompt')
  const r = read(w)
  assert.equal(r.state, 'working')
  assert.deepEqual(r.context, known.context)
  assert.deepEqual(r.limits, known.limits)
})

test('a subagent hook leaves the session file alone', () => {
  const w = setup()
  run(w, 'prompt')
  run(w, 'stop', { agent_id: 'sub-1' })
  assert.equal(read(w).state, 'working')
})

test('control characters in a terminal id are dropped', () => {
  const w = setup()
  run(w, 'stop', {}, { TMUX_PANE: '%1\tx' })
  assert.deepEqual(read(w).terminal, { tmux: '%1x' })
})

test('spaces around the colon in the hook input', () => {
  const w = setup()
  const r = spawnSync(process.env.TEST_SH || 'sh', [SCRIPT, 'stop'], {
    input: `{ "session_id" : "s1", "transcript_path" : ${JSON.stringify(w.rollout)}, "cwd" : "/w", "model" : "m" }`,
    env: { PATH: process.env.PATH, HOME: w.root, AGENT_TELEMETRY_DIR: w.dir, CODEX_HOME: w.codexHome },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0)
  assert.equal(read(w).model, 'm')
})

test('strings with quotes, backslashes and spaces come through whole', () => {
  const w = setup()
  const odd = join(w.root, 'a dir "q"')
  mkdirSync(odd)
  const rollout = join(odd, 'roll\\out.jsonl')
  writeFileSync(rollout, readFileSync(w.rollout))
  run(w, 'stop', { cwd: '/a\\b "q" ü', transcript_path: rollout })
  const r = read(w)
  assert.equal(r.cwd, '/a\\b "q" ü')
  assert.equal(r.agentVersion, '0.167.0', 'the rollout behind the escaped path was read')
})

test('a tool event keeps the session cwd and model, whatever the tool arguments say', () => {
  const w = setup()
  run(w, 'prompt')
  const r = spawnSync(process.env.TEST_SH || 'sh', [SCRIPT, 'tool'], {
    input: `{"session_id":"s1","transcript_path":${JSON.stringify(w.rollout)},"hook_event_name":"PostToolUse","tool_input":{"cwd":"/tmp","model":"other"},"cwd":"/w","model":"gpt-6.1-sol","tool_response":"${'x'.repeat(20000)}"}`,
    env: { PATH: process.env.PATH, HOME: w.root, AGENT_TELEMETRY_DIR: w.dir, CODEX_HOME: w.codexHome },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  const rec = read(w)
  assert.equal(rec.cwd, '/w')
  assert.equal(rec.model, 'gpt-6.1-sol')
  assert.equal(rec.state, 'working')
})

test('without a log: the hook input alone', () => {
  const w = setup()
  run(w, 'start', { transcript_path: null })
  const r = read(w)
  assert.equal(r.session, 's1')
  assert.equal(r.model, 'gpt-6.1-sol')
  assert.equal(r.state, 'idle')
  assert.equal(r.context, undefined)
  assert.equal(r.limits, undefined)
  assert.match(r.startedAt, /Z$/)
})

test('before the first response: no context figures', () => {
  const w = setup({ lines: [META, TURN('low'), { type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } }] })
  run(w, 'start')
  const r = read(w)
  assert.equal(r.context, undefined)
  assert.equal(r.limits, undefined)
})

test('no session id: nothing written', () => {
  const w = setup()
  run(w, 'stop', { session_id: undefined })
  assert.ok(!existsSync(w.dir) || readdirSync(w.dir).length === 0)
})

test('session ids are kept safe in the file name', () => {
  const w = setup()
  run(w, 'stop', { session_id: '../x y' })
  assert.deepEqual(readdirSync(w.dir), ['codex-.._x_y.json'])
})
