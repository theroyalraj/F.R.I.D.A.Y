import express from 'express';
import { findUserByEmail, findUserById, verifyPassword, AuthDbError } from './authDb.js';
import { jwtAuth, signUserToken, getJwtSecret } from './authMiddleware.js';
import { signupWithOrg } from './signupService.js';
import { getMembership, getOrgById } from './orgDb.js';
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
