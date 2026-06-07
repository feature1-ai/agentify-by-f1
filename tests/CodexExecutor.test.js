import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import CodexExecutor from '../src/executors/CodexExecutor.js';

describe('CodexExecutor Tests', () => {
  let executor;

  beforeEach(() => {
    process.env.CODEX_MAX_TOKENS = '2000';
    process.env.CODEX_TEMPERATURE = '0.5';

    executor = new CodexExecutor();
  });

  afterEach(() => {
    delete process.env.CODEX_MAX_TOKENS;
    delete process.env.CODEX_TEMPERATURE;
    delete process.env.CONTEXT_DIR;
  });

  test('should create CodexExecutor instance with default config', () => {
    expect(executor).toBeDefined();
    expect(executor.config.maxTokens).toBe(2000);
    expect(executor.config.temperature).toBe(0.5);
    expect(executor.config.workingDir).toMatch(/resources\/contexts$/);
  });

  test('should create CodexExecutor with custom config', () => {
    const customExecutor = new CodexExecutor({
      maxTokens: 3000,
      temperature: 0.8,
      timeout: 30000,
      workingDir: '/tmp/swagger'
    });

    expect(customExecutor.config.maxTokens).toBe(3000);
    expect(customExecutor.config.temperature).toBe(0.8);
    expect(customExecutor.config.timeout).toBe(30000);
    expect(customExecutor.config.workingDir).toBe('/tmp/swagger');
  });

  test('should resolve CONTEXT_DIR env var to absolute path', () => {
    process.env.CONTEXT_DIR = '/var/tmp/specs';
    const e = new CodexExecutor();
    expect(e.config.workingDir).toBe('/var/tmp/specs');
  });

  test('should build prompt with context', () => {
    const prompt = 'Generate a function';
    const context = {
      'requirements.txt': 'numpy==1.21.0',
      'config.json': { key: 'value' }
    };
    
    const fullPrompt = executor.buildPromptWithContext(prompt, context);
    
    expect(fullPrompt).toContain('## Context:');
    expect(fullPrompt).toContain('### requirements.txt:');
    expect(fullPrompt).toContain('numpy==1.21.0');
    expect(fullPrompt).toContain('### config.json:');
    expect(fullPrompt).toContain('"key": "value"');
    expect(fullPrompt).toContain('## Task:');
    expect(fullPrompt).toContain('Generate a function');
  });

  test('should build prompt without context', () => {
    const prompt = 'Generate a function';
    const fullPrompt = executor.buildPromptWithContext(prompt, {});
    
    expect(fullPrompt).toBe('## Task:\nGenerate a function');
  });

  test('should validate configuration', () => {
    const validExecutor = new CodexExecutor({
      maxTokens: 1000,
      temperature: 1.0
    });

    const validation = validExecutor.validateConfig();
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test('should detect invalid configuration', () => {
    const invalidExecutor = new CodexExecutor({
      maxTokens: 50000,
      temperature: 3.0,
      workingDir: ''
    });

    const validation = invalidExecutor.validateConfig();
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('maxTokens must be between 1 and 32000');
    expect(validation.errors).toContain('temperature must be between 0 and 2');
    expect(validation.errors).toContain('workingDir is not set');
  });

  test('should use default values when environment variables are not set', () => {
    delete process.env.CODEX_MAX_TOKENS;
    delete process.env.CODEX_TEMPERATURE;
    
    const executorDefaults = new CodexExecutor();
    
    expect(executorDefaults.config.maxTokens).toBe(4000);
    expect(executorDefaults.config.temperature).toBe(0.7);
  });

  test('should merge config options correctly', () => {
    const baseConfig = {
      maxTokens: 1000,
      temperature: 0.5
    };
    
    const executorBase = new CodexExecutor(baseConfig);
    expect(executorBase.config.maxTokens).toBe(1000);
    expect(executorBase.config.temperature).toBe(0.5);
  });

  test('should format complex context objects', () => {
    const context = {
      'nested': {
        deep: {
          value: 'test',
          array: [1, 2, 3]
        }
      },
      'simple': 'string value'
    };
    
    const fullPrompt = executor.buildPromptWithContext('Task', context);
    
    expect(fullPrompt).toContain('"deep":');
    expect(fullPrompt).toContain('"value": "test"');
    expect(fullPrompt).toContain('"array": [');
    expect(fullPrompt).toContain('string value');
  });
});