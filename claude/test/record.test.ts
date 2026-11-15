import { describe, expect, test } from 'claude-code/testing'
import {
  changeKey,
  contextFrom,
  fileName,
  limitsFrom,
  telemetryDir,
  tempName,
  terminalIds,
  toRecord,
} from '../hooks/record'

describe('telemetryDir', () => {
  test('AGENT_TELEMETRY_DIR wins, trailing slashes dropped', async () => {
    expect(telemetryDir({ AGENT_TELEMETRY_DIR: '/x/t/', XDG_CACHE_HOME: '/c', HOME: '/h' })).toBe('/x/t')
  })
  test('then XDG_CACHE_HOME', async () => {
    expect(telemetryDir({ XDG_CACHE_HOME: '/c/', HOME: '/h' })).toBe('/c/agent-telemetry')
  })
  test('then ~/.cache', async () => {
    expect(telemetryDir({ HOME: '/h' })).toBe('/h/.cache/agent-telemetry')
  })
  test('none without HOME', async () => {
    expect(telemetryDir({})).toBeUndefined()
  })
})

test('file names keep the session id safe', async () => {
  expect(fileName('claude', 'ab-12_c.d')).toBe('claude-ab-12_c.d.json')
  expect(fileName('claude', '../x y')).toBe('claude-.._x_y.json')
  expect(tempName('claude', 's1', '42')).toBe('.claude-s1.json.42.tmp')
})

test('terminal ids keep only what is set', async () => {
  expect(terminalIds({})).toBeUndefined()
  expect(terminalIds({ hc: 't24', tmux: '', kitty: undefined })).toEqual({ hc: 't24' })
  expect(terminalIds({ tmux: '%3', hc: 't1' })).toEqual({ hc: 't1', tmux: '%3' })
})

test('context: the engine percent rounded, else computed, absent before a response', async () => {
  expect(contextFrom({ tokens: 68224, window: 1000000, percent: 6.8 })).toEqual({ used: 68224, window: 1000000, percent: 7 })
  expect(contextFrom({ tokens: 50000, window: 200000 })).toEqual({ used: 50000, window: 200000, percent: 25 })
  expect(contextFrom({ window: 200000 })).toEqual({ window: 200000 })
  expect(contextFrom({ tokens: 250000, window: 200000 })).toEqual({ used: 250000, window: 200000, percent: 100 })
})

test('limits in the format words', async () => {
  expect(
    limitsFrom([
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-15T20:00:00Z' },
      { kind: 'seven_day', percentUsed: 41 },
    ]),
  ).toEqual([
    { kind: 'five_hour', percent: 23.5, resetsAt: '2026-11-15T20:00:00Z' },
    { kind: 'seven_day', percent: 41 },
  ])
})

test('a record has the format keys in order, absent values left out', async () => {
  const record = toRecord({
    agent: 'claude',
    session: 's1',
    pid: 42,
    cwd: '/w',
    state: 'idle',
    limits: [],
    startedAt: Date.UTC(2026, 10, 15, 15, 12, 19, 450),
    updatedAt: Date.UTC(2026, 10, 15, 15, 40, 2),
  })
  expect(Object.keys(record)).toEqual(['v', 'agent', 'session', 'pid', 'cwd', 'state', 'startedAt', 'updatedAt'])
  expect(record.v).toBe(1)
  expect(record.startedAt).toBe('2026-11-15T15:12:19Z')
  expect(record.updatedAt).toBe('2026-11-15T15:40:02Z')
})

test('the change key ignores the write time', async () => {
  const a = toRecord({ agent: 'claude', session: 's', cwd: '/', startedAt: 0, updatedAt: 1 })
  const b = toRecord({ agent: 'claude', session: 's', cwd: '/', startedAt: 0, updatedAt: 2 })
  const c = toRecord({ agent: 'claude', session: 's', cwd: '/', state: 'working', startedAt: 0, updatedAt: 2 })
  expect(changeKey(a)).toBe(changeKey(b))
  expect(changeKey(a)).not.toBe(changeKey(c))
})
