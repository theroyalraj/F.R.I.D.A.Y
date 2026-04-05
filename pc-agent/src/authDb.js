import bcrypt from 'bcryptjs';
import { getPool, usesSqliteBackend } from './perceptionDb.js';

const SALT_ROUNDS = 10;

export class AuthDbError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requirePgPool() {
  if (usesSqliteBackend()) {
    throw new AuthDbError('SQLITE_BACKEND', 'User auth requires Postgres (OPENCLAW_DATABASE_URL). SQLite backend is not supported for login.');
  }
  const pool = getPool();
  if (!pool) {
    throw new AuthDbError('NO_DATABASE', 'Database not configured — set OPENCLAW_DATABASE_URL.');
  }
  return pool;
}

/**
 * @param {string} email
 * @param {string} password
 * @param {string} [name]
 * @returns {Promise<{ id: string, email: string, name: string }>}
 */
export async function createUser(email, password, name = '') {
  const pool = requirePgPool();
  const em = String(email || '').trim().toLowerCase();
  const pw = String(password || '');
  const nm = String(name || '').trim();
  if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
    throw new AuthDbError('INVALID_EMAIL', 'Valid email is required');
  }
  if (pw.length < 8) {
    throw new AuthDbError('WEAK_PASSWORD', 'Password must be at least 8 characters');
  }

  const passwordHash = await bcrypt.hash(pw, SALT_ROUNDS);
  try {
    const r = await pool.query(
      `INSERT INTO openclaw_users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name`,
      [em, passwordHash, nm],
    );
    return r.rows[0];
  } catch (e) {
    if (e.code === '23505') {
      throw new AuthDbError('EMAIL_EXISTS', 'An account with this email already exists');
    }
    throw e;
  }
}

/**
 * @param {string} email
 * @returns {Promise<{ id: string, email: string, name: string, password_hash: string }|null>}
 */
export async function findUserByEmail(email) {
  const pool = requirePgPool();
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  const r = await pool.query(
    'SELECT id, email, name, password_hash FROM openclaw_users WHERE lower(email) = lower($1)',
    [em],
  );
  return r.rows[0] ?? null;
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, email: string, name: string }|null>}
 */
export async function findUserById(id) {
  const pool = requirePgPool();
  if (!id) return null;
  const r = await pool.query('SELECT id, email, name FROM openclaw_users WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

/**
 * @param {string} plain
 * @param {string} hash
 */
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(String(plain || ''), String(hash || ''));
}
