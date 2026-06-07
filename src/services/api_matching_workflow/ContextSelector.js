import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONTEXT_DIR = path.join(__dirname, '../../../resources/contexts');
const RULES_FILENAME = 'context-rules.json';

function resolveContextDir() {
  const value = process.env.CONTEXT_DIR;
  if (!value) return DEFAULT_CONTEXT_DIR;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

/**
 * ContextSelector — selects which OpenAPI spec files are relevant for a request.
 *
 * Default behavior (no config): treat every *.json in CONTEXT_DIR as a candidate
 * spec and return all of them. The LLM does the heavy lifting downstream.
 *
 * Optional: drop a `context-rules.json` in CONTEXT_DIR to define keyword→file
 * scoring and multi-file scenario patterns. Shape:
 *
 * {
 *   "services": {
 *     "<filename>.json": {
 *       "keywords": ["..."],
 *       "actions":  ["..."],
 *       "priority": 1
 *     }
 *   },
 *   "scenarios": [
 *     { "pattern": "refund|chargeback", "contexts": ["a.json", "b.json"], "description": "..." }
 *   ]
 * }
 */
export class ContextSelector {
  constructor(codexExecutor = null) {
    this.codexExecutor = codexExecutor;
    this.serviceKeywords = {};
    this.scenarioPatterns = [];
    this.rulesLoaded = false;
    this.loadRulesSync();
  }

  loadRulesSync() {
    const rulesPath = path.join(resolveContextDir(), RULES_FILENAME);
    try {
      if (!fsSync.existsSync(rulesPath)) return;
      const raw = fsSync.readFileSync(rulesPath, 'utf-8');
      const rules = JSON.parse(raw);
      this.serviceKeywords = rules.services || {};
      this.scenarioPatterns = (rules.scenarios || []).map(s => ({
        pattern: new RegExp(s.pattern, 'i'),
        contexts: s.contexts || [],
        description: s.description || ''
      }));
      this.rulesLoaded = true;
      logger.info(`ContextSelector: loaded ${Object.keys(this.serviceKeywords).length} service rules + ${this.scenarioPatterns.length} scenarios from ${RULES_FILENAME}`);
    } catch (error) {
      logger.warn(`ContextSelector: failed to load ${RULES_FILENAME}, falling back to auto-discover: ${error.message}`);
    }
  }

  async selectContexts(userInput) {
    try {
      const inputStr = typeof userInput === 'string' ? userInput : String(userInput || '');
      const input = inputStr.toLowerCase();

      if (this.rulesLoaded) {
        const scenario = this.detectScenario(input);
        if (scenario) {
          logger.info(`ContextSelector: scenario matched — ${scenario.description}`);
          return scenario.contexts;
        }
        const scored = this.keywordBasedSelection(input);
        if (scored.length > 0) return scored;
      }

      return this.listAllSpecs();
    } catch (error) {
      logger.error('Context selection failed:', error);
      return this.listAllSpecs();
    }
  }

  detectScenario(input) {
    for (const scenario of this.scenarioPatterns) {
      if (scenario.pattern.test(input)) return scenario;
    }
    return null;
  }

  keywordBasedSelection(input) {
    const scores = {};
    for (const [file, config] of Object.entries(this.serviceKeywords)) {
      let score = 0;
      for (const keyword of config.keywords || []) {
        if (input.includes(keyword.toLowerCase())) score += 2;
      }
      for (const action of config.actions || []) {
        if (input.includes(action.toLowerCase())) score += 3;
      }
      const priority = config.priority ?? 5;
      score *= Math.max(1, 6 - priority);
      if (score > 0) scores[file] = score;
    }
    return Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .map(([file]) => file)
      .slice(0, 3);
  }

  async listAllSpecs() {
    try {
      const contextPath = resolveContextDir();
      const files = await fs.readdir(contextPath);
      return files.filter(f =>
        f.endsWith('.json') &&
        !f.startsWith('.') &&
        f !== RULES_FILENAME
      );
    } catch (error) {
      logger.error('Failed to list spec files:', error);
      return [];
    }
  }

  async loadAllContexts() {
    try {
      const contextPath = resolveContextDir();
      const swaggerFiles = await this.listAllSpecs();

      const contexts = {};
      for (const file of swaggerFiles) {
        try {
          const content = await fs.readFile(path.join(contextPath, file), 'utf-8');
          contexts[file] = JSON.parse(content);
        } catch (error) {
          logger.warn(`Failed to load ${file}:`, error.message);
        }
      }
      return contexts;
    } catch (error) {
      logger.error('Failed to load contexts:', error);
      return {};
    }
  }

  async getRecommendations(userInput) {
    if (!this.rulesLoaded) return [];
    const input = userInput.toLowerCase();
    const recommendations = [];
    for (const [service, config] of Object.entries(this.serviceKeywords)) {
      let confidence = 0;
      const matches = { keywords: [], actions: [] };
      for (const keyword of config.keywords || []) {
        if (input.includes(keyword.toLowerCase())) {
          matches.keywords.push(keyword);
          confidence += 0.2;
        }
      }
      for (const action of config.actions || []) {
        if (input.includes(action.toLowerCase())) {
          matches.actions.push(action);
          confidence += 0.3;
        }
      }
      if (confidence > 0) {
        recommendations.push({
          service,
          confidence: Math.min(confidence, 1),
          matches,
          priority: config.priority ?? 5
        });
      }
    }
    recommendations.sort((a, b) =>
      b.confidence !== a.confidence ? b.confidence - a.confidence : a.priority - b.priority
    );
    return recommendations;
  }
}

export default ContextSelector;
