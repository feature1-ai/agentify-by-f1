import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import workflowRoutes from './workflowRoutes.js';
import registerWorkflows from './workflows/index.js';
import logger from './logger.js';
import { errorHandler, notFoundHandler } from './errorHandler.js';
import { logCodexVersion } from './executors/CodexExecutor.js';
import { resolveAuthMode } from './auth/mode.js';
import { SessionStore } from './auth/SessionStore.js';
import { initOidc } from './auth/oidc.js';
import { createAuthRoutes } from './auth/routes.js';
import { createApiAuth } from './auth/middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

logCodexVersion();
registerWorkflows();

// OIDC discovery happens once at boot and fails loud; the other modes have
// no setup. (Mode is re-resolved per request only for the none/api-key
// split, which the tests toggle at runtime.)
const bootAuthMode = resolveAuthMode();
const sessions = new SessionStore();
const oidc = bootAuthMode === 'oidc' ? await initOidc() : null;
logger.info(`Auth mode: ${bootAuthMode}${oidc?.forwardAccessToken ? ' (forwarding user access tokens to the downstream API)' : ''}`);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  // The stream endpoint reports the created instance via this header; the
  // browser needs it exposed to run the approval flow cross-origin.
  exposedHeaders: ['X-Instance-Id']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    query: req.query,
    body: req.method === 'POST' ? req.body : undefined
  });
  next();
});

// Only /api/* is gated (by whichever AUTH_MODE is configured). The static
// chat UI, `/`, `/health`, and `/auth/*` stay open so the page can load,
// logins can start, and container healthchecks work.
app.use('/auth', createAuthRoutes({ getMode: resolveAuthMode, sessions, oidc }));
app.use('/api', createApiAuth({ getMode: resolveAuthMode, sessions }));

// Serve static files from public directory (drop your own index.html here for a custom landing)
app.use(express.static(path.join(__dirname, '../public')));

// Default landing if no public/index.html is provided
app.get('/', (req, res) => {
  res.json({
    name: 'agentify-by-f1',
    description: 'OpenAPI-spec-driven agent over REST APIs',
    endpoints: {
      health: '/health',
      workflows: '/api/workflows',
      execute: 'POST /api/workflows/execute',
      stream: 'POST /api/workflows/stream'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.use('/api', workflowRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

let server;

if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    logger.info(`AI Agentic Service running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`API Key protection: ${process.env.API_KEY ? 'enabled' : 'disabled'}`);
  });
}

process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

export default app;