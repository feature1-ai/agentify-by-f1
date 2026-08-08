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

Access to agentify's own REST endpoints is controlled by `AUTH_MODE` (`src/auth/`):
`none` (open), `api-key` (shared `X-API-Key` = `API_KEY` env; also the inferred
mode when `AUTH_MODE` is unset but `API_KEY` is set), or `oidc` (company SSO,
authorization code + PKCE via openid-client; discovery at boot, fail loud).
OIDC sessions are in-memory (`SessionStore` — the swap-in seam for Redis);
there is still no database. With `OIDC_FORWARD_ACCESS_TOKEN=true` the user's
own access token becomes the downstream API auth — precedence: per-request
`credentials` > forwarded SSO token > env defaults (see `applyCredentials`).

## Context directory

`CONTEXT_DIR` env (absolute or relative-to-app-root) controls where:
- `CodexExecutor` runs `codex exec` (sets `cwd`)
- `BaseWorkflow.loadContext` reads spec files
- `ContextSelector` lists spec files

Default: `<app>/resources/contexts/`. Users drop their `*.json` OpenAPI specs there.

## ContextSelector — generic auto-discover

Default: every `*.json` file in `CONTEXT_DIR` (except `context-rules.json`) is treated as a candidate spec and loaded for the agent.

Optional: drop `context-rules.json` in `CONTEXT_DIR` to define keyword→file scoring and multi-file scenario regexes — useful when the spec set is large enough that sending all of them blows the model's context window. The rules are applied in `APIMatchingWorkflow.initializeNode` (via `ContextSelector.selectContexts`) to narrow which spec files get loaded. Shape is documented in the README.

## Codex CLI install in Docker

The Dockerfile installs the real OpenAI Codex CLI via `npm install -g @openai/codex`. The base image is `node:20-slim` (Debian) — **not alpine** — because Codex CLI ships a glibc-linked Rust binary that doesn't run on musl. Don't switch back to alpine without verifying.

## Tests

Jest in ESM mode (`NODE_OPTIONS='--experimental-vm-modules' jest`). 6 suites:
- `api.test.js` — Express endpoints (incl. credential redaction + retry regression tests)
- `auth.test.js` — AUTH_MODE resolution, SessionStore, oidc middleware, credential precedence
- `BaseWorkflow.test.js` — context loading, graph build, routing, state accumulation
- `CodexExecutor.test.js` — config / `CONTEXT_DIR` resolution
- `setup.test.js` — repo structure sanity
- `workflows.test.js` — `WORKFLOWS_ENABLED` allow-list filtering

Run: `OPENAI_API_KEY=dummy npm test`. (Tests never actually shell out to `codex` — they cover construction, config, and HTTP shape.)

## Things to avoid

- **Don't re-introduce hardcoded service rules in `ContextSelector`** — the whole point of the rewrite was to make it generic. New rules belong in a user-supplied `context-rules.json`.
- **Don't add a fallback default for any API key in source** — `RestExecutor` and others read env-only and should fail loud if a needed value is missing. (The prior codebase had a hardcoded API key fallback; that's exactly the trap to avoid.)
- **Don't bind to a specific user's API surface in the workflow code.** The workflow's job is to be spec-agnostic.
- **No new top-level docs (other than this CLAUDE.md and the README).** Architecture details go in inline comments where the code lives.
