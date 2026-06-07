import express from 'express';
import Joi from 'joi';
import WorkflowRegistry from '../services/WorkflowRegistry.js';
import { isRemovedWorkflow } from '../config/workflowPolicy.js';
import logger from '../utils/logger.js';
import { recordAuditEvent } from '../observability/auditStore.js';
import { incrementCounter } from '../observability/telemetryStore.js';

const router = express.Router();

const UNSUPPORTED_REASON = 'unsupported-workflow';

const buildUnsupportedWorkflowPayload = ({ workflowId, instanceId } = {}) => ({
  success: false,
  error: 'Unsupported workflow',
  code: UNSUPPORTED_REASON,
  message: 'Unsupported workflow',
  status: UNSUPPORTED_REASON,
  ...(workflowId && { workflowId }),
  ...(instanceId && { instanceId })
});

const rejectRemovedWorkflow = (res, workflowId) => {
  if (isRemovedWorkflow(workflowId)) {
    return res.status(404).json({
      success: false,
      error: `Workflow ${workflowId} not found`
    });
  }
  return null;
};

const recordUnsupportedWorkflow = ({ workflowId, endpoint }) => {
  recordAuditEvent({
    action: 'workflow_rejected',
    workflowId,
    reason: UNSUPPORTED_REASON,
    endpoint
  });
  incrementCounter('workflow_rejected', {
    workflowId,
    reason: UNSUPPORTED_REASON,
    endpoint
  });
};

/**
 * Per-request downstream credentials. Lets a multi-user SPA pass the
 * end-user's own REST API auth (their bearer token, their base URL) instead
 * of relying on the server-wide BASE_URL / AUTH_HEADER_* env defaults.
 * Merged into config.rest, which RestExecutor reads — per-request values
 * override the env defaults; anything omitted falls back to env.
 */
const credentialsSchema = Joi.object({
  baseUrl: Joi.string().uri().optional(),
  authHeaderName: Joi.string().optional(),
  authHeaderValue: Joi.string().optional()
}).optional();

const applyCredentials = (config = {}, credentials) => {
  if (!credentials || Object.keys(credentials).length === 0) {
    return config || {};
  }
  return {
    ...(config || {}),
    rest: { ...((config || {}).rest || {}), ...credentials }
  };
};

// The live RestExecutor keeps the real credential; the copy stored on the
// in-memory instance record is redacted so secrets never sit in /instances.
const redactConfig = (config = {}) => {
  if (!config || config.rest?.authHeaderValue === undefined) {
    return config;
  }
  return {
    ...config,
    rest: { ...config.rest, authHeaderValue: '***redacted***' }
  };
};

const executeSchema = Joi.object({
  workflowId: Joi.string().required(),
  input: Joi.any().required(),
  context: Joi.object().optional(),
  config: Joi.object().optional(),
  credentials: credentialsSchema,
  webhookUrl: Joi.string().uri().optional(),
  async: Joi.boolean().optional().default(false)
});

const streamSchema = Joi.object({
  workflowId: Joi.string().required(),
  input: Joi.any().required(),
  context: Joi.object().optional(),
  config: Joi.object().optional(),
  credentials: credentialsSchema
});

const approvalSchema = Joi.object({
  decision: Joi.string().valid('approved', 'rejected', 'approve', 'reject').required(),
  timestamp: Joi.string().optional()
});

router.get('/workflows', (req, res) => {
  try {
    const workflows = WorkflowRegistry.list().filter(
      (workflowId) => !isRemovedWorkflow(workflowId)
    );
    res.json({
      success: true,
      workflows,
      count: workflows.length
    });
  } catch (error) {
    logger.error('Error listing workflows:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/workflows/:workflowId', (req, res) => {
  try {
    const { workflowId } = req.params;
    if (isRemovedWorkflow(workflowId)) {
      recordUnsupportedWorkflow({ workflowId, endpoint: 'execute' });
      return rejectRemovedWorkflow(res, workflowId);
    }
    const exists = WorkflowRegistry.has(workflowId);
    
    if (!exists) {
      return res.status(404).json({
        success: false,
        error: `Workflow ${workflowId} not found`
      });
    }
    
    const instances = WorkflowRegistry.listInstances(workflowId);
    
    res.json({
      success: true,
      workflowId,
      instances,
      instanceCount: instances.length
    });
  } catch (error) {
    logger.error('Error getting workflow:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/workflows/execute', async (req, res) => {
  try {
    const { error, value } = executeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }
    
    const { workflowId, input, context, config, credentials, webhookUrl, async } = value;

    if (isRemovedWorkflow(workflowId)) {
      recordUnsupportedWorkflow({ workflowId, endpoint: 'execute' });
      return rejectRemovedWorkflow(res, workflowId);
    }

    if (!WorkflowRegistry.has(workflowId)) {
      return res.status(404).json({
        success: false,
        error: `Workflow ${workflowId} not found`
      });
    }

    const instanceConfig = applyCredentials(config, credentials);
    const { instanceId, instance } = WorkflowRegistry.createInstance(workflowId, instanceConfig);
    WorkflowRegistry.updateInstanceData(instanceId, { input, context, config: redactConfig(instanceConfig), webhookUrl });
    
    if (context && Object.keys(context).length > 0) {
      const contextFiles = Object.keys(context);
      await instance.loadContext(contextFiles);
    }
    
    if (async && webhookUrl) {
      res.json({
        success: true,
        instanceId,
        status: 'processing',
        message: 'Workflow execution started asynchronously'
      });
      
      WorkflowRegistry.updateInstanceStatus(instanceId, 'running');
      
      instance.execute(input)
        .then(result => {
          const workflowStatus = result?.metadata?.approvalStatus === 'pending'
            ? 'awaiting_approval'
            : 'completed';
          WorkflowRegistry.updateInstanceStatus(instanceId, workflowStatus);
          WorkflowRegistry.updateInstanceData(instanceId, { result });
          
          if (webhookUrl) {
            sendWebhook(webhookUrl, {
              instanceId,
              status: workflowStatus,
              result
            });
          }
        })
        .catch(error => {
          WorkflowRegistry.updateInstanceStatus(instanceId, 'failed');
          logger.error(`Workflow ${instanceId} failed:`, error);
          
          if (webhookUrl) {
            sendWebhook(webhookUrl, {
              instanceId,
              status: 'failed',
              error: error.message
            });
          }
        });
    } else {
      WorkflowRegistry.updateInstanceStatus(instanceId, 'running');
      
      try {
        const result = await instance.execute(input);
        const workflowStatus = result?.metadata?.approvalStatus === 'pending'
          ? 'awaiting_approval'
          : 'completed';
        WorkflowRegistry.updateInstanceStatus(instanceId, workflowStatus);
        WorkflowRegistry.updateInstanceData(instanceId, { result });
        
        res.json({
          success: true,
          instanceId,
          result
        });
      } catch (error) {
        WorkflowRegistry.updateInstanceStatus(instanceId, 'failed');
        throw error;
      }
    }
  } catch (error) {
    logger.error('Error executing workflow:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/workflows/stream', async (req, res) => {
  try {
    const { error, value } = streamSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }
    
    const { workflowId, input, context, config, credentials } = value;

    if (isRemovedWorkflow(workflowId)) {
      recordUnsupportedWorkflow({ workflowId, endpoint: 'stream' });
    }

    const removedResponse = rejectRemovedWorkflow(res, workflowId);
    if (removedResponse) {
      return removedResponse;
    }

    if (!WorkflowRegistry.has(workflowId)) {
      return res.status(404).json({
        success: false,
        error: `Workflow ${workflowId} not found`
      });
    }

    const instanceConfig = applyCredentials(config, credentials);
    const { instanceId, instance } = WorkflowRegistry.createInstance(workflowId, instanceConfig);
    WorkflowRegistry.updateInstanceData(instanceId, { input, context, config: redactConfig(instanceConfig), stream: true });
    
    if (context && Object.keys(context).length > 0) {
      const contextFiles = Object.keys(context);
      await instance.loadContext(contextFiles);
    }
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Instance-Id': instanceId
    });

    if (typeof instance.setStreamProgressHandler === 'function') {
      instance.setStreamProgressHandler((payload) => {
        res.write(`event: codex_thinking\ndata: ${JSON.stringify(payload)}\n\n`);
      });
    }

    req.on('close', () => {
      if (typeof instance.setStreamProgressHandler === 'function') {
        instance.setStreamProgressHandler(null);
      }
    });
    
    WorkflowRegistry.updateInstanceStatus(instanceId, 'streaming');
    
    try {
      const stream = await instance.stream(input);
      
      for await (const chunk of stream) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      
      WorkflowRegistry.updateInstanceStatus(instanceId, 'completed');
      res.write(`data: [DONE]\n\n`);
      if (typeof instance.setStreamProgressHandler === 'function') {
        instance.setStreamProgressHandler(null);
      }
      res.end();
    } catch (error) {
      WorkflowRegistry.updateInstanceStatus(instanceId, 'failed');
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      if (typeof instance.setStreamProgressHandler === 'function') {
        instance.setStreamProgressHandler(null);
      }
      res.end();
    }
  } catch (error) {
    logger.error('Error streaming workflow:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/instances', (req, res) => {
  try {
    const { workflowId } = req.query;
    const instances = WorkflowRegistry.listInstances(workflowId).map((instance) => ({
      ...instance,
      status: isRemovedWorkflow(instance.workflowId)
        ? 'unsupported-workflow'
        : instance.status
    }));
    
    res.json({
      success: true,
      instances,
      count: instances.length
    });
  } catch (error) {
    logger.error('Error listing instances:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/instances/:instanceId', (req, res) => {
  try {
    const { instanceId } = req.params;
    const instanceData = WorkflowRegistry.getInstanceData(instanceId);
    
    if (!instanceData) {
      return res.status(404).json({
        success: false,
        error: `Instance ${instanceId} not found`
      });
    }

    if (isRemovedWorkflow(instanceData.workflowId)) {
      return res.status(200).json({
        success: true,
        instance: {
          instanceId,
          workflowId: instanceData.workflowId,
          status: 'unsupported-workflow',
          createdAt: instanceData.createdAt,
          updatedAt: instanceData.updatedAt
        }
      });
    }
    
    res.json({
      success: true,
      instance: {
        instanceId,
        workflowId: instanceData.workflowId,
        status: instanceData.status,
        createdAt: instanceData.createdAt,
        updatedAt: instanceData.updatedAt
      }
    });
  } catch (error) {
    logger.error('Error getting instance:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/workflows/:instanceId/status', (req, res) => {
  try {
    const { instanceId } = req.params;
    const instanceData = WorkflowRegistry.getInstanceData(instanceId);

    if (!instanceData) {
      return res.status(404).json({
        success: false,
        error: `Instance ${instanceId} not found`
      });
    }

    return res.json({
      success: true,
      instanceId,
      status: instanceData.status,
      result: instanceData.result || null
    });
  } catch (error) {
    logger.error('Error getting workflow status:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/workflows/:instanceId/approve', async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { error, value } = approvalSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const instanceData = WorkflowRegistry.getInstanceData(instanceId);
    if (!instanceData) {
      return res.status(404).json({
        success: false,
        error: `Instance ${instanceId} not found`
      });
    }

    const instance = instanceData.instance;
    if (!instance || typeof instance.processApprovalResponse !== 'function') {
      return res.status(400).json({
        success: false,
        error: 'Workflow does not support approval operations'
      });
    }

    const normalizedDecision = ['approved', 'approve'].includes(value.decision)
      ? 'approve'
      : 'reject';

    if (normalizedDecision === 'approve') {
      WorkflowRegistry.updateInstanceStatus(instanceId, 'running');
    }

    const approvalResult = await instance.processApprovalResponse(normalizedDecision);

    if (!approvalResult.success) {
      if (instanceData.status === 'running') {
        WorkflowRegistry.updateInstanceStatus(instanceId, 'awaiting_approval');
      }
      return res.status(400).json({
        success: false,
        error: approvalResult.error || 'Failed to process approval'
      });
    }

    if (approvalResult.status === 'approved') {
      const result = approvalResult.result || null;
      WorkflowRegistry.updateInstanceData(instanceId, { result });
      WorkflowRegistry.updateInstanceStatus(instanceId, 'completed');

      return res.json({
        success: true,
        status: 'completed',
        message: 'Approval processed and execution completed',
        result
      });
    }

    if (approvalResult.status === 'rejected') {
      const result = approvalResult.result || null;
      WorkflowRegistry.updateInstanceData(instanceId, { result });
      WorkflowRegistry.updateInstanceStatus(instanceId, 'rejected');

      return res.json({
        success: true,
        status: 'rejected',
        message: approvalResult.reason || 'Operation rejected',
        result
      });
    }

    return res.json({
      success: true,
      status: approvalResult.status || 'processed',
      message: 'Approval response processed',
      details: approvalResult.details || null
    });
  } catch (error) {
    logger.error('Error processing approval:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/instances/:instanceId/retry', async (req, res) => {
  try {
    const { instanceId } = req.params;
    const instanceData = WorkflowRegistry.getInstanceData(instanceId);

    if (!instanceData) {
      return res.status(404).json({
        success: false,
        error: `Instance ${instanceId} not found`
      });
    }

    if (isRemovedWorkflow(instanceData.workflowId)) {
      return res.status(400).json(
        buildUnsupportedWorkflowPayload({
          workflowId: instanceData.workflowId,
          instanceId
        })
      );
    }

    if (!WorkflowRegistry.has(instanceData.workflowId)) {
      return res.status(404).json({
        success: false,
        error: `Workflow ${instanceData.workflowId} not found`
      });
    }

    if (!instanceData.input) {
      return res.status(400).json({
        success: false,
        error: 'Missing input for retry'
      });
    }

    const { instanceId: retryInstanceId, instance } = WorkflowRegistry.createInstance(
      instanceData.workflowId,
      instanceData.config || {}
    );
    WorkflowRegistry.updateInstanceData(retryInstanceId, {
      input: instanceData.input,
      context: instanceData.context,
      config: instanceData.config
    });

    if (instanceData.context && Object.keys(instanceData.context).length > 0) {
      const contextFiles = Object.keys(instanceData.context);
      await instance.loadContext(contextFiles);
    }

    WorkflowRegistry.updateInstanceStatus(retryInstanceId, 'running');

    try {
      const result = await instance.execute(instanceData.input);
      WorkflowRegistry.updateInstanceStatus(retryInstanceId, 'completed');

      res.json({
        success: true,
        instanceId: retryInstanceId,
        retriedFrom: instanceId,
        result
      });
    } catch (error) {
      WorkflowRegistry.updateInstanceStatus(retryInstanceId, 'failed');
      throw error;
    }
  } catch (error) {
    logger.error('Error retrying instance:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.delete('/instances/:instanceId', (req, res) => {
  try {
    const { instanceId } = req.params;
    const deleted = WorkflowRegistry.deleteInstance(instanceId);
    
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: `Instance ${instanceId} not found`
      });
    }
    
    res.json({
      success: true,
      message: `Instance ${instanceId} deleted successfully`
    });
  } catch (error) {
    logger.error('Error deleting instance:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

async function sendWebhook(url, data) {
  try {
    const axios = (await import('axios')).default;
    await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: parseInt(process.env.WEBHOOK_TIMEOUT) || 30000
    });
    logger.info(`Webhook sent to ${url}`);
  } catch (error) {
    logger.error(`Failed to send webhook to ${url}:`, error.message);
  }
}

export default router;
