import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import app from '../src/index.js';
import WorkflowRegistry from '../src/WorkflowRegistry.js';
import BaseWorkflow from '../src/workflows/BaseWorkflow.js';

class TestWorkflow extends BaseWorkflow {
  async executeActionNode(state) {
    return {
      ...state,
      currentNode: "executeAction",
      messages: [...state.messages, { role: 'assistant', content: 'Test response' }],
      metadata: {
        ...state.metadata,
        complete: true,
        testExecuted: true
      }
    };
  }
}

// Captures the config it was constructed with so tests can assert that
// per-request credentials reach the live workflow instance.
let lastCredConfig = null;
class CredentialCaptureWorkflow extends BaseWorkflow {
  constructor(workflowId, config = {}) {
    super(workflowId, config);
    lastCredConfig = config;
  }
  async executeActionNode(state) {
    return {
      ...state,
      currentNode: "executeAction",
      metadata: { ...state.metadata, complete: true }
    };
  }
}

describe('API Tests', () => {
  let server;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    WorkflowRegistry.register('test-workflow', TestWorkflow);
    WorkflowRegistry.register('cred-workflow', CredentialCaptureWorkflow);
    process.env.API_KEY = 'test-api-key';
  });

  afterAll((done) => {
    WorkflowRegistry.clear();
    if (server && server.close) {
      server.close(done);
    } else {
      done();
    }
  });

  test('GET /health should return health status', async () => {
    const response = await request(app)
      .get('/health')
      .set('X-API-Key', 'test-api-key');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.status).toBe('healthy');
    expect(response.body.timestamp).toBeDefined();
  });

  test('GET /api/workflows should list registered workflows', async () => {
    const response = await request(app)
      .get('/api/workflows')
      .set('X-API-Key', 'test-api-key');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.workflows).toContain('test-workflow');
    expect(response.body.workflows).toContain('api-matching');
    expect(response.body.count).toBe(3);
  });

  test('WorkflowRegistry.list should include registered workflows', () => {
    const workflows = WorkflowRegistry.list();
    expect(workflows).toContain('test-workflow');
    expect(workflows).toContain('api-matching');
  });

  test('GET /api/workflows/:workflowId should return workflow details', async () => {
    const response = await request(app)
      .get('/api/workflows/test-workflow')
      .set('X-API-Key', 'test-api-key');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.workflowId).toBe('test-workflow');
    expect(response.body.instances).toBeDefined();
  });

  test('GET /api/workflows/:workflowId should return 404 for non-existent workflow', async () => {
    const response = await request(app)
      .get('/api/workflows/non-existent')
      .set('X-API-Key', 'test-api-key');

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('not found');
  });

  test('POST /api/workflows/execute should execute workflow', async () => {
    const response = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'test-workflow',
        input: 'test input'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.instanceId).toBeDefined();
    expect(response.body.result).toBeDefined();
    expect(response.body.result.metadata.testExecuted).toBe(true);
  });

  test('POST /api/workflows/execute should validate required fields', async () => {
    const response = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'test-workflow'
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('required');
  });

  test('POST /api/workflows/execute should return 404 for non-existent workflow', async () => {
    const response = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'non-existent',
        input: 'test'
      });

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('not found');
  });

  test('GET /api/instances should list workflow instances', async () => {
    await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'test-workflow',
        input: 'test'
      });

    const response = await request(app)
      .get('/api/instances')
      .set('X-API-Key', 'test-api-key');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.instances).toBeDefined();
    expect(response.body.count).toBeGreaterThan(0);
  });

  test('GET /api/instances/:instanceId should return instance details', async () => {
    const executeResponse = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'test-workflow',
        input: 'test'
      });

    const instanceId = executeResponse.body.instanceId;

    const response = await request(app)
      .get(`/api/instances/${instanceId}`)
      .set('X-API-Key', 'test-api-key');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.instance.instanceId).toBe(instanceId);
    expect(response.body.instance.workflowId).toBe('test-workflow');
    expect(response.body.instance.status).toBe('completed');
  });

  test('DELETE /api/instances/:instanceId should delete instance', async () => {
    const executeResponse = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'test-workflow',
        input: 'test'
      });

    const instanceId = executeResponse.body.instanceId;

    const response = await request(app)
      .delete(`/api/instances/${instanceId}`)
      .set('X-API-Key', 'test-api-key');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toContain('deleted successfully');

    const getResponse = await request(app)
      .get(`/api/instances/${instanceId}`)
      .set('X-API-Key', 'test-api-key');

    expect(getResponse.status).toBe(404);
  });

  test('API should reject requests without valid API key', async () => {
    const response = await request(app)
      .get('/api/workflows')
      .set('X-API-Key', 'wrong-key');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('Invalid API key');
  });

  test('404 handler should work for non-existent routes', async () => {
    const response = await request(app)
      .get('/non-existent-route')
      .set('X-API-Key', 'test-api-key');

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('not found');
  });

  test('execute forwards per-request credentials into config.rest', async () => {
    lastCredConfig = null;
    const response = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'cred-workflow',
        input: 'hi',
        credentials: {
          baseUrl: 'https://api.example.com',
          authHeaderName: 'Authorization',
          authHeaderValue: 'Bearer super-secret'
        }
      });

    expect(response.status).toBe(200);
    // The live instance is constructed with the REAL credential...
    expect(lastCredConfig.rest.baseUrl).toBe('https://api.example.com');
    expect(lastCredConfig.rest.authHeaderName).toBe('Authorization');
    expect(lastCredConfig.rest.authHeaderValue).toBe('Bearer super-secret');

    // ...but the display copy persisted on the instance record is redacted.
    const stored = WorkflowRegistry.getInstanceData(response.body.instanceId);
    expect(stored.config.rest.baseUrl).toBe('https://api.example.com');
    expect(stored.config.rest.authHeaderValue).toBe('***redacted***');
  });

  test('retry reuses the live credentials, not the redacted display copy', async () => {
    const executeResponse = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'cred-workflow',
        input: 'hi',
        credentials: {
          baseUrl: 'https://api.example.com',
          authHeaderName: 'Authorization',
          authHeaderValue: 'Bearer super-secret'
        }
      });

    lastCredConfig = null;
    const retryResponse = await request(app)
      .post(`/api/instances/${executeResponse.body.instanceId}/retry`)
      .set('X-API-Key', 'test-api-key');

    expect(retryResponse.status).toBe(200);
    expect(retryResponse.body.retriedFrom).toBe(executeResponse.body.instanceId);
    expect(lastCredConfig.rest.authHeaderValue).toBe('Bearer super-secret');
  });

  test('execute rejects malformed credentials', async () => {
    const response = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'cred-workflow',
        input: 'hi',
        credentials: { baseUrl: 'not-a-valid-url' }
      });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  test('approve endpoint returns 400 for workflows without approval support', async () => {
    const executeResponse = await request(app)
      .post('/api/workflows/execute')
      .set('X-API-Key', 'test-api-key')
      .send({
        workflowId: 'test-workflow',
        input: 'test'
      });

    const instanceId = executeResponse.body.instanceId;
    const priorStatus = WorkflowRegistry.getInstanceData(instanceId).status;

    const response = await request(app)
      .post(`/api/workflows/${instanceId}/approve`)
      .set('X-API-Key', 'test-api-key')
      .send({ decision: 'approved' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    // status must be restored, not left stuck on 'running'
    expect(WorkflowRegistry.getInstanceData(instanceId).status).toBe(priorStatus);
  });

  test('GET / serves the chat UI without requiring an API key', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('agentify-by-f1');
    expect(response.text).toContain('Settings');
  });
});
