# gcc-mcp

**Persistent, structured memory for AI coding agents — as an MCP server.**

Implements the [Git Context Controller](https://arxiv.org/abs/2508.00031) (GCC)
method: instead of a single memory file that grows unbounded, or context that
gets silently compacted away, your agent's memory is a small git-like
filesystem:

```
.context/
├── main.md                     global project goal & status
└── branches/
    └── {branch-name}/
        ├── commit.md            milestone log (what happened, high-level)
        ├── log.md                append-only raw detail
        └── metadata.md           status / timestamps
```

The agent gets four operations as MCP tools — `gcc_init`, `gcc_branch`,
`gcc_commit`, `gcc_merge` — plus `gcc_context` / `gcc_status` for recall.
Because it's a real MCP server (not a rule your agent might ignore), the
tools show up in the agent's tool list and it's told directly when to use
them.

Zero dependencies. Pure Node.js. Nothing to build.

## Why not just a `memory.md` file or agent instructions?

- A single memory file grows unbounded and agents struggle to find what's
  relevant in it (this is exactly what Claude Code's built-in `CLAUDE.md` /
  memory files run into on large projects).
- Plain instructions in a system prompt are easy for an agent to forget to
  follow. An actual tool call is not.
- Branch/merge means failed approaches stay recorded (so the agent — or a
  future session — doesn't re-try them) without polluting the "current
  truth" in `main.md`.

## Install

No install needed to try it — just point your agent config at `npx`:

```json
{
  "mcpServers": {
    "gcc-memory": {
      "command": "npx",
      "args": ["-y", "gcc-mcp"]
    }
  }
}
```

Or install globally:

```bash
npm install -g gcc-mcp
```

```json
{
  "mcpServers": {
    "gcc-memory": {
      "command": "gcc-mcp"
    }
  }
}
```

### Claude Code

Add to `.claude/mcp.json` (project) or `~/.claude/mcp.json` (global):

```json
{
  "mcpServers": {
    "gcc-memory": {
      "command": "npx",
      "args": ["-y", "gcc-mcp"]
    }
  }
}
```

### Claude Desktop

Add the same block under `mcpServers` in your Claude Desktop config file
(Settings → Developer → Edit Config).

### Cursor

Add the same block to `.cursor/mcp.json`.

The server stores `.context/` in its own working directory, which the
client sets to your project root — so memory lives alongside your code and
can be committed to git if you want it version-controlled too (or gitignored
if you'd rather keep it local/ephemeral).

## Tools

| Tool | When the agent should call it |
|---|---|
| `gcc_init` | Once, at the start of a project |
| `gcc_branch` | Before exploring a new implementation approach |
| `gcc_commit` | After any meaningful subtask, decision, or fix |
| `gcc_merge` | When a branch's approach succeeds |
| `gcc_context` | At the start of a session, or whenever it needs to recall past decisions |
| `gcc_status` | Quick check: what's the current state of memory |

Each tool description (visible to the agent via `tools/list`) tells it
*when* to use it — most agents will pick this up and start using the
system on their own once it's connected, without extra prompting. For best
results you can also add a line like this to your project's system prompt /
`CLAUDE.md`:

```
This project has a gcc-memory MCP server connected. Use gcc_context at the
start of every session, gcc_commit after every meaningful milestone, and
gcc_branch/gcc_merge when trying and settling on implementation approaches.
```

## Example flow

```
gcc_init({ goal: "Build a LinkedIn scraper" })
gcc_branch({ branch: "playwright", description: "Browser automation approach" })
gcc_commit({ branch: "playwright", summary: "Basic script working" })
gcc_branch({ branch: "requests", description: "Raw HTTP approach" })
gcc_commit({ branch: "requests", summary: "Blocked by anti-bot check" })
gcc_merge({ branch: "playwright", summary: "Playwright works reliably — use as backend" })

# ...new session, hours or days later...
gcc_context({})  →  reads main.md, sees playwright was merged, requests wasn't
```

## Running remotely (Streamable HTTP)

Everything above uses stdio, which is the right transport for local
clients spawning the server as a subprocess. To run `gcc-mcp` as a shared
service instead — one memory store multiple teammates' agents can hit —
start it in Streamable HTTP mode:

```bash
node index.js --http --port=8000
# or: PORT=8000 MCP_TRANSPORT=http node index.js
```

This exposes a single `POST /mcp` JSON-RPC endpoint (plus `GET /health`).
Point a remote-capable client at it:

```json
{
  "mcpServers": {
    "gcc-memory": {
      "url": "http://your-host:8000/mcp"
    }
  }
}
```

Note: in HTTP mode, `.context/` is written relative to wherever the
server process runs — pass an explicit `project_dir` argument on every
tool call if multiple projects share one deployed server instance.

### Docker

```bash
docker build -t gcc-mcp .
docker run -d -p 8000:8000 --name gcc-mcp gcc-mcp
curl http://localhost:8000/health
```

## Publishing this yourself

```bash
npm login
npm publish
```

(Update the `repository` field and `name` in `package.json` first if you're
forking this.)

## License

MIT
