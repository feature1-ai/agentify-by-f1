import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import logger from '../../logger.js';
import { resolveContextDir } from '../../contextDir.js';

const RULES_FILENAME = 'context-rules.json';

/**
 * ContextSelector — selects which OpenAPI spec files are relevant for a request.
 *
 * Default behavior (no config): treat every *.json in CONTEXT_DIR as a candidate
 * spec and return all of them. The LLM does the heavy lifting downstream.
 *
 * Optional: drop a `context-rules.json` in CONTEXT_DIR to define keyword→file
 * scoring and multi-file scenario patterns — useful when the spec set is large
 * enough that sending all of them blows the model's context window. Shape:
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
  constructor() {
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

  /**
   * Returns the spec filenames to load for this request: scenario match first,
   * then keyword scoring, then (no rules / no match) every spec in the dir.
   */
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

  /**
   * Load the given spec files (filename → parsed content). Unreadable files
   * are skipped with a warning rather than failing the whole request.
   */
  async loadContexts(files) {
    const contextPath = resolveContextDir();
    const contexts = {};
    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(contextPath, file), 'utf-8');
        contexts[file] = JSON.parse(content);
      } catch (error) {
        logger.warn(`Failed to load ${file}:`, error.message);
      }
    }
    return contexts;
  }
}

export default ContextSelector;
