# LocalView

**无需索引，直接打开。**

常见格式统一预览，Markdown、HTML 与文本就地编辑。

只是想看一份 Markdown、检查一个本地 HTML 原型，再翻一下旁边的 PDF 和表格，不必为此先搭一个知识库，或在几个软件之间反复切换。

LocalView 是面向 **macOS 和 Windows** 的轻量本地文档工作台。直接打开已有文件或文件夹，浏览真实目录，在原处查看和修改。**不用建库，不用导入，不建内容索引。你的文件夹，就是工作区。**

[English](README.md) · [下载与安装](#下载与安装) · [快速开始](#快速开始) · [预览与编辑范围](#预览与编辑范围) · [反馈问题](https://github.com/theradengai/localview/issues/new/choose)

![LocalView：Markdown 预览、分栏、编辑、任务勾选与 HTML](docs/images/localview-demo.gif)

*动图来自使用虚构文档的浏览器演示，修改仅保存在内存；不是桌面启动、系统文件夹选择器或右键菜单的录屏。[查看静态截图](docs/images/localview-demo.png)。*

## 下载与安装

**当前提供公开 Beta 测试版，不是稳定版。** 两个平台均支持简体中文和英文。

| 平台 | 版本 | 安装包 |
| --- | --- | --- |
| Windows 10/11 x64 + WebView2 | 0.2.0-beta.8 | [下载 Windows EXE](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.8/LocalView_0.2.0-beta.8_x64-setup.exe) |
| macOS 12+ · Apple Silicon（M 系列） | 0.2.0-beta.6 | [下载 Apple Silicon DMG](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.6/LocalView_0.2.0-beta.6_aarch64.dmg) |
| macOS 12+ · Intel | 0.2.0-beta.6 | [下载 Intel DMG](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.6/LocalView_0.2.0-beta.6_x64.dmg) |

[Windows 发布说明与校验文件](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.8) · [macOS 发布说明与校验文件](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.6)

**Windows：**运行 EXE，安装到当前用户。缺少 WebView2 时，安装程序需要联网下载 Microsoft 引导程序。本 Beta **尚未进行 Windows 代码签名**，可能出现未知发布者或 SmartScreen 提示。请核对下载来源和校验值，不要关闭系统级安全保护。详见 [Windows 使用说明](docs/WINDOWS.md)。

**macOS：**退出旧版，打开 DMG，将 **LocalView** 拖入“应用程序”，弹出安装磁盘，再启动已安装的应用。目前是**临时签名、未经 Apple 公证的 Beta**，首次打开可能被系统拦截。请先阅读[安装与校验说明](docs/INSTALL.md)。

## 快速开始

1. 启动 **LocalView**，点击 **打开文件夹**。
2. 在系统选择器中选中已有的本地文件夹。左侧显示真实目录，展开子目录时再读取，不在启动时扫描全部文档。
3. 点击文件即可预览。Markdown、HTML 和文本可切换到 **编辑** 或 **分栏**，修改写回原文件。

只看单个文档，也可选择 **打开文件**；Windows 支持 `Ctrl+O`。

### Windows：从资源管理器右键打开文件夹

安装 **Beta 8** 后，右键点击本地文件夹，或文件夹内的空白处，选择 **用 LocalView 打开**。Windows 11 可能需要先点击 **显示更多选项**。

菜单文字跟随安装程序语言，不随应用内语言切换即时变化。只注册当前用户菜单，不修改默认应用；卸载时清理本安装拥有的菜单项。Beta 7 需要升级后才有这个入口。详见[右键菜单说明](docs/WINDOWS.md#explorer-folder-menu--资源管理器右键)。

### macOS：从 Finder 打开文件

右键点击 `.md`、`.html` 等受支持文件，选择 **打开方式 → LocalView**，即可连同所在目录上下文打开。打开整个文件夹，请使用应用内的 **打开文件夹**；文件的“打开方式”关联不代表安装包已内置 Finder 文件夹右键菜单。

## 预览与编辑范围

**可以预览，不代表可以编辑。**

| 格式 | 预览 | 在 LocalView 中编辑 |
| --- | --- | --- |
| Markdown | 阅读视图、任务勾选、分栏 | 保留原始 Markdown 的实时预览、文字格式、支持的表格单元格与源码编辑 |
| Markdown 看板（`localview: kanban`） | 可操作看板、卡片详情 | 拖动卡片和列、修改详情与子任务；更新同一份 `.md` |
| HTML | 隔离的本地页面预览，支持相对 CSS、图片和 JavaScript 交互 | 源码编辑、分栏 |
| 文本与常见代码文件 | 文本查看 | 文本编辑，不是完整开发环境 |
| 图片、PDF | 图片与 PDF 预览 | 不支持 |
| CSV、XLS、XLSX、ODS | 只读数据表格、单元格换行、工作表切换 | 不支持 |
| Word、PowerPoint、Pages、Keynote、Numbers | macOS：取决于系统组件的 Quick Look；Windows：用默认应用打开，不提供内嵌预览 | 不支持 |

本地 HTML 可以**直接在当前窗口中查看和交互，不必另切浏览器**。预览仍受沙盒隔离：不能访问外部网络、远程 API、第三方嵌入或应用原生命令。

## Markdown 看板

**不只是看源码，也能直接操作看板；保存的仍是 Markdown。**

在文件夹 `+` 菜单选择 **新建看板**，或打开[示例看板](docs/fixtures/kanban.md)。文件开头的 `localview: kanban` 标记启用看板：`##` 二级标题是列，顶层任务项是卡片，缩进的说明和子任务随卡片移动。普通任务清单仍使用原来的预览。

![LocalView Markdown 看板：四列卡片、标签与子任务进度](docs/images/localview-kanban-board.png)

*截图来自 Beta 5 生产前端，在隔离的 WebKit 浏览器中使用虚构示例；不是原生桌面录屏，浏览器中的修改只保存在内存。[截图来源](docs/images/KANBAN_CAPTURES.md)。*

拖动卡片把手、调整列顺序，或点击卡片，在右侧编辑详情。**预览**显示看板，**编辑**显示 Markdown，**分栏**同时显示两者，共用源码、撤销记录与自动保存。

[卡片详情](docs/images/localview-kanban-details.png) · [看板与源码分栏](docs/images/localview-kanban-split.png) · [看板格式与限制](docs/KANBAN.md)

移动到某一列不会自动勾选完成。本版看板卡片暂不支持多选；打印使用 Markdown 阅读视图，不是看板图片。

## 在原文件夹里工作

- **编辑与保存：**Markdown、HTML 和文本停止输入 600 ms 后自动保存，`⌘S` / `Ctrl+S` 立即写回原文件；检测外部修改，避免静默覆盖。Markdown 切换模式时保留撤销记录，预览中也可勾选任务。
- **整理文件，无需导入：**新建 Markdown 和文件夹、就地重命名，用 `⌘` / `Ctrl` 或 `Shift` 多选文件和目录，在工作区内移动。一次确认后可整组移到 macOS 废纸篓或 Windows 回收站，不提供永久删除。详见[多选与安全边界](docs/FOLDER_SELECTION.md)。
- **粘贴截图：**在 Markdown 编辑或分栏模式按 `⌘V` / `Ctrl+V`，图片保存到文档旁的 `assets/` 并插入相对引用。支持 PNG、JPEG、GIF、WebP；每次最多 8 张、合计 10 MB。
- **多窗口与打印：**`⌘N` / `Ctrl+N` 打开独立工作区窗口，`⌘P` / `Ctrl+P` 打开渲染后 Markdown 的打印设置。打印目前只支持 Markdown。

## 界面语言

标题栏可选择 **跟随系统 / 简体中文 / English**。切换立即生效并记住选择，不翻译文档、不重建编辑器。系统对话框与外部应用可能遵循各自的语言设置。详见[语言行为与验证说明](docs/LANGUAGES.md)。

## 当前限制

LocalView 是本地文件工作台，不是完整 Office 套件或通用浏览器。图片、PDF 和数据表格只支持预览；尚不支持 Office 编辑、公式重算、宏、图表与完整 Office 格式保真。

CSV 需要 UTF-8 编码（可带 BOM）、逗号分隔，前导零按文本保留。复杂 Markdown 表格可能回退源码编辑；保留普通换行与任务缩进，可参考[格式测试样例](docs/fixtures/markdown-format-matrix.md)和[验证记录](docs/MARKDOWN_FORMAT_VALIDATION.md)。

Windows Beta 支持普通本地盘符目录，不支持 UNC／网络目录、目录联接或重解析点穿越、跨卷移动，也未提供 Windows 原生 ARM64 包。目前没有 Linux 安装包。托管测试不等于覆盖所有 Windows 10/11 实机、输入法、系统对话框和 WebView2 版本；Intel／Monterey 也仍需要实机兼容性反馈。用 Beta 处理重要文档前请保留备份。

[完整功能与限制](docs/FEATURES.md) · [Windows 验证范围](docs/WINDOWS.md) · [版本记录](CHANGELOG.md)

## 本地开发

需要 **Node.js 24**、**Rust 1.91.1 或更高版本**。macOS 需要 Xcode Command Line Tools；Windows 需要 MSVC Rust 工具链、C++ Build Tools／Windows SDK 和 WebView2。详见 [Windows 开发说明](docs/WINDOWS.md#development)。

```bash
git clone https://github.com/theradengai/localview.git
cd localview
npm ci
npm run tauri:dev
```

`npm run dev` 启动仅操作内存示例的浏览器演示，不会读写你的真实文件夹。

```bash
npm test
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

技术栈：**Tauri 2 · React · TypeScript · CodeMirror 6 · Rust**。[交互原型](prototype/local-folder-viewer-prototype.html)定义视觉风格，[MVP 规格](docs/MVP.md)说明产品模型；已发布能力以本页格式表和版本记录为准。

## 参与贡献

欢迎小而明确的改进与可复现的问题反馈。构建、测试与提交说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，PR 提交到 `staging`。当前重点包括文件操作可靠性、Markdown／表格编辑体验和桌面兼容性。

请勿在公开 Issue 中上传私人文档或密钥。安全漏洞请按 [SECURITY.md](SECURITY.md)报告。

## 许可证

LocalView 原创源码采用 [MIT 许可证](LICENSE)。第三方组件保留各自许可，相关声明与源码链接见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，并随应用一同提供。
