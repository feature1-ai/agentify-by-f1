import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import BaseWorkflow from '../src/core/BaseWorkflow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('BaseWorkflow Tests', () => {
  let testWorkflow;
  const testContextPath = path.join(__dirname, '..', 'resources', 'contexts');
  const testTemplatePath = path.join(__dirname, '..', 'resources', 'templates');

  beforeAll(async () => {
    await fs.mkdir(testContextPath, { recursive: true });
    await fs.mkdir(testTemplatePath, { recursive: true });
    
    await fs.writeFile(
      path.join(testContextPath, 'test.json'),
      JSON.stringify({ key: 'value', test: true })
    );
    
    await fs.writeFile(
      path.join(testContextPath, 'test.txt'),
      'This is test context data'
    );
    
    await fs.writeFile(
      path.join(testTemplatePath, 'test-template.txt'),
      'Template: {{input}}'
    );
  });

  afterAll(async () => {
    try {
      await fs.unlink(path.join(testContextPath, 'test.json'));
      await fs.unlink(path.join(testContextPath, 'test.txt'));
      await fs.unlink(path.join(testTemplatePath, 'test-template.txt'));
    } catch (error) {
      // Files may not exist if test failed
    }
  });

  test('should create BaseWorkflow instance', () => {
    testWorkflow = new BaseWorkflow('test-workflow');
    expect(testWorkflow).toBeDefined();
    expect(testWorkflow.workflowId).toBe('test-workflow');
    expect(testWorkflow.config.maxRetries).toBe(3);
    expect(testWorkflow.config.timeout).toBe(30000);
  });

  test('should load JSON context files', async () => {
    testWorkflow = new BaseWorkflow('test-workflow');
    const context = await testWorkflow.loadContext(['test.json']);
    
    expect(context['test.json']).toBeDefined();
    expect(context['test.json'].key).toBe('value');
    expect(context['test.json'].test).toBe(true);
  });

  test('should load text context files', async () => {
    testWorkflow = new BaseWorkflow('test-workflow');
    const context = await testWorkflow.loadContext(['test.txt']);
    
    expect(context['test.txt']).toBeDefined();
    expect(context['test.txt']).toBe('This is test context data');
  });

  test('should load multiple context files', async () => {
    testWorkflow = new BaseWorkflow('test-workflow');
    const context = await testWorkflow.loadContext(['test.json', 'test.txt']);
    
    expect(Object.keys(context).length).toBe(2);
    expect(context['test.json']).toBeDefined();
    expect(context['test.txt']).toBeDefined();
  });

  test('should load template', async () => {
    testWorkflow = new BaseWorkflow('test-workflow');
    const template = await testWorkflow.loadTemplate('test-template');
    
    expect(template).toBe('Template: {{input}}');
  });

  test('should build workflow graph', () => {
    testWorkflow = new BaseWorkflow('test-workflow');
    const graph = testWorkflow.buildGraph();
    
    expect(graph).toBeDefined();
    expect(testWorkflow.graph).toBeDefined();
  });

  test('should handle workflow execution', async () => {
    testWorkflow = new BaseWorkflow('test-workflow');
    await testWorkflow.loadContext(['test.json']);
    
    const result = await testWorkflow.execute('test input');
    
    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0].content).toBe('test input');
    expect(result.metadata.workflowId).toBe('test-workflow');
    expect(result.metadata.startTime).toBeDefined();
    expect(result.metadata.endTime).toBeDefined();
  });

  test('should handle custom configuration', () => {
    const customConfig = {
      maxRetries: 5,
      timeout: 60000,
      customParam: 'custom'
    };
    
    testWorkflow = new BaseWorkflow('custom-workflow', customConfig);
    
    expect(testWorkflow.config.maxRetries).toBe(5);
    expect(testWorkflow.config.timeout).toBe(60000);
    expect(testWorkflow.config.customParam).toBe('custom');
  });

  test('should handle errors gracefully', async () => {
    testWorkflow = new BaseWorkflow('error-workflow');
    
    await expect(
      testWorkflow.loadContext(['non-existent.json'])
    ).rejects.toThrow();
  });

  test('should route correctly based on state', () => {
    testWorkflow = new BaseWorkflow('routing-workflow');
    
    const errorState = { errors: ['test error'], messages: [] };
    expect(testWorkflow.routeFromProcessInput(errorState)).toBe('error');
    
    const emptyState = { errors: [], messages: [] };
    expect(testWorkflow.routeFromProcessInput(emptyState)).toBe('end');
    
    const normalState = { errors: [], messages: ['test'] };
    expect(testWorkflow.routeFromProcessInput(normalState)).toBe('execute');
  });
});