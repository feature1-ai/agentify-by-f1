import WorkflowRegistry from '../services/WorkflowRegistry.js';
import APIMatchingWorkflow from './APIMatchingWorkflow.js';
import logger from '../utils/logger.js';
import { resolveExposedWorkflows } from '../config/workflowPolicy.js';

export function registerWorkflows() {
  try {
    const availableWorkflows = new Map([
      ['api-matching', APIMatchingWorkflow]
    ]);

    const { enabledWorkflows } = resolveExposedWorkflows(Array.from(availableWorkflows.keys()));

    enabledWorkflows.forEach((workflowId) => {
      const WorkflowClass = availableWorkflows.get(workflowId);
      if (WorkflowClass) {
        WorkflowRegistry.register(workflowId, WorkflowClass);
      }
    });
    
    logger.info('Registered all workflows successfully');
    return true;
  } catch (error) {
    logger.error('Failed to register workflows:', error);
    return false;
  }
}

export { APIMatchingWorkflow };
export default registerWorkflows;
