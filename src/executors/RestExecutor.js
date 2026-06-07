import axios from 'axios';
import logger from '../utils/logger.js';

/**
 * RestExecutor — generic HTTP executor used by the API Matching Workflow.
 *
 * Configuration (env, all optional):
 *   BASE_URL              Base URL prepended to each call's endpoint
 *   AUTH_HEADER_NAME      Header name for static auth (e.g. "Authorization")
 *   AUTH_HEADER_VALUE     Header value (e.g. "Bearer eyJ...")
 *   REQUEST_TIMEOUT_MS    Per-request timeout (default 30000)
 *
 * Per-call shape (passed to executeBulkAPICalls):
 *   { method, endpoint, pathParams?, queryParams?, body?, headers? }
 *
 * Audit events are written to the application logger; users can pipe
 * Winston output to a sink of their choice if they need a separate trail.
 */
export class RestExecutor {
  constructor(config = {}) {
    this.config = {
      baseUrl: process.env.BASE_URL || '',
      authHeaderName: process.env.AUTH_HEADER_NAME || '',
      authHeaderValue: process.env.AUTH_HEADER_VALUE || '',
      timeout: parseInt(process.env.REQUEST_TIMEOUT_MS) || 30000,
      ...config
    };

    const defaultHeaders = { 'Content-Type': 'application/json' };
    if (this.config.authHeaderName && this.config.authHeaderValue) {
      defaultHeaders[this.config.authHeaderName] = this.config.authHeaderValue;
    }

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: defaultHeaders,
      validateStatus: () => true
    });
  }

  interpolatePath(endpoint, pathParams = {}) {
    return endpoint.replace(/\{([^}]+)\}/g, (_, key) => {
      const value = pathParams[key];
      if (value === undefined || value === null) {
        throw new Error(`Missing path parameter: ${key} (in ${endpoint})`);
      }
      return encodeURIComponent(String(value));
    });
  }

  async executeAPICall(apiCall) {
    const method = (apiCall.method || 'GET').toUpperCase();
    const url = this.interpolatePath(apiCall.endpoint || '', apiCall.pathParams);

    try {
      const response = await this.client.request({
        method,
        url,
        params: apiCall.queryParams,
        data: apiCall.body,
        headers: apiCall.headers
      });

      const success = response.status >= 200 && response.status < 300;
      return {
        success,
        method,
        endpoint: apiCall.endpoint,
        status: response.status,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        method,
        endpoint: apiCall.endpoint,
        error: error.message
      };
    }
  }

  async executeBulkAPICalls(apiCalls = []) {
    const results = [];
    let successful = 0;
    let failed = 0;

    for (const call of apiCalls) {
      const result = await this.executeAPICall(call);
      results.push(result);
      if (result.success) successful++;
      else failed++;
    }

    return {
      totalCalls: apiCalls.length,
      successful,
      failed,
      results
    };
  }

  async logAuditEvent(event) {
    logger.info('Audit event', { audit: true, ...event });
  }
}

export default RestExecutor;
