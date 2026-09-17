#!/usr/bin/env node
// Exercise only the newly installed build in a disposable GitHub Windows account.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable CI only');
const [tools, executable, output] = process.argv.slice(2);
assert.ok(tools && executable && output);
const { chromium } = createRequire(path.resolve(tools))('playwright');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'localview-shell-'));
const folder = path.join(temporary, '中文 folder & test');
await fs.mkdir(folder);
const fixture = '# Opened from Explorer\r\n\r\nOriginal file, no import.\r\n';
await fs.writeFile(path.join(folder, 'right-click.md'), fixture);
const port = 19428;
const environment = {...process.env, LOCALVIEW_SHELL_FOLDER: folder, LOCALVIEW_SHELL_EXE: executable,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  WEBVIEW2_USER_DATA_FOLDER: path.join(temporary, 'webview-profile')};
const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  {encoding:'utf8', env:environment, timeout:30000}).trim();
const wait = async predicate => {
  const start = Date.now(); let last;
  while (Date.now()-start < 60000) {
    try { const value = await predicate(); if(value) return value; } catch(error) { last=error; }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error('Shell acceptance timeout: '+String(last??''));
};
const report = {status:'running', cases:[], limitations:['Windows 11 compact-menu placement requires Windows 11 desktop acceptance.','Background launch exercises the installed registry command; folder launch uses the actual Shell verb.']};
let browser, pid;
try {
  const registry = JSON.parse(ps(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);
    $entries=@(); foreach($type in @('Directory','Directory\\Background')) {
      $key=$base.OpenSubKey('Software\\Classes\\'+$type+'\\shell\\LocalView.Open'); if(!$key){throw 'Missing Explorer verb'};
      $entries+=@{type=$type;label=$key.GetValue('');owner=$key.GetValue('LocalViewOwner');icon=$key.GetValue('Icon');command=$key.OpenSubKey('command').GetValue('')};
    }; ConvertTo-Json -InputObject $entries -Compress`));
  assert.equal(registry.length,2);
  for(let i=0;i<2;i++) {
    const token=i===0?'%1':'%V';
    assert.equal(registry[i].owner.toLowerCase(),executable.toLowerCase());
    assert.equal(registry[i].command.toLowerCase(),`"${executable}" "${token}\\."`.toLowerCase());
    assert.ok(registry[i].label.includes('LocalView'));
    assert.equal(registry[i].icon.toLowerCase(),`"${executable}",0`.toLowerCase());
  }
  report.registry=registry;
  report.cases.push('Both current-user menu entries point to the quoted installed executable, with localized labels and icons');
  // Use the registered verb, not a reconstructed command, for the folder entry.
  pid=Number(ps(`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:LOCALVIEW_SHELL_FOLDER -Verb 'LocalView.Open' -PassThru; $p.Id`));
  assert.ok(Number.isInteger(pid)&&pid>0,'Shell must return the owned application PID');
  await wait(async()=>{const response=await fetch('http://127.0.0.1:'+port+'/json/version');return response.ok;});
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
  let page=await wait(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost/.test(p.url())));
  await page.locator('.app-shell.tauri-runtime').waitFor();
  await page.locator('.tree-name').filter({hasText:/^right-click\.md$/}).waitFor();
  await page.locator('.tree-row-main').filter({has:page.locator('.tree-name',{hasText:/^right-click\.md$/})}).click();
  await page.getByRole('heading',{name:'Opened from Explorer',exact:true}).waitFor();
  assert.equal(await fs.readFile(path.join(folder,'right-click.md'),'utf8'),fixture);
  assert.deepEqual(await fs.readdir(folder),['right-click.md']);
  await page.screenshot({path:path.join(output,'windows-explorer-open.png')});
  report.cases.push('Actual Explorer folder verb opens a Unicode/space/ampersand folder and reads its document without rewriting or importing it');
  await browser.close(); browser=undefined;
  try {execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore'});}catch{}
  pid=undefined;
  await new Promise(resolve=>setTimeout(resolve,1200));
  // Execute the exact background registration without cmd.exe or PowerShell expansion of the path.
  pid=Number(ps(`$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\Directory\\Background\\shell\\LocalView.Open\\command');
    $command=$key.GetValue(''); $match=[regex]::Match($command,'^"([^"]+)" (.+)$'); if(!$match.Success){throw 'Invalid command'};
    $info=New-Object Diagnostics.ProcessStartInfo; $info.FileName=$match.Groups[1].Value; $info.UseShellExecute=$false;
    $info.Arguments=$match.Groups[2].Value.Replace('%V',$env:LOCALVIEW_SHELL_FOLDER); $p=[Diagnostics.Process]::Start($info); $p.Id`));
  assert.ok(Number.isInteger(pid)&&pid>0);
  await wait(async()=>{const response=await fetch('http://127.0.0.1:'+port+'/json/version');return response.ok;});
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
  page=await wait(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/tauri\.localhost/.test(p.url())));
  await page.locator('.tree-name').filter({hasText:/^right-click\.md$/}).waitFor();
  assert.equal(await fs.readFile(path.join(folder,'right-click.md'),'utf8'),fixture);
  report.cases.push('The installed folder-background command opens the same exact folder without shell interpretation');
  report.status='passed';
} catch(error) {
  report.status='failed';report.error=String(error.stack??error);process.exitCode=1;
} finally {
  await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'shell-menu.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await browser?.close().catch(()=>{});
  if(pid){try{execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore'});}catch{}}
  await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:300}).catch(()=>{});
}
