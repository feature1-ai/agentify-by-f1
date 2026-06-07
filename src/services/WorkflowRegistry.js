import logger from '../utils/logger.js';
import { isRemovedWorkflow } from '../config/workflowPolicy.js';

class WorkflowRegistry {
  constructor() {
    this.workflows = new Map();
    this.instances = new Map();
  }

  register(workflowId, WorkflowClass) {
    if (!workflowId || typeof workflowId !== 'string') {
      throw new Error('Workflow ID must be a non-empty string');
    }

    if (isRemovedWorkflow(workflowId)) {
      logger.warn(`Attempted to register removed workflow: ${workflowId}`);
      return false;
    }
    
    if (typeof WorkflowClass !== 'function') {
      throw new Error('WorkflowClass must be a constructor function');
    }
    
    this.workflows.set(workflowId, WorkflowClass);
    logger.info(`Registered workflow: ${workflowId}`);
    return true;
  }

  unregister(workflowId) {
    const deleted = this.workflows.delete(workflowId);
    if (deleted) {
      logger.info(`Unregistered workflow: ${workflowId}`);
    }
    return deleted;
  }

  get(workflowId) {
    return this.workflows.get(workflowId);
  }

  has(workflowId) {
    return this.workflows.has(workflowId);
  }

  list() {
    return Array.from(this.workflows.keys());
  }

  createInstance(workflowId, config = {}) {
    const WorkflowClass = this.workflows.get(workflowId);
    
    if (!WorkflowClass) {
      throw new Error(`Workflow ${workflowId} not found in registry`);
    }
    
    const instanceId = `${workflowId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const instance = new WorkflowClass(instanceId, config);
    
    this.instances.set(instanceId, {
      workflowId,
      instance,
      createdAt: new Date().toISOString(),
      status: 'created'
    });
    
    logger.info(`Created workflow instance: ${instanceId}`);
    return { instanceId, instance };
  }

  getInstance(instanceId) {
    const instanceData = this.instances.get(instanceId);
    return instanceData ? instanceData.instance : null;
  }

  getInstanceData(instanceId) {
    return this.instances.get(instanceId);
  }

  updateInstanceStatus(instanceId, status) {
    const instanceData = this.instances.get(instanceId);
    if (instanceData) {
      instanceData.status = status;
      instanceData.updatedAt = new Date().toISOString();
    }
  }

  updateInstanceData(instanceId, updates = {}) {
    const instanceData = this.instances.get(instanceId);
    if (!instanceData) {
      return false;
    }
    Object.assign(instanceData, updates);
    instanceData.updatedAt = new Date().toISOString();
    return true;
  }

  addInstanceRecord(instanceId, record = {}) {
    if (!instanceId || typeof instanceId !== 'string') {
      throw new Error('Instance ID must be a non-empty string');
    }
    const { workflowId } = record;
    if (!workflowId || typeof workflowId !== 'string') {
      throw new Error('Workflow ID must be a non-empty string');
    }

    const createdAt = record.createdAt || new Date().toISOString();
    this.instances.set(instanceId, {
      workflowId,
      instance: record.instance || null,
      status: record.status || 'created',
      createdAt,
      updatedAt: record.updatedAt || createdAt,
      input: record.input,
      context: record.context,
      config: record.config
    });
    return true;
  }

  deleteInstance(instanceId) {
    return this.instances.delete(instanceId);
  }

  listInstances(workflowId = null) {
    const instances = [];
    for (const [id, data] of this.instances) {
      if (!workflowId || data.workflowId === workflowId) {
        instances.push({
          instanceId: id,
          workflowId: data.workflowId,
          status: data.status,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt
        });
      }
    }
    return instances;
  }

  clear() {
    this.workflows.clear();
    this.instances.clear();
    logger.info('Cleared workflow registry');
  }
}

export default new WorkflowRegistry();
