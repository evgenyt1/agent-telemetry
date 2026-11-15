# agent-telemetry

Every Claude Code and Codex session keeps a small JSON file describing itself: model, effort,
context use, usage limits, cost, and whether a turn is running. Any tool can read these files: a terminal
dashboard, a status bar, a window manager's sidebar, a script. Nothing leaves the machine; the
plugins only write local files.

The file format is in [FORMAT.md](FORMAT.md).

## Install for Claude Code

At the prompt of a Claude Code session:

```
/plugin install agent-telemetry --marketplace evgenyt1/agent-telemetry
```

Answer `y` to add the marketplace, then pick the user scope so every session gets it. From a shell
instead:

```
claude plugin marketplace add evgenyt1/agent-telemetry
claude plugin install agent-telemetry@agent-telemetry
```

It needs a Claude Code with function-hook plugins (2.1.325 or newer). It does not use or change
your status line, settings or hooks.

## Install for Codex

```
codex plugin marketplace add evgenyt1/agent-telemetry
codex plugin add agent-telemetry@agent-telemetry
```

Codex runs a plugin's hooks only after you approve them: open Codex, run `/hooks`, review the
agent-telemetry hooks and turn them on. Until then nothing is written. The hooks need only `sh`,
`sed` and `awk`.

A Codex file has the same fields, without `cost` (Codex keeps no cost ledger). Its figures come
from the session's own log (`~/.codex/sessions/…/rollout-*.jsonl`): the last token count gives
`context` (the last request's input tokens over the model's window) and `limits`, the last turn
context the `effort` (else `model_reasoning_effort` from `config.toml`). The hooks run on
`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop` and `PostCompact`, and remove the file
on `SessionEnd`.

## What you get

```
~/.cache/agent-telemetry/claude-<session>.json
~/.cache/agent-telemetry/codex-<session>.json
```

```json
{
  "v": 1,
  "agent": "claude",
  "session": "0b7c2f3e-…",
  "pid": 97127,
  "cwd": "/home/me/src/app",
  "terminal": { "tmux": "%3" },
  "model": "claude-opus-5-5",
  "effort": "high",
  "state": "idle",
  "context": { "used": 68224, "window": 1000000, "percent": 7 },
  "limits": [{ "kind": "seven_day", "percent": 24, "resetsAt": "2026-11-17T15:00:00.000Z" }],
  "cost": { "usd": 4.12 },
  "startedAt": "2026-11-15T15:12:19Z",
  "updatedAt": "2026-11-15T15:40:02Z"
}
```

The file is written at session start, when a turn starts and ends, when the figures move, and
during a long turn at most every five seconds; it is removed when the session ends. After `/clear` or a resume the
new session gets its own file at once. Set `AGENT_TELEMETRY_DIR` to use another folder
(`$XDG_CACHE_HOME/agent-telemetry` is used when that is set).

A quick look from a shell:

```sh
for f in ~/.cache/agent-telemetry/*.json; do
  jq -r '"\(.agent) \(.state) \(.model) \(.effort // "-") ctx \(.context.percent // "-")% \(.cwd)"' "$f"
done
```

## How it works

The repository is a plugin marketplace for both agents: `.claude-plugin/marketplace.json` lists
the Claude Code plugin in `claude/`, `.agents/plugins/marketplace.json` the Codex plugin in
`codex/`.

The Claude Code plugin is a function-hooks module (`claude/hooks/register.ts`). Each write reads
the session's figures from the engine (`$.session.usage()`: the same context, limits and cost the
status line gets). It writes on `session.start`, `turn.start`, `turn.complete`, `session.measure`
and, in a long turn, after a model response at most every five seconds (`turn.step`, which also
names the model and effort); it removes the file on `session.end`. Writes run one after another, each to a temporary file renamed over the
old one.

The Codex plugin is one POSIX shell script (`codex/hooks/agent-telemetry.sh`) that its hooks call
with the event's name; see "Install for Codex" above.

## Develop

```sh
claude plugin validate claude     # manifest and hooks module
claude plugin test claude         # tests in claude/test
node --test codex/test            # the Codex hook script (TEST_SH=dash to try another shell)
claude --plugin-dir ./claude      # a session with the working copy loaded
tsc -p claude                     # type-check, once a session has loaded the plugin
```

Loading the plugin makes Claude Code write its API types to `claude/.claude-plugin/types/`
(ignored by git), which `claude/tsconfig.json` extends.

## License

MIT
