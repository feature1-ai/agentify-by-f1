import { SESSION_COOKIE } from './routes.js';

/**
 * The /api gate, dispatching on the resolved auth mode per request:
 *   none     open
 *   api-key  legacy shared X-API-Key (open when API_KEY is unset)
 *   oidc     session cookie from the /auth login flow
 *
 * In oidc mode with pass-through enabled, the session's access token is
 * exposed as req.downstreamAuth so the workflow routes can use the caller's
 * own identity for the downstream REST API (explicit request credentials
 * still win — see applyCredentials).
 */
export function createApiAuth({ getMode, sessions }) {
  return (req, res, next) => {
    const mode = getMode();

    if (mode === 'none') {
      return next();
    }

    if (mode === 'api-key') {
      const expected = process.env.API_KEY;
      if (expected && req.headers['x-api-key'] !== expected) {
        return res.status(401).json({ success: false, error: 'Invalid API key' });
      }
      return next();
    }

    const session = sessions.get(req.cookies?.[SESSION_COOKIE]);
    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        authMode: 'oidc',
        loginUrl: '/auth/login'
      });
    }

    req.user = session.user;
    if (session.accessToken) {
      req.downstreamAuth = {
        authHeaderName: 'Authorization',
        authHeaderValue: `Bearer ${session.accessToken}`
      };
    }
    next();
  };
}
