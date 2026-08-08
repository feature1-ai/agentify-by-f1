import logger from '../../logger.js';
import { v4 as uuidv4 } from 'uuid';
import ApprovalMessageFormatter from './ApprovalMessageFormatter.js';

/**
 * ApprovalManager - Approval request lifecycle: generation, tracking,
 * decision processing, expiry. Message rendering is delegated to
 * ApprovalMessageFormatter.
 *
 * Approval is mandatory for every execution (see APIMatchingWorkflow's
 * routeFromParameters) — there is deliberately no auto-approve path.
 */
export class ApprovalManager {
  constructor(config = {}) {
    this.config = {
      defaultTimeout: 300000, // 5 minutes
      ...config
    };

    this.formatter = new ApprovalMessageFormatter();

    // In-memory storage for pending approvals.
    // In production, this should be Redis or a database.
    this.pendingApprovals = new Map();
  }

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
      message: this.formatter.format(intent, apiCalls, userInput, this.config.defaultTimeout)
    };

    this.pendingApprovals.set(approvalId, request);

    const timer = setTimeout(() => {
      if (this.pendingApprovals.has(approvalId)) {
        this.handleTimeout(approvalId);
      }
    }, this.config.defaultTimeout);
    timer.unref?.(); // never hold the process open just for an expiry sweep

    return request;
  }

  /**
   * Process an approval decision. Callers (the approve endpoint) normalize
   * the decision to exactly "approve" or "reject" before calling.
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

    const decision = String(response).toLowerCase().trim();

    if (decision === 'approve') {
      return this.approveRequest(approvalId);
    }
    if (decision === 'reject') {
      return this.rejectRequest(approvalId);
    }

    return {
      success: false,
      error: 'Invalid response. Use "approve" or "reject".'
    };
  }

  approveRequest(approvalId) {
    const approval = this.pendingApprovals.get(approvalId);

    approval.status = 'approved';
    approval.approvedAt = new Date().toISOString();

    logger.info(`Approval ${approvalId} approved`);

    return {
      success: true,
      status: 'approved',
      approval
    };
  }

  rejectRequest(approvalId, reason = 'User rejected') {
    const approval = this.pendingApprovals.get(approvalId);

    approval.status = 'rejected';
    approval.rejectedAt = new Date().toISOString();
    approval.rejectionReason = reason;

    logger.info(`Approval ${approvalId} rejected: ${reason}`);

    this.pendingApprovals.delete(approvalId);

    return {
      success: true,
      status: 'rejected',
      reason,
      approval
    };
  }

  handleTimeout(approvalId) {
    const approval = this.pendingApprovals.get(approvalId);

    if (approval && approval.status === 'pending') {
      approval.status = 'timeout';
      approval.timedOutAt = new Date().toISOString();

      logger.warn(`Approval ${approvalId} timed out`);

      this.pendingApprovals.delete(approvalId);
    }
  }

  isApprovalValid(approvalId) {
    const approval = this.pendingApprovals.get(approvalId);

    if (!approval) return false;
    if (approval.status !== 'approved') return false;
    if (new Date(approval.expiresAt) < new Date()) return false;

    return true;
  }
}

export default ApprovalManager;
