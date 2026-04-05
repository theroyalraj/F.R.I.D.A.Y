import express from 'express';
import { findUserByEmail, findUserById, verifyPassword, AuthDbError } from './authDb.js';
import { jwtAuth, signUserToken, getJwtSecret } from './authMiddleware.js';
import { signupWithOrg } from './signupService.js';
import { getMembership, getOrgById, findFirstUserWithMembershipForAutoLogin } from './orgDb.js';
import { getCompanyProfileByOrgId } from './companyDb.js';

export function createAuthRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));

  r.post('/signup', async (req, res) => {
    const { email, password, name } = req.body || {};
    try {
      getJwtSecret();
    } catch (e) {
      if (e.code === 'JWT_SECRET_MISSING') {
        return res.status(503).json({ error: 'Server auth is not configured (JWT_SECRET).' });
      }
      throw e;
    }
    try {
      const { user, orgId, role } = await signupWithOrg(email, password, name);
      const token = signUserToken(user.id, user.email, orgId, role);
      const org = await getOrgById(orgId);
      const company = await getCompanyProfileByOrgId(orgId);
      res.status(201).json({
        ok: true,
        token,
        user: { id: user.id, email: user.email, name: user.name },
        organization: org ? { id: org.id, domain: org.domain, name: org.name } : null,
        role,
        company,
      });
    } catch (e) {
      if (e instanceof AuthDbError) {
        const code = e.code === 'EMAIL_EXISTS' ? 409 : 400;
        return res.status(code).json({ error: e.message, code: e.code });
      }
      if (e.code === '42P01') {
        return res.status(503).json({
          error:
            'Auth tables are missing in Postgres. Restart pc-agent to apply schema, or run docker/postgres/init/04-auth-company.sql then 05-multitenant-org.sql.',
          code: 'AUTH_SCHEMA_MISSING',
        });
      }
      req.log?.warn({ err: String(e.message), code: e.code }, 'signup failed');
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  /**
   * Vite `npm run ui:dev` — same JWT as auto-session, no PC_AGENT_SECRET.
   * Disabled when NODE_ENV is production, or when PC_AGENT_DEV_SESSION is false or zero.
   */
  r.post('/dev-session', async (req, res) => {
    const prod = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    const devOff = ['0', 'false', 'no', 'off'].includes(
      String(process.env.PC_AGENT_DEV_SESSION || '').trim().toLowerCase(),
    );
    if (prod || devOff) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      getJwtSecret();
    } catch (e) {
      if (e.code === 'JWT_SECRET_MISSING') {
        return res.status(503).json({ error: 'Server auth is not configured (JWT_SECRET).' });
      }
      throw e;
    }
    try {
      const row = await findFirstUserWithMembershipForAutoLogin();
      if (!row) {
        return res.status(404).json({
          error:
            'No organization member yet. Sign up once from Listen (or production build), then dev auto-login works.',
          code: 'NO_MEMBERSHIP',
        });
      }
      const token = signUserToken(row.id, row.email, row.orgId, row.role);
      const org = await getOrgById(row.orgId);
      const company = await getCompanyProfileByOrgId(row.orgId);
      res.json({
        ok: true,
        token,
        user: { id: row.id, email: row.email, name: row.name },
        organization: org ? { id: org.id, domain: org.domain, name: org.name } : null,
        role: row.role,
        company,
      });
    } catch (e) {
      if (e.message?.includes('Organizations require Postgres') || e.message?.includes('not configured')) {
        return res.status(503).json({
          error: 'Database not configured for auth. Set OPENCLAW_DATABASE_URL or sign in manually.',
          code: 'NO_DATABASE',
        });
      }
      req.log?.warn({ err: String(e.message) }, 'dev-session failed');
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  /** Bearer PC_AGENT_SECRET when PC_AGENT_LISTEN_AUTO_LOGIN=true — issues JWT for first org member (Listen UI). */
  r.post('/auto-session', async (req, res) => {
    const enabled = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.PC_AGENT_LISTEN_AUTO_LOGIN || '').trim().toLowerCase(),
    );
    if (!enabled) {
      return res.status(403).json({ error: 'Listen auto-login is disabled (PC_AGENT_LISTEN_AUTO_LOGIN).' });
    }
    const secret = String(process.env.PC_AGENT_SECRET || '').trim();
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!secret || bearer !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      getJwtSecret();
    } catch (e) {
      if (e.code === 'JWT_SECRET_MISSING') {
        return res.status(503).json({ error: 'Server auth is not configured (JWT_SECRET).' });
      }
      throw e;
    }
    try {
      const row = await findFirstUserWithMembershipForAutoLogin();
      if (!row) {
        return res.status(404).json({
          error: 'No user with an organization yet. Sign up once from the Listen page, then auto-login will work.',
          code: 'NO_MEMBERSHIP',
        });
      }
      const token = signUserToken(row.id, row.email, row.orgId, row.role);
      const org = await getOrgById(row.orgId);
      const company = await getCompanyProfileByOrgId(row.orgId);
      res.json({
        ok: true,
        token,
        user: { id: row.id, email: row.email, name: row.name },
        organization: org ? { id: org.id, domain: org.domain, name: org.name } : null,
        role: row.role,
        company,
      });
    } catch (e) {
      if (e.message?.includes('Organizations require Postgres') || e.message?.includes('not configured')) {
        return res.status(503).json({
          error: 'Database not configured for auth. Set OPENCLAW_DATABASE_URL or sign in manually.',
          code: 'NO_DATABASE',
        });
      }
      req.log?.warn({ err: String(e.message) }, 'auto-session failed');
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    try {
      getJwtSecret();
    } catch (e) {
      if (e.code === 'JWT_SECRET_MISSING') {
        return res.status(503).json({ error: 'Server auth is not configured (JWT_SECRET).' });
      }
      throw e;
    }
    const em = String(email || '').trim().toLowerCase();
    if (!em || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    try {
      const user = await findUserByEmail(em);
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const mem = await getMembership(user.id);
      if (!mem) {
        return res.status(403).json({ error: 'Account has no organization membership. Contact support.' });
      }
      const token = signUserToken(user.id, user.email, mem.orgId, mem.role);
      const org = await getOrgById(mem.orgId);
      const company = await getCompanyProfileByOrgId(mem.orgId);
      res.json({
        ok: true,
        token,
        user: { id: user.id, email: user.email, name: user.name },
        organization: org ? { id: org.id, domain: org.domain, name: org.name } : null,
        role: mem.role,
        company,
      });
    } catch (e) {
      req.log?.warn({ err: String(e.message) }, 'login failed');
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.get('/me', jwtAuth, async (req, res) => {
    try {
      const user = await findUserById(req.user.id);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      const org = await getOrgById(req.user.orgId);
      const company = await getCompanyProfileByOrgId(req.user.orgId);
      res.json({
        ok: true,
        user: { id: user.id, email: user.email, name: user.name },
        organization: org ? { id: org.id, domain: org.domain, name: org.name } : null,
        role: req.user.role,
        company,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  return r;
}
