#!/usr/bin/env node
// Run against the built, in-memory demo only. No native bridge or user files.
// npm install --prefix /tmp/localview-browser playwright@1.58.2
// /tmp/localview-browser/node_modules/.bin/playwright install chromium webkit
// npm run build
// node scripts/verify-tree-selection-browser.mjs /tmp/localview-browser/package.json output/tree-browser
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const [packagePath, outputArgument = 'output/tree-browser'] = process.argv.slice(2);
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
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.setDefaultTimeout(15000);
    const report = { browser: name, version: browser.version(), cases: [], errors: [], status: 'running' };
    reports.push(report);
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.route('**/*', (route) => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
    try {
      await page.goto(origin);
      const row = (label) => page.getByRole('button', { name: label, exact: true });
      const selected = () => page.locator('[data-tree-path][aria-pressed="true"]').evaluateAll((elements) => elements.map((element) => element.dataset.treePath));
      const readme = row('README.md');
      await readme.waitFor();
      const root = path.posix.dirname(await readme.getAttribute('data-tree-path'));
      const p = (relative) => `${root}/${relative}`;
      const expectSelection = async (paths) => {
        await page.waitForFunction((expected) => JSON.stringify([...document.querySelectorAll('[data-tree-path][aria-pressed="true"]')].map((element) => element.dataset.treePath)) === JSON.stringify(expected), paths);
        assert.deepEqual(await selected(), paths);
      };
      const clear = async () => { await readme.focus(); await readme.press('Escape'); };
      const selectFolders = async () => {
        await clear();
        await row('docs').click({ modifiers: ['Meta'] });
        await row('prototype').click({ modifiers: ['Meta'] });
        await expectSelection([p('docs'), p('prototype')]);
      };
      await selectFolders();
      assert.equal(await row('docs').getAttribute('aria-expanded'), 'true');
      assert.equal(await readme.getAttribute('aria-current'), 'page');
      report.cases.push('modifier selection preserves expansion and current document');

      await row('docs').click({ button: 'right' });
      await page.getByRole('menu').waitFor();
      await expectSelection([p('docs'), p('prototype')]);
      assert.equal(await page.getByRole('menuitem', { name: '重命名', exact: true }).count(), 0);
      await page.keyboard.press('Escape');
      report.cases.push('context menu preserves group and excludes batch rename');

      await clear();
      await row('docs').click({ modifiers: ['Meta'] });
      await row('prototype').click({ modifiers: ['Shift'] });
      await expectSelection([p('docs'), p('docs/product-notes.md'), p('docs/roadmap.md'), p('prototype')]);
      report.cases.push('shift range follows visible tree order');

      await row('prototype').press('Meta+a');
      const visible = await page.locator('[data-tree-path]').evaluateAll((elements) => elements.map((element) => element.dataset.treePath));
      await expectSelection(visible);
      assert.ok(!visible.includes(p('assets/cover.png')));
      await row('prototype').press('Escape');
      await row('prototype').press('Meta+Backspace');
      await expectSelection([]);
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      report.cases.push('select-all is visible-only; cleared selection cannot delete');

      await selectFolders();
      await row('docs').dragTo(row('prototype'));
      await expectSelection([p('docs'), p('prototype')]);
      assert.equal(await row('docs').getAttribute('data-tree-path'), p('docs'));
      report.cases.push('drop into a selected source is rejected');

      await row('docs').dragTo(row('assets'));
      await expectSelection([p('assets/docs'), p('assets/prototype')]);
      assert.equal(await readme.getAttribute('aria-current'), 'page');
      await page.screenshot({ path: path.join(output, `${name}-group-move.png`) });
      report.cases.push('real pointer drag moves both selected directories');

      await row('docs').click({ button: 'right' });
      await page.getByRole('menuitem', { name: '移到废纸篓', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expectSelection([p('assets/docs'), p('assets/prototype')]);
      report.cases.push('cancelled batch trash changes no demo entries');

      await row('docs').click({ button: 'right' });
      await page.getByRole('menuitem', { name: '移到废纸篓', exact: true }).click();
      await page.getByRole('button', { name: '移到废纸篓', exact: true }).click();
      await row('docs').waitFor({ state: 'detached' });
      await row('prototype').waitFor({ state: 'detached' });
      assert.equal(await readme.getAttribute('aria-current'), 'page');
      report.cases.push('one confirmation removes the group, preserving unrelated document');
      assert.deepEqual(report.errors, []);
      report.status = 'passed';
    } catch (error) {
      report.status = 'failed';
      report.failure = String(error);
      await page.screenshot({ path: path.join(output, `${name}-failure.png`) }).catch(() => {});
    } finally { await browser.close(); }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(reports, null, 2) + '\n');
}
console.log(JSON.stringify(reports, null, 2));
if (reports.length !== 2 || reports.some((report) => report.status !== 'passed')) process.exitCode = 1;
