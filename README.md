# agents-dir-bridge

A Claude Code plugin implementing [anthropics/claude-code#80801](https://github.com/anthropics/claude-code/issues/80801):

> Support a shared `.agents/` directory and manifest-based discovery, instead of every
> agent/tool creating its own top-level directory (`.claude/`, `.cursor/`, `.opencode/`, ...).

Claude Code's core only ever reads from `.claude/skills`, `.claude/commands`, `.claude/agents`,
and root `.mcp.json`. Changing that is a core-team decision. This plugin doesn't wait for that —
it bridges the gap entirely from plugin-space, using a `SessionStart` hook, so a repo can adopt
the `.agents/` convention **today**, fully backward compatible, with **zero changes to Claude Code
itself**.

## What it does

On every session start (and on demand via `/agents-sync`), the plugin:

1. Looks for a `.agents/` directory at the project root. If absent: silent no-op.
2. Looks for a manifest at `.agents/manifest.json` (or `.yaml`/`.yml`), matching Proposal 2 from
   the issue:

   ```json
   {
     "skills": ["/.agents/skills"],
     "commands": ["/.agents/commands"],
     "agents": ["/.agents/agents"],
     "mcp": ["/.agents/claude/.mcp.json"]
   }
   ```

   YAML is supported for the same flat list-of-paths shape shown in the issue.
3. If no manifest exists, falls back to the convention from Proposal 1: `.agents/claude/skills`,
   `.agents/claude/commands`, `.agents/claude/agents` are mirrored automatically.
4. For each declared resource, creates **managed symlinks** into the matching native
   `.claude/<resource>/` directory (or root `.mcp.json` for MCP config), so Claude Code discovers
   them exactly as if they'd been placed there directly.

## Non-destructive by design

- Real files/directories you already have under `.claude/skills`, `.claude/commands`, etc. are
  **never touched or overwritten** — the script only manages symlinks it created itself, tracked
  in `.claude/.agents-dir-bridge-state.json`.
- Re-running is idempotent: unchanged declarations produce no filesystem writes.
- Renaming/removing a manifest entry cleans up the corresponding stale symlink on the next run —
  no orphaned links left behind.
- No `.agents/` directory present → the hook does nothing and emits no output.

## Install

```
/plugin marketplace add deepresearcher08/agents-dir-bridge
/plugin install agents-dir-bridge@agents-dir-bridge-marketplace
```

Or locally, for testing:

```
/plugin install ./agents-dir-bridge
```

## Manual re-sync

If you edit `.agents/manifest.json` mid-session, run:

```
/agents-sync
```

to re-sync without restarting the session.

## Why a plugin instead of a PR to core

`anthropics/claude-code` is Claude Code's issue tracker and plugin-catalog repo, not the CLI's
source (the CLI is closed-source; the repo only hosts docs/plugins metadata). A plugin is the
practical way to prototype and actually use this convention right now, and it doubles as a
concrete, working reference implementation to link from the issue — showing the core team the
exact manifest shape and discovery behavior a native implementation could adopt.

## Limitations / open questions (worth discussing on the issue)

- MCP server bridging currently only symlinks a single `.mcp.json` file; merging multiple
  declared MCP sources into one file is out of scope for a hook script.
- `.claude/settings.json` is intentionally **not** auto-linked — merging settings safely needs
  more thought than a symlink can offer.
- The YAML parser here only supports the flat `key: \n  - value` shape from the issue's example,
  not full YAML. Projects needing more structure should use `manifest.json`.
