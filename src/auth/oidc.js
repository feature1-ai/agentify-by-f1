import * as client from 'openid-client';
import logger from '../logger.js';

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when AUTH_MODE=oidc (see .env.example)`);
  }
  return value;
};

/**
 * OIDC integration via openid-client (authorization code flow + PKCE).
 * Runs discovery once at boot and fails loud on misconfiguration — a broken
 * IdP setup should stop the deploy, not surface on the first login attempt.
 */
export async function initOidc() {
  const issuerUrl = requiredEnv('OIDC_ISSUER_URL');
  const clientId = requiredEnv('OIDC_CLIENT_ID');
  const clientSecret = requiredEnv('OIDC_CLIENT_SECRET');
  const publicBaseUrl = requiredEnv('PUBLIC_BASE_URL').replace(/\/$/, '');

  const config = await client.discovery(new URL(issuerUrl), clientId, clientSecret);
  logger.info(`OIDC discovery complete: ${issuerUrl}`);

  return {
    config,
    publicBaseUrl,
    redirectUri: `${publicBaseUrl}/auth/callback`,
    scopes: process.env.OIDC_SCOPES || 'openid profile email',
    // When enabled, the logged-in user's access token becomes the default
    // downstream Authorization header — every API call runs as that user.
    forwardAccessToken: process.env.OIDC_FORWARD_ACCESS_TOKEN === 'true',
    secureCookies: publicBaseUrl.startsWith('https://')
  };
}

/** Start a login: returns the IdP redirect plus the per-login CSRF/PKCE material. */
export async function buildLoginRedirect(oidc) {
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();

  const url = client.buildAuthorizationUrl(oidc.config, {
    redirect_uri: oidc.redirectUri,
    scope: oidc.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  return { url: url.href, state, verifier };
}

/** Finish a login: exchange the callback code for tokens and extract the identity. */
export async function exchangeCallback(oidc, currentUrl, { state, verifier }) {
  const tokens = await client.authorizationCodeGrant(oidc.config, currentUrl, {
    pkceCodeVerifier: verifier,
    expectedState: state
  });

  const claims = tokens.claims();
  return {
    user: {
      sub: claims.sub,
      email: claims.email || null,
      name: claims.name || claims.preferred_username || claims.email || claims.sub
    },
    accessToken: tokens.access_token || null,
    expiresInMs: tokens.expires_in ? tokens.expires_in * 1000 : null
  };
}
