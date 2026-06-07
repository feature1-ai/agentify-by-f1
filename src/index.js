import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import workflowRoutes from './api/workflowRoutes.js';
import registerWorkflows from './workflows/index.js';
import logger from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

registerWorkflows();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    query: req.query,
    body: req.method === 'POST' ? req.body : undefined
  });
  next();
});

// Gate only the REST API (/api/*) with X-API-Key. The static chat UI, `/`,
// and `/health` stay open so the page can load (and prompt for the key) and
// container healthchecks work even when API_KEY is set.
app.use('/api', (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.API_KEY;

  if (expectedApiKey && apiKey !== expectedApiKey) {
    return res.status(401).json({
      success: false,
      error: 'Invalid API key'
    });
  }

  next();
});

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

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});

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