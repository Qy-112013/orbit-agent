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
executable. `tsconfig.json` declares `strict: true` and `noEmit: true`, but
Node type stripping does not check types. `npm run check` runs syntax checks
only; the package does not yet provide a complete type-checking gate.

Current runtime dependencies include `@anthropic-ai/sdk`. After cloning, run
`npm ci` before starting the app. Source and tests use `.ts`; the browser
client and `scripts/check-syntax.mjs` remain JavaScript.

## Next boundaries

The next refactor stages can replace `JsonStore` with a storage adapter,
introduce provider capability contracts, and split HTTP transport from the
orchestrator without changing the public route payloads or event vocabulary.
