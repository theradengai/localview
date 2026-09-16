# Windows Beta / Windows 测试版

## 无需索引，直接打开

LocalView Windows x64 从 **0.2.0-beta.7** 起提供安装包。直接打开本地文件或文件夹，按需读取目录与内容，不建索引、不导入知识库，编辑写回原文件。

### 安装与打开

从 [GitHub Release](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.7) 下载 `LocalView_0.2.0-beta.7_x64-setup.exe`。首版目标环境为 Windows 10/11 x64 + Microsoft WebView2，安装范围为当前用户。若系统缺少 WebView2，安装程序需要联网下载 Microsoft 的引导程序；已有 Runtime 时，本地文档使用不要求联网。

Beta 安装包**尚未进行 Authenticode 代码签名**，Windows 可能显示未知发布者或 SmartScreen 提示。确认下载来自上述仓库，并对照同一 Release 的 `SHA256SUMS.txt`。校验值证明文件完整性，不等于发布者身份认证。不要关闭 Defender、SmartScreen 或系统级安全策略；受管电脑应遵守管理员策略。

```powershell
Get-FileHash .\LocalView_0.2.0-beta.7_x64-setup.exe -Algorithm SHA256
```

启动后点击“打开文件”或按 `Ctrl+O`，也可点击“打开文件夹”。标题栏可切换“跟随系统 / 简体中文 / English”。首版安装包不注册 Windows 文件关联，不更改已有默认应用；不要把 macOS Finder 的自动关联说明套用到 Windows。

### 能做什么

| 类型/操作 | Windows 首版 |
| --- | --- |
| Markdown | 预览、编辑时实时预览、左右分栏、任务勾选、表格编辑、自动保存 |
| Markdown 看板 | 拖动卡片/列、编辑详情和子任务，仍存为普通 `.md` |
| HTML | 源码编辑与隔离的本地交互预览；支持相对 CSS、图片和脚本 |
| 文本/常见代码文件 | 编辑与自动保存，不是完整 IDE |
| 图片/PDF | 本地预览；PDF 控件取决于 WebView2 Runtime |
| CSV/XLS/XLSX/ODS | 只读数据表格，不是 Office 编辑器；不重算公式、不运行宏 |
| Word/PowerPoint/iWork | “用默认应用打开”；没有内嵌 Quick Look/Office 预览 |
| 文件与目录 | 新建、重命名、多选、工作区内移动、移到回收站；不提供永久删除 |
| 多窗口与语言 | `Ctrl+N` 新窗口，中英文设置同步；文档与撤销记录不因切换语言而改写 |

`Ctrl+S` 立即保存，`Ctrl+Z` 撤销，`Ctrl+Y` 重做。Markdown/HTML/文本停止输入 600 ms 后自动保存。遇到外部修改会检测冲突，不应静默覆盖。文件树获得焦点时，普通 Delete 移到回收站并要求确认；Shift+Delete 不提供永久删除功能。

### 首版限制

使用 `C:\...`、`D:\...` 这样的本地盘符目录。UNC/网络共享、设备路径、junction/reparse point 穿越及跨卷移动会被拒绝。某些云同步或占位文件也可能属于重解析点，应先在普通本地文件夹测试。目录联接不是普通文件夹支持范围。Windows 原生 ARM64 和 Linux 安装包不包含在本版中。

HTML 预览不能执行原生命令，阻止外部网络请求、表单、嵌套框架等；本地 JavaScript 交互可用，但不是可联网的内嵌浏览器。文件选择器、打印和系统外部应用有各自的语言、权限和兼容性边界。

## English

LocalView opens local files directly—**no indexing and no import step**. Windows x64 starts with **0.2.0-beta.7**, distributed as a current-user NSIS installer for Windows 10/11 x64 with Microsoft WebView2. A missing WebView2 Runtime requires the installer to download Microsoft's bootstrapper. The Beta is unsigned: verify the GitHub source and SHA-256 checksum, and do not disable system-wide security features.

Use **Open file / Ctrl+O** or **Open folder**. Markdown, HTML and text are editable in place; images/PDF and CSV/Excel/ODS data grids are previewable. Markdown Kanban remains an ordinary `.md` file. Office/iWork has a default-application action, **not** an embedded Office or Quick Look renderer. Windows file associations are not registered by this installer.

The first Beta supports local drive-letter workspaces only. It rejects UNC/network workspaces, device paths, junction/reparse-point traversal and cross-volume moves. Recycle Bin failures do not fall back to permanent deletion. Native Windows ARM64 and Linux packages are not included. Both English and Simplified Chinese UI are available without translating or rewriting user documents.

## Validation / 验证边界

The release includes `BUILD-PROVENANCE.json`, `VALIDATION-SUMMARY.json` and `SHA256SUMS.txt`. These record the actual source commits, build artifacts and successful checks rather than claiming unperformed tests. Windows CI uses synthetic fixtures on a disposable Windows runner. It checks native filesystem operations and Recycle Bin, then installs the actual release executable and exercises its WebView2 UI. Browser-demo checks alone do not prove Windows filesystem behavior.

Hosted Windows testing is **not** complete certification of physical Windows 10/11 machines, every WebView2 version, real IME input, file-picker/print dialogs or all third-party default applications. Preserve backups when testing a Beta with important documents. macOS Beta 6 packages are unchanged by this Windows-only release.

## Development

Install Node.js 24, Rust 1.91.1 or later using the `x86_64-pc-windows-msvc` toolchain, Microsoft C++ Build Tools with a Windows SDK, and WebView2. Follow the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows) and [Windows installer guide](https://v2.tauri.app/distribute/windows-installer/).

```powershell
npm ci
npm test
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri:build -- -- --locked
```

The installer is under `src-tauri/target/release/bundle/nsis/`. Native acceptance scripts run only on disposable GitHub Actions Windows accounts; never direct them at an installed user app, a private workspace, or an unrelated browser/debugging endpoint. The production application does not enable a remote-debugging port.
