import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONTEXT_DIR = path.join(__dirname, '../../resources/contexts');

function resolveContextDir(value) {
  if (!value) return DEFAULT_CONTEXT_DIR;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export class CodexExecutor {
  constructor(config = {}) {
    this.config = {
      maxTokens: parseInt(process.env.CODEX_MAX_TOKENS) || 4000,
      temperature: parseFloat(process.env.CODEX_TEMPERATURE) || 0.7,
      workingDir: resolveContextDir(process.env.CONTEXT_DIR),
      ...config
    };
  }

  buildPromptWithContext(prompt, context) {
    let fullPrompt = '';

    if (context && Object.keys(context).length > 0) {
      fullPrompt += '## Context:\n';

      for (const [key, value] of Object.entries(context)) {
        if (typeof value === 'object') {
          fullPrompt += `### ${key}:\n${JSON.stringify(value, null, 2)}\n\n`;
        } else {
          fullPrompt += `### ${key}:\n${value}\n\n`;
        }
      }
    }

    fullPrompt += '## Task:\n' + prompt;

    return fullPrompt;
  }

  async execute(prompt, context = {}, options = {}) {
    const fullPrompt = this.buildPromptWithContext(prompt, context);
    const mergedOptions = { ...this.config, ...options };
    const onProgress = typeof mergedOptions.onProgress === 'function'
      ? mergedOptions.onProgress
      : null;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let output = '';
      let errorOutput = '';

      const args = [
        'exec',
        fullPrompt
      ];

      logger.info('Executing Codex with prompt', {
        promptLength: fullPrompt.length,
        maxTokens: mergedOptions.maxTokens,
        temperature: mergedOptions.temperature,
        cwd: mergedOptions.workingDir
      });

      const codexProcess = spawn('codex', args, {
        env: process.env,
        cwd: mergedOptions.workingDir
      });

      codexProcess.stdout.on('data', (data) => {
        const stdoutChunk = data.toString();
        output += stdoutChunk;
        if (onProgress) {
          onProgress({ stream: 'stdout', chunk: stdoutChunk });
        }
      });

      codexProcess.stderr.on('data', (data) => {
        const stderrChunk = data.toString();
        errorOutput += stderrChunk;
        logger.debug('Codex stderr', { stderr: stderrChunk.trim() });
        if (onProgress) {
          onProgress({ stream: 'stderr', chunk: stderrChunk });
        }
      });

      codexProcess.on('error', (error) => {
        logger.error('Failed to start Codex process:', error);
        reject({
          success: false,
          error: error.message,
          details: 'Failed to start Codex CLI. Ensure it is installed and accessible.'
        });
      });

      codexProcess.on('close', (code, signal) => {
        const executionTime = Date.now() - startTime;

        if (code === 0) {
          logger.info(`Codex execution completed in ${executionTime}ms`);
          resolve({
            success: true,
            output: output.trim(),
            executionTime,
            metadata: {
              promptLength: fullPrompt.length,
              responseLength: output.length,
              maxTokens: mergedOptions.maxTokens,
              temperature: mergedOptions.temperature
            }
          });
        } else {
          logger.error('Codex process exited', { code, signal, executionTime });
          reject({
            success: false,
            error: `Process exited with code ${code}`,
            stderr: errorOutput,
            executionTime
          });
        }
      });

    });
  }

  async executeStream(prompt, context = {}, options = {}, onData) {
    const fullPrompt = this.buildPromptWithContext(prompt, context);
    const mergedOptions = { ...this.config, ...options };

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let output = '';
      let errorOutput = '';

      const args = [
        'exec',
        '--stream',
        '--max-tokens', mergedOptions.maxTokens.toString(),
        '--temperature', mergedOptions.temperature.toString(),
        fullPrompt
      ];

      logger.info('Executing Codex in stream mode', { cwd: mergedOptions.workingDir });

      const codexProcess = spawn('codex', args, {
        env: process.env,
        cwd: mergedOptions.workingDir
      });

      codexProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;

        if (onData && typeof onData === 'function') {
          onData(chunk);
        }
      });

      codexProcess.stderr.on('data', (data) => {
        const stderrChunk = data.toString();
        errorOutput += stderrChunk;
        logger.debug('Codex stderr', { stderr: stderrChunk.trim() });
      });

      codexProcess.on('error', (error) => {
        logger.error('Failed to start Codex process:', error);
        reject({
          success: false,
          error: error.message,
          details: 'Failed to start Codex CLI. Ensure it is installed and accessible.'
        });
      });

      codexProcess.on('close', (code, signal) => {
        const executionTime = Date.now() - startTime;

        if (code === 0) {
          logger.info(`Codex stream execution completed in ${executionTime}ms`);
          resolve({
            success: true,
            output: output.trim(),
            executionTime,
            metadata: {
              promptLength: fullPrompt.length,
              responseLength: output.length,
              mode: 'stream'
            }
          });
        } else {
          logger.error('Codex process exited', { code, signal, executionTime });
          reject({
            success: false,
            error: `Process exited with code ${code}`,
            stderr: errorOutput,
            executionTime
          });
        }
      });

    });
  }

  validateConfig() {
    const errors = [];

    if (this.config.maxTokens < 1 || this.config.maxTokens > 32000) {
      errors.push('maxTokens must be between 1 and 32000');
    }

    if (this.config.temperature < 0 || this.config.temperature > 2) {
      errors.push('temperature must be between 0 and 2');
    }

    if (!this.config.workingDir) {
      errors.push('workingDir is not set');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export default CodexExecutor;
