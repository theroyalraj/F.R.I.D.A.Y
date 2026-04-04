/**
 * Human display name for spoken / notification copy (set FRIDAY_USER_NAME in .env).
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function fridayUserDisplayName(env = process.env) {
  const v = String(env.FRIDAY_USER_NAME || 'Raj').trim();
  return v || 'Raj';
}
