#!/usr/bin/env bash
# Import Pi JSONL sessions into chrollo's memory store.
#
# Produces native-consistent files (bug-for-bug matching chrollo's local-time
# convention) so the recency/search machinery treats imports identically to
# live-captured sessions:
#   - filename:  YYYY-MM-DD_HHMMSS_<session-id-prefix>.md   (LOCAL TIME)
#   - YAML frontmatter (session_id, date, harness, cwd, parent_session)
#   - [YYYY-MM-DD HH:MM:SS] [User|Agent] line headers        (LOCAL TIME)
#   - agent text blockquoted with `>`
#
# Timestamps: read from JSONL as UTC ISO-8601, batch-converted to local via
# `date -f` (one process per session, not per message). This matches
# chrollo's native convention (storage.ts uses date.getHours() = local).
#
# Pipeline (keeps text as proper JSON throughout so newlines are preserved):
#   1. jq emits one JSON object: {sid, cwd, parent, start_iso, messages:[{role,iso,text}]}
#   2. ISOs extracted -> date -f converts all to local in ONE call
#   3. local times fed back into jq via --slurpfile
#   4. jq formats the final markdown (blockquotes, headers) at the very end
#
# Skips:
#   - non-message events (session, model_change, thinking_level_change, compaction, ...)
#   - toolResult messages (native chrollo has no such role)
#   - user/assistant messages whose visible text is empty or whitespace-only
#
# Dedup: by session-id prefix (first 8 hex of the UUID), checked BEFORE jq.
#
# Usage:
#   ./import-pi-sessions.sh [src_dir] [dest_dir]
#   ./import-pi-sessions.sh --dry-run [src_dir] [dest_dir]
#
# Defaults: src = ~/.pi/agent/sessions, dest = ~/.chrollo/memories

set -euo pipefail

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi

src_dir="${1:-$HOME/.pi/agent/sessions}"
dest_dir="${2:-$HOME/.chrollo/memories}"

[[ -d "$src_dir" ]] || { echo "error: src dir not found: $src_dir" >&2; exit 1; }
[[ "$dry_run" -eq 0 ]] && mkdir -p "$dest_dir"

mapfile -t files < <(find "$src_dir" -name '*.jsonl' -type f | sort)
[[ ${#files[@]} -eq 0 ]] && { echo "no jsonl sessions in $src_dir"; exit 0; }

# --- load existing session-id prefixes ONCE (from dest_dir only) ---
# a session already in dest (whether natively captured or previously imported) is skipped.
# fresh installs: dest is empty -> everything imports. existing users: dest has natives -> dedup'd.
# lab/testing: dest is the lab -> no cross-contamination of the real store.
declare -A existing_prefixes=()
if [[ -d "$dest_dir" ]]; then
  for p in "$dest_dir"/*_*.md; do
    [[ -f "$p" ]] || continue
    base="${p##*/}"
    stem="${base%.md}"
    prefix="${stem##*_}"
    [[ "$prefix" =~ ^[0-9a-f]{8}$ ]] && existing_prefixes["$prefix"]=1
  done
fi

imported=0
skipped=0
failed=0

for f in "${files[@]}"; do
  # --- cheap prefix extraction from line 1 (session event), no jq ---
  IFS= read -r first_line < "$f" || true
  first_line="${first_line#"${first_line%%[![:space:]]*}"}"
  if [[ "$first_line" =~ \"id\":\"([0-9a-f]{8}) ]]; then
    prefix="${BASH_REMATCH[1]}"
  else
    prefix=""
  fi

  if [[ -z "$prefix" ]]; then
    echo "  no session id: $(basename "$f")" >&2
    failed=$((failed+1))
    continue
  fi

  # --- dedup by prefix BEFORE paying jq cost ---
  if [[ -n "${existing_prefixes[$prefix]:-}" ]]; then
    skipped=$((skipped+1))
    continue
  fi

  # --- Step 1: jq extracts everything as ONE JSON object ---
  # text stays as proper JSON strings (newlines preserved natively)
  meta_json=$(sed 's/^[[:space:]]*//' "$f" | tr -d '\0' | jq -R -s '
    (split("\n") | map(select(length > 0) | fromjson?)) as $rows
    | ([$rows[] | select(.type == "session")][0] // empty) as $s
    | select($s != null)
    | {
        sid: $s.id,
        cwd: ($s.cwd // ""),
        parent: ($s.parentSession // ""),
        start_iso: $s.timestamp,
        messages: [ $rows[]
          | select(.type == "message")
          | (.message.role // "") as $role
          | select($role == "user" or $role == "assistant")
          | (.message.content // []) as $blocks
          | ($blocks | map(select(.type == "text") | (.text // "")) | join("\n")) as $text
          | select($text | test("\\S"))
          | { role: $role, iso: .timestamp, text: $text }
        ]
      }
  ' 2>/dev/null) || { echo "  jq failed: $(basename "$f")" >&2; failed=$((failed+1)); continue; }

  [[ -z "$meta_json" ]] && { skipped=$((skipped+1)); continue; }

  msg_count=$(jq '.messages | length' <<<"$meta_json")
  [[ "$msg_count" -eq 0 ]] && { skipped=$((skipped+1)); continue; }

  start_iso=$(jq -r '.start_iso' <<<"$meta_json")

  # --- Step 2: batch-convert ALL ISOs (start + every message) to local in ONE date call ---
  tmpisos="$(mktemp)"
  {
    echo "${start_iso%.*}Z"
    jq -r '.messages[].iso' <<<"$meta_json" | sed 's/\.[0-9]*Z\?$/Z/'
  } > "$tmpisos"

  # date -f reads timestamps line by line, converts each UTC -> local
  tmplines="$(mktemp)"
  date -f "$tmpisos" +"%Y-%m-%d %H:%M:%S" > "$tmplines" 2>/dev/null \
    || { echo "  date failed: $(basename "$f")" >&2; rm -f "$tmpisos" "$tmplines"; failed=$((failed+1)); continue; }
  rm -f "$tmpisos"

  # line 1 = session start (for filename), rest = message times
  start_local=$(head -n 1 "$tmplines")
  local_times_json=$(tail -n +2 "$tmplines" | jq -R -s 'split("\n") | map(select(length > 0))')
  rm -f "$tmplines"

  # --- compute filename from session start ---
  file_ts="${start_local/ /_}"            # "2026-07-04 08:01:17" -> "2026-07-04_08:01:17"
  file_ts="${file_ts//:/}"                  # -> "2026-07-04_080117"
  date_part="${file_ts%%_*}"
  filename="${file_ts}_${prefix}.md"

  if [[ "$dry_run" -eq 1 ]]; then
    printf '  would write %-55s (%s messages)\n' "$filename" "$msg_count"
    imported=$((imported+1))
    continue
  fi

  # --- Step 3: jq formats the final markdown, splicing in local times via --slurpfile ---
  # local_times_json is an array aligned with messages[] index
  content=$(jq -r --slurpfile times <(echo "$local_times_json") '
    def quote_agent($text):
      $text | split("\n")
      | map(if test("\\S") then "> " + . else ">" end)
      | join("\n");

    .sid as $sid
    | .cwd as $cwd
    | .parent as $parent
    | .messages as $msgs
    | ($times[0]) as $ts
    | [
        "---",
        "session_id: \"\($sid)\"",
        "date: \"\($ts[0][0:10])\"",
        "harness: \"pi\"",
        "cwd: \"\($cwd)\"",
        (if ($parent | length) > 0 then "parent_session: \"\($parent)\"" else empty end),
        "---",
        "",
        ( range(0; $msgs | length) as $i
          | $msgs[$i] as $m
          | $ts[$i] as $t
          | "[\($t)] [\(if $m.role == "user" then "User" else "Agent" end)]",
            (if $m.role == "user" then $m.text else quote_agent($m.text) end),
            "",
            ""
        )
      ]
    | flatten
    | .[]
  ' <<<"$meta_json" > "$dest_dir/$filename")

  existing_prefixes["$prefix"]=1
  imported=$((imported+1))
done

echo ""
echo "imported: $imported"
echo "skipped:  $skipped (dedup or empty)"
echo "failed:   $failed"
