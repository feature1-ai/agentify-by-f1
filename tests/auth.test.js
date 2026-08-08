import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { resolveAuthMode } from '../src/auth/mode.js';
import { SessionStore } from '../src/auth/SessionStore.js';
import { createApiAuth } from '../src/auth/middleware.js';
import { createAuthRoutes, SESSION_COOKIE } from '../src/auth/routes.js';
import { applyCredentials } from '../src/workflowRoutes.js';

const snapshot = { AUTH_MODE: process.env.AUTH_MODE, API_KEY: process.env.API_KEY };

describe('Auth mode resolution', () => {
  beforeEach(() => {
    delete process.env.AUTH_MODE;
    delete process.env.API_KEY;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('defaults preserve legacy behavior', () => {
    expect(resolveAuthMode()).toBe('none');
    process.env.API_KEY = 'k';
    expect(resolveAuthMode()).toBe('api-key');
  });

  test('explicit AUTH_MODE wins over API_KEY inference', () => {
    process.env.API_KEY = 'k';
    process.env.AUTH_MODE = 'none';
    expect(resolveAuthMode()).toBe('none');
    process.env.AUTH_MODE = 'oidc';
    expect(resolveAuthMode()).toBe('oidc');
  });

  test('rejects unknown modes', () => {
    process.env.AUTH_MODE = 'saml';
    expect(() => resolveAuthMode()).toThrow('AUTH_MODE must be one of');
  });
});

describe('SessionStore', () => {
  test('create/get round-trips the user and access token', () => {
    const store = new SessionStore({ ttlMs: 60000 });
    const id = store.create({ sub: '1', email: 'a@b.c' }, { accessToken: 'tok' });
    const session = store.get(id);
    expect(session.user.email).toBe('a@b.c');
    expect(session.accessToken).toBe('tok');
  });

  test('sessions expire and unknown ids return null', async () => {
    const store = new SessionStore({ ttlMs: 5 });
    const id = store.create({ sub: '1' });
    await new Promise((r) => setTimeout(r, 15));
    expect(store.get(id)).toBeNull();
    expect(store.get('nope')).toBeNull();
    expect(store.get(undefined)).toBeNull();
  });

  test('maxTtlMs caps the session below the store TTL', () => {
    const store = new SessionStore({ ttlMs: 60000 });
    const id = store.create({ sub: '1' }, { maxTtlMs: 1000 });
    expect(store.get(id).expiresAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('delete removes the session', () => {
    const store = new SessionStore({ ttlMs: 60000 });
    const id = store.create({ sub: '1' });
    store.delete(id);
    expect(store.get(id)).toBeNull();
  });
});

describe('API auth middleware (oidc mode)', () => {
  let sessions, app;

  beforeEach(() => {
    sessions = new SessionStore({ ttlMs: 60000 });
    app = express();
    app.use(cookieParser());
    app.use('/api', createApiAuth({ getMode: () => 'oidc', sessions }));
    app.get('/api/echo', (req, res) => {
      res.json({ user: req.user, downstreamAuth: req.downstreamAuth || null });
    });
  });

  test('rejects requests without a session and points at the login flow', async () => {
    const res = await request(app).get('/api/echo');
    expect(res.status).toBe(401);
    expect(res.body.authMode).toBe('oidc');
    expect(res.body.loginUrl).toBe('/auth/login');
  });

  test('accepts a valid session and attaches the user', async () => {
    const id = sessions.create({ sub: '1', email: 'jane@corp.com', name: 'Jane' });
    const res = await request(app).get('/api/echo').set('Cookie', `${SESSION_COOKIE}=${id}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('jane@corp.com');
    expect(res.body.downstreamAuth).toBeNull();
  });

  test('exposes the access token as downstream auth when present', async () => {
    const id = sessions.create({ sub: '1' }, { accessToken: 'sso-token' });
    const res = await request(app).get('/api/echo').set('Cookie', `${SESSION_COOKIE}=${id}`);
    expect(res.body.downstreamAuth).toEqual({
      authHeaderName: 'Authorization',
      authHeaderValue: 'Bearer sso-token'
    });
  });
});

describe('Auth routes', () => {
  let sessions, app;

  beforeEach(() => {
    sessions = new SessionStore({ ttlMs: 60000 });
    app = express();
    app.use(cookieParser());
    app.use('/auth', createAuthRoutes({ getMode: () => 'oidc', sessions, oidc: null }));
  });

  test('/auth/me reports unauthenticated without a session', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.body).toMatchObject({ authMode: 'oidc', authenticated: false, user: null });
  });

  test('/auth/me reports the logged-in user', async () => {
    const id = sessions.create({ sub: '1', email: 'jane@corp.com', name: 'Jane' });
    const res = await request(app).get('/auth/me').set('Cookie', `${SESSION_COOKIE}=${id}`);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.user).toEqual({ email: 'jane@corp.com', name: 'Jane' });
  });

  test('/auth/me reports plain mode for non-oidc deployments', async () => {
    const plain = express();
    plain.use(cookieParser());
    plain.use('/auth', createAuthRoutes({ getMode: () => 'api-key', sessions, oidc: null }));
    const res = await request(plain).get('/auth/me');
    expect(res.body).toEqual({ success: true, authMode: 'api-key' });
  });

  test('/auth/login 404s when OIDC is not configured', async () => {
    const res = await request(app).get('/auth/login');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not enabled');
  });

  test('/auth/logout destroys the session', async () => {
    const id = sessions.create({ sub: '1' });
    const res = await request(app).post('/auth/logout').set('Cookie', `${SESSION_COOKIE}=${id}`);
    expect(res.status).toBe(200);
    expect(sessions.get(id)).toBeNull();
  });
});

describe('Downstream credential precedence', () => {
  const identity = { authHeaderName: 'Authorization', authHeaderValue: 'Bearer sso-token' };

  test('SSO identity fills in when the request sends no credentials', () => {
    const config = applyCredentials({}, undefined, identity);
    expect(config.rest.authHeaderValue).toBe('Bearer sso-token');
  });

  test('explicit request credentials override the SSO identity', () => {
    const config = applyCredentials(
      {},
      { authHeaderName: 'X-Token', authHeaderValue: 'manual' },
      identity
    );
    expect(config.rest.authHeaderValue).toBe('manual');
    expect(config.rest.authHeaderName).toBe('X-Token');
  });

  test('baseUrl from the request coexists with SSO auth', () => {
    const config = applyCredentials({}, { baseUrl: 'https://api.corp.com' }, identity);
    expect(config.rest.baseUrl).toBe('https://api.corp.com');
    expect(config.rest.authHeaderValue).toBe('Bearer sso-token');
  });

  test('no credentials and no identity leaves config untouched', () => {
    expect(applyCredentials({ existing: true }, undefined, undefined)).toEqual({ existing: true });
  });
});
