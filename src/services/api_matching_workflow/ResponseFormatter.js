import logger from '../../utils/logger.js';

/**
 * ResponseFormatter - Responsible for formatting API responses for users
 * Single Responsibility: Response formatting and presentation
 */
export class ResponseFormatter {
  constructor(config = {}) {
    this.config = {
      verbose: config.verbose || false,
      format: config.format || 'markdown',
      includeMetadata: config.includeMetadata || false,
      ...config
    };
    
    this.formatters = {
      markdown: this.formatMarkdown.bind(this),
      json: this.formatJSON.bind(this),
      plain: this.formatPlain.bind(this)
    };
  }

  /**
   * Format response based on execution results
   */
  format(executionResults, intent, userInput, additionalContext = {}) {
    logger.info("Formatting response");
    
    const formatter = this.formatters[this.config.format] || this.formatters.markdown;
    return formatter(executionResults, intent, userInput, additionalContext);
  }

  /**
   * Format as Markdown (default)
   */
  formatMarkdown(executionResults, intent, userInput, context) {
    const sections = [];
    
    // Handle special cases
    if (context.rejected) {
      return this.formatRejection(userInput, context.rejectionReason);
    }
    
    if (context.pending) {
      return this.formatPending(userInput);
    }
    
    // Header
    sections.push(this.formatExecutionHeader(userInput));
    
    // Status summary
    sections.push(this.formatStatusSummary(executionResults, intent));
    
    // Detailed results (if any failures or verbose mode)
    if (this.shouldShowDetails(executionResults)) {
      sections.push(this.formatDetailedResults(executionResults));
    }
    
    // Next steps
    sections.push(this.formatNextSteps(executionResults, intent));
    
    // Metadata (if enabled)
    if (this.config.includeMetadata) {
      sections.push(this.formatMetadata(executionResults, context));
    }
    
    return sections.filter(Boolean).join('\n\n');
  }

  /**
   * Format rejection response
   */
  formatRejection(userInput, reason) {
    return `❌ **Request Rejected**

**Original Request:** "${userInput}"

The operation was not executed as it was rejected during the approval process.

**Reason:** ${reason || 'User cancelled the operation'}

No changes were made to the system.`;
  }

  /**
   * Format pending response
   */
  formatPending(userInput) {
    return `⏳ **Awaiting Approval**

**Request:** "${userInput}"

Your request is pending approval. You will be notified once it's processed.

Please respond with:
• "approve" to proceed
• "reject" to cancel
• "explain" for more details`;
  }

  /**
   * Format execution header
   */
  formatExecutionHeader(userInput) {
    return `📊 **Execution Report**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📝 **Request:** "${userInput}"`;
  }

  /**
   * Format status summary
   */
  formatStatusSummary(executionResults, intent) {
    if (!executionResults) {
      return `⏳ **Status:** Processing...`;
    }
    
    const { successful = 0, totalCalls = 0, failed = 0 } = executionResults;
    
    let status = '';
    let emoji = '';
    
    if (successful === totalCalls && totalCalls > 0) {
      emoji = '✅';
      status = 'SUCCESS';
    } else if (successful > 0 && failed > 0) {
      emoji = '⚠️';
      status = 'PARTIAL SUCCESS';
    } else if (failed === totalCalls && totalCalls > 0) {
      emoji = '❌';
      status = 'FAILED';
    } else {
      emoji = '📋';
      status = 'COMPLETED';
    }
    
    let summary = `${emoji} **Status:** ${status}`;
    
    if (totalCalls > 0) {
      summary += `\n📈 **Operations:** ${successful}/${totalCalls} successful`;
      
      // Add specific success message based on intent
      if (successful === totalCalls) {
        summary += this.getSuccessMessage(intent);
      }
    }
    
    return summary;
  }

  /**
   * Get success message based on intent
   */
  getSuccessMessage(intent) {
    // Action-based, domain-neutral messages — works for any resource the
    // agent maps from the user's OpenAPI specs.
    const resource = intent.resource && intent.resource !== 'unknown'
      ? intent.resource
      : 'resource';
    const byAction = {
      create: `\n➕ ${resource}(s) created successfully`,
      update: `\n✏️ ${resource}(s) updated successfully`,
      delete: `\n🗑️ ${resource}(s) deleted successfully`,
      enable: `\n🔓 ${resource}(s) enabled`,
      disable: `\n🔒 ${resource}(s) disabled`
    };

    return byAction[intent.action] || '';
  }

  /**
   * Format detailed results
   */
  formatDetailedResults(executionResults) {
    if (!executionResults.results || executionResults.results.length === 0) {
      return '';
    }
    
    let details = `📋 **Detailed Results:**\n`;
    
    // Group by success/failure
    const successes = executionResults.results.filter(r => r.success);
    const failures = executionResults.results.filter(r => !r.success);
    
    if (successes.length > 0 && this.config.verbose) {
      details += `\n✅ **Successful Operations:**`;
      successes.forEach((result, idx) => {
        details += `\n   ${idx + 1}. ${result.service}${result.endpoint}`;
        if (result.data && this.config.verbose) {
          details += `\n      Response: ${JSON.stringify(result.data, null, 6).split('\n').join('\n      ')}`;
        }
      });
    }
    
    if (failures.length > 0) {
      details += `\n\n❌ **Failed Operations:**`;
      failures.forEach((result, idx) => {
        details += `\n   ${idx + 1}. ${result.service}${result.endpoint}`;
        details += `\n      Error: ${result.error}`;
        if (result.status) {
          details += `\n      Status Code: ${result.status}`;
        }
      });
    }
    
    return details;
  }

  /**
   * Format next steps
   */
  formatNextSteps(executionResults, intent) {
    let steps = `📌 **Next Steps:**\n`;
    
    if (!executionResults) {
      steps += `   • Waiting for execution to complete`;
      return steps;
    }
    
    const { successful = 0, totalCalls = 0, errors = [] } = executionResults;
    
    if (successful === totalCalls && totalCalls > 0) {
      steps += `   ✓ Changes have been applied successfully\n`;
      steps += `   ✓ Audit log has been updated\n`;
      
      // Add rollback info for risky operations
      if (['delete', 'disable'].includes(intent.action)) {
        steps += `   ℹ️ To reverse this action, ${this.getRollbackInstruction(intent)}\n`;
      }
      
      steps += `   ✓ No further action required`;
    } else if (errors.length > 0) {
      steps += `   • Review the failed operations above\n`;
      steps += `   • Check service connectivity and permissions\n`;
      steps += `   • Retry failed operations if needed\n`;
      
      // Add specific troubleshooting tips
      const troubleshooting = this.getTroubleshootingTips(errors);
      if (troubleshooting) {
        steps += troubleshooting;
      }
    } else {
      steps += `   • Operation completed\n`;
      steps += `   • Review results above`;
    }
    
    return steps;
  }

  /**
   * Get rollback instruction
   */
  getRollbackInstruction(intent) {
    // Generic, action-based guidance — no assumptions about the resource.
    if (intent.action === 'delete') {
      return `recreate the ${intent.resource || 'resource'} (deletion is permanent)`;
    }
    if (intent.action === 'disable') {
      return 'run the opposite "enable" action';
    }
    return 're-run with the opposite action';
  }

  /**
   * Get troubleshooting tips based on errors
   */
  getTroubleshootingTips(errors) {
    let tips = '';
    
    // Check for common error patterns
    const has401 = errors.some(e => e.status === 401);
    const has403 = errors.some(e => e.status === 403);
    const has404 = errors.some(e => e.status === 404);
    const has500 = errors.some(e => e.status >= 500);
    
    if (has401 || has403) {
      tips += `   ⚠️ Authentication/Permission issue detected - verify API credentials\n`;
    }
    if (has404) {
      tips += `   ⚠️ Resource not found - verify entity IDs and endpoints\n`;
    }
    if (has500) {
      tips += `   ⚠️ Server error detected - check service status\n`;
    }
    
    return tips;
  }

  /**
   * Format metadata
   */
  formatMetadata(executionResults, context) {
    let metadata = `\n---\n📊 **Metadata:**\n`;
    
    metadata += `• Workflow ID: ${context.workflowId || 'N/A'}\n`;
    metadata += `• Execution Time: ${context.executionTime || 'N/A'}ms\n`;
    metadata += `• Timestamp: ${new Date().toISOString()}\n`;
    
    if (context.approvalId) {
      metadata += `• Approval ID: ${context.approvalId}\n`;
    }
    
    if (this.config.verbose && executionResults) {
      metadata += `• Raw Results: \n\`\`\`json\n${JSON.stringify(executionResults, null, 2)}\n\`\`\``;
    }
    
    return metadata;
  }

  /**
   * Format as JSON
   */
  formatJSON(executionResults, intent, userInput, context) {
    return JSON.stringify({
      request: userInput,
      intent,
      results: executionResults,
      context,
      timestamp: new Date().toISOString()
    }, null, 2);
  }

  /**
   * Format as plain text
   */
  formatPlain(executionResults, intent, userInput, context) {
    let response = `Request: ${userInput}\n`;
    response += `Status: ${this.getPlainStatus(executionResults)}\n`;
    
    if (executionResults?.results) {
      response += `Results: ${executionResults.successful}/${executionResults.totalCalls} successful\n`;
      
      if (executionResults.errors?.length > 0) {
        response += `Errors:\n`;
        executionResults.errors.forEach(error => {
          response += `  - ${error.endpoint}: ${error.error}\n`;
        });
      }
    }
    
    return response;
  }

  /**
   * Get plain text status
   */
  getPlainStatus(executionResults) {
    if (!executionResults) return 'Processing';
    
    const { successful = 0, totalCalls = 0 } = executionResults;
    
    if (successful === totalCalls && totalCalls > 0) return 'Success';
    if (successful > 0) return 'Partial Success';
    if (totalCalls > 0) return 'Failed';
    
    return 'Completed';
  }

  /**
   * Check if should show detailed results
   */
  shouldShowDetails(executionResults) {
    if (this.config.verbose) return true;
    if (!executionResults) return false;
    
    const hasFailures = executionResults.failed > 0;
    const hasMultipleOperations = executionResults.totalCalls > 1;
    
    return hasFailures || hasMultipleOperations;
  }

  /**
   * Format error response
   */
  formatError(error, userInput) {
    return `❌ **Error Processing Request**

**Request:** "${userInput}"

**Error:** ${error.message || 'An unexpected error occurred'}

Please try again or contact support if the issue persists.`;
  }

  /**
   * Format timeout response
   */
  formatTimeout(userInput, timeoutDuration) {
    return `⏱️ **Request Timeout**

**Request:** "${userInput}"

The approval request has expired after ${Math.round(timeoutDuration / 60000)} minutes.

Please submit a new request if you still need to perform this operation.`;
  }
}

export default ResponseFormatter;