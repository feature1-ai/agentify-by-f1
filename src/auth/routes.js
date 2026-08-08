import express from 'express';
import logger from '../logger.js';
import { asyncHandler } from '../errorHandler.js';
import { buildLoginRedirect, exchangeCallback } from './oidc.js';

export const SESSION_COOKIE = 'agentify_session';
const TXN_COOKIE = 'agentify_oidc_txn';

/**
 * /auth/* — mounted OUTSIDE the /api gate so the UI can always discover the
 * auth mode and start a login.
 */
export function createAuthRoutes({ getMode, sessions, oidc }) {
  const router = express.Router();

  // Who am I / what does this deployment expect? The chat UI renders its
  // login state and Settings hints from this.
  router.get('/me', (req, res) => {
    const mode = getMode();
    if (mode !== 'oidc') {
      return res.json({ success: true, authMode: mode });
    }
    const session = sessions.get(req.cookies?.[SESSION_COOKIE]);
    res.json({
      success: true,
      authMode: 'oidc',
      authenticated: Boolean(session),
      user: session ? { email: session.user.email, name: session.user.name } : null,
      forwardAccessToken: Boolean(oidc?.forwardAccessToken)
    });
  });

  router.get('/login', asyncHandler(async (req, res) => {
    if (!oidc) {
      return res.status(404).json({ success: false, error: 'OIDC login is not enabled (AUTH_MODE is not "oidc")' });
    }

    const { url, state, verifier } = await buildLoginRedirect(oidc);
    // Per-login CSRF/PKCE material lives in a short-lived cookie scoped to
    // /auth; it is only useful to the browser that started this login.
    res.cookie(TXN_COOKIE, JSON.stringify({ state, verifier }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: oidc.secureCookies,
      maxAge: 10 * 60 * 1000,
      path: '/auth'
    });
    res.redirect(url);
  }));

  router.get('/callback', asyncHandler(async (req, res) => {
    if (!oidc) {
      return res.status(404).json({ success: false, error: 'OIDC login is not enabled (AUTH_MODE is not "oidc")' });
    }

    const txn = parseTxn(req.cookies?.[TXN_COOKIE]);
    res.clearCookie(TXN_COOKIE, { path: '/auth' });
    if (!txn) {
      return res.status(400).send('Login attempt expired or was not started here. <a href="/auth/login">Try again</a>.');
    }

    const currentUrl = new URL(req.originalUrl, oidc.publicBaseUrl);
    const { user, accessToken, expiresInMs } = await exchangeCallback(oidc, currentUrl, txn);

    const sessionId = sessions.create(user, {
      accessToken: oidc.forwardAccessToken ? accessToken : null,
      // With pass-through, a session outliving its token would just produce
      // downstream 401s — cap the session to the token's lifetime instead.
      maxTtlMs: oidc.forwardAccessToken ? expiresInMs : null
    });

    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: oidc.secureCookies,
      maxAge: sessions.ttlMs,
      path: '/'
    });

    logger.info(`OIDC login: ${user.email || user.sub}`);
    res.redirect('/');
  }));

  router.post('/logout', (req, res) => {
    sessions.delete(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ success: true });
  });

  return router;
}

const parseTxn = (raw) => {
  try {
    const txn = JSON.parse(raw);
    return txn?.state && txn?.verifier ? txn : null;
  } catch {
    return null;
  }
};
