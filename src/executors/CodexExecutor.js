import { spawn, execFile } from 'child_process';
import logger from '../logger.js';
import { resolveContextDir } from '../contextDir.js';

const DEFAULT_TIMEOUT_MS = 120000;

export class CodexExecutor {
  constructor(config = {}) {
    this.config = {
      maxTokens: parseInt(process.env.CODEX_MAX_TOKENS) || 4000,
      temperature: parseFloat(process.env.CODEX_TEMPERATURE) || 0.7,
      workingDir: resolveContextDir(),
      timeoutMs: parseInt(process.env.CODEX_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
      // codex's own sandbox (seatbelt/bubblewrap). read-only suits spec
      // reading; inside Docker set CODEX_SANDBOX=danger-full-access — the
      // container is the isolation boundary and bubblewrap can't create
      // namespaces under Docker's default seccomp profile.
      sandboxMode: process.env.CODEX_SANDBOX || 'read-only',
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
      let timedOut = false;

      logger.info('Executing Codex with prompt', {
        promptLength: fullPrompt.length,
        cwd: mergedOptions.workingDir,
        timeoutMs: mergedOptions.timeoutMs,
        sandbox: mergedOptions.sandboxMode
      });

      // --skip-git-repo-check: CONTEXT_DIR is often a plain data directory
      // (always so in Docker), and codex exec refuses to run outside a git
      // repo without it.
      const codexProcess = spawn(
        'codex',
        ['exec', '--skip-git-repo-check', '--sandbox', mergedOptions.sandboxMode, fullPrompt],
        {
          env: process.env,
          cwd: mergedOptions.workingDir,
          // stdin is closed on purpose: if codex ever stops to prompt for
          // input, it must fail immediately instead of hanging the request.
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      // A stuck subprocess must never hang the HTTP request.
      const timer = setTimeout(() => {
        timedOut = true;
        codexProcess.kill('SIGKILL');
      }, mergedOptions.timeoutMs);

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
        // info, not debug: codex explains its failures (auth, network,
        // untrusted dir) on stderr, and hiding that costs debugging sessions.
        logger.info('Codex stderr', { stderr: stderrChunk.trim() });
        if (onProgress) {
          onProgress({ stream: 'stderr', chunk: stderrChunk });
        }
      });

      codexProcess.on('error', (error) => {
        clearTimeout(timer);
        logger.error('Failed to start Codex process:', error);
        reject({
          success: false,
          error: `Failed to start the Codex CLI: ${error.message}. Ensure it is installed for this platform and logged in.`
        });
      });

      codexProcess.on('close', (code, signal) => {
        clearTimeout(timer);
        const executionTime = Date.now() - startTime;
        const stderrTail = errorOutput.trim().slice(-500);

        if (timedOut) {
          logger.error('Codex timed out', { timeoutMs: mergedOptions.timeoutMs, executionTime });
          return reject({
            success: false,
            error: `codex timed out after ${mergedOptions.timeoutMs}ms${stderrTail ? ` — last stderr: ${stderrTail}` : ''}`,
            executionTime
          });
        }

        if (code === 0) {
          logger.info(`Codex execution completed in ${executionTime}ms`);
          return resolve({
            success: true,
            output: output.trim(),
            executionTime,
            metadata: {
              promptLength: fullPrompt.length,
              responseLength: output.length
            }
          });
        }

        logger.error('Codex process exited', { code, signal, executionTime, stderr: errorOutput.trim() });
        reject({
          success: false,
          error: `codex exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`,
          stderr: errorOutput,
          executionTime
        });
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

/**
 * Boot-time sanity check: surfaces a missing or wrong-architecture codex
 * binary at startup instead of on the first chat request.
 */
export function logCodexVersion() {
  execFile('codex', ['--version'], (error, stdout) => {
    if (error) {
      logger.warn(`Codex CLI check failed (${error.message}) — chats will fail until it is installed and logged in`);
    } else {
      logger.info(`Codex CLI: ${stdout.trim()}`);
    }
  });
}

export default CodexExecutor;
