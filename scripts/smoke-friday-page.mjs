#!/usr/bin/env node
/**
 * Headless smoke test: /friday must render the title (not a blank root).
 * Requires pc-agent listening on 3847 and: npm i -D playwright && npx playwright install chromium
 *
 *   node scripts/smoke-friday-page.mjs
 *   FRIDAY_UI_URL=http://127.0.0.1:3847/friday node scripts/smoke-friday-page.mjs
 */
const url = process.env.FRIDAY_UI_URL || 'http://127.0.0.1:3847/friday';

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(
      'Playwright not installed. Run from repo root:\n' +
        '  npm i -D playwright\n' +
        '  npx playwright install chromium'
    );
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (/esm\.sh|jsdelivr|animejs/i.test(u)) failures.push(`requestfailed: ${u} ${req.failure()?.errorText || ''}`);
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

  const titleOk = (await page.title()).includes('Friday');
  const heading = page.locator('h1.friday-title');
  const headingVisible = await heading.isVisible().catch(() => false);
  const bootFail = await page.locator('text=Friday UI failed to start').isVisible().catch(() => false);

  await browser.close();

  if (bootFail) {
    console.error('UI rendered the boot error panel (check esm.sh / network).');
    process.exit(1);
  }
  if (!titleOk || !headingVisible) {
    console.error('Expected title containing "Friday" and visible h1.friday-title — got blank or wrong page.');
    if (failures.length) console.error(failures.join('\n'));
    process.exit(1);
  }
  if (failures.length) console.warn('Warnings:\n' + failures.join('\n'));
  console.log('smoke-friday-page: ok', url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
