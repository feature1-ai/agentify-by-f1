import logger from '../../utils/logger.js';

/**
 * APIMapper - Maps a natural-language request to REST API calls by letting the
 * agent (codex exec) examine the OpenAPI/Swagger specs present in CONTEXT_DIR.
 *
 * Single Responsibility: intent → API endpoint mapping.
 *
 * This is fully spec-driven: the agent runs in the directory that holds the
 * user's OpenAPI docs, reads them, and returns the matching endpoints. There is
 * no hardcoded API surface and no rule-based fallback — mapping is entirely
 * determined by the specs the user drops in.
 */
export class APIMapper {
  constructor(codexExecutor = null) {
    this.codexExecutor = codexExecutor;
  }

  /**
   * Map a user request to API calls.
   *
   * @param {object|null} intent      Optional pre-extracted intent (unused in the
   *                                   combined prompt; the agent extracts it too).
   * @param {object|null} allSwaggerDocs  Map of available spec filename → content.
   * @param {string} userInput        The natural-language request.
   * @param {object} options          { onProgress }.
   */
  async mapToAPIs(intent, allSwaggerDocs = null, userInput = "", options = {}) {
    if (!this.codexExecutor) {
      throw new Error("APIMapper requires an agent executor (codex) to map APIs");
    }

    logger.info("Mapping request to REST APIs from the provided OpenAPI specs");
    return this.aiBasedMappingWithContextSelection(intent, allSwaggerDocs, userInput, options);
  }

  /**
   * Single agent call that performs intent analysis, context selection, and API
   * mapping together by examining the spec files in the working directory.
   */
  async aiBasedMappingWithContextSelection(intent, allSwaggerDocs, userInput, options = {}) {
    const availableFiles = allSwaggerDocs && typeof allSwaggerDocs === 'object'
      ? Object.keys(allSwaggerDocs)
      : [];
    const fileList = availableFiles.length > 0
      ? `Available files: ${availableFiles.join(', ')}`
      : `Examine the OpenAPI/Swagger *.json files present in the current directory.`;

    const combinedPrompt = `
You have access to OpenAPI/Swagger API documentation files in the current directory.
${fileList}

User request: "${userInput}"

First, analyze the user's intent and extract:
1. What action they want to perform (create, update, delete, get, list, etc.)
2. What resource/entity they're targeting (match it to the schemas in the specs)
3. Any specific entities mentioned (IDs, names, etc.)
4. Risk level (low, medium, high based on potential impact)

Then, examine each available Swagger file to understand what API it describes —
its resources, operations, and endpoints. Do not assume any particular service;
rely only on what the specs actually define.

Finally, determine:
1. Which Swagger files are relevant for this request (context selection)
2. Which specific API endpoints should be called (API mapping)

Return all information as JSON:
{
  "intent": {
    "action": "...",
    "resource": "...",
    "entities": [...],
    "conditions": {...},
    "riskLevel": "medium"
  },
  "relevantSwaggerDocs": ["<relevant-spec>.json"],
  "apiCalls": [
    {
      "service": "service_name",
      "endpoint": "/path/to/endpoint",
      "method": "HTTP_METHOD",
      "description": "What this API does",
      "requiredParams": ["param1", "param2"]
    }
  ]
}`;

    const result = await this.codexExecutor.execute(
      combinedPrompt,
      {}, // No specific context needed since the agent examines the files directly
      {
        temperature: 0.3,
        onProgress: options.onProgress
      }
    );

    const response = JSON.parse(result.output);
    logger.info(`Agent analyzed intent: ${response.intent?.action} ${response.intent?.resource}`);
    logger.info(`Agent selected contexts: ${response.relevantSwaggerDocs?.join(', ')}`);
    logger.info(`Agent mapped to ${response.apiCalls?.length || 0} API calls`);

    return response;
  }
}

export default APIMapper;
