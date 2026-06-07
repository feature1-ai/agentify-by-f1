import { StateGraph, END } from "@langchain/langgraph";
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class BaseWorkflow {
  constructor(workflowId, config = {}) {
    this.workflowId = workflowId;
    this.config = {
      maxRetries: 3,
      timeout: 30000,
      contextPath: 'resources/contexts',
      templatesPath: 'resources/templates',
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

  async loadContext(contextFiles = []) {
    try {
      const contextPath = process.env.CONTEXT_DIR
        ? (path.isAbsolute(process.env.CONTEXT_DIR)
            ? process.env.CONTEXT_DIR
            : path.resolve(process.cwd(), process.env.CONTEXT_DIR))
        : path.join(__dirname, '../../', this.config.contextPath);

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

  async loadTemplate(templateName) {
    try {
      const templatePath = path.join(
        __dirname, 
        '../../', 
        this.config.templatesPath, 
        `${templateName}.txt`
      );
      const template = await fs.readFile(templatePath, 'utf-8');
      return template;
    } catch (error) {
      logger.error(`Error loading template ${templateName}: ${error.message}`);
      throw error;
    }
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: {
        messages: {
          value: (oldMessages, newMessages) => {
            // Properly append new messages to existing ones
            const existing = oldMessages || [];
            const toAdd = newMessages || [];
            
            // If toAdd is the entire messages array (includes old ones), just return it
            if (toAdd.length > 0 && toAdd === newMessages) {
              // Check if this is a replacement (contains the old messages already)
              const hasOldContent = existing.length > 0 && 
                toAdd.some(msg => existing.some(old => 
                  old.content === msg.content && old.role === msg.role));
              
              if (hasOldContent || toAdd.length >= existing.length) {
                return toAdd;
              }
            }
            
            // Otherwise append genuinely new messages
            return [...existing, ...toAdd.filter(msg => 
              !existing.some(old => old.content === msg.content && old.role === msg.role))];
          },
          default: () => []
        },
        context: {
          value: (oldContext, newContext) => ({ ...oldContext, ...newContext }),
          default: () => ({})
        },
        metadata: {
          value: (oldMeta, newMeta) => ({ ...oldMeta, ...newMeta }),
          default: () => ({})
        },
        errors: {
          value: (oldErrors, newErrors) => [...oldErrors, ...newErrors],
          default: () => []
        },
        currentNode: {
          value: (_, newNode) => newNode,
          default: () => 'start'
        }
      }
    });

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

  async execute(input) {
    try {
      if (!this.graph) {
        this.buildGraph();
      }

      const initialState = {
        ...this.state,
        messages: [{ role: "user", content: input }],
        metadata: {
          inputReceived: new Date().toISOString()
        }
      };

      const result = await this.graph.invoke(initialState);
      return result;
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

      const initialState = {
        ...this.state,
        messages: [{ role: "user", content: input }],
        metadata: {
          inputReceived: new Date().toISOString()
        }
      };

      const stream = await this.graph.stream(initialState);
      return stream;
    } catch (error) {
      logger.error(`Workflow stream error: ${error.message}`);
      throw error;
    }
  }
}

export default BaseWorkflow;