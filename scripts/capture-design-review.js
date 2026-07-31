import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = new URL(process.env.OSAU_CAPTURE_BASE_URL || 'http://127.0.0.1:3000');
const capturedAt = new Date().toISOString();
const stamp = capturedAt.replace(/[-:.TZ]/gu, '').slice(0, 14);
const outputDir = resolve(process.env.OSAU_CAPTURE_OUTPUT || `evidence/captures/design-review-${stamp}`);
const desktop = { width: 1440, height: 1100 };
const mobile = { width: 390, height: 844 };
const pages = [];

function url(path) {
  return new URL(path, baseUrl).href;
}

async function ensureUniqueFile(file) {
  try {
    await readFile(file);
    throw new Error(`Capture output already exists: ${file}. Set OSAU_CAPTURE_OUTPUT to a new directory.`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

async function pageMetadata(page, file, viewport, fullPage) {
  const metadata = await page.evaluate(() => ({
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].map((node) => node.textContent.trim()).filter(Boolean),
    activeNav: [...document.querySelectorAll('nav a[aria-current="page"], nav a.active')]
      .filter((node) => node.checkVisibility())
      .map((node) => node.textContent.trim()),
    activeTabs: [...document.querySelectorAll('[role="tab"]')]
      .filter((node) => node.checkVisibility() && node.getAttribute('aria-selected') === 'true')
      .map((node) => node.textContent.trim()),
    visibleDialogs: [...document.querySelectorAll('dialog[open]')]
      .filter((node) => node.checkVisibility())
      .map((node) => node.id)
  }));
  const png = await readFile(file);
  return {
    file: relative(outputDir, file),
    route: new URL(page.url()).pathname,
    url: page.url(),
    viewport,
    fullPage,
    ...metadata,
    capturedAt,
    sha256: createHash('sha256').update(png).digest('hex')
  };
}

async function capture(page, relativeFile, viewport, { fullPage = true } = {}) {
  const file = join(outputDir, relativeFile);
  await ensureUniqueFile(file);
  await mkdir(dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage });
  pages.push(await pageMetadata(page, file, viewport, fullPage));
}

async function go(page, path) {
  await page.goto(url(path), { waitUntil: 'networkidle' });
  await page.locator('main').waitFor();
}

async function firstHref(page, selector, description) {
  const href = await page.locator(selector).first().getAttribute('href');
  if (!href?.startsWith('/app/')) throw new Error(`Could not find ${description} at ${page.url()}.`);
  return href;
}

async function selectedBlockSecond(page) {
  const blocks = page.locator('[data-block-select]');
  if (await blocks.count() < 2) throw new Error('A second persisted artifact block is required for the source-focus capture.');
  await blocks.nth(1).click();
}

async function captureDesktop(browser, sourceHref, artifactHref) {
  const context = await browser.newContext({ viewport: desktop });
  const page = await context.newPage();
  await go(page, '/app/inbox');
  await capture(page, 'screens/desktop/01_inbox.png', desktop);
  for (const [button, file] of [
    ['RSS 원본 연결', 'screens/desktop/01_inbox_rss_dialog.png'],
    ['전사 업로드', 'screens/desktop/01_inbox_transcript_dialog.png'],
    ['YouTube metadata', 'screens/desktop/01_inbox_youtube_dialog.png']
  ]) {
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.locator('dialog[open]').waitFor();
    await capture(page, file, desktop, { fullPage: false });
    await page.keyboard.press('Escape');
  }
  await go(page, sourceHref);
  await capture(page, 'screens/desktop/02_source_detail.png', desktop);
  await go(page, `/app/planner/${basename(sourceHref)}`);
  await capture(page, 'screens/desktop/03_planner.png', desktop);
  await go(page, '/app/runs');
  await capture(page, 'screens/desktop/04_runs.png', desktop);
  await go(page, '/app/settings');
  await capture(page, 'screens/desktop/05_settings.png', desktop);
  await go(page, artifactHref);
  await capture(page, 'screens/desktop/06_review_preview.png', desktop);
  await page.locator('#context-tab-checks').click();
  await capture(page, 'screens/desktop/07_review_checks_queue.png', desktop);
  await page.locator('#context-tab-versions').click();
  await capture(page, 'screens/desktop/08_review_versions.png', desktop);
  await page.locator('#context-tab-run').click();
  await capture(page, 'screens/desktop/09_review_run.png', desktop);
  await selectedBlockSecond(page);
  await capture(page, 'screens/desktop/10_review_source_focus.png', desktop);
  await context.close();
}

async function captureMobile(browser, sourceHref, artifactHref) {
  const context = await browser.newContext({ viewport: mobile, isMobile: true });
  const page = await context.newPage();
  await go(page, '/app/inbox');
  await capture(page, 'screens/mobile/01_inbox.png', mobile);
  await go(page, sourceHref);
  await capture(page, 'screens/mobile/02_source_detail.png', mobile);
  await go(page, `/app/planner/${basename(sourceHref)}`);
  await capture(page, 'screens/mobile/03_planner.png', mobile);
  await go(page, '/app/runs');
  await capture(page, 'screens/mobile/04_runs.png', mobile);
  await go(page, '/app/settings');
  await capture(page, 'screens/mobile/05_settings.png', mobile);
  await go(page, artifactHref);
  await page.getByRole('tab', { name: '원본', exact: true }).click();
  await capture(page, 'screens/mobile/06_review_source.png', mobile);
  await page.getByRole('tab', { name: '편집', exact: true }).click();
  await capture(page, 'screens/mobile/07_review_edit.png', mobile);
  await page.getByRole('tab', { name: '검토', exact: true }).evaluate((node) => node.click());
  await page.locator('#context-tab-checks').evaluate((node) => node.click());
  await page.locator('#context-checks').waitFor();
  await capture(page, 'screens/mobile/08_review_check_queue.png', mobile);
  await context.close();
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const discoveryContext = await browser.newContext({ viewport: desktop });
    const discovery = await discoveryContext.newPage();
    await go(discovery, '/app/inbox');
    const sourceHref = process.env.OSAU_CAPTURE_SOURCE_HREF || await firstHref(discovery, 'a[href^="/app/source/"]', 'a persisted source item');
    const artifactHref = process.env.OSAU_CAPTURE_ARTIFACT_HREF || await firstHref(discovery, 'a[href^="/app/review/"]', 'a persisted artifact');
    await discoveryContext.close();
    await captureDesktop(browser, sourceHref, artifactHref);
    await captureMobile(browser, sourceHref, artifactHref);
  } finally {
    await browser.close();
  }
  const duplicateHashes = pages.reduce((duplicates, page) => {
    const previous = pages.find((candidate) => candidate !== page && candidate.sha256 === page.sha256);
    if (previous) duplicates.push([previous.file, page.file]);
    return duplicates;
  }, []);
  if (duplicateHashes.length) throw new Error(`Duplicate visual evidence is not allowed: ${JSON.stringify(duplicateHashes)}`);
  await mkdir(join(outputDir, 'data'), { recursive: true });
  await writeFile(join(outputDir, 'data', 'capture-manifest.json'), `${JSON.stringify({
    captureVersion: '2026-07-31.2',
    capturedAt,
    baseUrl: baseUrl.href,
    viewportPresets: { desktop, mobile },
    schema: ['file', 'route', 'url', 'viewport', 'fullPage', 'title', 'headings', 'activeNav', 'activeTabs', 'visibleDialogs', 'capturedAt', 'sha256'],
    pages
  }, null, 2)}\n`);
  process.stdout.write(`capture: PASS (${pages.length} screens) ${outputDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`capture: FAIL ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
