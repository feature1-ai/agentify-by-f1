import logger from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * ApprovalManager - Responsible for managing approval workflow
 * Single Responsibility: Approval request generation, tracking, and validation
 */
export class ApprovalManager {
  constructor(config = {}) {
    this.config = {
      defaultTimeout: 300000, // 5 minutes
      autoApproveRiskLevel: config.autoApproveRiskLevel || null,
      requireApproval: config.requireApproval !== false,
      ...config
    };
    
    // In-memory storage for pending approvals
    // In production, this should be Redis or database
    this.pendingApprovals = new Map();
  }

  /**
   * Check if approval is required based on intent and configuration
   */
  requiresApproval(intent, apiCalls) {
    // If approval is disabled globally
    if (!this.config.requireApproval) {
      return false;
    }
    
    // Auto-approve low risk operations if configured
    if (this.config.autoApproveRiskLevel) {
      const riskLevels = ['low', 'medium', 'high'];
      const intentRiskIndex = riskLevels.indexOf(intent.riskLevel);
      const autoApproveIndex = riskLevels.indexOf(this.config.autoApproveRiskLevel);
      
      if (intentRiskIndex <= autoApproveIndex) {
        logger.info(`Auto-approving ${intent.riskLevel} risk operation`);
        return false;
      }
    }
    
    // Check specific conditions. These are generic, domain-neutral signals;
    // the agent's own riskLevel assessment is the primary driver.
    const riskyActions = ['delete', 'disable', 'remove', 'destroy'];
    const sensitiveResources = ['user', 'account', 'auth', 'security', 'permission'];
    
    const isRiskyAction = riskyActions.includes(intent.action);
    const isSensitiveResource = sensitiveResources.includes(intent.resource);
    const isHighRisk = intent.riskLevel === 'high';
    const isMediumRisk = intent.riskLevel === 'medium';
    const hasBulkOperation = apiCalls.length > 1;
    
    return isHighRisk || (isMediumRisk && isRiskyAction) || 
           (isRiskyAction && isSensitiveResource) || 
           (hasBulkOperation && isRiskyAction);
  }

  /**
   * Generate approval request with detailed information
   */
  generateApprovalRequest(intent, apiCalls, userInput) {
    logger.info("Generating approval request");
    
    const approvalId = uuidv4();
    const request = {
      id: approvalId,
      timestamp: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.config.defaultTimeout).toISOString(),
      userInput,
      intent,
      apiCalls,
      status: 'pending',
      message: this.formatApprovalMessage(intent, apiCalls, userInput)
    };
    
    // Store pending approval
    this.pendingApprovals.set(approvalId, request);
    
    // Set timeout for auto-rejection
    setTimeout(() => {
      if (this.pendingApprovals.has(approvalId)) {
        this.handleTimeout(approvalId);
      }
    }, this.config.defaultTimeout);
    
    return request;
  }

  /**
   * Format approval message for display
   */
  formatApprovalMessage(intent, apiCalls, userInput) {
    const sections = [];
    
    // Header
    sections.push(this.formatHeader(intent.riskLevel));
    
    // Request details
    sections.push(this.formatRequestDetails(userInput, intent));
    
    // API calls breakdown
    sections.push(this.formatAPICalls(apiCalls));
    
    // Impact analysis
    sections.push(this.formatImpactAnalysis(intent, apiCalls));
    
    // Approval instructions
    sections.push(this.formatInstructions());
    
    return sections.join('\n\n');
  }

  formatHeader(riskLevel) {
    const riskEmoji = {
      low: '🟢',
      medium: '🟡',
      high: '🔴'
    };
    
    return `🔔 **APPROVAL REQUIRED** ${riskEmoji[riskLevel] || '⚠️'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  formatRequestDetails(userInput, intent) {
    return `📝 **Original Request:** "${userInput}"

⚠️  **Risk Level:** ${intent.riskLevel?.toUpperCase() || 'UNKNOWN'}

🎯 **Intent Analysis:**
   • Action: ${intent.action}
   • Resource: ${intent.resource}
   • Targets: ${intent.entities?.join(', ') || 'None specified'}
   ${intent.conditions && Object.keys(intent.conditions).length > 0 
     ? `• Conditions: ${JSON.stringify(intent.conditions, null, 2)}` 
     : ''}`;
  }

  formatAPICalls(apiCalls) {
    let message = `📋 **Actions to be performed (${apiCalls.length} operation${apiCalls.length > 1 ? 's' : ''}):**`;
    
    apiCalls.forEach((call, index) => {
      message += `\n\n   ${index + 1}. ${call.description || 'API Call'}
      • Service: ${call.service.toUpperCase()}
      • Endpoint: ${call.method} ${call.endpoint}`;
      
      if (call.pathParams) {
        message += `\n      • Target: ${Object.values(call.pathParams).join(', ')}`;
      }
      
      if (call.queryParams) {
        message += `\n      • Filters: ${JSON.stringify(call.queryParams)}`;
      }
      
      if (call.body) {
        const bodyStr = JSON.stringify(call.body, null, 8);
        message += `\n      • Changes:\n         ${bodyStr.split('\n').join('\n         ')}`;
      }
    });
    
    return message;
  }

  formatImpactAnalysis(intent, apiCalls) {
    let impact = `⚡ **Impact Analysis:**`;
    
    // Action-specific impacts
    switch (intent.action) {
      case 'delete':
        impact += `
   • ⚠️  PERMANENT deletion of ${apiCalls.length} ${intent.resource}(s)
   • This action CANNOT be undone
   • All associated data will be removed
   • Dependent resources may be affected`;
        break;
        
      case 'disable':
        impact += `
   • 🔒 ${intent.resource} will be DISABLED for ${intent.entities?.length || apiCalls.length} target(s)
   • Affected users will lose access to this feature
   • Changes take effect immediately
   • Can be reversed by re-enabling`;
        break;
        
      case 'create':
        impact += `
   • ➕ ${apiCalls.length} new ${intent.resource}(s) will be created
   • Default permissions will be applied
   • Resources will be immediately available
   • May affect quotas or limits`;
        break;
        
      case 'update':
        impact += `
   • ✏️  ${apiCalls.length} ${intent.resource}(s) will be modified
   • Previous values will be overwritten
   • Changes are immediate
   • Some changes may trigger notifications`;
        break;
        
      default:
        impact += `
   • ${apiCalls.length} operation(s) will be performed
   • Changes may affect system state
   • Review details above carefully`;
    }
    
    // Add audit trail note
    impact += `\n   • 📝 All actions will be logged in audit trail`;
    
    return impact;
  }

  formatInstructions() {
    return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **To approve:** Reply with "approve", "yes", or "confirm"
❌ **To reject:** Reply with "reject", "no", or "cancel"
📝 **To modify:** Describe the changes needed
ℹ️  **For details:** Reply with "explain" or "more info"

⏱️ This request will timeout in ${Math.round(this.config.defaultTimeout / 60000)} minutes if no response is received.`;
  }

  /**
   * Process approval response
   */
  async processApprovalResponse(approvalId, response) {
    const approval = this.pendingApprovals.get(approvalId);
    
    if (!approval) {
      return {
        success: false,
        error: 'Approval request not found or expired'
      };
    }
    
    if (approval.status !== 'pending') {
      return {
        success: false,
        error: `Approval already ${approval.status}`
      };
    }
    
    const normalizedResponse = response.toLowerCase().trim();
    const result = this.interpretResponse(normalizedResponse);
    
    if (result.action === 'approve') {
      return this.approveRequest(approvalId);
    } else if (result.action === 'reject') {
      return this.rejectRequest(approvalId, result.reason);
    } else if (result.action === 'info') {
      return this.getApprovalDetails(approvalId);
    } else {
      return {
        success: false,
        error: 'Invalid response. Please use: approve, reject, or explain'
      };
    }
  }

  /**
   * Interpret user response
   */
  interpretResponse(response) {
    const approvalKeywords = ['approve', 'yes', 'confirm', 'ok', 'proceed', 'go ahead'];
    const rejectionKeywords = ['reject', 'no', 'cancel', 'stop', 'deny', 'abort'];
    const infoKeywords = ['explain', 'more', 'info', 'details', 'what', 'why'];
    
    if (approvalKeywords.some(keyword => response.includes(keyword))) {
      return { action: 'approve' };
    }
    
    if (rejectionKeywords.some(keyword => response.includes(keyword))) {
      return { action: 'reject', reason: 'User rejected' };
    }
    
    if (infoKeywords.some(keyword => response.includes(keyword))) {
      return { action: 'info' };
    }
    
    return { action: 'unknown' };
  }

  /**
   * Approve request
   */
  approveRequest(approvalId) {
    const approval = this.pendingApprovals.get(approvalId);
    
    approval.status = 'approved';
    approval.approvedAt = new Date().toISOString();
    approval.approvedBy = 'user'; // In production, track actual user
    
    logger.info(`Approval ${approvalId} approved`);
    
    return {
      success: true,
      status: 'approved',
      approval
    };
  }

  /**
   * Reject request
   */
  rejectRequest(approvalId, reason = 'User rejected') {
    const approval = this.pendingApprovals.get(approvalId);
    
    approval.status = 'rejected';
    approval.rejectedAt = new Date().toISOString();
    approval.rejectionReason = reason;
    
    logger.info(`Approval ${approvalId} rejected: ${reason}`);
    
    // Remove from pending
    this.pendingApprovals.delete(approvalId);
    
    return {
      success: true,
      status: 'rejected',
      reason,
      approval
    };
  }

  /**
   * Get approval details
   */
  getApprovalDetails(approvalId) {
    const approval = this.pendingApprovals.get(approvalId);
    
    if (!approval) {
      return {
        success: false,
        error: 'Approval not found'
      };
    }
    
    return {
      success: true,
      status: 'info_provided',
      details: {
        ...approval,
        timeRemaining: new Date(approval.expiresAt) - Date.now(),
        apiCallCount: approval.apiCalls.length,
        affectedEntities: approval.intent.entities
      }
    };
  }

  /**
   * Handle timeout
   */
  handleTimeout(approvalId) {
    const approval = this.pendingApprovals.get(approvalId);
    
    if (approval && approval.status === 'pending') {
      approval.status = 'timeout';
      approval.timedOutAt = new Date().toISOString();
      
      logger.warn(`Approval ${approvalId} timed out`);
      
      // Remove from pending
      this.pendingApprovals.delete(approvalId);
    }
  }

  /**
   * Check if approval exists and is valid
   */
  isApprovalValid(approvalId) {
    const approval = this.pendingApprovals.get(approvalId);
    
    if (!approval) return false;
    if (approval.status !== 'approved') return false;
    if (new Date(approval.expiresAt) < new Date()) return false;
    
    return true;
  }

  /**
   * Clean up old approvals
   */
  cleanup() {
    const now = Date.now();
    
    for (const [id, approval] of this.pendingApprovals) {
      if (new Date(approval.expiresAt) < now) {
        this.pendingApprovals.delete(id);
      }
    }
  }

  /**
   * Get all pending approvals
   */
  getPendingApprovals() {
    return Array.from(this.pendingApprovals.values()).filter(
      approval => approval.status === 'pending'
    );
  }
}

export default ApprovalManager;