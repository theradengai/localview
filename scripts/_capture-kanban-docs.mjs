// One-shot documentation capture: production browser frontend, synthetic files only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { webkit } = createRequire('/tmp/localview-docs-browser/package.json')('playwright');
const source = '3ebf48f9f917bc1296ea65cd9e5bb78cd8990255';
const fixture = await fs.readFile('docs/fixtures/kanban.md', 'utf8');
const dist = path.resolve('dist');
const out = path.resolve('docs/images');
const hashes = {};
const checks = [];
const errors = [];
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const button = name => page.getByRole('button', { name, exact: true });
  const col = name => page.getByLabel(`列：${name}`, { exact: true });
  const editor = page.locator('.cm-content');
  const snapshot = async name => {
    await page.locator('.notice').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('.statusbar [role="status"]')?.textContent.includes('已保存'));
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(8, 8);
    const bytes = await page.screenshot({ path: path.join(out, name), animations: 'disabled' });
    hashes[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  await page.goto(origin);
  await button('README.md').waitFor();
  assert.equal(await page.getByLabel('Markdown 看板', { exact: true }).count(), 0);
  checks.push('ordinary Markdown remains a normal reading preview');
  await button('在 PROJECT 根目录新建').click();
  await page.getByRole('menuitem', { name: '新建看板', exact: true }).click();
  const nameField = page.getByRole('textbox', { name: '在 project 中新建看板文件' });
  await nameField.fill('发布计划');
  await nameField.press('Enter');
  await page.getByLabel('Markdown 看板', { exact: true }).waitFor();
  await button('编辑').click();
  await editor.fill(fixture);
  await button('预览').click();
  await button('整理用户反馈 #产品').waitFor();
  assert.deepEqual(await page.locator('[data-kanban-column] h2').allTextContents(), ['待办', '进行中', '待验收', '已完成']);
  assert.equal(await page.locator('.kanban-card').count(), 8);
  assert.equal(await col('已完成').locator('.kanban-card.is-done').count(), 2);
  checks.push('existing synthetic fixture renders four columns and eight cards with completion state');
  await snapshot('localview-kanban-board.png');
  await button('支持 Markdown 看板 #产品').click();
  await page.getByLabel('卡片详情', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '对齐文件格式', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: '确认卡片交互', exact: true }).isChecked(), false);
  assert.match(await page.getByLabel('卡片说明与子任务').inputValue(), /文件仍是 \.md/);
  checks.push('right-side details expose the fixture description and semantic subtasks');
  await snapshot('localview-kanban-details.png');
  await button('关闭卡片详情').click();
  await button('分栏').click();
  const normalized = text => text.replace(/\r\n?/g, '\n').trimEnd();
  assert.equal(normalized(await editor.innerText()), normalized(fixture));
  checks.push('Split exposes the same Markdown source without a second document model');
  await snapshot('localview-kanban-split.png');
  await button('预览').click();
  const handle = button('拖动卡片 更新安装说明 #文档');
  const a = await handle.boundingBox(), b = await col('待验收').boundingBox();
  assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 90, { steps: 18 });
  await page.mouse.up();
  await col('待验收').getByRole('button', { name: '更新安装说明 #文档', exact: true }).waitFor();
  await button('撤销').click();
  await col('待办').getByRole('button', { name: '更新安装说明 #文档', exact: true }).waitFor();
  await button('分栏').click();
  assert.equal(normalized(await editor.innerText()), normalized(fixture));
  checks.push('real pointer movement and shared undo preserve the complete sample source');
  assert.deepEqual(errors, []);
  const runUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const report = { app_source: source, capture_commit: process.env.GITHUB_SHA, engine: 'WebKit', engine_version: browser.version(), fixture_sha256: createHash('sha256').update(fixture).digest('hex'), viewport: { width: 1440, height: 920 }, checks, page_errors: errors, images: hashes, workflow: runUrl };
  await fs.mkdir('/tmp/kanban-docs-evidence', { recursive: true });
  await fs.writeFile('/tmp/kanban-docs-evidence/capture-report.json', JSON.stringify(report, null, 2) + '\n');
  const provenance = `# Kanban screenshots / 看板截图来源\n\nThese are actual production-frontend screenshots, not a generated UI or the standalone prototype. 截图来自实际生产前端，不是生成式效果图或独立原型。\n\n- Application source: [LocalView Beta 5, ${source.slice(0, 7)}](https://github.com/theradengai/localview/commit/${source}). Capture-only helpers do not change application code.\n- Input: [the existing synthetic Markdown fixture](../fixtures/kanban.md). All cards and the displayed demo paths are fictional; browser edits stay in memory. No native bridge, user desktop, private documents or external page resources are accessed.\n- Engine: WebKit ${browser.version()} via isolated Playwright 1.58.2; viewport 1440 × 920 at 1×.\n- [Capture and source/interaction checks](${runUrl}).\n- Views: [board](localview-kanban-board.png), [card details](localview-kanban-details.png), [Split](localview-kanban-split.png). Images are unretouched viewport captures; no native macOS installation, filesystem or compatibility acceptance is implied.\n- The existing general-purpose LocalView demo GIF is retained unchanged.\n\n## Capture recipe\n\nBuild the pinned source with its locked dependencies. In the in-memory browser demo, create 发布计划.md through the folder's New board menu, paste the fixture through the source editor, and wait for the save indicator and transient notice to settle. Capture Preview; open 支持 Markdown 看板 #产品 for details; close the drawer and switch to Split. Source equality, card counts, subtask states, a real pointer move and undo are checked in the capture run.\n\n## Asset integrity\n\n| File | Bytes | SHA256 |\n| --- | ---: | --- |\n${Object.entries(hashes).map(([name, item]) => `| ${name} | ${item.bytes} | \`${item.sha256}\` |`).join('\n')}\n\nFixture SHA256: \`${report.fixture_sha256}\`.\n`;
  await fs.writeFile(path.join(out, 'KANBAN_CAPTURES.md'), provenance);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
