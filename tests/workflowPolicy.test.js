import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import WorkflowRegistry from '../src/services/WorkflowRegistry.js';
import BaseWorkflow from '../src/core/BaseWorkflow.js';
import { resolveExposedWorkflows } from '../src/config/workflowPolicy.js';

const snapshotEnv = () => ({ ...process.env });

const restoreEnv = (snapshot) => {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, snapshot);
};

describe('Workflow exposure policy', () => {
  let envSnapshot;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    WorkflowRegistry.clear();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    WorkflowRegistry.clear();
  });

  test('feature flags cannot re-enable removed workflows', () => {
    process.env.WORKFLOWS_ENABLED = 'code-generation,api-matching';

    const result = resolveExposedWorkflows(['api-matching']);

    expect(result.enabledWorkflows).toEqual(['api-matching']);
    expect(result.removedWorkflows).toContain('code-generation');
  });

  test('registry refuses to register removed workflows', () => {
    const registered = WorkflowRegistry.register('code-generation', BaseWorkflow);

    expect(registered).toBe(false);
    expect(WorkflowRegistry.has('code-generation')).toBe(false);
  });
});
