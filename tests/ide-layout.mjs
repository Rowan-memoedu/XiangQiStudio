import {chromium, expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = 'https://124.221.144.155';
const base = origin + '/xiangqi/';
const output = 'D:/Artifacts/XiangQiStudio/ide-layout';
await fs.mkdir(output, {recursive: true});
const accounts = JSON.parse(await fs.readFile('D:/AppData/XiangQiStudio/invitations.json', 'utf8'));
const browser = await chromium.launch({
  executablePath: 'C:/Users/fy/AppData/Local/Google/Chrome/Application/chrome.exe',
  headless: true
});
const context = await browser.newContext({viewport: {width: 1600, height: 1000}});
const page = await context.newPage();
const errors = [];
let authHeaders;
let started = false;
page.on('pageerror', error => errors.push(error.message));

const panel = id => page.locator(`[data-panel=${id}]`);
const maximize = id => page.locator(`[data-maximize=${id}]`);
const collapse = id => page.locator(`[data-collapse=${id}]`);
const restore = id => page.locator(`[data-restore=${id}]`);

async function expectCanvasFit() {
  await expect.poll(() => page.locator('#screen canvas').evaluate(canvas => {
    const box = canvas.getBoundingClientRect();
    const screen = canvas.closest('#screen').getBoundingClientRect();
    const context = canvas.getContext('2d');
    const points = [[3, 3], [canvas.width - 4, 3], [3, canvas.height - 4],
      [canvas.width - 4, canvas.height - 4]];
    const lit = canvas.width > 100 && canvas.height > 100 && points.every(([x, y]) => {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      return Math.max(r, g, b) > 40;
    });
    return lit && Math.abs(screen.width - box.width) < 2 && Math.abs(screen.height - box.height) < 2;
  }).catch(() => false), {timeout: 25000}).toBe(true);
}

async function pawnPosition(row) {
  return page.locator('#screen canvas').evaluate((canvas, row) => {
    const boardWidth = canvas.width - 290;
    const boardHeight = canvas.height - 45 - 37;
    const scale = Math.min(boardWidth / 488, boardHeight / 540);
    return {
      x: (boardWidth - 488 * scale) / 2 + 36 * scale,
      y: 45 + (boardHeight - 540 * scale) / 2 + (36 + row * 52) * scale
    };
  }, row);
}

async function pawnIsRed(row) {
  const point = await pawnPosition(row);
  return page.locator('#screen canvas').evaluate((canvas, {x, y}) => {
    const pixels = canvas.getContext('2d').getImageData(Math.round(x - 12), Math.round(y - 12), 24, 24).data;
    let red = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = pixels.subarray(i, i + 3);
      if (r > 120 && r > 1.5 * g && r > 1.5 * b) red++;
    }
    return red > 20;
  }, point);
}

try {
  const login = await context.request.post(base + 'api/login', {
    headers: {Origin: origin}, data: {code: accounts['test-a'].invitation_code}
  });
  if (!login.ok()) throw Error('Test account login failed: ' + login.status());
  authHeaders = {Origin: origin, 'X-CSRF-Token': (await login.json()).csrf};
  if (process.argv.includes('--local')) {
    // Exercise the built front end with the real test account and its isolated runner.
    await page.route(base + '**', route => {
      const relative = new URL(route.request().url()).pathname.slice('/xiangqi/'.length);
      if (relative && !/^assets\/[\w.-]+$/.test(relative)) return route.continue();
      return route.fulfill({path: path.join('dist', relative || 'index.html')});
    });
  }
  await page.goto(base, {waitUntil: 'networkidle'});
  await expect(page.locator('#file-name')).toHaveText('src/Main.java');
  const toolbar = page.locator('#workspace-toolbar');
  const workspace = page.locator('.workspace');
  await expect(toolbar).toBeHidden();
  const beforeHover = await workspace.boundingBox();
  await page.mouse.move(500, 1);
  await expect(toolbar).toBeVisible();
  expect(await workspace.boundingBox()).toEqual(beforeHover);
  await page.screenshot({path: output + '/toolbar.png'});
  await page.mouse.move(500, 300);
  await expect(toolbar).toBeHidden();

  for (const id of ['preview', 'code', 'discussion']) {
    await maximize(id).click();
    await expect(page.locator('[data-panel]:visible')).toHaveCount(1);
    await expect(maximize(id)).toHaveAttribute('aria-pressed', 'true');
    const box = await panel(id).boundingBox();
    const work = await workspace.boundingBox();
    expect(box.width).toBeCloseTo(work.width, 0);
    expect(box.height).toBeCloseTo(work.height, 0);
    await maximize(id).click();
    await expect(page.locator('[data-panel]:visible')).toHaveCount(3);
  }

  const divider = await page.locator('[data-split=columns]').boundingBox();
  const leftBefore = (await panel('preview').boundingBox()).width;
  await page.mouse.move(divider.x + divider.width / 2, 200);
  await page.mouse.down();
  await page.mouse.move(divider.x + 80, 200, {steps: 5});
  await page.mouse.up();
  const leftAfter = (await panel('preview').boundingBox()).width;
  expect(leftAfter).toBeGreaterThan(leftBefore + 60);
  await collapse('preview').click();
  await collapse('code').click();
  await expect(page.locator('[data-panel]:visible')).toHaveCount(1);
  await page.reload({waitUntil: 'networkidle'});
  await expect(restore('preview')).toBeVisible();
  await expect(restore('code')).toBeVisible();
  await collapse('discussion').click();
  await expect(page.locator('[data-panel]:visible')).toHaveCount(0);
  for (const id of ['discussion', 'code', 'preview']) await restore(id).click();
  await expect(page.locator('[data-panel]:visible')).toHaveCount(3);
  expect((await panel('preview').boundingBox()).width).toBeCloseTo(leftAfter, 0);

  await page.locator('#toolbar-toggle').click();
  await page.locator('#page-fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  await expect(page.locator('#page-fullscreen')).toHaveText('退出全屏');
  await page.locator('#page-fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await page.locator('#reset-layout').click();
  await page.keyboard.press('Escape');
  console.log('PASS overlay, three panel controls, persistent collapse, splitters and native fullscreen');

  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({width, height: 850});
    await maximize('code').click();
    await expect(panel('code')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await maximize('code').click();
  }
  await page.setViewportSize({width: 1600, height: 1000});
  started = true;
  await page.locator('#run-empty').click();
  await expect(page.locator('#run-status')).toHaveText('运行中', {timeout: 120000});
  await expectCanvasFit();
  await page.screenshot({path: output + '/workspace.png'});
  await maximize('preview').click();
  await expectCanvasFit();
  await page.screenshot({path: output + '/preview-maximized.png'});
  await expect.poll(() => pawnIsRed(6)).toBe(true);
  for (const row of [6, 5]) {
    const position = await pawnPosition(row);
    const canvas = page.locator('#screen canvas');
    const point = await canvas.evaluate((canvas, {x, y}) => {
      const box = canvas.getBoundingClientRect();
      return {x: x * box.width / canvas.width, y: y * box.height / canvas.height};
    }, position);
    await canvas.click({position: point});
  }
  await expect.poll(() => pawnIsRed(5)).toBe(true);
  await collapse('preview').click();
  await restore('preview').click();
  await expectCanvasFit();
  await expect.poll(() => pawnIsRed(5)).toBe(true);
  await expect(page.locator('#run-status')).toHaveText('运行中');
  if (errors.length) throw Error(errors.join('\n'));
  console.log('PASS real Swing framebuffer fit, moves after resizing, and game state after collapse and restore');
} catch (error) {
  await page.screenshot({path: output + '/failure.png'}).catch(() => {});
  throw error;
} finally {
  if (authHeaders && started) await context.request.post(base + 'api/stop', {headers: authHeaders});
  if (authHeaders) await context.request.post(base + 'api/logout', {headers: authHeaders});
  await browser.close();
}
