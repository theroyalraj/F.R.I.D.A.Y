/**
 * Static pattern scan of first-party source (no npm audit).
 * Heuristic rules only — triage with human review.
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_FILES = 6000;
const MAX_FILE_BYTES = 512 * 1024;

/** @type {{ id: string; severity: 'high' | 'medium' | 'low'; re: RegExp; note: string }[]} */
export const CODE_SCAN_RULES = [
  {
    id: 'eval-call',
    severity: 'high',
    re: /\beval\s*\(/g,
    note: 'eval can execute arbitrary strings',
  },
  {
    id: 'new-function',
    severity: 'high',
    re: /\bnew\s+Function\s*\(/g,
    note: 'dynamic Function body is hard to audit',
  },
  {
    id: 'dangerously-set-inner-html',
    severity: 'medium',
    re: /dangerouslySetInnerHTML\s*:/g,
    note: 'ensure HTML is trusted or sanitized',
  },
  {
    id: 'inner-html-assign',
    severity: 'medium',
    re: /\.innerHTML\s*=(?!=)/g,
    note: 'DOM XSS risk if value is user-controlled',
  },
  {
    id: 'document-write',
    severity: 'low',
    re: /\bdocument\.write\s*\(/g,
    note: 'legacy API; often unsafe with untrusted input',
  },
  {
    id: 'pickle-loads',
    severity: 'high',
    re: /\bpickle\.loads\s*\(/g,
    note: 'unpickling untrusted bytes can execute code',
  },
  {
    id: 'subprocess-shell-true',
    severity: 'medium',
    re: /shell\s*=\s*True\b/g,
    note: 'subprocess with shell True — verify arguments are not user-controlled',
  },
];

function severityRank(s) {
  if (s === 'high') return 3;
  if (s === 'medium') return 2;
  return 1;
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function defaultCodeScanRelDirs(repoRoot) {
  const raw = String(process.env.OPENCLAW_CODE_SCAN_DIRS || '').trim();
  if (raw) {
    return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  }
  return ['pc-agent/src', 'skill-gateway/src', 'scripts'];
}

/**
 * @param {string} dir
 * @param {string[]} acc
 */
async function collectSourceFiles(dir, acc) {
  if (acc.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' || e.name === '__pycache__') {
        continue;
      }
      await collectSourceFiles(full, acc);
    } else if (e.isFile()) {
      if (!/\.(js|mjs|cjs|ts|tsx|jsx|py)$/.test(e.name)) continue;
      acc.push(full);
    }
  }
}

/**
 * @param {string} repoRoot
 * @param {string} filePath
 */
function relPath(repoRoot, filePath) {
  const r = path.resolve(repoRoot);
  const f = path.resolve(filePath);
  let rel = path.relative(r, f);
  if (rel.startsWith('..')) return f;
  return rel.split(path.sep).join('/');
}

/**
 * @param {string} content
 * @param {RegExp} re
 * @returns {number[]}
 */
function lineNumbersForRegex(content, re) {
  const lines = content.split(/\r?\n/);
  const out = [];
  const flags = re.flags.replace(/g/g, '');
  const lineRe = new RegExp(re.source, flags);
  for (let i = 0; i < lines.length; i++) {
    lineRe.lastIndex = 0;
    if (lineRe.test(lines[i])) out.push(i + 1);
  }
  return out;
}

/**
 * @param {{ repoRoot: string }} opts
 */
export async function runCodeSecurityScan(opts) {
  const repoRoot = path.resolve(opts.repoRoot);
  const relDirs = defaultCodeScanRelDirs(repoRoot);
  /** @type {string[]} */
  const files = [];
  for (const rd of relDirs) {
    const abs = path.join(repoRoot, rd);
    await collectSourceFiles(abs, files);
    if (files.length >= MAX_FILES) break;
  }

  /** @type {{ file: string; line: number; ruleId: string; severity: string; note: string }[]} */
  const findings = [];

  for (const filePath of files) {
    let buf;
    try {
      buf = await readFile(filePath);
    } catch {
      continue;
    }
    if (buf.length > MAX_FILE_BYTES) continue;
    const content = buf.toString('utf8');
    const rel = relPath(repoRoot, filePath);

    for (const rule of CODE_SCAN_RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      const lines = lineNumbersForRegex(content, re);
      for (const line of lines) {
        findings.push({
          file: rel,
          line,
          ruleId: rule.id,
          severity: rule.severity,
          note: rule.note,
        });
      }
    }
  }

  findings.sort((a, b) => {
    const sr = severityRank(b.severity) - severityRank(a.severity);
    if (sr !== 0) return sr;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  const summary = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    summary[f.severity]++;
  }

  const ranAt = new Date().toISOString();
  return { ranAt, fileCount: files.length, findings, summary };
}

/**
 * @param {string} repoRoot
 * @param {Awaited<ReturnType<typeof runCodeSecurityScan>>} data
 */
export async function writeCodeScanCache(repoRoot, data) {
  const cacheDir = path.join(repoRoot, '.cache');
  await mkdir(cacheDir, { recursive: true });
  const p = path.join(cacheDir, 'code-security-scan.json');
  await writeFile(p, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * @param {string} repoRoot
 */
export async function readCodeScanCache(repoRoot) {
  const p = path.join(path.resolve(repoRoot), '.cache', 'code-security-scan.json');
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function defaultRepoRootFromModule() {
  return path.resolve(__dirname, '../..');
}
