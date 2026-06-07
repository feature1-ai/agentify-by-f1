import logger from '../utils/logger.js';

const REMOVED_WORKFLOWS = new Set(['code-generation']);
const FEATURE_FLAG_KEYS = ['WORKFLOWS_ENABLED', 'WORKFLOW_FEATURE_FLAGS', 'ENABLED_WORKFLOWS'];

const normalizeWorkflowId = (workflowId) => workflowId.trim();

const parseWorkflowList = (value) => {
  if (!value || typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const unique = (items) => Array.from(new Set(items));

const getRequestedWorkflowsFromEnv = () => {
  const requested = FEATURE_FLAG_KEYS.flatMap((key) => parseWorkflowList(process.env[key]));
  return unique(requested.map(normalizeWorkflowId));
};

export const isRemovedWorkflow = (workflowId) => REMOVED_WORKFLOWS.has(workflowId);

export const resolveExposedWorkflows = (availableWorkflows = []) => {
  const requestedWorkflows = getRequestedWorkflowsFromEnv();
  const candidates = requestedWorkflows.length > 0 ? requestedWorkflows : availableWorkflows;

  const removed = candidates.filter(isRemovedWorkflow);
  if (removed.length > 0) {
    logger.warn(`Removed workflows cannot be exposed: ${removed.join(', ')}`);
  }

  const filtered = candidates.filter((workflowId) => !isRemovedWorkflow(workflowId));
  const unknown = filtered.filter((workflowId) => !availableWorkflows.includes(workflowId));
  if (unknown.length > 0) {
    logger.warn(`Ignoring unknown workflows from configuration: ${unknown.join(', ')}`);
  }

  const enabledWorkflows = filtered.filter((workflowId) => availableWorkflows.includes(workflowId));

  return {
    enabledWorkflows,
    removedWorkflows: removed,
    unknownWorkflows: unknown,
    requestedWorkflows
  };
};

export const workflowPolicy = {
  removedWorkflows: REMOVED_WORKFLOWS,
  featureFlagKeys: FEATURE_FLAG_KEYS
};

export default workflowPolicy;
