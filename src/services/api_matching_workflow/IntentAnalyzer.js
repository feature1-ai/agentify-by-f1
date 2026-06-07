import logger from '../../utils/logger.js';

/**
 * IntentAnalyzer - Responsible for analyzing user input and extracting intent
 * Single Responsibility: Intent extraction and risk assessment
 */
export class IntentAnalyzer {
  constructor(codexExecutor = null) {
    this.codexExecutor = codexExecutor;
  }

  /**
   * Analyze user input and extract structured intent
   */
  async analyze(userInput, context = {}) {
    logger.info("Analyzing user intent");
    
    if (this.codexExecutor) {
      try {
        return await this.aiBasedAnalysis(userInput, context);
      } catch (error) {
        logger.warn("AI analysis failed, falling back to pattern matching", error);
        return this.patternBasedAnalysis(userInput);
      }
    }
    
    return this.patternBasedAnalysis(userInput);
  }

  /**
   * Use AI to analyze intent
   */
  async aiBasedAnalysis(userInput, context) {
    const intentPrompt = `
You have access to OpenAPI / Swagger documentation in the current directory.
Examine the available *.json spec files to understand what operations and resources exist.

Analyze this user request and extract the intent:
"${userInput}"

Extract:
1. Action (create, update, delete, get, list, etc.) - reference available API operations
2. Target resource - match it to the schemas defined in the available Swagger specs
3. Specific entities mentioned (names, IDs, etc.)
4. Any conditions or filters
5. Risk level (low, medium, high) - consider data modification, security impact based on available operations

Return as JSON:
{
  "action": "...",
  "resource": "...",
  "entities": [...],
  "conditions": {...},
  "riskLevel": "medium"
}`;

    const result = await this.codexExecutor.execute(
      intentPrompt,
      context,
      { temperature: 0.3 }
    );
    
    return JSON.parse(result.output);
  }

  /**
   * Pattern-based intent extraction (fallback)
   */
  patternBasedAnalysis(input) {
    // Ensure input is a string
    const inputStr = typeof input === 'string' ? input : String(input || '');
    const lowercaseInput = inputStr.toLowerCase();
    
    const intent = {
      action: this.extractAction(lowercaseInput),
      resource: this.extractResource(lowercaseInput),
      entities: this.extractEntities(inputStr),
      conditions: {},
      riskLevel: "low"
    };
    
    // Assess risk level
    intent.riskLevel = this.assessRiskLevel(intent.action, intent.resource);
    
    return intent;
  }

  extractAction(input) {
    const actions = {
      disable: ["disable", "turn off", "deactivate", "block"],
      enable: ["enable", "turn on", "activate", "allow"],
      create: ["create", "add", "new", "make"],
      delete: ["delete", "remove", "destroy", "erase"],
      update: ["update", "modify", "change", "edit"],
      get: ["get", "show", "view", "display", "fetch"],
      list: ["list", "all", "show all", "enumerate"]
    };
    
    for (const [action, keywords] of Object.entries(actions)) {
      if (keywords.some(keyword => input.includes(keyword))) {
        return action;
      }
    }
    
    return "unknown";
  }

  extractResource(input) {
    // Generic resource keywords for the rule-based fallback (petstore sample).
    const resources = {
      pet: ["pet", "animal", "dog", "cat"],
      user: ["user", "account", "profile", "customer"],
      order: ["order", "purchase", "checkout"],
      store: ["store", "inventory", "stock"]
    };
    
    for (const [resource, keywords] of Object.entries(resources)) {
      if (keywords.some(keyword => input.includes(keyword))) {
        return resource;
      }
    }
    
    return "unknown";
  }

  extractEntities(input) {
    const entities = [];
    
    // Extract user references
    const userPattern = /user\d+|user\s+\w+|@\w+/gi;
    const userMatches = input.match(userPattern);
    if (userMatches) {
      entities.push(...userMatches.map(m => m.replace(/[@\s]/g, '').replace(/^user/, 'user')));
    }
    
    // Extract IDs (UUIDs, numeric IDs)
    const idPattern = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b|\b\d{6,}\b/gi;
    const idMatches = input.match(idPattern);
    if (idMatches) {
      entities.push(...idMatches);
    }
    
    // Extract email addresses
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    const emailMatches = input.match(emailPattern);
    if (emailMatches) {
      entities.push(...emailMatches);
    }
    
    return entities;
  }

  assessRiskLevel(action, resource) {
    // High risk operations
    if (action === "delete") return "high";
    if (action === "disable" && ["account", "auth", "security"].includes(resource)) return "high";

    // Medium risk operations
    if (["update", "disable", "enable"].includes(action)) return "medium";
    if (["create"].includes(action) && ["user", "account", "role"].includes(resource)) return "medium";
    
    // Default to low risk
    return "low";
  }

  /**
   * Validate intent structure
   */
  validateIntent(intent) {
    const required = ["action", "resource", "riskLevel"];
    const missing = required.filter(field => !intent[field] || intent[field] === "unknown");
    
    return {
      valid: missing.length === 0,
      missing,
      intent
    };
  }
}

export default IntentAnalyzer;