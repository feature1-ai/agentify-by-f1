import WorkflowRegistry from '../WorkflowRegistry.js';
import APIMatchingWorkflow from './APIMatchingWorkflow.js';
import logger from '../logger.js';

const AVAILABLE_WORKFLOWS = new Map([
  ['api-matching', APIMatchingWorkflow]
]);

/**
 * Optional allow-list: WORKFLOWS_ENABLED="a,b" limits which workflows get
 * registered. Unset or empty exposes everything in AVAILABLE_WORKFLOWS.
 */
export function resolveEnabledWorkflows(availableIds, envValue = process.env.WORKFLOWS_ENABLED) {
  const requested = (envValue || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (requested.length === 0) {
    return [...availableIds];
  }

  const unknown = requested.filter((id) => !availableIds.includes(id));
  if (unknown.length > 0) {
    logger.warn(`Ignoring unknown workflows from WORKFLOWS_ENABLED: ${unknown.join(', ')}`);
  }

  return requested.filter((id) => availableIds.includes(id));
}

export function registerWorkflows() {
  const enabled = resolveEnabledWorkflows(Array.from(AVAILABLE_WORKFLOWS.keys()));

  enabled.forEach((workflowId) => {
    WorkflowRegistry.register(workflowId, AVAILABLE_WORKFLOWS.get(workflowId));
  });

  logger.info(`Registered workflows: ${enabled.join(', ') || '(none)'}`);
  return enabled;
}

export { APIMatchingWorkflow };
export default registerWorkflows;
