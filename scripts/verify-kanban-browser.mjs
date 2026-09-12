#!/usr/bin/env node
// Run against the built, in-memory demo only. No native bridge or user files.
// npm install --prefix /tmp/localview-browser playwright@1.58.2
// /tmp/localview-browser/node_modules/.bin/playwright install chromium webkit
// npm run build
// node scripts/verify-kanban-browser.mjs /tmp/localview-browser/package.json output/kanban-browser
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const [packagePath, outputArgument = 'output/kanban-browser'] = process.argv.slice(2);
if (!packagePath) throw new Error('Pass the isolated Playwright installation package.json');
const { chromium, webkit } = createRequire(path.resolve(packagePath))('playwright');
const output = path.resolve(outputArgument);
const dist = path.resolve('dist');
await fs.access(path.join(dist, 'index.html'));
await fs.mkdir(output, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(`${dist}${path.sep}`)) { response.writeHead(403).end(); return; }
    const body = await fs.readFile(filename);
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const reports = [];
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(15000);
    const report = { browser: name, version: browser.version(), cases: [], errors: [], status: 'running' };
    reports.push(report);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
    const button = title => page.getByRole('button', { name: title, exact: true });
    const col = title => page.getByLabel(`列：${title}`, { exact: true });
    const expectCards = async (title, names) => {
      await page.waitForFunction(({ title, names }) => {
        const element = [...document.querySelectorAll('[data-kanban-column]')].find(e => e.getAttribute('aria-label') === `列：${title}`);
        return element && JSON.stringify([...element.querySelectorAll('.kanban-card-title')].map(e => e.textContent)) === JSON.stringify(names);
      }, { title, names });
    };
    const drag = async (handle, target, dx = 0.5, dy = 90) => {
      await handle.scrollIntoViewIfNeeded();
      const a = await handle.boundingBox(), b = await target.boundingBox();
      assert.ok(a && b);
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width * dx, b.y + dy, { steps: 18 });
      await page.mouse.up();
    };
    try {
      await page.goto(origin);
      await button('README.md').waitFor();
      assert.equal(await page.getByLabel('Markdown 看板', { exact: true }).count(), 0);
      report.cases.push('ordinary Markdown keeps its reading preview');
      await button('在 PROJECT 根目录新建').click();
      await page.getByRole('menuitem', { name: '新建看板', exact: true }).click();
      await page.getByRole('textbox', { name: '在 project 中新建看板文件' }).fill('看板验证');
      await page.getByRole('textbox', { name: '在 project 中新建看板文件' }).press('Enter');
      await page.getByLabel('Markdown 看板', { exact: true }).waitFor();
      await page.locator('.cm-content').waitFor({ state: 'attached' });
      assert.match(await button('预览').getAttribute('class'), /active/);
      report.cases.push('create a normal Markdown board through root create menu');
      await col('待办').getByRole('button', { name: '＋ 添加卡片', exact: true }).click();
      const add = page.getByLabel('新卡片标题');
      for (const title of ['First #产品', 'Second']) { await add.fill(title); await add.press('Enter'); }
      await add.press('Escape');
      await expectCards('待办', ['First #产品', 'Second']);
      report.cases.push('Enter adds consecutive cards and Escape cancels the field');
      await button('First #产品').click();
      await page.getByLabel('卡片说明与子任务').fill('说明文字\n- [ ] 子任务');
      await page.getByRole('checkbox', { name: '子任务', exact: true }).check();
      await page.screenshot({ path: path.join(output, `${name}-details.png`) });
      await button('关闭卡片详情').click();
      report.cases.push('right drawer edits descriptions and semantic child task checkbox');
      await drag(button('拖动卡片 First #产品'), col('进行中'));
      await expectCards('进行中', ['First #产品']);
      assert.equal(await col('进行中').getByLabel('完成：First #产品', { exact: true }).isChecked(), false);
      await page.screenshot({ path: path.join(output, `${name}-board.png`) });
      report.cases.push('real pointer cross-column drag moves the full block, not completion');
      await button('撤销').click(); await expectCards('待办', ['First #产品', 'Second']);
      await button('重做').click(); await expectCards('进行中', ['First #产品']);
      report.cases.push('shared CodeMirror undo and redo restore a drag');
      await button('分栏').click();
      const editor = page.locator('.cm-content');
      let raw = await editor.innerText();
      assert.ok(raw.indexOf('## 进行中') < raw.indexOf('First #产品'));
      assert.ok(raw.includes('  - [x] 子任务'));
      await page.screenshot({ path: path.join(output, `${name}-split.png`) });
      report.cases.push('split preview and raw source reflect the same document');
      await editor.fill(raw.replace('First #产品', 'Renamed'));
      await button('Renamed').waitFor();
      await button('预览').click();
      await page.getByLabel('Markdown 看板', { exact: true }).focus();
      await page.keyboard.press('Meta+z'); await button('First #产品').waitFor();
      await page.keyboard.press('Meta+Shift+z'); await button('Renamed').waitFor();
      report.cases.push('source edits propagate to board and mode changes keep history');
      await button('Renamed').click();
      await page.getByLabel('卡片所在列').selectOption(await col('待办').getAttribute('data-kanban-column'));
      await expectCards('待办', ['Second', 'Renamed']);
      await button('Renamed').click(); await button('上移卡片').click(); await expectCards('待办', ['Renamed', 'Second']);
      report.cases.push('accessible column selector and reorder buttons preserve cards');
      await drag(button('拖动卡片 Second'), col('待办'), 0.5, 51);
      await expectCards('待办', ['Second', 'Renamed']);
      report.cases.push('real pointer same-column drag reorders cards');
      await button('Renamed').click(); await button('删除卡片…').click();
      await button('取消').click(); assert.equal(await button('Renamed').count(), 1);
      await button('删除卡片…').click(); await button('删除').click(); await button('Renamed').waitFor({ state: 'detached' });
      await button('撤销').click(); await button('Renamed').waitFor();
      report.cases.push('card deletion requires confirmation and can be undone');
      await button('待办 列操作').click(); await button('删除列…').click();
      await button('移动卡片并删除列').click(); await expectCards('进行中', ['Second', 'Renamed']);
      assert.equal(await col('待办').count(), 0);
      await button('撤销').click(); await expectCards('待办', ['Second', 'Renamed']);
      report.cases.push('nonempty-column deletion migrates all cards and undo restores both');
      await drag(button('拖动列 已完成'), col('待办'), 0.2, 20);
      assert.equal(await page.locator('[data-kanban-column]').first().getAttribute('aria-label'), '列：已完成');
      report.cases.push('real pointer column reorder moves complete column blocks');
      await button('分栏').click(); raw = await editor.innerText();
      await editor.fill(raw + '\nUnowned prose\n');
      await page.locator('.kanban-invalid').waitFor();
      assert.equal(await page.locator('.kanban-invalid pre').innerText(), raw + '\nUnowned prose\n');
      await editor.fill(raw); await page.getByLabel('Markdown 看板', { exact: true }).waitFor();
      report.cases.push('invalid marked source remains intact and recovers after source correction');
      await button('预览').click();
      await page.setViewportSize({ width: 900, height: 700 });
      const box = await page.locator('.kanban-scroll').boundingBox(); assert.ok(box && box.width > 100 && box.height > 100);
      const scrollable = await page.locator('.kanban-scroll').evaluate(e => e.scrollWidth > e.clientWidth);
      assert.equal(scrollable, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      report.cases.push('narrow window keeps horizontal scrolling inside board');
      await button('README.md').click(); await page.locator('.markdown-body').waitFor();
      assert.equal(await page.getByLabel('Markdown 看板', { exact: true }).count(), 0);
      await button('看板验证.md').click(); await button('Renamed').waitFor();
      report.cases.push('file switching persists demo Markdown, not a separate board model');
      assert.deepEqual(report.errors, []);
      report.status = 'passed';
    } catch (error) {
      report.status = 'failed'; report.failure = String(error);
      await page.screenshot({ path: path.join(output, `${name}-failure.png`) }).catch(() => {});
      await fs.writeFile(path.join(output, `${name}-failure.txt`), await page.locator('body').innerText().catch(() => '') + '\n' + String(error));
    } finally { await browser.close(); }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(reports, null, 2) + '\n');
}
console.log(JSON.stringify(reports, null, 2));
if (reports.length !== 2 || reports.some(r => r.status !== 'passed')) process.exitCode = 1;
