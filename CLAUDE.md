# agentify-by-f1 — context for Claude

agentify-by-f1 is an OpenAPI-spec-driven agent service. The pitch: drop your Swagger / OpenAPI JSON into `resources/contexts/`, set `OPENAI_API_KEY`, and your SPA can converse-and-act against your REST API instead of clicking through UI.

## How it works

Two executors back the workflows:

1. **`src/executors/CodexExecutor.js`** — shells out to the OpenAI Codex CLI (`codex exec`) with the user's intent + the loaded spec context. Codex returns structured intent / API-call mappings.
2. **`src/executors/RestExecutor.js`** — generic axios client that calls the user's REST API. Configured via `BASE_URL`, `AUTH_HEADER_NAME`, `AUTH_HEADER_VALUE`.

The workflow (`src/workflows/APIMatchingWorkflow.js`) is a LangGraph DAG:
`initialize → mapAPIs → extractParameters → requestApproval → executeAPIs → formatResponse → finalize`.

Approval is mandatory for every execution (see `routeFromParameters`); the workflow pauses, returns an approval payload, and resumes via `processApprovalResponse`.

## Auth model — server-wide

The Docker entrypoint (`scripts/docker-entrypoint.sh`) runs once at container start:

```sh
printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key
```

After that, `codex exec` reuses the saved credential. There is no per-request OpenAI key. `OPENAI_API_KEY` is **required**; the entrypoint exits non-zero if it's missing.

For the user's REST API auth, `RestExecutor` reads `AUTH_HEADER_NAME` + `AUTH_HEADER_VALUE` at startup (e.g. `Authorization` / `Bearer eyJ…`).

The REST endpoints themselves are gated by `X-API-Key` matching the `API_KEY` env (optional — if `API_KEY` is unset, the API is open).

## Context directory

`CONTEXT_DIR` env (absolute or relative-to-app-root) controls where:
- `CodexExecutor` runs `codex exec` (sets `cwd`)
- `BaseWorkflow.loadContext` reads spec files
- `ContextSelector` lists spec files

Default: `<app>/resources/contexts/`. Users drop their `*.json` OpenAPI specs there.

## ContextSelector — generic auto-discover

Default: every `*.json` file in `CONTEXT_DIR` (except `context-rules.json`) is treated as a candidate spec.

Optional: drop `context-rules.json` in `CONTEXT_DIR` to define keyword→file scoring and multi-file scenario regexes — useful when the spec set is large enough that sending all of them blows the model's context window. Shape is documented in the README.

## Codex CLI install in Docker

The Dockerfile installs the real OpenAI Codex CLI via `npm install -g @openai/codex`. The base image is `node:20-slim` (Debian) — **not alpine** — because Codex CLI ships a glibc-linked Rust binary that doesn't run on musl. Don't switch back to alpine without verifying.

## Tests

Jest in ESM mode (`NODE_OPTIONS='--experimental-vm-modules' jest`). 5 suites:
- `api.test.js` — Express endpoints
- `BaseWorkflow.test.js` — context loading, graph build, routing
- `CodexExecutor.test.js` — config / `CONTEXT_DIR` resolution
- `setup.test.js` — repo structure sanity
- `workflowPolicy.test.js` — feature-flag / removed-workflow guards

Run: `OPENAI_API_KEY=dummy npm test`. (Tests never actually shell out to `codex` — they cover construction, config, and HTTP shape.)

## Things to avoid

- **Don't re-introduce hardcoded service rules in `ContextSelector`** — the whole point of the rewrite was to make it generic. New rules belong in a user-supplied `context-rules.json`.
- **Don't add a fallback default for any API key in source** — `RestExecutor` and others read env-only and should fail loud if a needed value is missing. (The prior codebase had a hardcoded API key fallback; that's exactly the trap to avoid.)
- **Don't bind to a specific user's API surface in the workflow code.** The workflow's job is to be spec-agnostic.
- **No new top-level docs (other than this CLAUDE.md and the README).** Architecture details go in inline comments where the code lives.
