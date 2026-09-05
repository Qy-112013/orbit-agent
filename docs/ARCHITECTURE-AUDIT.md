# Architecture audit notes

Before implementing Orbit Agent, the reference multi-agent workspace was
mapped into five layers. This document records the reasoning behind the new
project without importing the reference application's product surfaces.

## Layer map

| Layer | Responsibility | Orbit Agent decision |
| --- | --- | --- |
| Contracts | ids, roles, message/event shapes | compact objects in `src/core/types.mjs` |
| Runtime | route, queue, invocation and completion | `router.mjs` + `orchestrator.mjs` |
| State | threads, messages, evidence and tasks | single-writer `store.mjs` |
| Model boundary | provider-specific sessions and output | `providers.mjs` contract |
| Projection | timeline, status and operator controls | static client + SSE |

## Critical path

```text
operator input
   ↓
router.route()                    deterministic target + strategy
   ↓
memory.buildContext()             bounded recent messages + citations
   ↓
provider.complete()               replaceable model adapter
   ↓
store.appendMessage()             durable result
   ↓
store.appendEvent() + SSE         replayable observability
```

## Complexity budget

Orbit Agent intentionally has one composition root (`src/server.mjs`), one
durable writer (`JsonStore`) and one workflow coordinator (`Orchestrator`). A
new feature should fit behind one of those boundaries; if it requires a second
writer or a second event vocabulary, the design should be reconsidered first.

## Verification matrix

| Behavior | Test |
| --- | --- |
| mention parsing and strategy | `test/router.test.mjs` |
| memory ranking and command parsing | `test/memory.test.mjs` |
| restart durability and concurrent writes | `test/store.test.mjs` |
| fan-out, task creation and trace | `test/orchestrator.test.mjs` |
| HTTP health/bootstrap/message path | `test/server.test.mjs` |

See [`ORIGIN-NOTES.md`](ORIGIN-NOTES.md) for the source-study provenance.

