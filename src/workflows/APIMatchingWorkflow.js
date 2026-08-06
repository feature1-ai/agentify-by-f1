import { END } from "@langchain/langgraph";
import BaseWorkflow, { lastWriteChannel } from './BaseWorkflow.js';
import CodexExecutor from '../executors/CodexExecutor.js';
import RestExecutor from '../executors/RestExecutor.js';
import logger from '../logger.js';

import APIMapper from './api-matching/APIMapper.js';
import ParameterExtractor from './api-matching/ParameterExtractor.js';
import ApprovalManager from './api-matching/ApprovalManager.js';
import ResponseFormatter from './api-matching/ResponseFormatter.js';
import ContextSelector from './api-matching/ContextSelector.js';

/**
 * APIMatchingWorkflow — maps a natural-language request onto the user's REST
 * API via their OpenAPI specs, pauses for mandatory approval, then executes.
 *
 * DAG: initialize → mapAPIs → extractParameters → requestApproval →
 *      executeAPIs → formatResponse → finalize
 */
export class APIMatchingWorkflow extends BaseWorkflow {
  constructor(workflowId, config = {}) {
    super(workflowId, config);

    // The reasoning layer is pluggable: pass ready-made executor instances via
    // config to swap the backend (or to stub them in tests); otherwise the
    // defaults are built from env-driven config.
    this.codexExecutor = config.codexExecutor || new CodexExecutor(config.codex || {});
    this.restExecutor = config.restExecutor || new RestExecutor(config.rest || {});

    this.contextSelector = new ContextSelector();
    this.apiMapper = new APIMapper(this.codexExecutor);
    this.parameterExtractor = new ParameterExtractor();
    this.approvalManager = new ApprovalManager(config.approval || {});
    this.responseFormatter = new ResponseFormatter(config.response || {});

    // Approval pause/resume state (single in-flight approval per instance)
    this.currentApprovalId = null;
    this.pendingApprovalState = null;
    this.lastExecutionResult = null;
    this.streamProgressHandler = null;
  }

  setStreamProgressHandler(handler) {
    this.streamProgressHandler = typeof handler === "function" ? handler : null;
  }

  emitStreamProgress(payload) {
    if (!this.streamProgressHandler) {
      return;
    }
    this.streamProgressHandler({
      source: "codex",
      ...payload
    });
  }

  // The workflow surfaces which specs the agent judged relevant as a
  // top-level state key, so it must be a declared channel.
  defineChannels() {
    return {
      ...super.defineChannels(),
      identifiedSwaggerDocs: lastWriteChannel(() => [])
    };
  }

  defineNodes(workflow) {
    workflow.addNode("initialize", this.initializeNode.bind(this));
    workflow.addNode("finalize", this.finalizeNode.bind(this));
    workflow.addNode("handleError", this.handleErrorNode.bind(this));

    workflow.addNode("mapAPIs", this.mapAPIsNode.bind(this));
    workflow.addNode("extractParameters", this.extractParametersNode.bind(this));
    workflow.addNode("requestApproval", this.requestApprovalNode.bind(this));
    workflow.addNode("executeAPIs", this.executeAPIsNode.bind(this));
    workflow.addNode("formatResponse", this.formatResponseNode.bind(this));
  }

  defineEdges(workflow) {
    workflow.addEdge("initialize", "mapAPIs");
    workflow.addEdge("mapAPIs", "extractParameters");

    workflow.addConditionalEdges(
      "extractParameters",
      this.routeFromParameters.bind(this),
      {
        approve: "requestApproval",
        error: "handleError"
      }
    );

    workflow.addConditionalEdges(
      "requestApproval",
      this.routeFromApproval.bind(this),
      {
        approved: "executeAPIs",
        rejected: "formatResponse",
        pending: "formatResponse"
      }
    );

    workflow.addEdge("executeAPIs", "formatResponse");
    workflow.addEdge("formatResponse", "finalize");
    workflow.addEdge("handleError", "finalize");
    workflow.addEdge("finalize", END);
  }

  async initializeNode(state) {
    logger.info(`Initializing API matching workflow: ${this.workflowId}`);

    try {
      const userInput = state.messages[0]?.content?.userInput ||
                       state.messages[0]?.content ||
                       "";

      // context-rules.json (if present) narrows which specs are loaded;
      // without rules every spec in CONTEXT_DIR is a candidate.
      const selectedFiles = await this.contextSelector.selectContexts(userInput);
      const allSwaggerDocs = await this.contextSelector.loadContexts(selectedFiles);
      logger.info(`Loaded ${Object.keys(allSwaggerDocs).length} Swagger context(s) for agent analysis`);

      return {
        ...state,
        currentNode: "initialize",
        metadata: {
          ...state.metadata,
          startTime: new Date().toISOString(),
          workflowId: this.workflowId,
          userInput,
          allSwaggerDocs
        }
      };
    } catch (error) {
      logger.error('Initialization error:', error);
      return {
        ...state,
        currentNode: "initialize",
        metadata: {
          ...state.metadata,
          startTime: new Date().toISOString(),
          workflowId: this.workflowId
        },
        errors: [...state.errors, `Initialization error: ${error.message}`]
      };
    }
  }

  async mapAPIsNode(state) {
    try {
      const { allSwaggerDocs, userInput } = state.metadata;

      // Single agent call performs intent analysis, context selection, and
      // API mapping together.
      const result = await this.apiMapper.mapToAPIs(allSwaggerDocs, userInput, {
        onProgress: (progress) => this.emitStreamProgress({
          stage: "api_mapping",
          ...progress
        })
      });

      if (!Array.isArray(result.apiCalls)) {
        throw new Error('Agent response did not include an apiCalls array');
      }

      const intent = result.intent || {
        action: 'unknown',
        resource: 'unknown',
        entities: [],
        conditions: {},
        riskLevel: 'medium'
      };
      const relevantSwaggerDocs = result.relevantSwaggerDocs || [];

      logger.info(`Mapped intent ${intent.action} ${intent.resource} to ${result.apiCalls.length} API call(s) across ${relevantSwaggerDocs.length} spec(s)`);

      return {
        ...state,
        currentNode: "mapAPIs",
        metadata: {
          ...state.metadata,
          intent,
          apiCalls: result.apiCalls,
          selectedContexts: relevantSwaggerDocs
        },
        identifiedSwaggerDocs: relevantSwaggerDocs
      };
    } catch (error) {
      logger.error("API mapping failed:", error);
      return {
        ...state,
        currentNode: "mapAPIs",
        errors: [...state.errors, `Failed to map APIs: ${error.message}`]
      };
    }
  }

  async extractParametersNode(state) {
    try {
      const { intent, apiCalls } = state.metadata;
      const apiCallsWithParams = this.parameterExtractor.extractParameters(intent, apiCalls);

      const validation = this.parameterExtractor.validateParameters(apiCallsWithParams);

      if (!validation.allValid) {
        const issues = validation.results
          .filter(r => !r.valid)
          .flatMap(r => r.issues);

        logger.warn("Parameter validation issues:", issues);

        return {
          ...state,
          currentNode: "extractParameters",
          errors: [...state.errors, ...issues]
        };
      }

      logger.info(`Extracted parameters for ${apiCallsWithParams.length} API calls`);

      return {
        ...state,
        currentNode: "extractParameters",
        metadata: {
          ...state.metadata,
          apiCallsWithParams
        }
      };
    } catch (error) {
      logger.error("Parameter extraction failed:", error);
      return {
        ...state,
        currentNode: "extractParameters",
        errors: [...state.errors, `Failed to extract parameters: ${error.message}`]
      };
    }
  }

  async requestApprovalNode(state) {
    try {
      const { intent, apiCallsWithParams, userInput } = state.metadata;

      const approvalRequest = this.approvalManager.generateApprovalRequest(
        intent,
        apiCallsWithParams,
        userInput
      );

      this.currentApprovalId = approvalRequest.id;
      this.pendingApprovalState = {
        ...state,
        currentNode: "requestApproval",
        metadata: {
          ...state.metadata,
          approvalId: approvalRequest.id,
          approvalStatus: "pending"
        }
      };

      logger.info(`Approval requested: ${approvalRequest.id}`);

      return {
        ...state,
        currentNode: "requestApproval",
        messages: [
          ...state.messages,
          { role: "assistant", content: approvalRequest.message }
        ],
        metadata: {
          ...state.metadata,
          approvalId: approvalRequest.id,
          approvalStatus: "pending"
        }
      };
    } catch (error) {
      logger.error("Approval request failed:", error);
      return {
        ...state,
        currentNode: "requestApproval",
        errors: [...state.errors, `Failed to request approval: ${error.message}`]
      };
    }
  }

  async executeAPIsNode(state) {
    try {
      const { apiCallsWithParams, approvalId } = state.metadata;

      if (approvalId && !this.approvalManager.isApprovalValid(approvalId)) {
        throw new Error("Invalid or expired approval");
      }

      await this.restExecutor.logAuditEvent({
        action: "api_execution_started",
        workflowId: this.workflowId,
        apiCalls: apiCallsWithParams.length
      });

      const results = await this.restExecutor.executeBulkAPICalls(apiCallsWithParams);

      await this.restExecutor.logAuditEvent({
        action: "api_execution_completed",
        workflowId: this.workflowId,
        successful: results.successful,
        failed: results.failed
      });

      logger.info(`API execution complete: ${results.successful}/${results.totalCalls} successful`);

      return {
        ...state,
        currentNode: "executeAPIs",
        metadata: {
          ...state.metadata,
          executionResults: results
        }
      };
    } catch (error) {
      logger.error("API execution failed:", error);
      return {
        ...state,
        currentNode: "executeAPIs",
        errors: [...state.errors, `Failed to execute APIs: ${error.message}`]
      };
    }
  }

  async formatResponseNode(state) {
    try {
      const {
        executionResults,
        intent,
        userInput,
        approvalStatus
      } = state.metadata;

      const context = {
        workflowId: this.workflowId,
        approvalId: this.currentApprovalId,
        rejected: approvalStatus === "rejected",
        pending: approvalStatus === "pending",
        rejectionReason: state.metadata.rejectionReason,
        executionTime: state.metadata.executionTime
      };

      const formattedResponse = this.responseFormatter.format(
        executionResults,
        intent,
        userInput,
        context
      );

      return {
        ...state,
        currentNode: "formatResponse",
        messages: [
          ...state.messages,
          { role: "assistant", content: formattedResponse }
        ],
        metadata: {
          ...state.metadata,
          responseFormatted: true
        }
      };
    } catch (error) {
      logger.error("Response formatting failed:", error);

      const errorMessage = this.responseFormatter.formatError(
        error,
        state.metadata.userInput
      );

      return {
        ...state,
        currentNode: "formatResponse",
        messages: [
          ...state.messages,
          { role: "assistant", content: errorMessage }
        ]
      };
    }
  }

  // Approval is mandatory for every execution; the only branch is error.
  routeFromParameters(state) {
    if (state.errors.length > 0) {
      return "error";
    }
    return "approve";
  }

  routeFromApproval(state) {
    const { approvalStatus } = state.metadata;

    if (approvalStatus === "approved") {
      return "approved";
    } else if (approvalStatus === "rejected") {
      return "rejected";
    }

    return "pending";
  }

  /**
   * Process approval response (called externally via the approve endpoint).
   */
  async processApprovalResponse(response) {
    if (!this.currentApprovalId) {
      return {
        success: false,
        error: "No pending approval"
      };
    }

    const result = await this.approvalManager.processApprovalResponse(
      this.currentApprovalId,
      response
    );

    if (result.success && result.status === "approved") {
      const workflowResult = await this.resumeFromApproval("approved");
      return {
        success: true,
        status: "approved",
        result: workflowResult
      };
    }

    if (result.success && result.status === "rejected") {
      const workflowResult = await this.resumeFromApproval("rejected", result.reason);
      return {
        success: true,
        status: "rejected",
        reason: result.reason,
        result: workflowResult
      };
    }

    return result;
  }

  /**
   * Resume the paused workflow after an approval decision.
   *
   * NOTE: this mirrors the tail of the DAG (executeAPIs → formatResponse →
   * finalize, with executeAPIs skipped on rejection). If defineEdges changes
   * downstream of requestApproval, update this sequence to match.
   */
  async resumeFromApproval(decision, reason) {
    if (!this.pendingApprovalState) {
      throw new Error("No pending workflow state to resume");
    }

    let state = {
      ...this.pendingApprovalState,
      metadata: {
        ...this.pendingApprovalState.metadata,
        approvalStatus: decision,
        ...(reason && { rejectionReason: reason })
      }
    };

    if (decision === "approved") {
      state = await this.executeAPIsNode(state);
    }
    state = await this.formatResponseNode(state);
    state = await this.finalizeNode(state);

    this.pendingApprovalState = null;
    this.currentApprovalId = null;
    this.lastExecutionResult = state;

    return state;
  }

  async finalizeNode(state) {
    logger.info("Finalizing API matching workflow");

    return {
      ...state,
      currentNode: "finalize",
      metadata: {
        ...state.metadata,
        endTime: new Date().toISOString(),
        executionTime: Date.now() - new Date(state.metadata.startTime).getTime()
      },
      identifiedSwaggerDocs: state.identifiedSwaggerDocs || state.metadata.selectedContexts || []
    };
  }

  async handleErrorNode(state) {
    logger.error("Handling workflow errors:", state.errors);
    return {
      ...state,
      currentNode: "handleError",
      messages: [
        ...state.messages,
        {
          role: "assistant",
          content: `Error occurred: ${state.errors.join(", ")}`
        }
      ]
    };
  }
}

export default APIMatchingWorkflow;
