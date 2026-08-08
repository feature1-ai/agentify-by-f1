export const AUTH_MODES = ['none', 'api-key', 'oidc'];

/**
 * Pluggable authentication, selected by env:
 *   AUTH_MODE=none     open API (local development)
 *   AUTH_MODE=api-key  shared X-API-Key (legacy behavior)
 *   AUTH_MODE=oidc     company SSO via OpenID Connect
 *
 * Unset AUTH_MODE preserves the pre-auth behavior exactly: an API_KEY env
 * implies api-key mode, otherwise the API is open. Resolved per call because
 * the api.test.js suite sets API_KEY after the app module is imported.
 */
export function resolveAuthMode() {
  const explicit = process.env.AUTH_MODE;
  if (explicit) {
    if (!AUTH_MODES.includes(explicit)) {
      throw new Error(`AUTH_MODE must be one of: ${AUTH_MODES.join(', ')} (got "${explicit}")`);
    }
    return explicit;
  }
  return process.env.API_KEY ? 'api-key' : 'none';
}
