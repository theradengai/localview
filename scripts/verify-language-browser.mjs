#!/usr/bin/env node
// Isolated synthetic browser demo only; never connects to a user's native app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const [packagePath, outputArgument = 'output/language-browser'] = process.argv.slice(2);
if (!packagePath) throw new Error('Pass the isolated Playwright package.json');
const { chromium, webkit } = createRequire(path.resolve(packagePath))('playwright');
const output = path.resolve(outputArgument), dist = path.resolve('dist');
await fs.mkdir(output, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(`${dist}${path.sep}`)) { response.writeHead(403).end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream' });
    response.end(await fs.readFile(filename));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const reports = [];
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1100, height: 760 } });
    const page = await context.newPage();
    const errors = [], cases = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: 'Open folder', exact: true }).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.locator('.cm-content');
      await editor.waitFor();
      await editor.fill('# 打开文件夹\nExisting user content / 中文 {0}');
      const source = await editor.innerText();
      const originalNode = await editor.elementHandle();
      await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-CN');
      await page.getByRole('button', { name: '打开文件夹', exact: true }).waitFor();
      assert.equal(await originalNode.evaluate(node => node.isConnected), true);
      assert.equal(await editor.innerText(), source);
      await page.screenshot({ path: path.join(output, `${name}-chinese.png`) });
      cases.push('English system default; live Chinese switch preserves editor and source');
      const second = await context.newPage();
      await second.goto(origin);
      await second.getByRole('button', { name: '打开文件夹', exact: true }).waitFor();
      await page.getByRole('combobox', { name: '界面语言' }).selectOption('en');
      await second.getByRole('button', { name: 'Open folder', exact: true }).waitFor();
      assert.equal(await editor.innerText(), source);
      await second.close();
      cases.push('Preference persists into a new page and propagates across windows');
      await page.getByRole('button', { name: 'Create in the PROJECT root', exact: true }).click();
      await page.getByRole('menuitem', { name: 'New board', exact: true }).click();
      const filename = page.getByRole('textbox', { name: 'New board file in project', exact: true });
      await filename.fill('双语看板'); await filename.press('Enter');
      await page.getByLabel('Markdown board', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Split', exact: true }).click();
      const boardSource = await editor.innerText();
      assert.ok(boardSource.includes('localview: kanban'));
      assert.ok(boardSource.includes('双语看板'));
      await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-CN');
      await page.getByLabel('Markdown 看板', { exact: true }).waitFor();
      assert.equal(await editor.innerText(), boardSource);
      assert.ok(await page.getByRole('heading', { name: 'To do', exact: true }).count());
      cases.push('New board uses current UI defaults; later switches never rewrite stored columns');
      await page.getByRole('combobox', { name: '界面语言' }).selectOption('en');
      await page.screenshot({ path: path.join(output, `${name}-english.png`) });
      await page.reload();
      await page.getByRole('button', { name: 'Open folder', exact: true }).waitFor();
      assert.equal(await page.getByRole('combobox', { name: 'Interface language' }).inputValue(), 'en');
      assert.deepEqual(errors, []);
      reports.push({ browser: name, cases, errors, status: 'passed' });
    } catch (error) {
      reports.push({ browser: name, cases, errors, status: 'failed', error: String(error) });
      await page.screenshot({ path: path.join(output, `${name}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await browser.close(); }
  }
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
  server.close();
}
