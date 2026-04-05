/**
 * Email domain → corporate vs consumer (generic) tenant rules.
 * Generic inbox providers get a personal org per user; corporate domains share one org per domain.
 */

const DEFAULT_GENERIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'mail.com',
  'hey.com',
  'fastmail.com',
  'tutanota.com',
  'pm.me',
]);

function parseGenericDomainsFromEnv() {
  const raw = (process.env.OPENCLAW_GENERIC_EMAIL_DOMAINS || '').trim();
  if (!raw) return new Set();
  const extra = new Set();
  for (const part of raw.split(',')) {
    const d = part.trim().toLowerCase();
    if (d) extra.add(d);
  }
  return extra;
}

/** @param {string} email */
export function emailDomain(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1) return '';
  return e.slice(at + 1).trim();
}

/** @param {string} domain */
export function isGenericEmailDomain(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return true;
  if (DEFAULT_GENERIC_DOMAINS.has(d)) return true;
  if (parseGenericDomainsFromEnv().has(d)) return true;
  return false;
}

/** @param {string} domain — corporate registrable domain */
export function defaultOrgNameFromDomain(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return 'Personal';
  const first = d.split('.')[0] || d;
  if (!first) return 'Personal';
  return first.charAt(0).toUpperCase() + first.slice(1);
}
