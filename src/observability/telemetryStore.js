import logger from '../utils/logger.js';

const counters = new Map();

export const incrementCounter = (name, tags = {}) => {
  const key = `${name}::${JSON.stringify(tags)}`;
  const current = counters.get(key) || 0;
  const next = current + 1;
  counters.set(key, next);

  logger.info('Telemetry counter incremented', {
    name,
    tags,
    value: next
  });

  return next;
};

export const getCounter = (name, tags = {}) => {
  const key = `${name}::${JSON.stringify(tags)}`;
  return counters.get(key) || 0;
};

export const resetTelemetry = () => {
  counters.clear();
};
