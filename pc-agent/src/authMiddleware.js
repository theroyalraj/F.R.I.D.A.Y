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
