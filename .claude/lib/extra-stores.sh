#!/usr/bin/env bash
# hooks: applies_to=all dest=.claude/lib
# SOURCED, not executed. The stores store-guard.sh holds that no `cli.json`
# names yet (PLAN-architecture-review.md §4, W7 and O1): named here so a
# store is guarded before its owner adds a cli.json (where both name a
# store, the cli.json is read first and its message is the one shown).
# Its source is tools/hooks (source/lib/); `hooks copies` there fails when a
# copy differs from it. Change the source, never a copy.
# Tests: bash tools/hooks/source/tests/test-extra-stores.sh
#
#   extra_stores    prints one store per line, three tab-separated fields:
#     pattern   a path relative to a REPO ROOT (any directory above the write
#               target that holds a CLAUDE.md), a glob allowed in its last
#               component only; never absolute, never `~`
#     writer    what really writes it, as a path from the workspace top
#               (tools/todo/todo), or `-` when no CLI does (only hooks do)
#     how       one phrase for the block message: how to change it instead
#
# A store goes in this list only when something other than a hand edit
# writes it. A store with no writer at all (knowledge-base's insights.tsv and
# sources.tsv, applications' audit-exempt.tsv: PLAN-architecture-review.md
# §4 W5) is NOT listed: blocking it would leave no way in, the break
# PLAN-services.md §3 "Before any store goes read-only" warns of. Its owner
# adds the CLI verb first.

extra_stores() {
  printf '%s\t%s\t%s\n' \
    'todo.json'           'tools/todo/todo'            'run the todo CLI from that repo (todo add, edit, done, ...)' \
    'todo-history.json'   'tools/todo/todo'            'run the todo CLI from that repo (todo done moves an item here)' \
    'data/failures.db'    'site-scrapers/failures.js'  'node failures.js record or forget, from that repo' \
    '.claude/state/*.tsv' '-'                          'only the hooks that append it write it; nothing else should' \
    '.claude/state/*.jsonl' '-'                        'only the hooks and agents.sh append it; nothing else should'
}
