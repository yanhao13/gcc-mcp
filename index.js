#!/usr/bin/env node
/**
 * gcc-mcp — Git Context Controller memory server (MCP)
 *
 * Implements the GCC method (arXiv:2508.00031) as an MCP server so ANY
 * MCP-compatible coding agent (Claude Code, Claude Desktop, Cursor, etc.)
 * gets structured, persistent, cross-session memory:
 *
 *   .context/
 *   ├── main.md                     global project context & status
 *   └── branches/
 *       └── {branch}/
 *           ├── commit.md           milestone log (high-level)
 *           ├── log.md              append-only raw history
 *           └── metadata.md         free-form branch metadata
 *
 * Zero external dependencies — speaks raw JSON-RPC 2.0 over stdio,
 * which is all the MCP stdio transport requires. This means it runs
 * anywhere `node` runs, with no `npm install` step.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SERVER_NAME = 'gcc-mcp';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------

function contextRoot(projectDir) {
  return path.join(projectDir || process.cwd(), '.context');
}

function branchDir(projectDir, branch) {
  return path.join(contextRoot(projectDir), 'branches', safeName(branch));
}

function safeName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('branch name is required and must be a string');
  }
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!cleaned) throw new Error(`invalid branch name: ${name}`);
  return cleaned;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readFile(p, fallback = '') {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
}

function appendFile(p, content) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, content, 'utf8');
}

function timestamp() {
  return new Date().toISOString();
}

function mainPath(projectDir) {
  return path.join(contextRoot(projectDir), 'main.md');
}

function listBranches(projectDir) {
  const dir = path.join(contextRoot(projectDir), 'branches');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// ---------------------------------------------------------------------
// GCC operations
// ---------------------------------------------------------------------

function opInit({ project_dir, goal }) {
  const mp = mainPath(project_dir);
  if (fs.existsSync(mp)) {
    return {
      already_initialized: true,
      main_md: readFile(mp),
      path: mp,
    };
  }
  const content = `# Project Context

## Project Goal
${goal || '[not yet described]'}

## Current Status
Initialized ${timestamp()}.

## Active Branches
(none yet)

## Completed Branches
(none yet)
`;
  writeFile(mp, content);
  return { initialized: true, path: mp };
}

function requireMainExists(project_dir) {
  const mp = mainPath(project_dir);
  if (!fs.existsSync(mp)) {
    throw new Error(
      "No .context/main.md found. Call 'gcc_init' first to set up the project's memory."
    );
  }
  return mp;
}

function opBranch({ project_dir, branch, description }) {
  requireMainExists(project_dir);
  const name = safeName(branch);
  const dir = branchDir(project_dir, name);
  ensureDir(dir);

  const commitPath = path.join(dir, 'commit.md');
  const logPath = path.join(dir, 'log.md');
  const metaPath = path.join(dir, 'metadata.md');

  if (!fs.existsSync(commitPath)) {
    writeFile(
      commitPath,
      `# Branch: ${name}\n\n## Description\n${description || '[not described]'}\n\n## Milestones\n`
    );
  }
  if (!fs.existsSync(logPath)) {
    writeFile(logPath, `# Log: ${name}\n(append-only — raw history)\n\n`);
  }
  if (!fs.existsSync(metaPath)) {
    writeFile(
      metaPath,
      `# Metadata: ${name}\ncreated: ${timestamp()}\nstatus: active\n`
    );
  }

  // Register in main.md's Active Branches section
  const mp = mainPath(project_dir);
  let main = readFile(mp);
  const line = `- [ ] ${name}: ${description || ''}`.trimEnd();
  if (!main.includes(`] ${name}:`) && !main.includes(`] ${name}\n`)) {
    if (main.includes('(none yet)') && main.includes('## Active Branches')) {
      main = main.replace(
        /## Active Branches\n\(none yet\)/,
        `## Active Branches\n${line}`
      );
    } else if (main.includes('## Active Branches')) {
      main = main.replace(
        /## Active Branches\n/,
        `## Active Branches\n${line}\n`
      );
    } else {
      main += `\n## Active Branches\n${line}\n`;
    }
    writeFile(mp, main);
  }

  return { branch: name, dir, created: true };
}

function opCommit({ project_dir, branch, summary, details }) {
  requireMainExists(project_dir);
  const name = safeName(branch);
  const dir = branchDir(project_dir, name);
  if (!fs.existsSync(dir)) {
    // Auto-create the branch if the agent forgot to call gcc_branch first.
    opBranch({ project_dir, branch: name, description: '(auto-created on commit)' });
  }

  const commitPath = path.join(dir, 'commit.md');
  const logPath = path.join(dir, 'log.md');

  const ts = timestamp();
  appendFile(commitPath, `\n### [${ts}] ${summary}\n`);
  if (details) appendFile(logPath, `\n---\n[${ts}] COMMIT: ${summary}\n\n${details}\n`);
  else appendFile(logPath, `\n---\n[${ts}] COMMIT: ${summary}\n`);

  return { branch: name, committed: true, timestamp: ts };
}

function opMerge({ project_dir, branch, summary }) {
  requireMainExists(project_dir);
  const name = safeName(branch);
  const dir = branchDir(project_dir, name);
  if (!fs.existsSync(dir)) {
    throw new Error(`branch '${name}' does not exist — nothing to merge`);
  }

  const mp = mainPath(project_dir);
  let main = readFile(mp);
  const ts = timestamp();

  // Move the branch line from Active to Completed
  const activeLineRe = new RegExp(`- \\[ \\] ${escapeRe(name)}:?[^\n]*\n?`);
  const activeMatch = main.match(activeLineRe);
  main = main.replace(activeLineRe, '');

  const completedLine = `- [x] ${name}: ${summary}`;
  if (main.includes('## Completed Branches\n(none yet)')) {
    main = main.replace(
      '## Completed Branches\n(none yet)',
      `## Completed Branches\n${completedLine}`
    );
  } else if (main.includes('## Completed Branches')) {
    main = main.replace(
      /## Completed Branches\n/,
      `## Completed Branches\n${completedLine}\n`
    );
  } else {
    main += `\n## Completed Branches\n${completedLine}\n`;
  }

  // Update Current Status with the merge summary
  const statusLine = `Merged '${name}' on ${ts}: ${summary}`;
  if (main.includes('## Current Status')) {
    main = main.replace(
      /## Current Status\n[^\n]*\n/,
      `## Current Status\n${statusLine}\n`
    );
  }

  writeFile(mp, main);

  // Mark branch metadata as merged (rewrite status line rather than duplicating it)
  const metaPath = path.join(dir, 'metadata.md');
  let meta = readFile(metaPath, `# Metadata: ${name}\n`);
  if (/^status: .*$/m.test(meta)) {
    meta = meta.replace(/^status: .*$/m, 'status: merged');
  } else {
    meta += 'status: merged\n';
  }
  meta += `merged_at: ${ts}\nmerge_summary: ${summary}\n`;
  writeFile(metaPath, meta);

  return { branch: name, merged: true, was_active: !!activeMatch };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function opContext({ project_dir, branch, include_log }) {
  const mp = mainPath(project_dir);
  const main = readFile(mp, '(no .context/main.md yet — call gcc_init)');
  const result = { main_md: main, branches: listBranches(project_dir) };

  if (branch) {
    const name = safeName(branch);
    const dir = branchDir(project_dir, name);
    result.branch = name;
    result.commit_md = readFile(path.join(dir, 'commit.md'), '(no such branch)');
    result.metadata_md = readFile(path.join(dir, 'metadata.md'), '');
    if (include_log) {
      result.log_md = readFile(path.join(dir, 'log.md'), '');
    }
  }
  return result;
}

function opStatus({ project_dir }) {
  const mp = mainPath(project_dir);
  return {
    initialized: fs.existsSync(mp),
    main_md: readFile(mp, ''),
    branches: listBranches(project_dir),
  };
}

// ---------------------------------------------------------------------
// MCP tool schema
// ---------------------------------------------------------------------

const TOOLS = [
  {
    name: 'gcc_init',
    description:
      "Initialize the Git Context Controller memory system for this project (creates .context/main.md). Call this once at the start of a project, or before any other gcc_ tool if .context/ does not exist yet.",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: {
          type: 'string',
          description: 'Absolute path to the project root. Defaults to the server current working directory.',
        },
        goal: { type: 'string', description: 'A short description of the overall project goal.' },
      },
    },
  },
  {
    name: 'gcc_branch',
    description:
      'Create a new memory branch for exploring an implementation direction/approach. Registers it in main.md and sets up commit.md, log.md, metadata.md.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string' },
        branch: { type: 'string', description: "Short branch name, e.g. 'playwright-approach'." },
        description: { type: 'string', description: 'What this branch is exploring and why.' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'gcc_commit',
    description:
      'Record a milestone on a branch: a concise summary is appended to commit.md, and (optionally) full detail is appended to the append-only log.md. Call this after completing any meaningful subtask, decision, or fix — not just at the end of a session.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string' },
        branch: { type: 'string', description: 'Branch to commit to. Auto-created if it does not exist.' },
        summary: { type: 'string', description: 'One or two sentence milestone summary.' },
        details: { type: 'string', description: 'Optional: fuller detail / reasoning / code snippets for the raw log.' },
      },
      required: ['branch', 'summary'],
    },
  },
  {
    name: 'gcc_merge',
    description:
      'Merge a successful branch back into main.md: moves it from Active to Completed and updates the global Current Status. Only call this for branches whose approach actually worked — leave failed experiments unmerged as a record of what not to try again.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string' },
        branch: { type: 'string' },
        summary: { type: 'string', description: 'What was learned/achieved — this becomes the permanent record in main.md.' },
      },
      required: ['branch', 'summary'],
    },
  },
  {
    name: 'gcc_context',
    description:
      "Retrieve memory for this project: main.md (global context) always, plus a specific branch's commit.md/metadata.md if 'branch' is given. Use this at the start of a session, or whenever you need to recall past decisions before continuing work. Set include_log=true only if you need the raw conversation-level detail, not just milestones.",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string' },
        branch: { type: 'string', description: 'Optional: a specific branch to pull commit.md/metadata.md/log.md for.' },
        include_log: { type: 'boolean', description: 'Also return the raw log.md for the branch (can be long).' },
      },
    },
  },
  {
    name: 'gcc_status',
    description: 'Quick overview: is memory initialized, current main.md contents, and list of known branches.',
    inputSchema: {
      type: 'object',
      properties: { project_dir: { type: 'string' } },
    },
  },
];

function callTool(name, args) {
  args = args || {};
  switch (name) {
    case 'gcc_init':
      return opInit(args);
    case 'gcc_branch':
      return opBranch(args);
    case 'gcc_commit':
      return opCommit(args);
    case 'gcc_merge':
      return opMerge(args);
    case 'gcc_context':
      return opContext(args);
    case 'gcc_status':
      return opStatus(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (MCP transport) — no SDK dependency
// ---------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respondResult(id, result) {
  if (id === undefined || id === null) return; // notification, no response
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize': {
        respondResult(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        break;
      }
      case 'notifications/initialized':
        // no response required
        break;
      case 'ping':
        respondResult(id, {});
        break;
      case 'tools/list':
        respondResult(id, { tools: TOOLS });
        break;
      case 'tools/call': {
        const toolName = params && params.name;
        const args = params && params.arguments;
        try {
          const result = callTool(toolName, args);
          respondResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        } catch (toolErr) {
          respondResult(id, {
            content: [{ type: 'text', text: `Error: ${toolErr.message}` }],
            isError: true,
          });
        }
        break;
      }
      default:
        respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    respondError(id, -32603, e.message);
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      return; // ignore malformed lines
    }
    handleMessage(msg);
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
