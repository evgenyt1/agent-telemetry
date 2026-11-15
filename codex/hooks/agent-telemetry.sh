#!/bin/sh
# agent-telemetry for Codex: keeps one JSON file per session (FORMAT.md, v1).
#
# Codex runs this from its hooks with the event's JSON on stdin and the event's name as the first
# argument: start, prompt, tool, stop, compact, end. The figures come from the session's own log
# (the rollout file the hook input names): the last token count gives context and limits, the last
# turn context the effort, the first line the start time and the Codex version.
#
# POSIX sh, sed and awk only. It prints nothing and always exits 0: telemetry never gets in the
# session's way. String values are carried as JSON-escaped text from the JSON they come from to
# the file, never unescaped and escaped again.

event=${1:-}
# A tool event's input carries the tool's arguments and output after the session's own keys:
# only its head is read.
if [ "$event" = tool ]; then
  input=$(head -c 8192)
  cat >/dev/null
else
  input=$(cat)
fi

# The first "key": "value" string in a JSON text, as JSON-escaped text.
str() {
  printf '%s' "$2" | awk -v key="$1" '{
    if (match($0, "\"" key "\" *: *\"([^\"\\\\]|\\\\.)*\"")) {
      v = substr($0, RSTART, RLENGTH); sub(/^"[^"]*" *: *"/, "", v); sub(/"$/, "", v); print v; exit
    }
  }'
}

# JSON-escaped text → the plain string (for a path the script opens).
unescape() {
  printf '%s' "$1" | sed 's/\\\//\//g; s/\\"/"/g; s/\\\\/\\/g'
}

# A plain string → JSON-escaped text (for values from the environment).
esc() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

iso_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Seconds since the epoch → ISO 8601 UTC (GNU or BusyBox date, then BSD date).
iso_epoch() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
}

# The Codex process: the nearest ancestor named codex.
codex_pid() {
  p=$PPID
  i=0
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ "$i" -lt 10 ]; do
    comm=$(ps -o comm= -p "$p" 2>/dev/null)
    case "${comm##*/}" in
      codex | codex-*) printf '%s' "$p"; return ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
}

session=$(str session_id "$input")
[ -n "$session" ] || exit 0
# A subagent's hooks name its agent: the session's own state is not theirs to change.
[ -n "$(str agent_id "$input")" ] && exit 0

if [ -n "${AGENT_TELEMETRY_DIR:-}" ]; then
  dir=${AGENT_TELEMETRY_DIR%/}
elif [ -n "${XDG_CACHE_HOME:-}" ]; then
  dir=${XDG_CACHE_HOME%/}/agent-telemetry
elif [ -n "${HOME:-}" ]; then
  dir=${HOME%/}/.cache/agent-telemetry
else
  exit 0
fi

name=codex-$(unescape "$session" | sed 's/[^A-Za-z0-9._-]/_/g').json
file=$dir/$name

if [ "$event" = end ]; then
  rm -f "$file"
  exit 0
fi

previous=
[ -f "$file" ] && previous=$(cat "$file")

case $event in
  start | stop) state=idle ;;
  prompt | tool) state=working ;;
  *)
    state=$(str state "$previous")
    [ -n "$state" ] || state=idle
    ;;
esac

cwd=$(str cwd "$input")
model=$(str model "$input")
# A tool's arguments may name a cwd or a model of their own: keep the session's.
if [ "$event" = tool ] && [ -n "$previous" ]; then
  cwd=$(str cwd "$previous")
  model=$(str model "$previous")
fi
rollout=$(unescape "$(str transcript_path "$input")")

counted=
version=
started=
effort=
window=
used=
limits=
if [ -n "$rollout" ] && [ -f "$rollout" ]; then
  meta=$(head -n 1 "$rollout")
  version=$(str cli_version "$meta")
  started=$(str timestamp "$meta" | sed 's/\.[0-9]*Z$/Z/')
  # The log only grows; its last 256 KB hold the latest token count and, but in a very long turn,
  # the latest turn context.
  recent=$(tail -c 262144 "$rollout")
  context_line=$(printf '%s\n' "$recent" | grep '"type":"turn_context"' | tail -n 1)
  if [ -n "$context_line" ]; then
    effort=$(str effort "$context_line")
  else
    # No turn context in reach: the effort already known stands.
    effort=$(str effort "$previous")
    if [ -z "$effort" ] && [ -z "$previous" ] && [ "$event" != tool ]; then
      effort=$(grep '"type":"turn_context"' "$rollout" | tail -n 1 | awk '{
        if (match($0, "\"effort\": *\"[^\"]*\"")) { v = substr($0, RSTART, RLENGTH); sub(/^"effort": *"/, "", v); sub(/"$/, "", v); print v }
      }')
    fi
  fi
  # window|used, then one minutes|percent|resets line per limit window; numbers only.
  counts=$(printf '%s\n' "$recent" | grep '"type":"token_count"' | tail -n 1 | awk '
    function num(s, key,   m) {
      if (match(s, "\"" key "\": *-?[0-9][0-9.eE+-]*")) { m = substr(s, RSTART, RLENGTH); sub(/^"[^"]*": */, "", m); return m }
      return ""
    }
    function obj(s, key) {
      if (match(s, "\"" key "\": *\\{[^{}]*\\}")) return substr(s, RSTART, RLENGTH)
      return ""
    }
    {
      print num($0, "model_context_window") "|" num(obj($0, "last_token_usage"), "input_tokens")
      for (i = 1; i <= 2; i++) {
        o = obj($0, i == 1 ? "primary" : "secondary")
        if (o != "") print num(o, "window_minutes") "|" num(o, "used_percent") "|" num(o, "resets_at")
      }
    }')
  [ -n "$counts" ] && counted=yes
  first=$(printf '%s\n' "$counts" | sed -n 1p)
  window=${first%%|*}
  used=${first#*|}
  [ "$used" = "$first" ] && used=
  limits=$(printf '%s\n' "$counts" | sed -n '2,$p')
fi
# No effort in the log: the session runs at the configured default, if one is set.
if [ -z "$effort" ]; then
  config=${CODEX_HOME:-${HOME:-}/.codex}/config.toml
  [ -f "$config" ] && effort=$(sed -n '/^\[/q; s/^model_reasoning_effort *= *"\([a-z]*\)".*/\1/p' "$config" | head -n 1)
fi
[ -n "$started" ] || started=$(str startedAt "$previous")
[ -n "$started" ] || started=$(iso_now)

# The pid this session's file already names, while that process lives; else a walk up the tree.
pid=
if [ -n "$previous" ]; then
  pid=$(printf '%s\n' "$previous" | sed -n 's/^  "pid": \([0-9][0-9]*\),$/\1/p')
  [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && pid=
fi
[ -n "$pid" ] || pid=$(codex_pid)

terminal=
add_terminal() {
  set -- "$1" "$(printf '%s' "$2" | tr -d '\000-\037\177')"
  [ -n "$2" ] || return 0
  [ -n "$terminal" ] && terminal="$terminal, "
  terminal="$terminal\"$1\": \"$(esc "$2")\""
}
add_terminal hc "${HC_TERMINAL_ID:-}"
add_terminal tmux "${TMUX_PANE:-}"
add_terminal wezterm "${WEZTERM_PANE:-}"
add_terminal kitty "${KITTY_WINDOW_ID:-}"
add_terminal zellij "${ZELLIJ_PANE_ID:-}"
add_terminal iterm "${ITERM_SESSION_ID:-}"

# A JSON number as the format takes it: plain decimal, else nothing.
number() {
  printf '%s' "$1" | awk '/^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$/ { print }'
}

limits_json=
if [ -n "$limits" ]; then
  limits_json=$(printf '%s\n' "$limits" | while IFS='|' read -r minutes percent resets; do
    percent=$(number "$percent")
    [ -n "$percent" ] || continue
    case $(number "$minutes") in
      (300) kind=five_hour ;;
      (10080) kind=seven_day ;;
      ('') continue ;;
      (*) kind=${minutes}m ;;
    esac
    entry="{ \"kind\": \"$kind\", \"percent\": $percent"
    resets=$(number "$resets")
    if [ -n "$resets" ]; then
      at=$(iso_epoch "${resets%.*}")
      [ -n "$at" ] && entry="$entry, \"resetsAt\": \"$at\""
    fi
    printf '%s }\n' "$entry"
  done | awk 'NR > 1 { printf ", " } { printf "%s", $0 }')
fi

window=$(number "$window")
used=$(number "$used")
[ -n "$window" ] && [ "$(awk -v w="$window" 'BEGIN { print (w > 0) ? 1 : 0 }')" = 1 ] || window=
percent=
if [ -n "$used" ] && [ -n "$window" ]; then
  percent=$(awk -v u="$used" -v w="$window" 'BEGIN { if (w > 0) { p = int(u / w * 100 + 0.5); if (p > 100) p = 100; if (p < 0) p = 0; print p } }')
fi

# No token count in reach (a huge last line, a compaction): the figures already known stand.
known_context=$(printf '%s\n' "$previous" | sed -n 's/^  "context": \({.*}\),$/\1/p')
known_limits=$(printf '%s\n' "$previous" | sed -n 's/^  "limits": \(\[.*\]\),$/\1/p')

body() {
  printf '{\n  "v": 1,\n  "agent": "codex",\n'
  [ -n "$version" ] && printf '  "agentVersion": "%s",\n' "$version"
  printf '  "session": "%s",\n' "$session"
  [ -n "$pid" ] && printf '  "pid": %s,\n' "$pid"
  printf '  "cwd": "%s",\n' "$cwd"
  [ -n "$terminal" ] && printf '  "terminal": { %s },\n' "$terminal"
  [ -n "$model" ] && printf '  "model": "%s",\n' "$model"
  [ -n "$effort" ] && printf '  "effort": "%s",\n' "$effort"
  printf '  "state": "%s",\n' "$state"
  if [ -n "$window" ]; then
    if [ -n "$used" ] && [ -n "$percent" ]; then
      printf '  "context": { "used": %s, "window": %s, "percent": %s },\n' "$used" "$window" "$percent"
    else
      printf '  "context": { "window": %s },\n' "$window"
    fi
  elif [ -z "$counted" ] && [ -n "$known_context" ]; then
    printf '  "context": %s,\n' "$known_context"
  fi
  if [ -n "$limits_json" ]; then
    printf '  "limits": [%s],\n' "$limits_json"
  elif [ -z "$counted" ] && [ -n "$known_limits" ]; then
    printf '  "limits": %s,\n' "$known_limits"
  fi
  printf '  "startedAt": "%s",\n' "$started"
}

mkdir -p "$dir" 2>/dev/null || exit 0
next=$(body)
if [ -n "$previous" ] && [ "$(printf '%s\n' "$previous" | grep -v '"updatedAt"' | sed '$d')" = "$next" ]; then
  exit 0
fi
temp=$dir/.$name.$$.tmp
{
  printf '%s\n' "$next"
  printf '  "updatedAt": "%s"\n}\n' "$(iso_now)"
} >"$temp" 2>/dev/null && mv -f "$temp" "$file" 2>/dev/null
rm -f "$temp" 2>/dev/null
exit 0
