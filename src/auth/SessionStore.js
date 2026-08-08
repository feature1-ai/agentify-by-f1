import crypto from 'crypto';

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

/**
 * In-memory session store for OIDC logins. Keeping sessions server-side (a
 * random id in the cookie, the access token only in process memory) means
 * tokens never reach the browser and the cookie stays tiny.
 *
 * Deliberate tradeoffs, in keeping with agentify's no-database model:
 * a restart logs everyone out (SSO makes re-login a silent redirect), and
 * multi-replica deployments need sticky sessions — or swap this class for a
 * Redis-backed one; this is the seam.
 */
export class SessionStore {
  constructor({ ttlMs } = {}) {
    this.ttlMs = ttlMs
      || parseFloat(process.env.SESSION_TTL_HOURS) * 60 * 60 * 1000
      || DEFAULT_TTL_MS;
    this.sessions = new Map();

    const sweeper = setInterval(() => this.sweep(), 60 * 1000);
    sweeper.unref?.();
  }

  /**
   * @param {object} user            { sub, email, name }
   * @param {object} [options]
   * @param {string} [options.accessToken]  kept in memory only, for downstream pass-through
   * @param {number} [options.maxTtlMs]     cap below the store TTL (e.g. the token's own lifetime)
   */
  create(user, { accessToken = null, maxTtlMs = null } = {}) {
    const id = crypto.randomBytes(32).toString('base64url');
    const ttl = maxTtlMs ? Math.min(this.ttlMs, maxTtlMs) : this.ttlMs;
    this.sessions.set(id, {
      user,
      accessToken,
      expiresAt: Date.now() + ttl
    });
    return id;
  }

  get(id) {
    const session = id ? this.sessions.get(id) : null;
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  delete(id) {
    return this.sessions.delete(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(id);
    }
  }
}
