import dotenv from 'dotenv';
import Joi from 'joi';
import logger from '../utils/logger.js';

dotenv.config();

const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number()
    .port()
    .default(3000),
  API_KEY: Joi.string()
    .optional()
    .allow('')
    .description('API key for authentication'),
  OPENAI_API_KEY: Joi.string()
    .required()
    .description('OpenAI API key — Codex CLI logs in with this at container startup'),
  CONTEXT_DIR: Joi.string()
    .optional()
    .allow('')
    .description('Directory mounted as Codex working directory (contains Swagger/OpenAPI specs)'),
  CODEX_MAX_TOKENS: Joi.number()
    .min(1)
    .max(32000)
    .default(4000),
  CODEX_TEMPERATURE: Joi.number()
    .min(0)
    .max(2)
    .default(0.7),
  WEBHOOK_TIMEOUT: Joi.number()
    .min(1000)
    .max(300000)
    .default(30000),
  WEBHOOK_RETRY_ATTEMPTS: Joi.number()
    .min(0)
    .max(10)
    .default(3),
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'debug')
    .default('info'),
  CORS_ORIGIN: Joi.string()
    .default('*')
}).unknown();

const { error, value: envVars } = envSchema.validate(process.env);

if (error && process.env.NODE_ENV !== 'test') {
  logger.error(`Config validation error: ${error.message}`);
  throw new Error(`Config validation error: ${error.message}`);
}

const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  api: {
    key: envVars.API_KEY,
    cors: {
      origin: envVars.CORS_ORIGIN
    }
  },
  codex: {
    openaiApiKey: envVars.OPENAI_API_KEY,
    contextDir: envVars.CONTEXT_DIR,
    maxTokens: envVars.CODEX_MAX_TOKENS,
    temperature: envVars.CODEX_TEMPERATURE
  },
  webhook: {
    timeout: envVars.WEBHOOK_TIMEOUT,
    retryAttempts: envVars.WEBHOOK_RETRY_ATTEMPTS
  },
  logging: {
    level: envVars.LOG_LEVEL
  },
  isProduction: envVars.NODE_ENV === 'production',
  isDevelopment: envVars.NODE_ENV === 'development',
  isTest: envVars.NODE_ENV === 'test'
};

export default config;