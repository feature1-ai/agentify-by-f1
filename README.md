# agentify-by-f1

**Drop in your OpenAPI spec + an `OPENAI_API_KEY`, get a REST-aware agent for your SPA.** Users converse with your app instead of clicking through UI — agentify-by-f1 maps natural-language intent to the right API call, asks for approval, and executes it.

Built on a LangGraph workflow that uses the OpenAI Codex exec for reasoning — isolated behind an executor so it can be extended to other agent runtimes (Claude Agent SDK, [cagent](https://github.com/docker/cagent), …) — and a generic axios-based REST executor for invoking your API.

> **Origin:** generalized from a real-world API-automation implementation into a vendor-neutral, spec-driven tool. Any domain- or deployment-specific details have been removed; what ships here is intentionally generic.

## Features

- 📜 **OpenAPI/Swagger-driven** — drop your spec(s) in `resources/contexts/`, no rebuild required
- 💬 **Built-in chat UI** — served at `/`; no build step, just open the browser
- 🧠 **Codex-powered reasoning** — uses the OpenAI Codex exec (server-wide login, no per-request keys); isolated behind an executor so it can be extended to other agent runtimes
- ✋ **Human-in-the-loop approval** — every execution pauses for confirmation
- 🔑 **Per-user API credentials** — each chat user can pass their own downstream auth, or fall back to server-wide env defaults
- 🌐 **REST + SSE API** — sync execution, async with webhook callbacks, server-sent event streaming
- 🐳 **One-command Docker** — `docker-compose up` and you're live
- 🧩 **Extensible workflows** — subclass `BaseWorkflow` to compose your own LangGraph DAG

## Architecture

```
agentify-by-f1
├── BaseWorkflow (LangGraph DAG)
├── APIMatchingWorkflow
│   ├── ContextSelector   ← reads your *.json specs from CONTEXT_DIR
│   ├── IntentAnalyzer    ← codex exec
│   ├── APIMapper         ← codex exec
│   ├── ApprovalManager   ← gates every execution
│   └── RestExecutor      ← axios → your API
├── REST API (sync / async-webhook / SSE stream)
└── Docker (codex login on entrypoint, OPENAI_API_KEY → saved auth)
```

## Quick Start

### Prerequisites

- Docker & Docker Compose
- OpenAI API Key (used to log Codex CLI in at container startup)

### 1. Clone and Setup

```bash
git clone <repository>
cd agentify-by-f1
cp .env.example .env
```

### 2. Configure Environment

Edit `.env` with your settings:

```bash
# Required — Codex CLI logs in with this at container startup
OPENAI_API_KEY=sk-...

# Optional
CONTEXT_DIR=./resources/contexts   # where you drop your Swagger / OpenAPI specs
API_KEY=your_api_key_here          # gates the REST endpoints
PORT=3000
LOG_LEVEL=info
```

### 3. Run with Docker

```bash
# Build and start
docker-compose up --build

# Or use npm scripts
npm run docker:build
npm run docker:run
```

### 4. Test the Service

```bash
# Health check
curl http://localhost:3000/health

# List available workflows
curl -H "X-API-Key: your_api_key" http://localhost:3000/api/workflows

# Execute API matching workflow
curl -X POST http://localhost:3000/api/workflows/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key" \
  -d '{
    "workflowId": "api-matching",
    "input": "Find the API call to create a new user"
  }'
```

### 5. Open the Chat UI

Browse to **http://localhost:3000/** for the built-in chat interface. Click **⚙ Settings** to point it at your REST API:

- **Base URL of your API** — e.g. `https://api.example.com`
- **Auth header name / value** — e.g. `Authorization` / `Bearer eyJ…`
- **Gateway API key** — only needed if the server sets `API_KEY`

Settings live in the browser's `localStorage`; the credentials are sent per request (see below). Then just type — every action is shown for approval before it runs.

The page is plain static HTML in `public/`. Drop your own `public/index.html` to replace it, or build your SPA against the REST API directly.

## Credentials: server-wide vs. per-request

The agent calls **your** REST API on the user's behalf, and there are two ways to supply that downstream auth:

1. **Server-wide (env defaults)** — set `BASE_URL`, `AUTH_HEADER_NAME`, `AUTH_HEADER_VALUE`. Every request uses the same credential. Good for single-tenant / shared-service-token setups.
2. **Per-request (`credentials`)** — include a `credentials` object in the `execute` / `stream` body so each end-user acts as themselves. Per-request values override the env defaults; anything omitted falls back to env.

```bash
curl -X POST http://localhost:3000/api/workflows/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key" \
  -d '{
    "workflowId": "api-matching",
    "input": "list all pets that are available",
    "credentials": {
      "baseUrl": "https://api.example.com",
      "authHeaderName": "Authorization",
      "authHeaderValue": "Bearer eyJ..."
    }
  }'
```

The live credential is held only on the in-memory workflow instance for the duration of the request (including the approval step); the copy kept on the instance record is redacted, so it never appears in `GET /api/instances/:id`.

## Embedding in your SPA

The bundled UI at `/` is a starter. To wire the agent into your own SPA you talk to two endpoints: **execute** (send the user's message) and **approve** (run, or reject, the planned calls). Every action pauses for approval, so the flow is always _execute → (maybe) approve_.

### Request / response contract

**1. Send a message** — `POST /api/workflows/execute`

```jsonc
// request
{
  "workflowId": "api-matching",
  "input": "list all pets that are available",
  "credentials": {                       // optional; omit to use server-wide env auth
    "baseUrl": "https://api.example.com",
    "authHeaderName": "Authorization",
    "authHeaderValue": "Bearer eyJ..."
  }
}
```

```jsonc
// response
{
  "success": true,
  "instanceId": "api-matching_1733..._ab12",   // keep this to approve
  "result": {
    "messages": [                                // chat transcript; last `assistant` entry is the reply
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "I'll call GET /pets?status=available — approve?" }
    ],
    "metadata": {
      "approvalStatus": "pending",               // "pending" → you must approve before anything runs
      "apiCallsWithParams": [                     // the planned calls, to show the user
        { "method": "GET", "endpoint": "/pets", "queryParams": { "status": "available" } }
      ]
    }
  }
}
```

**2. Approve (or reject)** — `POST /api/workflows/:instanceId/approve`

```jsonc
// request
{ "decision": "approved" }   // or "rejected"
```

```jsonc
// response
{
  "success": true,
  "status": "completed",                         // or "rejected"
  "result": {
    "messages": [ /* ..., final { role: "assistant", content } with the API results */ ]
  }
}
```

Headers for both: `Content-Type: application/json`, plus `X-API-Key: <key>` if the server sets `API_KEY`.

If `result.metadata.approvalStatus` is **not** `"pending"` (e.g. the request errored or needed no calls), there's nothing to approve — just render the last assistant message.

### Framework-agnostic client (~40 lines, no dependencies)

```js
// agentify-client.js — works in any SPA (React, Vue, Svelte, vanilla)
export function createAgentifyClient({ gateway = '/api', apiKey, credentials } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(apiKey && { 'X-API-Key': apiKey }) };
  const lastAssistant = (result) =>
    [...(result?.messages || [])].reverse().find((m) => m.role === 'assistant')?.content ?? null;

  async function send(input, { workflowId = 'api-matching' } = {}) {
    const res = await fetch(`${gateway}/workflows/execute`, {
      method: 'POST', headers,
      body: JSON.stringify({ workflowId, input, credentials }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'execute failed');

    if (data.result?.metadata?.approvalStatus === 'pending') {
      return {
        needsApproval: true,
        instanceId: data.instanceId,
        message: lastAssistant(data.result),
        apiCalls: data.result.metadata.apiCallsWithParams || data.result.metadata.apiCalls || [],
      };
    }
    return { needsApproval: false, reply: lastAssistant(data.result) };
  }

  async function approve(instanceId, decision = 'approved') {
    const res = await fetch(`${gateway}/workflows/${instanceId}/approve`, {
      method: 'POST', headers,
      body: JSON.stringify({ decision }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'approve failed');
    return { status: data.status, reply: lastAssistant(data.result) || data.message };
  }

  return { send, approve };
}
```

```js
// usage
const agent = createAgentifyClient({
  gateway: 'https://your-host/api',
  apiKey: 'your_api_key',                 // only if API_KEY is set server-side
  credentials: { baseUrl: 'https://api.example.com', authHeaderName: 'Authorization', authHeaderValue: 'Bearer eyJ...' },
});

const turn = await agent.send('cancel order 1023');
if (turn.needsApproval) {
  // show turn.message + turn.apiCalls, then on the user's click:
  const done = await agent.approve(turn.instanceId, 'approved'); // or 'rejected'
  console.log(done.reply);
} else {
  console.log(turn.reply);
}
```

### Cross-origin notes

If your SPA is served from a different origin than agentify-by-f1, set `CORS_ORIGIN` to your SPA's origin (defaults to `*`). The agent calls your REST API **server-side** (axios), so your API itself doesn't need CORS — only the SPA → agentify hop does.

## API Endpoints

### Workflows

- `GET /api/workflows` - List all registered workflows
- `GET /api/workflows/:id` - Get workflow details
- `POST /api/workflows/execute` - Execute workflow (sync/async)
- `POST /api/workflows/stream` - Stream workflow execution

### Instances

- `GET /api/instances` - List workflow instances
- `GET /api/instances/:id` - Get instance details
- `DELETE /api/instances/:id` - Delete instance

### System

- `GET /health` - Health check

## Workflow Execution

### Synchronous Execution

```javascript
{
  "workflowId": "api-matching",
  "input": "Find the API call to create a new user",
  "context": {
    "coding-standards.json": "..." // Optional context override
  }
}
```

### Asynchronous with Webhook

```javascript
{
  "workflowId": "api-matching", 
  "input": "Find the API call to create a new user",
  "webhookUrl": "https://your-app.com/webhook",
  "async": true
}
```

### Streaming Execution

```bash
curl -N http://localhost:3000/api/workflows/stream \
  -H "Content-Type: application/json" \
  -d '{"workflowId": "api-matching", "input": "..."}'
```

## Creating Custom Workflows

### 1. Extend BaseWorkflow

```javascript
import BaseWorkflow from '../core/BaseWorkflow.js';
import CodexExecutor from '../executors/CodexExecutor.js';

export class MyCustomWorkflow extends BaseWorkflow {
  constructor(workflowId, config = {}) {
    super(workflowId, config);
    this.codexExecutor = new CodexExecutor(config.codex || {});
  }

  // Override nodes
  defineNodes(workflow) {
    super.defineNodes(workflow);
    workflow.addNode("customNode", this.customNode.bind(this));
  }

  // Override edges
  defineEdges(workflow) {
    workflow.addEdge("initialize", "customNode");
    workflow.addEdge("customNode", "finalize");
    workflow.addEdge("finalize", "END");
  }

  // Custom node implementation
  async customNode(state) {
    const result = await this.codexExecutor.execute(
      "Generate code based on: " + state.messages[0].content,
      state.context
    );
    
    return {
      ...state,
      currentNode: "customNode",
      messages: [...state.messages, { role: 'assistant', content: result.output }],
      metadata: { ...state.metadata, complete: true }
    };
  }
}
```

### 2. Register Workflow

```javascript
// src/workflows/index.js
import WorkflowRegistry from '../services/WorkflowRegistry.js';
import MyCustomWorkflow from './MyCustomWorkflow.js';

WorkflowRegistry.register('my-custom', MyCustomWorkflow);
```

## Context System

### Loading Context Files

```javascript
// Workflow will load these files from resources/contexts/
await workflow.loadContext([
  'coding-standards.json',
  'project-requirements.txt',
  'api-documentation.md'
]);
```

### Context Structure

```
resources/
├── contexts/           # Context files loaded by workflows
│   ├── coding-standards.json
│   └── api-docs.md
├── templates/          # Prompt templates
└── schemas/            # Validation schemas
    └── request-schema.json
```

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Run linting
npm run lint
```

### Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- tests/BaseWorkflow.test.js

# Run with coverage
npm test -- --coverage
```

### Project Structure

```
src/
├── core/               # Core workflow components
│   └── BaseWorkflow.js
├── executors/          # AI service executors  
│   └── CodexExecutor.js
├── workflows/          # Workflow implementations
│   ├── APIMatchingWorkflow.js
│   └── index.js
├── api/                # REST API routes
│   └── workflowRoutes.js
├── services/           # Business logic services
│   └── WorkflowRegistry.js
├── middleware/         # Express middleware
│   └── errorHandler.js
├── utils/              # Utilities
│   └── logger.js
├── config/             # Configuration management
│   └── index.js
└── index.js            # Application entry point
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | OpenAI API key. Used once at container startup to log Codex CLI in (`codex login --with-api-key`). |
| `CONTEXT_DIR` | No | `./resources/contexts` | Directory `codex exec` runs in — drop your Swagger / OpenAPI JSON files here. |
| `BASE_URL` | No | - | Base URL for your REST API (the one the agent calls on your behalf). |
| `AUTH_HEADER_NAME` | No | - | Static auth header name for your REST API (e.g. `Authorization`). |
| `AUTH_HEADER_VALUE` | No | - | Static auth header value (e.g. `Bearer eyJ…`). |
| `REQUEST_TIMEOUT_MS` | No | 30000 | Per-request timeout for outbound REST calls. |
| `API_KEY` | No | - | API key gating agentify-by-f1's own REST endpoints (sent as `X-API-Key`). |
| `PORT` | No | 3000 | Server port |
| `NODE_ENV` | No | development | Environment mode |
| `LOG_LEVEL` | No | info | Logging level |
| `CODEX_MAX_TOKENS` | No | 4000 | Max tokens per Codex request |
| `CODEX_TEMPERATURE` | No | 0.7 | Codex temperature setting |
| `WEBHOOK_TIMEOUT` | No | 30000 | Webhook timeout (ms) |
| `CORS_ORIGIN` | No | * | CORS allowed origins |

## Bring your own OpenAPI specs

Drop one or more `*.json` OpenAPI/Swagger files into `CONTEXT_DIR`. agentify-by-f1 ships with `petstore.json` as a working example — replace or remove it.

### Optional: context-rules.json

If you ship many specs and don't want every request to send all of them to the model, drop a `context-rules.json` in `CONTEXT_DIR` to scope which files are loaded per intent:

```json
{
  "services": {
    "users.json": {
      "keywords": ["user", "account", "profile"],
      "actions":  ["create", "delete", "update"],
      "priority": 1
    },
    "billing.json": {
      "keywords": ["invoice", "payment", "charge"],
      "actions":  ["pay", "refund"],
      "priority": 2
    }
  },
  "scenarios": [
    { "pattern": "refund|chargeback",
      "contexts": ["users.json", "billing.json"],
      "description": "A refund touches both the customer and billing records" }
  ]
}
```

Without this file, all `*.json` specs in the directory are used.

## Docker Configuration

### Multi-stage Build

The Dockerfile uses a multi-stage build for optimized image size:

1. **Builder stage** - Installs dependencies
2. **Runtime stage** - Installs Codex CLI and runs application

### Security Features

- Non-root user execution
- Read-only resource mounts
- Health checks
- Resource limits via docker-compose

### Production Deployment

```bash
# Build production image
docker build -t agentify-by-f1:latest .

# Run with environment file
docker run --env-file .env -p 3000:3000 agentify-by-f1:latest

# Use docker-compose for full stack
docker-compose -f docker-compose.yml up -d
```

## Error Handling

The service includes comprehensive error handling:

- **Validation Errors** - Input validation with Joi
- **Workflow Errors** - Custom workflow execution errors  
- **Authentication Errors** - API key validation
- **Service Errors** - External service connectivity
- **Internal Errors** - Application-level errors

## Monitoring

### Health Checks

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "success": true,
  "status": "healthy", 
  "timestamp": "2026-03-05T20:00:00.000Z",
  "uptime": 3600
}
```

### Logging

Structured logging with Winston:

- Console output in development
- File logging in production
- Configurable log levels
- Request/response logging

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

---

Built with Node.js, LangGraph, and the OpenAI Codex CLI.
