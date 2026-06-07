import logger from '../utils/logger.js';

const auditEvents = [];

export const recordAuditEvent = (event) => {
  const enrichedEvent = {
    ...event,
    timestamp: new Date().toISOString()
  };

  auditEvents.push(enrichedEvent);
  logger.info('Audit event recorded', enrichedEvent);

  return enrichedEvent;
};

export const listAuditEvents = (filter = {}) => {
  if (!filter || Object.keys(filter).length === 0) {
    return [...auditEvents];
  }

  return auditEvents.filter((event) => {
    return Object.entries(filter).every(([key, value]) => event[key] === value);
  });
};

export const resetAuditEvents = () => {
  auditEvents.length = 0;
};
