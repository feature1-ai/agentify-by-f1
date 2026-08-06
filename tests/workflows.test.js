import { describe, test, expect } from '@jest/globals';
import { resolveEnabledWorkflows } from '../src/workflows/index.js';

describe('Workflow enablement (WORKFLOWS_ENABLED)', () => {
  const available = ['api-matching', 'other-workflow'];

  test('unset or empty exposes all available workflows', () => {
    expect(resolveEnabledWorkflows(available, undefined)).toEqual(available);
    expect(resolveEnabledWorkflows(available, '')).toEqual(available);
    expect(resolveEnabledWorkflows(available, '  ')).toEqual(available);
  });

  test('allow-list limits registration to the listed workflows', () => {
    expect(resolveEnabledWorkflows(available, 'api-matching')).toEqual(['api-matching']);
  });

  test('unknown ids in the allow-list are ignored', () => {
    expect(resolveEnabledWorkflows(available, 'api-matching, bogus')).toEqual(['api-matching']);
    expect(resolveEnabledWorkflows(available, 'bogus')).toEqual([]);
  });
});
