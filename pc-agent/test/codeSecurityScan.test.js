import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCodeSecurityScan, CODE_SCAN_RULES } from '../src/codeSecurityScan.js';

test('CODE_SCAN_RULES has unique ids', () => {
  const ids = CODE_SCAN_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('runCodeSecurityScan finds eval in temp repo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oc-codescan-'));
  try {
    await mkdir(path.join(dir, 'pc-agent', 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'pc-agent', 'src', 'bad.js'),
      '// x\nconsole.log(1);\nevil();\neval("1+1");\n',
      'utf8',
    );
    const out = await runCodeSecurityScan({ repoRoot: dir });
    const evalHits = out.findings.filter((f) => f.ruleId === 'eval-call');
    assert.ok(evalHits.length >= 1);
    assert.ok(evalHits.some((f) => f.file.includes('bad.js')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
