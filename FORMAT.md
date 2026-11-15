# The telemetry file, format v1

Each live agent session keeps one JSON file describing itself. Readers (a terminal UI, a status bar,
a script) list the folder and read the files; nothing else is needed to find a session.

## Where

```
$AGENT_TELEMETRY_DIR                      if set
$XDG_CACHE_HOME/agent-telemetry           else, if XDG_CACHE_HOME is set
~/.cache/agent-telemetry                  else
```

One file per session: `<agent>-<session>.json`, for example `claude-0b7c…e1.json` or
`codex-01a1…95.json`.

## How it is written

- **Whole.** A writer writes a temporary file in the same folder and renames it over the old one,
  so a reader never sees half a file. Temporary files start with `.` and end in `.tmp`; readers
  skip them.
- **When.** At session start, when a turn starts and ends, and when the context, limits or cost
  move. A file is not rewritten while nothing changes, so `updatedAt` is the last change, not a
  heartbeat.
- **Removal.** A writer removes its file when its session ends cleanly. A session that crashed
  leaves it behind: a reader treats a file whose `pid` is not a live process as ended and may
  delete it.

## Fields

```json
{
  "v": 1,
  "agent": "claude",
  "agentVersion": "2.1.325",
  "session": "0b7c2f3e-…",
  "pid": 97127,
  "cwd": "/home/me/src/app",
  "terminal": { "hc": "t24" },
  "model": "claude-opus-5-5",
  "effort": "high",
  "state": "working",
  "context": { "used": 68224, "window": 1000000, "percent": 7 },
  "limits": [
    { "kind": "five_hour", "percent": 23.5, "resetsAt": "2026-11-15T20:00:00Z" },
    { "kind": "seven_day", "percent": 41, "resetsAt": "2026-11-20T09:00:00Z" }
  ],
  "cost": { "usd": 4.12 },
  "startedAt": "2026-11-15T15:12:19Z",
  "updatedAt": "2026-11-15T15:40:02Z"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | Format version, `1`. A reader skips files of a version it does not know. |
| `agent` | string | `claude` or `codex`; other writers pick their own lowercase name. |
| `agentVersion` | string? | The agent program's version, when the writer can read it. |
| `session` | string | The agent's own session id (what its resume takes). |
| `pid` | number? | The agent's process id; absent while the writer cannot find it. A reader matches a file to a process by it, and treats a file without one as live until `updatedAt` is old. |
| `cwd` | string | The session's working folder, absolute. |
| `terminal` | object? | Ids of the terminal the agent runs in, keyed by kind, from the environment: `hc` (`HC_TERMINAL_ID`), `tmux` (`TMUX_PANE`), `wezterm` (`WEZTERM_PANE`), `kitty` (`KITTY_WINDOW_ID`), `zellij` (`ZELLIJ_PANE_ID`), `iterm` (`ITERM_SESSION_ID`). Only the ones set. |
| `model` | string? | The model of the main conversation's last request; before the first request, the session's model as the agent names it (it may be an alias, such as `opus`). |
| `effort` | string \| number? | Its reasoning effort (`low` … `max`, or a number), when the model takes one. |
| `state` | string? | `working` while a turn runs, `idle` after it ends. |
| `context` | object? | `used`: input tokens of the last request (uncached, cache-written and cache-read together); `window`: the model's context window in tokens; `percent`: `used` over `window`, a whole number 0–100 (100 when `used` is past the window). `used` and `percent` are absent before the first response. |
| `limits` | array? | Usage-limit windows the last response reported: `kind` (`five_hour`, `seven_day`, `spend_limit`, or `<n>m` for another window length in minutes), `percent` used (0–100, past 100 on an exceeded spend limit), `resetsAt` (ISO 8601). Empty or absent when there is no reading. |
| `cost` | object? | `usd`: what the session has cost so far, where the agent keeps a ledger. |
| `startedAt` | string | When the session started, ISO 8601 UTC. |
| `updatedAt` | string | When the file was last written, ISO 8601 UTC. |

A field marked `?` may be absent; a reader shows nothing for it. Writers add no other fields
without a new version; a reader ignores fields it does not know.

## Compatibility

A change that removes or redefines a field raises `v`. Adding an optional field keeps `v` and is
listed here.
