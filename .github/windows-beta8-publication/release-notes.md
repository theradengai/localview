## LocalView 0.2.0-beta.8 — Windows 文件夹右键

**公开预发布测试版 · Windows 10/11 x64 + Microsoft WebView2**

新增两个入口：右键点击本地文件夹，或右键点击文件夹内空白处，选择 **用 LocalView 打开 / Open with LocalView**。无需索引、无需导入，沿用现有的本地文件预览与编辑流程。

下载 `LocalView_0.2.0-beta.8_x64-setup.exe` 并安装。Beta 7 安装包不会自动增加这些菜单；升级时运行新版安装程序即可。Windows 11 可能需要先点 **显示更多选项 / Show more options**。

### 本次更新

- 两个菜单只注册到当前用户，不抢占文件默认应用。
- 可执行文件与目录参数均带引号，正确处理空格、中文和特殊字符；仍经过既有工作区路径校验。
- 菜单文字跟随安装程序语言，不随应用内中英文切换即时改变。
- 卸载时仅删除路径和命令均属于本次安装的菜单项，保留其他安装和无关菜单项。

### 验证范围

已通过前端、Windows 原生、真实回收站、macOS 及浏览器回归检查。对实际安装后的发布应用验证了文件夹 Shell verb、空白处的注册命令、中文/空格/符号路径、原文件不变、命令行参数解析，以及重装和卸载清理。原有 Markdown、HTML、图片、PDF、表格、看板和多窗口双语流程也通过原生应用验证。

附带安装包校验值、源码与构建来源、验证摘要及合成测试文件的原生应用截图。`windows-explorer-open.png` 展示经注册入口打开后的应用，不是右键菜单本身的截图。

### 保持不变的边界

安装包尚未进行 Authenticode 代码签名，可能出现未知发布者或 SmartScreen 提示；请核对仓库来源和 SHA-256，不要关闭系统安全保护。缺少 WebView2 Runtime 时，安装程序需要联网下载引导程序。

首版路径范围仍为普通本地盘符目录；UNC/网络共享、重解析点穿越与跨卷移动不在支持范围内。Markdown、HTML 和文本可编辑；图片/PDF/CSV/Excel/ODS 为预览，Word/PPT/iWork 在 Windows 上使用默认应用打开。托管 Windows 检查不等于已覆盖全部 Windows 10/11 实机、输入法、系统对话框或 Windows 11 精简菜单。

**Windows Beta 7 与 macOS Beta 6 的既有安装包及发布记录均保持不变。**

---

## English

**Open a folder directly from Windows File Explorer. No indexing. No import step.**

Install `LocalView_0.2.0-beta.8_x64-setup.exe`, then right-click a local folder—or the empty background inside it—and choose **Open with LocalView**. Windows 11 may require **Show more options**. Existing Beta 7 installations need this updated installer to gain the menu entries.

Registration is per user, preserves default applications, and safely quotes the executable and folder paths. Menu language follows the installer language. Uninstall removes only this installation's owned entries, preserving other registrations.

Actual installed-app validation covers the registered folder Shell verb, the registered background command, Unicode/spaces/symbols, unchanged source files, command-line parsing, reinstall and clean uninstall. Existing native document, preview, Kanban and language workflows remain covered. See the attached checksums, build provenance and validation summary. The Explorer-open screenshot shows the resulting application, not a captured context menu.

This is an **unsigned prerelease**, targeting Windows 10/11 x64 with WebView2. Local drive-letter workspaces only; Office/iWork uses the default app and spreadsheets remain read-only. Hosted-runner testing is not certification of all physical devices, IMEs, OS dialogs or Windows 11 compact-menu placement. Do not disable system-wide protections to install it. Previous Windows Beta 7 and macOS Beta 6 assets are unchanged.
