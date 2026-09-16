#!/usr/bin/env node
// Actual installed release binary, disposable Windows CI account only.
// CDP is enabled through this child process environment, never in shipped code.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [playwrightPackage, executableArgument, outputArgument] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable GitHub runner only');
assert.ok(playwrightPackage && executableArgument && outputArgument);
const { chromium } = createRequire(path.resolve(playwrightPackage))('playwright');
const executable = await fs.realpath(executableArgument);
const output = path.resolve(outputArgument);
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'localview-native-'));
const root = path.join(temporary, '中文 workspace');
await fs.mkdir(root);
const original = '# Windows 原生验收\r\n\r\nOriginal local document.\r\n\r\n- [ ] Native task\r\n';
const documentPath = path.join(root, '原文.md');
await fs.writeFile(documentPath, original);
await fs.writeFile(path.join(root, 'table.csv'), 'Name,Value\r\n中文,00123\r\n');
await fs.copyFile('src-tauri/tests/fixtures/basic.xlsx', path.join(root, 'book.xlsx'));
await fs.copyFile('src-tauri/icons/icon.png', path.join(root, 'image.png'));
await fs.writeFile(path.join(root, 'board.md'), '---\nlocalview: kanban\n---\n# Native board\n\n## To do\n- [ ] First card\n\n## Done\n');
await fs.writeFile(path.join(root, 'style.css'), '#native-html { color: rgb(1, 2, 3); }');
await fs.writeFile(path.join(root, 'action.js'), "document.querySelector('#change').onclick=()=>document.querySelector('#native-html').textContent='Clicked native HTML';");
await fs.writeFile(path.join(root, 'preview.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./style.css"></head><body><h1 id="native-html">Native HTML</h1><img width="32" src="./image.png"><button id="change">Change</button><script src="./action.js"></script></body></html>');
const stream = 'BT /F1 24 Tf 50 700 Td (LocalView native PDF fixture) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf = '%PDF-1.4\n'; const offsets = [0];
for (let i=0;i<objects.length;i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${objects[i]}\nendobj\n`; }
const xref=Buffer.byteLength(pdf); pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await fs.writeFile(path.join(root, 'sample.pdf'), pdf);
const port = 19427;
const report = { status:'running', version:JSON.parse(await fs.readFile('package.json','utf8')).version, sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(), os:os.release(), architecture:os.arch(), executableSHA256:createHash('sha256').update(await fs.readFile(executable)).digest('hex'), browser:'', cases:[], errors:[], limitations:['Hosted Windows environment; not physical Windows 10/11 hardware certification.','OS file-picker and print dialogs require manual acceptance.'] };
const record = message => { report.cases.push(message); console.log(message); };
let browser, page, child;
const wait = async (predicate, label, timeout=20000) => {
  const start=Date.now(); let last;
  while (Date.now()-start<timeout) {
    try { if (await predicate()) return; } catch(error) { last=error; }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error(`${label} timed out${last ? ': '+last.message : ''}`);
};
try {
  child=spawn(executable,[documentPath],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,WEBVIEW2_USER_DATA_FOLDER:path.join(temporary,'WebView2-profile')},stdio:'ignore'});
  child.on('error', error=>report.errors.push(error.message));
  await wait(async()=>{ const r=await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok; },'Owned WebView2 endpoint',90000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  report.browser=browser.version();
  await wait(()=>{ page=browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost/.test(p.url()));return Boolean(page);},'LocalView main page');
  page.setDefaultTimeout(20000);
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.locator('.app-shell.tauri-runtime').waitFor();
  await page.locator('.language-picker').selectOption('zh-CN');
  await page.getByRole('heading',{name:'Windows 原生验收',exact:true}).waitFor();
  assert.equal(await fs.readFile(documentPath,'utf8'),original);
  record('Installed native app directly opens a Unicode path without importing or rewriting the file');
  const mode = name => page.locator('.mode-switcher').getByRole('button',{name,exact:true});
  const open = async name => {
    await page.locator('.tree-row-main').filter({has:page.locator('.tree-name',{hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})}).click();
    await page.locator('.document-title-trigger').filter({hasText:name}).waitFor();
  };
  await mode('分栏').click();
  const editor=page.locator('.cm-content:visible');
  await editor.click(); await editor.press('Control+End');
  await page.keyboard.insertText('\nNative edit 已保存');
  await editor.press('Control+s');
  await wait(async()=>(await fs.readFile(documentPath,'utf8')).includes('Native edit 已保存'),'Native Ctrl+S writeback');
  const saved=await fs.readFile(documentPath,'utf8');
  assert.ok(saved.startsWith(original));
  await editor.press('Control+z');
  await wait(async()=>(await fs.readFile(documentPath,'utf8'))===original,'Native Ctrl+Z and autosave');
  await editor.press('Control+y');
  await wait(async()=>(await fs.readFile(documentPath,'utf8'))===saved,'Native Ctrl+Y and autosave');
  record('Windows Ctrl+S, Ctrl+Z, Ctrl+Y and automatic save round-trip the actual original document');
  await editor.evaluate(element=>{ window.__localviewAcceptanceEditor=element; });
  const text=await editor.innerText();
  await page.locator('.language-picker').selectOption('en'); await mode('Split').waitFor();
  assert.equal(await editor.evaluate(element=>element===window.__localviewAcceptanceEditor),true);
  assert.equal(await editor.innerText(),text);
  assert.equal(await fs.readFile(documentPath,'utf8'),saved);
  await page.screenshot({path:path.join(output,'windows-english.png')});
  await page.locator('.language-picker').selectOption('zh-CN'); await mode('分栏').waitFor();
  await page.screenshot({path:path.join(output,'windows-chinese.png')});
  record('Chinese/English switching keeps the real editor and file content unchanged');
  await open('image.png');
  await wait(()=>page.locator('.media-pane img').evaluate(image=>image.complete&&image.naturalWidth>0),'Native local image');
  record('PNG is decoded from the scoped Windows local-asset protocol');
  await open('table.csv'); await page.getByRole('gridcell',{name:'00123',exact:true}).waitFor();
  assert.equal(await page.locator('.cm-content:visible').count(),0);
  await open('book.xlsx'); await page.locator('.spreadsheet-cell').first().waitFor();
  record('CSV leading zeros and Excel saved cells render as read-only grids');
  await open('preview.html');
  const frame=page.frameLocator('iframe[title="preview.html"]');
  await frame.locator('#native-html').waitFor();
  assert.equal(await frame.locator('#native-html').evaluate(el=>getComputedStyle(el).color),'rgb(1, 2, 3)');
  await wait(()=>frame.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0),'HTML relative image');
  await frame.getByRole('button',{name:'Change'}).click();
  await frame.getByRole('heading',{name:'Clicked native HTML'}).waitFor();
  // WebView2 may inject an internal object in child frames. Verify the actual
  // command boundary with a positive main-window control, not the object's shape.
  const control = await page.evaluate(file => window.__TAURI_INTERNALS__.invoke('read_text_file', { path: file }), documentPath);
  assert.equal(control.content, saved);
  const isolation = await frame.locator('body').evaluate(async (_, file) => {
    const bridge = window.__TAURI_INTERNALS__;
    if (typeof bridge?.invoke !== 'function') return { denied: true, reason: 'No callable bridge' };
    return Promise.race([
      bridge.invoke('read_text_file', { path: file }).then(
        () => ({ denied: false, reason: 'Preview executed a native file-read command' }),
        error => ({ denied: true, reason: String(error) }),
      ),
      new Promise(resolve => setTimeout(() => resolve({ denied: false, reason: 'IPC result timed out; denial not established' }), 8000)),
    ]);
  }, documentPath);
  report.htmlIPC = isolation;
  assert.equal(isolation.denied, true, JSON.stringify(isolation));
  assert.match(isolation.reason, /No callable bridge|not allowed|denied|origin|Failed to fetch|NetworkError/i);
  assert.equal(await frame.locator('body').evaluate(async()=>{try{await fetch('https://example.com/');return false;}catch{return true;}}),true);
  record('Sandboxed native HTML resolves relative assets and interactions while native file-read commands and external fetch are denied');
  await open('board.md'); await page.locator('.kanban-card-title').filter({hasText:'First card'}).waitFor();
  const grip=page.locator('.kanban-card .kanban-grip').first();
  const target=page.locator('.kanban-column').nth(1);
  const a=await grip.boundingBox(),b=await target.boundingBox(); assert.ok(a&&b);
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
  await page.mouse.move(b.x+b.width/2,b.y+90,{steps:18});await page.mouse.up();
  await wait(async()=>{const content=await fs.readFile(path.join(root,'board.md'),'utf8');return content.indexOf('## Done')<content.indexOf('First card');},'Native board drag writeback');
  await mode('分栏').click(); await page.screenshot({path:path.join(output,'windows-kanban.png')});
  record('Actual pointer drag moves a Kanban card and autosaves its Markdown block');
  await fs.writeFile(path.join(root,'external.md'),'# External watcher fixture\n');
  await page.locator('.tree-name').filter({hasText:/^external\.md$/}).waitFor();
  record('Native filesystem watcher adds an externally created file without indexing');
  await page.keyboard.press('Control+n');
  let second;
  await wait(()=>{second=browser.contexts().flatMap(c=>c.pages()).find(p=>p!==page&&/tauri\.localhost/.test(p.url()));return Boolean(second);},'Independent native window');
  await second.locator('.language-picker').waitFor();
  await second.locator('.language-picker').selectOption('en');
  await wait(async()=>await page.locator('.language-picker').inputValue()==='en','Native cross-window language');
  assert.equal(await fs.readFile(documentPath,'utf8'),saved);
  record('Ctrl+N creates an independent native window and language changes synchronize across windows');
  await page.bringToFront();
  const deliveredPdf = page.waitForResponse(response => response.url().includes('/sample.pdf') && response.status() === 200);
  await open('sample.pdf');
  const pdfSource=await page.locator('iframe[title="sample.pdf"]').getAttribute('src');
  assert.ok(pdfSource&&/localview/.test(pdfSource));
  const pdfResponse=await deliveredPdf;
  assert.equal(pdfResponse.status(),200);
  assert.match(pdfResponse.headers()['content-type'],/application\/pdf/);
  // WebView2's PDF navigation body in CDP is the generated native viewer
  // wrapper, not necessarily the original response bytes. Do not confuse
  // these two layers or invoke scripts inside the built-in PDF reader.
  const navigationBody = (await pdfResponse.body()).toString('utf8');
  const originalBody = navigationBody.startsWith('%PDF-');
  if (originalBody) assert.equal(navigationBody,pdf);
  else {
    assert.match(navigationBody, /^\s*<!doctype html/i);
    assert.match(navigationBody, /application\/pdf|<embed\b/i);
  }
  assert.equal(await fs.readFile(path.join(root,'sample.pdf'),'utf8'),pdf);
  await new Promise(resolve=>setTimeout(resolve,8000));
  await page.screenshot({path:path.join(output,'windows-pdf.png')});
  await fs.writeFile(path.join(output,'pdf-navigation-body.txt'),navigationBody);
  report.pdfPreview = {
    status: pdfResponse.status(), type: pdfResponse.headers()['content-type'],
    originalFixtureUnchanged:true,
    fixtureSHA256:createHash('sha256').update(pdf).digest('hex'),
    cdpNavigationBody: originalBody ? 'original PDF' : 'WebView2-generated PDF viewer wrapper',
    screenshot:'windows-pdf.png', visualReviewRequired:true,
  };
  record('PDF navigation returns application/pdf; the source is unchanged and the actual native viewer screenshot is captured for visual review');
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));
  report.status='passed';
} catch(error) {
  report.status='failed';report.error=error.stack||String(error);
  if(page&&!page.isClosed()){
    await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    await fs.writeFile(path.join(output,'failure-dom.txt'),await page.locator('body').innerText().catch(()=>''));
  }
  process.exitCode=1;
} finally {
  await fs.writeFile(path.join(output,'native-ui.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await browser?.close().catch(()=>{});
  if(child?.pid){try{execFileSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{}}
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:300}).catch(()=>{});
}
