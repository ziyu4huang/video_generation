#!/bin/bash
# Sync TODO.md with GitHub issues

TODO_FILE="TODO_FILE.tmp"

echo "# TODO.md - Development Tracker

Generated automatically. Do not edit manually.

## Active (needs-triage)

| # | Title | Labels |
|---|-------|--------|" > "$TODO_FILE"

gh issue list --label "needs-triage" --state all --json number,title,labels --sort created --asc --jq '.[] | "| \(.number) | \(.title) | \(.labels[].name // "" ) |"' >> "$TODO_FILE"

echo "
## Ready for Agent

| # | Title | Labels |
|---|-------|--------|" >> "$TODO_FILE"

gh issue list --label "ready-for-agent" --state all --json number,title,labels --sort created --asc --jq '.[] | "| \(.number) | \(.title) | \(.labels[].name // "" ) |"' >> "$TODO_FILE"

echo "
## Backlog

| # | Title | Labels |
|---|-------|--------|" >> "$TODO_FILE"

gh issue list --label "enhancement" --state open --json number,title --sort created --asc --jq '
  [.[] | .title = .title[0:60]] | unique_by(.number) | .[] | "| \(.number) | \(.title) | enhancement |"' >> "$TODO_FILE"

echo "
---

Updated: $(date -Iseconds)" >> "$TODO_FILE"

mv "$TODO_FILE" TODO.md
echo "Synced to TODO.md"