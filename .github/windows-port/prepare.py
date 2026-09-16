from pathlib import Path
import json
# The workflow applies this readable, bounded transformation only to exact Beta 6.
r=Path.cwd()
def replace(path, old, new, count=1):
    p=r/path; text=p.read_text()
    assert text.count(old)>=count, (path,old)
    p.write_text(text.replace(old,new,count))
for name in ['package.json','package-lock.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json']:
    p=r/name; text=p.read_text(); assert '0.2.0-beta.6' in text
    p.write_text(text.replace('0.2.0-beta.6','0.2.0-beta.7'))
p=r/'src-tauri/Cargo.toml';p.write_text(p.read_text()+'''\n[target.'cfg(windows)'.dependencies]
windows = { version = "=0.61.3", features = ["Win32_Foundation", "Win32_Storage_FileSystem", "Win32_System_Com", "Win32_UI_Shell"] }
''')
p=r/'src-tauri/Cargo.lock';s=p.read_text();start=s.index('name = "localview"');end=s.index('\n[[package]]',start)
sub=s[start:end].replace(' "url",',' "url",\n "windows",');assert sub!=s[start:end];p.write_text(s[:start]+sub+s[end:])
p=r/'src-tauri/src/main.rs';p.write_text('#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]\n'+p.read_text())
replace('src-tauri/src/image_paste.rs','    #[cfg(not(unix))]', '''    #[cfg(windows)]
    {
        let payloads = extensions.iter().zip(images).map(|(ext, image)| (*ext, image.bytes.as_slice())).collect::<Vec<_>>();
        return windows_fs::save_images(state, document_path, workspace_generation, &payloads, before_write);
    }
    #[cfg(not(any(unix, windows)))]''')
base=json.loads((r/'src-tauri/tauri.conf.json').read_text());window=base['app']['windows'][0].copy()
for key in ['titleBarStyle','hiddenTitle','trafficLightPosition','acceptFirstMouse']:window.pop(key,None)
window['decorations']=True
(r/'src-tauri/tauri.windows.conf.json').write_text(json.dumps({'app':{'windows':[window]},'bundle':{'targets':['nsis'],'icon':['icons/icon.ico'],'fileAssociations':None,'windows':{'nsis':{'installMode':'currentUser','languages':['English','SimpChinese'],'displayLanguageSelector':True},'webviewInstallMode':{'type':'downloadBootstrapper','silent':True}}}},indent=2)+'\n')
p=r/'src/lib/desktop.ts';s=p.read_text();s="import { normalizePath, parentPath, joinPath, containsPath } from './paths';\nexport { normalizePath, parentPath, basename, joinPath } from './paths';\nimport { isWindows } from './platform';\n"+s
start=s.index('function containsNormalizedPath');end=s.index('export function resolveResourcePath',start);s=s[:start]+s[end:]
s=s.replace('containsNormalizedPath(root, target)','containsPath(root, target)').replace("(root === '/' ? 0 : 1)","(root.endsWith('/') ? 0 : 1)").replace("navigator.userAgent.includes('Windows')","isWindows()")
idx=s.index('export async function chooseFolder()');s=s[:idx]+'''export async function chooseFile(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const result = await open({ directory: false, multiple: false, title: t("打开文件") });
  return typeof result === 'string' ? result : null;
}

'''+s[idx:];p.write_text(s)
p=r/'src/lib/directoryTree.ts';s=p.read_text();start=s.index('export function containsPath');end=s.index('\n}',start)+2
s=s[:start]+"export { containsPath } from './paths';"+s[end:];p.write_text("import { containsPath } from './paths';\n"+s)
p=r/'src/lib/i18n.ts';s=p.read_text();s="import { platformMessage } from './platform';\n"+s
s=s.replace("const template = getLocale() === 'en' ? messages[message] ?? message : message;","const translated = getLocale() === 'en' ? messages[message] ?? message : message;\n  const template = Object.prototype.hasOwnProperty.call(messages, message) ? platformMessage(translated) : translated;");p.write_text(s)
p=r/'src/App.tsx';s=p.read_text();s="import { isWindows, htmlPreviewPolicy } from './lib/platform';\n"+s
s=s.replace('  chooseFolder,','  chooseFolder,\n  chooseFile,',1)
start=s.index('  const policy = ',s.index('function injectHtmlPreviewPolicy'));end=s.index('\n',start);s=s[:start]+'  const policy = htmlPreviewPolicy();'+s[end:]
s=s.replace('  if (/<meta\\s+http-equiv=["\']Content-Security-Policy["\']/i.test(source)) return source;\n','')
pos=s.index('  const followPairedRename')
s=s[:pos]+'''  const handleOpenFile = useCallback(async () => {
    if (!desktop || workspaceTransitionRef.current || documentActionGateRef.current !== 'idle') return;
    try {
      const path = await chooseFile();
      if (path) await openIncomingPath(path);
    } catch (error) { showNotice(errorMessage(error)); }
  }, [desktop, openIncomingPath, showNotice]);

'''+s[pos:]
s=s.replace("      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {", "      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {\n        event.preventDefault();\n        void handleOpenFile();\n      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {",1)
s=s.replace('[handleExplicitSave, handleNewWindow, requestReload]', '[handleExplicitSave, handleNewWindow, requestReload, handleOpenFile]',1)
s=s.replace("      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Backspace') return;","      const recycleKey = isWindows() && event.key === 'Delete' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;\n      if (!recycleKey && (!(event.metaKey || event.ctrlKey) || event.key !== 'Backspace')) return;",1)
s=s.replace("className={`app-shell ${desktop ? 'tauri-runtime' : ''}`}","className={`app-shell ${desktop ? 'tauri-runtime' : ''} ${isWindows() ? 'windows-platform' : ''}`}")
s=s.replace('<div className="title-actions"><LanguagePicker />','<div className="title-actions"><LanguagePicker /><button disabled={treeLocked} onClick={() => void handleOpenFile()}>{t("打开文件")}</button>',1);p.write_text(s)
p=r/'src/renderers/SystemPreviewRenderer.tsx';s="import { isWindows } from '../lib/platform';\n"+p.read_text()
s=s.replace('    const host = hostRef.current;', '''    if (isWindows()) {
      setStatusMessage({ key: "{0}使用默认应用打开", values: [STATUS_PREFIX] });
      return;
    }
    const host = hostRef.current;''',1)
pos=s.index('  return <div className="system-preview-renderer">');s=s[:pos]+'''  if (isWindows()) return <div className="empty-state system-preview-fallback">
    <strong>{entry.name}</strong>
    <span>{t("Windows 版暂不提供此格式的内嵌预览，可用默认应用打开。文件不会上传。")}</span>
    <button onClick={() => void runAction(onOpenDefault)}>{t("用默认应用打开")}</button>
  </div>;

'''+s[pos:];p.write_text(s)
p=r/'src/renderers/SpreadsheetRenderer.tsx';s="import { isWindows } from '../lib/platform';\n"+p.read_text();s=s.replace('<button onClick={() => void runAction(onQuickLook)}>{t("系统快速预览")}</button>','{!isWindows() && <button onClick={() => void runAction(onQuickLook)}>{t("系统快速预览")}</button>}');p.write_text(s)
p=r/'src/style.css';p.write_text(p.read_text()+'''\n/* Native Windows caption controls own minimize, maximize and close. */
.windows-platform .traffic-lights { display: none; }
.windows-platform .titlebar { grid-template-columns: minmax(120px, 1fr) auto; }
.windows-platform .window-title { text-align: left; }
.title-actions { flex-wrap: nowrap; }
@media (max-width: 900px) {
  .windows-platform .title-actions button { padding-left: 7px; padding-right: 7px; }
}
''')
p=r/'src/lib/locales/en.json';d=json.loads(p.read_text());d.update({'打开文件':'Open file','{0}使用默认应用打开':'{0}Open in default app','Windows 版暂不提供此格式的内嵌预览，可用默认应用打开。文件不会上传。':'Embedded preview for this format is not available on Windows yet. Open it in your default app. No file is uploaded.'});p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
