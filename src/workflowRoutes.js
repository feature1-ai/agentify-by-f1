import express from 'express';
import axios from 'axios';
import Joi from 'joi';
import WorkflowRegistry from './WorkflowRegistry.js';
import logger from './logger.js';
import { asyncHandler } from './errorHandler.js';

const router = express.Router();

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

/**
 * Downstream auth precedence: explicit request credentials > the logged-in
 * user's forwarded SSO access token (req.downstreamAuth, oidc mode with
 * OIDC_FORWARD_ACCESS_TOKEN) > BASE_URL / AUTH_HEADER_* env defaults, which
 * RestExecutor falls back to for anything left unset here.
 * Exported for the auth test suite.
 */
export const applyCredentials = (config = {}, credentials, identityAuth) => {
  const merged = { ...(identityAuth || {}), ...(credentials || {}) };
  if (Object.keys(merged).length === 0) {
    return config || {};
  }
  return {
    ...(config || {}),
    rest: { ...((config || {}).rest || {}), ...merged }
  };
};

// The instance record keeps two copies of the config: `liveConfig` (real
// credentials, used to construct/retry instances, never returned by any
// endpoint) and `config` (authHeaderValue redacted, safe to expose).
const redactConfig = (config = {}) => {
  if (!config || config.rest?.authHeaderValue === undefined) {
    return config;
  }
  return {
    ...config,
    rest: { ...config.rest, authHeaderValue: '***redacted***' }
  };
};

const validate = (schema, body, res) => {
  const { error, value } = schema.validate(body);
  if (error) {
    res.status(400).json({
      success: false,
      error: error.details[0].message
    });
    return null;
  }
  return value;
};

const workflowNotFound = (res, workflowId) =>
  res.status(404).json({
    success: false,
    error: `Workflow ${workflowId} not found`
  });

const instanceNotFound = (res, instanceId) =>
  res.status(404).json({
    success: false,
    error: `Instance ${instanceId} not found`
  });

const statusFromResult = (result) =>
  result?.metadata?.approvalStatus === 'pending' ? 'awaiting_approval' : 'completed';

/**
 * Shared by execute, stream, and retry: create the instance with the live
 * config, persist the record (redacted copy for display, live copy for
 * retries), and load any request-scoped context files.
 */
async function createConfiguredInstance({ workflowId, input, context, liveConfig, extraRecordFields = {} }) {
  const { instanceId, instance } = WorkflowRegistry.createInstance(workflowId, liveConfig);
  WorkflowRegistry.updateInstanceData(instanceId, {
    input,
    context,
    config: redactConfig(liveConfig),
    liveConfig,
    ...extraRecordFields
  });

  if (context && Object.keys(context).length > 0) {
    await instance.loadContext(Object.keys(context));
  }

  return { instanceId, instance };
}

async function runAndRecord(instanceId, instance, input) {
  WorkflowRegistry.updateInstanceStatus(instanceId, 'running');
  try {
    const result = await instance.execute(input);
    WorkflowRegistry.updateInstanceStatus(instanceId, statusFromResult(result));
    WorkflowRegistry.updateInstanceData(instanceId, { result });
    return result;
  } catch (error) {
    WorkflowRegistry.updateInstanceStatus(instanceId, 'failed');
    throw error;
  }
}

router.get('/workflows', (req, res) => {
  const workflows = WorkflowRegistry.list();
  res.json({
    success: true,
    workflows,
    count: workflows.length
  });
});

router.get('/workflows/:workflowId', (req, res) => {
  const { workflowId } = req.params;

  if (!WorkflowRegistry.has(workflowId)) {
    return workflowNotFound(res, workflowId);
  }

  const instances = WorkflowRegistry.listInstances(workflowId);

  res.json({
    success: true,
    workflowId,
    instances,
    instanceCount: instances.length
  });
});

router.post('/workflows/execute', asyncHandler(async (req, res) => {
  const value = validate(executeSchema, req.body, res);
  if (!value) return;

  const { workflowId, input, context, config, credentials, webhookUrl, async: isAsync } = value;

  if (!WorkflowRegistry.has(workflowId)) {
    return workflowNotFound(res, workflowId);
  }

  const { instanceId, instance } = await createConfiguredInstance({
    workflowId,
    input,
    context,
    liveConfig: applyCredentials(config, credentials, req.downstreamAuth),
    extraRecordFields: { webhookUrl }
  });

  if (isAsync && webhookUrl) {
    res.json({
      success: true,
      instanceId,
      status: 'processing',
      message: 'Workflow execution started asynchronously'
    });

    runAndRecord(instanceId, instance, input)
      .then((result) => sendWebhook(webhookUrl, {
        instanceId,
        status: WorkflowRegistry.getInstanceData(instanceId)?.status,
        result
      }))
      .catch((error) => {
        logger.error(`Workflow ${instanceId} failed:`, error);
        sendWebhook(webhookUrl, {
          instanceId,
          status: 'failed',
          error: error.message
        });
      });
    return;
  }

  const result = await runAndRecord(instanceId, instance, input);
  res.json({
    success: true,
    instanceId,
    result
  });
}));

router.post('/workflows/stream', asyncHandler(async (req, res) => {
  const value = validate(streamSchema, req.body, res);
  if (!value) return;

  const { workflowId, input, context, config, credentials } = value;

  if (!WorkflowRegistry.has(workflowId)) {
    return workflowNotFound(res, workflowId);
  }

  const { instanceId, instance } = await createConfiguredInstance({
    workflowId,
    input,
    context,
    liveConfig: applyCredentials(config, credentials, req.downstreamAuth),
    extraRecordFields: { stream: true }
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Instance-Id': instanceId
  });

  instance.setStreamProgressHandler((payload) => {
    res.write(`event: codex_thinking\ndata: ${JSON.stringify(payload)}\n\n`);
  });
  req.on('close', () => instance.setStreamProgressHandler(null));

  WorkflowRegistry.updateInstanceStatus(instanceId, 'streaming');

  try {
    const stream = await instance.stream(input);

    // LangGraph yields { [nodeName]: stateAfterNode } per step; the last
    // node's state is the workflow result, same shape the execute path gets.
    let finalState = null;
    for await (const chunk of stream) {
      for (const nodeState of Object.values(chunk)) {
        finalState = nodeState;
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    WorkflowRegistry.updateInstanceStatus(instanceId, statusFromResult(finalState));
    WorkflowRegistry.updateInstanceData(instanceId, { result: finalState });
    res.write(`data: [DONE]\n\n`);
  } catch (error) {
    WorkflowRegistry.updateInstanceStatus(instanceId, 'failed');
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
  } finally {
    instance.setStreamProgressHandler(null);
    res.end();
  }
}));

router.get('/instances', (req, res) => {
  const { workflowId } = req.query;
  const instances = WorkflowRegistry.listInstances(workflowId);

  res.json({
    success: true,
    instances,
    count: instances.length
  });
});

router.get('/instances/:instanceId', (req, res) => {
  const { instanceId } = req.params;
  const instanceData = WorkflowRegistry.getInstanceData(instanceId);

  if (!instanceData) {
    return instanceNotFound(res, instanceId);
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
});

router.get('/workflows/:instanceId/status', (req, res) => {
  const { instanceId } = req.params;
  const instanceData = WorkflowRegistry.getInstanceData(instanceId);

  if (!instanceData) {
    return instanceNotFound(res, instanceId);
  }

  res.json({
    success: true,
    instanceId,
    status: instanceData.status,
    result: instanceData.result || null
  });
});

router.post('/workflows/:instanceId/approve', asyncHandler(async (req, res) => {
  const { instanceId } = req.params;
  const value = validate(approvalSchema, req.body, res);
  if (!value) return;

  const instanceData = WorkflowRegistry.getInstanceData(instanceId);
  if (!instanceData) {
    return instanceNotFound(res, instanceId);
  }

  const normalizedDecision = ['approved', 'approve'].includes(value.decision)
    ? 'approve'
    : 'reject';

  // Surface 'running' while the approved tail of the workflow executes;
  // restore the prior status if the approval turns out to be unprocessable.
  const priorStatus = instanceData.status;
  if (normalizedDecision === 'approve') {
    WorkflowRegistry.updateInstanceStatus(instanceId, 'running');
  }

  const approvalResult = await instanceData.instance.processApprovalResponse(normalizedDecision);

  if (!approvalResult.success) {
    WorkflowRegistry.updateInstanceStatus(instanceId, priorStatus);
    return res.status(400).json({
      success: false,
      error: approvalResult.error || 'Failed to process approval'
    });
  }

  if (approvalResult.status === 'approved' || approvalResult.status === 'rejected') {
    const result = approvalResult.result || null;
    WorkflowRegistry.updateInstanceData(instanceId, { result });
    WorkflowRegistry.updateInstanceStatus(
      instanceId,
      approvalResult.status === 'approved' ? 'completed' : 'rejected'
    );

    return res.json({
      success: true,
      status: approvalResult.status === 'approved' ? 'completed' : 'rejected',
      message: approvalResult.status === 'approved'
        ? 'Approval processed and execution completed'
        : (approvalResult.reason || 'Operation rejected'),
      result
    });
  }

  res.json({
    success: true,
    status: approvalResult.status || 'processed',
    message: 'Approval response processed'
  });
}));

router.post('/instances/:instanceId/retry', asyncHandler(async (req, res) => {
  const { instanceId } = req.params;
  const instanceData = WorkflowRegistry.getInstanceData(instanceId);

  if (!instanceData) {
    return instanceNotFound(res, instanceId);
  }

  if (!WorkflowRegistry.has(instanceData.workflowId)) {
    return workflowNotFound(res, instanceData.workflowId);
  }

  if (!instanceData.input) {
    return res.status(400).json({
      success: false,
      error: 'Missing input for retry'
    });
  }

  const { instanceId: retryInstanceId, instance } = await createConfiguredInstance({
    workflowId: instanceData.workflowId,
    input: instanceData.input,
    context: instanceData.context,
    liveConfig: instanceData.liveConfig || {}
  });

  const result = await runAndRecord(retryInstanceId, instance, instanceData.input);

  res.json({
    success: true,
    instanceId: retryInstanceId,
    retriedFrom: instanceId,
    result
  });
}));

router.delete('/instances/:instanceId', (req, res) => {
  const { instanceId } = req.params;
  const deleted = WorkflowRegistry.deleteInstance(instanceId);

  if (!deleted) {
    return instanceNotFound(res, instanceId);
  }

  res.json({
    success: true,
    message: `Instance ${instanceId} deleted successfully`
  });
});

async function sendWebhook(url, data) {
  try {
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
