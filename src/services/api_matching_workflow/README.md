# API Matching Workflow Services

This directory contains all the modular services for the API Matching Workflow. Each service follows the Single Responsibility Principle for clean, maintainable code.

## Directory Structure

```
api_matching_workflow/
├── IntentAnalyzer.js      # Analyzes user input and extracts intent
├── APIMapper.js           # Maps intents to API endpoints
├── ParameterExtractor.js  # Extracts and builds API parameters
├── ApprovalManager.js     # Manages approval workflow
├── ResponseFormatter.js   # Formats responses for users
├── index.js              # Central export file
└── README.md             # This file
```

## Services Overview

### 1. IntentAnalyzer
**Responsibility**: Analyze user input and extract structured intent

**Key Methods**:
- `analyze(userInput, context)` - Main analysis method
- `aiBasedAnalysis()` - Uses Codex for intent extraction
- `patternBasedAnalysis()` - Fallback pattern matching
- `assessRiskLevel()` - Determines operation risk level

**Output**: 
```javascript
{
  action: "list",
  resource: "pet",
  entities: [],
  conditions: { status: "available" },
  riskLevel: "low"
}
```

> Note: `IntentAnalyzer` is an optional helper. In the live workflow, `APIMapper`
> performs intent extraction and mapping together in a single agent call.

### 2. APIMapper
**Responsibility**: Map a request to REST API endpoints by letting the agent
(`codex exec`) examine the OpenAPI specs in the working directory. Fully
spec-driven — no hardcoded API surface.

**Key Methods**:
- `mapToAPIs(intent, allSwaggerDocs, userInput, options)` - Main mapping method
- `aiBasedMappingWithContextSelection()` - Single agent call doing intent
  analysis, context selection, and API mapping from the user's specs

**Output**:
```javascript
{
  intent: { action: "list", resource: "pet", entities: [], conditions: {}, riskLevel: "low" },
  relevantSwaggerDocs: ["petstore.json"],
  apiCalls: [{
    service: "petstore",
    endpoint: "/pets",
    method: "GET",
    description: "List all pets"
  }]
}
```

### 3. ParameterExtractor
**Responsibility**: Extract and build API parameters from intent

**Key Methods**:
- `extractParameters(intent, apiCalls)` - Main extraction method
- `buildRequestBody()` - Constructs request payloads
- `extractPathParams()` - Extracts URL parameters
- `validateParameters()` - Validates completeness

**Output**:
```javascript
[{
  service: "petstore",
  endpoint: "/pets/{petId}",
  method: "DELETE",
  pathParams: { petId: "123" }
}]
```

### 4. ApprovalManager
**Responsibility**: Manage human-in-the-loop approval process

**Key Methods**:
- `requiresApproval(intent, apiCalls)` - Checks if approval needed
- `generateApprovalRequest()` - Creates detailed approval message
- `processApprovalResponse()` - Handles user response
- `handleTimeout()` - Manages approval timeouts

**Features**:
- Risk-based approval requirements
- Detailed impact analysis
- Timeout handling
- Approval tracking

### 5. ResponseFormatter
**Responsibility**: Format API responses for user consumption

**Key Methods**:
- `format(results, intent, userInput)` - Main formatting method
- `formatMarkdown()` - Rich markdown formatting
- `formatJSON()` - Structured JSON output
- `formatPlain()` - Plain text output

**Features**:
- Multiple output formats
- Error handling
- Success/failure summaries
- Next steps guidance

## Usage Example

```javascript
import {
  IntentAnalyzer,
  APIMapper,
  ParameterExtractor,
  ApprovalManager,
  ResponseFormatter
} from './api_matching_workflow/index.js';

// Initialize services
const intentAnalyzer = new IntentAnalyzer(codexExecutor);
const apiMapper = new APIMapper(codexExecutor);
const parameterExtractor = new ParameterExtractor();
const approvalManager = new ApprovalManager({ requireApproval: true });
const responseFormatter = new ResponseFormatter({ format: 'markdown' });

// Process user request (the agent reads whatever OpenAPI specs are in CONTEXT_DIR)
const userInput = "list all available pets";

// 1. Map to APIs — the agent extracts intent + selects specs + maps endpoints
const { intent, apiCalls } = await apiMapper.mapToAPIs(null, allSwaggerDocs, userInput);

// 2. Extract parameters
const apiCallsWithParams = parameterExtractor.extractParameters(intent, apiCalls);

// 4. Check approval
if (approvalManager.requiresApproval(intent, apiCallsWithParams)) {
  const approval = approvalManager.generateApprovalRequest(intent, apiCallsWithParams, userInput);
  // Show approval to user and wait for response
}

// 5. Execute APIs (after approval)
const results = await restExecutor.executeBulkAPICalls(apiCallsWithParams);

// 6. Format response
const response = responseFormatter.format(results, intent, userInput);
```

## Design Principles

1. **Single Responsibility**: Each service has one clear purpose
2. **Dependency Injection**: Services receive dependencies via constructor
3. **Interface Segregation**: Clean, focused interfaces
4. **Testability**: Each service can be tested independently
5. **Extensibility**: Easy to add new features or modify behavior

## Testing

Each service should have its own test file:
- `IntentAnalyzer.test.js`
- `APIMapper.test.js`
- `ParameterExtractor.test.js`
- `ApprovalManager.test.js`
- `ResponseFormatter.test.js`

## Configuration

Services accept configuration via constructor:

```javascript
// Example configurations
const intentAnalyzer = new IntentAnalyzer(codexExecutor);

const approvalManager = new ApprovalManager({
  requireApproval: true,
  autoApproveRiskLevel: 'low',
  defaultTimeout: 300000 // 5 minutes
});

const responseFormatter = new ResponseFormatter({
  format: 'markdown',
  verbose: true,
  includeMetadata: false
});
```

## Adding New Services

To add a new service:

1. Create the service file in this directory
2. Follow the single responsibility principle
3. Export from `index.js`
4. Update this README
5. Add tests

## Dependencies

- `logger` - Winston logging utility
- `uuid` - For generating approval IDs
- Parent services use Codex and REST executors