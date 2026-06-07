import logger from '../../utils/logger.js';

/**
 * ParameterExtractor - Responsible for extracting and building API parameters
 * Single Responsibility: Parameter extraction and request body construction
 */
export class ParameterExtractor {
  constructor() {
    this.parameterPatterns = this.initializePatterns();
  }

  initializePatterns() {
    return {
      pathParams: {
        userId: /user[_-]?(\w+)|@(\w+)|uid[_-]?(\w+)/gi,
        petId: /pet[_-]?(\w+)|pid[_-]?(\w+)/gi,
        orderId: /order[_-]?(\w+)|oid[_-]?(\w+)/gi
      },
      dataTypes: {
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        phone: /^\+?[\d\s-()]+$/,
        uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        numeric: /^\d+$/
      }
    };
  }

  /**
   * Extract parameters for API calls based on intent and matched APIs
   */
  extractParameters(intent, apiCalls) {
    logger.info("Extracting parameters for API calls");
    
    const apiCallsWithParams = [];
    
    for (const api of apiCalls) {
      // Handle multiple entities (bulk operations)
      if (this.requiresBulkOperation(api, intent)) {
        apiCallsWithParams.push(...this.createBulkCalls(api, intent));
      } else {
        apiCallsWithParams.push(this.createSingleCall(api, intent));
      }
    }
    
    return apiCallsWithParams;
  }

  /**
   * Check if API requires bulk operation
   */
  requiresBulkOperation(api, intent) {
    const hasMultipleEntities = intent.entities && intent.entities.length > 1;
    const hasPathParams = api.endpoint.includes('{');
    return hasMultipleEntities && hasPathParams;
  }

  /**
   * Create multiple API calls for bulk operations
   */
  createBulkCalls(api, intent) {
    return intent.entities.map(entity => {
      const call = { ...api };
      call.pathParams = this.extractPathParams(api.endpoint, entity, intent);
      
      if (this.requiresRequestBody(api.method)) {
        call.body = this.buildRequestBody(intent, api, entity);
      }
      
      return call;
    });
  }

  /**
   * Create a single API call
   */
  createSingleCall(api, intent) {
    const call = { ...api };
    
    // Extract path parameters if needed
    if (api.endpoint.includes('{')) {
      const entity = intent.entities?.[0] || null;
      call.pathParams = this.extractPathParams(api.endpoint, entity, intent);
    }
    
    // Build request body if needed
    if (this.requiresRequestBody(api.method)) {
      call.body = this.buildRequestBody(intent, api);
    }
    
    // Add query parameters if any
    if (intent.conditions && Object.keys(intent.conditions).length > 0) {
      call.queryParams = this.extractQueryParams(intent.conditions);
    }
    
    return call;
  }

  /**
   * Extract path parameters from endpoint template
   */
  extractPathParams(endpoint, entity, intent) {
    const params = {};
    const paramMatches = endpoint.match(/{(\w+)}/g);
    
    if (!paramMatches) return params;
    
    for (const match of paramMatches) {
      const paramName = match.replace(/{|}/g, '');
      params[paramName] = this.resolveParameterValue(paramName, entity, intent);
    }
    
    return params;
  }

  /**
   * Resolve parameter value based on parameter name and available data
   */
  resolveParameterValue(paramName, entity, intent) {
    // Direct entity mapping
    if (entity) {
      // Ensure entity is a string before calling replace
      const entityStr = typeof entity === 'string' ? entity : String(entity);
      // Clean up entity (remove prefixes like "user", "@", etc.)
      const cleanEntity = entityStr.replace(/^(user|pet|order|@)/i, '');
      return cleanEntity || entityStr;
    }
    
    // Try to extract from conditions
    if (intent.conditions && intent.conditions[paramName]) {
      return intent.conditions[paramName];
    }
    
    // Try to infer from intent
    if (paramName.includes('user') && intent.entities?.length > 0) {
      return intent.entities[0];
    }
    
    // Default placeholder
    return `{${paramName}}`;
  }

  /**
   * Extract query parameters from conditions
   */
  extractQueryParams(conditions) {
    const queryParams = {};
    
    for (const [key, value] of Object.entries(conditions)) {
      // Filter out internal conditions
      if (!key.startsWith('_') && value !== undefined && value !== null) {
        queryParams[key] = value;
      }
    }
    
    return Object.keys(queryParams).length > 0 ? queryParams : undefined;
  }

  /**
   * Check if HTTP method requires request body
   */
  requiresRequestBody(method) {
    return ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
  }

  /**
   * Build request body based on intent and API requirements
   */
  buildRequestBody(intent, api, entity = null) {
    // Spec-agnostic body. The agent (codex exec) maps the request against the
    // user's OpenAPI schema, so we don't assume any resource shape here — we
    // just carry through whatever conditions/fields the request implied, plus
    // light provenance metadata.
    const body = {
      updated_by: "ai-agent",
      timestamp: new Date().toISOString()
    };

    if (intent.conditions && Object.keys(intent.conditions).length > 0) {
      Object.assign(body, intent.conditions);
    }

    return body;
  }

  /**
   * Validate extracted parameters
   */
  validateParameters(apiCallsWithParams) {
    const validationResults = [];
    
    for (const call of apiCallsWithParams) {
      const issues = [];
      
      // Check for unresolved path parameters
      if (call.pathParams) {
        for (const [key, value] of Object.entries(call.pathParams)) {
          if (value.includes('{')) {
            issues.push(`Unresolved path parameter: ${key}`);
          }
        }
      }
      
      // Check for required body fields
      if (call.method === "POST" && (!call.body || Object.keys(call.body).length === 0)) {
        issues.push("Missing request body for POST request");
      }
      
      // Validate endpoint is complete
      if (call.endpoint?.includes('{')) {
        const unresolvedParams = call.endpoint.match(/{(\w+)}/g);
        if (unresolvedParams && !call.pathParams) {
          issues.push(`Missing path parameters for: ${unresolvedParams.join(', ')}`);
        }
      }
      
      validationResults.push({
        call,
        valid: issues.length === 0,
        issues
      });
    }
    
    return {
      allValid: validationResults.every(r => r.valid),
      results: validationResults
    };
  }
}

export default ParameterExtractor;