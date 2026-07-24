#!/usr/bin/env node
/**
 * agents-dir-bridge : sync-agents-dir.js
 *
 * Implements the proposal from anthropics/claude-code#80801:
 *   1. A shared `.agents/` root directory (`.agents/<tool>/...`)
 *   2. Manifest-based discovery, so resource locations are declared,
 *      not hard-coded.
 *
 * Claude Code itself only reads from `.claude/skills`, `.claude/commands`,
 * `.claude/agents`, and root `.mcp.json`. This script bridges that gap
 * *without* touching Claude Code's core: it runs as a SessionStart hook,
 * reads a project's `.agents/` layout (optionally guided by a manifest),
 * and creates managed symlinks into the native `.claude/` locations.
 *
 * Design goals:
 *  - Zero core changes. Pure hook + filesystem.
 *  - Idempotent. Safe to run every session start.
 *  - Non-destructive. Never overwrites a real (non-symlinked) file the
 *    user created directly under .claude/. Only manages links it created
 *    itself, tracked in a state file.
 *  - Backward compatible. Absence of .agents/ is a silent no-op.
 */

const fs = require("fs");
const path = require("path");

const RESOURCE_TARGETS = {
  skills: ".claude/skills",
  commands: ".claude/commands",
  agents: ".claude/agents",
};

const STATE_FILE = ".claude/.agents-dir-bridge-state.json";
const MANIFEST_CANDIDATES = ["manifest.json", "manifest.yaml", "manifest.yml"];

function readStdin() {
  try {
    const data = fs.readFileSync(0, "utf8");
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

function log(msg) {
  // Diagnostic only — never goes to stdout, so it can't corrupt the
  // JSON contract with Claude Code.
  process.stderr.write(`[agents-dir-bridge] ${msg}\n`);
}

/**
 * Extremely small parser for the flat subset of YAML the proposal's
 * example manifest uses:
 *
 *   skills:
 *     - /.agents/skills
 *   commands:
 *     - /.agents/commands
 *
 * Full YAML is out of scope for a dependency-free hook script — if a
 * project needs more, it should ship manifest.json instead.
 */
function parseSimpleYamlManifest(text) {
  const result = {};
  let currentKey = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      result[currentKey] = [];
      continue;
    }
    const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
    if (itemMatch && currentKey) {
      result[currentKey].push(itemMatch[1].replace(/^["']|["']$/g, ""));
    }
  }
  return result;
}

function loadManifest(agentsDir) {
  for (const candidate of MANIFEST_CANDIDATES) {
    const manifestPath = path.join(agentsDir, candidate);
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, "utf8");
      try {
        return {
          data: candidate.endsWith(".json")
            ? JSON.parse(raw)
            : parseSimpleYamlManifest(raw),
          path: manifestPath,
        };
      } catch (e) {
        log(`failed to parse ${manifestPath}: ${e.message}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Fallback convention when no manifest is present: mirror
 * `.agents/claude/<resource>` onto the matching native `.claude/<resource>`.
 */
function fallbackDeclaration(agentsDir) {
  const claudeAgentDir = path.join(agentsDir, "claude");
  if (!fs.existsSync(claudeAgentDir) || !fs.statSync(claudeAgentDir).isDirectory()) {
    return {};
  }
  const declared = {};
  for (const type of Object.keys(RESOURCE_TARGETS)) {
    const candidate = path.join(claudeAgentDir, type);
    if (fs.existsSync(candidate)) {
      declared[type] = [path.relative(agentsDir, candidate)];
    }
  }
  return declared;
}

function resolveDeclaredPath(root, agentsDir, p) {
  // Manifest paths may be root-relative ("/.agents/skills") or
  // agents-dir-relative ("skills", "./skills").
  if (p.startsWith("/")) return path.join(root, p);
  return path.join(agentsDir, p);
}

function loadState(root) {
  const statePath = path.join(root, STATE_FILE);
  if (!fs.existsSync(statePath)) return { links: [] };
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { links: [] };
  }
}

function saveState(root, state) {
  const statePath = path.join(root, STATE_FILE);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function isManagedSymlink(dest, state) {
  return state.links.some((l) => l.dest === dest);
}

function removeStaleLinks(root, state, stillWantedDests) {
  const kept = [];
  for (const link of state.links) {
    const abs = path.join(root, link.dest);
    if (stillWantedDests.has(link.dest)) {
      kept.push(link);
      continue;
    }
    try {
      if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) {
        fs.unlinkSync(abs);
        log(`removed stale link ${link.dest}`);
      }
    } catch (e) {
      log(`could not remove stale link ${link.dest}: ${e.message}`);
    }
  }
  state.links = kept;
}

function linkDirectoryEntries(root, sourceDir, targetDir, state, newLinks, summary, label) {
  if (!fs.existsSync(sourceDir)) {
    log(`declared source missing: ${sourceDir}`);
    return;
  }
  const targetAbs = path.join(root, targetDir);
  fs.mkdirSync(targetAbs, { recursive: true });

  const entries = fs.readdirSync(sourceDir);
  let linked = 0;
  for (const entry of entries) {
    const srcAbs = path.join(sourceDir, entry);
    const destRel = path.join(targetDir, entry);
    const destAbs = path.join(root, destRel);

    const destExists = fs.existsSync(destAbs);
    const destIsSymlink = destExists && fs.lstatSync(destAbs).isSymbolicLink();

    if (destExists && !destIsSymlink) {
      // Real user file/dir already lives here — never touch it.
      log(`skipping ${destRel}: real file already present (not managed)`);
      continue;
    }

    if (destIsSymlink) {
      const currentTarget = fs.readlinkSync(destAbs);
      if (path.resolve(path.dirname(destAbs), currentTarget) === path.resolve(srcAbs)) {
        newLinks.add(destRel);
        linked++;
        continue; // already correct
      }
      if (!isManagedSymlink(destRel, state)) {
        log(`skipping ${destRel}: symlink present but not managed by this plugin`);
        continue;
      }
      fs.unlinkSync(destAbs);
    }

    fs.symlinkSync(srcAbs, destAbs);
    newLinks.add(destRel);
    linked++;
  }
  if (linked > 0) summary.push(`${label}: ${linked} item(s) from ${path.relative(root, sourceDir)}`);
}

function linkSingleFile(root, sourceFile, targetRel, state, newLinks, summary, label) {
  if (!fs.existsSync(sourceFile)) return;
  const targetAbs = path.join(root, targetRel);
  const destExists = fs.existsSync(targetAbs);
  const destIsSymlink = destExists && fs.lstatSync(targetAbs).isSymbolicLink();

  if (destExists && !destIsSymlink) {
    log(`skipping ${targetRel}: real file already present (not managed)`);
    return;
  }
  if (destIsSymlink) {
    const currentTarget = fs.readlinkSync(targetAbs);
    if (path.resolve(path.dirname(targetAbs), currentTarget) === path.resolve(sourceFile)) {
      newLinks.add(targetRel);
      return;
    }
    if (!isManagedSymlink(targetRel, state)) {
      log(`skipping ${targetRel}: symlink present but not managed`);
      return;
    }
    fs.unlinkSync(targetAbs);
  }
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.symlinkSync(sourceFile, targetAbs);
  newLinks.add(targetRel);
  summary.push(`${label}: linked ${path.relative(root, sourceFile)}`);
}

function main() {
  const input = readStdin();
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const agentsDir = path.join(root, ".agents");

  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    return; // silent no-op, fully backward compatible
  }

  const manifestResult = loadManifest(agentsDir);
  const declared = manifestResult ? manifestResult.data : fallbackDeclaration(agentsDir);

  const state = loadState(root);
  const newLinks = new Set();
  const summary = [];

  for (const [type, targetRel] of Object.entries(RESOURCE_TARGETS)) {
    const paths = declared[type];
    if (!paths || !paths.length) continue;
    for (const p of paths) {
      const srcAbs = resolveDeclaredPath(root, agentsDir, p);
      if (!fs.existsSync(srcAbs)) {
        log(`declared ${type} path missing: ${p}`);
        continue;
      }
      if (fs.statSync(srcAbs).isDirectory()) {
        linkDirectoryEntries(root, srcAbs, targetRel, state, newLinks, summary, type);
      }
    }
  }

  // Optional: bridge a project-level MCP config the same way.
  const mcpDeclared = declared.mcp;
  if (mcpDeclared && mcpDeclared.length) {
    for (const p of mcpDeclared) {
      const srcAbs = resolveDeclaredPath(root, agentsDir, p);
      if (fs.existsSync(srcAbs) && fs.statSync(srcAbs).isFile()) {
        linkSingleFile(root, srcAbs, ".mcp.json", state, newLinks, summary, "mcp");
      }
    }
  }

  removeStaleLinks(root, state, newLinks);
  state.links = Array.from(newLinks).map((dest) => ({ dest }));
  saveState(root, state);

  if (summary.length) {
    const context = `.agents/ bridge active (via agents-dir-bridge plugin, see anthropics/claude-code#80801): ${summary.join("; ")}.`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      })
    );
  }
}

main();
