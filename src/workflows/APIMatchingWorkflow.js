import { END } from "@langchain/langgraph";
import BaseWorkflow from '../core/BaseWorkflow.js';
import CodexExecutor from '../executors/CodexExecutor.js';
import RestExecutor from '../executors/RestExecutor.js';
import logger from '../utils/logger.js';

// Import all API Matching Workflow services from single location
import {
  IntentAnalyzer,
  APIMapper,
  ParameterExtractor,
  ApprovalManager,
  ResponseFormatter
} from '../services/api_matching_workflow/index.js';
import ContextSelector from '../services/api_matching_workflow/ContextSelector.js';

/**
 * APIMatchingWorkflow - Refactored version using modular services
 * Clean separation of concerns with single responsibility modules
 */
export class APIMatchingWorkflow extends BaseWorkflow {
  constructor(workflowId, config = {}) {
    super(workflowId, config);

    // Initialize executors
    this.codexExecutor = new CodexExecutor(config.codex || {});
    this.restExecutor = new RestExecutor(config.rest || {});

    // Initialize services with single responsibilities
    this.contextSelector = new ContextSelector(this.codexExecutor);
    this.intentAnalyzer = new IntentAnalyzer(this.codexExecutor);
    this.apiMapper = new APIMapper(this.codexExecutor);
    this.parameterExtractor = new ParameterExtractor();
    this.approvalManager = new ApprovalManager(config.approval || {});
    this.responseFormatter = new ResponseFormatter(config.response || {});

    // Workflow state
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

  defineNodes(workflow) {
    // Define our own initialize and finalize nodes
    workflow.addNode("initialize", this.initializeNode.bind(this));
    workflow.addNode("finalize", this.finalizeNode.bind(this));
    workflow.addNode("handleError", this.handleErrorNode.bind(this));

    // Each node delegates to a specific service
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


  /**
   * Node: Map intent to APIs
   */
  async mapAPIsNode(state) {
    try {
      const { allSwaggerDocs, userInput } = state.metadata;
      
      // Use optimized single AI call for intent analysis, context selection, and API mapping
      const result = await this.apiMapper.mapToAPIs(null, allSwaggerDocs, userInput, {
        onProgress: (progress) => this.emitStreamProgress({
          stage: "api_mapping",
          ...progress
        })
      });

      // Extract intent, context selection, and API calls from the combined result
      let intent, apiCalls, relevantSwaggerDocs;
      
      if (result.intent && result.apiCalls && result.relevantSwaggerDocs) {
        // New optimized format with intent analysis
        intent = result.intent;
        apiCalls = result.apiCalls;
        relevantSwaggerDocs = result.relevantSwaggerDocs;
        logger.info(`Complete analysis: ${intent.action} ${intent.resource}, selected ${relevantSwaggerDocs.length} contexts, mapped to ${apiCalls.length} API calls`);
      } else if (result.apiCalls && result.relevantSwaggerDocs) {
        // Partial optimized format
        intent = { action: 'unknown', resource: 'unknown', entities: [], conditions: {}, riskLevel: 'medium' };
        apiCalls = result.apiCalls;
        relevantSwaggerDocs = result.relevantSwaggerDocs;
        logger.info(`Partial mapping: selected ${relevantSwaggerDocs.length} contexts, mapped to ${apiCalls.length} API calls`);
      } else if (Array.isArray(result)) {
        // Legacy format (fallback)
        intent = { action: 'unknown', resource: 'unknown', entities: [], conditions: {}, riskLevel: 'medium' };
        apiCalls = result;
        relevantSwaggerDocs = ['unknown'];
        logger.info(`Legacy mapping: mapped to ${apiCalls.length} API calls`);
      } else {
        throw new Error('Unexpected mapping result format');
      }

      return {
        ...state,
        currentNode: "mapAPIs",
        metadata: {
          ...state.metadata,
          intent,
          apiCalls,
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

  /**
   * Node: Extract parameters
   */
  async extractParametersNode(state) {
    try {
      const { intent, apiCalls } = state.metadata;
      const apiCallsWithParams = this.parameterExtractor.extractParameters(intent, apiCalls);

      // Validate parameters
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

  /**
   * Node: Request approval
   */
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

  /**
   * Node: Execute APIs
   */
  async executeAPIsNode(state) {
    try {
      const { apiCallsWithParams, approvalId } = state.metadata;

      // Verify approval if needed
      if (approvalId && !this.approvalManager.isApprovalValid(approvalId)) {
        throw new Error("Invalid or expired approval");
      }

      // Log audit event
      await this.restExecutor.logAuditEvent({
        action: "api_execution_started",
        workflowId: this.workflowId,
        apiCalls: apiCallsWithParams.length
      });

      // Execute API calls
      const results = await this.restExecutor.executeBulkAPICalls(apiCallsWithParams);

      // Log completion
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

  /**
   * Node: Format response
   */
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

      // Fallback to simple error message
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

  /**
   * Route from parameter extraction - always require approval
   */
  routeFromParameters(state) {
    if (state.errors.length > 0) {
      return "error";
    }

    // Always require approval for all API executions
    return "approve";
  }

  /**
   * Route from approval
   */
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
   * Process approval response (called externally)
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
      const workflowResult = await this.executeApprovedWorkflow();
      return {
        success: true,
        status: "approved",
        result: workflowResult
      };
    }

    if (result.success && result.status === "rejected") {
      const workflowResult = await this.buildRejectedWorkflowResult(result.reason);
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
   * Continue workflow after approval
   */
  async continueFromApproval() {
    return this.executeApprovedWorkflow();
  }

  async executeApprovedWorkflow() {
    if (!this.pendingApprovalState) {
      throw new Error("No pending workflow state to resume");
    }

    const approvedState = {
      ...this.pendingApprovalState,
      metadata: {
        ...this.pendingApprovalState.metadata,
        approvalStatus: "approved"
      }
    };

    const executedState = await this.executeAPIsNode(approvedState);
    const formattedState = await this.formatResponseNode(executedState);
    const finalizedState = await this.finalizeNode(formattedState);

    this.pendingApprovalState = null;
    this.currentApprovalId = null;
    this.lastExecutionResult = finalizedState;

    return finalizedState;
  }

  async buildRejectedWorkflowResult(reason = "User rejected") {
    if (!this.pendingApprovalState) {
      throw new Error("No pending workflow state to reject");
    }

    const rejectedState = {
      ...this.pendingApprovalState,
      metadata: {
        ...this.pendingApprovalState.metadata,
        approvalStatus: "rejected",
        rejectionReason: reason
      }
    };

    const formattedState = await this.formatResponseNode(rejectedState);
    const finalizedState = await this.finalizeNode(formattedState);

    this.pendingApprovalState = null;
    this.currentApprovalId = null;
    this.lastExecutionResult = finalizedState;

    return finalizedState;
  }

  /**
   * Base workflow nodes
   */
  async initializeNode(state) {
    logger.info(`Initializing API matching workflow: ${this.workflowId}`);

    try {
      // Extract user input
      const userInput = state.messages[0]?.content?.userInput ||
                       state.messages[0]?.content ||
                       "";

      // Load all contexts for the AI to examine (optimization: no pre-selection)
      const allSwaggerDocs = await this.contextSelector.loadAllContexts();
      logger.info(`Loaded all Swagger contexts for AI analysis`);

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
        context: {
          ...state.context,
          ...this.contextData
        },
        errors: [...state.errors, `Initialization error: ${error.message}`]
      };
    }
  }

  async finalizeNode(state) {
    logger.info("Finalizing API matching workflow");
    
    // Remove context completely and add identifiedSwaggerDocs at top level
    const { context, ...stateWithoutContext } = state;
    
    return {
      ...stateWithoutContext,
      currentNode: "finalize",
      metadata: {
        ...state.metadata,
        endTime: new Date().toISOString(),
        executionTime: Date.now() - new Date(state.metadata.startTime).getTime()
      },
      // Add identifiedSwaggerDocs at top level
      identifiedSwaggerDocs: state.identifiedSwaggerDocs || state.metadata.selectedContexts || [],
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
