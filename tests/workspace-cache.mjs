import {chromium, expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const origin = 'https://124.221.144.155';
const base = origin + '/xiangqi/';
const privateRoot = await fs.realpath('D:/AppData/XiangQiStudio');
const profile = await fs.mkdtemp(path.join(privateRoot, 'cache-test-'));
const account = JSON.parse(await fs.readFile(path.join(privateRoot, 'invitations.json'), 'utf8'))['test-a'];
const cacheKey = 'xq-workspace-v1:test-a';
const open = () => chromium.launchPersistentContext(profile, {
  executablePath: 'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',
  headless: true, viewport: {width: 1600, height: 1000}
});
let context;
try {
  context = await open();
  let page = context.pages()[0];
  await page.goto(base);
  await page.locator('#invite').evaluate((input, code) => { input.value = code; }, account.invitation_code);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#file-name')).toHaveText('src/Main.java');
  await page.locator('#tree button[data-path="README.md"]').click();
  await expect(page.locator('#file-name')).toHaveText('README.md');
  const cookie = (await context.cookies()).find(cookie => cookie.name === 'xq_session');
  expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(364 * 86400);
  expect(cookie.httpOnly && cookie.secure).toBe(true);
  const saved = await page.evaluate(key => localStorage.getItem(key), cacheKey);
  if (!saved || saved.includes(account.invitation_code)) throw Error('The local cache must contain workspace data without the invitation credential');
  await context.close();

  context = await open();
  page = context.pages()[0];
  const requested = [];
  page.on('request', request => {
    if (request.url().includes('/api/')) requested.push(new URL(request.url()).pathname);
  });
  let resume;
  const held = new Promise(resolve => { resume = resolve; });
  await page.route('**/api/workspace', async route => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(base, {waitUntil: 'domcontentloaded'});
    await expect(page.locator('#file-name')).toHaveText('README.md');
    await expect(page.locator('#markdown-preview h1')).toBeVisible();
    await expect(page.locator('#login')).toBeHidden();
    expect(requested).not.toContain('/xiangqi/api/login');
    expect(requested).not.toContain('/xiangqi/api/file');
    const synced = page.waitForResponse(response => response.url().endsWith('/api/workspace'));
    resume();
    await synced;
    expect(requested).not.toContain('/xiangqi/api/file');
  } finally {
    resume();
    await page.unroute('**/api/workspace');
  }
  console.log('PASS browser restart restores login, project tree and last file while workspace response is held');

  const response = await context.request.get(base + 'api/file?path=README.md');
  if (!response.ok()) throw Error('Could not read test file');
  const original = await response.json();
  const content = original.content + '\n\n## 缓存版本更新验证\n';
  const sha = createHash('sha256').update(content).digest('hex');
  await page.route('**/api/workspace', async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.head += '-test';
    snapshot.files.find(file => file.path === 'README.md').sha = sha;
    await route.fulfill({response, json: snapshot});
  });
  await page.route('**/api/file?path=README.md', route => route.fulfill({json: {...original, content, sha}}));
  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.locator('#markdown-preview h2').last()).toHaveText('缓存版本更新验证');
  await page.unroute('**/api/workspace');
  await page.unroute('**/api/file?path=README.md');
  await page.reload({waitUntil: 'domcontentloaded'});
  await expect(page.locator('#markdown-preview h2').filter({hasText: '缓存版本更新验证'})).toHaveCount(0);
  await expect(page.locator('#markdown-preview h1')).toBeVisible();

  await page.locator('#toolbar-toggle').click();
  await page.locator('#logout').click();
  await expect(page.locator('#login')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), cacheKey)).toBeNull();
  expect((await context.cookies()).some(cookie => cookie.name === 'xq_session')).toBe(false);
  console.log('PASS changed revision replaces cached text and explicit logout clears the cache and cookie');
} finally {
  await context?.close().catch(() => {});
  const resolved = await fs.realpath(profile);
  if (path.dirname(resolved) === privateRoot && path.basename(resolved).startsWith('cache-test-')) {
    await fs.rm(resolved, {recursive: true, force: true, maxRetries: 5});
  }
}
