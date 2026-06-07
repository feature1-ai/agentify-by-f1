/**
 * API Matching Workflow Services
 * 
 * This module exports all services related to the API Matching Workflow.
 * Each service follows the Single Responsibility Principle:
 * 
 * - IntentAnalyzer: Analyzes user input and extracts intent
 * - APIMapper: Maps intents to API endpoints
 * - ParameterExtractor: Extracts and builds API parameters
 * - ApprovalManager: Manages approval workflow
 * - ResponseFormatter: Formats responses for users
 */

export { IntentAnalyzer } from './IntentAnalyzer.js';
export { APIMapper } from './APIMapper.js';
export { ParameterExtractor } from './ParameterExtractor.js';
export { ApprovalManager } from './ApprovalManager.js';
export { ResponseFormatter } from './ResponseFormatter.js';
export { ContextSelector } from './ContextSelector.js';

// Default exports as named exports for convenience
import IntentAnalyzerDefault from './IntentAnalyzer.js';
import APIMapperDefault from './APIMapper.js';
import ParameterExtractorDefault from './ParameterExtractor.js';
import ApprovalManagerDefault from './ApprovalManager.js';
import ResponseFormatterDefault from './ResponseFormatter.js';

export default {
  IntentAnalyzer: IntentAnalyzerDefault,
  APIMapper: APIMapperDefault,
  ParameterExtractor: ParameterExtractorDefault,
  ApprovalManager: ApprovalManagerDefault,
  ResponseFormatter: ResponseFormatterDefault
};