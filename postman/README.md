# Postman Collection for API Matching Workflow

## Overview
This Postman collection provides example requests for the agentify-by-f1 API Matching Workflow. Examples cover the sync, async-with-webhook, streaming, and approval-management endpoints.

The scenarios use the bundled **petstore.json** sample spec. To test against your own API, drop your OpenAPI/Swagger spec into `resources/contexts/` and change the natural-language `input` to match your domain.

## Setup Instructions

### 1. Import Collection
1. Open Postman
2. Click "Import"
3. Select `API_Matching_Workflow.postman_collection.json`

### 2. Configure Variables
The collection defines these variables (with defaults):
- `baseUrl`: Default `http://localhost:3000`
- `apiKey`: Sent as `X-API-Key` — only required if the server sets `API_KEY`
- `workflowInstanceId`: Auto-populated by the "List Available Pets" test script

### 3. Start the Server
```bash
npm start
# or: docker-compose up --build
```

## Collection Structure

### 1. Workflow Management
- **List Available Workflows** — `GET /api/workflows`
- **Get Workflow Details** — `GET /api/workflows/api-matching`
- **Get Workflow Instance Status** — `GET /api/workflows/{instanceId}/status`

### 2. API Matching Scenarios (Petstore sample)
- **List Available Pets** — read-only, maps to `GET /pets`
- **Create a Pet** — maps to `POST /pets`
- **Get Pet by ID** — maps to `GET /pets/{petId}`
- **Delete a Pet** — destructive, returns an approval request first
- **List Pets (with per-request credentials)** — passes the downstream API base URL + auth in the request body

### 3. Workflow Execution Options
- **Async Execution with Webhook** — non-blocking, with a callback
- **Stream Workflow Execution** — real-time SSE events

### 4. Approval Management
- **Approve Pending Action** — `POST /api/workflows/{instanceId}/approve` `{ "decision": "approved" }`
- **Reject Pending Action** — `{ "decision": "rejected" }`

## Usage Examples

### Basic execution
1. Select **List Available Pets** and click **Send**.
2. The response includes `instanceId` and a `result`. The test script saves the `instanceId` into the `workflowInstanceId` variable.

### Action requiring approval
1. Run **Delete a Pet (high-risk, requires approval)**.
2. The response comes back with `result.metadata.approvalStatus = "pending"`.
3. Run **Approve Pending Action** (it uses the saved `workflowInstanceId`) to execute, or **Reject Pending Action** to cancel.

### Async execution with webhook
1. Create a webhook endpoint (e.g. at webhook.site).
2. Put its URL in `webhookUrl` and send the async request.
3. The completion payload is POSTed to your webhook.

## Request Body Parameters

### Required
- `workflowId`: `"api-matching"`
- `input`: Natural-language description of the desired action (a plain string)

### Optional
- `credentials`: `{ baseUrl, authHeaderName, authHeaderValue }` — per-request downstream API auth (overrides server-wide env defaults)
- `config.approval.requireApproval`: Force an approval gate (boolean)
- `config.approval.autoApproveRiskLevel`: Auto-approve at/below a risk level (`low` | `medium` | `high` | `none`)
- `async`: Execute asynchronously (boolean)
- `webhookUrl`: Callback URL for async execution

> Note: you don't list spec files in the request. The agent (`codex exec`) automatically reads whatever OpenAPI specs are present in `CONTEXT_DIR` (`resources/contexts/`).

## Troubleshooting

1. **Connection refused** — ensure the server is running and `baseUrl` matches the port.
2. **401 Invalid API key** — set the `apiKey` variable to match the server's `API_KEY` (or unset `API_KEY` to run open).
3. **Workflow not found** — confirm `api-matching` is registered via **List Available Workflows**.
4. **Approval timeout** — approvals default to a 5-minute timeout; approve promptly or raise `config.approval.defaultTimeout`.

## Support
- Server logs for detailed errors
- The instance status endpoint for execution details
- The main project README for architecture
