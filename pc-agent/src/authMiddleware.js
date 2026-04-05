import jwt from 'jsonwebtoken';

export function getJwtSecret() {
  const s = (process.env.JWT_SECRET || '').trim();
  if (!s) {
    const err = new Error('JWT_SECRET is not set in environment');
    err.code = 'JWT_SECRET_MISSING';
    throw err;
  }
  return s;
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function jwtAuth(req, res, next) {
  let secret;
  try {
    secret = getJwtSecret();
  } catch (e) {
    if (e.code === 'JWT_SECRET_MISSING') {
      return res.status(503).json({ error: 'Server auth is not configured (JWT_SECRET).' });
    }
    throw e;
  }
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const decoded = jwt.verify(token, secret);
    req.user = {
      id: decoded.sub,
      email: String(decoded.email || ''),
      orgId: decoded.orgId,
      role: decoded.role === 'admin' || decoded.role === 'member' ? decoded.role : 'member',
    };
    req.authMode = 'user';
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Accept PC_AGENT_SECRET (daemon/N8N) or valid user JWT.
 * @param {string} agentSecret
 */
export function authJwtOrAgentSecret(agentSecret) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const SECRET = String(agentSecret || '').trim();
    if (SECRET && token === SECRET) {
      req.authMode = 'agent';
      req.user = undefined;
      return next();
    }
    return jwtAuth(req, res, next);
  };
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only organization admins can change company settings.' });
  }
  next();
}

/**
 * @param {string} userId
 * @param {string} email
 * @param {string} orgId
 * @param {'admin'|'member'} role
 */
export function signUserToken(userId, email, orgId, role) {
  return jwt.sign(
    { sub: userId, email, orgId, role },
    getJwtSecret(),
    { expiresIn: '30d' },
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Todos/reminders tenancy: Bearer PC_AGENT_SECRET → optional env default org/user, else legacy NULL bucket.
 * Valid user JWT → orgId + sub (user id). No auth → legacy NULL bucket.
 * Invalid Bearer (not secret, not valid JWT) → 401.
 * Sets req.todoScope = { orgId: string|null, userId: string|null }, req.todoAuthKind.
 * @param {string} agentSecret PC_AGENT_SECRET
 */
export function todoRequestContext(agentSecret) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const SECRET = String(agentSecret || '').trim();

    if (SECRET && token === SECRET) {
      req.todoAuthKind = 'agent';
      const o = (process.env.OPENCLAW_TODO_DEFAULT_ORG_ID || '').trim();
      const u = (process.env.OPENCLAW_TODO_DEFAULT_USER_ID || '').trim();
      req.todoScope =
        o && u && UUID_RE.test(o) && UUID_RE.test(u)
          ? { orgId: o, userId: u }
          : { orgId: null, userId: null };
      return next();
    }

    if (!token) {
      req.todoAuthKind = 'anonymous';
      req.todoScope = { orgId: null, userId: null };
      return next();
    }

    try {
      const secret = getJwtSecret();
      const decoded = jwt.verify(token, secret);
      const orgId = decoded.orgId != null ? String(decoded.orgId).trim() : '';
      const userId = decoded.sub != null ? String(decoded.sub).trim() : '';
      if (!orgId || !userId || !UUID_RE.test(orgId) || !UUID_RE.test(userId)) {
        return res.status(401).json({ error: 'Invalid token scope for todos' });
      }
      req.todoAuthKind = 'user';
      req.todoScope = { orgId, userId };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
