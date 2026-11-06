import {chromium, expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = 'https://124.221.144.155';
const base = origin + '/xiangqi/';
const accounts = JSON.parse(await fs.readFile('D:/AppData/XiangQiStudio/invitations.json', 'utf8'));
const browser = await chromium.launch({
  executablePath: 'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',
  headless: true
});
const context = await browser.newContext({viewport: {width: 1600, height: 1000}});
let csrf;
try {
  const login = await context.request.post(base + 'api/login', {
    headers: {Origin: origin}, data: {code: accounts['test-a'].invitation_code}
  });
  if (!login.ok()) throw Error('Test account login failed: ' + login.status());
  csrf = (await login.json()).csrf;
  const page = await context.newPage();
  if (process.argv.includes('--local')) {
    await page.route(base + '**', route => {
      const relative = new URL(route.request().url()).pathname.slice('/xiangqi/'.length);
      if (relative && !/^assets\/[\w.-]+$/.test(relative)) return route.continue();
      return route.fulfill({path: path.join('dist', relative || 'index.html')});
    });
  }
  await page.route('**/api/chat', route => route.fulfill({json: []}));
  await page.route('**/api/chat/stream', route => route.fulfill({
    contentType: 'application/x-ndjson',
    body: '{"type":"delta","text":"验证通过"}\n{"type":"done","finish_reason":"stop"}\n'
  }));
  await page.goto(base, {waitUntil: 'domcontentloaded', timeout: 60000});
  await expect(page.locator('#file-name')).toHaveText('src/Main.java', {timeout: 30000});

  async function explain(expected) {
    const sent = page.waitForRequest(request => request.url().endsWith('/api/chat/stream'));
    await page.locator('#explain-selection').click();
    expect((await sent).postDataJSON().selection).toEqual(expected);
    await expect(page.locator('#explain-selection')).toBeEnabled();
  }

  await page.locator('#editor .monaco-editor').click({position: {x: 110, y: 60}});
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+End');
  await explain({path: 'src/Main.java'});

  await page.locator('#annotate').click();
  await expect(page.locator('#selection-label')).toContainText('第 13–17 行');
  await explain({path: 'src/Main.java', start_line: 13, end_line: 17});
  await page.locator('#selection-clear').click();
  await explain({path: 'src/Main.java'});

  await page.locator('#annotate').click();
  await page.locator('#tree button[data-path="src/model/game/Game.java"]').click();
  await expect(page.locator('#selection-context')).toBeHidden();
  await explain({path: 'src/model/game/Game.java'});
  console.log('PASS whole-file default, explicit indentation block, clear selection and file switch');
} finally {
  if (csrf) await context.request.post(base + 'api/logout', {headers: {Origin: origin, 'X-CSRF-Token': csrf}});
  await browser.close();
}
