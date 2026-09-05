# TypeScript Migration

## Scope

The migration keeps the existing Orbit runtime contract intact while making
the core seams explicit:

- `types.ts` defines agents, threads, messages, memories, tasks, events,
  provider results and execution context.
- `store.ts` owns the durable state shape and serializes writes through one
  mutation queue.
- `router.ts` exposes a typed route decision for mention and strategy parsing.
- `providers.ts` exposes a typed provider result and preserves the local
  fallback path when no API key is configured.
- `server.ts` remains the HTTP/SSE composition root.

## Runtime model

Node 25 runs `.ts` files with `--experimental-strip-types`. The code avoids
TypeScript features that require a transform (for example parameter
properties, enums and namespaces), so the same modules remain directly
executable while `tsconfig.json` provides a strict-checking target for a
future emitted build.

## Next boundaries

The next refactor stages can replace `JsonStore` with a storage adapter,
introduce provider capability contracts, and split HTTP transport from the
orchestrator without changing the public route payloads or event vocabulary.
