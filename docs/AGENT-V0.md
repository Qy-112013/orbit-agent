# Orbit Agent v0

Orbit v0 is a local-first Agent Runtime with a Web chat surface and an MCP
stdio surface. A request can be routed to one or more named agents, enriched
with bounded memory and matching Skills, executed through an allow-listed tool
registry, and observed through durable events and SSE.

## Capability map

| Surface | Capability |
| --- | --- |
| Web API | threads, messages, tasks, memories, events, agents, skills |
| Runtime | deterministic mention routing, serial/parallel turns, per-thread queue |
| Provider | OpenAI-compatible HTTP adapter plus Codex, Claude Code and Pi CLI adapters with local fallback |
| Skills | Markdown registry, metadata/keyword matching, prompt injection, API discovery |
| MCP | initialize, tools/list, tools/call, resources/list, resources/read |
| Workspace | bounded `workspace_list` and `workspace_read` tools |
| Reliability | atomic JSON writes, bounded state, event replay, provider recovery |

## CLI adapter boundary

Set `ORBIT_ATLAS_PROVIDER=codex`, `ORBIT_FORGE_PROVIDER=claude-code`, or
`ORBIT_LENS_PROVIDER=pi` to route an Agent to a local CLI. Codex uses
`codex exec --json`, Claude Code uses `claude -p --output-format json`, and Pi
uses `pi --print --mode json`. Each invocation is a bounded child process and
its output is normalized into the ProviderResult contract. CLI-specific
interactive PTY control, session resume UX, and automatic file/shell approvals
are intentionally deferred.

## Deliberate limits

The v0 runtime does not execute arbitrary shell commands, mutate files, expose
remote MCP transports, or provide multi-user authentication. Those are separate
capability and security boundaries for a later release.

## Demo path

1. Start the Web runtime with `npm start` and open `http://127.0.0.1:3030`.
2. Ask for an architecture or review task; the matching Skill appears in the
   execution trace and is included in the provider context.
3. Use `@all` to fan out across Atlas, Forge and Lens.
4. Use `npm --silent run mcp` to connect an MCP client to the same allow-listed
   tool surface.
