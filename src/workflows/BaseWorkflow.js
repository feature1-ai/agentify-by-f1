import { StateGraph, END } from "@langchain/langgraph";
import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { resolveContextDir } from '../contextDir.js';

/**
 * State convention: every node returns the FULL next state (spread `...state`,
 * then override what changed), so every channel uses last-write-wins semantics.
 * Subclasses that need extra top-level state keys extend defineChannels().
 */
export const lastWriteChannel = (defaultValue) => ({
  value: (_previous, next) => next,
  default: defaultValue
});

export class BaseWorkflow {
  constructor(workflowId, config = {}) {
    this.workflowId = workflowId;
    this.config = {
      maxRetries: 3,
      timeout: 30000,
      ...config
    };
    this.graph = null;
    this.contextData = {};
    this.state = {
      messages: [],
      context: {},
      metadata: {},
      errors: [],
      currentNode: 'start'
    };
  }

  // Streaming progress is an optional capability; the default no-op lets
  // callers set/clear handlers on any workflow without feature-detection.
  setStreamProgressHandler(_handler) {}

  // Approval is an optional capability; workflows that pause for approval
  // (see APIMatchingWorkflow) override this.
  async processApprovalResponse(_response) {
    return {
      success: false,
      error: 'Workflow does not support approval operations'
    };
  }

  async loadContext(contextFiles = []) {
    try {
      const contextPath = resolveContextDir();

      for (const file of contextFiles) {
        const filePath = path.join(contextPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const fileExt = path.extname(file);

        if (fileExt === '.json') {
          this.contextData[file] = JSON.parse(content);
        } else {
          this.contextData[file] = content;
        }

        logger.info(`Loaded context file: ${file}`);
      }

      return this.contextData;
    } catch (error) {
      logger.error(`Error loading context: ${error.message}`);
      throw error;
    }
  }

  defineChannels() {
    return {
      messages: lastWriteChannel(() => []),
      context: lastWriteChannel(() => ({})),
      metadata: lastWriteChannel(() => ({})),
      errors: lastWriteChannel(() => []),
      currentNode: lastWriteChannel(() => 'start')
    };
  }

  buildGraph() {
    const workflow = new StateGraph({ channels: this.defineChannels() });

    this.defineNodes(workflow);
    this.defineEdges(workflow);

    workflow.setEntryPoint(this.getEntryPoint());

    this.graph = workflow.compile();
    return this.graph;
  }

  defineNodes(workflow) {
    workflow.addNode("initialize", this.initializeNode.bind(this));
    workflow.addNode("processInput", this.processInputNode.bind(this));
    workflow.addNode("executeAction", this.executeActionNode.bind(this));
    workflow.addNode("handleError", this.handleErrorNode.bind(this));
    workflow.addNode("finalize", this.finalizeNode.bind(this));
  }

  defineEdges(workflow) {
    workflow.addEdge("initialize", "processInput");
    workflow.addConditionalEdges(
      "processInput",
      this.routeFromProcessInput.bind(this),
      {
        execute: "executeAction",
        error: "handleError",
        end: END
      }
    );
    workflow.addConditionalEdges(
      "executeAction",
      this.routeFromExecution.bind(this),
      {
        continue: "processInput",
        finalize: "finalize",
        error: "handleError"
      }
    );
    workflow.addEdge("handleError", "finalize");
    workflow.addEdge("finalize", END);
  }

  getEntryPoint() {
    return "initialize";
  }

  async initializeNode(state) {
    logger.info(`Initializing workflow: ${this.workflowId}`);
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
      }
    };
  }

  async processInputNode(state) {
    logger.info("Processing input");
    return {
      ...state,
      currentNode: "processInput"
    };
  }

  async executeActionNode(state) {
    logger.info("Executing action - to be overridden by subclass");
    return {
      ...state,
      currentNode: "executeAction",
      metadata: {
        ...state.metadata,
        complete: true
      }
    };
  }

  async handleErrorNode(state) {
    logger.error(`Handling error: ${JSON.stringify(state.errors)}`);
    return {
      ...state,
      currentNode: "handleError",
      metadata: {
        ...state.metadata,
        hasError: true
      }
    };
  }

  async finalizeNode(state) {
    logger.info("Finalizing workflow");
    return {
      ...state,
      currentNode: "finalize",
      metadata: {
        ...state.metadata,
        endTime: new Date().toISOString()
      }
    };
  }

  routeFromProcessInput(state) {
    if (state.errors.length > 0) {
      return "error";
    }
    if (state.messages.length === 0) {
      return "end";
    }
    return "execute";
  }

  routeFromExecution(state) {
    if (state.errors.length > 0) {
      return "error";
    }
    if (state.metadata.complete) {
      return "finalize";
    }
    return "continue";
  }

  buildInitialState(input) {
    return {
      ...this.state,
      messages: [{ role: "user", content: input }],
      metadata: {
        inputReceived: new Date().toISOString()
      }
    };
  }

  async execute(input) {
    try {
      if (!this.graph) {
        this.buildGraph();
      }
      return await this.graph.invoke(this.buildInitialState(input));
    } catch (error) {
      logger.error(`Workflow execution error: ${error.message}`);
      throw error;
    }
  }

  async stream(input) {
    try {
      if (!this.graph) {
        this.buildGraph();
      }
      return await this.graph.stream(this.buildInitialState(input));
    } catch (error) {
      logger.error(`Workflow stream error: ${error.message}`);
      throw error;
    }
  }
}

export default BaseWorkflow;
